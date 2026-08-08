---
name: figma-browser
description: Read a Figma design — values, design tokens, variants, component properties, styles — over the user's logged-in Chrome. Read-only.
---

# Figma

Every operation is one Bash call:

```bash
node <skill>/lib/figma.mjs <operation> [target] [--json]
```

**Navigate first, then inspect.** Reaching for a value without selecting the
layer is how you end up reading the wrong node.

| command | Figma UI | answers | detail |
|---|---|---|---|
| `figma.mjs pages` | the page list | what is in this file | |
| `figma.mjs find <regexp>` | Cmd+F | where is this thing | [open.md](references/open.md) |
| `figma.mjs open <id\|regexp>` | double-click a page or component | makes it the selection | [open.md](references/open.md) |
| `figma.mjs layers [target] [--depth=N]` | left panel | what is this made of | [layers.md](references/layers.md) |
| `figma.mjs inspect [target] [--css]` | right panel | a layer's values · a COMPONENT_SET's contract · an INSTANCE's overrides | [inspect.md](references/inspect.md) · [components.md](references/components.md) |
| `figma.mjs vars <regexp\|id>` | Variables panel | what a token resolves to, per mode | [vars.md](references/vars.md) |
| `figma.mjs status` `login` `help` | | connection, auth, every parameter | |

`target` is a node id (`12:34`, `I12:34;56:78`), a regexp, or `selection`;
omitted, it means the current selection — or for `layers`, the current page.

## Reporting

- **Speak Figma, not CSS** unless asked. `cornerRadius` is `8`, not `8px`; a
  weight is `"Semi Bold"`, not `600`; alignment is `"CENTER"`, not `center`.
- **Value AND variable, always.** A hex without its `token` is half an answer;
  a token without its value cannot be checked against the screen.
- **Typography is the exception.** `inspect` reports `fontName`/`fontSize` with
  no `token` even though they are variable-bound. The variable lives in `vars`,
  looked up by style name — `vars "^Title Hero/"`. Two commands, always.
- **Never answer from a partial read.** `vars` is paged — `pages > 1` means you
  have not seen them all.
- **Read the contract, do not infer it.** A component's properties are data on
  the node; do not reconstruct them from child names.

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
