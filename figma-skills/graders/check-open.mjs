/**
 * check-open.mjs — GENERIC deterministic grader for "open the right node".
 *
 * One input, one job: given EXPECTED_ID (a Figma node id), attach to the
 * dedicated Chrome over CDP and decide whether the live editor is showing that
 * node — by the tab URL's node-id param OR figma.currentPage.id. Scores 1/0.
 * Never trusts the agent's self-report. No per-page logic — the dataset carries
 * the expected id (see dataset.json / build-eval.mjs).
 *
 * Env (inlined per-task in the grader `run:` command):
 *   EXPECTED_ID    required, e.g. "280:23459"
 *   EXPECTED_NAME  optional, for readable messages only
 *   FIGMA_FILE_KEY / COVER_ID / PLAYWRIGHT_CORE_PATH  from .env
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const CDP = "http://localhost:9333";
const FILE_KEY = process.env.FIGMA_FILE_KEY || "o4J88pjxnuF7DSdLRhbtlO";
const EXPECTED_ID = (process.env.EXPECTED_ID || "").trim();
const EXPECTED_NAME = (process.env.EXPECTED_NAME || "").trim();
const COVER_ID = process.env.COVER_ID || "3:5";

const norm = (id) => (id || "").replace(/-/g, ":"); // URL uses "-", API uses ":"

function emit(score, details, checks) {
  console.log(JSON.stringify({ score, details, checks: checks || [] }));
  process.exit(0);
}

async function loadChromium() {
  const cands = [process.env.PLAYWRIGHT_CORE_PATH].filter(Boolean);
  let dir = process.cwd();
  for (;;) {
    cands.push(join(dir, "node_modules", "playwright-core", "index.mjs"));
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of cands) if (existsSync(c)) return (await import(c)).chromium;
  throw new Error("playwright-core not found — set PLAYWRIGHT_CORE_PATH");
}

const READ_CURRENT = `(async () => (typeof figma === "undefined" ? { error: "window.figma absent" } : { id: figma.currentPage.id, name: figma.currentPage.name }))()`;

if (!EXPECTED_ID) emit(0, "no EXPECTED_ID provided to grader", [{ name: "config", passed: false, message: "EXPECTED_ID unset" }]);

let browser;
try {
  const chromium = await loadChromium();
  browser = await chromium.connectOverCDP(CDP, { timeout: 5000 });
  const ctx = browser.contexts()[0];
  if (!ctx) emit(0, "no browser context on :9333 — Chrome not running", [{ name: "cdp-attach", passed: false, message: "no context" }]);
  const page =
    ctx.pages().find((p) => p.url().includes(FILE_KEY)) ||
    ctx.pages().find((p) => p.url().includes("figma.com/design")) ||
    ctx.pages()[0];
  page.setDefaultTimeout(3000);

  // Settle loop: read both signals until the editor stabilizes (canvas re-init
  // after a navigation can take several seconds).
  let urlId = null, cur = null;
  for (let i = 0; i < 12; i++) {
    urlId = norm((page.url().match(/node-id=([\w-]+)/) || [])[1]);
    cur = await page.evaluate(READ_CURRENT);
    if ((cur && !cur.error) || urlId) break;
    await page.waitForTimeout(1000);
  }
  const reachable = !!(cur && !cur.error);
  const urlMatch = !!(urlId && urlId === EXPECTED_ID);
  const pageMatch = !!(reachable && cur.id === EXPECTED_ID);
  const passed = urlMatch || pageMatch;

  const checks = [
    { name: "url node-id matches", passed: urlMatch, message: `url=${urlId || "none"} vs expected ${EXPECTED_ID}` },
    { name: "currentPage matches", passed: pageMatch, message: reachable ? `currentPage=${cur.name} (${cur.id})` : (cur && cur.error) || "unreachable" },
  ];

  // Reset to Cover (API, no reload — keeps editor warm for the next trial).
  try {
    await page.evaluate(`(async () => { const p = await figma.getNodeByIdAsync(${JSON.stringify(COVER_ID)}); if (p && p.type === "PAGE") await figma.setCurrentPageAsync(p); })()`);
  } catch {}

  await browser.close();
  emit(
    passed ? 1 : 0,
    passed ? `on expected node ${EXPECTED_NAME || EXPECTED_ID}` : `not on expected node (url=${urlId || "none"}, page=${reachable ? cur.id : "n/a"})`,
    checks,
  );
} catch (e) {
  try { if (browser) await browser.close(); } catch {}
  emit(0, "grader error: " + (e && e.message ? e.message : String(e)), [{ name: "grader-ran", passed: false, message: String(e && e.message ? e.message : e) }]);
}
