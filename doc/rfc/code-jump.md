# RFC 2 — Code jump: navigation as a best-effort reader

|                              |                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| **Status**                   | Draft `0.1` — **implemented in the JavaScript reference** at [`lib/jump.mjs`](../../lib/jump.mjs): the `JumpTarget` of [§3.2](#32-the-jump-target), the ladder of [§4](#4-the-best-effort-ladder), both profiles, and the document gate of [§5.1](#51-the-gate) (`jumpGate`, and `--gate` on the CLI). What remains is the corpus half — no band row asserts the policy — and the three ports, which implement the resolver only; [§8](#8-conformance-for-this-profile) is what a port owes. |
| **Version**                  | `0.1-draft`                                                                                    |
| **Is a use case of**         | [RFC 1 — section mapping](section-mapping.md) (`0.9-rc`) — the contract, the resolution core, and the band vocabulary this spec routes |
| **Normative detail**         | [`doc/section-matching.md`](../section-matching.md) — how a reference resolves                 |
| **Sibling use case**         | [RFC 3 — inject examples](inject-examples.md) — the strict reader of the same core             |
| **Conformance data**         | [`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json), [`test/vectors/manifest.json`](../../test/vectors/manifest.json) — **shared, unresolved**: a port implements the core, and this spec adds no resolver rows |
| **Reference implementation** | the core pieces this spec reads are in [`lib/section.mjs`](../../lib/section.mjs); the jump profile itself has no implementation yet |

---

## 1. Summary

**A code jump is a reference turned into a cursor.** The consumer holds a link
fragment — `src/Cart.java#Cart/Line/render/-` — and wants to put the reader
somewhere in `src/Cart.java`. It does not want the text, it does not want to write
anything, and it is usually running while a person types.

This is [RFC 1 §1.1](section-mapping.md#11-there-is-one-resolver-and-two-ways-to-read-it)'s
first product, and the whole of this document is one sentence:

> **Find the first line, or say honestly that you could not — and make the best
> answer available without ever pretending it is the exact one.**

The resolver ([RFC 1 §3](section-mapping.md#3-the-resolution-core)) is unchanged
and shared with the injector. What this document owns is the **jump profile**: how
a resolution becomes a landing line, what an editor does when the resolution
fails, and — separately — what the *same* failures mean when a jump runs as a
gate over a repository.

### 1.1 The two readings of one failure

The reason jump and inject are separate specs is not that they resolve
differently. It is that the same failed resolve is a **warning in an editor** and
an **error in a gate**, and the second is not optional:

|                        | **jump/editor**                                                           | **jump/gate**                                                                           |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Where it runs          | inside IDE/LSP, on a document that is usually broken                      | `--check` in CI, over a whole repository                                                |
| An imperfect reference | best effort: land usefully, **say so**                                    | **fails the run**                                                                       |
| Why                    | a reader is sitting in front of it, and a wrong-but-close cursor is cheap | a shipped document full of broken references is the drift both products exist to remove |

A gate that tolerated what the editor tolerates would be the tool that says
"fine" while the documentation rots. An editor that failed what the gate fails
would refuse to help a person mid-keystroke. Neither reading is a lenient version
of the other; they are two policies over one resolver, and
[§5](#5-the-profile-matrix) is the table that pins both.

### 1.2 What this spec may not do

- **It may not change a resolution.** Every band it routes is a failure the core
  already produced, with the core's own message.
- **It may not re-rank, re-scan or re-parse.** The ladder of
  [§4](#4-the-best-effort-ladder) walks the *candidates the core reported*; a
  fallback that goes looking on its own is outside this contract.
- **It may not call an approximation a resolve.** Every target carries its
  `cause` ([§3.2](#32-the-jump-target)), and every approximation carries the
  failure it came from.

---

## 2. The resolver this reads, and the one thing it does not get

The core is [RFC 1 §3](section-mapping.md#3-the-resolution-core):

```text
planSection(source, reference, lexer) -> Plan | error     // the whole contract; never approximates
resolveSection(source, reference, lexer) -> string        // planSection(...).text
diagnose(source, reference, lexer) -> Diagnosis           // never throws; RFC 1 §5.3
deepestResolvablePrefix(source, reference, lexer)         // the ladder's first rung, RFC 1 §5.3
  -> { reference, firstLine, segments } | null
```

A jump calls the core and reads two things from the answer:

- **`ranges`** — for the landing line, and for whatever the host highlights;
- **`reference.selectors`** — so a host can highlight each piece rather than the
  span between them, and so a completion item can be described ("`render`, in
  `Line`, body").

**`text` is not read.** A jump never needs the bytes, and a host that shows a
preview should render it from the file it already has open, not from a second
resolution. Reading the text would make the jump pay for the injector's answer;
not reading it is why a jump can be called on every cursor move.

When the resolve fails, the jump reads the **diagnosis** rather than the prose
([RFC 1 §5.3](section-mapping.md#53-the-diagnosis-surface-structured-failure)):
the failing selector, the scope it was searched in, the candidates the name
answered to, and the category. The core ranks nothing and picks nothing — which
candidate is "closest" is this spec's ladder
([§4](#4-the-best-effort-ladder)), and the reason it lives here is that it is a
*policy*, and one only an editor wants.

---

## 3. Where a jump lands

### 3.1 The first line

The landing line is defined once for both products in
[RFC 1 §3.5](section-mapping.md#35-the-first-line), and this spec does not
re-derive it:

> **The first line of a selection is the `from` of its first range.**

Two consequences a jump implementer must not "fix":

- **It is the first selector as written, not the lowest line number.** `L40,toString`
  has `startLine` 3 when `toString` sits near the top, and the cursor belongs on
  **40**.
- **It is a line, not a byte offset.** A selector that begins mid-line
  (`L13:9`) still lands the cursor on line 13; the column is the host's to use or
  ignore, and is carried in the selector for a host that wants a precise cursor.

For a resolved plan, `firstLine = plan.ranges[0].from`. A host must use that
field rather than `startLine`, and must not recompute it from `text`.

### 3.2 The jump target

```text
JumpTarget := {
  path:      string,                 // the file the reference names, as the link wrote it
  firstLine: number,                 // 1-based, inclusive — where the cursor goes
  lineCount: number,                 // how many lines the selection spans, for a highlight
  selectors: Selector[],             // the per-selector detail, for piece-wise highlighting
  cause:     'resolved' | 'ambiguous' | 'nearest' | 'file-start' | 'uncertain',
  plan:      Plan | null             // present only when cause === 'resolved'
}

JumpOutcome := { ok: true, target: JumpTarget }
             | { ok: false, failure: Diagnosis }        // jump/gate, or an editor with no ladder left
```

- **`cause` is the profile's honesty field**, and it is why this spec can be
  strict in a gate and useful in an editor without a second resolver. `resolved`
  is the only cause that means "the reference named exactly this"; every other
  cause means the landing line was chosen by policy, and a host that shows it
  (a status bar note, a squiggle, a hint) is implementing this spec rather than
  decorating it.
- **`plan` is null unless the resolve was exact.** A host that wants the text of
  an approximation must not get one from a jump: it re-resolves, deliberately,
  or it shows an excerpt of the file. Handing a plan to a jump is how an
  approximation would quietly become an injection.
- **`lineCount` is derived from `ranges`** (the outermost bound, or the last
  range's `to` minus the first range's `from`), never from `text.split('\n')`.

### 3.3 What a resolved jump points at, per kind

The matcher decides *which* block; the jump decides *where in it* the cursor
goes, and the rule is uniform: **the first line of the selection the reference
asked for**, not the first line of the block it found.

| Resolved to                                   | Cursor                                                               | Why                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| a declaration (`render`, `Cart/Line`)         | the declaration's first line, before any annotation or doc comment   | the reader is being taken to the declaration, not its decoration; `+` and `++` are how a caller asks for the decoration to be included |
| a declaration with `-` (`render/-`)           | the first line of the **body**                                       | the modifier said so, and jumping to the header instead would ignore it                             |
| a property (`count`)                          | the statement's first line (`-` lands on the initialiser expression) | [RFC 1 §3.4](section-mapping.md#34-plan-the-whole-contract); a property selects its whole statement |
| a `#region` (`add`)                           | the first line strictly inside the directives                        | the directive lines are not part of the region ([`doc/section-matching.md`](../section-matching.md#searching-one-element-in-a-scope)) |
| a comment anchor (`getUsers`)                 | the anchor comment, which is the block's first line                  | the anchor is why the block is addressable, and it is inside the selection                          |
| a condition literal                           | the statement's `if`/`else if` line                                  | the block's selection starts at its header                                                          |
| a line range (`L40:12-L44:3`)                 | line 40                                                              | the range is verbatim, columns included                                                             |
| an envelope (`Cart/^,toString,$`)             | the **head** — the parent's declaration line                         | the reader is being taken to the member *in its declaration*, and the head is what they wrote first; a host that wants the member itself uses `ranges[1]` |
| a scope segment (`Cart/Line/render` → `Cart`) | the selected member, never the scope                                 | a path's earlier segments exist to narrow the search, not to be the destination ([§3.4](#34-the-scope-is-not-the-destination)) |

### 3.4 The scope is not the destination

The most common way to get a jump "wrong but plausible" is to land on a **path's
scope**. `Cart/Line/render` must land on `render` inside `Line`, not on `Line` and
certainly not on `Cart`.

A host that wants the *scope* — a "go to enclosing type" command, a breadcrumb —
is asking a different question, and it asks it by writing that reference:
`Cart/Line`. The mapper serves both, and this spec does not blur them: a jump
resolves the reference it is given, and the reference is the question.

The same rule covers a name several blocks answer to: a **path** does the
choosing (`Cart/add` names the holder), so `Cart/add` is resolvable while a bare
`add` that answers twice is the ambiguity band
([§4.2](#42-ambiguous-several-candidates)) — never a walk-order guess.

---

## 4. The best-effort ladder

The editor's ladder, in order, for a resolve that failed. **Every rung is a
`cause` from [§3.2](#32-the-jump-target)**, and the first rung that lands wins.

### 4.1 Rung 0 — exact

The core resolved. `cause: 'resolved'`, `plan` present, cursor on
`ranges[0].from`. Nothing about the reference is approximated, and this is the
only rung a gate accepts.

### 4.2 Ambiguous (several candidates)

The core reports that `<name>` is declared *n* times at one level, with the
candidates. A *gate* refuses ([§5](#5-the-profile-matrix)) — it cannot pick, and
picking would ship a lie. An *editor* picks, but only in a way the reader can
see:

1. **Deepest unique prefix first.** Re-resolve the reference's path minus its last
   segment; if that prefix resolves uniquely, land on the **container's first
   line** — a reader who asked for `add` inside a file with two `add`s is best
   served at the holder the rest of the path already named. `cause: 'ambiguous'`.
2. **Otherwise the shallowest candidate.** The candidates are at one depth; the
   walk found them in source order, and the ladder takes the first — but never
   silently: the target keeps `cause: 'ambiguous'` and the candidate list, so the
   host can offer a picker.
3. **No candidate list** (an engine that cannot supply one): fall through to
   [§4.6](#46-rung-5-the-file-head-and-uncertain).

**What the editor must not do is invent a distance.** If two `add` methods sit in
different `impl` blocks and the prefix does not disambiguate, the reader gets a
picker or the file head — not a coin flip presented as a definition.

### 4.3 Not found

The name matches nothing in the scope, and the core reports the scope it searched
(`no section named "render" in "Line"`). The ladder walks **inward**, because the
good answer is usually "the enclosing thing you can see":

1. **The deepest prefix that does resolve.** For `Cart/Line/render`, try
   `Cart/Line`, then `Cart`, and take the first that resolves — the cursor lands
   on the last container that exists. `cause: 'nearest'`.
2. **A name from the resolver's own candidate set**, where it has one: a region
   directive (`no "#region add" found, and no section named "add"` means the two
   readings were both tried) or a scope that matched with a different modifier.
   `cause: 'nearest'`.
3. **The file's first line.** `cause: 'file-start'`.
4. **A host fallback.** `cause: 'uncertain'`, and see [§4.6](#46-rung-5-the-file-head-and-uncertain).

Rung 1 is the rung that makes an editor feel intelligent without being dishonest:
it never claims the block exists, and it stays inside the scope the author wrote.
It is also the rung a **rename** turns useful — when `render` is renamed to
`paint`, the reference `Cart/Line/render` lands on `Line`, one keystroke from the
new name, instead of at the file head.

### 4.4 Out of range

A line range past the end of the file (`L31` in a 30-line file). Verbatim ranges
are exact or nothing ([RFC 1 §3.4](section-mapping.md#34-plan-the-whole-contract)):
an editor clamps to the **last line** with `cause: 'nearest'`, and a gate
errors — a document that points past the end of its file is stale, and there is
no defensible injection there either.

### 4.5 Grammar

The reference is malformed as written, so the resolver threw before consulting a
file and there is nothing to be nearest *to*.

1. **The file's first line**, `cause: 'file-start'` — the link is locatable even
   when the fragment is not, so a reader can be put in the right file.
2. **A host-side repair offer** — a code action applying the message's own advice
   (`"++" is a path segment now; write "#add/++"`). This is a host feature built on
   the diagnosis, not a re-resolution, and the ladder does not depend on it.

### 4.6 Rung 5 — the file head, and uncertain

The last rung is always available: **line 1 of the named file**, `cause:
'file-start'`. A reader who is in the right file is better off than one who is
nowhere, and the host can say what happened.

**`cause: 'uncertain'` is reserved for a host that searched outside the mapper** —
a text search for the name, a heuristic of its own. It is in the type because hosts
do it, and it is deliberately the least trustworthy cause: it is the only landing
line the mapper cannot explain, so a host that produces one should mark it
visibly and must not report it as a definition.

**A jump is only ever within the file the reference names.** No rung crosses into
a second file, because a reference does not
([RFC 1 §9.8](section-mapping.md#98-cross-file-references-are-out-of-scope)) —
the file comes from the link's path, and a jump that opens another file is a
different feature (import resolution), not this one.

---

## 5. The profile matrix

The rows are the failure bands of
[RFC 1 §5.2](section-mapping.md#52-the-band-table), read from this product's side.
"Fails the run" is `jump/gate`; "lands usefully" is `jump/editor`.

| Band                                            | **jump/gate**                                 | **jump/editor**              | Fallback rung                            |
| ----------------------------------------------- | --------------------------------------------- | ---------------------------- | ---------------------------------------- |
| malformed reference (grammar)                   | **error**, naming the selector and the repair | warn, `file-start`           | [§4.5](#45-grammar)                      |
| not found                                       | **error**                                     | warn, prefix or `file-start` | [§4.3](#43-not-found)                    |
| ambiguous at one level                          | **error**                                     | warn, prefix or picker       | [§4.2](#42-ambiguous-several-candidates) |
| not a container / wrong scope                   | **error**                                     | warn, prefix                 | [§4.3](#43-not-found)                    |
| line range past the end                         | **error**                                     | warn, clamp to the last line | [§4.4](#44-out-of-range)                 |
| duplicate key / table / section                 | **error**                                     | warn, prefix or picker       | [§4.2](#42-ambiguous-several-candidates) |
| a bare `#reference` with no file (in-page link) | not a marker; not a jump                      | not a marker                 | —                                        |

### 5.1 The gate

`jump/gate` is a **document-level** check, and it is deliberately the same
strictness as `inject/gate`
([RFC 3 §5](inject-examples.md#5-the-strict-gate)): anything that is not an exact
resolve fails. A CI job that validates the references a document carries must not
depend on which product reads the document.

Two obligations follow, and they are what make the gate worth running:

1. **Collect, do not stop.** A gate reports *every* failing reference in the
   document, with its file, its selector and its message, so one run is one fix
   list. The document enumeration is the injector's ([RFC 3 §4](inject-examples.md#4-the-document-layer)),
   shared, not reimplemented.
2. **The band, not the message, decides.** A host must not classify failures by
   matching message text; the diagnosis carries the category
   ([RFC 1 §5.3](section-mapping.md#53-the-diagnosis-surface-structured-failure)),
   and that is the value a gate branches on.

### 5.2 The editor

`jump/editor` **never fails a keystroke**. It returns a `JumpTarget` for anything
that lands and `ok: false` only when even the file head is unavailable (the file
does not exist, the path is ignored by policy, or the reference is an in-page
link). The contract-level properties:

- **Cheap.** `parseSelectors` on every keystroke; `planSection` when the document
  or the target changes, cached per file version — the invalidation a host
  already has ([§6.1](#61-what-the-server-wants)).
- **Pure.** No fallback writes, no cache mutation, no file opened by the mapper.
- **Honest.** Every non-`resolved` target carries its `cause` and the failure it
  came from, so a host can render the difference between "here it is" and "here
  is the closest I could get". A host that hides `cause` is not implementing this
  spec.

### 5.3 Escalation is a policy, and it is nameable

A product that wants neither pure reading may state a floor — for example *"warn
on `nearest`, error on `file-start`"* — and that statement belongs to the host,
as a host option or a per-document rule. What this spec fixes is the two ends:
the **editor** end tolerates every band, and the **gate** end tolerates none. A
middle setting must be spelled as a choice between bands, never as a second
notion of what resolves.

---

## 6. The language server and IDE integration

A language server is the most demanding form of this use case: it runs *while a
person types*, on a document that is usually broken, and it must never block the
editor. It is a first-class consumer, and every feature below is built from the
resolver's operations — none of them requires the mapper to do anything more.

### 6.1 What the server wants

**An IDE or LSP host usually has an AST already, and should use it.** That is the
preferred arrangement and not a workaround: the parse has been paid for, the
host's parser knows its own language better than a shape heuristic can, and no
second parser has to be installed or kept current
([RFC 1 §3.8](section-mapping.md#38-engines-the-standalone-scan-or-the-hosts-own-ast)).
So the shape of an IDE integration is:

- the **grammar** is always the mapper's — a reference must mean the same thing in
  every host, and parsing a fragment needs no AST at all;
- **resolution** uses the host's AST where the host has one for the language,
  passed in as the engine;
- the **standalone engine** covers languages the host has no parser for, and any
  host that is not an IDE — which is why both paths must produce the same range
  and the same messages.

| The server wants                                                | Built from                       | What the mapper supplies                                                                            |
| --------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| completion of a reference (after `#`, after `/`, after `,`)     | `parseSelectors`                 | a pure, context-free parse that reads no file, so it is safe to call on every keystroke             |
| a preview of a completion item                                  | `parseSelectors`                 | the structured `Reference`: `segments`, `scope`, `selectors[]`, and the canonical spelling          |
| go-to-definition, and document highlight                        | `planSection`, or the host's AST | `ranges[0].from` for the cursor, and one range per selector so each piece is highlighted separately |
| a diagnostic for a broken fragment                              | `diagnose`                       | a specific message that names the selector at fault, with the category and candidates a fallback needs |
| a code action repairing a fragment                              | `diagnose`                       | the message's own advice (`"++" is a path segment now; write "#add/++"`), which is a rewrite the host may offer |
| semantic tokens, folding, "find all references to this section" | `planSection`, or the host's AST | `reference.selectors[]` and `ranges`                                                                |

### 6.2 Two properties that make it work

1. **Parsing is pure and cheap.** `parseSelectors` reads no file and takes about a
   microsecond, so a server can call it on every keystroke. `planSection` reads
   the target, so a server calls it when the document or the target changes and
   caches per file version. Cost is a *contract-level* concern here, not an
   optimisation detail: an engine whose scan is not near-linear in the file is
   unusable for this consumer, and
   [RFC 1 §3.8 rule 4](section-mapping.md#38-engines-the-standalone-scan-or-the-hosts-own-ast)
   makes the comparison a gate.
2. **Failure is a value, not an approximation.** The resolver never guesses, so a
   server can show *"no section named render in Cart"* confidently and apply its
   own ladder while the user is still typing — a policy the resolver deliberately
   keeps out ([RFC 1 §9.5](section-mapping.md#95-one-resolver-strictness-is-a-profile)).

### 6.3 What the server does, and the mapper does not

Editing, undoing, ranking beyond the ladder of [§4](#4-the-best-effort-ladder),
fuzzy matching, applying a rename, and diagnosing anything that needs a *type*
rather than a *shape*. Two honest limits follow from the non-goals
([RFC 1 §3.9](section-mapping.md#39-explicitly-out-of-scope)):

- **No symbol table.** The mapper cannot tell whether `render` is reachable in the
  sense a compiler means; it only knows whether a declaration shaped like it is
  written there.
- **Shape, not type.** A name that a type system would reject may still resolve,
  because the mapper matches declaration *shapes* over masked text. A validator
  that needs types must re-check the mapper's answer rather than trust it.

---

## 7. What this spec does not cover

- **The text.** Anything that copies bytes is [RFC 3](inject-examples.md). A jump
  that shows a snippet renders it from the host's open buffer.
- **The document layer.** Markers, fences, gitignore and region rules are
  [RFC 3 §4](inject-examples.md#4-the-document-layer). A gate borrows the
  enumeration and none of the rewriting.
- **Resolving differently per host.** The engine may differ (host AST versus
  standalone scan), the answer may not
  ([RFC 1 §3.8](section-mapping.md#38-engines-the-standalone-scan-or-the-hosts-own-ast)).
- **A workspace-wide index.** Jumping from a `#fragment` to a line is local by
  design; finding *which documents reference a name* is the refactor direction
  ([RFC 1 §4](section-mapping.md#4-forward-goal-refactoring-that-updates-references)),
  not a jump.

---

## 8. Conformance for this profile

**No new resolver rows, and a corpus of its own.** This profile resolves nothing
of its own: a jump over a reference must produce the same resolve the core
produced, byte for byte, and the shared corpora already gate that. What a profile
*does* own is policy, and policy is pinned in
[`test/vectors/profile-vectors.json`](../../test/vectors/profile-vectors.json) —
generated by `tools/profile-vectors.mjs`, asserted by
[`lib/jump.test.mjs`](../../lib/jump.test.mjs), and mapped for a porter in
[`test/vectors/manifest.json`](../../test/vectors/manifest.json) as layer 8.

A port that implements the resolver alone **skips that layer** and is still
conformant ([RFC 1 §6.3](section-mapping.md#63-making-the-suite-usable-by-a-new-implementation)).
A port that offers a profile owes, and the corpus asserts:

1. **Every band routes as [§5](#5-the-profile-matrix) says**, per reading — the
   rows are exactly the cases where the two columns differ, because the generator
   refuses a row both readings answer alike.
2. **The landing line is asserted, not just the cause.** `ranges[0].from` for a
   plain resolve, and for a reference of several selectors it is neither
   `startLine` nor the lowest line number — the `L9,L1` row is that case, written
   into the corpus rather than left to prose.
3. **The gate is at least as strict as `inject/gate`**: every band the editor
   lands is a band the gate refuses, and the row names the code it refuses with.
4. **The editor never fails a keystroke** for which a file-start target exists.
5. **A document's gate reports every failure in one pass**, with each failure's
   code and the selector at fault — `broken.md` carries one reference of every
   band for exactly that reason.

The fixtures are `test/fixtures/jump/`: `Cart.java` (a class whose line numbers
the corpus quotes), `Duplicate.java` (one name, two blocks), and the documents
`clean.md` and `broken.md`. Every file a document reads is **embedded in the
corpus**, so a port implements the rows with no disk access at all.

---

## 9. Change log

- `0.1-draft` — the profile corpus. The policy stopped being prose and became
  data: `test/vectors/profile-vectors.json` (8 resolution rows, 2 documents),
  generated by `tools/profile-vectors.mjs` and asserted by `lib/jump.test.mjs`.
  The generator **refuses** a row both readings answer exactly, so every row in
  the file is a case where the policy shows. Nothing here changes a resolution.
- `0.1-draft` — first revision. Extracted from RFC 1's use case A (the former
  [§3.1 and §3.5](section-mapping.md)) and given what the split made possible:
  the landing rule as a **first line** defined once for both products
  ([§3.1](#31-the-first-line)), the **jump target** with its honesty field
  ([§3.2](#32-the-jump-target)), the **best-effort ladder** as five stated rungs
  instead of a sentence ([§4](#4-the-best-effort-ladder)), and the
  **editor-versus-gate profile** with the same strictness as the injector's gate
  ([§5](#5-the-profile-matrix)). Nothing here changes a resolution, and no corpus
  row moves.

---

## 10. References

- [RFC 1 — section mapping](section-mapping.md) — the contract and the core.
- [`doc/section-matching.md`](../section-matching.md) — the resolution rules.
- [RFC 3 — inject examples](inject-examples.md) — the strict sibling.
- [`lib/section.mjs`](../../lib/section.mjs) — the resolver this profile reads.
