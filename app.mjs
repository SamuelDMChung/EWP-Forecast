import { extractPdfLines, parseMaterialReportLines, normalizeSpaces } from "./parser.mjs";
import { loadCloudRows, loadActivityRows, insertRows, updateRows, deleteRows, logActivity } from "./db.mjs";
import { restoreSession, signInWithPassword, signOut, getCurrentUser, getLastEmail } from "./auth.mjs";
import { startRealtime, stopRealtime, refreshRealtimeAuth } from "./realtime.mjs";

const LEGACY_STORAGE_KEY = "ewp_forecast_v2";
const UI_PREFS_KEY = "ewp_forecast_v06_ui";
const SCHEMA_VERSION = 12;
const EPSILON = 0.0001;
const HISTORY_PAGE_SIZE = 100;

let state = { version: SCHEMA_VERSION, projects: [] };
let draft = null;
let pdfjsLib = null;
let activeDelivery = null;
let activeEditProject = null;
let activeDeleteProject = null;
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
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate || "",
      sourceFileName: project.sourceFileName || "",
      createdAt: project.createdAt || new Date().toISOString(),
      updatedAt: project.updatedAt || new Date().toISOString(),
      version: Number(project.version || 1),
      levels: (project.levels || []).map((level, levelIndex) => ({
        id: level.id || uid(),
        name: level.name || `Level ${levelIndex + 1}`,
        estimatedDeliveryDate: level.estimatedDeliveryDate || "",
        displayOrder: Number(level.displayOrder ?? levelIndex),
        version: Number(level.version || 1),
        materials: (level.materials || []).map(material => ({
          id: material.id || uid(),
          material: material.material || "",
          requiredLf: Number(material.requiredLf || 0),
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
    }))
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
      displayOrder: Number(row.display_order || 0),
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",
      version: Number(row.version || 1),
      materials: [],
      deliveries: []
    };
    levelMap.set(level.id, level);
    project.levels.push(level);
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
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || "",
      version: Number(row.version || 1)
    };
    materialMap.set(material.id, material);
    level.materials.push(material);
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

  const projects = [...projectMap.values()];
  projects.forEach(project => project.levels.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, undefined, { numeric: true })));
  return { version: SCHEMA_VERSION, projects };
}

function hasOpenDialog() {
  return $("deliveryDialog")?.open || $("projectEditDialog")?.open || $("deleteProjectDialog")?.open || $("projectReviewDialog")?.open;
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

function outstandingFor(level, material) {
  const totals = deliveryTotals(level);
  const delivered = totals.get(`id:${material.id}`) ?? totals.get(`name:${normalizeMaterialKey(material.material)}`) ?? 0;
  return Math.max(0, Number(material.requiredLf || 0) - delivered);
}

function levelStats(level) {
  let required = 0;
  let outstanding = 0;
  for (const material of level.materials || []) {
    required += Number(material.requiredLf || 0);
    outstanding += outstandingFor(level, material);
  }
  const delivered = Math.max(0, required - outstanding);
  const percent = required > EPSILON ? Math.max(0, Math.min(100, (delivered / required) * 100)) : 0;
  const status = outstanding <= EPSILON ? "delivered" : delivered > EPSILON ? "partial" : "upcoming";
  return { required, delivered, outstanding, percent, status };
}

function projectStats(project) {
  let required = 0;
  let delivered = 0;
  let outstanding = 0;
  const incompleteLevels = [];
  (project.levels || []).forEach((level, index) => {
    const stats = levelStats(level);
    required += stats.required;
    delivered += stats.delivered;
    outstanding += stats.outstanding;
    if (stats.outstanding > EPSILON) incompleteLevels.push({ level, stats, index });
  });
  incompleteLevels.sort((a, b) => {
    const aDate = a.level.estimatedDeliveryDate || "9999-12-31";
    const bDate = b.level.estimatedDeliveryDate || "9999-12-31";
    return aDate.localeCompare(bDate) || a.index - b.index;
  });
  const percent = required > EPSILON ? Math.max(0, Math.min(100, (delivered / required) * 100)) : 0;
  const status = outstanding <= EPSILON ? "delivered" : delivered > EPSILON ? "partial" : "upcoming";
  return { required, delivered, outstanding, percent, status, packagesRemaining: incompleteLevels.length, nextLevel: incompleteLevels[0]?.level || null };
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

function projectTitle(project) { return project.address || "Address / Project Name not entered"; }
function projectMetaHtml(project) {
  const projectId = [project.projectNumber, project.revision].filter(Boolean).join(" · ") || "No project #";
  const missingTitle = !normalizeSpaces(project.address || "");
  return `
    <div class="project-title${missingTitle ? " project-title-missing" : ""}">${escapeHtml(projectTitle(project))}</div>
    <div class="project-meta-line">${escapeHtml(projectId)} · Customer: ${escapeHtml(project.customer || "—")}</div>
    <div class="project-meta-line">Sales: ${escapeHtml(project.sales || "—")}</div>`;
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
    $("address").value = draft.address;
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
          <span class="delivery-preview-date">${escapeHtml(formatDate(level.estimatedDeliveryDate))}</span>
          ${level.estimatedDeliveryDate ? `<span class="date-source-badge ${level.dateSource === "manual" ? "manual" : "auto"}">${level.dateSource === "manual" ? "Manual" : "Auto"}</span>` : ""}
        </div>`).join("")}
    </div>`;
  preview.classList.remove("hidden");
}
function syncDraftFromInputs() {
  if (!draft) return;
  draft.projectNumber = normalizeSpaces($("projectNumber").value).toUpperCase();
  draft.revision = normalizeSpaces($("revision").value).toUpperCase();
  draft.customer = normalizeSpaces($("customer").value);
  draft.sales = normalizeSpaces($("sales").value);
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
  $("address").value = "";
  $("projectDate").value = "";
  $("applyDateAll").checked = false;
  $("staggerWeekly").checked = false;
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
    if (!level.estimatedDeliveryDate) {
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
          <strong>${escapeHtml(formatDate(level.estimatedDeliveryDate))}</strong>
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
      </div>
    </section>
    <section class="review-section">
      <div class="review-section-heading">
        <h3>Estimated Delivery Dates</h3>
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
      const message = `Project ${draft.projectNumber} already exists${existing.revision ? ` (${existing.revision})` : ""}.\n\nReplace it with ${draft.revision || "this upload"}?\n\nExisting delivery history will be removed because the project quantities may have changed.`;
      if (!confirm(message)) return;
    }

    const projectRecord = {
      projectNumber: draft.projectNumber,
      revision: draft.revision,
      customer: draft.customer,
      sales: draft.sales,
      address: draft.address,
      defaultEstimatedDeliveryDate: draft.defaultEstimatedDeliveryDate,
      levels: draft.levels.map(level => ({
        ...level,
        materials: validDraftMaterials(level)
      }))
    };
    const newProjectId = await createProjectGraph(projectRecord);
    if (existing) await deleteRows("projects", { id: `eq.${existing.id}` });
    await recordActivity("project", newProjectId, existing ? "replace_project" : "create_project", { project_number: draft.projectNumber, revision: draft.revision, address_project_name: draft.address, customer: draft.customer, sales: draft.sales });
    setProjectCollapsed(newProjectId, draft.levels.length > 1);
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
  let outstanding = 0;
  let found = false;
  for (const level of column.levels) {
    for (const material of level.materials || []) {
      if (normalizeMaterialKey(material.material) !== materialKey) continue;
      found = true;
      required += Number(material.requiredLf || 0);
      outstanding += outstandingFor(level, material);
    }
  }
  return { found, required, outstanding, delivered: Math.max(0, required - outstanding) };
}

function levelHeaderHtml(project, level) {
  const stats = levelStats(level);
  const multiLevel = (project.levels || []).length > 1;
  return `<th class="project-col level-project-col">
    <div class="project-header-card">
      ${projectMetaHtml(project)}
      <div class="operational-line"><strong>${escapeHtml(level.name)}</strong> · ${escapeHtml(formatDate(level.estimatedDeliveryDate))}</div>
      ${progressHtml(stats.percent, "level complete")}
      <div class="project-card-actions">
        <span class="status-badge ${stats.status}">${statusLabel(stats.status)}</span>
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
        <span class="status-badge ${stats.status}">${statusLabel(stats.status)}</span>
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
  const address = normalizeSpaces($("editAddress").value);
  const defaultDate = $("editProjectDate").value;
  const applyAll = $("editApplyDateAll").checked;

  if (!projectNumber) return alert("Project # is required.");
  if (!address) return alert("Address (Project Name) is required.");
  if (applyAll && !defaultDate) return alert("Choose a project default delivery date before applying it to all levels.");

  const duplicate = state.projects.find(item => item.id !== projectId && item.projectNumber.toLowerCase() === projectNumber.toLowerCase());
  if (duplicate) return alert(`Project # ${projectNumber} already exists.`);

  const fieldChanges = {};
  const compared = [
    ["Project #", activeEditProject.projectNumber || "", projectNumber],
    ["Revision", activeEditProject.revision || "", revision],
    ["Customer", activeEditProject.customer || "", customer],
    ["Sales", activeEditProject.sales || "", sales],
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
      const cls = stats.outstanding <= EPSILON ? "cell-delivered" : stats.delivered > EPSILON ? "cell-partial" : "";
      return `<td class="${cls}">${stats.outstanding <= EPSILON ? "0" : formatNumber(stats.outstanding)}</td>`;
    }).join("");
    return `<tr><td class="material-col">${escapeHtml(materialName)}</td>${cells}</tr>`;
  }).join("");

  wrap.innerHTML = `<table><thead><tr><th class="material-col">Material / Outstanding LF</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  $("matrixTopScroll").classList.remove("hidden");
  empty.classList.add("hidden");
  requestAnimationFrame(updateMatrixTopScrollbar);
}

function renderForecast() {
  const datedLevels = allLevels().filter(({ level }) => level.estimatedDeliveryDate && levelStats(level).outstanding > EPSILON);
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
        const material = level.materials.find(item => normalizeMaterialKey(item.material) === key);
        if (material) total += outstandingFor(level, material);
      }
      return `<td class="${total > 0 ? "month-total" : "cell-zero"}">${total > 0 ? formatNumber(total) : "—"}</td>`;
    }).join("");
    return `<tr><td class="material-col">${escapeHtml(materialName)}</td>${cells}</tr>`;
  }).join("");

  wrap.innerHTML = `<table><thead><tr><th class="material-col">Material / Outstanding LF</th>${months.map(month => `<th>${escapeHtml(monthLabel(month))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
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
  import_project: "Project imported",
  update_project: "Project edited",
  update_forecast_date: "Delivery date changed",
  record_delivery: "Delivery recorded",
  undo_delivery: "Delivery undone",
  remove_level: "Level removed",
  delete_project: "Project deleted"
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
  if (row.action === "update_forecast_date") return `${formatDate(d.from)} → ${formatDate(d.to)}`;
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
  if (document.getElementById("history")?.classList.contains("active") && historyLoaded) renderHistory();
}

function openDelivery(projectId, levelId) {
  const project = state.projects.find(item => item.id === projectId);
  const level = project?.levels.find(item => item.id === levelId);
  if (!project || !level) return;
  activeDelivery = { project, level };
  $("deliveryTitle").textContent = `${projectTitle(project)} — ${level.name}`;
  $("deliverySubtitle").textContent = `${project.projectNumber}${project.revision ? ` · ${project.revision}` : ""} · ${project.customer ? `Customer: ${project.customer} · ` : ""}${project.sales ? `Sales: ${project.sales} · ` : ""}Forecast date ${formatDate(level.estimatedDeliveryDate)}`;
  $("forecastDateEdit").value = level.estimatedDeliveryDate || "";
  $("deliveryDate").value = todayIso();
  $("deliveryNote").value = "";
  renderDeliveryItems();
  renderDeliveryHistory();
  $("deliveryDialog").showModal();
}

function renderDeliveryItems() {
  if (!activeDelivery) return;
  const { level } = activeDelivery;
  const rows = level.materials.map((material, index) => {
    const remaining = outstandingFor(level, material);
    const delivered = Number(material.requiredLf) - remaining;
    return `<tr>
      <td>${escapeHtml(material.material)}</td>
      <td>${formatNumber(material.requiredLf)}</td>
      <td>${formatNumber(delivered)}</td>
      <td><strong>${formatNumber(remaining)}</strong></td>
      <td><input class="delivery-input" data-material-index="${index}" type="number" min="0" max="${remaining}" step="0.01" value="0" ${remaining <= EPSILON ? "disabled" : ""} /></td>
    </tr>`;
  }).join("");
  $("deliveryItems").innerHTML = `<div class="table-wrap"><table class="delivery-table"><thead><tr><th>Material</th><th>Original</th><th>Delivered</th><th>Remaining</th><th>Deliver now</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
  if (!date) return alert("Choose a delivery date.");

  // Re-read shared data immediately before validating the quantities. This reduces stale-entry conflicts.
  await refreshActiveDelivery();
  if (!activeDelivery) return alert("This level no longer exists in the shared data.");

  const items = [];
  document.querySelectorAll(".delivery-input").forEach(input => {
    const index = Number(input.dataset.materialIndex);
    const material = activeDelivery.level.materials[index];
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
    $("deliverySubtitle").textContent = `${activeDelivery.project.projectNumber}${activeDelivery.project.revision ? ` · ${activeDelivery.project.revision}` : ""} · ${activeDelivery.project.customer ? `Customer: ${activeDelivery.project.customer} · ` : ""}${activeDelivery.project.sales ? `Sales: ${activeDelivery.project.sales} · ` : ""}Forecast date ${formatDate(activeDelivery.level.estimatedDeliveryDate)}`;
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
  const levels = allLevels().filter(({ level }) => level.estimatedDeliveryDate && levelStats(level).outstanding > EPSILON);
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
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate,
      levels: (project.levels || []).map(level => ({
        name: level.name,
        estimatedDeliveryDate: level.estimatedDeliveryDate,
        materials: (level.materials || []).map(material => ({ material: material.material, requiredLf: material.requiredLf })),
        deliveries: (level.deliveries || []).map(delivery => ({
          date: delivery.date,
          note: delivery.note,
          items: (delivery.items || []).map(item => ({ material: item.material, lf: item.lf }))
        }))
      }))
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
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate || "",
      levels: (project.levels || []).map((level, index) => ({
        id: uid(),
        name: normalizeSpaces(level.name || `Level ${index + 1}`),
        estimatedDeliveryDate: level.estimatedDeliveryDate || "",
        materials: (level.materials || []).map(material => ({ id: uid(), material: normalizeSpaces(material.material || ""), requiredLf: Number(material.requiredLf || 0) })),
        deliveries: (level.deliveries || []).map(delivery => ({
          id: uid(),
          date: delivery.date || "",
          note: normalizeSpaces(delivery.note || ""),
          items: (delivery.items || []).map(item => ({ material: normalizeSpaces(item.material || ""), lf: Number(item.lf || 0) }))
        }))
      }))
    }))
  };
}

async function importProjectsToCloud(importState, label) {
  const validProjects = (importState.projects || []).filter(project => project.projectNumber && project.address && (project.levels || []).length);
  if (!validProjects.length) throw new Error("No valid projects were found in this import.");
  if (!confirm(`${label} contains ${validProjects.length} project${validProjects.length === 1 ? "" : "s"}.\n\nMatching Project # records in shared data will be replaced. Continue?`)) return;

  await syncFromCloud({ silent: true });
  for (const project of validProjects) {
    const existing = state.projects.find(item => item.projectNumber.toLowerCase() === project.projectNumber.toLowerCase());
    const newId = await createProjectGraph(project);
    if (existing) await deleteRows("projects", { id: `eq.${existing.id}` });
    setProjectCollapsed(newId, (project.levels || []).length > 1);
    await recordActivity("project", newId, "import_project", { source: label, project_number: project.projectNumber });
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
  if (!nextDate) return alert("Choose a forecast date.");
  const { project, level } = activeDelivery;
  try {
    const result = await updateRows("levels", { id: `eq.${level.id}`, version: `eq.${level.version}` }, {
      estimated_delivery_date: nextDate,
      updated_at: new Date().toISOString(),
      version: level.version + 1
    });
    if (!result?.length) throw new Error("This level was changed by another user. The shared data will be refreshed before you try again.");
    await recordActivity("level", level.id, "update_forecast_date", { from: level.estimatedDeliveryDate, to: nextDate });
    const projectId = project.id;
    const levelId = level.id;
    await syncFromCloud({ silent: true });
    const freshProject = state.projects.find(item => item.id === projectId);
    const freshLevel = freshProject?.levels.find(item => item.id === levelId);
    activeDelivery = freshProject && freshLevel ? { project: freshProject, level: freshLevel } : null;
    if (activeDelivery) {
      $("deliverySubtitle").textContent = `${activeDelivery.project.projectNumber}${activeDelivery.project.revision ? ` · ${activeDelivery.project.revision}` : ""} · ${activeDelivery.project.customer ? `Customer: ${activeDelivery.project.customer} · ` : ""}${activeDelivery.project.sales ? `Sales: ${activeDelivery.project.sales} · ` : ""}Forecast date ${formatDate(nextDate)}`;
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
    state = { version: SCHEMA_VERSION, projects: [] };
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
    syncDraftFromInputs();
    const levelIndex = Number(input.dataset.levelIndex);

    draft.levels[levelIndex].dateSource = draft.levels[levelIndex].estimatedDeliveryDate ? "manual" : "";

    if ($("applyDateAll").checked) {
      // A manual exception breaks the "same date for all" rule, while preserving all current dates.
      $("applyDateAll").checked = false;
      renderDraftLevels();
      return;
    }

    if ($("staggerWeekly").checked) {
      // The edited level becomes a new anchor and every later level remains one week apart.
      if (levelIndex === 0) {
        $("projectDate").value = draft.levels[0].estimatedDeliveryDate || "";
        draft.defaultEstimatedDeliveryDate = $("projectDate").value;
      }
      continueWeeklyScheduleFrom(levelIndex);
      renderDraftLevels();
      return;
    }

    if (levelIndex === 0) {
      $("projectDate").value = draft.levels[0].estimatedDeliveryDate || "";
      draft.defaultEstimatedDeliveryDate = $("projectDate").value;
    }
    renderDraftLevels();
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
  $("fillEntireLevel").addEventListener("click", () => {
    if (!activeDelivery) return;
    document.querySelectorAll(".delivery-input").forEach(input => {
      const material = activeDelivery.level.materials[Number(input.dataset.materialIndex)];
      input.value = outstandingFor(activeDelivery.level, material);
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

  $("saveProjectEdit").addEventListener("click", saveProjectEdit);
  $("openDeleteProject").addEventListener("click", openDeleteProjectDialog);
  $("confirmDeleteProject").addEventListener("click", deleteActiveProject);
  wireBackdropClose($("deliveryDialog"));
  wireBackdropClose($("projectEditDialog"));
  wireBackdropClose($("deleteProjectDialog"));
  wireReviewBackdropClose();

  $("exportMatrixCsv").addEventListener("click", exportMatrixCsv);
  $("exportForecastCsv").addEventListener("click", exportForecastCsv);
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
