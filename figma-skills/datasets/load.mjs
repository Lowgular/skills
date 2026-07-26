/**
 * load.mjs — the only module that knows the dataset's physical shape.
 *
 * One file, `rows.jsonl`, one row per line, flat columns. Every facet a caller
 * might want to slice on is a top-level column, not a nested `metadata` object:
 * that keeps a filter a one-level lookup (`row[col]`), keeps a line diff
 * readable, and means `duckdb -c "select * from read_json_auto('rows.jsonl')"`
 * gives you a real table with no unnesting.
 *
 *   id        unique, stable, forever — the join key from results back to here
 *   tier      easy | medium | hard          difficulty
 *   type      the capability under test     (open, prop, token, axes, refuse, …)
 *   form      the exact question form       (prop.fills, style.fontsize, …)
 *             — the sampling stratum: "one of each kind" means one per form
 *   file_key  which Figma file the answer was read from
 *   tags      curated labels (smoke, p1, …) — the ONLY hand-written column
 *   task      the question put to the agent
 *   note      why the row is hard (human-facing; never shown to the agent)
 *   graders   [{ name, arguments }]
 *
 * `tags` is CURATED and everything else is DERIVED. gen.mjs regenerates the
 * derived columns from the live Figma file and carries `tags` forward by id —
 * see CURATED below, which is the whole of that contract.
 *
 * Column names avoid SQL reserved words on purpose (`form`, not `group`) so the
 * file stays queryable in DuckDB without quoting.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROWS_PATH = fileURLToPath(new URL("./rows.jsonl", import.meta.url));

/** On-disk key order. Fixed, so a changed tag is a legible one-line diff. */
export const COLUMNS = ["id", "tier", "type", "form", "file_key", "tags", "task", "note", "graders"];

/** Hand-written columns. gen.mjs must carry these forward, never overwrite. */
export const CURATED = ["tags"];

/** Columns exposed as `--<col>=v[,v]` filters. `task`/`note` are prose and
 *  `graders` is nested, so neither is a sensible equality filter. Add a column
 *  here and it becomes a flag in build-eval.mjs with no change to that file. */
export const FILTERABLE = ["id", "tier", "type", "form", "file_key", "tags"];

/**
 * id prefix → { type, form }.
 *
 * Ids are generated from the same templates as the questions, so the first
 * segment is a reliable discriminator — but only because this table is
 * exhaustive and an unknown prefix throws instead of defaulting. `form` takes a
 * suffix from the id where one question kind covers several fields.
 *
 *   suffix: "last"  → form is `<type>.<last segment>`   prop-button-…-fills → prop.fills
 *   suffix: "2nd"   → form is `<type>.<second segment>` inv-page-buttons    → inv.page
 *
 * Note the two text cases that read alike and are not: `type-*` asks about a
 * named text STYLE's property; `textstyle-*` asks which style a named LAYER
 * inside a component uses. They get different type names for that reason.
 */
const RULES = {
  open: { type: "open" },
  type: { type: "style", suffix: "last" },
  varcss: { type: "varcss" },
  var: { type: "var" },
  alias: { type: "alias" },
  prop: { type: "prop", suffix: "last" },
  token: { type: "token", suffix: "last" },
  axes: { type: "axes" },
  axis: { type: "axis" },
  props: { type: "props" },
  proptype: { type: "proptype" },
  uses: { type: "uses" },
  textlayers: { type: "layer-list" },
  textstyle: { type: "layer-style" },
  textcolor: { type: "layer-color" },
  inv: { type: "inv", suffix: "2nd" },
  count: { type: "count", suffix: "2nd" },
  refuse: { type: "refuse" },
};

/** id → { type, form }. Throws on an unrecognised prefix — a silently
 *  misclassified row would quietly drop out of every filter that should match it. */
export function classify(id) {
  const parts = String(id).split("-");
  const rule = RULES[parts[0]];
  if (!rule) {
    throw new Error(
      `cannot classify "${id}": no rule for prefix "${parts[0]}". ` +
        `Add it to RULES in datasets/load.mjs (known: ${Object.keys(RULES).join(", ")}).`,
    );
  }
  const suffix =
    rule.suffix === "last" ? parts[parts.length - 1] : rule.suffix === "2nd" ? parts[1] : null;
  return { type: rule.type, form: suffix ? `${rule.type}.${suffix}` : rule.type };
}

/** One row → one line, fixed key order, empty columns omitted. */
export function serialize(row) {
  const out = {};
  for (const c of COLUMNS) {
    const v = row[c];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0 && c !== "graders") continue;
    out[c] = v;
  }
  return JSON.stringify(out);
}

/**
 * Read + validate. Returns rows in file order.
 * Validation is loud and positional: a bad dataset should name its own line.
 */
export function loadRows(path = ROWS_PATH) {
  if (!existsSync(path)) {
    throw new Error(`no dataset at ${path} — run: node gen.mjs --write`);
  }
  const rows = [];
  const seen = new Map();
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`rows.jsonl:${i + 1} is not valid JSON — ${e.message}`);
    }
    if (!row.id) throw new Error(`rows.jsonl:${i + 1} has no id`);
    if (seen.has(row.id)) throw new Error(`rows.jsonl:${i + 1} duplicate id "${row.id}" (first seen on line ${seen.get(row.id)})`);
    seen.set(row.id, i + 1);
    if (!row.task) throw new Error(`rows.jsonl:${i + 1} (${row.id}) has no task`);
    if (!Array.isArray(row.graders) || !row.graders.length)
      throw new Error(`rows.jsonl:${i + 1} (${row.id}) has no graders`);
    row.tags = row.tags || [];
    rows.push(row);
  }
  return rows;
}

/** id → row, for the grader's single lookup. */
export function rowById(id, path = ROWS_PATH) {
  return loadRows(path).find((r) => r.id === id) || null;
}

const globToRe = (s) => new RegExp("^" + s.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

/** One column value vs the wanted list. OR within the list; `*` globs; an array
 *  column (tags) matches on containment. */
function matches(value, wanted) {
  const have = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? ""));
  return wanted.some((w) =>
    w.includes("*") ? have.some((h) => globToRe(w).test(h)) : have.includes(w),
  );
}

/**
 * Turn argv into { include: {col: [v]}, exclude: {col: [v]} }.
 *
 * Any FILTERABLE column is a flag automatically — `--tier=easy,medium`,
 * `--tags=smoke`, `--id=open-*`. `--not-<col>=v` excludes. Unknown flags are an
 * error rather than a silent no-op, because a typo'd filter that matched
 * everything would quietly run (and bill for) the whole suite.
 */
export function parseFilters(argv, reserved = []) {
  const include = {};
  const exclude = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.trim();
    if (reserved.includes(key)) continue;
    const neg = key.startsWith("not-");
    const col = neg ? key.slice(4) : key;
    if (!FILTERABLE.includes(col)) {
      throw new Error(
        `unknown filter "--${key}". Filterable columns: ${FILTERABLE.join(", ")} ` +
          `(prefix with not- to exclude). Other flags: ${reserved.map((r) => "--" + r).join(", ")}`,
      );
    }
    const values = rest.join("=").split(",").map((s) => s.trim()).filter(Boolean);
    if (!values.length) throw new Error(`--${key} needs a value, e.g. --${key}=smoke`);
    const bag = neg ? exclude : include;
    bag[col] = (bag[col] || []).concat(values);
  }
  return { include, exclude };
}

/** AND across columns, OR within a column. Excludes win. */
export function selectRows(rows, { include = {}, exclude = {} } = {}) {
  return rows.filter((r) => {
    for (const [col, wanted] of Object.entries(include)) if (!matches(r[col], wanted)) return false;
    for (const [col, wanted] of Object.entries(exclude)) if (matches(r[col], wanted)) return false;
    return true;
  });
}

/** Columns that make sense to stratify by — scalar, low cardinality. */
export const STRATA = ["form", "type", "tier", "file_key"];

/** FNV-1a. Not cryptographic — this only has to spread ids evenly. */
const hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

/**
 * At most `n` rows per distinct value of `per` — "one of each kind, three of
 * each kind, all".
 *
 * Deterministic by construction: rows are ranked inside their group by
 * hash(seed|id), so the same seed always picks the same rows. That matters more
 * than it sounds — a smoke suite whose membership drifts between runs makes
 * every pass-rate change ambiguous. Ranking by a hash of the *id* (rather than
 * shuffling positions) also means adding a row to one group leaves the other
 * groups' picks untouched.
 *
 * Coverage, not distribution: a form with 1 row and a form with 14 both
 * contribute `n`. That is the point — you are asking "does every question kind
 * still work?", not "what is my pass rate?".
 */
export function sampleRows(rows, { n, per = "form", seed = 1 } = {}) {
  if (!n) return rows;
  if (!STRATA.includes(per)) {
    throw new Error(`--per=${per} is not stratifiable. Use one of: ${STRATA.join(", ")}`);
  }
  const groups = new Map();
  for (const r of rows) {
    const k = String(r[per] ?? "—");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keep = new Set();
  for (const [k, g] of groups) {
    const ranked = [...g].sort((a, b) => hash(`${seed}|${a.id}`) - hash(`${seed}|${b.id}`));
    for (const r of ranked.slice(0, n)) keep.add(r.id);
  }
  return rows.filter((r) => keep.has(r.id)); // dataset order, not group order
}

/** Count rows per distinct value of a column (array columns count per element). */
export function tally(rows, col) {
  const out = new Map();
  for (const r of rows) {
    const vals = Array.isArray(r[col]) ? (r[col].length ? r[col] : ["—"]) : [r[col] ?? "—"];
    for (const v of vals) out.set(String(v), (out.get(String(v)) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
