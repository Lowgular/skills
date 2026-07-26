# Eval logging — data model

Design only. Not implemented.

Goal: capture everything a trial did, into a gitignored folder, such that months
later a parser can answer a specific question **without loading megabytes into
context**.

## The core constraint

One trial's raw stream is ~75–320 KB. 328 rows × 5 trials is ~500 MB. So the
store must be readable at three different costs.

| tier | size | answers |
|---|---|---|
| `index.ndjson` | ~250 B / trial | which rows failed, what they cost, did they use the CLI |
| `*.spans.ndjson` | ~5–50 KB / trial | what happened, in order, as a tree |
| `blobs/` | up to MB | the actual tool output / full text |

A question like "which rows bypassed the skill" reads **only the index**. Drilling
into one row reads one spans file. A blob is opened only when someone asks for
that specific payload. Context cost stays bounded no matter how big the store gets.

## Borrowed from LangSmith

Researched 2026-07-26 (`docs.langchain.com/langsmith/run-data-format`).

1. **`dotted_order`** — a sortable key encoding the full path:
   `<ts>Z<root_id>.<ts>Z<parent_id>.<ts>Z<own_id>`.
   Invariants: first UUID = `trace_id`, last = own `id`, penultimate = parent.
   Lexicographic sort = depth-first order; prefix match = all descendants. This
   is what makes a flat NDJSON file queryable as a tree with `grep` and `sort`,
   with no index and no recursion. Timestamps need microsecond precision
   (`20260726T083500123456Z`) or sibling spans tie.
2. **Feedback is a separate record**, keyed by run id — not a field on the run.
   Fits our sequencing exactly: the grader runs *after* the agent returns, so it
   cannot write into the agent's span.
3. **`run_type`** as a closed taxonomy. LangSmith uses
   llm/chain/tool/retriever/embedding/prompt/parser. We need three: `chain`
   (trial), `llm` (turn), `tool` (tool call).
4. **Flattened tokens/cost** on the span rather than nested.
5. They cap at 25k runs/trace and 400-day retention — evidence that unbounded
   retention is a mistake worth pre-empting.

## Folder layout

```
runs/                                   # GITIGNORED
  index.ndjson                          # append-only, every trial ever — the entry point
  20260726T083500Z-a8xw/                # one skillgrade invocation ("project")
    manifest.json
    trials/
      easy--open-tooltip.1.spans.ndjson
      easy--open-tooltip.1.raw.ndjson   # verbatim claude stream, optional, prunable
    feedback.ndjson
    blobs/
      sha256-3f2a…json
```

Run ids are `<utc-compact>Z-<4 rand>` so `ls` sorts chronologically and two runs
in the same second don't collide.

**Blobs are content-addressed.** The output of `figma.mjs pages --json` is
byte-identical across all 109 rows, so it is stored once. Given how repetitive
eval tool calls are, this is the difference between ~500 MB and something far
smaller.

## Span record

One JSON object per line. Flat, stable names, versioned so a future parser can
handle old runs.

```json
{
  "v": 1,
  "dotted_order": "20260726T083500123456Z<uuid>.20260726T083501234567Z<uuid>",
  "id": "<uuid>",
  "trace_id": "<uuid>",
  "parent_id": "<uuid>|null",
  "run_type": "chain|llm|tool",
  "name": "trial|turn|Bash|Skill|Read|Agent",
  "start": "2026-07-26T08:35:00.123456Z",
  "end":   "2026-07-26T08:35:04.001234Z",
  "status": "success|error",
  "error": null,
  "attrs": {},
  "inputs":  {"command": "node …/figma.mjs pages --json"},
  "outputs": {"$blob": "sha256-3f2a…"},
  "tokens": {"in": 8, "out": 893, "cache_read": 158584, "cache_write": 24032},
  "cost_usd": 0.205
}
```

`inputs`/`outputs` are inline when small, `{"$blob": …}` when over a threshold
(8 KB). One indirection keeps spans files small while losing nothing.

### The three span types

- **`chain` / `trial`** — root. One per trial. `attrs` carries the identity that
  makes joins possible:
  `{tier, task, trial, workspace, claude_session_id, model, deny_tools,
    skill_resolved_path, skill_content_sha}`.
- **`llm` / `turn`** — one per assistant event. Tokens and cost per turn, plus
  `thinking_chars` so reasoning volume is measurable without storing it inline
  (full thinking text goes to a blob).
- **`tool`** — one per `tool_use`, child of the turn that issued it. `inputs` is
  the tool input, `outputs` the matching `tool_result`.

`skill_content_sha` is deliberate: today's lesson was a 109-row run that measured
a different skill of the same name. Hashing the skill that was actually resolved
makes that detectable from the index alone.

## Index line

One per trial, ~250 bytes. The whole index for 328 rows × 5 trials is ~400 KB —
still greppable, and the summary fields answer most questions outright.

```json
{"v":1,"run":"20260726T083500Z-a8xw","task":"easy--open-tooltip","trial":1,
 "tier":"easy","model":"claude-sonnet-5","reward":1.0,
 "turns":14,"cost_usd":0.511,"tokens_out":3993,"duration_ms":80500,
 "tools":11,"used_cli":false,"foreign_skill":true,"subagent":false,"denials":0,
 "trace_id":"<uuid>","workspace":"skillgrade-a8xwgr",
 "claude_session_id":"baea915b-…","skill_sha":"sha256-9c1d…",
 "spans":"20260726T083500Z-a8xw/trials/easy--open-tooltip.1.spans.ndjson"}
```

The booleans (`used_cli`, `foreign_skill`, `subagent`) are computed once at write
time rather than re-derived by every reader. That is the whole lesson of the
tool this replaced: it inferred the same facts afterwards by regex over command
strings, read a field that did not exist, and so reported "used the CLI 0/109"
as clean for 109 rows that had genuinely bypassed the skill. Record at the source;
never reconstruct.

## Feedback record

```json
{"v":1,"trace_id":"<uuid>","key":"reward","score":1.0,
 "grader":"deterministic","details":"✓ open 280:23459","ts":"…"}
```

Separate file, appended after grading. Multiple graders per trial = multiple
records. Keeps the agent's spans immutable once written.

## manifest.json

Everything needed to reproduce or invalidate a run: git sha of the repo, sha of
`eval.yaml`, sha of the skill dir, tier, row filter, model, `DENY_TOOLS`, the
skillgrade version, provider, trials, and the resolved skill path. Without this,
comparing two runs' numbers is guesswork — which is exactly the confound that
made the Sonnet-vs-vocabulary comparison unattributable.

## Writing discipline

- **Append-only, flush per line.** A killed run must leave a valid partial file;
  every line independently parseable.
- **Never buffer a whole trial in memory** — write spans as events arrive, so a
  timeout still yields a usable trace.
- **Absolute log root, outside the workspace.** Learned the hard way: with the
  `harness/` workspace mapping, `TRACE_DIR` resolved inside the temp workspace
  and `provider.cleanup()` deleted the trace.

## Retention

`index.ndjson` is small — keep forever. `raw.ndjson` and `blobs/` are the bulk —
prune beyond the last N runs, or after a release baseline is recorded. Pruning
blobs is safe as long as the index and spans survive: what's lost is payload
detail, not the audit trail.

## Future parser (not now)

`node logs.mjs` over the index, e.g.:

- `--failed --tier=hard` — reward < 1
- `--no-cli` — rows that never called `figma.mjs`
- `--cost --group-by=tier`
- `--trace <task>` — pretty-print one tree (sort the spans file by
  `dotted_order`; indent by counting dots)
- `--diff <runA> <runB>` — rows that flipped, which is the delta-gate the tiering
  plan needs

Every one of those reads the index only, except `--trace`.
