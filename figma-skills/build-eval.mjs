/**
 * build-eval.mjs — datasets/rows.jsonl → eval.yaml
 *
 * Every filterable column of the dataset is a flag, automatically:
 *
 *   node build-eval.mjs                          all rows
 *   node build-eval.mjs --id=open-tooltip        one row (run exactly this)
 *   node build-eval.mjs --id='var-*'             glob
 *   node build-eval.mjs --tier=easy,medium       OR within a column
 *   node build-eval.mjs --tier=easy --type=prop  AND across columns
 *   node build-eval.mjs --tags=smoke --not-tags=flaky
 *   node build-eval.mjs --form=prop.fills --limit=5
 *   node build-eval.mjs --tags=p1 --list         show the selection, write nothing
 *
 * Stratified sampling — a broad-but-cheap subset, "N of each kind":
 *
 *   node build-eval.mjs --tier=easy --sample=1   1 row per form: every question
 *                                                kind, none of the repetition
 *   node build-eval.mjs --sample=3 --per=type    3 per capability
 *   node build-eval.mjs --sample=2 --seed=7      a different draw, still fixed
 *
 * The draw is deterministic for a given seed, so a sampled suite is stable
 * across runs and a pass-rate change means the skill changed, not the rows.
 *
 * Filterable columns come from datasets/load.mjs (FILTERABLE) — add a column
 * there and it is a flag here with no change to this file. An unknown flag is a
 * hard error: a typo that silently matched everything would run all 328 rows.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. The skill is actually injected. skillgrade auto-detects skills only at
 *    <taskdir>/SKILL.md, <taskdir>/skills/*, <taskdir>/.agents/skills/*,
 *    <taskdir>/.claude/skills/*  (core/skills.js). `figma-browser/` is none of
 *    those, so without the explicit `skill:` key NOTHING is injected and every
 *    run silently measures a bare agent. Comment it out for a RED baseline.
 *
 * 2. No expected value reaches the agent. skillgrade writes each grader's `run:`
 *    line verbatim into <workspace>/tests/test.sh, and the workspace is the
 *    agent's cwd. So graders get ROW_ID only, and are invoked by ABSOLUTE path
 *    so they can read the dataset from outside the workspace. (An absolute path
 *    also stops prepareTempTaskDir copying graders/ in, since it only copies the
 *    first path segment of a relative reference.)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRows, parseFilters, selectRows, sampleRows, tally, FILTERABLE } from "./datasets/load.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRADER = join(HERE, "graders", "grade.mjs");
const argv = process.argv.slice(2);

/** Flags that are NOT column filters. Everything else is one. */
const RESERVED = ["list", "limit", "trials", "out", "help", "sample", "per", "seed"];
const flag = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=").slice(1).join("=") || null;
const has = (n) => argv.includes(`--${n}`);

if (has("help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*|^ \* ?/gm, ""));
  process.exit(0);
}

/** A non-numeric count must not degrade to "no limit" — that silently runs (and
 *  bills for) the whole suite when you meant to run five rows. */
const num = (name, dflt) => {
  const raw = flag(name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`✗ --${name}=${raw} is not a positive number`);
    process.exit(1);
  }
  return n;
};

const TRIALS = num("trials", 5);
const LIMIT = num("limit", null);
const SAMPLE = num("sample", null);
const PER = flag("per") || "form";
const SEED = num("seed", 1);
const OUT = flag("out") || join(HERE, "eval.yaml");

let rows, total;
try {
  rows = loadRows();
  const filters = parseFilters(argv, RESERVED);
  rows = selectRows(rows, filters);
  total = rows.length;
  // Sample AFTER filtering, so --tier=easy --sample=1 means one per form
  // *within easy*, not one per form globally then filtered down to easy.
  if (SAMPLE !== null) rows = sampleRows(rows, { n: SAMPLE, per: PER, seed: SEED });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
if (LIMIT !== null) rows = rows.slice(0, LIMIT);

if (!rows.length) {
  console.error(`✗ no rows matched. Filterable columns: ${FILTERABLE.join(", ")}`);
  process.exit(1);
}

const PREAMBLE = (fileKey) => `A dedicated Chrome is already running and logged in to Figma, with remote
      debugging on http://localhost:9333. The Figma file "Simple Design System"
      (file key ${fileKey}) is open there.`;

const RULES = "Do not edit the file. No blind canvas clicks.";

/**
 * The answer protocol. One line of answer.txt per question asked, nothing else —
 * no JSON, no prose, no units the question did not ask for. Kept this plain so
 * that response format is never what the score measures.
 */
function protocol(row) {
  const needs = row.graders.filter((g) => g.name !== "open");
  if (!needs.length) return "";
  const g = needs[0];
  if (needs.length === 1 && g.name === "value") {
    return `
      Write ONLY the answer to answer.txt — a single line, no explanation and no
      label. If the property is not set at all, write: none`;
  }
  if (needs.length === 1 && g.name === "list") {
    return `
      Write ONLY the answer to answer.txt — a single line, the items separated by
      commas, no explanation. Order does not matter.`;
  }
  if (needs.length === 1 && g.name === "refuse") {
    return `
      If this question has one unambiguous answer, write it to answer.txt.
      If it does NOT — several different nodes could be meant, or the thing does
      not exist in this file — say so on the first line of answer.txt and then
      list the candidates you found, one per line, each with its node id.
      Do not pick one and present it as the answer.`;
  }
  return `
      Write your answers to answer.txt — one line per question asked, in the
      order asked, nothing else.`;
}

/* ── --list: what would run, and roughly what it costs ─────────────────── */

/** Mean $/trial from whatever the trace index has logged. Honest about n. */
function costHint(nRows) {
  const idx = join(HERE, "runs", "index.ndjson");
  if (!existsSync(idx)) return null;
  const costs = readFileSync(idx, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l).cost_usd; } catch { return null; } })
    .filter((c) => typeof c === "number");
  if (!costs.length) return null;
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  return `  est. $${(mean * nRows * TRIALS).toFixed(2)} for ${nRows}×${TRIALS} trials (mean $${mean.toFixed(3)}/trial over ${costs.length} logged)`;
}

if (has("list")) {
  const drawn = SAMPLE !== null ? `  (${SAMPLE} per ${PER}, seed ${SEED}, from ${total} matching)` : "";
  console.log(`\n  ${rows.length} row(s) selected${drawn}\n`);
  for (const col of ["tier", "type", "form", "tags"]) {
    const t = tally(rows, col);
    if (t.length <= 1 && col !== "tier") continue;
    console.log(`  by ${col}`);
    for (const [v, n] of t) console.log(`    ${String(n).padStart(4)}  ${v}`);
    console.log();
  }
  if (rows.length <= 25) for (const r of rows) console.log(`    ${r.id}`);
  const hint = costHint(rows.length);
  if (hint) console.log(`\n${hint}`);
  console.log();
  process.exit(0);
}

/* ── write eval.yaml ───────────────────────────────────────────────────── */

const tasks = rows.map(
  (row) => `  - name: ${row.tier}--${row.id}
    instruction: |
      ${PREAMBLE(row.file_key)}

      ${row.task}
${protocol(row)}
      ${RULES}
    graders:
      - type: deterministic
        run: TIER=${row.tier} ROW_ID=${row.id} node ${GRADER}
        weight: 1.0`,
);

const yaml = `# GENERATED by build-eval.mjs from datasets/rows.jsonl — do not edit by hand.
# Edit the dataset (or gen.mjs), then: node build-eval.mjs [filters]
#
# Selection: ${argv.length ? argv.join(" ") : "(all rows)"}
# Rows: ${rows.length}${SAMPLE !== null ? ` — ${SAMPLE} per ${PER}, seed ${SEED}, drawn from ${total} matching` : ""}
#
# Always run: --provider=local --parallel=1
#   local    the browser is on the host
#   serial   the prompt is staged at the fixed path /tmp/.prompt.md, so
#            concurrent trials overwrite each other. (Also: one Chrome, and
#            \`open\` mutates the current page globally.)
#
# We use the \`command\` agent, not \`claude\`. The built-in claude adapter hardcodes
# plain \`claude -p\`, whose only output is final text — no tool calls, no real
# token counts, so "did it actually use the skill?" is unanswerable.
#
# The command is our own supervisor script rather than a \`claude -p …\` string,
# because a script can do four things a config string cannot: stream the trace
# while the trial runs, keep 320KB of NDJSON out of the results JSON, stamp one
# trace id that joins results ↔ trace ↔ Claude's own transcript, and enforce a
# tool denylist (DENY_TOOLS). See harness/run-claude.mjs.
#
# The grader reads the row by ROW_ID alone. TIER is still on the \`run:\` line
# because harness/run-claude.mjs reconstructs the task name from those two env
# vars — it is a label for the harness, not an input to grading. Neither this
# file nor any expected value reaches the agent.

version: "1"

# REQUIRED — without it skillgrade injects no skill and measures a bare agent.
skill: figma-browser

defaults:
  agent: command
  command: "node ${join(HERE, "harness", "run-claude.mjs")}"
  provider: local
  trials: ${TRIALS}
  timeout: 300
  threshold: 0.6

tasks:
${tasks.join("\n\n")}
`;

writeFileSync(OUT, yaml);
const facets = ["tier", "type"]
  .map((c) => `${c}: ${tally(rows, c).map(([v, n]) => `${v} ${n}`).join(", ")}`)
  .join("   |   ");
console.log(`wrote eval.yaml — ${rows.length} task(s), ${TRIALS} trials\n  ${facets}`);
