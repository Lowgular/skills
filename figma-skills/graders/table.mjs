/**
 * table.mjs — read a markdown table into objects, deterministically.
 *
 * Agents answer "list every style with its value" with a table, and a table is
 * already structured: rows are entries, columns are fields. Handing that to a
 * model to re-type into JSON adds variance for nothing — measured 57/61 then
 * 61/61 on the same 61-row answer, purely because it dropped four glosses one
 * time and not the other.
 *
 * So score-extract.mjs tries this first and only falls back to a model when the
 * answer has no table, or its headers cannot be mapped to the golden's fields.
 *
 * Nothing here looks at the golden's VALUES — only its field NAMES, which the
 * extractor is told anyway. The parse cannot be led by the expected answer.
 */

/** Header synonyms, per golden field name. Longest match wins. */
const SYNONYMS = {
  name: ["style name", "style", "name", "token", "variable", "property", "level"],
  // "paint type" is here because one row asks for the hex OR the paint kind in
  // the same field ("use the hex for solid colours, the paint type otherwise"),
  // and answers split that across two tables with different headers. No golden
  // in the set carries both `value` and `type`, so this cannot steal a column
  // from `type` — if one ever does, give that row an explicit mapping instead.
  value: ["hex", "colour", "color", "value", "resolved", "paint type", "paint kind"],
  type: ["paint kind", "paint type", "paint", "kind", "type"],
  property: ["property", "prop", "name"],
  kind: ["kind", "type"],
  default: ["default", "default value"],
  options: ["options", "allowed values", "values", "allowed"],
  values: ["values", "options", "allowed values"],
  fontSize: ["font size", "size", "fontsize"],
  lineHeight: ["line height", "leading", "lineheight"],
  letterSpacing: ["letter spacing", "tracking", "letterspacing"],
  paragraphSpacing: ["paragraph spacing", "paragraphspacing"],
  fontFamily: ["font family", "family", "typeface", "fontfamily"],
  fontStyle: ["font style", "weight", "style", "fontstyle"],
  min: ["min", "from", "minimum"],
  max: ["max", "to", "maximum"],
  effects: ["effects", "effect", "shadow", "shadows"],
  count: ["count", "total"],
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Strip presentation from a cell, and a trailing gloss with it.
 *
 * `GRADIENT_LINEAR` — a linear gradient   → GRADIENT_LINEAR
 * `#bedce8` at opacity 0.3               → #bedce8
 * **Bold** (700)                         → Bold
 *
 * Only a gloss AFTER the value is dropped, and only when introduced by a dash
 * or parenthesis — never a comma, because "Light, Dark" is a list.
 */
export function cleanCell(raw) {
  let v = String(raw ?? "").trim();
  v = v.replace(/^\|+|\|+$/g, "").trim();
  v = v.replace(/`/g, "").replace(/\*\*?/g, "").trim();      // code + emphasis
  v = v.replace(/^["'](.*)["']$/s, "$1").trim();             // quoted value
  v = v.replace(/\s+[—–-]{1,2}\s+.*$/u, "").trim();          // — a linear gradient
  v = v.replace(/\s+\((?:[^()]*)\)\s*$/u, "").trim();        // (700)
  v = v.replace(/\s+(?:at|@)\s*opacity\s+[\d.]+\s*$/i, "").trim(); // at/@ opacity 0.3
  return v;
}

/** Every markdown table in the text, as { headers, rows }. */
export function parseTables(text) {
  const lines = String(text || "").split("\n");
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    // A table is a header row, a separator of dashes, then body rows.
    const sep = lines[i + 1];
    if (!sep || !/^\s*\|[\s:|-]*\|\s*$/.test(sep) || !/-/.test(sep)) continue;
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const headers = cells(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) {
      const r = cells(lines[j]);
      if (r.length >= 2) rows.push(r);
    }
    if (rows.length) tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * Map a table's headers onto the golden's field names.
 *
 * Returns null unless EVERY field finds a column — a partial mapping would
 * silently grade an entry as missing a field the answer actually gave, which is
 * worse than falling back to the model.
 */
export function mapHeaders(headers, fields, skip = new Set()) {
  const normed = headers.map(norm);
  const taken = new Set(skip);
  const out = {};
  // Longest synonym first, so "paint kind" beats "kind" for the same column.
  const candidates = fields.map((f) => ({
    field: f,
    syns: [...(SYNONYMS[f] || []), norm(f)].sort((a, b) => b.length - a.length),
  }));
  // Exact header matches before loose ones, so `name` does not steal `property`.
  for (const pass of ["exact", "loose"]) {
    for (const { field, syns } of candidates) {
      if (out[field] !== undefined) continue;
      for (const syn of syns) {
        const idx = normed.findIndex((h, k) =>
          !taken.has(k) && (pass === "exact" ? h === norm(syn) : h.includes(norm(syn))));
        if (idx !== -1) { out[field] = idx; taken.add(idx); break; }
      }
    }
  }
  return fields.every((f) => out[f] !== undefined) ? out : null;
}

/**
 * Every disjoint field group in one header row.
 *
 * Answers lay long lists out side by side to save vertical space:
 *
 *   | Style | Value | | Style | Value |
 *   | Elevation/Light/-1 | #e8ebef | | Elevation/Navy/-1 | #11243e |
 *
 * One mapping reads the left pair and silently drops the right — six entries
 * went missing exactly this way. So keep mapping until the remaining columns
 * cannot form another complete group.
 */
export function mapHeaderGroups(headers, fields) {
  const groups = [];
  const used = new Set();
  for (;;) {
    const m = mapHeaders(headers, fields, used);
    if (!m) break;
    groups.push(m);
    for (const i of Object.values(m)) used.add(i);
  }
  return groups;
}

/**
 * The answer's tables as objects keyed by the golden's field names, or null.
 *
 * `listFields` name columns whose cell is a list ("Light, Navy, Dark") and must
 * come back as an array — taken from the golden's shape, not its values.
 */
export function tableToObjects(text, fields, listFields = []) {
  // EVERY table that maps, not the first: a long answer groups its rows into
  // several tables (one per colour family), and taking only the first returned
  // 7 of 61 entries.
  const seen = new Set();
  const all = [];
  for (const { headers, rows } of parseTables(text)) {
    const groups = mapHeaderGroups(headers, fields);
    if (!groups.length) continue;
    const objs = [];
    for (const r of rows) {
      for (const map of groups) {
        const o = {};
        for (const f of fields) {
          const cell = cleanCell(r[map[f]]);
          o[f] = listFields.includes(f)
            ? cell.split(/\s*(?:,|·|\/|\||\bor\b)\s*/i).map((x) => cleanCell(x)).filter(Boolean)
            : cell;
        }
        // A side-by-side layout leaves the shorter column blank on trailing rows.
        if (fields.every((f) => !o[f] || (Array.isArray(o[f]) && !o[f].length))) continue;
        // A style repeated across rows (levels 0-4 sharing one paint) is one entry.
        const key = JSON.stringify(o);
        if (seen.has(key)) continue;
        seen.add(key);
        objs.push(o);
      }
    }
    all.push(...objs);
  }
  return all.length ? all : null;
}
