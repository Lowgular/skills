/**
 * build-eval.mjs — LangSmith → eval.yaml.
 *
 *   node build-eval.mjs                       every example
 *   node build-eval.mjs --split=smoke         one split
 *   node build-eval.mjs --capability=locate   one capability
 *   node build-eval.mjs --trials=5
 *   node build-eval.mjs --list                print the selection, write nothing
 *
 * LangSmith IS the dataset. There is no local copy in this path and no schema
 * module — `datasets/load.mjs` defined a column contract for a 328-row JSONL and
 * both are gone. An example is `inputs` / `outputs` / `metadata`, and that is
 * the whole contract.
 *
 * ── Graders come from the SHAPE of `outputs` ────────────────────────────────
 *
 * Each top-level key in `outputs` says what KIND of answer a row has, so the
 * grader follows from it. Nothing in the dataset names a script:
 *
 *   outputs.browser  →  graders/browser-state.mjs   (where the browser ended up)
 *
 * Coupled on purpose. The alternative — a `grader:` field on every example —
 * puts an implementation name in the dataset and has to be updated in N places
 * when a grader is renamed.
 *
 * Adding a capability = add a key to `outputs` and a case to GRADERS below.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./figma-browser/lib/connect.mjs"; // side effect: loads .env

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const KNOWN = ["split", "capability", "origin", "trials", "limit", "list", "dataset"];
for (const a of process.argv.slice(2)) {
  const name = a.replace(/^--/, "").split("=")[0];
  // An unknown flag that silently matched everything would run the wrong set.
  if (!KNOWN.includes(name)) {
    console.error(`unknown flag --${name}\n  known: ${KNOWN.map((k) => "--" + k).join(" ")}`);
    process.exit(1);
  }
}

/**
 * The precondition preamble, prepended to every instruction.
 *
 * It lives here rather than on the examples because it is true of every row:
 * N copies of a constant cannot discriminate between any of them.
 */
const PREAMBLE = [
  "A dedicated Chrome is already running and logged in to Figma, with remote",
  "debugging on http://localhost:9333. The Figma design file is open there.",
  "",
  "",
].join("\n");

/** outputs key → the grader command that scores it. */
const GRADERS = {
  browser: (out) => {
    const nodeId = out?.query_params?.["node-id"];
    if (!nodeId) return null;
    return `EXPECTED_NODE_ID=${nodeId} node graders/browser-state.mjs`;
  },
};

// ── fetch ───────────────────────────────────────────────────────────────────

const key = process.env.LANGSMITH_API_KEY;
const ep = (process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com").replace(/\/$/, "");
const NAME = arg("dataset", process.env.LANGSMITH_DATASET || "figma-read");

if (!key) {
  console.error("✗ LANGSMITH_API_KEY not set — add it to .env");
  process.exit(1);
}

const found = await (await fetch(`${ep}/api/v1/datasets?name=${encodeURIComponent(NAME)}`, {
  headers: { "x-api-key": key },
})).json();
const ds = Array.isArray(found) ? found[0] : null;
if (!ds) {
  console.error(`✗ no dataset named "${NAME}" on this account`);
  process.exit(1);
}

const examples = [];
for (let offset = 0; ; offset += 100) {
  const page = await (await fetch(`${ep}/api/v1/examples?dataset=${ds.id}&limit=100&offset=${offset}`, {
    headers: { "x-api-key": key },
  })).json();
  examples.push(...page);
  if (page.length < 100) break;
}

// ── select ──────────────────────────────────────────────────────────────────

const wantSplit = arg("split");
const wantCap = arg("capability");
const wantOrigin = arg("origin");
const limit = arg("limit") ? Number(arg("limit")) : null;
const trials = Number(arg("trials", "1"));

let rows = examples
  .filter((e) => !wantSplit || (e.metadata?.dataset_split || []).includes(wantSplit))
  .filter((e) => !wantCap || e.metadata?.capability === wantCap)
  .filter((e) => !wantOrigin || e.metadata?.origin === wantOrigin)
  // Stable order so eval.yaml diffs cleanly between builds.
  .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
if (limit) rows = rows.slice(0, limit);

if (!rows.length) {
  console.error("no examples matched that selection");
  process.exit(1);
}

const named = rows.map((e) => {
  const cap = e.metadata?.capability || "row";
  const graders = Object.entries(e.outputs || {})
    .map(([k, v]) => (GRADERS[k] ? GRADERS[k](v) : null))
    .filter(Boolean);
  return { e, cap, name: `${cap}-${String(e.id).slice(0, 8)}`, graders };
});

const ungraded = named.filter((r) => !r.graders.length);
if (ungraded.length) {
  // A task with no grader would report a pass for something nothing checked.
  console.error(`✗ ${ungraded.length} example(s) have no grader for their outputs keys:`);
  for (const r of ungraded) {
    console.error(`    ${r.name}   outputs: ${Object.keys(r.e.outputs || {}).join(", ") || "(none)"}`);
  }
  console.error(`  Add a case to GRADERS in build-eval.mjs, or fix the row's outputs.`);
  process.exit(1);
}

if (has("list")) {
  console.log(`${NAME}: ${rows.length} of ${examples.length} example(s)  × ${trials} trial(s)\n`);
  const by = {};
  for (const r of named) (by[r.cap] ??= []).push(r);
  for (const [cap, rs] of Object.entries(by)) {
    console.log(`  ${cap}  (${rs.length})`);
    for (const r of rs) console.log(`     ${r.name}   ${JSON.stringify(r.e.inputs?.task || "").slice(0, 52)}`);
  }
  process.exit(0);
}

// ── emit ────────────────────────────────────────────────────────────────────

const sel = [
  wantSplit && `--split=${wantSplit}`,
  wantCap && `--capability=${wantCap}`,
  wantOrigin && `--origin=${wantOrigin}`,
  limit && `--limit=${limit}`,
  `--trials=${trials}`,
].filter(Boolean).join(" ");

const indent = (text, pad) => text.trimEnd().split("\n").map((l) => pad + l).join("\n");

const yaml = `# GENERATED by build-eval.mjs from the LangSmith dataset "${NAME}".
# Do not edit — change the examples on LangSmith, then re-run:
#   node build-eval.mjs ${sel}
#
# Selection: ${sel}
# Examples:  ${rows.length}
#
# agent: claude     the built-in adapter. Plain \`claude -p\` is enough now:
#                   diagnostics come from Claude Code's own session transcript
#                   (~/.claude/projects/<cwd>/<id>.jsonl), which carries the
#                   resolved model, every tool call and real token counts.
#                   Read it with: node evals/trajectory.mjs
#
# provider: local   this runs INSIDE the eval container, so the container is the
#                   isolation — no docker-in-docker. A clean image has no
#                   ~/.claude/skills, which is precisely what makes a HOST run
#                   untrustworthy (TODO.md §0.5).
#
#   docker exec -it figma-box bash
#   skillgrade
#
# Graders are derived from each example's \`outputs\` keys rather than stored in
# the dataset — see the note at the top of build-eval.mjs.

version: "1"

# REQUIRED — without it skillgrade injects no skill and measures a bare agent.
skill: figma-browser

defaults:
  agent: claude
  provider: local
  trials: ${trials}
  timeout: 300
  threshold: 0.6

tasks:
${named.map((r) => `  - name: ${r.name}
    instruction: |
${indent(PREAMBLE + (r.e.inputs?.task || ""), "      ")}
    graders:
${r.graders.map((g) => `      - type: deterministic
        run: ${g}
        weight: 1.0`).join("\n")}`).join("\n")}
`;

writeFileSync(join(HERE, "eval.yaml"), yaml);
console.log(`✓ eval.yaml — ${rows.length} task(s) × ${trials} trial(s) from "${NAME}"${sel ? `   (${sel})` : ""}`);
for (const r of named) console.log(`   ${r.name.padEnd(22)} ${r.graders.length} grader(s)`);
