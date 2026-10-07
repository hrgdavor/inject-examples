# File-section matching — normative specification

The following is the **shipped** normative spec for file-section matching. The contract (
`00-contract.md`) is internal planning prose; this document is the public artefact, written
for an implementer who has never seen this repository.

---

## 1. What a section reference is

A `<section-reference>` appears in a marker's fragment as `#region:<section-reference>`. The
marker form is:

```text
[label](path#region:<section-reference>)
```

- `inject:` is a consumer project's own marker prefix — how their tooling recognises a line
  as an injection marker before rewriting it into the form above.
- `region:` is a fixed fragment keyword, not a name to match — it is what tells the tool
  "this fragment is a section reference".
- The reference text (`<section-reference>`) is the only part of the marker that defines
  behaviour. The label names the target file; the path selects which scope within it.

A single-segment reference (no `/` in the path) searches the whole file at any depth. A
slash-separated reference descends into blocks: each later segment is searched **only inside
the scope the previous one found**. For a multi-segment reference, every later segment is
searched only within the scope the previous segment matched.

---

## 2. Grammar

```text
section-reference := path [ modifier ]
modifier          := '++' | '+' | '-'          ; longest match first; those three only
path              := segment ( '/' segment )*  ; at most 8 segments
segment           := token
token             := /[A-Za-z_$][\w$]*/ | 'new'
```

A `token` contains no `/`, `+`, `-` or whitespace. Dotted names are one token (e.g.
`Foo.Bar` is a single token, because dotted names occur in JS/TS code). Dots are never path
separators.

---

## 3. The six rules

1. **`/` is not a package path.** It never means a Java package or an FQDN. It only descends
   into nested blocks inside the one target file.
2. **Only the last segment selects content to inject.** Earlier segments are scopes: each
   must resolve, and each later segment is looked up inside the block the previous segment
   found.
3. **The modifier is trailing and applies to the final path part.** The old leading spelling
   keeps working: `-add`, `+add`, `++add` are canonicalised to `add-`, `add+`, `add++` (§7).
4. **A bare name is a path of one segment**, and keeps today's meaning: search the whole
   file, at any depth.
5. **First match wins.** Walking depth-first and left to right. A trailing modifier never
   changes which match is found.
6. **`region:` is not a name.** The reference `add` matches a `#region add` directive, a
   `void add()` method, a `String add` property, a `class add`, a `//add` anchor, or an
   `if ("add".equals(...))` block — whichever the walk finds first.

---

## 4. Matcher precedence table (walk description)

Within one scope the matchers are tried in this order. The first that matches ends the lookup
for that scope. In a single-segment reference, this also ends the whole search. When a scope
yields no match, the walker descends into every block that scope contains — left to right,
depth first — and retries the same segment. For a multi-segment reference: once `Cart` matches,
later segments are searched **only inside `Cart`**, with the same precedence and depth descent.

| # | Matcher | What it finds | Notes |
| --- | --- | --- | --- |
| 1 | **Region directive** | `#region <name>` … `#endregion` whose enclosing block is this scope (file scope for top-level) | lines strictly between the directives; chosen before 2–6 |
| 2 | **Class-like declaration** | `class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union` named `<name>` in this scope | declaration, or the modified part (§8); beats a same-named constructor |
| 3 | **Method / function** | named method, constructor, function or arrow-valued property with a body in this scope | body-less members are skipped |
| 4 | **Property** | a field/constant declaration named `<name>` | the whole statement; `-` gives the initialiser expression when there is one |
| 5 | **Condition literal** | a statement block whose header line carries `"<name>"` (double-quoted, exact bytes) | the block's braces, header to close |
| 6 | **Comment anchor** | a braced block whose first non-blank line is `//<name>` or `/*<name>*/` | the block's braces, header to close, **anchor comment included**; a `#region`/`#endregion` line is never an anchor |

---

## 5. Canonicalisation and compatibility spellings

Normalise first, then parse:

1. If the reference starts with `++`, `+` or `-`, detach it and append it to the end.
2. If the **second** segment starts with exactly one `-` and nothing was detached in step 1,
   detach that `-` and append it (`Cart/-Line` → `Cart/Line-`).
3. After normalisation, a `+` or `-` anywhere except the very end is an error (§9).

Accepted: `add`, `add-`, `-add`, `Cart/Line`, `Cart/Line-`, `Cart/-Line`, `toString++`,
`++toString`, `Cart/Line/render-`, `Cart/Line/-render`.
Rejected (errors): `Cart/-Line/render`, `Cart/Line/+render`, `a//b`, `a/`, `/a`, `a+++`.
Warned: `a/b++-`, `a-/b++`, `a+-`.

---

## 6. Modifier semantics per match kind

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

- **Declaration** — exactly today's semantics (`declaration` / `body` / `annotated` /
  `documented`, see `index.mjs:445`), with `-` also reaching a property's initialiser. Byte-for-byte unchanged for the forms that exist today.
- **Region directive** — a region is already exactly its body, so the modifier is **ignored**:
  `add+` and `add` inject the same lines.
- **Condition literal, comment anchor** — the block is the unit. No modifier (or `+`) = the
  block from its first line through its closing brace, where that first line is:
  - comment anchor: the **anchor comment line**;
  - condition literal: the **statement header line** (`if (…) {`).
  `-` = the body strictly inside the braces. `++` on a comment anchor behaves like `+` (there
  is no declaration to document).

---

## 7. Error catalogue

Messages quote **the reference as the user wrote it** (call it `<raw>`, `/`-separated, before
normalisation) so the message points at the document, not at the parser's internal form. `Cart/-Line` therefore appears as written even though it normalises to `Cart/Line-`.

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
caller can distinguish a malformed reference from a resolution failure without matching on message
text. Resolution failures thrown by the walker are plain `Error`s carrying the same messages,
exactly as today.

**Back-compatibility of one message.** Today's text is `no "#region missing" found, and no
method or inner class named "missing"`, asserted at `test.mjs:249` and `test.mjs:858`. The new
text must still match `/no "#region missing" found/`, or those two assertions are updated
deliberately, in the same commit, with the reason in the commit message. Do not silently rewrite
them.

---

## 8. Contradiction warning

`++` and `-` contradict each other: `++` asks for the declaration **with** its annotations and
doc comment, `-` asks for the **body alone**. No single section can be both, so the reference is
meaningless — but it must not hold a whole document hostage, and it is exactly what a human types
while refactoring.

| Case | Kind | Behaviour |
| --- | --- | --- |
| Contradictory pair: `++` with `-`, either order (`a++-`, `a-++`, `a-/b++`) | **Warning** | Reported once as `inject-examples: warn: <doc>:<line>: "#region:<ref>": "+/-" contradicts "++"; using "#region:<ref-without-the-minus>"`. The **`++` reading wins**; the block is injected as if the `-` were absent; the run continues; the run **exits 1** |
| `+` with `-` (`a+-`, `a-+`) | **Warning** | Same shape: contradictory, `+` wins |
| One modifier named twice (`a+++`, `a---`) | **Error** | Malformed, not contradictory — §9 |
| A modifier anywhere but the end | **Error** | §7 rule 3, §9 |

Three consequences that must not be missed:

- **Warnings are not gated on `--lenient`.** `--lenient` tolerates *broken includes*; a
  contradictory modifier is not broken, it is merely contradictory. It warns in every mode.
- **Exit code is 1 whenever a warning was emitted**, even though every block was written, and
  the summary counts it (`1 warning`). A deliberate exception to "0 = every block up to date":
  the run did succeed at injecting, but the document still says something nonsense.
- **It is idempotent.** The second pass warns again with no change to the text — the warning
  is about the document, not about the state of the block.

---

## 9. Worked examples (the acceptance bytes)

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

Given `test/fixtures/Anchors.java` (contains `if ("getUsers".equals(methodName)) { … }` and a method whose body opens `{ //getUsers`):

| Reference | Result |
| --- | --- |
| `getUsers` | the `if` block, header through closing brace |
| `getUsers-` | the `if` block's body only |
| `dispatch/getUsers` | the same match, reached explicitly through the method's scope |
| `getUsers` (anchor case) | `        //getUsers` + the block body, through its closing brace |
| `getUsers-` (anchor case) | the block body only, anchor comment excluded |
| `getusers` | error: literal matching is case-sensitive, exact bytes |

---

## 10. A heuristic, not a parser

The matcher blanks comments and string literals and counts brackets; it does not parse Java or
TypeScript and makes no type-aware decisions. Consumers must not expect a real parser. This is a
heuristic over text whose comments and string literals are blanked — the result is deterministic
and reproducible, but it has no guarantees about correctness in every possible language construct.

---

## 11. Revision header

`Written against the JavaScript implementation at commit <sha>`. The JavaScript implementation is
authoritative; a port that disagrees is wrong by definition. Do not fork the semantics per consumer —
the contract is the source of truth, and this revision is the reference until the maintainer signs
off the settled revision (step 9). When the syntax is settled, replace the placeholder with the
actual commit sha.

---

## 12. Public surface

The module exports: `parseReference`, `resolveSection`, `planSection`, `scanBlocks`,
`isSingleSegment`, `finalSegment`, `SectionReferenceError`. (Additional exports may exist; verify
against `lib/section.mjs`.)
