/**
 * figma-fns.mjs — page-side functions, as source strings.
 *
 * These run INSIDE the Figma tab via cdp.evaluate(). Plain JS, no imports, no
 * typings. All Figma knowledge lives here; cdp.mjs stays generic.
 *
 * Call convention (a string given to evaluate is an EXPRESSION):
 *   cdp.evaluate(`(${FIND_FN})(${JSON.stringify(args)})`)
 */

/** Shared page-side helpers, prepended to every function that needs them. */
const HELPERS = `
  const _hex = (c) => "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  const _round = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : undefined);
  const _pageOf = (n) => { let p = n; while (p && p.type !== "PAGE") p = p.parent; return p; };
  const _path = (n) => { const out = []; let p = n.parent; while (p && p.type !== "DOCUMENT") { out.unshift(p.name || p.type); p = p.parent; } return out.join(" / "); };
  async function _varOf(bound, key) {
    if (!bound || !bound[key]) return null;
    try {
      const v = await figma.variables.getVariableByIdAsync(bound[key].id);
      if (!v) return null;
      return { token: v.name, var: (v.codeSyntax || {}).WEB || null, id: v.id };
    } catch (e) { return null; }
  }
  const _mixed = (v) => v === figma.mixed;
`;

export const PROBE_FN = `(async () => (typeof figma === "undefined" ? null : { page: figma.currentPage.name }))()`;

export const PAGES_FN = `async () => {
  if (typeof figma === "undefined") return { error: "window.figma absent" };
  return { pages: figma.root.children.map((p) => ({ id: p.id, name: p.name, children: p.children ? p.children.length : 0 })) };
}`;

/**
 * Name search by REGEXP. Scope with `root` (a node id) to search a subtree —
 * that is how you go from "Pricing card" to "the button inside it".
 */
export const FIND_FN = `async ({ pattern, flags, root, types, limit }) => {
  ${HELPERS}
  if (typeof figma === "undefined") return { error: "window.figma absent" };
  let rx; try { rx = new RegExp(pattern, flags || "i"); } catch (e) { return { error: "bad regexp: " + e.message }; }

  let scope;
  if (root) {
    scope = await figma.getNodeByIdAsync(root);
    if (!scope) return { error: "root node not found: " + root };
  } else {
    try { await figma.loadAllPagesAsync(); } catch (e) {}
    scope = figma.root;
  }

  let hits = scope.findAll ? scope.findAll((n) => rx.test(n.name)) : [];
  if (!root && rx.test(scope.name || "")) { /* document name never matches meaningfully */ }
  if (types && types.length) hits = hits.filter((n) => types.indexOf(n.type) !== -1);

  return {
    scope: root ? { id: scope.id, name: scope.name, type: scope.type } : { id: "root", name: figma.root.name, type: "DOCUMENT" },
    count: hits.length,
    matches: hits.slice(0, limit || 100).map((n) => {
      const pg = _pageOf(n);
      return {
        id: n.id, name: n.name, type: n.type,
        page: pg ? pg.name : null,
        path: _path(n),
        w: _round(n.width), h: _round(n.height),
        visible: n.visible !== false,
      };
    }),
  };
}`;

/**
 * CSS-SHAPED read. This is the FE-facing verb.
 *
 * Figma stores `cornerRadius`, `itemSpacing`, `counterAxisAlignItems`. A frontend
 * dev asks for `border-radius`, `gap`, `align-items`. This function does that
 * translation EXPLICITLY so the model never has to guess a property name or a
 * mapping. Every value that is bound to a variable also reports `token` (the
 * Figma variable name) and `var` (its codeSyntax.WEB, e.g. "var(--sds-color-...)").
 */
/**
 * The layer panel: structure only, no CSS.
 *
 * The same traversal CSS_FN does, minus the ~25 property reads and the async
 * variable lookup behind every bound value — for a structure question that work
 * is pure cost, and the resulting wall of JSON is something the caller then has
 * to filter. What it adds is `textStyle`, which CSS_FN cannot report: a text
 * style binding lives on textStyleId and is invisible in the resolved font
 * values, so "Body Base" and "Single Line/Body Base" look identical without it.
 *
 * No nodeId → the current page, which is what the layer panel actually shows.
 */
export const LAYERS_FN = `async ({ nodeId, depth }) => {
  ${HELPERS}
  if (typeof figma === "undefined") return { error: "window.figma absent" };

  const _style = async (id) => {
    if (!id || _mixed(id)) return null;
    try { const s = await figma.getStyleByIdAsync(id); return s ? s.name : null; } catch (e) { return null; }
  };

  async function serialize(n, d) {
    const o = { id: n.id, name: n.name, type: n.type };
    if (n.visible === false) o.hidden = true;
    if (n.type === "INSTANCE") {
      // The layer name is renameable; the main component is the real identity.
      try {
        const mc = await n.getMainComponentAsync();
        if (mc) o.component = mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc.name;
      } catch (e) {}
      if (n.variantProperties) o.variant = n.variantProperties;
    }
    if (n.type === "TEXT") {
      o.characters = String(n.characters || "").slice(0, 60);
      o.textStyle = await _style(n.textStyleId);
    }
    if (n.children && n.children.length) {
      if (d > 0) { o.children = []; for (const c of n.children) o.children.push(await serialize(c, d - 1)); }
      else o.childCount = n.children.length;
    }
    return o;
  }

  if (nodeId === "selection") {
    const sel = figma.currentPage.selection;
    if (!sel.length) return { error: "nothing is selected — open a node first" };
    const nodes = []; for (const n of sel) nodes.push(await serialize(n, depth));
    return { page: figma.currentPage.name, nodes };
  }
  if (!nodeId || nodeId === "page") {
    return { page: figma.currentPage.name, nodes: [await serialize(figma.currentPage, depth)] };
  }
  const target = await figma.getNodeByIdAsync(nodeId);
  if (!target) return { error: "node not found: " + nodeId };
  return { page: (_pageOf(target) || target).name || null, nodes: [await serialize(target, depth)] };
}`;

/**
 * Node properties in FIGMA vocabulary — fills, strokes, cornerRadius,
 * itemSpacing, layoutMode, fontName. What the Plugin API actually calls things.
 *
 * This is the primary read. CSS_FN below is a second projection over the same
 * facts, kept because the Figma→CSS mapping (MIN→flex-start, HUG→fit-content,
 * "Semi Bold"→600) is real knowledge that a later codegen stage needs — but
 * translation is that stage's job, not this one's.
 *
 * What both projections share, and what neither invents: every value bound to a
 * variable also reports `token` (the variable's name) and `var`
 * (`codeSyntax.WEB`). That is the design-system link, not a translation —
 * codeSyntax is Figma's own field.
 */
export const INSPECT_FN = `async ({ nodeId, depth }) => {
  ${HELPERS}
  if (typeof figma === "undefined") return { error: "window.figma absent" };

  const _style = async (id) => {
    if (!id || _mixed(id)) return null;
    try { const s = await figma.getStyleByIdAsync(id); return s ? s.name : null; } catch (e) { return null; }
  };

  /**
   * Figma exposes an AGGREGATE property but binds the variable on the per-side
   * keys: a node with cornerRadius 8 has boundVariables.topLeftRadius, and never
   * boundVariables.cornerRadius. Looking up the aggregate name silently drops
   * the token — the value looks right and the design-system link is gone.
   */
  const BINDKEY = { cornerRadius: "topLeftRadius", strokeWeight: "strokeTopWeight" };

  /** A number, plus the variable it is bound to if there is one. */
  const num = async (n, key) => {
    const v = n[key];
    if (v === undefined || _mixed(v)) return undefined;
    const b = (await _varOf(n.boundVariables, key)) || (await _varOf(n.boundVariables, BINDKEY[key] || key));
    return b ? { value: _round(v), token: b.token, var: b.var } : _round(v);
  };

  const paints = async (list) => {
    if (!list || _mixed(list)) return undefined;
    const out = [];
    for (const p of list) {
      if (p.visible === false) continue;
      if (p.type !== "SOLID") { out.push({ type: p.type }); continue; }
      const e = { type: "SOLID", color: _hex(p.color) };
      if (p.opacity !== undefined && p.opacity !== 1) e.opacity = _round(p.opacity);
      const b = await _varOf(p.boundVariables, "color");
      if (b) { e.token = b.token; e.var = b.var; }
      out.push(e);
    }
    return out.length ? out : undefined;
  };

  // Figma's own UI shows these as "140%" / "-2%" / "16" — keep that rendering.
  const unit = (u) => {
    if (!u || _mixed(u)) return undefined;
    if (u.unit === "AUTO") return "AUTO";
    if (u.unit === "PERCENT") return _round(u.value) + "%";
    return _round(u.value);
  };

  async function propsOf(n) {
    const o = {};
    const set = async (k, key) => { const v = await num(n, key || k); if (v !== undefined) o[k] = v; };

    const f = await paints(n.fills); if (f) o.fills = f;
    const s = await paints(n.strokes); if (s) o.strokes = s;
    await set("strokeWeight");
    if (n.strokes && n.strokes.length) {
      if (n.strokeAlign) o.strokeAlign = n.strokeAlign;
      if (n.dashPattern && n.dashPattern.length) o.dashPattern = n.dashPattern;
    }

    if (n.cornerRadius !== undefined) {
      if (_mixed(n.cornerRadius)) {
        o.cornerRadius = { topLeft: _round(n.topLeftRadius), topRight: _round(n.topRightRadius),
                           bottomRight: _round(n.bottomRightRadius), bottomLeft: _round(n.bottomLeftRadius) };
      } else await set("cornerRadius");
    }

    if (n.layoutMode && n.layoutMode !== "NONE") {
      o.layoutMode = n.layoutMode;
      await set("itemSpacing");
      o.primaryAxisAlignItems = n.primaryAxisAlignItems;
      o.counterAxisAlignItems = n.counterAxisAlignItems;
      for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) await set(p);
      if (n.layoutSizingHorizontal) o.layoutSizingHorizontal = n.layoutSizingHorizontal;
      if (n.layoutSizingVertical) o.layoutSizingVertical = n.layoutSizingVertical;
    }
    if (n.width !== undefined) { o.width = _round(n.width); o.height = _round(n.height); }

    if (n.type === "TEXT") {
      if (n.fontName && !_mixed(n.fontName)) o.fontName = { family: n.fontName.family, style: n.fontName.style };
      await set("fontSize");
      const lh = unit(n.lineHeight); if (lh !== undefined) o.lineHeight = lh;
      const ls = unit(n.letterSpacing); if (ls !== undefined) o.letterSpacing = ls;
      if (n.textAlignHorizontal) o.textAlignHorizontal = n.textAlignHorizontal;
      if (n.textAlignVertical) o.textAlignVertical = n.textAlignVertical;
      if (n.textDecoration && n.textDecoration !== "NONE") o.textDecoration = n.textDecoration;
      if (n.textCase && n.textCase !== "ORIGINAL") o.textCase = n.textCase;
      const ts = await _style(n.textStyleId); if (ts) o.textStyle = ts;
      o.characters = String(n.characters || "").slice(0, 60);
    }

    if (n.opacity !== undefined && n.opacity !== 1) o.opacity = _round(n.opacity);
    if (n.visible === false) o.visible = false;
    if (n.clipsContent !== undefined) o.clipsContent = n.clipsContent;
    if (n.effects && n.effects.length) {
      o.effects = n.effects.filter((e) => e.visible !== false).map((e) => {
        const x = { type: e.type, radius: _round(e.radius) };
        if (e.offset) { x.offsetX = _round(e.offset.x); x.offsetY = _round(e.offset.y); }
        if (e.spread) x.spread = _round(e.spread);
        if (e.color) { x.color = _hex(e.color); x.alpha = _round(e.color.a); }
        return x;
      });
      const es = await _style(n.effectStyleId); if (es) o.effectStyle = es;
    }
    return o;
  }

  /**
   * The component's public API — what anyone placing it may configure.
   *
   * Five types, all of them Figma's, not any file's convention:
   *   VARIANT        pick one of variantOptions
   *   TEXT           overridable string
   *   BOOLEAN        show/hide a layer
   *   INSTANCE_SWAP  swap in another component
   *   SLOT           arbitrary nested content
   * An unrecognised type passes through rather than being dropped — SLOT is a
   * later addition than the other four, so the set is not assumed closed.
   *
   * Keys keep Figma's suffix (\`Label#2:0\`), because that is what an instance's
   * override map is keyed by and what you must match programmatically. \`name\`
   * carries the display half — what a designer actually says — and is emitted
   * only when it differs, which is exactly the non-VARIANT properties.
   *
   * preferredValues is COUNTED, never listed. It holds cross-file library keys
   * (576 of them on Button's icon slots), and resolving one to a name is an
   * importComponentByKeyAsync round trip each. That is the vars-truncation
   * mistake in a new costume: a payload nobody asked for, crowding out the
   * answer.
   */
  const contractOf = (defs) => {
    const out = {};
    for (const key of Object.keys(defs || {})) {
      const d = defs[key] || {};
      const e = { type: d.type };
      const display = key.split("#")[0];
      if (display !== key) e.name = display;
      if (d.defaultValue !== undefined) e.defaultValue = d.defaultValue;
      if (d.variantOptions) e.options = d.variantOptions;
      if (d.preferredValues) e.preferredValueCount = d.preferredValues.length;
      out[key] = e;
    }
    return Object.keys(out).length ? out : undefined;
  };

  /** What one INSTANCE actually set, against that API. */
  const overridesOf = async (props) => {
    const out = {};
    for (const key of Object.keys(props || {})) {
      const p = props[key] || {};
      const e = { type: p.type, value: p.value };
      const display = key.split("#")[0];
      if (display !== key) e.name = display;
      const b = await _varOf(p.boundVariables, "value");
      if (b) { e.token = b.token; e.var = b.var; }
      out[key] = e;
    }
    return Object.keys(out).length ? out : undefined;
  };

  async function serialize(n, d) {
    const o = { id: n.id, name: n.name, type: n.type, properties: await propsOf(n) };

    // COMPONENT_SET holds the contract; so does a standalone COMPONENT. On a
    // COMPONENT that IS a variant, Figma throws rather than returning the
    // parent's — hence the try, and hence reading the parent instead.
    if (n.type === "COMPONENT_SET" || n.type === "COMPONENT") {
      let defs = null;
      try { defs = n.componentPropertyDefinitions; } catch (e) { defs = null; }
      if (!defs && n.parent && n.parent.type === "COMPONENT_SET") {
        try { defs = n.parent.componentPropertyDefinitions; } catch (e) {}
      }
      const c = contractOf(defs);
      if (c) o.componentProperties = c;
      // Which variant this particular child is, when it is one.
      if (n.type === "COMPONENT" && n.variantProperties) o.variantProperties = n.variantProperties;
    }

    if (n.type === "INSTANCE") {
      try { const mc = await n.getMainComponentAsync();
            if (mc) o.mainComponent = mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc.name; } catch (e) {}
      if (n.variantProperties) o.variantProperties = n.variantProperties;
      let ov = null;
      try { ov = await overridesOf(n.componentProperties); } catch (e) {}
      if (ov) o.componentProperties = ov;
    }

    if (n.children && n.children.length) {
      if (d > 0) { o.children = []; for (const c of n.children) o.children.push(await serialize(c, d - 1)); }
      else o.childCount = n.children.length;
    }
    return o;
  }

  if (nodeId === "selection") {
    const sel = figma.currentPage.selection;
    if (!sel.length) return { error: "nothing is selected — open a node first" };
    const nodes = []; for (const n of sel) nodes.push(await serialize(n, depth));
    return { page: figma.currentPage.name, nodes };
  }
  const target = await figma.getNodeByIdAsync(nodeId);
  if (!target) return { error: "node not found: " + nodeId };
  return { page: (_pageOf(target) || {}).name || null, nodes: [await serialize(target, depth)] };
}`;

export const CSS_FN = `async ({ nodeId, depth }) => {
  ${HELPERS}
  if (typeof figma === "undefined") return { error: "window.figma absent" };

  const WEIGHTS = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400,
                    medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900 };
  const weightOf = (style) => {
    if (!style) return undefined;
    const k = String(style).toLowerCase().replace(/[^a-z]/g, "");
    return WEIGHTS[k];
  };
  const JUSTIFY = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
  const ALIGN = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };
  const SIZING = { HUG: "fit-content", FILL: "100%", FIXED: null };
  const ALIGN_TEXT = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };

  async function paintCss(p) {
    if (!p || p.visible === false) return null;
    if (p.type !== "SOLID") return { value: p.type.toLowerCase().replace("_", "-") };
    const v = await _varOf(p.boundVariables, "color");
    const o = { value: _hex(p.color) };
    if (p.opacity !== undefined && p.opacity !== 1) o.opacity = p.opacity;
    if (v) { o.token = v.token; o.var = v.var; }
    return o;
  }

  async function firstPaint(arr) {
    if (!arr || _mixed(arr) || !arr.length) return null;
    for (const p of arr) { const c = await paintCss(p); if (c) return c; }
    return null;
  }

  async function cssOf(n) {
    const css = {};
    const add = (k, v) => { if (v !== undefined && v !== null && v !== "") css[k] = v; };

    // --- box ---------------------------------------------------------------
    const b = n.absoluteBoundingBox;
    if (b) { add("width", _round(b.width) + "px"); add("height", _round(b.height) + "px"); }
    if (n.layoutSizingHorizontal && SIZING[n.layoutSizingHorizontal]) css.width = SIZING[n.layoutSizingHorizontal];
    if (n.layoutSizingVertical && SIZING[n.layoutSizingVertical]) css.height = SIZING[n.layoutSizingVertical];

    // --- background / colour ----------------------------------------------
    const fill = await firstPaint(n.fills);
    if (fill) add(n.type === "TEXT" ? "color" : "background-color", fill);

    // --- border ------------------------------------------------------------
    const stroke = await firstPaint(n.strokes);
    if (stroke) {
      add("border-color", stroke);
      if (n.strokeWeight !== undefined && !_mixed(n.strokeWeight)) add("border-width", _round(n.strokeWeight) + "px");
      add("border-style", n.dashPattern && n.dashPattern.length ? "dashed" : "solid");
    }

    // --- radius ------------------------------------------------------------
    if (!_mixed(n.cornerRadius) && n.cornerRadius) {
      const rv = await _varOf(n.boundVariables, "topLeftRadius");
      const o = { value: _round(n.cornerRadius) + "px" };
      if (rv) { o.token = rv.token; o.var = rv.var; }
      add("border-radius", o);
    } else if (_mixed(n.cornerRadius)) {
      const c = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map((x) => _round(x) + "px");
      add("border-radius", { value: c.join(" ") });
    }

    // --- layout ------------------------------------------------------------
    if (n.layoutMode && n.layoutMode !== "NONE") {
      add("display", "flex");
      add("flex-direction", n.layoutMode === "HORIZONTAL" ? "row" : "column");
      if (n.itemSpacing !== undefined) {
        const gv = await _varOf(n.boundVariables, "itemSpacing");
        const o = { value: _round(n.itemSpacing) + "px" };
        if (gv) { o.token = gv.token; o.var = gv.var; }
        add("gap", o);
      }
      add("justify-content", JUSTIFY[n.primaryAxisAlignItems]);
      add("align-items", ALIGN[n.counterAxisAlignItems]);
      if (n.layoutWrap === "WRAP") add("flex-wrap", "wrap");
    }

    // --- padding -----------------------------------------------------------
    const pads = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
    if (pads.some((k) => n[k])) {
      const vals = [];
      for (const k of pads) {
        const pv = await _varOf(n.boundVariables, k);
        vals.push({ px: _round(n[k] || 0) + "px", token: pv ? pv.token : null, var: pv ? pv.var : null });
      }
      const shorthand = vals.map((v) => v.px).join(" ");
      const anyToken = vals.some((v) => v.token);
      add("padding", anyToken ? { value: shorthand, parts: vals } : { value: shorthand });
    }

    // --- typography --------------------------------------------------------
    if (n.type === "TEXT") {
      if (n.fontName && !_mixed(n.fontName)) {
        add("font-family", n.fontName.family);
        add("font-weight", weightOf(n.fontName.style));
        add("font-style", /italic/i.test(n.fontName.style) ? "italic" : undefined);
      }
      if (!_mixed(n.fontSize)) add("font-size", _round(n.fontSize) + "px");
      if (n.lineHeight && !_mixed(n.lineHeight)) {
        add("line-height", n.lineHeight.unit === "AUTO" ? "normal"
          : n.lineHeight.unit === "PERCENT" ? _round(n.lineHeight.value) + "%" : _round(n.lineHeight.value) + "px");
      }
      if (n.letterSpacing && !_mixed(n.letterSpacing)) {
        add("letter-spacing", n.letterSpacing.unit === "PERCENT" ? _round(n.letterSpacing.value) + "%" : _round(n.letterSpacing.value) + "px");
      }
      add("text-align", ALIGN_TEXT[n.textAlignHorizontal]);
      if (n.textDecoration && n.textDecoration !== "NONE") add("text-decoration", String(n.textDecoration).toLowerCase());
      if (n.textCase && n.textCase !== "ORIGINAL") add("text-transform", n.textCase === "UPPER" ? "uppercase" : n.textCase === "LOWER" ? "lowercase" : "capitalize");
      if (n.textStyleId && typeof n.textStyleId === "string") {
        try { const s = await figma.getStyleByIdAsync(n.textStyleId); if (s) css["--text-style"] = s.name; } catch (e) {}
      }
    }

    // --- effects / misc ----------------------------------------------------
    if (n.opacity !== undefined && n.opacity !== 1) add("opacity", _round(n.opacity));
    if (n.effects && n.effects.length) {
      const shadows = n.effects.filter((e) => e.visible !== false && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"));
      if (shadows.length) {
        add("box-shadow", shadows.map((e) =>
          (e.type === "INNER_SHADOW" ? "inset " : "") +
          _round(e.offset.x) + "px " + _round(e.offset.y) + "px " + _round(e.radius) + "px " +
          _hex(e.color) ).join(", "));
      }
      const blur = n.effects.find((e) => e.visible !== false && e.type === "LAYER_BLUR");
      if (blur) add("filter", "blur(" + _round(blur.radius) + "px)");
    }
    if (n.clipsContent === true) add("overflow", "hidden");
    return css;
  }

  async function serialize(n, d) {
    const o = { id: n.id, name: n.name, type: n.type, css: await cssOf(n) };
    if (n.type === "TEXT") o.characters = n.characters;
    if (n.type === "INSTANCE") {
      try { const mc = await n.getMainComponentAsync();
            o.component = mc && mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc && mc.name; } catch (e) {}
      if (n.variantProperties) o.variant = n.variantProperties;
    }
    if (n.children && n.children.length) {
      if (d > 0) { o.children = []; for (const c of n.children) o.children.push(await serialize(c, d - 1)); }
      else o.childCount = n.children.length;
    }
    return o;
  }

  const target = nodeId === "selection" ? null : await figma.getNodeByIdAsync(nodeId);
  if (nodeId === "selection") {
    const sel = figma.currentPage.selection;
    if (!sel.length) return { error: "nothing selected" };
    const nodes = []; for (const n of sel) nodes.push(await serialize(n, depth));
    return { page: figma.currentPage.name, nodes };
  }
  if (!target) return { error: "node not found: " + nodeId };
  return { page: (_pageOf(target) || {}).name || null, nodes: [await serialize(target, depth)] };
}`;

/**
 * Variable lookup by name or id, with aliases resolved per mode.
 *
 * ── Paged, because a page is navigable and a cap is not ─────────────────────
 *
 * The Plugin API does not paginate: getLocalVariablesAsync() returns every
 * local variable in one call. The paging here is ours, and it exists only to
 * keep a broad regexp from putting a few hundred entries in front of the
 * agent at once.
 *
 * Every response is a full page envelope — page, pages, page_size, total —
 * so "is this all of them?" is answerable from the response alone, and the
 * next page is a parameter rather than a different query. --limit=all is not
 * a special case: it is one page holding everything, page 1 of 1.
 *
 * The previous version capped at 40 and said nothing, reporting count: 40 for
 * a file with 347 variables. Nothing downstream could tell a complete answer
 * from a truncated one — not the agent, not a grader, not a human reading the
 * output. A limit that cannot be detected is not a limit, it is a wrong
 * answer.
 *
 * (That cap was also applied per collection, since the `break` left only the
 * inner loop, so the real ceiling was 40 x collections. Nobody meant that.)
 *
 * ── One call, then filter ───────────────────────────────────────────────────
 *
 * It used to fetch every variable by id and THEN test the regexp, so a query
 * matching three variables still paid 347 round trips. Names come back with
 * getLocalVariablesAsync(), so the filter happens locally and only matches pay
 * for mode resolution. The old path is kept as a fallback for a Figma build
 * that predates the bulk getter.
 */
export const VARS_FN = `async ({ query, limit, page }) => {
  ${HELPERS}
  if (typeof figma === "undefined") return { error: "window.figma absent" };
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const modeName = (colId, modeId) => {
    const c = cols.find((x) => x.id === colId);
    const m = c && c.modes.find((mm) => mm.modeId === modeId);
    return m ? m.name : modeId;
  };
  async function resolve(v, modeId, seen) {
    const raw = v.valuesByMode[modeId];
    if (raw && raw.type === "VARIABLE_ALIAS") {
      if (seen.indexOf(raw.id) !== -1) return { alias: "<cycle>" };
      seen.push(raw.id);
      const next = await figma.variables.getVariableByIdAsync(raw.id);
      if (!next) return { alias: raw.id };
      const c = cols.find((x) => x.id === next.variableCollectionId);
      const nextMode = c ? (c.modes.find((m) => m.name === modeName(v.variableCollectionId, modeId)) || c.modes[0]).modeId : null;
      const inner = nextMode ? await resolve(next, nextMode, seen) : {};
      return Object.assign({ alias: next.name }, inner);
    }
    // _round, not raw: the API returns 0.699999988079071 for 70%, and line 252
    // in this same file already rounds. Two spellings of one value is a bug.
    if (v.resolvedType === "COLOR" && raw && typeof raw === "object" && "r" in raw) return { value: _hex(raw), alpha: _round(raw.a) };
    return { value: raw };
  }

  let rx; try { rx = new RegExp(query, "i"); } catch (e) { return { error: "bad regexp: " + e.message }; }

  // Every local variable, names included, without a round trip each.
  let all = null;
  if (typeof figma.variables.getLocalVariablesAsync === "function") {
    all = await figma.variables.getLocalVariablesAsync();
  } else {
    all = [];
    for (const c of cols) {
      for (const id of c.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) all.push(v);
      }
    }
  }

  const hits = all.filter((v) => v.id === query || rx.test(v.name));

  // limit == null means "one page holding everything". An empty result is
  // still page 1 of 1 — "page 1 of 0" is a shape nobody should have to parse.
  const total = hits.length;
  const size = limit == null ? total : limit;
  const pages = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
  // Clamped rather than rejected: an overshooting page number comes back as
  // the last page, and \`pages\` says where the agent actually is.
  const current = Math.min(Math.max(1, page || 1), pages);

  const out = [];
  for (const v of hits.slice((current - 1) * size, (current - 1) * size + size)) {
    const c = cols.find((x) => x.id === v.variableCollectionId);
    const modes = {};
    if (c) for (const m of c.modes) modes[m.name] = await resolve(v, m.modeId, [v.id]);
    out.push({ id: v.id, name: v.name, collection: c ? c.name : null, type: v.resolvedType,
               var: (v.codeSyntax || {}).WEB || null, modes });
  }

  return { query, page: current, pages, page_size: size, total, variables: out };
}`;

/**
 * Select a node WITHOUT navigating.
 *
 * setCurrentPageAsync + selection is faster and safer than a URL jump: no canvas
 * re-init wait, and no selection-drift class of bug to guard against. (The
 * clean-agent baseline found this independently.)
 */
/**
 * Back to the file's opening view: first page, nothing selected.
 *
 * Only an eval harness has any business calling this — see the gate in
 * figma.mjs. A human's browser position is theirs.
 */
export const RESET_FN = `async () => {
  if (typeof figma === "undefined") return { error: "window.figma absent" };
  const p = figma.root.children[0];
  if (!p) return { error: "file has no pages" };
  if (figma.currentPage.id !== p.id) await figma.setCurrentPageAsync(p);
  figma.currentPage.selection = [];
  return { page: figma.currentPage.name, pageId: figma.currentPage.id };
}`;

export const SELECT_FN = `async ({ nodeId }) => {
  if (typeof figma === "undefined") return { error: "window.figma absent" };
  const n = await figma.getNodeByIdAsync(nodeId);
  if (!n) return { error: "node not found: " + nodeId };
  if (n.type === "PAGE") {
    await figma.setCurrentPageAsync(n);
    return { page: figma.currentPage.name, pageId: figma.currentPage.id, selection: [] };
  }
  let pg = n; while (pg && pg.type !== "PAGE") pg = pg.parent;
  if (!pg) return { error: "node has no page ancestor: " + nodeId };
  if (figma.currentPage.id !== pg.id) await figma.setCurrentPageAsync(pg);
  figma.currentPage.selection = [n];
  try { figma.viewport.scrollAndZoomIntoView([n]); } catch (e) {}
  return {
    page: figma.currentPage.name,
    pageId: figma.currentPage.id,
    selection: figma.currentPage.selection.map((s) => ({ id: s.id, name: s.name, type: s.type })),
  };
}`;
