# TODO — deferred, do not implement yet

Lives outside `figma-browser/` on purpose: notes about the skill, not part of it.

## 0. LangSmith dataset schemas — removed 2026-08-01, revisit later

`inputs_schema_definition` / `outputs_schema_definition` were set on the
`figma-read` dataset and then cleared the same day. They cost more than they
gave while the row shape is still moving.

**Why they hurt now.** LangSmith validates *existing* examples when a schema is
applied, not just new writes. So any shape change becomes a three-step dance —
clear the schema, migrate every row, re-apply — for what should be a one-line
edit. Renaming `context.start_page` to `context.browser` on a **one-row**
dataset needed exactly that.

**Why they are still worth having eventually.** `additionalProperties: false` is
what would have caught the real drift: a stray `selection` or `node` key, or a
dataset description that documents a shape no example uses any more. Prose
conventions rot silently; a schema fails loudly at write time.

**Revisit when the shape stops moving** — concretely, once `read-values` and
`refuse` rows exist and `outputs` has held still across all three capabilities.
Then a schema locks a shape that has earned it, instead of freezing a guess.

## 0.5 Skill isolation — the workspace copy does not win (measured 2026-08-01)

**The finding.** A workspace copy of `figma-browser` was placed at
`<cwd>/.claude/skills/figma-browser` and **sabotaged** — `lib/figma.mjs`
replaced with `exit 3`. The task still succeeded. The agent loaded
`~/.claude/skills/figma-browser` instead. A softer sentinel test (an added
SKILL.md instruction) agreed: the workspace copy's instruction was never obeyed.

**What it invalidates.** `evalContext()` hashes `<cwd>/.claude/skills/...` into
`skill_sha`, so the manifest fingerprints a directory that did not run. No
number so far is wrong — the global entry is a symlink back to this repo (§1),
so the bytes are identical — but the isolation is fictional, and skill-TDD
breaks the moment you want to A/B a modified skill: the workspace copy is
ignored and the eval keeps grading the global one.

**What does not fix it.** Overriding `HOME` for the child so `~/.claude` moves:
Claude Code's credentials do not follow, and the agent lands on
`Not logged in · Please run /login`. Symlinking `.credentials.json` /
`.claude.json` into the fake home did not help.

**What is in place now.** `evals/run.mjs` preflights and REFUSES to run while
`~/.claude/skills/figma-browser` exists, printing the `mv … .off` fix.
`--allow-global-skill` opts out knowingly. Loud beats silently-wrong.

**Docker — evaluated 2026-08-01, DROPPED.** skillgrade ships a `docker` provider
that would solve this properly: it builds from a clean base and injects only the
named skills into `/workspace/.claude/skills`, so there is no global skill to
shadow anything. What it costs, measured rather than guessed:

- **Auth.** `claude` in a bare container prints `Not logged in · Please run
  /login` — and **exits 0**. The subscription token is in the macOS Keychain
  (service `Claude Code-credentials`), which a Linux container cannot read.
  `claude setup-token` ("long-lived token, requires Claude subscription") is the
  supported bridge and avoids `ANTHROPIC_API_KEY`, but it is an interactive OAuth
  flow needing a real TTY, and skillgrade's provider has **no volume mounts**
  (`HostConfig` is only `NanoCpus` + `Memory`), so a token would ride in as an
  env var visible to `docker inspect`.
- **Browser.** arm64 host ⇒ Chromium, not Chrome (no arm64 Linux build). Chromium
  image builds fine. Untested and the real risk: whether Figma's WebGL editor and
  `window.figma` work headless in a container. The Figma profile would need its
  own named volume and a one-time login.
- **No mounts also means no traces** — `cleanup()` force-removes the container,
  so the span store would have to be extracted with `getArchive` or it is lost.

Decision: not worth it now. The provider is built for API-key agents; making a
subscription work inside it is a workaround, not a fix. Revisit only if hermetic
CI becomes the goal.

**Kept from the exercise:** `claude` exiting 0 while unauthenticated is a real
harness bug — `evals/run.mjs` now detects the not-logged-in output and fails the
trial instead of scoring stale browser state.

**Still open.** Whether a Claude Code setting can disable global skill discovery
per-run. That would give isolation without renaming a symlink or containerising.

## 0.6 `npx skillgrade --provider=docker` — 90% there, parked 2026-08-01

The goal: no custom runner. `eval.yaml` with `agent: claude` + `provider: docker`,
skillgrade owns the container lifecycle. Everything is written and in the repo
(`eval.yaml`, `environment/Dockerfile`, `boot.sh`, `seed.mjs`,
`graders/browser-state.mjs`). **It does not pass.**

What works: image builds, skill injected into `/workspace/.claude/skills`, agent
authenticates and runs, graders execute in-container, and the agent escalates
correctly when the browser is missing.

**The one blocker: the browser never starts in skillgrade's container.** Grader
reports `no page target on :9333 after 30s`. Ruled out by measurement:

- Not the commit — `docker commit` preserves `User=node` and
  `Entrypoint=[/workspace/environment/boot.sh]`; verified by replicating
  create → exec → commit, and a container from that image boots fine.
- Not CPU starvation — `cpus: 2` → `8` changed nothing.
- Not the image — a container run by hand from the same image seeds in <30s
  (`seed: window.figma live (18 cookies)`, 8 chromium processes).

So it is something in `setup()`'s `createContainer` (`Tty: true`, `Env` list,
`NanoCpus`/`Memory`, no `--shm-size`) or in how prepare()'s temp container —
which also runs the ENTRYPOINT and starts a Chromium — leaves `/profile` before
it is committed. Next step would be to keep a failed container alive and read
`/tmp/chrome.log` inside it; skillgrade force-removes it on cleanup, so that
needs a patch or a `--keep` flag.

**Two things that would still be wrong even once it boots:**

1. **The answer key lands in the sandbox.** `provider.runCommand` is
   `container.exec`, so graders run in the agent's cwd and `EXPECTED_NODE_ID`
   sits in `tests/test.sh`. The host-side setup deliberately avoids this
   (absolute-path graders reading the dataset outside the workspace). Tolerable
   only for browser-state rows — knowing a node id does not let an agent fake
   having navigated there. It breaks for any row whose answer is text.
2. **Cold browser per trial.** No volumes, container per trial, so Figma boots
   from scratch every time. The warm box does 8–25s per trial, measured. For
   this skill the "scalable" option is the slower one, because the expensive
   part cannot be shared.

**Fixes found along the way that are worth keeping regardless:**

- `IS_SANDBOX=1` — skillgrade execs as root despite `USER node`, and `claude`
  refuses `--dangerously-skip-permissions` as root. Set it in `.env`; the image
  `ENV` does not reach the exec.
- The built-in `claude` agent's plain `-p` is no longer a reason to avoid it:
  diagnostics come from Claude Code's session transcript, not stdout.

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

### Multi-file: what is left before a SECOND design system works

The slug indirection is in and verified against one file (`sds`): rows carry
`figma_file`, `.env` binds `FIGMA_FILE_<SLUG>` → key, `connect.mjs config({file})`
resolves, and no key crosses a process boundary. Remaining, all only needed once
a second slug exists:

- **`gen.mjs` overwrites.** `writeFileSync(ROWS_PATH, out…)` keeps only what it
  just generated, and the orphan guard is `removed.filter(r => r.tags?.length)` —
  with every row at `tags: []`, generating against a second file would silently
  drop all 328 `sds` rows without even asking for `--prune`. Must merge on
  `figma_file`, keeping rows from other slugs untouched. **Do this before
  pointing `gen.mjs` at anything new.**
- **Key rows on `(figma_file, id)`.** Both files will produce `open-tooltip`, and
  `loadRows` throws on a duplicate id — correctly, but it blocks the merge. Do
  not namespace the id instead: `classify()` reads `parts[0]` and, for
  `suffix: "last"` rules, the final segment, so `prop-…-fills@mui` would
  classify as form `prop.fills@mui`. `rowById` becomes `rowById(file, id)`, and
  the grader's `run:` line already carries `FIGMA_FILE` to pass it.
- **Pre-open a tab per file.** `cdp.mjs` matches targets by URL substring so
  concurrent files are fine, but a file with no open tab pays `connect()`
  opening one and polling ~20× on its first trial.
- **A row whose slug is unbound** currently reaches `config()` and errors per
  trial. Cheaper to refuse at build time: `build-eval.mjs` knows every selected
  row's slug and could check the bindings once.

### Answers

- 2 easy rows expect `#ffffff` for a colour that is white at 70% / 40% alpha
  (`var-text-default-secondary-sds-dark`, `var-text-default-tertiary-sds-dark`).
  The expected answer describes a colour not in the file. Split into a hex row
  and an alpha row rather than teaching the grader to accept `rgba()` — 50 other
  rows depend on the "speak Figma, not CSS" rule holding.
- SKILL.md never says how to report a two-component value. That silence is why
  the model fused them into `rgba(255,255,255,0.7)`.

## 4.5 Trial reset — solved 2026-08-02, with two constraints left

skillgrade has **no pre-task hook**. Checked against the installed source, not
the README: `dist/core/config.types.d.ts` has exactly two `setup` fields —
`docker.setup` and `graders[].setup` — and `dist/commands/run.js:317-325` emits
both as Dockerfile `RUN` lines at image build. Neither runs per trial, and
`graders[].setup` never runs at all under `provider: local`. The lifecycle in
`evalRunner.runSingleTrial` is `provider.setup` (file copy only, no command) →
`agent.run` → graders → `cleanup`. There is no seam before the agent.

So the reset moved into the **skill**, on its way in: `maybeReset()` in
`figma.mjs`, called from `withFigma` — the funnel every read operation already
passes through. Off unless `FIGMA_RESET_ON_CONNECT` is set, which only
`box.mjs up` sets; a human's browser position is theirs. Latched once per cwd,
because every operation is its own process and skillgrade's local provider
gives each trial a fresh workspace dir — without the latch, `inspect` would
wipe what `open` just selected and no task could ever complete.

A grader-side reset was built first and removed: too late to define a start
state, and a second copy of the definition of "neutral" to keep in sync.

Three things this does not cover:

- **An agent that never calls the skill** cannot trigger the skill's reset, so
  it grades against the previous trial's leftovers. Scores 0 on its own merits
  unless that leftover happens to be this row's answer.
- **`--parallel` is unusable.** One browser, so concurrent trials would reset
  each other mid-measurement. Trials must stay sequential. Nothing enforces it.
- **A row whose answer IS the neutral node** (`Cover`, `3-5` in the SDS copy)
  would auto-pass, because reset parks the browser exactly there. No such row
  exists; it is a trap for whoever adds a "go to the cover page" row.

Found on the way: **the URL lags the Plugin API by 1-2s.** Figma pushes history
asynchronously, so a grader reading `location.href` the instant the agent stops
can see the *previous* position. This produced a false pass in testing — the
reset moved Figma to `Cover` but `node-id=1444-11846` was still in the address
bar, so the next read scored 1 against a browser that had done nothing. The
grader now waits for the URL, but only in the direction that cannot manufacture
a pass. Any future grader reading the URL needs the same care.

## 5. Harness — STALE, the harness is deleted

Kept only for the two notes that outlived it (blob spill, subagent nesting).
Everything referencing `run-claude.mjs` describes code that no longer exists.



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
- **No per-trial `setup` hook.** Any skill driving a stateful external resource
  (a browser, a DB, a logged-in session) needs to reset between trials, and
  there is nowhere to put it: the two existing `setup` fields are build-time
  Dockerfile `RUN`s. Without one, `trials > 1` silently measures inherited
  state — trial 2 passes on trial 1's leftovers. A `setup:` sibling to
  `instruction`, run through `provider.runCommand` before `agent.run`, is a
  handful of lines in `runSingleTrial`. Worth a PR.
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
