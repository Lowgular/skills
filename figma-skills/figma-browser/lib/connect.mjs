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
export function bindings() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^FIGMA_FILE_([A-Z0-9_]+)$/.exec(k);
    // FIGMA_FILE_KEY is the retired name and would otherwise register as the
    // slug "key". Excluded here so the error below can name the migration.
    if (!m || m[1] === "KEY" || !v?.trim()) continue;
    out[m[1].toLowerCase()] = v.trim();
  }
  return out;
}

/** `--file=<slug>`, for a human switching design systems mid-session. */
export function sessionFile() {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--file="));
  return hit ? hit.slice("--file=".length) : null;
}

/**
 * Which design system to read.
 *
 * 1. want            an explicit slug — `--file=`, or a caller that knows
 * 2. the session     already resolved by the runtime; no lookup happens here
 * 3. the sole binding so one design system needs no selector at all
 * 4. otherwise       { error } naming what to do, never a silent default
 *
 * Rule 2 is the important one. A runtime is invoked once per task, and the task
 * config says which design system the task is about — so it resolves the key
 * there, once, and writes it to the session. This function then has nothing to
 * work out. Resolution belongs as high up as the information does.
 *
 * Failures are returned, not thrown: callers already have an escalation path
 * that tells the human what to fix, and reading the WRONG file is the failure
 * worth preventing — it yields plausible answers that look like a broken skill.
 */
function resolveFile(wanted) {
  const map = bindings();
  const slugs = Object.keys(map).sort();
  const want = String(wanted || "").trim().toLowerCase();

  if (!want) {
    // Already resolved by whoever started this task — no lookup here at all.
    // A session without a file is normal (a runtime that traces but does not
    // care about Figma), so fall through rather than erroring.
    const s = readSession();
    if (s?.figma_key) return { slug: s.figma_file || null, key: s.figma_key, from: "session" };
  }

  if (want) {
    if (map[want]) return { slug: want, key: map[want] };
    return {
      error: `unknown Figma file "${want}"`,
      hint: slugs.length
        ? `bound slugs: ${slugs.join(", ")} — or add FIGMA_FILE_${want.toUpperCase()}=<key> to .env`
        : `no FIGMA_FILE_<SLUG> is set — add FIGMA_FILE_${want.toUpperCase()}=<key> to .env`,
    };
  }
  if (slugs.length === 1) return { slug: slugs[0], key: map[slugs[0]] };
  if (slugs.length) {
    return {
      error: `several Figma files are bound and none was chosen`,
      hint: `pass --file=<slug>. Bound: ${slugs.join(", ")}`,
    };
  }
  // The one case worth a bespoke message: a .env from before the slug split.
  if (process.env.FIGMA_FILE_KEY) {
    return {
      error: `FIGMA_FILE_KEY is no longer read`,
      hint: `rename it in .env to a slug binding, e.g. FIGMA_FILE_SDS=${process.env.FIGMA_FILE_KEY}`,
    };
  }
  return {
    error: `no Figma file configured`,
    hint: `add FIGMA_FILE_<SLUG>=<key> to .env — the key is the segment after /design/ in the URL`,
  };
}

/**
 * @param file  which design system, as a slug. Optional: a running task's
 *              session already carries the resolved file, and a setup with one
 *              binding needs no selector. Pass it when you know better than
 *              both — `--file=` from a human, or a dataset row's `figma_file`.
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
