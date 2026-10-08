export function normalizeSpaces(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function stripTrailingDate(value) {
  return normalizeSpaces(value)
    .replace(/\s*\d{1,2}\/\d{1,2}\/\d{2,4}\b.*$/i, "")
    .trim();
}

function parseFilenameMeta(filename = "") {
  const stem = filename.replace(/\.pdf$/i, "");
  const match = stem.match(/\b([A-Za-z]{1,6}\d{2,})[_\- ]*(R\d+)\b/i);
  if (!match) return { projectNumber: "", revision: "" };
  return { projectNumber: match[1].toUpperCase(), revision: match[2].toUpperCase() };
}

export function parseLengthToFeet(raw = "") {
  const text = normalizeSpaces(raw);
  const feetMatch = text.match(/(\d+(?:\.\d+)?)\s*'/);
  if (!feetMatch) return null;
  const feet = Number(feetMatch[1]);
  if (!Number.isFinite(feet)) return null;

  const after = text.slice((feetMatch.index ?? 0) + feetMatch[0].length);
  const inchesMatch = after.match(/^\s*(\d+(?:\.\d+)?)\s*"/);
  const inches = inchesMatch ? Number(inchesMatch[1]) : 0;
  return Math.round((feet + inches / 12) * 100) / 100;
}

function parseTotalLengthLine(line) {
  const text = normalizeSpaces(line);
  if (!text || /^(page |\(†\)|refer to|length product|total lengths)/i.test(text)) return null;

  // Weyerhaeuser PDFs can extract in either visual order:
  //   1921'0"0 9 1/2" TJI 230 joist
  // or
  //   9 1/2" TJI 230 joist1921'0"0
  let match = text.match(/^(\d+(?:\.\d+)?'\s*\d*(?:\.\d+)?"?\s*\d*)\s*(.+)$/);
  if (match) {
    const feet = parseLengthToFeet(match[1]);
    const material = normalizeSpaces(match[2]);
    if (feet != null && material && /[A-Za-z]/.test(material)) return { material, requiredLf: feet };
  }

  match = text.match(/^(.+?)(\d+(?:\.\d+)?'\s*\d*(?:\.\d+)?"?\s*\d*)$/);
  if (match) {
    const material = normalizeSpaces(match[1]);
    const feet = parseLengthToFeet(match[2]);
    if (feet != null && material && /[A-Za-z]/.test(material)) return { material, requiredLf: feet };
  }

  // A more permissive fallback for text extraction that glues the material and length together.
  const apostropheIndex = text.lastIndexOf("'");
  if (apostropheIndex > 0) {
    const before = text.slice(0, apostropheIndex + 1);
    const afterApostrophe = text.slice(apostropheIndex + 1);
    const trailingFeet = before.match(/(\d+(?:\.\d+)?)'$/);
    if (trailingFeet) {
      const start = (trailingFeet.index ?? 0);
      const material = normalizeSpaces(before.slice(0, start));
      const feet = Number(trailingFeet[1]);
      if (material && /[A-Za-z]/.test(material) && Number.isFinite(feet)) {
        return { material, requiredLf: feet };
      }
    }

    const leadingFeet = text.match(/^(\d+(?:\.\d+)?)'/);
    if (leadingFeet) {
      const feet = Number(leadingFeet[1]);
      const material = normalizeSpaces(afterApostrophe.replace(/^\s*\d*(?:\.\d+)?"?\s*\d*/, ""));
      if (material && /[A-Za-z]/.test(material) && Number.isFinite(feet)) {
        return { material, requiredLf: feet };
      }
    }
  }

  return null;
}

function extractProjectMeta(lines, filename) {
  const filenameMeta = parseFilenameMeta(filename);
  let projectNumber = filenameMeta.projectNumber;
  let revision = filenameMeta.revision;

  for (const line of lines) {
    const jobMatch = line.match(/\bJob:\s*([A-Za-z0-9-]+)(?:[_\- ]+(R\d+))?/i);
    if (jobMatch) {
      const rawJob = jobMatch[1].toUpperCase();
      const embedded = rawJob.match(/^(.+?)[_\-](R\d+)$/i);
      projectNumber = (embedded ? embedded[1] : rawJob) || projectNumber;
      revision = (jobMatch[2] || (embedded ? embedded[2] : "") || revision).toUpperCase();
      break;
    }
  }

  // Some extraction engines keep tc26238_r1 as one token.
  for (const line of lines) {
    const match = line.match(/\b([A-Za-z]{1,6}\d{2,})[_\-](R\d+)\b/i);
    if (match) {
      projectNumber = match[1].toUpperCase();
      revision = match[2].toUpperCase();
      break;
    }
  }

  const levelIndex = lines.findIndex(line => /^Level\s*:/i.test(line));
  let address = "";
  if (levelIndex > 0) {
    const candidates = lines.slice(Math.max(0, levelIndex - 10), levelIndex)
      .map(stripTrailingDate)
      .map(normalizeSpaces)
      .filter(Boolean)
      .filter(line => !/^(address|job name|number of sheets|project\s*#|layout material list report|design date|job:)/i.test(line))
      .filter(line => !/^\d+$/.test(line))
      .filter(line => !/^R\d+$/i.test(line))
      .filter(line => !/^[A-Za-z]{1,6}\d{2,}[_\-]R\d+$/i.test(line));

    const likelyStart = candidates.findIndex(line => /\d/.test(line) && /[A-Za-z]/.test(line));
    const addressParts = likelyStart >= 0 ? candidates.slice(likelyStart) : candidates.slice(-2);
    address = normalizeSpaces(addressParts.join(" "));
  }

  return { projectNumber, revision, address };
}

function dedupeAndAggregateMaterials(materials) {
  const map = new Map();
  for (const item of materials) {
    const key = normalizeSpaces(item.material).toLowerCase();
    if (!key) continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { material: normalizeSpaces(item.material), requiredLf: Number(item.requiredLf) || 0 });
    } else if (Math.abs(existing.requiredLf - Number(item.requiredLf || 0)) < 0.001) {
      // Exact repeated Total Lengths lines can appear across page extraction; keep one copy.
      continue;
    } else {
      existing.requiredLf += Number(item.requiredLf) || 0;
    }
  }
  return [...map.values()].filter(item => item.requiredLf > 0);
}

function splitDefaultFilteredMaterials(materials) {
  const included = [];
  const filteredMaterials = [];
  for (const item of materials) {
    if (/\bweb\s+stiffeners?\b/i.test(item.material || "")) filteredMaterials.push(item);
    else included.push(item);
  }
  return { included, filteredMaterials };
}

function isTotalLengthsPageFurniture(line) {
  const text = normalizeSpaces(line);
  return /^(?:Page\s+\d+(?:\s+of\s+\d+)?|\(†\)|\(‡\)|Refer to\b|Layout Material List Report$|Job\s*:|Length\s+Product$|Design Date\b|Number of Sheets\b)/i.test(text)
    || /^\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?$/i.test(text);
}

function isTotalLengthsSectionBoundary(line) {
  const text = normalizeSpaces(line);
  return /^(?:Level\s*:|Products?$|Accessories?$|Blocking$|Connectors?$|Connector Summary$|Hangers?$|Hardware$)/i.test(text);
}

function collectTotalLengthMaterials(region) {
  const materials = [];
  let capturing = false;

  for (const line of region) {
    if (/^Total Lengths$/i.test(line)) {
      capturing = true;
      continue;
    }
    if (!capturing) continue;

    // Physical PDF page breaks are not logical Total Lengths boundaries. Weyerhaeuser
    // reports repeat footer/header furniture around the break before the material rows
    // continue, so ignore that furniture and keep the same capture state alive.
    if (isTotalLengthsPageFurniture(line)) continue;

    // Stop only when the report actually enters another logical section or level.
    if (isTotalLengthsSectionBoundary(line)) break;

    const parsed = parseTotalLengthLine(line);
    if (parsed) materials.push(parsed);
  }

  return materials;
}

export function parseMaterialReportLines(linesInput, filename = "") {
  const lines = linesInput.map(normalizeSpaces).filter(Boolean);
  const meta = extractProjectMeta(lines, filename);
  const levelPositions = [];

  lines.forEach((line, index) => {
    const match = line.match(/^Level\s*:\s*(.+)$/i);
    if (match) levelPositions.push({ index, name: normalizeSpaces(match[1]) || `Level ${levelPositions.length + 1}` });
  });

  const levels = [];
  for (let i = 0; i < levelPositions.length; i += 1) {
    const start = levelPositions[i].index;
    const end = i + 1 < levelPositions.length ? levelPositions[i + 1].index : lines.length;
    const region = lines.slice(start, end);
    const materials = collectTotalLengthMaterials(region);

    if (materials.length) {
      const aggregated = dedupeAndAggregateMaterials(materials);
      const { included, filteredMaterials } = splitDefaultFilteredMaterials(aggregated);
      levels.push({ name: levelPositions[i].name, materials: included, filteredMaterials });
    }
  }

  // Fallback for reports where text extraction loses the Level label but still has one Total Lengths section.
  if (!levels.length) {
    const materials = collectTotalLengthMaterials(lines);
    if (materials.length) {
      const aggregated = dedupeAndAggregateMaterials(materials);
      const { included, filteredMaterials } = splitDefaultFilteredMaterials(aggregated);
      levels.push({ name: "Level 1", materials: included, filteredMaterials });
    }
  }

  return { ...meta, levels };
}

export async function extractPdfLines(file, pdfjsLib) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const allLines = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    // Group PDF text items by their Y coordinate. This is materially more reliable than joining all items blindly.
    const rows = [];
    for (const item of content.items) {
      const text = normalizeSpaces(item.str);
      if (!text) continue;
      const y = item.transform?.[5] ?? 0;
      const x = item.transform?.[4] ?? 0;
      let row = rows.find(candidate => Math.abs(candidate.y - y) <= 2.2);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x, text });
    }

    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      allLines.push(normalizeSpaces(row.items.map(item => item.text).join(" ")));
    }
  }

  return allLines.filter(Boolean);
}
