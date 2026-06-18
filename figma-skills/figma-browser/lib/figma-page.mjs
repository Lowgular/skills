/**
 * FigmaPage — page-object model for operating Figma through a real Chrome
 * over raw CDP. Two layers:
 *
 *   DATA layer (selector-free): the Figma web editor exposes the full Plugin
 *   API as `window.figma` on the main page. Reading structure (auto-layout,
 *   component props incl. SLOT, text styles, variable-bound fills) goes
 *   through the scene graph — never through panel scraping.
 *
 *   ACTION layer (DOM locators + keyboard): the few UI operations that have
 *   no API equivalent (export, search). Locators here are VERIFIED ones —
 *   each cost timeouts to learn; extend, don't guess new ones blind.
 *
 * HARD RULES (from the 2026-06-06 file-mutation incident):
 *   - ZERO blind canvas position-clicks (a coordinate click once EDITED the
 *     file via a swap-instance control). Select nodes via URL only.
 *   - Assert the URL's node-id equals the requested node before acting.
 *
 * Runtime: NODE, not Bun (Bun's websocket stack can't complete the CDP
 * handshake). playwright-core is borrowed as a library from any reachable
 * node_modules — pass its path or rely on the candidate search.
 *
 * Usage:
 *   import { FigmaPage } from "~/.claude/skills/figma-browser/lib/figma-page.mjs";
 *   const fp = await FigmaPage.connect({ fileKey });   // attaches, finds/opens the tab
 *   const spec = await fp.readNode("2153:7973", 3);    // structured spec JSON
 *   const sel  = await fp.readSelection(3);            // what the human selected
 *   await fp.watchSelection((id) => console.log(id));  // human-in-the-loop
 *   await fp.close();                                  // detach CDP; Chrome stays
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP_PORT = 9333;
const PROFILE_DIR = join(homedir(), ".figma-chrome");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------------------------------------------------------------------------
// playwright-core resolution — borrowed, never a new dependency
// ---------------------------------------------------------------------------

async function loadChromium(explicitPath) {
  const candidates = [explicitPath, process.env.PLAYWRIGHT_CORE_PATH].filter(Boolean);
  // Walk up from cwd: <dir>/node_modules/{playwright-core,playwright}/index.mjs.
  // (Subpath require.resolve is blocked by the packages' exports maps, so look
  // for the file directly.)
  let dir = process.cwd();
  for (;;) {
    for (const pkg of ["playwright-core", "playwright"]) {
      candidates.push(join(dir, "node_modules", pkg, "index.mjs"));
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    if (existsSync(c)) return (await import(c)).chromium;
  }
  throw new Error(
    "playwright-core not found — run from a project that has playwright(-core) installed, " +
      "or set PLAYWRIGHT_CORE_PATH to its index.mjs",
  );
}

// ---------------------------------------------------------------------------
// Scene-graph serializer (runs INSIDE the page; plain JS string — no typings)
// ---------------------------------------------------------------------------

export const READ_FN = `async ({ nodeId, depth }) => {
  if (typeof figma === "undefined") return { error: "window.figma not present — open the file in the design editor (not viewer) and retry" };
  async function varName(id) {
    try { const v = await figma.variables.getVariableByIdAsync(id); return v ? v.name : id; } catch { return id; }
  }
  async function paints(arr) {
    if (!arr || !arr.length) return undefined;
    const out = [];
    for (const f of arr) {
      if (f.visible === false) continue;
      if (f.type === "SOLID") {
        const hex = "#" + [f.color.r, f.color.g, f.color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
        const v = f.boundVariables && f.boundVariables.color;
        out.push({ type: "SOLID", hex, opacity: f.opacity, variable: v ? await varName(v.id) : undefined });
      } else out.push({ type: f.type });
    }
    return out;
  }
  async function ser(node, d) {
    const o = { id: node.id, name: node.name, type: node.type };
    try { o.size = { w: Math.round(node.width * 100) / 100, h: Math.round(node.height * 100) / 100 }; } catch {}
    if (node.layoutMode && node.layoutMode !== "NONE")
      o.autoLayout = { dir: node.layoutMode, gap: node.itemSpacing,
        padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
        primaryAlign: node.primaryAxisAlignItems, counterAlign: node.counterAxisAlignItems,
        sizing: node.layoutSizingHorizontal + "x" + node.layoutSizingVertical };
    o.fills = await paints(node.fills);
    if (node.strokes && node.strokes.length) { o.strokes = await paints(node.strokes); o.strokeWeight = node.strokeWeight; }
    if (node.cornerRadius && node.cornerRadius !== 0) o.cornerRadius = node.cornerRadius;
    if (node.type === "TEXT") {
      o.text = node.characters;
      o.font = { family: node.fontName && node.fontName.family, style: node.fontName && node.fontName.style,
        size: node.fontSize, lineHeight: node.lineHeight, letterSpacing: node.letterSpacing };
      if (node.textStyleId && typeof node.textStyleId === "string") {
        try { const s = await figma.getStyleByIdAsync(node.textStyleId); if (s) o.textStyle = s.name; } catch {}
      }
    }
    if (node.type === "INSTANCE") {
      try { const mc = await node.getMainComponentAsync();
        o.component = mc && mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc && mc.name;
        o.mainId = mc && mc.id; o.variantProps = node.variantProperties || undefined; } catch {}
      try { o.props = Object.fromEntries(Object.entries(node.componentProperties || {}).map(([k, v]) => [k, v.value])); } catch {}
    }
    if (node.type === "COMPONENT_SET" || node.type === "COMPONENT") {
      try { if (node.type === "COMPONENT_SET" || (node.parent && node.parent.type !== "COMPONENT_SET")) o.propertyDefs = node.componentPropertyDefinitions; } catch {}
    }
    if (d > 0 && node.children && node.children.length) {
      o.children = [];
      for (const c of node.children) o.children.push(await ser(c, d - 1));
    } else if (node.children && node.children.length) o.childCount = node.children.length;
    return o;
  }
  if (nodeId === "selection") {
    const sel = figma.currentPage.selection;
    if (!sel.length) return { error: "nothing selected", page: figma.currentPage.name };
    const nodes = [];
    for (const n of sel) nodes.push(await ser(n, depth));
    return { page: figma.currentPage.name, nodes };
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return { error: "node not found: " + nodeId };
  return { page: figma.currentPage.name, nodes: [await ser(node, depth)] };
}`;

// ---------------------------------------------------------------------------
// The POM
// ---------------------------------------------------------------------------

export class FigmaPage {
  /** @param {{ browser: any, ctx: any, page: any, fileKey: string }} parts */
  constructor(parts) {
    Object.assign(this, parts);
  }

  static cdpAlive() {
    try {
      execSync(`curl -sf http://localhost:${CDP_PORT}/json/version`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Launch (or reuse) the dedicated Chrome profile. Login persists — one-time. */
  static async ensureChrome() {
    if (FigmaPage.cdpAlive()) return;
    spawn(
      CHROME_BIN,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "https://www.figma.com/login",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (FigmaPage.cdpAlive()) return;
    }
    throw new Error("Chrome did not come up on :" + CDP_PORT);
  }

  /**
   * Attach over CDP and locate (or open) the tab for fileKey.
   * @param {{ fileKey: string, playwrightCorePath?: string }} opts
   */
  static async connect({ fileKey, playwrightCorePath }) {
    const chromium = await loadChromium(playwrightCorePath);
    await FigmaPage.ensureChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 5000 });
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error("no browser context in the dedicated Chrome");
    let page = ctx.pages().find((p) => p.url().includes(fileKey));
    if (!page) {
      page = await ctx.newPage();
      await page.goto(`https://www.figma.com/design/${fileKey}/`, { waitUntil: "domcontentloaded" });
      // Readiness = left panel ATTACHED (not visible — zero-size positioner
      // wrappers mid-animation never report visible).
      await page.waitForSelector(
        '[class*="left_panel"], [data-testid="layers-panel"], [class*="objects_panel"]',
        { state: "attached", timeout: 60_000 },
      );
    }
    page.setDefaultTimeout(2500); // Figma UI renders in <500ms or never
    return new FigmaPage({ browser, ctx, page, fileKey });
  }

  /** Bring the Figma tab to front (for human-in-the-loop sessions). */
  async bringToFront() {
    await this.page.bringToFront();
  }

  /**
   * Select a node via URL navigation (NEVER canvas clicks), then assert the
   * selection landed — abort on drift rather than act blind.
   */
  async selectNode(nodeId) {
    const urlId = nodeId.replace(":", "-");
    await this.page.goto(`https://www.figma.com/design/${this.fileKey}/?node-id=${urlId}`, {
      waitUntil: "domcontentloaded",
    });
    await this.page.waitForTimeout(5000); // canvas re-init before anything keyboard/clipboard
    const got = (this.page.url().match(/node-id=([\d-]+)/) ?? [])[1];
    if (got !== urlId) throw new Error(`selection drift: wanted ${urlId}, URL has ${got} — abort`);
  }

  /** DATA layer: structured spec of a node (or "selection"). */
  async readNode(nodeId, depth = 4) {
    return this.page.evaluate(`(${READ_FN})(${JSON.stringify({ nodeId, depth })})`);
  }

  async readSelection(depth = 4) {
    return this.readNode("selection", depth);
  }

  /**
   * Human-in-the-loop: poll the URL for selection changes (canvas clicks
   * mirror into ?node-id=). Calls onSelect(nodeIdColonForm) per change.
   */
  async watchSelection(onSelect, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
    let last = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = this.page.url().match(/node-id=([\d-]+)/);
      const id = m ? m[1].replace("-", ":") : "";
      if (id && id !== last) {
        last = id;
        await onSelect(id);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
  }

  /** Escape hatch for one-off page work (still: no blind canvas clicks). */
  async evaluate(fnSrcOrFn, arg) {
    return this.page.evaluate(fnSrcOrFn, arg);
  }

  /** Detach CDP only — Chrome keeps running with the session. */
  async close() {
    await this.browser.close();
  }
}
