# File-section matching

`doc/section-matching.md` is the normative specification of the
`<section-reference>` that follows `#region:` in a marker fragment. It is
written for an implementer who has never seen this repository: every rule needed
to match a reference to a piece of a target file is here, and only here lives
the definition of *what a section reference is*.

The marker that carries one looks like this:

```text
[label](path#region:<section-reference>)
```

`inject:` is a consumer project's own marker prefix — how *their* tooling flags
a line as an injection marker before rewriting it into the form above (the
`inject:` prefix is a concern of the consumer, not of this grammar). `region:` is
a fixed fragment keyword, **not** a name to match: it is what tells the tool,
"this fragment is a section reference, resolve it against the file." This
document specifies only the reference text after `region:`; it does not change
the marker prefix, the fragment keyword, fences, gitignore, the CLI, or the JSON
rule. Those are out of scope and unchanged.

A reference resolves to a **section** — a span of text inside the target file.
A **block** is a braced (or indented) span: a class-like body, a method body, a
statement body (`if`/`for`/`while`/`switch`/`try`/`catch`), or a block
introduced only by an anchor comment. The file itself is scope 0; every block
that scope contains is scope 1; and so on.

Written against the JavaScript implementation as of the commit that adds this
file, and frozen by `plan/section-matching/00-contract.md` once it is settled.

## Contents

- [Grammar](#grammar)
- [The six rules](#the-six-rules)
- [Matcher precedence](#matcher-precedence)
- [Canonicalisation and compatibility spellings](#canonicalisation-and-compatibility-spellings)
- [Modifiers](#modifiers)
- [Errors](#errors)
- [Contradictory modifiers are a warning](#contradictory-modifiers-are-a-warning)
- [Worked examples](#worked-examples)
- [Heuristic, not a parser](#heuristic-not-a-parser)
- [The vendorable module boundary](#the-vendorable-module-boundary)

## Grammar

```text
section-reference := path [ modifier ]
modifier          := '++' | '+' | '-'            ; longest match first; those three only
path              := segment ( '/' segment )*    ; at most 8 segments
segment           := token
token             := /[A-Za-z_$][\w$]*/ | 'new'
```

A `token` contains no `/`, `+`, `-` or whitespace. A name may be dotted
(`Foo.Bar` is one token, because dotted names occur in JS/TS code); dots are
never path separators. Each bullet below is an error when violated:

1. `/` is not a package path or an FQDN. It only descends into nested blocks
   *inside the one target file*.
2. Only the last segment selects content to inject. Earlier segments are
   **scopes**: each must resolve, and each later segment is looked up only
   inside the block the previous segment found.
3. The modifier is trailing and applies to the final segment. The **old leading
   spelling stays supported**: `-add`, `+add`, `++add` are normalised to `add-`,
   `add+`, `add++` (see [Canonicalisation](#canonicalisation-and-compatibility-spellings)).
4. A bare name is a path of one segment, and keeps today's meaning: search the
   whole file, at any depth.
5. First match wins, walking depth-first and left to right. A trailing modifier
   never changes which match is found.
6. `region:` is not a name. The reference `add` matches a `#region add`
   directive, a `void add()` method, a `String add` property, a `class add`, a
   `//add` anchor, or an `if ("add".equals(...))` block — whichever the walk
   finds first.

## Matcher precedence

Within one scope the matchers below are tried in this order; the first that
matches ends the lookup *for that scope*. In a single-segment reference that
also ends the whole search.

| # | Matcher | What it finds | Selects |
| --- | --- | --- | --- |
| 1 | **Region directive** | `#region <name>` … `#endregion` whose enclosing block is this scope (the whole file for a top-level region) | the lines strictly between the directives |
| 2 | **Class-like declaration** | `class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union` named `<name>` in this scope | the declaration, or the modified part |
| 3 | **Method / function** | a named method, constructor, function or arrow-valued property in this scope **that has a body** | the declaration, or the modified part |
| 4 | **Property** | a field or constant named `<name>` (`private int getUsers = 0;`, `static final String X = …`) | the whole statement |
| 5 | **Condition literal** | a statement block whose header line carries `"<name>"` (double-quoted, exact bytes) | the block, header line through closing brace |
| 6 | **Comment anchor** | a braced block whose first non-blank line is `//<name>` or `/*<name>*/` | the block, anchor comment through closing brace |

A class-like name beats a same-named constructor. Body-less members (interface
methods, `abstract` declarations) have nothing to inject and are skipped. A
`#region`/`#endregion` line is never an anchor, and a comment that is not the
first thing in the block is not an anchor either.

**The walk.** Within one scope the table is tried top to bottom and the first
match wins. When a scope yields no match, the walker descends into every block
that scope contains, left to right, depth first, and retries the same segment —
so `render` finds `Line.render` even though it is nested inside `Cart`. For a
multi-segment reference the same descent happens one step at a time: once
`Cart` matches, later segments are searched **only inside `Cart`**, with the
same precedence and the same depth-first descent.

## The six rules

The grammar above, in short form (each violated in some cases below):

- `/` is not a package path; it descends into nested blocks of the one file.
- Only the last segment selects content; earlier segments are only scopes.
- The modifier is trailing and applies to the final segment; `-add` and `add-`
  mean the same thing.
- A bare name is a one-segment path and searches the whole file.
- First match wins, depth first and left to right.
- `region:` is the fragment keyword, not a name to match.

## Canonicalisation and compatibility spellings

The leading spelling reads `-`, `+`, `++` only as a prefix of the whole
reference. The canonical form is **trailing**, so the parser normalises before
it parses:

1. If the reference begins with `++`, `+` or `-`, detach that prefix and append it
   to the end.
2. After step 1, if the **second** segment begins with exactly one `-` and
   nothing was detached in step 1, detach that `-` and append it
   (`Cart/-Line` → `Cart/Line-`).
3. After normalisation, a `+` or `-` anywhere except the very end is an error.

| Accepted | Notes |
| --- | --- |
| `add`, `-add`, `+add`, `++add` | the last three canonicalise to `add-`, `add+`, `add++` |
| `Cart/Line`, `Cart/Line-`, `Cart/-Line` | the last two canonicalise to `Cart/Line-` |
| `toString++`, `++toString` | same result |
| `Cart/Line/render-`, `Cart/Line/-render` | same result |

| Rejected (errors) |
| --- |
| `Cart/-Line/render` — a `-` is not in the last segment |
| `Cart/Line/+render` — a `+` is not in the last segment |
| `a//b`, `a/`, `/a` — an empty path segment |
| `a+++` — more than one modifier |

| Warned (see [Contradictory modifiers](#contradictory-modifiers-are-a-warning)) |
| --- |
| `a/b++-`, `a-/b++`, `a+-` |

## Modifiers

A trailing `++`, `+` or `-` before the final segment selects how much of the
match comes with it:

| Reference | Injection |
| --- | --- |
| `Cart/Line` | the whole inner class declaration |
| `Cart/Line-` | `Line`'s body only (no class line, no closing brace) |
| `Cart/toString+` | `toString`'s declaration including the annotations above it |
| `Cart/toString++` | declaration, its annotations, and the doc comment above them |
| `getUsers-` | the body inside the brace pair |
| `getUsers+` / `getUsers++` | the header line, plus a leading doc/annotation block for `++` |
| `count-` (property) | the initialiser expression, or the declaration when there is none |

Modifier semantics per match kind:

- **Declaration (class / method / property)** — exactly today's semantics:
  `declaration` / `body` / `annotated` / `documented`, with `-` also reaching a
  property's initialiser. Byte-for-byte unchanged for the forms that exist today.
- **Region directive** — a region is already exactly its body, so the modifier is
  **ignored**: `add+` and `add` inject the same lines.
- **Condition literal, comment anchor** — the block is the unit. No modifier (or
  `+`) selects the block from its first line through its closing brace, where
  that first line is the anchor comment (for a comment anchor) or the statement
  header (for a condition literal). `-` selects the body strictly inside the
  braces. `++` on a comment anchor behaves like `+` (there is nothing to
  document).

## Errors

Every message quotes the reference **exactly as the user wrote it** (call it
`<raw>`, `/`-separated, before normalisation) — `Cart/-Line` therefore appears
as written even though it normalises to `Cart/Line-`:

| Condition | Message shape |
| --- | --- |
| empty reference | `"#region:" names nothing` |
| empty segment, leading/trailing `/`, `//` | `"#region:<raw>" has an empty path segment` |
| `+`/`-` not at the end, after normalisation | `"<char>" may only modify the last path segment of "#region:<raw>"` |
| the same modifier twice or thrice (`a+++`, `a---`) | `"#region:<raw>" carries more than one modifier` |
| a detached leading modifier and a trailing one (`-a-`) | `"#region:<raw>" carries more than one modifier` |
| more than 8 segments | `"#region:<raw>" is deeper than 8 sections` |
| a segment matches nothing anywhere | `no "#region <name>" found, and no section named "<name>"` |
| a class/block is matched but path remains | `"<name>" is not a container` |
| a mid-path scope does not exist | `no section named "<name>" in "<previous>"` |

A missing, duplicate or unclosed `#region`/`#endregion` directive is reported by
the region directive itself (see `extractRegion`) and is not part of this
catalogue.

**One back-compatible message shape.** The single-segment "found nothing" error
above must still match `/no "#region <name>" found/` so existing callers that
test against it keep working.

## Contradictory modifiers are a warning

`++` and `-` contradict each other: `++` asks for the declaration *with* its
annotations and doc comment, `-` asks for the *body alone*. No single section is
both, so the reference is meaningless — but it is exactly what a human types
while refactoring, so it must not hold a whole document hostage.

| Case | Kind | Behaviour |
| --- | --- | --- |
| `++` with `-` (`a++-`, `a-++`, `a-/b++`) | Warning | The **`++` reading wins**; the `-` is dropped. Reported once as `inject-examples: warn: <doc>:<line>: "#region:<ref>": "+/-" contradicts "++"; using "#region:<ref-without-the-minus>"`. The run continues, every block is written, and the run **exits 1** |
| `+` with `-` (`a+-`, `a-+`) | Warning | Same shape: contradictory, `+` wins |
| One modifier named twice (`a+++`, `a---`) | Error | Malformed, not contradictory — see [Errors](#errors) |
| A modifier anywhere but the end | Error | See [Canonicalisation](#canonicalisation-and-compatibility-spellings) |

Three consequences it is easy to miss:

- **Warnings are not gated on `--lenient`.** `--lenient` tolerates *broken
  includes*; a contradictory modifier is not broken, it is merely contradictory.
  It warns in every mode.
- **Exit code is 1 whenever a warning was emitted**, even though every block was
  written, and the summary counts it (`1 warning`). This is a deliberate
  exception to "0 means up to date": the run did succeed at injecting, but the
  document still says something nonsense.
- **It is idempotent.** The second pass warns again with no change to the text —
  the warning is about the document, not about the state of the block.

## Worked examples

Both fixtures live in `test/fixtures/`. The first column is the reference text as
written by a user; the table quotes exact bytes where the result is a single
line, and describes the rest (read the fixture for the full bytes).

Given `test/fixtures/Example.java` — a `Cart` class containing an annotated,
documented `toString()` and an inner `Line` with a `render()`:

| Reference | Result |
| --- | --- |
| `toString` | today's output, unchanged |
| `toString-` (or `-toString`) | today's output, unchanged |
| `toString+` (or `+toString`) | today's output, unchanged |
| `toString++` (or `++toString`) | today's output, unchanged |
| `Line` | today's output, unchanged |
| `Cart/Line` | identical to `Line` |
| `Cart/toString` | identical to `toString` |
| `Cart/Line/render` | the `render` declaration, line through closing brace |
| `Cart/Line/render-` (or `Cart/Line/-render`) | `            return name + " x" + quantity;` |
| `Cart/Line-` | `Line`'s body, without the class line or the closing brace |
| `Line/toString` | error: `no section named "toString" in "Line"` |
| `Cart/Line/render/extra` | error: `render` is not a container |
| `Cart/Cart` | error: `Cart` is not a container (a class is a scope, not a section) |

Given `test/fixtures/Anchors.java` — a method `dispatch` whose body holds an
`if ("getUsers".equals(methodName)) { … }` block, and another method whose body
opens with the anchor comment `{ //getUsers`:

| Reference | Result |
| --- | --- |
| `getUsers` | the `if` block, header line through closing brace |
| `getUsers-` | the `if` block's body only (the line inside the braces) |
| `dispatch/getUsers` | the same `if` match, reached explicitly via the method's scope |
| `getUsers` (anchor case) | the `//getUsers` anchor line plus the block body, through the closing brace |
| `getUsers-` (anchor case) | the block body only, the anchor comment excluded |
| `getusers` | error: case-sensitive exact-byte matching |

## Heuristic, not a parser

The matcher blanks comments and string literals and counts brackets. It does
**not** parse Java or TypeScript, and it makes no type-aware decisions. A
matching step is:

1. Walk the target's lines in order, with each line's comment and string-literal
   text blanked to spaces of the same length.
2. Track `{` / `}` over the blanked text to know where each block opens and
   closes. Indentation closes blocks in brace-less scopes (Python, Ruby).
3. At each step offer the current scope's candidates in matcher-precedence order;
   the first match for a segment ends the lookup at that scope.

Consumers must not expect a real parser: declarations are found by
shape and by name, not by type information, and a name that occurs inside a
string or a comment is never a declaration.

## The vendorable module boundary

`lib/section.mjs` is a single, dependency-free ES module that exports the
matching algorithm only. It must not import or reference `node:fs`, `node:path`,
`process`, `cli.mjs`, or anything that reads the disk or the environment — a
consumer project vendors this one file. `index.mjs` owns markers, fences, rule
dispatch, gitignore and document rewriting, and delegates only section
resolution. A test asserts the boundary (see §10 of the contract), so it cannot
rot.

A project adds a rule for another type with `options.regionRules` (see the
README's "Region rules by file type" section); a custom rule calls
`extractSection` for its type and otherwise reuses this module's matchers.
