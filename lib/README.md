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
import { resolveSection, parseSelectors } from '@hrg/inject-examples/lib/section.mjs';
```

The per-type lexers are a second exported subpath, so a consumer does not have
to reach into `node_modules` by path:

```js
import { lexerFor } from '@hrg/inject-examples/src/js/scanner/lexers.js';
resolveSection(code, 'Cart/Line/render/-', lexerFor('Example.java'));
```

You hand it the file's text and a reference; it hands you the text or throws. A
modifier is the path's **last segment** — `render/-` is its body, `render/++` the
declaration with its doc comment — and a `-` inside a name is a name, so
`item-list` and `--brand` are addressable:

```js
const code = readFileOf('Example.java', 'utf8');
resolveSection(code, 'Cart/Line/render/-');
// -> '            return name + " x" + quantity;'

// Lines instead of a name, and two selectors in one reference.
resolveSection(code, 'L12-L14');
resolveSection(code, 'Cart/Line/render/,L1-L3');
```

## Public surface

| Export                                             | Kind         | What it does                                                                                      |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `resolveSection(text, reference, lexer?)`          | function     | The text a reference stands for. Throws `SectionReferenceError` on a malformed reference, a plain `Error` on a well-formed one that matches nothing. |
| `planSection(text, reference, lexer?)`             | function     | `{ text, reference, startLine, endLine, ranges, kind }` — the same, plus the parsed reference and the 1-based line range of every selector it named. |
| `diagnose(text, reference, lexer?)`                | function     | The same resolution **without throwing**: `{ status, plan, firstLine, error, code, selector, scope, candidates, advice }`. `status` is `ok`, `failed` or `invalid`; `firstLine` is the landing line. This is what a best-effort host (an editor, a jump) calls. |
| `deepestResolvablePrefix(text, reference, lexer?)` | function     | `{ reference, firstLine, segments }` for the longest *prefix* of the path that still resolves, or `null`. The fallback ladder's first rung; it probes and never guesses. |
| `parseSelectors(raw)`                              | function     | The parser for a whole reference: one or more comma-separated selectors, each a path or a line range (`L40:12-L44:3`). Returns `{ raw, canonical, selectors, segments, scope }`. |
| `parseReference(raw)`                              | function     | The parser for one *path* selector: `{ raw, canonical, segments, scope }`. A modifier is the path's last segment (`render/++`), so `segments` holds names only. Throws on a comma, on a line range, and on a grammar error. |
| `scanBlocks(text, path?, lexer?)`                  | function     | The block scanner: `{ root, blocks, regions, anchors, lex }`. Pure data; the matcher's front end. |
| `extractDeclaration(text, name, scope?)`           | function     | The named declaration, or `null`. Single name, any depth; never matches a `#region` directive.    |
| `masked(text)`                                     | function     | Comments and string literals blanked to spaces, length and newline offsets preserved.             |
| `commentsIn(text)`                                 | function     | The comment spans (`{ text, from, to }`) of a file, skipping string literals.                     |
| `isSingleSegment(reference)`                       | function     | Whether a reference (or its parsed form) is one segment.                                          |
| `finalSegment(reference)`                          | function     | The last segment of a reference (name or parsed form).                                            |
| `SectionReferenceError`                            | class        | An `Error` subclass thrown for a malformed reference. Carries the diagnosis fields below.         |
| `ERROR_CODES`                                      | frozen table | The stable failure codes: `grammar/*` when no file was read, `resolution/*` when the file cannot answer. A code is added, never renamed. |

**Every failure carries a stable code**, and both error categories carry the same
diagnosis fields — `code`, `selector`, `scope`, `candidates`, `near` — so a caller
can tell *which band* a failure belongs to without matching message text. A
malformed reference throws a `SectionReferenceError`; a well-formed reference the
file cannot answer throws a plain `Error`. Both are part of the contract: see
[RFC 1 §3.6 and §5.3](../doc/rfc/section-mapping.md).

`path` on `scanBlocks` is reserved and unused; pass nothing.

**This module is the resolver only.** A host that wants a *cursor* rather than
text imports [`lib/jump.mjs`](./jump.mjs) beside it — the code-jump profile of
[RFC 2](../doc/rfc/code-jump.md), which reads `diagnose` and applies the policy
the resolver deliberately keeps out (what a failure means to an editor, and what
it means to a gate). That module is not vendorable: the gate reads a whole
document, so it needs `index.mjs`.

The optional `lexer` is the language-specific half of a scan — `{ name,
mask(text), comments(text) }`, blanking comments and string literals and
locating the comments. Omit it (an unknown file type) and the built-in default
engine masks the file; `src/js/scanner/lexers.js` holds the per-type lexers and
picks one by extension (`lexerFor(path)`, an exported subpath of the package). A
lexer changes only what is blanked, never how the blanked text is walked. See the
Tokenizers section of the spec.

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
