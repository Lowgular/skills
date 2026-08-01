/**
 * seed.mjs — runs inside the trial container, from boot.sh.
 *
 * Waits for Chromium's CDP, installs the cookies from $FIGMA_COOKIES, reloads
 * the file, and blocks until window.figma exists. Blocking is the point: the
 * agent must not start against a half-booted browser, or it will correctly
 * report "not logged in" and the trial measures the boot sequence instead of
 * the skill.
 */
const PORT = process.env.FIGMA_CDP_PORT || "9333";
const KEY = process.env.FIGMA_FILE_SDS || "";
const RAW = process.env.FIGMA_COOKIES || "";

if (!RAW) {
  console.error("seed: FIGMA_COOKIES is empty");
  process.exit(1);
}
let cookies;
try {
  cookies = JSON.parse(RAW);
} catch {
  console.error("seed: FIGMA_COOKIES is not valid JSON");
  process.exit(1);
}

const list = async () =>
  (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).filter((t) => t.type === "page");

let target = null;
for (let i = 0; i < 60; i++) {
  try { target = (await list())[0]; if (target) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!target) { console.error("seed: chromium never exposed a page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
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

await send("Network.setCookies", { cookies });
await send("Page.navigate", { url: `https://www.figma.com/design/${KEY}/seeded` });

let live = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const r0 = await send("Runtime.evaluate", {
    expression: 'JSON.stringify({ f: typeof figma !== "undefined" })',
    returnByValue: true,
  });
  try { if (JSON.parse(r0.result.result.value).f) { live = true; break; } } catch { /* still loading */ }
}
ws.close();

console.log(live ? `seed: window.figma live (${cookies.length} cookies)` : "seed: window.figma never appeared");
process.exit(live ? 0 : 1);
