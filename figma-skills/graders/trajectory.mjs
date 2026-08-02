/**
 * trajectory.mjs — what the agent DID, not just what it ended up with.
 *
 * Source is Claude Code's own session transcript
 * (~/.claude/projects/<cwd>/<session>.jsonl), not a parsed stdout stream. That
 * file is a superset of --output-format=stream-json: every tool call with its
 * full input, per-message token usage including cache, the resolved model. It
 * also survives the run, so it can be copied out and re-read later.
 *
 * ── Two graders in one file, and the difference matters ─────────────────────
 *
 * REFERENCE-FREE (no --expected). A fixed rubric about process, identical for
 * every row: did it load the skill, did it call the CLI, did it roll its own.
 * It encodes a prior about what good looks like — "small classes are better" —
 * so it is a metric, not a spec. It cannot gate a verdict, because a single
 * row's score means nothing; only the rate across many rows does.
 *
 * REFERENCE-BASED (--expected). Compares the actual trajectory against one the
 * dataset row supplies, in one of five modes. Now it IS a spec: "for THIS task,
 * open then inspect, nothing else." Meaningful on a single row.
 *
 * Modes are borrowed from agentevals (docs.langchain.com/langsmith/
 * trajectory-evals), adapted to steps rather than LangChain messages:
 *
 *   strict      same steps, same order, no extras
 *   unordered   same steps, any order, no extras
 *   superset    every expected step occurs; extras allowed
 *   subset      only expected steps occur; missing allowed
 *   sequence    expected steps occur IN ORDER; extras allowed  ← not in agentevals
 *
 * `sequence` is the addition and it is the one worth having. Real agents pad
 * their trajectories — a `pages` to orient, a `status` to check — and `strict`
 * fails all of that while `superset` cannot express "open BEFORE inspect".
 * A subsequence match says what actually matters: the required steps happened,
 * in the required order, and anything else is the agent's business.
 *
 * ── The step vocabulary ─────────────────────────────────────────────────────
 *
 * Each tool call normalises to a colon-delimited token, narrowest last:
 *
 *   skill:figma-browser          the Skill tool
 *   figma:open:pricing card      a figma.mjs call, with its target
 *   figma:inspect                a figma.mjs call with no target
 *   write / read / bash          anything else, by tool name
 *
 * An expected step matches by PREFIX, so precision is opt-in: `figma:open`
 * matches whatever it opened, `figma:open:pricing card` insists. This inverts
 * agentevals, which compares args by default and needs toolArgsMatchOverrides
 * to relax. Our args are human-typed regexps — comparing them by default would
 * fail on `Pricing Card` vs `^Pricing Card$`, which is the same intent.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OPS = "pages|find|layers|inspect|css|vars|open|help|status|login";
const CLI_CALL = new RegExp(`figma\\.mjs["']?\\s+(${OPS})\\b`);
/** The op and whatever followed it, for the third token segment. */
const CLI_PARSE = new RegExp(`figma\\.mjs["']?\\s+(${OPS})\\b\\s*([^|;&>]*)`);

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
    /**
     * Prefer THIS trial's transcript, not the newest one on the box.
     *
     * Claude Code names a project dir after the cwd it ran in, with every "/"
     * replaced by "-", and skillgrade's local provider gives each trial its own
     * workspace (/tmp/skillgrade-<random>) which it also runs the grader in. So
     * cwd identifies the trial exactly, and one grep beats a timestamp race.
     */
    const mine = join(root, process.cwd().replaceAll("/", "-"));
    const files = [];
    for (const d of existsSync(mine) ? [mine] : readdirSync(root).map((x) => join(root, x))) {
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) files.push(join(d, f));
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

/**
 * One tool call → one comparable token.
 *
 * Lowercased because the expected steps are hand-written in a dataset and
 * "Pricing Card" vs "pricing card" is not a difference anyone means.
 */
function tokenFor(name, input) {
  if (name === "Skill") {
    const s = input?.skill || input?.name || input?.command;
    return s ? `skill:${String(s).toLowerCase()}` : "skill";
  }
  if (name === "Bash") {
    const m = CLI_PARSE.exec(input?.command || "");
    if (!m) return "bash";
    // Strip quotes and flags off the target: `open "Pricing Card" --json` → pricing card
    const arg = (m[2] || "").replace(/--\S+/g, "").trim().replace(/^["']|["']$/g, "").toLowerCase();
    return arg ? `figma:${m[1]}:${arg}` : `figma:${m[1]}`;
  }
  return String(name).toLowerCase();
}

/** Parse a transcript into a trajectory. Pure — unit-testable without Docker. */
export function summarise(jsonl) {
  const lines = jsonl.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!lines.length) return null;

  const steps = [];
  let model = null, sessionId = null;
  let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;

  for (const l of lines) {
    sessionId ??= l.sessionId || null;
    const msg = l.message;
    if (!msg) continue;
    model ??= msg.model || null;
    if (msg.usage) {
      inTok += msg.usage.input_tokens || 0;
      outTok += msg.usage.output_tokens || 0;
      cacheRead += msg.usage.cache_read_input_tokens || 0;
      cacheWrite += msg.usage.cache_creation_input_tokens || 0;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type !== "tool_use") continue;
      const input = JSON.stringify(b.input || {});
      const cmd = b.input?.command || "";
      steps.push({
        tool: b.name,
        token: tokenFor(b.name, b.input),
        rolledOwn: WRITE_TOOLS.has(b.name) || (b.name === "Bash" && ROLLED_OWN.test(cmd)),
        // The command, trimmed to the verb and target — enough to read the path
        // the agent took without dumping the whole transcript.
        detail: b.name === "Bash" ? cmd.replace(/^node \S*figma\.mjs\s*/, "figma ").slice(0, 90) : input.slice(0, 90),
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
    tokens_: steps.map((s) => s.token),
    tools: steps.length,
    cliCalls: cliCalls.length,
    skillInvoked: steps.some((s) => s.isSkill),
    usedCli: cliCalls.length > 0,
    rolledOwn: steps.some((s) => s.rolledOwn),
    subagent: steps.some((s) => s.tool === "Agent" || s.tool === "Task"),
    tokens: { in: inTok, out: outTok, cacheRead, cacheWrite },
  };
}

// ── reference-based matching ────────────────────────────────────────────────

export const MODES = ["strict", "unordered", "superset", "subset", "sequence"];

/** Expected matches actual when it is the whole token or a colon-prefix of it. */
const hit = (expected, actual) => actual === expected || actual.startsWith(expected + ":");

/**
 * Compare an actual step list against an expected one.
 *
 * Returns what matched and what did not, so a failure can say WHICH step is
 * missing rather than just "false" — the whole reason to prefer this over a
 * boolean is being able to read the diff.
 */
export function matchTrajectory(actual, expected, mode = "superset") {
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" — one of: ${MODES.join(", ")}`);

  if (mode === "strict") {
    const ok = actual.length === expected.length && expected.every((e, i) => hit(e, actual[i]));
    return {
      ok,
      missing: ok ? [] : expected.filter((e, i) => !(actual[i] && hit(e, actual[i]))),
      extra: ok ? [] : actual.slice(expected.length),
    };
  }

  if (mode === "sequence") {
    // Subsequence: expected in order, anything else interleaved is fine.
    let i = 0;
    const missing = [];
    for (const e of expected) {
      const at = actual.findIndex((a, j) => j >= i && hit(e, a));
      if (at === -1) missing.push(e);
      else i = at + 1;
    }
    return { ok: !missing.length, missing, extra: [] };
  }

  // Order-insensitive modes share one greedy pass: consume each expected step
  // from a pool of unmatched actual steps, then read off what is left over.
  const pool = [...actual];
  const missing = [];
  for (const e of expected) {
    const at = pool.findIndex((a) => hit(e, a));
    if (at === -1) missing.push(e);
    else pool.splice(at, 1);
  }
  const extra = pool;

  if (mode === "unordered") return { ok: !missing.length && !extra.length, missing, extra };
  if (mode === "superset") return { ok: !missing.length, missing, extra: [] };
  return { ok: !extra.length, missing: [], extra }; // subset
}

/**
 * The reference-free rubric. Three signals, deliberately simple.
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
 */
export function scoreTrajectory(t) {
  const why = [];
  let score = 0;
  if (t.skillInvoked) { score += 0.5; why.push("+skill loaded"); }
  else why.push("-skill never loaded");
  if (t.usedCli) { score += 0.5; why.push(`+${t.cliCalls} cli call(s)`); }
  else why.push("-never called figma.mjs");
  if (t.rolledOwn) {
    score = Math.max(0, score - 1);
    const how = [...new Set(t.steps.filter((s) => s.rolledOwn).map((s) => s.tool))];
    why.push(`-WROTE/RAN ITS OWN CODE (${how.join(", ")})`);
  }
  return { score, comment: why.join("  ") };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
//   trajectory.mjs                                    human-readable trajectory
//   trajectory.mjs --grade                            reference-free rubric
//   trajectory.mjs --grade --mode=sequence \
//                  --expected='["skill","figma:open"]' reference-based match
//
// --expected is a JSON array of step tokens, or the whole object
// {"mode":"...","steps":[...]} as the dataset row stores it. build-eval.mjs
// passes outputs.trajectory through verbatim, so the row controls which tools
// must be called and whether their order matters.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argOf = (n) => {
    const h = process.argv.find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : null;
  };
  const t = summarise(pullTranscript());

  /**
   * Everything the transcript knows that nothing else does, as one parseable
   * check. skillgrade's results JSON records only estimateTokens() guesses and
   * never the model or session, so without this an uploader would have to go
   * find the transcript itself — and it has no way to know which trial's cwd
   * produced which file. This grader has already read it; publishing beats
   * making someone else re-derive it.
   */
  const usage = (x) => ({
    name: "usage",
    passed: true,
    message: JSON.stringify({
      session: x.sessionId, model: x.model,
      in: x.tokens.in, out: x.tokens.out,
      cache_read: x.tokens.cacheRead, cache_write: x.tokens.cacheWrite,
      tools: x.tools, cli: x.cliCalls,
    }),
  });

  if (process.argv.includes("--grade")) {
    const emit = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
    if (!t) emit({ score: 0, details: "no transcript found", checks: [] });

    const raw = argOf("expected");
    if (!raw) {
      const { score, comment } = scoreTrajectory(t);
      emit({
        score,
        details: `${comment}${t.model ? `  [${t.model}]` : ""}`,
        checks: [
          { name: "skill loaded", passed: t.skillInvoked, message: t.skillInvoked ? "Skill tool used" : "never loaded" },
          { name: "called figma.mjs", passed: t.usedCli, message: `${t.cliCalls}/${t.tools} tool calls` },
          { name: "did not roll its own", passed: !t.rolledOwn, message: t.rolledOwn ? "wrote or ran its own code" : "none" },
          usage(t),
        ],
      });
    }

    let spec;
    try { spec = JSON.parse(raw); } catch (e) {
      // A malformed reference must not read as a failing agent.
      emit({ score: 0, details: `grader misconfigured: --expected is not JSON (${e.message})`, checks: [] });
    }
    const steps = Array.isArray(spec) ? spec : spec?.steps;
    const mode = argOf("mode") || spec?.mode || "superset";
    if (!Array.isArray(steps)) emit({ score: 0, details: "grader misconfigured: --expected has no steps array", checks: [] });

    let r;
    try { r = matchTrajectory(t.tokens_, steps, mode); } catch (e) {
      emit({ score: 0, details: `grader misconfigured: ${e.message}`, checks: [] });
    }
    emit({
      score: r.ok ? 1 : 0,
      details: r.ok
        // The RESOLVED model, on both branches. Comparing two runs is
        // meaningless without knowing what answered — and the model is set by
        // an env var outside eval.yaml, so nothing else in the output records it.
        ? `trajectory matches [${mode}]: ${steps.join(" → ")}${t.model ? `  [${t.model}]` : ""}`
        : `trajectory does not match [${mode}]${r.missing.length ? `  missing: ${r.missing.join(", ")}` : ""}${r.extra.length ? `  extra: ${r.extra.join(", ")}` : ""}${t.model ? `  [${t.model}]` : ""}`,
      checks: [
        { name: `mode=${mode}`, passed: r.ok, message: `actual: ${t.tokens_.join(" → ") || "(no tool calls)"}` },
        ...steps.map((e) => ({ name: e, passed: !r.missing.includes(e), message: r.missing.includes(e) ? "not called" : "called" })),
        usage(t),
      ],
    });
  }

  if (!t) { console.error("no transcript found"); process.exit(1); }
  console.log(`session  ${t.sessionId}`);
  console.log(`model    ${t.model}`);
  console.log(`tokens   in=${t.tokens.in} out=${t.tokens.out} cache_read=${t.tokens.cacheRead}`);
  console.log(`grounded ${t.usedCli}  (${t.cliCalls}/${t.tools} tool calls were the skill)${t.subagent ? "  ⚠ delegated to a subagent" : ""}`);
  console.log(`\nsteps:`);
  for (const [i, s] of t.steps.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${s.isCli ? "▸" : " "} ${s.token.padEnd(28)} ${s.detail}`);
}
