/**
 * agent-runtime.mjs — invoke an agent CLI and listen to it.
 *
 * The RUNTIME layer: turn a subprocess's byte stream into parsed events. It knows
 * about processes, chunk boundaries and NDJSON. It knows nothing about traces,
 * spans, evals or Figma — hand it callbacks and it calls them.
 *
 * Split out because line-buffering a stream is a genuinely separate problem from
 * deciding what the lines mean, and getting it wrong is silent: a JSON object
 * split across two chunks parses as nothing and the event vanishes.
 */
import { spawn } from "node:child_process";

/**
 * Argv for `claude -p` in streaming mode. Kept as a named function so the flags
 * are visible in one place rather than buried in a spawn call.
 *
 *   stream-json + verbose   every tool call, thinking block and real usage on
 *                           stdout. Plain `claude -p` emits only final text,
 *                           which is why "did it use the skill?" was unanswerable.
 *   forward-subagent-text   a delegated subagent is otherwise one opaque `Agent`
 *                           tool call. Forwarded messages carry parent_tool_use_id.
 *   disallowedTools         the only actual guardrail. Detection cannot stop a
 *                           bypass; refusing the tool can.
 */
export function claudeArgs({ deny = [] } = {}) {
  const args = [
    "-p",
    "--output-format=stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--forward-subagent-text",
  ];
  if (deny.length) args.push(`--disallowedTools=${deny.join(",")}`);
  return args;
}

/**
 * Spawn, feed stdin, stream stdout as parsed JSON events. Resolves with the exit
 * code; never rejects — a crashed agent is a result, not an exception.
 *
 * @param onEvent  (obj) => void   one per parsed NDJSON object
 * @param onStderr (text) => void
 * @param onLine   (text) => void  optional: non-JSON stdout lines
 */
export function runAgent({ command = "claude", args = [], stdin = "", onEvent, onStderr, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(stdin);

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      // Keep the trailing fragment: a JSON object can straddle two chunks, and
      // parsing half of one yields nothing with no error.
      buf = lines.pop() ?? "";
      for (const line of lines) emit(line);
    });

    child.stderr.on("data", (d) => onStderr?.(d.toString()));

    const emit = (line) => {
      const t = line.trim();
      if (!t) return;
      // --verbose interleaves plain log lines with the NDJSON.
      if (!t.startsWith("{")) return onLine?.(t);
      let obj;
      try { obj = JSON.parse(t); } catch { return onLine?.(t); }
      onEvent?.(obj);
    };

    child.on("close", (code) => {
      if (buf.trim()) emit(buf);          // flush a final unterminated line
      resolve(code ?? 1);
    });
    child.on("error", (e) => { onStderr?.(String(e)); resolve(1); });
  });
}
