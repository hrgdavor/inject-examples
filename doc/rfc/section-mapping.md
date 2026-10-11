# RFC 1 — Section mapping syntax

| | |
| --- | --- |
| **Status** | Release candidate for 1.0 — **not** 1.0 yet. The design questions are settled ([§9](#9-decisions)); what remains is to exercise the document against a fresh port. |
| **Version** | `0.9-rc` (see [Document status](#10-document-status-and-versioning)) |
| **Supersedes** | nothing |
| **Normative detail** | [`doc/section-matching.md`](../section-matching.md) — the resolution rules |
| **Conformance data** | [`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json), [`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json), [`test/vectors/manifest.json`](../../test/vectors/manifest.json) |
| **Reference implementation** | [`lib/section.mjs`](../../lib/section.mjs) (matcher), [`index.mjs`](../../index.mjs) (document rules) |
| **Discussion** | the eight settled questions are in [§9](#9-decisions) |

---

## 1. Summary

**Section mapping** is the act of turning a short textual **reference** into the
exact lines of one source file it names:

```text
Cart/Line/render-          the body of the method `render` inside `Line` inside `Cart`
L40:12-L44:3               lines 40 to 44, from column 12 to column 3
++toString,render          a documented method, then another method, of the same file
server/port                a key path in a config file
```

Each line above is a *different* reference — a reference names one file, and the
file is the path in the link. The reference rides in the fragment:

```markdown
[the renderer](src/Cart.java#Cart/Line/render-)
[the port](app.yaml#server/port)
```

One link, one file, one reference. The same `path/to/file#reference` shape serves
every rule — a code file, or a config file — because the separator and the
composition rules are the same; what differs is only what a segment *names*. A
reference cannot reach into a second file, and a second `#` is a broken link
rather than a nested reference ([§9.8](#98-cross-file-references-are-out-of-scope)).

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
  masked text. This is the line: a mapper answers *where is this written*, never
  *what does this mean*.
- **Writing or refactoring — today.** The mapper as specified is **read-only**:
  it never modifies a target. A rename, a quick-fix or a refactor needs a writer,
  and no writer is part of this contract. **This is a boundary of the current
  version, not of the project** — see the forward goal in
  [§3.6](#36-forward-goal-refactoring-that-updates-references).
- **Being an AST parser.** See [§6](#6-what-a-mapper-is-not): no syntax tree, no
  grammar, no parser dependency — this is the single most important non-goal, and
  the reason the answer is a *range* rather than an AST node. AST-based
  implementations are a future *second kind* of engine
  ([§7.5](#75-ast-based-implementations-later-and-what-they-change)), not a
  change to this one.
- **Executing or evaluating.** Config values are read as text; nothing is
  interpreted.
- **Finding a *good* place.** Ranking, "closest match", fuzzy matching: host
  policy, never the mapper's.

**Language servers are not on this list — they are a consumer.** See
[§3.5](#35-what-a-language-server-consumes): a language server is use case A with
high call frequency, and the mapper is deliberately shaped to serve it. What is
out of scope is doing the *server's* work inside the mapper, not being used by
one.

### 3.5 What a language server consumes

A language server is the most demanding form of use case A: it runs *while a
person types*, on a document that is usually broken, and it must never block the
editor. It is a first-class consumer, and every feature below is built from the
mapper's operations — none of them requires the mapper to do anything more.

**An IDE or LSP host usually has an AST already, and should use it.** That is the
preferred arrangement and not a workaround: the parse has been paid for, the
host's parser knows its own language better than a shape heuristic can, and no
second parser has to be installed or kept current. So the shape of an IDE
integration is:

- the **grammar** ([§5.1](#51-parse)) is always the mapper's — a reference must
  mean the same thing in every host, and parsing a fragment needs no AST at all;
- **resolution** ([§5.3](#53-plan-the-whole-contract)) uses the host's AST where
  the host has one for the language, passed in as the engine
  ([§7.5 rule 5](#75-ast-based-implementations-later-and-what-they-change));
- the **standalone engine** covers languages the host has no parser for, and any
  host that is not an IDE — which is why both paths must produce the same range
  and the same messages.

That division is what the table below assumes; where the host's AST is used, the
rows are satisfied by the host plus the mapper's grammar, and the mapper's own
scan is not involved at all.

| The server wants | Built from | What the mapper supplies |
| --- | --- | --- |
| completion of a reference (after `#`, after `/`, after `,`) | `parseSelectors`/`parseReference` | a pure, context-free parse that reads no file, so it is safe to call on every keystroke |
| a preview of a completion item | `parseSelectors` | the structured `Reference`: `segments`, `scope`, `selectors[]`, and the canonical spelling |
| go-to-definition, and document highlight | `planSection`, or the host's AST | `startLine`/`endLine`, and one range per selector so each piece is highlighted separately |
| a diagnostic for a broken fragment | `planSection` | a specific message that names the selector at fault, and `warning` as a finding rather than a failure |
| semantic tokens, folding, "find all references to this section" | `planSection`, or the host's AST | `reference.selectors[]` and `ranges` |

**Two properties make this work, and both are already in the interface.**

1. **Parsing is pure and cheap.** `parseSelectors` reads no file and takes about
   a microsecond, so a server can call it on every keystroke. `planSection` reads
   the target, so a server calls it when the document or the target changes and
   caches per file version — exactly the invalidation a host already has. Cost is
   a *contract-level* concern here, not an optimisation detail: an engine whose
   scan is not near-linear in the file is unusable for this consumer, and
   [§7.5](#75-ast-based-implementations-later-and-what-they-change) makes the
   comparison a gate.
2. **Failure is a value, not an approximation.** The mapper never guesses. A
   server can therefore show *"no section named render in Cart"* confidently, and
   apply its own fuzzy policy while the user is still typing — a policy the RFC
   deliberately keeps out of the mapper ([§9.5](#95-no-fallback-in-the-mapper)).

**What the server does, and the mapper does not.** Editing, undoing, ranking
candidates, fuzzy matching, applying a rename, and diagnosing anything that needs
a *type* rather than a *shape*. Two honest limits follow from the non-goals:

- **No symbol table.** The mapper cannot tell whether `render` is reachable in the
  sense a compiler means; it only knows whether a declaration shaped like it is
  written there.
- **Shape, not type.** A name that a type system would reject may still resolve,
  because the mapper matches declaration *shapes* over masked text. That is the
  trade the non-goals make, and it is why a validator that needs types must
  re-check the mapper's answer rather than trust it.

### 3.6 Forward goal: refactoring that updates references

**Out of scope for 1.0 — in scope for the project.** A reference is a *name*, and
a name is exactly what a refactor changes. Today a rename in the target silently
breaks every document that referenced it, and the mapper's job stops at reporting
that. The goal is to close that loop: **a refactor that changes a declaration
should be able to find and update the references that pointed at it.**

The stated direction is to investigate **OpenRewrite** integration — an
OpenRewrite recipe detects the declaration change, and something must then
rewrite the `#` fragments across the documents that used them. Nothing about that
is designed yet, and this section is a statement of direction, not a
specification.

What 1.0 does to keep that door open, cheaply:

1. **The grammar stays machine-rewritable.** A reference is a `,`-separated list
   of `/`-separated paths with a trailing modifier; there is no syntax whose
   meaning depends on context outside the fragment. A writer can regenerate a
   fragment from a parsed `Reference` without asking anything else — which is
   already true, because `Reference.canonical` exists.
2. **A fragment is locatable.** References live in link fragments
   (`path#reference`) and are found by the document layer, not by guessing at
   prose. A rewriter needs to find them reliably; it does not need to understand
   them.
3. **Failure is explicit.** A rewriter must know which references it could *not*
   resolve, because those are the ones it must not touch. The mapper already
   distinguishes "malformed", "names nothing" and "not found", and names the
   selector at fault in each case.

**What is deliberately not promised.** That the mapper will ever write; that a
rename can be applied by editing fragments alone (it cannot — the target's own
declaration changes too, which is the recipe engine's half); and that a reference
and a declaration can be matched with certainty from text alone. The mapper
supplies *where the references are and what they asked for*; deciding whether a
given declaration change invalidates them is the writer's problem.

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
plan(source: string, reference: string, lexer?: Lexer) -> Plan | error

Plan := {
  text:      string,                     // selections joined with "\n", in order
  reference: Reference,                  // what was asked for, parsed
  startLine: number,                     // 1-based, inclusive
  endLine:   number,
  ranges:    { from: number, to: number }[],  // the spread of `text`, ascending
  kind:      'region' | 'declaration' | 'property' | 'condition'
           | 'anchor' | 'lines' | 'multiple'
}

Reference := {
  raw:       string,                     // the reference as written
  canonical: string,                     // its canonical spelling
  selectors: Selector[],                 // one per selector, in order
  segments:  string[],                   // the last path selector's segments
  scope:     'declaration' | 'body' | 'annotated' | 'documented',
  warning:   null | { kind: 'contradiction', kept: '++' | '+', dropped: '-' }
}

Selector := { kind: 'path',  raw: string, segments: string[], scope: Scope }
          | { kind: 'lines', raw: string, from: LinePoint, to: LinePoint | null }
```

- `text` is the file's own bytes (LF-normalised) — nothing added or re-indented —
  except in a **rendering rule** (JSON/YAML/TOML/INI), where a selection of keys
  is re-printed so the block is valid source of that format.
- `startLine`/`endLine` are the outermost bounds of `text`; `ranges` is the spread
  of `text` as ascending 1-based inclusive line pairs, adjacent pieces merged, so
  a host can highlight what was injected and nothing between it.
- **The per-selection detail is `reference.selectors`**, not a plan field: each
  selector carries its own `kind` (`path` or `lines`), its own `scope`, and its
  own segments. `kind` on the plan is the *summary*: the one matcher that found a
  single selector, or `multiple` when the reference named several.
- The `warning` belongs to the reference, not the plan, because it is a property
  of what was asked for rather than of what was found.
- Every selector must resolve. A list is **not** a fallback: the first missing
  selector fails the whole reference, naming it.
- **Never a clamp.** Anything the file does not have is an error, because a range
  that silently became a different range reintroduces the drift the whole design
  exists to remove.

A lighter parser is also public, and a host that only needs the grammar uses it:

```text
parseSelectors(reference: string) -> Reference | error
```

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

**"Not a parser" means not an AST parser.** The tokenizer step is real, and it is
the *only* part that needs per-language knowledge. What the mapper deliberately
does not do is build a syntax tree — no grammar, no AST library, no per-language
parser dependency. That is an engineering choice with a purpose, not a limitation
to be apologised for:

- **The mapper stays standalone.** A single dependency-free module that is
  vendorable and portable, rather than one build per language with a parser
  library behind it. The reference is one ES module; the ports are one small
  library each.
- **It stays fast and lean enough for a language server.** The engine runs per
  keystroke and per document, so its cost is a user-visible property. A
  five-line heuristic that resolves in microseconds beats a full parse of the
  file, and the sizes are not comparable.
- **Its contract is a range, not a node.** A tree would let an implementation
  answer questions the contract does not ask, and the boundary in
  [§3.3](#33-the-boundary-stated-once) exists to prevent exactly that.

**AST-based implementations will be added later, and are not a contradiction.**
See [§7.5](#75-ast-based-implementations-later-and-what-they-change): an AST
variant is an additional implementation of the same contract, allowed to use a
real grammar for its language. When one exists it becomes the **source of truth
for that language**, and the standalone engine becomes the thing it is measured
against — on correctness *and* on time and memory. Two rules follow, and both are
binding:

> **A standalone implementation must be correct and leaner or faster than the AST
> variant, or the custom implementation has no reason to exist.**

> **An AST variant must agree with the conformance suite.** Becoming the source
> of truth for a language means being better *within the same contract*, never
> redefining it — a variant that resolves something the suite says must fail is
> wrong, however well it parses.

Consequences of the heuristic design that an implementation must reproduce rather
than "improve":

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
| `test/vectors/section-vectors.json` | 186 | the grammar and the resolution: canonical spelling, text, `startLine`/`endLine`, `ranges`, `kind`, error, warning | JS, Zig, Java, Rust |
| — of which grammar-only (`input: null`) | 54 | canonical spelling and the thrown message; no file, no lexer | do. |
| — of which resolution | 132 | text and ranges against a fixture | do. |
| — of which expect an **error** | 52 | the failure path: a missing name, a malformed selector, a range past the end, a second `#` | do. |
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

### 7.5 AST-based implementations (later), and what they change

A second *kind* of implementation is expected, and this section fixes the rules
before the first one exists so that adding it is not a debate.

**What it is.** An implementation that resolves a language by parsing it with a
real grammar — an AST library, or a parser generated from the language's own
specification — rather than by the shape heuristics of
[§6](#6-what-a-mapper-is-not). It implements the *same* interface
([§5](#5-the-interface)) and answers the *same* questions: a `Plan`, the same
error messages, the same conformance rows.

**What changes when one exists.**

| | Standalone (heuristic) engine | AST variant |
| --- | --- | --- |
| Correctness for its language | best-effort by shape, per §6 | **source of truth for that language** |
| Which constructs it resolves | the shapes it recognises | everything the grammar defines |
| Cost | no parse; microseconds | a parse of the file, or **none, when the host has already parsed it** |
| Dependencies | none, vendorable | the language's parser |
| Status | the general engine, all languages; **the fallback wherever a host AST exists** | the authority for its own language, and **the preferred engine in an IDE that holds one** |

**The rules that follow.**

1. **An AST variant is bound by the same contract.** It may resolve *more* than
   the heuristic engine — that is the point — but it may not resolve something the
   conformance suite says must fail, and it may not rename a message or a field.
   Being the source of truth for a language means being better *inside* the
   contract, never redefining it.
2. **The standalone engine remains the fallback and the baseline.** It is what
   serves languages with no AST variant, and what a variant is measured against.
3. **Correctness is not the only gate — cost is too.** For the project to justify
   a hand-written engine where a parser exists, the standalone implementation must
   be **correct and either leaner or faster**. A variant that parses must earn its
   place by resolving what the heuristic engine cannot; a heuristic engine must
   earn its place by being right about the common shapes at a fraction of the
   cost. The honest position:
   > If the standalone engine is not correct, and not faster or leaner than the
   > AST variant, then the custom implementation is pointless and should be
   > replaced by the parser.

   **Where the host already has the AST, the comparison is not even close**, and
   the preference is settled rather than argued: the parse is already paid for,
   the host's parser knows its own language better than any heuristic, and using
   it ships no new dependency. The standalone engine's claim in *that*
   environment is portability and coverage, not speed — and if it is slower than
   a parse that already happened, it has no claim there at all. Its cost argument
   belongs to the environment that has no AST: the documentation build, where the
   alternative to a microsecond heuristic is a parser per language that must be
   installed, kept current and paid for on every file.
4. **Benchmarks become part of the suite, not an afterthought.** Cost is a
   property the project claims, so comparing engine and variant on time and
   memory over the fixtures is a gate, alongside the vectors. A performance
   regression is a defect in the same way a wrong range is.
5. **The host decides, and the host's own AST is preferred where it has one.**
   The target usages include an **IDE or a language server**, and those
   environments usually *already hold an AST* for the language being edited. In
   such an environment, **a mapper that uses the host's built-in AST is
   preferred** over the standalone heuristic engine — the parse has already been
   paid for, the host's knowledge of its own language is better than any shape
   heuristic, and it needs no second parser to ship. The rule:
   > Resolve with the best engine the host already has. Where the host has an AST
   > for the language, use it. The standalone engine is for hosts that do not,
   > and for languages the host does not cover.
   Two things this does **not** mean: it does not weaken the conformance
   requirement (an AST-backed resolution must still agree with the suite,
   [§7.5 rule 1](#75-ast-based-implementations-later-and-what-they-change)), and
   it does not make the standalone engine pointless — it is the portable
   baseline that works everywhere, including the CI job that builds the docs,
   which has no IDE and no AST.
6. **Selection is a policy, and it has to be visible.** Whichever engines are
   available, which one a document is resolved with must be a stated choice
   (a default, a flag, or a rule override) — never an accident of what happens to
   be installed. A document that resolves differently on two machines is the
   failure mode to design out. In an IDE the natural statement is *"prefer the
   host's AST, fall back to the standalone engine"*; in the documentation
   pipeline it is *"the standalone engine"*, and the two must be nameable.
7. **A variant is registered like a rule, not bolted on.** The interface already
   takes the language's engine as an argument (`lexer`), so a variant is *an
   engine a caller passes*, not a second code path inside the mapper. That is
   what lets an IDE pass an AST-backed engine and a CLI pass the standalone one
   without either knowing about the other.

**The two environments, side by side.** The same contract, served two ways:

| | IDE / LSP host | Documentation pipeline (this project) |
| --- | --- | --- |
| AST available | usually, for the edited language | no |
| Preferred engine | **the host's AST** | the standalone engine |
| Standalone engine's role | fallback, and coverage for languages the host lacks | the only engine |
| Cost that matters | per keystroke, inside an already-warm document | per build, over many files |
| What must not differ | the resolved range and the messages | the same |

**Nothing here is scheduled**, and none of it is needed for 1.0. The point of
writing it down now is that 1.0 does not have to be redesigned to allow it: the
contract is already engine-agnostic, the conformance suite is already the
arbiter, and the engine is already a parameter.

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

## 9. Decisions

The draft left eight questions open. All eight are now settled, and **none of
them changed resolution behaviour** — each one either recorded what the
implementation already did or drew a boundary. They are normative from here on.

### 9.1 What 1.0 freezes

**The reference grammar, the thrown messages, and the field names of `Plan` and
`Reference` as given in [§5.3](#53-plan-the-whole-contract).** Additions are
minor: a new `kind` member, a new field, a new language, a new corpus row. A
removal, a rename, a changed message or a changed resolution is major. This
settles *how much* is stable without freezing the vocabulary forever.

### 9.2 One modifier syntax, and no long form

`-`, `+`, `++` are the only spellings; a host that wants
`#Cart/render.body` must translate it itself. The reason is not taste: **`.`
already means something.** A TOML header spells a nested table `[a.b]`, a JSON
key may contain a dot, and the config rules once used `.` as their separator.
Adding `.body` as a modifier alias would make one reference readable two ways
depending on which rule claims the file. One syntax, one reading. The alias idea
is closed.

### 9.3 The per-selection detail already exists

A mixed reference reports `kind: 'multiple'` on the plan, and each piece carries
its own kind, scope and segments in `reference.selectors[]`. Nothing needs to be
added; what was missing was the *documentation* of it, which §5.3 now gives.

### 9.4 A key is a section, under the same grammar

**One reference grammar. Four rules that read it.** `/` separates segments for
every rule alike — code, JSON, YAML, TOML and INI — and a rule decides what a
segment *names*: a declaration path for code, a key path for the data formats.
There is no second grammar for config files, and the separator question is
therefore closed rather than merely decided per format.

The formats' own spellings still appear in the *output*, because they are the
format's: a TOML table is rendered as `[a.b]` with its dots, a YAML key path is
re-indented. The reference's spelling is always `/`. A key that itself contains a
dot is reached as `#a/b.c`; where the format allows a quoted key, `#a/"b.c"`
says the same thing explicitly.

What a missing selector reports also differs by rule, deliberately: code says
`no section named "render" in "Cart"`, the data rules name the key or the path
(`"server/nope": no key "nope"`), because that is the vocabulary of the file the
reader is looking at.

**A path may name a key or the container that holds one, and the reading is
ordered.** The formats make these two things look alike, so the rule is stated
once and applied by each:

1. **the last segment is a key of the container the earlier segments name** —
   `#a/b/c` is the key `c` of `[a.b]`. This wins when both readings exist,
   because it is the more specific claim.
2. **otherwise the whole path is a container** — `#server/tls` is `[server.tls]`.
   In TOML this resolves whether or not `[server]` is declared too, because a
   child table may stand alone.
3. **otherwise a single segment is a key that sits above every container** —
   `#title`, or a key before any `[section]` in INI.

JSON and YAML are only case 1 and 3 (a mapping is not a "table" to be selected
whole by a path that also names its child), TOML and INI have all three, and INI
stops at two segments because a section holds keys and nothing deeper.

### 9.5 No fallback in the mapper

**A mapper MUST NOT approximate.** It returns the exact range or an error. A
host **MAY** apply a fallback of its own when the call errors — that is use case
A's whole latitude — but the search, the ranking and the "close enough" judgement
belong to the host, never to the mapper. Writing this down converts the boundary
of [§3.3](#33-the-boundary-stated-once) from an explanation into an obligation.

### 9.6 No version negotiation

A reference does not declare the version of the syntax it was written against,
and 1.0 does not add one. The grammar is small, its changes are additive, and a
declaration would be carried by every marker in every document for a benefit that
has not been demonstrated. This is a deliberate *no*: if a real document ever
breaks under a syntax change, the question reopens with evidence.

### 9.7 The corpus is the regression suite; fuzzing is the discovery tool

Generated differential cases are **not** committed as rows. Instead:

> Every bug a differential run finds MUST become a committed conformance row
> before it is fixed.

That keeps the corpus small enough to review and turns each discovered bug into a
permanent, portable test. The differential harness stays the tool for finding
what no hand-written row covered — it is how the `->` header bug and an
assigned-name scan bug were found — and a port without a differential partner is
still held to everything those runs ever found.

### 9.8 Cross-file references are out of scope

A reference names a section of **one** file, and the file is named by the link's
path. A reference does not walk out of the current document, and nesting one
reference inside another (`path#a#b`) is not syntax. Everything in
[§3.4](#34-explicitly-out-of-scope) applies; this makes it explicit that
transclusion — pulling one document into another — is a different feature with a
different failure mode (which version of the other file?), and is not smuggled in
through the fragment.

---

## 10. Document status and versioning

- **Status: release candidate for 1.0 (`0.9-rc`).** The eight questions of the
  draft are settled in [§9](#9-decisions) and none of them changed resolution
  behaviour. What remains before 1.0 is *exercise*, not design: a port written
  from this document alone, and a release in which no question reopens.
- **The reference implementation is authoritative** where this document and the
  behaviour disagree; the conformance corpora are generated from it. A
  disagreement is a bug in the document or in the port, never in the corpus.
- **The `doc/section-matching.md` specification is normative** for resolution.
  This RFC is normative for *scope, boundary and conformance obligations*.
- **The RFC version is independent of the package version.** The npm package is
  `@hrg/inject-examples` and versions on its own semver; the version here is the
  *syntax* version, and the two must not be read as one number.
- **What a version means.** Before 1.0: any change. At 1.0 ([§9.1](#91-what-10-freezes)):
  the grammar, the error messages and the `Plan`/`Reference` field names stop
  changing incompatibly. New languages, lexer entries, conformance rows, `kind`
  members and fields are **minor**; a removal, a rename, a changed message or a
  changed resolution is **major**.
- **Change log.**
  - `0.9-rc` — the eight open questions settled ([§9](#9-decisions)), and two
    errors corrected: the answer shape in §5.3 named a `selections` field that
    does not exist (the per-selection detail is `reference.selectors[]`, and
    `warning` lives on the reference, not the plan), and the config rules'
    separator was documented as `.` in several places. **The separator is `/` for
    every rule alike**, which is a breaking change to any document that spelled a
    config reference with dots; there is no compatibility path, because this is
    the syntax's first release.
  - `0.9-rc` (continued) — three clarifications after review:
    - **Language servers are a consumer, not out of scope** ([§3.5](#35-what-a-language-server-consumes)).
      The removed item was a category error, and §3.4 now excludes *semantic code
      intelligence* — what the mapper must not do — rather than the hosts that use
      it.
    - **"Not a parser" means not an AST parser** ([§6](#6-what-a-mapper-is-not)),
      with [§7.5](#75-ast-based-implementations-later-and-what-they-change) fixing
      the rules for the AST-based implementations that will follow: they become
      the source of truth for their language, and the standalone engine must stay
      correct and leaner or faster, or it has no reason to exist.
    - **Refactoring that updates references is a forward goal**
      ([§3.6](#36-forward-goal-refactoring-that-updates-references)), with
      OpenRewrite integration named as the direction. Read-only is a boundary of
      this version, not of the project.
    - **In an IDE or LSP host, the host's AST is the preferred engine** when it
      has one for the language — the parse is already paid for, the host knows its
      own language better than a heuristic, and it ships no new dependency. The
      standalone engine keeps the grammar, covers what the host cannot, and serves
      the hosts that have no AST at all
      ([§3.5](#35-what-a-language-server-consumes),
      [§7.5](#75-ast-based-implementations-later-and-what-they-change)).
    - Row counts in [§7.1](#71-the-three-corpora) corrected to the corpus as it
      stands.
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
