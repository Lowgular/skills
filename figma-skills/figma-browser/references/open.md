# open and find — getting to the right node

```bash
figma.mjs open <id|regexp>
figma.mjs find <regexp> [--in=<id>] [--type=T1,T2] [--instances] [--limit=N]
```

`open` makes something the selection: a page becomes the active page, a
component becomes the selected node. Everything downstream (`layers`, `inspect`
with no argument) reads from that selection, so **open first**.

`find` is Cmd+F — use it when you do not know where a thing lives. It reports
`count` (how many matched) and `shown` (how many are listed), ranked by how well
they match.

## Anchor your regexp

The argument is a regular expression, matched case-insensitively against the
node name. A bare word matches anything containing it, which is usually several
nodes and therefore an ambiguity error.

```bash
figma.mjs open "avatar"        # matches Avatar, Avatar Block, Avatar Group, …
figma.mjs open "^Avatar$"      # one node
```

Anchor with `^…$` as soon as you know the exact name.

## Variant names are not part of the component name

This is the most common way to find nothing:

```bash
figma.mjs find "pricing card desktop brand"   # → 0 matches
```

The component set is named `Pricing Card`. Its children are named by the
variant axes:

```
Pricing Card                        COMPONENT_SET
  Device=Desktop, Variant=Stroke    COMPONENT
  Device=Desktop, Variant=Brand     COMPONENT
  Device=Mobile,  Variant=Stroke    COMPONENT
  Device=Mobile,  Variant=Brand     COMPONENT
```

So reach a specific variant either by opening the set and reading its children,
or by matching the generated child name:

```bash
figma.mjs open "Device=Desktop, Variant=Brand"
```

Read the axes off the set's contract rather than guessing them:
[components.md](components.md).

## Instances are hidden by default

`find` filters out `INSTANCE` nodes unless you pass `--instances`. A design
system file has thousands of instances of a handful of components, and they
would bury the component you are looking for. When you want a *usage* rather
than a definition, ask for them.

## Narrowing

- `--in=<id>` searches inside one node instead of the whole file
- `--type=COMPONENT_SET,COMPONENT` restricts by node type — the fastest way to
  find a definition rather than a usage
- `--limit=N` how many to list

```bash
figma.mjs find "^Button$" --type=COMPONENT_SET
```

## Ambiguity is refused

When several nodes match equally well, `open` exits non-zero and prints the
candidates. That is not a failure to work around — narrow the regexp or pass one
of the printed node ids. Never pick one silently.

## Node ids

Anything taking `<id|regexp>` also takes a node id (`12:34`), an instance-scoped
id (`I12:34;56:78`), or the literal `selection`. Ids are stable and unambiguous
— once `find` has given you one, use it.
