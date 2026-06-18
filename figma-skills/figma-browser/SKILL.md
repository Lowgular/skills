---
name: figma-browser
description: Drive a real Chrome over raw CDP to operate Figma's UI — export PNGs/SVGs, find node ids, read designs — without the REST API (quota-immune) and without Playwright MCP. Use whenever Figma ground truth is needed and the REST API is rate-limited or unavailable.
---

# Operating Figma via a real browser (raw CDP)

Drive a **dedicated real Chrome** with playwright-core as a library over CDP. Never Playwright MCP (drops connections, leaves daemons holding profile locks). Never the user's daily Chrome profile.

## FIRST CHOICE: read the design as structured data — `window.figma`

**The Figma web editor exposes the full Plugin API as `window.figma` on the MAIN page** (verified 2026-06-07, design editor, community file; the `__windowDotFigmaOnAccess` global is the lazy-getter hook). Everything below about exports/screenshots is for *pixels*; for **structure — auto-layout, gaps, padding, sizing modes, component property definitions (incl. SLOT-type props), variant props, text styles, variable-bound fills, characters** — read the scene graph directly via `page.evaluate`. No layers-panel scraping, no REST quota, no DOM selectors.

**Executable POM (portable, lives with this skill):** `lib/figma-page.mjs` — `FigmaPage.connect({fileKey})` → `readNode(id, depth)` / `readSelection(depth)` / `watchSelection(cb)` / `selectNode(id)`. Borrows playwright-core from the calling project's node_modules (or `PLAYWRIGHT_CORE_PATH`). The `figma-spec` subagent (`~/.claude/agents/figma-spec.md`) wraps this skill + the Figma→Angular translation language.

In benchmark-runner the same channel is committed as:

```bash
node scripts/figma-browser.ts read <fileKey> <nodeId|selection> [depth=4]
```

Key facts (cost timeouts to learn — don't rediscover):

- `figma.getNodeByIdAsync(id)` accepts both plain ids (`2153:7973`) and instance-path ids (`I175:4454;2162:8659;…` — semicolon path from root instance to nested node, mirrored in the URL when clicking inside instances).
- `figma.currentPage.selection` reads what the user has selected — pair with "click the node you mean" for human-in-the-loop spec reading.
- Use the **Async** API variants (`getMainComponentAsync`, `getStyleByIdAsync`, `figma.variables.getVariableByIdAsync`) — sync ones can throw in dynamic-page mode.
- `boundVariables.color` on a fill → variable id → `getVariableByIdAsync(id).name` gives the design-token name (e.g. `Text/Default/Default`) — this is the token-binding ground truth.
- Component props live on `node.componentProperties` (instances) / `componentPropertyDefinitions` (components/sets). Property types: `TEXT`, `BOOLEAN`, `VARIANT`, `INSTANCE_SWAP`, and **`SLOT`** — a SLOT-type child (node `type: "SLOT"`) is Figma's content-projection slot → maps to `ng-content` in Angular.
- Node `layoutSizingHorizontal/Vertical` = `HUG`/`FILL`/`FIXED` — HUG×HUG ⇒ shrink-wrap (`inline-block` host), FILL ⇒ `w-full`/flex-grow.
- The serializer pattern (paint→hex+variable, autoLayout→dir/gap/padding/sizing, TEXT→characters+font+textStyle, INSTANCE→component+props) is committed in `scripts/figma-browser.ts` (`READ_FN`) — extend that, don't re-write it.
- `page.evaluate` with a STRING evaluates an expression — a bare function source is returned uncalled. Call it inline: `page.evaluate(\`(\${FN_SRC})(\${JSON.stringify(args)})\`)`.

## Setup (once per machine)

```bash
# Dedicated profile + CDP port. Login persists in the profile — one-time.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.figma-chrome" \
  --no-first-run --no-default-browser-check \
  "https://www.figma.com/login" &
```

Liveness check: `curl -sf http://localhost:9333/json/version`.

In benchmark-runner this is wrapped as `node scripts/figma-browser.ts ensure-chrome | inspect | export` — prefer the committed tool there; use the raw pattern below elsewhere.

## Script skeleton (every interaction)

**Run with NODE, not Bun** — Bun's websocket stack can't complete the CDP handshake (connectOverCDP times out; Node attaches instantly). **Write a temp `.mjs` file**, never inline `node -e` (shell quoting mangles escapes).

```js
import { chromium } from "<some-project>/node_modules/playwright-core/index.mjs"; // borrow as a library, no new deps

const browser = await chromium.connectOverCDP("http://localhost:9333", { timeout: 5000 });
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes(FILE_KEY)) ?? (await ctx.newPage());
page.setDefaultTimeout(2500);            // ← CRITICAL: Figma UI renders in <500ms or never.
await page.bringToFront();               //   Playwright's 30s default turns every wrong locator into a 30s stall.
// ... work ...
await browser.close();                   // detaches CDP only; Chrome keeps running
```

Clipboard access (needed for any Copy-as-X export):

```js
const cdp = await ctx.newCDPSession(page);
await cdp.send("Browser.grantPermissions", {
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  origin: "https://www.figma.com",
});
```

## HARD RULES (learned from a file-mutation incident)

1. **ZERO blind canvas position-clicks.** A coordinate click once hit a swap-instance control and **edited the file** (`Slot: Modified`; Cmd+Z didn't recover — fix was right-click → "Reset instance"). Interact ONLY with DOM-targeted elements (`getByText`, `getByLabel`, role locators) or URL navigation.
2. **Select nodes via URL only**, then assert before acting:
   ```js
   await page.goto(`https://www.figma.com/design/${FILE_KEY}/?node-id=${id.replace(":", "-")}`, { waitUntil: "domcontentloaded" });
   // canvas re-init; then:
   const urlNode = (page.url().match(/node-id=([\d-]+)/) ?? [])[1]?.replace("-", ":");
   if (urlNode !== wantedId) throw new Error("selection drift — abort, never act blind");
   ```
3. **Fail fast, look, then retry.** On any locator failure: take `page.screenshot()` to /tmp, READ the image, fix the locator. Never guess a second locator blind — one screenshot costs less than one 30s timeout.
4. **Export instances, not main components.** Component definitions render slot placeholders (grey circles) and different dims. Always export the INSTANCE from an example/usage page, and eyeball every export before trusting it.

## Readiness & navigation facts

- File-loaded signal: `page.waitForSelector('[class*="left_panel"], [data-testid="layers-panel"], [class*="objects_panel"]', { state: "attached" })` — **`attached`, not `visible`** (panel positioner wrappers are zero-size mid-animation and never report visible).
- After `goto` with a node-id the canvas needs ~5–8s to re-init before keyboard shortcuts land. Sleep, don't poll the canvas (it's WebGL — no DOM to poll).
- **Find node ids without clicking:** `Cmd+F` in-file search, scope "All pages", step results — the URL mirrors each selection. Or have the user click while you poll `page.url()` (inspect mode).
- The canvas is WebGL: layer names/menus are real DOM, the design itself is not. All reading of the design goes through exports or the properties panel.

## Menus (exact labels — these cost timeouts to learn)

- Main menu button: `page.getByLabel("Main menu")`.
- Main menu → **Edit** submenu contains **"Copy as ▸"** (NOT "Copy/paste as" — that wording is only in the canvas **right-click context menu**, as "Copy/Paste as ▸").
- Submenus open on `.hover()`; give ~500–800ms between hover steps.
- Keyboard shortcuts are the most robust path when one exists: `Meta+Shift+c` = Copy as PNG.

## Export recipes

**PNG** — `Meta+Shift+c`, then read `image/png` off the clipboard via `navigator.clipboard.read()`. Copy-as-PNG renders at a **FIXED @2x regardless of canvas zoom** (verified at 53% zoom → exact 2× node dims). Box-filter halve to @1x if 1x ground truth is needed. Strip `tEXt/iTXt/zTXt` PNG chunks if provenance hygiene matters.

**SVG** — menu path Edit → Copy as → Copy as SVG (or right-click → Copy/Paste as → Copy as SVG), then `navigator.clipboard.readText()`. Yields one SVG of the whole selection with named groups — split sub-icons by `id` with a committed script.

**Clipboard read pattern** (binary, chunked btoa to avoid call-stack overflow):

```js
const b64 = await page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  for (const item of items)
    if (item.types.includes("image/png")) {
      const bytes = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
  return null;
});
```

## Token discipline

Screenshots of the full Figma window are expensive to read. Prefer, in order:
1. URL reads (free) — selection, node ids
2. `page.evaluate` DOM queries (cheap text) — aria-labels, menu items, properties panel values
3. One targeted screenshot only when a locator failed and the UI state is unknown
