# RFC 1 — Section mapping syntax

| | |
| --- | --- |
| **Status** | Draft — **not** 1.0. Expect breaking changes before the version is fixed. |
| **Version** | `0.1-draft` (see [Document status](#10-document-status-and-versioning)) |
| **Supersedes** | nothing |
| **Normative detail** | [`doc/section-matching.md`](../section-matching.md) — the resolution rules |
| **Conformance data** | [`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json), [`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json), [`test/vectors/manifest.json`](../../test/vectors/manifest.json) |
| **Reference implementation** | [`lib/section.mjs`](../../lib/section.mjs) (matcher), [`index.mjs`](../../index.mjs) (document rules) |
| **Discussion** | open — see [Open questions](#9-open-questions) |

---

## 1. Summary

**Section mapping** is the act of turning a short textual **reference** into the
exact lines of a source file it names:

```text
Cart/Line/render-          the body of the method `render` inside `Line` inside `Cart`
L40:12-L44:3               lines 40 to 44, from column 12 to column 3
++toString,config.port     a documented method, then a key from a config file
```

The reference rides in the fragment of an ordinary Markdown link:

```markdown
[the renderer](src/Cart.java#Cart/Line/render-)
```

This RFC defines the problem, the two use cases it must serve, the boundary
between what a section mapper is and is not, and the conformance suite a new
implementation is measured against. The precise resolution algorithm lives in
[`doc/section-matching.md`](../section-matching.md); this document is the
umbrella contract that names it, versions it and bounds it.

**One-line statement of the contract.** Given a source text and a reference, a
conformant implementation either returns *the exact text and its 1-based
inclusive line ranges* or raises an error naming the selector that failed. It
never returns an approximation.

---

## 2. Motivation

Documentation about code is written in Markdown, far from the code it describes.
The line-number link — "see lines 41–58 of Cart.java" — is the state of the art
and it rots on the first edit above it. Section mapping replaces the line number
with something that survives editing: a **name**.

Three properties make it worth specifying rather than leaving to each host:

1. **Anchoring that survives edits.** A named block moves with the code. A line
   number does not. This is the whole point.
2. **One reference syntax over many languages and formats.** Java, Go, Rust,
   Python, C#, Kotlin, PHP, Ruby, SQL, Shell, VB, Haskell, Zig — plus YAML, TOML,
   INI and JSON. A documentation author should not learn eighteen lookup rules.
3. **A verifiable answer.** Because the reference resolves to a *range*, two
   implementations can be compared byte for byte, and a documentation build can
   fail loudly instead of silently embedding the wrong code.

---

## 3. Use cases, and the boundary

There are two, and they are genuinely different products with a shared core. The
RFC exists mainly to draw the line between them precisely, because every past
design mistake here came from blurring it.

### 3.1 Use case A — *navigation* ("take me as close as feasible")

**Who:** an IDE, an editor plugin, a documentation site that wants a clickable
reference, a code-review tool.

**Need:** the reader wants to *be taken* to the right place. It is acceptable for
the destination to be approximate; it is not acceptable to be dropped at the top
of the file, or at a wrong-but-plausible place.

**The mapper's job:** resolve the reference and return the line range. Nothing
else. Navigation needs **only** a range; it does not need the text, and it must
not need to modify anything.

**Why this is the easier case:** the failure mode is shallow. If the reference
does not resolve, the host can fall back — the file's first line, a search for
the name, the previous location — and the reader still lands *somewhere*. A
stale named reference is still better than a stale line number, because the name
is the thing a human can check.

**Where the mapper must not help:** it must not *invent* a destination. If
`Cart/renderr` is a typo, returning "the class `Cart`, near enough" is worse than
an error, because it is silently wrong and the reader will trust it. Closeness is
the **host's** policy, not the mapper's: the mapper either finds the exact range
or says it cannot.

### 3.2 Use case B — *injection* (the primary case)

**Who:** this project. A documentation pipeline that puts the code *into* the
document, so the doc cannot drift from the source.

**Need:** the section's **exact text**, byte for byte, plus its line range in the
source (for the "open in editor" affordance and for highlighting). One named
block, or several in a written order, injected into a fenced code block.

**Why this is the demanding case:**

- The text must be *exact* — it is pasted, not linked. An off-by-one is a bug
  someone will copy.
- **Several selections must compose in the order written**, because prose
  narrates an order (`++toString,config.port`) that need not be source order.
- It must work for files that are **not code** — YAML, TOML, INI, JSON — where
  "declaration" has no meaning and the answer is a key, a value or a verbatim
  line range.
- A failure must **fail the build**, not degrade: a doc that silently injects
  nothing is a doc that lies.

### 3.3 The boundary, stated once

| | **A — navigation** | **B — injection (primary)** |
| --- | --- | --- |
| Consumer | IDE, editor, site link | documentation pipeline |
| Needs the text | no | **yes, byte-exact** |
| Needs ranges | yes | yes |
| Several selectors | usually one | **composed, in order** |
| Non-code files (YAML/TOML/INI/JSON) | not necessarily | **must work** |
| Failure policy | host falls back | **hard error** |
| May modify the target | never | never (it only reads) |
| Precision | exact range or error; *closeness* is the host's call | exact, no approximation tolerated |

**The dividing rule.** Both use cases call the *same* resolution function and get
the same answer object. They differ only in what they do *afterwards*: A may
apply a fallback of its own when the call errors; B must not. Therefore:

> **The mapper's contract is identical for A and B, and it is the B contract.**
> A is a special case of B in which the caller is allowed to ignore the text and
> to handle the error itself.

This is the boundary the RFC fixes. It means there is exactly one thing to
specify, one conformance suite, and no "lenient mode" inside the mapper — a
`--lenient` spelling exists in the CLI, but it is a *document* policy that
reports rather than rewrites, not a different resolution.

### 3.4 Explicitly out of scope

Not section mapping, and no implementation should grow these inside the mapper:

- **Semantic code intelligence.** No type inference, no symbol tables, no
  reference-finding, no call graphs. The mapper matches *declaration shapes* over
  masked text.
- **Writing or refactoring.** The mapper never modifies a target.
- **Language server behaviour.** No completion, diagnostics or rename.
- **Being a parser.** See [§6](#6-what-a-mapper-is-not); this is the single most
  important non-goal, and the reason the answer is a *range* rather than an AST
  node.
- **Executing or evaluating.** Config values are read as text; nothing is
  interpreted.
- **Finding a *good* place.** Ranking, "closest match", fuzzy matching: host
  policy, never the mapper's.

---

## 4. Terminology

| Term | Meaning |
| --- | --- |
| **source** | the bytes being mapped (one file), LF-normalised for scanning |
| **mask** | the source with comments and string literals blanked to spaces, same length, every newline at its own offset |
| **block** | a braced or indented span: a class-like body, a method body, a statement body, or a block introduced by an anchor comment |
| **scope** | the file (scope 0), or a block (its members are the next scope down) |
| **selector** | one element of a reference: a path, or a line range |
| **reference** | a `,`-separated list of selectors, in the order written |
| **modifier** | `-`, `+`, `++` — chooses *how much* of a match to take, never *which* |
| **scope name** | the four renderings a modifier selects: `declaration`, `body`, `annotated`, `documented` |
| **selection** | one resolved selector: its text and its line range |
| **answer** | the whole result: composed text, outermost range, one range per selector, per-selection kind |
| **lexer** | the language-specific half: masking, comment spans, and optionally the declaration shapes and annotation spelling a language adds |

---

## 5. The interface

The interface is small on purpose. Implementations are not required to mirror
internal structure, but they **must** expose these four operations, because the
conformance suite is defined in their terms.

### 5.1 Parse

```text
parse(reference: string) -> Reference | error
```

Reads the reference into selectors and a canonical spelling, consulting no file.
Asserted by the `grammar:*` rows, which compare the **canonical** spelling and
the thrown message.

### 5.2 Scan

```text
scan(source: string, lexer?: Lexer) -> Blocks
```

Builds the block tree. Not part of the public contract in detail, but its two
lexical invariants are:

- `mask(text)` returns a string of the **same length** with **every `\n` at the
  same offset**;
- every region the language calls a comment or a string is blank in the mask.

Both are asserted by the lexical corpus.

### 5.3 Plan (the whole contract)

```text
plan(source: string, reference: string, lexer?: Lexer) -> Answer | error

Answer := {
  text:      string,                     // selections joined with "\n", in order
  startLine: number,                     // 1-based, inclusive
  endLine:   number,
  ranges:    { from: number, to: number }[],  // one per selector, in order
  kind:      'region' | 'declaration' | 'property' | 'condition'
           | 'anchor' | 'lines' | 'multiple',
  selections: Selection[]
}
```

- `text` is the file's own bytes (LF-normalised), with nothing added, rendered or
  re-indented.
- `startLine`/`endLine` are the outermost bounds of the pieces; `ranges` is one
  entry per selector **in the order written**, so a host can highlight each piece
  separately.
- Every selector must resolve. A list is **not** a fallback: the first missing
  selector fails the whole reference, naming it.
- **Never a clamp.** Anything the file does not have is an error, because a range
  that silently became a different range reintroduces the drift the whole design
  exists to remove.

### 5.4 Errors

One error type (a `SectionReferenceError`, or a language equivalent that carries
the same message text). Messages are part of the contract — the conformance
suite asserts them — and they always quote the reference or selector at fault:

| Situation | Message shape |
| --- | --- |
| empty reference | `"#" names nothing` |
| empty selector | `"#a," has an empty selector` |
| malformed range | `"#L40-" is not a line range; write L<line> or L<line>:<column>` |
| zero/negative | `"#L0" counts lines and columns from 1` |
| reversed | `"#L44-L40" ends before it starts` |
| past the end | `"#L31": the file has 30 line(s)` |
| too deep | `"#a/b/c/d/e/f/g/h/i" is deeper than 8 sections` |
| not found | `no section named "render" in "Cart"` |

Two things are **warnings, not errors**, and they belong to the answer, not the
failure path: a modifier written twice with different meanings
(`getUsers++-` → keeps `++`, drops `-`), and a modifier on a `#region` or a line
range, where it is ignored.

---

## 6. What a mapper is *not*

The load-bearing non-goal, stated as a rule an implementer must respect:

> A mapper is **not a parser**. It masks comments and string literals with a real
> tokenizer for the language, then reads declaration-shaped lines, counts
> brackets and applies shape heuristics.

Consequences that follow, and that an implementation must reproduce rather than
"improve":

1. **A `}` inside a string or comment cannot end a body** — because it is blank in
   the mask. This is the *only* reason the lexical layer exists.
2. **A declaration's header may span lines.** Wrapped parameter lists, generic
   lists, `throws` clauses, `implements` clauses, and a Java `enum`'s constants
   each put the body's `{` below the name's line. The header is followed to the
   `{` or `;` that ends it, with one subtlety that matters: the `>` of `->` and
   `=>` is punctuation, **not** a closing angle bracket.
3. **A header that is not closed is not followed** — the scan is bounded (200
   lines), so a malformed file cannot make a mapper walk to the end.
4. **A construct the shape rules do not recognise is simply not a declaration**,
   however legal it is. The guarantee is one-directional: valid source never
   breaks the lexical layer; the matcher layer is best-effort by design.
5. **Names are matched exact-byte and case-sensitive.**
6. **A wrapped call stays a call.** `return map(\n 1, 2);` must not resolve as a
   declaration of `map`.

---

## 7. Conformance

The conformance suite is the second deliverable of this project, and it is
**data**, not code: an implementation reads the JSON and asserts every row. The
corpora are generated from the reference implementation, so a disagreement is a
bug in the *port* by definition.

### 7.1 The three corpora

| Corpus | Rows | Asserts | Read by |
| --- | --- | --- | --- |
| `test/vectors/section-vectors.json` | 182 | the grammar and the resolution: canonical spelling, text, `startLine`/`endLine`, `ranges`, `kind`, error, warning | JS, Zig, Java, Rust |
| — of which grammar-only (`input: null`) | 50 | canonical spelling and the thrown message; no file, no lexer | do. |
| — of which resolution | 132 | text and ranges against a fixture | do. |
| — of which expect an **error** | 48 | the failure path: a missing name, a malformed selector, a range past the end | do. |
| — of which expect a **warning** | 4 | a contradictory modifier resolved to the dominant reading | do. |
| `test/vectors/lexical-vectors.json` → `masks` | 45 | `mask()` output for every lexer entry (plus the built-in engine), and the length/newline invariant | JS, Zig, Java, Rust |
| `test/vectors/lexical-vectors.json` → `shapes` | 43 | `declarations(maskedLine)` field by field: `kind`, `name`, `headerFrom`, `body`, `end`, `line` | JS, Zig, Java, Rust |
| `test/vectors/manifest.json` | — | the machine-readable map of the above (see §7.3) | tooling, humans |

The `kind` a resolution row reports, as a census of the suite:
`declaration` 69, `property` 10, `anchor` 9, `lines` 6, `region` 5,
`multiple` 5, `condition` 2, and `null` 26 (the error rows and the rows whose
answer is a whole-file or body-less selection).

A fourth suite is not in the corpus but is equally required: the **differential
harness** (`tools/compare-zig.mjs` is the template). It runs two implementations
over the same corpus *plus generated fuzz cases* and compares bytes. That is how
the `->` header bug and an assigned-name scan bug were found, neither of which any
hand-written vector had covered.

### 7.2 Row shapes

```jsonc
// section-vectors.json — a grammar-only row: no fixture, nothing to resolve
{ "name": "grammar:add-,render++", "input": null, "reference": "add-,render++",
  "text": null, "startLine": null, "endLine": null,
  "ranges": null, "kind": null, "error": null, "warning": null }

// section-vectors.json — a resolution row
{ "name": "wrapped-method", "input": "test/fixtures/Wrapped.java",
  "reference": "render", "text": "    public String render(\n…",
  "startLine": 6, "endLine": 10, "ranges": [[6, 10]], "kind": "declaration",
  "error": null, "warning": null }
```

The two kinds are told apart by `input`: a grammar-only row consults no file, so
it has none. (`mode` appears in the *generator* as a case declaration; it is not
written into the row.)

Rules for the data, which exist to keep it trustworthy:

- **Never hand-edit a corpus.** Regenerate with `node tools/section-vectors.mjs`
  and `node tools/lexical-vectors.mjs`, then `node tools/zig-vectors.mjs` for the
  Zig copy.
- **Assert every row**, and fail when a row is unaccounted for. Silently skipping
  a row is how a port passes while being wrong.
- **Every row must discriminate**: an input whose wrong answer looks different
  from its right answer. A row that passes with either a right or a wrong matcher
  is not worth having.
- **Hand-check any row a change touches.** Because the corpus is generated from
  the implementation, an implementation that is wrong *consistently* bakes its
  own bug into the contract. This happened once (`rs-retry-past-the-first-impl`
  was committed without the closing `}`), so a changed row is reviewed, not
  trusted.
- **Error rows matter most.** They are what catch an over-eager matcher: a port
  can pass every resolution row and still over-match, and the rows expecting an
  *error* are where it fails.

### 7.3 Making the suite usable by a new implementation

For a new port, the path must be obvious and mechanical:

1. Read [`test/vectors/manifest.json`](../../test/vectors/manifest.json) — it
   lists every corpus, its row count, its row shape and what each field means,
   without the implementer having to reverse-engineer a generator.
2. Implement the four operations of [§5](#5-the-interface).
3. Write a conformance runner that reads the corpora **directly from the
   repository** (do not copy them into the port; every existing port does this,
   and it is why a corpus change reaches all of them at once).
4. Run it. Every failing row names itself, its field and the expected value, so
   the report is the bug list.
5. Add the port to the differential harness if the language allows it.

The existing ports are the worked examples: `java/section` (reads the corpora
directly, `mvn test`), `rust/section` (same, `cargo test`, with hand-written
matchers because it ships no regex engine), `src/` (Zig, with a generated
`src/section_vectors.zig` copy because Zig cannot read JSON at test time).

### 7.4 Adding a language

Two halves, both needed:

1. **Lexical**: one row in the mask corpus, so the blanking is verified.
2. **Shapes**: probe rows for the discriminating declaration spellings the
   language has that the generic matcher misses, plus at least one resolution row
   so the seams are exercised end to end.

`doc/languages.md` carries the per-language inventory; `AGENTS.md` carries the
mechanical checklist.

---

## 8. Test-suite organization

The suite is deliberately layered, cheapest first. An implementer should work
down this list and expect to stop at the first layer that fails.

| Layer | Where | What it proves | Depends on |
| --- | --- | --- | --- |
| **1. Grammar** | `grammar:*` rows | the reference is parsed and canonicalised; malformed input throws the specified message | nothing (no file, no lexer) |
| **2. Lexical** | `masks` rows | comments and strings are blanked; length and newlines preserved | a lexer table |
| **3. Shapes** | `shapes` rows | the language's own declaration spellings are read | layer 2 |
| **4. Blocks** | `scanBlocks:*` tests in `test.mjs` | the block tree: nesting, anchors, regions, conditions, Allman/indented/arrow bodies | layers 2–3 |
| **5. Resolution** | resolution rows | names, paths, scopes, modifiers, line ranges, several selectors | layers 1–4 |
| **6. Document rules** | `test.mjs` document tests | markers, gitignore, `--lenient`, region directives, JSON/TOML/INI/YAML rules, round trips | layer 5 |
| **7. Differential** | `tools/compare-zig.mjs` | two implementations agree byte for byte, including on generated inputs | a second implementation |

Two organizational rules that keep this honest as implementations multiply:

- **A layer's failures must not depend on a later layer.** Grammar rows take no
  file; a port can pass the grammar corpus before it can scan anything.
- **Every asserted fact lives in exactly one layer.** If a resolution row is the
  only place the mask is exercised, a masking bug will be reported as a
  resolution bug, and the implementer will look in the wrong place.

Fixtures are shared by path (`test/fixtures/*`), named for the behaviour they
demonstrate rather than the language alone (`Wrapped.java`, `WrappedClass.java`,
`Enum.java`, `Generics.rs`). A new fixture should be the smallest file that
demonstrates its behaviour, because it becomes part of the contract the moment a
row names it.

---

## 9. Open questions

This draft is expected to change. The questions below are the ones a 1.0 must
settle; they are listed with the current leaning, not as decisions.

1. **Frozen 1.0 surface.** Which parts become stable — the reference grammar
   only, or also the answer object's field names? *Leaning: the grammar and the
   error messages are 1.0; `kind`'s vocabulary may gain members in a minor.*
2. **Modifier naming.** `-`, `+`, `++` are terse and asymmetric. Is a long
   spelling (`#Cart/render.body`) wanted as a synonym, or does one syntax stay
   the only syntax? *Leaning: one syntax, aliases are a host concern.*
3. **A `kind` for "several".** Today a mixed reference reports `multiple`. Should
   each selection carry its own `kind` more explicitly than `selections[]` does?
4. **Non-code formats.** YAML/TOML/INI/JSON resolve keys. Is a key a "section" in
   the same sense, and should the RFC name a separate grammar for them?
5. **Fallback, formally.** Use case A wants "as close as feasible". Should the
   RFC define an *optional* second call — a suggestion the host may ignore —
   rather than leaving it entirely to the host?
6. **Version negotiation.** Does a document need to declare which reference
   version it was written against, or is the syntax stable enough to skip that?
7. **Fuzz corpus as a contract.** The differential harness generates inputs. Should
   a frozen subset of those generated cases become committed rows, so a port
   without a differential partner is still held to them?
8. **Cross-file references.** Everything is one file today. Is `path#a#b`, or a
   reference that walks *out* of the current document, ever in scope?

---

## 10. Document status and versioning

- **This document is a draft.** The reference implementation is authoritative
  where the two disagree, and the conformance corpora are generated from it.
- **The `doc/section-matching.md` specification is normative** for resolution.
  This RFC is normative for *scope, boundary and conformance obligations*.
- **The RFC version is independent of the package version.** The npm package is
  `@hrg/inject-examples` and versions on its own semver; `0.1-draft` here is the
  *syntax* version, and the two must not be read as one number. When this
  document reaches 1.0, it is the syntax that becomes stable.
- **What a version means here, once we get there.** Before 1.0: any change. At
  1.0: the grammar and the error messages stop changing incompatibly; new
  languages, new lexer entries and new conformance rows are *minor* changes; a
  new answer field is minor; a removed or renamed field, a changed message, or a
  changed resolution is *major*.
- **Change log.**
  - `0.1-draft` — first draft, extracted from the implementation and the
    resolution spec after the wrapped-header, expression-body and enum work.
    Section 3 (the boundary) and section 8 (test layering) are the new material;
    5, 6 and 7 restate what the implementation already does, and 7.3 records how
    a new port is expected to consume the suite.

---

## 11. References

- [`doc/section-matching.md`](../section-matching.md) — the resolution rules.
- [`doc/usage.md`](../usage.md) — how a document uses references.
- [`doc/languages.md`](../languages.md) — the per-language inventory.
- [`README.md`](../../README.md) — the project, and the CLI.
- [`AGENTS.md`](../../AGENTS.md) — the mechanical checklists, including how to
  add a language and how to regenerate the corpora.
- [`plans/zig-port.md`](../../plans/zig-port.md) — the porting goals and gates,
  as they were set for the first port.
- The corpora: [`section-vectors.json`](../../test/vectors/section-vectors.json),
  [`lexical-vectors.json`](../../test/vectors/lexical-vectors.json), and their map
  [`manifest.json`](../../test/vectors/manifest.json).
- The generators: `tools/section-vectors.mjs`, `tools/lexical-vectors.mjs`,
  `tools/zig-vectors.mjs`, `tools/conformance-manifest.mjs`.
- The differential harness: [`tools/compare-zig.mjs`](../../tools/compare-zig.mjs).
- `lib/section.mjs`, `java/section`, `rust/section`, `src/` — four
  implementations that pass the same suite.
