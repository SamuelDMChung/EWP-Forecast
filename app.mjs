import { extractPdfLines, parseMaterialReportLines, normalizeSpaces } from "./parser.mjs";

const STORAGE_KEY = "ewp_forecast_v2";
const SCHEMA_VERSION = 2;
let state = loadState();
let draft = null;
let pdfjsLib = null;
let activeDelivery = null;

const $ = id => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (parsed?.version === SCHEMA_VERSION && Array.isArray(parsed.projects)) return parsed;
  } catch (error) {
    console.warn("Could not load saved state", error);
  }
  return { version: SCHEMA_VERSION, projects: [] };
}

function persist() {
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
      const workerBase = url.replace(/pdf\.min\.mjs$/, "pdf.worker.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = workerBase;
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
  const n = Number(value || 0);
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(n);
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
  const status = outstanding <= 0.0001 ? "delivered" : delivered > 0.0001 ? "partial" : "upcoming";
  return { required, delivered, outstanding, status };
}

function levelRef(project, level) {
  return { project, level };
}

function allLevels() {
  return state.projects.flatMap(project => project.levels.map(level => levelRef(project, level)));
}

function uniqueMaterials(levels = allLevels()) {
  const materialMap = new Map();
  for (const { level } of levels) {
    for (const material of level.materials || []) {
      const key = normalizeMaterialKey(material.material);
      if (!materialMap.has(key)) materialMap.set(key, material.material);
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
      address: parsed.address || "",
      levels: parsed.levels.map(level => ({
        id: uid(),
        name: level.name,
        estimatedDeliveryDate: $("projectDate").value || "",
        materials: level.materials.map(item => ({ material: item.material, requiredLf: item.requiredLf })),
        deliveries: []
      }))
    };

    $("projectNumber").value = draft.projectNumber;
    $("revision").value = draft.revision;
    $("address").value = draft.address;
    $("reviewCard").classList.remove("hidden");
    status.className = "status success";
    status.textContent = `Read ${draft.levels.length} level${draft.levels.length === 1 ? "" : "s"} and ${draft.levels.reduce((n, l) => n + l.materials.length, 0)} Total Length material lines.`;
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
  draft.address = normalizeSpaces($("address").value);
  document.querySelectorAll(".level-name").forEach(input => { draft.levels[Number(input.dataset.levelIndex)].name = normalizeSpaces(input.value); });
  document.querySelectorAll(".level-date").forEach(input => { draft.levels[Number(input.dataset.levelIndex)].estimatedDeliveryDate = input.value; });
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
  $("address").value = "";
  $("projectDate").value = "";
  $("applyDateAll").checked = true;
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
  if (!draft.levels.length) return alert("At least one level is required.");

  for (const level of draft.levels) {
    if (!level.name) return alert("Every level needs a name.");
    if ($("applyDateAll").checked) level.estimatedDeliveryDate = projectDate;
    if (!level.estimatedDeliveryDate) return alert(`Enter an estimated delivery date for ${level.name}.`);
    level.materials = level.materials.filter(item => normalizeSpaces(item.material) && Number(item.requiredLf) > 0);
    if (!level.materials.length) return alert(`${level.name} needs at least one material.`);
  }

  const existingIndex = state.projects.findIndex(project => project.projectNumber.toLowerCase() === draft.projectNumber.toLowerCase());
  const projectRecord = {
    id: existingIndex >= 0 ? state.projects[existingIndex].id : uid(),
    projectNumber: draft.projectNumber,
    revision: draft.revision,
    address: draft.address,
    sourceFileName: draft.sourceFileName,
    createdAt: existingIndex >= 0 ? state.projects[existingIndex].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    levels: draft.levels.map(level => ({ ...level, id: level.id || uid(), deliveries: level.deliveries || [] }))
  };

  if (existingIndex >= 0) {
    const existing = state.projects[existingIndex];
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

function renderMatrix() {
  const showDelivered = $("showDelivered").checked;
  const levels = allLevels().filter(({ level }) => showDelivered || levelStats(level).status !== "delivered");
  const materials = uniqueMaterials(levels);
  const wrap = $("matrixWrap");
  const empty = $("matrixEmpty");

  if (!levels.length || !materials.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  const head = levels.map(({ project, level }) => {
    const stats = levelStats(level);
    return `<th class="project-col">
      <strong>${escapeHtml(project.projectNumber)}${project.revision ? ` · ${escapeHtml(project.revision)}` : ""}</strong>
      <span>${escapeHtml(level.name)}</span>
      <span>${escapeHtml(formatDate(level.estimatedDeliveryDate))}</span>
      <span class="status-badge ${stats.status}">${stats.status === "partial" ? "PARTIAL" : stats.status === "delivered" ? "DELIVERED" : "UPCOMING"}</span>
      <button class="mini-button manage-level" data-project-id="${project.id}" data-level-id="${level.id}">Manage level</button>
    </th>`;
  }).join("");

  const rows = materials.map(materialName => {
    const key = normalizeMaterialKey(materialName);
    const cells = levels.map(({ level }) => {
      const material = level.materials.find(item => normalizeMaterialKey(item.material) === key);
      if (!material) return `<td class="cell-zero">—</td>`;
      const outstanding = outstandingFor(level, material);
      const delivered = Number(material.requiredLf) - outstanding;
      const cls = outstanding <= 0.0001 ? "cell-delivered" : delivered > 0.0001 ? "cell-partial" : "";
      return `<td class="${cls}">${outstanding <= 0.0001 ? "0" : formatNumber(outstanding)}</td>`;
    }).join("");
    return `<tr><td class="material-col">${escapeHtml(materialName)}</td>${cells}</tr>`;
  }).join("");

  wrap.innerHTML = `<table><thead><tr><th class="material-col">Material / Outstanding LF</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.classList.remove("hidden");
  empty.classList.add("hidden");
}

function renderForecast() {
  const datedLevels = allLevels().filter(({ level }) => level.estimatedDeliveryDate && levelStats(level).outstanding > 0.0001);
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
  $("deliveryTitle").textContent = `${project.projectNumber} — ${level.name}`;
  $("deliverySubtitle").textContent = `${project.address || "No address"} · Forecast date ${formatDate(level.estimatedDeliveryDate)}`;
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
      <td><input class="delivery-input" data-material-index="${index}" type="number" min="0" max="${remaining}" step="0.01" value="0" ${remaining <= 0 ? "disabled" : ""} /></td>
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
    if (requested < -0.0001 || requested > max + 0.0001) throw new Error(`Delivery for ${material.material} must be between 0 and ${formatNumber(max)} LF.`);
    if (requested > 0.0001) items.push({ material: material.material, lf: requested });
  });
  if (!items.length) return alert("Enter at least one delivery quantity.");

  activeDelivery.level.deliveries ||= [];
  activeDelivery.level.deliveries.push({ id: uid(), date, note: normalizeSpaces($("deliveryNote").value), items, createdAt: new Date().toISOString() });
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
  const levels = allLevels().filter(({ level }) => $("showDelivered").checked || levelStats(level).status !== "delivered");
  const materials = uniqueMaterials(levels);
  const header = ["Material", ...levels.map(({ project, level }) => `${project.projectNumber}${project.revision ? ` ${project.revision}` : ""} - ${level.name}`)];
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
  const levels = allLevels().filter(({ level }) => level.estimatedDeliveryDate && levelStats(level).outstanding > 0.0001);
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
    if (!draft || !$("applyDateAll").checked) return;
    draft.levels.forEach(level => { level.estimatedDeliveryDate = $("projectDate").value; });
    renderDraftLevels();
  });

  $("applyDateAll").addEventListener("change", () => {
    if (!draft) return;
    syncDraftFromInputs();
    if ($("applyDateAll").checked) draft.levels.forEach(level => { level.estimatedDeliveryDate = $("projectDate").value; });
    renderDraftLevels();
  });

  $("addLevelBtn").addEventListener("click", () => {
    if (!draft) return;
    syncDraftFromInputs();
    draft.levels.push({ id: uid(), name: `Level ${draft.levels.length + 1}`, estimatedDeliveryDate: $("projectDate").value, materials: [{ material: "", requiredLf: 0 }], deliveries: [] });
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

  $("matrixWrap").addEventListener("click", event => {
    const button = event.target.closest(".manage-level");
    if (button) openDelivery(button.dataset.projectId, button.dataset.levelId);
  });

  $("updateForecastDate").addEventListener("click", () => {
    if (!activeDelivery) return;
    const nextDate = $("forecastDateEdit").value;
    if (!nextDate) return alert("Choose a forecast date.");
    activeDelivery.level.estimatedDeliveryDate = nextDate;
    persist();
    $("deliverySubtitle").textContent = `${activeDelivery.project.address || "No address"} · Forecast date ${formatDate(nextDate)}`;
  });

  $("fillEntireLevel").addEventListener("click", () => {
    if (!activeDelivery) return;
    document.querySelectorAll(".delivery-input").forEach(input => {
      const material = activeDelivery.level.materials[Number(input.dataset.materialIndex)];
      input.value = outstandingFor(activeDelivery.level, material);
    });
  });
  $("clearDeliveryInputs").addEventListener("click", () => document.querySelectorAll(".delivery-input").forEach(input => { input.value = 0; }));
  $("saveDelivery").addEventListener("click", () => {
    try { saveDelivery(); } catch (error) { alert(error.message); }
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

  $("exportMatrixCsv").addEventListener("click", exportMatrixCsv);
  $("exportForecastCsv").addEventListener("click", exportForecastCsv);
  $("exportBackup").addEventListener("click", () => downloadText(`ewp-forecast-backup-${todayIso()}.json`, JSON.stringify(state, null, 2), "application/json"));
  $("importBackup").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.projects)) throw new Error("This is not a compatible EWP Forecast backup.");
      if (!confirm(`Restore ${parsed.projects.length} projects from this backup? This replaces the current browser data.`)) return;
      state = parsed;
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
