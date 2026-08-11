/**
 * connect.mjs — config + Chrome process lifecycle. No protocol code (that's
 * cdp.mjs), no Figma knowledge (that's figma-fns.mjs), no dependencies.
 *
 * Config — all env-overridable, all with working defaults:
 *   FIGMA_CDP_PORT        default 9333
 *   FIGMA_CHROME_PROFILE  default <repo>/figma-skills/.chrome-profile  (gitignored)
 *   FIGMA_CHROME_BIN      default: /Applications/Google Chrome.app/…/Google Chrome
 *   FIGMA_FILE_<SLUG>     slug → file key. One per design system.
 *
 * WHICH FILE — a running task's session decides, and a runtime wrote that
 * session (see session.mjs). Failing a session, this resolves it: `--file=`, or
 * the sole binding. Every caller that reaches Figma (figma.mjs, gen.mjs,
 * inventory.mjs, extract.mjs, graders/grade.mjs) goes through config(), so the
 * rule lives in exactly one place.
 *
 * A file key names YOUR editable copy, so it is machine-specific and stays in
 * .env. A slug names which design system a question is about, so it is
 * intrinsic to the data and lives in git. Keeping a raw key out of the wire is
 * what makes a second design system possible: nothing passes a key between
 * processes, so nothing can pass the wrong one.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSession } from "./session.mjs";

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

/** Every FIGMA_FILE_<SLUG> binding, as lowercase slug → key. */
/** `--file=<key>`, for a one-off read of something other than the configured file. */
export function sessionFile() {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--file="));
  return hit ? hit.slice("--file=".length) : null;
}

/**
 * Which design file to read. ONE of them, named directly by its key.
 *
 * 1. want         `--file=<key>`, or a caller that knows
 * 2. the session  already resolved by the runtime
 * 3. FIGMA_FILE   the configured file
 * 4. otherwise    { error } naming what to do, never a silent default
 *
 * ── Why there is no slug map ────────────────────────────────────────────────
 *
 * There was one: FIGMA_FILE_<SLUG> bindings and a `--file=<slug>` lookup, so a
 * dataset row could name its design system and have the key resolved for it.
 * It bought nothing and cost a whole evening.
 *
 * Two bindings existed for about an hour, and in that hour EVERY task in BOTH
 * suites failed — `several Figma files are bound and none was chosen` — because
 * nothing downstream passed a slug. The abstraction's only load-bearing moment
 * was a failure.
 *
 * The deeper reason it should not come back: swapping design systems is not a
 * change of one property. Going from one to another took a different LangSmith
 * account, a different Figma login, a duplicated file (the original was
 * read-only, so the Plugin API was absent entirely), and a re-seed of the
 * container's cookies. A slug that pretends the difference is a lookup invites
 * treating a whole environment swap as a config toggle.
 *
 * A dataset belongs to a file. Every golden in it — the hexes, the style names,
 * a component's variant axes — is true of exactly one document. So the file is
 * configured once, by hand, alongside the other things that must move with it,
 * and the row's `figma_file` is provenance rather than a selector.
 *
 * There is deliberately no guard that the configured file matches the dataset.
 * Running the wrong one fails every row at once with every golden missing,
 * which is not a plausible model failure and does not need machinery to detect.
 *
 * Failures are returned, not thrown: callers already have an escalation path
 * that tells the human what to fix.
 */
function resolveFile(wanted) {
  const want = String(wanted || "").trim();
  if (want) return { key: want, from: "flag" };

  // Already resolved by whoever started this task. A session without a file is
  // normal (a runtime that traces but does not care about Figma), so fall
  // through rather than erroring.
  const s = readSession();
  if (s?.figma_key) return { slug: s.figma_file || null, key: s.figma_key, from: "session" };

  const key = process.env.FIGMA_FILE?.trim();
  if (key) return { key, from: "env" };

  // Both retired names, each worth its own message so a stale .env says so.
  const legacy = Object.keys(process.env).filter((k) => /^FIGMA_FILE_[A-Z0-9_]+$/.test(k));
  if (legacy.length) {
    return {
      error: `${legacy.join(", ")} ${legacy.length > 1 ? "are" : "is"} no longer read`,
      hint: `one file at a time now — set FIGMA_FILE=<key> in .env and remove the rest`,
    };
  }
  return {
    error: `no Figma file configured`,
    hint: `add FIGMA_FILE=<key> to .env — the key is the segment after /design/ in the URL`,
  };
}

/**
 * @param file  a file KEY, for a one-off read of something other than the
 *              configured file. Normally omitted: FIGMA_FILE says which.
 */
export function config({ file = null } = {}) {
  const port = Number(process.env.FIGMA_CDP_PORT || 9333);
  // Repo-local default so the profile is covered by .gitignore, and stays
  // correct if the repo moves. Override to reuse a profile from elsewhere.
  const profile = process.env.FIGMA_CHROME_PROFILE || join(HERE, "..", "..", ".chrome-profile");
  const bin = process.env.FIGMA_CHROME_BIN || DEFAULT_CHROME;
  const f = resolveFile(file);
  return {
    port,
    profile,
    bin,
    binExists: existsSync(bin),
    cdp: `http://localhost:${port}`,
    figmaFile: f.slug || null,
    fileKey: f.key || null,
    fileUrl: f.key ? `https://www.figma.com/design/${f.key}/` : null,
    // "session" when a runtime resolved it for us, null when we did it here.
    fileFrom: f.from || null,
    // Why there is no file, in the caller's words. null when resolution worked.
    fileError: f.error || null,
    fileHint: f.hint || null,
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
