/**
 * score-json.mjs — grade an answer that IS data, by diffing it against a golden.
 *
 * No model anywhere in this file. score-answer.mjs has to ask an LLM what a
 * sentence claims, because prose has no schema; a row that asks for JSON has
 * one, so the whole judgement is a comparison and the same input always gives
 * the same number.
 *
 * That difference is not academic. Measured on one real answer, repeated runs of
 * the SAME text through the LLM extractor: haiku ~15/19, sonnet 13/14. When it
 * flips it flips wholesale, so a correct answer scores 0 and looks exactly like a
 * wrong agent. Across a 25-row suite that is a different pass rate every run.
 * Here, re-running cannot change the number.
 *
 * ── Spec ────────────────────────────────────────────────────────────────────
 *
 *   --spec='{"expect": <golden>, "at": "$root", "by": "name"}'
 *
 *   expect  what a correct answer contains
 *   at      where to look in the agent's JSON. "$root" is the whole thing; a
 *           key name digs in, so a row whose golden is {count, styles} can grade
 *           the styles and ignore the count.
 *   by      for arrays of objects, the field that IDENTIFIES an entry. Entries
 *           are paired on it and then compared field by field, so a reordered
 *           answer is not wrong and a renamed one is.
 *
 * ── Scoring ─────────────────────────────────────────────────────────────────
 *
 *   score = correct / (expected + extra)
 *
 * Jaccard rather than plain recall, because both halves are real failures and
 * only counting one of them invites the other. Recall alone would let an agent
 * dump every style in the file and score 1 on a question about Body; precision
 * alone would reward answering with one entry it was sure of.
 *
 * It also gives the paging failure the number it deserves: an agent that stops
 * at the first page of 103 styles returns 40 correct and scores 0.39, which
 * fails, rather than the 1.0 an "everything you listed was right" grader would
 * hand it.
 *
 * A whole-answer failure — not JSON at all, or nothing at `at` — is 0 with a
 * reason, never a crash. But note the asymmetry with a broken SPEC: that is
 * reported as `grader misconfigured`, because an eval bug must never be
 * readable as a failing agent.
 *
 * ── What counts as equal ────────────────────────────────────────────────────
 *
 * Deliberately strict, with three exceptions that are noise rather than
 * disagreement:
 *
 *   numbers   within 0.011 — letter spacing is published to two decimals and
 *             the Plugin API returns 0.10000000149011612 for 0.1. A grader that
 *             failed on that would be measuring float representation.
 *   hex       case-insensitive. #0074B8 and #0074b8 are one colour.
 *   strings   trimmed, otherwise exact. Case IS significant elsewhere: these
 *             rows exist to check that a design system's own names come back
 *             verbatim, and "semibold" for "SemiBold" is the failure, not a
 *             rounding difference.
 */
import { readFileSync } from "node:fs";
import { pullTranscript } from "./trajectory.mjs";

const emit = (score, details, checks = []) => {
  console.log(JSON.stringify({ score, details, checks }));
  process.exit(0);
};
/** A broken grader must never read as a failing agent. */
const misconfigured = (why) => emit(0, `grader misconfigured: ${why}`, []);

const argOf = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : null;
};

// ── equality ────────────────────────────────────────────────────────────────

const EPSILON = 0.011;
const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);

export function same(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= EPSILON;
  // The API reports numbers; an agent may hand them back as strings.
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b))) {
    return Math.abs(a - Number(b)) <= EPSILON;
  }
  if (typeof b === "number" && typeof a === "string") return same(b, a);
  // Same reason as numbers: the API reports a boolean, prose hands back "true".
  if (typeof a === "boolean" && typeof b === "string") return String(a) === b.trim().toLowerCase();
  if (typeof b === "boolean" && typeof a === "string") return same(b, a);
  if (isHex(a) && isHex(b)) return a.toLowerCase() === b.toLowerCase();
  /**
   * A hex golden against a decorated actual: "#bedce8 at opacity 0.3".
   *
   * The golden grades the colour and says nothing about opacity, so the
   * qualifier is not a competing claim. Requiring exactly ONE hex in the string
   * keeps this from matching a list — "#bedce8 or #ffffff" stays wrong.
   *
   * The extractor is also told to strip glosses, but on a 61-entry answer it
   * complied only some of the time (57/61 then 61/61 on identical input), so
   * this is the deterministic half of that fix.
   */
  if (isHex(a) && typeof b === "string") {
    const found = b.match(/#[0-9a-f]{3,8}\b/gi);
    if (found && found.length === 1) return a.toLowerCase() === found[0].toLowerCase();
  }
  if (isHex(b) && typeof a === "string") return same(b, a);
  if (typeof a === "string" && typeof b === "string") {
    if (a.trim() === b.trim()) return true;
    /**
     * ALL-CAPS golden values are API enum constants — BOOLEAN, VARIANT,
     * GRADIENT_LINEAR, DROP_SHADOW — and prose renders them naturally
     * ("Boolean", "Variant"). Compare those case-insensitively.
     *
     * Deliberately narrow. Style names, font weights and token names are not
     * all-caps, so "Semi Bold" still does not match "semi bold" and the file
     * remains the authority on its own spelling.
     */
    const enumish = (x) => /^[A-Z][A-Z0-9_]*$/.test(x.trim());
    if (enumish(a) || enumish(b)) return a.trim().toUpperCase() === b.trim().toUpperCase();
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // Order-insensitive: a list of allowed values is a set.
    if (a.length !== b.length) return false;
    const pool = [...b];
    return a.every((x) => {
      const i = pool.findIndex((y) => same(x, y));
      return i !== -1 && (pool.splice(i, 1), true);
    });
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.every((k) => same(a[k], b[k]));
  }
  return false;
}

// ── the agent's JSON ────────────────────────────────────────────────────────

/** The last thing the agent said. skillgrade hands graders the session log and
 *  then ignores it (`_sessionLog`), so fetch it ourselves. */
function finalAnswer(jsonl) {
  let last = "";
  for (const line of jsonl.trim().split("\n")) {
    let l; try { l = JSON.parse(line); } catch { continue; }
    if (l.type !== "assistant" && l.message?.role !== "assistant") continue;
    for (const b of Array.isArray(l.message?.content) ? l.message.content : []) {
      if (b.type === "text" && b.text?.trim()) last = b.text.trim();
    }
  }
  return last;
}

/**
 * Pull JSON out of an answer that was asked for JSON only.
 *
 * Every row says "no prose and no code fence", and models fence anyway, so
 * refusing a fenced answer would grade instruction-following in a row about
 * design tokens. Fences are stripped; the LAST balanced array or object wins,
 * because a model that reasons first and answers last would otherwise be graded
 * on its worked example.
 */
export function extractJson(text) {
  if (!text) return { error: "the agent said nothing" };
  const clean = String(text).replace(/```(?:json)?/gi, "");
  const candidates = [];
  for (let i = 0; i < clean.length; i++) {
    const open = clean[i];
    if (open !== "[" && open !== "{") continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < clean.length; j++) {
      const c = clean[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { candidates.push(JSON.parse(clean.slice(i, j + 1))); } catch { /* not JSON */ }
        i = j;
        break;
      }
    }
  }
  if (!candidates.length) return { error: "no JSON found in the answer" };
  return { value: candidates[candidates.length - 1] };
}

// ── compare ─────────────────────────────────────────────────────────────────

const label = (entry, by) =>
  entry && typeof entry === "object" ? String(entry[by] ?? JSON.stringify(entry)) : String(entry);

/**
 * Pure. Returns { score, details, checks } for a golden and an actual.
 *
 * Three shapes, because that is what the rows actually contain: a list of
 * scalars, a list of objects keyed by a field, and a single object.
 */
export function compare(expect, actual, by) {
  // ── list of objects, paired on `by` ──────────────────────────────────────
  if (Array.isArray(expect) && expect.length && typeof expect[0] === "object" && by) {
    if (!Array.isArray(actual)) {
      return { score: 0, details: `expected a JSON array of ${expect.length}, got ${typeof actual}`, checks: [] };
    }
    const pool = [...actual];
    const checks = [];
    let correct = 0;
    for (const want of expect) {
      const key = label(want, by);
      const i = pool.findIndex((got) => got && same(got[by], want[by]));
      if (i === -1) {
        checks.push({ name: key, passed: false, message: "missing" });
        continue;
      }
      const got = pool.splice(i, 1)[0];
      // Only the fields the golden names — an answer carrying extra fields per
      // entry is more than was asked for, not wrong.
      //
      // A null in the golden means NOT APPLICABLE, not "must be null": Figma
      // reports no `options` for a BOOLEAN property, and an answer describing
      // them as "true / false" is not making a false claim. Grading those
      // failed all 8 properties of a component whose every property the agent
      // had read correctly.
      const bad = Object.keys(want).filter((k) => want[k] !== null && !same(got[k], want[k]));
      if (bad.length) {
        checks.push({
          name: key, passed: false,
          message: bad.map((k) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`).join("; "),
        });
      } else { correct++; checks.push({ name: key, passed: true, message: "ok" }); }
    }
    for (const left of pool) checks.push({ name: label(left, by), passed: false, message: "not expected" });
    const score = correct / (expect.length + pool.length);
    const missing = checks.filter((c) => c.message === "missing").length;
    const wrong = checks.filter((c) => !c.passed && c.message !== "missing" && c.message !== "not expected").length;
    return {
      score,
      details: `${correct}/${expect.length} correct` +
        (missing ? `, ${missing} missing` : "") +
        (wrong ? `, ${wrong} wrong` : "") +
        (pool.length ? `, ${pool.length} unexpected` : ""),
      checks,
    };
  }

  // ── list of scalars, as a set ────────────────────────────────────────────
  if (Array.isArray(expect)) {
    if (!Array.isArray(actual)) {
      return { score: 0, details: `expected a JSON array of ${expect.length}, got ${typeof actual}`, checks: [] };
    }
    const pool = [...actual];
    const checks = [];
    let correct = 0;
    for (const want of expect) {
      const i = pool.findIndex((got) => same(got, want));
      if (i === -1) checks.push({ name: String(want), passed: false, message: "missing" });
      else { pool.splice(i, 1); correct++; checks.push({ name: String(want), passed: true, message: "ok" }); }
    }
    for (const left of pool) checks.push({ name: String(left), passed: false, message: "not expected" });
    return {
      score: correct / (expect.length + pool.length),
      details: `${correct}/${expect.length} correct` + (pool.length ? `, ${pool.length} unexpected` : ""),
      checks,
    };
  }

  // ── single object ────────────────────────────────────────────────────────
  if (expect && typeof expect === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return { score: 0, details: `expected a JSON object, got ${Array.isArray(actual) ? "an array" : typeof actual}`, checks: [] };
    }
    const keys = Object.keys(expect);
    const checks = keys.map((k) => ({
      name: k,
      passed: same(actual[k], expect[k]),
      message: same(actual[k], expect[k])
        ? "ok" : `got ${JSON.stringify(actual[k])}, want ${JSON.stringify(expect[k])}`,
    }));
    const correct = checks.filter((c) => c.passed).length;
    return {
      score: correct / keys.length,
      details: `${correct}/${keys.length} field(s) correct` +
        (correct < keys.length ? `: ${checks.filter((c) => !c.passed).map((c) => c.name).join(", ")} wrong` : ""),
      checks,
    };
  }

  return { score: same(actual, expect) ? 1 : 0, details: same(actual, expect) ? "matches" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expect)}`, checks: [] };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
//   --spec='{"expect":[...],"at":"$root","by":"name"}'   the golden (required)
//   --answer='...'   grade a literal answer instead of the transcript's last
//                    message — how the algebra is tested with no browser.
if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = argOf("spec");
  if (!raw) misconfigured("--spec is required");
  let spec;
  try { spec = JSON.parse(raw); } catch (e) { misconfigured(`--spec is not JSON (${e.message})`); }
  if (spec.expect === undefined || spec.expect === null) {
    misconfigured("--spec has no `expect` — this row has no golden and must not be run");
  }

  const answer = argOf("answer") ?? finalAnswer(pullTranscript());
  const parsed = extractJson(answer);
  if (parsed.error) emit(0, parsed.error, [{ name: "valid JSON", passed: false, message: String(answer).slice(0, 200) }]);

  const at = spec.at && spec.at !== "$root" ? spec.at : null;
  let actual = parsed.value;
  if (at) {
    if (!actual || typeof actual !== "object" || !(at in actual)) {
      emit(0, `answer has no "${at}" key`, [{ name: at, passed: false, message: `keys: ${Object.keys(actual || {}).join(", ") || "(none)"}` }]);
    }
    actual = actual[at];
  }

  const out = compare(spec.expect, actual, spec.by || null);
  emit(out.score, out.details, out.checks);
}
