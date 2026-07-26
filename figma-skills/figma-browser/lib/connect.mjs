/**
 * connect.mjs — config + Chrome process lifecycle. No protocol code (that's
 * cdp.mjs), no Figma knowledge (that's figma-fns.mjs), no dependencies.
 *
 * Config — all env-overridable, all with working defaults:
 *   FIGMA_CDP_PORT        default 9333
 *   FIGMA_CHROME_PROFILE  default <repo>/figma-skills/.chrome-profile  (gitignored)
 *   FIGMA_CHROME_BIN      default: /Applications/Google Chrome.app/…/Google Chrome
 *   FIGMA_FILE_KEY        the file to open / verify against
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// .env — so the CLI works in a bare shell. skillgrade injects these for the
// agent already; this is for humans. Real env always wins over the file.
// ---------------------------------------------------------------------------

(function loadDotEnv() {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, ".env");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
        if (!m) continue;
        const val = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
        if (process.env[m[1]] === undefined) process.env[m[1]] = val;
      }
      return;
    }
    dir = join(dir, "..");
  }
})();

// ONE path, env-overridable. Deliberately not a fallback chain: Canary and
// Chromium are different browsers with their OWN profiles, so silently picking
// one turns a clear "Chrome not found" into a confusing "not logged in" later.
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function config() {
  const port = Number(process.env.FIGMA_CDP_PORT || 9333);
  // Repo-local default so the profile is covered by .gitignore, and stays
  // correct if the repo moves. Override to reuse a profile from elsewhere.
  const profile = process.env.FIGMA_CHROME_PROFILE || join(HERE, "..", "..", ".chrome-profile");
  const bin = process.env.FIGMA_CHROME_BIN || DEFAULT_CHROME;
  return {
    port,
    profile,
    bin,
    binExists: existsSync(bin),
    cdp: `http://localhost:${port}`,
    fileKey: process.env.FIGMA_FILE_KEY || null,
    fileUrl: process.env.FIGMA_FILE_KEY
      ? `https://www.figma.com/design/${process.env.FIGMA_FILE_KEY}/`
      : null,
  };
}

/** Is something answering CDP on the port? */
export async function cdpAlive(port = config().port) {
  try {
    const r = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Launch the dedicated Chrome if it isn't up, and wait for CDP.
 *
 * Guarantees a BROWSER, not a logged-in one — verify the session separately
 * (figma.mjs `login` / `status` probe window.figma).
 */
export async function ensureChrome({ url = "https://www.figma.com", waitMs = 30_000 } = {}) {
  const { port, profile, bin, binExists } = config();
  if (await cdpAlive(port)) return { launched: false, port, profile };
  if (!binExists) {
    throw new Error(`Chrome not found at:\n    ${bin}\n  → set FIGMA_CHROME_BIN in .env`);
  }
  spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await cdpAlive(port)) return { launched: true, port, profile };
  }
  throw new Error(`Chrome did not answer CDP on :${port} within ${waitMs}ms`);
}
