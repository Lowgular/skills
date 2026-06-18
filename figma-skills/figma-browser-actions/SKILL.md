---
name: figma-browser-actions
description: Verified, replayable recipes for operating Figma through a real Chrome over raw CDP (the ~/.figma-chrome profile, port 9333) — one entry per confirmed action, each with the exact browser interaction that worked. Companion to the figma-browser skill (which holds setup + hard rules); this skill is the growing cookbook of "to do X, run Y". Use when you need to perform a concrete Figma operation (navigate, select, read selection, export, find a node, switch edit/view mode) and want a proven snippet rather than re-deriving it.
---

# Figma browser actions — verified cookbook

Browser-only. **No Figma MCP** (user constraint: every Figma interaction goes
through the real Chrome on their login). See `figma-browser/SKILL.md` for setup,
the `window.figma` channel, and the HARD RULES (no blind canvas clicks, select
via URL only). This file is the replayable action log: each entry is an action
the user confirmed working, plus the exact interaction.

## Conventions for every snippet

- Connect over CDP: `chromium.connectOverCDP("http://localhost:9333")`.
- Borrow `playwright-core` as a library (no new dep). Known path on this machine:
  `/Users/grzegorz.radzio/Desktop/projects/syzygy/pzu/pzu-tests/node_modules/playwright-core/index.mjs`.
- Run with **Node, not Bun**. Write a temp `.mjs`; never inline `node -e`.
- If `/json` lists **0 endpoints**, CDP attach fails with "Browser context
  management is not supported" — force a tab first:
  `curl -s "http://localhost:9333/json/new?https://www.figma.com" -X PUT`.

---

<!-- ENTRIES BELOW — append one per confirmed action -->

The verified interactions are encoded as importable functions in
`lib/figma-actions.mjs` — prefer calling them over re-deriving DOM locators:

```js
import { connect } from "<skill>/lib/figma-actions.mjs"; // Node, not Bun
const fp = await connect({ fileKey });
await fp.selectPage("Header");
const r = await fp.selectFrame({ name: "Blog", size: "1280x100" }); // or { nodeId }
fp.currentNodeId(); await fp.close();
```

Known file: **PZU Component library** — fileKey `vAiG65xbSrWzHprZ0QzO3H`. Its
Pages list (Figma pages, grouped by non-clickable divider rows ATOMS / MOLECULES
/ AREAS / TEMPLATES / PAGES): atoms (AvatarBox, Button, Card, Divider, Image,
Heading, LanguageSelector, Logo, Link, LinkList, …), molecules (AuthorTile,
NewsInfo, NewsTile), areas (**Header**, Footer, UniversalSection), templates
(NewsDetails), pages (ArticlePage, Playground).

---

## Action: `select page` (arg: name)

Activate a Figma **PAGE** node by name in the Pages panel. Side effect: the
Layers tree repopulates with that page's frames (page→layers is parent→child,
not independent navigation). `fp.selectPage("Header")`.

**Why it can fail / what was learned:**
- A synthetic `el.click()` does NOT switch Figma pages — needs a **trusted**
  pointer click (playwright `handle.click()` / locator click).
- Divider rows (`ATOMS`, `AREAS`, `PAGES`, …) are labels, not pages — not
  clickable targets. Match the page name only.
- Works in **view-only** files. `window.figma` is absent there, but the click
  still switches the page; read the result from the URL, not the Plugin API.
- Returns `{ name, nodeId, changed }`. `nodeId` is the **restored selection** on
  that page (a frame), NOT the page node — Figma tracks active-page separately
  from selected-node. `changed:false` just means that page was already active.

Verified 2026-06-08 on `vAiG65xbSrWzHprZ0QzO3H`: `selectPage("Header")` →
active Header page (frames: Klub PZU, Zdrowie, TUW, PZU, Sport, Blog×3, …).

## Action: `select frame` (arg: name, +size/index/nodeId)

Select a **FRAME** node on the **currently active page**. Two modes:
- **Discovery** `{ name, size?, index? }` — clicks the matching Layers-tree row.
- **Replay** `{ nodeId }` — URL-jump straight to the frame
  (`?node-id=<id>`); loads its page AND selects it in one shot, no panel walk.
  Asserts the URL node-id matches (aborts on selection drift).

**Why it can fail / what was learned:**
- Layers rows are `[class*="object_row--row--"]`; top-level frames carry
  `object_row--topLevel--`. Match the `[class*="rowName--"]` child — **NOT**
  `rowText`, whose text is doubled by a placeholder (e.g. `"BlogBlog"`), so an
  `=== "Blog"` test on rowText silently matches nothing.
- Selection (page row / layer row / URL) is **unified** into the URL `node-id` —
  that's how we read the result with no `window.figma`.
- When several frames share a name, the helper returns
  `{ ambiguous:true, candidates:[{index,nodeId,size}] }` instead of guessing —
  disambiguate by `size` (right-panel `Fixed (Npx)`), `index`, or a known
  `nodeId`. `size` only resolves if it's unique among candidates.

## Action: `read specs in a view-only file` (no window.figma)

In view-only files `window.figma` is `undefined` (don't wait on it — race a 4s
timeout around `page.evaluate("typeof window.figma")`; `FigmaPage.readNode`
hangs forever there). The spec channel that DOES work: the **right Properties
panel + full-page screenshots Claude reads visually**.

1. Select the component via `selectPage` + `selectFrame` (above).
2. `page.screenshot()` → read: the panel shows Layout (W/H/Radius), Colors and
   Borders **of the whole selection** (the purple dashed 1px border is Figma's
   component-frame chrome, not the design).
3. If the panel is cut off, scroll IT, not the canvas: `mouse.move(innerWidth -
   110, innerHeight*0.6)` then `mouse.wheel(0, 800)` (get `innerWidth` from
   `page.evaluate` — don't guess from the screenshot, it's scaled).
4. Drill into children **by keyboard, not canvas clicks**: `Enter` selects the
   selection's children (Layers tree expands too), `Tab` cycles siblings. With
   multiple children selected the panel's "Colors" section lists every hex in
   the selection — often enough on its own.

Verified 2026-06-12 on `vAiG65xbSrWzHprZ0QzO3H`: Divider atom (node `394:841`,
240×62 component) → Enter selected children "Default" + "On navy" (200×1 each);
panel Colors listed `#D8D8D8` + `#44689E` → mapped to `--color-border-default`
/ `--color-border-on-navy` tokens. ✅

Verified 2026-06-08: on the Header page, `selectFrame({name:"Blog"})` →
3 candidates: `2435:6179` 375×64 (mobile), `2435:4993` 1280×100,
`2404:3491` 1280×100 (the page-default / "top" desktop blog header).
`selectFrame({nodeId:"2404:3491"})` replay → re-selected, 1280×100. ✅
