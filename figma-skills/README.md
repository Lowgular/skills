# figma-skills — skillgrade eval suite

Skill-TDD for the browser-driven Figma skill (`figma-browser`). The agent drives
a real Chrome over raw CDP and the `window.figma` Plugin API — no Figma REST
token, no Playwright MCP.

The skill is one directory with an on-demand KB:

```
figma-browser/
  SKILL.md                    minimal — preconditions, hard rules, "run help to discover"
  references/browser-use.md   why the browser, and what view-only files can't give you
  lib/cdp.mjs                 generic CDP client (connect/evaluate/waitFor). Zero deps.
  lib/connect.mjs             config + Chrome lifecycle
  lib/figma-fns.mjs           page-side Figma code — all domain knowledge
  lib/figma.mjs               the CLI:  login status pages find css vars open
```

Zero dependencies: Node 22+ global `WebSocket` + `fetch` replace playwright.
Discover the tool with `node figma-browser/lib/figma.mjs help`.

## Auth model (read this first)

**Auth is a precondition, not a task step.** The agent never logs in. It
attaches to a **dedicated, already-running, already-logged-in Chrome**:

- Profile `~/.figma-chrome`, remote debugging on port **9333**.
- The Figma session lives in that profile's cookies and **persists across
  restarts** — you log in **once**, manually, and it stays logged in.
- `FigmaPage.ensureChrome()` relaunches the browser if it's down, but it cannot
  log you in. If the session ever expires, log in again in that profile.

Variable/structure reads need `window.figma`, which is only present in the
**design editor** — so the SDS file must be an **editable copy in the account**
(a community-file *preview* is view-only and has no `window.figma`).

Verify all of this before a run:

```bash
node figma-browser/lib/figma.mjs status
```

It checks: CDP alive → file tab reachable → `window.figma` live (= logged in +
design editor), with an actionable fix for each failure. If Chrome isn't up:
`node figma-browser/lib/figma.mjs login`.

## Preconditions

| | |
|---|---|
| Chrome on :9333 | `~/.figma-chrome` profile, logged in |
| SDS file | editable copy at `FIGMA_FILE_KEY` (`.env`) |
| agent | `--agent=claude` (Claude Code CLI uses its own OAuth) |

## The dataset

`dataset.json` is the answer key and the only thing you edit by hand — and in it
you write only the **question**, never the answer:

```
        you write                          the machine writes
  ┌──────────────────────────┐      ┌──────────────────────────────┐
  │ prompt: what a dev asks  │      │ expected: {value,token,var}  │
  │ reads:  which node/var   │ ───► │  ← node extract.mjs --write  │
  │ why:    what makes it    │      │    reads the LIVE file       │
  │         hard             │      └──────────────────────────────┘
  └──────────────────────────┘                   │
                                                 ▼
                                     node build-eval.mjs → eval.yaml
```

```bash
node extract.mjs                 # dry run: what would change, + which node each read hit
node extract.mjs --write         # fill every `expected` block from the live file
node build-eval.mjs              # dataset.json → eval.yaml
```

Expected values are never hand-typed — a hex or a token name typed by a human is
a coin flip. `extract.mjs` reads the same Plugin API that Figma's own Dev Mode
panel reads, and prints the node it landed on (`button → COMPONENT "Variant=…"`)
so you can confirm the case is asking about the node you meant.

**The circularity, stated plainly:** extraction uses the same reader the agent
uses, so it cannot catch a bug that exists in `figma-fns.mjs` *today*. It does
freeze a snapshot, so a regression tomorrow turns the eval red. Present-day
correctness is a human job — spot-check **one case per property kind** (a bound
colour, a radius, a padding set, a font) against Dev Mode, once.

### Case kinds

| kind | success is | grader |
|---|---|---|
| `page` | `figma.currentPage.id` equals the target | `check-open.mjs` — observes the live editor |
| `node` | the node is **selected** (its page will not match — correct) | `check-open.mjs` |
| `values` | `answer.json` matches `expected` key-for-key, normalized | `check-values.mjs` |
| `refuse` | `answer.json` says `refused: true` with ≥2 candidates | `check-values.mjs` |

`values` grading is tolerant about spelling and strict about facts: `#2C2C2C` =
`#2c2c2c`, `8` = `8px`, `12px` = `12px 12px 12px 12px`, `--x` = `var(--x)`,
`Space / 200` = `Space/200`, and nested `{button:{...}}` is accepted for
`"button.…"`. But a right hex with a missing token scores **zero for that key** —
that is the view-only failure mode, and it must not pass. Each key is
all-or-nothing; the check message names the field that broke.

`refuse` is the highest-signal kind. A skill that quietly picks the first match
passes every other case and fails this one.

## Running

Always **local provider** (browser is on the host) and **serial** — `--parallel=1`
is not just about the shared browser. The Claude adapter stages every prompt at
the fixed path `/tmp/.prompt.md` (`dist/agents/claude.js`), so concurrent trials
overwrite each other between write and read and can silently run the wrong task.

```bash
npx skillgrade --agent=claude --provider=local --parallel=1 --smoke
npx skillgrade --agent=claude --provider=local --parallel=1 --trials=1 --eval=button-primary-css
npx skillgrade preview            # or: preview browser
```

For a **RED baseline**, comment out `skill: figma-browser` in `eval.yaml` and
re-run. Do not try to hide the skill by moving the directory: skillgrade looks
for skills only at `<taskdir>/SKILL.md`, `<taskdir>/skills/*`,
`<taskdir>/.agents/skills/*`, `<taskdir>/.claude/skills/*` — `figma-browser/`
matches none of them, so the explicit `skill:` key is the *only* thing injecting
it. (Before that key existed, every run here was an unintentional RED baseline.)

### The answer key never reaches the agent

skillgrade copies a prepared task dir into the agent's cwd, and it writes each
grader's `run:` line verbatim into `<workspace>/tests/test.sh`. An
`EXPECTED_ID=1444:11846 …` there would be a plain-text answer key in the agent's
working directory. So graders receive **`CASE_ID` only** and are invoked by
**absolute path**, reading `dataset.json` from outside the workspace.
`dataset.json` and `eval.yaml` themselves are never copied.

If you add a grader, keep that property: no expected value in the `run:` line.

## Observability

A pass rate cannot tell you *how* a row passed. It matters here because a 109-row
run once scored 98.2% while the agent was loading a different skill of the same
name from `~/.claude/skills` and never calling `figma.mjs` once — and skillgrade
reported `skills_used: ["figma-browser"]` throughout, because the name matched.

So every trial is traced. **Data model and rationale: [LOGGING.md](LOGGING.md).**

```
runs/                          # gitignored
  index.ndjson                 ~250 B per trial — the entry point
  <runId>/
    manifest.json              model, git sha, eval.yaml sha, skill sha
    trials/*.spans.ndjson      the tree: trial → turn → tool call
    blobs/sha256-*.json        payloads over 8 KB, content-addressed
    feedback.ndjson            grader scores, joined after the run
```

Three read costs, so a question never means loading megabytes:

```bash
node logs.mjs                          # summary of the latest run
node logs.mjs --failed                 # index only
node logs.mjs --no-cli                 # rows that never called figma.mjs
node logs.mjs --cost                   # spend per tier
node logs.mjs --trace easy--open-tooltip   # one tree, indented
node logs.mjs --link <results-dir>     # attach skillgrade rewards to traces
```

Traces come from `harness/run-claude.mjs`, which supervises `claude -p` rather
than shelling out to it directly — that is what makes the stream, the real token
counts, and the tool calls available at all. See the note in `build-eval.mjs` for
why the eval uses the `command` agent instead of the built-in `claude` one.

## Portability

`FIGMA_FILE_KEY` is machine-specific (your editable SDS copy). To run elsewhere:
duplicate the community "Simple Design System" into that account's drafts, open
it in the editor, set the new key in `.env`, then `node extract.mjs --write` to
re-derive every expected value against the new copy. The node ids in `reads`
survive duplication; if one does not, `extract.mjs` fails loudly with the node
name it found instead of writing a wrong answer key.
