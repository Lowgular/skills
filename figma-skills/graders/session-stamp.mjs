#!/usr/bin/env node
/**
 * session-stamp.mjs — record WHICH transcript belongs to WHICH trial.
 *
 * Not a grader. A Claude Code hook, registered in the box's user settings and
 * run by Claude Code itself, once per trial.
 *
 * ── The problem it removes ──────────────────────────────────────────────────
 *
 * graders/trajectory.mjs finds the transcript by convention: Claude Code names
 * its project directory after the cwd with "/" → "-", and skillgrade's local
 * provider gives each trial its own cwd, so that resolves to one directory.
 * Then it takes the NEWEST .jsonl inside it. That last step is a guess, and it
 * has already been wrong once — a grader that shells out to `claude` from the
 * trial workspace lands a second transcript in the same directory, newer than
 * the agent's, and the grader scores itself. (score-answer.mjs runs in /tmp for
 * exactly this reason. That is a workaround, not a fix.)
 *
 * Hooks are handed the answer on stdin. Every hook payload carries `session_id`,
 * `transcript_path` and `cwd` — no convention, no guess, no race.
 *
 * ── SubagentStop is the reason this is worth doing at all ───────────────────
 *
 * A delegated turn writes a SEPARATE transcript, and the hook payload is the
 * only place its path appears (`agent_transcript_path`). trajectory.mjs reads
 * one file, so today a trial that delegates is silently under-counted: the
 * subagent's tool calls are simply not in the trajectory it scores.
 *
 * ── Written outside the workspace, on purpose ───────────────────────────────
 *
 * The obvious place is <cwd>/.session.json. But cwd is the agent's workspace
 * and the agent can `ls` it. Nothing here would help it, but an eval that
 * writes bookkeeping into the environment it measures is one edit away from
 * leaking something that does. Keyed by workspace basename instead —
 * /tmp/skillgrade-<random> is already unique per trial.
 *
 * ── Failure is silent, always ───────────────────────────────────────────────
 *
 * A non-zero exit from UserPromptSubmit can block the turn. Nothing this
 * script does is worth failing a trial over: every path swallows its error and
 * exits 0. If the stamp is missing, trajectory.mjs falls back to the old
 * convention and the run is exactly as good as it was before.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const OUT_DIR = process.env.SKILLGRADE_SESSION_DIR || "/tmp/skillgrade-sessions";

/** Where the stamp for a given trial workspace lives. Also used by readers. */
export const stampPath = (cwd) => join(OUT_DIR, `${basename(cwd)}.json`);

/** Merge, never overwrite: three hook events write to the same file. */
function stamp(h) {
  if (!h?.cwd) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = stampPath(h.cwd);

  let rec = {};
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { /* first write */ }

  rec.cwd = h.cwd;
  if (h.session_id) rec.session_id = h.session_id;
  if (h.transcript_path) rec.transcript_path = h.transcript_path;
  if (h.permission_mode) rec.permission_mode = h.permission_mode;
  if (h.agent_transcript_path) {
    rec.subagents = [...new Set([...(rec.subagents || []), h.agent_transcript_path])];
  }
  rec.events = [...new Set([...(rec.events || []), h.hook_event_name].filter(Boolean))];

  writeFileSync(file, JSON.stringify(rec, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let payload = "";
  // If stdin never closes the hook's own timeout ends this — but exit 0 first,
  // so a hung read cannot be mistaken for a hook that rejected the turn.
  const bail = setTimeout(() => process.exit(0), 5000);
  bail.unref?.();
  process.stdin.on("data", (d) => (payload += d));
  process.stdin.on("end", () => {
    try { stamp(JSON.parse(payload)); } catch { /* never block the agent */ }
    process.exit(0);
  });
  process.stdin.on("error", () => process.exit(0));
}
