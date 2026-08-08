/**
 * box.mjs — bring up the eval container and give it a logged-in Figma session.
 *
 *   node environment/box.mjs build     build the image
 *   node environment/box.mjs up        start the container (Chromium running)
 *   node environment/box.mjs login     ONE-TIME: log in, and put the session in the box
 *   node environment/box.mjs seed      re-copy this machine's session (login does this too)
 *   node environment/box.mjs status    is it up, and is window.figma live?
 *   node environment/box.mjs down      stop and remove the container
 *   node environment/box.mjs reset     put the browser back on <node-id>
 *
 * ── The session, and why it is done this way ────────────────────────────────
 *
 * Copying the host's Chrome profile directory does NOT work: Chrome encrypts its
 * cookie store with a key from the macOS Keychain, so the DB will not decrypt on
 * Linux. Over CDP the same cookies are plaintext, so `seed` reads them from the
 * host browser and writes them into the container's — the user's own session
 * moving between their own browsers. No password, no VNC, no login automation.
 *
 * Cookie values are passed as data and never printed.
 *
 * ── Three flags that are not optional ───────────────────────────────────────
 *
 *   --user-agent=<real desktop UA>    without it Figma's CDN answers 403
 *   --enable-unsafe-swiftshader       without it: "WebGL isn't supported"
 *   --shm-size=2g (on docker run)     Chromium starves on the default 64MB
 *
 * `--remote-debugging-address=0.0.0.0` does NOT work — Chromium binds loopback
 * regardless. Everything therefore runs inside the container; the host never
 * talks to the container's CDP.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, ensureChrome } from "../figma-browser/lib/connect.mjs";
import { connect } from "../figma-browser/lib/cdp.mjs";
import { PROBE_FN } from "../figma-browser/lib/figma-fns.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const IMAGE = "figma-eval";
export const BOX = "figma-box";
export const VOLUME = "figma-profile";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Verbs of the skill under test — the same pattern eval-context.mjs uses. */
const CLI_CALL = /figma\.mjs["']?\s+(pages|find|layers|inspect|css|vars|open|help|status|login)\b/;

const sh = (args, opts = {}) =>
  spawnSync("docker", args, { encoding: "utf8", env: process.env, ...opts });

/**
 * Clear the profile lock before launching.
 *
 * Chromium writes /profile/SingletonLock as a symlink naming the HOSTNAME and
 * pid that hold it. `docker rm -f` kills the browser without cleaning up, and
 * the next container gets a new hostname — so Chromium reads the stale lock,
 * decides the profile is "in use by another Chromium process on another
 * computer", and refuses to start. Every down/up cycle would break.
 *
 * Safe to remove unconditionally: the volume has exactly one user, this box.
 */
const chromiumCmd = (fileKey) => `
rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie
chromium --headless=new --no-sandbox --disable-dev-shm-usage \\
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \\
  --remote-debugging-port=9333 --user-data-dir=/profile \\
  --user-agent="${UA}" --disable-blink-features=AutomationControlled \\
  "https://www.figma.com/design/${fileKey}/box" >/tmp/chrome.log 2>&1 &
sleep 1; tail -f /dev/null
`;

export function build() {
  // ONE Dockerfile, at environment/Dockerfile — skillgrade hardcodes that path
  // (providers/docker.js: { dockerfile: "environment/Dockerfile" }), so both
  // this box and `npx skillgrade` build the same image from the same file.
  const r = sh(["build", "-t", IMAGE, "-f", join(HERE, "Dockerfile"), ROOT], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("docker build failed");
}

export function up({ file = null } = {}) {
  const cfg = config({ file });
  if (!cfg.fileKey) throw new Error(`${cfg.fileError} — ${cfg.fileHint}`);
  sh(["rm", "-f", BOX]);
  const r = sh([
    "run", "-d", "--name", BOX,
    "-e", `FIGMA_FILE_SDS=${cfg.fileKey}`,
    "-e", "CLAUDE_CODE_OAUTH_TOKEN",
    // boot.sh seeds the session from this. Without it the box only works while
    // the profile volume happens to still hold a live session from an earlier
    // seed — and fails later with no obvious cause.
    "-e", "FIGMA_COOKIES",
    // The skill derives its profile path as <skill>/../../.chrome-profile, which
    // inside the container is NOT where boot.sh puts it. Harmless while CDP is
    // already up (the skill attaches), but if it ever needs to LAUNCH Chrome it
    // would start a second browser against an empty profile and report
    // "not logged in". Pin it.
    "-e", "FIGMA_CHROME_PROFILE=/profile",
    /**
     * Makes the skill return the browser to the file's opening view on the
     * first operation of each trial, so a trial cannot pass on the previous
     * trial's position. See maybeReset() in figma.mjs.
     *
     * Set HERE and not in .env on purpose: .env is bind-mounted and shared with
     * the host, where this skill drives the human's own browser. Eval behaviour
     * belongs to the eval box.
     */
    "-e", "FIGMA_RESET_ON_CONNECT=1",
    /**
     * LangSmith tracing for the agent under test.
     *
     * The plugin reads these from the process env, and skillgrade's local
     * provider spawns `claude` with {...process.env}, so setting them on the
     * container is enough — nothing has to be threaded through eval.yaml.
     *
     * The key is inherited (bare -e) rather than interpolated, so it comes from
     * .env via connect.mjs and never appears in this file or in shell history.
     * It IS visible to `docker inspect`, exactly like FIGMA_COOKIES above.
     *
     * Traces are for reading a failed row, not for scoring one — graders parse
     * the local transcript. Set TRACE_TO_LANGSMITH=false to turn it all off.
     */
    "-e", `TRACE_TO_LANGSMITH=${process.env.TRACE_TO_LANGSMITH ?? "true"}`,
    "-e", "LANGSMITH_API_KEY",
    "-e", "LANGSMITH_ENDPOINT",
    "-e", `CC_LANGSMITH_PROJECT=${process.env.CC_LANGSMITH_PROJECT || "figma-eval-traces"}`,
    "-v", `${VOLUME}:/profile`,
    /**
     * ONE mount: figma-skills itself, nothing else from the monorepo.
     *
     * It carries eval.yaml, graders/, datasets/ and — via
     * .claude/skills/figma-browser, a symlink to ../../figma-browser — the skill
     * under test. Bind-mounted rather than baked so editing SKILL.md takes
     * effect immediately: edit → rerun → read the score, no rebuild.
     */
    "-v", `${ROOT}:/work`,
    "--shm-size=2g",
    IMAGE, "sh", "-c", chromiumCmd(cfg.fileKey),
  ]);
  if (r.status !== 0) throw new Error("docker run failed: " + r.stderr);
  return r.stdout.trim().slice(0, 12);
}

/** Run JS inside the container. `input` is piped to its stdin. */
const inBox = (code, env = {}, input = undefined) => {
  const args = ["exec"];
  if (input !== undefined) args.push("-i");
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(BOX, "node", "-e", code);
  return sh(args, input === undefined ? {} : { input });
};

/** Read the host browser's Figma cookies. Values are returned, never logged. */
async function hostCookies(port) {
  const targets = (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter((t) => t.type === "page");
  if (!targets.length) throw new Error(`no page target on the host browser (:${port})`);
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const all = (await send("Network.getAllCookies")).result.cookies || [];
  ws.close();
  return all
    .filter((c) => (c.domain || "").includes("figma"))
    .map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly,
      ...(c.expires > 0 ? { expires: c.expires } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
}

const INJECT = `
const cookies = JSON.parse(require("fs").readFileSync(0, "utf8"));   // stdin
(async () => {
  const t = (await (await fetch("http://localhost:9333/json/list")).json()).filter(x=>x.type==="page")[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let id=0; const pend=new Map();
  ws.addEventListener("message", e => { const m=JSON.parse(e.data); const p=pend.get(m.id); if(p){pend.delete(m.id);p(m);} });
  const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  await send("Network.setCookies", { cookies });
  await send("Page.navigate", { url: "https://www.figma.com/design/" + process.env.KEY + "/seeded" });
  let st=null;
  for (let i=0;i<45;i++) {
    await new Promise(r=>setTimeout(r,2000));
    const r0 = await send("Runtime.evaluate", { expression: 'JSON.stringify({hasFigma: typeof figma!=="undefined"})', returnByValue:true });
    try { st = JSON.parse(r0.result.result.value); } catch {}
    if (st && st.hasFigma) break;
  }
  console.log(st && st.hasFigma ? "LIVE" : "ABSENT");
  ws.close();
})();
`;

export async function seed({ file = null } = {}) {
  const cfg = config({ file });
  const cookies = await hostCookies(cfg.port);
  if (!cookies.length) throw new Error("no figma cookies on the host browser — is it logged in?");

  /**
   * Piped over stdin — deliberately never written to disk on either side.
   *
   * Two earlier attempts were worse. A temp file inside the repo
   * (docker/.cookies.tmp.json) put live session cookies one crash and one
   * `git add -A` away from being committed. Moving it to os.tmpdir() with mode
   * 0600 fixed that but broke the container: `docker cp` lands the file owned by
   * root, and the container runs as `node`, so it could not read it —
   * "EACCES: permission denied, open '/tmp/cookies.json'". stdin has neither
   * problem and leaves nothing to clean up.
   */
  const r = inBox(INJECT, { KEY: cfg.fileKey }, JSON.stringify(cookies));
  const live = (r.stdout || "").includes("LIVE");
  return { cookies: cookies.length, live, detail: (r.stdout || r.stderr || "").trim().slice(0, 300) };
}

/**
 * login — the one-time human step, done properly.
 *
 * `seed` assumes a logged-in browser already exists on this machine. That is a
 * bad assumption for anyone setting this up the first time, and it is the only
 * part a script genuinely cannot do: Figma logins are SSO, 2FA, password
 * managers — they need a real browser window in front of a real person.
 *
 * So: open one (the same dedicated profile the skill itself uses), wait for the
 * design editor to come alive, then pipe that session into the box. The
 * container's browser stays headless and is never something the user has to
 * see — no VNC, no X11, no login automation, no credentials anywhere.
 *
 * Idempotent. If the host browser is already logged in it skips straight to the
 * transfer, so it is safe to re-run whenever the container's session expires.
 */
export async function login({ file = null, waitSeconds = 300 } = {}) {
  const cfg = config({ file });
  if (!cfg.fileKey) throw new Error(`${cfg.fileError} — ${cfg.fileHint}`);
  if (!cfg.binExists) throw new Error(`Chrome not found at ${cfg.bin} — set FIGMA_CHROME_BIN in .env`);

  const { launched } = await ensureChrome({ url: cfg.fileUrl });
  console.log(`  ${launched ? "opened" : "reusing"} Chrome on :${cfg.port}  (profile ${cfg.profile})`);

  // Poll for the Plugin API — the only proof that the session is real AND the
  // file is an editable copy rather than a view-only preview.
  const deadline = Date.now() + waitSeconds * 1000;
  let live = false;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
      const probe = await cdp.evaluate(PROBE_FN, { timeoutMs: 3000 }).catch(() => null);
      cdp.close();
      if (probe) { live = true; break; }
    } catch { /* browser still starting */ }
    if (!announced) {
      console.log(`\n  → Log in to Figma in that window, as someone who can EDIT the file.`);
      console.log(`    Waiting up to ${waitSeconds}s…\n`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!live) throw new Error(`still no window.figma after ${waitSeconds}s — not logged in, or the file is view-only`);

  console.log("  ✓ host session live — transferring to the container");
  return seed({ file });
}

const STATE = `
(async () => {
  const t = (await (await fetch("http://localhost:9333/json/list")).json()).filter(x=>x.type==="page")[0];
  if (!t) return console.log(JSON.stringify({ error: "no page target" }));
  const u = new URL(t.url);
  const query_params = {}; for (const [k,v] of u.searchParams) if (!["t","p"].includes(k)) query_params[k]=v;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let id=0; const pend=new Map();
  ws.addEventListener("message", e => { const m=JSON.parse(e.data); const p=pend.get(m.id); if(p){pend.delete(m.id);p(m);} });
  const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  const r0 = await send("Runtime.evaluate", { expression: 'typeof figma==="undefined" ? JSON.stringify({hasFigma:false}) : JSON.stringify({hasFigma:true,page:figma.currentPage.name,selection:figma.currentPage.selection.map(n=>({id:n.id,name:n.name,type:n.type}))})', returnByValue:true, awaitPromise:true });
  ws.close();
  console.log(JSON.stringify({ browser: { url: u.origin+u.pathname, query_params }, figma: JSON.parse(r0.result.result.value) }));
})();
`;

/** The container's observable state, in the same shape a row states it. */
export function state() {
  const r = inBox(STATE);
  try { return JSON.parse((r.stdout || "").trim().split("\n").pop()); }
  catch { return { error: (r.stdout || r.stderr || "unreadable").trim().slice(0, 200) }; }
}

const GOTO = (apiId) => `
(async () => {
  const t = (await (await fetch("http://localhost:9333/json/list")).json()).filter(x=>x.type==="page")[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let id=0; const pend=new Map();
  ws.addEventListener("message", e => { const m=JSON.parse(e.data); const p=pend.get(m.id); if(p){pend.delete(m.id);p(m);} });
  const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  const expr = \`(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(apiId)});
    if (!n) return "not found";
    if (n.type === "PAGE") { await figma.setCurrentPageAsync(n); figma.currentPage.selection = []; return figma.currentPage.name; }
    let pg = n; while (pg && pg.type !== "PAGE") pg = pg.parent;
    if (figma.currentPage.id !== pg.id) await figma.setCurrentPageAsync(pg);
    figma.currentPage.selection = [n];
    return figma.currentPage.name;
  })()\`;
  const r0 = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  ws.close();
  console.log(String(r0.result.result.value));
})();
`;

/** Put the browser where a row's inputs.context.browser says it starts. */
export function reset(urlNodeId) {
  const r = inBox(GOTO(String(urlNodeId).replace(/-/g, ":")));
  return (r.stdout || r.stderr || "").trim().slice(0, 120);
}

/**
 * Run the agent inside the box.
 *
 * stream-json rather than plain -p: the `system/init` event carries the model
 * the CLI actually RESOLVED, which is the only way to record what answered
 * rather than what we asked for. Plain -p emits final text only — the same
 * reason the eval uses a custom command agent instead of skillgrade's built-in
 * claude one. It also gets turn and tool counts back in docker mode.
 */
export function runAgent(prompt, { model = null } = {}) {
  const args = ["exec", "-w", "/workspace"];
  if (model) args.push("-e", `ANTHROPIC_MODEL=${model}`);
  args.push(BOX, "sh", "-c",
    `printf %s ${JSON.stringify(prompt)} | claude -p --output-format=stream-json --verbose --dangerously-skip-permissions 2>&1`);
  const r = sh(args);

  const raw = r.stdout || "";
  let resolvedModel = null, text = "", turns = 0, tools = 0, usedCli = false, subagent = false;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === "system" && ev.subtype === "init" && ev.model) resolvedModel = ev.model;
    if (ev.type === "assistant") {
      turns++;
      if (!resolvedModel && ev.message?.model) resolvedModel = ev.message.model;
      for (const b of ev.message?.content || []) {
        if (b.type === "tool_use") {
          tools++;
          if (b.name === "Agent" || b.name === "Task") subagent = true;
          // Did it actually call the skill, or answer some other way? A pass
          // that never touched figma.mjs is not evidence the skill works —
          // this is the check that caught a 109-row run scoring 98.2% against
          // a skill it had never invoked. Same regexp as eval-context.mjs,
          // including the optional quote: `node "/abs/figma.mjs" open` counts.
          if (CLI_CALL.test(JSON.stringify(b.input || {}))) usedCli = true;
        }
        if (b.type === "text" && b.text) text = b.text;
      }
    }
    if (ev.type === "result" && typeof ev.result === "string") text = ev.result;
  }
  // Auth failures are plain text, not NDJSON — keep the raw stream for that check.
  return { code: r.status, out: raw, err: r.stderr || "", model: resolvedModel, text, turns, tools, usedCli, subagent };
}

export function down() { sh(["rm", "-f", BOX]); }

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] || "status";
  if (cmd === "build") { build(); console.log("✓ built " + IMAGE); }
  else if (cmd === "up") { console.log("✓ up " + up()); }
  else if (cmd === "down") { down(); console.log("✓ down"); }
  else if (cmd === "login") {
    const r = await login({ waitSeconds: Number(process.argv[3] || 300) });
    console.log(`${r.live ? "✓" : "✗"} ${r.cookies} cookie(s) → window.figma ${r.live ? "LIVE in the container" : "ABSENT — " + r.detail}`);
  }
  else if (cmd === "seed") {
    const r = await seed();
    console.log(`${r.live ? "✓" : "✗"} ${r.cookies} cookie(s) → window.figma ${r.live ? "LIVE" : "ABSENT — " + r.detail}`);
  } else if (cmd === "reset") {
    console.log("→ " + reset(process.argv[3] || "3-5"));
  } else {
    console.log(JSON.stringify(state(), null, 1));
  }
}
