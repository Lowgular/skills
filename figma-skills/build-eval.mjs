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
 *
 * The start state is a GUARANTEE, not a hope — the skill returns the browser to
 * the file's opening view on the first operation of each trial (maybeReset in
 * figma.mjs, armed by FIGMA_RESET_ON_CONNECT in the box). So the preamble can
 * state it flatly, and no row has to carry a context line about where the
 * browser happens to be.
 */
const PREAMBLE = [
  "A dedicated Chrome is already running and logged in to Figma, with remote",
  "debugging on http://localhost:9333. The Figma design file is open at its",
  "first page with nothing selected.",
  "",
  "",
].join("\n");

/** Single-quote for the shell, POSIX-correctly. */
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/** outputs key → the grader that scores it. These carry the verdict. */
const GRADERS = {
  browser: (out) => {
    const nodeId = out?.query_params?.["node-id"];
    if (!nodeId) return null;
    return { run: `EXPECTED_NODE_ID=${nodeId} node graders/browser-state.mjs`, weight: 1.0 };
  },

  /**
   * `outputs.trajectory` — the row says which steps it expects and whether
   * their order matters. Passed through verbatim; the grader owns the schema.
   *
   *   {"mode": "sequence", "steps": ["skill", "figma:open:pricing card"]}
   *
   * Modes: strict | unordered | superset | subset | sequence. See the header of
   * graders/trajectory.mjs — `sequence` (expected steps in order, extras
   * allowed) is usually the one you want for a real agent.
   *
   * Weight 0 by DEFAULT even though this one has a golden and could legitimately
   * gate. Adding an expected trajectory to a row should not silently change what
   * that row's pass rate has meant historically. Set `"weight": 1` in the row
   * when you decide the path is part of the spec, not just observed.
   */
  trajectory: (out) => {
    if (!Array.isArray(out?.steps)) return null;
    // `weight` is for THIS builder, not the grader — don't ship it in the payload.
    const { weight, ...expected } = out;
    return {
      run: `node graders/trajectory.mjs --grade --expected=${shq(JSON.stringify(expected))}`,
      weight: typeof weight === "number" ? weight : 0,
    };
  },

  /**
   * `outputs.answer` — rows whose answer is prose rather than a browser state.
   *
   *   {"field":"Variant","mode":"exact",
   *    "required":["Stroke","Brand"],"forbidden":["Desktop","Mobile"],
   *    "optional":["Pricing Card"]}
   *
   * `field` is the PROPERTY the terms are values of, not a loose category.
   * "variants" failed in testing: Desktop and Mobile genuinely are variant
   * values (of Device), so the extractor classified them as such and the ideal
   * answer scored 0. Naming the property makes the question answerable.
   *
   * Weight 1 — for these rows this IS the verdict. Note the answer key lands in
   * tests/test.sh inside the agent's own cwd, so pair it with a weighted
   * `trajectory` so a row cannot be passed by reading the grader.
   */
  answer: (out) => {
    if (!Array.isArray(out?.required) || !out.required.length) return null;
    const { weight, ...spec } = out;
    return {
      run: `node graders/score-answer.mjs --spec=${shq(JSON.stringify(spec))}`,
      weight: typeof weight === "number" ? weight : 1.0,
    };
  },
};

/**
 * Graders that run on EVERY row, at weight 0.
 *
 * Same reasoning as PREAMBLE: this asks something true of every row, so it does
 * not belong in `outputs` — N copies of a constant discriminate between nothing.
 *
 * Weight 0 is deliberate and load-bearing. Trajectory answers "did it go through
 * the skill", which is a different question from "did it get the right answer".
 * Using the skill is PREFERRED, not required — an agent that solves the task its
 * own way still solved the task — so folding this into the reward would turn a
 * style preference into a failure. skillgrade divides by total weight
 * (evalRunner.js:220), so a 0 touches neither numerator nor denominator while
 * the full result still lands in grader_results.
 *
 * It is here because the opposite mistake is expensive: a 109-row run once
 * scored 98.2% against a skill it never invoked, because writing a CDP client
 * by hand reaches the same end state that browser-state.mjs checks.
 */
const ALWAYS = [{ run: "node graders/trajectory.mjs --grade", weight: 0 }];

/**
 * A row that supplies its own expected trajectory gets the reference-BASED
 * grader instead of the reference-free one — same script, and running both
 * would report two different numbers for the same word.
 */
const supersededBy = { trajectory: "node graders/trajectory.mjs --grade" };

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
  const keys = Object.keys(e.outputs || {});
  const derived = keys.map((k) => (GRADERS[k] ? GRADERS[k](e.outputs[k]) : null)).filter(Boolean);
  const dropped = new Set(keys.map((k) => supersededBy[k]).filter(Boolean));
  const always = ALWAYS.filter((g) => !dropped.has(g.run));
  // Only weighted graders decide anything; the rest report.
  const scoring = derived.filter((g) => g.weight > 0);
  return { e, cap, name: `${cap}-${String(e.id).slice(0, 8)}`, scoring, graders: [...derived, ...always] };
});

/**
 * Every row needs at least one WEIGHTED grader.
 *
 * Weight is what makes a grader decide anything: skillgrade divides by total
 * weight, so a row carrying only weight-0 graders reports a reward of 0 for a
 * task nothing actually judged. Unmapped keys and unweighted ones are the same
 * failure wearing different clothes, so they are one check.
 */
const ungraded = named.filter((r) => !r.scoring.length);
if (ungraded.length) {
  console.error(`✗ ${ungraded.length} example(s) have nothing that decides pass/fail:`);
  for (const r of ungraded) {
    const seen = r.graders.map((g) => `${g.run.match(/graders\/([\w.-]+)/)?.[1] || g.run} (w=${g.weight})`);
    console.error(`    ${r.name}`);
    console.error(`      outputs: ${Object.keys(r.e.outputs || {}).join(", ") || "(none)"}`);
    console.error(`      graders: ${seen.join(", ") || "(none)"}`);
  }
  console.error(`  Add a case to GRADERS in build-eval.mjs, fix the row's outputs, or`);
  console.error(`  give one of its graders a non-zero weight.`);
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
#                   Read it with: node graders/trajectory.mjs
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
        run: '${g.run.replaceAll("'", "''")}'
        weight: ${g.weight}`).join("\n")}`).join("\n")}
`;

writeFileSync(join(HERE, "eval.yaml"), yaml);
console.log(`✓ eval.yaml — ${rows.length} task(s) × ${trials} trial(s) from "${NAME}"${sel ? `   (${sel})` : ""}`);
for (const r of named) console.log(`   ${r.name.padEnd(22)} ${r.scoring.length} scoring + ${r.graders.length - r.scoring.length} reporting`);
