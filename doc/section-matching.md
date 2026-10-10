# File-section matching

`doc/section-matching.md` is the normative specification of the
`<section-reference>` that follows `#` in a marker fragment. It is
written for an implementer who has never seen this repository: every rule needed
to match a reference to a piece of a target file is here, and only here lives
the definition of *what a section reference is*.

The marker that carries one looks like this:

```text
[label](path#<section-reference>)
```

Anything after `#` is the reference, resolved against the file: the fragment of
a marker on a real path *is* a section reference (an in-page link, whose path is
empty, is navigation and never a marker). This document specifies the reference
grammar and its resolution only; it does not change fences, gitignore, the CLI,
or the JSON rule.

A reference resolves to a **section** — a span of text inside the target file.
A **block** is a braced (or indented) span: a class-like body, a method body, a
statement body (`if`/`for`/`while`/`switch`/`try`/`catch`), or a block
introduced only by an anchor comment. The file itself is scope 0; every block
that scope contains is scope 1; and so on.

The JavaScript implementation in `lib/section.mjs` and `index.mjs` is
authoritative: a port that disagrees with it is wrong by definition.

## At a glance

A section reference is a `/`-separated path of names. A `+`, `++` or `-` applies
to the **last** name only — a modifier written on an earlier name is collected and
applied to the last one, not an error — and the canonical spelling puts it at the
very end. A leading spelling is accepted in two cases only, and they are not
symmetric: see [Where a modifier may appear](#where-a-modifier-may-appear). Three
questions fully specify it, and this document keeps each in its own section so
they do not blur into one another:

| Question | In one line | Expanded in |
| --- | --- | --- |
| How does a path with one or more `/` resolve? | Every name except the last **narrows the scope** to the block it finds; only the **last** name selects content; a single name searches the whole file. | [Paths and scopes](#paths-and-scopes) |
| How is one name found inside a scope? | Inside that scope — the whole file, or a block a parent narrowed it to — the six matchers run in order against the scope's own members; the first match wins, and a shallower sibling always beats a deeper block. | [Searching one element in a scope](#searching-one-element-in-a-scope) |
| Where do `+`, `++` and `-` apply, and what do they do? | A modifier binds to the **last** segment, wherever it was written; it chooses **how much** of the match to take, never **which** match. | [Applying the modifiers](#applying-the-modifiers) |

[Grammar](#grammar) gives the syntax and [The six rules](#the-six-rules) is the
compact normative statement; the three topics expand them, and the tables beneath
each topic are the detail.

## Contents

- [Grammar](#grammar)
- [The six rules](#the-six-rules)
- [Paths and scopes](#paths-and-scopes)
  - [Narrowing the scope](#narrowing-the-scope)
  - [A bare name](#a-bare-name)
- [Searching one element in a scope](#searching-one-element-in-a-scope)
  - [Matcher precedence](#matcher-precedence)
  - [Sibling-first descent](#sibling-first-descent)
- [Applying the modifiers](#applying-the-modifiers)
  - [Where a modifier may appear](#where-a-modifier-may-appear)
  - [Canonicalisation](#canonicalisation)
  - [Modifiers](#modifiers)
  - [Contradictory modifiers are a warning](#contradictory-modifiers-are-a-warning)
- [Errors](#errors)
- [Worked examples](#worked-examples)
- [Not a parser](#not-a-parser)
- [Tokenizers](#tokenizers)
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
never path separators. The syntax alone says nothing about resolution — the six
rules below do, and each is expanded in its own topic.

## The six rules

The grammar, as six rules. Each violated below is an error (see
[Errors](#errors)); rule 5 is the walk order other documents cite:

1. `/` is not a package path or an FQDN. It only descends into nested blocks
   *inside the one target file*.
2. Only the last segment selects content to inject. Earlier segments are
   **scopes**: each must resolve, and each later segment is looked up only
   inside the block the previous segment found.
3. The modifier is **trailing** and applies to the final segment, but two leading
   spellings are normalised to it before parsing and a third case is collected
   from wherever it was written. Precisely: a prefix of the **whole reference**
   (`+a/b`, `++a/b`, `-a/b`, `-add` → `a/b+`, `a/b++`, `a/b-`, `add-`) and a
   single `-` leading the **last segment** (`a/-b` → `a/b-`, `Cart/-Line` →
   `Cart/Line-`) are accepted; a `+` or `++` leading a *segment* is an error even
   when that segment is last (`a/+b`); and a trailing run written on a segment
   that is not the last is collected and applied to the last segment
   (`a++/b` → `a/b++`). The two leading forms are **not** symmetric, which is the
   one thing ports get wrong — see
   [Where a modifier may appear](#where-a-modifier-may-appear).
4. A bare name is a path of one segment: it searches the whole file, at any
   depth.
5. First match wins, walking **sibling first**: every scope at one depth is
   searched, left to right, before the walk descends into any block they
   contain. A declaration in a scope is therefore never shadowed by a same-named
   block nested inside an earlier sibling — `doSomeAction` resolves to the
   method, not to an `if ("doSomeAction"…)` inside a method that comes sooner in
   the file. A trailing modifier never changes which match is found.
6. The reference `add` matches a `#region add` directive, a `void add()` method,
   a `String add` property, a `class add`, a `//add` anchor, or an
   `if ("add".equals(...))` block — whichever the walk finds first, the
   shallowest candidate winning.

Rules 1, 2 and 4 are the subject of [Paths and scopes](#paths-and-scopes); rule
5 (and the matcher table rule 6 names) of
[Searching one element in a scope](#searching-one-element-in-a-scope); rule 3 of
[Applying the modifiers](#applying-the-modifiers).

## Paths and scopes

*How a complex target — one name, or a path of several names separated by `/` —
resolves. Rules 1, 2 and 4.*

A path is read **left to right**. The first segment is looked up in **scope 0**,
the whole target file. Every later segment is looked up **only inside the block
the previous segment matched**, so the search space shrinks one step at a time.
The **last** segment is the one that selects content to inject; all earlier
segments are **scopes** that exist only to narrow where the last one is searched.

```text
Cart / Line / render
│       │      └── last segment: selects the `render` declaration
│       └── scope: found inside `Cart`, narrows the search to `Line`'s block
└── scope: found in the whole file, narrows the search to `Cart`'s block
```

A segment used as a scope must resolve to a block that **can contain** other
sections — a class, a method body, a statement block, or an anchor block. A
property or a `#region` cannot, so naming one mid-path is the `"…" is not a
container` error ([Errors](#errors)); a scope segment that matches nothing is
`no section named "…" in "…"`. A path may have at most 8 segments.

### When a name is declared more than once

One name may be declared several times at the same level, and the path **retries
them**: each candidate is tried in walk order, and the first one that can hold the
rest of the path wins. The retry is what makes members that live *outside* their
type addressable — a Rust `struct Cart` and its `impl Cart` blocks all answer to
`Cart`, so `Cart/add` passes over the struct (which holds `items`) and reaches
the method, and `Cart/remove` passes over the first impl to reach the second one.
Likewise two `impl` blocks for one type split a type's methods across siblings
without either becoming unaddressable.

The **last** segment is not retried: its first match in walk order is the
selection, exactly as [Sibling-first descent](#sibling-first-descent) says, so a
path is ambiguous only when the *scopes* disagree. When no candidate can hold the
rest of the path, the error is the one the first candidate produced, and a single
candidate — a `#region` named mid-path, say — still reports `"…" is not a
container`.

### Narrowing the scope

Because a parent segment scopes the search to the block it found, a child name
is searched in that smaller scope first — with the *same* matcher precedence and
sibling-first walk described in
[Searching one element in a scope](#searching-one-element-in-a-scope) — and only
within it. So `Cart/Line/render` looks for `render` inside `Line`, which is
itself inside `Cart`; it never finds a `render` elsewhere in the file. The scope
may be as small as a single method or `if` block: `dispatch/getUsers` searches
`getUsers` only inside the `dispatch` method's body, which is exactly how it
reaches the `if ("getUsers"…)` block that a bare `getUsers` would skip in favour
of a shallower sibling (see the [Worked examples](#worked-examples)).

Narrowing is what makes a name that is not unique in the file addressable: qualify
it with its ancestors, and the last segment resolves inside a scope where it *is*
unique.

### A bare name

A reference with no `/` is a path of **one** segment (rule 4): scope 0 is the
whole file, so the name is searched everywhere, at any depth — still sibling
first. `render` finds `Line.render` even though it is nested inside `Cart`,
because the walk descends to it once no shallower `render` matches. A bare name
is therefore shorthand for "the shallowest thing in this file with this name",
and it is the form that rule 5's shadowing guarantee protects: a method named
`doSomeAction` wins over an `if ("doSomeAction"…)` buried in an earlier method.

## Searching one element in a scope

*How a single path element is found once you are inside one scope. Rule 5, and
the matcher table rule 6 names.*

A **scope** is the block currently being searched. It is the whole file for a
bare name or the first segment of a path, and a narrowed block — a method body,
an inner class, a single `if` — for every later segment reached through a parent
([Narrowing the scope](#narrowing-the-scope)). Searching one element is the same
operation regardless of how big the scope is; only its extent differs.

Within one scope the lookup has two parts:

1. **Precedence, on this scope's own members.** The six matchers below are tried
   top to bottom, but only against the blocks that belong *directly* to this
   scope — matchers 5 and 6 never sweep deeper blocks. The first matcher that
   hits ends the search for this scope. Among equal-depth candidates the matcher
   order decides, and within one matcher the left-to-right source order does.
2. **Descent, one level at a time.** If no member of this scope matches, the walk
   descends exactly one level — into every block this scope contains, left to
   right — and retries the *same* element there, with the same precedence. It
   repeats depth by depth until a match is found or the scope's subtree is
   exhausted.

The consequence is rule 5: **a shallower candidate always beats a deeper one,
whatever the source order.** Nesting never shadows a sibling.

### Matcher precedence

Within one scope the matchers below are tried in this order; the first that
matches ends the lookup *for that scope*. In a single-segment reference that
also ends the whole search.

| # | Matcher | What it finds | Selects |
| --- | --- | --- | --- |
| 1 | **Region directive** | `#region <name>` … `#endregion` whose enclosing block is this scope (the whole file for a top-level region) | the lines strictly between the directives |
| 2 | **Class-like declaration** | `class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union` named `<name>` in this scope | the declaration, or the modified part |
| 3 | **Method / function** | a named method, constructor, function or arrow-valued property in this scope **that has a body** | the declaration, or the modified part |
| 4 | **Property** | a field or constant named `<name>` (`private int getUsers = 0;`, `static final String X = …`) | the whole statement |
| 5 | **Condition literal** | a statement block **in this scope** whose header line carries `"<name>"` (double-quoted, exact bytes) | the block, header line through closing brace |
| 6 | **Comment anchor** | a braced block **in this scope** whose first non-blank line is `//<name>` or `/*<name>*/` | the block, anchor comment through closing brace |

A class-like name beats a same-named constructor. Body-less members (interface
methods, `abstract` declarations) have nothing to inject and are skipped. A
`#region`/`#endregion` line is never an anchor, and a comment that is not the
first thing in the block is not an anchor either.

**The walk.** Within one scope the table is tried top to bottom against that
scope's own members — matchers 5 and 6 never sweep deeper blocks — and the first
match wins. When no scope at the current depth matches, the walker descends one
level, into every block those scopes contain left to right, and retries the same
segment there; so `render` finds `Line.render` even though it is nested inside
`Cart`, while a `doSomeAction` method is found before the same-named block
nested in a method that precedes it. For a multi-segment reference the same
descent happens one step at a time: once `Cart` matches, later segments are
searched **only inside `Cart`**, with the same precedence and the same
sibling-first descent.

### Sibling-first descent

The descent is breadth first over *depths*, matcher precedence *within* a scope.
That ordering is the whole point of rule 5, and it is what makes a declaration
targetable even when a same-named block sits inside an earlier sibling:

```java
class Svc {
    void bar() {                                  // comes sooner in the file
        if ("doSomeAction".equals(m)) { legacy(); }
    }
    void doSomeAction() { current(); }
}
```

`doSomeAction` is matched at `Svc`'s depth (matcher 3, a method), so it wins
before the walk ever descends into `bar`; the `if ("doSomeAction"…)` block is
reached only by naming its scope — `bar/doSomeAction`. Naming the enclosing
block is therefore how a deeper same-named section stays addressable, at any
depth. The [Worked examples](#worked-examples) pin both readings on
`Anchors.java`.

## Applying the modifiers

*How and where `+`, `++` and `-` apply. Rule 3.*

A modifier is one of `+`, `++`, `-`. It says **how much** of the matched block to
inject — the whole declaration, the body alone, the declaration with its
annotations, or with its doc comment too. Two facts govern where it may sit:

- It is **trailing**: it attaches to the very end of the whole reference.
- It binds to the **last segment** only. A scope segment may not carry one:
  `Cart/-Line/render` is an error, because `-` would modify the scope `Line`
  rather than the selected `render`.

And one fact governs what it does: a modifier never changes **which** block is
matched. Precedence and the sibling-first walk ([Searching one element in a
scope](#searching-one-element-in-a-scope)) run on the bare name; the modifier is
applied to the result. `getUsers` and `getUsers-` find the same block and differ
only in how much of it is taken.

### Where a modifier may appear

The canonical spelling is trailing: the modifier sits at the very end of the whole
reference. Four other positions are easy to mistake for one another, and a port
that conflates them will disagree with `lib/section.mjs` on `a/+b` or on `a++/b`:

| Written | Where it is | Result |
| --- | --- | --- |
| `add+`, `Cart/Line/render-` | trailing, at the very end | the modifier, joined to the last segment |
| `+add`, `++a/b`, `-a/b` | a prefix of the **whole reference** | moved to the end: `add+`, `a/b++`, `a/b-` |
| `a/-b`, `Cart/Line/-render` | a single `-` leading the **last segment** | moved to the end: `a/b-`, `Cart/Line/render-` |
| `Cart/-Line` | a single `-` leading the second of **two** segments | moved to the end: `Cart/Line-` |
| `a/+b`, `a/++b` | a `+` or `++` leading a **segment** — any segment, the last included | **error** |
| `a++/b`, `a-/b` | a trailing run on a segment that is **not** the last | collected, then applied to the last segment: `a/b++`, `a/b-` |
| `x/y+z`, `Cart/-Line/render` | anywhere else: a `+` inside a name, or a `-` on a segment that is neither the last nor the second of two | **error** |

**The two leading forms are not symmetric.** A single `-` may lead a segment when
that segment is the last one, or the second of two; `+` and `++` may appear in
front only as the detached prefix of the whole reference. So `a/-b` is legal and
`a/+b` is not, and neither is `a/++b`. The message for the rejected case is
`"+" may only modify the last path segment of "#a/+b"`, which reads oddly about a
segment that *is* last — hence the explicit note: the last-segment position is
checked for `-` only, and a `+` or `++` leading a segment is rejected outright.

**A modifier written mid-path is collected, not rejected.** `a++/b` parses and
means `a/b++`, because the parser gathers every modifier run it finds and applies
the collected one to the last segment. That is laxer than the canonical form and
is **not** pinned by `test/vectors/section-vectors.json`: a port that rejects
`a++/b` will still pass the vectors, but it will disagree with `lib/section.mjs`,
which is authoritative.

### Canonicalisation

The canonical form is **trailing**, so the parser normalises before it parses:

1. If the reference begins with `++`, `+` or `-`, detach that prefix and append it
   to the end.
2. After step 1, if the **second** segment begins with exactly one `-` and
   nothing was detached in step 1, detach that `-` and append it
   (`Cart/-Line` → `Cart/Line-`).
3. Walk the segments: a leading `-` on the last segment is detached and appended;
   a leading `+` or `++` on any segment is an error; a trailing run on any segment
   is detached and collected.
4. If more than one modifier was collected, they are combined: a `++`/`+` together
   with a `-` contradict and warn, and the positive one wins; the same modifier
   twice is an error (see
   [Contradictory modifiers](#contradictory-modifiers-are-a-warning)).
5. The result is the segments joined with `/`, followed by the modifier — or
   nothing when there was none.

| Accepted | Notes |
| --- | --- |
| `add`, `-add`, `+add`, `++add` | canonicalise to `add`, `add-`, `add+`, `add++` |
| `Cart/Line`, `Cart/Line-`, `Cart/-Line` | canonicalise to `Cart/Line`, `Cart/Line-`, `Cart/Line-` |
| `toString++`, `++toString` | same result |
| `Cart/Line/render-`, `Cart/Line/-render` | same result |
| `+a/b`, `++a/b`, `-a/b` | canonicalise to `a/b+`, `a/b++`, `a/b-` — the prefix belongs to the whole reference, not to the first segment |
| `a/-b` | canonicalises to `a/b-` |
| `a++/b`, `a-/b` | canonicalise to `a/b++`, `a/b-` (collected; see above) |

| Rejected (errors) | Message |
| --- | --- |
| `a/+b`, `a/++b`, `x/y+z` — a `+` or `++` leading a segment, or a `+` inside a name | `"+" may only modify the last path segment of "#<the reference as written>"` |
| `Cart/-Line/render` — a `-` leading a segment that is neither last nor the second of two | `"-" may only modify the last path segment of "#<the reference as written>"` |
| `a//b`, `a/`, `/a` — an empty path segment | `"#<the reference as written>" has an empty path segment` |
| `a+++`, `a---`, `a--` — more than one modifier | `"#<the reference as written>" carries more than one modifier` |

| Warned (see [Contradictory modifiers](#contradictory-modifiers-are-a-warning)) |
| --- |
| `a/b++-`, `a-/b++`, `a+-` |

### Modifiers

A trailing `++`, `+` or `-` selects how much of the match comes with it:

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

- **Declaration (class / method / property)** — four scopes: no modifier takes
  the whole declaration, `-` takes the body alone (reaching a property's
  initialiser), `+` takes the declaration with the annotations above it, `++`
  takes those with the doc comment above them. What counts as an *annotation*
  is the language's to say through its lexer (see
  [Tokenizers](#tokenizers)): an `@Decorator` or `#[attribute]` by default, a
  Haskell `name ::` type signature when that lexer supplies the test.
- **Region directive** — a region is already exactly its body, so the modifier is
  **ignored**: `add+` and `add` inject the same lines.
- **Condition literal, comment anchor** — the block is the unit. No modifier (or
  `+`) selects the block from its first line through its closing brace, where
  that first line is the anchor comment (for a comment anchor) or the statement
  header (for a condition literal). `-` selects the body strictly inside the
  braces. `++` on a comment anchor behaves like `+` (there is nothing to
  document).

### Contradictory modifiers are a warning

`++` and `-` contradict each other: `++` asks for the declaration *with* its
annotations and doc comment, `-` asks for the *body alone*. No single section is
both, so the reference is meaningless — but it is exactly what a human types
while refactoring, so it must not hold a whole document hostage.

| Case | Kind | Behaviour |
| --- | --- | --- |
| `++` with `-` (`a++-`, `a-++`, `a-/b++`) | Warning | The **`++` reading wins**; the `-` is dropped. Reported once as `inject-examples: warn: <doc>:<line>: "<marker>": "++" contradicts "-"; using "#<ref-without-the-minus>"`. The run continues, every block is written, and the run **exits 1** |
| `+` with `-` (`a+-`, `a-+`) | Warning | Same shape: contradictory, `+` wins |
| One modifier named twice (`a+++`, `a---`) | Error | Malformed, not contradictory — see [Errors](#errors) |
| A modifier anywhere but the end | Error | See [Canonicalisation](#canonicalisation) |

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

## Errors

Every message quotes the reference **exactly as the user wrote it** (call it
`<raw>`, `/`-separated, before normalisation) — `Cart/-Line` therefore appears
as written even though it normalises to `Cart/Line-`:

| Condition | Message shape |
| --- | --- |
| empty reference | `"#" names nothing` |
| empty segment, leading/trailing `/`, `//` | `"#<raw>" has an empty path segment` |
| `+`/`-` not at the end, after normalisation | `"<char>" may only modify the last path segment of "#<raw>"` |
| the same modifier twice or thrice (`a+++`, `a---`) | `"#<raw>" carries more than one modifier` |
| a detached leading modifier and a trailing one (`-a-`) | `"#<raw>" carries more than one modifier` |
| more than 8 segments | `"#<raw>" is deeper than 8 sections` |
| a segment matches nothing anywhere | `no "#region <name>" found, and no section named "<name>"` |
| a class/block is matched but path remains | `"<name>" is not a container` |
| a mid-path scope does not exist | `no section named "<name>" in "<previous>"` |

A missing, duplicate or unclosed `#region`/`#endregion` directive is reported by
the region directive itself (see `extractRegion`) and is not part of this
catalogue.

**One message shape is load-bearing.** Consumers match the single-segment "found
nothing" error against `/no "#region <name>" found/`, so that pattern must keep
holding.

## Worked examples

Both fixtures live in `test/fixtures/`. The first column is the reference text as
written by a user; the table quotes exact bytes where the result is a single
line, and describes the rest (read the fixture for the full bytes).

Given `test/fixtures/Example.java` — a `Cart` class containing an annotated,
documented `toString()` and an inner `Line` with a `render()`:

| Reference | Result |
| --- | --- |
| `toString` | `public String toString() { … }`, signature line through closing brace |
| `toString-` (or `-toString`) | `        return String.join(",", items);` |
| `toString+` (or `+toString`) | the declaration plus the `@Override` above it |
| `toString++` (or `++toString`) | that plus the `/** Add one item to this cart. */` doc comment |
| `Line` | the `public static class Line { … }` declaration, doc comment excluded |
| `Cart/Line` | identical to `Line` |
| `Cart/toString` | identical to `toString` |
| `Cart/Line/render` | the `render` declaration, line through closing brace |
| `Cart/Line/render-` (or `Cart/Line/-render`) | `            return name + " x" + quantity;` |
| `Cart/Line-` | `Line`'s body, without the class line or the closing brace |
| `Line/toString` | error: `no section named "toString" in "Line"` |
| `Cart/Line/render/extra` | error: `render` is not a container |
| `Cart/Cart` | error: `Cart` is not a container (a class is a scope, not a section) |

Given `test/fixtures/Anchors.java` — a method `dispatch` whose body holds an
`if ("getUsers".equals(methodName)) { … }` block, a `handler` method opened by
the anchor comment `{ //getUsers`, and an `other` method whose body opens with
`//getOrders`:

| Reference | Result |
| --- | --- |
| `getUsers` | the `handler` anchor block — `handler` is a member of the class scope, so it is matched before the `if` block nested inside `dispatch`, even though `dispatch` comes sooner |
| `getUsers-` | `handler`'s body only, the anchor comment excluded |
| `getOrders` | the `other` anchor block, for the same reason — it beats the `else if ("getOrders"…)` inside `dispatch` |
| `dispatch/getUsers` | the `if` block, header line through closing brace, reached explicitly via the method's scope |
| `dispatch/getOrders` | the `else if` segment, header line through closing brace |
| `handler/getUsers` | identical to `getUsers` |
| `other/getOrders` | identical to `getOrders` |
| `getusers` | error: case-sensitive exact-byte matching |

The rule that decided the first row, in its minimal shape — a method and a
same-named block inside an earlier method of the same class:

```java
class Svc {
    void bar() {                                  // comes sooner
        if ("doSomeAction".equals(m)) { legacy(); }
    }
    void doSomeAction() { current(); }
}
```

| Reference | Result |
| --- | --- |
| `doSomeAction` | the method — matched at the class's depth, before the walk descends into `bar` |
| `bar/doSomeAction` | the `if` block inside `bar`, reached explicitly via the method's scope |

## Not a parser

Matching has two layers, and the distinction between them is the whole
guarantee a port has to keep.

**Lexically it is exact, for a type this project tokenizes.** The per-type
lexers (see [Tokenizers](#tokenizers)) follow the language's own comment and
string syntax — template literals, text blocks, nested block comments, multiline
strings — so a name inside a comment or a string is never read as a declaration
and a `}` inside one never closes a block. A lexer is a scanner: it emits no
AST, consults no grammar, and **does not fail on valid source** — an
unterminated block comment or text block runs to the end of the file, an
unterminated single-line string to its newline. For a type no lexer claims, the
built-in default mask is a best-effort union of the comment and string spellings
in the wild, and that is where the residual risk lives: the Zig nested-comment
case in [Tokenizers](#tokenizers) is what a default mask gets wrong.

**Structurally it stays a heuristic, for every type.** No grammar and no type
information are consulted, and none are needed: reliable tokenizing plus bracket
counting plus declaration shapes is enough to resolve a reference, and a full
AST would add nothing the matcher uses. A matching step is:

1. Take the masked text — comments and string literals blanked to spaces of the
   same length, every newline offset preserved. Which engine produces it
   (a per-type lexer or the default) does not change this step or any result.
2. Track `{` / `}` over the masked text to know where each block opens and
   closes. Indentation closes blocks in brace-less scopes (Python, Ruby).
3. Recognise a declaration by **shape and name** — a `class`/`interface`/…
   keyword, a method header, a `field =` statement, a condition literal, an
   anchor comment — never by what the language's type system would say.
4. Offer the scopes of one depth, left to right, each in matcher-precedence
   order; the first match ends the lookup for the whole depth. Only a depth
   that yields nothing is descended (rule 5).

So the guarantee is one-directional, and consumers must not expect more of it
than that: valid source never breaks the lexical layer, but a construct the
shape rules do not recognise is simply not a declaration, however legal it is.
Names are matched exact-byte and case-sensitive throughout.

## Tokenizers

The only language-sensitive work in a match is **lexical**: blanking comments
and string literals, and locating the comments (for anchors and region
directives). Everything else — the block tree, matcher precedence, the
sibling-first walk, the modifier-on-last-segment rule and rendering — is
language-neutral and lives in `lib/section.mjs`, so every engine agrees on it.
That split is the **lexer seam**: `lib/section.mjs` accepts an optional *lexer*
that supplies the lexical facts and otherwise uses its own built-in mask.

A lexer is `{ name, mask(text), comments(text) }`, with three optional extras, all
of which default to the language-neutral reading when absent:

- `conditionLiterals(line, from)` — matcher 5's double-quoted-literal reader,
  the same across these languages and so usually inherited;
- `declarations(maskedLine)` — the declaration **shapes** this language adds to
  the generic ones, as `{ kind, name, headerFrom, line?, body? }` entries read
  from an already-masked line. This is where Ruby's paren-less `def add` and
  Haskell's `add x y = …` binding live: a shape, not a parse, and the same
  matcher precedence, walk and rendering apply to what it names;
- `annotationLine(line)` — what counts as the annotation directly above a
  declaration for the `+` scope, which for Haskell is the `name ::` type
  signature rather than a decorator.

The one hard contract is the **mask invariant**: `mask` returns a string of the
*same length* as the input with *every `\n` at the same offset* — comments and
strings become spaces, never disappear. `lib/section.mjs` asserts this once per
scan and names the offending lexer, so a bad engine fails loudly instead of
silently mislocating a brace.

**The default engine.** When no lexer is supplied — the file's type is unknown —
`lib/section.mjs` masks the file with its built-in `masked`/`commentsIn`, the
language-agnostic union of the comment and string spellings seen in the wild.
This is the authority: a reference resolves to the same bytes whether the type
is recognised or not, because a per-type lexer only changes *what is blanked*,
never how the blanked text is walked.

**The per-type lexers.** `index.mjs` selects a lexer by file extension through
`src/js/scanner/lexers.js` (`lexerFor(path)` → a lexer, or `undefined` for an
unknown type, which then takes the default engine). The lexers are built on a
shared one-pass tokenizer, `src/js/scanner/tokenizer.js`, parameterised by
syntax; three files carry the work:

| File | What it is |
| --- | --- |
| `syntaxes.js` | the language table: one object per language, all data |
| `tokenizer.js` | the one-pass engine: mask, comment spans, `if` clauses |
| `lexers.js` | extension → lexer, built from the table (`lexerFor`) |

A language that is not in the table takes the default engine — the same answer
an unknown type gets — so an entry earns its keep only where the union is wrong
for that language:

| Language | Extensions | The construct the entry exists for |
| --- | --- | --- |
| JavaScript / TypeScript | `js` `mjs` `cjs` `jsx` `ts` `tsx` `mts` `cts` | backtick templates |
| Java | `java` | text blocks `"""` |
| Zig | `zig` | **nested** block comments, `\\` multiline strings |
| Go | `go` | backtick raw strings (no escapes at all) |
| Rust | `rs` | nested block comments, `r#"…"#`, and `'a` (lifetime) versus `'a'` (char) |
| Python | `py` `pyi` | `"""` / `'''`, raw `r"…"` |
| C# | `cs` | verbatim `@"…""…"`, raw `"""` |
| Kotlin | `kt` `kts` | nested block comments, `"""` |
| PHP | `php` `phtml` | `<<<EOT` heredocs; `#[Attribute]` is not a `#` comment |
| Ruby | `rb` `rake` `gemspec` | `=begin` / `=end`, `<<~TAG` heredocs (`<<` stays a shift) |
| SQL | `sql` | `''` doubling, `$$ … $$` |
| Shell | `sh` `bash` `zsh` | `<<EOF` heredocs, `'…'` takes no escapes |
| VB | `vb` `bas` `vbs` | `""` doubling |
| Haskell | `hs` `lhs` | nested `{- -}` |
| YAML | `yaml` `yml` | `'…'` doubling, both quoted forms folding across lines |
| TOML | `toml` | `"""` / `'''` |
| INI | `ini` `cfg` `properties` | `;` and `#` comments |

The knobs an entry may use — several line-comment spellings, several block pairs
(`nested`, `lineStart`), string forms (`escape: 'doubling'`, `multiline`,
`lineScoped`, `boundary`, `hashes`, and `maxSpan`/`content` for a char literal
that must not be read as a lifetime) and `heredoc` — are declared in
`syntaxes.js` and described at the top of `tokenizer.js`. None of it reaches
`lib/section.mjs`: an entry changes **what is blanked**, never how the blanked
text is walked, which is why a new language cannot change an existing answer.

The three original languages keep their sample scanners — `scanJS.js`,
`scanJava.js`, `scanZig.js` — which export `lexerX` (the seam) plus the original
`scanX`/`visitX` pair. `scanX(source, target)` returns the `if` clauses whose
header carries `target` —
matcher 5's candidate list, as `{ type: 'if_clause', line, col, snippet }`.
`visitX(source, visitor)`
runs the same single pass and calls `visitor.comment`, `visitor.string` and
`visitor.ifClause`, so a file can be **enumerated** for a test or another use
without resolving anything; the resolver uses the very same pass through
`lexerX`.

A per-type lexer earns its keep where the default union is wrong. The clearest
case is Zig's nested block comments: the default mask is non-nesting, so in

```zig
/* outer /* inner */ fn decoy() void { x(); } */
```

it blanks only up to the first `*/`, leaking `fn decoy` out as a real
declaration — `decoy` then resolves to a commented-out method. `lexerZig` blanks
the whole nested comment, so `decoy` is not a section at all. The golden vectors
pin both readings (`z-decoy-hidden-by-nested-comment`).

Two more readings are pinned the same way, and they show the second half of a
lexer's job: `Cart.rb` resolves `Cart/add` only because the Ruby entry declares
the paren-less `def add` **and** the `end` that closes it, and `Store.hs`
resolves `+add` only because the Haskell entry declares the `add x y = …`
binding and says its `name ::` signature is the annotation the `+` scope takes.
A substitute engine has to supply those shapes too — the mask alone will not
reproduce those vectors.

**Substituting an engine.** An implementation is free to produce the mask and
comment spans from whatever it already has — a TreeSitter parse, an IDE index, a
compiler frontend — by handing `lib/section.mjs` (or its own resolver) a lexer
that satisfies the invariant. The substitute must keep the observable rules of
this document: exact-byte, case-sensitive names; a name inside a comment or
string is never a declaration; the matcher precedence; the sibling-first walk;
the modifier on the last segment only. `test/vectors/section-vectors.json` is
the conformance set it has to reproduce, gated by
`node tools/section-vectors.mjs --check`.

## The vendorable module boundary

`lib/section.mjs` is a single, dependency-free ES module that exports the
matching algorithm only. It must not import or reference `node:fs`, `node:path`,
`process`, `cli.mjs`, the `src/js/scanner/` lexers, or anything that reads the
disk or the environment — a consumer project vendors this one file. The per-type
lexers are *injected* (a `lexer` argument threaded from `index.mjs`), so the
module stays dependency-free while still resolving through a language engine; a
lexer that is not supplied leaves the built-in default engine. `index.mjs` owns
markers, fences, rule dispatch, the extension→lexer selection, gitignore and
document rewriting, and delegates only section resolution. A test asserts the
boundary, so it cannot rot.

A project adds a rule for another type with `options.regionRules` (see the
README's "Region rules by file type" section); a custom rule calls
`extractSection` for its type and otherwise reuses this module's matchers.

### What a resolution answers

A resolution is three answers rather than one, because the three consumers of it
need different ones — and answering the same question twice is how two answers
start to disagree:

| Field | What it is | Who needs it |
| --- | --- | --- |
| `text` | the bytes the section stands for | an injector, which writes them into a document |
| `startLine`, `endLine` | the **1-based inclusive** line span the text came from | a host, which navigates to a line rather than to bytes |
| `kind` | the matcher that found it: `region`, `declaration`, `property`, `condition` or `anchor` | anything that has to explain the answer, which is what makes a heuristic arguable instead of mysterious |

The span is computed from the same slice the text was made from, so it cannot
disagree with it; a section whose slice is empty still reports the line it would
start on, rather than a range that runs backwards. `resolveSection` is
`planSection(...).text` — the one-field shorthand for a caller that only wants the
bytes.

`test/vectors/section-vectors.json` pins all three for every resolution case, so a
port that agrees about the bytes but not about the span or the kind fails the
conformance gate rather than passing it quietly.
