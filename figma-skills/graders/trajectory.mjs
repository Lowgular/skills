/**
 * trajectory.mjs — what the agent DID, not just what it ended up with.
 *
 * Source is Claude Code's own session transcript
 * (~/.claude/projects/<cwd>/<session>.jsonl), not a parsed stdout stream. That
 * file is a superset of --output-format=stream-json: every tool call with its
 * full input, per-message token usage including cache, the resolved model. It
 * also survives the run, so it can be copied out and re-read later.
 *
 * One key, `trajectory`, from three signals:
 *
 *   +0.5  the skill was loaded
 *   +0.5  figma.mjs was actually called
 *   −1    it wrote or ran its own code instead
 *
 * Plus `reads` when — and only when — the row states a budget.
 *
 * Using the skill is PREFERRED, not mandatory: the model may legitimately solve
 * the task another way, and the verdict does not care. But an agent that writes
 * its own CDP client against localhost:9333 (Claude does this unprompted) hits
 * the same end state while proving nothing about the skill. That is how a
 * 109-row run once scored 98.2% against a skill it never invoked.
 *
 * So this is reported BESIDE the verdict and never folded into it, and a missing
 * signal is an absent score rather than a zero.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CLI_CALL = /figma\.mjs["']?\s+(pages|find|layers|inspect|css|vars|open|help|status|login)\b/;

/** Tools that author code. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Rolling its own: writing a script to a file, or executing inline code.
 *
 * This is the bypass that matters. Claude can and does write a ~90-line CDP
 * client against localhost:9333 and drive Figma directly — it reaches the same
 * end state while proving nothing about the skill. The heredoc and `>` forms
 * catch a script written via Bash rather than the Write tool.
 */
const ROLLED_OWN = /(^|\s|\|)(node|python3?|deno|bun)\s+-(e|c)\b|<<\s*['"]?EOF|>\s*\S+\.(mjs|js|cjs|ts|py|sh)\b|\btee\s+\S+\.(mjs|js|py|sh)\b/;

/**
 * The most recent session transcript.
 *
 * Two paths, because this runs in two places: as a skillgrade grader it executes
 * INSIDE the container (provider: local in the box), where the transcript is a
 * local file; run by hand from the host it must reach in via docker exec.
 *
 * The test is /.dockerenv, NOT "does ~/.claude/projects exist" — that exists on
 * the host too, so the first version silently graded the operator's OWN Claude
 * Code session (opus, 328 tool calls) instead of the box's trial. Reading the
 * wrong transcript is worse than failing: it produces a plausible score for a
 * run that never happened.
 */
export function pullTranscript(boxName = "figma-box") {
  const inContainer = existsSync("/.dockerenv");
  const root = join(process.env.HOME || "", ".claude", "projects");
  if (inContainer && existsSync(root)) {
    const files = [];
    for (const d of readdirSync(root)) {
      const dir = join(root, d);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push(join(dir, f));
    }
    if (files.length) {
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      return readFileSync(files[0], "utf8");
    }
  }
  const r = spawnSync("docker", ["exec", boxName, "sh", "-c",
    'F=$(ls -t /home/node/.claude/projects/*/*.jsonl 2>/dev/null | head -1); [ -n "$F" ] && cat "$F"'],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.stdout || "";
}

/** Parse a transcript into a trajectory. Pure — unit-testable without Docker. */
export function summarise(jsonl) {
  const lines = jsonl.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!lines.length) return null;

  const steps = [];
  let model = null, sessionId = null;
  let inTok = 0, outTok = 0, cacheRead = 0;

  for (const l of lines) {
    sessionId ??= l.sessionId || null;
    const msg = l.message;
    if (!msg) continue;
    model ??= msg.model || null;
    if (msg.usage) {
      inTok += msg.usage.input_tokens || 0;
      outTok += msg.usage.output_tokens || 0;
      cacheRead += msg.usage.cache_read_input_tokens || 0;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type !== "tool_use") continue;
      const input = JSON.stringify(b.input || {});
      const cmd = b.input?.command || "";
      steps.push({
        tool: b.name,
        rolledOwn: WRITE_TOOLS.has(b.name) || (b.name === "Bash" && ROLLED_OWN.test(cmd)),
        // The command, trimmed to the verb and target — enough to read the path
        // the agent took without dumping the whole transcript.
        detail: b.name === "Bash" ? (b.input?.command || "").replace(/^node \S*figma\.mjs\s*/, "figma ").slice(0, 90) : input.slice(0, 90),
        isCli: CLI_CALL.test(input),
        isSkill: b.name === "Skill",
      });
    }
  }

  const cliCalls = steps.filter((s) => s.isCli);
  return {
    sessionId,
    model,
    steps,
    tools: steps.length,
    cliCalls: cliCalls.length,
    skillInvoked: steps.some((s) => s.isSkill),
    usedCli: cliCalls.length > 0,
    rolledOwn: steps.some((s) => s.rolledOwn),
    subagent: steps.some((s) => s.tool === "Agent" || s.tool === "Task"),
    tokens: { in: inTok, out: outTok, cacheRead },
  };
}

/**
 * Score a trajectory. Three signals, deliberately simple.
 *
 *   + the skill was loaded          it went the intended route
 *   + the figma CLI was called      it used the tool rather than improvising
 *   − it wrote or ran its own code  it bypassed the skill
 *
 * The penalty is the point. An agent that writes its own CDP script can reach
 * the right end state and pass the verdict check while telling you nothing
 * about the skill — that is how a 109-row run once scored 98.2% against a skill
 * it never invoked. Rolling its own is not forbidden (the model may solve it
 * however it likes), but it is the opposite of evidence, so it scores as such.
 *
 * Reported BESIDE the verdict, never folded into it.
 */
export function scoreTrajectory({ trajectory, referenceOutputs }) {
  if (!trajectory) return [{ key: "trajectory", score: null, comment: "no transcript" }];

  const why = [];
  let score = 0;

  if (trajectory.skillInvoked) { score += 0.5; why.push("+skill loaded"); }
  else why.push("-skill never loaded");

  if (trajectory.usedCli) { score += 0.5; why.push(`+${trajectory.cliCalls} cli call(s)`); }
  else why.push("-never called figma.mjs");

  if (trajectory.rolledOwn) {
    score = Math.max(0, score - 1);
    const how = trajectory.steps.filter((s) => s.rolledOwn).map((s) => s.tool);
    why.push(`-WROTE/RAN ITS OWN CODE (${[...new Set(how)].join(", ")})`);
  }

  const out = [{ key: "trajectory", score, comment: why.join("  ") }];

  const budget = referenceOutputs?.trajectory?.max_reads;
  if (typeof budget === "number") {
    out.push({ key: "reads", score: trajectory.cliCalls <= budget ? 1 : 0, comment: `${trajectory.cliCalls} call(s), budget ${budget}` });
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
// Two modes. Bare, it prints the trajectory for a human. With --grade it emits
// skillgrade's { score, details, checks } contract.
//
// WEIGHT THIS 0 in eval.yaml. Trajectory is reported BESIDE the verdict, never
// folded into it: using the skill is preferred, not required, and an agent that
// solves the task another way still passed the task. A non-zero weight would
// turn a style preference into a failure.
if (import.meta.url === `file://${process.argv[1]}`) {
  const t = summarise(pullTranscript());

  if (process.argv.includes("--grade")) {
    const fb = t
      ? scoreTrajectory({ trajectory: t })[0]
      : { score: null, comment: "no transcript found" };
    console.log(JSON.stringify({
      score: fb.score ?? 0,
      details: `${fb.comment}${t?.model ? `  [${t.model}]` : ""}`,
      checks: t ? [
        { name: "skill loaded", passed: t.skillInvoked, message: t.skillInvoked ? "Skill tool used" : "never loaded" },
        { name: "called figma.mjs", passed: t.usedCli, message: `${t.cliCalls}/${t.tools} tool calls` },
        { name: "did not roll its own", passed: !t.rolledOwn, message: t.rolledOwn ? "wrote or ran its own code" : "none" },
      ] : [],
    }));
    process.exit(0);
  }

  if (!t) { console.error("no transcript found"); process.exit(1); }
  console.log(`session  ${t.sessionId}`);
  console.log(`model    ${t.model}`);
  console.log(`tokens   in=${t.tokens.in} out=${t.tokens.out} cache_read=${t.tokens.cacheRead}`);
  console.log(`grounded ${t.usedCli}  (${t.cliCalls}/${t.tools} tool calls were the skill)${t.subagent ? "  ⚠ delegated to a subagent" : ""}`);
  console.log(`\nsteps:`);
  for (const [i, s] of t.steps.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${s.isCli ? "▸" : " "} ${s.tool.padEnd(6)} ${s.detail}`);
}
