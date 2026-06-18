# figma-skills — skillgrade eval suite

Skill-TDD for the browser-driven Figma skills (`figma-browser`,
`figma-browser-actions`). The agent drives a real Chrome over raw CDP and the
`window.figma` Plugin API — no Figma REST token, no Playwright MCP.

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
PLAYWRIGHT_CORE_PATH=... node preflight.mjs
```

It checks: CDP alive → SDS tab reachable → `window.figma` live (= logged in +
design editor), with an actionable fix for each failure.

## Preconditions

| | |
|---|---|
| Chrome on :9333 | `~/.figma-chrome` profile, logged in |
| SDS file | editable copy at `FIGMA_FILE_KEY` (`.env`) |
| `PLAYWRIGHT_CORE_PATH` | path to a `playwright-core/index.mjs` (`.env`) |
| agent | `--agent=claude` (Claude Code CLI uses its own OAuth) |

## Running

Always **local provider** (browser is on the host) and **serial** (one shared
browser):

```bash
# RED baseline — run with the skills hidden, expect failure (proves the skill is needed)
#   (skills are auto-detected from sibling dirs; move them aside to disable)
npx skillgrade --agent=claude --provider=local --parallel=1 --trials=1

# GREEN — skills present
npx skillgrade --agent=claude --provider=local --parallel=1 --smoke
npx skillgrade preview            # or: preview browser
```

The grader (`graders/check-open-page.js`) scores by **observing the live editor**
(`figma.currentPage`) over CDP — never the agent's self-report — then resets to
the Cover page so each trial starts neutral.

## Portability

`FIGMA_FILE_KEY` is machine-specific (your editable SDS copy). To run elsewhere:
duplicate the community "Simple Design System" into that account's drafts, open
it in the editor, and set the new key in `.env`. Ground-truth fixtures in
`fixtures/` were extracted from this copy via the real Plugin API.
