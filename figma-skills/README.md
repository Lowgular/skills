# figma-browser

An Agent Skill that reads a Figma design — values, design tokens, variants,
component properties, published styles — by driving the Figma **Plugin API**
inside your own logged-in Chrome. Read-only.

It is one directory. Copy it into your agent's skills folder and you are done;
everything else in this repo exists to prove it works.

```
figma-skills/
├── figma-browser/            ← THE SKILL. This is the part you copy.
│   ├── SKILL.md              60 lines: one command table, six links
│   ├── lib/
│   │   ├── figma.mjs         the CLI: pages find open layers inspect vars styles
│   │   ├── figma-fns.mjs     the functions that run inside the Figma page
│   │   ├── cdp.mjs           raw Chrome DevTools Protocol over a WebSocket
│   │   ├── connect.mjs       finds/starts Chrome, resolves the file, loads .env
│   │   └── session.mjs       reads the logged-in session
│   └── references/           progressive disclosure — read on demand, not up front
│       ├── open.md  layers.md  inspect.md
│       └── components.md  vars.md  styles.md
│
├── eval.example.yaml         ← starter eval: 4 rows, public design system
├── graders/                  how answers are scored
│   ├── score-answer.mjs      prose answers: LLM extracts, plain code scores
│   ├── score-json.mjs        data answers: deterministic structural diff
│   ├── browser-state.mjs     did the browser actually end up on that node
│   ├── trajectory.mjs        how the answer was reached — reports, and can gate
│   └── session-stamp.mjs     hook that records session id + transcript path
│
├── environment/              the container, for repeatable runs
│   ├── box.mjs               build / up / login / seed / status / down
│   ├── Dockerfile  boot.sh  claude-settings.json
│
├── langsmith/                optional: datasets and experiments (see below)
│   ├── build-eval.mjs        generate eval.yaml from a LangSmith dataset
│   ├── upload-experiment.mjs push results back as an experiment
│   └── run-eval.sh           skillgrade + that upload, with a timestamp cutoff
│
└── .env.example              every setting, documented
```

## Use it

```bash
cp -r figma-browser ~/.claude/skills/
```

That is the common case. The skill needs Node 20+, a Chrome it can reach over
the DevTools Protocol, and a Figma file open in the **design editor**.

```bash
node ~/.claude/skills/figma-browser/lib/figma.mjs login    # once, opens Chrome
node ~/.claude/skills/figma-browser/lib/figma.mjs status   # ✓ window.figma live
```

Then ask your agent things like *"what variants does Button have"*, *"what does
Background/Brand/Default resolve to in dark mode"*, *"list every elevation
style"*. The skill's own `SKILL.md` routes it to the right command.

## What was tested

Two design systems, deliberately unalike:

| | rows | what it is |
|---|---|---|
| **Public** | 12 | the Simple Design System (Figma Community) — variables-based, 347 variables, two modes |
| **Private** | 22 | a production design system from a client engagement — **styles**-based, 0 variables, 61 paint styles + 103 text styles |

The second one is why this skill reads styles at all. It was built before Figma
shipped variables, so `vars` returns nothing for it and every colour lives in a
paint style. An early version of the skill was blind to that and reported a
tokenless system — which is why `styles` exists, and why `SKILL.md` says a file
"may use either mechanism, or both".

**The four starter rows**, against a fresh duplicate of the public file, Claude
Sonnet, one trial each — this is the number you can reproduce yourself with the
`eval.example.yaml` in this repo:

```
locate-f6c6586a      PASS  1.00   16s
component-4da43204   PASS  1.00   28s
property-0998e97f    PASS  1.00   48s
vars-40b9b21f        PASS  1.00   23s
```

Three of those grade the route as well as the answer, so a pass means the agent
went through the skill rather than reaching the same place another way.

**The private system**, 22 rows, Claude Opus, one trial each:

```
mean reward   0.945     20 of 22 rows scored 1.00
```

An earlier run of the same suite scored 0.65, and the difference was almost
entirely the graders rather than the agent. Six rows had been failing on defects
in how they were scored: five specs descended into a field before comparing
(`at: "name"` where the answer *is* the object), and one golden encoded shadows
in a form no agent would ever emit. Fixing those, and moving name-based rows
from strict-JSON answers to prose graded by term extraction, moved the suite
from 0.65 to 0.945 without touching the skill.

The two rows still short of 1.00 were also graders, not answers:

- one golden stored `letterSpacing` as the string `"0%"` on three of its fifteen
  entries and as numbers on the rest. The agent reported `0`, which is what
  Figma returns. Golden corrected; that row now scores 1.00.
- one row asked the agent to pick the right variant axis and listed the *other*
  axes' values as forbidden. The agent named the right axis and then tabulated
  the others to show its working — and the extractor attributed those to the
  answer. Measured at 1.00 for a terse answer and 0.00 for a thorough one, so
  the row punished rigour. It now grades its JSON object instead, which ignores
  the surrounding prose.

Both fixes are in the dataset and verified against the answers that exposed
them, but the 0.945 above is the last published run and stands as reported.

Model comparison, on the rows both models completed: Opus recovered two rows
Sonnet scored 0 on, and lost one Sonnet got right. Four rows failed identically
on both — which is what pointed at the graders in the first place.

The pattern worth taking from this: on a suite this size, most of what looks
like model error is grader error, and it only becomes visible if you read the
failures one at a time.

## How it works, and why

The skill executes JavaScript **inside the Figma editor tab**, against
`window.figma` — the same Plugin API a Figma plugin gets. It reaches the tab
over the Chrome DevTools Protocol, using your existing browser session.

```
agent → figma.mjs → CDP WebSocket → your Chrome tab → window.figma → the document
```

**Why this and not the REST API.** REST returns a *rendered* document. Ask it
for a fill and you get `#2c2c2c`; the Plugin API gives you `#2c2c2c` **and**
that it came from `Background/Brand/Default`, which resolves differently in dark
mode. For design-system work the token name is the answer and the hex is a
detail. REST also has per-file rate limits and needs a personal access token
with organisation scope — a credential to provision, rotate and leak.

**Why not the Figma MCP server.** It is a good tool and it costs money per seat,
meters usage, and puts a network hop plus someone else's schema between the
agent and the document. This skill has no token, no quota, no vendor: it uses
the browser session you already have, and every call is local. The trade is
real — you must keep a Chrome window logged in, and there is no headless
CI story without the container below.

**What it cannot do.** A **view-only file has no Plugin API at all** —
`window.figma` is `undefined`, not degraded. Community files opened from a share
link are view-only, so you must duplicate one into your own drafts first. The
skill detects this and stops with instructions rather than falling back to
scraping hex out of the DOM, because a spec built from resolved pixels looks
right and is wrong.

It is also strictly read-only. There is no click path, by design: a coordinate
click once edited a real file and `Cmd+Z` did not recover it.

## Run the evals

### Basic — your own browser

Needs [skillgrade](https://github.com/mgechev/skillgrade) and a Chrome logged
in to Figma.

```bash
npm i -g skillgrade
cp .env.example .env          # set FIGMA_FILE and FIGMA_CHROME_BIN
cp eval.example.yaml eval.yaml
node figma-browser/lib/figma.mjs login    # once
skillgrade
```

Four rows, one per capability — locate a node, read a component's variants, list
the typography groups, resolve a token per mode. Three of them grade the *route*
too (did it go through the skill, via which command), not just the answer.

They run against the Simple Design System, so duplicate it into your own drafts
and put **your** copy’s key
in `FIGMA_FILE`. Node-id rows are per-copy and will not match otherwise.

`.env` is the whole config surface and is gitignored; `.env.example` documents
every key. The two that matter are `FIGMA_FILE` and `FIGMA_CHROME_BIN`.

### Advanced — the container

A local run borrows your real browser and your real skills directory, so a clean
machine and yours disagree. `environment/box.mjs` builds a container with its own
Chromium, its own profile, and no skills but the one under test.

```bash
node environment/box.mjs build
node environment/box.mjs up
node environment/box.mjs login     # ONE-TIME — opens a browser, you log in
node environment/box.mjs status    # ✓ window.figma live
docker exec -it figma-box bash -lc 'cd /work && skillgrade'
```

`login` is the interesting part. Copying a Chrome profile does not work — Chrome
encrypts its cookie store with a key from the macOS Keychain, so it will not
decrypt on Linux. Over CDP the same cookies are plaintext, so `seed` reads them
from your browser and writes them into the container's: your own session moving
between your own browsers. No password, no VNC, no login automation. It survives
container recreation, so `login` really is once.

`--model=` picks which model answers, if your skillgrade has it
([PR #34](https://github.com/mgechev/skillgrade/pull/34)); otherwise export
`ANTHROPIC_MODEL`.

### Claude subscription

The agent under test is the **Claude Code CLI**, invoked as
`claude -p`. It authenticates against a Claude subscription — Pro or Max — not
a pay-per-token API key. Log in once with `claude` on the host; for the
container, `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (generate with
`claude setup-token`).

An `ANTHROPIC_API_KEY` is only needed if you add `llm_rubric` graders. The
graders here do not use one: `score-json.mjs` is pure arithmetic, and
`score-answer.mjs` shells out to the same subscription CLI.

### Advanced — LangSmith

Optional — nothing above needs it. The full suites live as LangSmith datasets
rather than files, and everything for that is in `langsmith/`:

```bash
node langsmith/build-eval.mjs          # dataset → eval.yaml
langsmith/run-eval.sh                  # skillgrade, then upload the results
langsmith/run-eval.sh --model=claude-opus-5
```

`build-eval.mjs` derives each row's graders from the shape of its `outputs`, so
adding a capability means adding a key to the dataset, not editing YAML.
`upload-experiment.mjs` files results as an experiment, which is what makes two
runs comparable over time. Set `LANGSMITH_API_KEY` and `LANGSMITH_DATASET`.

Run them from the repo root — they resolve `eval.yaml` and `graders/` relative
to it, not to `langsmith/`.

`eval.yaml` is gitignored for this reason — it is generated, and a generated
file in git drifts from its source.
