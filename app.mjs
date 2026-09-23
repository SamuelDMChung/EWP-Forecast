import { extractPdfLines, parseMaterialReportLines, normalizeSpaces } from "./parser.mjs";

const STORAGE_KEY = "ewp_forecast_v2"; // Keep the old key so existing browser data migrates in place.
const SCHEMA_VERSION = 4;
const EPSILON = 0.0001;

let state = loadState();
let draft = null;
let pdfjsLib = null;
let activeDelivery = null;
let activeEditProject = null;
let matrixScrollLeft = 0;
let matrixScrollTop = 0;

const $ = id => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function migrateState(parsed) {
  if (!parsed || !Array.isArray(parsed.projects)) return null;
  if (![2, 3, 4].includes(Number(parsed.version))) return null;

  return {
    version: SCHEMA_VERSION,
    projects: parsed.projects.map(project => ({
      ...project,
      id: project.id || uid(),
      projectNumber: project.projectNumber || "",
      revision: project.revision || "",
      customer: project.customer || "",
      sales: project.sales || "",
      address: project.address || "",
      collapsed: Boolean(project.collapsed),
      defaultEstimatedDeliveryDate: project.defaultEstimatedDeliveryDate || "",
      levels: (project.levels || []).map(level => ({
        ...level,
        id: level.id || uid(),
        estimatedDeliveryDate: level.estimatedDeliveryDate || "",
        materials: (level.materials || []).map(material => ({
          material: material.material || "",
          requiredLf: Number(material.requiredLf || 0)
        })),
        deliveries: Array.isArray(level.deliveries) ? level.deliveries : []
      }))
    }))
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const migrated = migrateState(parsed);
    if (migrated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (error) {
    console.warn("Could not load saved state", error);
  }
  return { version: SCHEMA_VERSION, projects: [] };
}

function persist() {
  state.version = SCHEMA_VERSION;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
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

function monthKey(date) {
  return date ? date.slice(0, 7) : "";
}

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { month: "short", year: "numeric" }).format(new Date(y, m - 1, 1));
}

function normalizeMaterialKey(material) {
  return normalizeSpaces(material).toLowerCase();
}

function deliveryTotals(level) {
  const totals = new Map();
  for (const delivery of level.deliveries || []) {
    for (const item of delivery.items || []) {
      const key = normalizeMaterialKey(item.material);
      totals.set(key, (totals.get(key) || 0) + Number(item.lf || 0));
    }
  }
  return totals;
}

function outstandingFor(level, material) {
  const key = normalizeMaterialKey(material.material);
  const delivered = deliveryTotals(level).get(key) || 0;
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
  return {
    required,
    delivered,
    outstanding,
    percent,
    status,
    packagesRemaining: incompleteLevels.length,
    nextLevel: incompleteLevels[0]?.level || null
  };
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

function projectTitle(project) {
  return project.address || "Address / Project Name not entered";
}

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

    const useProjectDate = $("applyDateAll").checked;
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
        estimatedDeliveryDate: useProjectDate ? ($("projectDate").value || "") : "",
        materials: level.materials.map(item => ({ material: item.material, requiredLf: item.requiredLf })),
        deliveries: []
      }))
    };

    $("projectNumber").value = draft.projectNumber;
    $("revision").value = draft.revision;
    $("customer").value = draft.customer;
    $("sales").value = draft.sales;
    $("address").value = draft.address;
    $("reviewCard").classList.remove("hidden");
    status.className = "status success";
    status.textContent = `Read ${draft.levels.length} level${draft.levels.length === 1 ? "" : "s"} and ${draft.levels.reduce((n, level) => n + level.materials.length, 0)} Total Length material lines.`;
    renderDraftLevels();
  } catch (error) {
    console.error(error);
    status.className = "status error";
    status.textContent = error.message || "Could not read this PDF.";
  }
}

function renderDraftLevels() {
  if (!draft) return;
  const wrap = $("levelEditor");
  wrap.innerHTML = draft.levels.map((level, levelIndex) => `
    <div class="level-card" data-level-index="${levelIndex}">
      <div class="level-header">
        <label>Level
          <input class="level-name" data-level-index="${levelIndex}" value="${escapeHtml(level.name)}" />
        </label>
        <label>Estimated Delivery
          <input class="level-date" data-level-index="${levelIndex}" type="date" value="${escapeHtml(level.estimatedDeliveryDate || "")}" ${$("applyDateAll").checked ? "disabled" : ""} />
        </label>
        <button class="button ghost remove-level" data-level-index="${levelIndex}" type="button">Remove Level</button>
      </div>
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
  $("parseStatus").className = "status muted";
  $("parseStatus").textContent = "No PDF selected.";
  $("reviewCard").classList.add("hidden");
  $("levelEditor").innerHTML = "";
}

function saveDraftProject() {
  if (!draft) return;
  syncDraftFromInputs();
  const projectDate = $("projectDate").value;

  if (!draft.projectNumber) return alert("Project # is required.");
  if (!draft.address) return alert("Address (Project Name) is required.");
  if (!draft.levels.length) return alert("At least one level is required.");

  for (const level of draft.levels) {
    if (!level.name) return alert("Every level needs a name.");
    if ($("applyDateAll").checked) level.estimatedDeliveryDate = projectDate;
    if (!level.estimatedDeliveryDate) return alert(`Enter an estimated delivery date for ${level.name}.`);
    level.materials = level.materials.filter(item => normalizeSpaces(item.material) && Number(item.requiredLf) > 0);
    if (!level.materials.length) return alert(`${level.name} needs at least one material.`);
  }

  const existingIndex = state.projects.findIndex(project => project.projectNumber.toLowerCase() === draft.projectNumber.toLowerCase());
  const existing = existingIndex >= 0 ? state.projects[existingIndex] : null;
  const projectRecord = {
    id: existing?.id || uid(),
    projectNumber: draft.projectNumber,
    revision: draft.revision,
    customer: draft.customer,
    sales: draft.sales,
    address: draft.address,
    defaultEstimatedDeliveryDate: draft.defaultEstimatedDeliveryDate,
    collapsed: existing ? Boolean(existing.collapsed) : draft.levels.length > 1,
    sourceFileName: draft.sourceFileName,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    levels: draft.levels.map(level => ({ ...level, id: level.id || uid(), deliveries: level.deliveries || [] }))
  };

  if (existingIndex >= 0) {
    const message = `Project ${draft.projectNumber} already exists${existing.revision ? ` (${existing.revision})` : ""}.\n\nReplace it with ${draft.revision || "this upload"}?\n\nExisting delivery history will be removed because the project quantities may have changed.`;
    if (!confirm(message)) return;
    state.projects.splice(existingIndex, 1, projectRecord);
  } else {
    state.projects.push(projectRecord);
  }

  persist();
  resetIntake();
  setTab("matrix");
}

function visibleProjects(showDelivered) {
  return state.projects
    .map(project => {
      const visibleLevels = (project.levels || []).filter(level => showDelivered || levelStats(level).status !== "delivered");
      return { project, visibleLevels };
    })
    .filter(item => item.visibleLevels.length > 0);
}

function buildMatrixColumns(showDelivered) {
  const columns = [];
  for (const { project, visibleLevels } of visibleProjects(showDelivered)) {
    const canCollapse = (project.levels || []).length > 1;
    if (canCollapse && project.collapsed) {
      columns.push({ type: "project", project, levels: visibleLevels });
    } else {
      for (const level of visibleLevels) columns.push({ type: "level", project, level, levels: [level] });
    }
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
      ${next ? `
        <div class="operational-line"><strong>Next:</strong> ${escapeHtml(next.name)} · ${escapeHtml(formatDate(next.estimatedDeliveryDate))}</div>
      ` : `<div class="operational-line"><strong>Project complete</strong></div>`}
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

function saveProjectEdit() {
  if (!activeEditProject) return;
  const projectNumber = normalizeSpaces($("editProjectNumber").value).toUpperCase();
  const revision = normalizeSpaces($("editRevision").value).toUpperCase();
  const customer = normalizeSpaces($("editCustomer").value);
  const sales = normalizeSpaces($("editSales").value);
  const address = normalizeSpaces($("editAddress").value);
  const defaultDate = $("editProjectDate").value;

  if (!projectNumber) return alert("Project # is required.");
  if (!address) return alert("Address (Project Name) is required.");

  const duplicate = state.projects.find(item => item.id !== activeEditProject.id && item.projectNumber.toLowerCase() === projectNumber.toLowerCase());
  if (duplicate) return alert(`Project # ${projectNumber} already exists.`);
  if ($("editApplyDateAll").checked && !defaultDate) return alert("Choose a project default delivery date before applying it to all levels.");

  activeEditProject.projectNumber = projectNumber;
  activeEditProject.revision = revision;
  activeEditProject.customer = customer;
  activeEditProject.sales = sales;
  activeEditProject.address = address;
  activeEditProject.defaultEstimatedDeliveryDate = defaultDate;
  activeEditProject.updatedAt = new Date().toISOString();

  if ($("editApplyDateAll").checked) {
    (activeEditProject.levels || []).forEach(level => { level.estimatedDeliveryDate = defaultDate; });
  }

  $("projectEditDialog").close("saved");
  activeEditProject = null;
  persist();
  setTab("matrix");
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
  const columns = buildMatrixColumns(showDelivered);
  const levelRefs = columns.flatMap(column => column.levels.map(level => ({ project: column.project, level })));
  const materials = uniqueMaterials(levelRefs);
  const wrap = $("matrixWrap");
  const empty = $("matrixEmpty");

  if (!columns.length || !materials.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    $("matrixTopScroll").classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  const head = columns.map(column => column.type === "project"
    ? collapsedProjectHeaderHtml(column.project)
    : levelHeaderHtml(column.project, column.level)
  ).join("");

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

function renderStorageSummary() {
  const levels = allLevels().length;
  $("storageSummary").textContent = `${state.projects.length} project${state.projects.length === 1 ? "" : "s"}, ${levels} level${levels === 1 ? "" : "s"} saved in this browser.`;
}

function renderAll() {
  renderMatrix();
  renderForecast();
  renderStorageSummary();
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
  const history = [...(level.deliveries || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
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

function saveDelivery() {
  if (!activeDelivery) return;
  const date = $("deliveryDate").value;
  if (!date) return alert("Choose a delivery date.");

  const items = [];
  document.querySelectorAll(".delivery-input").forEach(input => {
    const index = Number(input.dataset.materialIndex);
    const material = activeDelivery.level.materials[index];
    const max = outstandingFor(activeDelivery.level, material);
    const requested = Number(input.value || 0);
    if (requested < -EPSILON || requested > max + EPSILON) throw new Error(`Delivery for ${material.material} must be between 0 and ${formatNumber(max)} LF.`);
    if (requested > EPSILON) items.push({ material: material.material, lf: requested });
  });

  if (!items.length) return alert("Enter at least one delivery quantity.");
  activeDelivery.level.deliveries ||= [];
  activeDelivery.level.deliveries.push({
    id: uid(),
    date,
    note: normalizeSpaces($("deliveryNote").value),
    items,
    createdAt: new Date().toISOString()
  });
  persist();
  renderDeliveryItems();
  renderDeliveryHistory();
}

function deleteDelivery(deliveryId) {
  if (!activeDelivery) return;
  const index = activeDelivery.level.deliveries.findIndex(item => item.id === deliveryId);
  if (index < 0) return;
  if (!confirm("Undo this delivery? The quantities will be added back to the outstanding forecast.")) return;
  activeDelivery.level.deliveries.splice(index, 1);
  persist();
  renderDeliveryItems();
  renderDeliveryHistory();
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
  // CSV remains the full project-level matrix regardless of UI collapse state.
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

function wireEvents() {
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

  $("projectDate").addEventListener("change", () => {
    if (!draft) return;
    draft.defaultEstimatedDeliveryDate = $("projectDate").value;
    if (!$("applyDateAll").checked) return;
    draft.levels.forEach(level => { level.estimatedDeliveryDate = $("projectDate").value; });
    renderDraftLevels();
  });

  $("applyDateAll").addEventListener("change", () => {
    if (!draft) return;
    syncDraftFromInputs();
    if ($("applyDateAll").checked) {
      draft.levels.forEach(level => { level.estimatedDeliveryDate = $("projectDate").value; });
    }
    renderDraftLevels();
  });

  $("addLevelBtn").addEventListener("click", () => {
    if (!draft) return;
    syncDraftFromInputs();
    draft.levels.push({
      id: uid(),
      name: `Level ${draft.levels.length + 1}`,
      estimatedDeliveryDate: $("applyDateAll").checked ? $("projectDate").value : "",
      materials: [{ material: "", requiredLf: 0 }],
      deliveries: []
    });
    renderDraftLevels();
  });

  $("levelEditor").addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || !draft) return;
    syncDraftFromInputs();
    const levelIndex = Number(button.dataset.levelIndex);

    if (button.classList.contains("remove-level")) {
      draft.levels.splice(levelIndex, 1);
      renderDraftLevels();
    } else if (button.classList.contains("add-material")) {
      draft.levels[levelIndex].materials.push({ material: "", requiredLf: 0 });
      renderDraftLevels();
    } else if (button.classList.contains("remove-material")) {
      draft.levels[levelIndex].materials.splice(Number(button.dataset.materialIndex), 1);
      renderDraftLevels();
    }
  });

  $("saveProject").addEventListener("click", saveDraftProject);
  $("showDelivered").addEventListener("change", renderMatrix);

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

  $("matrixWrap").addEventListener("click", event => {
    const manageButton = event.target.closest(".manage-level");
    if (manageButton) {
      openDelivery(manageButton.dataset.projectId, manageButton.dataset.levelId);
      return;
    }

    const editButton = event.target.closest(".edit-project");
    if (editButton) {
      openProjectEdit(editButton.dataset.projectId);
      return;
    }

    const toggleButton = event.target.closest(".toggle-project-collapse");
    if (toggleButton) {
      const project = state.projects.find(item => item.id === toggleButton.dataset.projectId);
      if (!project || (project.levels || []).length <= 1) return;
      project.collapsed = !project.collapsed;
      persist();
    }
  });

  $("updateForecastDate").addEventListener("click", () => {
    if (!activeDelivery) return;
    const nextDate = $("forecastDateEdit").value;
    if (!nextDate) return alert("Choose a forecast date.");
    activeDelivery.level.estimatedDeliveryDate = nextDate;
    persist();
    $("deliverySubtitle").textContent = `${activeDelivery.project.projectNumber}${activeDelivery.project.revision ? ` · ${activeDelivery.project.revision}` : ""} · ${activeDelivery.project.customer ? `Customer: ${activeDelivery.project.customer} · ` : ""}${activeDelivery.project.sales ? `Sales: ${activeDelivery.project.sales} · ` : ""}Forecast date ${formatDate(nextDate)}`;
  });

  $("fillEntireLevel").addEventListener("click", () => {
    if (!activeDelivery) return;
    document.querySelectorAll(".delivery-input").forEach(input => {
      const material = activeDelivery.level.materials[Number(input.dataset.materialIndex)];
      input.value = outstandingFor(activeDelivery.level, material);
    });
  });

  $("clearDeliveryInputs").addEventListener("click", () => {
    document.querySelectorAll(".delivery-input").forEach(input => { input.value = 0; });
  });

  $("saveDelivery").addEventListener("click", () => {
    try {
      saveDelivery();
    } catch (error) {
      alert(error.message);
    }
  });

  $("deliveryHistory").addEventListener("click", event => {
    const button = event.target.closest(".history-delete");
    if (button) deleteDelivery(button.dataset.deliveryId);
  });

  $("removeLevel").addEventListener("click", () => {
    if (!activeDelivery) return;
    const { project, level } = activeDelivery;
    if (!confirm(`Remove ${project.projectNumber} — ${level.name} from the project?\n\nUse delivery transactions instead when material has actually shipped. This action is intended for a cancelled/wrongly imported level.`)) return;

    const levelIndex = project.levels.findIndex(item => item.id === level.id);
    if (levelIndex >= 0) project.levels.splice(levelIndex, 1);
    if (!project.levels.length) {
      const projectIndex = state.projects.findIndex(item => item.id === project.id);
      if (projectIndex >= 0) state.projects.splice(projectIndex, 1);
    }
    activeDelivery = null;
    $("deliveryDialog").close();
    persist();
  });

  $("saveProjectEdit").addEventListener("click", saveProjectEdit);
  wireBackdropClose($("deliveryDialog"));
  wireBackdropClose($("projectEditDialog"));

  $("exportMatrixCsv").addEventListener("click", exportMatrixCsv);
  $("exportForecastCsv").addEventListener("click", exportForecastCsv);
  $("exportBackup").addEventListener("click", () => downloadText(`ewp-forecast-backup-${todayIso()}.json`, JSON.stringify(state, null, 2), "application/json"));

  $("importBackup").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const migrated = migrateState(parsed);
      if (!migrated) throw new Error("This is not a compatible EWP Forecast backup.");
      if (!confirm(`Restore ${migrated.projects.length} projects from this backup? This replaces the current browser data.`)) return;
      state = migrated;
      persist();
    } catch (error) {
      alert(error.message || "Could not restore backup.");
    } finally {
      event.target.value = "";
    }
  });

  $("clearData").addEventListener("click", () => {
    if (!state.projects.length) return;
    if (!confirm("Clear every project and delivery stored by this app in this browser? Export a JSON backup first if you may need the data later.")) return;
    state = { version: SCHEMA_VERSION, projects: [] };
    persist();
  });
}

wireEvents();
renderAll();
