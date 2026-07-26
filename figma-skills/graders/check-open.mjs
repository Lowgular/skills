/**
 * check-open.mjs — GENERIC deterministic grader for "open the right node".
 *
 * Given CASE_ID, look the expected node up in dataset.json, attach to the
 * dedicated Chrome, and decide whether the live editor is showing that node.
 * Never trusts the agent's self-report. No per-case logic here.
 *
 * Works for PAGE ids and for nodes inside a page:
 *   PAGE → figma.currentPage.id equals the expected id
 *   NODE → the node is SELECTED; its containing page will NOT match, correctly
 *
 * The URL is recorded but never sufficient on its own — it can survive a reset
 * and would let a later trial pass without doing any work.
 *
 * The expected id is read from dataset.json BY ABSOLUTE PATH, next to this file
 * and outside the agent's workspace. It is deliberately not passed in the
 * command line: skillgrade writes the grader command verbatim into
 * <workspace>/tests/test.sh, so an EXPECTED_ID= there would sit in the agent's
 * cwd as a plain-text answer key. CASE_ID leaks nothing — it is already the
 * task name.
 *
 * Infra comes from the skill: connect.mjs (config) + cdp.mjs (protocol). Zero deps.
 *
 * Env:  CASE_ID (required)  COVER_ID (default 3:5)
 */
import { readFileSync } from "node:fs";
import { config, cdpAlive } from "../figma-browser/lib/connect.mjs";
import { connect } from "../figma-browser/lib/cdp.mjs";

const CASE_ID = (process.env.CASE_ID || "").trim();
const COVER_ID = process.env.COVER_ID || "3:5";

const norm = (id) => (id || "").replace(/-/g, ":"); // URL uses "-", API uses ":"

function emit(score, details, checks) {
  console.log(JSON.stringify({ score, details, checks: checks || [] }));
  process.exit(0);
}

const READ_STATE = `(async () => (typeof figma === "undefined"
  ? { error: "window.figma absent" }
  : { pageId: figma.currentPage.id,
      pageName: figma.currentPage.name,
      selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name })) }))()`;

const RESET = `(async () => {
  const p = await figma.getNodeByIdAsync(${JSON.stringify(COVER_ID)});
  if (p && p.type === "PAGE") await figma.setCurrentPageAsync(p);
  figma.currentPage.selection = [];
  return true;
})()`;

if (!CASE_ID) {
  emit(0, "no CASE_ID provided to grader", [{ name: "config", passed: false, message: "CASE_ID unset" }]);
}
const ds = JSON.parse(readFileSync(new URL("../dataset.json", import.meta.url), "utf8"));
const kase = ds.cases.find((c) => c.id === CASE_ID);
if (!kase?.target?.nodeId) {
  emit(0, `unknown CASE_ID "${CASE_ID}" (or it has no target.nodeId)`, [
    { name: "config", passed: false, message: "not an open-case in dataset.json" },
  ]);
}
const EXPECTED_ID = kase.target.nodeId;
const EXPECTED_NAME = kase.target.name || "";

let cdp;
try {
  const cfg = config();
  // A grader must never spawn a browser mid-eval: Chrome being down is a
  // precondition failure, not something to paper over.
  if (!(await cdpAlive(cfg.port))) {
    emit(0, `Chrome not running on :${cfg.port}`, [{ name: "cdp-alive", passed: false, message: "no CDP" }]);
  }
  cdp = await connect({ port: cfg.port, match: cfg.fileKey });

  // Settle loop: canvas re-init after a navigation can take several seconds.
  let st = null;
  let urlId = null;
  for (let i = 0; i < 12; i++) {
    st = await cdp.evaluate(READ_STATE, { timeoutMs: 5000 }).catch((e) => ({ error: String(e.message || e) }));
    urlId = norm((((await cdp.currentUrl()) || "").match(/node-id=([\w-]+)/) || [])[1]);
    if (st && !st.error && (st.pageId === EXPECTED_ID || st.selection.some((n) => n.id === EXPECTED_ID))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const reachable = !!(st && !st.error);
  const pageMatch = !!(reachable && st.pageId === EXPECTED_ID);
  const selMatch = !!(reachable && st.selection.some((n) => n.id === EXPECTED_ID));
  const passed = pageMatch || selMatch;

  const checks = [
    { name: "currentPage is the expected node", passed: pageMatch,
      message: reachable ? `currentPage=${st.pageName} (${st.pageId})` : (st && st.error) || "unreachable" },
    { name: "expected node is selected", passed: selMatch,
      message: reachable ? `selection=${JSON.stringify(st.selection)}` : "unreachable" },
    { name: "url node-id matches (corroborating only)", passed: urlId === EXPECTED_ID,
      message: `url=${urlId || "none"} vs expected ${EXPECTED_ID}` },
  ];

  // Reset to Cover AND clear the selection so the next trial starts neutral —
  // a selected node otherwise survives the page switch and the next trial could
  // pass without doing any work.
  await cdp.evaluate(RESET, { timeoutMs: 10_000 }).catch(() => {});
  cdp.close();

  emit(
    passed ? 1 : 0,
    passed
      ? `on expected node ${EXPECTED_NAME || EXPECTED_ID}`
      : `not on expected node (page=${reachable ? st.pageId : "n/a"}, selection=${reachable ? JSON.stringify(st.selection) : "n/a"})`,
    checks,
  );
} catch (e) {
  try { cdp?.close(); } catch {}
  emit(0, "grader error: " + (e && e.message ? e.message : String(e)), [
    { name: "grader-ran", passed: false, message: String(e && e.message ? e.message : e) },
  ]);
}
