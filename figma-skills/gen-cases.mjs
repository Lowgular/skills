#!/usr/bin/env node
/**
 * gen-cases.mjs — turn fixtures/inventory.json into dataset cases.
 *
 * The pipeline:
 *   inventory.mjs   live file  → fixtures/inventory.json   (raw truth)
 *   gen-cases.mjs   inventory  → dataset.json              (this file)
 *   extract.mjs     live file  → fills `expected` for css-value cases
 *   build-eval.mjs  dataset    → eval.yaml
 *
 * Hand-written cases in dataset.json are preserved: anything without
 * `"generated": true` is left exactly as it is.
 *
 * ── Why enumeration cases have ONE key ───────────────────────────────────────
 * build-eval.mjs prints the required answer.json keys into the instruction. For
 * "what variants does Avatar have?" a key list of ["axes.Type","axes.Size",
 * "axes.Shape"] would hand over the axis names the agent was asked to find. So
 * every enumeration is a single key holding a set or a map, and the grader
 * compares it order-insensitively. Keep it that way when adding families.
 *
 *   node gen-cases.mjs            # dry run: counts by family
 *   node gen-cases.mjs --write
 */
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const DATASET = new URL("./dataset.json", import.meta.url);
const inv = JSON.parse(readFileSync(new URL("./fixtures/inventory.json", import.meta.url), "utf8"));
const ds = JSON.parse(readFileSync(DATASET, "utf8"));

const setByName = (n) => inv.sets.find((s) => s.name === n);
const singleByName = (n) => inv.singles.find((s) => s.name === n);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Figma style names → CSS font-weight. Roughly the CSS_FN table, kept in sync by hand. */
const WEIGHT = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Italic: 400, Medium: 500,
                 "Semi Bold": 600, SemiBold: 600, Bold: 700, "Extra Bold": 800, Black: 900 };
const weightOf = (styleName) => WEIGHT[styleName] ?? null;

/**
 * Tiers — by what the ANSWER requires, not by how obscure the component is.
 *
 *   easy      the question names the target exactly and it is unique in the
 *             file — a text style, a variable, a page. Pure lookup: find the
 *             named thing, read its fields. No sibling to disambiguate.
 *   medium    the target must be resolved among siblings (one variant out of
 *             20), and the token binding has to be reported beside the value.
 *   advanced  the answer IS the structure — axes, properties, composition. One
 *             key holding a set or map, because the member names are the answer.
 *
 * All three have deterministic ground truth. Only `advanced` requires the model
 * to understand Figma's object model rather than just read a field.
 *
 * The answer FORMAT is not a tier property — build-eval.mjs derives it from the
 * shape of `expected`, so a scalar fact is a scalar and a set is a list.
 */
const TIER = {
  type: "easy", token: "easy", open: "easy",
  css: "medium", typo: "medium", button: "medium",
  axes: "advanced", axis: "advanced", props: "advanced", uses: "advanced",
  texts: "advanced", inv: "advanced", notfound: "advanced", ambiguous: "advanced",
};
const tierOf = (id) => TIER[id.split("-")[0]] || "medium";

const cases = [];
const add = (c) => cases.push({ ...c, tier: c.tier || tierOf(c.id), generated: true });

// ───────────────────────────────────────────────────────────── A. inventory
// "what are the ui elements?" — the question a dev asks on day one.

const uiPages = [...new Set(inv.sets.map((s) => s.page))].filter((p) => p !== "Utilities" && p !== "Examples");

add({
  id: "inv-ui-element-groups",
  kind: "values",
  prompt:
    "I've never seen this design system before — what UI elements does it ship? Answer with the file's page names, " +
    "counting only pages that actually define component sets, and skipping the internal \"Utilities\" and \"Examples\" pages.",
  expected: { groups: uiPages },
  why: `The orientation question. ${uiPages.length} of the file's pages define component sets. The scope rule is spelled out in the prompt on purpose: without it, "is Examples a UI element group?" is a judgement call and the case would punish a defensible answer. What is still being tested is real — walking every page and checking which contain COMPONENT_SETs, rather than guessing from page names.`,
});

for (const page of ["Inputs", "Buttons", "Avatars", "Tags", "Navigation", "Pagination"]) {
  const names = inv.sets.filter((s) => s.page === page).map((s) => s.name);
  if (names.length < 2) continue;
  add({
    id: `inv-components-${slug(page)}`,
    kind: "values",
    prompt: `What components are on the ${page} page?`,
    expected: { components: names },
    why: `Scoped enumeration — ${names.length} component sets on that page. Catches a run that answers from the component's own name rather than by walking the page.`,
  });
}

add({
  id: "inv-text-styles",
  kind: "values",
  prompt:
    "What typography styles does this design system define? Just the names, and leave out the internal ones whose name starts with a dot.",
  expected: { textStyles: inv.textStyles.filter((s) => !s.name.startsWith(".")).map((s) => s.name) },
  why: `${inv.textStyles.length} local text styles exist; ${inv.textStyles.filter((s) => s.name.startsWith(".")).length} are dot-prefixed internals (Figma's convention for "hide from the picker") and the prompt excludes them explicitly so the boundary is not a guess. The real trap is the two "Single Line/" styles — they are easy to miss because they duplicate the names of the styles above them and differ only in line-height.`,
});

add({
  id: "inv-shadow-styles",
  kind: "values",
  prompt: "List every effect style defined in this file, by name.",
  expected: { shadowStyles: inv.effectStyles.map((s) => s.name) },
  why: `Effect styles are a separate namespace from variables — a run that only searches variables finds nothing and may answer "this system has no shadows", which is wrong. Asked as "every effect style" rather than "shadow tokens" because ${inv.effectStyles.filter((s) => s.name.startsWith("Blur/")).length} of the ${inv.effectStyles.length} are blurs, and grading a run for excluding a blur from a question about shadows would be unfair.`,
});

// ───────────────────────────────────────────────────────── B. variant axes
// "what are the variants of avatar?" / "what sizes does it come in?"

const AXIS_SETS = [
  ["Avatar", "Avatars"], ["Avatar Group", "Avatars"], ["Button", "Buttons"], ["Tag", "Tags"],
  ["Tag Toggle", "Tags"], ["Tooltip", "Tooltip"], ["Card", "Cards"], ["Pricing Card", "Cards"],
  ["Input Field", "Inputs"], ["Checkbox Field", "Inputs"], ["Radio Field", "Inputs"],
  ["Select Field", "Inputs"], ["Switch Field", "Inputs"], ["Textarea Field", "Inputs"],
  ["Search", "Inputs"], ["Slider Field", "Inputs"], ["Menu Item", "Menu"],
  ["Navigation Button", "Navigation"], ["Navigation Pill", "Navigation"],
  ["Pagination Page", "Pagination"], ["Tab", "Tabs"], ["Notification", "Notification"],
  ["Text Price", "Text"], ["Text Content Heading", "Text"],
];

for (const [name] of AXIS_SETS) {
  const s = setByName(name);
  if (!s || !Object.keys(s.variantAxes).length) continue;
  const axes = Object.entries(s.variantAxes);
  const combos = axes.reduce((a, [, v]) => a * v.length, 1);
  add({
    id: `axes-${slug(name)}`,
    kind: "values",
    prompt: `What variants does the ${name} component come in? I need every variant axis and all of its options.`,
    expected: { axes: s.variantAxes },
    why: `${axes.length} axis/axes → ${combos} variant combinations (${s.variantCount} exist in the set). The axis NAMES are part of the answer, so they must not appear in the required-keys list — that is why this is one "axes" key. ${
      combos !== s.variantCount ? `Note ${combos} combinations vs ${s.variantCount} actual variants: the matrix is not fully populated, so enumerating variant children and inferring axes gives a different answer than reading componentPropertyDefinitions.` : "Matrix is fully populated."
    }`,
  });
}

// A single-axis question in dev voice — "what sizes?" rather than "what axes?"
for (const [name, axis] of [["Avatar", "Size"], ["Button", "Size"], ["Text Price", "Size"],
                            ["Avatar", "Shape"], ["Avatar", "Type"], ["Tag", "Scheme"],
                            ["Button", "State"], ["Tooltip", "Placement"], ["Avatar Group", "Spacing"],
                            ["Pagination Page", "State"], ["Card", "Direction"], ["Notification", "Variant"]]) {
  const s = setByName(name);
  if (!s?.variantAxes[axis]) continue;
  const q = { Size: "sizes", Shape: "shapes", Type: "types", Scheme: "colour schemes", State: "states",
              Placement: "placements", Spacing: "spacing options", Direction: "directions", Variant: "variants" }[axis] || axis.toLowerCase();
  add({
    id: `axis-${slug(name)}-${slug(axis)}`,
    kind: "values",
    prompt: `What ${q} does ${name} support?`,
    expected: { options: s.variantAxes[axis] },
    why: `Single-axis slice of ${name}'s ${Object.keys(s.variantAxes).length}-axis matrix. The dev names the concept ("${q}"), not the Figma axis ("${axis}") — the mapping is the work. Answer must be exactly the ${s.variantAxes[axis].length} options on that axis, with no options from the other axes mixed in.`,
  });
}

// ─────────────────────────────────────────────────── C. component contract
// "what props does it take?" — the code API, incl. slots and swaps.

const PROP_SETS = ["Button", "Avatar", "Avatar Group", "Tag", "Card", "Notification", "Tooltip",
                   "Input Field", "Select Field", "Checkbox Field", "Switch Field", "Textarea Field",
                   "Menu Item", "Navigation Button", "Tag Toggle", "Text Content Heading",
                   "Slider Field", "Radio Field"];

for (const name of PROP_SETS) {
  const s = setByName(name) || singleByName(name);
  if (!s || !s.props.length) continue;
  const map = Object.fromEntries(s.props.map((p) => [p.name, p.type]));
  const kinds = [...new Set(s.props.map((p) => p.type))];
  add({
    id: `props-${slug(name)}`,
    kind: "values",
    // "Spacing" (a VARIANT axis) is a property too, and a live run listed it —
    // correctly. Variant axes have their own `axes-*` cases, so the scope is
    // stated here rather than left as a judgement call the case would punish.
    prompt:
      `I'm writing the ${name} component in code. What properties does the Figma component expose, and what type is each one? ` +
      `Exclude the variant axes — I want the content properties only. Give the type as the bare Figma property type.`,
    expected: { props: map },
    why: `The component contract — ${s.props.length} propert${s.props.length === 1 ? "y" : "ies"} of type ${kinds.join(", ")}. These live in componentPropertyDefinitions, NOT in the layer tree, so a run that inspects children instead of properties cannot answer it. Figma suffixes keys ("Label#2:0"); the suffix is storage detail and must be stripped.${
      kinds.includes("SLOT") ? " Includes SLOT — a content-projection point (ng-content), not a value input." : ""
    }${kinds.includes("INSTANCE_SWAP") ? " INSTANCE_SWAP means a swappable child component, not a string." : ""}`,
  });
}

// Scoped to the core UI pages on purpose: unscoped, the answer is 25+ items
// dominated by page-layout Sections, and an all-or-nothing check on 25 items
// fails on one debatable entry while telling you nothing.
const SLOT_PAGES = ["Avatars", "Cards", "Tags", "Tooltip", "Notification", "Inputs", "Menu", "Dialog", "Text"];
const slotted = inv.sets
  .filter((s) => SLOT_PAGES.includes(s.page) && s.props.some((p) => p.type === "SLOT"))
  .map((s) => s.name);
add({
  id: "inv-slotted-components",
  kind: "values",
  prompt: `Which components on these pages expose a slot — a place where arbitrary content gets projected in? Pages: ${SLOT_PAGES.join(", ")}.`,
  expected: { components: slotted },
  why: `Slots map to ng-content / children, so this is the list telling a dev which components cannot be modelled as plain value inputs. ${slotted.length} of the sets on those ${SLOT_PAGES.length} pages expose one. SLOT lives in componentPropertyDefinitions, so this cannot be answered by looking at layers — and note Figma also has a SLOT *node* type, which is a different thing and a plausible wrong path.`,
});

// ───────────────────────────────────────────────────────── D. composition
// "what components are used in avatar block?"

/** Component-set names of the INSTANCE children, recursively, excluding icons. */
function usedComponents(node) {
  const out = [];
  const walk = (kids) => {
    for (const c of kids || []) {
      if (c.type === "INSTANCE" && (c.componentSet || c.component)) out.push(c.componentSet || c.component);
      walk(c.children);
    }
  };
  walk(node.children);
  return [...new Set(out)];
}
/**
 * TEXT layer name → its text style. The "Title typography / Description
 * typography" answer.
 *
 * Returns null on a duplicate layer name: a map keyed by name would silently
 * drop one entry, so the answer key would be short by one and every run would
 * fail a case that is really just unaskable in this form.
 */
function textLayers(node) {
  const out = {};
  let collision = false;
  const walk = (kids) => {
    for (const c of kids || []) {
      if (c.type === "TEXT" && c.typography?.textStyle) {
        if (c.name in out && out[c.name] !== c.typography.textStyle) collision = true;
        out[c.name] = c.typography.textStyle;
      }
      walk(c.children);
    }
  };
  walk(node.children);
  return collision ? null : out;
}

const COMPOSE = [
  ["Avatar Block", null], ["Pricing Card", "Device=Desktop, Variant=Brand"],
  ["Card", "Asset Type=Icon, Variant=Default, Direction=Vertical"],
  ["Notification", "Variant=Alert"], ["Input Field", "State=Default, Value Type=Default"],
  ["Menu Item", "State=Default"], ["Tooltip", "Placement=Top"],
  ["Checkbox Field", "State=Default, Value Type=Checked"],
  ["Select Field", "State=Default, Value Type=Default"],
  ["Text Content Heading", "Align=Start"], ["Avatar Group", "Spacing=Overlap"],
  ["Tag", "Scheme=Brand, State=Default, Variant=Primary"],
];

for (const [name, variantName] of COMPOSE) {
  const s = setByName(name) || singleByName(name);
  if (!s) continue;
  const node = variantName ? s.variants?.find((v) => v.name === variantName) : s;
  if (!node?.children?.length) continue;
  const uses = usedComponents(node);
  const texts = textLayers(node);
  const label = variantName ? `${name} (${variantName})` : name;

  if (uses.length) {
    add({
      id: `uses-${slug(name)}`,
      kind: "values",
      prompt: `What other components is ${label} built out of?`,
      expected: { uses },
      why: `Composition, not styling. Each child INSTANCE has to be resolved to its main component via getMainComponentAsync — the layer NAME is not reliable (an instance can be renamed). ${uses.length} distinct component(s). Reporting layer names instead of component names is the classic wrong answer.`,
    });
  }
  if (texts && Object.keys(texts).length) {
    add({
      id: `texts-${slug(name)}`,
      kind: "values",
      prompt: `Which text layers does ${label} contain, and what typography style is each one using?`,
      expected: { textLayers: texts },
      why: `Maps each TEXT layer to its Figma text style. The style binding lives on textStyleId and is NOT visible in the resolved font values — two layers can both be "Inter 16px" while using different styles (Body Base vs Single Line/Body Base differ only in line-height). ${Object.keys(texts).length} text layer(s).`,
    });
  }
}

// ───────────────────────────────────────────────────────── E. typography
// "what's the type style for Heading?" in CSS vocabulary.

for (const st of inv.textStyles.filter((s) => !s.name.startsWith("."))) {
  add({
    id: `type-${slug(st.name)}`,
    kind: "values",
    prompt: `Give me the CSS for the "${st.name}" text style — font family, size, weight, line height and letter spacing.`,
    expected: {
      "font-family": st.fontFamily,
      "font-size": st.fontSize + "px",
      "font-weight": weightOf(st.fontStyleName),
      "line-height": st.lineHeight,
      "letter-spacing": st.letterSpacing,
    },
    why: `Text styles are a separate namespace from variables and the CLI has no verb for them today — this case is expected to FAIL until one exists. Figma stores the weight as a style name ("${st.fontStyleName}"), so answering in CSS requires the name→number mapping${
      st.fontStyleName === "Italic" ? ' (and "Italic" is font-style, not weight — weight stays 400)' : ""
    }. Line height is stored as ${st.lineHeight.endsWith("%") ? `a percentage with float noise (140% is 139.9999976158142)` : "a pixel value"}.`,
  });
}

// The in-context version: the layer, not the style catalogue.
const ab = singleByName("Avatar Block");
if (ab) {
  for (const layer of ["Title", "Description"]) {
    const t = (function find(kids) {
      for (const c of kids || []) {
        if (c.type === "TEXT" && c.name === layer) return c.typography;
        const r = find(c.children);
        if (r) return r;
      }
      return null;
    })(ab.children);
    if (!t) continue;
    add({
      id: `typo-avatar-block-${slug(layer)}`,
      kind: "values",
      prompt: `In Avatar Block, what typography does the ${layer} use? Give it to me as CSS — font family, size, weight, line height and colour — plus the token name for the colour.`,
      expected: {
        "font-family": t.fontFamily,
        "font-size": t.fontSize + "px",
        "font-weight": weightOf(t.fontStyleName),
        "line-height": t.lineHeight,
        color: { value: t.color, token: t.colorToken, var: t.colorVar },
        "text-style": t.textStyle,
      },
      why: `The task you actually do when building a component: read a specific layer, not the style catalogue. Title and Description are both Inter 16px — they differ only in weight (${weightOf(t.fontStyleName)}), text style (${t.textStyle}) and colour token (${t.colorToken}). Answering from the visual alone cannot tell them apart.`,
    });
  }
}

// ─────────────────────────────────────────────────── F. css box values
// `reads` stubs; extract.mjs --write fills `expected` from the live file.

const BOX = [
  ["Tag", "Scheme=Brand, State=Default, Variant=Primary", ["background-color", "border-radius", "padding", "gap"]],
  ["Tag", "Scheme=Danger, State=Default, Variant=Primary", ["background-color", "border-color"]],
  ["Tag", "Scheme=Positive, State=Default, Variant=Secondary", ["background-color", "border-color"]],
  ["Menu Item", "State=Hover", ["background-color", "padding", "gap"]],
  ["Notification", "Variant=Alert", ["background-color", "border-radius", "padding", "gap"]],
  ["Tooltip", "Placement=Top", ["background-color", "border-radius", "padding"]],
  ["Input Field", "State=Error, Value Type=Default", ["gap"]],
  ["Checkbox Field", "State=Default, Value Type=Checked", ["gap"]],
  ["Navigation Pill", "State=Active", ["background-color", "border-radius", "padding"]],
  ["Pagination Page", "State=Current", ["background-color", "border-radius"]],
  ["Tab", "State=Default, Active=On", ["border-color", "padding"]],
  ["Button", "Variant=Subtle, State=Default, Size=Medium", ["background-color", "border-color", "border-radius"]],
  ["Button", "Variant=Primary, State=Disabled, Size=Medium", ["background-color", "border-color"]],
  ["Button", "Variant=Primary, State=Default, Size=Small", ["padding", "gap", "border-radius"]],
  ["Avatar", "Type=Initial, Size=Large, Shape=Circle", ["background-color", "border-radius", "width", "height"]],
  ["Avatar", "Type=Initial, Size=Small, Shape=Square", ["border-radius", "width", "height"]],
  ["Avatar", "Type=Initial, Size=Medium, Shape=Circle", ["width", "height"]],
];

for (const [name, variantName, props] of BOX) {
  const s = setByName(name);
  const v = s?.variants?.find((x) => x.name === variantName);
  if (!v) continue;
  const nice = variantName.replace(/(\w+)=/g, "").split(", ").join(" / ");
  add({
    id: `css-${slug(name)}-${slug(variantName)}`,
    kind: "values",
    prompt: `For the ${name} component, ${nice} variant — give me ${props.join(", ")}. Token names where they exist.`,
    reads: [{ as: "box", node: v.id, props }],
    expected: {},
    why: `Box values on a named variant of ${name}. Requires resolving "${variantName}" out of ${s.variantCount} variants. Every colour and length in SDS is variable-bound, so hex without a token name scores zero for that key.`,
  });
}

// ────────────────────────────────────────────────────── G. token resolution

for (const q of ["^Background/Brand/Hover$", "^Text/Default/Secondary$", "^Border/Danger/Default$",
                 "^Background/Disabled/Default$", "^Space/400$", "^Radius/400$", "^Text/Brand/On Brand$"]) {
  const name = q.replace(/[$^]/g, "");
  add({
    id: `token-${slug(name)}`,
    kind: "values",
    prompt: `The variable ${name} — what's its CSS custom property, what does it resolve to in each mode, and in each mode is it an alias of another variable (if so, which)?`,
    reads: [{ as: "tok", variable: q }],
    expected: {},
    why: `Token resolution across modes. SDS variables are mostly aliases onto primitives, so the final value and the indirection are two different facts — a dev changing a colour needs the primitive, not the semantic name.`,
  });
}

// ─────────────────────────────────────────────── H. refuse / not-found

add({
  id: "notfound-carousel",
  kind: "refuse",
  prompt: "Give me the background colour of the Carousel component.",
  expected: { refused: true, minCandidates: 0 },
  why: "There is no Carousel in this file. The failure mode is inventing a plausible answer (#ffffff / Background/Default/Default) or silently substituting a similar component like Tabs. Absence is a fact and must be reported as one.",
});

add({
  id: "ambiguous-tag-scheme",
  kind: "refuse",
  prompt: "What's the Tag's background colour?",
  expected: { refused: true, minCandidates: 5 },
  why: "Tag has 5 colour schemes x 2 states x 2 variants = 20 variants, each with a different background. 'The' Tag background does not exist. Unlike the Pricing Card case the candidates here are variants of one component rather than separate instances, so the disambiguation has to name axes, not node ids.",
});

// ──────────────────────────────────────────────────────────────── write

// Hand-written cases are never regenerated, but they still need a tier, and the
// tiering rule should live in exactly one place.
const kept = ds.cases
  .filter((c) => !c.generated)
  .map((c) => ({
    ...c,
    // Kind wins over the id prefix: a refusal case is always advanced (it is
    // about judgement, not lookup) and a node case always beats a page case.
    tier: c.tier || (c.kind === "refuse" ? "advanced" : c.kind === "node" ? "medium" : tierOf(c.id)),
  }));
const ids = new Set();
const dupes = [];
for (const c of [...kept, ...cases]) {
  if (ids.has(c.id)) dupes.push(c.id);
  ids.add(c.id);
}
if (dupes.length) {
  console.error(`✗ duplicate case ids: ${dupes.join(", ")}`);
  process.exit(1);
}

const byFam = cases.reduce((a, c) => {
  const fam = c.id.split("-")[0];
  a[fam] = (a[fam] || 0) + 1;
  return a;
}, {});
const needExtract = cases.filter((c) => c.reads).length;

console.log(`hand-written kept : ${kept.length}`);
console.log(`generated         : ${cases.length}`);
console.log(`TOTAL             : ${kept.length + cases.length}`);
console.log(`\nby family: ${Object.entries(byFam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`awaiting extract.mjs: ${needExtract}`);

if (argv.includes("--write")) {
  ds.cases = [...kept, ...cases];
  writeFileSync(DATASET, JSON.stringify(ds, null, 2) + "\n");
  console.log(`\n✓ wrote dataset.json — next: node extract.mjs --write && node build-eval.mjs`);
} else {
  console.log("\n(dry run — pass --write to save)");
}
