# Adjacency in a section reference — draft plan (postponed)

**Status: draft, postponed. Nothing here is scheduled, and no step is in
flight.** The maintainer's decision on 2026-10-10: the shape of the extension is
sketched, but its **usefulness is not yet established**, so it is parked rather
than planned. Not normative, not implemented, and not a backlog item — a
recorded idea with a design attached, so that a future decision to take it up
starts from here instead of from a blank page.

**What reopens it.** A concrete document that cannot be written without an
adjacency operand — that is, a section a reader genuinely wants to inject and
that today's grammar can only reach by taking a larger block or by writing the
bytes out by hand. The candidate most likely to produce one is `@doc-` (the
javadoc's *interior*, decoration stripped) and, after it, `@text:<needle>`. If
no such document shows up, the correct outcome is that this stays a draft: the
modifier set already covers "more of it", and an unused second namespace is cost
without benefit.

**What is deliberately excluded while it is postponed:** no amendment to
[`doc/section-matching.md`](../doc/section-matching.md), no new vectors, no
parser or resolver change, and no `@` reservation. Until this is taken up, `@`
in a reference is simply illegal-as-before, not reserved.

The gap this closes: today *how much* of a thing you take is a trailing
modifier (`-`, `+`, `++`), and *which* thing you take is a name. There is no way
to say **"the javadoc that belongs to this method"** as the subject of the
reference, and no way to say **"something inside that javadoc"** at all. The
user's case, verbatim:

> I need a way to target method and target the method's javadoc and even then
> things inside it.

`toString++` gets near it but not to it: it takes *declaration + annotations +
doc comment*, so the doc is selectable only as a prefix of a bigger selection,
never alone, never narrowed, and never re-entered. The sketch below makes the doc —
and everything else adjacent to a match — first-class.

---

## 1. The one idea

A reference resolves a path of names. Add a second kind of path element: an
**adjacency operand**, spelled with a sigil that cannot occur in a name:

```text
section-reference := path [ modifier ]
path              := segment ( '/' segment )*
segment           := name | edge
name              := token                        ; unchanged
edge              := '@' operand [ ':' argument ] ; new; '@' is reserved
```

An edge never searches for a declaration. It **re-frames the current match** —
the block the previous segment found — into an adjacent span (its doc comment,
its annotations, its header, its body, its neighbour), and a later segment is
then looked up in that frame, exactly as a later segment is looked up inside a
container today. The trailing modifier keeps its single meaning: it chooses
*how much* of the final frame to take.

Because `@` is not legal in a `token` today (the grammar's `/[A-Za-z_$][\w$]*/`
has never allowed it, and no fixture or vector uses one in a reference), this is
a pure extension: **every existing reference resolves to the same bytes**, and
the vectors for them must stay byte-identical.

### The user's case, answered

Assume a declaration the fixture already has
(`test/fixtures/Example.java:10-14`, doc at line 10, `@Override` at 11,
signature at 12):

| Reference | Result |
| --- | --- |
| `<span>toString/@doc</span>` | the doc comment alone: `    /** Add one item to this cart. */` (line 10) |
| `toString/@doc-` | its interior, decoration stripped: `Add one item to this cart.` |
| `toString/@annotations` | the annotation block alone: `    @Override` (line 11) |
| `toString/@signature` | the header line alone: `    public String toString() {` (line 12) |
| `toString/@body` | the statements inside the braces (identical to `toString-`) |
| `toString/@name` | the bare name: `toString` |
| `toString/@doc/@1` | line 1 of the doc comment's interior |
| `toString/@doc/@param:items` | one javadoc tag's body (see §5, doc frames) |

Read the last two rows as the answer to "even then things inside it": `@doc` is
not a leaf, it is a **frame** whose children are its interior lines, so a further
`/` keeps composing. Nothing new has to be invented for "inside" — the existing
descent machinery applies to the frame instead of to a block.

---

## 2. Semantics

**A frame** is what an edge resolves to: `{ fromLine, toLine, text?, container }`.
An edge is resolved against the block the previous segment matched (its *owner*),
all offsets coming from the same scan that found it. A frame is a container when
it has children to descend into, which is what lets `resolvePath` treat edges
like it already treats blocks.

**Modifier interaction (the invariant that must not move).** The modifier still
binds to the last path element and still never changes *which* thing is found.
For an edge, the scope reads:

| Modifier | On a declaration (today) | On `@doc` (proposed) |
| --- | --- | --- |
| none | whole declaration | the whole comment, delimiters included |
| `-` | body alone | the comment's interior, decoration stripped |
| `+` | declaration + annotations | the whole comment (nothing above it — no-op) |
| `++` | + doc comment | the whole comment (no-op) |

`+`/`++` on an edge is accepted and means the same as no modifier, on the same
precedent as `#region` today (`add+` and `add` inject the same lines). It is not
an error, because a user who typed `++toString` and then refactored to
`toString/@doc++` should not be punished for a harmless carry-over; the doc
already names this class of leniency.

**Missing adjacency is an error, never an empty block.** `toString/@doc` where
the method has no doc comment fails. An include that silently injects nothing is
exactly the failure mode this tool exists to prevent, so the message is a
`no …` error, in the catalogue's voice:

```text
no doc comment on "toString" in "Example.java"
no annotations on "toString" in "Example.java"
no next sibling after "render" in "Line"
```

**Edges are confined.** An edge may only be written where a match already
exists — it is never the first path element (`@doc` alone is meaningless) and
never followed by a name search that escapes the frame. `@parent` and `@root` are
the only ways out, and both are explicit (§4).

**Search order is untouched.** Edges are resolved left to right, after each
preceding element has resolved; they add no candidates to the walk, no
precedence row to the matcher table, and no change to sibling-first descent. A
reference with no edge cannot observe that this feature exists.

---

## 3. Edge vocabulary (phase 1)

The minimum that answers the request, restricted to facts the scanner can already
compute or can compute in one line pass:

| Edge | Frame | Notes |
| --- | --- | --- |
| `@doc` | the doc comment immediately above the declaration, when it is a *doc* comment (`/** */`, `///`, a Python/Ruby docstring) | today's `docCommentStart` / `annotationStart` already locate both |
| `@annotations` | the contiguous annotation block immediately above the declaration | `@Override`, `#[derive]`, a Kotlin `@Serializable`; already located by `annotationStart` |
| `@signature` | the declaration's header, first line through the body's opening brace (or its end when single-line) | new, trivial: `declLine` → `openLine` |
| `@body` | the contents of the braces, or the indented body | identical to the `-` scope, as a *subject* rather than a modifier |
| `@name` | the declared identifier | one line, or the token span |
| `@header` | alias of `@signature` | the word people reach for first |
| `@before` | the nearest contiguous non-blank run of comment lines directly above the owner | what `+`/`++` approximate; lets a non-doc `//` note be taken alone |
| `@prev` / `@next` | the previous / next **addressable** sibling in the owner's scope | skips blank lines and non-declarations; "addressable" is the matcher table, so a `@prev` from a method lands on the sibling method, not on a field inside it |
| `@first` / `@last` | the first / last addressable child of the owner | |
| `@scope` | the owner's enclosing block | the inverse of `/`; `Cart/Line/render/@scope` is `Line` |
| `@root` | the whole file's scope | lets a path start over without a second marker |
| `@N` (a bare integer) | the Nth line of the current frame, 1-based | only inside a line-shaped frame (`@doc`, `@body`, `@before`); an integer token is unambiguous because names cannot start with a digit |

`@body` deserves a note: it is deliberately *also* a modifier (`toString-`).
That is duplication, not conflict — the modifier is the short spelling for the
common case, the edge is the composable one, and both are rendered by the same
`renderDeclaration` path so they cannot drift.

**`@doc` is a frame with structure.** Its interior is exposed as children, so
`toString/@doc/@1` is the first interior line. Decoration stripping (`/**`,
`*/`, a leading `* `, `///`) is **data the lexer owns**, in the same spirit as
`annotationLine`: the default engine strips the union spelling, and a language
that differs (a Python docstring, a Ruby `=begin`) supplies its own. That keeps
`lib/section.mjs` dependency-free and language-neutral, and keeps a new language
from changing an existing answer.

---

## 4. Edge vocabulary (phase 2 — the suggestions that fit this direction)

These are *not* needed for the user's case. They are the set that makes the
feature a general "adjacency" capability rather than a javadoc shortcut, and
each one reuses the frame machinery from §2 rather than adding a mechanism.

### 4.1 Search inside a frame

| Edge | Meaning |
| --- | --- |
| `@text:<needle>` | the first line range in the current frame whose bytes contain `<needle>`; searched over masked text, so a needle inside a string or comment is found by the lexical layer rather than by accident |
| `@match:<regex>` | as `@text:`, but a regular expression; **must be disallowed in references that ship to the web**, or escaped — a Markdown link destination cannot carry a raw `)` |
| `@from:<needle>` … `@to:<needle>` | a range between two needles, which is how one grabs a block of a long method body without naming a declaration in it |
| `@line:<N>` / `@endline` | an absolute line into the frame, and the frame's last line — the escape hatch for prose, warned about in the docs because a line number is the one reference an edit can silently invalidate |

`@text:` is the highest-value member of this group: with it, "the line of
`toString` that returns the joined items" becomes
`toString/@body/@text:return`, and "the fallback branch" becomes
`getUsers/@body/@from:return null`. Both are things a reader of a doc wants to
show and a name cannot address.

### 4.2 Structured documentation

Once `@doc` is a frame, the natural next question is "the description of
parameter `items`". Language-neutral shape, language-specific data:

| Edge | Meaning |
| --- | --- |
| `@doc/name` | the doc comment's first sentence / summary, decoration stripped |
| `@doc/param:<name>` | one parameter's tag body — Java `@param items`, JSDoc `@param {T} items`, Python `:param items:`, Ruby `@param` — recognised by the lexer's doc-tag table |
| `@doc/return` / `@doc/throws:<T>` | the corresponding tag bodies |
| `@doc/see:<ref>` / `@doc/since` / `@doc/deprecated` | the same shape, other standard tags |
| `@doc/code` | the run of indented or `<pre>` lines inside the doc — the javadoc `{@code}`/`<pre>` case |
| `@doc/tag:<any>` | the general form when a project uses a custom tag |

This is one table in the language data (`syntaxes.js`) plus one reader in the
tokenizer, not a parser: a doc tag is a line beginning with the language's tag
spelling, terminated by the next tag line. It earns its place because the tag
*is* the unit a document usually wants to quote, and quoting it by line range
today is brittle.

### 4.3 Selection across siblings

| Edge | Meaning |
| --- | --- |
| `@all` | render every addressable child of the frame, joined by a blank line, in source order — the "show all the public methods' docs" case |
| `@all:<filter>` | as `@all`, narrowed by a filter name the lexer declares (`@all:public` in Java, `@all:exported` in TS) |
| `@or:<name>` | resolve the frame again with another name if the current one matches nothing — cross-language aliases (`Add`/`add`), and a migration path for a rename without an edit-and-hope window |

`@all` is the only edge that changes the *arity* of a selection (many blocks
instead of one). It is listed here, not in phase 1, precisely because it forces a
decision the rest do not: how the injected block represents a list
(blank-line-joined, this proposal's default) and whether the marker's line range
becomes a union of ranges. That decision deserves its own review.

### 4.4 What is deliberately rejected

- **A raw line-number selector as the primary tool** (`@10-14`). It works, it is
  cheap, and it is the one reference that rots silently. Offered only as
  `@line:N` inside a frame.
- **Reaching out of the file.** No `@file:`, no `@import`. The vendorable module
  reads one string; anything else belongs in `index.mjs`, and none of it is
  needed to name a piece of a file.
- **A `@doc` that writes.** The doc comment is source; edges select, they never
  rewrite. Injection still writes only between the fences.
- **Guessing a doc by proximity across blanks.** `@doc` requires the comment to
  be *immediately* above with no blank line, exactly as `docCommentStart` says
  today. A blank line means "not this declaration's doc", and the error is the
  honest answer.
- **A general AST.** Every edge above is a line range computed from offsets the
  scanner already has. If an edge would need a grammar, it does not belong here
  (house rule 5).

---

## 5. Errors

New messages follow the catalogue's shape (quote the reference as written; name
the frame):

| Condition | Message |
| --- | --- |
| an edge is the first path element (`@doc`) | `"#<raw>": "@doc" needs something to describe` |
| an unknown operand (`@doct`) | `"#<raw>": no adjacency named "@doct"` |
| the operand has no argument but requires one (`@param`) | `"#<raw>": "@param" needs an argument` |
| an argument on an operand that takes none (`@body:x`) | `"#<raw>": "@body" takes no argument` |
| the adjacency is absent | `no doc comment on "<element>" in "<file>"` (and the siblings per §2) |
| a name segment after an edge that is not a container (`@name/render`) | `"@name" is not a container` |
| `@N` outside a line frame (`Cart/@1`) | `"#<raw>": "@1" needs a line frame, not "<element>"` |
| dropping the names to a bare edge (`toString/@doc/@`) | standard empty-segment error; `@` alone is not an operand |

The existing single-segment failure pattern (`/no "#region <name>" found/`) is
untouched: an edge never produces it, and no existing message changes text.

---

## 6. Implementation, in reviewable phases

**None of these phases is started or scheduled.** They are recorded so that a
future decision to take this up has an order to follow; the sequencing argument
is what is being preserved, not a commitment. All of it is downstream of the
reopening test in the status note above.

Each phase is independently shippable and independently green. The order is
chosen so that no phase can regress an existing reference. Splitting it this way
is also what makes "is this worth it?" answerable cheaply: **phase 1 is useful on
its own** — it removes a real duplication (doc and annotation positions computed
at render time today) and changes no behaviour — while phases 2–4 are the part
whose value is still unproven. If the extension is taken up, phase 1 can land by
itself, and if it never is, phase 1 is still worth doing for its own reason.

**Phase 0 — decide and register (no code).** Accept or amend §1–§3, then add an
amendment section to [`doc/section-matching.md`](../doc/section-matching.md)
(grammar, edges, modifier table, error rows) exactly as the earlier amendments to
[`plans/section-matching/00-contract.md`](section-matching/00-contract.md) are
recorded. `@` becomes a reserved character in a reference, and that reservation
is written down. **This phase is the one the postponement blocks**: while it has
not happened, `@` carries no meaning in a reference at all.

**Phase 1 — facts on blocks.** In `lib/section.mjs`, `buildScope` already skips
comment lines to find declarations; record what it skipped: give each block
optional `doc` (`{ fromLine, toLine, kind: 'doc' | 'block' | 'line' | 'string' }`),
`annotations` (`{ fromLine, toLine }`) and `headerEnd`. The locating logic exists
(`annotationStart`, `docCommentStart`, `DOC_OPEN`/`DOC_RUN`) — phase 1 is moving
it from render time to scan time so the same answer is not computed twice, which
is the disagreement the "what a resolution answers" table already warns about.
No observable behaviour changes; the existing vectors must stay byte-identical.

**Phase 2 — grammar.** `parseReference` gains edge segments: an edge is
recognised by a leading `@`, kept as `{ edge: true, operand, argument }` in
`reference.segments`, and canonicalised in the existing single place
(`cleanSegments.join('/') + modifier`). All modifier-collection and
contradiction-warning logic is unchanged, including the mid-path collection
rule (`a++/b`), so no parser vector moves. New parse errors land in the §5
catalogue.

**Phase 3 — resolution.** `resolvePath` gains one branch: when the element is an
edge, resolve it against the previous frame instead of calling `searchSegments`,
returning a frame that either carries children (a container) or is terminal. The
frame planner is a new `planFrame(block, operand, argument, ctx)` beside
`renderBlock`; `renderBlock` is reused for the terminal render so `@body` cannot
diverge from `-`.

**Phase 4 — the doc lexer seam.** Add the optional `docStrip` (and, in phase 2 of
the vocabulary, `docTags`) to the lexer typedef, default the union spelling in
`lib/section.mjs`, and supply the language spelling in
`src/js/scanner/tokenizer.js`/`syntaxes.js` where the entry earns it (Python
docstrings, Ruby `=begin`, JSDoc tags beside Java's). The boundary test
(`lib/section.mjs` imports nothing) stays green because this is data injected
through the existing seam.

**Phase 5 — vectors.** Extend the generator
[`tools/section-vectors.mjs`](../tools/section-vectors.mjs) with cases for every
new spelling (the table in §1, the error rows in §5), regenerate
`test/vectors/section-vectors.json` and the Zig copy
(`node tools/zig-vectors.mjs`), and assert in `test.mjs` that every existing row
is unchanged — a diff gate, not only a pass gate. Per the corpus rule, each new
row must *discriminate*: `toString/@doc` beside `Line/@doc` (a class doc), one
`@doc` that is absent, and one `@annotations` where the annotation block sits
above a doc comment so the order cannot be swapped.

**Phase 6 — the ports.** The corpus is the contract, so Zig/Java/Rust go red the
moment phase 5 lands; that is by design (`npm test` runs both drift gates). Port
in the order [`plans/zig-port.md`](zig-port.md) prescribes — JavaScript is the
source of truth, the Zig port mirrors file for file, Java and Rust read the
corpora directly — and regenerate `src/section_vectors.zig` rather than editing
it. Consider gating phase 5 and phase 6 in one branch if a red `npm test` on
`main` is unacceptable; the phase boundary is a review boundary, not
necessarily a commit boundary.

**Phase 7 — documents and demo.** Add the new forms to
`doc/section-matching.md`'s modifier/worked-example sections, a recipe or two to
`doc/usage.md`, and a `##` section to [`docs/demo.md`](../docs/demo.md) with a
marker per phase-1 edge so the demo page shows the feature (the page is
generated: `node cli.mjs docs/demo.md`, then `bun tools/build-demo.mjs`).
`test.mjs`'s link check and the count-free assertions must stay satisfied.

### Regression safety, stated once

The feature's whole risk is that it perturbs the walk. It must not, and the
guard is structural rather than hopeful:

1. edges only ever appear after a resolved match, so a reference without `@`
   takes the identical code path;
2. the modifier table keeps `-`/`+`/`++` meaning exactly what they mean today;
3. phase 5 asserts the *existing* vector rows byte-for-byte rather than merely
   re-running them;
4. `node tools/compare-zig.mjs` holds JS and Zig at parity, so a JS-only reading
   of the new grammar cannot pass unnoticed.

---

## 7. Open questions (maintainer decisions, for whenever this reopens)

1. **Is the extension worth taking at all?** This is the question that postponed
   the plan, and it outranks every other item below: the answer is the reopening
   test in the status note, not a design preference.
2. Sigil. `@` (`toString/@doc`) is this draft's choice because it is
   illegal in a name today, so no reference can change meaning. The alternatives
   are a keyword-ish name (`toString/doc`) — rejected because it collides with a
   real member named `doc`, which is the one thing a heuristic matcher must not
   do — and a modifier-like prefix (`#doc:toString`), rejected because it puts
   the subject last and reads backwards.
3. **Is an edge a *scope* or a *selection*?** §2 says both, by composition.
   If a maintainer prefers one, the conservative reading is "scope only": a
   trailing edge without a further segment is then an error, and `@doc-` becomes
   `toString/@doc/@text`. This draft takes the composable reading because the
   user's case wants the doc alone.
4. **`+`/`++` on an edge: no-op or error?** §2 accepts them by precedent
   (`#region`). The stricter alternative is an error, which is consistent with
   `@body:x` being an error.
5. **Phase 2 order.** `@doc/param:name` is the highest-value follow-on, but it
   is also the first thing that needs a per-language doc-tag table; `@text:`
   needs nothing. If only one lands, it should be `@text:`.
6. **`@all` arity.** Deferred until the list-rendering decision is made; an
   implementation should not ship `@all` before that answer exists.
