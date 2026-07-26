/**
 * eval-context.mjs — what trial am I, and what is under test?
 *
 * The HARNESS layer: everything skillgrade-specific about a single trial's
 * identity. It answers questions the runtime and the trace store have no way to
 * ask — which row is this, which skill actually got injected, where do logs go.
 *
 * Separated because all of it is inference from the workspace skillgrade built.
 * The `command` agent is told nothing: no task name, no trial number, no run id.
 * Every field here is recovered from the environment or the files on disk, and
 * each recovery is a place this can silently go wrong.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Verbs of the skill under test — used to answer "did it call the CLI at all?"
 *
 * The optional quote matters. An agent that writes `node "/abs/path/figma.mjs"
 * vars …` is doing the same thing as one that leaves the path bare, but an
 * earlier version of this pattern demanded whitespace straight after `.mjs` and
 * flagged the quoted form as NO-CLI — a passing row accused of bypassing the
 * skill it had just used. Integrity checks that cry wolf get ignored, so this
 * errs toward matching.
 */
const CLI = /figma\.mjs["']?\s+(pages|find|layers|inspect|css|vars|open|help|status|login)\b/;

/**
 * Which row is this? skillgrade does not pass the task name to a `command`
 * agent, but it does write the grader line into <workspace>/tests/test.sh, and
 * that line carries TIER and ROW_ID. Falls back to the workspace slug so a trace
 * is never anonymous.
 */
function taskName(cwd) {
  try {
    const sh = readFileSync(join(cwd, "tests", "test.sh"), "utf8");
    const tier = sh.match(/TIER=(\S+)/)?.[1];
    const row = sh.match(/ROW_ID=(\S+)/)?.[1];
    if (tier && row) return `${tier}--${row}`;
    if (row) return row;
  } catch {}
  return basename(cwd);
}

/**
 * Hash the skill that was ACTUALLY resolved.
 *
 * A 109-row run once scored 98.2% while the agent loaded a *different* skill of
 * the same name from ~/.claude/skills, and skillgrade reported
 * skills_used: ["figma-browser"] throughout because the name matched. A content
 * hash in the index makes that detectable without a post-mortem.
 */
function skillFingerprint(cwd, skillName) {
  const dir = join(cwd, ".claude", "skills", skillName);
  if (!existsSync(dir)) return { skill_path: null, skill_sha: null };
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { h.update(e.name); h.update(readFileSync(p)); }
    }
  };
  try { walk(dir); } catch { return { skill_path: dir, skill_sha: null }; }
  return { skill_path: dir, skill_sha: "sha256-" + h.digest("hex").slice(0, 32) };
}

/** Collect everything about this trial. Pure reads; no side effects. */
export function evalContext({ skillName = "figma-browser", cwd = process.cwd() } = {}) {
  const workspace = basename(cwd);
  const fp = skillFingerprint(cwd, skillName);
  const deny = (process.env.DENY_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);

  return {
    task: taskName(cwd),
    trial: Number(process.env.TRIAL_ID || 1),
    workspace,
    model: process.env.ANTHROPIC_MODEL || null,
    deny,
    // Absolute, and outside the workspace on purpose: the provider deletes the
    // workspace on cleanup, which once took the whole trace with it.
    traceRoot: process.env.TRACE_ROOT || resolve(HERE, "..", "runs"),
    runId: process.env.RUN_ID || `adhoc-${new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "")}`,
    ...fp,

    /**
     * Domain flags for the index line. These are EVAL questions, not trace
     * questions — "did it call figma.mjs" means nothing to a tracer — so they
     * travel with the context and are injected into Trace.
     */
    flags(tools) {
      return {
        used_cli: tools.some((t) => CLI.test(t.arg)),
        subagent: tools.some((t) => t.name === "Agent"),
        workspace,
        model: process.env.ANTHROPIC_MODEL || null,
      };
    },
  };
}
