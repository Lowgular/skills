# layers — what a thing is made of

```bash
figma.mjs layers [<id|regexp>|selection] [--depth=N]
```

No argument means the current page. This is the left panel: the tree, not the
values.

```bash
figma.mjs layers                      # everything on the active page
figma.mjs layers selection --depth=3  # what the selected component is built from
```

## What each line carries

- the layer **name** and **type** (`FRAME`, `TEXT`, `INSTANCE`, `COMPONENT_SET`…)
- for an `INSTANCE`, the **component it came from** and **which variant**
- for a `TEXT` layer, its **text style**

It deliberately carries **no property values**, which is what keeps it small
enough to read a whole component at once.

## The two-step

`layers` and `inspect` are meant to be used together:

1. `layers` to see the structure and find the layer you actually want
2. `inspect` on that one layer for its values

Going straight to `inspect --depth=5` returns values for every node in the
subtree and is usually far more than the question needs.

## Depth

`--depth=N` controls how far down the tree it walks. Beyond the depth it reports
`childCount` instead of recursing, so a truncated branch is visible rather than
silently missing.

Start shallow. A design-system component is often 4–6 levels deep, and the layer
you want is usually named clearly enough to spot at depth 2 or 3.
