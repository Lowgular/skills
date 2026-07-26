#!/usr/bin/env node
/**
 * logs.mjs — query the trace store. Data model: LOGGING.md
 *
 *   node logs.mjs                            latest run, one line per trial
 *   node logs.mjs --run=<runId>              a specific run  (--all for every run)
 *   node logs.mjs --failed                   reward < 1 (needs --link first)
 *   node logs.mjs --no-cli                   never called figma.mjs — likely bypass
 *   node logs.mjs --protocol                 no answer.txt — instruction/harness fault,
 *                                            NOT a capability failure
 *   node logs.mjs --cost                     spend, grouped by tier
 *   node logs.mjs --trace <task>             pretty-print one span tree
 *   node logs.mjs --link <results-dir>       attach skillgrade rewards to traces
 *
 * Everything except --trace reads index.ndjson only, so a query costs kilobytes
 * no matter how large the store is.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TRACE_ROOT || resolve(HERE, "runs");
const INDEX = join(ROOT, "index.ndjson");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const h = argv.find((a) => a.startsWith(`${f}=`)); return h ? h.slice(f.length + 1) : null; };
const positional = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function readIndex() {
  if (!existsSync(INDEX)) return [];
  return readFileSync(INDEX, "utf8").split("\n").filter((l) => l.trim().startsWith("{"))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const n = (x, d = "—") => (x === null || x === undefined ? d : x);
const money = (x) => (x == null ? "     —" : "$" + Number(x).toFixed(3));

/* ---------- --link : attach grader rewards ------------------------------- */
// The agent finishes before grading, so index lines are written with reward:null.
// run-claude.mjs prints trace_id into stdout, which skillgrade stores as the
// agent output — so the join is by id, not by matching question text.
if (has("--link")) {
  const dir = positional("--link");
  if (!dir || !existsSync(dir)) { console.error(`--link needs a results dir; got ${dir}`); process.exit(1); }
  const rows = readIndex();
  const byTrace = new Map(rows.map((r) => [r.trace_id, r]));
  let linked = 0, missed = 0;
  const feedback = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let r; try { r = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    for (const t of r.trials || []) {
      const out = (t.session_log || []).find((e) => e.type === "agent_result")?.output || "";
      const m = out.match(/"trace_id":\s*"([0-9a-f-]{36})"/);
      if (!m) { missed++; continue; }
      const row = byTrace.get(m[1]);
      if (!row) { missed++; continue; }
      row.reward = t.reward ?? 0;
      const g = (t.grader_results || [])[0] || {};
      const details = (g.details || "").replace(/\n/g, " / ");
      // A row that never wrote answer.txt failed the PROTOCOL — wrong instruction
      // wording, or the agent never ran at all. That is not the same as answering
      // wrongly, and in a bare pass rate the two are indistinguishable. A relative
      // command path once graded FAIL 0.00 on 1 row where claude never executed.
      row.no_answer = /not written/.test(details);
      feedback.push({ v: 1, trace_id: m[1], key: "reward", score: row.reward,
                      grader: g.grader_type || null, details,
                      duration_ms: t.duration_ms ?? null });
      linked++;
    }
  }
  writeFileSync(INDEX, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  for (const fb of feedback) {
    const row = byTrace.get(fb.trace_id);
    if (row) appendFileSync(join(ROOT, row.run, "feedback.ndjson"), JSON.stringify(fb) + "\n");
  }
  console.log(`  linked ${linked} trial(s)${missed ? `, ${missed} unmatched` : ""}`);
  process.exit(0);
}

/* ---------- --trace : one span tree ------------------------------------- */
if (has("--trace")) {
  const task = positional("--trace");
  const rows = readIndex().filter((r) => r.task === task || r.trace_id === task);
  if (!rows.length) { console.error(`no trace for "${task}"`); process.exit(1); }
  const row = rows[rows.length - 1];               // most recent
  const p = join(ROOT, row.spans);
  if (!existsSync(p)) { console.error(`spans file missing: ${p}`); process.exit(1); }
  const spans = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l))
    // dotted_order sorts lexicographically into depth-first order — that is the
    // entire reason for the format. Depth is just the number of dots.
    .sort((a, b) => a.dotted_order.localeCompare(b.dotted_order));
  console.log(`\n  ${row.task}  run=${row.run}  reward=${n(row.reward)}  ${money(row.cost_usd)}\n`);
  for (const s of spans) {
    const depth = s.dotted_order.split(".").length - 1;
    const ms = Date.parse(s.end) - Date.parse(s.start);
    const arg = s.inputs?.command || s.inputs?.file_path || s.inputs?.skill || s.inputs?.subagent_type || "";
    const out = s.outputs?.$blob ? `[blob ${s.outputs.$bytes}B]` : "";
    const bad = s.status === "error" ? " ✗" : "";
    const sub = s.attrs?.subagent ? " ⤷sub" : "";
    console.log(`  ${"  ".repeat(depth)}${s.run_type}/${s.name}${sub}${bad}  ${ms}ms  ${String(arg).slice(0, 90)} ${out}`);
  }
  console.log();
  process.exit(0);
}

/* ---------- index-only views ------------------------------------------- */
let rows = readIndex();
if (!rows.length) { console.error(`  no traces in ${ROOT}`); process.exit(1); }

const runFilter = val("--run");
if (runFilter) rows = rows.filter((r) => r.run === runFilter);
else if (!has("--all")) {
  const latest = rows[rows.length - 1].run;
  rows = rows.filter((r) => r.run === latest);
}
if (has("--failed")) rows = rows.filter((r) => (r.reward ?? 1) < 1);
if (has("--no-cli")) rows = rows.filter((r) => r.used_cli === false);
if (has("--protocol")) rows = rows.filter((r) => r.no_answer);
if (has("--subagents")) rows = rows.filter((r) => r.subagent);

if (has("--cost")) {
  const groups = new Map();
  for (const r of rows) {
    const k = (r.task || "").split("--")[0] || "?";
    const g = groups.get(k) || { n: 0, cost: 0, turns: 0, tools: 0 };
    g.n++; g.cost += r.cost_usd || 0; g.turns += r.turns || 0; g.tools += r.tools || 0;
    groups.set(k, g);
  }
  console.log(`\n  tier      trials     cost   avg turns   avg tools`);
  let tc = 0;
  for (const [k, g] of groups) {
    tc += g.cost;
    console.log(`  ${k.padEnd(9)} ${String(g.n).padStart(6)}  ${money(g.cost)}  ${(g.turns / g.n).toFixed(1).padStart(9)}   ${(g.tools / g.n).toFixed(1).padStart(9)}`);
  }
  console.log(`  ${"total".padEnd(9)} ${String(rows.length).padStart(6)}  ${money(tc)}\n`);
  process.exit(0);
}

const w = Math.max(12, ...rows.map((r) => (r.task || "").length));
console.log();
for (const r of rows) {
  const flags = [
    r.used_cli === false ? "NO-CLI" : "cli",
    r.subagent ? "SUBAGENT" : "",
    r.no_answer ? "NO-ANSWER-FILE" : "",
    r.rate_limited ? "RATE-LIMITED" : "",
    r.denials ? `denials=${r.denials}` : "",
    r.status === "error" ? "ERROR" : "",
  ].filter(Boolean).join(" ");
  const rw = r.reward == null ? " —  " : r.reward.toFixed(2);
  console.log(`  ${rw}  ${(r.task || "").padEnd(w)}  ${String(n(r.turns)).padStart(3)}t ${String(n(r.tools)).padStart(3)}c  ${money(r.cost_usd)}  ${flags}`);
}
const linked = rows.filter((r) => r.reward != null);
const cost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
// Only suggest --link when there is something to link; on an empty filtered set
// that hint points at a problem that doesn't exist.
const rewardNote = linked.length
  ? `mean reward ${(linked.reduce((s, r) => s + r.reward, 0) / linked.length).toFixed(3)}`
  : rows.length ? "rewards unlinked — run --link <results-dir>" : "no matches";
console.log(`\n  ${rows.length} trial(s)   ${rewardNote}   total ${money(cost)}`);
console.log(`  no-cli ${rows.filter((r) => r.used_cli === false).length}   subagent ${rows.filter((r) => r.subagent).length}   run(s): ${[...new Set(rows.map((r) => r.run))].join(", ")}`);
// Subscription runs fail on a usage window rather than a bill. Surfacing the
// window and its reset means a mid-run stall is diagnosable, not mysterious.
const rl = rows.filter((r) => r.rate_limited).length;
const last = rows[rows.length - 1];
if (rl || last?.rate_limit_type) {
  console.log(`  rate limit: ${last?.rate_limit_type ?? "?"} · ${rl ? `${rl} THROTTLED` : "none throttled"}` +
              (last?.rate_limit_resets_at ? ` · window resets ${last.rate_limit_resets_at}` : ""));
}
console.log();
