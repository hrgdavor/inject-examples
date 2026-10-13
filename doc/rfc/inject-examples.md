# RFC 3 — Inject examples: the strict reader of the core

|                              |                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| **Status**                   | Draft `0.1` — the policy is settled by the band table, and the failure surface it routes is **implemented** ([RFC 1 §5.3](section-mapping.md#53-the-diagnosis-surface-structured-failure): every failure carries a stable code and its selector). The document layer is shipped; the band rows that would gate a *port* on the codes are not. |
| **Version**                  | `0.1-draft` (independent of the package version and of [RFC 1](section-mapping.md)'s) |
| **Is a use case of**         | [RFC 1 — section mapping](section-mapping.md) (`0.9-rc`) — the contract, the resolution core, and the band vocabulary this spec routes |
| **Normative detail**         | [`doc/section-matching.md`](../section-matching.md) — how a reference resolves; [`doc/usage.md`](../usage.md) — how a document uses references |
| **Sibling use case**         | [RFC 2 — code jump](code-jump.md) — the best-effort reader of the same core           |
| **Conformance data**         | [`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json), [`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json), [`test/vectors/manifest.json`](../../test/vectors/manifest.json) |
| **Reference implementation** | [`index.mjs`](../../index.mjs) (document rules), [`cli.mjs`](../../cli.mjs) (the CLI), [`lib/section.mjs`](../../lib/section.mjs) (the resolver) |

---

## 1. Summary

**This is the project's own use case.** A Markdown document carries a link whose
fragment is a reference, and the fenced block below that link is not typed by
hand: the tool writes the file's current bytes into it, and a gate keeps it that
way.

````markdown
[the renderer](src/Cart.java#Cart/Line/render/-)

```java
        return name + " x" + quantity;
```
````

The link is a **marker**; the block below it is what the marker stands for; and
`#Cart/Line/render/-` resolved to exactly those bytes. The reference grammar and
the walk are [RFC 1 §3](section-mapping.md#3-the-resolution-core) and
[`doc/section-matching.md`](../section-matching.md) — this document owns only what
an *injector* does with the answer, and it is the strictest reader in the family:

> **An injection is exact or it fails.** There is no approximation in this
> product, at any setting, because a block copied out of the wrong `add` method
> reads as fact and no reader can see the difference.

### 1.1 Why strictness is the product, not a preference

Drift is the failure this tool exists to remove, and an injection has three ways
to drift that a jump does not:

| Way it drifts                             | What an injection would ship                | What catches it                 |
| ----------------------------------------- | ------------------------------------------- | ------------------------------- |
| the name is gone                          | an empty or stale block                     | a not-found failure at the gate |
| the name answers twice                    | the wrong `add`, presented as the right one | an ambiguity failure — an **error**, never a tie-break ([RFC 1 §9.5](section-mapping.md#95-one-resolver-strictness-is-a-profile)) |
| the block moved past a written line range | the neighbours of the intended block        | a byte comparison at the gate   |

The first two are the resolver's own strictness, which every consumer gets. The
third is this product's: it is the only consumer that has the **text**, so it is
the only one that can compare it.

### 1.2 What this spec may not do

- **It may not change a resolution.** Every band it routes is a failure the core
  already produced, with the core's own message.
- **It may not substitute one block for another.** `--lenient` tolerates a broken
  include by *skipping* it; it never picks a nearby block. A tolerant injection is
  still an injection ([§5.4](#54-what---lenient-is-and-is-not)).
- **It may not be weaker at the gate than [RFC 2](code-jump.md)'s gate.** The two
  gates answer the same band table the same way.

---

## 2. Product and boundary

|                |                                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| **Who**        | this project: a documentation pipeline that puts the code *into* the document     |
| **Needs**      | the section's **exact text**, byte for byte, plus its line range (for the "open in editor" affordance and for highlighting) |
| **Composes**   | one named block, or several in a written order, injected into a fenced code block |
| **Tolerates**  | nothing approximate. Not at the gate, not in the writer, not under `--lenient`    |
| **May modify** | the *document* it was asked to process, and nothing else — never a target file ([§7](#7-what-it-may-write)) |

**Why this is the demanding case**, restated as obligations:

- The text must be *exact* — it is pasted, not linked. An off-by-one is a bug
  someone will copy.
- **Several selections must compose in the order written**, because prose narrates
  an order (`toString/++,config.port`) that need not be source order.
- It must work for files that are **not code** — YAML, TOML, INI, JSON, CSS —
  where "declaration" has no meaning and the answer is a key, a value or a
  verbatim line range.
- A failure must **fail the build**, not degrade: a doc that silently injects
  nothing is a doc that lies.

**What is out of scope here** is the resolver's own list
([RFC 1 §3.9](section-mapping.md#39-explicitly-out-of-scope)) plus everything a
*jump* does: this product has no ladder, no "nearest", no file-start fallback, and
no cursor. It reads the same answer as [RFC 2](code-jump.md) and refuses
everything that is not the answer.

---

## 3. What it reads from the core

```text
planSection(source, reference, lexer) -> Plan | error     // the whole contract
resolveSection(source, reference, lexer) -> string        // planSection(...).text
```

An injection reads **`plan.text`** — the one field a jump does not read
([RFC 2 §2](code-jump.md#2-the-resolver-this-reads-and-the-one-thing-it-does-not-get)).
It writes those bytes into the document verbatim, with nothing added and nothing
re-indented, except where a rule *renders* a selection instead:

- the **code** rule copies the file's own lines, indentation included;
- the **data rules** (JSON, YAML, TOML, INI) re-print a selection of keys so the
  block is valid source *of that format* — a TOML table is rendered `[a.b]`, a
  YAML key path is re-indented — which is why the reference's `/` and the
  format's own spelling can differ in the output
  ([RFC 1 §9.4](section-mapping.md#94-a-key-is-a-section-under-the-same-grammar));
- the **CSS** rule copies the rule's lines, and names it by its rightmost simple
  selector or an at-rule keyword.

`reference.selectors` is read for the per-piece detail: the **plan** carries the
joined text and the merged `ranges`, and a host that wants to highlight each piece
separately reads the selectors rather than the plan.

**The envelope is the one feature built for this product.** `Cart/^,toString,$`
injects the class's declaration line, the method, and the class's closing line, so
a method copied out of a class reads as code rather than as a fragment
([`doc/section-matching.md`](../section-matching.md#envelopes)). A jump ignores the
extra pieces; an injection is why they exist.

---

## 4. The document layer

This is the half a jump does not have, and the reason the two specs were split:
a resolver answers *what is at this reference*, and this layer answers *which
references a document carries, and what to do with each*. It is shared with
[RFC 2 §5.1](code-jump.md#51-the-gate) — a gate enumerates markers with the same
code — and it never reaches into the resolver.

```
findMarkers(lines)                        -> Marker[]      // which links are markers
ruleFor(path, rules = REGION_RULES)       -> Rule          // which reader claims the file
planMarker(marker, read, rule)            -> Plan          // the resolve, through the rule
updateDocument(text, options)             -> { text, changed, markers, results }
```

### 4.1 A marker, and what follows it

- A marker is a link **with a non-empty path** and a `#` fragment. An in-page link
  (empty path) is navigation, never a marker.
- The block is the **fenced code block immediately below** the marker; blank lines
  between them are allowed, anything else is an error.
- Fences follow CommonMark: an opener of three or more backticks with an optional
  info string, a closer of the opener's length or longer with no info string. A
  fence left open at the end of the document is an error.
- A fence with no info string is given one from the marker's file extension, so
  the injected content is highlighted; a fence that already names a language is
  left as written.
- **A marker is unique in its document.** A repeated marker is an error in every
  mode, because it is ambiguous which block the second one owns.

### 4.2 A rule, and how it is chosen

`REGION_RULES` is an ordered list — `json`, `yaml`, `toml`, `ini`, `css`, then
`code` — and the **first** rule whose `extensions` claim the path wins, with
`code` (no extensions) as the fallback. A rule is a plain object
`{ name, extensions, resolve(text, region, path) }`, and `options.regionRules`
replaces the list, so a project adds a rule for another type by passing the
built-ins plus its own.

What a rule may do, and what it may not:

- **It reads the reference the same way.** A rule decides what a segment *names*
  — a key path, a CSS selector — and nothing else; there is one grammar and one
  walk ([RFC 1 §9.4](section-mapping.md#94-a-key-is-a-section-under-the-same-grammar)).
- **It may render its output**, because that is the format's spelling
  ([what a rule reads](#3-what-it-reads-from-the-core)).
- **It may not weaken resolution.** A rule that resolves a name two blocks answer
  to by picking one is out of contract; the ambiguity band is an error for every
  rule ([RFC 1 §5.2](section-mapping.md#52-the-band-table)).

### 4.3 Which blocks are rewritten

Every marker's block is rewritten unless the marker's file is excluded by the
document's own policy — a gitignore-shaped exclusion, or the marker being
skipped. A skipped marker keeps its block **byte for byte as written** and is
reported in `results`; it is never silently dropped, and a skipped marker is not a
clean resolve ([§5.4](#54-what---lenient-is-and-is-not)).

### 4.4 What the call returns

```text
updateDocument(text, options) -> {
  text:    string,        // the document with every applicable block rewritten
  changed: boolean,
  markers: Marker[],
  results: Array<{ marker, content: string | null, changed: boolean,
                   skipped: boolean, failure?: string }>
}
```

`failure` is present exactly when a marker was skipped because its include was
broken — the value `--lenient` exists to collect
([§5.4](#54-what---lenient-is-and-is-not)). A host that wants a *list* of broken
references reads `results`, not the exception.

---

## 5. The strict gate

### 5.1 One reading in the writer, one in the gate

There are two ways to ask the question, and the difference is what happens to the
run, never to the resolve:

- **`updateDocument`/the writer** resolves and rewrites. In the default mode a
  failure throws immediately — the document is being changed, and continuing past
  a broken include would half-write a document that lies. The error names the
  marker and carries the resolver's message.
- **`--check` (the gate)** writes nothing, reports everything, and **exits 1** if
  any block is stale or any include fails. It is the CI hook, and it is the
  reading that makes drift visible before a merge rather than after a publish.

`cli.mjs` exposes both, and a document that fails does not stop the documents
after it: the run exits with the worst code any of them produced.

### 5.2 The bands, from this product's side

The rows are [RFC 1 §5.2](section-mapping.md#52-the-band-table)'s, read from the
injector's side:

| Band                                                                | **inject/gate**                               | **inject/tolerant** (`--lenient`)                               |
| ------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| malformed reference (grammar)                                       | **error**, naming the selector and the repair | **error** — the document itself is wrong                        |
| not found                                                           | **error**                                     | warn, skip the marker, keep the block as written                |
| ambiguous at one level                                              | **error**                                     | **error** — no mode picks a block                               |
| not a container / wrong scope                                       | **error**                                     | warn, skip                                                      |
| line range past the end                                             | **error**                                     | warn, skip                                                      |
| duplicate key / table / section                                     | **error**                                     | **error**                                                       |
| a malformed document (duplicate marker, stray text, unclosed fence) | **error**                                     | **error** — the document is wrong, not its references           |
| a block that no longer matches its file                             | **error** in `--check` (stale)                | the same; `--lenient` is about *resolving*, not about staleness |

### 5.3 Why there is no lenient *resolution*

A tolerant injection would have to choose, and choosing is what this product
cannot do: an injected block is copied into a document and read as fact, so a
block that was *chosen* rather than *resolved* is a lie no reader can detect — and
CI, the only thing that could have caught it, saw a clean resolve
([RFC 1 §9.5](section-mapping.md#95-one-resolver-strictness-is-a-profile)).
`--lenient` exists so that a documentation author can *see* the breakage and keep
working; it is a reporting mode, not a resolution mode.

### 5.4 What `--lenient` is, and is not

- **Is:** a document policy that tolerates a broken *include* — the file or region
  cannot be read, or the block cannot be found — by skipping the marker, leaving
  its block exactly as written, and recording the cause in `results`. The run
  continues, and the exit code still reflects that something was broken.
- **Is not:** a second notion of what resolves. Every band marked **error** in the
  tolerant column above stays an error: an ambiguous name, a duplicate marker, a
  malformed document.
- **Is not:** a jump. It never produces a landing line, and it never chooses a
  different block. A product that wants a best-effort *place* is
  [RFC 2](code-jump.md); a product that wants a complete document is this one.

The mechanism is a single class: `IncludeError` marks the failures the tolerant
mode permits, and everything else — the document's own defects — stays a plain
`Error` in every mode.

### 5.5 Drift, from the injector's side

[RFC 1 §5.4](section-mapping.md#54-drift-guards) names the four shapes of drift;
this product's answer to each is the band table, with one addition it owns:

- **the name is gone** → the gate fails; the tolerant mode reports and skips;
- **the name answers twice** → the gate fails, and so does the tolerant mode;
- **the block moved, so a written line range is stale** → the gate compares the
  block's bytes against the resolve and reports it stale, which is the one drift
  only this product can see;
- **the reference was rewritten to a name that exists but names a different
  block** → **nothing here catches it either** ([RFC 1 §5.4](section-mapping.md#54-drift-guards));
  a test that pins the intent, not a resolver, is the only answer.

---

## 6. Conformance

**No new resolver rows.** This product resolves nothing of its own: the reference
grammar, the walk, the modifiers, the envelopes and the messages are
[RFC 1](section-mapping.md)'s, and the shared corpora gate all of them. A port
implements the core and reads the same rows.

What this *document layer* owes, and where it is gated today:

| Layer                  | Where                                                           | What it proves                                                        |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Document rules         | `test.mjs` document tests                                       | markers, gitignore, fences, region directives, the JSON/TOML/INI/YAML/CSS rules, round trips, `--lenient` |
| Round trips            | `test.mjs`                                                      | a document already standing for its files is left byte for byte alone |
| The package            | `tools/package-contents.mjs --check`                            | every path the package points at ships                                |
| The docs' own examples | `test.mjs` (`docs/` checks), `bun tools/build-demo.mjs --check` | the demo pages are generated and current                              |

The discriminating case for this profile, when band rows land, is the row where
it must **refuse** what [RFC 2](code-jump.md) accepts: an ambiguity, or a range
past the end. A row where both products agree proves nothing about the split
([RFC 1 §6.2](section-mapping.md#62-row-shapes)).

---

## 7. What it may write

**The document, and only the document.** A target file named by a marker is
opened for reading and never for writing; the resolver is read-only by contract
([RFC 1 §3.9](section-mapping.md#39-explicitly-out-of-scope)) and this product adds
no writer. A rename or a quick-fix that would update the *target* is a different
feature with a different owner — the forward goal in
[RFC 1 §4](section-mapping.md#4-forward-goal-refactoring-that-updates-references) —
and it must not be smuggled in as a "repair" of an injection.

What it writes, precisely:

1. the body of each marker's fenced block, replaced with the resolve's exact text;
2. a fence's info string, added only when the opener has none;
3. nothing else. Prose, markers, other blocks and the file's line endings are left
   as they are; a block that already stands for its file is not rewritten at all,
   so a `--check` run reports no change.

---

## 8. Change log

- `0.1-draft` — first revision. Extracted from RFC 1's use case B (the former
  [§3.2](section-mapping.md)) and given what the split made possible: the
  document layer as one place ([§4](#4-the-document-layer)), the **strict gate
  and `--lenient`** stated as two readings of one resolve
  ([§5](#5-the-strict-gate)) with the bands it routes, and the drift shapes it
  owns as against the ones no resolver can catch
  ([§5.5](#55-drift-from-the-injectors-side)). Nothing here changes a resolution,
  and no corpus row moves.

---

## 9. References

- [RFC 1 — section mapping](section-mapping.md) — the contract and the core.
- [`doc/section-matching.md`](../section-matching.md) — the resolution rules.
- [`doc/usage.md`](../usage.md) — the guide to using this product.
- [RFC 2 — code jump](code-jump.md) — the best-effort sibling.
- [`index.mjs`](../../index.mjs), [`cli.mjs`](../../cli.mjs) — the implementation.
