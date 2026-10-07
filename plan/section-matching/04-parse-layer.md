# Step 4 — Parse layer (`lib/section.mjs`)

**Depends on:** [00-contract.md](00-contract.md), step 3 (failing tests).
**Blocks:** step 5. **Size:** small-medium. One commit.

## Goal

Create `lib/section.mjs` and implement **only** reference parsing: canonicalisation, the
grammar errors, and the contradiction warning. No block scanning, no resolution — those are
steps 5 and 6. At the end of this step the module parses a reference into a value object, or
throws, or reports a warning.

The tests from step 3 for grammar errors (`test group 4`) and canonicalisation must pass;
the resolution tests stay red.

## The module's boundary (from the contract §10)

`lib/section.mjs` must not import or reference `node:fs`, `node:path`, `process`, `cli.mjs`,
or anything that reads the disk or environment. Only pure computation. A test asserts this
at step 8; do not make it false now.

Use ESM (`export function …`), matching `index.mjs`'s style. Do not add dependencies.

## API to implement in this step

```js
/** @typedef {'declaration' | 'body' | 'annotated' | 'documented'} Scope */

/**
 * @typedef {object} Reference
 * @property {string}   raw        the reference exactly as written (pre-normalisation)
 * @property {string}   canonical  the normalised form: path + trailing modifier
 * @property {string[]} segments   path segments, in order; 1..8 of them
 * @property {Scope}    scope      what the trailing modifier selects
 * @property {null | { kind: 'contradiction', kept: '++' | '+', dropped: '-' }} warning
 */

/** @throws {SectionReferenceError} */
export function parseReference(reference) {}

/** `true` when the reference has no `/` (search the whole file). */
export function isSingleSegment(reference) {}   // takes a Reference or a string; document which

/** The last segment's name — the section that gets injected. */
export function finalSegment(reference) {}

/** The error type for a malformed reference. */
export class SectionReferenceError extends Error {}
```

Returning a `warning` field rather than logging is deliberate: this module is pure and must
not print. Step 7 formats the message and owns the exit code.

## Canonicalisation (contract §7)

Normalise first, then parse:

1. If the reference starts with `++`, `+` or `-`, detach that modifier and remember it as
   "detached".
2. If the **second** segment starts with exactly one `-` and nothing was detached, detach
   that `-` (`Cart/-Line` → `Cart/Line-`).
3. If both a detached leading modifier and a trailing modifier are present (`-a-`), throw
   `"#region:<raw>" carries more than one modifier`.
4. Split the remainder on `/` and parse the trailing modifier off the **last** segment
   (`'++'` before `'+'` before `'-'`).
5. After normalisation, any `+` or `-` anywhere except the very end is an error:
   `"<char>" may only modify the last path segment of "#region:<raw>"`.
6. More than 8 segments is an error. An empty segment (leading, trailing, or `//`) is an
   error.

Modifier → scope mapping (unchanged from today's `codeReference`):

| Modifier | Scope |
| --- | --- |
| none | `declaration` |
| `-` | `body` |
| `+` | `annotated` |
| `++` | `documented` |

`canonical` is the normalised string, for example `Cart/-Line` → `Cart/Line-`, `-add` →
`add-`, `Cart/Line/render` → unchanged. `raw` keeps the original, and **every error
message quotes `raw`** (contract §9).

## The contradiction warning (contract §11)

When both `++` and `-` are present — in either order, whether one was detached or in the
path — do **not** throw. Return the reference with:

- `scope` set from the **dominant** modifier: `++` beats `+` beats `-` beats none;
- `warning: { kind: 'contradiction', kept: '++', dropped: '-' }` (or `kept: '+'` when the
  pair is `+` with `-`);
- `canonical` as if the `-` were absent (`getUsers++-` → `getUsers++`).

Examples that must warn and resolve to `documented`: `a++-`, `a-++`, `a-/b++`. Examples
that must warn and resolve to `annotated`: `a+-`, `a-+`. Examples that must **throw** (one
modifier named twice, not a contradiction): `a+++`, `a---`, `a--`.

Purity note: the warning is *data* on the returned value. Nothing in this module prints,
throws, or changes a status code.

## Tests this step must make pass

- **Grammar and canonicalisation, group 1** — `add`, `add-`, `add+`, `add++`, plus the old
  `-add`, `+add`, `++add` giving identical `segments`/`scope`; `canonical` is the trailing
  form for the old spellings.
- **Group 2** — `Cart/Line/render` → `segments: ['Cart','Line','render']`, `scope:
  'declaration'`, `warning: null`.
- **Group 3** — `Cart/Line-`, `Cart/-Line`, `-Cart/Line`, `Cart/Line/render-`,
  `Cart/Line/-render` all produce one trailing modifier and the same `scope`/`segments`.
- **Group 4** — the error list throws, with messages matching the contract §9 shapes.
- **Group 5** — the contradiction cases return the dominant scope and a non-null `warning`.
- **Group 6** — the boundary: `a+++` throws while `a++-` warns.

Add these as focused `parseReference` unit tests in `test.mjs`, in a clearly delimited
section. They belong next to (not mixed into) the step 3 block.

## Out of scope

- No block scanning, no mask pass, no `resolveSection` (steps 5–6).
- Do not touch `index.mjs` (step 7). In particular **do not** delete `codeReference` yet:
  `index.mjs` still exports it and `test.mjs` still tests it. Both are removed/replaced in
  step 7.
- Do not touch `test/fixtures/**`, `doc/**`, `README.md`, `src/**`.
- Do not make the step 3 resolution tests pass by stubbing `resolveSection`.

## Done when

- [ ] `lib/section.mjs` exists, exports `parseReference`, `isSingleSegment`, `finalSegment`,
      `SectionReferenceError`, and imports nothing from Node.
- [ ] All six grammar/canonicalisation test groups pass.
- [ ] Every step 3 resolution/anchor test is **still failing**, and still failing for a
      resolution reason (not because the module is missing). If a step 3 test imported
      `./index.mjs`, it must still fail through that path unchanged.
- [ ] `node --test test.mjs` shows no new failures outside the intended red set.
- [ ] Error messages quote `raw`, verified by a test that types `Cart/-Line` and asserts the
      message contains `Cart/-Line` (not the canonical form).

## Verification

```bash
node --test test.mjs
node -e "import('./lib/section.mjs').then(m => console.log(m.parseReference('Cart/Line/render-')))"
grep -nE "node:fs|node:path|process\.|cli\.mjs" lib/section.mjs   # expect no matches
```

## Commit

`feat(section): parse file-section references, canonicalise, warn on contradictions`
