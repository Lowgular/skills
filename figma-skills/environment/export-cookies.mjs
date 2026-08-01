/**
 * export-cookies.mjs — write this machine's Figma session into .env as
 * FIGMA_COOKIES, so skillgrade's stateless trial containers can boot logged in.
 *
 *   node environment/export-cookies.mjs
 *
 * Why env and not a volume: skillgrade's docker provider creates a fresh
 * container per trial and mounts nothing (HostConfig is NanoCpus + Memory only),
 * so an environment variable is the only channel into it. For the persistent box
 * (environment/box.mjs) this is unnecessary — it reads the live browser over CDP and
 * nothing is stored.
 *
 * The trade-off, stated plainly: this puts a live session token at rest in .env.
 * It is gitignored, but it does not expire from disk and any process that can
 * read the file has your Figma session. Re-run when it stops working; delete the
 * line when you are done with skillgrade runs.
 *
 * The value is never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, ensureChrome } from "../figma-browser/lib/connect.mjs";
import { connect } from "../figma-browser/lib/cdp.mjs";
import { PROBE_FN } from "../figma-browser/lib/figma-fns.mjs";

const ENV = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
const cfg = config();

/**
 * Make sure there IS a logged-in session before reading it.
 *
 * This is the only step a script cannot do for you — Figma logins are SSO, 2FA,
 * password managers, so they need a real window and a real person. Everything
 * after this point is automatic, and skillgrade owns the containers.
 */
if (!cfg.binExists) { console.error(`✗ Chrome not found at ${cfg.bin} — set FIGMA_CHROME_BIN in .env`); process.exit(1); }
const { launched } = await ensureChrome({ url: cfg.fileUrl });
console.log(`  ${launched ? "opened" : "reusing"} Chrome on :${cfg.port}`);

let live = false, asked = false;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  try {
    const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
    const probe = await cdp.evaluate(PROBE_FN, { timeoutMs: 3000 }).catch(() => null);
    cdp.close();
    if (probe) { live = true; break; }
  } catch { /* still starting */ }
  if (!asked) { console.log("\n  → Log in to Figma in that window, as someone who can EDIT the file.\n"); asked = true; }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!live) { console.error("✗ no window.figma after 5min — not logged in, or the file is view-only"); process.exit(1); }

const targets = (await (await fetch(`http://localhost:${cfg.port}/json/list`)).json()).filter((t) => t.type === "page");

const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const all = (await send("Network.getAllCookies")).result.cookies || [];
ws.close();

const cookies = all
  .filter((c) => (c.domain || "").includes("figma"))
  .map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly,
    ...(c.expires > 0 ? { expires: c.expires } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  }));

if (!cookies.length) {
  console.error("✗ no figma cookies — the browser is not logged in");
  process.exit(1);
}

// Single line, no quotes: Node's --env-file and skillgrade's dotenv both take
// the rest of the line verbatim, and the JSON contains no newlines.
const line = `FIGMA_COOKIES=${JSON.stringify(cookies)}`;
const current = readFileSync(ENV, "utf8");
const next = /^FIGMA_COOKIES=/m.test(current)
  ? current.replace(/^FIGMA_COOKIES=.*$/m, line)
  : current.trimEnd() + "\n" + line + "\n";
writeFileSync(ENV, next, { mode: 0o600 });

console.log(`✓ ${cookies.length} cookie(s) → .env as FIGMA_COOKIES (${line.length} chars, value not shown)`);
console.log(`  names: ${cookies.map((c) => c.name).join(", ")}`);
