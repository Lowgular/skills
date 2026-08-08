/**
 * score-answer.mjs — grade what the agent SAID, for rows whose answer is prose.
 *
 * Two halves, deliberately separable:
 *
 *   EXTRACT   an LLM turns the agent's prose into a structure. This is the only
 *             part that needs a model, and it never scores anything.
 *   SCORE     plain code compares that structure to the row's golden. No model,
 *             no network, same input always gives the same number.
 *
 * skillgrade's own `llm_rubric` cannot do this. It sends rubric + transcript in
 * one HTTP call and keeps only {score, reasoning} — every other key the model
 * returns is discarded (graders/index.js:327). So the judge both extracts and
 * decides, in prose, unauditably. Here the model only ever answers "what does
 * this text claim?", and the arithmetic is ours.
 *
 * Registered as `type: deterministic`, because from skillgrade's side it is:
 * a command that prints {score, details, checks}.
 *
 * ── The extractor is blind ──────────────────────────────────────────────────
 *
 * It is handed the vocabulary — the union of required, forbidden and optional,
 * sorted alphabetically so position cannot encode category — and never learns
 * which is which. A judge shown the golden tends to agree with it.
 *
 * It also never sees the QUESTION, only the answer text. Asked "what does this
 * claim", a model reports; asked "is this right", it starts helping. The prompt
 * says so explicitly, and temperature is whatever `claude -p` defaults to with
 * a task this mechanical.
 *
 * What this cannot hide is the vocabulary itself, and what it cannot survive is
 * a synonym: an answer saying "Outlined" where the row says "Stroke" scores 0.
 * That is deliberate — these rows exist to check the design system's own words.
 *
 * ── Three buckets, because forbidden and optional differ ────────────────────
 *
 *   required   must be classified as the field        (Stroke, Brand)
 *   forbidden  must NOT be the field; elsewhere is fine (Desktop, Mobile —
 *              a designer may mention devices, just not AS the variants)
 *   optional   mentioned anywhere at all; bonus only  (Pricing Card)
 *
 * ── Why the extractor runs in /tmp ──────────────────────────────────────────
 *
 * It shells out to `claude`, which writes a session transcript named after its
 * cwd. Run from the trial workspace it would land in the SAME project directory
 * as the agent's own session and, being newer, would be the one
 * graders/trajectory.mjs reads. The grader would end up scoring itself.
 */
import { spawnSync } from "node:child_process";
import { pullTranscript } from "./trajectory.mjs";

/**
 * Sonnet, not Haiku. Measured on one real answer, repeated runs of the SAME
 * text: haiku ~15/19, sonnet 13/14, opus 6/6. Haiku's failures are wholesale —
 * every required term flips to "other" at once, so a correct answer scores 0
 * rather than losing a point. That is the worst possible shape for a grader:
 * indistinguishable from a genuinely wrong agent.
 *
 * Extraction runs once per graded row, so the tier costs little; a grader that
 * disagrees with itself costs the whole dataset.
 */
const MODEL = process.env.SCORE_ANSWER_MODEL || "claude-sonnet-5";

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

// ── the golden ──────────────────────────────────────────────────────────────

const rawSpec = argOf("spec");
if (!rawSpec) misconfigured("--spec is required");
let spec;
try { spec = JSON.parse(rawSpec); } catch (e) { misconfigured(`--spec is not JSON (${e.message})`); }

const FIELD = spec.field || "variants";
const MODE = spec.mode || "contains";
const required = spec.required || [];
const forbidden = spec.forbidden || [];
const optional = spec.optional || [];
if (!required.length) misconfigured("--spec has no required terms");
if (!["exact", "contains"].includes(MODE)) misconfigured(`unknown mode "${MODE}" — exact | contains`);

/** Sorted so the extractor cannot read category off the order. */
const VOCAB = [...new Set([...required, ...forbidden, ...optional])].sort((a, b) => a.localeCompare(b));

// ── the answer ──────────────────────────────────────────────────────────────

/** The last thing the agent said. skillgrade hands deterministic graders the
 *  session log and then ignores it (`_sessionLog`), so we fetch it ourselves. */
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

function buildPrompt(answer) {
  return `You are extracting claims from text. You are NOT judging correctness.

Below is an answer someone gave about a Figma component. For each term in the
list, report how THE ANSWER uses it — not how you believe it should be used.

Terms: ${VOCAB.join(", ")}

For each term choose exactly one:
  "${FIELD}" — the answer presents it as a value of "${FIELD}"
  "other"    — the answer mentions it, but as something else (a value of a
               different property, a component name, an aside)
  "absent"   — the answer does not mention it

Also list, under "extra", any OTHER value the answer presents as a value of
"${FIELD}" that is not in the term list above.

If the answer is wrong, report it as wrong. Do not correct it. Do not infer.

Answer:
"""
${answer}
"""

Respond with ONLY a JSON object, no prose and no code fence:
{"terms": {${VOCAB.map((t) => `"${t}": "..."`).join(", ")}}, "extra": []}`;
}

function extract(answer) {
  const r = spawnSync("claude", ["-p", buildPrompt(answer), "--model", MODEL], {
    encoding: "utf8",
    // NOT the trial workspace — see the header.
    cwd: "/tmp",
    /**
     * The extractor must not trace. The box enables the LangSmith plugin for
     * every `claude` process, and this is a `claude` process — left alone it
     * would post one trace per graded row into the project you go to when a
     * trial looks wrong, doubling the run count with runs that graded rather
     * than ran. The agent's trace is the evidence; the grader's is noise.
     */
    env: { ...process.env, TRACE_TO_LANGSMITH: "false" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error) return { error: `claude failed to run: ${r.error.message}` };
  if (r.status !== 0) return { error: `claude exited ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}` };
  const text = (r.stdout || "").replace(/```(?:json)?/g, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: `extractor returned no JSON: ${text.slice(0, 200)}` };
  try { return { found: JSON.parse(m[0]) }; } catch (e) { return { error: `extractor JSON invalid: ${e.message}` }; }
}

// ── score ───────────────────────────────────────────────────────────────────

/**
 * Pure. Exported shape is { score, details, checks }.
 *
 *   forbidden classified as the field   → 0, hard
 *   mode=exact and the field has extras → 0, hard
 *   some required missing               → 0.5 x fraction, i.e. always below the
 *                                         0.6 threshold: partial never passes
 *   all required                        → 0.8, plus 0.2 x optional mentioned
 */
export function score(found) {
  const terms = found?.terms || {};
  const norm = (s) => String(s).trim().toLowerCase();
  const classified = (t) => norm(terms[t] ?? "absent");

  const inField = new Set(required.concat(forbidden, optional).filter((t) => classified(t) === norm(FIELD)));
  const extra = (found?.extra || []).filter(Boolean);

  const badForbidden = forbidden.filter((t) => inField.has(t));
  const surplus = [...inField].filter((t) => !required.includes(t)).concat(extra);
  const hitRequired = required.filter((t) => inField.has(t));
  const mentionedOptional = optional.filter((t) => classified(t) !== "absent");

  const checks = [
    ...required.map((t) => ({ name: `required: ${t}`, passed: inField.has(t), message: classified(t) })),
    ...forbidden.map((t) => ({ name: `not a ${FIELD}: ${t}`, passed: !inField.has(t), message: classified(t) })),
    ...optional.map((t) => ({ name: `optional: ${t}`, passed: mentionedOptional.includes(t), message: classified(t) })),
  ];
  if (extra.length) checks.push({ name: `unlisted ${FIELD}`, passed: MODE !== "exact", message: extra.join(", ") });

  if (badForbidden.length) {
    return { score: 0, details: `presented as ${FIELD} but must not be: ${badForbidden.join(", ")}`, checks };
  }
  if (MODE === "exact" && surplus.length) {
    return { score: 0, details: `mode=exact: extra ${FIELD} claimed: ${surplus.join(", ")}`, checks };
  }
  if (hitRequired.length < required.length) {
    const missing = required.filter((t) => !inField.has(t));
    return {
      score: 0.5 * (hitRequired.length / required.length),
      details: `missing ${FIELD}: ${missing.join(", ")}`,
      checks,
    };
  }
  const bonus = optional.length ? 0.2 * (mentionedOptional.length / optional.length) : 0.2;
  return {
    score: Math.min(1, 0.8 + bonus),
    details: `${FIELD} correct: ${required.join(", ")}${optional.length ? `  (optional ${mentionedOptional.length}/${optional.length})` : ""}`,
    checks,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
//   --spec='{...}'                        the golden (required)
//   --found='{"terms":{...},"extra":[]}'  skip the LLM; scores directly. This is
//                                         how the algebra is tested with no key
//                                         and no network.
//   --answer='...'                        score a literal answer instead of the
//                                         transcript's last message.
if (import.meta.url === `file://${process.argv[1]}`) {
  const rawFound = argOf("found");
  let found;

  if (rawFound) {
    try { found = JSON.parse(rawFound); } catch (e) { misconfigured(`--found is not JSON (${e.message})`); }
  } else {
    const answer = argOf("answer") ?? finalAnswer(pullTranscript());
    if (!answer) misconfigured("no answer found — the transcript has no assistant text");
    const r = extract(answer);
    if (r.error) misconfigured(r.error);
    found = r.found;
  }

  const out = score(found);
  // The extraction rides along in checks: if scores move between runs, this is
  // how you tell whether the AGENT changed or the EXTRACTOR did.
  out.checks.push({ name: "extraction", passed: true, message: JSON.stringify(found) });
  emit(out.score, out.details, out.checks);
}
