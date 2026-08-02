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
 *
 * ── This grader OBSERVES. It does not touch. ────────────────────────────────
 *
 * Resetting the browser between trials is the SKILL's job, on its way in — see
 * maybeReset() in figma.mjs. A grader that also reset would be doing it after
 * the fact, which is both too late to define a start state and a second place
 * to keep the definition of "neutral" in sync.
 *
 * The one case that leaves: an agent that never calls the skill at all cannot
 * trigger the skill's reset, so it grades against whatever the previous trial
 * left. It scores 0 on its own merits unless the previous trial happened to
 * park on this row's answer.
 *
 * Trials must also run sequentially — one browser, so `--parallel` would have
 * trials resetting each other mid-measurement. Nothing enforces that.
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

  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value;

  /** URL and Plugin API read together, so they always describe the same moment. */
  const read = async () => JSON.parse(await ev(
    'typeof figma==="undefined" ? JSON.stringify({hasFigma:false,href:location.href}) : ' +
    'JSON.stringify({hasFigma:true,href:location.href,page:figma.currentPage.name,' +
    'selection:figma.currentPage.selection.map(n=>({id:n.id,name:n.name,type:n.type}))})',
  ));

  // node-id is hyphenated in the URL and colonned in the Plugin API: 1444-11846 / 1444:11846
  const urlId = (href) => new URL(href).searchParams.get("node-id");
  const toUrlId = (s) => String(s).replaceAll(":", "-");

  let fig = await read();
  let got = urlId(fig.href);

  /**
   * The URL LAGS the Plugin API. Figma pushes history asynchronously — measured
   * at 1-2s — so a grader that reads the URL the instant the agent stops can
   * still see the previous position and fail a trial that succeeded.
   *
   * Wait only in the direction that cannot manufacture a pass: when the
   * SELECTION is already the answer, give the URL its moment to agree. Never
   * the reverse.
   */
  if (got !== EXPECTED && fig.selection?.some((n) => toUrlId(n.id) === EXPECTED)) {
    for (let i = 0; i < 10 && got !== EXPECTED; i++) {
      await new Promise((r) => setTimeout(r, 500));
      fig = await read();
      got = urlId(fig.href);
    }
  }

  const ok = got === EXPECTED;
  ws.close();

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
