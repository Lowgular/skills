# Component properties — the contract, not the copy

`inspect` on a **COMPONENT_SET** (or a standalone COMPONENT) returns
`componentProperties`: what anyone placing that component may configure. It is
the answer to *"what variants does X have"*, *"what props does X take"*,
*"what's the default"*.

```bash
figma.mjs open "^Button$"
figma.mjs inspect
```

```json
"componentProperties": {
  "Variant":            { "type": "VARIANT", "defaultValue": "Primary", "options": ["Primary","Neutral","Subtle"] },
  "State":              { "type": "VARIANT", "defaultValue": "Default", "options": ["Default","Hover","Disabled"] },
  "Size":               { "type": "VARIANT", "defaultValue": "Medium",  "options": ["Medium","Small"] },
  "Label#2:0":          { "type": "TEXT",    "name": "Label", "defaultValue": "Button" },
  "Has Icon Start#4:128":{ "type": "BOOLEAN","name": "Has Icon Start", "defaultValue": false },
  "Icon Start#4:192":   { "type": "INSTANCE_SWAP", "name": "Icon Start", "preferredValueCount": 576 }
}
```

## The five types

| type | means |
|---|---|
| `VARIANT` | pick one of `options` |
| `TEXT` | an overridable string |
| `BOOLEAN` | show or hide a layer |
| `INSTANCE_SWAP` | swap in another component |
| `SLOT` | arbitrary nested content |

These are Figma's, not any file's convention — the same five in every file. What
*is* file-specific is the names and the values: one team's `Variant / State /
Size` is another's `Type / Status / Scale`.

## Do not infer the contract from child names

A component set's children are named `Variant=Primary, State=Hover, Size=Medium`.
You can reverse-engineer the axes from a list of those, and it goes wrong: with
two axes it is guesswork which is which, and a value that appears in only some
combinations looks like it does not exist. Read `componentProperties` instead.

## Name the axis you are answering for

`Pricing Card` has **two** variant properties:

```
Device  → Desktop, Mobile
Variant → Stroke, Brand
```

"What variants does it have" is a question about a *named property*. Answer for
the property, and say which one. Never merge two axes into one flat list — the
4 children are the cross product, not four variants.

## Keys keep Figma's suffix

Non-variant properties come back as `Label#2:0`, `Has Icon End#4:64`. Figma
appends that id so the property survives a rename, and an instance's override
map is keyed by the full string — so it is what you match programmatically.
`name` carries the display half (`Label`), which is what a designer says.

Variant properties never get a suffix, so they carry no `name`.

## Sets versus instances

- **COMPONENT_SET / COMPONENT** — `componentProperties` is the *declaration*:
  `type`, `defaultValue`, `options`.
- **INSTANCE** — `componentProperties` is what that copy *set*:
  `{ "Label#2:0": { "type": "TEXT", "value": "Sign up" } }`, plus a `token` when
  the override is bound to a variable. `variantProperties` reports which variant
  it is.

## preferredValues is counted, not listed

`INSTANCE_SWAP` properties carry a `preferredValues` list of cross-file library
keys — 576 of them on Button's icon slots. Resolving one to a name is a network
round trip each, so `inspect` reports `preferredValueCount` and stops. If you
need the actual icons, browse the icon component set with `find`.
