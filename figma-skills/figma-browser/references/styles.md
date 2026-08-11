# styles — the four published tables

```bash
figma.mjs styles [<regexp>] [--type=paint,text,effect,grid] [--limit=N|all] [--page=N]
```

Figma publishes exactly four kinds of style, and they are the four sections of
the right-hand panel. All four exist in every file; which ones a design system
actually uses is its own choice.

| type | is |
|---|---|
| `paint` | a named colour — solid, gradient or image |
| `text` | a named type row — family, weight, size, leading, tracking |
| `effect` | a named shadow or blur, often several stacked |
| `grid` | a named layout grid — columns, gutters, margins |

The regexp is optional. With no argument you get everything, which is the right
opening move: the response always carries `counts`, so one call tells you which
kinds this file publishes and how many of each.

```json
{
  "query": ".",
  "counts": { "paint": 61, "text": 103, "effect": 15, "grid": 10 },
  "page": 1, "pages": 5, "page_size": 40, "total": 189,
  "styles": [ … ]
}
```

## Entry shapes

Every entry carries its `type`, so a mixed page reads without guesswork.

```json
{ "type": "paint",  "name": "Brand/Primary",
  "paints": [{ "type": "SOLID", "hex": "#0074b8" }] }

{ "type": "text",   "name": "Body/sm R",
  "fontFamily": "Source Sans 3", "fontStyle": "Regular",
  "fontSize": 14, "lineHeight": 20, "letterSpacing": 0.1, "paragraphSpacing": 16 }

{ "type": "effect", "name": "Elevation/1",
  "effects": [{ "type": "DROP_SHADOW", "radius": 6, "offsetX": 0, "offsetY": 2,
                "hex": "#000000", "alpha": 0.12 }] }

{ "type": "grid",   "name": "M_Default",
  "grids": [{ "pattern": "COLUMNS", "count": 12, "gutterSize": 24,
              "offset": 32, "alignment": "STRETCH" }] }
```

A non-solid paint reports its kind and **no hex** — `{"type":"GRADIENT_LINEAR"}`.
There is no single colour to report and inventing one would be worse than saying
so.

## One name can be in two tables

Style names are per-type, so the same name may exist twice. An elevation ramp
typically publishes both a surface colour and a shadow:

```bash
figma.mjs styles "^Elevation/"
#   paint   Elevation/Light/-1     the surface colour
#   effect  Elevation/Light/-1     the shadow
```

That is why this is one command rather than four — the question "what is
elevation made of" has one answer spanning two tables.

## Paging

40 per page by default, same envelope as `vars`. **`pages > 1` means you have
not seen them all.** Narrowing the regexp or filtering by `--type` usually beats
paging; page when you genuinely need the whole set.

```bash
figma.mjs styles "." --type=text              # page 1 of 3, total 103
figma.mjs styles "." --type=text --page=2
figma.mjs styles "^Body/" --type=text         # narrower — usually the better move
figma.mjs styles "." --type=grid --limit=all  # page 1 of 1
```

## Styles versus variables

Two different mechanisms, and a file may use either or both:

- a **variable** is a value with modes, resolved per mode — `vars`
- a **style** is a named bundle of properties a node points at — this command

A design system built before variables shipped will have no variables at all and
dozens of paint styles. One built recently may have the reverse. `counts` here
and `total` from `vars` tell you which you are looking at, and neither absence is
an error.

On a node, `inspect` reports both links where they exist: `token`/`var` for a
variable-bound value, and `fillStyle` / `strokeStyle` / `textStyle` /
`effectStyle` for a value that came from a style.
