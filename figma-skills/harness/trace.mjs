/**
 * trace.mjs — the application layer between the harness and the trace store.
 *
 *   harness (run-claude.mjs)   "I am at this point in the runtime"
 *        │
 *        ▼
 *   Trace  (this file)         decides what that MEANS: which span opens or
 *        │                     closes, which counter moves, what the summary is
 *        ▼
 *   trace-writer.mjs           infra: dotted_order, blob spilling, index append
 *
 * The harness calls exactly one function — `at(moment, payload)` — naming where
 * it is, never what to write or where. Everything about spans, turn numbering,
 * subagent nesting and blob thresholds lives here, so the harness stays a pipe
 * between a subprocess and this object.
 *
 * Moments:
 *   at('stream', ev)     one parsed NDJSON event from the agent
 *   at('stderr', text)   a stderr chunk
 *   at('exit', {code})   process ended — closes anything open, writes the index
 */
import { openTrace, writeManifest } from "./trace-writer.mjs";

export class Trace {
  /**
   * @param flags  optional (tools, ctx) => object — domain-specific booleans for
   *               the index line. Kept injectable so this class stays generic:
   *               "did it call figma.mjs" is an eval question, not a trace one.
   */
  constructor({ root, runId, task, trial = 1, attrs = {}, manifest = {}, flags = null }) {
    this.task = task;
    this.trial = trial;
    this.flags = flags;

    this.store = openTrace({ root, runId, task, trial, attrs });
    writeManifest(root, runId, manifest);

    // Everything below is bookkeeping the harness used to carry.
    this.tools = [];
    this.blocks = {};
    this.turnIdx = 0;
    this.subIdx = 0;
    this.openTools = new Map();      // tool_use_id -> span
    this.lastEventAt = new Date().toISOString();
    this.result = null;
    this.rateLimit = null;
    this.rateLimited = false;
    this.stderr = "";
    this.closed = false;
  }

  get traceId() { return this.store.trace_id; }
  get spansPath() { return this.store.spansPath; }

  /** The single entry point. `moment` says where we are; Trace decides the rest. */
  at(moment, payload) {
    switch (moment) {
      case "stream": return this.#stream(payload);
      case "stderr": this.stderr += payload; return;
      case "exit":   return this.#exit(payload || {});
      default: throw new Error(`Trace.at: unknown moment "${moment}"`);
    }
  }

  #stream(ev) {
    this.store.raw(ev);
    const content = ev?.message?.content;

    // A forwarded subagent message names the Agent tool call it belongs to.
    const pid = ev?.parent_tool_use_id ?? ev?.message?.parent_tool_use_id ?? null;
    const host = pid ? this.openTools.get(pid) : null;
    const isSub = !!host;

    if (ev?.type === "assistant" && Array.isArray(content)) this.#turn(ev, content, host, isSub, pid);
    if (ev?.type === "user" && Array.isArray(content)) this.#results(content);

    if (ev?.type === "rate_limit_event" && ev.rate_limit_info) {
      // On a subscription the binding limit is a usage window, not cost, and a
      // breach fails the request — which looks exactly like a skill failure in a
      // pass rate unless it is recorded as infrastructure.
      this.rateLimit = ev.rate_limit_info;
      if (this.rateLimit.status && this.rateLimit.status !== "allowed") this.rateLimited = true;
    }

    if (ev?.type === "result") this.result = ev;
  }

  #turn(ev, content, host, isSub, pid) {
    const parent = host || this.store;
    const label = isSub ? `sub-turn-${++this.subIdx}` : `turn-${++this.turnIdx}`;
    // Backdated to the previous event: that gap is the model's thinking time.
    // Without it start === end and the duration is a lie.
    const span = parent.span("llm", label, {
      startAt: this.lastEventAt,
      attrs: isSub ? { subagent: true, parent_tool_use_id: pid } : {},
    });
    this.lastEventAt = new Date().toISOString();

    let thinking = 0;
    const text = [];
    for (const b of content) {
      this.blocks[b.type] = (this.blocks[b.type] || 0) + 1;
      if (b.type === "thinking") thinking += (b.thinking || "").length;
      if (b.type === "text") text.push(b.text || "");
      if (b.type === "tool_use") this.#toolOpen(span, b, isSub);
    }

    const u = ev.message?.usage;
    span.end({
      status: "success",
      outputs: { text: text.join("\n") || null },
      attrs: { thinking_chars: thinking },
      tokens: u ? { in: u.input_tokens, out: u.output_tokens, cache_read: u.cache_read_input_tokens } : null,
    });
  }

  #toolOpen(turnSpan, block, isSub) {
    const span = turnSpan.span("tool", block.name || "?", { inputs: block.input });
    // Stays open until its tool_result — and while open it is the parent that
    // forwarded subagent messages attach to.
    this.openTools.set(block.id, span);
    const i = block.input || {};
    const arg = i.command ?? i.file_path ?? i.pattern ?? (i.skill ? `skill=${i.skill}` : "")
      ?? (i.subagent_type ? `subagent=${i.subagent_type}` : "") ?? "";
    this.tools.push({ name: block.name, subagent: isSub, arg: String(arg).slice(0, 200) });
  }

  #results(content) {
    for (const b of content) {
      this.blocks[b.type] = (this.blocks[b.type] || 0) + 1;
      if (b.type !== "tool_result") continue;
      const span = this.openTools.get(b.tool_use_id);
      if (!span) continue;
      span.end({ status: b.is_error ? "error" : "success", outputs: b.content });
      this.openTools.delete(b.tool_use_id);
    }
  }

  #exit({ code = 0 }) {
    if (this.closed) return this.summary;
    this.closed = true;
    // A stream that ended mid-call leaves spans open; mark them rather than
    // dropping them, so a timeout is visible instead of silently absent.
    for (const s of this.openTools.values()) {
      s.end({ status: "error", error: "stream ended before tool_result" });
    }
    this.openTools.clear();
    this.exitCode = code;
    this.store.close({ status: code === 0 ? "success" : "error", summary: this.summary });
    return this.summary;
  }

  /** The facts, assembled once. Used for the index line and the harness stdout. */
  get summary() {
    const u = this.result?.usage || {};
    const base = {
      exit_code: this.exitCode ?? null,
      turns: this.result?.num_turns ?? null,
      assistant_events: this.turnIdx,
      subagent_events: this.subIdx,
      subagent_tools: this.tools.filter((t) => t.subagent).length,
      cost_usd: this.result?.total_cost_usd ?? null,
      tokens_in: u.input_tokens ?? null,
      tokens_out: u.output_tokens ?? null,
      cache_read: u.cache_read_input_tokens ?? null,
      tools: this.tools.length,
      denials: Array.isArray(this.result?.permission_denials) ? this.result.permission_denials.length : 0,
      blocks: this.blocks,
      claude_session_id: this.result?.session_id ?? null,
      stop_reason: this.result?.stop_reason ?? null,
      rate_limit_status: this.rateLimit?.status ?? null,
      rate_limit_type: this.rateLimit?.rateLimitType ?? null,
      rate_limit_resets_at: this.rateLimit?.resetsAt
        ? new Date(this.rateLimit.resetsAt * 1000).toISOString() : null,
      rate_limited: this.rateLimited,
    };
    return { ...base, ...(this.flags ? this.flags(this.tools, base) : {}) };
  }

  /** Final agent text, for the harness to hand back to skillgrade. */
  get finalText() { return this.result?.result ?? ""; }
}
