#!/usr/bin/env node
/**
 * run-claude.mjs — the CLI entry point skillgrade invokes.
 *
 *   defaults: { agent: command, command: "node <abs>/harness/run-claude.mjs" }
 *
 * This file is PLUMBING only: read the prompt from stdin, wire the four layers
 * together, write the result contract to stdout, exit with the agent's code.
 * Every decision lives elsewhere.
 *
 *   eval-context.mjs   which trial is this, which skill got injected   (harness)
 *   agent-runtime.mjs  spawn claude, turn bytes into events           (runtime)
 *   trace.mjs          what each moment means                    (application)
 *   trace-writer.mjs   dotted_order, blobs, index                     (storage)
 *
 * The stdout contract matters: skillgrade stores stdout as the agent output, and
 * `logs.mjs --link` reads `trace_id` out of it to attach the grader's reward. So
 * the summary block is load-bearing, not decoration — but it stays small, because
 * the ~320KB of raw events belong in the trace store, not the results JSON.
 *
 * Env: TRACE_ROOT · RUN_ID · TRIAL_ID · ANTHROPIC_MODEL · DENY_TOOLS
 */
import { evalContext } from "./eval-context.mjs";
import { claudeArgs, runAgent } from "./agent-runtime.mjs";
import { Trace } from "./trace.mjs";

const readStdin = () =>
  new Promise((res) => {
    let b = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (b += d)).on("end", () => res(b));
  });

const prompt = await readStdin();
const ctx = evalContext();

const trace = new Trace({
  root: ctx.traceRoot,
  runId: ctx.runId,
  task: ctx.task,
  trial: ctx.trial,
  attrs: { workspace: ctx.workspace, model: ctx.model, deny_tools: ctx.deny,
           skill_path: ctx.skill_path, skill_sha: ctx.skill_sha },
  manifest: { model: ctx.model, deny_tools: ctx.deny, cwd: process.cwd(),
              skill_path: ctx.skill_path, skill_sha: ctx.skill_sha },
  flags: ctx.flags,
});

const code = await runAgent({
  command: "claude",
  args: claudeArgs({ deny: ctx.deny }),
  stdin: prompt,
  onEvent: (ev) => trace.at("stream", ev),
  onStderr: (text) => trace.at("stderr", text),
});

const summary = trace.at("exit", { code });

console.log(trace.finalText);
console.log("\n--- TRIAL SUMMARY ---");
console.log(JSON.stringify({
  trace_id: trace.traceId,
  task: ctx.task,
  run: ctx.runId,
  trace_file: trace.spansPath,
  ...summary,
}, null, 1));
if (trace.stderr.trim()) console.error(trace.stderr.trim().slice(0, 500));

process.exit(code === 0 ? 0 : code);
