/**
 * browser-state.mjs — deterministic grader, run INSIDE the trial container.
 *
 * skillgrade's docker provider implements provider.runCommand as
 * `container.exec`, so this executes next to the browser the agent just drove.
 * It reads the observable end state over CDP and compares it to the row.
 *
 * Emits skillgrade's grader contract on stdout: { score, details, checks }.
 *
 * ── The answer key, and an honest caveat ────────────────────────────────────
 *
 * The host-side setup keeps expected values OUT of the agent's reach: graders
 * are invoked by absolute path and read the dataset from outside the workspace.
 * That is not possible here. With `provider: docker` the grader runs in the
 * container, so whatever it needs to know must be IN the container — which is
 * also the agent's cwd. `EXPECTED` therefore arrives on the command line and is
 * visible to a determined agent in tests/test.sh.
 *
 * That is a real weakening, inherent to running graders in the sandbox rather
 * than a flaw in this file. It is acceptable only because these rows are graded
 * on BROWSER STATE: knowing the target node id does not let an agent fake being
 * on it — it would still have to actually navigate there, which is the task.
 * Do not reuse this pattern for rows whose answer is text.
 */
const PORT = process.env.FIGMA_CDP_PORT || "9333";
const EXPECTED = (process.env.EXPECTED_NODE_ID || "").trim();

const emit = (score, details, checks = []) => {
  console.log(JSON.stringify({ score, details, checks }));
  process.exit(0);
};

if (!EXPECTED) emit(0, "grader misconfigured: EXPECTED_NODE_ID unset");

try {
  /**
   * Wait for the browser rather than racing it. boot.sh starts Chromium and
   * seeds the session at container start; if the agent finishes fast (e.g. it
   * errors), the grader can arrive before that completes and report
   * "fetch failed" — which reads as a task failure when it is a startup race.
   */
  let targets = [];
  for (let i = 0; i < 30; i++) {
    try {
      targets = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).filter((t) => t.type === "page");
      if (targets.length) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!targets.length) emit(0, `no page target on :${PORT} after 30s — the browser never started`);

  const url = new URL(targets[0].url);
  const got = url.searchParams.get("node-id");

  // Figma state, for a readable failure. Never the verdict.
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

  const r = await send("Runtime.evaluate", {
    expression:
      'typeof figma==="undefined" ? JSON.stringify({hasFigma:false}) : ' +
      'JSON.stringify({hasFigma:true,page:figma.currentPage.name,selection:figma.currentPage.selection.map(n=>({id:n.id,name:n.name,type:n.type}))})',
    returnByValue: true,
    awaitPromise: true,
  });
  ws.close();
  const fig = JSON.parse(r.result.result.value);

  const ok = got === EXPECTED;
  emit(
    ok ? 1 : 0,
    ok ? `browser is on node-id=${EXPECTED}` : `expected node-id=${EXPECTED}, browser is on ${got || "none"}`,
    [
      { name: "url node-id matches", passed: ok, message: `got ${got || "none"}` },
      { name: "figma session live", passed: !!fig.hasFigma, message: fig.hasFigma ? `page="${fig.page}" selection=${JSON.stringify(fig.selection)}` : "window.figma absent" },
    ],
  );
} catch (e) {
  emit(0, "grader error: " + (e?.message || String(e)));
}
