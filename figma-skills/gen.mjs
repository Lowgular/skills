#!/usr/bin/env node
/**
 * gen.mjs — build datasets/rows.jsonl from the live Figma file.
 *
 * Row shape is deliberately flat and classical: one task, one grader, one
 * expected value.
 *
 *   { "id": "...", "task": "<one full sentence>", "grader": "open|value|list|refuse",
 *     "value": <node id | scalar | array | null>, "note": "<optional one-liner>" }
 *
 * Call sites write that ergonomic shape; the writer at the bottom adds the
 * derived columns (tier, type, form, file_key) and carries `tags` — the one
 * hand-written column — forward by id. Column contract: datasets/load.mjs.
 *
 * Why one fact per row: the previous shape had a per-case JSON contract printed
 * into the instruction, which (a) made response format part of what was being
 * tested and (b) leaked answers — a required key of "axes.Shape" hands over the
 * axis name the agent was asked to find. Atomising removes both problems. A
 * question with five facts becomes five rows, and every answer is a scalar or a
 * flat list.
 *
 * Tiers:
 *   easy    the task names a unique thing (a text style, a variable, a page).
 *           Find it, read one field.
 *   medium  the target is one variant among siblings, or the answer is the token
 *           binding rather than the value.
 *   hard    the answer is the structure — axes, properties, composition — or the
 *           right answer is a refusal.
 *
 * Sources: fixtures/inventory.json (run inventory.mjs first) + a live CDP read
 * for box values. Run:  node gen.mjs [--write] [--prune]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config, cdpAlive } from "./figma-browser/lib/connect.mjs";
import { connect } from "./figma-browser/lib/cdp.mjs";
import { PROBE_FN, INSPECT_FN, VARS_FN } from "./figma-browser/lib/figma-fns.mjs";
import { ROWS_PATH, CURATED, loadRows, classify, serialize } from "./datasets/load.mjs";

const WRITE = process.argv.includes("--write");
const PRUNE = process.argv.includes("--prune");
const inv = JSON.parse(readFileSync(new URL("./fixtures/inventory.json", import.meta.url), "utf8"));
const setBy = (n) => inv.sets.find((s) => s.name === n);
const singleBy = (n) => inv.singles.find((s) => s.name === n);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const easy = [], medium = [], hard = [];

/**
 * Rows carry `graders: [{ name, arguments: string[] }]`.
 *
 * Uniform shape, always strings, so a task can be graded on several independent
 * facts without inventing a JSON response contract for it. Call sites still
 * write the ergonomic `grader:`/`value:` pair and this normalises it.
 */
const row = (bucket, r) => {
  const { grader, value, minCandidates, ...rest } = r;
  const args =
    grader === "refuse" ? [String(minCandidates ?? 0)]
    : Array.isArray(value) ? value.map(String)
    : [String(value)];
  const out = { ...rest, graders: [{ name: grader, arguments: args }] };
  bucket.push(out);
  return out;
};

// ═══════════════════════════════════════════════════════════════════ EASY
// The task names a unique thing. Find it, read one field.

// ── pages ────────────────────────────────────────────────────────────────
for (const [q, name, id] of [
  ["Tooltips", "Tooltip", "280:23459"], ["buttons", "Buttons", "128:10284"],
  ["the accordion", "Accordion", "128:10528"], ["dialog / modal", "Dialog", "128:10421"],
  ["tabs", "Tabs", "128:11109"], ["pagination", "Pagination", "128:10525"],
  ["avatars", "Avatars", "128:10526"],
]) {
  row(easy, {
    id: `open-${slug(name)}`,
    task: `Open the page for ${q} in this Figma file.`,
    grader: "open",
    value: id,
    note: `The page is called "${name}" — the task wording is deliberately loose.`,
  });
}

// ── text styles: one row per FIGMA field ─────────────────────────────────
//
// Figma names, not CSS: fontSize is a number (not "16px"), and the weight lives
// in fontName.style as a NAME ("Semi Bold"), not a number. That collapses what
// used to be two rows — font-weight and font-style — into one, because Figma
// stores "Semi Bold" and "Italic" in the same field.
const styles = inv.textStyles.filter((s) => !s.name.startsWith("."));
for (const s of styles) {
  const q = `the "${s.name}" text style`;
  row(easy, { id: `type-${slug(s.name)}-fontsize`, task: `What fontSize does ${q} use?`, grader: "value", value: s.fontSize });
  row(easy, { id: `type-${slug(s.name)}-fontstyle`, task: `What is the fontName.style of ${q}?`, grader: "value", value: s.fontStyleName,
              note: `Figma keeps weight and italics together in fontName.style. Translating "${s.fontStyleName}" to a CSS font-weight is a later stage's job.` });
  row(easy, { id: `type-${slug(s.name)}-lineheight`, task: `What lineHeight does ${q} use?`, grader: "value", value: s.lineHeight });
  row(easy, { id: `type-${slug(s.name)}-fontfamily`, task: `What is the fontName.family of ${q}?`, grader: "value", value: s.fontFamily });
}
row(easy, { id: "type-body-link-textdecoration", task: 'What textDecoration does the "Body Link" text style use?', grader: "value", value: "UNDERLINE",
            note: "The only thing distinguishing Body Link from Body Base. A Figma enum, not a CSS keyword." });
row(easy, { id: "type-body-base-letterspacing", task: 'What letterSpacing does the "Body Base" text style use?', grader: "value", value: "0%" });
row(easy, { id: "type-title-hero-letterspacing", task: 'What letterSpacing does the "Title Hero" text style use?', grader: "value", value: "-3%",
            note: "Negative tracking on the display sizes; the body styles are all 0%." });

// ── variables: resolved value per mode, and the alias behind it ───────────
const VARS = ["Background/Brand/Default", "Background/Brand/Hover", "Text/Default/Secondary",
              "Text/Default/Tertiary", "Border/Danger/Default", "Background/Disabled/Default",
              "Text/Brand/On Brand", "Space/400", "Radius/400", "Space/200", "Radius/200"];

// ═════════════════════════════════════════════════════════════════ MEDIUM
// One variant among siblings, or the token binding rather than the value.

const BOX = [
  ["Button", "Variant=Primary, State=Default, Size=Medium", ["fills", "cornerRadius", "itemSpacing"]],
  ["Button", "Variant=Primary, State=Hover, Size=Medium", ["fills"]],
  ["Button", "Variant=Primary, State=Disabled, Size=Medium", ["fills"]],
  ["Button", "Variant=Neutral, State=Default, Size=Medium", ["fills", "strokes"]],
  ["Button", "Variant=Subtle, State=Default, Size=Medium", ["fills"]],
  ["Button", "Variant=Primary, State=Default, Size=Small", ["paddingTop", "itemSpacing"]],
  ["Tag", "Scheme=Brand, State=Default, Variant=Primary", ["fills", "cornerRadius"]],
  ["Tag", "Scheme=Danger, State=Default, Variant=Primary", ["fills"]],
  ["Tag", "Scheme=Positive, State=Default, Variant=Primary", ["fills"]],
  ["Avatar", "Type=Initial, Size=Large, Shape=Circle", ["cornerRadius", "width"]],
  ["Avatar", "Type=Initial, Size=Small, Shape=Square", ["cornerRadius", "width"]],
  ["Avatar", "Type=Initial, Size=Medium, Shape=Circle", ["width"]],
  ["Menu Item", "State=Hover", ["fills"]],
  ["Notification", "Variant=Alert", ["fills", "cornerRadius"]],
  ["Tooltip", "Placement=Top", ["fills", "cornerRadius"]],
  ["Navigation Pill", "State=Active", ["fills"]],
  ["Pagination Page", "State=Current", ["fills"]],
];

// How to ask for each Figma property in a sentence, and where its value sits.
// fills/strokes are arrays of paints, so the fact lives at [0].color.
const ASK = {
  fills: ["fill colour", (v) => v && v[0] && v[0].color, (v) => v && v[0] && v[0].token],
  strokes: ["stroke colour", (v) => v && v[0] && v[0].color, (v) => v && v[0] && v[0].token],
  cornerRadius: ["cornerRadius", (v) => (v && v.value !== undefined ? v.value : v), (v) => v && v.token],
  itemSpacing: ["itemSpacing", (v) => (v && v.value !== undefined ? v.value : v), (v) => v && v.token],
  paddingTop: ["paddingTop", (v) => (v && v.value !== undefined ? v.value : v), (v) => v && v.token],
  width: ["width", (v) => v, () => null],
  height: ["height", (v) => v, () => null],
};

// ═══════════════════════════════════════════════════════════════════ HARD
// The answer is the structure, or the right answer is a refusal.

const AXIS_WORD = { Size: "sizes", Shape: "shapes", Type: "types", Scheme: "colour schemes",
                    State: "states", Placement: "placements", Spacing: "spacing options",
                    Direction: "directions", Variant: "variants", Active: "active states",
                    "Value Type": "value types", Align: "alignments", Device: "devices",
                    Platform: "platforms", Density: "densities", "Asset Type": "asset types" };

const AXIS_SETS = ["Avatar", "Avatar Group", "Button", "Tag", "Tag Toggle", "Tooltip", "Card",
                   "Pricing Card", "Input Field", "Checkbox Field", "Radio Field", "Select Field",
                   "Switch Field", "Textarea Field", "Search", "Menu Item", "Navigation Button",
                   "Navigation Pill", "Pagination Page", "Tab", "Notification", "Text Price"];

for (const name of AXIS_SETS) {
  const s = setBy(name);
  if (!s) continue;
  const axes = Object.keys(s.variantAxes);
  if (!axes.length) continue;
  row(hard, {
    id: `axes-${slug(name)}`,
    task: `What are the names of the variant axes on the ${name} component?`,
    grader: "list",
    value: axes,
    note: `${axes.length} axis/axes, ${s.variantCount} variants in the set. The axis names live in componentPropertyDefinitions, not in the layer tree.`,
  });
  for (const [axis, opts] of Object.entries(s.variantAxes)) {
    row(hard, {
      id: `axis-${slug(name)}-${slug(axis)}`,
      task: `What ${AXIS_WORD[axis] || axis.toLowerCase()} does the ${name} component support?`,
      grader: "list",
      value: opts,
      note: `The "${axis}" axis. Answer must not mix in options from the other ${axes.length - 1} axis/axes.`,
    });
  }
}

const PROP_SETS = ["Button", "Avatar", "Avatar Group", "Tag", "Card", "Notification", "Tooltip",
                   "Input Field", "Select Field", "Checkbox Field", "Switch Field", "Menu Item",
                   "Navigation Button", "Tag Toggle", "Text Price", "Textarea Field"];

for (const name of PROP_SETS) {
  const s = setBy(name) || singleBy(name);
  if (!s?.props.length) continue;
  row(hard, {
    id: `props-${slug(name)}`,
    task: `Which content properties does the ${name} component expose? Exclude the variant axes.`,
    grader: "list",
    value: s.props.map((p) => p.name),
    note: `${s.props.length} propert${s.props.length === 1 ? "y" : "ies"}. Figma suffixes the keys ("Label#2:0") — the suffix is storage detail.`,
  });
  for (const p of s.props.filter((p) => p.type === "SLOT" || p.type === "INSTANCE_SWAP")) {
    row(hard, {
      id: `proptype-${slug(name)}-${slug(p.name)}`,
      task: `What Figma property type is the "${p.name}" property of the ${name} component?`,
      grader: "value",
      value: p.type,
      note: p.type === "SLOT"
        ? "SLOT means content projection (ng-content / children), not a value input."
        : "INSTANCE_SWAP means a swappable child component, not a string.",
    });
  }
}

const COMPOSE = [
  ["Avatar Block", null], ["Pricing Card", "Device=Desktop, Variant=Brand"],
  ["Card", "Asset Type=Icon, Variant=Default, Direction=Vertical"],
  ["Notification", "Variant=Alert"], ["Menu Item", "State=Default"],
  ["Input Field", "State=Default, Value Type=Default"], ["Tooltip", "Placement=Top"],
  ["Checkbox Field", "State=Default, Value Type=Checked"], ["Text Content Heading", "Align=Start"],
];

const usedComponents = (node) => {
  const out = [];
  const walk = (kids) => { for (const c of kids || []) { if (c.type === "INSTANCE" && (c.componentSet || c.component)) out.push(c.componentSet || c.component); walk(c.children); } };
  walk(node.children);
  return [...new Set(out)];
};
const textLayerNames = (node) => {
  const out = [];
  const walk = (kids) => { for (const c of kids || []) { if (c.type === "TEXT") out.push(c.name); walk(c.children); } };
  walk(node.children);
  return [...new Set(out)];
};
const textLayerStyle = (node, layer) => {
  let hit = null;
  const walk = (kids) => { for (const c of kids || []) { if (!hit && c.type === "TEXT" && c.name === layer) hit = c.typography; walk(c.children); } };
  walk(node.children);
  return hit;
};

for (const [name, variantName] of COMPOSE) {
  const s = setBy(name) || singleBy(name);
  const node = variantName ? s?.variants?.find((v) => v.name === variantName) : s;
  if (!node?.children?.length) continue;
  const label = variantName ? `${name} (${variantName.replace(/\w+=/g, "").split(", ").join(" / ")})` : name;
  const uses = usedComponents(node);
  const texts = textLayerNames(node);
  if (uses.length) {
    row(hard, {
      id: `uses-${slug(name)}`,
      task: `Which other components is the ${label} component built out of?`,
      grader: "list",
      value: uses,
      note: "Each child INSTANCE must be resolved to its main component — a layer name can be renamed and is not reliable.",
    });
  }
  if (texts.length) {
    row(hard, {
      id: `textlayers-${slug(name)}`,
      task: `What are the names of the text layers inside the ${label} component?`,
      grader: "list",
      value: texts,
    });
  }
  for (const layer of texts) {
    const t = textLayerStyle(node, layer);
    if (!t?.textStyle) continue;
    row(hard, {
      id: `textstyle-${slug(name)}-${slug(layer)}`,
      task: `Which text style is the "${layer}" layer in ${label} using?`,
      grader: "value",
      value: t.textStyle,
      note: "The style binding is on textStyleId and is invisible in the resolved font values — two layers can both read Inter 16px while using different styles.",
    });
    if (t.colorToken) {
      row(hard, {
        id: `textcolor-${slug(name)}-${slug(layer)}`,
        task: `Which design token is the text colour of the "${layer}" layer in ${label} bound to?`,
        grader: "value",
        value: t.colorToken,
      });
    }
  }
}

// ── inventory ────────────────────────────────────────────────────────────
const uiPages = [...new Set(inv.sets.map((s) => s.page))].filter((p) => p !== "Utilities" && p !== "Examples");
row(hard, {
  id: "inv-ui-groups",
  task: 'Which pages of this file define component sets? Skip the internal "Utilities" and "Examples" pages.',
  grader: "list",
  value: uiPages,
  note: "The scope rule is stated in the task so the boundary is not a guess; what is tested is walking every page and checking for COMPONENT_SETs.",
});
for (const page of ["Inputs", "Buttons", "Avatars", "Tags", "Navigation", "Pagination", "Text"]) {
  const names = inv.sets.filter((s) => s.page === page).map((s) => s.name);
  if (names.length < 2) continue;
  row(hard, { id: `inv-page-${slug(page)}`, task: `Which component sets are defined on the ${page} page?`, grader: "list", value: names });
}
row(hard, {
  id: "inv-text-styles",
  task: "List the names of every text style in this file, leaving out the internal ones whose name starts with a dot.",
  grader: "list",
  value: styles.map((s) => s.name),
  note: 'The two "Single Line/" styles are easy to miss — they duplicate names above them and differ only in line-height.',
});
row(hard, {
  id: "inv-effect-styles",
  task: "List the names of every effect style defined in this file.",
  grader: "list",
  value: inv.effectStyles.map((s) => s.name),
  note: "Effect styles are a separate namespace from variables; a run that searches only variables concludes there are no shadows.",
});

// ── refusals ─────────────────────────────────────────────────────────────
row(hard, {
  id: "refuse-carousel",
  task: "What is the background colour of the Carousel component?",
  grader: "refuse",
  value: null,
  minCandidates: 0,
  note: "There is no Carousel in this file. The failure is inventing a colour or silently substituting Tabs.",
});
row(hard, {
  id: "refuse-tag-background",
  task: "What is the Tag component's background colour?",
  grader: "refuse",
  value: null,
  minCandidates: 5,
  note: "Tag has 5 colour schemes x 2 states x 2 variants; 'the' background does not exist. Must name the axes, not pick one.",
});
row(hard, {
  id: "refuse-pricing-card-button",
  task: "What is the background colour of the button in the Pricing Card?",
  grader: "refuse",
  value: null,
  minCandidates: 2,
  note: "Four Button instances live inside the Pricing Card component set, at two different widths. Any single answer is a guess.",
});

// ── the broad-inventory questions ────────────────────────────────────────
//
// "what are the colors?" / "what are the components?" cannot be graded as an
// exact set — the answer is 100+ items and one debatable entry fails the row
// while telling you nothing. Three shapes make them gradable:
//
//   list      when the set is small and its boundary is unambiguous — usually
//             the GROUP level (Background/Text/Border/Icon) rather than the 136
//             individual variables.
//   count     "how many" — the only check that catches a run which sampled
//             instead of enumerating. Requires the task to state the boundary.
//   contains  recall over a big set, scored as a fraction.
//
// COLLECTIONS is filled by the live read below, then these rows are appended.
const COLLECTIONS_ROWS = (cols) => {
  const byName = (n) => cols.find((c) => c.collection === n);

  row(hard, {
    id: "inv-variable-collections",
    task: "What are the names of the variable collections in this file?",
    grader: "list",
    value: cols.map((c) => c.collection),
    note: `${cols.length} collections. "Color Primitives" and "Color" are separate — the first holds raw ramps, the second the semantic tokens that alias them.`,
  });

  row(hard, {
    id: "inv-color-collections",
    task: "Which variable collections in this file hold colours?",
    grader: "list",
    value: cols.filter((c) => c.types.includes("COLOR")).map((c) => c.collection),
    note: 'The honest answer to "what are the colours?" — there are two distinct answers (raw ramps vs semantic tokens), so the question has to be resolved before it can be answered.',
  });

  for (const [id, name, task, note] of [
    ["inv-color-groups", "Color",
     "What are the top-level groups of the semantic Color variable collection?",
     "4 groups over 136 variables. Asked at the group level because listing 136 names is not a gradable answer."],
    ["inv-color-primitive-families", "Color Primitives",
     "What colour families does the Color Primitives collection define?",
     "10 families of 10 steps each. Includes Black and White as full 10-step ramps, which is easy to miss."],
    ["inv-size-groups", "Size",
     "What are the top-level groups of the Size variable collection?",
     'The answer to "what are the size tokens?" at a gradable level. Note Depth (13) and Icon (3) live here too — a run that assumes size means only Space and Radius misses half of it.'],
    ["inv-typography-groups", "Typography",
     "What are the top-level groups of the Typography variable collection?",
     "Parallel to the text styles but a different namespace — these are variables, not styles."],
  ]) {
    const c = byName(name);
    if (!c) continue;
    row(hard, { id, task, grader: "list", value: Object.keys(c.groups), note });
  }

  for (const c of cols.filter((x) => x.modes.length > 1)) {
    row(hard, {
      id: `inv-modes-${slug(c.collection)}`,
      task: `What modes does the "${c.collection}" variable collection have?`,
      grader: "list",
      value: c.modes,
      note: `${c.modes.length} modes — every variable in this collection resolves to a different value per mode.`,
    });
  }

  // counts — the check that catches sampling
  for (const c of cols) {
    row(hard, {
      id: `count-vars-${slug(c.collection)}`,
      task: `How many variables are defined in the "${c.collection}" variable collection?`,
      grader: "count",
      value: c.count,
    });
  }
  row(hard, {
    id: "count-component-sets",
    task: "How many component sets (COMPONENT_SET nodes, not individual components) does this file define across all of its pages?",
    grader: "count",
    value: inv.sets.length,
    note: "The boundary is stated in the task because it is the whole difficulty: variants inside a set are COMPONENTs, and counting those instead gives a number in the hundreds.",
  });
  row(hard, {
    id: "count-text-styles",
    task: "How many text styles does this file define, including the internal dot-prefixed ones?",
    grader: "count",
    value: inv.textStyles.length,
  });
  row(hard, {
    id: "count-effect-styles",
    task: "How many effect styles does this file define?",
    grader: "count",
    value: inv.effectStyles.length,
  });

  // recall over the big set
  row(hard, {
    id: "inv-all-component-sets",
    task: "List the names of every component set defined in this file, comma-separated.",
    grader: "contains",
    value: inv.sets.map((s) => s.name),
    note: `${inv.sets.length} sets. Graded by RECALL, not exact match — extras are ignored, so the score says how much of the file the run actually walked rather than pass/fail on one debatable entry.`,
  });
};

// ═════════════════════════════════════════════════ live reads for the rest

const cfg = config();
if (!(await cdpAlive(cfg.port))) {
  console.error(`✗ Chrome not running on :${cfg.port} — node figma-browser/lib/figma.mjs login`);
  process.exit(1);
}
const cdp = await connect({ port: cfg.port, match: cfg.fileKey, openUrl: cfg.fileUrl });
const run = (fn, args) => `(${fn})(${JSON.stringify(args)})`;
try {
  if (!(await cdp.evaluate(PROBE_FN, { timeoutMs: 5000 }).catch(() => null))) {
    console.error("✗ window.figma absent");
    process.exit(1);
  }

  const COLLECTIONS_FN = `async () => {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    const out = [];
    for (const c of cols) {
      const groups = {}; const types = [];
      for (const id of c.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (!v) continue;
        const g = v.name.split("/")[0];
        groups[g] = (groups[g] || 0) + 1;
        if (types.indexOf(v.resolvedType) === -1) types.push(v.resolvedType);
      }
      out.push({ collection: c.name, modes: c.modes.map((m) => m.name), count: c.variableIds.length, types, groups });
    }
    return out;
  }`;
  COLLECTIONS_ROWS(await cdp.evaluate(`(${COLLECTIONS_FN})()`, { timeoutMs: 180_000 }));

  // variables → easy rows (per-mode value + the alias behind it)
  for (const name of VARS) {
    const r = await cdp.evaluate(run(VARS_FN, { query: `^${name.replace(/[/]/g, "\\/")}$` }), { timeoutMs: 60_000 });
    const v = r.variables?.find((x) => x.name === name);
    if (!v) { console.error(`  ⚠ variable not found: ${name}`); continue; }
    row(easy, {
      id: `varcss-${slug(name)}`,
      task: `What is the CSS custom property name for the ${name} variable?`,
      grader: "value",
      value: v.var,
      note: "Comes from codeSyntax.WEB on the variable, which is populated for every variable in this file.",
    });
    const modes = Object.entries(v.modes);
    for (const [mode, m] of modes) {
      const suffix = modes.length > 1 ? ` in ${mode} mode` : "";
      row(easy, {
        id: `var-${slug(name)}-${slug(mode)}`,
        task: `What value does the ${name} variable resolve to${suffix}?`,
        grader: "value",
        value: typeof m.value === "number" ? m.value : m.value,
      });
      if (m.alias) {
        row(easy, {
          id: `alias-${slug(name)}-${slug(mode)}`,
          task: `Which variable is ${name} an alias of${suffix}?`,
          grader: "value",
          value: m.alias,
          note: "SDS semantic tokens alias primitives; a dev changing the colour needs the primitive, not the semantic name.",
        });
      }
    }
  }

  // box values → medium rows (the value, and the variable it is bound to)
  for (const [name, variantName, props] of BOX) {
    const s = setBy(name);
    const v = s?.variants?.find((x) => x.name === variantName);
    if (!v) { console.error(`  ⚠ variant not found: ${name} / ${variantName}`); continue; }
    const nice = variantName.replace(/\w+=/g, "").split(", ").join(" / ");
    const r = await cdp.evaluate(run(INSPECT_FN, { nodeId: v.id, depth: 0 }), { timeoutMs: 60_000 });
    const p = r.nodes?.[0]?.properties || {};
    for (const prop of props) {
      const [label, getVal, getTok] = ASK[prop];
      const raw = p[prop];
      const id = `${slug(name)}-${slug(variantName)}-${slug(prop)}`;
      if (raw === undefined) {
        row(medium, {
          id: `prop-${id}`,
          task: `What is the ${label} of the ${name} component, ${nice} variant?`,
          grader: "value", value: "none",
          note: `This variant genuinely has no ${prop} — the answer is "none". Inventing a colour is the failure.`,
        });
        continue;
      }
      row(medium, {
        id: `prop-${id}`,
        task: `What is the ${label} of the ${name} component, ${nice} variant?`,
        grader: "value", value: getVal(raw),
        note: `Requires resolving "${variantName}" out of ${s.variantCount} variants of ${name}.`,
      });
      const tok = getTok(raw);
      if (tok) {
        row(medium, {
          id: `token-${id}`,
          task: `Which variable is the ${label} of the ${name} component, ${nice} variant, bound to?`,
          grader: "value", value: tok,
          note: "The variable name, not the resolved value — this is the fact a view-only file cannot give you.",
        });
      }
    }
  }
} finally {
  cdp.close();
}

// medium also carries the one non-page open case
row(medium, {
  id: "open-pricing-card",
  task: "Open the Pricing Card component definition and select it.",
  grader: "open",
  value: "1444:11846",
  note: "14 nodes match /pricing card/i and 13 are INSTANCEs; the definition is the COMPONENT_SET. Opening its page is not enough — the node itself must end up selected.",
});

// ──────────────────────────────────────────────────────────────── write

const files = { easy, medium, hard };
const ids = new Set();
for (const [tier, rows] of Object.entries(files)) {
  for (const r of rows) {
    if (ids.has(r.id)) console.error(`  ⚠ duplicate id: ${r.id}`);
    ids.add(r.id);
    for (const g of r.graders) {
      if (!g.arguments.length) console.error(`  ⚠ ${tier}/${r.id}: grader ${g.name} has no arguments`);
      if (g.name !== "refuse" && g.arguments.some((a) => a === "undefined" || a === "null" || a === ""))
        console.error(`  ⚠ ${tier}/${r.id}: grader ${g.name} has an empty argument`);
    }
  }
}
/**
 * Read-merge-write, because `tags` is the one column a human writes and this
 * script owns the file. Every other column is derived and gets overwritten;
 * CURATED comes forward by id. A curated row the generator no longer emits is
 * NOT dropped silently — it is reported, and --prune is required to lose it.
 */
const prior = existsSync(ROWS_PATH) ? new Map(loadRows().map((r) => [r.id, r])) : new Map();

const out = [];
for (const [tier, rows] of Object.entries(files)) {
  for (const r of rows) {
    const { type, form } = classify(r.id);
    const carried = {};
    for (const c of CURATED) if (prior.get(r.id)?.[c]?.length) carried[c] = prior.get(r.id)[c];
    out.push({
      id: r.id,
      tier,
      type,
      form,
      file_key: process.env.FIGMA_FILE_KEY,
      tags: [],
      ...carried,
      task: r.task,
      note: r.note,
      graders: r.graders,
    });
  }
}
out.sort((a, b) => a.id.localeCompare(b.id));

// The diff summary is the actual review artifact. Nobody reads 328 lines of
// JSON, but "5 answers changed on existing ids" is a line that stops a merge.
const fresh = new Set(out.map((r) => r.id));
const added = out.filter((r) => !prior.has(r.id));
const removed = [...prior.values()].filter((r) => !fresh.has(r.id));
const changed = out.filter((r) => {
  const p = prior.get(r.id);
  return p && JSON.stringify(p.graders) !== JSON.stringify(r.graders);
});
const orphaned = removed.filter((r) => r.tags?.length);
const curated = out.filter((r) => r.tags?.length);

for (const [tier, rows] of Object.entries(files)) {
  const byGrader = rows.reduce((a, r) => { for (const g of r.graders) a[g.name] = (a[g.name] || 0) + 1; return a; }, {});
  console.log(`${tier.padEnd(7)} ${String(rows.length).padStart(3)} rows   ${Object.entries(byGrader).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
console.log(`${"TOTAL".padEnd(7)} ${String(out.length).padStart(3)} rows`);

if (prior.size) {
  console.log(
    `\ndiff vs rows.jsonl: +${added.length} row(s), -${removed.length}, ` +
      `${changed.length} answer(s) changed on existing ids, curation preserved on ${curated.length}`,
  );
  for (const r of changed.slice(0, 10)) {
    console.log(`  ~ ${r.id}: ${JSON.stringify(prior.get(r.id).graders)} → ${JSON.stringify(r.graders)}`);
  }
  if (changed.length > 10) console.log(`  … ${changed.length - 10} more`);
}

if (orphaned.length && !PRUNE) {
  console.error(`\n✗ ${orphaned.length} curated row(s) are no longer generated:`);
  for (const r of orphaned) console.error(`    ${r.id}  [${r.tags.join(", ")}]`);
  console.error(`  re-run with --prune to drop them, or fix the generator.`);
  process.exit(1);
}

if (WRITE) {
  mkdirSync(new URL("./datasets/", import.meta.url), { recursive: true });
  writeFileSync(ROWS_PATH, out.map(serialize).join("\n") + "\n");
  console.log(`\n✓ wrote datasets/rows.jsonl — next: node build-eval.mjs`);
} else {
  console.log("\n(dry run — pass --write to save)");
}
