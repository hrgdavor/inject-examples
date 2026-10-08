# File-section matching — plan set (JavaScript)

The work of formalising `#region:<reference>` into a specified **file-section matching**
syntax, split so that each part is small enough for one agent to complete and verify in one
sitting. **Read this index first, then exactly two documents: the contract, and your step.**

| Order | Document | One-line scope | Depends on |
| --- | --- | --- | --- |
| — | [00-contract.md](00-contract.md) | The frozen syntax + house rules. **Binding on every step; implement it, never change it.** | — |
| 1 | [01-freeze-porting.md](01-freeze-porting.md) | Stop all porting; switch the Zig differential harness off; delete the stale hard-coded reference counts | — |
| 2 | [02-spec-document.md](02-spec-document.md) | Write the normative spec `doc/section-matching.md` from the contract | 00 |
| 3 | [03-fixtures-and-failing-tests.md](03-fixtures-and-failing-tests.md) | Add the anchor fixture; pin every expected byte as failing tests | 00, 01 |
| 4 | [04-parse-layer.md](04-parse-layer.md) | `lib/section.mjs`: reference parsing, canonicalisation, errors, the contradiction warning | 00, 03 |
| 5 | [05-scanner-layer.md](05-scanner-layer.md) | `lib/section.mjs`: the mask pass and the block scanner | 00, 04 |
| 6 | [06-resolve-layer.md](06-resolve-layer.md) | `lib/section.mjs`: matcher precedence, scope descent, modifiers | 00, 05 |
| 7 | [07-wire-into-index.md](07-wire-into-index.md) | Delegate `index.mjs` to the new module; prove existing behaviour unchanged | 00, 06 |
| 8 | [08-vectors.md](08-vectors.md) | Golden vectors with a `--check` drift gate, wired into `npm test` | 00, 07 |
| 9 | [09-docs-and-settle.md](09-docs-and-settle.md) | Dogfooded docs, the vendoring README, and the settle/sign-off handoff | 00, 08 |

The superseded single-document plan is kept for history at
[inject-examples-section-matching.md](../inject-examples-section-matching.md). **Where it and
these documents disagree, these documents win**; it will not be updated.

## How the split works

- **The contract is frozen and shared.** Syntax, matcher precedence, worked examples and
  error messages live in [00-contract.md](00-contract.md) and nowhere else. A step document
  never restates them; it cites them. If a step needs a contract change, it **stops** and
  reports back — it does not edit the contract.
- **Each step owns one commit.** A step is done when its own acceptance checklist passes and
  `node test.mjs` (or `node --test test.mjs` once steps 3+ add tests) is green. Steps land in
  order; do not start a step before its dependencies are committed.
- **Every step is a pure JavaScript step.** Porting is frozen — see §3 of the contract.
  No step may touch `src/**`, `build.zig`, `build.zig.zon`, or write a Java/Zig file.
- **Test counts drift, so nothing depends on them.** Prefer "assert this exact string",
  "assert this throws", "the whole suite is green" over "there are exactly N tests".

## Language scanners

The plan's scanner layer (step 5) builds `scanBlocks` in `lib/section.mjs` for structural
scanning — classes, methods, properties, region directives, comment anchors. The per-language
`if`-clause detection that feeds matcher 5 (**condition literal**, contract §6) is provided by
the language-aware scanners in `./src/js/scanner/`. Each one masks out comments and string
literals for its target language, then reports every `if` clause whose header spans up to the
opening brace contain `targetString`:

| File | Function | Language support |
| --- | --- | --- |
| [`src/js/scanner/scanJS.js`](src/js/scanner/scanJS.js) | `scanJS(source, targetString)` | JavaScript/TypeScript — single/double quotes, template literals, `//` and `/* */` |
| [`src/js/scanner/scanJava.js`](src/js/scanner/scanJava.js) | `scanJava(source, targetString)` | Java — standard strings, text blocks (`"""`), `//` and `/* */` |
| [`src/js/scanner/scanZig.js`](src/js/scanner/scanZig.js) | `scanZig(source, targetString)` | Zig — regular strings, multiline strings (`\`), line comments, **nested** block comments |

All three are pure functions taking `(source, targetString)` and returning an array of match
objects `{ type: 'if_clause', line, col, snippet }`, where `snippet` is the clause from `if` to
`{` trimmed of surrounding whitespace. They skip the contents of comments and string literals so
that `if` keywords and `{` braces appearing inside them do not produce false matches. Keyword
detection is guarded by `isBoundary` from [`src/js/utils.js`](src/js/utils.js), so `gift` is not
matched as `if`.

Usage:

```js
import { scanJS } from './src/js/scanner/scanJS.js';

const source = 'if ("getUsers".equals(methodName)) {\n    handle();\n}';
const matches = scanJS(source, 'getUsers');
console.log(matches[0]);
// → { type: 'if_clause', line: 1, col: 1, snippet: 'if ("getUsers".equals(methodName))' }
```

Each scanner is self-contained and may be imported directly; there is no barrel index. They share
the same `(source, targetString)` signature and return shape so step 5 can route by language
without a parser (house rule §3.5: "This is a heuristic, not a parser"). The JS scanner is the
reference implementation for the plan; the Java and Zig scanners mirror its shape for the
matching-language cases the resolver may later delegate to.

## Status

| Step | Status |
| --- | --- |
| 1 freeze porting | ✅ done |
| 2 spec document | ✅ done |
| 3 fixtures + failing tests | ✅ done |
| 4 parse layer | ✅ done |
| 5 scanner layer | ✅ done |
| 6 resolve layer | ✅ done |
| 7 wire into index | ✅ done |
| 8 vectors | ⛔ not started |
| 9 docs + settle | ⛔ not started |

Working tree has steps 1–7 committed; step 8 is next. The plan set
itself is complete: every step is written, each cites the contract rather than restating it,
and each carries its own acceptance checklist and verification commands.
