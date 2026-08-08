# inspect — what a node's values are

```bash
figma.mjs inspect [<id|regexp>|selection] [--depth=N] [--css]
```

No argument means the current selection. It is the right panel: paints, strokes,
effects, corner radius, auto-layout, padding, sizing, opacity, and for `TEXT`
the font, size, line height, letter spacing, alignment and text style.

## Every bound value carries its token

```json
"fills": [{ "type": "SOLID", "color": "#2c2c2c",
            "token": "Background/Brand/Default",
            "var": "var(--sds-color-background-brand-default)" }]
```

`token` is the variable's name, `var` its `codeSyntax.WEB`. That is the
design-system link and the most useful thing here — **report the value and its
token together**. A raw hex without the token cannot be traced back to the
system; a token without its value cannot be checked against the screen.

## Speak Figma, not CSS

`inspect` reports what the Plugin API calls things — `fills`, `strokes`,
`cornerRadius`, `itemSpacing`, `layoutMode`, `paddingTop`, `fontName.style`.
Report those names and values as they come:

| Figma | not |
|---|---|
| `cornerRadius: 8` | `8px` |
| `fontName.style: "Semi Bold"` | `font-weight: 600` |
| `primaryAxisAlignItems: "CENTER"` | `justify-content: center` |

If CSS is genuinely what was asked for, `inspect --css` (or `css`) projects the
same read into CSS names, adding `font-weight`, `flex-*` and `fit-content`
sizing. Use it when asked, not by default.

## Typography is the exception you have to work for

`inspect` returns `fontName`, `fontSize` and `lineHeight` as bare values with no
`token` — but they **are** variable-bound; the binding just is not on the node.
Look it up by style name:

```bash
figma.mjs inspect "^Title Hero$"   # Inter / Bold / 72 — no variable in sight
figma.mjs vars "^Title Hero/"      # Title Hero/Font Family → Family Sans → "Inter"
```

Two collections: `Typography` holds the per-style variables (`<Style>/Font
Family`, `/Font Weight`, `/Size`), `Typography Primitives` holds what they alias
(`Family Sans`, `Family Serif`, `Family Mono`).

The variable group does not always match the style name — `Body Code` is driven
by `Code/Font Family`. Search, do not assume.

## Depth

`--depth=N` serialises N levels of children with their values. Values for a
whole tree get large fast; prefer `layers` to find the layer you want, then
`inspect` that one node.

## Component sets

Inspecting a COMPONENT_SET returns almost no paints — the one fill you see
(`#9747ff`, a dashed purple boundary) is the Figma editor's own placeholder, not
design data. What you want from a component set is its contract:
[components.md](components.md).
