/**
 * score-extract.mjs — grade a MARKDOWN answer against a JSON golden.
 *
 * The row's answer is data — a list of styles, a token and its hex, a
 * component's variant axis — but the agent should be free to write prose. So:
 *
 *   EXTRACT   a model transcribes the prose into the golden's SHAPE.
 *   DIFF      score-json.mjs's compare() does the arithmetic. No model.
 *
 * ── Why not score-answer.mjs ────────────────────────────────────────────────
 *
 * That grader asks a JUDGEMENT, once per term: "is `DS_PZU_Gradient` a
 * colour-style-that-is-not-a-solid-colour?" Three costs followed from it:
 *
 *   - the question had to be phrased by hand per row. Measured on one fixed
 *     answer: field "Type" scored 0.00, field "value of the Button component's
 *     Type property" scored 1.00.
 *   - `forbidden` punished rigour. An answer that named the right variant axis
 *     and then tabulated the others to show its working had those attributed to
 *     the answer: 1.00 terse, 0.00 thorough, three runs each.
 *   - it flipped on identical input. Measured 0.00/1.00/1.00/0.00/1.00 over
 *     five runs of the same text — 40% wrong, which is indistinguishable from
 *     a genuinely wrong agent.
 *
 * This grader asks a TRANSCRIPTION instead: "read this and emit
 * [{name, value}]". Mechanical, schema-directed, and — the part that matters —
 * the model never sees the expected values, so it cannot be led by them. The
 * only thing it is told is the shape, which is the row's contract anyway.
 *
 * ── The golden is unchanged ─────────────────────────────────────────────────
 *
 * Same {expect, at, by} spec score-json.mjs takes, so a row can move between
 * the two graders without touching its golden. Use score-json.mjs when the
 * instruction demands a JSON block; use this one when the answer is prose.
 *
 * Registered as `type: deterministic`, because from skillgrade's side it is: a
 * command that prints {score, details, checks}.
 */
import { spawnSync } from "node:child_process";
import { compare, extractJson } from "./score-json.mjs";
import { tableToObjects } from "./table.mjs";
import { pullTranscript } from "./trajectory.mjs";

/**
 * Sonnet, for the reason score-answer.mjs uses it: extraction runs once per
 * graded row so the tier costs little, and a grader that disagrees with itself
 * costs the whole dataset.
 */
const MODEL = process.env.SCORE_EXTRACT_MODEL || "claude-sonnet-5";

const argOf = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : null;
};

const out = (score, details, checks = []) => {
  console.log(JSON.stringify({ score, details, checks }));
  process.exit(0);
};
const misconfigured = (msg) => out(0, `grader misconfigured: ${msg}`);

/**
 * The golden's shape, with every value replaced by its type.
 *
 * Field NAMES are the contract and have to be given; field VALUES are the
 * answer and must not be. `[{name:"Body/xs R",fontSize:12}]` becomes
 * `[{"name":"string","fontSize":"number"}]` — enough to direct the
 * transcription, nothing to copy from.
 */
export function schemaOf(golden) {
  if (Array.isArray(golden)) {
    if (!golden.length) return ["string"];
    // MERGE the entries, do not sample the first. A golden whose first entry
    // has `options: null` and whose later ones have `options: [...]` typed the
    // field as a string, so the extractor produced "Light · Navy · Dark" and
    // every entry failed the diff.
    if (golden.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const merged = {};
      for (const entry of golden) {
        for (const [k, v] of Object.entries(entry)) {
          if (v === null) continue;                 // null carries no type
          const t = schemaOf(v);
          if (merged[k] === undefined) { merged[k] = t; continue; }
          // Types conflict across entries — one property defaults to true, the
          // next to "Light". Fall back to the permissive one: same() coerces
          // "true" to true and "12" to 12, so a string never loses a match.
          if (JSON.stringify(merged[k]) !== JSON.stringify(t)) merged[k] = "string";
        }
      }
      // A key that is null in every entry is still part of the shape.
      for (const entry of golden) for (const k of Object.keys(entry)) merged[k] ??= "string";
      return [merged];
    }
    return [schemaOf(golden[0])];
  }
  if (golden && typeof golden === "object") {
    return Object.fromEntries(Object.entries(golden).map(([k, v]) => [k, schemaOf(v)]));
  }
  if (Array.isArray(golden)) return ["string"];
  return typeof golden === "number" ? "number" : typeof golden === "boolean" ? "boolean" : "string";
}

function buildPrompt(answer, schema, question) {
  return `You are transcribing an answer into JSON. You are NOT judging it.

Someone was asked:

"""
${question || "(not supplied)"}
"""

Below is their answer. Report ONLY what their answer offers as the response to
that question, as JSON in exactly this shape:

${JSON.stringify(schema, null, 2)}

Rules:
  - Use EXACTLY these keys. Never invent a key, never rename one, never flatten
    a list into one object per row of a table.
  - Include only entries the answer puts forward AS the answer. An entry the
    answer mentions and then rules out ("these are still solid", "not a
    gradient") is excluded. Asides, sources, counts and cross-references are
    excluded.
  - List each distinct entry once. If the answer repeats one across several
    rows of a table, it is still one entry.
  - Transcribe verbatim: do not correct, complete or infer. If the answer is
    wrong, transcribe it wrong — that is the point, and correcting it destroys
    the measurement.
  - Keep names exactly as written, including case, spaces and slashes. Strip
    only presentation: backticks, asterisks, table pipes, and quotes the answer
    wrapped around a value.
  - Where the shape asks for a list, emit a list — split whatever separator the
    answer used (commas, slashes, middots, "or", separate table rows).
  - Each field holds ONE value and nothing else. Answers decorate values with
    glosses, units and qualifiers — "GRADIENT_LINEAR — a linear gradient",
    "#bedce8 at opacity 0.3", "16 (1rem)", "Bold (700)". Report only the value:
    GRADIENT_LINEAR, #bedce8, 16, Bold. Drop the decoration, never the value,
    and never substitute the decoration FOR the value.
  - A value the answer does not give is null. Never guess one.

Answer:
"""
${answer}
"""

Respond with ONLY the JSON, no prose and no code fence.`;
}

function transcribe(answer, schema, question) {
  const r = spawnSync("claude", ["-p", buildPrompt(answer, schema, question), "--model", MODEL], {
    encoding: "utf8",
    // NOT the trial workspace: `claude` names its transcript after the cwd, and
    // from the workspace this would land beside the agent's own session and,
    // being newer, become the one trajectory.mjs reads. See score-answer.mjs.
    cwd: "/tmp",
    // One trace per graded row would double the run count with runs that graded
    // rather than ran. The agent's trace is the evidence; the grader's is noise.
    env: { ...process.env, TRACE_TO_LANGSMITH: "false" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error) return { error: `claude failed to run: ${r.error.message}` };
  if (r.status !== 0) return { error: `claude exited ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}` };

  // The model is told "no code fence" and mostly obeys; extractJson copes when
  // it does not, and takes the last balanced JSON so a preamble is harmless.
  const parsed = extractJson(r.stdout);
  if (parsed.error) return { error: `extractor returned no JSON: ${(r.stdout || "").trim().slice(0, 160)}` };
  return { value: parsed.value };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
//   --spec='{"expect":[...],"at":"$root","by":"name","question":"..."}'
//                    the golden (required). `question` is optional but strongly
//                    recommended: without it the extractor cannot tell an aside
//                    from an answer.
//   --question='...' the question, if not carried in the spec
//   --answer='...'   grade a literal answer instead of the transcript's last
//                    message — how this is tested with no browser.
if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = argOf("spec");
  if (!raw) misconfigured("--spec is required");
  let spec;
  try { spec = JSON.parse(raw); } catch (e) { misconfigured(`--spec is not JSON (${e.message})`); }
  if (spec.expect === undefined || spec.expect === null) {
    misconfigured("--spec has no `expect` — this row has no golden and must not be run");
  }

  const answer = argOf("answer") ?? finalAnswer(pullTranscript());
  if (!answer || !answer.trim()) out(0, "the agent said nothing");

  /**
   * A markdown table is already structured, so parse it rather than asking a
   * model to re-type it. Rows are entries, columns are fields; the only thing
   * taken from the golden is its field NAMES, which the model is told anyway.
   *
   * This is not an optimisation, it is a correctness fix: the same 61-row answer
   * scored 57/61 then 61/61 through the model, because it stripped four glosses
   * one time and not the other. Parsed, it is 61/61 every time.
   */
  let actual = null;
  let via = "table";
  const golden = spec.expect;
  const proto = Array.isArray(golden) ? golden.find((x) => x && typeof x === "object") : null;
  if (proto) {
    const fields = [...new Set(golden.flatMap((x) => Object.keys(x || {})))];
    const listFields = fields.filter((f) => golden.some((x) => Array.isArray(x?.[f])));
    actual = tableToObjects(answer, fields, listFields);
  }

  // No table, or headers that do not map onto every field: ask the model. The
  // row's own question goes with it, so it can tell an aside from an answer —
  // without it, one answer became 21 invented keys.
  if (!actual) {
    via = "model";
    const t = transcribe(answer, schemaOf(spec.expect), spec.question || argOf("question"));
    if (t.error) misconfigured(t.error);
    actual = t.value;
  }

  // `at` digs into the transcription the same way score-json.mjs digs into a
  // JSON answer, so a golden written for one grader works in the other.
  const at = spec.at && spec.at !== "$root" ? spec.at : null;
  if (at) {
    if (!actual || typeof actual !== "object" || !(at in actual)) {
      out(0, `transcription has no "${at}" key`, [{ name: at, passed: false, message: `keys: ${Object.keys(actual || {}).join(", ") || "(none)"}` }]);
    }
    actual = actual[at];
  }

  const r = compare(spec.expect, actual, spec.by || null);
  out(r.score, `${r.details}  [${via}]`, r.checks);
}

/** The agent's last assistant message, from its own session transcript. */
function finalAnswer(jsonl) {
  let last = "";
  for (const line of (jsonl || "").trim().split("\n")) {
    let l; try { l = JSON.parse(line); } catch { continue; }
    if (l.type !== "assistant" && l.message?.role !== "assistant") continue;
    for (const b of Array.isArray(l.message?.content) ? l.message.content : []) {
      if (b.type === "text" && b.text?.trim()) last = b.text.trim();
    }
  }
  return last;
}
