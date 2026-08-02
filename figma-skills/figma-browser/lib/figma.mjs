#!/usr/bin/env node
/**
 * figma.mjs — read a Figma design over a real, logged-in Chrome. Zero deps.
 *
 * One Bash call per operation. Run with NODE (not Bun).
 * Layers: connect.mjs (config + Chrome) → cdp.mjs (generic protocol) →
 *         figma-fns.mjs (page-side Figma code) → this file (CLI).
 *
 * Start here:  node lib/figma.mjs help
 */

import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config as baseConfig, cdpAlive, ensureChrome, sessionFile } from "./connect.mjs";
import { connect } from "./cdp.mjs";
import { PROBE_FN, PAGES_FN, FIND_FN, LAYERS_FN, INSPECT_FN, CSS_FN, VARS_FN, SELECT_FN, RESET_FN } from "./figma-fns.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};
const JSON_OUT = !!flag("json", false);

/**
 * The ambient read, once per process — this file is the entry point, so this is
 * where session context stops being ambient. Everything downstream is handed a
 * slug; nothing else here calls config() bare.
 */
const FILE = sessionFile();
const config = () => baseConfig({ file: FILE });

const emit = (obj) => console.log(JSON.stringify(obj, null, 2));
const die = (msg, hint) => {
  if (JSON_OUT) emit({ ok: false, error: msg, hint: hint || null });
  else {
    console.error(`\n✗ ${msg}`);
    if (hint) console.error(`  → ${hint}\n`);
  }
  process.exit(1);
};

/**
 * Escalate to the human and stop.
 *
 * Auth is the tool's problem, not the caller's. Nothing the model can do on its
 * own fixes "not logged in" — so instead of documenting a precondition ritual in
 * the skill and hoping it gets run, every entry point funnels here and the error
 * itself carries the instruction. Exit code 3 marks "blocked on a human" as
 * distinct from exit 1 ("bad request"), so a wrapper can tell them apart.
 */
const escalate = (problem, askUser) => {
  const payload = { ok: false, error: problem, needsHuman: true, askUser, exitCode: 3 };
  if (JSON_OUT) emit(payload);
  else {
    console.error(`\n✗ ${problem}\n`);
    console.error(`  ACTION REQUIRED — a human has to do this; you cannot.`);
    console.error(`  Ask the user:\n`);
    for (const line of askUser) console.error(`    • ${line}`);
    console.error(`\n  Then stop and wait for them to confirm. Do not retry, and do not`);
    console.error(`  attempt to reach Figma any other way.\n`);
  }
  process.exit(3);
};

const NOT_RUNNING = (port) => [
  `Run this in their own terminal:  node <skill>/lib/figma.mjs login`,
  `It opens a dedicated Chrome on port ${port} and waits for them to log in.`,
  `Leave the Figma file tab open in that window.`,
];

const NO_API = [
  `Confirm they are logged in to Figma in the dedicated Chrome window.`,
  `Confirm the file is open in the DESIGN EDITOR, not a preview or view-only link.`,
  `A view-only file has no Plugin API: it can show resolved values but NOT design`,
  `token names, so any spec built from one is raw hex that looks right and is wrong.`,
  `If the file is view-only, they need an editable copy before this can work.`,
];

/**
 * Return the browser to the file's opening view, ONCE per task. Eval only.
 *
 * ── Why this is gated, and why it is once ───────────────────────────────────
 *
 * An eval needs every trial to start from the same place, or a trial passes on
 * the previous trial's position: "open Pricing card" scores full marks against
 * a browser already parked on Pricing card. A human running this skill needs
 * the exact opposite — their browser is where they left it on purpose, and a
 * read-only tool that silently navigates away is a tool nobody trusts. So this
 * is off unless FIGMA_RESET_ON_CONNECT is set, which only the eval box sets.
 *
 * ONCE matters as much as the gate. Every operation is its own process and
 * every process connects, so "reset on connect" without a latch would mean
 * reset before EVERY command — and the workflow this skill prescribes is
 * `open` then `inspect`. The second command would wipe what the first
 * selected, and the task could never be completed at all.
 *
 * The latch is cwd. skillgrade's local provider gives each trial a fresh
 * workspace directory (providers/local.js: /tmp/skillgrade-<random>) and runs
 * the agent in it, so cwd is a per-trial identity that every child process
 * inherits for free — no session to thread, no id to invent. A new trial is a
 * new directory, so it resets again.
 */
function maybeReset(cdp) {
  if (!process.env.FIGMA_RESET_ON_CONNECT) return null;
  const mark = join(tmpdir(), `figma-reset-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12)}`);
  if (existsSync(mark)) return null;
  // Written BEFORE the reset runs: if the reset throws, the retry storm of
  // resetting on every subsequent command is worse than not resetting at all.
  writeFileSync(mark, process.cwd());
  return cdp.evaluate(run(RESET_FN, {}), { timeoutMs: 15_000 }).catch(() => null);
}

/**
 * Attach to the file tab and confirm the Plugin API is live.
 *
 * Every read operation goes through here, so auth failures surface at the point
 * of use with an actionable escalation — there is no precondition step for the
 * caller to remember or skip.
 */
async function withFigma(fn) {
  const cfg = config();
  if (!cfg.fileKey) return escalate(cfg.fileError, [cfg.fileHint]);
  if (!(await cdpAlive(cfg.port))) {
    return escalate(`No Chrome is listening on port ${cfg.port}.`, NOT_RUNNING(cfg.port));
  }

  const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
  try {
    const probe = await cdp.evaluate(PROBE_FN, { timeoutMs: 5000 }).catch(() => null);
    if (!probe) {
      return escalate("Chrome is running, but the Figma Plugin API is not available on that tab.", NO_API);
    }
    await maybeReset(cdp);
    return await fn(cdp, cfg);
  } finally {
    cdp.close();
  }
}

const run = (fnSrc, args) => `(${fnSrc})(${JSON.stringify(args)})`;

// ---------------------------------------------------------------------------

async function status() {
  const cfg = config();
  const report = {
    ok: false, port: cfg.port, profile: cfg.profile, chromeBin: cfg.bin,
    chromeBinExists: cfg.binExists, figmaFile: cfg.figmaFile, fileKey: cfg.fileKey,
    cdpAlive: false, figmaApi: false,
  };
  report.cdpAlive = await cdpAlive(cfg.port);
  if (!report.cdpAlive) {
    if (JSON_OUT) emit(report);
    else console.log(`  port ${cfg.port}\n  profile ${cfg.profile}\n  chrome ${cfg.bin}${cfg.binExists ? "" : "  ✗ NOT FOUND"}\n  ✗ CDP not answering`);
    return escalate(`No Chrome is listening on port ${cfg.port}.`, NOT_RUNNING(cfg.port));
  }
  if (!cfg.fileKey) return escalate(cfg.fileError, [cfg.fileHint]);

  const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
  try {
    const probe = await cdp.evaluate(PROBE_FN, { timeoutMs: 5000 }).catch(() => null);
    report.figmaApi = !!probe;
    report.currentPage = probe ? probe.page : null;
    report.ok = !!probe;
  } finally {
    cdp.close();
  }
  if (!report.ok && !JSON_OUT) return escalate("Chrome is running, but the Figma Plugin API is not available on that tab.", NO_API);
  if (JSON_OUT) emit(report);
  else {
    console.log(`  port     ${cfg.port}`);
    console.log(`  profile  ${cfg.profile}`);
    console.log(`  file     ${cfg.figmaFile}  (${cfg.fileKey})`);
    console.log(`  ✓ CDP alive`);
    console.log(report.ok ? `  ✓ window.figma live — currentPage="${report.currentPage}"\n\n✓ ready\n` : `  ✗ window.figma absent`);
  }
  if (!report.ok) process.exit(1);
}

async function login() {
  const cfg = config();
  const waitMs = Number(flag("wait", 300)) * 1000;
  if (!cfg.binExists) return die(`Chrome not found at: ${cfg.bin}`, "set FIGMA_CHROME_BIN in .env");

  const target = cfg.fileUrl || "https://www.figma.com/login";
  console.log(`\n  profile  ${cfg.profile}\n  port     ${cfg.port}\n  opening  ${target}`);
  const { launched } = await ensureChrome({ url: target });
  console.log(launched ? "  ✓ Chrome launched" : `  ✓ Chrome already running on :${cfg.port}`);
  if (!cfg.fileKey) return console.log(`\n  ⚠ ${cfg.fileError} — log in, then: ${cfg.fileHint}\n`);

  console.log(`\n  → Log in as a user who can EDIT this file, and leave the tab open.`);
  console.log(`    Waiting up to ${waitMs / 1000}s for the design editor…\n`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
      const probe = await cdp.evaluate(PROBE_FN, { timeoutMs: 3000 }).catch(() => null);
      cdp.close();
      if (probe) {
        console.log(`  ✓ logged in — window.figma live, currentPage="${probe.page}"`);
        console.log(`  ✓ session saved to ${cfg.profile}`);
        console.log(`\n✓ ready. One-time — the session persists across restarts.\n`);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  die("timed out waiting for a live design editor",
      "confirm you are logged in AND the file is an editable copy (previews are view-only)");
}

// ---------------------------------------------------------------------------
// resolve: query → one node, or refuse
// ---------------------------------------------------------------------------

const DEF_TYPES = ["COMPONENT_SET", "COMPONENT", "FRAME", "SECTION"];
const looksLikeId = (s) => /^I?\d+:\d+(;\d+:\d+)*$/.test(s);

/** Name exactness dominates node type — see references/browser-use.md. */
function rank(matches, pattern) {
  const q = pattern.trim().toLowerCase();
  const nameScore = (n) => {
    const s = n.trim().toLowerCase();
    if (s === q) return 0;
    if (s.endsWith("/" + q)) return 1;
    if (s.startsWith(q)) return 2;
    return 3;
  };
  const typeScore = (t) => (DEF_TYPES.indexOf(t) === -1 ? DEF_TYPES.length : DEF_TYPES.indexOf(t));
  return matches
    .map((m) => ({ ...m, _n: nameScore(m.name), _t: typeScore(m.type) }))
    .sort((a, b) => a._n - b._n || a._t - b._t);
}

async function resolveOne(cdp, arg, { root, instances }) {
  if (looksLikeId(arg)) return { id: arg };
  const r = await cdp.evaluate(run(FIND_FN, { pattern: arg, root: root || null, types: null, limit: 300 }), { timeoutMs: 60_000 });
  if (r.error) throw new Error(r.error);
  if (!r.count) return { error: `nothing matching /${arg}/i${root ? ` inside ${root}` : ""}` };
  const pool = instances ? r.matches : r.matches.filter((m) => m.type !== "INSTANCE");
  const ranked = rank(pool.length ? pool : r.matches, arg);
  const best = ranked[0];
  const tied = ranked.filter((m) => m._n === best._n && m._t === best._t);
  if (tied.length > 1) return { error: `ambiguous: ${tied.length} equally good ${best.type} candidates`, candidates: tied };
  return { id: best.id, match: best };
}

function bail(res) {
  if (JSON_OUT) emit(res);
  else {
    console.error(`\n✗ ${res.error}`);
    (res.candidates || []).forEach((c) => console.error(`    ${c.id.padEnd(22)} ${c.page} / ${c.name}`));
    console.error("");
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------

const pages = () =>
  withFigma(async (cdp) => {
    const r = await cdp.evaluate(run(PAGES_FN, {}));
    if (JSON_OUT) return emit(r);
    r.pages.forEach((p) => console.log(`  ${p.id.padEnd(16)} ${String(p.children).padStart(3)}  ${p.name}`));
  });

const find = () =>
  withFigma(async (cdp) => {
    const pattern = pos[0];
    if (!pattern) return die("usage: find <regexp> [--in=<id>] [--type=T1,T2] [--instances] [--limit=N]");
    const root = flag("in") ? String(flag("in")) : null;
    const types = flag("type") ? String(flag("type")).split(",") : null;
    const limit = Number(flag("limit", 40));
    const r = await cdp.evaluate(run(FIND_FN, { pattern, root, types, limit: 300 }), { timeoutMs: 60_000 });
    if (r.error) return die(r.error);
    const pool = flag("instances") ? r.matches : r.matches.filter((m) => m.type !== "INSTANCE");
    const ranked = rank(pool, pattern).slice(0, limit);
    if (JSON_OUT) return emit({ ...r, shown: ranked.length, hiddenInstances: r.matches.length - pool.length, matches: ranked });
    const hidden = r.matches.length - pool.length;
    console.log(`\nfind /${pattern}/i in ${r.scope.name} → ${r.count} match(es)${hidden ? `, ${hidden} instance(s) hidden (--instances)` : ""}\n`);
    for (const m of ranked) {
      console.log(`  ${m.id.padEnd(22)} ${m.type.padEnd(14)} ${m.w ?? "?"}×${m.h ?? "?"}  ${m.page ?? "?"} / ${m.name}`);
    }
    console.log("");
  });

/** Indented layer tree — the left panel. */
function printTree(nodes, indent = 2) {
  for (const n of nodes) {
    const pad = " ".repeat(indent);
    let line = `${pad}${n.name || "(unnamed)"}`.padEnd(46) + n.type.padEnd(14);
    if (n.component) line += `→ ${n.component}`;
    if (n.variant) line += `  {${Object.entries(n.variant).map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
    if (n.textStyle) line += `→ ${n.textStyle}`;
    if (n.characters) line += `   "${n.characters}"`;
    if (n.hidden) line += "   (hidden)";
    if (n.childCount) line += `   … ${n.childCount} child(ren), raise --depth`;
    console.log(line.replace(/\s+$/, ""));
    if (n.children) printTree(n.children, indent + 2);
  }
}

const layers = () =>
  withFigma(async (cdp) => {
    // No target = the current page. The layer panel does not ask you which page.
    const arg = pos[0] || "page";
    let nodeId = arg;
    if (arg !== "page" && arg !== "selection" && !looksLikeId(arg)) {
      const res = await resolveOne(cdp, arg, { root: flag("in") ? String(flag("in")) : null, instances: !!flag("instances") });
      if (res.error) return bail(res);
      nodeId = res.id;
    }
    const r = await cdp.evaluate(run(LAYERS_FN, { nodeId, depth: Number(flag("depth", 2)) }), { timeoutMs: 60_000 });
    if (r.error) return die(r.error);
    if (JSON_OUT) return emit(r);
    console.log(`\n  page "${r.page}"\n`);
    printTree(r.nodes);
    console.log("");
  });

/**
 * inspect — node properties in FIGMA vocabulary (the default), or CSS with --css.
 *
 * Figma-native is the default because it is what the file actually says. The CSS
 * projection is a translation, and translating is a later stage's job — but it
 * stays one flag away so nothing has to be rediscovered.
 */
const inspect = () =>
  withFigma(async (cdp) => {
    // No target = whatever is selected. The right panel follows the selection.
    const arg = pos[0] || "selection";
    let nodeId = arg;
    if (arg !== "selection") {
      const res = await resolveOne(cdp, arg, { root: flag("in") ? String(flag("in")) : null, instances: !!flag("instances") });
      if (res.error) return bail(res);
      nodeId = res.id;
    }
    const fn = flag("css") ? CSS_FN : INSPECT_FN;
    const r = await cdp.evaluate(run(fn, { nodeId, depth: Number(flag("depth", 1)) }), { timeoutMs: 60_000 });
    if (r.error) return die(r.error);
    emit(r);
  });

/** Kept so `css` still means "the translated view" without a flag. */
const css = () => {
  if (!argv.includes("--css")) argv.push("--css");
  return inspect();
};

const vars = () =>
  withFigma(async (cdp) => {
    const q = pos[0];
    if (!q) return die("usage: vars <regexp|variable-id>");
    const r = await cdp.evaluate(run(VARS_FN, { query: q }), { timeoutMs: 60_000 });
    if (r.error) return die(r.error);
    emit(r);
  });

const open = () =>
  withFigma(async (cdp) => {
    const arg = pos[0];
    if (!arg) return die("usage: open <id|regexp>");
    const res = await resolveOne(cdp, arg, { root: flag("in") ? String(flag("in")) : null, instances: !!flag("instances") });
    if (res.error) return bail(res);
    // No URL navigation: setCurrentPage + selection is faster and has no
    // canvas-re-init wait and no selection-drift failure mode.
    const st = await cdp.evaluate(run(SELECT_FN, { nodeId: res.id }), { timeoutMs: 30_000 });
    if (st.error) return die(st.error);
    const ok = st.selection.length === 1 ? st.selection[0].id === res.id : st.pageId === res.id;
    const payload = { ok, opened: res.match || { id: res.id }, ...st };
    if (JSON_OUT) return emit(payload);
    const m = res.match;
    console.log(`\n  opened ${m ? `${m.type} "${m.name}" ` : ""}(${res.id})`);
    console.log(`  page      "${st.page}"`);
    console.log(`  selection ${JSON.stringify(st.selection)}`);
    console.log(ok ? "  ✓ verified\n" : "  ✗ NOT verified\n");
    if (!ok) process.exit(1);
  });

// ---------------------------------------------------------------------------

const COMMANDS = { login, status, pages, find, layers, inspect, css, vars, open };

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(`
  figma.mjs — read a Figma design over a real, logged-in Chrome. Zero deps.

  Read  (no navigation, no state change)
    pages                    list the file's pages
    layers [<id|regexp>]     the LEFT PANEL: layer tree. No argument = current page.
                             Per layer: name, type, the component an INSTANCE came
                             from + its variant, and the text style of a TEXT layer.
                             Structure only — no CSS, so it is small and fast.
        --depth=N              levels to descend (default 2)
    find <regexp>            the SEARCH BOX: node names by REGEXP; always a list, never picks
        --in=<id>              search inside one node's subtree (nested layers)
        --type=FRAME,TEXT      filter by node type
        --instances            include INSTANCEs (hidden by default: usages, not definitions)
        --limit=N              max rows (default 40)
    inspect [<id|regexp>]    the RIGHT PANEL: properties of a layer, in FIGMA
                             vocabulary. No argument = whatever is selected.
                               fills strokes strokeWeight cornerRadius
                               layoutMode itemSpacing primaryAxisAlignItems
                               counterAxisAlignItems padding{Top,Right,Bottom,Left}
                               layoutSizing{Horizontal,Vertical} width height
                               fontName{family,style} fontSize lineHeight
                               letterSpacing textAlignHorizontal textDecoration
                               textCase textStyle characters
                               opacity effects effectStyle clipsContent
                             Every value bound to a variable also reports:
                               token  the variable name       e.g. "Radius/200"
                               var    its codeSyntax.WEB      e.g. "var(--sds-size-radius-200)"
        --depth=N              include N levels of children (default 1)
        --css                  translate to CSS names instead (same as the css command)
    css [<id|regexp>]        same read, projected to CSS names — a convenience for
                             codegen. Adds font-weight/font-style/text-decoration,
                             flex-* and fit-content/100% sizing:
                               background-color, color, border-radius, border-*,
                               padding, gap, display, flex-direction, justify-content,
                               align-items, width, height, font-family, font-size,
                               font-weight, line-height, letter-spacing, text-align,
                               opacity, box-shadow, overflow
                             Every value bound to a variable also reports:
                               token  the Figma variable name   e.g. "Border/Default"
                               var    its codeSyntax.WEB        e.g. "var(--sds-color-border)"
        --depth=N              include N levels of children (default 1)
        --in=<id>              resolve the regexp inside this subtree
    vars <regexp|id>         variables matching a name: per-mode values, aliases resolved

  Act
    open <id|regexp>         select a node (setCurrentPage + selection; no URL jump)

  Flags:  --json  machine-readable

  Anything accepting <id|regexp> takes a node id (12:34 or I12:34;56:78) or a regexp.
  Ambiguous regexps are REFUSED with the candidate list — narrow it or pass an id.

  Auth is not your problem. Any read fails with exit code 3 and instructions when a
  human is needed; follow them and stop. There is no precondition to run first.

  Human setup (a person runs these, not you)
    login [--wait=N]         open the dedicated Chrome and wait for a Figma login
    status                   report port / profile / CDP / Plugin API
`);
  process.exit(cmd ? 0 : 1);
}

const fn = COMMANDS[cmd];
if (!fn) die(`unknown command: ${cmd}`, `try: ${Object.keys(COMMANDS).join(", ")}`);
fn().catch((e) => die(String(e?.message || e)));
