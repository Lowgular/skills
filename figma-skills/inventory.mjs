#!/usr/bin/env node
/**
 * inventory.mjs — dump the file's whole component inventory to fixtures/inventory.json.
 *
 * This is the raw material the dataset generator turns into cases. It answers the
 * question shapes the `css` verb cannot:
 *
 *   variant axes + their allowed values   "what are the variants of Avatar?"
 *   non-variant component properties      "what props does Button take?"
 *   composition (children, and for each
 *     INSTANCE the main component name)   "what is Avatar Block made of?"
 *   text styles + effect styles in use    "what typography does the Title use?"
 *
 * Usage:  node inventory.mjs            # writes fixtures/inventory.json, prints a summary
 *         node inventory.mjs --name=Ava # only sets whose name matches, for poking around
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { config, cdpAlive } from "./figma-browser/lib/connect.mjs";
import { connect } from "./figma-browser/lib/cdp.mjs";
import { PROBE_FN } from "./figma-browser/lib/figma-fns.mjs";

const argv = process.argv.slice(2);
const val = (f) => (argv.find((a) => a.startsWith(`--${f}=`)) || "").split("=")[1] || null;

const INVENTORY_FN = `async ({ filter }) => {
  if (typeof figma === "undefined") return { error: "window.figma absent" };
  await figma.loadAllPagesAsync();

  const hex = (c) => "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  const pageOf = (n) => { let p = n; while (p && p.type !== "PAGE") p = p.parent; return p; };

  const styleName = async (id) => {
    if (!id || id === figma.mixed) return null;
    const s = await figma.getStyleByIdAsync(id);
    return s ? s.name : null;
  };

  // Variable behind a bound property. Colour bindings live on the PAINT
  // (fills[0].boundVariables.color), not on the node — the node-level entry
  // only exists for scalars like cornerRadius.
  const varById = async (id) => {
    try { return id ? await figma.variables.getVariableByIdAsync(id) : null; } catch (e) { return null; }
  };
  const tokenOf = async (n, prop) => {
    let ref = null;
    if (prop === "fills" || prop === "strokes") {
      const p = n[prop] && n[prop] !== figma.mixed ? n[prop][0] : null;
      ref = p && p.boundVariables ? p.boundVariables.color : null;
    }
    if (!ref) {
      const b = n.boundVariables && n.boundVariables[prop];
      ref = Array.isArray(b) ? b[0] : b;
    }
    const v = ref && ref.id ? await varById(ref.id) : null;
    return v ? { token: v.name, var: (v.codeSyntax || {}).WEB || null } : null;
  };

  /** Typography in CSS vocabulary — what a frontend dev would ask for. */
  const typography = async (n) => {
    const lh = n.lineHeight, ls = n.letterSpacing;
    const fill = (n.fills && n.fills[0] && n.fills[0].type === "SOLID") ? n.fills[0] : null;
    const colorTok = await tokenOf(n, "fills");
    return {
      textStyle: await styleName(n.textStyleId),
      fontFamily: n.fontName && n.fontName !== figma.mixed ? n.fontName.family : null,
      fontStyleName: n.fontName && n.fontName !== figma.mixed ? n.fontName.style : null,
      fontSize: n.fontSize === figma.mixed ? null : n.fontSize,
      // Figma stores 140% as 139.9999976158142 — round, or the answer key is noise.
      lineHeight: !lh || lh === figma.mixed ? null : (lh.unit === "AUTO" ? "normal" : lh.unit === "PERCENT" ? Math.round(lh.value * 10) / 10 + "%" : Math.round(lh.value * 100) / 100 + "px"),
      letterSpacing: !ls || ls === figma.mixed ? null : (ls.unit === "PERCENT" ? Math.round(ls.value * 100) / 100 + "%" : Math.round(ls.value * 100) / 100 + "px"),
      textAlign: n.textAlignHorizontal || null,
      color: fill ? hex(fill.color) : null,
      colorToken: colorTok ? colorTok.token : null,
      colorVar: colorTok ? colorTok.var : null,
      characters: typeof n.characters === "string" ? n.characters.slice(0, 40) : null,
    };
  };

  /**
   * Composition tree. For INSTANCEs, resolve which component they are — that is
   * the answer to "what is this built from". Recurses through plain
   * FRAME/GROUP wrappers ("Info") to reach the TEXT nodes a dev asks about, but
   * stops at INSTANCE boundaries: inside an instance is the other component's
   * business, not this one's composition.
   */
  const compose = async (node, depth) => {
    const out = [];
    for (const c of node.children || []) {
      const e = { id: c.id, name: c.name, type: c.type, visible: c.visible !== false };
      if (c.type === "INSTANCE") {
        const main = await c.getMainComponentAsync().catch(() => null);
        if (main) {
          e.component = main.name;
          e.componentSet = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : null;
          e.mainId = main.id;
          // The variant this usage is set to, e.g. { Type: "Circle" }
          const props = c.componentProperties || {};
          const variant = {};
          for (const [k, v] of Object.entries(props)) if (v && v.type === "VARIANT") variant[k] = v.value;
          if (Object.keys(variant).length) e.variant = variant;
        }
      }
      if (c.type === "TEXT") e.typography = await typography(c);
      if (c.effectStyleId) e.effectStyle = await styleName(c.effectStyleId);
      if (c.children && c.children.length) {
        e.childCount = c.children.length;
        if (c.type !== "INSTANCE" && depth > 0) e.children = await compose(c, depth - 1);
      }
      out.push(e);
    }
    return out;
  };

  const propsOf = (n) => {
    const defs = n.componentPropertyDefinitions || {};
    const variantAxes = {}, props = [];
    for (const [key, d] of Object.entries(defs)) {
      if (d.type === "VARIANT") variantAxes[key] = d.variantOptions || [];
      else props.push({ name: key.split("#")[0], key, type: d.type, default: d.defaultValue });
    }
    return { variantAxes, props };
  };

  const sets = [], singles = [];
  for (const page of figma.root.children) {
    const walk = async (n) => {
      if (n.type === "COMPONENT_SET") {
        if (!filter || n.name.toLowerCase().indexOf(filter.toLowerCase()) !== -1) {
          const { variantAxes, props } = propsOf(n);
          const variants = [];
          for (const v of n.children) {
            const axis = {};
            for (const part of v.name.split(",")) {
              const [k, ...rest] = part.split("=");
              if (rest.length) axis[k.trim()] = rest.join("=").trim();
            }
            variants.push({ id: v.id, name: v.name, axis, children: await compose(v, 3) });
          }
          sets.push({ id: n.id, name: n.name, page: (pageOf(n) || {}).name || null, type: "COMPONENT_SET",
                      variantAxes, props, variantCount: n.children.length, variants });
        }
        return; // don't descend into variants twice
      }
      if (n.type === "COMPONENT") {
        if (!filter || n.name.toLowerCase().indexOf(filter.toLowerCase()) !== -1) {
          const { variantAxes, props } = propsOf(n);
          singles.push({ id: n.id, name: n.name, page: (pageOf(n) || {}).name || null, type: "COMPONENT",
                         variantAxes, props, children: await compose(n, 3) });
        }
        return;
      }
      for (const c of n.children || []) await walk(c);
    };
    for (const c of page.children || []) await walk(c);
  }

  const textStyles = (await figma.getLocalTextStylesAsync()).map((s) => ({
    id: s.id, name: s.name, fontFamily: s.fontName.family, fontStyleName: s.fontName.style,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight.unit === "AUTO" ? "normal" : s.lineHeight.unit === "PERCENT" ? Math.round(s.lineHeight.value * 10) / 10 + "%" : Math.round(s.lineHeight.value * 100) / 100 + "px",
    letterSpacing: s.letterSpacing.unit === "PERCENT" ? Math.round(s.letterSpacing.value * 100) / 100 + "%" : Math.round(s.letterSpacing.value * 100) / 100 + "px",
  }));
  const effectStyles = (await figma.getLocalEffectStylesAsync()).map((s) => ({
    id: s.id, name: s.name,
    effects: s.effects.map((e) => ({ type: e.type, x: e.offset ? e.offset.x : null, y: e.offset ? e.offset.y : null,
                                     blur: e.radius, spread: e.spread || 0,
                                     color: e.color ? hex(e.color) : null, alpha: e.color ? Math.round(e.color.a * 100) / 100 : null })),
  }));

  return { sets, singles, textStyles, effectStyles };
}`;

const cfg = config();
if (!(await cdpAlive(cfg.port))) {
  console.error(`✗ Chrome not running on :${cfg.port} — node figma-browser/lib/figma.mjs login`);
  process.exit(1);
}
const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
try {
  if (!(await cdp.evaluate(PROBE_FN, { timeoutMs: 5000 }).catch(() => null))) {
    console.error("✗ window.figma absent");
    process.exit(1);
  }
  const r = await cdp.evaluate(`(${INVENTORY_FN})(${JSON.stringify({ filter: val("name") })})`, { timeoutMs: 300_000 });
  if (r.error) throw new Error(r.error);
  mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./fixtures/inventory.json", import.meta.url), JSON.stringify(r, null, 2) + "\n");
  console.log(`sets: ${r.sets.length}   singles: ${r.singles.length}   textStyles: ${r.textStyles.length}   effectStyles: ${r.effectStyles.length}`);
  for (const s of r.sets) {
    const axes = Object.entries(s.variantAxes).map(([k, v]) => `${k}[${v.length}]`).join(" ");
    console.log(`  ${s.id.padEnd(14)} ${s.page.padEnd(14)} ${s.name.padEnd(28)} ${s.variantCount} variants   ${axes}`);
  }
} finally {
  cdp.close();
}
