/**
 * check-values.mjs — deterministic grader for "read these values off the design".
 *
 * Reads the agent's answer.json from the workspace (cwd) and compares it to the
 * case's `expected` block in dataset.json. Pure code check: no LLM judge, no
 * prose parsing, no live browser needed.
 *
 * The answer key is NOT in the workspace. This grader is invoked by ABSOLUTE
 * path with only CASE_ID in the environment, and reads dataset.json from its own
 * directory — so nothing the agent can see contains an expected value. (See
 * build-eval.mjs for why that matters.)
 *
 * Scoring: one point per expected key, all-or-nothing on that key's fields, so
 * "right hex, wrong token" scores zero for that key and the message says which
 * field broke. Extra keys in answer.json are ignored — the eval grades design
 * reading, not JSON obedience.
 *
 * Env:  CASE_ID (required)   ANSWER_FILE (default answer.json)
 */
import { readFileSync, existsSync } from "node:fs";

const CASE_ID = (process.env.CASE_ID || "").trim();
const ANSWER_FILE = process.env.ANSWER_FILE || "answer.json";

const emit = (score, details, checks = []) => {
  console.log(JSON.stringify({ score, details, checks }));
  process.exit(0);
};

// ---------------------------------------------------------------------------
// Normalization — accept every spelling of the same fact, reject different facts
// ---------------------------------------------------------------------------

// "the node has no background" is a legitimate answer, and CSS spells it several
// ways. All of these mean the same fact; inventing #ffffff does not.
const isNullish = (v) =>
  v === undefined || v === null || v === "" ||
  (typeof v === "string" &&
    ["none", "null", "n/a", "-", "unset", "transparent", "no fill", "not set", "rgba(0,0,0,0)"].includes(
      v.trim().toLowerCase(),
    ));

/** #ABC → #aabbcc; #rrggbbff → #rrggbb (opaque alpha is not a fact). */
function normColor(s) {
  let h = String(s).trim().toLowerCase();
  if (!h.startsWith("#")) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("ff")) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(h) ? "#" + h : null;
}

/** "8px" / "8" / "8.0px" / 8 → [8]. Multi-value ("12px 12px 0 0") → per-part. */
function normLengths(s) {
  const parts = String(s).trim().split(/\s+/);
  const nums = parts.map((p) => {
    const m = p.match(/^(-?[\d.]+)(px|rem|%)?$/i);
    return m ? parseFloat(m[1]) : NaN;
  });
  return nums.some(Number.isNaN) ? null : nums;
}

/** CSS box shorthand: [a] / [a,b] / [a,b,c] → [top,right,bottom,left]. */
function expand4(n) {
  if (n.length === 1) return [n[0], n[0], n[0], n[0]];
  if (n.length === 2) return [n[0], n[1], n[0], n[1]];
  if (n.length === 3) return [n[0], n[1], n[2], n[1]];
  return n;
}

/** var(--x) / --x → --x */
const normVar = (s) => {
  const t = String(s).trim();
  const m = t.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return (m ? m[1] : t).toLowerCase();
};

/** "Background/Brand/Default" — case- and space-insensitive around separators. */
const normToken = (s) =>
  String(s).trim().toLowerCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");

function sameValue(exp, got) {
  if (isNullish(exp)) return isNullish(got);
  if (isNullish(got)) return false;
  const ec = normColor(exp);
  if (ec) return ec === normColor(got);
  let el = normLengths(exp);
  if (el) {
    let gl = normLengths(got);
    if (!gl) return false;
    // "12px" and "12px 12px 12px 12px" are the same padding. Grading the
    // shorthand as wrong would grade verbosity, not design reading.
    if (el.length !== gl.length && (el.length <= 4 || gl.length <= 4)) {
      el = expand4(el);
      gl = expand4(gl);
    }
    return gl.length === el.length && el.every((n, i) => Math.abs(n - gl[i]) < 0.01);
  }
  return normToken(exp) === normToken(got);
}

const sameToken = (exp, got) => (isNullish(exp) ? isNullish(got) : !isNullish(got) && normToken(exp) === normToken(got));
const sameVar = (exp, got) => (isNullish(exp) ? isNullish(got) : !isNullish(got) && normVar(exp) === normVar(got));

/**
 * Look a flat "button.background-color" key up in the agent's JSON, accepting
 * either the flat key or one level of nesting. Shape tolerance is deliberate:
 * we are grading whether the agent read the design, not whether it can nest.
 */
function pick(answer, key) {
  if (answer && Object.prototype.hasOwnProperty.call(answer, key)) return answer[key];
  const i = key.indexOf(".");
  if (i === -1) return undefined;
  const outer = answer?.[key.slice(0, i)];
  return outer && typeof outer === "object" ? outer[key.slice(i + 1)] : undefined;
}

/** A bare "8px" is read as {value:"8px"} — then it fails any expected token, correctly. */
const asTriple = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? { value: v.value, token: v.token ?? v.variable ?? v.tokenName, var: v.var ?? v.cssVar ?? v.customProperty }
    : { value: v, token: undefined, var: undefined };

// ---------------------------------------------------------------------------
// Enumeration answers — "what variants does Avatar have?"
//
// These CANNOT use one graded key per fact: the key list is printed in the
// instruction, so "axes.Shape" would hand the agent the axis names it was asked
// to discover. So the whole enumeration is ONE key holding a set or a map, and
// the comparison below is order-insensitive over its contents.
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Sets are compared normalized: order, case and inner whitespace never matter. */
const toSet = (arr) => new Set(arr.map((x) => normToken(String(x))));

function diffSets(exp, got) {
  if (!Array.isArray(got)) return { ok: false, why: `expected a list, got ${typeof got}` };
  const e = toSet(exp), g = toSet(got);
  const missing = [...e].filter((x) => !g.has(x));
  const extra = [...g].filter((x) => !e.has(x));
  return {
    ok: !missing.length && !extra.length,
    why: [missing.length ? `missing ${JSON.stringify(missing)}` : "", extra.length ? `extra ${JSON.stringify(extra)}` : ""]
      .filter(Boolean).join("; "),
  };
}

/**
 * Enum-ish scalar compare, used for map values like "Label": "TEXT".
 *
 * A run that answers `"BOOLEAN (default: true)"` has stated the fact and added
 * true commentary. Scoring that zero grades terseness, not design reading — so
 * an answer that LEADS with the expected token is accepted. It still has to lead
 * with the right one: "TEXT" does not match an expected "SLOT".
 */
function sameEnum(exp, got) {
  if (sameValue(exp, got)) return true;
  if (typeof got !== "string" || typeof exp !== "string") return false;
  const e = normToken(exp), g = normToken(got);
  return g === e || g.startsWith(e + " ") || g.startsWith(e + "(") || g.startsWith(e + ":") || g.startsWith(e + ",") || g.startsWith(e + " (");
}

/** Map compare: key set must match, then each value as a set (arrays) or scalar. */
function diffMaps(exp, got) {
  if (!isPlainObject(got)) return { ok: false, why: `expected an object, got ${Array.isArray(got) ? "a list" : typeof got}` };
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [normToken(k), v]));
  const e = norm(exp), g = norm(got);
  const missing = Object.keys(e).filter((k) => !(k in g));
  const extra = Object.keys(g).filter((k) => !(k in e));
  const wrong = [];
  for (const k of Object.keys(e)) {
    if (!(k in g)) continue;
    const d = Array.isArray(e[k])
      ? diffSets(e[k], g[k])
      : { ok: sameEnum(e[k], g[k]), why: `got ${JSON.stringify(g[k])}, want ${JSON.stringify(e[k])}` };
    if (!d.ok) wrong.push(`${k}: ${d.why}`);
  }
  return {
    ok: !missing.length && !extra.length && !wrong.length,
    why: [missing.length ? `missing key(s) ${JSON.stringify(missing)}` : "",
          extra.length ? `extra key(s) ${JSON.stringify(extra)}` : "",
          ...wrong].filter(Boolean).join("; "),
  };
}

// ---------------------------------------------------------------------------

if (!CASE_ID) emit(0, "no CASE_ID provided to grader", [{ name: "config", passed: false, message: "CASE_ID unset" }]);

const ds = JSON.parse(readFileSync(new URL("../dataset.json", import.meta.url), "utf8"));
const kase = ds.cases.find((c) => c.id === CASE_ID);
if (!kase) emit(0, `unknown CASE_ID "${CASE_ID}"`, [{ name: "config", passed: false, message: "not in dataset.json" }]);

if (!existsSync(ANSWER_FILE)) {
  emit(0, `${ANSWER_FILE} not written`, [
    { name: "answer-file-exists", passed: false, message: `expected ${ANSWER_FILE} in the workspace` },
  ]);
}
let answer;
try {
  answer = JSON.parse(readFileSync(ANSWER_FILE, "utf8"));
} catch (e) {
  emit(0, `${ANSWER_FILE} is not valid JSON`, [
    { name: "answer-file-parses", passed: false, message: String(e.message || e) },
  ]);
}

// --- refuse cases: the correct answer is "I won't guess, here are the options"
if (kase.expected?.refused) {
  const refused = answer.refused === true;
  const cands = Array.isArray(answer.candidates) ? answer.candidates : [];
  const min = kase.expected.minCandidates || 2;
  const enough = cands.length >= min;
  // A concrete value alongside the refusal means it guessed anyway and hedged.
  const asserted = Object.entries(answer)
    .filter(([k]) => /colou?r|value|token|var|radius/i.test(k))
    .filter(([, v]) => !isNullish(v))
    .map(([k]) => k);
  const checks = [
    { name: "refused instead of guessing", passed: refused, message: `refused=${JSON.stringify(answer.refused)}` },
    { name: `listed >=${min} candidates`, passed: enough, message: `${cands.length} candidate(s): ${JSON.stringify(cands).slice(0, 200)}` },
    { name: "did not assert a value anyway", passed: !asserted.length, message: asserted.length ? `also asserted: ${asserted.join(", ")}` : "no value asserted" },
  ];
  const passed = checks.filter((c) => c.passed).length;
  emit(passed / checks.length, `${passed}/${checks.length} refusal checks passed`, checks);
}

// --- values cases
const keys = Object.keys(kase.expected || {}).filter((k) => !k.startsWith("_meta."));
if (!keys.length) {
  emit(0, `case "${CASE_ID}" has no expected values — run: node extract.mjs --write`, [
    { name: "config", passed: false, message: "empty expected block" },
  ]);
}

const checks = keys.map((key) => {
  const exp = kase.expected[key];

  // Enumerations: one key, whole set or map compared at once.
  if (Array.isArray(exp)) {
    const raw = pick(answer, key);
    if (raw === undefined) return { name: key, passed: false, message: `missing — expected ${exp.length} item(s)` };
    const d = diffSets(exp, raw);
    return { name: key, passed: d.ok, message: d.ok ? `${exp.length} item(s) match` : d.why };
  }
  if (isPlainObject(exp) && !("value" in exp)) {
    const raw = pick(answer, key);
    if (raw === undefined) return { name: key, passed: false, message: `missing — expected ${Object.keys(exp).length} entr(ies)` };
    const d = diffMaps(exp, raw);
    return { name: key, passed: d.ok, message: d.ok ? `${Object.keys(exp).length} entr(ies) match` : d.why };
  }

  // Scalars: "font-weight": 600 — no token/var to report.
  if (!isPlainObject(exp)) {
    const raw = pick(answer, key);
    const got = isPlainObject(raw) ? raw.value : raw;
    if (got === undefined) return { name: key, passed: false, message: `missing — expected ${JSON.stringify(exp)}` };
    const ok = sameValue(exp, got);
    return { name: key, passed: ok, message: ok ? String(exp) : `got ${JSON.stringify(got)}, want ${JSON.stringify(exp)}` };
  }

  const got = asTriple(pick(answer, key));
  if (got.value === undefined && got.token === undefined && got.var === undefined) {
    return { name: key, passed: false, message: `missing — expected ${exp.value}${exp.token ? ` / ${exp.token}` : ""}` };
  }
  const bad = [];
  if (!sameValue(exp.value, got.value)) bad.push(`value: got ${JSON.stringify(got.value)}, want ${JSON.stringify(exp.value)}`);
  if (!sameToken(exp.token, got.token)) bad.push(`token: got ${JSON.stringify(got.token)}, want ${JSON.stringify(exp.token)}`);
  if (!sameVar(exp.var, got.var)) bad.push(`var: got ${JSON.stringify(got.var)}, want ${JSON.stringify(exp.var)}`);
  return { name: key, passed: bad.length === 0, message: bad.length ? bad.join("; ") : `${exp.value}${exp.token ? ` / ${exp.token}` : ""}` };
});

const passed = checks.filter((c) => c.passed).length;
emit(passed / checks.length, `${passed}/${checks.length} values correct`, checks);
