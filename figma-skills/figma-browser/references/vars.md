# vars — variables, aliases and modes

```bash
figma.mjs vars <regexp|variable-id> [--limit=N|all] [--page=N]
```

Answers *"what does this token actually resolve to"*. It returns the alias
chain and the resolved value **together**, per mode, so it answers both halves
of a design-system question on its own.

```json
{
  "query": "Text/Default/Secondary",
  "page": 1, "pages": 1, "page_size": 40, "total": 1,
  "variables": [{
    "name": "Text/Default/Secondary",
    "collection": "Color",
    "type": "COLOR",
    "var": "var(--sds-color-text-default-secondary)",
    "modes": {
      "SDS Light": { "alias": "Gray/500",  "value": "#757575", "alpha": 1 },
      "SDS Dark":  { "alias": "White/500", "value": "#ffffff", "alpha": 0.7 }
    }
  }]
}
```

## Modes are not optional context

Most colours resolve differently per mode. If the question names a mode, answer
for that mode and say so. If it does not, either give both or say which you
picked — a bare hex from a two-mode variable is ambiguous.

## Paging

40 matches per page by default. Every response carries `{ page, pages,
page_size, total }`.

```bash
figma.mjs vars "^Color/"              # page 1 of 4, page_size 40, total 132
figma.mjs vars "^Color/" --page=2     # the next 40
figma.mjs vars "^Color/" --limit=all  # page 1 of 1, page_size 132, total 132
figma.mjs vars "^Color/Brand/"        # or narrow it — usually the better move
```

**`pages > 1` means you have not seen them all.** Narrowing the regexp beats
paging when you know what you want; page when you genuinely need the whole set
(counting, listing a collection).

## Alpha

Colour modes carry `alpha` separately from `value`. `#ffffff` at `alpha: 0.7`
is white at 70% — report both. Do not fuse them into `rgba(...)`; that is a CSS
spelling, and this skill speaks Figma.

## Collections

Variables are grouped into collections, and the group prefix in a variable's
name does not always match the thing it styles. The text style `Body Code` is
driven by `Code/Font Family`, not `Body Code/Font Family`. **Search, do not
assume.**
