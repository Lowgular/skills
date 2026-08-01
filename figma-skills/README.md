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
| SDS file | editable copy, bound as `FIGMA_FILE_SDS` (`.env`) |
| agent | `agent: command` in `eval.yaml` (Claude Code CLI uses its own OAuth) |

## The dataset

**One file: `datasets/rows.jsonl`.** 328 rows, one per line, flat columns. It is
a *snapshot of the live Figma file*, not a build artifact — the same category as
a lockfile, so it is committed. `eval.yaml` is the build artifact.

```
  gen.mjs ──reads the LIVE file──► datasets/rows.jsonl ──filter──► eval.yaml
   (+ fixtures/inventory.json)      328 rows, committed        N tasks, generated
```

| column | | |
|---|---|---|
| `id` | unique, stable **forever** | the join key from any result back to the row |
| `tier` | `easy` \| `medium` \| `hard` | difficulty |
| `type` | `open`, `prop`, `token`, `axes`, `refuse`, … | the capability under test |
| `form` | `prop.fills`, `style.fontsize`, … | the exact question form — 44 of them; the sampling stratum |
| `figma_file` | which design system, as a slug (`sds`) | the key lives in `.env` as `FIGMA_FILE_<SLUG>`, never in the row |
| `tags` | `smoke`, `p1`, … | **the only hand-written column** |
| `task` `note` `graders` | the question, why it's hard, the answer key | |

Everything except `tags` is derived. `gen.mjs` regenerates the derived columns
and carries `tags` forward by id; a curated row the generator stops emitting is
reported and needs `--prune` to lose. The column contract lives in one place —
`datasets/load.mjs` — and `classify()` there throws on an id it cannot place,
so a new question kind cannot silently land outside every filter.

Column names dodge SQL reserved words (`form`, not `group`), so the file is
directly queryable:

```bash
duckdb -c "select type, count(*) from read_json_auto('datasets/rows.jsonl') group by 1 order by 2 desc"
```

```bash
node gen.mjs                     # dry run: row counts + diff vs the current file
node gen.mjs --write             # regenerate from the live file, preserving tags
node build-eval.mjs [filters]    # rows.jsonl → eval.yaml
```

`gen.mjs` prints the review artifact — `+3 rows, -0, 2 answers changed on
existing ids, curation preserved on 31`. Nobody reads 328 lines of JSON; *"2
answers changed"* is the line that should stop a merge.

Expected values are never hand-typed — a hex or a token name typed by a human is
a coin flip. `gen.mjs` reads the same Plugin API that Figma's own Dev Mode panel
reads.

**The circularity, stated plainly:** generation uses the same reader the agent
uses, so it cannot catch a bug that exists in `figma-fns.mjs` *today*. It does
freeze a snapshot, so a regression tomorrow turns the eval red. Present-day
correctness is a human job — spot-check **one case per property kind** (a bound
colour, a radius, a padding set, a font) against Dev Mode, once.

### Selecting rows

Every filterable column is a flag, automatically. **AND across columns, OR
within one**; `--not-<col>` excludes; `*` globs.

```bash
node build-eval.mjs                                  # all 328
node build-eval.mjs --id=open-tooltip                # exactly one row
node build-eval.mjs --id='var-*'                     # glob
node build-eval.mjs --tier=easy,medium               # OR
node build-eval.mjs --tier=hard --type=refuse        # AND
node build-eval.mjs --tags=smoke --not-tags=flaky
node build-eval.mjs --form=prop.fills --limit=5
node build-eval.mjs --tags=p1 --list                 # selection + $ estimate, writes nothing
```

`--list` prints the breakdown by tier / type / form / tag and an estimated cost
from whatever `runs/index.ndjson` has logged. Worth running first: the full
328 × 5 is ~$330. An unknown flag, or a non-numeric `--sample`/`--limit`, is a
hard error — either one silently matching everything would run the whole suite.

### Broad but cheap: stratified sampling

`form` exists to be the sampling stratum. **N of each kind** gives coverage of
every question form without the repetition:

```bash
node build-eval.mjs --tier=easy --sample=1              # 10 rows — every easy form once
node build-eval.mjs --sample=1                          # 44 rows — every form in the suite
node build-eval.mjs --sample=3 --per=type               # 3 per capability
node build-eval.mjs --tier=easy --sample=1 --seed=7     # a different draw, still fixed
```

The draw is deterministic for a given seed — rows are ranked inside their group
by `hash(seed|id)`, so the same seed always picks the same rows, and adding a row
to one group leaves the other groups' picks untouched. That matters: a smoke
suite whose membership drifts makes every pass-rate change ambiguous.

Sampling runs *after* filtering, so `--tier=easy --sample=1` means one per form
within easy. Prefer `--per=form` over `--per=type` for smoke coverage: `style`
is one type but six different questions, and `--per=type` would leave four of
them untested.

Coverage, not distribution — a form with 1 row and a form with 14 both
contribute N. That is the point when the question is "does every question kind
still work?" rather than "what is my pass rate?".

Adding a column to `FILTERABLE` in `datasets/load.mjs` makes it a flag here with
no change to `build-eval.mjs`.

### Grader kinds

One `answer.txt` line per grader, in order — no JSON, so response format is
never what is being measured. `graders/grade.mjs` dispatches on the row's
`graders[]` and receives **`ROW_ID` only**.

| kind | success is |
|---|---|
| `open` | the live editor's page — or selection, for a node — matches the target, observed over CDP |
| `value` | one scalar, normalized |
| `list` | a set, order-insensitive |
| `count` | a number |
| `contains` | fractional recall over expected items |
| `refuse` | says so, and names ≥ N candidates instead of picking one |

`value` grading is tolerant about spelling and strict about facts: `#2C2C2C` =
`#2c2c2c`, `8` = `8px`, `--x` = `var(--x)`, `Space / 200` = `Space/200`. But a
right hex where a token was asked for scores **zero** — that is the view-only
failure mode, and it must not pass.

`refuse` is the highest-signal kind. A skill that quietly picks the first match
passes every other case and fails this one.

## Running

Always **local provider** (browser is on the host) and **serial** — `--parallel=1`
is not just about the shared browser. The Claude adapter stages every prompt at
the fixed path `/tmp/.prompt.md` (`dist/agents/claude.js`), so concurrent trials
overwrite each other between write and read and can silently run the wrong task.

```bash
node build-eval.mjs --tier=hard --type=refuse        # pick the rows first
npx skillgrade --provider=local --parallel=1 --smoke
# no --agent: eval.yaml sets `agent: command`, and --agent=claude would override
# it back to the built-in adapter, which emits final text only and no trace.
npx skillgrade preview            # or: preview browser
```

**Select rows with `build-eval.mjs`, not with skillgrade.** skillgrade's
`--eval=a,b` is an exact-name match over `tasks[]` (`src/commands/run.ts`) — no
regex, no tags — so subsetting there means typing out every task name. Its
`--smoke` / `--reliable` / `--regression` flags are *trial counts* (5 / 15 / 30),
not case subsets; they compose with a filtered `eval.yaml` rather than replacing
one. Filtering at build time also keeps the selection recorded in the generated
file's header.

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
working directory. So graders receive **`ROW_ID` only** and are invoked by
**absolute path**, reading `datasets/rows.jsonl` from outside the workspace.
The dataset and `eval.yaml` themselves are never copied. (`TIER=` is also on the
`run:` line — it is a label `harness/run-claude.mjs` uses to reconstruct the task
name, and grading never reads it.)

If you add a grader, keep that property: no expected value in the `run:` line.

## Starting a session

Four commands. `.env` is auto-loaded by `connect.mjs`, so no `--env-file` needed.

```bash
node environment/box.mjs build     # once per skill change
node environment/box.mjs up        # start the container (Chromium inside it)
node environment/box.mjs login     # ONE-TIME per session: log in, session goes into the box
node evals/run.mjs --smoke    # 5 trials
```

`login` opens Chrome **on your machine**, waits for you to log in, then pipes the
session into the container. That is the only step a script cannot do — Figma
logins are SSO/2FA/password-manager, they need a real window in front of a real
person. It is idempotent: if this machine is already logged in it skips straight
to the transfer, so re-run it whenever the container's session expires.

Everything else lives inside the container. You never see its browser.

```bash
node environment/box.mjs status    # is it up, is window.figma live?
node environment/box.mjs down      # stop (the profile volume survives)
node datasets/pull.mjs        # LangSmith → datasets/rows.jsonl
```

Working on the dataset: edit examples on LangSmith, `pull` to bring them down,
then `run`. LangSmith is the source of truth; `rows.jsonl` is a working copy, so
hand-editing it is lost on the next pull.

## Running the agent in Docker — on the subscription, no API key

**Verified 2026-08-01.** Claude Code runs inside a container against your normal
Claude subscription. It does *not* need `ANTHROPIC_API_KEY`, and the macOS
Keychain (where the desktop token actually lives, service
`Claude Code-credentials`) never has to be read.

```bash
docker run -it --rm <image> claude setup-token     # real TTY required
```

`setup-token` is an OAuth flow with **two copy-paste moments, and the first one
is a trap**: the browser shows an *authorization code* you paste back into the
terminal; only afterwards does it print the **token**. The token starts
`sk-ant-oat01-` and is ~108 characters. Pasting the code instead gives
`401 Invalid bearer token` — which is still progress over `Not logged in`,
because it proves the variable is being read.

It is not persisted anywhere. Pass it in:

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…      # in .env
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN <image> sh -c 'echo "who are you?" | claude -p'
```

Two failure modes worth knowing, both measured:

- **`claude` exits 0 when it is not logged in**, printing
  `Not logged in · Please run /login`. Exit status alone cannot distinguish a
  working trial from one that never reached the model, so `evals/run.mjs` matches
  the text and fails the trial instead of scoring stale browser state.
- **`--bare` would break this.** Its help says Anthropic auth becomes *"strictly
  ANTHROPIC_API_KEY or apiKeyHelper … OAuth and keychain are never read"* — so it
  forces the billing change this avoids, and it also skips hooks, auto-memory and
  CLAUDE.md discovery, quietly changing what is measured.

**Why bother:** a clean container has no `~/.claude/skills`, and a global skill
of the same name beats the one injected into the workspace — measured by
sabotaging the workspace copy and watching the task pass anyway (see `TODO.md`
§0.5). In a container the skill under test is the only one present, so that
whole class of "which artifact did I actually grade?" disappears.

### Figma in a containerised Chromium — what it takes

Tested 2026-08-01 on arm64. It must be **Chromium** (no arm64 Linux Chrome).
Three separate walls, each one a failed run before the flag was found:

```bash
chromium --headless=new --no-sandbox --disable-dev-shm-usage \
  --user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36" \
  --disable-blink-features=AutomationControlled \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --remote-debugging-port=9333 --user-data-dir=/tmp/prof
# plus: docker run --shm-size=2g
```

| wall | symptom | fix |
|---|---|---|
| Figma's CDN blocks the default headless UA | `403 ERROR … Request blocked` from CloudFront | a real desktop `--user-agent` |
| Chrome 151 disables SwiftShader for WebGL | *"We can't open this file because WebGL isn't supported"* | `--use-angle=swiftshader --enable-unsafe-swiftshader` |
| `claude` refuses root | `--dangerously-skip-permissions cannot be used with root` | `USER node` in the Dockerfile |

With those, the editor **renders**: the URL resolves to
`…?node-id=3-5&p=f`, `webgl: true`, and the page is Figma's real editor chrome.

**What is still missing: a logged-in session.** Anonymous access gets the
view-only community preview, which has no `window.figma` — the same limitation
described under *Auth model*. Copying the host profile will not work: Chrome
encrypts its cookie store with a key from the macOS Keychain, so the DB does not
decrypt on Linux. The session has to be established **inside** the container
once and kept in a named volume — either by driving the login over CDP or by
running headful behind Xvfb/VNC for a one-time manual login.

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

A file key is machine-specific — it names one account's editable copy — so no key
appears in the dataset. Rows carry a `figma_file` slug and `.env` binds it:

```bash
FIGMA_FILE_SDS=<key>          # slug `sds` → your copy
```

`connect.mjs config({ file })` resolves it, in this order: `--file=<slug>` →
`FIGMA_FILE=<slug>` (what the harness exports per trial) → the sole binding if
only one exists → an error listing the bound slugs. So a single design system
needs no selector anywhere, and every script that reaches Figma — `figma.mjs`,
`gen.mjs`, `inventory.mjs`, `extract.mjs`, `graders/grade.mjs` — inherits the
same rule from that one function.

To run elsewhere: duplicate the community "Simple Design System" into that
account's drafts, open it in the editor, point `FIGMA_FILE_SDS` at the new key,
then `node gen.mjs --write` to re-derive every expected value against that copy.
Run it without `--write` first — the diff summary tells you how many answers
moved. Expect movement: `open` rows grade on node ids, which differ between
copies, while value rows (`#2c2c2c`, `Space/200`) survive duplication.
