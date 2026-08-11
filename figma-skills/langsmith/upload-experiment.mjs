/**
 * upload-experiment.mjs — skillgrade results → a LangSmith experiment.
 *
 *   skillgrade && node upload-experiment.mjs
 *
 * An "experiment" in LangSmith is not a framework feature. It is three plain
 * records, and none of them need LangChain:
 *
 *   a SESSION whose reference_dataset_id is the dataset   → the grid exists
 *   RUNS carrying reference_example_id                     → the rows
 *   FEEDBACK keyed to those runs                           → the columns
 *
 * So this is raw REST, the same way build-eval.mjs reads the dataset. Nothing
 * to npm install, nothing to add to the image.
 *
 * ── Where each field comes from ─────────────────────────────────────────────
 *
 * skillgrade writes one results JSON per task under $TMPDIR/skillgrade/work.
 * That file carries the task name, per-trial reward, per-grader score, duration
 * and a session_log holding the instruction and the agent's final text. Three
 * things it does NOT carry, and how each is recovered:
 *
 *   which example      results.task is "<capability>-<first 8 of the id>", so
 *                      the id is resolved by prefix against the live dataset.
 *                      Ids are immutable, so this cannot go stale the way a
 *                      generated sidecar map could.
 *
 *   which grader       grader_results entries have {grader_type, score, weight,
 *                      details} and no name — and ours are all "deterministic".
 *                      The only link back is POSITION, so eval.yaml is read and
 *                      graders[i] matched to grader_results[i]. The feedback key
 *                      is the grader's filename: score-answer.mjs → score-answer.
 *                      Positional coupling, deliberately: adding a grader needs
 *                      no change here, but REORDERING eval.yaml's graders
 *                      without rebuilding would mislabel columns.
 *
 *   real token counts  results.input_tokens/output_tokens are skillgrade's
 *                      estimateTokens() guesses, not usage. The real numbers,
 *                      the resolved model and the session id come from the
 *                      `usage` check that graders/trajectory.mjs emits — it has
 *                      already parsed the transcript, so nothing here has to.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * LangSmith prices runs of type "llm" that carry usage_metadata. A trial is a
 * chain run, so each gets one synthetic llm child holding the totals. On a
 * subscription nothing is billed per token — the figure is what the same work
 * would cost on the API, which is the number that matters when deciding whether
 * to deploy this off-subscription.
 *
 * Cache reads dominate here (~112k against ~8 fresh input tokens on a typical
 * trial) and are an order of magnitude cheaper, so they are reported separately
 * under input_token_details. If LangSmith's price map ignores that, the cost is
 * overstated — check one run against known counts before trusting the column.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import "../figma-browser/lib/connect.mjs"; // side effect: loads .env

const HERE = dirname(fileURLToPath(import.meta.url));
// eval.yaml lives at the repo root, one level up from this folder.
const ROOT = join(HERE, "..");
const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const KNOWN = ["results", "dataset", "name", "since", "dry-run", "help"];
for (const a of process.argv.slice(2)) {
  const name = a.replace(/^--/, "").split("=")[0];
  if (!KNOWN.includes(name)) {
    console.error(`unknown flag --${name}\n  known: ${KNOWN.map((k) => "--" + k).join(" ")}`);
    process.exit(1);
  }
}
if (has("help")) {
  console.log(`upload-experiment.mjs — skillgrade results → a LangSmith experiment

  --results=DIR   skillgrade output   (default $TMPDIR/skillgrade/work/results)
  --dataset=NAME  LangSmith dataset   (default $LANGSMITH_DATASET or figma-read)
  --name=PREFIX   experiment name     (default <model>-<gitsha>)
  --since=MS      only results newer than this epoch-ms. Without it, the NEWEST
                  file per task is used — the results directory accumulates every
                  run ever, so uploading all of it would invent history.
  --dry-run       print what would be sent, touch nothing`);
  process.exit(0);
}

const KEY = process.env.LANGSMITH_API_KEY;
const EP = (process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com").replace(/\/$/, "");
const DATASET = arg("dataset", process.env.LANGSMITH_DATASET || "figma-read");
const RESULTS = arg("results", join(process.env.TMPDIR || "/tmp", "skillgrade", "work", "results"));
const SINCE = arg("since") ? Number(arg("since")) : null;
const DRY = has("dry-run");

if (!KEY) { console.error("✗ LANGSMITH_API_KEY not set — add it to .env"); process.exit(1); }
if (!existsSync(RESULTS)) { console.error(`✗ no results directory at ${RESULTS}\n  run skillgrade first, or pass --results=`); process.exit(1); }

const H = { "x-api-key": KEY, "Content-Type": "application/json" };
const api = async (path, init = {}) => {
  const r = await fetch(`${EP}${path}`, { ...init, headers: H });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || "GET"} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// ── eval.yaml: grader position → feedback key ───────────────────────────────

/**
 * Deliberately not a YAML parser. eval.yaml is generated by build-eval.mjs, so
 * its shape is known exactly, and a dependency to read our own output would be
 * absurd. Returns { taskName: ["browser-state", "trajectory"] } in file order.
 */
function readEvalYaml(yamlPath) {
  const text = readFileSync(yamlPath, "utf8");
  const keys = {};
  let task = null;
  for (const line of text.split("\n")) {
    const name = /^ {2}- name: (.+)$/.exec(line);
    if (name) { task = name[1].trim(); keys[task] = []; continue; }
    const run = /^\s+run: '(.*)'\s*$/.exec(line);
    // The grader's own filename is the column name — convention, not config.
    if (run && task) {
      const m = /graders\/([\w.-]+)\.mjs/.exec(run[1].replaceAll("''", "'"));
      keys[task].push(m ? m[1] : `grader-${keys[task].length}`);
    }
  }
  // Stamped by build-eval.mjs, which runs on the host where git exists.
  const sha = /^# git: (.+)$/m.exec(text)?.[1]?.trim() || "nogit";
  return { keys, sha };
}

// ── the results skillgrade just wrote ───────────────────────────────────────

/**
 * One file per task. Without --since we take the NEWEST per task: the directory
 * is append-only across every run, so "upload everything" would fabricate an
 * experiment out of results from different code, models and days.
 */
function latestResults() {
  const files = readdirSync(RESULTS).filter((f) => f.endsWith(".json")).map((f) => {
    const p = join(RESULTS, f);
    return { path: p, mtime: statSync(p).mtimeMs, task: f.replace(/_\d{4}-.*$/, "") };
  }).sort((a, b) => b.mtime - a.mtime);

  if (SINCE) return files.filter((f) => f.mtime >= SINCE);
  const seen = new Set();
  return files.filter((f) => (seen.has(f.task) ? false : (seen.add(f.task), true)));
}

// ── LangSmith ───────────────────────────────────────────────────────────────

/**
 * LangSmith rejects a feedback score with more than 4 decimal places — 422, and
 * because feedback is posted one call at a time, the FIRST such score aborts the
 * upload with the session and runs already created. Half an experiment.
 *
 * Our scorers produce them routinely: score-answer.mjs returns 0.8 + 0.2 × k/n,
 * so three optional terms with two mentioned is 0.9333333333333333. Rounding is
 * lossless at the precision anyone reads.
 */
const round4 = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : n);

/** dotted_order encodes parentage as <start><Z><uuid> segments joined by ".". */
const stamp = (iso) => iso.replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1000Z");
const seg = (iso, id) => `${stamp(iso)}${id}`;

const ds = (await api(`/api/v1/datasets?name=${encodeURIComponent(DATASET)}`))[0];
if (!ds) { console.error(`✗ no dataset named "${DATASET}"`); process.exit(1); }

const examples = [];
for (let offset = 0; ; offset += 100) {
  const page = await api(`/api/v1/examples?dataset=${ds.id}&limit=100&offset=${offset}`);
  examples.push(...page);
  if (page.length < 100) break;
}

const { keys: keysByTask, sha: GIT_SHA } = readEvalYaml(join(ROOT, "eval.yaml"));

/**
 * Only tasks the CURRENT eval.yaml declares. The results directory is
 * append-only across every run this box has ever done, including tasks from
 * naming schemes that no longer exist — uploading those would put rows in the
 * experiment that the dataset has no example for.
 */
const results = latestResults().filter((f) => {
  const r = JSON.parse(readFileSync(f.path, "utf8"));
  return Boolean(keysByTask[r.task || f.task]);
});
if (!results.length) { console.error(`✗ no results in ${RESULTS}${SINCE ? " newer than --since" : ""}`); process.exit(1); }

// ── assemble ────────────────────────────────────────────────────────────────

const runs = [];
const feedback = [];
let model = null;
const problems = [];

for (const file of results) {
  const r = JSON.parse(readFileSync(file.path, "utf8"));
  const taskName = r.task || file.task;
  const prefix = taskName.split("-").pop();
  const matches = examples.filter((e) => e.id.startsWith(prefix));
  if (matches.length !== 1) {
    problems.push(`${taskName}: ${matches.length} examples match id prefix "${prefix}"`);
    continue;
  }
  const example = matches[0];
  const keys = keysByTask[taskName];

  for (const t of r.trials) {
    const runId = randomUUID();
    const end = new Date(file.mtime);
    const start = new Date(file.mtime - (t.duration_ms || 0));

    // The `usage` check that trajectory.mjs publishes: real tokens, the resolved
    // model, the session id. Absent on rows with no trajectory grader.
    let usage = null;
    for (const g of t.grader_results) {
      const m = /✓ usage: (\{.*\})/.exec(g.details || "");
      if (m) { try { usage = JSON.parse(m[1]); } catch {} }
    }
    model ??= usage?.model || null;

    runs.push({
      id: runId,
      trace_id: runId,
      dotted_order: seg(start.toISOString(), runId),
      name: taskName,
      run_type: "chain",
      inputs: example.inputs,
      outputs: { answer: t.session_log?.find((e) => e.type === "agent_result")?.output ?? null },
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      reference_example_id: example.id,
      extra: {
        metadata: {
          capability: example.metadata?.capability,
          difficulty: example.metadata?.difficulty,
          trial: t.trial_id,
          model: usage?.model,
          session_id: usage?.session,
          tool_calls: usage?.tools,
          cli_calls: usage?.cli,
        },
      },
    });

    // One synthetic llm child so LangSmith can price the trial. Not a trace —
    // a single node carrying the totals, which is all the cost column needs.
    if (usage?.model) {
      const childId = randomUUID();
      runs.push({
        id: childId,
        trace_id: runId,
        parent_run_id: runId,
        dotted_order: `${seg(start.toISOString(), runId)}.${seg(start.toISOString(), childId)}`,
        name: usage.model,
        run_type: "llm",
        inputs: { messages: [] },
        /**
         * usage_metadata belongs in OUTPUTS, not at the top level. The first
         * version set both; LangSmith read the outputs one, so the 112k cache
         * reads vanished and it billed 32 input tokens.
         *
         * input_tokens is the TOTAL and cache_read is a breakdown OF it, not an
         * addition to it — that is the LangChain UsageMetadata convention, and
         * getting it backwards double-counts.
         */
        outputs: {
          usage_metadata: {
            input_tokens: usage.in + usage.cache_read + (usage.cache_write || 0),
            output_tokens: usage.out,
            total_tokens: usage.in + usage.cache_read + (usage.cache_write || 0) + usage.out,
            input_token_details: { cache_read: usage.cache_read, cache_creation: usage.cache_write || 0 },
          },
        },
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        extra: { metadata: { ls_provider: "anthropic", ls_model_name: usage.model } },
      });
    }

    feedback.push({ run_id: runId, key: "reward", score: round4(t.reward) });
    t.grader_results.forEach((g, i) => {
      feedback.push({
        run_id: runId,
        key: keys?.[i] || `${g.grader_type}-${i}`,
        score: round4(g.score),
        comment: (g.details || "").slice(0, 2000),
      });
    });
  }
}

const NAME = arg("name") || `${(model || "unknown").replace(/[^a-z0-9]+/gi, "-")}-${GIT_SHA}`;
const stampSuffix = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const projectName = `${NAME}-${stampSuffix}`;

for (const p of problems) console.warn(`  ! ${p}`);

if (DRY) {
  console.log(`experiment  ${projectName}`);
  console.log(`dataset     ${DATASET}  (${ds.id})`);
  console.log(`runs        ${runs.length}  (${runs.filter((x) => x.run_type === "chain").length} trials + ${runs.filter((x) => x.run_type === "llm").length} llm)`);
  console.log(`feedback    ${feedback.length}`);
  for (const r of runs.filter((x) => x.run_type === "chain")) {
    const fb = feedback.filter((f) => f.run_id === r.id).map((f) => `${f.key}=${f.score}`).join("  ");
    console.log(`  ${r.name.padEnd(24)} ${fb}`);
  }
  process.exit(0);
}

// ── send ────────────────────────────────────────────────────────────────────

const session = await api(`/api/v1/sessions?upsert=true`, {
  method: "POST",
  body: JSON.stringify({
    name: projectName,
    reference_dataset_id: ds.id,
    description: `skillgrade · ${DATASET} · ${runs.filter((r) => r.run_type === "chain").length} trials`,
    extra: { metadata: { model, git_sha: GIT_SHA, source: "skillgrade", dataset: DATASET } },
  }),
});

await api(`/api/v1/runs/batch`, {
  method: "POST",
  body: JSON.stringify({ post: runs.map((r) => ({ ...r, session_id: session.id })) }),
});

// Feedback is its own endpoint and has no batch form in every deployment, so
// one call each. Small N; if it ever isn't, this is the thing to batch.
for (const f of feedback) {
  await api(`/api/v1/feedback`, { method: "POST", body: JSON.stringify({ ...f, id: randomUUID() }) });
}

const host = EP.includes("api.smith") ? "https://smith.langchain.com" : EP;
console.log(`✓ ${projectName}`);
console.log(`  ${runs.filter((r) => r.run_type === "chain").length} trial(s), ${feedback.length} feedback`);
console.log(`  ${host}/o/-/datasets/${ds.id}/compare?selectedSessions=${session.id}`);
