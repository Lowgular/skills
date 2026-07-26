# TODO — deferred, do not implement yet

Lives outside `figma-browser/` on purpose: notes about the skill, not part of it.

## 1. Capability lost when the global Figma skills were removed

`~/.claude/skills/figma-browser` is now a **symlink** to `figma-skills/figma-browser`,
so one artifact serves both the evals and every session on this machine. The two
skills it replaced are preserved at `~/.claude/skills-replaced/` (2026-07-26).

What they could do and we can't:

| gap | was in | notes |
|---|---|---|
| PNG / SVG **export** | old `figma-browser` | read-only in effect — safe to add |
| **screenshot** of canvas or node | `figma-browser-actions` | read-only — safe to add |
| edit ↔ view **mode switch** | `figma-browser-actions` | mutates editor state, not the file |
| DOM **clicking** / panel navigation | `figma-actions.mjs` | **do not restore** — see boundary below |
| `FigmaPage` POM (`FigmaPage.connect`) | `figma-page.mjs` | the `figma-spec` agent imports this |

### The read-only boundary

`export` and `screenshot` don't mutate the file, so adding them keeps SKILL.md
rule 1 and the eval's premise intact. **Clicking does not belong back in.** Rule 2
exists because a coordinate click once edited a real file and `Cmd+Z` did not
recover it. If clicking ever returns it needs its own skill, not this one.

## 2. Broken right now

`~/.claude/agents/figma-spec.md` — its operating procedure (lines 22–27) reads
`~/.claude/skills/figma-browser/SKILL.md`, then imports
`lib/figma-page.mjs` and calls `FigmaPage.connect({ fileKey })`. Through the
symlink that module no longer exists. Either port the agent to the `figma.mjs`
CLI or retire it.

(It was also one of the eval bypass routes — a passing row delegated the whole
task to it — so leaving it broken helps eval integrity in the short term.)

## 3. Skill bugs, deliberately reverted

Both were found, fixed, verified, then reverted on request so the skill matches
the state the datasets were built against. They are still bugs:

- **`vars` truncates silently.** `figma-fns.mjs:481` caps at 40 per collection.
  The file has 347 variables; `vars "."` returns 45 and reports `count: 45` with
  no truncation flag. Makes `count-vars-color-primitives` (answer: 100)
  unanswerable, and threatens the hard tier's 111 `list` graders.
- **Alpha is unrounded.** `figma-fns.mjs:466` returns `alpha: raw.a` →
  `0.699999988079071`, while line 252 in the same file uses `_round`.

Fix verified earlier: two-pass enumeration + `matched`/`truncated` fields and a
`--limit` flag; `_round(raw.a)`.

## 4. Dataset

- 2 easy rows expect `#ffffff` for a colour that is white at 70% / 40% alpha
  (`var-text-default-secondary-sds-dark`, `var-text-default-tertiary-sds-dark`).
  The expected answer describes a colour not in the file. Split into a hex row
  and an alpha row rather than teaching the grader to accept `rgba()` — 50 other
  rows depend on the "speak Figma, not CSS" rule holding.
- SKILL.md never says how to report a two-component value. That silence is why
  the model fused them into `rgba(255,255,255,0.7)`.

## 5. Harness

- **Guardrail unused.** `DENY_TOOLS=Agent` in `run-claude.mjs` would close the
  subagent bypass. Off by default.
- **Blob spill untested.** Nothing in the rows run so far exceeded the 8 KB
  threshold. A row calling `vars` (~75 KB output) is what exercises it.
- **Subagent nesting is unverified.** `--forward-subagent-text` is on and
  forwarded messages are nested under the `Agent` span via `parent_tool_use_id`,
  but no row has delegated since the shadow skill was removed, so the code path
  has never executed. Needs a row that actually delegates (previously
  `type-title-hero-fontsize`, `axes-avatar`).
- With forwarding on, a `figma.mjs` call made *by a subagent* counts toward
  `used_cli`. Watch `subagent: true` if what matters is the main agent using the
  skill directly.

Resolved: the workspace-mapping trace deletion (reverted to an absolute command
path) and `report.mjs` (deleted — `logs.mjs` records what it used to infer).

## 6. Upstream skillgrade (repo at ~/Desktop/projects/oss/skillgrade)

- **Skill injection is unverified.** A different skill of the same name shadowed
  ours and `skills_used: ["figma-browser"]` still reported success — 109 rows
  measured the wrong artifact. Record the resolved path + content hash, and warn
  on a name collision with `~/.claude/skills`.
- **`command` is not scanned for relative file refs.** `prepareTempTaskDir`
  copies dirs referenced from `graders[].run` only, so `command: "node
  mycli.js"` (README:273) fails with MODULE_NOT_FOUND. Verified empirically.
- **`input_tokens`/`output_tokens` are `estimateTokens()` guesses**
  (`evalRunner.ts:280`), not real usage.
- **`agent_output` is a phantom field** — text lives at
  `session_log[].agent_result.output`.
- **Logger + `--stream`** — `LogEntry` is already an event model and
  `loggedRunCommand` is already the seam; `spawn` already handles `data` events
  and drops them. Sinks: memory / file / stdout.
