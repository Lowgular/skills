/**
 * preflight.mjs — verify the eval's PRECONDITIONS before spending a trial.
 *
 * Auth is NOT a task step: the agent attaches to an already-running, already
 * logged-in dedicated Chrome (~/.figma-chrome profile, persistent session).
 * This script fails fast with an actionable message if that assumption breaks.
 *
 * Checks, in order:
 *   1. CDP alive on :9333                 → else: launch the dedicated Chrome
 *   2. SDS file tab reachable             → else: open the file URL
 *   3. window.figma present (= logged in  → else: log in once in that profile
 *      AND in the design editor)
 *
 * Run:  PLAYWRIGHT_CORE_PATH=... node preflight.mjs
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CDP = "http://localhost:9333";
const FILE_KEY = process.env.FIGMA_FILE_KEY || "o4J88pjxnuF7DSdLRhbtlO";

function die(msg, hint) {
  console.error(`\n✗ preflight FAILED: ${msg}`);
  if (hint) console.error(`  → ${hint}\n`);
  process.exit(1);
}

// 1. CDP alive?
try {
  execSync(`curl -sf ${CDP}/json/version`, { stdio: "pipe" });
  console.log("✓ CDP alive on :9333");
} catch {
  die("Chrome not running on :9333",
    `launch it once:\n     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n       --remote-debugging-port=9333 --user-data-dir="$HOME/.figma-chrome" \\\n       --no-first-run --no-default-browser-check https://www.figma.com`);
}

async function loadChromium() {
  const cands = [process.env.PLAYWRIGHT_CORE_PATH].filter(Boolean);
  let dir = process.cwd();
  for (;;) { cands.push(join(dir, "node_modules", "playwright-core", "index.mjs")); const p = join(dir, ".."); if (p === dir) break; dir = p; }
  for (const c of cands) if (existsSync(c)) return (await import(c)).chromium;
  die("playwright-core not found", "set PLAYWRIGHT_CORE_PATH in .env");
}

const chromium = await loadChromium();
const browser = await chromium.connectOverCDP(CDP, { timeout: 5000 });
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes(FILE_KEY));
if (!page) {
  console.log(`… SDS tab not open, navigating to file ${FILE_KEY}`);
  page = await ctx.newPage();
  await page.goto(`https://www.figma.com/design/${FILE_KEY}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
}
console.log("✓ SDS file tab reachable");

page.setDefaultTimeout(4000);
const probe = await page.evaluate(`(async () => (typeof figma === "undefined" ? null : { name: figma.currentPage.name }))()`);
await browser.close();

if (!probe) {
  die("window.figma ABSENT — either not logged in, or the file is view-only",
    "open the SDS file in the DESIGN EDITOR (a copy in your drafts, not the community preview), logged into the ~/.figma-chrome profile");
}
console.log(`✓ window.figma live (logged in, design editor) — currentPage=${probe.name}`);
console.log("\n✓ preflight PASSED — preconditions met.\n");
