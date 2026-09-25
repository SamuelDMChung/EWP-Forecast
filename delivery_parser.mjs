import { normalizeSpaces, parseLengthToFeet } from "./parser.mjs";

function clean(value = "") {
  return normalizeSpaces(value);
}

function parseFilenameMeta(filename = "") {
  const stem = String(filename || "").replace(/\.pdf$/i, "");
  const project = stem.match(/\b([A-Za-z]{1,8}\d{2,})[_\- ]*(R\d+)\b/i);
  const delivery = stem.match(/\b(L\s*\d+\s*D\s*\d+)\b/i);
  return {
    projectNumber: project ? project[1].toUpperCase() : "",
    revision: project ? project[2].toUpperCase() : "",
    deliveryCode: delivery ? delivery[1].replace(/\s+/g, "").toUpperCase() : ""
  };
}

function isEwpProduct(product = "") {
  const value = clean(product).toUpperCase();
  return /\bTJI\s*\d+\b/.test(value)
    || /\b(?:LVL|MICROLLAM)\b/.test(value)
    || /\b(?:LSL|TIMBERSTRAND)\b/.test(value)
    || /\b(?:PSL|PARALLAM)\b/.test(value)
    || /\bRIM\s*BOARD\b|\bRIMBOARD\b/.test(value);
}

function parseMaterialLine(line) {
  const text = clean(line);
  if (!text || /\bWeb\s+Stiffeners?\b/i.test(text)) return null;

  // Layout Material List rows render as:
  //   PlotID  Length  Product  Plies  Net Qty
  // Example:
  //   MLdg9 14'0"0 1 3/4" x 9 1/4" 2.0E Microllam LVL (WSO) 1 1
  // The extra trailing 0 after the inch mark is part of the source report's
  // length formatting and parseLengthToFeet safely ignores it.
  const match = text.match(/^\s*\S+\s+(\d+(?:\.\d+)?'\s*\d*(?:\.\d+)?"?\s*\d*)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/i);
  if (!match) return null;

  const lengthFt = parseLengthToFeet(match[1]);
  const product = clean(match[2]);
  const plies = Number(match[3]);
  const netQty = Number(match[4]);
  if (!Number.isFinite(lengthFt) || lengthFt <= 0) return null;
  if (!Number.isFinite(netQty) || netQty <= 0) return null;
  if (!isEwpProduct(product)) return null;

  // Business rule from the delivery/material-list workflow:
  // subtotal LF = Length x Net Qty. Plies is informational only and must not
  // be multiplied again because Net Qty already represents the required pieces.
  const quantityLf = Math.round(lengthFt * netQty * 100) / 100;
  return {
    product,
    rawLine: text,
    lengthFt,
    plies: Number.isFinite(plies) ? plies : 0,
    netQty,
    quantityLf
  };
}

function extractMeta(lines, filename = "") {
  const fileMeta = parseFilenameMeta(filename);
  let projectNumber = fileMeta.projectNumber;
  let revision = fileMeta.revision;
  let levelName = "";
  let deliveryCode = fileMeta.deliveryCode;

  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;

    const projectField = line.match(/\bPROJECT\s*#\s*:\s*([A-Za-z0-9-]+)(?:[_\- ]+(R\d+))?/i);
    if (projectField) {
      const rawProject = projectField[1].toUpperCase();
      const embedded = rawProject.match(/^(.+?)[_\-](R\d+)$/i);
      projectNumber = (embedded ? embedded[1] : rawProject) || projectNumber;
      revision = (projectField[2] || embedded?.[2] || revision || "").toUpperCase();
    }

    const job = line.match(/\bJob:\s*([A-Za-z0-9-]+)(?:[_\- ]+(R\d+))?/i);
    if (job) {
      const rawProject = job[1].toUpperCase();
      const embedded = rawProject.match(/^(.+?)[_\-](R\d+)$/i);
      projectNumber = (embedded ? embedded[1] : rawProject) || projectNumber;
      revision = (job[2] || embedded?.[2] || revision || "").toUpperCase();
    }

    const embeddedProject = line.match(/\b([A-Za-z]{1,8}\d{2,})[_\-](R\d+)\b/i);
    if (embeddedProject) {
      projectNumber = embeddedProject[1].toUpperCase();
      revision = embeddedProject[2].toUpperCase();
    }

    const level = line.match(/^Level\s*:\s*(.+)$/i);
    if (level && !levelName) levelName = clean(level[1]);

    const delivery = line.match(/\b(L\s*\d+\s*D\s*\d+)\b/i);
    if (delivery && !deliveryCode) deliveryCode = delivery[1].replace(/\s+/g, "").toUpperCase();
  }

  return { projectNumber, revision, levelName, deliveryCode };
}

export function parseDeliveryMaterialReportLines(linesInput, filename = "") {
  const lines = (linesInput || []).map(clean).filter(Boolean);
  if (!lines.length) throw new Error("The PDF did not contain readable text.");

  const meta = extractMeta(lines, filename);
  const parsedRows = [];
  for (const line of lines) {
    const parsed = parseMaterialLine(line);
    if (parsed) parsedRows.push(parsed);
  }

  if (!parsedRows.length) {
    throw new Error("I could not find EWP material rows with Length, Product, Plies and Net Qty in this PDF.");
  }

  const grouped = new Map();
  for (const row of parsedRows) {
    const key = row.product.toLowerCase();
    let item = grouped.get(key);
    if (!item) {
      item = {
        material: row.product,
        quantityLf: 0,
        breakdown: [],
        rawDescriptions: [row.product]
      };
      grouped.set(key, item);
    }
    item.quantityLf += row.quantityLf;
    item.breakdown.push({
      lengthFt: row.lengthFt,
      netQty: row.netQty,
      plies: row.plies,
      linealLf: row.quantityLf,
      rawLine: row.rawLine
    });
  }

  const items = [...grouped.values()]
    .map(item => ({ ...item, quantityLf: Math.round(item.quantityLf * 100) / 100 }))
    .sort((a, b) => a.material.localeCompare(b.material, undefined, { numeric: true }));

  return {
    ...meta,
    sourceFileName: filename || "",
    sourceRows: parsedRows.length,
    totalLf: Math.round(items.reduce((sum, item) => sum + item.quantityLf, 0) * 100) / 100,
    items
  };
}
