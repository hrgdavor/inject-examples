# 00 — Contract: file-section matching (frozen)

**Binding on every step.** This is the specification of `<section-reference>` in
`#region:<section-reference>`, and it is **frozen**. Do not change it, extend it, or
"improve" it in a step. If a step discovers that the contract is wrong or impossible, stop
and report back with the specific case; the contract changes only by a maintainer decision.

If you are implementing a step, read [README.md](README.md) for the routing, this document
for the requirements, and your own step document for the deliverables.

---

## 1. Mission

Today `#region:<name>` resolves one of: an explicit `#region`/`#endregion` directive, or a
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
- **Section reference** — the text after `#region:` in a marker's fragment.
- **Section** — the text a reference resolves to inside the target.
- **Block** — a braced (or indented) span in the target: a class-like body, a method body, a
  statement body (`if`/`for`/`while`/`switch`/`try`/`catch`/`synchronized`), or a block
  introduced only by an anchor comment.
- **Scope** — the block whose body a lookup searches. The file itself is **scope 0**.

## 3. House rules (non-negotiable)

1. **`index.mjs` + `cli.mjs` are the source of truth.** Nothing is "fixed" anywhere else.
2. **All porting is frozen.** No step touches `src/**`, `build.zig`, `build.zig.zon`, or
   writes a Java/Zig/other-language implementation. The Zig differential harness
   (`tools/compare-zig.mjs`) is switched off in step 1 and stays off. Porting resumes in a
   **separate plan** after this plan set is complete and the syntax is settled.
3. **Zero dependencies, Node 18+, ESM.** `node:fs` / `node:path` may be used by `index.mjs`
   and `cli.mjs`; `lib/section.mjs` may **not** use them (see §10).
4. **No behaviour change beyond this contract.** Every existing test in `test.mjs` stays
   green. The only permitted edits to existing tests are the two message-regex assertions
   named in §9.
5. **This is a heuristic, not a parser.** The implementation counts brackets over text whose
   comments and string literals are blanked. It must not grow a real Java/TypeScript parser,
   a type checker, or a language registry with per-language grammars.

---

## 4. Marker form (unchanged)

```text
[label](path#region:<section-reference>)
```

`label` must still name the same path as `path`, `path` must not carry a URL scheme, and the
line must be nothing but the link. **`inject:` is a consumer project's own marker prefix** —
how *their* tooling recognises a line as an injection marker before rewriting it into the
form above. `region:` is a fixed fragment keyword, not a name to match: it is what tells the
tool "this fragment is a section reference".

This contract changes the grammar of `<section-reference>` only — **never** the marker
prefix, **never** the fragment keyword, never anything about fences, gitignore, the CLI or
the JSON rule.

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
3. **The modifier is trailing and applies to the final path part.** The **old leading
   spelling keeps working**: `-add`, `+add`, `++add` are canonicalised to `add-`, `add+`,
   `add++` (§7).
4. **A bare name is a path of one segment**, and keeps today's meaning: search the whole
   file, at any depth.
5. **First match wins**, walking depth-first and left to right. A trailing modifier never
   changes which match is found.
6. **`region:` is not a name.** The reference `add` matches a `#region add` directive, a
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
3. After normalisation, a `+` or `-` anywhere except the very end is an error (§9).

Accepted: `add`, `add-`, `-add`, `Cart/Line`, `Cart/Line-`, `Cart/-Line`, `toString++`,
`++toString`, `Cart/Line/render-`, `Cart/Line/-render`.
Rejected (errors): `Cart/-Line/render`, `Cart/Line/+render`, `a//b`, `a/`, `/a`, `a+++`.
Warned (see §10): `a/b++-`, `a-/b++`, `a+-`.

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
| empty reference | `"#region:" names nothing` (unchanged from today) |
| empty segment, leading/trailing `/`, `//` | `"#region:<raw>" has an empty path segment` |
| `+`/`-` not at the end, after normalisation | `"<char>" may only modify the last path segment of "#region:<raw>"` |
| the same modifier twice or thrice (`a+++`, `a---`) | `"#region:<raw>" carries more than one modifier` |
| a detached leading modifier and a trailing one (`-a-`) | `"#region:<raw>" carries more than one modifier` |
| more than 8 segments | `"#region:<raw>" is deeper than 8 sections` |
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
| Contradictory pair: `++` with `-`, either order (`a++-`, `a-++`, `a-/b++`) | **Warning** | Reported once as `inject-examples: warn: <doc>:<line>: "#region:<ref>": "+/-" contradicts "++"; using "#region:<ref-without-the-minus>"`. The **`++` reading wins**; the block is injected as if the `-` were absent; the run continues; the run **exits 1** |
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
