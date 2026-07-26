#!/usr/bin/env node
/**
 * run-claude.mjs — supervise `claude -p` for a skillgrade trial.
 *
 * Used as skillgrade's `command` agent:
 *   defaults: { agent: command, command: "node <abs>/harness/run-claude.mjs" }
 *
 * Why a script instead of `claude -p …` straight in eval.yaml: a config string
 * can only configure claude, a script can supervise it —
 *
 *   - parses the stream as it arrives, so a trace exists WHILE the trial runs
 *     (skillgrade's runCommand only resolves after the process exits)
 *   - writes spans/blobs to an absolute log root and returns a short summary, so
 *     the results JSON does not swallow ~320KB of raw events per row
 *   - stamps one trace id, and records the claude session_id + workspace slug, so
 *     our trace, skillgrade's results, and Claude Code's own transcript all join
 *     on ids instead of matching question text
 *   - is the only place a guardrail can live (DENY_TOOLS)
 *
 * The prompt arrives on stdin (command.ts pipes it), which is what `claude -p`
 * wants anyway.
 *
 * Env:
 *   TRACE_ROOT       log root (default <skill>/runs) — MUST be outside the workspace
 *   RUN_ID           groups trials into one run; auto-generated if absent
 *   ANTHROPIC_MODEL  passed through to claude
 *   DENY_TOOLS       comma-separated tools to refuse, e.g. "Agent,WebFetch"
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openTrace, writeManifest } from "./trace-writer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACE_ROOT = process.env.TRACE_ROOT || resolve(HERE, "..", "runs");
// Workspace dir name: unique per trial, and the slug of Claude Code's own
// transcript dir (~/.claude/projects/-private-tmp-<slug>).
const WORKSPACE = basename(process.cwd());
// Trials of one skillgrade invocation share a RUN_ID when the caller exports one.
const RUN_ID = process.env.RUN_ID || `adhoc-${new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "")}`;

/** Which task is this? skillgrade doesn't tell the command agent, so derive it
 *  from the grader line it wrote into the workspace. */
function taskName() {
  try {
    const sh = readFileSync(join(process.cwd(), "tests", "test.sh"), "utf8");
    const tier = sh.match(/TIER=(\S+)/)?.[1];
    const row = sh.match(/ROW_ID=(\S+)/)?.[1];
    if (tier && row) return `${tier}--${row}`;
  } catch {}
  return WORKSPACE;
}

/** Hash the skill that was ACTUALLY resolved — a run once measured a different
 *  skill of the same name and nothing in the results revealed it. */
function skillFingerprint() {
  const dir = join(process.cwd(), ".claude", "skills", "figma-browser");
  if (!existsSync(dir)) return { skill_path: null, skill_sha: null };
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { h.update(e.name); h.update(readFileSync(p)); }
    }
  };
  try { walk(dir); } catch {}
  let real = dir;
  try { real = statSync(dir).isSymbolicLink() ? dir : dir; } catch {}
  return { skill_path: real, skill_sha: "sha256-" + h.digest("hex").slice(0, 32) };
}

const prompt = await new Promise((res) => {
  let b = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (b += d)).on("end", () => res(b));
});

const TASK = taskName();
const fp = skillFingerprint();
const DENY = (process.env.DENY_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);

const trace = openTrace({
  root: TRACE_ROOT, runId: RUN_ID, task: TASK, trial: 1,
  attrs: { workspace: WORKSPACE, model: process.env.ANTHROPIC_MODEL || null, deny_tools: DENY, ...fp },
});
writeManifest(TRACE_ROOT, RUN_ID, {
  model: process.env.ANTHROPIC_MODEL || null, deny_tools: DENY, cwd: process.cwd(), ...fp,
});

const args = [
  "-p", "--output-format=stream-json", "--verbose", "--dangerously-skip-permissions",
  // Without this, a delegated subagent appears as a single `Agent` tool call and
  // everything it did is invisible — a passing row once did the whole task in a
  // subagent and looked like 2 tool calls. Forwarded messages carry
  // parent_tool_use_id, which we use to nest them under the Agent span.
  "--forward-subagent-text",
];
// The guardrail. Detection cannot stop a bypass; refusing the tool can.
if (DENY.length) args.push(`--disallowedTools=${DENY.join(",")}`);

const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
child.stdin.end(prompt);

const tools = [];
const blocks = {};
let resultEv = null, buf = "", stderr = "";
let rateLimit = null, rateLimitHit = false;
let turnIdx = 0, subIdx = 0;
let lastEventAt = new Date().toISOString();
const openTools = new Map();   // tool_use_id -> span, so tool_result lands on the right span

child.stderr.on("data", (d) => (stderr += d.toString()));
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";                    // keep the partial line for the next chunk
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;         // --verbose can interleave plain logs
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    trace.raw(ev);

    const content = ev.message?.content;

    // A forwarded subagent message names the Agent tool call it belongs to.
    const pid = ev.parent_tool_use_id ?? ev.message?.parent_tool_use_id ?? null;
    const hostSpan = pid ? openTools.get(pid) : null;
    const isSub = !!hostSpan;

    if (ev.type === "assistant" && Array.isArray(content)) {
      // Attach under the Agent span when forwarded, otherwise at the trial root.
      // Depth is carried by dotted_order, so nesting needs nothing else.
      const host = hostSpan || trace;
      const label = isSub ? `sub-turn-${++subIdx}` : `turn-${++turnIdx}`;
      // Backdate to the previous event: that gap is the time the model spent
      // producing this turn. Without it start == end and the duration is a lie.
      const t2 = host.span("llm", label, { startAt: lastEventAt, attrs: isSub ? { subagent: true, parent_tool_use_id: pid } : {} });
      lastEventAt = new Date().toISOString();
      let thinkingChars = 0, text = [];
      for (const b of content) {
        blocks[b.type] = (blocks[b.type] || 0) + 1;
        if (b.type === "thinking") thinkingChars += (b.thinking || "").length;
        if (b.type === "text") text.push(b.text || "");
        if (b.type === "tool_use") {
          const s = t2.span("tool", b.name || "?", { inputs: b.input });
          openTools.set(b.id, s);
          const i = b.input || {};
          tools.push({ name: b.name, subagent: isSub, arg: String(i.command ?? i.file_path ?? i.pattern ?? (i.skill ? `skill=${i.skill}` : "") ?? "").slice(0, 200) });
        }
      }
      t2.end({
        status: "success",
        outputs: { text: text.join("\n") || null },
        attrs: { thinking_chars: thinkingChars },
        tokens: ev.message?.usage
          ? { in: ev.message.usage.input_tokens, out: ev.message.usage.output_tokens,
              cache_read: ev.message.usage.cache_read_input_tokens }
          : null,
      });
    }

    // tool_result arrives as a user event referencing the tool_use id
    if (ev.type === "user" && Array.isArray(content)) {
      for (const b of content) {
        blocks[b.type] = (blocks[b.type] || 0) + 1;
        if (b.type !== "tool_result") continue;
        const s = openTools.get(b.tool_use_id);
        // Keep the Agent span open while its subagent is still streaming — it is
        // the parent every forwarded message attaches to.
        if (s) { s.end({ status: b.is_error ? "error" : "success", outputs: b.content }); openTools.delete(b.tool_use_id); }
      }
    }

    // On a subscription the binding limit is a usage window, not cost — and with
    // overageStatus "rejected" a breach FAILS the request. A throttled row writes
    // no answer.txt, which is indistinguishable from a skill failure in a pass
    // rate, so record it as infrastructure rather than losing it.
    if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
      rateLimit = ev.rate_limit_info;
      if (rateLimit.status && rateLimit.status !== "allowed") rateLimitHit = true;
    }

    if (ev.type === "result") resultEv = ev;
  }
});

const code = await new Promise((res) => {
  child.on("close", res);
  child.on("error", (e) => { stderr += String(e); res(1); });
});

// Anything still open means the stream ended mid-call (timeout, crash).
for (const s of openTools.values()) s.end({ status: "error", error: "stream ended before tool_result" });

const u = resultEv?.usage || {};
const usedCli = tools.some((t) => /figma\.mjs\s+(pages|find|layers|inspect|css|vars|open|help|status|login)/.test(t.arg));
const summary = {
  workspace: WORKSPACE,
  claude_session_id: resultEv?.session_id || null,
  model: process.env.ANTHROPIC_MODEL || null,
  exit_code: code,
  // Two different counts, both kept because neither is wrong: claude's own
  // num_turns, and the number of assistant events we actually saw on the stream.
  turns: resultEv?.num_turns ?? null,
  assistant_events: turnIdx,
  subagent_events: subIdx,
  subagent_tools: tools.filter((t) => t.subagent).length,
  cost_usd: resultEv?.total_cost_usd ?? null,
  tokens_in: u.input_tokens ?? null,
  tokens_out: u.output_tokens ?? null,
  cache_read: u.cache_read_input_tokens ?? null,
  tools: tools.length,
  used_cli: usedCli,
  subagent: tools.some((t) => t.name === "Agent"),
  denials: Array.isArray(resultEv?.permission_denials) ? resultEv.permission_denials.length : 0,
  rate_limit_status: rateLimit?.status ?? null,
  rate_limit_type: rateLimit?.rateLimitType ?? null,
  rate_limit_resets_at: rateLimit?.resetsAt ? new Date(rateLimit.resetsAt * 1000).toISOString() : null,
  rate_limited: rateLimitHit,
  blocks,
  ...fp,
};
trace.close({ status: code === 0 ? "success" : "error", summary });

// stdout becomes skillgrade's agent_output — keep it small, and include trace_id
// so `logs.mjs --link` can attach the grader's reward without text matching.
console.log(resultEv?.result ?? "");
console.log("\n--- TRIAL SUMMARY ---");
console.log(JSON.stringify({ trace_id: trace.trace_id, task: TASK, run: RUN_ID, trace_file: trace.spansPath, tool_calls: tools, ...summary }, null, 1));
if (stderr.trim()) console.error(stderr.trim().slice(0, 500));
process.exit(code === 0 ? 0 : code);
