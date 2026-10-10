# Step 8 — Golden vectors and the drift gate

**Depends on:** [00-contract.md](00-contract.md), step 7. **Blocks:** step 9.
**Size:** small-medium. One commit.

## Goal

Freeze the contract's behaviour as **data**: one JSON file of cases generated from the
JavaScript implementation, with a `--check` mode that fails when the committed file and the
current implementation disagree. Add it to `npm test`, so drift is a build failure rather
than a discovery.

The file's other purpose is forward-looking: when a later plan ports this syntax to another
language, these vectors are the machine-readable target. That plan is **not** written here —
this step only produces the data and the gate.

## Deliverable 1 — `tools/section-vectors.mjs`

A small script, no dependencies, two modes:

```bash
node tools/section-vectors.mjs            # write/update test/vectors/section-vectors.json
node tools/section-vectors.mjs --check    # compare; exit 1 and print a diff on drift
```

### The case list (hard-coded in the script, not discovered)

Include, at minimum, every row of the contract §12, plus:

| Group | Cases |
| --- | --- |
| Grammar | `add`, `add-`, `add+`, `add++`, `-add`, `+add`, `++add`, `Cart/Line/render`, `Cart/Line-`, `Cart/-Line`, `Cart/Line/-render` |
| Grammar errors | `''`, `a/`, `/a`, `a//b`, `a/+b`, `a/b/-c`, `a+++`, `a---`, `a--`, a 9-segment path |
| Warnings | `a++-`, `a-++`, `a+-`, `a-+` |
| Resolution | every §12 row for `Example.java` and `Anchors.java`, including the error rows and the case-sensitive miss `getusers` |
| Walk order | `getUsers` (must be the `dispatch` literal, not the `handler` anchor) |

Each case:

```json
{
  "name": "cart-line-render-body",
  "input": "test/fixtures/Example.java",
  "reference": "Cart/Line/render-",
  "text": "            return name + \" x\" + quantity;",
  "startLine": 13,
  "endLine": 13,
  "kind": "declaration",
  "error": null,
  "warning": null
}
```

- `input` is a **repo-relative path**, so the file is portable and re-generatable.
- `startLine`/`endLine` are the **1-based inclusive** span the text came from, and `kind` is the matcher that found
  it (`region`, `declaration`, `property`, `condition` or `anchor`). A consumer that *navigates* needs the span, and
  one that *explains itself* needs the kind, so both are pinned — otherwise a port could agree about the bytes and
  drift on the two answers around them. Parse-only rows carry `null` for all three.
- `error` is the thrown message for an error case, `null` otherwise.
- `warning` is `null`, or `{ "kind": "contradiction", "kept": "++", "dropped": "-" }`.
- Exactly one of `text` / `error` is non-null.
- **The reference is recorded as a string, and the `#region:` prefix is not part of it.**
  Keep the case list explicit and human-reviewable — it is documentation as much as test data.

### Determinism requirements

- Stable key order in every object, and a fixed case order (the list's order, never a map's
  iteration order).
- Sorted JSON or fixed insertion order — pick one and be consistent, so `--check` compares
  bytes, not "equivalent" JSON.
- The file is byte-identical across two runs on a clean tree. Verify by running the generator
  twice and diffing.
- A trailing newline at EOF, LF endings.

### `--check` behaviour

- Recompute all cases in memory, serialise the same way, compare with the committed file.
- On a difference: print which cases differ (name, and for a text difference the two values
  with visible escapes) and exit 1. Do not print the whole file.
- On a missing file: exit 1 with a message saying to run the generator.
- On agreement: exit 0, silent (or one short line).

## Deliverable 2 — wire it into `npm test`

`package.json`:

```json
"scripts": {
  "test": "node --test test.mjs && node tools/section-vectors.mjs --check",
  "vectors": "node tools/section-vectors.mjs",
  "compare:zig": "node tools/compare-zig.mjs"
}
```

`compare:zig` stays exactly as step 1 left it (disabled, not part of `test`). Do not add the
vectors check to any hook, workflow or publish step beyond `test`.

## Deliverable 3 — a test that the vectors are the contract's cases

Add a test in `test.mjs` that reads `test/vectors/section-vectors.json` and asserts each case
against a live `planSection` / `parseReference` call — so the vectors cannot silently contain
stale or hand-edited values that `--check` happens to reproduce because the generator was
edited alongside them. The distinction matters:

- `--check` catches "the implementation changed, the file did not";
- this test catches "someone relaxed a case so `--check` would pass".

Assert, per case: the same error message (or the same text), and the same warning object.

## Out of scope

- Do not write a Java/Zig/other consumer of the vectors. That is a **separate plan**, after
  the syntax is settled. `src/**` stays untouched and `compare-zig.mjs` stays off.
- Do not add the vectors for markers, fences, gitignore or the JSON rule — only section
  references. Those already have tests, and this file's contract is §5–§12.
- Do not touch `doc/**` or `README.md` (step 9).

## Done when

- [ ] `node tools/section-vectors.mjs` writes the file; running it twice produces no diff.
- [ ] `node tools/section-vectors.mjs --check` exits 0 on the committed file, and exits 1
      with a readable diff after a deliberate one-character edit to a `text` value (revert the
      edit afterwards).
- [ ] `npm test` runs both the suite and the vectors check, and is green.
- [ ] The new `test.mjs` case asserts the vectors against a live implementation call.
- [ ] `test/vectors/section-vectors.json` covers every contract §12 row and every group in
      the case-list table above.
- [ ] `git diff --stat` shows only `tools/section-vectors.mjs`, `test/vectors/section-vectors.json`,
      `package.json`, `test.mjs`.

## Verification

```bash
node tools/section-vectors.mjs
node tools/section-vectors.mjs --check; echo "exit=$?"      # expect 0
npm test
```

Then prove the gate bites: edit one expected string in the JSON, run `--check` (expect 1),
and `git checkout` the file.

## Commit

`test: add section-matching golden vectors with a drift gate`
