# RFC 1 — Section mapping: the contract and the resolution core

|                              |                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------ |
| **Status**                   | Release candidate for 1.0 — **not** 1.0 yet. The design questions are settled ([§9](#9-decisions)); what remains is to exercise the document against a fresh port. |
| **Version**                  | `0.9-rc` (see [Document status](#10-document-status-and-versioning))           |
| **Supersedes**               | nothing                                                                        |
| **Normative detail**         | [`doc/section-matching.md`](../section-matching.md) — how a reference resolves |
| **This document**            | what a section mapper *is*, the one contract both use cases call, the execution profiles that read it, and the suite that measures it |
| **Use-case specs**           | [RFC 2 — code jump](code-jump.md) (navigation, best-effort) and [RFC 3 — inject examples](inject-examples.md) (injection, strict) |
| **Conformance data**         | [`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json), [`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json), [`test/vectors/manifest.json`](../../test/vectors/manifest.json) |
| **Reference implementation** | [`lib/section.mjs`](../../lib/section.mjs) (matcher), [`index.mjs`](../../index.mjs) (document rules) |
| **Discussion**               | the settled questions are in [§9](#9-decisions)                                |

---

## 1. Summary

**Section mapping** is the act of turning a short textual **reference** into the
exact lines of one source file it names:

```text
Cart/Line/render/-         the body of the method `render` inside `Line` inside `Cart`
L40:12-L44:3               lines 40 to 44, from column 12 to column 3
toString/++,render         a documented method, then another method, of the same file
server/port                a key path in a config file
```

Each line above is a *different* reference — a reference names one file, and the
file is the path in the link. The reference rides in the fragment:

```markdown
[the renderer](src/Cart.java#Cart/Line/render/-)
[the port](app.yaml#server/port)
```

One link, one file, one reference. The same `path/to/file#reference` shape serves
every rule — a code file, or a config file — because the separator and the
composition rules are the same; what differs is only what a segment *names*. A
reference cannot reach into a second file, and a second `#` is a broken link
rather than a nested reference ([§9.8](#98-cross-file-references-are-out-of-scope)).

The precise resolution algorithm lives in
[`doc/section-matching.md`](../section-matching.md); this document is the
umbrella contract that names it, versions it and bounds it.

**One-line statement of the contract.** Given a source text and a reference, a
conformant implementation either returns *the exact text and its 1-based
inclusive line ranges* or raises an error naming the selector that failed. It
never returns an approximation.

### 1.1 There is one resolver, and two ways to read it

The design mistake this document exists to prevent is a second resolver. There is
exactly **one** resolution contract — one grammar, one walk, one message set, one
suite — and everything a caller does differently it does *after* the call.

What genuinely differs between the two products built on it is not the algorithm
but the **profile**: when a failure fails the run, and how much of a useful answer
an imperfect reference still yields. A resolver that returns something different
depending on who asked is the drift this split removes.

|                                 | [RFC 2 — code jump](code-jump.md)               | [RFC 3 — inject examples](inject-examples.md)                   |
| ------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Product                         | IDE, editor plugin, doc-site link, code review  | documentation pipeline (this project)                           |
| Wants from a resolution         | the **first line**, to put a cursor on          | the **exact text**, byte for byte, plus ranges                  |
| When the reference is imperfect | best effort: a useful place, with a warning     | fail: a hard error, no approximation                            |
| As a gate (`--check`, CI)       | any non-exact resolve **is** an error           | any non-exact resolve **is** an error                           |
| What only it tolerates          | the editor reading — a warning, never at a gate | a *skipped* marker under `--lenient`, never a substituted block |

So the layers are: the **resolution core** in this document (never
approximates), [RFC 2](code-jump.md) on top of it (an outcome profile that may
be best-effort in an editor and strict in a gate), and
[RFC 3](inject-examples.md) on top of both (the strict end, where nothing but an
exact answer is ever accepted). The three are normative in that order, and a
disagreement between them is resolved here, not by whichever is read last.

### 1.2 What is normative where

Three short rules keep the layering from blurring as the documents grow:

- **[`doc/section-matching.md`](../section-matching.md)** is normative for *how a
  reference resolves* — the grammar, the walk, the modifiers, the envelopes and
  the messages.
- **This document** is normative for *what a mapper is*: the operations, the two
  error categories, the non-goals, the conformance obligations, and the fact that
  one resolver serves every profile.
- **[RFC 2](code-jump.md)** and **[RFC 3](inject-examples.md)** are normative
  **only** for what their use case does with a resolution — the acceptance and
  escalation policy, and the fallback ladder. **Neither may redefine resolution.**
  Where a use-case spec and this document disagree about *what a reference
  resolves to*, this document wins; where they disagree about *when a failure
  ends the run*, the use-case spec wins.

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
   INI, JSON and CSS. A documentation author should not learn nineteen lookup
   rules.
3. **A verifiable answer.** Because the reference resolves to a *range*, two
   implementations can be compared byte for byte, and a documentation build can
   fail loudly instead of silently embedding the wrong code.

Two products want that, and they were always the reason the contract had to be
written down. **A jump:** an editor, a documentation site or a review tool has a
reference in hand and wants to put the reader *at the right line*. It needs the
line number and nothing else, and it can survive an imperfect reference — a
reader who lands on the enclosing type is still better served than one who lands
at the top of the file. **An injection:** this project's own use case, putting the
named block *into* a document, verbatim, so the document cannot drift from the
source. Here an imperfect answer is not a smaller answer, it is a lie — a block
copied out of the wrong `add` method reads as fact.

The two are the same call and different policies, which is the whole of
[§1.1](#11-there-is-one-resolver-and-two-ways-to-read-it).

---

## 3. The resolution core

### 3.1 The operations, one answer shape

The interface is small on purpose. Implementations are not required to mirror
internal structure, but they **must** expose these operations, because the
conformance suite is defined in their terms.

```text
parseSelectors(reference: string) -> Reference | error     // grammar only; reads no file
parseReference(reference: string) -> Reference | error     // an alias of the same parse
scan(source: string, lexer?: Lexer) -> Blocks              // the block tree
planSection(source: string, reference: string, lexer?: Lexer) -> Plan | error
resolveSection(source: string, reference: string, lexer?: Lexer) -> string   // planSection(...).text
diagnose(source: string, reference: string, lexer?: Lexer) -> Diagnosis      // never throws (§5.3)
deepestResolvablePrefix(source: string, reference: string, lexer?: Lexer)    // the ladder's probe (§5.3)
  -> { reference, firstLine, segments } | null
```

`parseReference` and `parseSelectors` are one operation under two names, kept
because hosts adopted both spellings; `resolveSection` is the one-field shorthand
for a caller that wants only the bytes. **A host that needs less must not get a
different answer**: `resolveSection(t, r)` is byte-identical to
`planSection(t, r).text`, and `parseSelectors(r)` is byte-identical to
`parseReference(r)`. `diagnose` is `planSection` with the throw turned into a
value, and resolves nothing of its own.

The first five are the contract a port implements. `diagnose` and
`deepestResolvablePrefix` serve a best-effort host ([RFC 2](code-jump.md)) and are
**not required of a port** until the corpus gains band rows
([§6.2](#62-row-shapes)).

### 3.2 Parse

```text
parse(reference: string) -> Reference | error
```

Reads the reference into selectors and a canonical spelling, consulting no file.
Asserted by the `grammar:*` rows, which compare the **canonical** spelling and
the thrown message. It is pure and takes about a microsecond, so a host may call
it on every keystroke.

### 3.3 Scan

```text
scan(source: string, lexer?: Lexer) -> Blocks
```

Builds the block tree. Not part of the public contract in detail, but its two
lexical invariants are:

- `mask(text)` returns a string of the **same length** with **every `\n` at the
  same offset**;
- every region the language calls a comment or a string is blank in the mask.

Both are asserted by the lexical corpus.

### 3.4 Plan (the whole contract)

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
  segments:  string[],                   // the last path selector's name segments
  scope:     'declaration' | 'body' | 'annotated' | 'documented'
}

Selector := { kind: 'path',  raw: string, segments: string[], scope: Scope,
              envelope?: { mark: '^' | '$', parent: string[] | null } }
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
- A modifier (`++`, `+`, `-`) is the **last segment** of a path, so `segments`
  holds names only; it is reported as the selector's `scope`.
- Every selector must resolve. A list is **not** a fallback: the first missing
  selector fails the whole reference, naming it.
- **Never a clamp.** Anything the file does not have is an error, because a range
  that silently became a different range reintroduces the drift the whole design
  exists to remove.

**Who reads which field.** One answer, several consumers, and the split exists
because they want different parts of it — so the part each one reads is written
down rather than left to a reader of the code. The two consumers of note are the
use-case specs ([RFC 2](code-jump.md), [RFC 3](inject-examples.md)):

| Field                 | What it is                                                    | Jump reads it                                          | Injection reads it                                           |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `ranges[0].from`      | the first line of the first selector — the landing line       | **yes** ([RFC 2 §3.1](code-jump.md#31-the-first-line)) | for highlighting                                             |
| `text`                | the bytes the section stands for, selections joined with `\n` | **no**                                                 | **yes**, written verbatim                                    |
| `ranges`              | one range per selector, ascending, adjacent pieces merged     | to highlight the piece                                 | to highlight the piece, and to compare a block for staleness |
| `startLine`/`endLine` | the outermost bounds of `text`                                | not for the cursor                                     | the span the selection occupies                              |
| `reference.selectors` | the per-selector detail: kind, scope, segments                | to describe a target ("`render`, in `Line`, body")     | to report which selector failed, and to render each piece    |
| `kind`                | the matcher that found a single selector, or `multiple`       | to explain a target                                    | to explain a resolve                                         |

**No consumer may derive a field another one owns.** A jump that needs the landing
line reads `ranges[0].from`; it does not split `text` to find it. An injection that
needs the bytes reads `text`; it does not re-slice the file from `ranges`. The
table is the agreement, and the reason it is normative rather than descriptive is
that two readers deriving the same number two ways is how they start to disagree.

### 3.5 The first line

Both use cases need one derived number, and it is the same number, so it is
defined here once rather than derived twice:

> **The first line of a selection is the `from` of its first range** — that is,
> the first line of the *first selector as written*, not the lowest line number
> in the selection.

For a reference of several selectors the two readings differ: `L40,toString`
written at a file where `toString` is near the top has `startLine` 3 and a first
range that starts at 40, and a cursor belongs on **40**, because that is what the
author wrote first. `ranges` is ascending, and `startLine`/`endLine` are the
outermost bounds — so `ranges[0].from` is the only field that means "where a
reader starts", and a host that jumps must read it rather than recompute it.

The concrete jump contract — which line, what it means for an envelope or a
region, and what a host may do when the resolve fails — is
[RFC 2 §3](code-jump.md#3-where-a-jump-lands).

### 3.6 Errors, in two categories

One error type per category, and the category is part of the contract, because
the two use cases route the categories differently
([§5](#5-acceptance-and-escalation)):

| Category       | Meaning                                                      | Thrown as                                                                                      | When                                                                |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Grammar**    | the reference is malformed as written; no file was consulted | a `SectionReferenceError` (or a language equivalent carrying the same `name` and message text) | by `parse`/`parseSelectors`, and by `plan` before it reads anything |
| **Resolution** | the reference is well-formed but the file cannot answer it   | an `Error` whose message is the contract text (a `SectionReferenceError` where the failure needs no file, e.g. an envelope whose ends contradict) | by `plan`/`resolve` |

**Every failure also carries a stable code**, which is how a profile tells one
band from another without matching prose (implemented in the reference
implementation; see [§5.3](#53-the-diagnosis-surface-structured-failure) for the
fields and the registry):

| Situation                               | Category   | Code                                  | Message shape                                                    |
| --------------------------------------- | ---------- | ------------------------------------- | ---------------------------------------------------------------- |
| empty reference                         | grammar    | `grammar/empty-reference`             | `"#" names nothing`                                              |
| empty selector                          | grammar    | `grammar/empty-selector`              | `"#a," has an empty selector`                                    |
| malformed range                         | grammar    | `grammar/line-range-not-a-range`      | `"#L40-" is not a line range; write L<line> or L<line>:<column>` |
| zero/negative                           | grammar    | `grammar/line-range-from-1`           | `"#L0" counts lines and columns from 1`                          |
| reversed                                | grammar    | `grammar/line-range-backwards`        | `"#L44-L40" ends before it starts`                               |
| past the end                            | resolution | `resolution/line-range-past-end`      | `"#L31": the file has 30 line(s)`                                |
| too deep                                | grammar    | `grammar/too-deep`                    | `"#a/b/c/d/e/f/g/h/i" is deeper than 8 sections`                 |
| a modifier that is not the last segment | grammar    | `grammar/modifier-not-last`           | `"++" may only modify the last path segment of "#a/++/b"`        |
| the old suffix or prefix spelling       | grammar    | `grammar/modifier-old-spelling`       | `"++" is a path segment now; write "#a/++"`                      |
| not found                               | resolution | `resolution/not-found`                | `no section named "render" in "Cart"`                            |
| one level, several candidates           | resolution | `resolution/ambiguous`                | `"add" is declared 2 times; names must be unique`                |

The full registry is the `ERROR_CODES` table of `lib/section.mjs`, and
`test/vectors/manifest.json` lists it for a porter. **A code is added, never
renamed**: rewording a message must not break a host that branches on one.

**Nothing in this grammar is a warning.** A reference either resolves or fails, so
there is no third answer to carry: a modifier written twice on one path is
malformed (`a/++/-`) rather than two readings to choose between, and a modifier on
a `#region` or a line range is ignored because neither is a path that could carry
one. A warning is a **profile** word ([§5](#5-acceptance-and-escalation)), never a
resolver word.

**The failure path is structurally readable.** A resolution failure must say
*which selector* failed and *which block* it was looking in — that is in the
message text — and a host must be able to recover it without parsing prose. The
offending selector, the scope it was searched in, the candidates a name answered
to and the stable code are the **diagnosis surface** of
[§5.3](#53-the-diagnosis-surface-structured-failure): additive, advisory, and
outside the 1.0 freeze ([§9.1](#91-what-10-freezes)).

### 3.7 The mapper is not a parser

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
  answer questions the contract does not ask.

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

### 3.8 Engines: the standalone scan, or the host's own AST

A second *kind* of implementation is expected, and the rules are fixed here before
the first one exists so that adding it is not a debate.

**What it is.** An implementation that resolves a language by parsing it with a
real grammar — an AST library, or a parser generated from the language's own
specification — rather than by the shape heuristics of
[§3.7](#37-the-mapper-is-not-a-parser). It implements the *same* interface
([§3.1](#31-the-operations-one-answer-shape)) and answers the *same* questions: a
`Plan`, the same error messages, the same conformance rows.

|                              | Standalone (heuristic) engine                                                  | AST variant                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Correctness for its language | best-effort by shape, per §3.7                                                 | **source of truth for that language**                                                     |
| Which constructs it resolves | the shapes it recognises                                                       | everything the grammar defines                                                            |
| Cost                         | no parse; microseconds                                                         | a parse of the file, or **none, when the host has already parsed it**                     |
| Dependencies                 | none, vendorable                                                               | the language's parser                                                                     |
| Status                       | the general engine, all languages; **the fallback wherever a host AST exists** | the authority for its own language, and **the preferred engine in an IDE that holds one** |

**The rules that follow.**

1. **An AST variant is bound by the same contract.** It may resolve *more* than
   the heuristic engine — that is the point — but it may not resolve something the
   conformance suite says must fail, and it may not rename a message or a field.
   Being the source of truth for a language means being better *inside* the
   contract, never redefining it ([§9.5](#95-one-resolver-strictness-is-a-profile)).
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
   preferred** over the standalone heuristic engine. The rule:
   > Resolve with the best engine the host already has. Where the host has an AST
   > for the language, use it. The standalone engine is for hosts that do not,
   > and for languages the host does not cover.
   Two things this does **not** mean: it does not weaken the conformance
   requirement (an AST-backed resolution must still agree with the suite, rule 1
   above), and it does not make the standalone engine pointless — it is the
   portable baseline that works everywhere, including the CI job that builds the
   docs, which has no IDE and no AST.
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

The two environments, side by side — the same contract, served two ways — are the
two use-case specs: the IDE column is [RFC 2](code-jump.md), the pipeline column
is [RFC 3](inject-examples.md).

**Nothing here is scheduled**, and none of it is needed for 1.0. The point of
writing it down now is that 1.0 does not have to be redesigned to allow it: the
contract is already engine-agnostic, the conformance suite is already the
arbiter, and the engine is already a parameter.

### 3.9 Explicitly out of scope

Not section mapping, and no implementation should grow these inside the mapper:

- **Semantic code intelligence.** No type inference, no symbol tables, no
  reference-finding, no call graphs. The mapper matches *declaration shapes* over
  masked text. This is the line: a mapper answers *where is this written*, never
  *what does this mean*.
- **Writing or refactoring — today.** The mapper as specified is **read-only**:
  it never modifies a target. A rename, a quick-fix or a refactor needs a writer,
  and no writer is part of this contract. **This is a boundary of the current
  version, not of the project** — see the forward goal in
  [§4](#4-forward-goal-refactoring-that-updates-references).
- **Being an AST parser.** See [§3.7](#37-the-mapper-is-not-a-parser): no syntax
  tree, no grammar, no parser dependency — this is the single most important
  non-goal, and the reason the answer is a *range* rather than an AST node.
- **Executing or evaluating.** Config values are read as text; nothing is
  interpreted.
- **Finding a *good* place.** Ranking, "closest match", fuzzy matching: host
  policy, never the mapper's. A mapper either finds the exact range or says it
  cannot ([§5](#5-acceptance-and-escalation)).

**Language servers are not on this list — they are a consumer.** Their contract
is [RFC 2 §6](code-jump.md#6-the-language-server-and-ide-integration): a language
server is a jump consumer with high call frequency, and the mapper is deliberately
shaped to serve it. What is out of scope is doing the *server's* work inside the
mapper, not being used by one.

### 3.10 The vendorable module boundary

`lib/section.mjs` is a single, dependency-free ES module that exports the matching
algorithm only — the core of [§3.1](#31-the-operations-one-answer-shape), and
nothing else. It **must not** import or reference `node:fs`, `node:path`,
`process`, `cli.mjs`, the `src/js/scanner/` lexers, or anything that reads the
disk or the environment, because a consumer project vendors this one file.

The per-type lexers are *injected* — a `lexer` argument threaded in by the caller
— so the module stays dependency-free while still resolving through a language
engine, and a lexer that is not supplied leaves the built-in default engine
([§3.8](#38-engines-the-standalone-scan-or-the-hosts-own-ast)).

**Where the boundary runs, now that the RFC is split.** The document layer —
markers, fences, rule dispatch, the extension→lexer selection, gitignore and
document rewriting — is [`index.mjs`](../../index.mjs), and it is the subject of
[RFC 3 §4](inject-examples.md#4-the-document-layer), not of this document. It
delegates section resolution and owns nothing about it. The jump product
([RFC 2](code-jump.md)) has no document layer at all: it takes a path and a
fragment, which is why it can be called on every cursor move without touching a
document.

A project adds a rule for another type with `options.regionRules` (see
[`doc/usage.md`](../usage.md)); a custom rule calls the core for its type and
otherwise reuses the same matchers. A test asserts this boundary, so it cannot
rot.

---

## 4. Forward goal: refactoring that updates references

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
   of `/`-separated paths whose last segment may be a modifier (`render/++`);
   there is no syntax whose meaning depends on context outside the fragment. A
   writer can regenerate a fragment from a parsed `Reference` without asking
   anything else — which is already true, because `Reference.canonical` exists.
2. **A fragment is locatable.** References live in link fragments
   (`path#reference`) and are found by the document layer, not by guessing at
   prose. A rewriter needs to find them reliably; it does not need to understand
   them.
3. **Failure is explicit.** A rewriter must know which references it could *not*
   resolve, because those are the ones it must not touch. The mapper already
   distinguishes "malformed", "names nothing" and "not found", and names the
   selector at fault in each case — and the diagnosis surface of
   [§5.3](#53-the-diagnosis-surface-structured-failure) is what makes that
   machine-readable rather than prose.

**What is deliberately not promised.** That the mapper will ever write; that a
rename can be applied by editing fragments alone (it cannot — the target's own
declaration changes too, which is the recipe engine's half); and that a reference
and a declaration can be matched with certainty from text alone. The mapper
supplies *where the references are and what they asked for*; deciding whether a
given declaration change invalidates them is the writer's problem.

**Why this is a core concern and not a use-case one.** Both use cases need the
same three properties — a rewritable grammar, a findable fragment, an explicit
failure — and both need them to agree, because a refactor that updates a fragment
one product reads and the other does not is exactly the drift
[§1.1](#11-there-is-one-resolver-and-two-ways-to-read-it) removes.

---

## 5. Acceptance and escalation

This section is the **contract between the core and the profiles**, and it is the
reason the RFC was split. A profile says what a failure *means to a run*; the
resolver says what the failure *is*.

### 5.1 The three outcomes

A profile sorts every resolve into exactly one of three outcomes, and never
invents a fourth:

| Outcome          | What the profile does                                                     | The band it belongs to                                                    |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Resolved**     | the exact answer is used as-is                                            | the reference named a block, and there was one candidate                  |
| **Approximated** | a *different* answer may be used, and the profile must record that it did | the reference did not resolve exactly, but the core said what it was near |
| **Failed**       | no answer is used; the profile's policy decides whether the run continues | the reference is malformed, or nothing near it could be named             |

**An approximation is always attributable.** A profile that returns an
approximated answer must carry the reason and the exact failure it came from, so
that the same situation can be an error under the other profile without either
having to re-resolve anything. A profile that cannot say why an answer is
approximate is not implementing this section.

**What "near" means is the core's answer, not the profile's.** The resolver
reports the candidates a name answered to, and the scope a path failed in; it
never ranks them and never picks one. The ladder that turns "near" into "use it"
is the profile's ([RFC 2 §4](code-jump.md#4-the-best-effort-ladder)).

### 5.2 The band table

The profile word for each band, per spec. "Error" ends the run as a failure;
"warn" reports and continues; "ok" is a normal answer.

| Band (core)                                          | **inject/gate** ([RFC 3](inject-examples.md)) | **inject/tolerant** (`--lenient`) | **jump/editor** ([RFC 2](code-jump.md))  | **jump/gate** (`--check`) |
| ---------------------------------------------------- | --------------------------------------------- | --------------------------------- | ---------------------------------------- | ------------------------- |
| grammar (malformed reference)                        | error                                         | error                             | warn, fall back                          | **error**                 |
| not found                                            | error                                         | warn, skip the marker             | warn, fall back                          | **error**                 |
| ambiguous (one level, several candidates)            | error                                         | error                             | warn, pick per the ladder                | **error**                 |
| not a container / wrong scope                        | error                                         | warn, skip the marker             | warn, fall back                          | error                     |
| out of range (`L31` in a 30-line file)               | error                                         | warn, skip the marker             | warn, fall back to the last line         | error                     |
| duplicate key / table / section                      | error                                         | error                             | warn, fall back                          | error                     |
| unresolved by drift (the file no longer declares it) | error                                         | error                             | warn, fall back **and report the drift** | **error**                 |

Three readings of the table are deliberate, and they are the whole point of the
split:

- **The gates agree.** `inject/gate` and `jump/gate` are the same on every band:
  anything that is not an exact resolve fails. A CI job that jumps through a
  document and a CI job that injects into it must not disagree about whether the
  document is broken.
- **The editor is the only tolerant reading.** Best effort exists in exactly one
  column, and it exists there because a reader is sitting in front of it. Nothing
  in the editor may *silently* approximate: every fallback is attributable
  ([§5.1](#51-the-three-outcomes)).
- **`--lenient` is not a jump-like mode.** It tolerates a failure by leaving the
  block as written and reporting it; it never chooses a different block. A
  tolerant *injection* is still an injection, so it may skip — it may not
  substitute.

### 5.3 The diagnosis surface: structured failure

**Status: implemented in the JavaScript reference implementation; the band rows
are not yet in the corpus.** Both failure categories are readable without parsing
prose, the strict path is byte-for-byte unchanged, and every field below exists
today — the codes are asserted by `test.mjs`, and a port gains them when the
corpus gains band rows (RFC 1 §6.2). The shape:

```text
SectionReferenceError {
  name:    'SectionReferenceError',
  message: string,                 // unchanged: the contract text
  code:    string,                 // stable category, e.g. 'grammar/empty-selector',
                                   //   'resolution/not-found', 'resolution/ambiguous'
  selector: string | null,         // the selector as written, when one is at fault
  scope:    string | null,         // the block it was searched in, for a resolution failure
  candidates: { name, startLine, endLine, kind }[] | null   // what the name answered to
}
```

**There is deliberately no `near` field.** A "did you mean" needs a *ranking*, and
ranking is the profile's, never the core's
([§9.5](#95-one-resolver-strictness-is-a-profile)). The core reports the
candidates a name answered to and the prefix of the path that still resolves
([`deepestResolvablePrefix`](#53-the-diagnosis-surface-structured-failure)); a host
that wants edit-distance suggestions computes them itself, from what it was given.

**A resolution failure is a plain `Error` with the same fields**, because the
category split of [§3.6](#36-errors-in-two-categories) is by *type*: a malformed
reference throws a `SectionReferenceError`, and a reference the file cannot answer
throws an `Error`. Both carry `code`.

**The codes.** `ERROR_CODES` in `lib/section.mjs` is the registry: every code is
namespaced by the category it belongs to (`grammar/…` when no file was read,
`resolution/…` when the file cannot answer), and a code is **added, never
renamed** — rewording a message must not break a host that branches on the code.
The registry is exported so a tool can read it, and `test/vectors/manifest.json`
lists it for a porter.

**`diagnose(source, reference, lexer)` is the non-throwing entry point**, and the
only operation a best-effort host needs. It returns the same `Plan` on success —
byte for byte, not a second resolution — or the structured failure otherwise:

```text
diagnose(text, reference, lexer) -> {
  status:   'ok' | 'failed' | 'invalid',   // resolved / the file cannot answer / malformed
  plan:     Plan | null,                   // present only when status === 'ok'
  firstLine: number | null,                // ranges[0].from, the landing line (§3.5)
  error:    Error | null,                  // the failure itself, with the fields above
  code, selector, scope, candidates,       // the failure's own diagnosis
  advice:   string | null                  // a repair hint; non-null only for grammar/*
}
```

Four rules make it additive rather than a redesign:

1. **`message` and the thrown type never change.** Existing consumers, the corpus
   and the four ports keep working untouched; the fields are extra.
2. **The fields are advisory and never used for resolution.** A profile reads them
   to choose a fallback; the resolver's own answer does not depend on them.
3. **`plan()` keeps throwing, in the same categories.** `diagnose` is the same
   call with the throw turned into a value; there is no third operation that
   resolves differently.
4. **A row pins every field a profile may branch on.** If a profile can read
   `code` or `candidates` to decide a fallback, the corpus asserts them, so a port
   that guesses differently fails the gate. Until those rows land, the codes and
   the candidate lists are asserted in `test.mjs`, and a port that omits
   `diagnose` still passes every corpus row.

**Where the ladder gets its "near".** The core supplies two things and ranks
neither: the `candidates` a name answered to (the ambiguity band), and
`deepestResolvablePrefix(text, reference, lexer)` — the longest prefix of the
reference the user wrote that still resolves, with the line it starts on, or null.
Both are probes: they report, the host decides
([RFC 2 §4.3](code-jump.md#43-not-found)).

### 5.4 Drift guards

The reason both use cases care about strictness is the same: **a reference that
silently stops meaning what it meant is the failure the whole design exists to
remove.** Drift arrives in four shapes, and each profile names what it does about
each — the band table is the answer, and these are the shapes it answers about:

| Shape of drift                                                     | How it shows up                | Who must catch it hardest                                                     |
| ------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------- |
| the target no longer declares the name                             | a not-found failure            | the injector at the gate: the document is wrong, and a reader will believe it |
| the name now answers twice                                         | an ambiguity failure           | the injector first — it cannot choose — and the gate of either product        |
| the block moved, so the written line range is stale                | a range that no longer matches | the injector, which compares bytes; the jump can only be approximate here, since it has no text to compare |
| the reference was rewritten to a different block that *does* exist | a resolve that succeeds        | **nobody catches this from text alone** — see below                           |

The last row is the honest limit, stated once for both specs: a resolver matches
*shapes and names*, so a reference edited to name a real but wrong block resolves
cleanly. Only a reader, or a test that pins the *intent*, can catch it. What the
suite can do is pin that the **profile difference is deliberate** rather than
accidental — the corpus answers the same reference the same way for every
consumer, and a port that makes jump and inject disagree anywhere fails.

---

## 6. Conformance

The conformance suite is the second deliverable of this project, and it is
**data**, not code: an implementation reads the JSON and asserts every row. The
corpora are generated from the reference implementation, so a disagreement is a
bug in the *port* by definition.

### 6.1 The three corpora

| Corpus                                         | Rows | Asserts                                                                                            | Read by                  |
| ---------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- | ------------------------ |
| `test/vectors/section-vectors.json`            | 326  | the grammar and the resolution: canonical spelling, text, `startLine`/`endLine`, `ranges`, `kind`, error | JS, Zig, Java, Rust, Lua |
| — of which grammar-only (`input: null`)        | 68   | canonical spelling and the thrown message; no file, no lexer                                       | do.                      |
| — of which resolution                          | 258  | text and ranges against a fixture                                                                  | do.                      |
| — of which expect an **error**                 | 94   | the failure path: a missing name, an ambiguous name, a malformed selector, a range past the end, a second `#`, a misplaced modifier | do. |
| `test/vectors/lexical-vectors.json` → `masks`  | 46   | `mask()` output for every lexer entry (plus the built-in engine), and the length/newline invariant | JS, Zig, Java, Rust, Lua |
| `test/vectors/lexical-vectors.json` → `shapes` | 53   | `declarations(maskedLine)` field by field: `kind`, `name`, `headerFrom`, `body`, `end`, `line`     | JS, Zig, Java, Rust, Lua |
| `test/vectors/manifest.json`                   | —    | the machine-readable map of the above (see §6.3)                                                   | tooling, humans          |

The `kind` a resolution row reports, as a census of the suite:
`declaration` 79, `property` 66, `multiple` 13, `anchor` 27, `lines` 6,
`region` 7, `condition` 4, and `null` 124 (the error rows and the rows whose
answer is a whole-file or body-less selection).

A fourth suite is not in the corpus but is equally required: the **differential
harness** (`tools/compare-zig.mjs` is the template). It runs two implementations
over the same corpus *plus generated fuzz cases* and compares bytes. That is how
the `->` header bug and an assigned-name scan bug were found, neither of which any
hand-written vector had covered.

**The profile layer, as data.** The policy is pinned in its **own corpus**,
`test/vectors/profile-vectors.json`, generated by `tools/profile-vectors.mjs` and
asserted by `lib/jump.test.mjs`:

- **`resolutions[]`** — one row per case where the policy shows: the **editor's**
  landing line and `cause`, and the **band the gate refuses** (or `null` when it
  resolves too). A row is discriminating only where the two readings disagree, or
  where the editor's answer is one the resolver corpus does not record — the
  generator **refuses** a row that both readings answer exactly, because that row
  belongs in the resolution corpus.
- **`documents[]`** — a whole document through the gate: `checked`, `passed`, and
  **every** failure with its `code` and the selector at fault. The document text
  and every file it reads are **embedded**, so a consumer needs no disk.

It is a separate file on purpose. A profile is a product's policy, not the
resolver's contract, so a port that implements the resolver alone **skips this
layer entirely** ([§6.3](#63-making-the-suite-usable-by-a-new-implementation));
folding it into `section-vectors.json` would silently change what every existing
port assertion means. This is the one layer a port may pass by not having the
feature. The `code` a resolution row carries ([§5.3](#53-the-diagnosis-surface-structured-failure))
is what makes the two corpora meet: the band the gate refuses is the same string
the resolver already reports.

### 6.2 Row shapes

```jsonc
// section-vectors.json — a grammar-only row: no fixture, nothing to resolve
{ "name": "grammar:add/-,render/++", "input": null, "reference": "add/-,render/++",
  "text": null, "startLine": null, "endLine": null,
  "ranges": null, "kind": null, "error": null }

// section-vectors.json — a resolution row
{ "name": "wrapped-method", "input": "test/fixtures/Wrapped.java",
  "reference": "render", "text": "    public String render(\n…",
  "startLine": 6, "endLine": 10, "ranges": [[6, 10]], "kind": "declaration",
  "error": null }

// section-vectors.json — a failure row, once band rows land: the code the
// profile branches on, beside the message it must not parse
{ "name": "missing-name", "input": "test/fixtures/Example.java",
  "reference": "renderr", "text": null, "startLine": null, "endLine": null,
  "ranges": null, "kind": null,
  "error": "no \"#region renderr\" found, and no section named \"renderr\"",
  "code": "resolution/not-found" }
```

The two kinds are told apart by `input`: a grammar-only row consults no file, so
it has none. (`mode` appears in the *generator* as a case declaration; it is not
written into the row.) The `code` field is **proposed, not yet written** — the one
addition the band table needs; a row without it still asserts everything it
asserts today.

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
- **A profile difference is a row, not a paragraph.** When the band table or
  [§5.3](#53-the-diagnosis-surface-structured-failure) lands, the discriminating
  rows are the ones where the two columns of the table disagree — a fallback that
  a strict profile must refuse. A row both profiles answer the same way proves
  nothing about the split.

### 6.3 Making the suite usable by a new implementation

For a new port, the path must be obvious and mechanical:

1. Read [`test/vectors/manifest.json`](../../test/vectors/manifest.json) — it
   lists every corpus, its row count, its row shape and what each field means,
   without the implementer having to reverse-engineer a generator.
2. Implement the operations of [§3.1](#31-the-operations-one-answer-shape).
3. Write a conformance runner that reads the corpora **directly from the
   repository** (do not copy them into the port; every existing port does this,
   and it is why a corpus change reaches all of them at once).
4. Run it. Every failing row names itself, its field and the expected value, so
   the report is the bug list.
5. Add the port to the differential harness if the language allows it.
6. **A port implements the resolver only.** It is not required to expose a profile
   — a jump host and an injector can both sit on the same resolver a port
   supplies — but if it does offer one, it must reproduce the band table of
   [§5.2](#52-the-band-table) for the profiles it offers.

The existing ports are the worked examples: `java/section` (reads the corpora
directly, `mvn test`), `rust/section` (same, `cargo test`, with hand-written
matchers because it ships no regex engine), `src/` (Zig, with a generated
`src/section_vectors.zig` copy because Zig cannot read JSON at test time).

### 6.4 Adding a language

Two halves, both needed:

1. **Lexical**: one row in the mask corpus, so the blanking is verified.
2. **Shapes**: probe rows for the discriminating declaration spellings the
   language has that the generic matcher misses, plus at least one resolution row
   so the seams are exercised end to end.

`doc/languages.md` carries the per-language inventory; `AGENTS.md` carries the
mechanical checklist. A new language changes **nothing** about a band: it adds
answers to the same contract, and the two profiles read them the same way.

---

## 7. Test-suite organization

The suite is deliberately layered, cheapest first. An implementer should work
down this list and expect to stop at the first layer that fails.

| Layer                 | Where                              | What it proves                                                                            | Depends on                  |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| **1. Grammar**        | `grammar:*` rows                   | the reference is parsed and canonicalised; malformed input throws the specified message   | nothing (no file, no lexer) |
| **2. Lexical**        | `masks` rows                       | comments and strings are blanked; length and newlines preserved                           | a lexer table               |
| **3. Shapes**         | `shapes` rows                      | the language's own declaration spellings are read                                         | layer 2                     |
| **4. Blocks**         | `scanBlocks:*` tests in `test.mjs` | the block tree: nesting, anchors, regions, conditions, Allman/indented/arrow bodies       | layers 2–3                  |
| **5. Resolution**     | resolution rows                    | names, paths, scopes, modifiers, line ranges, several selectors                           | layers 1–4                  |
| **6. Document rules** | `test.mjs` document tests          | markers, gitignore, `--lenient`, region directives, JSON/TOML/INI/YAML rules, round trips | layer 5                     |
| **7. Differential**   | `tools/compare-zig.mjs`            | two implementations agree byte for byte, including on generated inputs                    | a second implementation     |

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

## 8. Glossary

| Term           | Meaning                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| **source**     | the bytes being mapped (one file), LF-normalised for scanning                                    |
| **mask**       | the source with comments and string literals blanked to spaces, same length, every newline at its own offset |
| **block**      | a braced or indented span: a class-like body, a method body, a statement body, or a block introduced by an anchor comment |
| **scope**      | the file (scope 0), or a block (its members are the next scope down)                             |
| **selector**   | one element of a reference: a path, or a line range                                              |
| **reference**  | a `,`-separated list of selectors, in the order written                                          |
| **modifier**   | `-`, `+`, `++` — chooses *how much* of a match to take, never *which*                            |
| **scope name** | the four renderings a modifier selects: `declaration`, `body`, `annotated`, `documented`         |
| **selection**  | one resolved selector: its text and its line range                                               |
| **answer**     | the whole result: composed text, outermost range, one range per selector, per-selection kind     |
| **first line** | the `from` of the first range — where a reader starts, and what a jump returns ([§3.5](#35-the-first-line)) |
| **lexer**      | the language-specific half: masking, comment spans, and optionally the declaration shapes and annotation spelling a language adds |
| **band**       | what a failure means to a run: resolved, approximated or failed ([§5.1](#51-the-three-outcomes)) |
| **profile**    | the acceptance and escalation policy of one product — `inject/gate`, `inject/tolerant`, `jump/editor`, `jump/gate` ([§5.2](#52-the-band-table)) |
| **drift**      | a reference that no longer means what it meant — the failure both profiles exist to catch ([§5.4](#54-drift-guards)) |

---

## 9. Decisions

The draft left eight questions open. All eight are now settled, and **none of
them changed resolution behaviour** — each one either recorded what the
implementation already did or drew a boundary. They are normative from here on.
The layering questions that follow the split are
[§9.5](#95-one-resolver-strictness-is-a-profile) and
[§9.6](#96-the-rfc-is-split-into-a-core-and-two-use-case-specs).

### 9.1 What 1.0 freezes

**The reference grammar, the thrown messages, and the field names of `Plan` and
`Reference` as given in [§3.4](#34-plan-the-whole-contract).** Additions are
minor: a new `kind` member, a new field, a new language, a new corpus row, a new
optional error field. A removal, a rename, a changed message or a changed
resolution is major. This settles *how much* is stable without freezing the
vocabulary forever.

The freeze is on the **resolution** contract. A profile — the band table, the
fallback ladder — is deliberately *not* frozen at 1.0: it is a policy each
product owns, and a product that changes when it errors has changed a policy, not
a resolution ([§9.5](#95-one-resolver-strictness-is-a-profile)).

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
its own kind, scope and segments in `reference.selectors[]`. Nothing needed to be
added; what was missing was the *documentation* of it, which §3.4 now gives — and
the one number both use cases need, the first line, is defined once in
[§3.5](#35-the-first-line).

### 9.4 A key is a section, under the same grammar

**One reference grammar. Five rules that read it.** `/` separates segments for
every rule alike — code, JSON, YAML, TOML, INI and CSS — and a rule decides what
a segment *names*: a declaration path for code, a key path for the data formats,
a rule's rightmost simple selector or an at-rule keyword for CSS. There is no
second grammar for config files, and the separator question is therefore closed
rather than merely decided per format. The formats' own spellings still appear in
the *output*, because they are the format's: a TOML table is rendered as `[a.b]`
with its dots, a YAML key path is re-indented. A key that itself contains a dot is
reached as `#a/b.c`; where the format allows a quoted key, `#a/"b.c"` says the
same thing explicitly.

What a missing selector reports also differs by rule, deliberately: code says
`no section named "render" in "Cart"`, the data rules name the key or the path
(`"server/nope": no key "nope"`). Every message belongs to one of the two
categories of [§3.6](#36-errors-in-two-categories), which is what lets a profile
route it without re-reading the format's vocabulary.

### 9.5 One resolver; strictness is a profile

**This is the decision the split exists to record.**

> There is one resolution function. It never approximates: it returns the exact
> range or an error. A host that wants an approximation builds it *on top* of the
> error, from the diagnosis the error carries — the mapper does not guess on its
> behalf, because it cannot know which host is asking.

Three consequences, each of which was a design question before the split:

1. **A tie is an error, not a tie-break** — in the resolver, for every consumer.
   When two blocks at one level both answer to the name a reference selected, the
   mapper fails with `"<name>" is declared <n> times; names must be unique` rather
   than returning the first in walk order. The injector cannot tolerate a silent
   choice (it would copy a lie into a document), and the editor must not be handed
   one either, because the choice it *would* make is its own policy and not the
   mapper's ([RFC 2 §4](code-jump.md#4-the-best-effort-ladder)).
2. **The best-effort belongs to the caller.** An editor that wants *some* answer
   catches the failure and applies its ladder. What it cannot do is make the
   mapper guess, because the mapper has no way to know which host is asking.
3. **"Error" is a profile word.** The same failed resolve is an error in a gate
   and a warning in an editor, without resolution being redefined — because the
   resolver's answer is identical in both cases and only the policy differs.

Qualifying the name with its holder (`Cart/add`) is the fix, and it is what a
path is for. The key formats answer the same way, with a message that names the
format's own thing: `"server": key "server" appears 2 times; names must be
unique`.

### 9.6 The RFC is split into a core and two use-case specs

**One document held two things, and they diverge.** The single text fixed the
resolver (shared, strict, frozen) *and* the two products' failure policy (unshared
and deliberately different). The split names the three layers and their order of
authority ([§1.2](#12-what-is-normative-where)):

| Document                                          | Owns                                                                                     | Does not own                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| **RFC 1** (this document)                         | the operations, the two error categories, the answer shape, the first line, the non-goals, the conformance obligations, the band vocabulary | any product's failure policy |
| **[RFC 2 — code jump](code-jump.md)**             | the jump profile: what a cursor gets, the fallback ladder, IDE-versus-gate escalation    | resolution, or any byte a resolution returns |
| **[RFC 3 — inject examples](inject-examples.md)** | the injection profile: the document layer, markers, fences, the strict gate, `--lenient` | resolution, or the jump ladder               |

The rule that keeps them from drifting apart: **a document may never make the
resolver answer differently.** Divergence is permitted only in the band table,
and a band a product disagrees with is a stated policy with a row behind it, not
a private reading of the grammar.

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
[§3.9](#39-explicitly-out-of-scope) applies; this makes it explicit that
transclusion — pulling one document into another — is a different feature with a
different failure mode (which version of the other file?), and is not smuggled in
through the fragment.

---

## 10. Document status and versioning

- **Status: release candidate for 1.0 (`0.9-rc`).** The questions of the draft are
  settled in [§9](#9-decisions) and none of them changed resolution behaviour.
  What remains before 1.0 is *exercise*, not design: a port written from this
  document alone, and a release in which no question reopens. The two use-case
  specs are at `0.1-draft` — their policy is settled by the table in
  [§5.2](#52-the-band-table), and theirs is the work still to be exercised.
- **The reference implementation is authoritative** where this document and the
  behaviour disagree; the conformance corpora are generated from it. A
  disagreement is a bug in the document or in the port, never in the corpus.
- **The `doc/section-matching.md` specification is normative** for resolution.
- **This RFC is normative for *scope, boundary and conformance obligations***,
  and for the **band vocabulary** — the names and meanings of the three outcomes
  and the failure bands. A use-case spec is normative for which band its product
  escalates.
- **The RFC version is independent of the package version.** The npm package is
  `@hrg/inject-examples` and versions on its own semver; the version here is the
  *syntax* version, and the two must not be read as one number. Each use-case spec
  carries its own version, because a policy can move without the syntax moving.
- **What a version means.** Before 1.0: any change. At 1.0
  ([§9.1](#91-what-10-freezes)): the grammar, the error messages and the
  `Plan`/`Reference` field names stop changing incompatibly. New languages, lexer
  entries, conformance rows, `kind` members, fields and optional error fields are
  **minor**; a removal, a rename, a changed message or a changed resolution is
  **major**. A band-table change is a **minor** change to a use-case spec, and a
  **major** one only to the product that made it.
- **Change log.**
  - `0.9-rc` (this revision) — **a region includes its directives, and a
    one-line block is a block.** A region selection is now the opening
    `#region` through the closing `#endregion`, like a declaration with its
    signature; `/-` selects the body, and `extractRegion` returns the same whole
    span. The brace-block default already ran from its opening line through its
    closer, so region, brace block and declaration now read alike. A bare block
    whose opener and closer share one line (`{/*name*/ … }`) is recognized too.
    The region rows and the one-line anchor row pin the change; the §6.1 counts
    are refreshed.
  - `0.9-rc` (this revision) — **a braceless statement does not own a later
    block.** The statement scanner used to take the next `{` anywhere below an
    `if (x) return;` as that statement's body, so a bare `{//name` block a few
    lines later resolved as the whole `if` prefix plus the block. It now stops
    at the first top-level `;` or `{` after the statement keyword: a `;` means
    the body is one statement, a `{` is the body, and a later block is its own.
    Two corpus rows on `test/fixtures/Shorthand.java` pin the reported shape; no
    existing row moves, and the §6.1 counts are refreshed.
  - `0.9-rc` (this revision) — **a hyphen is a name character in an anchor.** Now
    that `-`, `+` and `++` are whole `/`-segments, a `-` can never be a modifier
    suffix, so a comment anchor's name may contain one: `{//item-list`,
    `//item-list`, `def f():  #item-list`. The anchor reader accepted only
    `[A-Za-z_$][\w$]*` before, even though the grammar already read `item-list`
    as a name; the two now agree. The corpus gains two rows and no existing row
    moves; the §6.1 counts are refreshed.
  - `0.9-rc` (this revision) — **a block may be named without a region
    directive.** The block's braces already mark where it starts and ends, so a
    comment at the opening brace (`{//name`, `{// name`) or on the first line
    inside it names the block with no `#region` prefix and no `#endregion`. It is
    answered by the existing **comment anchor** (matcher 6), not by the region
    directive: the default selection starts at the opening line — so a
    `while`/`if`/declaration prefix comes with it — and `/-` selects the body.
    Whether a caller calls it a region or a named block, the answer is the same.
    This is a spelling and documentation clarification of an existing behaviour,
    not a resolution change; the corpus gains ten rows on
    `test/fixtures/Shorthand.java` covering the adjacent, spaced and next-line
    spellings, a bare block, and their `/-` bodies. The §6.1 counts are refreshed
    to the corpus as it stands.
  - `0.9-rc` (this revision) — **the RFC is split into a core and two use-case
    specs** ([§9.6](#96-the-rfc-is-split-into-a-core-and-two-use-case-specs)).
    This document keeps the contract, the resolution core, the non-goals and the
    conformance obligations; the navigation product moves to
    [`code-jump.md`](code-jump.md) (RFC 2) and the injection product to
    [`inject-examples.md`](inject-examples.md) (RFC 3). Two things are *new*
    rather than moved: **the first line is defined once** for both products
    ([§3.5](#35-the-first-line) — the first range's `from`, not the lowest line
    number in the selection), and **the band table**
    ([§5.2](#52-the-band-table)) states which failure is a warning and which is
    an error per product, so a jump in an editor may be best-effort while the
    same failure fails a gate, and an injection always fails it. The structured
    **diagnosis surface is implemented** ([§5.3](#53-the-diagnosis-surface-structured-failure)):
    every failure carries a stable `code` (the `ERROR_CODES` registry) plus the
    selector, the scope it was searched in and the candidates a name answered to;
    `diagnose()` is the non-throwing entry point that returns the same `Plan` or
    the structured failure; and `deepestResolvablePrefix()` is the ladder's probe.
    What is **not** yet done is the corpus half: no band row was added, so a port
    that omits `diagnose` and the codes still passes every row, and the codes are
    asserted in `test.mjs` instead. No resolution behaviour changes and no corpus
    row moves.
  - `0.9-rc` (previous revision) — **an envelope holds a member in its
    declaration.** A new *additive* grammar feature for use case B: `Cart/^,toString,$`
    injects `Cart`'s declaration line, the `toString` method, and `Cart`'s closing
    line, so a method copied out of a class reads as code rather than as a
    fragment. `^` (the head: the declaration line through the line the body opens
    on) and `$` (the tail: the line the block ends on) are whole path segments at
    the ends of the reference, the parent is named on either end, and everything
    between them is read inside it. Nothing existing resolves differently — an
    envelope needs a whole segment that used to be a name, and no corpus reference
    or fixture named `^` or `$` — and the range is useful to inject and not to
    open, so a host that only navigates ignores the extra pieces. The `Selector`
    gains an optional `envelope` field
    ([§3.4](#34-plan-the-whole-contract)); the corpus gains 29 rows carrying a
    mark (9 grammar, 4 resolution rows for a type whose members live in several
    `impl` blocks, and 16 error paths).
  - `0.9-rc` (continued) — **a comment is any spelling, and a block need not
    brace.** Three matchers were reachable only through C-style spellings, and are
    now reachable through the language's own: a region directive accepts a `#`
    prefix (`# #region add` in Python, Ruby, Shell, YAML and INI, where `#` is the
    comment and was previously left on the text, so the directive never parsed); a
    comment anchor accepts a trailing comment on an **indented** block's header
    line (`def legacy(self):  #count`) or a comment that is the first thing in its
    body, where matcher 6 previously required braces and so never fired; and a
    condition literal (matcher 5) is found in a statement closed by **indentation**
    rather than a brace (`if (name == "count"):`, `If name = "count" Then`),
    because only a statement block carries its header's literals. Both readers
    (`index.mjs` and `lib/section.mjs`) change together. Existing resolutions are
    unchanged — the corpus gains rows for the new spellings and moves none.
  - `0.9-rc` (continued) — **an ambiguous name is an error.** When two blocks
    at one level both answer to the name a reference selected, the mapper fails
    (`"add" is declared 2 times; names must be unique`) instead of returning the
    first in walk order, which it did until now: the document use case cannot
    tolerate a silent choice, and a host that wants one has its own ranking
    ([§9.5](#95-one-resolver-strictness-is-a-profile)). The key formats follow the
    same rule for a duplicated key, table or section.
  - `0.9-rc` (continued) — **the modifier is a path segment.** The grammar now
    reads `selector := path | line-range` and `path := segment ('/' segment)*`,
    where a segment is a name or one of `++`, `+`, `-`, and a modifier is legal
    **only as the last segment**: `toString/++`, `Cart/Line/render/-`,
    `getUsers/+`. There is no trailing or leading modifier any more, so
    `toString++` is an error whose message names the new spelling, and a `-`
    inside a name is a name (`item-list`, a CSS custom property's `--brand`).
    This is breaking for every document that used a suffix or prefix. The
    **contradiction warning is removed** with it, because two modifiers can no
    longer land on one selector: `a/++/-` is malformed rather than two readings
    to choose between. The `Reference` shape loses its `warning` field, and the
    corpus rows lose it too.
  - `0.9-rc` (continued) — the eight open questions settled, and two errors
    corrected: the answer shape in §3.4 named a `selections` field that does not
    exist (the per-selection detail is `reference.selectors[]`, and `warning`
    lived on the reference, not the plan), and the config rules' separator was
    documented as `.` in several places. **The separator is `/` for every rule
    alike**, which is a breaking change to any document that spelled a config
    reference with dots; there is no compatibility path, because this is the
    syntax's first release.
  - `0.9-rc` (continued) — three clarifications after review:
    - **Language servers are a consumer, not out of scope** — now
      [RFC 2 §6](code-jump.md#6-the-language-server-and-ide-integration). The
      removed item was a category error, and [§3.9](#39-explicitly-out-of-scope)
      now excludes *semantic code intelligence* — what the mapper must not do —
      rather than the hosts that use it.
    - **"Not a parser" means not an AST parser** ([§3.7](#37-the-mapper-is-not-a-parser)),
      with [§3.8](#38-engines-the-standalone-scan-or-the-hosts-own-ast) fixing the
      rules for the AST-based implementations that will follow: they become the
      source of truth for their language, and the standalone engine must stay
      correct and leaner or faster, or it has no reason to exist.
    - **Refactoring that updates references is a forward goal**
      ([§4](#4-forward-goal-refactoring-that-updates-references)), with
      OpenRewrite integration named as the direction. Read-only is a boundary of
      this version, not of the project.
    - **In an IDE or LSP host, the host's AST is the preferred engine** when it
      has one for the language — the parse is already paid for, the host knows
      its own language better than a heuristic, and it ships no new dependency.
      The standalone engine keeps the grammar, covers what the host cannot, and
      serves the hosts that have no AST at all
      ([§3.8](#38-engines-the-standalone-scan-or-the-hosts-own-ast),
      [RFC 2 §6](code-jump.md#6-the-language-server-and-ide-integration)).
    - Row counts in [§6.1](#61-the-three-corpora) corrected to the corpus as it
      stands.
  - `0.1-draft` — first draft, extracted from the implementation and the
    resolution spec after the wrapped-header, expression-body and enum work.
    Section 3 (the boundary) and section 7 (test layering) are the new material;
    5, 6 and 7 restate what the implementation already does, and 6.3 records how
    a new port is expected to consume the suite.

---

## 11. References

- [`doc/section-matching.md`](../section-matching.md) — the resolution rules.
- [RFC 2 — code jump](code-jump.md) — the navigation use case: first line, best
  effort, IDE-versus-gate escalation.
- [RFC 3 — inject examples](inject-examples.md) — the injection use case: the
  document layer, the strict gate, `--lenient`.
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
