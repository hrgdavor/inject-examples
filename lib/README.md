# `lib/section.mjs` — the file-section matcher

A single, dependency-free ES module that resolves a `#region:<reference>`
against the text of a file: it parses the reference, scans the file into a tree
of blocks, applies the matcher precedence, and returns the bytes a reference
stands for. It is the matcher behind
[`@hrg/inject-examples`](https://www.npmjs.com/package/@hrg/inject-examples),
extracted so another project can reuse it without pulling in the CLI, the
filesystem, or the Markdown machinery.

## What it is

- **One file**, no dependencies, no transitive imports — `import` it and go.
- **ES module** (`.mjs`), Node 18+.
- **Pure.** It never reads the disk, never spawns a process, never touches
  `process`. Every entry point takes text as a string and returns a string or a
  plain object. The caller owns all I/O.

## How to consume it

Copy `lib/section.mjs` into your tree (it has no imports to follow), or depend
on the package and import the subpath:

```js
import { resolveSection, parseReference } from '@hrg/inject-examples/lib/section.mjs';
```

You hand it the file's text and a reference; it hands you the text or throws:

```js
const code = readFileOf('Example.java', 'utf8');
resolveSection(code, 'Cart/Line/render-');
// -> '            return name + " x" + quantity;'
```

## Public surface

| Export | Kind | What it does |
| --- | --- | --- |
| `resolveSection(text, reference)` | function | The text a reference stands for. Throws `SectionReferenceError` on a malformed reference, a plain `Error` on a well-formed one that matches nothing. |
| `planSection(text, reference)` | function | `{ text, reference }` — the same, plus the parsed reference and any contradiction warning. |
| `parseReference(raw)` | function | The parser: `{ raw, canonical, segments, scope, warning }`. Throws `SectionReferenceError` on a grammar error. |
| `scanBlocks(text, path?)` | function | The block scanner: `{ root, blocks, regions, anchors }`. Pure data; the matcher's front end. |
| `extractDeclaration(text, name, scope?)` | function | The named declaration, or `null`. Single name, any depth; never matches a `#region` directive. |
| `masked(text)` | function | Comments and string literals blanked to spaces, length and newline offsets preserved. |
| `commentsIn(text)` | function | The comment spans (`{ text, from, to }`) of a file, skipping string literals. |
| `isSingleSegment(reference)` | function | Whether a reference (or its parsed form) is one segment. |
| `finalSegment(reference)` | function | The last segment of a reference (name or parsed form). |
| `SectionReferenceError` | class | An `Error` subclass thrown for a malformed reference. |

`path` on `scanBlocks` is reserved and unused today; pass nothing.

## The contract it implements

The reference grammar, matcher precedence, modifier semantics, and every exact
error message are specified in
[`../doc/section-matching.md`](../doc/section-matching.md). The behaviour is
pinned as data in `test/vectors/section-vectors.json` and checked in CI.

## This revision is the reference

The JavaScript here is **authoritative**: it is what the syntax means. A port
to another language that disagrees with this module is wrong by definition —
the port moves, not the semantics. Do not fork or specialise the behaviour per
consumer; if a consumer needs a change, the change is made here first, and
everywhere else follows.

## Status

**Draft API until the maintainer signs off the settled revision.** The public
surface may still move while file-section matching is being settled; pin a
commit, not a range, if you vendor it. The semantics are frozen and vectorised
— the surface (`function` names, return shapes) is what is not yet guaranteed.
