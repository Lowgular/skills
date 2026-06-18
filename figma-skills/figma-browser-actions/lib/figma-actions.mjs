/**
 * figma-actions — replayable Figma UI operations over raw CDP.
 *
 * Companion to ~/.claude/skills/figma-browser/ (setup + hard rules) and the
 * figma-browser-actions SKILL.md (the action cookbook). Browser-only; NO Figma
 * MCP (user constraint). Each function here is a VERIFIED interaction — extend,
 * don't re-derive.
 *
 * Vocabulary follows Figma's own: a "page" is a PAGE node (Pages panel, a whole
 * canvas); a "frame" is a FRAME node (Layers tree, a sized box on a page). The
 * design system's "PAGES" divider (Magnolia page templates) is unrelated — that
 * naming clash is the consumer's problem, not this skill's.
 *
 * Works in VIEW-ONLY files: window.figma is absent there, but panel-DOM clicks
 * still select nodes and the selection is mirrored into the URL's node-id — so
 * we read selection from the URL, not the Plugin API.
 *
 * Run with NODE, not Bun. Import and call; never inline node -e.
 *
 *   import { connect } from "<this>/figma-actions.mjs";
 *   const fp = await connect();
 *   await fp.selectPage("Header");
 *   const cands = await fp.selectFrame({ name: "Blog", size: "1280x100" });
 *   console.log(fp.currentNodeId());
 *   await fp.close();
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP_PORT = 9333;

// playwright-core is borrowed as a library — never a new dependency.
const PW_CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  "/Users/grzegorz.radzio/Desktop/projects/syzygy/pzu/pzu-tests/node_modules/playwright-core/index.mjs",
].filter(Boolean);

async function loadChromium() {
  let dir = process.cwd();
  for (;;) {
    PW_CANDIDATES.push(join(dir, "node_modules", "playwright-core", "index.mjs"));
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of PW_CANDIDATES) if (c && existsSync(c)) return (await import(c)).chromium;
  throw new Error("playwright-core not found — set PLAYWRIGHT_CORE_PATH");
}

const nodeIdFromUrl = (url) => (url.match(/node-id=([\d-]+)/) || [])[1]?.replace("-", ":");

export class FigmaActions {
  constructor(parts) { Object.assign(this, parts); }

  /**
   * Attach over CDP and find (or force) the /design/ tab.
   * GOTCHA: if /json lists 0 endpoints, connectOverCDP fails with "Browser
   * context management is not supported" — force a tab via the HTTP endpoint
   * first, then attach.
   */
  static async connect({ fileKey } = {}) {
    const chromium = await loadChromium();
    // 0-endpoints guard
    try {
      const list = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { stdio: "pipe" }).toString());
      if (!list.length) execSync(`curl -s "http://localhost:${CDP_PORT}/json/new?https://www.figma.com" -X PUT`, { stdio: "pipe" });
    } catch { /* curl/parse best-effort */ }
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 5000 });
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error("no browser context in the dedicated Chrome");
    let page = ctx.pages().find((p) => /figma\.com\/design\//.test(p.url()) && (!fileKey || p.url().includes(fileKey)))
      ?? ctx.pages().find((p) => p.url().includes("figma.com"))
      ?? ctx.pages()[0];
    if (!page) throw new Error("no page in the dedicated Chrome");
    page.setDefaultTimeout(4000);
    await page.bringToFront();
    return new FigmaActions({ browser, ctx, page });
  }

  currentNodeId() { return nodeIdFromUrl(this.page.url()); }

  /** Right-panel Layout dims of the current selection (view-only safe). */
  async readDims() {
    return this.page.evaluate(() => {
      const t = document.body.innerText;
      const all = (t.match(/Fixed \(([\d.,]+)px\)/g) || []).map((s) => s.match(/[\d.,]+/)[0].replace(/,/g, ""));
      return all.length >= 2 ? `${all[0]}x${all[1]}` : null;
    });
  }

  /**
   * ACTION: select page — activate a PAGE node by name in the Pages panel.
   * The Layers tree repopulates with that page's frames as a side effect.
   * Needs a TRUSTED pointer click (handle.click) — a synthetic el.click()
   * does NOT switch Figma pages.
   */
  async selectPage(name) {
    const before = this.page.url();
    const handle = await this.page.evaluateHandle((n) => {
      const norm = (s) => (s || "").replace(/[^A-Za-z0-9]/g, "");
      const rows = [...document.querySelectorAll('[class*="left_panel"] [role="row"], [class*="pages_panel"] [role="row"], [class*="left_panel"] [role="treeitem"]')];
      return rows.find((r) => norm(r.innerText.split("\n")[0]) === norm(n)) || null;
    }, name);
    if (!(await handle.evaluate((e) => !!e))) throw new Error(`page row not found: ${name}`);
    await handle.scrollIntoViewIfNeeded();
    await handle.click();
    await this.page.waitForTimeout(2500);
    return { name, nodeId: this.currentNodeId(), changed: this.page.url() !== before };
  }

  /**
   * ACTION: select frame — select a FRAME node on the ACTIVE page.
   *
   *  - { nodeId }            → REPLAY: URL-jump straight to the frame (loads its
   *                           page + selects it in one shot; no panel walking).
   *  - { name, size?, index? } → DISCOVERY: click the matching Layers-tree row.
   *
   * Layers rows are [class*="object_row--row--"]; match the [class*="rowName--"]
   * child (NOT rowText — a placeholder doubles it to e.g. "BlogBlog"). Top-level
   * frames carry object_row--topLevel--. When several frames share a name,
   * returns { candidates } (node-id + size each) instead of guessing — pass
   * `index` or `nodeId` to disambiguate.
   */
  async selectFrame({ name, size, index, nodeId } = {}) {
    if (nodeId) {
      const fileKey = (this.page.url().match(/design\/([^/]+)/) || [])[1];
      await this.page.goto(`https://www.figma.com/design/${fileKey}/?node-id=${nodeId.replace(":", "-")}`, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(3000);
      const got = this.currentNodeId();
      if (got !== nodeId) throw new Error(`selection drift — wanted ${nodeId}, got ${got}`);
      return { nodeId: got, size: await this.readDims() };
    }
    if (!name) throw new Error("selectFrame needs { name } or { nodeId }");
    // enumerate matching top-level frame rows
    const count = await this.page.evaluate((n) => {
      return [...document.querySelectorAll('[class*="object_row--row--"]')]
        .filter((r) => r.className.includes("topLevel"))
        .filter((r) => { const x = r.querySelector('[class*="rowName--"]'); return x && x.textContent.trim() === n; }).length;
    }, name);
    if (!count) throw new Error(`frame not found on active page: ${name}`);
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const h = await this.page.evaluateHandle(({ n, idx }) =>
        [...document.querySelectorAll('[class*="object_row--row--"]')]
          .filter((r) => r.className.includes("topLevel"))
          .filter((r) => { const x = r.querySelector('[class*="rowName--"]'); return x && x.textContent.trim() === n; })[idx] || null,
        { n: name, idx: i });
      await h.scrollIntoViewIfNeeded();
      await h.click();
      await this.page.waitForTimeout(1000);
      candidates.push({ index: i, nodeId: this.currentNodeId(), size: await this.readDims() });
    }
    let pick;
    if (typeof index === "number") pick = candidates[index];
    else if (size) { const m = candidates.filter((c) => c.size === size); if (m.length === 1) pick = m[0]; }
    else if (candidates.length === 1) pick = candidates[0];
    if (!pick) return { ambiguous: true, name, candidates }; // caller disambiguates
    if (this.currentNodeId() !== pick.nodeId) await this.selectFrame({ nodeId: pick.nodeId });
    return { picked: pick, candidates };
  }

  async screenshot(path) { await this.page.screenshot({ path }); return path; }
  async close() { await this.browser.close(); } // detaches CDP; Chrome stays
}

export const connect = (opts) => FigmaActions.connect(opts);
