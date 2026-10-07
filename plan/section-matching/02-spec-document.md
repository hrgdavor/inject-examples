# Step 2 — Write the normative spec document

**Depends on:** [00-contract.md](00-contract.md). **Blocks:** nothing hard, but later steps
cite this file, so write it early. **Size:** small-medium. One commit. No code.

## Goal

Turn the contract into the **shipped** document `doc/section-matching.md`: the normative
specification another project implements against. The contract is internal planning prose
written for these steps; the spec is the public artefact, written for an implementer who has
never seen this repository.

## What the document must contain

Write it as a specification, in this order (headings may be worded differently; the content
must all be present):

1. **What a section reference is**, and that it lives in the fragment of a marker:
   `[label](path#region:<section-reference>)`. State plainly that `inject:` is a consumer
   project's own marker prefix and that `region:` is a fixed keyword, not a name — the
   grammar being specified is the reference, nothing else.
2. **The grammar**, verbatim from the contract §5, including the 8-segment cap, the token
   character class, the three modifiers, and the note that dots are never path separators.
3. **The six rules** (slash is not a package path; only the last segment selects content;
   the modifier is trailing; a bare name is a one-segment path; first match wins; `region:`
   is not a name).
4. **The matcher precedence table** (contract §6), with the walk description: within a scope,
   in order, first match wins; on no match, descend into contained blocks left to right,
   depth first; for a multi-segment reference each later segment is searched only inside the
   scope the previous one found.
5. **Canonicalisation and the compatibility spellings** (contract §7), including the accepted
   and rejected lists.
6. **Modifier semantics per match kind** (contract §8).
7. **The error catalogue** (contract §9) — message shapes included, because ports match on
   them.
8. **The contradiction warning** (contract §11), including that it is not gated on
   `--lenient` and that the run still exits 1.
9. **The worked examples** (contract §12) — both fixtures, as tables, with the exact injected
   bytes where the block is a single line.
10. **A "heuristic, not a parser" section**, in these words or equivalent: the matcher blanks
    comments and string literals and counts brackets; it does not parse Java or TypeScript
    and makes no type-aware decisions; consumers must not expect a real parser.
11. **A revision header**: `Written against the JavaScript implementation at commit <sha>`. At
    step 2 you do not know the final sha; write
    `Written against the JavaScript implementation as of the commit that adds this file` and
    step 9 replaces it with the settled sha. Say so, so the placeholder is not forgotten.

## Hard constraints

- **No injected blocks from fixtures in this document.** Every example is written as prose,
  literal `text`-tagged fences or tables. This document describes the syntax; it must not
  *use* it yet, and it must not add markers (that would move the marker count asserted at
  `test.mjs:1290`, which step 9 is responsible for). Step 9 decides whether to dogfood it.
- **Every Markdown link must resolve.** `test.mjs` enforces, over every `.md` file in the
  repo, that a prose link is an external URL, an existing heading in the same file, or an
  existing file (resolved against that document's own directory). A link to
  `plan/section-matching/00-contract.md` from `doc/section-matching.md` must therefore be
  `../plan/section-matching/00-contract.md`, and it must stay valid.
- **All illustrative marker-shaped lines go inside fenced code blocks.** A line that is
  nothing but a self-labelled link, outside a fence, in a `.md` file, is a **real marker**
  and will be resolved by any `inject-examples` run over the repo — and the repo's own test
  suite runs the tool over its documents. This is the single easiest way to break the build
  in this step.
- Fences that contain fence lines inside them must be **longer** (four backticks wrapping
  three), per CommonMark and this repo's rules.
- No new dependencies; no code changes to `index.mjs`, `cli.mjs` or `lib/**`.

## Done when

- [ ] `doc/section-matching.md` exists and contains all eleven items above.
- [ ] `node -e "…"` is not needed: `npm test` is green (the link and doc tests pick the new
      file up automatically).
- [ ] `npx inject-examples --check README.md doc/usage.md` exits 0 (nothing else changed).
- [ ] The document adds **no** markers, so `test.mjs:1290` is unaffected.
- [ ] A reader with no repository context could implement the grammar from this file alone —
      have a second agent (or a careful self-review) try to state the algorithm back from the
      document only, and fix whatever it gets wrong.

## Verification

```bash
node --test test.mjs                                   # includes the doc-link and injector tests
npx @hrg/inject-examples --check README.md doc/usage.md
```

Two things the link test does **not** catch, so check them by eye: it strips inline code
before scanning, and for a link with both a path and a fragment it only checks that the
*path* exists — the fragment is ignored. So `[…](./README.md#no-such-heading)` passes. Keep
cross-file fragments either absent or verified by hand.

## Commit

One commit: `docs: add the normative file-section matching spec`.
Name the contract in the commit body so the provenance is obvious.

## Handoff note

Steps 3–8 implement exactly this document. If, while implementing, a step finds that this
spec and the contract disagree, **the contract wins** and this document is the thing to fix
— in the same commit, with the reason stated.
