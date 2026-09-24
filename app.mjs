import { extractPdfLines, parseMaterialReportLines, normalizeSpaces } from "./parser.mjs";
import { parsePurchaseWorkbook, normalizePoMaterialDescription } from "./purchase_parser.mjs";
import { loadCloudRows, loadActivityRows, insertRows, updateRows, deleteRows, logActivity } from "./db.mjs";
import { restoreSession, signInWithPassword, signOut, getCurrentUser, getLastEmail } from "./auth.mjs";
import { startRealtime, stopRealtime, refreshRealtimeAuth } from "./realtime.mjs";

const LEGACY_STORAGE_KEY = "ewp_forecast_v2";
const UI_PREFS_KEY = "ewp_forecast_v06_ui";
const SCHEMA_VERSION = 17;
const EPSILON = 0.0001;
const HISTORY_PAGE_SIZE = 100;

let state = { version: SCHEMA_VERSION, projects: [], inventoryMaterials: [], purchaseOrders: [], incomingOrders: [] };
let draft = null;
let purchaseDraft = null;
let pdfjsLib = null;
let activeDelivery = null;
let activeEditProject = null;
let activeDeleteProject = null;
let activeMaterialExclusion = null;
let matrixScrollLeft = 0;
let matrixScrollTop = 0;
let syncInProgress = false;
let lastSyncAt = null;
let uiPrefs = loadUiPrefs();
let currentUserName = "";
let loginResolve = null;
let activityRows = [];
let historyLoaded = false;
let historyLimit = HISTORY_PAGE_SIZE;
let historyHasMore = false;
let realtimeRefreshTimer = null;
let historyRefreshTimer = null;
let realtimeState = "starting";

const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID();

function applySessionIdentity(session) {
  const user = session?.user || getCurrentUser();
  currentUserName = normalizeSpaces(user?.email || "");
  renderCurrentUser();
}

function renderCurrentUser() {
  const label = $("currentUserName");
  if (label) label.textContent = currentUserName || "Not signed in";
}

function activityDetails(details = {}) {
  const user = getCurrentUser();
  return {
    ...details,
    actor_name: currentUserName || user?.email || "Unknown user",
    actor_email: user?.email || currentUserName || "",
    actor_user_id: user?.id || ""
  };
}

function activityContext(entityType, entityId) {
  if (entityType === "project") {
    const project = state.projects.find(item => item.id === entityId);
    return project ? {
      project_number: project.projectNumber || "",
      address_project_name: project.address || ""
    } : {};
  }
  if (entityType === "level") {
    for (const project of state.projects) {
      const level = (project.levels || []).find(item => item.id === entityId);
      if (level) return {
        project_number: project.projectNumber || "",
        address_project_name: project.address || "",
        level_name: level.name || ""
      };
    }
  }
  return {};
}

async function recordActivity(entityType, entityId, action, details = {}) {
  return logActivity(entityType, entityId, action, activityDetails({ ...activityContext(entityType, entityId), ...details }));
}

function setLoginError(message = "") {
  const el = $("loginError");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function setAuthGateVisible(visible) {
  const gate = $("loginGate");
  if (!gate) return;
  gate.classList.toggle("hidden", !visible);
  document.body.classList.toggle("auth-locked", visible);
  $("signOutButton")?.classList.toggle("hidden", visible);
}

function openLoginDialog() {
  $("loginEmail").value = getLastEmail();
  $("loginPassword").value = "";
  setLoginError("");
  setAuthGateVisible(true);
  requestAnimationFrame(() => {
    const target = $("loginEmail").value ? $("loginPassword") : $("loginEmail");
    target?.focus();
  });
  return new Promise(resolve => { loginResolve = resolve; });
}

function finishLogin(session) {
  applySessionIdentity(session);
  setAuthGateVisible(false);
  const resolve = loginResolve;
  loginResolve = null;
  if (resolve) resolve(session);
}

async function ensureAuthenticated() {
  const restored = await restoreSession();
  if (restored?.user) {
    applySessionIdentity(restored);
    return restored;
  }
  return openLoginDialog();
}

function loadUiPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "null");
    if (parsed && typeof parsed === "object") return { collapsed: parsed.collapsed || {} };
  } catch (error) {
    console.warn("Could not load UI preferences", error);
  }
  return { collapsed: {} };
}

function saveUiPrefs() {
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify(uiPrefs));
}

function isProjectCollapsed(project) {
  if ((project.levels || []).length <= 1) return false;
  if (Object.prototype.hasOwnProperty.call(uiPrefs.collapsed, project.id)) return Boolean(uiPrefs.collapsed[project.id]);
  return true;
}

function setProjectCollapsed(projectId, collapsed) {
  uiPrefs.collapsed[projectId] = Boolean(collapsed);
  saveUiPrefs();
}

function migrateLegacyState(parsed) {
  if (!parsed || !Array.isArray(parsed.projects)) return null;
  if (![2, 3, 4].includes(Number(parsed.version))) return null;
  return {
    version: SCHEMA_VERSION,
    projects: parsed.projects.map(project => ({
      id: project.id || uid(),
      projectNumber: project.projectNumber || "",
      revision: project.revision || "",
      customer: project.customer || "",
      sales: project.sales || "",
      address: project.address || "",
      projectType: project.projectType === "sfd" ? "sfd" : "multi",
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate || "",
      sourceFileName: project.sourceFileName || "",
      createdAt: project.createdAt || new Date().toISOString(),
      updatedAt: project.updatedAt || new Date().toISOString(),
      version: Number(project.version || 1),
      levels: (project.levels || []).map((level, levelIndex) => ({
        id: level.id || uid(),
        name: level.name || `Level ${levelIndex + 1}`,
        estimatedDeliveryDate: level.estimatedDeliveryDate || "",
        workflowStatus: level.workflowStatus === "spruce" ? "spruce" : "forecast",
        displayOrder: Number(level.displayOrder ?? levelIndex),
        version: Number(level.version || 1),
        materials: (level.materials || []).map(material => ({
          id: material.id || uid(),
          material: material.material || "",
          requiredLf: Number(material.requiredLf || 0),
          excludedLf: Number(material.excludedLf || 0),
          exclusionReason: material.exclusionReason || "",
          exclusionNote: material.exclusionNote || "",
          version: Number(material.version || 1)
        })),
        deliveries: Array.isArray(level.deliveries) ? level.deliveries.map(delivery => ({
          id: delivery.id || uid(),
          date: delivery.date || "",
          note: delivery.note || "",
          createdAt: delivery.createdAt || new Date().toISOString(),
          items: (delivery.items || []).map(item => ({
            material: item.material || "",
            materialId: item.materialId || "",
            lf: Number(item.lf || 0)
          }))
        })) : []
      }))
    })),
    inventoryMaterials: [],
    purchaseOrders: [],
    incomingOrders: []
  };
}

function readLegacyBrowserData() {
  try {
    return migrateLegacyState(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null"));
  } catch {
    return null;
  }
}

function setCloudStatus(kind, text) {
  const pill = $("cloudPill");
  pill.className = `cloud-pill ${kind}`;
  pill.textContent = text;
}

function formatSyncTime(date) {
  if (!date) return "not synced yet";
  return new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(date);
}

function mapCloudRows(rows) {
  const projectMap = new Map();
  for (const row of rows.projects || []) {
    projectMap.set(row.id, {
      id: row.id,
      projectNumber: row.project_number || "",
      revision: row.revision || "",
      customer: row.customer || "",
      sales: row.sales || "",
      address: row.address_project_name || "",
      projectType: row.project_type === "sfd" ? "sfd" : "multi",
      defaultEstimatedDeliveryDate: row.default_delivery_date || "",
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",
      version: Number(row.version || 1),
      levels: []
    });
  }

  const levelMap = new Map();
  for (const row of rows.levels || []) {
    const project = projectMap.get(row.project_id);
    if (!project) continue;
    const level = {
      id: row.id,
      projectId: row.project_id,
      name: row.level_name || "",
      estimatedDeliveryDate: row.estimated_delivery_date || "",
      workflowStatus: row.workflow_status === "spruce" ? "spruce" : "forecast",
      isActive: row.is_active !== false,
      displayOrder: Number(row.display_order || 0),
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",
      version: Number(row.version || 1),
      materials: [],
      deliveries: []
    };
    levelMap.set(level.id, level);
    if (level.isActive) project.levels.push(level);
  }

  const materialMap = new Map();
  for (const row of rows.materials || []) {
    const level = levelMap.get(row.level_id);
    if (!level) continue;
    const material = {
      id: row.id,
      levelId: row.level_id,
      material: row.material_name || "",
      requiredLf: Number(row.original_lf || 0),
      excludedLf: Number(row.excluded_lf || 0),
      exclusionReason: row.exclusion_reason || "",
      exclusionNote: row.exclusion_note || "",
      isActive: row.is_active !== false,
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",
      version: Number(row.version || 1)
    };
    materialMap.set(material.id, material);
    if (level.isActive && material.isActive) level.materials.push(material);
  }

  // Rows written together share the exact delivered_at timestamp and note, so they reconstruct one delivery batch.
  const batches = new Map();
  for (const row of rows.deliveries || []) {
    const level = levelMap.get(row.level_id);
    const material = materialMap.get(row.material_id);
    if (!level || !material) continue;
    const key = `${row.level_id}|${row.delivered_at || ""}|${row.note || ""}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        id: row.id,
        rowIds: [],
        date: (row.delivered_at || "").slice(0, 10),
        deliveredAt: row.delivered_at || "",
        note: row.note || "",
        createdAt: row.created_at || row.delivered_at || "",
        items: []
      };
      batches.set(key, batch);
      level.deliveries.push(batch);
    }
    batch.rowIds.push(row.id);
    batch.items.push({ materialId: material.id, material: material.material, lf: Number(row.delivered_lf || 0) });
  }

  const inventoryMaterials = (rows.inventoryMaterials || []).map(row => ({
    id: row.id,
    material: row.material_name || "",
    onHandLf: Number(row.on_hand_lf || 0),
    leadTimeWeeks: Number(row.lead_time_weeks ?? 6),
    note: row.note || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    version: Number(row.version || 1)
  }));

  const purchaseOrders = (rows.purchaseOrders || []).map(row => ({
    id: row.id,
    poNumber: row.po_number || "",
    orderDate: row.order_date || "",
    expectedDate: row.expected_date || "",
    sourceFileName: row.source_file_name || "",
    note: row.note || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    version: Number(row.version || 1)
  }));

  const incomingOrders = (rows.incomingOrders || []).map(row => ({
    id: row.id,
    purchaseOrderId: row.purchase_order_id || "",
    material: row.material_name || "",
    quantityLf: Number(row.quantity_lf || 0),
    receivedLf: Number(row.received_lf || 0),
    expectedDate: row.expected_date || "",
    reference: row.reference || "",
    note: row.note || "",
    lengthBreakdown: Array.isArray(row.length_breakdown) ? row.length_breakdown : [],
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    version: Number(row.version || 1)
  }));

  const projects = [...projectMap.values()];
  projects.forEach(project => project.levels.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, undefined, { numeric: true })));
  inventoryMaterials.sort((a, b) => a.material.localeCompare(b.material, undefined, { numeric: true }));
  purchaseOrders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return { version: SCHEMA_VERSION, projects, inventoryMaterials, purchaseOrders, incomingOrders };
}
function hasOpenDialog() {
  return $("deliveryDialog")?.open || $("materialExclusionDialog")?.open || $("projectEditDialog")?.open || $("deleteProjectDialog")?.open || $("projectReviewDialog")?.open;
}

async function syncFromCloud({ silent = false, rebindActive = false } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  if (!silent) setCloudStatus("connecting", "Refreshing shared data…");
  const deliveryIds = rebindActive && activeDelivery ? { projectId: activeDelivery.project.id, levelId: activeDelivery.level.id } : null;
  const editProjectId = rebindActive && activeEditProject ? activeEditProject.id : null;

  try {
    const rows = await loadCloudRows();
    state = mapCloudRows(rows);
    lastSyncAt = new Date();
    if (realtimeState === "error") setCloudStatus("connecting", "Shared data connected · live sync unavailable");
    else if (realtimeState === "connected") setCloudStatus("connected", "Shared data connected · live");
    else setCloudStatus("connected", "Shared data connected");
    renderAll();

    if (deliveryIds) {
      const project = state.projects.find(item => item.id === deliveryIds.projectId);
      const level = project?.levels.find(item => item.id === deliveryIds.levelId);
      activeDelivery = project && level ? { project, level } : null;
    }
    if (editProjectId) activeEditProject = state.projects.find(item => item.id === editProjectId) || null;
  } catch (error) {
    console.error(error);
    setCloudStatus("error", "Shared data unavailable");
    if (!silent) alert(`Could not load shared data.\n\n${error.message}`);
  } finally {
    syncInProgress = false;
  }
}

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  const candidates = [
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs"
  ];
  let lastError;
  for (const url of candidates) {
    try {
      const lib = await import(url);
      lib.GlobalWorkerOptions.workerSrc = url.replace(/pdf\.min\.mjs$/, "pdf.worker.min.mjs");
      pdfjsLib = lib;
      return pdfjsLib;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`PDF reader could not load. Your network may block both PDF.js CDNs. ${lastError?.message || ""}`);
}

function setTab(tabName) {
  document.querySelectorAll(".tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === tabName));
  if (tabName === "history") {
    if (!historyLoaded) loadAndRenderHistory({ reset: true });
    else renderHistory();
  }
}

function todayIso() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatPercent(value) {
  const n = Math.max(0, Math.min(100, Number(value || 0)));
  return `${Math.round(n)}%`;
}

function formatDate(date) {
  if (!date) return "No date";
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric" }).format(new Date(y, m - 1, d));
}

function addDaysIso(date, days) {
  if (!date) return "";
  const [y, m, d] = String(date).split("-").map(Number);
  if (!y || !m || !d) return "";
  const value = new Date(Date.UTC(y, m - 1, d));
  value.setUTCDate(value.getUTCDate() + Number(days || 0));
  return value.toISOString().slice(0, 10);
}

function applyProjectDateToDraft() {
  if (!draft?.levels?.length) {
    renderDeliveryPreview();
    return;
  }
  const projectDate = $("projectDate").value || "";
  draft.defaultEstimatedDeliveryDate = projectDate;

  if ($("applyDateAll").checked) {
    draft.levels.forEach(level => {
      level.estimatedDeliveryDate = projectDate;
      level.dateSource = projectDate ? "auto" : "";
    });
    renderDeliveryPreview();
    return;
  }

  if ($("staggerWeekly").checked) {
    draft.levels.forEach((level, index) => {
      level.estimatedDeliveryDate = projectDate ? addDaysIso(projectDate, index * 7) : "";
      level.dateSource = level.estimatedDeliveryDate ? "auto" : "";
    });
    renderDeliveryPreview();
    return;
  }

  // The project date is always the starting/first-level date even when no bulk rule is selected.
  draft.levels[0].estimatedDeliveryDate = projectDate;
  draft.levels[0].dateSource = projectDate ? "auto" : "";
  renderDeliveryPreview();
}

function continueWeeklyScheduleFrom(levelIndex) {
  if (!draft?.levels?.length || levelIndex < 0 || levelIndex >= draft.levels.length) return;
  const anchor = draft.levels[levelIndex].estimatedDeliveryDate || "";
  for (let index = levelIndex + 1; index < draft.levels.length; index += 1) {
    draft.levels[index].estimatedDeliveryDate = anchor ? addDaysIso(anchor, (index - levelIndex) * 7) : "";
    draft.levels[index].dateSource = draft.levels[index].estimatedDeliveryDate ? "auto" : "";
  }
  renderDeliveryPreview();
}

function monthKey(date) { return date ? date.slice(0, 7) : ""; }
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { month: "short", year: "numeric" }).format(new Date(y, m - 1, 1));
}
function normalizeMaterialKey(material) { return normalizeSpaces(material).toLowerCase(); }

function deliveryTotals(level) {
  const totals = new Map();
  for (const delivery of level.deliveries || []) {
    for (const item of delivery.items || []) {
      const key = item.materialId ? `id:${item.materialId}` : `name:${normalizeMaterialKey(item.material)}`;
      totals.set(key, (totals.get(key) || 0) + Number(item.lf || 0));
    }
  }
  return totals;
}

function deliveredFor(level, material) {
  const totals = deliveryTotals(level);
  return Math.max(0, Number(totals.get(`id:${material.id}`) ?? totals.get(`name:${normalizeMaterialKey(material.material)}`) ?? 0));
}

function excludedFor(material) {
  return Math.max(0, Math.min(Number(material.requiredLf || 0), Number(material.excludedLf || 0)));
}

function outstandingFor(level, material) {
  return Math.max(0, Number(material.requiredLf || 0) - deliveredFor(level, material) - excludedFor(material));
}

function levelStats(level) {
  let required = 0;
  let delivered = 0;
  let excluded = 0;
  let outstanding = 0;
  for (const material of level.materials || []) {
    required += Number(material.requiredLf || 0);
    delivered += deliveredFor(level, material);
    excluded += excludedFor(material);
    outstanding += outstandingFor(level, material);
  }
  const resolved = Math.min(required, delivered + excluded);
  const percent = required > EPSILON ? Math.max(0, Math.min(100, (resolved / required) * 100)) : 0;
  const status = outstanding <= EPSILON ? "delivered" : resolved > EPSILON ? "partial" : "upcoming";
  return { required, delivered, excluded, outstanding, percent, status };
}

function projectStats(project) {
  let required = 0;
  let delivered = 0;
  let excluded = 0;
  let outstanding = 0;
  const incompleteLevels = [];
  (project.levels || []).forEach((level, index) => {
    const stats = levelStats(level);
    required += stats.required;
    delivered += stats.delivered;
    excluded += stats.excluded;
    outstanding += stats.outstanding;
    if (stats.outstanding > EPSILON) incompleteLevels.push({ level, stats, index });
  });
  incompleteLevels.sort((a, b) => {
    const aDate = a.level.estimatedDeliveryDate || "9999-12-31";
    const bDate = b.level.estimatedDeliveryDate || "9999-12-31";
    return aDate.localeCompare(bDate) || a.index - b.index;
  });
  const resolved = Math.min(required, delivered + excluded);
  const percent = required > EPSILON ? Math.max(0, Math.min(100, (resolved / required) * 100)) : 0;
  const status = outstanding <= EPSILON ? "delivered" : resolved > EPSILON ? "partial" : "upcoming";
  return { required, delivered, excluded, outstanding, percent, status, packagesRemaining: incompleteLevels.length, nextLevel: incompleteLevels[0]?.level || null };
}

function allLevels() {
  return state.projects.flatMap(project => (project.levels || []).map(level => ({ project, level })));
}

function uniqueMaterials(levelRefs = allLevels()) {
  const materialMap = new Map();
  for (const { level } of levelRefs) {
    for (const material of level.materials || []) {
      const key = normalizeMaterialKey(material.material);
      if (key && !materialMap.has(key)) materialMap.set(key, material.material);
    }
  }
  return [...materialMap.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status) {
  if (status === "partial") return "PARTIAL";
  if (status === "delivered") return "DELIVERED";
  return "UPCOMING";
}

function planningStatus(level) {
  if (levelStats(level).outstanding <= EPSILON) return "delivered";
  return level.workflowStatus === "spruce" ? "spruce" : "forecast";
}

function planningStatusLabel(status) {
  if (status === "spruce") return "IN SPRUCE";
  if (status === "delivered") return "DELIVERED";
  return "FORECAST";
}

function projectTitle(project) { return project.address || "Address / Project Name not entered"; }
function projectMetaHtml(project) {
  const projectId = [project.projectNumber, project.revision].filter(Boolean).join(" · ") || "No project #";
  const missingTitle = !normalizeSpaces(project.address || "");
  return `
    <div class="project-title${missingTitle ? " project-title-missing" : ""}">${escapeHtml(projectTitle(project))}</div>
    <div class="project-meta-line">${escapeHtml(projectId)} · Customer: ${escapeHtml(project.customer || "—")}</div>
    <div class="project-meta-line">Sales: ${escapeHtml(project.sales || "—")} · ${project.projectType === "sfd" ? "SFD" : "Multi"}</div>`;
}

function progressHtml(percent, label) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `
    <div class="progress-row"><strong>${formatPercent(safe)}</strong><span>${escapeHtml(label)}</span></div>
    <div class="progress-track" aria-label="${formatPercent(safe)} ${escapeHtml(label)}"><span style="width:${safe}%"></span></div>`;
}

async function handlePdf(file) {
  const status = $("parseStatus");
  status.className = "status muted";
  status.textContent = `Reading ${file.name}…`;
  try {
    const lib = await loadPdfJs();
    const lines = await extractPdfLines(file, lib);
    const parsed = parseMaterialReportLines(lines, file.name);
    if (!parsed.levels.length) throw new Error("I found the PDF text, but no Total Lengths section could be confidently read.");

    draft = {
      sourceFileName: file.name,
      projectNumber: parsed.projectNumber || "",
      revision: parsed.revision || "",
      customer: "",
      sales: "",
      projectType: $("projectType")?.value === "sfd" ? "sfd" : "multi",
      address: parsed.address || "",
      defaultEstimatedDeliveryDate: $("projectDate").value || "",
      levels: parsed.levels.map(level => ({
        id: uid(),
        name: level.name,
        estimatedDeliveryDate: "",
        dateSource: "",
        materials: level.materials.map(item => ({ id: uid(), material: item.material, requiredLf: item.requiredLf })),
        filteredMaterials: (level.filteredMaterials || []).map(item => ({ id: uid(), material: item.material, requiredLf: item.requiredLf })),
        deliveries: []
      }))
    };
    applyProjectDateToDraft();

    $("projectNumber").value = draft.projectNumber;
    $("revision").value = draft.revision;
    $("customer").value = draft.customer;
    $("sales").value = draft.sales;
    $("projectType").value = draft.projectType || "multi";
    $("address").value = draft.address;
    updateProjectTypeUi();
    $("reviewCard").classList.remove("hidden");
    const filteredCount = draft.levels.reduce((n, level) => n + (level.filteredMaterials || []).length, 0);
    status.className = filteredCount ? "status warning" : "status success";
    status.textContent = `Read ${draft.levels.length} level${draft.levels.length === 1 ? "" : "s"} and ${draft.levels.reduce((n, level) => n + level.materials.length, 0)} included Total Length material lines.${filteredCount ? ` ${filteredCount} Web Stiffener line${filteredCount === 1 ? " was" : "s were"} filtered out by default; review the warning below to add any back.` : ""}`;
    renderDraftLevels();
  } catch (error) {
    console.error(error);
    status.className = "status error";
    status.textContent = error.message || "Could not read this PDF.";
  }
}

function renderDraftLevels() {
  if (!draft) {
    renderDeliveryPreview();
    return;
  }
  const wrap = $("levelEditor");
  wrap.innerHTML = draft.levels.map((level, levelIndex) => `
    <div class="level-card" data-level-index="${levelIndex}">
      <div class="level-header">
        <label>Level
          <input class="level-name" data-level-index="${levelIndex}" value="${escapeHtml(level.name)}" />
        </label>
        <label>Estimated Delivery
          <div class="date-field-wrap">
            <input class="level-date" data-level-index="${levelIndex}" type="date" value="${escapeHtml(level.estimatedDeliveryDate || "")}" />
            ${level.estimatedDeliveryDate ? `<span class="date-source-badge ${level.dateSource === "manual" ? "manual" : "auto"}">${level.dateSource === "manual" ? "Manual" : "Auto"}</span>` : ""}
          </div>
        </label>
        <button class="button ghost remove-level" data-level-index="${levelIndex}" type="button">Remove Level</button>
      </div>
      ${(level.filteredMaterials || []).length ? `
      <div class="filtered-warning">
        <div class="filtered-warning-title">⚠ Web Stiffener filtered out by default</div>
        <div class="filtered-warning-copy">These Total Length entries will not affect the forecast unless you add them back.</div>
        ${(level.filteredMaterials || []).map((item, filteredIndex) => `
          <div class="filtered-item">
            <span>${escapeHtml(item.material)}</span>
            <strong>${formatNumber(item.requiredLf)} LF</strong>
            <button type="button" class="mini-button restore-filtered" data-level-index="${levelIndex}" data-filtered-index="${filteredIndex}">Add to project</button>
          </div>`).join("")}
      </div>` : ""}
      <div class="material-list">
        <div class="material-head"><span>Material</span><span>Total Length (LF)</span><span></span></div>
        ${level.materials.map((material, materialIndex) => `
          <div class="material-row">
            <input class="material-name" data-level-index="${levelIndex}" data-material-index="${materialIndex}" value="${escapeHtml(material.material)}" />
            <input class="material-lf" data-level-index="${levelIndex}" data-material-index="${materialIndex}" type="number" min="0" step="0.01" value="${material.requiredLf}" />
            <button class="remove-button remove-material" data-level-index="${levelIndex}" data-material-index="${materialIndex}" type="button" aria-label="Remove material">×</button>
          </div>`).join("")}
        <button class="button secondary add-material" data-level-index="${levelIndex}" type="button">+ Add Material</button>
      </div>
    </div>`).join("");
  renderDeliveryPreview();
}

function renderDeliveryPreview() {
  const preview = $("deliveryPreview");
  if (!preview) return;
  if (!draft?.levels?.length) {
    preview.classList.add("hidden");
    preview.innerHTML = "";
    return;
  }
  const hasAnyDate = draft.levels.some(level => level.estimatedDeliveryDate);
  if (!hasAnyDate) {
    preview.classList.add("hidden");
    preview.innerHTML = "";
    return;
  }
  preview.innerHTML = `
    <div class="delivery-preview-title">Delivery date preview</div>
    <div class="delivery-preview-list">
      ${draft.levels.map((level, index) => `
        <div class="delivery-preview-row">
          <span class="delivery-preview-level">${escapeHtml(level.name || `Level ${index + 1}`)}</span>
          <input class="preview-level-date delivery-preview-date-input" data-level-index="${index}" type="date" value="${escapeHtml(level.estimatedDeliveryDate || "")}" aria-label="Estimated delivery date for ${escapeHtml(level.name || `Level ${index + 1}`)}" />
          ${level.estimatedDeliveryDate ? `<span class="date-source-badge ${level.dateSource === "manual" ? "manual" : "auto"}">${level.dateSource === "manual" ? "Manual" : "Auto"}</span>` : `<span></span>`}
        </div>`).join("")}
    </div>`;
  preview.classList.remove("hidden");
}


function updateProjectTypeUi() {
  const isSfd = $("projectType")?.value === "sfd";
  const hint = $("projectTypeHint");
  if (hint) hint.textContent = isSfd
    ? "SFD dates are optional. Outstanding SFD material is grouped into the purchasing buffer unless the package is marked In Spruce."
    : "Multi-family levels appear in the 6-week delivery schedule. Estimated delivery dates are required.";
  if (draft) draft.projectType = isSfd ? "sfd" : "multi";
}

function applyManualDraftLevelDate(levelIndex, nextDate) {
  if (!draft?.levels?.[levelIndex]) return;
  draft.levels[levelIndex].estimatedDeliveryDate = nextDate || "";
  draft.levels[levelIndex].dateSource = nextDate ? "manual" : "";

  if ($("applyDateAll").checked) {
    // A manual exception breaks the "same date for all" rule, while preserving all current dates.
    $("applyDateAll").checked = false;
  } else if ($("staggerWeekly").checked) {
    // The edited level becomes a new anchor and every later level remains one week apart.
    if (levelIndex === 0) {
      $("projectDate").value = draft.levels[0].estimatedDeliveryDate || "";
      draft.defaultEstimatedDeliveryDate = $("projectDate").value;
    }
    continueWeeklyScheduleFrom(levelIndex);
  } else if (levelIndex === 0) {
    $("projectDate").value = draft.levels[0].estimatedDeliveryDate || "";
    draft.defaultEstimatedDeliveryDate = $("projectDate").value;
  }
  renderDraftLevels();
}

function syncDraftFromInputs() {
  if (!draft) return;
  draft.projectNumber = normalizeSpaces($("projectNumber").value).toUpperCase();
  draft.revision = normalizeSpaces($("revision").value).toUpperCase();
  draft.customer = normalizeSpaces($("customer").value);
  draft.sales = normalizeSpaces($("sales").value);
  draft.projectType = $("projectType")?.value === "sfd" ? "sfd" : "multi";
  draft.address = normalizeSpaces($("address").value);
  draft.defaultEstimatedDeliveryDate = $("projectDate").value;

  document.querySelectorAll(".level-name").forEach(input => {
    draft.levels[Number(input.dataset.levelIndex)].name = normalizeSpaces(input.value);
  });
  document.querySelectorAll(".level-date").forEach(input => {
    draft.levels[Number(input.dataset.levelIndex)].estimatedDeliveryDate = input.value;
  });
  document.querySelectorAll(".material-name").forEach(input => {
    draft.levels[Number(input.dataset.levelIndex)].materials[Number(input.dataset.materialIndex)].material = normalizeSpaces(input.value);
  });
  document.querySelectorAll(".material-lf").forEach(input => {
    draft.levels[Number(input.dataset.levelIndex)].materials[Number(input.dataset.materialIndex)].requiredLf = Number(input.value || 0);
  });
}

function resetIntake() {
  draft = null;
  $("pdfFile").value = "";
  $("projectNumber").value = "";
  $("revision").value = "";
  $("customer").value = "";
  $("sales").value = "";
  $("projectType").value = "multi";
  $("address").value = "";
  $("projectDate").value = "";
  $("applyDateAll").checked = false;
  $("staggerWeekly").checked = false;
  updateProjectTypeUi();
  $("parseStatus").className = "status muted";
  $("parseStatus").textContent = "No PDF selected.";
  $("reviewCard").classList.add("hidden");
  $("levelEditor").innerHTML = "";
  $("deliveryPreview").classList.add("hidden");
  $("deliveryPreview").innerHTML = "";
  clearIntakeValidation();
}

function projectToCloudRows(project) {
  const projectId = uid();
  const projectRow = {
    id: projectId,
    project_number: project.projectNumber,
    revision: project.revision || null,
    address_project_name: project.address || null,
    customer: project.customer || null,
    sales: project.sales || null,
    project_type: project.projectType === "sfd" ? "sfd" : "multi",
    default_delivery_date: project.defaultEstimatedDeliveryDate || null,
    version: 1
  };

  const levelRows = [];
  const materialRows = [];
  const deliveryRows = [];
  const levelIdMap = new Map();
  const materialIdMap = new Map();

  (project.levels || []).forEach((level, levelIndex) => {
    const levelId = uid();
    levelIdMap.set(level.id || `${levelIndex}`, levelId);
    levelRows.push({
      id: levelId,
      project_id: projectId,
      level_name: level.name,
      estimated_delivery_date: level.estimatedDeliveryDate || null,
      workflow_status: level.workflowStatus === "spruce" ? "spruce" : "forecast",
      is_active: true,
      display_order: levelIndex,
      version: 1
    });

    (level.materials || []).forEach((material, materialIndex) => {
      const materialId = uid();
      materialIdMap.set(`${level.id || levelIndex}|${material.id || materialIndex}|${normalizeMaterialKey(material.material)}`, materialId);
      materialRows.push({
        id: materialId,
        level_id: levelId,
        material_name: material.material,
        original_lf: Number(material.requiredLf || 0),
        is_active: true,
        version: 1
      });
    });

    (level.deliveries || []).forEach((delivery, deliveryIndex) => {
      const selectedDate = delivery.date || todayIso();
      const uniqueTime = new Date(Date.now() + deliveryIndex).toISOString().slice(11);
      const deliveredAt = `${selectedDate}T${uniqueTime}`;
      for (const item of delivery.items || []) {
        let materialId = null;
        const match = (level.materials || []).find((material, materialIndex) => {
          if (item.materialId && material.id === item.materialId) {
            materialId = materialIdMap.get(`${level.id || levelIndex}|${material.id || materialIndex}|${normalizeMaterialKey(material.material)}`);
            return true;
          }
          return normalizeMaterialKey(material.material) === normalizeMaterialKey(item.material);
        });
        if (!materialId && match) {
          const materialIndex = level.materials.indexOf(match);
          materialId = materialIdMap.get(`${level.id || levelIndex}|${match.id || materialIndex}|${normalizeMaterialKey(match.material)}`);
        }
        if (!materialId) continue;
        deliveryRows.push({
          id: uid(),
          level_id: levelId,
          material_id: materialId,
          delivered_lf: Number(item.lf || 0),
          delivered_at: deliveredAt,
          note: delivery.note || null
        });
      }
    });
  });

  return { projectId, projectRow, levelRows, materialRows, deliveryRows };
}

async function createProjectGraph(project) {
  const rows = projectToCloudRows(project);
  let insertedProject = false;
  try {
    await insertRows("projects", rows.projectRow);
    insertedProject = true;
    if (rows.levelRows.length) await insertRows("levels", rows.levelRows);
    if (rows.materialRows.length) await insertRows("materials", rows.materialRows);
    if (rows.deliveryRows.length) await insertRows("deliveries", rows.deliveryRows);
    return rows.projectId;
  } catch (error) {
    if (insertedProject) {
      try { await deleteRows("projects", { id: `eq.${rows.projectId}` }); }
      catch (cleanupError) { console.warn("Could not clean up failed project insert", cleanupError); }
    }
    throw error;
  }
}

function clearIntakeValidation() {
  ["projectNumber", "address", "projectDate"].forEach(id => $(id)?.classList.remove("input-invalid"));
  document.querySelectorAll(".level-name, .level-date, .material-name, .material-lf").forEach(input => input.classList.remove("input-invalid"));
  const message = $("intakeValidationMessage");
  if (message) {
    message.textContent = "";
    message.classList.add("hidden");
  }
}

function showIntakeValidation(message, target = null) {
  const el = $("intakeValidationMessage");
  if (el) {
    el.textContent = message;
    el.classList.remove("hidden");
  }
  if (target) {
    target.classList.add("input-invalid");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    requestAnimationFrame(() => target.focus?.());
  }
}

function validDraftMaterials(level) {
  return (level.materials || []).filter(item => normalizeSpaces(item.material) && Number(item.requiredLf) > 0);
}

function validateDraftForReview() {
  clearIntakeValidation();
  if (!draft) {
    showIntakeValidation("Upload a material-list PDF before reviewing the project.");
    return false;
  }
  syncDraftFromInputs();
  const projectDate = $("projectDate").value;
  const isMulti = draft.projectType !== "sfd";

  if (!draft.projectNumber) {
    showIntakeValidation("Project # is required.", $("projectNumber"));
    return false;
  }
  if (!draft.address) {
    showIntakeValidation("Address (Project Name) is required.", $("address"));
    return false;
  }
  if (!draft.levels.length) {
    showIntakeValidation("At least one level is required.");
    return false;
  }

  if ($("applyDateAll").checked && projectDate) {
    draft.levels.forEach(level => {
      level.estimatedDeliveryDate = projectDate;
      level.dateSource = "auto";
    });
  }

  for (let index = 0; index < draft.levels.length; index += 1) {
    const level = draft.levels[index];
    const levelNameInput = document.querySelector(`.level-name[data-level-index="${index}"]`);
    const levelDateInput = document.querySelector(`.level-date[data-level-index="${index}"]`);
    if (!level.name) {
      showIntakeValidation("Every level needs a name.", levelNameInput);
      return false;
    }
    if (isMulti && !level.estimatedDeliveryDate) {
      showIntakeValidation(`Enter an estimated delivery date for ${level.name}.`, levelDateInput);
      return false;
    }
    if (!validDraftMaterials(level).length) {
      showIntakeValidation(`${level.name} needs at least one material with a positive Total Length.`);
      return false;
    }
  }
  renderDraftLevels();
  return true;
}

function projectReviewSummaryHtml() {
  const levelRows = draft.levels.map((level, index) => {
    const included = validDraftMaterials(level);
    const levelLf = included.reduce((sum, item) => sum + Number(item.requiredLf || 0), 0);
    return `
      <div class="review-level-row">
        <div>
          <strong>${escapeHtml(level.name || `Level ${index + 1}`)}</strong>
          <span>${included.length} material line${included.length === 1 ? "" : "s"} · ${formatNumber(levelLf)} LF</span>
        </div>
        <div class="review-level-date">
          <strong>${escapeHtml(level.estimatedDeliveryDate ? formatDate(level.estimatedDeliveryDate) : "Not scheduled")}</strong>
          ${level.estimatedDeliveryDate ? `<span class="date-source-badge ${level.dateSource === "manual" ? "manual" : "auto"}">${level.dateSource === "manual" ? "Manual" : "Auto"}</span>` : ""}
        </div>
      </div>`;
  }).join("");

  const validMaterials = draft.levels.flatMap(level => validDraftMaterials(level));
  const uniqueTypes = new Set(validMaterials.map(item => normalizeMaterialKey(item.material))).size;
  const totalLf = validMaterials.reduce((sum, item) => sum + Number(item.requiredLf || 0), 0);
  const filtered = draft.levels.flatMap(level => (level.filteredMaterials || []).map(item => ({ ...item, levelName: level.name })));

  return `
    <section class="review-project-identity">
      <h3>${escapeHtml(draft.address)}</h3>
      <div class="review-project-meta">
        <span><strong>Project #</strong> ${escapeHtml(draft.projectNumber || "—")}</span>
        <span><strong>Revision</strong> ${escapeHtml(draft.revision || "—")}</span>
        <span><strong>Customer</strong> ${escapeHtml(draft.customer || "—")}</span>
        <span><strong>Sales</strong> ${escapeHtml(draft.sales || "—")}</span>
        <span><strong>Project Type</strong> ${draft.projectType === "sfd" ? "SFD" : "Multi-family"}</span>
      </div>
    </section>
    <section class="review-section">
      <div class="review-section-heading">
        <h3>${draft.projectType === "sfd" ? "Package Dates (optional for SFD)" : "Estimated Delivery Dates"}</h3>
        <span>${draft.levels.length} package${draft.levels.length === 1 ? "" : "s"}</span>
      </div>
      <div class="review-level-list">${levelRows}</div>
    </section>
    <div class="review-summary-strip">
      <span><strong>${draft.levels.length}</strong> package${draft.levels.length === 1 ? "" : "s"}</span>
      <span><strong>${uniqueTypes}</strong> material type${uniqueTypes === 1 ? "" : "s"}</span>
      <span><strong>${formatNumber(totalLf)}</strong> total LF</span>
    </div>
    ${filtered.length ? `
      <div class="review-filter-warning">
        <strong>⚠ ${filtered.length} filtered Web Stiffener entr${filtered.length === 1 ? "y remains" : "ies remain"} excluded</strong>
        <span>These items will not be added to the project unless you go back and add them.</span>
        <div>${filtered.map(item => `<span>${escapeHtml(item.levelName)} · ${escapeHtml(item.material)} · ${formatNumber(item.requiredLf)} LF</span>`).join("")}</div>
      </div>` : ""}`;
}

function openProjectReview() {
  if (!validateDraftForReview()) return;
  $("projectReviewContent").innerHTML = projectReviewSummaryHtml();
  const dialog = $("projectReviewDialog");
  dialog.returnValue = "";
  dialog.showModal();
  requestAnimationFrame(() => $("confirmProjectSave")?.focus());
}

async function reconcileProjectRevision(existing, projectRecord) {
  const now = new Date().toISOString();
  const updatedProject = await updateRows("projects", { id: `eq.${existing.id}`, version: `eq.${existing.version}` }, {
    project_number: projectRecord.projectNumber,
    revision: projectRecord.revision || null,
    customer: projectRecord.customer || null,
    sales: projectRecord.sales || null,
    address_project_name: projectRecord.address || null,
    project_type: projectRecord.projectType === "sfd" ? "sfd" : "multi",
    default_delivery_date: projectRecord.defaultEstimatedDeliveryDate || null,
    updated_at: now,
    version: existing.version + 1
  });
  if (!updatedProject?.length) throw new Error("This project changed while the revision was being applied. Refresh and try again.");

  const usedLevelIds = new Set();
  const summary = { levelsAdded: 0, levelsUpdated: 0, levelsArchived: 0, materialsAdded: 0, materialsUpdated: 0, materialsArchived: 0, exclusionsAdjusted: 0 };

  for (let levelIndex = 0; levelIndex < projectRecord.levels.length; levelIndex += 1) {
    const incomingLevel = projectRecord.levels[levelIndex];
    const levelKey = normalizeSpaces(incomingLevel.name).toLowerCase();
    const existingLevel = (existing.levels || []).find(level => !usedLevelIds.has(level.id) && normalizeSpaces(level.name).toLowerCase() === levelKey);

    if (!existingLevel) {
      const levelId = uid();
      await insertRows("levels", {
        id: levelId,
        project_id: existing.id,
        level_name: incomingLevel.name,
        estimated_delivery_date: incomingLevel.estimatedDeliveryDate || null,
        workflow_status: "forecast",
        is_active: true,
        display_order: levelIndex,
        version: 1
      });
      const materials = validDraftMaterials(incomingLevel).map(material => ({
        id: uid(),
        level_id: levelId,
        material_name: material.material,
        original_lf: Number(material.requiredLf || 0),
        excluded_lf: 0,
        is_active: true,
        version: 1
      }));
      if (materials.length) await insertRows("materials", materials);
      summary.levelsAdded += 1;
      summary.materialsAdded += materials.length;
      continue;
    }

    usedLevelIds.add(existingLevel.id);
    const levelUpdated = await updateRows("levels", { id: `eq.${existingLevel.id}`, version: `eq.${existingLevel.version}` }, {
      level_name: incomingLevel.name,
      estimated_delivery_date: incomingLevel.estimatedDeliveryDate || null,
      display_order: levelIndex,
      is_active: true,
      updated_at: now,
      version: existingLevel.version + 1
    });
    if (!levelUpdated?.length) throw new Error(`${existingLevel.name} changed while the revision was being applied.`);
    summary.levelsUpdated += 1;

    const usedMaterialIds = new Set();
    for (const incomingMaterial of validDraftMaterials(incomingLevel)) {
      const materialKey = normalizeMaterialKey(incomingMaterial.material);
      const existingMaterial = (existingLevel.materials || []).find(material => !usedMaterialIds.has(material.id) && normalizeMaterialKey(material.material) === materialKey);
      if (!existingMaterial) {
        await insertRows("materials", {
          id: uid(),
          level_id: existingLevel.id,
          material_name: incomingMaterial.material,
          original_lf: Number(incomingMaterial.requiredLf || 0),
          excluded_lf: 0,
          is_active: true,
          version: 1
        });
        summary.materialsAdded += 1;
        continue;
      }

      usedMaterialIds.add(existingMaterial.id);
      const nextRequired = Number(incomingMaterial.requiredLf || 0);
      const delivered = deliveredFor(existingLevel, existingMaterial);
      const priorExcluded = excludedFor(existingMaterial);
      const nextExcluded = Math.min(priorExcluded, Math.max(0, nextRequired - delivered));
      if (Math.abs(nextExcluded - priorExcluded) > EPSILON) summary.exclusionsAdjusted += 1;
      const materialUpdated = await updateRows("materials", { id: `eq.${existingMaterial.id}`, version: `eq.${existingMaterial.version}` }, {
        material_name: incomingMaterial.material,
        original_lf: nextRequired,
        excluded_lf: nextExcluded,
        is_active: true,
        updated_at: now,
        version: existingMaterial.version + 1
      });
      if (!materialUpdated?.length) throw new Error(`${incomingMaterial.material} changed while the revision was being applied.`);
      summary.materialsUpdated += 1;
    }

    for (const existingMaterial of existingLevel.materials || []) {
      if (usedMaterialIds.has(existingMaterial.id)) continue;
      const archived = await updateRows("materials", { id: `eq.${existingMaterial.id}`, version: `eq.${existingMaterial.version}` }, {
        is_active: false,
        updated_at: now,
        version: existingMaterial.version + 1
      });
      if (!archived?.length) throw new Error(`${existingMaterial.material} changed while the revision was being applied.`);
      summary.materialsArchived += 1;
    }
  }

  for (const existingLevel of existing.levels || []) {
    if (usedLevelIds.has(existingLevel.id)) continue;
    const archived = await updateRows("levels", { id: `eq.${existingLevel.id}`, version: `eq.${existingLevel.version}` }, {
      is_active: false,
      updated_at: now,
      version: existingLevel.version + 1
    });
    if (!archived?.length) throw new Error(`${existingLevel.name} changed while the revision was being applied.`);
    summary.levelsArchived += 1;
  }

  return summary;
}

async function persistDraftProject() {
  if (!draft) return;
  if (!validateDraftForReview()) {
    $("projectReviewDialog")?.close("cancel");
    return;
  }

  const saveButton = $("confirmProjectSave");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  try {
    await syncFromCloud({ silent: true });
    const existing = state.projects.find(project => project.projectNumber.toLowerCase() === draft.projectNumber.toLowerCase());
    if (existing) {
      const message = `Project ${draft.projectNumber} already exists${existing.revision ? ` (${existing.revision})` : ""}.\n\nApply ${draft.revision || "this upload"} as a revision?\n\nExisting deliveries and audit history will be preserved. Matching levels/materials will be updated, new items added, and items removed by the revision archived from the active forecast.`;
      if (!confirm(message)) return;
    }

    const projectRecord = {
      projectNumber: draft.projectNumber,
      revision: draft.revision,
      customer: draft.customer,
      sales: draft.sales,
      projectType: draft.projectType === "sfd" ? "sfd" : "multi",
      address: draft.address,
      defaultEstimatedDeliveryDate: draft.defaultEstimatedDeliveryDate,
      levels: draft.levels.map(level => ({
        ...level,
        workflowStatus: "forecast",
        materials: validDraftMaterials(level)
      }))
    };

    let projectId;
    if (existing) {
      const summary = await reconcileProjectRevision(existing, projectRecord);
      projectId = existing.id;
      await recordActivity("project", projectId, "apply_revision", {
        project_number: draft.projectNumber,
        from_revision: existing.revision || "",
        to_revision: draft.revision || "",
        address_project_name: draft.address,
        project_type: projectRecord.projectType,
        ...summary
      });
    } else {
      projectId = await createProjectGraph(projectRecord);
      await recordActivity("project", projectId, "create_project", {
        project_number: draft.projectNumber,
        revision: draft.revision,
        address_project_name: draft.address,
        customer: draft.customer,
        sales: draft.sales,
        project_type: projectRecord.projectType
      });
    }

    setProjectCollapsed(projectId, draft.levels.length > 1);
    if ($("projectReviewDialog")?.open) $("projectReviewDialog").close("saved");
    resetIntake();
    await syncFromCloud({ silent: true });
    setTab("matrix");
  } catch (error) {
    console.error(error);
    alert(`Could not save the project to shared data.\n\n${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Confirm & Add Project";
  }
}
function projectMatchesMatrixSearch(project) {
  const query = normalizeSpaces($("projectSearch")?.value || "").toLowerCase();
  if (!query) return true;
  const haystack = [
    project.projectNumber,
    project.revision,
    project.address,
    project.customer,
    project.sales
  ].map(value => normalizeSpaces(value || "")).join(" ").toLowerCase();
  return haystack.includes(query);
}

function visibleProjects(showDelivered, { ignoreSearch = false } = {}) {
  return state.projects
    .map(project => {
      const visibleLevels = (project.levels || []).filter(level => showDelivered || levelStats(level).status !== "delivered");
      return { project, visibleLevels };
    })
    .filter(item => item.visibleLevels.length > 0)
    .filter(item => ignoreSearch || projectMatchesMatrixSearch(item.project));
}

function buildMatrixColumns(showDelivered) {
  const columns = [];
  for (const { project, visibleLevels } of visibleProjects(showDelivered)) {
    const canCollapse = (project.levels || []).length > 1;
    if (canCollapse && isProjectCollapsed(project)) columns.push({ type: "project", project, levels: visibleLevels });
    else for (const level of visibleLevels) columns.push({ type: "level", project, level, levels: [level] });
  }
  return columns;
}

function columnMaterialStats(column, materialKey) {
  let required = 0;
  let delivered = 0;
  let excluded = 0;
  let outstanding = 0;
  let found = false;
  for (const level of column.levels) {
    for (const material of level.materials || []) {
      if (normalizeMaterialKey(material.material) !== materialKey) continue;
      found = true;
      required += Number(material.requiredLf || 0);
      delivered += deliveredFor(level, material);
      excluded += excludedFor(material);
      outstanding += outstandingFor(level, material);
    }
  }
  return { found, required, delivered, excluded, outstanding };
}

function levelHeaderHtml(project, level) {
  const stats = levelStats(level);
  const plan = planningStatus(level);
  const multiLevel = (project.levels || []).length > 1;
  return `<th class="project-col level-project-col">
    <div class="project-header-card">
      ${projectMetaHtml(project)}
      <div class="operational-line"><strong>${escapeHtml(level.name)}</strong> · ${escapeHtml(level.estimatedDeliveryDate ? formatDate(level.estimatedDeliveryDate) : "No date")}</div>
      ${progressHtml(stats.percent, "level complete")}
      <div class="project-card-actions">
        <span class="status-badge workflow-${plan}">${planningStatusLabel(plan)}</span>
        <button class="mini-button manage-level" data-project-id="${project.id}" data-level-id="${level.id}">Manage</button>
        <button class="mini-button edit-project" data-project-id="${project.id}">Edit</button>
        ${multiLevel ? `<button class="mini-button toggle-project-collapse" data-project-id="${project.id}">Collapse</button>` : ""}
      </div>
    </div>
  </th>`;
}

function collapsedProjectHeaderHtml(project) {
  const stats = projectStats(project);
  const next = stats.nextLevel;
  const packageWord = stats.packagesRemaining === 1 ? "package" : "packages";
  return `<th class="project-col collapsed-project-col">
    <div class="project-header-card collapsed-summary-card">
      ${projectMetaHtml(project)}
      ${next ? `<div class="operational-line"><strong>Next:</strong> ${escapeHtml(next.name)} · ${escapeHtml(formatDate(next.estimatedDeliveryDate))}</div>` : `<div class="operational-line"><strong>Project complete</strong></div>`}
      <div class="package-line">${stats.packagesRemaining} ${packageWord} remaining</div>
      ${progressHtml(stats.percent, "overall complete")}
      <div class="project-card-actions">
        <span class="status-badge workflow-${next ? planningStatus(next) : "delivered"}">${planningStatusLabel(next ? planningStatus(next) : "delivered")}</span>
        <button class="mini-button edit-project" data-project-id="${project.id}">Edit</button>
        <button class="mini-button toggle-project-collapse" data-project-id="${project.id}">Expand</button>
      </div>
    </div>
  </th>`;
}

function openProjectEdit(projectId) {
  const project = state.projects.find(item => item.id === projectId);
  if (!project) return;
  activeEditProject = project;
  $("editProjectNumber").value = project.projectNumber || "";
  $("editRevision").value = project.revision || "";
  $("editCustomer").value = project.customer || "";
  $("editSales").value = project.sales || "";
  $("editProjectType").value = project.projectType === "sfd" ? "sfd" : "multi";
  $("editAddress").value = project.address || "";
  $("editProjectDate").value = project.defaultEstimatedDeliveryDate || "";
  $("editApplyDateAll").checked = false;
  $("projectEditDialog").showModal();
}

async function saveProjectEdit() {
  if (!activeEditProject) return;
  const projectId = activeEditProject.id;
  const projectVersion = activeEditProject.version;
  const projectNumber = normalizeSpaces($("editProjectNumber").value).toUpperCase();
  const revision = normalizeSpaces($("editRevision").value).toUpperCase();
  const customer = normalizeSpaces($("editCustomer").value);
  const sales = normalizeSpaces($("editSales").value);
  const projectType = $("editProjectType")?.value === "sfd" ? "sfd" : "multi";
  const address = normalizeSpaces($("editAddress").value);
  const defaultDate = $("editProjectDate").value;
  const applyAll = $("editApplyDateAll").checked;

  if (!projectNumber) return alert("Project # is required.");
  if (!address) return alert("Address (Project Name) is required.");
  if (applyAll && !defaultDate) return alert("Choose a project default delivery date before applying it to all levels.");
  const undatedLevels = (activeEditProject.levels || []).filter(level => !level.estimatedDeliveryDate);
  if (projectType === "multi" && undatedLevels.length && !(applyAll && defaultDate)) {
    return alert(`Multi-family packages need estimated delivery dates. ${undatedLevels.length} package${undatedLevels.length === 1 ? " is" : "s are"} currently undated. Choose a default date and Apply to all levels, or set the package dates before changing the project type.`);
  }

  const duplicate = state.projects.find(item => item.id !== projectId && item.projectNumber.toLowerCase() === projectNumber.toLowerCase());
  if (duplicate) return alert(`Project # ${projectNumber} already exists.`);

  const fieldChanges = {};
  const compared = [
    ["Project #", activeEditProject.projectNumber || "", projectNumber],
    ["Revision", activeEditProject.revision || "", revision],
    ["Customer", activeEditProject.customer || "", customer],
    ["Sales", activeEditProject.sales || "", sales],
    ["Project Type", activeEditProject.projectType === "sfd" ? "SFD" : "Multi-family", projectType === "sfd" ? "SFD" : "Multi-family"],
    ["Address (Project Name)", activeEditProject.address || "", address],
    ["Project default delivery date", activeEditProject.defaultEstimatedDeliveryDate || "", defaultDate]
  ];
  for (const [label, from, to] of compared) {
    if (String(from) !== String(to)) fieldChanges[label] = { from, to };
  }

  const button = $("saveProjectEdit");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const updated = await updateRows("projects", { id: `eq.${projectId}`, version: `eq.${projectVersion}` }, {
      project_number: projectNumber,
      revision: revision || null,
      customer: customer || null,
      sales: sales || null,
      project_type: projectType,
      address_project_name: address,
      default_delivery_date: defaultDate || null,
      updated_at: new Date().toISOString(),
      version: projectVersion + 1
    });
    if (!updated?.length) throw new Error("This project was changed by another user while you were editing it. The shared data will be reloaded so you can review the latest version.");

    if (applyAll) {
      for (const level of activeEditProject.levels || []) {
        const changed = await updateRows("levels", { id: `eq.${level.id}`, version: `eq.${level.version}` }, {
          estimated_delivery_date: defaultDate,
          updated_at: new Date().toISOString(),
          version: level.version + 1
        });
        if (!changed?.length) throw new Error(`${level.name} was changed by another user while you were editing the project.`);
      }
    }

    await recordActivity("project", projectId, "update_project", { project_number: projectNumber, address_project_name: address, changes: fieldChanges, apply_date_to_all_levels: applyAll });
    $("projectEditDialog").close("saved");
    activeEditProject = null;
    await syncFromCloud({ silent: true });
    setTab("matrix");
  } catch (error) {
    console.error(error);
    alert(error.message);
    await syncFromCloud({ silent: true });
  } finally {
    button.disabled = false;
    button.textContent = "Save Project";
  }
}

function closeDialogToMatrix(dialog) {
  if (dialog.open) dialog.close("cancel");
  setTab("matrix");
}

function wireBackdropClose(dialog) {
  dialog.addEventListener("click", event => {
    const rect = dialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (event.target === dialog || outside) closeDialogToMatrix(dialog);
  });
  dialog.addEventListener("close", () => {
    setTab("matrix");
    if (dialog.id === "deliveryDialog") activeDelivery = null;
    if (dialog.id === "projectEditDialog") activeEditProject = null;
  });
}

function wireReviewBackdropClose() {
  const dialog = $("projectReviewDialog");
  dialog.addEventListener("click", event => {
    const rect = dialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (event.target === dialog || outside) dialog.close("cancel");
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "saved") requestAnimationFrame(() => $("saveProject")?.focus());
  });
}

function updateMatrixTopScrollbar() {
  const wrap = $("matrixWrap");
  const topScroll = $("matrixTopScroll");
  const spacer = $("matrixTopScrollInner");
  if (!wrap || !topScroll || !spacer || wrap.classList.contains("hidden")) return;
  const contentWidth = Math.max(wrap.scrollWidth, wrap.clientWidth);
  spacer.style.width = `${contentWidth}px`;
  const hasHorizontalOverflow = wrap.scrollWidth > wrap.clientWidth + 1;
  topScroll.classList.toggle("no-overflow", !hasHorizontalOverflow);
  const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  matrixScrollLeft = Math.min(matrixScrollLeft, maxLeft);
  wrap.scrollLeft = matrixScrollLeft;
  wrap.scrollTop = Math.min(matrixScrollTop, Math.max(0, wrap.scrollHeight - wrap.clientHeight));
  topScroll.scrollLeft = wrap.scrollLeft;
}

function renderMatrix() {
  const showDelivered = $("showDelivered").checked;
  const query = normalizeSpaces($("projectSearch")?.value || "");
  const eligibleProjects = visibleProjects(showDelivered, { ignoreSearch: true });
  const matchingProjects = visibleProjects(showDelivered);
  const columns = buildMatrixColumns(showDelivered);
  const levelRefs = columns.flatMap(column => column.levels.map(level => ({ project: column.project, level })));
  const materials = uniqueMaterials(levelRefs);
  const wrap = $("matrixWrap");
  const empty = $("matrixEmpty");
  const count = $("projectSearchCount");
  const clear = $("clearProjectSearch");

  if (count) {
    count.textContent = query
      ? `${matchingProjects.length} of ${eligibleProjects.length} project${eligibleProjects.length === 1 ? "" : "s"}`
      : `${eligibleProjects.length} project${eligibleProjects.length === 1 ? "" : "s"}`;
  }
  clear?.classList.toggle("hidden", !query);

  if (!columns.length || !materials.length) {
    empty.textContent = query ? "No projects match this search." : "Add a project to build the material matrix.";
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    $("matrixTopScroll").classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  empty.textContent = "Add a project to build the material matrix.";

  const head = columns.map(column => column.type === "project" ? collapsedProjectHeaderHtml(column.project) : levelHeaderHtml(column.project, column.level)).join("");
  const rows = materials.map(materialName => {
    const key = normalizeMaterialKey(materialName);
    const cells = columns.map(column => {
      const stats = columnMaterialStats(column, key);
      if (!stats.found) return `<td class="cell-zero">—</td>`;
      const cls = stats.excluded > EPSILON
        ? (stats.outstanding <= EPSILON ? "cell-excluded" : "cell-partial")
        : stats.outstanding <= EPSILON ? "cell-delivered" : stats.delivered > EPSILON ? "cell-partial" : "";
      const exclusionNote = stats.excluded > EPSILON ? `<div class="cell-subnote">${formatNumber(stats.excluded)} excluded</div>` : "";
      return `<td class="${cls}">${stats.outstanding <= EPSILON ? "0" : formatNumber(stats.outstanding)}${exclusionNote}</td>`;
    }).join("");
    return `<tr><td class="material-col">${escapeHtml(materialName)}</td>${cells}</tr>`;
  }).join("");

  wrap.innerHTML = `<table><thead><tr><th class="material-col">Material / Outstanding LF</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  $("matrixTopScroll").classList.remove("hidden");
  empty.classList.add("hidden");
  requestAnimationFrame(updateMatrixTopScrollbar);
}

function startOfWeekIso(date = todayIso()) {
  const [y, m, d] = String(date).split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d));
  const day = value.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function weekIndexForDate(date, firstWeekStart) {
  if (!date || !firstWeekStart) return -1;
  const a = Date.parse(`${firstWeekStart}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
  return Math.floor((b - a) / (7 * 86400000));
}

function weekLabel(weekStart) {
  const weekEnd = addDaysIso(weekStart, 6);
  const [sy, sm, sd] = weekStart.split("-").map(Number);
  const [ey, em, ed] = weekEnd.split("-").map(Number);
  const startText = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(new Date(Date.UTC(sy, sm - 1, sd)));
  const endText = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(new Date(Date.UTC(ey, em - 1, ed)));
  return `${startText}–${endText}`;
}

function sixWeekStarts() {
  const first = startOfWeekIso();
  return Array.from({ length: 6 }, (_, index) => addDaysIso(first, index * 7));
}

function sixWeekMultiLevels() {
  const weeks = sixWeekStarts();
  const first = weeks[0];
  const last = addDaysIso(weeks[5], 6);
  return allLevels()
    .filter(({ project, level }) => project.projectType !== "sfd" && levelStats(level).outstanding > EPSILON && level.estimatedDeliveryDate)
    // Keep overdue packages visible until their date is corrected or material is delivered.
    .filter(({ level }) => level.estimatedDeliveryDate <= last)
    .sort((a, b) => a.level.estimatedDeliveryDate.localeCompare(b.level.estimatedDeliveryDate) || a.project.projectNumber.localeCompare(b.project.projectNumber));
}

function renderWeeklySchedule() {
  const wrap = $("weeklyScheduleWrap");
  const empty = $("weeklyScheduleEmpty");
  if (!wrap || !empty) return;
  const refs = sixWeekMultiLevels();
  if (!refs.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  const firstWeek = sixWeekStarts()[0];
  const rows = refs.map(({ project, level }) => {
    const stats = levelStats(level);
    const plan = planningStatus(level);
    const weekIndex = weekIndexForDate(level.estimatedDeliveryDate, firstWeek);
    const overdue = weekIndex < 0;
    const weekStart = addDaysIso(firstWeek, Math.max(0, weekIndex) * 7);
    return `<tr class="${overdue ? "schedule-overdue" : ""}">
      <td>${overdue ? "OVERDUE" : escapeHtml(`Week ${weekIndex + 1}`)}</td>
      <td>${overdue ? "Before current week" : escapeHtml(weekLabel(weekStart))}</td>
      <td>${escapeHtml(formatDate(level.estimatedDeliveryDate))}</td>
      <td class="weekly-project-cell"><strong>${escapeHtml(project.projectNumber || "—")}</strong><span>${escapeHtml(project.address || "")}</span></td>
      <td>${escapeHtml(level.name)}</td>
      <td><span class="status-badge workflow-${plan}">${planningStatusLabel(plan)}</span></td>
      <td>${formatNumber(stats.outstanding)}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table class="weekly-schedule-table"><thead><tr><th>Week</th><th>Week Range</th><th>Estimated Date</th><th>Project</th><th>Level</th><th>Status</th><th>Outstanding LF</th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
}

function renderWeeklyMaterialForecast() {
  const wrap = $("weeklyMaterialWrap");
  const empty = $("weeklyMaterialEmpty");
  if (!wrap || !empty) return;
  const weeks = sixWeekStarts();
  const refs = sixWeekMultiLevels();
  const materials = uniqueMaterials(refs);
  if (!refs.length || !materials.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  const firstWeek = weeks[0];
  const rows = materials.map(materialName => {
    const key = normalizeMaterialKey(materialName);
    const cells = weeks.map((weekStart, weekIndex) => {
      let total = 0;
      for (const { level } of refs) {
        if (weekIndexForDate(level.estimatedDeliveryDate, firstWeek) !== weekIndex) continue;
        for (const material of level.materials || []) {
          if (normalizeMaterialKey(material.material) === key) total += outstandingFor(level, material);
        }
      }
      return `<td class="${total > EPSILON ? "month-total" : "cell-zero"}">${total > EPSILON ? formatNumber(total) : "—"}</td>`;
    }).join("");
    return `<tr><td class="material-col">${escapeHtml(materialName)}</td>${cells}</tr>`;
  }).join("");
  wrap.innerHTML = `<table><thead><tr><th class="material-col">Material / Outstanding LF</th>${weeks.map((week, index) => `<th>W${index + 1}<span class="table-head-sub">${escapeHtml(weekLabel(week))}</span></th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
}

function renderMonthlyForecast() {
  const datedLevels = allLevels().filter(({ project, level }) => project.projectType !== "sfd" && level.estimatedDeliveryDate && levelStats(level).outstanding > EPSILON);
  const months = [...new Set(datedLevels.map(({ level }) => monthKey(level.estimatedDeliveryDate)))].sort();
  const materials = uniqueMaterials(datedLevels);
  const wrap = $("forecastWrap");
  const empty = $("forecastEmpty");

  if (!months.length || !materials.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  const rows = materials.map(materialName => {
    const key = normalizeMaterialKey(materialName);
    const cells = months.map(month => {
      let total = 0;
      for (const { level } of datedLevels) {
        if (monthKey(level.estimatedDeliveryDate) !== month) continue;
        for (const material of level.materials || []) {
          if (normalizeMaterialKey(material.material) === key) total += outstandingFor(level, material);
        }
      }
      return `<td class="${total > 0 ? "month-total" : "cell-zero"}">${total > 0 ? formatNumber(total) : "—"}</td>`;
    }).join("");
    return `<tr><td class="material-col">${escapeHtml(materialName)}</td>${cells}</tr>`;
  }).join("");

  wrap.innerHTML = `<table><thead><tr><th class="material-col">Material / Outstanding LF</th>${months.map(month => `<th>${escapeHtml(monthLabel(month))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
}

function renderForecast() {
  renderWeeklySchedule();
  renderWeeklyMaterialForecast();
  renderMonthlyForecast();
}

function incomingRemaining(order) {
  return Math.max(0, Number(order.quantityLf || 0) - Number(order.receivedLf || 0));
}

function allKnownMaterialNames() {
  const map = new Map();
  for (const name of uniqueMaterials()) {
    const key = normalizeMaterialKey(name);
    if (key) map.set(key, name);
  }
  for (const item of state.inventoryMaterials || []) {
    const key = normalizeMaterialKey(item.material);
    if (key && !map.has(key)) map.set(key, item.material);
  }
  for (const order of state.incomingOrders || []) {
    const key = normalizeMaterialKey(order.material);
    if (key && !map.has(key)) map.set(key, order.material);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function inventoryProfileFor(materialName) {
  const key = normalizeMaterialKey(materialName);
  return (state.inventoryMaterials || []).find(item => normalizeMaterialKey(item.material) === key) || null;
}

function incomingForMaterial(materialName) {
  const key = normalizeMaterialKey(materialName);
  return (state.incomingOrders || []).filter(order => normalizeMaterialKey(order.material) === key && incomingRemaining(order) > EPSILON);
}

function demandBreakdownFor(materialName, leadTimeWeeks = 6) {
  const key = normalizeMaterialKey(materialName);
  const cutoff = addDaysIso(todayIso(), Math.max(0, Number(leadTimeWeeks || 0)) * 7);
  let committed = 0;
  let multiForecast = 0;
  let multiDueInLeadTime = 0;
  let sfdBuffer = 0;

  for (const { project, level } of allLevels()) {
    for (const material of level.materials || []) {
      if (normalizeMaterialKey(material.material) !== key) continue;
      const outstanding = outstandingFor(level, material);
      if (outstanding <= EPSILON) continue;
      if (level.workflowStatus === "spruce") {
        committed += outstanding;
      } else if (project.projectType === "sfd") {
        sfdBuffer += outstanding;
      } else {
        multiForecast += outstanding;
        if (level.estimatedDeliveryDate && level.estimatedDeliveryDate <= cutoff) multiDueInLeadTime += outstanding;
      }
    }
  }
  return { cutoff, committed, multiForecast, multiDueInLeadTime, sfdBuffer };
}

function inventoryCalculation(materialName) {
  const profile = inventoryProfileFor(materialName);
  const onHand = Number(profile?.onHandLf || 0);
  const leadTimeWeeks = Number(profile?.leadTimeWeeks ?? 6);
  const demand = demandBreakdownFor(materialName, leadTimeWeeks);
  const orders = incomingForMaterial(materialName);
  const incomingOpen = orders.reduce((sum, order) => sum + incomingRemaining(order), 0);
  const incomingDue = orders.reduce((sum, order) => sum + ((order.expectedDate && order.expectedDate <= demand.cutoff) ? incomingRemaining(order) : 0), 0);
  const needInLeadTime = demand.committed + demand.sfdBuffer + demand.multiDueInLeadTime;
  const stockOwed = Math.max(0, needInLeadTime - onHand - incomingDue);
  const availableNow = onHand - demand.committed;
  const projectedBalance = onHand + incomingOpen - demand.committed - demand.multiForecast - demand.sfdBuffer;
  return { profile, onHand, leadTimeWeeks, ...demand, incomingOpen, incomingDue, needInLeadTime, stockOwed, availableNow, projectedBalance };
}

function purchaseOrderForId(id) {
  return (state.purchaseOrders || []).find(order => order.id === id) || null;
}

function purchaseOrderForNumber(poNumber) {
  const key = normalizeSpaces(poNumber || "").toLowerCase();
  if (!key) return null;
  return (state.purchaseOrders || []).find(order => normalizeSpaces(order.poNumber || "").toLowerCase() === key) || null;
}

function materialDimensionValues(materialName) {
  const values = [];
  const text = String(materialName || "");
  const regex = /(\d+(?:\.\d+)?)(?:[-\s]+(\d+)\s*\/\s*(\d+))?\s*(?=["”]|\bx\b)/gi;
  let match;
  while ((match = regex.exec(text))) {
    let value = Number(match[1]);
    if (match[2] && match[3] && Number(match[3])) value += Number(match[2]) / Number(match[3]);
    if (Number.isFinite(value)) values.push(Math.round(value * 10000) / 10000);
  }
  return values;
}

function materialMatchSignature(materialName) {
  const normalized = normalizePoMaterialDescription(materialName).toUpperCase();
  const tji = normalized.match(/\bTJI\s*(\d+)\b/);
  const dims = materialDimensionValues(normalized);
  if (tji && dims.length) return `TJI|${tji[1]}|${Math.max(...dims)}`;

  const type = /\bLSL\b/.test(normalized) ? "LSL" : /\bLVL\b/.test(normalized) ? "LVL" : "";
  if (type && dims.length >= 2) {
    const sorted = [...dims].sort((a, b) => a - b);
    const grade = normalized.match(/\b(?:\d+(?:\.\d+)?E|SSS)\b/)?.[0] || "";
    return `${type}|${sorted[0]}|${sorted[sorted.length - 1]}|${grade}`;
  }
  return "";
}

function canonicalPurchaseMaterialName(materialName) {
  const normalized = normalizePoMaterialDescription(materialName);
  const key = normalizeMaterialKey(normalized);
  const known = allKnownMaterialNames();
  const exact = known.find(name => normalizeMaterialKey(normalizePoMaterialDescription(name)) === key);
  if (exact) return exact;
  const signature = materialMatchSignature(normalized);
  if (signature) {
    const matches = known.filter(name => materialMatchSignature(name) === signature);
    if (matches.length === 1) return matches[0];
  }
  return normalized;
}

function updateAddInventoryMaterialButton() {
  const button = $("addInventoryMaterial");
  const input = $("inventoryNewMaterial");
  if (!button || !input) return;
  const value = normalizeSpaces(input.value || "");
  const key = normalizeMaterialKey(value);
  const alreadyListed = Boolean(key) && allKnownMaterialNames().some(name => normalizeMaterialKey(name) === key);
  button.disabled = !value || alreadyListed;
  button.textContent = alreadyListed ? "Already Added" : "+ Add to Inventory";
  button.title = alreadyListed ? "This material is already shown in Stock Position." : "Add this material to Stock Position.";
}

function renderInventory() {
  const wrap = $("inventoryWrap");
  const empty = $("inventoryEmpty");
  const summary = $("inventorySummary");
  const names = allKnownMaterialNames();
  const datalist = $("inventoryMaterialOptions");
  if (datalist) datalist.innerHTML = names.map(name => `<option value="${escapeHtml(name)}"></option>`).join("");

  if (!wrap || !empty || !summary) return;
  if (!names.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    summary.innerHTML = "";
    updateAddInventoryMaterialButton();
    return;
  }

  const calculations = names.map(name => ({ name, ...inventoryCalculation(name) }));
  const totalOwed = calculations.reduce((sum, row) => sum + row.stockOwed, 0);
  const shortageCount = calculations.filter(row => row.stockOwed > EPSILON).length;
  const totalIncoming = calculations.reduce((sum, row) => sum + row.incomingOpen, 0);
  summary.innerHTML = `
    <div class="summary-metric"><span>Stock Owed</span><strong>${formatNumber(totalOwed)} LF</strong></div>
    <div class="summary-metric"><span>Materials Short</span><strong>${shortageCount}</strong></div>
    <div class="summary-metric"><span>Open Incoming</span><strong>${formatNumber(totalIncoming)} LF</strong></div>`;

  const rows = calculations.map(row => {
    const key = normalizeMaterialKey(row.name);
    const shortage = row.stockOwed > EPSILON;
    const projectedClass = row.projectedBalance < -EPSILON ? "inventory-negative" : row.projectedBalance > EPSILON ? "inventory-positive" : "";
    return `<tr class="inventory-row" data-material-key="${escapeHtml(key)}" data-material-name="${escapeHtml(row.name)}" data-inventory-id="${escapeHtml(row.profile?.id || "")}">
      <td class="material-col">${escapeHtml(row.name)}</td>
      <td><input class="inventory-on-hand" type="number" min="0" step="0.01" value="${row.onHand}" /></td>
      <td><input class="inventory-lead-time" type="number" min="0" step="1" value="${row.leadTimeWeeks}" /></td>
      <td>${formatNumber(row.committed)}</td>
      <td>${formatNumber(row.multiForecast)}</td>
      <td>${formatNumber(row.sfdBuffer)}</td>
      <td>${formatNumber(row.incomingOpen)}</td>
      <td>${formatNumber(row.incomingDue)}</td>
      <td class="${row.availableNow < -EPSILON ? "inventory-negative" : ""}">${formatNumber(row.availableNow)}</td>
      <td><strong>${formatNumber(row.needInLeadTime)}</strong><span class="cell-subnote">through ${escapeHtml(formatDate(row.cutoff))}</span></td>
      <td class="${shortage ? "stock-owed" : "cell-zero"}">${shortage ? `<strong>${formatNumber(row.stockOwed)}</strong><span class="cell-subnote">ORDER</span>` : "—"}</td>
      <td class="${projectedClass}">${formatNumber(row.projectedBalance)}</td>
      <td><button type="button" class="mini-button save-inventory-row">Save</button></td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table class="inventory-table"><thead><tr><th class="material-col">Material</th><th>On Hand LF</th><th>Lead Time (wk)</th><th>Committed / Spruce</th><th>Multi Forecast</th><th>SFD Buffer</th><th>Open Incoming</th><th>Incoming by Lead Time</th><th>Available Now</th><th>Need in Lead Time</th><th>Stock Owed</th><th>Projected Balance</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
  updateAddInventoryMaterialButton();
}

function formatLengthBreakdown(order) {
  const breakdown = Array.isArray(order?.lengthBreakdown) ? order.lengthBreakdown : [];
  if (!breakdown.length) return "—";
  return breakdown.map(item => {
    const length = Number(item.lengthFt || 0) > 0 ? `${formatNumber(item.lengthFt)}'` : "Length ?";
    const pkg = Number(item.packages || 0) > 0 ? `${formatNumber(item.packages)} pkg` : "";
    const pcs = Number(item.pieces || 0) > 0 ? `${formatNumber(item.pieces)} pcs` : "";
    const lf = Number(item.linealLf || 0) > 0 ? `${formatNumber(item.linealLf)} LF` : "";
    return [length, pkg, pcs, lf].filter(Boolean).join(" · ");
  }).join(" | ");
}

function renderIncomingOrders() {
  const wrap = $("incomingOrdersWrap");
  const empty = $("incomingOrdersEmpty");
  const summary = $("purchasingSummary");
  if (!wrap || !empty) return;
  const orders = (state.incomingOrders || []).filter(order => incomingRemaining(order) > EPSILON).sort((a, b) => {
    const dateCompare = (a.expectedDate || "9999-12-31").localeCompare(b.expectedDate || "9999-12-31");
    if (dateCompare) return dateCompare;
    return (a.reference || "").localeCompare(b.reference || "", undefined, { numeric: true });
  });

  const openLf = orders.reduce((sum, order) => sum + incomingRemaining(order), 0);
  const poIds = new Set(orders.map(order => order.purchaseOrderId).filter(Boolean));
  const manualCount = orders.filter(order => !order.purchaseOrderId).length;
  if (summary) summary.innerHTML = `
    <div class="summary-metric"><span>Open PO Files</span><strong>${poIds.size}</strong></div>
    <div class="summary-metric"><span>Open Incoming</span><strong>${formatNumber(openLf)} LF</strong></div>
    <div class="summary-metric"><span>Manual / Transfer Lines</span><strong>${manualCount}</strong></div>`;

  if (!orders.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  const rows = orders.map(order => {
    const po = order.purchaseOrderId ? purchaseOrderForId(order.purchaseOrderId) : null;
    const reference = po?.poNumber || order.reference || "Manual";
    const source = po?.sourceFileName ? `<span class="cell-subnote">${escapeHtml(po.sourceFileName)}</span>` : (!order.purchaseOrderId ? `<span class="cell-subnote">manual / transfer</span>` : "");
    return `<tr data-order-id="${escapeHtml(order.id)}">
      <td class="purchase-reference-cell"><strong>${escapeHtml(reference)}</strong>${source}</td>
      <td class="incoming-material-cell">${escapeHtml(order.material)}</td>
      <td>${formatNumber(order.quantityLf)}</td>
      <td>${formatNumber(order.receivedLf)}</td>
      <td><strong>${formatNumber(incomingRemaining(order))}</strong></td>
      <td>${escapeHtml(order.expectedDate ? formatDate(order.expectedDate) : "No date")}</td>
      <td class="purchase-breakdown-cell">${escapeHtml(formatLengthBreakdown(order))}</td>
      <td class="incoming-note-cell">${escapeHtml(order.note || po?.note || "—")}</td>
      <td><button type="button" class="mini-button receive-incoming">Receive Remaining</button></td>
      <td><button type="button" class="mini-button delete-incoming danger-text">Delete Open</button></td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table class="incoming-table purchasing-table"><thead><tr><th>PO / Ref</th><th>Material</th><th>Ordered LF</th><th>Received LF</th><th>Open LF</th><th>Expected</th><th>Length / Package Detail</th><th>Note</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
}

function renderPurchasing() {
  renderIncomingOrders();
  if (purchaseDraft) renderPurchaseDraft();
  else updatePurchaseDuplicateNotice();
}

function syncPurchaseDraftFromInputs() {
  if (!purchaseDraft) return;
  purchaseDraft.poNumber = normalizeSpaces($("purchasePoNumber")?.value || "").toUpperCase();
  purchaseDraft.orderDate = $("purchaseOrderDate")?.value || "";
  purchaseDraft.expectedDate = $("purchaseExpectedDate")?.value || "";
  purchaseDraft.note = normalizeSpaces($("purchaseNote")?.value || "");
}

function updatePurchaseDuplicateNotice() {
  const notice = $("purchaseDuplicateNotice");
  const saveButton = $("savePurchaseOrder");
  if (!notice) return;
  const poNumber = normalizeSpaces($("purchasePoNumber")?.value || purchaseDraft?.poNumber || "").toUpperCase();
  const existing = purchaseOrderForNumber(poNumber);
  notice.classList.toggle("hidden", !existing);
  notice.textContent = existing ? `PO ${existing.poNumber} already exists. Confirming this import will reconcile the existing PO instead of adding the footage twice.` : "";
  if (saveButton) saveButton.textContent = existing ? "Update Existing PO" : "Add Purchase Order";
}

function clearPurchaseValidation() {
  const message = $("purchaseValidationMessage");
  if (!message) return;
  message.classList.add("hidden");
  message.textContent = "";
}

function showPurchaseValidation(message) {
  const el = $("purchaseValidationMessage");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

function renderPurchaseDraft() {
  if (!purchaseDraft) return;
  const card = $("purchaseReviewCard");
  const wrap = $("purchaseReviewWrap");
  const summary = $("purchaseReviewSummary");
  if (!card || !wrap || !summary) return;
  card.classList.remove("hidden");

  const validItems = (purchaseDraft.items || []).filter(item => normalizeSpaces(item.material) && Number(item.quantityLf || 0) > EPSILON);
  const totalLf = validItems.reduce((sum, item) => sum + Number(item.quantityLf || 0), 0);
  const sourceRows = validItems.reduce((sum, item) => sum + (Array.isArray(item.breakdown) ? item.breakdown.length : 0), 0);
  const detailSummary = Number(purchaseDraft.totalPackages || 0) > 0
    ? `${formatNumber(purchaseDraft.totalPackages)} pkg${Number(purchaseDraft.totalPieces || 0) > 0 ? ` · ${formatNumber(purchaseDraft.totalPieces)} pcs` : ""}`
    : `${sourceRows} rows`;
  summary.innerHTML = `
    <div><strong>${validItems.length}</strong><span>materials</span></div>
    <div><strong>${formatNumber(totalLf)} LF</strong><span>incoming</span></div>
    <div><strong>${detailSummary}</strong><span>PO detail retained</span></div>`;

  const rows = (purchaseDraft.items || []).map((item, index) => {
    const raw = (item.rawDescriptions || []).join(" / ");
    const normalizedSource = raw && normalizeMaterialKey(raw) !== normalizeMaterialKey(item.material)
      ? `<span class="purchase-source-name">PO: ${escapeHtml(raw)}</span>` : "";
    const detail = Array.isArray(item.breakdown) && item.breakdown.length
      ? item.breakdown.map(part => [
          Number(part.lengthFt || 0) > 0 ? `${formatNumber(part.lengthFt)}'` : "",
          Number(part.packages || 0) > 0 ? `${formatNumber(part.packages)} pkg` : "",
          Number(part.pieces || 0) > 0 ? `${formatNumber(part.pieces)} pcs` : "",
          Number(part.linealLf || 0) > 0 ? `${formatNumber(part.linealLf)} LF` : ""
        ].filter(Boolean).join(" · ")).join(" | ")
      : "Manual item";
    return `<tr data-purchase-index="${index}">
      <td class="purchase-material-edit"><input class="purchase-material-name" list="inventoryMaterialOptions" value="${escapeHtml(item.material)}" autocomplete="off" />${normalizedSource}</td>
      <td><input class="purchase-material-lf" type="number" min="0" step="0.01" value="${Number(item.quantityLf || 0)}" /></td>
      <td class="purchase-breakdown-cell">${escapeHtml(detail)}</td>
      <td><button type="button" class="mini-button remove-purchase-material danger-text">Remove</button></td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table class="purchase-review-table"><thead><tr><th>Material</th><th>Incoming LF</th><th>PO Length / Package Detail</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  clearPurchaseValidation();
  updatePurchaseDuplicateNotice();
}

function resetPurchaseDraft() {
  purchaseDraft = null;
  $("poFile").value = "";
  $("purchasePoNumber").value = "";
  $("purchaseOrderDate").value = "";
  $("purchaseExpectedDate").value = "";
  $("purchaseSourceFile").value = "";
  $("purchaseNote").value = "";
  $("purchaseReviewCard").classList.add("hidden");
  $("purchaseReviewWrap").innerHTML = "";
  $("purchaseReviewSummary").innerHTML = "";
  $("purchaseParseStatus").className = "status muted";
  $("purchaseParseStatus").textContent = "No Excel file selected.";
  clearPurchaseValidation();
  updatePurchaseDuplicateNotice();
}

async function handlePurchaseWorkbook(file) {
  const status = $("purchaseParseStatus");
  status.className = "status muted";
  status.textContent = `Reading ${file.name}…`;
  try {
    const parsed = await parsePurchaseWorkbook(file);
    const items = parsed.items.map(item => ({
      id: uid(),
      material: canonicalPurchaseMaterialName(item.material),
      quantityLf: Number(item.quantityLf || 0),
      rawDescriptions: item.rawDescriptions || [],
      breakdown: item.breakdown || []
    }));
    purchaseDraft = {
      sourceFileName: file.name,
      poNumber: parsed.poNumber || "",
      poNumberSource: parsed.poNumberSource || "",
      orderDate: parsed.orderDate || "",
      expectedDate: "",
      note: "",
      customer: parsed.customer || "",
      totalPackages: Number(parsed.totalPackages || 0),
      totalPieces: Number(parsed.totalPieces || 0),
      items
    };
    $("purchasePoNumber").value = purchaseDraft.poNumber;
    $("purchaseOrderDate").value = purchaseDraft.orderDate;
    $("purchaseExpectedDate").value = "";
    $("purchaseSourceFile").value = file.name;
    $("purchaseNote").value = "";
    const aliases = parsed.items.filter(item => (item.rawDescriptions || []).some(raw => normalizeMaterialKey(raw) !== normalizeMaterialKey(item.material))).length;
    status.className = "status success";
    status.textContent = `Read ${parsed.items.length} material${parsed.items.length === 1 ? "" : "s"}, ${formatNumber(parsed.totalLf)} LF${parsed.poNumber ? ` · PO ${parsed.poNumber}${parsed.poNumberSource === "filename" ? " from filename" : ""}` : ""}.${aliases ? ` ${aliases} material name${aliases === 1 ? " was" : "s were"} normalized using PO aliases.` : ""}`;
    renderPurchaseDraft();
  } catch (error) {
    console.error(error);
    purchaseDraft = null;
    $("purchaseReviewCard").classList.add("hidden");
    status.className = "status error";
    status.textContent = error.message || "Could not read this PO workbook.";
  }
}

function syncPurchaseItemsFromTable() {
  if (!purchaseDraft) return;
  document.querySelectorAll("#purchaseReviewWrap tr[data-purchase-index]").forEach(row => {
    const index = Number(row.dataset.purchaseIndex);
    const item = purchaseDraft.items[index];
    if (!item) return;
    item.material = normalizeSpaces(row.querySelector(".purchase-material-name")?.value || "");
    item.quantityLf = Number(row.querySelector(".purchase-material-lf")?.value || 0);
  });
}

function validPurchaseDraftItems() {
  return (purchaseDraft?.items || []).filter(item => normalizeSpaces(item.material) && Number.isFinite(Number(item.quantityLf)) && Number(item.quantityLf) > EPSILON);
}

async function persistPurchaseOrderDraft() {
  if (!purchaseDraft) return alert("Upload a PO Excel file first.");
  syncPurchaseItemsFromTable();
  syncPurchaseDraftFromInputs();
  clearPurchaseValidation();

  if (!purchaseDraft.poNumber) return showPurchaseValidation("Enter the PO # before confirming.");
  if (!purchaseDraft.expectedDate) return showPurchaseValidation("Enter the expected arrival date before confirming.");
  const items = validPurchaseDraftItems();
  if (!items.length) return showPurchaseValidation("Keep at least one material with incoming footage greater than 0 LF.");
  if (items.length !== purchaseDraft.items.length) return showPurchaseValidation("Every material row needs a material name and incoming footage greater than 0 LF, or remove the row.");
  const materialKeys = items.map(item => normalizeMaterialKey(canonicalPurchaseMaterialName(item.material)));
  if (new Set(materialKeys).size !== materialKeys.length) return showPurchaseValidation("The same material appears more than once. Combine its footage into one row before confirming.");

  await syncFromCloud({ silent: true });
  const existing = purchaseOrderForNumber(purchaseDraft.poNumber);
  const totalLf = items.reduce((sum, item) => sum + Number(item.quantityLf || 0), 0);
  const now = new Date().toISOString();

  if (existing) {
    const existingItems = (state.incomingOrders || []).filter(order => order.purchaseOrderId === existing.id);
    const message = `PO ${existing.poNumber} already exists.\n\nUpdate it to the reviewed ${items.length} material${items.length === 1 ? "" : "s"} / ${formatNumber(totalLf)} LF? Existing received quantities will be preserved.`;
    if (!confirm(message)) return;

    const usedIds = new Set();
    let added = 0;
    let updated = 0;
    let closed = 0;
    for (const item of items) {
      const materialName = canonicalPurchaseMaterialName(item.material);
      const match = existingItems.find(order => !usedIds.has(order.id) && normalizeMaterialKey(order.material) === normalizeMaterialKey(materialName));
      if (match) {
        usedIds.add(match.id);
        if (Number(item.quantityLf) + EPSILON < Number(match.receivedLf || 0)) {
          throw new Error(`${materialName} has already received ${formatNumber(match.receivedLf)} LF, so the PO cannot be revised down to ${formatNumber(item.quantityLf)} LF.`);
        }
        const changed = await updateRows("incoming_orders", { id: `eq.${match.id}`, version: `eq.${match.version}` }, {
          material_name: materialName,
          quantity_lf: Number(item.quantityLf),
          expected_date: purchaseDraft.expectedDate,
          reference: purchaseDraft.poNumber,
          note: purchaseDraft.note || null,
          length_breakdown: item.breakdown || [],
          updated_at: now,
          version: match.version + 1
        });
        if (!changed?.length) throw new Error(`${materialName} changed while the PO revision was being saved. Refresh and try again.`);
        updated += 1;
      } else {
        await insertRows("incoming_orders", {
          id: uid(),
          purchase_order_id: existing.id,
          material_name: materialName,
          quantity_lf: Number(item.quantityLf),
          received_lf: 0,
          expected_date: purchaseDraft.expectedDate,
          reference: purchaseDraft.poNumber,
          note: purchaseDraft.note || null,
          length_breakdown: item.breakdown || [],
          version: 1
        });
        added += 1;
      }
    }

    for (const oldItem of existingItems) {
      if (usedIds.has(oldItem.id)) continue;
      if (Number(oldItem.receivedLf || 0) > EPSILON) {
        const changed = await updateRows("incoming_orders", { id: `eq.${oldItem.id}`, version: `eq.${oldItem.version}` }, {
          quantity_lf: Number(oldItem.receivedLf || 0),
          expected_date: purchaseDraft.expectedDate,
          note: [oldItem.note, "Removed from revised PO after receipt"].filter(Boolean).join(" · "),
          updated_at: now,
          version: oldItem.version + 1
        });
        if (!changed?.length) throw new Error(`${oldItem.material} changed while the PO revision was being saved.`);
      } else {
        const deleted = await deleteRows("incoming_orders", { id: `eq.${oldItem.id}`, version: `eq.${oldItem.version}` });
        if (!deleted?.length) throw new Error(`${oldItem.material} changed while the PO revision was being saved.`);
      }
      closed += 1;
    }

    const header = await updateRows("purchase_orders", { id: `eq.${existing.id}`, version: `eq.${existing.version}` }, {
      po_number: purchaseDraft.poNumber,
      order_date: purchaseDraft.orderDate || null,
      expected_date: purchaseDraft.expectedDate,
      source_file_name: purchaseDraft.sourceFileName || null,
      note: purchaseDraft.note || null,
      updated_at: now,
      version: existing.version + 1
    });
    if (!header?.length) throw new Error("This PO was changed by another user while the revision was being saved.");
    await recordActivity("purchase_order", existing.id, "update_purchase_order", {
      po_number: purchaseDraft.poNumber,
      total_lf: totalLf,
      expected_date: purchaseDraft.expectedDate,
      source_file_name: purchaseDraft.sourceFileName,
      items_added: added,
      items_updated: updated,
      items_removed_or_closed: closed
    });
  } else {
    if (!confirm(`Add PO ${purchaseDraft.poNumber} with ${items.length} material${items.length === 1 ? "" : "s"} / ${formatNumber(totalLf)} LF incoming?`)) return;
    const purchaseOrderId = uid();
    await insertRows("purchase_orders", {
      id: purchaseOrderId,
      po_number: purchaseDraft.poNumber,
      order_date: purchaseDraft.orderDate || null,
      expected_date: purchaseDraft.expectedDate,
      source_file_name: purchaseDraft.sourceFileName || null,
      note: purchaseDraft.note || null,
      version: 1
    });
    await insertRows("incoming_orders", items.map(item => ({
      id: uid(),
      purchase_order_id: purchaseOrderId,
      material_name: canonicalPurchaseMaterialName(item.material),
      quantity_lf: Number(item.quantityLf),
      received_lf: 0,
      expected_date: purchaseDraft.expectedDate,
      reference: purchaseDraft.poNumber,
      note: purchaseDraft.note || null,
      length_breakdown: item.breakdown || [],
      version: 1
    })));
    await recordActivity("purchase_order", purchaseOrderId, "import_purchase_order", {
      po_number: purchaseDraft.poNumber,
      material_count: items.length,
      total_lf: totalLf,
      expected_date: purchaseDraft.expectedDate,
      source_file_name: purchaseDraft.sourceFileName
    });
  }

  resetPurchaseDraft();
  await syncFromCloud({ silent: true });
  setTab("purchasing");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }).format(date);
}

const ACTIVITY_LABELS = {
  create_project: "Project added",
  replace_project: "Project replaced",
  apply_revision: "Revision applied",
  import_project: "Project imported",
  update_project: "Project edited",
  update_forecast_date: "Estimated delivery date changed",
  update_level_planning: "Level planning updated",
  record_delivery: "Delivery recorded",
  undo_delivery: "Delivery undone",
  exclude_material_forecast: "Material excluded",
  adjust_material_forecast: "Material exclusion adjusted",
  restore_material_forecast: "Material restored to forecast",
  remove_level: "Level removed",
  delete_project: "Project deleted",
  create_inventory: "Inventory material added",
  update_inventory: "Inventory updated",
  import_purchase_order: "Purchase order imported",
  update_purchase_order: "Purchase order updated",
  add_incoming: "Incoming material added",
  receive_incoming: "Incoming material received",
  delete_incoming: "Incoming material deleted"
};

function actionLabel(action) {
  return ACTIVITY_LABELS[action] || String(action || "Activity").replaceAll("_", " ");
}

function activityEntityContext(row) {
  const details = row?.details && typeof row.details === "object" ? row.details : {};
  let projectNumber = details.project_number || "";
  let address = details.address_project_name || "";
  let levelName = details.level_name || "";

  if (row.entity_type === "project") {
    const project = state.projects.find(item => item.id === row.entity_id);
    if (project) {
      projectNumber ||= project.projectNumber || "";
      address ||= project.address || "";
    }
  } else if (row.entity_type === "level") {
    for (const project of state.projects) {
      const level = (project.levels || []).find(item => item.id === row.entity_id);
      if (!level) continue;
      projectNumber ||= project.projectNumber || "";
      address ||= project.address || "";
      levelName ||= level.name || "";
      break;
    }
  }
  return { projectNumber, address, levelName };
}

function activityDetailText(row) {
  const d = row?.details && typeof row.details === "object" ? row.details : {};
  if (row.action === "record_delivery") {
    const items = Array.isArray(d.items) ? d.items.map(item => `${item.material}: ${formatNumber(item.lf)} LF`).join("; ") : "";
    return [d.delivery_date ? `Delivery ${formatDate(d.delivery_date)}` : "", items, d.note ? `Note: ${d.note}` : ""].filter(Boolean).join(" · ") || "Delivery recorded";
  }
  if (row.action === "undo_delivery") return d.delivery_date ? `Reversed delivery dated ${formatDate(d.delivery_date)}` : "Delivery quantities restored";
  if (["exclude_material_forecast", "adjust_material_forecast", "restore_material_forecast"].includes(row.action)) {
    const amount = `${formatNumber(d.from_excluded_lf || 0)} → ${formatNumber(d.to_excluded_lf || 0)} LF excluded`;
    return [d.material_name || "Material", amount, d.reason ? `Reason: ${d.reason}` : "", d.note ? `Note: ${d.note}` : ""].filter(Boolean).join(" · ");
  }
  if (row.action === "update_forecast_date") return `${formatDate(d.from)} → ${formatDate(d.to)}`;
  if (row.action === "update_level_planning") return [
    `Date: ${d.from_date ? formatDate(d.from_date) : "No date"} → ${d.to_date ? formatDate(d.to_date) : "No date"}`,
    `Status: ${planningStatusLabel(d.from_status || "forecast")} → ${planningStatusLabel(d.to_status || "forecast")}`
  ].join(" · ");
  if (row.action === "apply_revision") return [
    `Revision ${d.from_revision || "—"} → ${d.to_revision || "—"}`,
    `${Number(d.materials_updated || 0)} material${Number(d.materials_updated || 0) === 1 ? "" : "s"} updated`,
    Number(d.materials_added || 0) ? `${d.materials_added} added` : "",
    Number(d.materials_archived || 0) ? `${d.materials_archived} archived` : "",
    Number(d.levels_archived || 0) ? `${d.levels_archived} level${Number(d.levels_archived) === 1 ? "" : "s"} archived` : ""
  ].filter(Boolean).join(" · ");
  if (["create_inventory", "update_inventory"].includes(row.action)) return [
    d.material_name || "Material",
    d.to_on_hand_lf !== undefined ? `On Hand ${formatNumber(d.from_on_hand_lf || 0)} → ${formatNumber(d.to_on_hand_lf || 0)} LF` : `On Hand ${formatNumber(d.on_hand_lf || 0)} LF`,
    d.to_lead_time_weeks !== undefined ? `Lead time ${d.from_lead_time_weeks ?? 6} → ${d.to_lead_time_weeks} weeks` : `Lead time ${d.lead_time_weeks ?? 6} weeks`
  ].filter(Boolean).join(" · ");
  if (["import_purchase_order", "update_purchase_order"].includes(row.action)) return [
    d.po_number ? `PO ${d.po_number}` : "Purchase order",
    d.material_count !== undefined ? `${d.material_count} material${Number(d.material_count) === 1 ? "" : "s"}` : "",
    d.total_lf !== undefined ? `${formatNumber(d.total_lf)} LF` : "",
    d.expected_date ? `Expected ${formatDate(d.expected_date)}` : "",
    d.items_added ? `${d.items_added} added` : "",
    d.items_updated ? `${d.items_updated} updated` : ""
  ].filter(Boolean).join(" · ");
  if (row.action === "add_incoming") return [d.material_name, `${formatNumber(d.quantity_lf)} LF`, d.expected_date ? `Expected ${formatDate(d.expected_date)}` : "", d.reference ? `Ref: ${d.reference}` : ""].filter(Boolean).join(" · ");
  if (row.action === "receive_incoming") return [d.material_name, `${formatNumber(d.received_lf)} LF received`, d.reference ? `Ref: ${d.reference}` : ""].filter(Boolean).join(" · ");
  if (row.action === "delete_incoming") return [d.material_name, `${formatNumber(d.open_lf)} LF open removed`, d.reference ? `Ref: ${d.reference}` : ""].filter(Boolean).join(" · ");
  if (row.action === "remove_level") return d.level_name ? `Removed ${d.level_name}` : "Level removed";
  if (row.action === "delete_project") {
    const reason = d.reason ? `Reason: ${d.reason}` : "";
    const note = d.note ? `Note: ${d.note}` : "";
    const packages = Number.isFinite(Number(d.packages_removed)) ? `${d.packages_removed} package${Number(d.packages_removed) === 1 ? "" : "s"} removed` : "";
    return [packages, reason, note].filter(Boolean).join(" · ") || "Project deleted";
  }
  if (row.action === "update_project") {
    const changes = d.changes && typeof d.changes === "object" ? Object.entries(d.changes) : [];
    const text = changes.map(([field, values]) => `${field}: ${values?.from || "—"} → ${values?.to || "—"}`).join("; ");
    const applied = d.apply_date_to_all_levels ? "Applied default date to all levels" : "";
    return [text, applied].filter(Boolean).join(" · ") || "Project fields updated";
  }
  if (["create_project", "replace_project", "import_project"].includes(row.action)) {
    return [d.revision ? `Revision ${d.revision}` : "", d.customer ? `Customer: ${d.customer}` : "", d.sales ? `Sales: ${d.sales}` : "", d.source ? `Source: ${d.source}` : ""].filter(Boolean).join(" · ") || actionLabel(row.action);
  }
  return Object.keys(d).length ? JSON.stringify(d) : "—";
}

function populateHistoryFilters() {
  const userSelect = $("historyUserFilter");
  const actionSelect = $("historyActionFilter");
  if (!userSelect || !actionSelect) return;
  const currentUser = userSelect.value;
  const currentAction = actionSelect.value;
  const users = [...new Set(activityRows.map(row => row.details?.actor_email || row.details?.actor_name || "").filter(Boolean))].sort();
  const actions = [...new Set(activityRows.map(row => row.action).filter(Boolean))].sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
  userSelect.innerHTML = `<option value="">All users</option>${users.map(user => `<option value="${escapeHtml(user)}">${escapeHtml(user)}</option>`).join("")}`;
  actionSelect.innerHTML = `<option value="">All actions</option>${actions.map(action => `<option value="${escapeHtml(action)}">${escapeHtml(actionLabel(action))}</option>`).join("")}`;
  if (users.includes(currentUser)) userSelect.value = currentUser;
  if (actions.includes(currentAction)) actionSelect.value = currentAction;
}

function renderHistory() {
  const wrap = $("historyWrap");
  const status = $("historyStatus");
  if (!wrap || !status) return;
  populateHistoryFilters();
  const query = normalizeSpaces($("historySearch")?.value || "").toLowerCase();
  const user = $("historyUserFilter")?.value || "";
  const action = $("historyActionFilter")?.value || "";
  const date = $("historyDateFilter")?.value || "";

  const filtered = activityRows.filter(row => {
    const actor = row.details?.actor_email || row.details?.actor_name || "Unknown user";
    if (user && actor !== user) return false;
    if (action && row.action !== action) return false;
    if (date && String(row.created_at || "").slice(0, 10) !== date) return false;
    if (query) {
      const ctx = activityEntityContext(row);
      const haystack = [actor, row.action, actionLabel(row.action), ctx.projectNumber, ctx.address, ctx.levelName, activityDetailText(row)].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const scopeText = historyHasMore ? `Loaded latest ${activityRows.length} entries` : `Loaded ${activityRows.length} entr${activityRows.length === 1 ? "y" : "ies"}`;
  status.textContent = `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}${filtered.length !== activityRows.length ? ` shown from ${activityRows.length}` : ""}. ${scopeText}. History is read-only.`;
  const olderButton = $("loadOlderHistory");
  if (olderButton) olderButton.classList.toggle("hidden", !historyHasMore);
  if (!filtered.length) {
    wrap.innerHTML = `<div class="history-empty">No entry history matches the current filters.</div>`;
    wrap.classList.remove("hidden");
    return;
  }

  const rows = filtered.map(row => {
    const actor = row.details?.actor_email || row.details?.actor_name || "Unknown user";
    const ctx = activityEntityContext(row);
    const project = [ctx.projectNumber, ctx.address].filter(Boolean).join(" · ") || "—";
    const level = ctx.levelName || "—";
    return `<tr>
      <td class="history-time">${escapeHtml(formatDateTime(row.created_at))}</td>
      <td>${escapeHtml(actor)}</td>
      <td class="history-project">${escapeHtml(project)}</td>
      <td>${escapeHtml(level)}</td>
      <td><strong>${escapeHtml(actionLabel(row.action))}</strong></td>
      <td class="history-details">${escapeHtml(activityDetailText(row))}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table class="entry-history-table"><thead><tr><th>Date / Time</th><th>User</th><th>Project</th><th>Level</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
}

async function loadAndRenderHistory({ silent = false, reset = false } = {}) {
  const status = $("historyStatus");
  if (!status) return;
  if (reset) historyLimit = HISTORY_PAGE_SIZE;
  if (!silent) status.textContent = "Loading entry history…";
  try {
    const rows = (await loadActivityRows({ limit: historyLimit + 1 })) || [];
    historyHasMore = rows.length > historyLimit;
    activityRows = rows.slice(0, historyLimit);
    historyLoaded = true;
    renderHistory();
  } catch (error) {
    console.error("Could not load entry history", error);
    status.textContent = `Could not load entry history: ${error.message}`;
  }
}

function scheduleRealtimeDataRefresh() {
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  setCloudStatus("connecting", "Syncing shared data…");
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    await syncFromCloud({ silent: true, rebindActive: hasOpenDialog() });
  }, 550);
}

function scheduleHistoryRefresh() {
  if (!historyLoaded && !document.getElementById("history")?.classList.contains("active")) return;
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    loadAndRenderHistory({ silent: true });
  }, 450);
}

async function startLiveSync() {
  realtimeState = "starting";
  const started = await startRealtime({
    onChange: ({ table }) => {
      if (table === "activity_log") {
        scheduleHistoryRefresh();
        return;
      }
      scheduleRealtimeDataRefresh();
    },
    onStatus: status => {
      if (status === "SUBSCRIBED") {
        realtimeState = "connected";
        setCloudStatus("connected", "Shared data connected · live");
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        realtimeState = "error";
        setCloudStatus("connecting", "Shared data connected · live sync unavailable");
      }
    }
  });
  if (!started) {
    realtimeState = "error";
    setCloudStatus("connecting", "Shared data connected · live sync unavailable");
  }
}

function renderAll() {
  renderMatrix();
  renderForecast();
  renderInventory();
  renderPurchasing();
  if (document.getElementById("history")?.classList.contains("active") && historyLoaded) renderHistory();
}

function openDelivery(projectId, levelId) {
  const project = state.projects.find(item => item.id === projectId);
  const level = project?.levels.find(item => item.id === levelId);
  if (!project || !level) return;
  activeDelivery = { project, level };
  $("deliveryTitle").textContent = `${projectTitle(project)} — ${level.name}`;
  $("deliverySubtitle").textContent = `${project.projectNumber}${project.revision ? ` · ${project.revision}` : ""} · ${project.customer ? `Customer: ${project.customer} · ` : ""}${project.sales ? `Sales: ${project.sales} · ` : ""}Estimated delivery ${formatDate(level.estimatedDeliveryDate)}`;
  $("forecastDateEdit").value = level.estimatedDeliveryDate || "";
  $("workflowStatusEdit").value = level.workflowStatus === "spruce" ? "spruce" : "forecast";
  $("deliveryDate").value = todayIso();
  $("deliveryNote").value = "";
  $("deliveryMaterialSearch").value = "";
  $("clearDeliveryMaterialSearch").classList.add("hidden");
  renderDeliveryItems();
  renderDeliveryHistory();
  $("deliveryDialog").showModal();
}

function applyDeliveryMaterialFilter() {
  const query = normalizeSpaces($("deliveryMaterialSearch")?.value || "").toLowerCase();
  $("clearDeliveryMaterialSearch")?.classList.toggle("hidden", !query);
  document.querySelectorAll("#deliveryItems .delivery-material-row").forEach(row => {
    row.classList.toggle("hidden", Boolean(query) && !String(row.dataset.materialSearch || "").includes(query));
  });
}

function renderDeliveryItems() {
  if (!activeDelivery) return;
  const { level } = activeDelivery;
  const rows = level.materials.map(material => {
    const remaining = outstandingFor(level, material);
    const delivered = deliveredFor(level, material);
    const excluded = excludedFor(material);
    const maxExcludable = Math.max(0, Number(material.requiredLf || 0) - delivered);
    const actionLabel = excluded > EPSILON ? "Adjust" : "Exclude";
    return `<tr class="delivery-material-row" data-material-search="${escapeHtml(normalizeMaterialKey(material.material))}">
      <td>${escapeHtml(material.material)}</td>
      <td>${formatNumber(material.requiredLf)}</td>
      <td>${formatNumber(delivered)}</td>
      <td class="material-excluded-cell">${excluded > EPSILON ? formatNumber(excluded) : "0"}</td>
      <td><strong>${formatNumber(remaining)}</strong></td>
      <td><input class="delivery-input" data-material-id="${escapeHtml(material.id)}" type="number" min="0" max="${remaining}" step="0.01" value="0" ${remaining <= EPSILON ? "disabled" : ""} /></td>
      <td class="forecast-action-cell"><button type="button" class="mini-button exclude-material" data-material-id="${escapeHtml(material.id)}" ${maxExcludable <= EPSILON && excluded <= EPSILON ? "disabled" : ""}>${actionLabel}</button></td>
    </tr>`;
  }).join("");
  $("deliveryItems").innerHTML = `<div class="table-wrap"><table class="delivery-table"><thead><tr><th>Material</th><th>Original</th><th>Delivered</th><th>Excluded</th><th>Remaining</th><th>Deliver now</th><th>Forecast</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  applyDeliveryMaterialFilter();
}

function openMaterialExclusion(materialId) {
  if (!activeDelivery) return;
  const material = activeDelivery.level.materials.find(item => item.id === materialId);
  if (!material) return;
  const delivered = deliveredFor(activeDelivery.level, material);
  const currentExcluded = excludedFor(material);
  const maxExcludable = Math.max(0, Number(material.requiredLf || 0) - delivered);
  activeMaterialExclusion = { materialId: material.id };
  $("materialExclusionTitle").textContent = currentExcluded > EPSILON ? "Adjust Forecast Exclusion" : "Exclude Material from Forecast";
  $("materialExclusionSummary").textContent = `${material.material} · Original ${formatNumber(material.requiredLf)} LF · Delivered ${formatNumber(delivered)} LF · Up to ${formatNumber(maxExcludable)} LF can be excluded.`;
  $("materialExcludedLf").value = currentExcluded;
  $("materialExcludedLf").max = maxExcludable;
  $("materialExclusionReason").value = material.exclusionReason || "Customer supplied / pre-ordered";
  $("materialExclusionNote").value = material.exclusionNote || "";
  $("restoreMaterialForecast").classList.toggle("hidden", currentExcluded <= EPSILON);
  $("materialExclusionDialog").showModal();
  requestAnimationFrame(() => $("materialExcludedLf")?.focus());
}

async function saveMaterialExclusion({ restore = false } = {}) {
  if (!activeDelivery || !activeMaterialExclusion) return;
  const requestedValue = restore ? 0 : Number($("materialExcludedLf").value || 0);
  if (!Number.isFinite(requestedValue) || requestedValue < -EPSILON) return alert("Enter a valid excluded quantity.");

  const materialId = activeMaterialExclusion.materialId;
  await refreshActiveDelivery();
  if (!activeDelivery) return alert("This level no longer exists in the shared data.");
  const material = activeDelivery.level.materials.find(item => item.id === materialId);
  if (!material) return alert("This material no longer exists in the shared data.");

  const delivered = deliveredFor(activeDelivery.level, material);
  const maxExcludable = Math.max(0, Number(material.requiredLf || 0) - delivered);
  const nextExcluded = restore ? 0 : requestedValue;
  if (nextExcluded > maxExcludable + EPSILON) {
    $("materialExcludedLf").max = maxExcludable;
    return alert(`Excluded quantity must be between 0 and ${formatNumber(maxExcludable)} LF. Shared delivery data may have changed; review the updated limit.`);
  }

  const previousExcluded = excludedFor(material);
  const reason = nextExcluded > EPSILON ? $("materialExclusionReason").value : "";
  const note = nextExcluded > EPSILON ? normalizeSpaces($("materialExclusionNote").value) : "";
  const result = await updateRows("materials", { id: `eq.${material.id}`, version: `eq.${material.version}` }, {
    excluded_lf: nextExcluded,
    exclusion_reason: reason || null,
    exclusion_note: note || null,
    updated_at: new Date().toISOString(),
    version: material.version + 1
  });
  if (!result?.length) throw new Error("This material was changed by another user. The shared data will be refreshed before you try again.");

  const action = nextExcluded <= EPSILON
    ? "restore_material_forecast"
    : previousExcluded <= EPSILON ? "exclude_material_forecast" : "adjust_material_forecast";
  await recordActivity("level", activeDelivery.level.id, action, {
    material_name: material.material,
    original_lf: Number(material.requiredLf || 0),
    delivered_lf: delivered,
    from_excluded_lf: previousExcluded,
    to_excluded_lf: nextExcluded,
    remaining_lf: Math.max(0, Number(material.requiredLf || 0) - delivered - nextExcluded),
    reason,
    note
  });

  const projectId = activeDelivery.project.id;
  const levelId = activeDelivery.level.id;
  await syncFromCloud({ silent: true });
  const project = state.projects.find(item => item.id === projectId);
  const level = project?.levels.find(item => item.id === levelId);
  activeDelivery = project && level ? { project, level } : null;
  activeMaterialExclusion = null;
  $("materialExclusionDialog").close("saved");
  if (activeDelivery) {
    renderDeliveryItems();
    renderDeliveryHistory();
  }
}

function renderDeliveryHistory() {
  if (!activeDelivery) return;
  const { level } = activeDelivery;
  const history = [...(level.deliveries || [])].sort((a, b) => (b.deliveredAt || b.date || "").localeCompare(a.deliveredAt || a.date || ""));
  if (!history.length) {
    $("deliveryHistory").innerHTML = `<h3>Delivery history</h3><p class="small-note">No deliveries recorded for this level.</p>`;
    return;
  }
  $("deliveryHistory").innerHTML = `<h3>Delivery history</h3>${history.map(delivery => `
    <div class="history-item">
      <div>
        <strong>${escapeHtml(formatDate(delivery.date))}${delivery.note ? ` — ${escapeHtml(delivery.note)}` : ""}</strong>
        ${delivery.items.map(item => `<p>${escapeHtml(item.material)}: ${formatNumber(item.lf)} LF</p>`).join("")}
      </div>
      <button type="button" class="history-delete" data-delivery-id="${delivery.id}">Undo</button>
    </div>`).join("")}`;
}

function makeDeliveredAt(selectedDate) {
  return `${selectedDate}T${new Date().toISOString().slice(11)}`;
}

async function refreshActiveDelivery() {
  if (!activeDelivery) return;
  const projectId = activeDelivery.project.id;
  const levelId = activeDelivery.level.id;
  await syncFromCloud({ silent: true });
  const project = state.projects.find(item => item.id === projectId);
  const level = project?.levels.find(item => item.id === levelId);
  activeDelivery = project && level ? { project, level } : null;
}

async function saveDelivery() {
  if (!activeDelivery) return;
  const date = $("deliveryDate").value;
  if (!date) return alert("Choose an actual delivery date.");

  // Re-read shared data immediately before validating the quantities. This reduces stale-entry conflicts.
  await refreshActiveDelivery();
  if (!activeDelivery) return alert("This level no longer exists in the shared data.");

  const items = [];
  document.querySelectorAll(".delivery-input").forEach(input => {
    const material = activeDelivery.level.materials.find(item => item.id === input.dataset.materialId);
    if (!material) return;
    const max = outstandingFor(activeDelivery.level, material);
    const requested = Number(input.value || 0);
    if (requested < -EPSILON || requested > max + EPSILON) throw new Error(`Delivery for ${material.material} must be between 0 and ${formatNumber(max)} LF. Another user may have recorded a delivery; review the refreshed remaining quantity.`);
    if (requested > EPSILON) items.push({ material, lf: requested });
  });
  if (!items.length) return alert("Enter at least one delivery quantity.");

  const deliveredAt = makeDeliveredAt(date);
  const note = normalizeSpaces($("deliveryNote").value);
  const rows = items.map(item => ({
    id: uid(),
    level_id: activeDelivery.level.id,
    material_id: item.material.id,
    delivered_lf: item.lf,
    delivered_at: deliveredAt,
    note: note || null
  }));
  await insertRows("deliveries", rows);
  await recordActivity("level", activeDelivery.level.id, "record_delivery", { delivery_date: date, note, items: items.map(item => ({ material: item.material.material, lf: item.lf })) });
  const projectId = activeDelivery.project.id;
  const levelId = activeDelivery.level.id;
  await syncFromCloud({ silent: true });
  const project = state.projects.find(item => item.id === projectId);
  const level = project?.levels.find(item => item.id === levelId);
  activeDelivery = project && level ? { project, level } : null;
  if (activeDelivery) {
    renderDeliveryItems();
    renderDeliveryHistory();
    $("deliverySubtitle").textContent = `${activeDelivery.project.projectNumber}${activeDelivery.project.revision ? ` · ${activeDelivery.project.revision}` : ""} · ${activeDelivery.project.customer ? `Customer: ${activeDelivery.project.customer} · ` : ""}${activeDelivery.project.sales ? `Sales: ${activeDelivery.project.sales} · ` : ""}Estimated delivery ${formatDate(activeDelivery.level.estimatedDeliveryDate)}`;
  }
}

async function deleteDelivery(deliveryId) {
  if (!activeDelivery) return;
  const delivery = activeDelivery.level.deliveries.find(item => item.id === deliveryId);
  if (!delivery) return;
  if (!confirm("Undo this delivery? The quantities will be added back to the shared outstanding forecast for everyone.")) return;
  const ids = delivery.rowIds?.length ? delivery.rowIds : [delivery.id];
  await deleteRows("deliveries", { id: `in.(${ids.join(",")})` });
  await recordActivity("level", activeDelivery.level.id, "undo_delivery", { delivery_date: delivery.date, row_ids: ids });
  const projectId = activeDelivery.project.id;
  const levelId = activeDelivery.level.id;
  await syncFromCloud({ silent: true });
  const project = state.projects.find(item => item.id === projectId);
  const level = project?.levels.find(item => item.id === levelId);
  activeDelivery = project && level ? { project, level } : null;
  if (activeDelivery) {
    renderDeliveryItems();
    renderDeliveryHistory();
  }
}

async function saveInventoryRow(row) {
  if (!row) return;
  const materialName = normalizeSpaces(row.dataset.materialName || "");
  const onHand = Number(row.querySelector(".inventory-on-hand")?.value || 0);
  const leadTimeWeeks = Number(row.querySelector(".inventory-lead-time")?.value || 0);
  if (!materialName) return alert("Material name is required.");
  if (!Number.isFinite(onHand) || onHand < 0) return alert("On Hand must be zero or greater.");
  if (!Number.isFinite(leadTimeWeeks) || leadTimeWeeks < 0) return alert("Lead Time must be zero or greater.");

  await syncFromCloud({ silent: true });
  const existing = inventoryProfileFor(materialName);
  const now = new Date().toISOString();
  if (existing) {
    const updated = await updateRows("inventory_materials", { id: `eq.${existing.id}`, version: `eq.${existing.version}` }, {
      material_name: materialName,
      on_hand_lf: onHand,
      lead_time_weeks: leadTimeWeeks,
      updated_at: now,
      version: existing.version + 1
    });
    if (!updated?.length) throw new Error("This inventory row was changed by another user. Refresh and try again.");
    await recordActivity("inventory", existing.id, "update_inventory", {
      material_name: materialName,
      from_on_hand_lf: existing.onHandLf,
      to_on_hand_lf: onHand,
      from_lead_time_weeks: existing.leadTimeWeeks,
      to_lead_time_weeks: leadTimeWeeks
    });
  } else {
    const id = uid();
    await insertRows("inventory_materials", {
      id,
      material_name: materialName,
      on_hand_lf: onHand,
      lead_time_weeks: leadTimeWeeks,
      version: 1
    });
    await recordActivity("inventory", id, "create_inventory", { material_name: materialName, on_hand_lf: onHand, lead_time_weeks: leadTimeWeeks });
  }
  await syncFromCloud({ silent: true });
}

async function addTrackedInventoryMaterial() {
  const materialName = normalizeSpaces($("inventoryNewMaterial")?.value || "");
  if (!materialName) return alert("Enter a material to add to inventory.");
  await syncFromCloud({ silent: true });
  const key = normalizeMaterialKey(materialName);
  if (allKnownMaterialNames().some(name => normalizeMaterialKey(name) === key)) {
    updateAddInventoryMaterialButton();
    return;
  }
  const id = uid();
  await insertRows("inventory_materials", {
    id,
    material_name: materialName,
    on_hand_lf: 0,
    lead_time_weeks: 6,
    version: 1
  });
  await recordActivity("inventory", id, "create_inventory", { material_name: materialName, on_hand_lf: 0, lead_time_weeks: 6 });
  $("inventoryNewMaterial").value = "";
  await syncFromCloud({ silent: true });
}

async function addIncomingOrder() {
  const materialName = normalizeSpaces($("incomingMaterial")?.value || "");
  const quantityLf = Number($("incomingLf")?.value || 0);
  const expectedDate = $("incomingDate")?.value || "";
  const reference = normalizeSpaces($("incomingReference")?.value || "");
  const note = normalizeSpaces($("incomingNote")?.value || "");
  if (!materialName) return alert("Enter a material.");
  if (!Number.isFinite(quantityLf) || quantityLf <= EPSILON) return alert("Enter an incoming quantity greater than 0 LF.");
  if (!expectedDate) return alert("Choose an expected date for the incoming material.");

  const id = uid();
  await insertRows("incoming_orders", {
    id,
    material_name: materialName,
    quantity_lf: quantityLf,
    received_lf: 0,
    expected_date: expectedDate,
    reference: reference || null,
    note: note || null,
    version: 1
  });
  await recordActivity("incoming", id, "add_incoming", { material_name: materialName, quantity_lf: quantityLf, expected_date: expectedDate, reference, note });
  $("incomingMaterial").value = "";
  $("incomingLf").value = "";
  $("incomingDate").value = "";
  $("incomingReference").value = "";
  $("incomingNote").value = "";
  await syncFromCloud({ silent: true });
}

async function receiveIncomingOrder(orderId) {
  await syncFromCloud({ silent: true });
  const order = (state.incomingOrders || []).find(item => item.id === orderId);
  if (!order) return alert("This incoming order no longer exists.");
  const remaining = incomingRemaining(order);
  if (remaining <= EPSILON) return;
  if (!confirm(`Receive ${formatNumber(remaining)} LF of ${order.material}?\n\nThe remaining quantity will be added to On Hand.`)) return;

  const claimed = await updateRows("incoming_orders", { id: `eq.${order.id}`, version: `eq.${order.version}` }, {
    received_lf: Number(order.quantityLf || 0),
    updated_at: new Date().toISOString(),
    version: order.version + 1
  });
  if (!claimed?.length) throw new Error("This incoming order was changed by another user. Refresh and try again.");

  let createdInventoryId = "";
  try {
    const profile = inventoryProfileFor(order.material);
    if (profile) {
      const updated = await updateRows("inventory_materials", { id: `eq.${profile.id}`, version: `eq.${profile.version}` }, {
        on_hand_lf: Number(profile.onHandLf || 0) + remaining,
        updated_at: new Date().toISOString(),
        version: profile.version + 1
      });
      if (!updated?.length) throw new Error("The inventory row changed while this receipt was being posted.");
    } else {
      createdInventoryId = uid();
      await insertRows("inventory_materials", {
        id: createdInventoryId,
        material_name: order.material,
        on_hand_lf: remaining,
        lead_time_weeks: 6,
        version: 1
      });
    }
  } catch (error) {
    try {
      await updateRows("incoming_orders", { id: `eq.${order.id}`, version: `eq.${order.version + 1}` }, {
        received_lf: order.receivedLf,
        updated_at: new Date().toISOString(),
        version: order.version + 2
      });
      if (createdInventoryId) await deleteRows("inventory_materials", { id: `eq.${createdInventoryId}` });
    } catch (rollbackError) {
      console.error("Incoming receipt rollback failed", rollbackError);
    }
    throw error;
  }

  await recordActivity("incoming", order.id, "receive_incoming", { material_name: order.material, received_lf: remaining, reference: order.reference || "" });
  await syncFromCloud({ silent: true });
}

async function deleteIncomingOrder(orderId) {
  const order = (state.incomingOrders || []).find(item => item.id === orderId);
  if (!order) return;
  const openLf = incomingRemaining(order);
  if (!confirm(`Remove the remaining ${formatNumber(openLf)} LF incoming for ${order.material}?${Number(order.receivedLf || 0) > EPSILON ? "\n\nAlready received footage will be kept in the PO record." : ""}`)) return;
  if (Number(order.receivedLf || 0) > EPSILON) {
    const changed = await updateRows("incoming_orders", { id: `eq.${order.id}`, version: `eq.${order.version}` }, {
      quantity_lf: Number(order.receivedLf || 0),
      updated_at: new Date().toISOString(),
      version: order.version + 1
    });
    if (!changed?.length) throw new Error("This incoming order was changed by another user. Refresh and try again.");
  } else {
    const deleted = await deleteRows("incoming_orders", { id: `eq.${order.id}`, version: `eq.${order.version}` });
    if (!deleted?.length) throw new Error("This incoming order was changed by another user. Refresh and try again.");
  }
  await recordActivity("incoming", order.id, "delete_incoming", { material_name: order.material, open_lf: openLf, reference: order.reference || "" });
  await syncFromCloud({ silent: true });
}

function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportMatrixCsv() {
  const levels = allLevels().filter(({ level }) => $("showDelivered").checked || levelStats(level).status !== "delivered");
  const materials = uniqueMaterials(levels);
  const header = ["Material", ...levels.map(({ project, level }) => `${projectTitle(project)} | ${project.projectNumber}${project.revision ? ` ${project.revision}` : ""} | ${level.name}`)];
  const rows = [header];
  for (const materialName of materials) {
    const key = normalizeMaterialKey(materialName);
    rows.push([materialName, ...levels.map(({ level }) => {
      const material = level.materials.find(item => normalizeMaterialKey(item.material) === key);
      return material ? outstandingFor(level, material) : "";
    })]);
  }
  downloadText("ewp-project-material-matrix.csv", rows.map(row => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
}

function exportForecastCsv() {
  const levels = allLevels().filter(({ project, level }) => project.projectType !== "sfd" && level.estimatedDeliveryDate && levelStats(level).outstanding > EPSILON);
  const months = [...new Set(levels.map(({ level }) => monthKey(level.estimatedDeliveryDate)))].sort();
  const materials = uniqueMaterials(levels);
  const rows = [["Material", ...months.map(monthLabel)]];
  for (const materialName of materials) {
    const key = normalizeMaterialKey(materialName);
    rows.push([materialName, ...months.map(month => {
      let total = 0;
      for (const { level } of levels) {
        if (monthKey(level.estimatedDeliveryDate) !== month) continue;
        const material = level.materials.find(item => normalizeMaterialKey(item.material) === key);
        if (material) total += outstandingFor(level, material);
      }
      return total || "";
    })]);
  }
  downloadText("ewp-monthly-forecast.csv", rows.map(row => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
}

function exportInventoryCsv() {
  const rows = [["Material", "On Hand LF", "Lead Time Weeks", "Committed / Spruce LF", "Multi Forecast LF", "SFD Buffer LF", "Open Incoming LF", "Incoming by Lead Time LF", "Available Now LF", "Need In Lead Time LF", "Stock Owed LF", "Projected Balance LF"]];
  for (const materialName of allKnownMaterialNames()) {
    const c = inventoryCalculation(materialName);
    rows.push([materialName, c.onHand, c.leadTimeWeeks, c.committed, c.multiForecast, c.sfdBuffer, c.incomingOpen, c.incomingDue, c.availableNow, c.needInLeadTime, c.stockOwed, c.projectedBalance]);
  }
  downloadText("ewp-inventory.csv", rows.map(row => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
}

function exportPurchasingCsv() {
  const rows = [["PO / Reference", "Source File", "Material", "Ordered LF", "Received LF", "Open LF", "Expected Date", "Length / Package Detail", "Note"]];
  for (const order of (state.incomingOrders || []).filter(item => incomingRemaining(item) > EPSILON)) {
    const po = order.purchaseOrderId ? purchaseOrderForId(order.purchaseOrderId) : null;
    rows.push([
      po?.poNumber || order.reference || "Manual",
      po?.sourceFileName || "",
      order.material,
      order.quantityLf,
      order.receivedLf,
      incomingRemaining(order),
      order.expectedDate,
      formatLengthBreakdown(order),
      order.note || po?.note || ""
    ]);
  }
  downloadText("ewp-open-purchase-orders.csv", rows.map(row => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
}

function cleanBackupState() {
  return {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source: "Supabase shared data",
    projects: state.projects.map(project => ({
      projectNumber: project.projectNumber,
      revision: project.revision,
      customer: project.customer,
      sales: project.sales,
      address: project.address,
      projectType: project.projectType === "sfd" ? "sfd" : "multi",
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate,
      levels: (project.levels || []).map(level => ({
        name: level.name,
        estimatedDeliveryDate: level.estimatedDeliveryDate,
        workflowStatus: level.workflowStatus === "spruce" ? "spruce" : "forecast",
        materials: (level.materials || []).map(material => ({
          material: material.material,
          requiredLf: material.requiredLf,
          excludedLf: material.excludedLf || 0,
          exclusionReason: material.exclusionReason || "",
          exclusionNote: material.exclusionNote || ""
        })),
        deliveries: (level.deliveries || []).map(delivery => ({
          date: delivery.date,
          note: delivery.note,
          items: (delivery.items || []).map(item => ({ material: item.material, lf: item.lf }))
        }))
      }))
    })),
    inventoryMaterials: (state.inventoryMaterials || []).map(item => ({
      material: item.material,
      onHandLf: item.onHandLf,
      leadTimeWeeks: item.leadTimeWeeks,
      note: item.note || ""
    })),
    incomingOrders: (state.incomingOrders || []).map(order => ({
      material: order.material,
      quantityLf: order.quantityLf,
      receivedLf: order.receivedLf,
      expectedDate: order.expectedDate,
      reference: order.reference || "",
      note: order.note || ""
    }))
  };
}

function normalizeBackup(parsed) {
  if (!parsed || !Array.isArray(parsed.projects)) return null;
  if ([2, 3, 4].includes(Number(parsed.version))) return migrateLegacyState(parsed);
  return {
    version: SCHEMA_VERSION,
    projects: parsed.projects.map(project => ({
      projectNumber: normalizeSpaces(project.projectNumber || "").toUpperCase(),
      revision: normalizeSpaces(project.revision || "").toUpperCase(),
      customer: normalizeSpaces(project.customer || ""),
      sales: normalizeSpaces(project.sales || ""),
      address: normalizeSpaces(project.address || ""),
      projectType: project.projectType === "sfd" ? "sfd" : "multi",
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate || "",
      levels: (project.levels || []).map((level, index) => ({
        id: uid(),
        name: normalizeSpaces(level.name || `Level ${index + 1}`),
        estimatedDeliveryDate: level.estimatedDeliveryDate || "",
        workflowStatus: level.workflowStatus === "spruce" ? "spruce" : "forecast",
        materials: (level.materials || []).map(material => ({
          id: uid(),
          material: normalizeSpaces(material.material || ""),
          requiredLf: Number(material.requiredLf || 0),
          excludedLf: Number(material.excludedLf || 0),
          exclusionReason: normalizeSpaces(material.exclusionReason || ""),
          exclusionNote: normalizeSpaces(material.exclusionNote || "")
        })),
        deliveries: (level.deliveries || []).map(delivery => ({
          id: uid(),
          date: delivery.date || "",
          note: normalizeSpaces(delivery.note || ""),
          items: (delivery.items || []).map(item => ({ material: normalizeSpaces(item.material || ""), lf: Number(item.lf || 0) }))
        }))
      }))
    })),
    inventoryMaterials: Array.isArray(parsed.inventoryMaterials) ? parsed.inventoryMaterials.map(item => ({
      material: normalizeSpaces(item.material || ""),
      onHandLf: Math.max(0, Number(item.onHandLf || 0)),
      leadTimeWeeks: Math.max(0, Math.round(Number(item.leadTimeWeeks ?? 6))),
      note: normalizeSpaces(item.note || "")
    })).filter(item => item.material) : [],
    incomingOrders: Array.isArray(parsed.incomingOrders) ? parsed.incomingOrders.map(order => ({
      material: normalizeSpaces(order.material || ""),
      quantityLf: Math.max(0, Number(order.quantityLf || 0)),
      receivedLf: Math.max(0, Number(order.receivedLf || 0)),
      expectedDate: order.expectedDate || "",
      reference: normalizeSpaces(order.reference || ""),
      note: normalizeSpaces(order.note || "")
    })).filter(order => order.material && order.quantityLf > EPSILON) : []
  };
}

async function importProjectsToCloud(importState, label) {
  const validProjects = (importState.projects || []).filter(project => project.projectNumber && project.address && (project.levels || []).length);
  if (!validProjects.length) throw new Error("No valid projects were found in this import.");
  if (!confirm(`${label} contains ${validProjects.length} project${validProjects.length === 1 ? "" : "s"}.\n\nMatching Project # records will be reconciled in place so existing delivery history is preserved. Continue?`)) return;

  await syncFromCloud({ silent: true });
  for (const project of validProjects) {
    const existing = state.projects.find(item => item.projectNumber.toLowerCase() === project.projectNumber.toLowerCase());
    let projectId;
    if (existing) {
      const summary = await reconcileProjectRevision(existing, project);
      projectId = existing.id;
      await recordActivity("project", projectId, "apply_revision", { source: label, project_number: project.projectNumber, ...summary });
    } else {
      projectId = await createProjectGraph(project);
      await recordActivity("project", projectId, "import_project", { source: label, project_number: project.projectNumber });
    }
    setProjectCollapsed(projectId, (project.levels || []).length > 1);
    await syncFromCloud({ silent: true });
  }
  await syncFromCloud({ silent: true });
  alert(`${validProjects.length} project${validProjects.length === 1 ? "" : "s"} imported into shared data.`);
  setTab("matrix");
}

async function importLegacyBrowserData() {
  const legacy = readLegacyBrowserData();
  if (!legacy?.projects?.length) return alert("No V0.5 browser data was found on this computer.");
  try {
    await importProjectsToCloud(legacy, "V0.5 browser data");
  } catch (error) {
    console.error(error);
    alert(`Could not import the browser data.\n\n${error.message}`);
  }
}

function openDeleteProjectDialog() {
  if (!activeEditProject) return;
  activeDeleteProject = activeEditProject;
  const project = activeDeleteProject;
  const packages = (project.levels || []).length;
  $("deleteProjectTitle").textContent = `Delete ${project.projectNumber || "Project"}?`;
  $("deleteProjectSummary").textContent = `${project.address || "Address / Project Name not entered"} · ${packages} package${packages === 1 ? "" : "s"} will be removed.`;
  $("deleteProjectReason").value = "";
  $("deleteProjectNote").value = "";
  $("projectEditDialog").close();
  $("deleteProjectDialog").showModal();
}

async function deleteActiveProject() {
  if (!activeDeleteProject) return;
  const project = activeDeleteProject;
  const reason = $("deleteProjectReason").value;
  const note = normalizeSpaces($("deleteProjectNote").value);
  const packagesRemoved = (project.levels || []).length;
  const button = $("confirmDeleteProject");
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    const deleted = await deleteRows("projects", { id: `eq.${project.id}`, version: `eq.${project.version}` });
    if (!deleted?.length) throw new Error("This project was changed by another user before it could be deleted. Shared data will be refreshed so you can review the latest version.");

    await recordActivity("project", project.id, "delete_project", {
      project_number: project.projectNumber || "",
      revision: project.revision || "",
      address_project_name: project.address || "",
      customer: project.customer || "",
      sales: project.sales || "",
      packages_removed: packagesRemoved,
      reason,
      note
    });

    activeDeleteProject = null;
    activeEditProject = null;
    $("deleteProjectDialog").close("deleted");
    await syncFromCloud({ silent: true });
    setTab("matrix");
  } catch (error) {
    console.error(error);
    alert(error.message);
    await syncFromCloud({ silent: true });
  } finally {
    button.disabled = false;
    button.textContent = "Delete Project Permanently";
  }
}

async function updateForecastDate() {
  if (!activeDelivery) return;
  const nextDate = $("forecastDateEdit").value;
  const nextStatus = $("workflowStatusEdit").value === "spruce" ? "spruce" : "forecast";
  const { project, level } = activeDelivery;
  if (project.projectType !== "sfd" && !nextDate) return alert("Choose an estimated delivery date for a Multi-family package.");
  try {
    const result = await updateRows("levels", { id: `eq.${level.id}`, version: `eq.${level.version}` }, {
      estimated_delivery_date: nextDate || null,
      workflow_status: nextStatus,
      updated_at: new Date().toISOString(),
      version: level.version + 1
    });
    if (!result?.length) throw new Error("This level was changed by another user. The shared data will be refreshed before you try again.");
    await recordActivity("level", level.id, "update_level_planning", {
      from_date: level.estimatedDeliveryDate || "",
      to_date: nextDate || "",
      from_status: level.workflowStatus || "forecast",
      to_status: nextStatus
    });
    const projectId = project.id;
    const levelId = level.id;
    await syncFromCloud({ silent: true });
    const freshProject = state.projects.find(item => item.id === projectId);
    const freshLevel = freshProject?.levels.find(item => item.id === levelId);
    activeDelivery = freshProject && freshLevel ? { project: freshProject, level: freshLevel } : null;
    if (activeDelivery) {
      $("deliverySubtitle").textContent = `${activeDelivery.project.projectNumber}${activeDelivery.project.revision ? ` · ${activeDelivery.project.revision}` : ""} · ${activeDelivery.project.customer ? `Customer: ${activeDelivery.project.customer} · ` : ""}${activeDelivery.project.sales ? `Sales: ${activeDelivery.project.sales} · ` : ""}Estimated delivery ${formatDate(nextDate)} · ${planningStatusLabel(planningStatus(activeDelivery.level))}`;
      $("workflowStatusEdit").value = activeDelivery.level.workflowStatus === "spruce" ? "spruce" : "forecast";
      renderDeliveryItems();
      renderDeliveryHistory();
    }
  } catch (error) {
    console.error(error);
    alert(error.message);
    await syncFromCloud({ silent: true });
  }
}
async function removeActiveLevel() {
  if (!activeDelivery) return;
  const { project, level } = activeDelivery;
  if (!confirm(`Remove ${project.projectNumber} — ${level.name} from the shared project?\n\nUse delivery transactions instead when material has actually shipped. This is intended for a cancelled or wrongly imported level.`)) return;
  try {
    const deleted = await deleteRows("levels", { id: `eq.${level.id}`, version: `eq.${level.version}` });
    if (!deleted?.length) throw new Error("This level was changed by another user before it could be removed.");
    await recordActivity("project", project.id, "remove_level", { level_name: level.name });
    if ((project.levels || []).length === 1) {
      // No levels remain, so remove the empty project too.
      await deleteRows("projects", { id: `eq.${project.id}` });
    }
    activeDelivery = null;
    $("deliveryDialog").close();
    await syncFromCloud({ silent: true });
  } catch (error) {
    console.error(error);
    alert(error.message);
    await syncFromCloud({ silent: true });
  }
}

function wireEvents() {
  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("loginButton");
    button.disabled = true;
    button.textContent = "Signing in…";
    setLoginError("");
    try {
      const session = await signInWithPassword($("loginEmail").value, $("loginPassword").value);
      finishLogin(session);
      setCloudStatus("connecting", "Connecting to shared data…");
    } catch (error) {
      console.error(error);
      setLoginError(error.message || "Could not sign in.");
    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });
  $("signOutButton").addEventListener("click", async () => {
    if (!confirm("Sign out of EWP Material Forecast?")) return;
    await stopRealtime();
    await signOut();
    currentUserName = "";
    renderCurrentUser();
    state = { version: SCHEMA_VERSION, projects: [], inventoryMaterials: [], purchaseOrders: [], incomingOrders: [] };
    renderAll();
    setCloudStatus("connecting", "Sign in required");
    const session = await openLoginDialog();
    if (session?.user) {
      setCloudStatus("connecting", "Connecting to shared data…");
      await syncFromCloud();
      await startLiveSync();
    }
  });
  document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));
  $("addProjectTop").addEventListener("click", () => setTab("intake"));

  $("pdfFile").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) handlePdf(file);
  });

  const poFile = $("poFile");
  poFile.addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) handlePurchaseWorkbook(file);
  });
  const poDropZone = $("poDropZone");
  ["dragenter", "dragover"].forEach(name => poDropZone.addEventListener(name, event => {
    event.preventDefault();
    poDropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach(name => poDropZone.addEventListener(name, event => {
    event.preventDefault();
    poDropZone.classList.remove("dragging");
  }));
  poDropZone.addEventListener("drop", event => {
    const file = [...(event.dataTransfer?.files || [])].find(item => /\.(xlsx|xls)$/i.test(item.name));
    if (file) handlePurchaseWorkbook(file);
  });
  ["purchasePoNumber", "purchaseOrderDate", "purchaseExpectedDate", "purchaseNote"].forEach(id => {
    $(id).addEventListener("input", () => {
      syncPurchaseDraftFromInputs();
      clearPurchaseValidation();
      if (id === "purchasePoNumber") updatePurchaseDuplicateNotice();
    });
    $(id).addEventListener("change", () => {
      syncPurchaseDraftFromInputs();
      clearPurchaseValidation();
      updatePurchaseDuplicateNotice();
    });
  });
  $("purchaseReviewWrap").addEventListener("input", event => {
    const row = event.target.closest("tr[data-purchase-index]");
    if (!row || !purchaseDraft) return;
    const index = Number(row.dataset.purchaseIndex);
    const item = purchaseDraft.items[index];
    if (!item) return;
    if (event.target.matches(".purchase-material-name")) item.material = normalizeSpaces(event.target.value || "");
    if (event.target.matches(".purchase-material-lf")) item.quantityLf = Number(event.target.value || 0);
    clearPurchaseValidation();
  });
  $("purchaseReviewWrap").addEventListener("click", event => {
    const button = event.target.closest(".remove-purchase-material");
    if (!button || !purchaseDraft) return;
    syncPurchaseItemsFromTable();
    const row = button.closest("tr[data-purchase-index]");
    purchaseDraft.items.splice(Number(row.dataset.purchaseIndex), 1);
    renderPurchaseDraft();
  });
  $("addPurchaseMaterial").addEventListener("click", () => {
    if (!purchaseDraft) return;
    syncPurchaseItemsFromTable();
    purchaseDraft.items.push({ id: uid(), material: "", quantityLf: 0, rawDescriptions: [], breakdown: [] });
    renderPurchaseDraft();
  });
  $("clearPurchaseDraft").addEventListener("click", resetPurchaseDraft);
  $("savePurchaseOrder").addEventListener("click", async () => {
    const button = $("savePurchaseOrder");
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Saving…";
    try { await persistPurchaseOrderDraft(); }
    catch (error) { console.error(error); alert(error.message); await syncFromCloud({ silent: true }); }
    finally {
      button.disabled = false;
      if (purchaseDraft) updatePurchaseDuplicateNotice();
      else button.textContent = "Add Purchase Order";
      if (purchaseDraft && button.textContent === "Saving…") button.textContent = original;
    }
  });

  const dropZone = $("dropZone");
  ["dragenter", "dragover"].forEach(name => dropZone.addEventListener(name, event => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach(name => dropZone.addEventListener(name, event => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  }));
  dropZone.addEventListener("drop", event => {
    const file = [...(event.dataTransfer?.files || [])].find(item => item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf"));
    if (file) handlePdf(file);
  });

  const handleProjectDateChange = () => {
    if (!draft) return;
    syncDraftFromInputs();
    applyProjectDateToDraft();
    renderDraftLevels();
  };
  $("projectDate").addEventListener("input", handleProjectDateChange);
  $("projectDate").addEventListener("change", handleProjectDateChange);
  $("projectType").addEventListener("change", () => {
    updateProjectTypeUi();
    if (draft) {
      syncDraftFromInputs();
      renderDraftLevels();
    }
  });
  ["projectNumber", "revision", "customer", "sales", "address"].forEach(id => {
    $(id).addEventListener("input", () => {
      $(id).classList.remove("input-invalid");
      const message = $("intakeValidationMessage");
      if (message && !message.classList.contains("hidden")) clearIntakeValidation();
    });
  });

  $("applyDateAll").addEventListener("change", () => {
    if (!draft) {
      if ($("applyDateAll").checked) $("staggerWeekly").checked = false;
      return;
    }
    syncDraftFromInputs();
    if ($("applyDateAll").checked) {
      $("staggerWeekly").checked = false;
      applyProjectDateToDraft();
    }
    renderDraftLevels();
  });

  $("staggerWeekly").addEventListener("change", () => {
    if (!draft) {
      if ($("staggerWeekly").checked) $("applyDateAll").checked = false;
      return;
    }
    syncDraftFromInputs();
    if ($("staggerWeekly").checked) {
      $("applyDateAll").checked = false;
      applyProjectDateToDraft();
    }
    renderDraftLevels();
  });

  $("addLevelBtn").addEventListener("click", () => {
    if (!draft) return;
    syncDraftFromInputs();
    let nextDate = "";
    if ($("applyDateAll").checked) nextDate = $("projectDate").value || "";
    else if ($("staggerWeekly").checked) {
      const previous = draft.levels[draft.levels.length - 1]?.estimatedDeliveryDate || $("projectDate").value || "";
      nextDate = previous ? addDaysIso(previous, 7) : "";
    }
    draft.levels.push({
      id: uid(),
      name: `Level ${draft.levels.length + 1}`,
      estimatedDeliveryDate: nextDate,
      dateSource: nextDate ? "auto" : "",
      materials: [{ id: uid(), material: "", requiredLf: 0 }],
      filteredMaterials: [],
      deliveries: []
    });
    renderDraftLevels();
  });

  $("levelEditor").addEventListener("input", event => {
    if (event.target.matches("input")) event.target.classList.remove("input-invalid");
    if (!draft) return;
    const levelName = event.target.closest(".level-name");
    if (levelName) {
      draft.levels[Number(levelName.dataset.levelIndex)].name = normalizeSpaces(levelName.value);
      renderDeliveryPreview();
    }
  });

  $("levelEditor").addEventListener("change", event => {
    const input = event.target.closest(".level-date");
    if (!input || !draft) return;
    const levelIndex = Number(input.dataset.levelIndex);
    const nextDate = input.value;
    syncDraftFromInputs();
    applyManualDraftLevelDate(levelIndex, nextDate);
  });

  $("deliveryPreview").addEventListener("change", event => {
    const input = event.target.closest(".preview-level-date");
    if (!input || !draft) return;
    const levelIndex = Number(input.dataset.levelIndex);
    const nextDate = input.value;
    syncDraftFromInputs();
    applyManualDraftLevelDate(levelIndex, nextDate);
  });

  $("levelEditor").addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || !draft) return;
    syncDraftFromInputs();
    const levelIndex = Number(button.dataset.levelIndex);
    if (button.classList.contains("remove-level")) {
      draft.levels.splice(levelIndex, 1);
      if ($("staggerWeekly").checked) applyProjectDateToDraft();
      renderDraftLevels();
    } else if (button.classList.contains("restore-filtered")) {
      const filteredIndex = Number(button.dataset.filteredIndex);
      const item = draft.levels[levelIndex].filteredMaterials?.splice(filteredIndex, 1)?.[0];
      if (item) draft.levels[levelIndex].materials.push(item);
      renderDraftLevels();
    } else if (button.classList.contains("add-material")) {
      draft.levels[levelIndex].materials.push({ id: uid(), material: "", requiredLf: 0 });
      renderDraftLevels();
    } else if (button.classList.contains("remove-material")) {
      draft.levels[levelIndex].materials.splice(Number(button.dataset.materialIndex), 1);
      renderDraftLevels();
    }
  });

  $("saveProject").addEventListener("click", openProjectReview);
  $("confirmProjectSave").addEventListener("click", persistDraftProject);
  $("showDelivered").addEventListener("change", renderMatrix);
  $("projectSearch").addEventListener("input", renderMatrix);
  $("clearProjectSearch").addEventListener("click", () => {
    $("projectSearch").value = "";
    renderMatrix();
    $("projectSearch").focus();
  });
  $("refreshCloud").addEventListener("click", () => syncFromCloud());
  $("refreshCloudForecast").addEventListener("click", () => syncFromCloud());
  $("refreshCloudInventory").addEventListener("click", () => syncFromCloud());
  $("refreshCloudPurchasing").addEventListener("click", () => syncFromCloud());

  const matrixWrap = $("matrixWrap");
  const matrixTopScroll = $("matrixTopScroll");
  matrixWrap.addEventListener("scroll", () => {
    matrixScrollLeft = matrixWrap.scrollLeft;
    matrixScrollTop = matrixWrap.scrollTop;
    if (Math.abs(matrixTopScroll.scrollLeft - matrixWrap.scrollLeft) > 1) matrixTopScroll.scrollLeft = matrixWrap.scrollLeft;
  });
  matrixTopScroll.addEventListener("scroll", () => {
    if (Math.abs(matrixWrap.scrollLeft - matrixTopScroll.scrollLeft) > 1) matrixWrap.scrollLeft = matrixTopScroll.scrollLeft;
    matrixScrollLeft = matrixTopScroll.scrollLeft;
  });
  matrixTopScroll.addEventListener("wheel", event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    matrixTopScroll.scrollLeft += event.deltaY;
  }, { passive: false });
  matrixWrap.addEventListener("wheel", event => {
    if (!event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    matrixWrap.scrollLeft += event.deltaY;
  }, { passive: false });
  window.addEventListener("resize", () => requestAnimationFrame(updateMatrixTopScrollbar));

  matrixWrap.addEventListener("click", event => {
    const manageButton = event.target.closest(".manage-level");
    if (manageButton) return openDelivery(manageButton.dataset.projectId, manageButton.dataset.levelId);
    const editButton = event.target.closest(".edit-project");
    if (editButton) return openProjectEdit(editButton.dataset.projectId);
    const toggleButton = event.target.closest(".toggle-project-collapse");
    if (toggleButton) {
      const project = state.projects.find(item => item.id === toggleButton.dataset.projectId);
      if (!project || (project.levels || []).length <= 1) return;
      setProjectCollapsed(project.id, !isProjectCollapsed(project));
      renderMatrix();
    }
  });

  $("updateForecastDate").addEventListener("click", updateForecastDate);
  $("deliveryMaterialSearch").addEventListener("input", applyDeliveryMaterialFilter);
  $("clearDeliveryMaterialSearch").addEventListener("click", () => {
    $("deliveryMaterialSearch").value = "";
    applyDeliveryMaterialFilter();
    $("deliveryMaterialSearch").focus();
  });
  $("deliveryItems").addEventListener("click", event => {
    const button = event.target.closest(".exclude-material");
    if (button) openMaterialExclusion(button.dataset.materialId);
  });
  $("fillEntireLevel").addEventListener("click", () => {
    if (!activeDelivery) return;
    document.querySelectorAll(".delivery-input").forEach(input => {
      const material = activeDelivery.level.materials.find(item => item.id === input.dataset.materialId);
      if (material) input.value = outstandingFor(activeDelivery.level, material);
    });
  });
  $("clearDeliveryInputs").addEventListener("click", () => document.querySelectorAll(".delivery-input").forEach(input => { input.value = 0; }));
  $("saveDelivery").addEventListener("click", async () => {
    const button = $("saveDelivery");
    button.disabled = true;
    button.textContent = "Saving…";
    try { await saveDelivery(); }
    catch (error) { console.error(error); alert(error.message); }
    finally { button.disabled = false; button.textContent = "Record Delivery"; }
  });
  $("deliveryHistory").addEventListener("click", async event => {
    const button = event.target.closest(".history-delete");
    if (!button) return;
    try { await deleteDelivery(button.dataset.deliveryId); }
    catch (error) { console.error(error); alert(error.message); }
  });
  $("removeLevel").addEventListener("click", removeActiveLevel);
  $("saveMaterialExclusion").addEventListener("click", async () => {
    const button = $("saveMaterialExclusion");
    button.disabled = true;
    button.textContent = "Saving…";
    try { await saveMaterialExclusion(); }
    catch (error) { console.error(error); alert(error.message); await syncFromCloud({ silent: true, rebindActive: true }); }
    finally { button.disabled = false; button.textContent = "Save Adjustment"; }
  });
  $("restoreMaterialForecast").addEventListener("click", async () => {
    const button = $("restoreMaterialForecast");
    button.disabled = true;
    button.textContent = "Restoring…";
    try { await saveMaterialExclusion({ restore: true }); }
    catch (error) { console.error(error); alert(error.message); await syncFromCloud({ silent: true, rebindActive: true }); }
    finally { button.disabled = false; button.textContent = "Restore to Forecast"; }
  });
  $("materialExclusionDialog").addEventListener("close", () => { activeMaterialExclusion = null; });

  $("inventoryWrap").addEventListener("click", async event => {
    const button = event.target.closest(".save-inventory-row");
    if (!button) return;
    const row = button.closest(".inventory-row");
    button.disabled = true;
    button.textContent = "Saving…";
    try { await saveInventoryRow(row); }
    catch (error) { console.error(error); alert(error.message); await syncFromCloud({ silent: true }); }
    finally { button.disabled = false; button.textContent = "Save"; }
  });
  $("inventoryNewMaterial").addEventListener("input", updateAddInventoryMaterialButton);
  $("inventoryNewMaterial").addEventListener("change", updateAddInventoryMaterialButton);
  $("addInventoryMaterial").addEventListener("click", async () => {
    const button = $("addInventoryMaterial");
    button.disabled = true;
    try { await addTrackedInventoryMaterial(); }
    catch (error) { console.error(error); alert(error.message); }
    finally { updateAddInventoryMaterialButton(); }
  });
  $("addIncomingOrder").addEventListener("click", async () => {
    const button = $("addIncomingOrder");
    button.disabled = true;
    button.textContent = "Adding…";
    try { await addIncomingOrder(); }
    catch (error) { console.error(error); alert(error.message); }
    finally { button.disabled = false; button.textContent = "+ Add Incoming"; }
  });
  $("incomingOrdersWrap").addEventListener("click", async event => {
    const row = event.target.closest("tr[data-order-id]");
    if (!row) return;
    const orderId = row.dataset.orderId;
    const receive = event.target.closest(".receive-incoming");
    const remove = event.target.closest(".delete-incoming");
    if (!receive && !remove) return;
    const button = receive || remove;
    button.disabled = true;
    try {
      if (receive) await receiveIncomingOrder(orderId);
      else await deleteIncomingOrder(orderId);
    } catch (error) {
      console.error(error);
      alert(error.message);
      await syncFromCloud({ silent: true });
    } finally {
      button.disabled = false;
    }
  });

  $("saveProjectEdit").addEventListener("click", saveProjectEdit);
  $("openDeleteProject").addEventListener("click", openDeleteProjectDialog);
  $("confirmDeleteProject").addEventListener("click", deleteActiveProject);
  wireBackdropClose($("deliveryDialog"));
  wireBackdropClose($("materialExclusionDialog"));
  wireBackdropClose($("projectEditDialog"));
  wireBackdropClose($("deleteProjectDialog"));
  wireReviewBackdropClose();

  $("exportMatrixCsv").addEventListener("click", exportMatrixCsv);
  $("exportForecastCsv").addEventListener("click", exportForecastCsv);
  $("exportInventoryCsv").addEventListener("click", exportInventoryCsv);
  $("exportPurchasingCsv").addEventListener("click", exportPurchasingCsv);
  $("refreshHistory").addEventListener("click", () => loadAndRenderHistory());
  $("loadOlderHistory").addEventListener("click", async () => {
    const button = $("loadOlderHistory");
    button.disabled = true;
    button.textContent = "Loading…";
    historyLimit += HISTORY_PAGE_SIZE;
    try { await loadAndRenderHistory({ silent: true }); }
    finally {
      button.disabled = false;
      button.textContent = "Load 100 older entries";
    }
  });
  ["historySearch", "historyUserFilter", "historyActionFilter", "historyDateFilter"].forEach(id => {
    $(id).addEventListener(id === "historySearch" ? "input" : "change", renderHistory);
  });
  $("clearHistoryFilters").addEventListener("click", () => {
    $("historySearch").value = "";
    $("historyUserFilter").value = "";
    $("historyActionFilter").value = "";
    $("historyDateFilter").value = "";
    renderHistory();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !hasOpenDialog()) {
      refreshRealtimeAuth().catch(() => {});
      syncFromCloud({ silent: true });
    }
  });
  window.addEventListener("focus", () => {
    if (!hasOpenDialog()) {
      refreshRealtimeAuth().catch(() => {});
      syncFromCloud({ silent: true });
    }
  });
}

async function init() {
  wireEvents();
  updateProjectTypeUi();
  renderCurrentUser();
  setAuthGateVisible(true);
  renderAll();
  try {
    const session = await ensureAuthenticated();
    if (!session?.user) throw new Error("Authentication did not return a signed-in user.");
    setCloudStatus("connecting", "Connecting to shared data…");
    await syncFromCloud();
    await startLiveSync();
  } catch (error) {
    console.error("EWP Forecast startup failed", error);
    setCloudStatus("error", "Sign-in required");
    setLoginError(error?.message || "Could not initialize sign-in.");
    setAuthGateVisible(true);
  }
}

init();
