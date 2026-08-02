---
name: figma-browser
description: Read a Figma design — values, design tokens, variants, component properties, styles — over the user's logged-in Chrome. Read-only.
---

# Figma

One command. Every operation is a Bash call:

```bash
node <skill>/lib/figma.mjs <operation> [target] [--json]
```

## Workflow — work the panels, in order

The operations map onto the Figma UI. **Navigate first, then inspect.** Reaching
straight for a value without selecting the layer is how you end up reading the
wrong node.

| Figma UI | operation |
|---|---|
| page list | `pages` |
| double-click a page or component → it opens, selected | `open <name\|id>` |
| **left panel** — the layer tree | `layers` — no argument means the current page |
| **right panel** — properties of the selected layer | `inspect` — no argument means the selection |
| Cmd+F search box — when you don't know where a thing is | `find <regexp>` |
| the Variables panel | `vars <regexp>` |

```bash
figma.mjs pages                       # what's in this file
figma.mjs open avatars                # a page — it becomes the active page
figma.mjs layers                      # what's on it
figma.mjs open "^Avatar Block$"       # a component — it becomes the selection
figma.mjs layers selection --depth=3  # what it's built from
figma.mjs inspect                     # properties of the selection
```

`layers` answers *"what is this made of"* — per layer it gives the type, the
component an `INSTANCE` came from with its variant, and the text style of a
`TEXT` layer. It carries no property values, so it stays small: use it to find
the layer you want, then `inspect` that layer.

`inspect` answers *"what are its values"*.

## Speak Figma, not CSS

`inspect` reports what the Plugin API actually calls things — `fills`,
`strokes`, `cornerRadius`, `itemSpacing`, `layoutMode`, `paddingTop`,
`fontName.style`. Report those names and values as they come. **Do not translate
to CSS unless you are asked to**: `cornerRadius` is `8`, not `8px`; a weight is
`"Semi Bold"`, not `600`; alignment is `"CENTER"`, not `center`.

Every value bound to a variable also carries `token` (the variable's name) and
`var` (its `codeSyntax.WEB`). That is the design-system link and it is the most
useful thing here — a raw hex without its token is nearly worthless.

**Report the value AND its variable, always.** One without the other is half an
answer: the value alone cannot be traced back to the system, and the variable
alone cannot be checked against what is on screen.

**Typography is the exception you have to work for.** `inspect` returns
`fontName`, `fontSize` and `lineHeight` as bare values with no `token` — but
they ARE variable-bound, and the binding simply is not on the node. Look it up
by style name:

```bash
figma.mjs inspect "^Title Hero$"     # Inter / Bold / 72 — no variable in sight
figma.mjs vars "^Title Hero/"        # Title Hero/Font Family → Family Sans → "Inter"
```

`vars` gives the alias and the resolved value together, so it answers both
halves on its own. Two collections: `Typography` holds the per-style variables
(`<Style>/Font Family`, `/Font Weight`, `/Size`) and `Typography Primitives`
holds what they alias (`Family Sans`, `Family Serif`, `Family Mono`).

The variable group does not always match the style name — the style `Body Code`
is driven by `Code/Font Family`. Search, do not assume.

If CSS is genuinely what's wanted, `inspect --css` (or `css`) projects the same
read into CSS names, adding `font-weight`, `flex-*` and `fit-content` sizing.

Anything taking `<id|regexp>` also accepts a node id (`12:34`, `I12:34;56:78`),
plus `selection` for the current selection. Run `help` for every parameter.

## Rules

1. **Read-only.** No operation here writes. If a task needs an edit, stop and
   say so.
2. **Never click or type into the canvas.** There is no click path — keep it
   that way. A coordinate click once edited a real file and `Cmd+Z` did not
   recover it. Arrow keys nudge the selection; `Delete` deletes.
3. **Ambiguity is refused, not guessed.** When several nodes match equally well
   the command exits non-zero and prints the candidates. Narrow the regexp or
   pass a node id. Never pick one silently.
4. **Errors are instructions.** Every failure prints what to do next. When it
   says to ask the user, ask — do not retry, and do not route around it with
   browser automation of your own.
