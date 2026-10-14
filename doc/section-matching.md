# File-section matching

`doc/section-matching.md` is the normative specification of the
`<section-reference>` that follows `#` in a marker fragment. It is
written for an implementer who has never seen this repository: every rule needed
to match a reference to a piece of a target file is here, and only here lives
the definition of *what a section reference is*.

> **Scope, boundary and conformance obligations live in
> [`doc/rfc/section-mapping.md`](rfc/section-mapping.md) (RFC 1, status
> `0.9-rc`).** This document is normative for *how a reference resolves*; RFC 1
> is normative for what a mapper is, the operations it exposes, the two error
> categories, the first line a selection starts on, and the suite a new
> implementation is measured against. The two **use cases** built on it have
> specs of their own — [`rfc/code-jump.md`](rfc/code-jump.md) (RFC 2,
> navigation, best-effort in an editor) and
> [`rfc/inject-examples.md`](rfc/inject-examples.md) (RFC 3, injection, strict)
> — and both are normative only for what they do *after* a resolve, never for
> how one happens. Read RFC 1 first if you are writing a port.

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

A section reference is a `,`-separated list of **selectors**, and every selector
is one of two things: a `/`-separated path, or a **line range**
(`L40:12-L44:3`). A path's segments are **names**, except that its **last**
segment may be a modifier — `+`, `++` or `-` — which says how much of the match
comes along; a modifier anywhere else is an error, and there is nothing to
normalise because it is written where it means something. Four questions fully
specify it, and this document keeps each in its own section so they do not blur
into one another:

| Question                                               | In one line | Expanded in                                                           |
| ------------------------------------------------------ | ----------- | --------------------------------------------------------------------- |
| How do several selectors combine?                      | A reference is a list; each selector contributes its own text, and the pieces are joined with a newline in the order written. | [Selectors](#selectors) |
| How does a path with one or more `/` resolve?          | Every name except the last **narrows the scope** to the block it finds; only the **last** name selects content; a single name searches the whole file. | [Paths and scopes](#paths-and-scopes) |
| How is one name found inside a scope?                  | Inside that scope — the whole file, or a block a parent narrowed it to — the six matchers run in order against the scope's own members; the first match wins, and a shallower sibling always beats a deeper block. | [Searching one element in a scope](#searching-one-element-in-a-scope) |
| Where do `+`, `++` and `-` apply, and what do they do? | A modifier is the **last segment of a path**, so it belongs to the selector that path carries; it chooses **how much** of the match to take, never **which** match. | [Applying the modifiers](#applying-the-modifiers) |

[Grammar](#grammar) gives the syntax, [Selectors](#selectors) the composition and
the line range, and [The six rules](#the-six-rules) the compact normative
statement; the topics expand them, and the tables beneath each topic are the
detail.

## Contents

- [Grammar](#grammar)
- [Selectors](#selectors)
  - [Line ranges](#line-ranges)
  - [Several selectors](#several-selectors)
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
  - [Two modifiers on one path is an error](#two-modifiers-on-one-path-is-an-error)
- [Envelopes](#envelopes)
- [Errors](#errors)
- [Worked examples](#worked-examples)
- [Not a parser](#not-a-parser)
- [Tokenizers](#tokenizers)
- [The vendorable module boundary](#the-vendorable-module-boundary)

## Grammar

```text
section-reference := selector ( ',' selector )*     ; at most 8 path segments per selector
selector          := path
                   | line-range
path              := segment ( '/' segment )*
segment           := name | modifier | envelope-mark
name              := token
modifier          := '++' | '+' | '-'               ; only as the last segment of a path
envelope-mark     := '^' | '$'                      ; only as the last segment of a path
token             := /[A-Za-z_$][\w$-]*/ | 'new'    ; `-` is a name character, `+` never is
line-range        := point [ '-' point ]
point             := 'L' digits [ ':' digits ]      ; lines and columns from 1
```

A `token` contains no `/`, `+`, `,` or whitespace. A name may contain `-`
(`item-list`, `update-document-test`, and a CSS custom property's `--brand`) and
may be dotted (`Foo.Bar` is one token, because dotted names occur in JS/TS code);
dots are never path separators. The three **modifier** spellings are segments of
their own, not suffixes: `render/-` is a path of two segments whose last one is a
modifier, which is why `+` can be excluded from every name. The two **envelope
marks** are whole segments in the same way, and only these two readings: `foo$` is
the name `foo$`, while `foo/$` is a path that ends in a mark
([Envelopes](#envelopes)). A selector that opens
`L<digit>` is a line range or a typo, never a name — which is what reserves the
`L<digit>` spelling — while `Lx` is an ordinary name. The syntax alone says
nothing about resolution — the rules below do, and each is expanded in its own
topic.

## Selectors

A reference is a **list**: one or more selectors separated by `,`. Each selector
resolves on its own, to its own text and its own line span, and the pieces are
joined with a newline in the order they were written; the reference's
`startLine`/`endLine` are the outermost bounds of the pieces and its `ranges` is
one entry per selector. A single selector is the degenerate case of a list of
one, and every rule of this document about a path applies to a selector of that
list: the comma is structure, not part of a name, and an empty selector (`a,`,
`,a`, `a,,b`) is the `has an empty selector` error.

Every selector of a reference must resolve. A list is not a fallback — the first
missing piece fails the whole reference, naming the selector that failed.

### Line ranges

A selector may name lines instead of a block, for a file whose structure the
matchers cannot see:

| Reference      | Selects                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `L40`          | line 40 alone, without its newline                                             |
| `L40:12`       | line 40 from its twelfth character to the end of the line                      |
| `L40-L44`      | lines 40 through 44, inclusive, verbatim                                       |
| `L40:12-L44:3` | from character 12 of line 40 to character 3 of line 44, inclusive at both ends |

Lines and columns are counted **from 1**, both ends are inclusive, and an
endpoint with no column runs to the end of its line. `L<line>` and
`L<line>:<column>` are the only endpoint spellings: `L40:` ("to the end of the
line") is malformed, because writing the point alone already says that.

The text is the file's own bytes (LF-normalised, as every scan is) with nothing
added and nothing rendered, and the span is exactly the lines and columns asked
for. Anything the file does not have is an error, never a clamp — `L31` in a
30-line file is `"#L31": the file has 30 line(s)`, and a column past the end of
its line is `line 13 has 39 character(s)`. A range that silently became a
different range is the drift a line reference is written to avoid.

A line range has no modifier at all: there is nothing about a verbatim slice of
lines for `+` to widen, and `-` belongs to the range's own spelling. A path does
not open a range, so a modifier written after one — `L40/+`, `L40-L44/-` — is not
a range at all (`is not a line range`), and a range cannot be the subject of one
either.

### Several selectors

Each selector carries its own modifier, because the modifier is part of that
selector's path and there is no path outside one: `add/-,render/++` is two
selectors that each say what they mean, and neither can contradict the other.
Two modifiers on *one* path is a different thing — an error, not a reading to
choose between — because the modifier describes the selection and only the last
segment is where a selection ends (see
[Where a modifier may appear](#where-a-modifier-may-appear)).

## The six rules

The grammar, as six rules. Each violated below is an error (see
[Errors](#errors)); rule 5 is the walk order other documents cite:

1. `/` is not a package path or an FQDN. It only descends into nested blocks
   *inside the one target file*.
2. Only the last segment selects content to inject. Earlier segments are
   **scopes**: each must resolve, and each later segment is looked up only
   inside the block the previous segment found.
3. The modifier is a **segment of its own** and may be only the **last** one of a
   path: `render/++`, `Cart/Line/-`, `getUsers/+`. It is never a suffix and never
   a prefix, so `render-` is the name `render-` (which no file declares) and
   `+render` is the old prefix form, rejected with a message naming the spelling
   that works. A modifier written anywhere but the end — `a/++/b`, `a/++/-` — is
   the `may only modify the last path segment` error, and a segment that is
   nothing but modifiers (`a/+++`) is
   [more than one modifier](#two-modifiers-on-one-path-is-an-error).
4. A bare name is a path of one segment: it searches the whole file, at any
   depth.
5. First match wins, walking **sibling first**: every scope at one depth is
   searched, left to right, before the walk descends into any block they
   contain. A declaration in a scope is therefore never shadowed by a same-named
   block nested inside an earlier sibling — `doSomeAction` resolves to the
   method, not to an `if ("doSomeAction"…)` inside a method that comes sooner in
   the file. A modifier never changes which match is found.
6. The reference `add` matches a `#region add` directive, a `void add()` method,
   a `String add` property, a `class add`, a `//add` anchor, or an
   `if ("add".equals(...))` block — whichever the walk finds first, the
   shallowest candidate winning.

A **line-range selector** is resolved by none of the six: it names lines, and
the lines it names are the selection (see [Line ranges](#line-ranges)).

A region directive is a *comment* in the language's own spelling, so the `#` of
`#region` is the directive and the prefix that makes it a comment is whatever the
language writes — `// #region add`, `# #region add`, `' #region add`,
`-- #region add`, `; #region add`, `<!-- #region add -->` or `/* #region add */`.
A line that is not a comment takes the bare `#region` spelling only, so prose that
says `region add` is prose.

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

One name may be declared several times at the same level, and a path with more
segments **retries them**: each candidate is tried in walk order, and the one
that can hold the rest of the path wins. The retry is what makes members that
live *outside* their type addressable — a Rust `struct Cart` and its `impl Cart`
blocks all answer to `Cart`, so `Cart/add` passes over the struct (which holds
`items`) and reaches the method, and `Cart/remove` passes over the first impl to
reach the second one. Likewise two `impl` blocks for one type split a type's
methods across siblings without either becoming unaddressable.

**A name that several blocks answer to is ambiguous, and ambiguity is an error,
never a guess.** The selection is the *last* segment, and nothing follows it to
say which candidate was meant, so

```
"add" is declared 2 times; names must be unique
"Cart" is declared 3 times; names must be unique
```

is the answer rather than the first match in walk order. The reason is the whole
point of the tool: an injected block is copied into a document, so a silent
choice between two `add` methods ships a lie that no reader can see. The
heuristics may be approximate about *what* a block is; they may not be
approximate about *which* block a reference named.

Two cases are not ambiguity:

- **A deeper path**, which does the choosing: `Cart/add` names the holder, and
  only one candidate holds `add`. That is why the retry exists, and it is the
  fix for the error above.
- **Descents that all succeed.** If two candidates can both hold the rest of the
  path, the path does not distinguish them and the reference fails the same way,
  one level down.

When no candidate can hold the rest of the path, the error is the one the first
candidate produced, and a single candidate — a `#region` named mid-path, say —
still reports `"…" is not a container`.

The same rule binds every key format: a duplicated YAML key, TOML table or INI
section is an error naming the key and the count (`"server": key "server" appears
2 times; names must be unique`), because those rules select a key the same way.
JSON is the one exception, and it is the parser's: `JSON.parse` silently keeps the
last of two identical keys, so the duplicate is gone before a rule can see it.

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

"The shallowest" is a depth, not a tie-break: two candidates at the *same* depth
both answer to the name, and the reference then has no answer
([When a name is declared more than once](#when-a-name-is-declared-more-than-once)).
A path spells which one.

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
   Two candidates at one depth that *the same* matcher finds are not a tie to
   break but an ambiguity to report, at the depth where they are found.
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

| #   | Matcher                    | What it finds                                                                                    | Selects                                                    |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | **Region directive**       | `#region <name>` … `#endregion` whose enclosing block is this scope (the whole file for a top-level region) | the lines strictly between the directives       |
| 2   | **Class-like declaration** | `class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union` named `<name>` in this scope | the declaration, or the modified part             |
| 3   | **Method / function**      | a named method, constructor, function or arrow-valued property in this scope **that has a body** | the declaration, or the modified part                      |
| 4   | **Property**               | a variable named `<name>` — a field, a constant, or one a block or a signature declares (`private int getUsers = 0;`, `int count;`, `int first = 1, second = 2;`, `String title` in `void render(String title)`, an enum's `CALL,`) | the whole statement, or the text that declares a parameter |
| 5   | **Condition literal**      | a statement block **in this scope** whose header line carries `"<name>"` (double-quoted, exact bytes) | the block, header line through closing brace          |
| 6   | **Comment anchor**         | a braced block **in this scope** whose first non-blank line is `//<name>` or `/*<name>*/`        | the block, anchor comment through closing brace            |

A class-like name beats a same-named constructor. Body-less members (interface
methods, `abstract` declarations) have nothing to inject and are skipped. A
`#region`/`#endregion` line is never an anchor, and a comment that is not the
first thing in the block is not an anchor either. A header may span lines — see
[A declaration's header may span lines](#not-a-parser) — and the closing bracket
of a wrapped parameter list is where the matchers look for it, not on the line
the name is written on.

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

A modifier is one of `+`, `++`, `-`, and it is a **segment of a path**. It says
**how much** of the matched block to inject — the whole declaration, the body
alone, the declaration with its annotations, or with its doc comment too. Two
facts govern it:

- It is the **last segment** of the path. Nothing follows it: `render/++` is a
  path of two segments, the second of which is the modifier, and `a/++/b` is the
  `may only modify the last path segment` error.
- A modifier applies to the **selector whose path carries it**. Each selector of
  a list has its own path, so `add/-,render/++` is two selectors that each say
  what they mean, and two modifiers on *one* path (`a/++/-`) is an error rather
  than a reading to choose between.

And one fact governs what it does: a modifier never changes **which** block is
matched. Precedence and the sibling-first walk ([Searching one element in a
scope](#searching-one-element-in-a-scope)) run on the names; the modifier is
applied to the result. `getUsers` and `getUsers/-` find the same block and differ
only in how much of it is taken.

A **line-range** selector takes no modifier at all: `L40` is a whole selector, so
`L40/+` is not a range (it is the `is not a line range` error) and a range cannot
follow a modifier either. There is nothing about a verbatim slice of lines for a
scope to widen.

### Where a modifier may appear

Nowhere but the end of a path, and as a whole segment. The spellings that make
that visible:

| Written                                      | Read as                                          | Result                                                          |
| -------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `add`, `Cart/Line`, `Cart/Line/render`       | paths of names                                   | the declaration itself                                          |
| `add/-`, `Cart/Line/-`, `Cart/Line/render/-` | a modifier as the last segment                   | that block's body                                               |
| `add/+`, `add/++`                            | a modifier as the last segment                   | the declaration with its annotations, then with its doc comment |
| `add/-,render/++`                            | two selectors, each with its own path            | two pieces, each taking its own scope                           |
| `add-`, `render-`                            | **names** — a `-` between name characters is one | `no section named "add-"`                                       |
| `add++`, `render+`                           | a `+` inside a name                              | error: `"++" is a path segment now; write "#add/++"`            |
| `+add`, `++add`, `-add`                      | a modifier as the *first* segment                | error: it follows the path, not leads it                        |
| `a/++/b`, `a/-/b`                            | a modifier mid-path                              | error: `may only modify the last path segment`                  |
| `a/++/-`, `a/-/++`                           | two modifiers on one path                        | error, naming the first as misplaced                            |
| `a/+++`, `a/---`                             | a segment that is nothing but modifiers          | error: `carries more than one modifier`                         |
| `a/--`, `--brand`                            | names, in every segment                          | a CSS custom property is a name                                 |
| `L40`, `L40-L44`                             | a line range                                     | unchanged; `L40/+` and `L40-L44/-` are not ranges               |

**A `+` is never part of a name.** That is the one character the grammar spends
to keep names and modifiers unmistakable: a `-` may sit inside a name, a `+` may
not, so `add++` can only ever have meant a modifier and its message says which
spelling to write. A reference whose modifier was written the old way is
therefore an **error** with guidance, never a silent miss:

```text
"++" is a path segment now; write "#add/++"
"+" is a path segment now; it follows the path, as "#<path>/+"
```

### Canonicalisation

There is nothing to canonicalise: the modifier is written where it means
something, so the canonical spelling of a reference is its parsed path with its
modifier segment re-joined:

| Written                                    | Canonical                                                  |
| ------------------------------------------ | ---------------------------------------------------------- |
| `add`, `add/-`, `add/+`, `add/++`          | unchanged                                                  |
| `Cart/Line`, `Cart/Line/-`, `Cart/Line/++` | unchanged                                                  |
| ` a , b `                                  | `a,b` (the whitespace around a selector is not part of it) |
| `L40-L44`, `L40:12-L44:3`                  | unchanged (a range has no modifier to move)                |

| Rejected (errors)                                                    | Message                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `a/++/b`, `a/+/b`, `a/-/b` — a modifier that is not the last segment | `"<the modifier>" may only modify the last path segment of "#<the reference as written>"` |
| `add++`, `add+`, `+add`, `a/b++` — the old suffix or prefix spelling | `"<the modifier>" is a path segment now; write "#<path>/<the modifier>"`                  |
| `a/+++`, `a/---` — more than one modifier on one segment             | `"#<the reference as written>" carries more than one modifier`                            |
| `a//b`, `a/`, `/a` — an empty path segment                           | `"#<the reference as written>" has an empty path segment`                                 |
| `L40-`, `L40:x`, `L40-L44/+` — a range that is not one               | `"#<the reference as written>" is not a line range; write L<line> or L<line>:<column>`    |
| `L0`, `L1:0` — a line or column below 1                              | `"#<the reference as written>" counts lines and columns from 1`                           |
| `L44-L40` — a range that ends before it starts                       | `"#<the reference as written>" ends before it starts`                                     |
| `add,`, `,add`, `add,,render` — an empty selector                    | `"#<the reference as written>" has an empty selector`                                     |

### Modifiers

The modifier segment selects how much of the match comes with it:

| Reference                    | Injection                                                         |
| ---------------------------- | ----------------------------------------------------------------- |
| `Cart/Line`                  | the whole inner class declaration                                 |
| `Cart/Line/-`                | `Line`'s body only (no class line, no closing brace)              |
| `Cart/toString/+`            | `toString`'s declaration including the annotations above it       |
| `Cart/toString/++`           | declaration, its annotations, and the doc comment above them      |
| `getUsers/-`                 | the body inside the brace pair                                    |
| `getUsers/+` / `getUsers/++` | the header line, plus a leading doc/annotation block for `++`     |
| `count/-` (property)         | the initialiser expression, or the declaration when there is none |

Modifier semantics per match kind:

- **Declaration (class / method / property)** — four scopes: no modifier takes
  the whole declaration, `-` takes the body alone (reaching a property's
  initialiser), `+` takes the declaration with the annotations above it, `++`
  takes those with the doc comment above them. What counts as an *annotation*
  is the language's to say through its lexer (see
  [Tokenizers](#tokenizers)): an `@Decorator` or `#[attribute]` by default, a
  Haskell `name ::` type signature when that lexer supplies the test.
- **Region directive** — a region is already exactly its body, so the modifier is
  **ignored**: `add/+` and `add` inject the same lines.
- **Condition literal, comment anchor** — the block is the unit. No modifier (or
  `+`) selects the block from its first line through its closing brace, where
  that first line is the anchor comment (for a comment anchor) or the statement
  header (for a condition literal). `-` selects the body strictly inside the
  braces. `++` on a comment anchor behaves like `+` (there is nothing to
  document).

### Two modifiers on one path is an error

A path has one modifier, because a modifier describes the selection and a
selection ends where the path does:

| Case                                                       | Kind    | Behaviour                                                             |
| ---------------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| A modifier before the last segment (`a/++/b`, `a/-/b`)     | Error   | `"<the modifier>" may only modify the last path segment of "#a/++/b"` |
| Two modifiers where one is last (`a/++/-`, `a/-/++`)       | Error   | The first is misplaced, and the message names it                      |
| A segment that is nothing but modifiers (`a/+++`, `a/---`) | Error   | `"#a/+++" carries more than one modifier`                             |
| A modifier on each of two selectors (`add/-,render/++`)    | Neither | Each path carries its own; two selectors are not one path             |

There is no **warning** anywhere in this grammar: a reference either resolves or
fails, and the run never exits 1 with every block written. Nothing is guessed,
so nothing has to be reported as a guess.

## Envelopes

*How a member is selected together with the declaration that holds it. Rules 1
and 2.*

A method copied out of a class reads as a fragment: indented under nothing, with
no sign of the type it belongs to. An **envelope** is that declaration's own first
and last lines, taken verbatim around whatever is selected from inside it, and it
is written with two marks at the ends of the path that names the holder:

```text
[Inventory.java#Inventory/^,toString,$]
                     │         │      └── the class's closing line
                     │         └── the member, read inside the class
                     └── the class's declaration line and the line its body opens on
```

- `^` is the **head**: the declaration line of the block its path names, through
  the line that block's body opens on — so a wrapped signature comes whole, and a
  block whose body opens below its header brings that line with it.
- `$` is the **tail**: the line the same block ends on, which is the closing
  brace, the `end`, or the line a block with no closing line ends on.

The head and the tail are **one envelope**, not two selections: they must be the
first and the last selector, the mark is the last segment of its path, and the
parent may be named on **either** end. The other end then inherits it, which is
what keeps a reference short:

| Written                                   | Reads as                                               |
| ----------------------------------------- | ------------------------------------------------------ |
| `Cart/^,toString,$`                       | `Cart`'s head, `toString`, `Cart`'s tail               |
| `Cart/^,Cart/toString,Cart/$`             | The same three, with the parent named every time       |
| `Cart/^,toString,Cart/$`                  | The same three, the parent named on each mark          |
| `Cart/^,toString/-,Cart/$`                | `Cart`'s head, `toString`'s **body**, `Cart`'s tail    |
| `Cart/^,Line/render,Cart/$`               | `Cart`'s head, a method of its nested `Line`, its tail |

**What sits between the marks is read inside the block they name.** The parent is
written once, and every selector between the marks is scoped to it, so a member
that is not unique in the file — `toString` — needs no qualification. A selector
that *does* name the parent is left as written, because saying it again says the
same thing: the long form above resolves byte for byte like the short one.

**The marks retry a name several blocks answer to**, exactly as a path does. A
Rust type is a `struct` beside one or more `impl` blocks, all of them answering to
the type's name, so `Cart/^,add,$` is the `impl` that holds `add` and
`Cart/^,remove,Cart/$` is the one that holds `remove` — the member between the
marks is what chooses. This is the one place an envelope is *not* ambiguous where
a bare name would be: `#Cart` on its own is the
[ambiguity error](#when-a-name-is-declared-more-than-once), while
`Cart/^,…,Cart/$` names the candidate the rest of the reference fits. A name no
candidate can hold is still `no section named "…" in "…"`, and a name that is not
a container at all is `"…" is not a container`.

An envelope is **verbatim**, like every other code selection: the head and the
tail are the file's own lines, indentation included, so the pieces join into text
that reads as the declaration with the selected member still inside it. The
answer's `ranges` are one range per selector, so a host can highlight the head,
the member and the tail as three places — or merge them, since the envelope's
bounds already span the block.

An envelope **composes** with the rest of the grammar: a line range may take the
place of the member (`Cart/^,L12-L14,Cart/$`), and a modifier may select less of
one (`toString/-`). What an envelope may not be is *nested*: one reference has one
`^` and one `$`, so a second pair inside the first is the error below rather than
a deeper reading. Selecting a nested member inside its own block's envelope is
written as one pair for the outer block, as the fourth row above shows.

## Errors

Every message quotes the reference **exactly as the user wrote it** (call it
`<raw>`, `/`-separated, never normalised — there is nothing to normalise, since
the modifier is written where it means something). Where the message names a
selector, it is that selector as written (`L40-`), not the whole reference:

| Condition                                                                             | Message shape                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| empty reference                                                                       | `"#" names nothing`                                                                  |
| empty segment, leading/trailing `/`, `//`                                             | `"#<raw>" has an empty path segment`                                                 |
| a modifier that is not the last segment (`a/++/b`, `a/-/b`)                           | `"<the modifier>" may only modify the last path segment of "#<raw>"`                 |
| the old suffix or prefix spelling (`add++`, `+add`)                                   | `"<the modifier>" is a path segment now; write "#<path>/<the modifier>"`             |
| more than one modifier on one segment (`a/+++`, `a/---`)                              | `"#<raw>" carries more than one modifier`                                            |
| more than 8 segments                                                                  | `"#<raw>" is deeper than 8 sections`                                                 |
| an empty selector (`a,`, `,a`, `a,,b`)                                                | `"#<raw>" has an empty selector`                                                     |
| a range that is not one, or one carrying a modifier (`L40-`, `L40:x`, `L40-L44/+`)    | `"#<selector>" is not a line range; write L<line> or L<line>:<column>`               |
| a line or column below 1 (`L0`, `L1:0`)                                               | `"#<selector>" counts lines and columns from 1`                                      |
| a range that ends before it starts (`L44-L40`)                                        | `"#<selector>" ends before it starts`                                                |
| a line the file does not have (`L31` in a 30-line file)                               | `"#<selector>": the file has <n> line(s)`                                            |
| a column past the end of its line                                                     | `"#<selector>": line <n> has <m> character(s)`                                       |
| a line range in a rule that renders its selection (`.json`, `.yaml`, `.toml`, `.ini`) | `"#<selector>" is a line range, which only the code rule reads; "<rule>" reads keys` |
| a segment matches nothing anywhere                                                    | `no "#region <name>" found, and no section named "<name>"`                           |
| a class/block is matched but path remains                                             | `"<name>" is not a container`                                                        |
| a mid-path scope does not exist                                                       | `no section named "<name>" in "<previous>"`                                          |
| two blocks at one level answer to the selection's name                                | `"<name>" is declared <n> times; names must be unique`                               |
| a key, table or section appears twice (YAML, TOML, INI)                               | `"<path>": key "<key>" appears <n> times; names must be unique` (the `describe` names the format's own thing: `key`, `table "[a]"`, `section "[a]"`) |
| two CSS rules at one level answer to one selector                                     | `"<selector>" matches <n> blocks; the name must be unique`                           |
| an envelope mark written alone (`Cart/^`, `Cart/$`)                                   | `"#Cart/^": a lone "^" has nothing to close` (and `to open` for `$`)                 |
| an envelope whose ends are not first and last                                         | `"#<raw>": an envelope is "^" first and "$" last, around what they open and close`   |
| more than one `^` or more than one `$`                                                | `"#<raw>": an envelope has one "^" and one "$"`                                      |
| an envelope whose ends name different blocks                                          | `"#<raw>": "^" opens "<a>" and "$" closes "<b>"; they must be the same block`        |
| neither end names a block (`^,$`)                                                     | `"#<raw>": neither "^" nor "$" names a block, so there is nothing to open or close`  |

A missing, duplicate or unclosed `#region`/`#endregion` directive is reported by
the region directive itself (see `extractRegion`) and is not part of this
catalogue.

There are **no warnings** in this grammar. Every message above is an error, and a
reference either resolves or fails; a scope modifier written twice on one path is
malformed rather than two readings to choose between, and a modifier on a
`#region` or a line range is simply ignored, because neither is a path that could
carry one.

**One message shape is load-bearing.** Consumers match the single-segment "found
nothing" error against `/no "#region <name>" found/`, so that pattern must keep
holding.

## Worked examples

Both fixtures live in `test/fixtures/`. The first column is the reference text as
written by a user; the table quotes exact bytes where the result is a single
line, and describes the rest (read the fixture for the full bytes).

Given `test/fixtures/Example.java` — a `Cart` class containing an annotated,
documented `toString()` and an inner `Line` with a `render()`:

| Reference                     | Result                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `toString`                    | `public String toString() { … }`, signature line through closing brace                            |
| `toString/-`                  | `        return String.join(",", items);`                                                         |
| `toString/+`                  | the declaration plus the `@Override` above it                                                     |
| `toString/++`                 | that plus the `/** Add one item to this cart. */` doc comment                                     |
| `Line`                        | the `public static class Line { … }` declaration, doc comment excluded                            |
| `Cart/Line`                   | identical to `Line`                                                                               |
| `Cart/toString`               | identical to `toString`                                                                           |
| `Cart/Line/render`            | the `render` declaration, line through closing brace                                              |
| `Cart/Line/render/-`          | `            return name + " x" + quantity;`                                                      |
| `Cart/Line/-`                 | `Line`'s body, without the class line or the closing brace                                        |
| `Line/toString`               | error: `no section named "toString" in "Line"`                                                    |
| `Cart/Line/render/extra`      | error: `render` is not a container                                                                |
| `Cart/Cart`                   | error: `Cart` is not a container (a class is a scope, not a section)                              |
| `L12-L14`                     | the same three lines as `toString`, byte for byte                                                 |
| `L13`                         | the same line as `toString/-`                                                                     |
| `L13:9`                       | `        return String.join(",", items);` from its ninth character: `return String.join(",", items);` |
| `L4:8-L4:21`                  | `java.util.List` — the import's class, from column to column                                      |
| `L31`                         | error: `"#L31": the file has 30 line(s)`                                                          |
| `toString,L1-L3`              | `toString`'s three lines, then the first three lines of the file, joined with a newline           |
| `toString,L16-L20`            | the `toString` declaration and the opening of the `Line` class — two pieces, two `ranges` entries |
| `add/-,render/++`             | the body of `add` and the annotated declaration of `render`, each taking the modifier written on its own path |
| `Cart/^,toString,$`           | `Cart`'s head, the three lines of `toString`, then `Cart`'s tail — three pieces, three `ranges` entries |
| `Cart/^,Cart/toString,Cart/$` | byte for byte the same as the row above, with the parent named on every selector                  |
| `Cart/^,Line/render,Cart/$`   | `Cart`'s head, `Line`'s `render`, `Cart`'s tail — the member is read inside `Cart`                |
| `Cart/^,L12-L14,Cart/$`       | the same text, with a line range in place of the member                                           |
| `Cart/^`                      | error: `"#Cart/^": a lone "^" has nothing to close`                                               |
| `Cart/^,Line/render,Line/$`   | error: `"#Cart/^,Line/render,Line/$": "^" opens "Cart" and "$" closes "Line"; they must be the same block` |

A reference of several selectors answers with one `text` — the pieces joined by a
newline — and a `ranges` list with one entry per selector, so a consumer can
point at each piece instead of at everything between them.

Given `test/fixtures/Anchors.java` — a method `dispatch` whose body holds an
`if ("getUsers".equals(methodName)) { … }` block, a `handler` method opened by
the anchor comment `{ //getUsers`, and an `other` method whose body opens with
`//getOrders`:

| Reference            | Result                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `getUsers`           | the `handler` anchor block — `handler` is a member of the class scope, so it is matched before the `if` block nested inside `dispatch`, even though `dispatch` comes sooner |
| `getUsers/-`         | `handler`'s body only, the anchor comment excluded                                           |
| `getOrders`          | the `other` anchor block, for the same reason — it beats the `else if ("getOrders"…)` inside `dispatch` |
| `dispatch/getUsers`  | the `if` block, header line through closing brace, reached explicitly via the method's scope |
| `dispatch/getOrders` | the `else if` segment, header line through closing brace                                     |
| `handler/getUsers`   | identical to `getUsers`                                                                      |
| `other/getOrders`    | identical to `getOrders`                                                                     |
| `getusers`           | error: case-sensitive exact-byte matching                                                    |

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

| Reference          | Result                                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| `doSomeAction`     | the method — matched at the class's depth, before the walk descends into `bar` |
| `bar/doSomeAction` | the `if` block inside `bar`, reached explicitly via the method's scope         |

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

**A declaration's header may span lines.** Wrapping a parameter list, a generic
list or a `throws` clause is formatting, not a different declaration, so a
member is *not* required to fit its header on one line. When the line a
declaration starts on does not say everything there is to say — the closing `)`
is on a later line — the matchers are run over the **header** instead: the mask
from the declaration's own name through the `{` or `;` that ends it.

The header ends at the first `{` or `;` met with every bracket closed, and stops
at a blank line or a line that opened nothing the next line could continue. Every
bracket counts — `(`, `[`, `{` and `<` — which is what makes a wrapped parameter
list, a wrapped generic list, a wrapped `throws` and a wrapped class header one
rule; a `{` inside the header's own brackets (a lambda default, an array
initialiser) is not the body's brace, because a bracket is open, and a line whose
brackets are balanced ends the header there. The one `>` that is *not* a closer
is the one an arrow spells: `->` and `=>` are punctuation, so counting them as
angle brackets would end a Rust `fn f() -> T {` header at the arrow and lose its
body. The header is bounded (200 lines), so one that is never closed is not
followed through the rest of the file.

The same rule is what reads a Java `enum`, where the constants come before the
body's brace and each takes a line of its own — `enum Tier {\n  FREE(0),\n
PAID(1);\n … }` — so the declaration is only complete at the `{`, several lines
below the line it starts on. **An enum's constants are members** (2026-10-13,
matcher 4): each is named by its identifier, selected as the whole constant —
its arguments and the body it may declare included — and a constant is
reachable by its own name or through the enum that holds it
(`#OrgFeature/CALL`). The list ends at the first `;` outside every bracket, and
only what follows that `;` is an ordinary class body, so `#OrgFeature/label`
still finds the method. The widening scopes reach a constant's annotations and
its doc comment exactly as they do a field's, and `-` is what follows the name:
the arguments a constant is built with, or its own body, and nothing when it is
bare.

**A variable is a member wherever it is declared** (2026-10-13, matcher 4). A
field was always one, and so is a local inside a method or a block, a parameter a
signature names, a loop's own variable, a resource a `try (…)` opens and a
`catch` parameter. Three things about it are worth stating:

- **The initialiser is not required.** `int count;` declares `count` exactly as
  `private int count;` declares a field, and `-` is empty for both.
- **Every declarator counts.** `int first = 1, second = 2;` names `first` *and*
  `second` — the type is written once, before the first name, and each later
  declarator inherits it. The last one reaches the statement's own end.
- **The type is what makes it a declaration**, and the type may nest:
  `Map<Long, List<Session>> perOrg = …;` is one, because the generic list is
  counted rather than matched to its first `>`. A statement with no type before
  its name is not a declaration at all, so `count = 1;` stays an assignment.

Two boundaries are deliberate. A `catch` whose `try` opens resources is not read
yet — the resource list and the chain of `catch` segments share a line, and the
chain scan and this rule disagree about which parentheses belong to whom. And an
untyped lambda parameter (`item -> …`) is not read either: naming a variable
would mean parsing the expression it sits in, which is the parser this rule
refuses to be.

A body that puts its constants on the declaration's own line —
`enum Tier { FREE, PAID }` — registers them too, and the block is a container
because what it contains is its constants. Every constant of such a body
therefore lands on that one line: the selection is the line the constant is
written on, which is where a click goes. Kotlin's spelling, `enum class Suit`,
is one declaration like any other: the word after `enum` is the language's own
`class`, and the name follows it.

What the header must **not** do is invent a declaration. The name is looked for
where it is written, and only a statement that would declare it counts: the text
before the name must be a return type, a modifier list or nothing at all, and the
`(` must belong to the name. A wrapped *call* — `return map(\n  1, 2);` — is
therefore still a call, at whatever depth it appears, and a name that merely
occurs inside a wrapped argument list is not a section. A body-less member whose
header wraps (`abstract String label(\n  int width);`) is a name with nothing to
inject, exactly as its one-line spelling is.

So the guarantee is one-directional, and consumers must not expect more of it
than that: valid source never breaks the lexical layer, but a construct the
shape rules do not recognise is simply not a declaration, however legal it is.
Names are matched exact-byte and case-sensitive throughout.

## Tokenizers

The only language-sensitive work in a match is **lexical**: blanking comments
and string literals, and locating the comments (for anchors and region
directives). Everything else — the block tree, matcher precedence, the
sibling-first walk, the modifier-as-last-segment rule and rendering — is
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

| File           | What it is                                             |
| -------------- | ------------------------------------------------------ |
| `syntaxes.js`  | the language table: one object per language, all data  |
| `tokenizer.js` | the one-pass engine: mask, comment spans, `if` clauses |
| `lexers.js`    | extension → lexer, built from the table (`lexerFor`)   |

A language that is not in the table takes the default engine — the same answer
an unknown type gets — so an entry earns its keep only where the union is wrong
for that language:

| Language                | Extensions                                    | The construct the entry exists for                                       |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| JavaScript / TypeScript | `js` `mjs` `cjs` `jsx` `ts` `tsx` `mts` `cts` | backtick templates                                                       |
| Java                    | `java`                                        | text blocks `"""`                                                        |
| Zig                     | `zig`                                         | **nested** block comments, `\\` multiline strings                        |
| Go                      | `go`                                          | backtick raw strings (no escapes at all)                                 |
| Rust                    | `rs`                                          | nested block comments, `r#"…"#`, and `'a` (lifetime) versus `'a'` (char) |
| Python                  | `py` `pyi`                                    | `"""` / `'''`, raw `r"…"`                                                |
| C#                      | `cs`                                          | verbatim `@"…""…"`, raw `"""`                                            |
| Kotlin                  | `kt` `kts`                                    | nested block comments, `"""`                                             |
| PHP                     | `php` `phtml`                                 | `<<<EOT` heredocs; `#[Attribute]` is not a `#` comment                   |
| Ruby                    | `rb` `rake` `gemspec`                         | `=begin` / `=end`, `<<~TAG` heredocs (`<<` stays a shift)                |
| SQL                     | `sql`                                         | `''` doubling, `$$ … $$`                                                 |
| Shell                   | `sh` `bash` `zsh`                             | `<<EOF` heredocs, `'…'` takes no escapes                                 |
| VB                      | `vb` `bas` `vbs`                              | `""` doubling                                                            |
| Haskell                 | `hs` `lhs`                                    | nested `{- -}`                                                           |
| YAML                    | `yaml` `yml`                                  | `'…'` doubling, both quoted forms folding across lines                   |
| TOML                    | `toml`                                        | `"""` / `'''`                                                            |
| INI                     | `ini` `cfg` `properties`                      | `;` and `#` comments                                                     |

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

A resolution is four answers rather than one, because the consumers of it need
different ones — and answering the same question twice is how two answers start
to disagree:

| Field                  | What it is                                                              | Who needs it                                                                               |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `text`                 | the bytes the section stands for — every selector's text, joined with a newline in the order written | an injector, which writes them into a document                |
| `ranges`               | one **1-based inclusive** line range per selector, in the order written | a host, which highlights or navigates to each piece rather than to everything between them |
| `startLine`, `endLine` | the outermost bounds of `ranges`                                        | a host that wants the one span the selection occupies                                      |
| `kind`                 | the matcher that found a single selector: `region`, `declaration`, `property`, `condition`, `anchor` or `lines` (a line range); `multiple` when the reference named several | anything that has to explain the answer, which is what makes a heuristic arguable instead of mysterious |

The ranges are computed from the same slices the text was made from, so they
cannot disagree with it; a rendering that prepends a line of its own — the `if`
of a condition literal, the header line of a shared-close chain segment —
contributes the header line as well as the lines that follow it. A section whose
slice is empty still reports the line it would start on, rather than a range that
runs backwards. `resolveSection` is `planSection(...).text` — the one-field
shorthand for a caller that only wants the bytes.

`test/vectors/section-vectors.json` pins all four for every resolution case, so a
port that agrees about the bytes but not about the ranges or the kind fails the
conformance gate rather than passing it quietly.
