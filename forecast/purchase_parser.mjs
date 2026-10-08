let xlsxLib = null;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = clean(value).replaceAll(",", "");
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePoMaterialDescription(value) {
  let material = clean(value)
    .replace(/[×✕]/g, "x")
    .replace(/([\d"”])\s*[xX]\s*(?=\d)/g, "$1 x ");

  // Ody / mill PO shorthand used by Griff:
  // ML = LVL, TS = LSL. Keep all remaining product text unchanged.
  if (/^ML(?=\s|\d|-)/i.test(material)) material = material.replace(/^ML\s*/i, "LVL ");
  if (/^TS(?=\s|\d|-)/i.test(material)) material = material.replace(/^TS\s*/i, "LSL ");
  return clean(material);
}

function filenamePoNumber(fileName = "") {
  const base = String(fileName).replace(/\.[^.]+$/, "");
  const match = base.match(/(?:^|[^A-Z0-9])PO\s*#?\s*([A-Z0-9][A-Z0-9-]*)/i);
  return match ? clean(match[1]).toUpperCase() : "";
}

function valueAfterLabel(rows, wantedLabel) {
  const wanted = wantedLabel.toLowerCase();
  for (const row of rows.slice(0, 20)) {
    for (let index = 0; index < row.length; index += 1) {
      if (lower(row[index]) !== wanted) continue;
      for (let next = index + 1; next < Math.min(row.length, index + 6); next += 1) {
        const candidate = row[next];
        if (clean(candidate)) return candidate;
      }
    }
  }
  return "";
}

function toIsoDate(value, XLSX) {
  if (!value && value !== 0) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const utc = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    return utc.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && XLSX?.SSF?.parse_date_code) {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts?.y && parts?.m && parts?.d) {
      return `${String(parts.y).padStart(4, "0")}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
    }
  }
  const text = clean(value);
  if (!text) return "";
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString().slice(0, 10);
  }
  return "";
}

function headerInfo(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 35); rowIndex += 1) {
    const normalized = rows[rowIndex].map(lower);
    const description = normalized.indexOf("description");
    const lineal = normalized.indexOf("lineal");
    const length = normalized.indexOf("length");
    if (description < 0 || lineal < 0 || length < 0) continue;
    return {
      rowIndex,
      description,
      lineal,
      length,
      packages: normalized.indexOf("# pkgs"),
      pieces: normalized.indexOf("total pcs"),
      odyCode: normalized.indexOf("ody code"),
      productCode: normalized.indexOf("prod code")
    };
  }
  return null;
}

export function parsePurchaseRows(rows, fileName = "", XLSX = null) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("The workbook did not contain readable rows.");
  const header = headerInfo(rows);
  if (!header) throw new Error("I could not find the PO material table. Expected columns include Description, Length and Lineal.");

  const grouped = new Map();
  let totalPackages = 0;
  let totalPieces = 0;
  let sourceRows = 0;

  for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const first = lower(row.find(value => clean(value)) ?? "");
    if (first === "total") break;

    const rawDescription = clean(row[header.description]);
    const lineal = numeric(row[header.lineal]);
    if (!rawDescription || lineal <= 0) continue;

    const material = normalizePoMaterialDescription(rawDescription);
    if (!material) continue;
    const key = material.toLowerCase();
    const packages = header.packages >= 0 ? numeric(row[header.packages]) : 0;
    const pieces = header.pieces >= 0 ? numeric(row[header.pieces]) : 0;
    const lengthFt = numeric(row[header.length]);
    const odyCode = header.odyCode >= 0 ? clean(row[header.odyCode]) : "";
    const productCode = header.productCode >= 0 ? clean(row[header.productCode]) : "";

    let item = grouped.get(key);
    if (!item) {
      item = {
        material,
        rawDescriptions: [],
        quantityLf: 0,
        packages: 0,
        pieces: 0,
        breakdown: []
      };
      grouped.set(key, item);
    }
    if (!item.rawDescriptions.includes(rawDescription)) item.rawDescriptions.push(rawDescription);
    item.quantityLf += lineal;
    item.packages += packages;
    item.pieces += pieces;
    item.breakdown.push({
      lengthFt,
      packages,
      pieces,
      linealLf: lineal,
      odyCode,
      productCode
    });
    totalPackages += packages;
    totalPieces += pieces;
    sourceRows += 1;
  }

  const items = [...grouped.values()].sort((a, b) => a.material.localeCompare(b.material, undefined, { numeric: true }));
  if (!items.length) throw new Error("The PO table was found, but I could not read any material rows with positive Lineal footage.");

  const workbookPo = clean(valueAfterLabel(rows, "PO")).toUpperCase();
  const poNumber = workbookPo || filenamePoNumber(fileName);
  const orderDate = toIsoDate(valueAfterLabel(rows, "Date"), XLSX);
  const customer = clean(valueAfterLabel(rows, "Customer"));
  const totalLf = items.reduce((sum, item) => sum + item.quantityLf, 0);

  return {
    poNumber,
    poNumberSource: workbookPo ? "workbook" : (poNumber ? "filename" : ""),
    orderDate,
    customer,
    totalLf,
    totalPackages,
    totalPieces,
    sourceRows,
    items
  };
}

async function loadXlsx() {
  if (xlsxLib) return xlsxLib;
  const candidates = [
    "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs",
    "https://esm.sh/xlsx@0.18.5"
  ];
  let lastError;
  for (const url of candidates) {
    try {
      const imported = await import(url);
      const lib = imported?.read ? imported : imported?.default;
      if (!lib?.read || !lib?.utils?.sheet_to_json) throw new Error("XLSX module loaded without the expected API.");
      xlsxLib = lib;
      return xlsxLib;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Excel reader could not load. Your network may block both XLSX CDNs. ${lastError?.message || ""}`);
}

export async function parsePurchaseWorkbook(file) {
  if (!file) throw new Error("Choose an Excel PO file first.");
  const XLSX = await loadXlsx();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true, cellFormula: true, cellText: false });
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) throw new Error("The workbook has no worksheets.");
  let lastError;
  for (const sheetName of sheetNames) {
    try {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false });
      return parsePurchaseRows(rows, file.name, XLSX);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No worksheet contained a recognizable PO material table.");
}
