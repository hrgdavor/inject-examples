# Plan: formalise file-section matching in JavaScript (slash paths, code anchors)

**Audience:** the implementing agent. This document is the complete brief: the frozen
syntax, the exact JS work order, the test matrix, the porting freeze, and the acceptance
gate.

**Mission.** Turn today's ad-hoc `#region:<name>` matcher into a *specified* syntax —
"file section matching" — that (a) can drill into nested blocks with `/`, (b) can name a
block by a code anchor inside it (`"getUsers".equals(...)`, `{//getUsers`), and (c) ships
as a reusable, hosted **JavaScript** matcher other projects can vendor.

> ## Porting was stopped — and is now allowed again
> This plan is JavaScript only. The Zig port in `src/` was frozen where it stood,
> `tools/compare-zig.mjs` was turned **off** in step 1, and no Java/Zig/other-language
> implementation was written, started or designed here. Porting was to resume **in a separate
> plan, written after this one is implemented and the JavaScript syntax is settled** — see
> [§6 Porting freeze](#6-porting-freeze-in-force-for-this-whole-plan) and
> [§9 What "settled" means](#9-what-settled-means-the-trigger-that-ends-the-freeze).
>
> **That separate plan is [`plans/zig-port.md`](./zig-port.md), and the freeze is lifted
> (2026-10-10).** The syntax is settled; the harness is back on; the Zig port has been brought
> to parity and is held there by gates. Everything in §6 below is history and no longer
> binding, except where it says the JavaScript is the source of truth — that rule outlives the
> freeze, and it is goal 1 of the port plan. This document is superseded by
> [`plans/section-matching/README.md`](./section-matching/README.md); it is kept for history
> and is not updated further.

**Rule of the house, restated because it governs every decision here:** `index.mjs` +
`cli.mjs` are the source of truth. Nothing is "fixed" anywhere else; a port that disagrees
with JS is wrong by definition — which is exactly why no port runs against a moving target.

**Decisions already made by the maintainer** (do not re-litigate; they are folded in):

1. The `-` / `+` / `++` modifier goes at the **end** of the reference and applies to the
   **last path part**; the old leading spelling is accepted for compatibility.
2. A comment-anchored block's canonical body **includes the anchor comment line**.
3. `#region:` is the *fragment keyword*, not a name to be matched: a single-item reference
   is matched against every indexable thing (region directive, property, method, class,
   block with a simple comment, condition literal). With slashes, the **first** element is
   searched globally and each later element is searched **inside the scope the previous one
   found**. `#region`/`#endregion` lines are **not** anchor comments.
4. Porting (Zig today; Java and anything else later) is out of scope until the JS syntax is
   settled, and gets its own plan then.

**Status:** ⛔ not started. Nothing in this plan is implemented; the working tree is clean
at `bc03bfe`.

---

## 1. Where the syntax stands today (verified against the code, not assumed)

| Fact | Evidence |
| --- | --- |
| A marker's fragment is `#region:<reference>`; anything else is an ordinary link | `parseMarker`, `index.mjs:664` |
| `#region:<reference>` is dispatched by file extension; `code` is the fallback rule | `ruleFor` / `REGION_RULES`, `index.mjs:625` |
| A code reference means: explicit `#region <name>` directive, else one declaration by name | `extractCodeRegion`, `index.mjs:531` |
| `-`, `+`, `++` prefix selects body / +annotations / +doc comment; **one name only** | `codeReference`, `index.mjs:124` |
| Matching is line-shaped and *flat*: it scans every line, never descends into a body | `extractDeclaration`, `index.mjs:487` |
| A name declared twice is an error; a class name beats a same-named constructor | `index.mjs:507` |
| Comments and string literals are blanked before bracket counting, so `}` in a string is safe | `strippedCode`, `index.mjs:222` |
| **A method inside an inner class is unreachable except by luck** | `extractDeclaration` scans lines flatly, so `render` in `test/fixtures/Example.java` resolves to `Line.render()` only because no other `render` exists in the file |

Facts about the tree this plan has to work with:

- 75 tests in `test.mjs`, run by `node --test`; the default `npm test` script is
  `node --test test.mjs`.
- `index.mjs` is 1203 lines; `extractDeclaration` / `strippedCode` / `declarationOn` /
  `declarationRange` / `renderDeclaration` are the machinery to be replaced (lines ~130–560).
- `tools/compare-zig.mjs` runs the JS and Zig CLIs over a corpus and compares stdout,
  stderr, exit codes and rewritten files byte for byte. Its corpus already enumerates
  references such as `#region:++add` and `#region:a,b`.
- **Nothing wires the harness in today.** There is no `compare:zig` script in
  `package.json`, and `test.mjs` contains no reference to Zig at all — the harness is run by
  hand. So the freeze is mostly a *convention* this plan states and documents, plus one new
  guard (§6.2); it is not a test that has to be kept green.
- `.github/workflows/release.yml` cross-builds Zig binaries on a `v*` tag; no workflow runs
  the differential harness.
- `src/main.zig` and `src/root.zig` are the Zig port.

Two gaps the mission closes, from the brief:

1. A block guarded by a string-literal condition must be nameable:
   `if ("getUsers".equals(methodName)) { … }` — any statement block whose condition
   mentions the name as a string literal, not only `if`.
2. A block whose **first thing after the opening brace** is a simple comment anchor named
   for the section — `{//getUsers`, or `{` and `//getUsers` on the next line — must match
   that name.

---

## 2. The syntax, frozen (this is the part other projects implement)

### 2.1 Terms

- **Document** — the Markdown file holding markers.
- **Target** — the file a marker points at.
- **Section reference** — the text after `#region:` in a marker's fragment.
- **Section** — the text a reference resolves to inside the target.
- **Block** — a braced (or indented) span in the target: a class-like body, a method body,
  a statement body (`if`/`for`/`while`/`switch`/`try`/`catch`/`synchronized`), or a block
  introduced only by an anchor comment.
- **Scope** — the block whose body a lookup searches. The file itself is scope 0.

### 2.2 Marker form (unchanged) and the `inject:` relationship

```text
[label](path#region:<section-reference>)
```

`label` must still name the same path as `path`, `path` must not carry a URL scheme, and
the line must be nothing but the link. **`inject:` is the consumer projects' own marker
prefix** — the thing by which *their* tooling recognises a line as an injection marker
before rewriting it into the marker above. `region:` in the fragment is likewise a fixed
keyword here, not a name to match: it is what tells the tool "this fragment is a section
reference".

**This plan changes the grammar of `<section-reference>` only — never the marker prefix,
never the fragment keyword.** A project may keep a different prefix for its own markers and
still implement exactly this section grammar; that is the point of publishing the syntax and
the matcher code.

### 2.3 Section-reference grammar

```text
section-reference := path [ modifier ]
modifier          := '++' | '+' | '-'          ; longest match first; those three only
path              := segment ( '/' segment )*  ; at most 8 segments
segment           := token
token             := /[A-Za-z_$][\w$]*/ | 'new'
```

A `token` contains no `/`, no `+`, no `-` and no whitespace. Names may be dotted
(`Foo.Bar` is a single token) because dotted names occur in JS/TS code; dots are never path
separators.

Rules, each an error when violated:

1. **`/` is not a package path.** It never means a Java package or an FQDN. It only
   descends into nested blocks *inside the one target file*.
2. **Only the last segment selects content to inject.** Earlier segments are scopes: each
   must resolve, and each later segment is looked up inside the block the previous segment
   found.
3. **The modifier is trailing and applies to the final path part.** `Cart/Line/render-` =
   the body of `render`; `toString++` = declaration + annotations + doc comment;
   `Cart/Line+` = the inner class with its annotations. The **old leading spelling keeps
   working**: `-add`, `+add`, `++add` are canonicalised to `add-`, `add+`, `add++` (§2.7).
4. **A bare name is a path of one segment**, and keeps today's meaning: search the whole
   file, at any depth.
5. **First match wins**, walking depth-first and left to right. A trailing modifier never
   changes which match is found.
6. **`#region:` is not a name.** The reference `add` matches a `#region add` directive, a
   `void add()` method, a `String add` property, a `class add`, a `//add` anchor, or an
   `if ("add".equals(...))` block — whichever the walk finds first.

### 2.4 What a segment may match, at one scope, in precedence order

| # | Matcher | What it finds | Region text | Notes |
| --- | --- | --- | --- | --- |
| 1 | **Region directive** | `#region <name>` … `#endregion` whose enclosing block is this scope (file scope for top-level) | lines strictly between the directives | chosen before 2–6 |
| 2 | **Class-like declaration** | `class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union` named `<name>` in this scope | declaration, or the modified part (§2.5) | beats a same-named constructor, as today |
| 3 | **Method / function** | named method, constructor, function or arrow-valued property in this scope **with a body** | declaration, or the modified part | body-less members (interface methods, `abstract`) have nothing to inject and are skipped |
| 4 | **Property** | a field/constant declaration named `<name>` (`private int getUsers = 0;`, `static final String X = …`) | the declaration (its whole statement) | `-` gives the initialiser expression when there is one |
| 5 | **Condition literal** | a statement block in this scope whose header line carries `"<name>"` (double-quoted, exact bytes) | the block's braces, header to close | this is the `if ("getUsers".equals(methodName))` case |
| 6 | **Comment anchor** | a braced block in this scope whose first non-blank line is `//<name>` or `/*<name>*/` | the block's braces, header to close, **anchor comment included** | a `#region`/`#endregion` line is never an anchor, and a comment that is not the first thing in the block is not an anchor either |

Within one scope the matchers are tried in that order, and the first that matches ends the
lookup **for that scope**. In a single-segment reference that also ends the whole search.
When a scope yields no match, the walker descends into every block that scope contains, left
to right, depth first, and retries the same segment — so `render` finds `Line.render` even
though it is nested. For a multi-segment reference the same thing happens one step at a
time: once `Cart` matches, later segments are searched **only inside `Cart`**, with the same
precedence and the same depth descent.

### 2.5 The modifier applies to the final section only

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
  **ignored**: `add+` and `add` both inject the region's lines.
- **Condition literal, comment anchor** — the block is the unit. No modifier (or `+`) = the
  block from its first line through its closing brace, where that first line is:
  - comment anchor: the **anchor comment line** (maintainer decision 2);
  - condition literal: the **statement header line** (`if (…) {`).
  `-` = the body strictly inside the braces.
  `++` on a comment anchor behaves like `+` (there is no declaration to document).

### 2.6 The empty reference keeps its old error

`#region:` (empty reference) is today an error naming nothing: `"#region:" names nothing`.
Keep that message. An empty *segment* is a different, new error (§2.9).

### 2.7 Canonical form and compatibility (the old leading modifier)

Today's parser reads `-`, `+`, `++` only as a prefix of the whole reference. The canonical
form is now **trailing**, so `parseReference` normalises before parsing:

1. If the reference starts with `++`, `+` or `-`, detach it and append it to the end.
2. If the **second** segment starts with exactly one `-` and nothing was detached in step 1,
   detach that `-` and append it (`Cart/-Line` → `Cart/Line-`).
3. After normalisation, a `+` or `-` anywhere except the very end is an error (§2.9).

Accepted: `add`, `add-`, `-add`, `Cart/Line`, `Cart/Line-`, `Cart/-Line`, `toString++`,
`++toString`, `Cart/Line/render-`, `Cart/Line/-render`.
Rejected (errors): `Cart/-Line/render`, `Cart/Line/+render`, `a//b`, `a/`, `/a`, `a+++`.
Warned (see §2.10): `a/b++-`, `a-/b++`, `a+-`.

### 2.8 Worked examples (these become fixtures and tests verbatim)

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

Given `test/fixtures/Anchors.java`, a dispatch target that contains
`if ("getUsers".equals(methodName)) { … }` and a method whose body opens `{ //getUsers`:

| Reference | Result |
| --- | --- |
| `getUsers` | the `if` block, header through closing brace |
| `getUsers-` | the `if` block's body only |
| `dispatch/getUsers` | the same match, reached explicitly through the method's scope |
| `getUsers` (anchor case) | `        //getUsers` + the block body, through its closing brace |
| `getUsers-` (anchor case) | the block body only, anchor comment excluded |
| `getusers` | error: literal matching is case-sensitive, exact bytes |

### 2.9 Error catalogue (message text is part of the contract)

| Condition | Message shape |
| --- | --- |
| empty reference | `"#region:" names nothing` (unchanged) |
| empty segment, leading/trailing `/`, `//` | `"#region:<ref>" has an empty path segment` |
| `+`/`-` not at the end, after normalisation | `"<char>" may only modify the last path segment of "#region:<ref>"` |
| the same modifier twice or thrice (`a+++`, `a---`) | `"#region:<ref>" carries more than one modifier` |
| more than 8 segments | `"#region:<ref>" is deeper than 8 sections` |
| segment matches nothing anywhere | `no "#region <name>" found, and no section named "<name>"` |
| class/block matched but more path remains | `"<name>" is not a container` |
| a mid-path scope does not exist | `no section named "<name>" in "<previous>"` |

Contradictory modifier pairs are **not** in this table: they are warnings, not errors, and
they resolve. See §2.10 for the message shape and the exit-code rule.

### 2.10 Contradictory modifiers are a warning, not an error

`++` and `-` contradict each other: `++` asks for the declaration **with** its annotations
and doc comment, `-` asks for the **body alone**. No single section can be both, so the
reference is meaningless — but it is not the kind of mistake that should hold a whole
document hostage, and it is exactly the kind of thing a human types while refactoring. So:

| Case | Kind | Behaviour |
| --- | --- | --- |
| A contradictory modifier pair: `++` with `-` (either order, `a++-` / `a-++` / `a-/b++`) | **Warning** | Reported once as `inject-examples: warn: <doc>:<line>: "#region:<ref>": "+/-" contradicts "++"; using "#region:<ref-without-the-minus>"`. The **`++` reading wins**, the block is injected as if the `-` were absent, the rest of the run proceeds, and the run **exits 1** |
| `+` with `-` (`a+-`, `a-+`) | **Warning** | Same shape: contradictory, `+` wins |
| The *same* modifier twice or thrice (`a+++`, `a---`) | **Error** | Unambiguous syntax mistake: naming one modifier twice is malformed (`"#region:a+++" carries more than one modifier`) — §2.9 |
| A modifier anywhere but the end, after canonicalisation | **Error** | §2.7 rule 3, §2.9 |

Why a warning and not an error: the tool's job is to keep documents honest about the *text*
they show, and a contradictory modifier still names one real section — the `++` one. Failing
the whole run (writing nothing, exit 1 with no output) trades a typo for a stalled build;
warning keeps the document fresh, names the marker and the line, and still exits 1 so CI
notices. This is deliberately the same shape as `--lenient`'s failure reporting, minus the
"block left as written" part, because here the block *can* be resolved.

Three consequences the implementer must not miss:

- **Warnings are not gated on `--lenient`.** `--lenient` tolerates *broken includes*; a
  contradictory modifier is not broken, it is merely contradictory. It warns in every mode.
- **Exit code is 1 whenever a warning was emitted**, even though every block was written.
  The summary counts it (`1 warning`), so a green `--check` cannot hide it. This is a
  deliberate exception to "0 = every block up to date": the run *did* succeed at injecting,
  but the document still says something nonsense.
- **It is idempotent.** The second pass sees the same contradictory reference and warns
  again, with no change to the text — the warning is about the document, not about the state
  of the block.

The existing message `no "#region missing" found, and no method or inner class named
"missing"` is asserted at `test.mjs:249` and `test.mjs:858`. The new text must still match
`/no "#region missing" found/`, or those two assertions are updated **deliberately, in the
same commit**. Do not silently rewrite them.

---

## 3. Deliverables (JavaScript only)

### 3.1 Files

| File | Change |
| --- | --- |
| `lib/section.mjs` | **new** — the hosted JS matcher: `parseReference`, `resolveSection`, the block scanner, the anchor matchers. One file, pure, dependency-free, **no fs, no CLI coupling** |
| `lib/README.md` | **new** — how another project vendors `lib/section.mjs` (copy the one file, or `import '@hrg/inject-examples/lib/section.mjs'`), plus an explicit "this revision is the reference; do not fork the semantics" |
| `index.mjs` | `extractCodeRegion` delegates to `lib/section.mjs`; `extractDeclaration` and `extractRegion` keep their exported signatures and delegate too; new exports re-exported |
| `doc/section-matching.md` | **new** — the formal, normative spec other projects implement against (§2 expanded, with the grammar, matcher table, worked examples, error catalogue, and the JS revision it was written against) |
| `doc/usage.md` | new "Section paths" and "Code anchors" sections, all injected from real fixtures, added to its Contents list |
| `README.md` | a short section: slash paths, anchors, pointers to the spec and the hosted matcher; **and the porting-pause sentence required by §6.2** |
| `test.mjs` | new cases per §4; the existing 75 tests stay green |
| `test/fixtures/Anchors.java` | **new** — the condition-literal and comment-anchor fixture |
| `test/fixtures/Example.java` | extended only if the worked examples need a second nesting level |
| `test/vectors/section-vectors.json` | **new** — golden vectors generated from the JS implementation: the machine-readable form of the spec, and the input a *later* port plan consumes. Nothing in this plan consumes them |
| `tools/section-vectors.mjs` | **new** — regenerates the vectors from `lib/section.mjs`; `--check` fails when they are stale |
| `package.json` | `files` gains `lib/` and `doc/section-matching.md`; `exports` gains `"./lib/section.mjs"`; `test` script gains the vector check; a `compare:zig` script is added but stays off the default path (§6.2) |
| `tools/compare-zig.mjs` | **changed** — disabled with a banner and an early refusal (§6.2) |
| `.github/workflows/**` | **changed** — no step runs the differential harness (§6.2) |

### 3.2 Explicitly not in this plan

| Not done here | Why, and when it happens |
| --- | --- |
| Any Java implementation (`lib/java/**`, `pom.xml`, Java vectors) | A separate plan, written after this one is implemented and the JS syntax is settled |
| Any `src/**` change to match the new syntax | The Zig port stays frozen at its current revision (§6) |
| Any `tools/compare-zig.mjs` corpus extension for the new syntax | The harness is switched **off** in step 1, not extended (§6.2) |
| Any change to `cli.mjs` flags, marker syntax, the `inject:` prefix, or the JSON rule | Out of scope by construction |
| Windows path separators in references | Targets always use `/`, never `\` |
| A version bump, `npm publish`, or a `v*` tag | Do not tag: see the two-artifacts trap in §10 |

### 3.3 What "hosted JavaScript" means here

`lib/section.mjs` exports only the matching algorithm, so a consumer can vendor exactly one
file or import `@hrg/inject-examples/lib/section.mjs`. `index.mjs` keeps owning markers,
fences, rules and document rewriting, and delegates only section resolution. That boundary is
what makes a later port a port of *one file's worth of algorithm* instead of the whole tool —
and it is why `lib/README.md` must say plainly that the JS revision is the reference and must
not be adapted per consumer.

`src/` stays the Zig port's directory and is untouched. A later port plan chooses its own
layout (for example `lib/java/`); nothing beyond the one-file boundary is designed here.

---

## 4. JS test matrix (write these as you implement, not after)

**Grammar and canonicalisation**

1. `parseReference('add')`, `add-`, `add+`, `add++` → scopes
   `declaration` / `body` / `annotated` / `documented`; the old `-add`, `+add`, `++add`
   canonicalise to the same result.
2. `parseReference('Cart/Line/render')` → segments `['Cart','Line','render']`, no modifier.
3. `Cart/Line-`, `Cart/-Line`, `-Cart/Line`, `Cart/Line/render-`, `Cart/Line/-render` → all
   normalise to one trailing modifier.
4. Errors: `''`, `'a/'`, `'/a'`, `'a//b'`, `'a/+b'`, `'a/b/-c'`, `'a--'`, `'a+++'`,
   9 segments (`a/b/c/d/e/f/g/h/i`). These must fail, so nothing can quietly change their
   meaning later.
5. Contradictory modifiers warn and resolve (§2.10): `'a++-'`, `'a-++'`, `'a+-'`, `'a-+'`,
   `'Cart/Line/render++-'` → `parseReference` returns the `++`/`+` scope plus a
   `warning` field; the markers warn once each, the blocks are injected with the dominant
   reading, and the run exits 1.
6. Both halves of the boundary: `'a+++'` is an **error** while `'a++-'` is a **warning** —
   a test asserts each, so the two categories cannot drift into one another.

**Resolution against `Example.java`**

7. `toString`, `toString-`, `toString+`, `toString++`, `Line` → byte-identical to today (a
   regression test that copies the current expectations from `test.mjs`).
8. `Cart/Line`, `Cart/toString`, `Cart/Line/render`, `Cart/Line/render-`, `Cart/Line-` → the
   §2.8 fixtures.
9. Errors: `Line/toString`, `Cart/Line/render/extra`, `Cart/Cart`, `nope/deeper`.
10. Two `render` methods in two inner classes: `Line/render` resolves the right one, and the
    walk order is pinned by a test (left to right, depth first, first match).

**Anchors (new fixture)**

11. Condition literal: `if ("getUsers".equals(methodName)) { … }` → `getUsers` and
    `getUsers-`.
12. Condition literals in `while` / `switch` / `catch` headers match too; a literal in a
    *declaration* header is handled by matcher 3 and must not double-match.
13. Comment anchor: `{ //getUsers` (same line) and `{` newline `//getUsers` → canonical body
    includes the anchor comment; `-` excludes it.
14. `// #region foo` is **not** an anchor (decision 3), and a `//name` comment that is not
    the first thing in a block is not an anchor either.
15. A string literal that merely mentions the name (`String s = "getUsers";`) must **not**
    match — only a statement-header literal does.
16. Anchors match only in braced languages; an indented Python block has no brace, so a
    leading `#name` comment there is not an anchor.

**Properties, regions, scoping**

17. A field `private int getUsers = 0;` is matched by `getUsers`; `getUsers-` gives `0`.
18. An explicit `#region <name>` inside `Cart` resolves as `Cart/<name>`, and the trailing
    modifier is ignored for it.
19. A top-level `#region <name>` still wins over a same-named method, as today (matcher 1
    outranks matcher 3).
20. A duplicate `#region` name in one scope errors; the same name in two different scopes is
    fine, and `A/x` / `B/x` both resolve.

**Contract-level**

21. `extractCodeRegion` and `extractDeclaration` keep their exported signatures and pass
    every pre-existing test unmodified.
22. Idempotency: `updateDocument` twice over a document using every new form → second pass
    reports `changed: false`, and a contradictory-modifier document warns on **both** passes.
23. `--lenient` reports the new errors with line numbers and keeps the block; strict mode
    writes nothing. A contradictory modifier warns in **both** modes and still injects.
24. Golden vectors: `tools/section-vectors.mjs` regenerates `test/vectors/section-vectors.json`,
    and `--check` makes CI fail on drift. The vectors carry the warning cases too, with the
    dominant reading recorded as the expected text.
25. `lib/section.mjs` imports nothing from `node:fs`, `node:path`, `process` or `cli.mjs` —
    asserted by a test, so the vendorable boundary cannot rot.
26. The new documents (`lib/README.md`, `doc/section-matching.md`) satisfy the repo's own
    rules: every prose link resolves, and any injected block matches its fixture. The two
    existing enforcement tests in `test.mjs` already scan **every** `.md` file in the repo,
    so they will pick the new files up automatically — verify they do, and make them explicit
    about the two new paths rather than relying on the walk.
27. `node --test test.mjs` green (75 existing + new). **`tools/compare-zig.mjs` is off, not
    green** — see §6.

---

## 5. Not a goal, but worth stating

The frozen syntax is deliberately *not* a parser. It stays a bracket-counting, comment-aware
scanner, exactly as today's implementation is (`strippedCode` blanks comments and string
literals, then brackets are counted). The new features must not introduce a real parse of
Java or TypeScript: a heuristic that is precisely specified and heavily tested is the
contract, and `doc/section-matching.md` must say so in those words, so no consumer expects
type-aware resolution.

---

## 6. Porting freeze (in force for this whole plan)

The maintainer's instruction is explicit: **all porting stops until the final version of the
JavaScript implementation is settled.** The Zig port exists in this repo so that it is
*provably* the same tool, which means the new syntax would break it by design. The answer is
not to race it — it is to stop comparing until the JS stops moving.

### 6.1 The hard rules

1. **No `src/**` changes** in this plan. Nothing in the JS test suite reads `src/`, so this
   rule is on the implementer, not on a test: the Zig sources stay exactly at their current
   revision, and the pause is recorded where a reader will see it (§6.2, README). If
   `zig build test` is red against the new JS expectations, that is expected and acceptable —
   the JS suite is the only suite this plan must keep green.
2. **`tools/compare-zig.mjs` is turned off in step 1 and stays off.** It compares JS to Zig
   byte for byte, so while the syntax moves it can only produce false failures. Turn it off
   *before* touching the matcher, so no commit in this plan has an ambiguous harness result.
3. **No port scaffolding.** No `lib/java/**`, no `pom.xml`, no port-shaped abstractions
   ("language backend interface", "extractor registry") invented for a port that does not
   exist yet. §3.3 fixes the boundary at one file; nothing beyond it is designed here.
4. **Porting gets its own plan**, written after this one lands and the JS syntax is settled.
   That plan owns the Java deliverable and its shape, the Zig catch-up (if still wanted), the
   differential harness's return, and the parity gates.
5. **The spec is still written for implementers.** `doc/section-matching.md` must be complete
   enough that another project can implement the grammar from it — that is the "formalise the
   syntax" half of the mission, and rule 1 does not weaken it. It is a specification, not an
   invitation to port in this plan.

### 6.2 Turning the harness off (step 1, concrete)

Do all of this in the first commit, with a message that names this plan:

- **`package.json`** — add `"compare:zig": "node tools/compare-zig.mjs"` (there is no such
  script today) purely so the harness has a named, discoverable entry point, and keep it
  **off** the default path: `test` becomes
  `node --test test.mjs && node tools/section-vectors.mjs --check`. Nothing in this plan may
  make `compare:zig` part of `npm test` or of CI.
- **`tools/compare-zig.mjs`** — add a header banner stating it is **disabled until the JS
  section-matching syntax is settled**, naming this plan, and make its default invocation
  refuse to run: print the reason and exit non-zero unless an explicit `--force` is passed.
  A default run must not look like a passing test.
- **`README.md`**, "The Zig port" section — one sentence stating that the Zig port and the
  differential harness are **paused** while file-section matching is formalised in
  JavaScript, and resume with their own plan. Link to `doc/section-matching.md`, not to this
  plan, because the plan is not a shipped document. This sentence is the actual enforcement
  of `src/`'s freeze, because no test covers `src/`.
- **`.github/workflows/**`** — verify no step runs `compare-zig.mjs` (today none does) and
  keep it that way. A workflow may keep building the Zig binary on a `v*` tag, but it must
  not fail the run over the new syntax — and see the "do not tag" risk in §10.

---

## 7. Work order for the implementing agent (one step per commit)

1. **Freeze porting, first.** Do §6.2 — harness off, README sentence, CI step removed. Commit
   alone, so the freeze is visible in history before any semantics move.
2. **Spec first.** Write `doc/section-matching.md` from §2. No code. Commit.
3. **Fixtures and expectations.** Add `test/fixtures/Anchors.java`, any `Example.java`
   additions, and write the §4 expectations as *failing* tests (or a scratch harness). This
   fixes the bytes before the algorithm exists. Commit.
4. **Parse layer.** `lib/section.mjs`: `parseReference` + canonicalisation + the error
   catalogue + the §2.10 contradictory-modifier warning. Make test groups 1–6 pass. Commit.
5. **Mask + block scanner.** Move `strippedCode` into `lib/section.mjs`, add the block scanner
   (class/method/property declarations, statement blocks with header spans, region directives
   with their scope, comment anchors). Unit-test it directly: braces in strings, comments,
   Allman, arrow bodies, abstract/interface body-less members, nesting depth, CRLF. Commit.
6. **Resolve layer.** `resolveSection(text, reference)`: matcher precedence 1–6, scope
   containment for slashed paths, first-match walk order, trailing-modifier application. Make
   groups 7–20 pass. Commit.
7. **Wire into `index.mjs`.** `extractCodeRegion` delegates; `extractDeclaration` /
   `extractRegion` delegate; re-exports added; the old tests prove no regression. Commit.
8. **Vectors.** `tools/section-vectors.mjs` and `test/vectors/section-vectors.json`, wired into
   the default `test` script with `--check`. No Zig corpus work, no port. Commit.
9. **Docs, dogfooded.** Extend `doc/usage.md` (new sections, injected from the real fixtures,
   added to its Contents list), `README.md` and `lib/README.md`; extend the existing
   "documentation stays in sync" and "every link is functional" tests to cover the new files.
   `npx inject-examples --check README.md doc/usage.md` clean. Commit.
10. **SETTLE.** Record the JS commit sha at the top of `doc/section-matching.md` and hand the
    frozen revision to the maintainer for review. **Only a maintainer decision ends the
    freeze** (§9). After this, a *separate* plan covers Java and any Zig catch-up.

---

## 8. Acceptance gate

This plan is done when all of these hold. Nothing here involves a port.

- [ ] Porting is frozen per §6: `git diff` shows no `src/**` change; `compare:zig` exists but
      is unreachable from `npm test`; `node tools/compare-zig.mjs` refuses to run without
      `--force`; the README states the pause; no CI step runs the harness.
- [ ] `node --test test.mjs` green, and the count went up, not sideways.
- [ ] Every pre-existing test unmodified except the two message-regex assertions in §2.9.
- [ ] `npx @hrg/inject-examples --check README.md doc/usage.md` exits 0.
- [ ] `doc/section-matching.md` contains the grammar, the matcher precedence table, the error
      catalogue, the worked examples and the "heuristic, not a parser" statement — another
      project can implement from it alone — and it names the JS revision it was written
      against.
- [ ] `test/vectors/section-vectors.json` is generated by `tools/section-vectors.mjs`, and
      `--check` fails on drift and is part of `npm test`.
- [ ] `lib/section.mjs` imports nothing from Node, the fs, or the CLI (test 25).
- [ ] A second `updateDocument` pass over a document exercising every new form reports
      `changed: false`.
- [ ] A document carrying a contradictory modifier (`a++-`) warns with the document, line and
      marker, injects the `++` reading, and exits 1 — in strict mode, in `--check` and with
      `--lenient` (§2.10).
- [ ] The frozen JS commit sha is recorded in `doc/section-matching.md`, and the maintainer has
      signed off on the syntax (§9).

---

## 9. What "settled" means (the trigger that ends the freeze)

The freeze ends when every one of these is true, and not before:

- the acceptance gate in §8 is fully checked;
- the JS commit sha is recorded at the top of `doc/section-matching.md` (work-order step 10);
- the maintainer has reviewed the frozen syntax after using it on a real document, not just on
  fixtures — the "final version" the instruction refers to is a decision, not a test result.

Until then, treat `lib/section.mjs` as a draft API: `index.mjs` may depend on it, and the
fixtures and docs may use it, but nothing may be published as a stable interface for other
languages to implement against beyond the written spec.

---

## 10. Risks and how the plan handles them

| Risk | Mitigation |
| --- | --- |
| Recursive bare-name matching changes behaviour for existing users (`render` now finds a nested method) | Intentional, documented in §2.3 rule 4; the existing suite pins today's outputs; the walk order is fixed and tested (left to right, depth first, first match) |
| "First match wins" hides a real ambiguity | The walk order is deterministic and specified; strict and `--lenient` modes both report the *chosen* match's location in the error/warn text, so a wrong pick is visible |
| Condition-literal matching is fuzzy by construction ("string as part of condition") | Frozen to: **exact double-quoted literal, exact bytes, on a statement header line, in the same scope**. Not substring, not case-insensitive, not a regex |
| Comment anchors collide with real `#region` directives | `#region`/`#endregion` lines are never anchors, and matcher 1 outranks matcher 6 |
| The block scanner and the old line scanner disagree | The scanner *replaces* the line scanner: `extractDeclaration` becomes a wrapper, so there is exactly one algorithm |
| A frozen Zig port silently rots while the JS moves | This is the accepted cost of the freeze; §9 makes resuming it a deliberate, separately planned act, and the vectors are the machine-readable target that port will consume |
| **One repo, two artifacts**: a `v*` tag cross-builds and publishes Zig binaries (`release.yml`) | Do **not** tag a release in this plan. A tag would attach binaries that do not implement the new syntax to a release whose README documents it — exactly the "silently out of date" failure this project exists to prevent. Publish the npm package only, or wait for the port plan |
| The spec is mistaken for a licence to port early | §6 rule 5 states it plainly: the spec is complete by design, porting still waits for its own plan |
| `lib/README.md` or `doc/section-matching.md` breaks the repo's own doc rules (dead links, stale injected blocks) | Test 26 extends the two existing enforcement tests to the new files |
| The `--` spelling | Not a modifier and never was: only `-`, `+`, `++` exist (§2.3), so `a--` is rejected as two modifiers. Deliberate, per the maintainer |
| A contradiction warning is swallowed, or blocks the run | Test 6 pins the error/warning boundary (`a+++` errors, `a++-` warns); §2.10 fixes that warnings fire in every mode, inject the dominant reading, and still exit 1 — so a warning can neither stall a build nor hide behind exit 0 |

---

## 11. Resolved decisions (recorded so the later port plan inherits them)

| Question | Decision |
| --- | --- |
| Where does the modifier live? | At the end, applying to the last path part; the old leading spelling is canonicalised to it |
| Comment anchor body? | Anchor comment plus the block body; `-` strips the comment |
| Is `region` a name to match? | No — `region:` is the fragment keyword; a single-item reference matches region directives, properties, methods, classes, comment-anchored blocks and condition literals alike |
| Bare-name depth? | Whole file, any depth, first match in a fixed depth-first, left-to-right walk |
| Slashed path semantics? | First element global; every later element searched only inside the scope the previous element found |
| Contradictory modifiers (`++` with `-`, `+` with `-`)? | A **warning**, not an error: the higher modifier wins (`++` over `-`), the block is injected, the run exits 1 (§2.10). Repeating one modifier (`a+++`) stays an error |
| Where does the matcher live? | One vendorable ES module, `lib/section.mjs`; `index.mjs` delegates to it |
| When does porting resume? | Only via a **separate plan**, after the JS syntax is settled and a maintainer has signed off (§9) |
| Java deliverable shape, when its plan is written? | Source tree + JSON vectors + a Maven module, zero runtime dependencies, Java 8 — recorded for that plan, not built here |
