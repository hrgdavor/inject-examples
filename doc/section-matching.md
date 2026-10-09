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

A section reference is a `/`-separated path of names. Only the **last** name may
carry a trailing `+`, `++` or `-`; a modifier on an earlier name has no meaning,
so it is an error. Three questions fully specify it, and this document keeps each
in its own section so they do not blur into one another:

| Question | In one line | Expanded in |
| --- | --- | --- |
| How does a path with one or more `/` resolve? | Every name except the last **narrows the scope** to the block it finds; only the **last** name selects content; a single name searches the whole file. | [Paths and scopes](#paths-and-scopes) |
| How is one name found inside a scope? | Inside that scope — the whole file, or a block a parent narrowed it to — the six matchers run in order against the scope's own members; the first match wins, and a shallower sibling always beats a deeper block. | [Searching one element in a scope](#searching-one-element-in-a-scope) |
| Where do `+`, `++` and `-` apply, and what do they do? | A modifier is **trailing** and binds to the **last** segment only; it chooses **how much** of the match to take, never **which** match. | [Applying the modifiers](#applying-the-modifiers) |

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
- [Heuristic, not a parser](#heuristic-not-a-parser)
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
3. The modifier is trailing and applies to the final segment. A **leading
   spelling is accepted too**: `-add`, `+add`, `++add` are normalised to `add-`,
   `add+`, `add++` (see [Canonicalisation](#canonicalisation)).
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

The canonical spelling is trailing. The parser also accepts a leading modifier
and normalises it before parsing, so `-add` and `add-` mean the same thing, and
a `-` on the second segment of a two-segment path is understood as belonging to
the end (`Cart/-Line` → `Cart/Line-`). After normalisation a `+` or `-` anywhere
except the very end is an error. The full accepted/rejected lists are in
[Canonicalisation](#canonicalisation).

### Canonicalisation

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
  takes those with the doc comment above them.
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

## Heuristic, not a parser

The matcher blanks comments and string literals and counts brackets. It does
**not** parse Java or TypeScript, and it makes no type-aware decisions. A
matching step is:

1. Walk the target's lines in order, with each line's comment and string-literal
   text blanked to spaces of the same length. This blanking is the lexer's job —
   the built-in default engine, or a per-type lexer when the file's type is known
   (see [Tokenizers](#tokenizers)); either way the mask preserves length and
   every newline offset.
2. Track `{` / `}` over the blanked text to know where each block opens and
   closes. Indentation closes blocks in brace-less scopes (Python, Ruby).
3. Offer the scopes of one depth, left to right, each in matcher-precedence
   order; the first match ends the lookup for the whole depth. Only a depth
   that yields nothing is descended (rule 5).

Consumers must not expect a real parser: declarations are found by
shape and by name, not by type information, and a name that occurs inside a
string or a comment is never a declaration.

## Tokenizers

The only language-sensitive work in a match is **lexical**: blanking comments
and string literals, and locating the comments (for anchors and region
directives). Everything else — the block tree, matcher precedence, the
sibling-first walk, the modifier-on-last-segment rule and rendering — is
language-neutral and lives in `lib/section.mjs`, so every engine agrees on it.
That split is the **lexer seam**: `lib/section.mjs` accepts an optional *lexer*
that supplies the lexical facts and otherwise uses its own built-in mask.

A lexer is `{ name, mask(text), comments(text) }`, with an optional
`conditionLiterals(line, from)` (matcher 5's double-quoted-literal reader, which
is the same across these languages and so usually inherited). The one hard
contract is the **mask invariant**: `mask` returns a string of the *same length*
as the input with *every `\n` at the same offset* — comments and strings become
spaces, never disappear. `lib/section.mjs` asserts this once per scan and names
the offending lexer, so a bad engine fails loudly instead of silently
mislocating a brace.

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
syntax; the three language scanners expose it:

| File | Exports | Covers |
| --- | --- | --- |
| `scanJS.js` | `lexerJS`, `scanJS(source, target)`, `visitJS(source, visitor)` | JS/TS — `'` `"` and backtick templates |
| `scanJava.js` | `lexerJava`, `scanJava`, `visitJava` | Java — `"` `'` and text blocks `"""` |
| `scanZig.js` | `lexerZig`, `scanZig`, `visitZig` | Zig — `"` and `\\` multiline strings, **nested** `/* /* */ */` comments |

`scanX(source, target)` returns the `if` clauses whose header carries `target` —
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
