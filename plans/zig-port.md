# The Zig port — goals, gates, and the end of the freeze

**Status: active plan. The porting freeze is lifted.**

This document is the "separate plan" the two superseded documents promised:
[§6 of inject-examples-section-matching.md](./inject-examples-section-matching.md#6-porting-freeze-in-force-for-this-whole-plan)
("Porting gets its own plan, written after this one lands and the JS syntax is settled. That
plan owns the Java deliverable and its shape, the Zig catch-up (if still wanted), the
differential harness's return, and the parity gates.") and house rule 2 of
[the contract](./section-matching/00-contract.md).

**The maintainer's decision: the file-section-matching syntax is well enough defined that
porting is allowed again.** The JavaScript side is settled; `doc/section-matching.md` is the
normative specification; the vectors are stable; and the Zig port has been brought to parity
and is now held there by gates rather than by a freeze.

---

## 1. What changed, and why

The freeze existed for one reason, stated in the superseded plan: while the JavaScript syntax
was moving, a second implementation could only be stale by design, so comparing the two would
produce false failures and hide real ones.

That reason is gone:

- the reference grammar, matcher precedence, the sibling-first walk, the modifier rules, the
  error catalogue and the contradiction warning are written down in
  [doc/section-matching.md](./../doc/section-matching.md) and pinned as data in
  [test/vectors/section-vectors.json](./../test/vectors/section-vectors.json);
- the per-type lexers are data in
  [src/js/scanner/syntaxes.js](./../src/js/scanner/syntaxes.js), enumerated in
  [doc/languages.md](./../doc/languages.md), and cross-checked against highlight.js by the
  mask oracle;
- the corpus no longer changes under the port: `node tools/section-vectors.mjs --check`
  exits 0, so the vectors the two engines are held to are frozen in the same sense the
  contract is.

So the freeze is replaced by something stronger: **parity that is proven on every commit**.

## 2. The goals

1. **The JavaScript implementation stays the source of truth.** `index.mjs`, `cli.mjs`,
   `lib/section.mjs` and `src/js/scanner/**` define what this tool does. A port that
   disagrees with them is wrong by definition — the port moves, not the semantics.
2. **The Zig port is a supported deliverable**, not a science project. It builds, ships in
   the tagged GitHub release, and must be a drop-in stand-in for `node cli.mjs`: the same
   flags, the same `inject-examples: …` messages, the same rewriting, the same exit codes.
3. **Parity is a gate, not an aspiration.** No port change lands without the golden vectors
   and the differential harness being green, and no JavaScript change to the matching rules
   lands without regenerating the vectors and re-running both.
4. **The language-neutral design boundary is unchanged.** Structure, precedence and rendering
   stay in one place per implementation (`lib/section.mjs` / `src/section.zig`); a language is
   *data* plus a lexer, and adding one is one object, one extension line, and corpus entries —
   never a new parser.
5. **No second semantics.** The port mirrors; it does not lead. If a Zig-side fix is worth
   having, it is made in JavaScript first and ported.

## 3. The state of the port

Complete as of this plan, and verified:

| JavaScript (source of truth) | Zig (port) |
| --- | --- |
| `lib/section.mjs` | [src/section.zig](./../src/section.zig) |
| `src/js/scanner/syntaxes.js` | [src/scanner/syntaxes.zig](./../src/scanner/syntaxes.zig) |
| `src/js/scanner/tokenizer.js` | [src/scanner/tokenizer.zig](./../src/scanner/tokenizer.zig) |
| `src/js/scanner/lexers.js` | [src/scanner/lexers.zig](./../src/scanner/lexers.zig) |
| the YAML / TOML / INI rules in `index.mjs` | [src/data_rules.zig](./../src/data_rules.zig) |
| `index.mjs` | [src/root.zig](./../src/root.zig) |
| `cli.mjs` | [src/main.zig](./../src/main.zig) |
| shared UTF-16 runtime | [src/js.zig](./../src/js.zig) |

Ported: slash-separated section paths with retried same-named scopes, trailing and leading
`-` / `+` / `++` modifiers with the contradiction warning, condition literals, comment
anchors, `#region` pairing, the per-type lexers for all eighteen languages in the table, and
the three config-format rules. Markers carry `#<reference>` directly, as the JavaScript does
since an older fragment prefix was dropped.

## 4. The gates

Every one of these must be green; the CI workflow
[.github/workflows/ci.yml](./../.github/workflows/ci.yml) runs all three on every push and
pull request.

| Gate | Command | What it proves |
| --- | --- | --- |
| JavaScript suite | `node --test test.mjs` | 153 tests: the shipped behaviour, the docs, the demo page, the language table, the two corpora |
| Vectors drift | `node tools/section-vectors.mjs --check` | the golden corpus still describes the JavaScript implementation |
| Lexical vectors drift | `node tools/lexical-vectors.mjs --check` | the mask and shape corpus still describes the JavaScript implementation |
| Ported suite | `zig build test` | 55 Zig tests, including both conformance corpora |
| Zig corpus drift | `node tools/zig-vectors.mjs --check` | `src/section_vectors.zig` still describes both corpora |
| Differential | `node tools/compare-zig.mjs` | JS vs Zig, byte for byte: stdout, stderr, exit code and every rewritten file, over the edge-case corpus, a reference corpus that resolves every construct each lexer exists for (including the hard spellings), and a seeded fuzzer |
| Java port | `mvn test` (in `java/section`) | the same corpora, read directly: every resolution vector, every mask and every declaration shape |
| Rust port | `cargo test` (in `rust/section`) | the layers it has ported: the grammar vectors, every mask and every declaration shape |
| Formatting | `zig fmt --check build.zig src`, `cargo fmt --check` | the hand-written sources and the generated `src/section_vectors.zig` are all `zig fmt`-clean |

### The conformance corpus

[src/section_vectors.zig](./../src/section_vectors.zig) is **generated** by
[tools/zig-vectors.mjs](./../tools/zig-vectors.mjs) from the same
`test/vectors/section-vectors.json` that `test.mjs` holds the JavaScript to, plus the fixture
text it resolves against. Every vector is one assertion inside `section.zig`'s conformance
test, so a drift between the two engines fails `zig build test` with the case's name and both
expected and actual bytes.

Never edit it by hand. Regenerate with `node tools/zig-vectors.mjs`, and note that
`npm test` runs `--check`, so a stale file fails the JavaScript gate too.

### The differential harness

[tools/compare-zig.mjs](./../tools/compare-zig.mjs) is the proof of goal 2. It was switched
off in step 1 of the plan set and is switched back on here; it is no longer gated behind
`--force`. `--seed N` and `--rounds N` vary the fuzzer.

## 5. Changing something after the freeze

The freeze is over, but the order of operations is not optional.

**A new language, or a change to what a language masks:**

1. one object in [src/js/scanner/syntaxes.js](./../src/js/scanner/syntaxes.js) and one line in
   `EXTENSIONS` in `lexers.js` — see [doc/languages.md](./../doc/languages.md);
2. probe entries in the corpus in [tools/mask-oracle.mjs](./../tools/mask-oracle.mjs), and
   `npm run oracle` to cross-check against highlight.js;
3. a mask row in [tools/lexical-vectors.mjs](./../tools/lexical-vectors.mjs), and
   `node tools/lexical-vectors.mjs` — this is the corpus that holds *every* entry, so an entry the
   resolution vectors never reach is still asserted in all four implementations;
4. the same object in [src/scanner/syntaxes.zig](./../src/scanner/syntaxes.zig) and the same
   extension line in [src/scanner/lexers.zig](./../src/scanner/lexers.zig), the same object in
   `Syntaxes.java` and `syntaxes.rs`, and `node tools/zig-vectors.mjs` to bake the corpus for Zig;
5. `node tools/compare-zig.mjs` to prove the two engines still agree, then `mvn test` and
   `cargo test` to prove the other two do.

**A change to a language's declaration shapes** (the spellings the generic `name(` heuristics miss):

1. the descriptor in `src/js/scanner/syntaxes.js`, with shape rows
   (`declarations(maskedLine)` on the *raw* line, the discriminating spelling) in
   [tools/lexical-vectors.mjs](./../tools/lexical-vectors.mjs);
2. the same descriptor or matcher in `src/scanner/syntaxes.zig`, `Syntaxes.java` and
   `rust/section/src/tokenizer.rs` — the shape rows are what proves the transcription;
3. resolution cases for the spelling in
   [tools/section-vectors.mjs](./../tools/section-vectors.mjs), so the *resolver* is held to it and
   not only the matcher, and the same fixture in `tools/compare-zig.mjs`'s reference corpus.

**A change to the matching rules** (grammar, precedence, walk order, modifiers, rendering):
change `lib/section.mjs` and `src/section.zig` together, add or update the vector cases in
[tools/section-vectors.mjs](./../tools/section-vectors.mjs), regenerate the JavaScript and the Zig
corpora (`node tools/section-vectors.mjs`, `node tools/zig-vectors.mjs`), then run every gate —
`node test.mjs`, `zig build test`, `node tools/compare-zig.mjs`, `mvn test`, `cargo test`.
**A semantics change that is not in the JavaScript first does not land.**

**A change to the CLI** (a flag, a message, an exit code): `cli.mjs` and `src/main.zig` in the
same change, with `node tools/compare-zig.mjs` as the check.

**Documentation that a port must not silently diverge from:**
[doc/section-matching.md](./../doc/section-matching.md) is normative for the grammar;
[doc/languages.md](./../doc/languages.md) is the language table as prose; `test.mjs` holds
the second of those to the code.

## 6. What is deliberately not done

- **No Java or Rust CLI is specified or started.** Two further ports of `lib/section.mjs` — not of
  the CLI — do exist: the Java library in [`java/section`](./../java/section) (complete) and the
  Rust crate in [`rust/section`](./../rust/section) (lexical layers done, resolution still to come).
  They are held at parity the way this plan holds the Zig port, by the same generated corpora read
  directly — `test/vectors/section-vectors.json` for resolution and
  `test/vectors/lexical-vectors.json` for the masks and the declaration shapes — with `mvn test` and
  `cargo test` as their gates. That is the answer to the question this section used to ask: a third
  and fourth implementation need no differential harness of their own, because the corpus is the
  comparison and every port asserts it in CI. `compare-zig.mjs` still compares exactly two tools,
  and only the Zig port ships a binary.
- **No older fragment prefix is coming back.** It was dropped in
  `10646fb`; `#<reference>` is the syntax, and neither implementation accepts the old
  spelling.
- **No version bump or tag here.** `npm publish` ships the JavaScript package and a `v*` tag
  ships the binaries; both are the maintainer's call, and the earlier warning about tagging
  while the port was stale no longer applies.
- **No behaviour invented on the Zig side.** The known, deliberate divergence stays: a
  `.gitignore` glob whose generated JavaScript regular expression is invalid (`[?-!*]`) makes
  the JavaScript tool die with an uncaught `SyntaxError` while the Zig port matches the glob
  as written and carries on. It is documented in `README.md` as deliberate.

## 7. Working on the port

```bash
zig build                     # -> zig-out/inject-examples(.exe)
zig build test                # the ported suite plus the conformance corpus
node tools/compare-zig.mjs    # JS vs Zig, byte for byte
```

`zig build` and `zig build test` need a writable Zig cache. Where the global cache is not
writable (a sandbox, a locked-down CI runner), point both at the tree:

```bash
zig build test --global-cache-dir .zig-cache/global --cache-dir .zig-cache/local
```

---

## Amendment (maintainer decision, 2026-10-10): the freeze is lifted

House rule 2 of [the contract](./section-matching/00-contract.md) is retired. The rule that
replaces it is goal 1 above — the JavaScript is the source of truth and the port follows it —
which is the same rule the freeze was protecting, without the pause.

What was *not* a freeze and is unchanged: the design rule that keeps a port cheap. Structure,
precedence, the walk and rendering live in one language-neutral module per implementation;
the language-specific half is a lexer and a data table; a new language is never a new parser.
That is why there is a port at all.
