#!/usr/bin/env node
/**
 * extract.mjs — fill the `expected` blocks in dataset.json from the LIVE file.
 *
 * Expected values are never hand-typed. A hex or a token name typed by a human
 * is a coin-flip; this reads the same Plugin API a designer's Dev Mode panel
 * reads, so the answer key is exactly what the file says today.
 *
 *   node extract.mjs            # print what WOULD change (diff against dataset)
 *   node extract.mjs --write    # write it back into dataset.json
 *   node extract.mjs --case=X   # one case only
 *
 * The circularity is real and deliberate: this uses the same reader the agent
 * uses, so it cannot detect a bug that is present TODAY in figma-fns.mjs. What
 * it does give you is a frozen snapshot — if the reader regresses tomorrow, the
 * eval goes red. Present-day correctness is a human job: spot-check one case per
 * property kind against Figma's own Dev Mode panel (`--sheet` prints the list).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config, cdpAlive } from "./figma-browser/lib/connect.mjs";
import { connect } from "./figma-browser/lib/cdp.mjs";
import { PROBE_FN, CSS_FN, VARS_FN } from "./figma-browser/lib/figma-fns.mjs";

const DATASET = new URL("./dataset.json", import.meta.url);
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.find((a) => a.startsWith(`--${f}=`)) || "").split("=")[1] || null;

const run = (fnSrc, args) => `(${fnSrc})(${JSON.stringify(args)})`;

/**
 * Collapse a css value to the answer-protocol shape: {value, token, var}.
 * Uniform 4-side padding becomes one entry — that is how a dev states it
 * ("padding 12px, Space/300"), and asking an agent to reproduce a 4-element
 * parts array would be grading JSON gymnastics instead of design reading.
 */
function shape(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return { value: v, token: null, var: null };
  if (Array.isArray(v.parts)) {
    const toks = [...new Set(v.parts.map((p) => p.token || null))];
    const vars = [...new Set(v.parts.map((p) => p.var || null))];
    return {
      value: v.value,
      token: toks.length === 1 ? toks[0] : toks,
      var: vars.length === 1 ? vars[0] : vars,
    };
  }
  return { value: v.value ?? null, token: v.token ?? null, var: v.var ?? null };
}

async function extractCase(cdp, c) {
  const out = {};
  for (const r of c.reads || []) {
    if (r.variable) {
      const res = await cdp.evaluate(run(VARS_FN, { query: r.variable }), { timeoutMs: 60_000 });
      if (res.error) throw new Error(`${c.id}: vars ${r.variable}: ${res.error}`);
      if (res.count !== 1) throw new Error(`${c.id}: /${r.variable}/ matched ${res.count} variables — must match exactly 1`);
      const v = res.variables[0];
      out[`${r.as}.var`] = { value: v.var, token: v.name, var: v.var };
      for (const [mode, m] of Object.entries(v.modes)) {
        out[`${r.as}.${mode}`] = { value: m.value, token: m.alias || null, var: null };
      }
      continue;
    }
    const res = await cdp.evaluate(run(CSS_FN, { nodeId: r.node, depth: 0 }), { timeoutMs: 60_000 });
    if (res.error) throw new Error(`${c.id}: css ${r.node}: ${res.error}`);
    const node = res.nodes[0];
    for (const p of r.props) {
      // A property the node genuinely does not have is a FACT, not an error:
      // Button/Subtle has no fill, Tag/Primary has no stroke. Recording it as
      // null makes "there is no background" the gradable answer, and the wrong
      // answer — inventing #ffffff — fails. Only flag it when the case asked
      // for nothing but absences, which means the node id is probably wrong.
      const s = shape(node.css[p]);
      out[`${r.as}.${p}`] = s === null ? { value: null, token: null, var: null } : s;
    }
    if (r.props.every((p) => node.css[p] === undefined)) {
      throw new Error(`${c.id}: node ${r.node} ("${node.name}") has NONE of ${r.props.join(", ")} — wrong node?`);
    }
    out[`_meta.${r.as}`] = { id: node.id, name: node.name, type: node.type, page: res.page };
  }
  return out;
}

const ds = JSON.parse(readFileSync(DATASET, "utf8"));
const only = val("case");
const targets = ds.cases.filter(
  (c) => c.kind === "values" && (!only || c.id === only) && (c.reads || []).length,
);
if (!targets.length) {
  console.error(only ? `no values-case with id "${only}"` : "no values-cases with `reads` in dataset.json");
  process.exit(1);
}

const cfg = config();
if (!(await cdpAlive(cfg.port))) {
  console.error(`✗ Chrome not running on :${cfg.port} — node figma-browser/lib/figma.mjs login`);
  process.exit(1);
}
const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
let failed = 0;
try {
  if (!(await cdp.evaluate(PROBE_FN, { timeoutMs: 5000 }).catch(() => null))) {
    console.error("✗ window.figma absent — not logged in, or the file is view-only");
    process.exit(1);
  }
  for (const c of targets) {
    let next;
    try {
      next = await extractCase(cdp, c);
    } catch (e) {
      console.error(`✗ ${c.id}: ${e.message}`);
      failed++;
      continue;
    }
    const before = JSON.stringify(c.expected || {});
    const after = JSON.stringify(next);
    const changed = before !== after;
    console.log(`\n${changed ? (Object.keys(c.expected || {}).length ? "~ CHANGED" : "+ NEW    ") : "= same   "}  ${c.id}`);
    for (const [k, v] of Object.entries(next)) {
      if (k.startsWith("_meta.")) continue;
      const old = (c.expected || {})[k];
      const mark = !old ? "+" : JSON.stringify(old) === JSON.stringify(v) ? " " : "~";
      console.log(`   ${mark} ${k.padEnd(28)} ${v.value === null ? "(not set)" : v.value}${v.token ? `   ${v.token}` : ""}`);
      if (mark === "~") console.log(`       was: ${old.value}${old.token ? `   ${old.token}` : ""}`);
    }
    for (const [k, v] of Object.entries(next)) {
      if (k.startsWith("_meta.")) console.log(`     ${k.slice(6)} → ${v.type} "${v.name}" on ${v.page} (${v.id})`);
    }
    if (has("--write")) c.expected = next;
  }
} finally {
  cdp.close();
}

if (has("--write") && !failed) {
  writeFileSync(DATASET, JSON.stringify(ds, null, 2) + "\n");
  console.log(`\n✓ wrote dataset.json — ${targets.length} case(s). Now: node build-eval.mjs`);
} else if (has("--write")) {
  console.error(`\n✗ ${failed} case(s) failed — nothing written. Fix the node ids first.`);
  process.exit(1);
} else {
  console.log("\n(dry run — pass --write to save)");
}
