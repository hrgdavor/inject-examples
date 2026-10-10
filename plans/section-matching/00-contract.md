# 00 — Contract: file-section matching (frozen)

**Binding on every step.** This is the specification of `<section-reference>` in
a marker's `#<section-reference>`, and it is **frozen**. Do not change it, extend it, or
"improve" it in a step. If a step discovers that the contract is wrong or impossible, stop
and report back with the specific case; the contract changes only by a maintainer decision.

If you are implementing a step, read [README.md](README.md) for the routing, this document
for the requirements, and your own step document for the deliverables.

---

## 1. Mission

A `<reference>` resolves one of: an explicit `#region`/`#endregion` directive, or a
single named declaration, matched by a *flat* scan of every line (`index.mjs`,
`extractDeclaration`). This contract formalises what a reference may say, so that:

- nested blocks are addressable with `/` (an inner class, and a method inside it);
- a block can be named by a **code anchor** inside it — a string literal in a statement
  condition, or a leading comment;
- the whole grammar is specified well enough that another project (or another language)
  can implement it from this document alone.

## 2. Terms

- **Document** — the Markdown file holding markers.
- **Target** — the file a marker points at.
- **Section reference** — the text after `#` in a marker's fragment.
- **Section** — the text a reference resolves to inside the target.
- **Block** — a braced (or indented) span in the target: a class-like body, a method body, a
  statement body (`if`/`for`/`while`/`switch`/`try`/`catch`/`synchronized`), or a block
  introduced only by an anchor comment.
- **Scope** — the block whose body a lookup searches. The file itself is **scope 0**.

## 3. House rules (non-negotiable)

1. **`index.mjs` + `cli.mjs` are the source of truth.** Nothing is "fixed" anywhere else.
   **The source of truth has since grown:** the syntax these steps specify is now normative in
   [`doc/section-matching.md`](../../doc/section-matching.md), which supersedes §4, §5 and §9
   of this contract where the two disagree (the error catalogue and grammar moved on). Treat
   this document as the plan set's history and
   as the source of the *design* rules in §3 and §10, not as the current grammar.
2. **~~All porting is frozen.~~ Retired.** No step touched `src/**`, `build.zig`,
   `build.zig.zon`, or wrote a Java/Zig implementation; the Zig differential harness
   (`tools/compare-zig.mjs`) was switched off in step 1 and stayed off for the length of the
   plan set. **The maintainer lifted the freeze on 2026-10-10**: the syntax is settled and the
   port is active again, with the harness back on and held at parity by gates. The plan that
   owns it is [`plans/zig-port.md`](../zig-port.md); it replaces this rule, and goal 1 of that
   plan ("the JavaScript implementation stays the source of truth") is what this rule was
   protecting.
3. **Zero dependencies, Node 18+, ESM.** `node:fs` / `node:path` may be used by `index.mjs`
   and `cli.mjs`; `lib/section.mjs` may **not** use them (see §10).
4. **No behaviour change beyond this contract.** Every existing test in `test.mjs` stays
   green. The only permitted edits to existing tests are the two message-regex assertions
   named in §9.
5. **This is a heuristic, not a parser.** The implementation counts brackets over text whose
   comments and string literals are blanked. It must not grow a real Java/TypeScript parser,
   a type checker, or a language registry with per-language grammars.

---

## 4. Marker form (superseded — see the note below)

```text
[label](path#<section-reference>)
```

> **Superseded on 2026-10-09.** A marker carries
> `#<section-reference>` directly, and anything after the `#` is the reference. The normative
> statement is in [`doc/section-matching.md`](../../doc/section-matching.md). The rest of this
> section is kept because the reasoning still holds — the fragment names a section, it is not a
> name to match.

`label` must still name the same path as `path`, `path` must not carry a URL scheme, and the
line must be nothing but the link. **`inject:` is a consumer project's own marker prefix** —
how *their* tooling recognises a line as an injection marker before rewriting it into the
form above. The fragment is the section reference, verbatim: it is not a name to match, and
there is no keyword in front of it.

This contract changes the grammar of `<section-reference>` only — **never** the marker
prefix, never anything about fences, gitignore, the CLI or the JSON rule. (The fragment
keyword it once fixed in place is gone; see the note above.)

## 5. Grammar

```text
section-reference := path [ modifier ]
modifier          := '++' | '+' | '-'          ; longest match first; those three only
path              := segment ( '/' segment )*  ; at most 8 segments
segment           := token
token             := /[A-Za-z_$][\w$]*/ | 'new'
```

A `token` contains no `/`, `+`, `-` or whitespace. Names may be dotted (`Foo.Bar` is one
token, because dotted names occur in JS/TS code); dots are never path separators.

Rules, each an error when violated:

1. **`/` is not a package path.** It never means a Java package or an FQDN. It only descends
   into nested blocks *inside the one target file*.
2. **Only the last segment selects content to inject.** Earlier segments are scopes: each
   must resolve, and each later segment is looked up inside the block the previous segment
   found.
3. **The modifier applies to the final path part, and the canonical spelling is trailing.**
   Two leading spellings are normalised to it (§7): a prefix of the **whole reference**
   (`+add`, `++add`, `-add` → `add+`, `add++`, `add-`) and a single `-` leading the last
   segment, or the second of two (`Cart/Line/-render`, `Cart/-Line`). The forms are **not
   symmetric**: a `+` or `++` leading a *segment* is an error even when that segment is last
   (`a/+b`), while a trailing run written on a non-last segment is collected and applied to
   the last one (`a++/b` → `a/b++`).
4. **A bare name is a path of one segment**, and keeps today's meaning: search the whole
   file, at any depth.
5. **First match wins**, walking depth-first and left to right. A trailing modifier never
   changes which match is found.
6. **A reference is a name, not a directive prefix.** The reference `add` matches a `#region add` directive, a
   `void add()` method, a `String add` property, a `class add`, a `//add` anchor, or an
   `if ("add".equals(...))` block — whichever the walk finds first.

## 6. Matcher precedence (what a segment may match, at one scope)

| # | Matcher | What it finds | Region text | Notes |
| --- | --- | --- | --- | --- |
| 1 | **Region directive** | `#region <name>` … `#endregion` whose enclosing block is this scope (file scope for top-level) | lines strictly between the directives | chosen before 2–6 |
| 2 | **Class-like declaration** | `class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union` named `<name>` in this scope | declaration, or the modified part (§8) | beats a same-named constructor, as today |
| 3 | **Method / function** | named method, constructor, function or arrow-valued property in this scope **with a body** | declaration, or the modified part | body-less members (interface methods, `abstract`) have nothing to inject and are skipped |
| 4 | **Property** | a field/constant declaration named `<name>` (`private int getUsers = 0;`, `static final String X = …`) | the declaration (its whole statement) | `-` gives the initialiser expression when there is one |
| 5 | **Condition literal** | a statement block in this scope whose header line carries `"<name>"` (double-quoted, exact bytes) | the block's braces, header to close | the `if ("getUsers".equals(methodName))` case |
| 6 | **Comment anchor** | a braced block in this scope whose first non-blank line is `//<name>` or `/*<name>*/` | the block's braces, header to close, **anchor comment included** | a `#region`/`#endregion` line is never an anchor; a comment that is not the first thing in the block is not an anchor either |

**How the walk uses the table.** Within one scope the matchers are tried in that order, and
the first that matches ends the lookup *for that scope*. In a single-segment reference that
also ends the whole search. When a scope yields no match, the walker descends into every
block that scope contains, left to right, depth first, and retries the same segment — so
`render` finds `Line.render` even though it is nested. For a multi-segment reference the
same thing happens one step at a time: once `Cart` matches, later segments are searched
**only inside `Cart`**, with the same precedence and the same depth descent.

## 7. Canonicalisation and compatibility

Today's parser reads `-`, `+`, `++` only as a prefix of the whole reference. The canonical
form is **trailing**, so the parser normalises before parsing:

1. If the reference starts with `++`, `+` or `-`, detach it and append it to the end.
2. If the **second** segment starts with exactly one `-` and nothing was detached in step 1,
   detach that `-` and append it (`Cart/-Line` → `Cart/Line-`).
3. After normalisation, a `+` or `++` leading a path segment is an error, and so is a `-`
   leading a segment that is neither the last nor the second of two. A trailing run on a
   non-last segment is **collected**, not rejected, and is applied to the last segment
   (`a++/b` → `a/b++`, `a-/b` → `a/b-`) (§9).

Accepted: `add`, `add-`, `-add`, `+add`, `++add`, `Cart/Line`, `Cart/Line-`, `Cart/-Line`,
`toString++`, `++toString`, `Cart/Line/render-`, `Cart/Line/-render`, `+a/b`, `a/-b`, `a++/b`.
Rejected (errors): `Cart/-Line/render`, `Cart/Line/+render`, `a/+b`, `a/++b`, `x/y+z`, `a//b`,
`a/`, `/a`, `a+++`.
Warned (see §10): `a/b++-`, `a-/b++`, `a+-`.

> **Corrected 2026-10-10.** Rule 3 above and step 3 here previously read *"the modifier is
> trailing… a `+` or `-` anywhere except the very end is an error"*, which described neither
> `lib/section.mjs` nor the vectors: a leading `+`/`++` is rejected on a *segment* even when
> that segment is last (`a/+b` is an error), while a trailing run on a non-last segment is
> collected rather than rejected (`a++/b` is `a/b++`). `doc/section-matching.md` carries the
> same correction, and it is the normative document for implementers. The earlier wording is
> kept here, in the note, rather than in the rules — so a port written against the old text
> has a record of what changed and why.

## 8. Modifiers (§8.1 applies to the final section only)

| Reference | Injection |
| --- | --- |
| `Cart/Line` | the whole inner class declaration |
| `Cart/Line-` | `Line`'s body only (no `public static class Line {` line, no closing brace) |
| `Cart/toString+` | `toString`'s declaration including the annotations above it |
| `Cart/toString++` | declaration, annotations and the doc comment above them |
| `getUsers-` | the body inside the `if`'s braces |
| `getUsers+` / `getUsers++` | the `if` header line, plus a leading doc/annotation block for `++` |
| `count-` (property) | the initialiser expression, or the declaration when there is none |

Modifier semantics per match kind:

- **Declaration (class / method / property)** — exactly today's semantics
  (`declaration` / `body` / `annotated` / `documented`, `index.mjs:445`), with `-` also
  reaching a property's initialiser. Byte-for-byte unchanged for the forms that exist today.
- **Region directive** — a region is already exactly its body, so the modifier is
  **ignored**: `add+` and `add` inject the same lines.
- **Condition literal, comment anchor** — the block is the unit. No modifier (or `+`) = the
  block from its first line through its closing brace, where that first line is:
  - comment anchor: the **anchor comment line**;
  - condition literal: the **statement header line** (`if (…) {`).
  `-` = the body strictly inside the braces. `++` on a comment anchor behaves like `+`
  (there is no declaration to document).

## 9. Error catalogue (message text is part of the contract)

Messages quote **the reference as the user wrote it** (call it `<raw>`, `/`-separated, before
normalisation) so the message points at the document, not at the parser's internal form.
`Cart/-Line` therefore appears as written even though it normalises to `Cart/Line-`.

| Condition | Message shape |
| --- | --- |
| empty reference | `"#" names nothing` |
| empty segment, leading/trailing `/`, `//` | `"#<raw>" has an empty path segment` |
| a `+` or `++` leading a path segment (any segment, the last included), or a `-` leading a segment that is neither the last nor the second of two | `"<char>" may only modify the last path segment of "#<raw>"` |
| the same modifier twice or thrice (`a+++`, `a---`) | `"#<raw>" carries more than one modifier` |
| a detached leading modifier and a trailing one (`-a-`) | `"#<raw>" carries more than one modifier` |
| more than 8 segments | `"#<raw>" is deeper than 8 sections` |
| segment matches nothing anywhere | `no "#region <name>" found, and no section named "<name>"` |
| class/block matched but more path remains | `"<name>" is not a container` |
| a mid-path scope does not exist | `no section named "<name>" in "<previous>"` |

Errors are thrown as `SectionReferenceError` (`lib/section.mjs`), an `Error` subclass, so a
caller can distinguish a malformed reference from a resolution failure without matching on
message text. Resolution failures thrown by the walker are plain `Error`s carrying the same
messages, exactly as today.

**Back-compatibility of one message.** Today's text is
`no "#region missing" found, and no method or inner class named "missing"`, asserted at
`test.mjs:249` and `test.mjs:858`. The new text must still match
`/no "#region missing" found/`, or those two assertions are updated **deliberately, in the
same commit, with the reason in the commit message**. Do not silently rewrite them.

Contradictory modifier pairs are **not** in this table: see §11.

## 10. The vendorable module boundary

`lib/section.mjs` is a single dependency-free ES module exporting the matching algorithm
only. It **must not** import or reference `node:fs`, `node:path`, `process`, `cli.mjs`, or
anything that reads the disk or the environment: a consumer project vendors this one file.
`index.mjs` keeps owning markers, fences, rule dispatch, gitignore and document rewriting,
and delegates only section resolution. A test asserts the boundary (§12, test 25) so it
cannot rot.

## 11. Contradictory modifiers are a warning, not an error

`++` and `-` contradict each other: `++` asks for the declaration **with** its annotations
and doc comment, `-` asks for the **body alone**. No single section can be both, so the
reference is meaningless — but it must not hold a whole document hostage, and it is exactly
what a human types while refactoring.

| Case | Kind | Behaviour |
| --- | --- | --- |
| Contradictory pair: `++` with `-`, either order (`a++-`, `a-++`, `a-/b++`) | **Warning** | Reported once as `inject-examples: warn: <doc>:<line>: "#<ref>": "+/-" contradicts "++"; using "#<ref-without-the-minus>"`. The **`++` reading wins**; the block is injected as if the `-` were absent; the run continues; the run **exits 1** |
| `+` with `-` (`a+-`, `a-+`) | **Warning** | Same shape: contradictory, `+` wins |
| One modifier named twice (`a+++`, `a---`) | **Error** | Malformed, not contradictory — §9 |
| A modifier anywhere but the end | **Error** | §7 rule 3, §9 |

Three consequences that must not be missed:

- **Warnings are not gated on `--lenient`.** `--lenient` tolerates *broken includes*; a
  contradictory modifier is not broken, it is merely contradictory. It warns in every mode.
- **Exit code is 1 whenever a warning was emitted**, even though every block was written,
  and the summary counts it (`1 warning`). A deliberate exception to "0 = every block up to
  date": the run did succeed at injecting, but the document still says something nonsense.
- **It is idempotent.** The second pass warns again with no change to the text — the warning
  is about the document, not about the state of the block.

## 12. Worked examples (the acceptance bytes)

Given `test/fixtures/Example.java` (`Cart`, `toString`, inner `Line` with `render`):

| Reference | Result |
| --- | --- |
| `toString` | today's output, unchanged |
| `toString-`, `-toString` | today's output, unchanged |
| `toString+`, `+toString` | today's output, unchanged |
| `toString++`, `++toString` | today's output, unchanged |
| `Line` | today's output, unchanged |
| `Cart/Line` | identical to `Line` |
| `Cart/toString` | identical to `toString` |
| `Cart/Line/render` | `        String render() {\n            return name + " x" + quantity;\n        }` |
| `Cart/Line/render-`, `Cart/Line/-render` | `            return name + " x" + quantity;` |
| `Cart/Line-` | `Line`'s body, without the class line or the closing brace |
| `Line/toString` | error: no `toString` in `Line` |
| `Cart/Line/render/extra` | error: `render` is not a container |
| `Cart/Cart` | error: `Cart` is not a container (a class is a scope, not a section) |

Given `test/fixtures/Anchors.java` (contains `if ("getUsers".equals(methodName)) { … }` and a
method whose body opens `{ //getUsers`):

| Reference | Result |
| --- | --- |
| `getUsers` | the `if` block, header through closing brace |
| `getUsers-` | the `if` block's body only |
| `dispatch/getUsers` | the same match, reached explicitly through the method's scope |
| `getUsers` (anchor case) | `        //getUsers` + the block body, through its closing brace |
| `getUsers-` (anchor case) | the block body only, anchor comment excluded |
| `getusers` | error: literal matching is case-sensitive, exact bytes |

## 13. What the completed plan set must satisfy

The end state (step 9) is:

- `lib/section.mjs` implements this contract, dependency-free, with the §10 boundary
  asserted by a test.
- `index.mjs` delegates to it; `extractCodeRegion`, `extractDeclaration` and `extractRegion`
  keep their exported signatures and existing behaviour.
- `doc/section-matching.md` is the normative written spec, complete enough to implement from.
- Every superseded hard-coded count in the repo has been replaced by a structural
  assertion, so the suite cannot be "fixed" by editing a number. The known ones:
  - `test.mjs:552` — `assert.equal(first.markers.length, 2)` inside the
    `// #region update-document-test` region. **This one is injected into
    `doc/usage.md`**, so changing it changes that document's injected block too. It stays
    factually correct (two markers), so prefer leaving it; if you do change it, you must
    re-run the injector over `doc/usage.md` in the same commit.
  - `test.mjs:1290` — `assert.equal(result.markers.length, 15, …)` over the repository's
    own documents, immediately inside the test `the documentation stays in sync with the
    files it shows` (which also asserts every result is non-skipped and carries no
    `failure`). This **will** break when step 9 adds markers to the docs, and has already
    rotted once. Replace it with a structural assertion (for example: every result carries a
    `marker`, no result is `skipped`, and every marker's `path` resolves to a file) rather
    than bumping the number.
  - `test.mjs:689` — `assert.equal(rules.length, 4)`, unrelated to this plan; leave it.
- All porting is still frozen, and the freeze is recorded in the README.

---

## Amendment (maintainer decision, 2026-10-08): the walk is sibling-first

§5 rule 5 and the §6 walk order are superseded. A segment is searched
**breadth first**: every scope at one depth is tried with the full matcher
table, left to right, before the walk descends into any of their blocks.
Matcher 5 (condition literal) consequently considers only this scope's own
statement blocks — it never sweeps deeper ones.

The reason: a declaration must stay targetable when a same-named block sits
inside an earlier sibling. `doSomeAction` now resolves to the method, not to an
`if ("doSomeAction"…)` inside a method that comes sooner in the file.

Consequences for §12, regenerated into `test/vectors/section-vectors.json`: on
`Anchors.java` the bare references `getUsers` and `getOrders` resolve to the
`handler` / `other` anchor blocks (the shallower siblings) instead of the
condition literals inside `dispatch`; `dispatch/getUsers` and
`dispatch/getOrders` still reach those. `doc/section-matching.md` carries the
normative wording.

---

## Amendment (maintainer decision, 2026-10-08): a per-type lexer seam, with the built-in engine as default

§6 and §10 are extended (not superseded). The matcher table, the sibling-first
walk, the modifier-on-last rule and rendering stay wholly in `lib/section.mjs`.
The only language-specific work is **lexical**, and it is now an injectable
**lexer**: `scanBlocks`/`planSection`/`resolveSection` take an optional
`lexer = { name, mask(text), comments(text) }` (with `conditionLiterals`
inherited unless overridden). A lexer owns nothing but the mask and the comment
spans; it MUST preserve the mask invariant — same length, every `\n` at the same
offset — which `lib/section.mjs` asserts once per scan and names on failure.

**The default engine is `lib/section.mjs`'s built-in mask** (`masked`/
`commentsIn`, the language-agnostic union) and applies whenever no lexer is
supplied — i.e. when the file's type is unknown. `index.mjs` selects a lexer by
extension (`src/js/scanner/lexers.js` → `lexerFor`); the three sample scanners
are rebuilt on a shared one-pass `tokenizer.js` and each exports `lexerX` (the
seam), `scanX(source, target)` (the original sample shape, unchanged) and
`visitX(source, visitor)` (the same pass, for enumeration/tests). Because a lexer
changes only what is blanked, a known type and the default engine resolve the
same reference to the same bytes — pinned by the parity tests and by the
regenerated vectors (the existing cases are byte-identical).

House rule 2 ("all porting is frozen, no step touches `src/**`") is lifted **for
`src/js/scanner/` only**, and only for this wiring: the JavaScript sample
tokenizers become the per-type lexers. The Zig port (`src/root.zig`, `build.zig`,
`build.zig.zon`) and every non-JavaScript implementation remain frozen and are
untouched. §10's vendorable boundary is unchanged and now has an explicit test:
`lib/section.mjs` imports nothing; lexers are injected from `index.mjs`.

Consequence for §12: two Zig vectors are added on a new
`test/fixtures/Nesting.zig` — `z-target-method` (found) and
`z-decoy-hidden-by-nested-comment` (error) — the latter showing the Zig lexer
hide a declaration the non-nesting default mask would leak. `doc/section-matching.md`
carries the normative wording (the "Tokenizers" section).

---

## Amendment (maintainer decision, 2026-10-09): the language table, and two more lexer fields

§6 and §10 are extended again, in the same spirit as the lexer seam above: more
languages must not mean a parser, and must not move any structure out of
`lib/section.mjs`.

**The language table.** A language is data in `src/js/scanner/syntaxes.js`:
comment spellings (`lineComments`, `blockComments` with `nested`/`lineStart`),
string forms (`open`/`close`, `escape: 'backslash' | 'doubling' | null`,
`multiline`, `lineScoped`, `boundary`, `hashes` for Rust's `r#"…"#`, and
`maxSpan`/`content` for the one form that is not a string at all — a Rust `'a`
lifetime beside a `'a'` char literal), and `heredoc` (`true`, or `'strict'` so
Ruby's `array << x` is never one). `tokenizer.js` walks the table; nothing in it
knows a language name, and `lib/section.mjs` is untouched by any of it.

**Shapes a language adds.** Two optional lexer fields, both of which default to
the language-neutral reading when absent:

- `declarations(maskedLine)` returns `{ kind, name, headerFrom, line?, body?,
  end? }` entries — the declaration *shapes* the generic `name(`/class-keyword
  heuristics cannot see (Ruby's paren-less `def name`, Haskell's `name … = …`
  binding and `data`/`class` declarations). The matcher table, precedence, the
  sibling-first walk and rendering are unchanged: a shape only adds a block to
  index. `body: 'end'` marks a body closed by a terminator keyword line, found
  by indentation (`keywordBody`); `line: true` marks a declaration whose line is
  itself the selection when no body follows.
- `annotationLine(line)` replaces the `@Decorator` / `#[attribute]` test the `+`
  scope uses, so a Haskell binding's `name ::` signature is what `+` brings
  along.

Both are consumed through the existing seam — `makeLex` copies them from the
injected lexer — so §10's boundary holds: `lib/section.mjs` still imports
nothing, and an unknown type still gets the default engine and the generic
shapes, which is pinned by the tests in `test.mjs`.

**Measured effect on the vectors:** none. `node tools/section-vectors.mjs
--check` is unchanged, because every existing case is Java, TypeScript, Zig or
JSON — none of which gained a declaration shape.

---

## Amendment (maintainer decision, 2026-10-09): a path retries a duplicated scope

§6's walk is extended by one rule, at the maintainer's direction: when a **scope**
segment (any segment but the last) names several blocks at the same level, the
path tries them in walk order and takes the first that can hold the rest of the
path. Previously the first hit was taken and a failure was final, which made a
Rust type's members unreachable — `struct Cart` is declared before `impl Cart`,
they are siblings with the same name, and `Cart/add` resolved `Cart` to the
struct and stopped.

What does **not** change, and is why this is an extension rather than a
relaxation:

- the **last** segment is not retried: its first match in walk order is still the
  selection;
- matcher precedence is untouched — a name still belongs to the first matcher
  that has it, and only that matcher's hits are candidates (a `class Cart` never
  gives way to a same-named method or property);
- the walk is still sibling-first and level-order, so candidates are only ever
  compared within the shallowest level that matched;
- the errors are the ones the first candidate produced (`no section named "x" in
  "y"`, `"y" is not a container`), so a single-candidate case reads exactly as
  before. The regenerated vectors are byte-identical for every pre-existing case;
  `test/fixtures/Cart.rs` adds five that pin the retry and the five new vectors
  (`rs-*`) are the conformance cases for a port.

The language side of the same decision is data: `syntaxes.js` declares `impl
Type { … }` (and `impl Trait for Type`) as a class-like scope named after the
type, plus a field shape (`name: Type,`) the generic property rule cannot see.
A substitute engine that wants those vectors must supply both.
