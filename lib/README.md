# `lib/section.mjs` — the file-section matcher

A single, dependency-free ES module that resolves a `#<reference>`
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
| `resolveSection(text, reference, lexer?)` | function | The text a reference stands for. Throws `SectionReferenceError` on a malformed reference, a plain `Error` on a well-formed one that matches nothing. |
| `planSection(text, reference, lexer?)` | function | `{ text, reference }` — the same, plus the parsed reference and any contradiction warning. |
| `parseReference(raw)` | function | The parser: `{ raw, canonical, segments, scope, warning }`. Throws `SectionReferenceError` on a grammar error. |
| `scanBlocks(text, path?, lexer?)` | function | The block scanner: `{ root, blocks, regions, anchors, lex }`. Pure data; the matcher's front end. |
| `extractDeclaration(text, name, scope?)` | function | The named declaration, or `null`. Single name, any depth; never matches a `#region` directive. |
| `masked(text)` | function | Comments and string literals blanked to spaces, length and newline offsets preserved. |
| `commentsIn(text)` | function | The comment spans (`{ text, from, to }`) of a file, skipping string literals. |
| `isSingleSegment(reference)` | function | Whether a reference (or its parsed form) is one segment. |
| `finalSegment(reference)` | function | The last segment of a reference (name or parsed form). |
| `SectionReferenceError` | class | An `Error` subclass thrown for a malformed reference. |

`path` on `scanBlocks` is reserved and unused; pass nothing.

The optional `lexer` is the language-specific half of a scan — `{ name,
mask(text), comments(text) }`, blanking comments and string literals and
locating the comments. Omit it (an unknown file type) and the built-in default
engine masks the file; `src/js/scanner/lexers.js` holds the per-type lexers and
picks one by extension. A lexer changes only what is blanked, never how the
blanked text is walked. See the Tokenizers section of the spec.

## The contract it implements

The reference grammar, matcher precedence, modifier semantics, and every exact
error message are specified in
[`../doc/section-matching.md`](../doc/section-matching.md). The behaviour is
pinned as data in `test/vectors/section-vectors.json` and checked in CI.

## This module is the reference

The JavaScript here is **authoritative**: it is what the syntax means. A port
to another language that disagrees with this module is wrong by definition —
the port moves, not the semantics. Do not fork or specialise the behaviour per
consumer; if a consumer needs a change, the change is made here first, and
everywhere else follows.
