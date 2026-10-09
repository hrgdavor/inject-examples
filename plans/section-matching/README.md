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
scanning — classes, methods, properties, region directives, comment anchors — and it owns
precedence, the sibling-first walk, the modifier-on-last rule and rendering. The genuinely
language-specific part is only **lexical**: blanking comments and string literals (the mask) and
locating the comments. That is the **lexer seam**: `scanBlocks`/`planSection`/`resolveSection` take
an optional `lexer` (`{ name, mask, comments }`, plus an inherited `conditionLiterals`) and fall
back to a built-in default mask — the language-agnostic union — when none is supplied, i.e. when
the file's type is unknown. A lexer changes only what is blanked, never how the blanked text is
walked, so a known type and the default engine resolve the same reference to the same bytes.

`index.mjs` selects a lexer by extension via `src/js/scanner/lexers.js` (`lexerFor(path)` →
lexer or `undefined`). The three sample scanners are built on a shared one-pass tokenizer
(`src/js/scanner/tokenizer.js`, parameterised by syntax) and each exports three things:

| File | `lexerX` (the seam) | `scanX(source, target)` (the original sample) | `visitX(source, visitor)` (one-pass enumeration) | Language support |
| --- | --- | --- | --- | --- |
| [`src/js/scanner/scanJS.js`](src/js/scanner/scanJS.js) | `lexerJS` | `scanJS` | `visitJS` | JS/TS — `'` `"`, backtick templates, `//`, `/* */` |
| [`src/js/scanner/scanJava.js`](src/js/scanner/scanJava.js) | `lexerJava` | `scanJava` | `visitJava` | Java — `"` `'`, text blocks `"""`, `//`, `/* */` |
| [`src/js/scanner/scanZig.js`](src/js/scanner/scanZig.js) | `lexerZig` | `scanZig` | `visitZig` | Zig — `"`, multiline `\\`, `//`, **nested** `/* /* */ */` |

`scanX(source, targetString)` keeps its original shape: the `if` clauses whose header (up to the
opening brace) contains `targetString`, as `{ type: 'if_clause', line, col, snippet }`, detected on
the mask so an `if` or `{` inside a string or comment never matches. `visitX(source, visitor)` runs
the same single pass and calls `visitor.comment`, `visitor.string`, `visitor.ifClause`, so a file is
enumerable for tests or another use without resolving anything — the resolver uses that very pass
through `lexerX`. The mask invariant (same length, every `\n` at the same offset) is asserted once
per scan in `lib/section.mjs` and names the lexer that breaks it. `lib/section.mjs` imports nothing
(contract §10), so the lexers are injected from `index.mjs`, never imported by the module; a test
pins that boundary.

A per-type lexer matters where the default union is wrong — chiefly Zig's nested block comments,
which the non-nesting default mask leaks (a commented-out `fn decoy` becomes a section). The golden
vectors pin it (`z-decoy-hidden-by-nested-comment`). Spec consumers may substitute any lexer — a
TreeSitter parse, an IDE index — that satisfies the invariant; see the "Tokenizers" section of
`doc/section-matching.md`.

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
| 8 vectors | ✅ done |
| 9 docs + settle | ✅ done |

All nine steps are committed. The revision is **frozen and awaiting maintainer
sign-off** (step 9, task 5): the settled reference is commit `656d280`, named in
`doc/section-matching.md`; `lib/README.md` keeps its draft-API warning until a
human reviews the syntax against a real document outside the fixtures.
The plan set itself is complete: every step is written, each cites the contract rather than restating it,
and each carries its own acceptance checklist and verification commands.

**Amendment (2026-10-08, maintainer):** the walk rule changed from depth-first to
**sibling-first** (breadth first) — see the amendment at the end of
[00-contract.md](00-contract.md) and rule 5 of `doc/section-matching.md`. The
implementation, the tests and the golden vectors were updated with it, so the
settled SHA above predates the amendment.
