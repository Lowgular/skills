/**
 * grade.mjs — the only grader. Dispatches on the row's `graders` array.
 *
 *   { "name": "open",   "arguments": ["1444:11846"] }   live editor state over CDP
 *   { "name": "value",  "arguments": ["#2c2c2c"] }      one scalar from answer.txt
 *   { "name": "list",   "arguments": ["Large","Small"] } a set, order-insensitive
 *   { "name": "refuse", "arguments": ["2"] }            min candidates to name
 *
 * A row scores the mean of its graders. One line of answer.txt per grader, in
 * order — no JSON, so response format is never what is being measured.
 *
 * The answer key is NOT in the workspace: this is invoked by absolute path with
 * only ROW_ID, and reads datasets/rows.jsonl from its own directory. skillgrade
 * copies the grader's `run:` line verbatim into <workspace>/tests/test.sh, which
 * is the agent's cwd — so an expected value there would be a plain-text answer
 * key. (TIER is also on that line, but only so harness/run-claude.mjs can
 * reconstruct the task name; grading never reads it.)
 *
 * Env:  ROW_ID (required)   ANSWER_FILE (default answer.txt)   COVER_ID (3:5)
 */
import { readFileSync, existsSync } from "node:fs";
import { rowById } from "../datasets/load.mjs";

const ROW_ID = (process.env.ROW_ID || "").trim();
const ANSWER_FILE = process.env.ANSWER_FILE || "answer.txt";
const COVER_ID = process.env.COVER_ID || "3:5";

const emit = (score, details, checks = []) => {
  console.log(JSON.stringify({ score, details, checks }));
  process.exit(0);
};

// ── normalisation: accept every spelling of a fact, reject different facts ──

const isNullish = (v) =>
  v === undefined || v === null ||
  (typeof v === "string" &&
    ["", "none", "null", "n/a", "-", "unset", "transparent", "no fill", "not set"].includes(v.trim().toLowerCase()));

function normColor(s) {
  let h = String(s).trim().toLowerCase();
  if (!h.startsWith("#")) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("ff")) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(h) ? "#" + h : null;
}

/** "16px" / "16" / "140%" / 16 → number. Percent and px are not interchangeable. */
function normNum(s) {
  const m = String(s).trim().match(/^(-?[\d.]+)\s*(px|rem|%)?$/i);
  if (!m) return null;
  return { n: parseFloat(m[1]), unit: (m[2] || "").toLowerCase() };
}

const normVar = (s) => {
  const t = String(s).trim();
  const m = t.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return (m ? m[1] : t).toLowerCase();
};

/** Case- and space-insensitive around "/" — "Space / 200" is "Space/200". */
const normText = (s) => String(s).trim().toLowerCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");

function sameValue(exp, got) {
  if (isNullish(exp)) return isNullish(got);
  if (isNullish(got)) return false;

  const ec = normColor(exp);
  if (ec) return ec === normColor(got);

  if (/^(var\(|--)/.test(String(exp).trim())) return normVar(exp) === normVar(got);

  const en = normNum(exp);
  if (en) {
    const gn = normNum(got);
    if (!gn) return false;
    // A bare number answers a px expectation ("16" for "16px") but not a
    // percentage one — 140 and 140% are the same, 140px and 140% are not.
    if (en.unit === "%" && gn.unit && gn.unit !== "%") return false;
    if (gn.unit === "%" && en.unit && en.unit !== "%") return false;
    return Math.abs(en.n - gn.n) < 0.01;
  }
  return normText(exp) === normText(got);
}

// ── answer.txt: one line per grader ────────────────────────────────────────

/**
 * Both cleanups below are deliberately narrow. A greedy version cost me every
 * numeric answer in the suite: /^[-*\d.)\s]+/ turns "24px" into "px", "600" into
 * "", and "--sds-color-x" into "sds-color-x".
 *
 *   bullets  only a marker FOLLOWED BY WHITESPACE ("- x", "1. x") — so a bare
 *            "600" and a leading "--" survive.
 *   labels   only "word: value" with a space after the colon, and never a
 *            digits-only prefix — so the node id "1444:11846" survives.
 */
const stripBullet = (l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
const stripLabel = (l) => l.replace(/^[A-Za-z][\w -]{0,23}:[ \t]+/, "");

function answerLines() {
  if (!existsSync(ANSWER_FILE)) return null;
  return readFileSync(ANSWER_FILE, "utf8")
    .split("\n")
    .map((l) => stripLabel(stripBullet(l.trim())).trim())
    .filter((l) => l.length);
}

// ── graders ───────────────────────────────────────────────────────────────

const CDP = async () => {
  const { config, cdpAlive } = await import("../figma-browser/lib/connect.mjs");
  const { connect } = await import("../figma-browser/lib/cdp.mjs");
  const cfg = config();
  if (!(await cdpAlive(cfg.port))) return null;
  return { cdp: await connect({ port: cfg.port, match: cfg.fileKey }), cfg };
};

const READ_STATE = `(async () => (typeof figma === "undefined"
  ? { error: "window.figma absent" }
  : { pageId: figma.currentPage.id, pageName: figma.currentPage.name,
      selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name })) }))()`;

const RESET = (cover) => `(async () => {
  const p = await figma.getNodeByIdAsync(${JSON.stringify(cover)});
  if (p && p.type === "PAGE") await figma.setCurrentPageAsync(p);
  figma.currentPage.selection = [];
  return true;
})()`;

/** open: the live editor must be showing the node. Never the agent's report. */
async function gradeOpen(expectedId) {
  const c = await CDP();
  if (!c) return { passed: false, message: "Chrome not answering CDP — precondition failure" };
  try {
    let st = null;
    for (let i = 0; i < 10; i++) {
      st = await c.cdp.evaluate(READ_STATE, { timeoutMs: 5000 }).catch((e) => ({ error: String(e.message || e) }));
      if (st && !st.error && (st.pageId === expectedId || st.selection.some((n) => n.id === expectedId))) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!st || st.error) return { passed: false, message: st?.error || "unreachable" };
    const onPage = st.pageId === expectedId;
    const selected = st.selection.some((n) => n.id === expectedId);
    return {
      passed: onPage || selected,
      message: onPage
        ? `currentPage=${st.pageName} (${st.pageId})`
        : selected
          ? `selected ${JSON.stringify(st.selection)}`
          : `page=${st.pageId}, selection=${JSON.stringify(st.selection)} — wanted ${expectedId}`,
    };
  } finally {
    // Reset page AND selection: a selected node survives a page switch and would
    // let the next trial pass without doing any work.
    await c.cdp.evaluate(RESET(COVER_ID), { timeoutMs: 10_000 }).catch(() => {});
    c.cdp.close();
  }
}

/** value: extra arguments are accepted ALTERNATIVES, not extra required facts. */
function gradeValue(args, line) {
  if (line === undefined) return { passed: false, message: `no answer line — expected ${JSON.stringify(args[0])}` };
  const ok = args.some((a) => sameValue(a, line));
  return { passed: ok, message: ok ? String(args[0]) : `got ${JSON.stringify(line)}, want ${args.map((a) => JSON.stringify(a)).join(" or ")}` };
}

/** list: one comma-separated line, compared as a set. */
function gradeList(args, line) {
  if (line === undefined) return { passed: false, message: `no answer line — expected ${args.length} item(s)` };
  const got = line.split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  const e = new Set(args.map(normText));
  const g = new Set(got.map(normText));
  const missing = [...e].filter((x) => !g.has(x));
  const extra = [...g].filter((x) => !e.has(x));
  const ok = !missing.length && !extra.length;
  return {
    passed: ok,
    message: ok
      ? `${args.length} item(s) match`
      : [missing.length ? `missing ${JSON.stringify(missing)}` : "", extra.length ? `extra ${JSON.stringify(extra)}` : ""].filter(Boolean).join("; "),
  };
}

/**
 * count: "how many X are there" — one integer, exact.
 *
 * The cheap way to grade a broad question. A run that samples instead of
 * enumerating gets a plausible-looking list but the wrong total, and this is the
 * only check that notices. Requires the task to state the counting boundary.
 */
function gradeCount(args, line) {
  if (line === undefined) return { passed: false, message: `no answer line — expected ${args[0]}` };
  const m = String(line).match(/-?\d+/);
  const got = m ? parseInt(m[0], 10) : NaN;
  const want = parseInt(args[0], 10);
  return { passed: got === want, message: Number.isNaN(got) ? `no number in ${JSON.stringify(line)}` : `got ${got}, want ${want}` };
}

/**
 * contains: recall over a large set — score is the fraction of required items
 * present, and extras are ignored.
 *
 * For "what are the components?" an exact set comparison is useless: the answer
 * is 78 items, one debatable entry fails the whole row, and a 0 tells you
 * nothing about whether the run found 3 or 77. Recall grades how much it
 * actually enumerated. Use `list` whenever the set is small and its boundary is
 * unambiguous — this is the fallback, not the default.
 */
function gradeContains(args, line) {
  if (line === undefined) return [{ name: "contains", passed: false, message: `no answer line — expected ${args.length} item(s)` }];
  const got = new Set(line.split(/\s*[,;]\s*/).map((s) => normText(s.trim())).filter(Boolean));
  const missing = args.filter((a) => !got.has(normText(a)));
  const found = args.length - missing.length;
  // One check per item would flood the report; report recall as a single check
  // and name a sample of what was missed.
  return [{
    name: `recall ${found}/${args.length}`,
    passed: missing.length === 0,
    message: missing.length
      ? `missing ${missing.length}: ${JSON.stringify(missing.slice(0, 8))}${missing.length > 8 ? " …" : ""}`
      : `all ${args.length} present`,
    partial: found / args.length,
  }];
}

/**
 * refuse: the task is under-specified or the thing does not exist. The answer
 * must say so and, when there are competing candidates, name at least N.
 */
function gradeRefuse(args, lines) {
  const min = Number(args[0] || 0);
  const text = (lines || []).join("\n");
  // Two distinct refusals to recognise: "which one do you mean" (ambiguous) and
  // "that isn't in this file" (absent). English has many ways to say the second
  // one — "there is no Carousel" matches none of the ambiguity words.
  const said =
    /\b(ambiguous|unclear|which one|clarify|several|multiple|cannot|can'?t)\b/i.test(text) ||
    /\b(not found|no such|not present|absent|no match)\b/i.test(text) ||
    /\b(?:there (?:is|are) no|does not exist|doesn'?t exist|does not (?:have|contain)|doesn'?t (?:have|contain)|no \w+(?: \w+)? (?:component|page|style|variable|node|named|called))\b/i.test(text);
  const named = (lines || []).filter((l) => /\d+:\d+|=/.test(l)).length;
  const guessed = /#[0-9a-f]{3,8}\b/i.test(text);
  const checks = [
    { name: "refused instead of answering", passed: said && !guessed, message: guessed ? "answer contains a hex colour — it guessed" : said ? "refusal stated" : `no refusal in: ${text.slice(0, 120)}` },
  ];
  if (min > 0) checks.push({ name: `named >=${min} candidates`, passed: named >= min, message: `${named} candidate line(s)` });
  return checks;
}

// ── main ──────────────────────────────────────────────────────────────────

if (!ROW_ID) emit(0, "ROW_ID is required", [{ name: "config", passed: false, message: "env unset" }]);

let rw;
try {
  rw = rowById(ROW_ID);
} catch (e) {
  emit(0, "cannot read datasets/rows.jsonl", [{ name: "config", passed: false, message: String(e.message || e) }]);
}
if (!rw) emit(0, `unknown ROW_ID "${ROW_ID}"`, [{ name: "config", passed: false, message: "not in dataset" }]);

const needsAnswerFile = rw.graders.some((g) => g.name !== "open");
const lines = answerLines();
if (needsAnswerFile && lines === null) {
  emit(0, `${ANSWER_FILE} not written`, [{ name: "answer-file-exists", passed: false, message: `expected ${ANSWER_FILE} in the workspace` }]);
}

const checks = [];
let li = 0;
for (const g of rw.graders) {
  if (g.name === "open") {
    const r = await gradeOpen(g.arguments[0]);
    checks.push({ name: `open ${g.arguments[0]}`, ...r });
  } else if (g.name === "value") {
    checks.push({ name: "value", ...gradeValue(g.arguments, (lines || [])[li++]) });
  } else if (g.name === "list") {
    checks.push({ name: "list", ...gradeList(g.arguments, (lines || [])[li++]) });
  } else if (g.name === "count") {
    checks.push({ name: "count", ...gradeCount(g.arguments, (lines || [])[li++]) });
  } else if (g.name === "contains") {
    checks.push(...gradeContains(g.arguments, (lines || [])[li++]));
  } else if (g.name === "refuse") {
    checks.push(...gradeRefuse(g.arguments, lines));
  } else {
    checks.push({ name: g.name, passed: false, message: `unknown grader "${g.name}"` });
  }
}

// `contains` carries a fractional score; every other check is binary. Summing
// partials keeps a recall check informative instead of collapsing it to 0/1.
const score = checks.reduce((a, c) => a + (c.partial ?? (c.passed ? 1 : 0)), 0) / checks.length;
const passed = checks.filter((c) => c.passed).length;
emit(
  score,
  checks.some((c) => c.partial !== undefined && !c.passed)
    ? `partial: ${(score * 100).toFixed(0)}%`
    : `${passed}/${checks.length} check(s) passed`,
  checks.map(({ partial, ...c }) => c),
);
