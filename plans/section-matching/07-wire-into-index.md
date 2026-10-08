# Step 7 — Wire `index.mjs` into the new module

**Depends on:** [00-contract.md](00-contract.md), step 6. **Blocks:** step 8.
**Size:** medium. One commit.

## Goal

Make the real tool use `lib/section.mjs`, prove existing behaviour is byte-identical, and
surface the contradiction warning through the library and the CLI — without changing any
other public behaviour, and without deleting anything a test still relies on.

This step is where the regression risk lives. Treat "the existing suite is green" as the
primary acceptance criterion, not a formality.

## Task 1 — delegate the code rule

In `index.mjs`:

- `extractCodeRegion(text, region)` becomes a thin wrapper: `return resolveSection(text, region)`.
  Keep its exported name and signature.
- Move `strippedCode`, the declaration renderer (`renderDeclaration`), `annotationStart`,
  `docCommentStart` and the declaration matchers **into** `lib/section.mjs` if step 5/6 left
  copies behind, and import them back if `index.mjs` still needs them. There must end up
  **one** implementation of each — the scanner in `lib/` is the only matcher.
- `CODE_RULE` keeps its shape (`{ name, extensions, resolve }`) and now resolves through the
  new module.

## Task 2 — keep every remaining export working

These are exported and tested; check each one against `test.mjs` before you touch it:

| Export | What to do |
| --- | --- |
| `extractCodeRegion` | delegate (task 1) |
| `extractDeclaration` | **keep working**. It is unit-tested directly (a method, a class, an Allman body, an indented Python body, arrow functions, body-less members, duplicates) and it takes one name, not a path. Implement it as a wrapper that uses the new scanner's **declaration index** at scope 0 with the same depth descent, applying the scope modifier through the shared renderer — *not* by deleting it, and **not** by calling `resolveSection`, which would also match a `#region` directive of that name and change its documented meaning. If a test's expectation genuinely must change, stop and report; the contract says behaviour is unchanged. |
| `extractRegion` | unchanged; the new scanner must reuse its semantics, not fork them |
| `codeReference` | **keep it exported and unchanged.** `test.mjs` asserts its exact outputs (`{scope:'declaration',name:'add'}` and so on). The new `parseReference` supersedes it internally; the old function stays for now, with a comment saying it is superseded. Do not remove it in this step. |
| `parseMarker`, `findMarkers`, `injectInto`, `fenceRanges`, `ruleFor`, `REGION_RULES`, `normalize`, `fileLanguage`, `fileReader`, ignore machinery | untouched |

Re-export whatever of `lib/section.mjs` is useful for consumers: at minimum
`resolveSection`, `planSection`, `parseReference`, `scanBlocks`, `SectionReferenceError`.

## Task 3 — carry the warning (library)

A pure rule interface returns a `string`, so the warning needs a defined path. Do this:

```js
/** The text a marker stands for, plus the section warning when the code rule produced one.
 *  @returns {{ text: string, warning: object | null }} */
export function planMarker(marker, read, rule = ruleFor(marker.path)) {}
```

- When `rule` is the built-in `CODE_RULE` **and** the marker has a `region`, use
  `planSection(text, marker.region)` and return its `{ text, warning }`.
- Otherwise resolve exactly as today (`rule.resolve(text, region, path)`, or `normalize(text)`
  for a whole-file marker) and return `{ text, warning: null }`.
- `resolveMarker` keeps returning the **string** (`planMarker(...).text`), so its existing
  tests are untouched.

In `updateDocument`, every non-skipped result entry carries `warning: <object | null>`
alongside `{ marker, content, changed, skipped }`. A skipped entry keeps its current shape
(and may carry `warning: null`).

## Task 4 — surface the warning (CLI)

In `cli.mjs`, follow the **existing** failure-warning shape rather than inventing a new one.
The current per-marker warning is:

```js
console.error(`inject-examples: warn: ${display(file)}:${marker.index + 1}: ${marker.raw}: ${failure}`);
```

Add a parallel line for a section warning, using the message the contract fixes
(no double `warn:`):

```text
inject-examples: warn: <file>:<line>: <marker.raw>: "+/-" contradicts "++"; using "#region:<canonical>"
```

Requirements:

- It is printed **in every mode**: normal, `--check`, `--dry-run`, `--lenient`, and
  regardless of `--quiet` (a warning is a finding, like `failed`, not decoration). If
  `--quiet` currently suppresses the failure warnings, put the section warnings in the same
  place as them for consistency and say so in the commit message.
- It is printed **once per marker**.
- The summary counts it: extend the closing summaries with `, N warning(s)` when `N > 0`
  (the existing `skipNote` / `failedNote` pattern).
- **The exit code is 1 whenever a warning was emitted**, in every mode, including when every
  block was written and `--check` found nothing stale. This is the contract's deliberate
  exception to "0 = everything up to date". Implement it where the document's exit code is
  computed, and make sure `--out` and multi-target runs take the worst code as they do today.

## Tests to add in this step

- **Library**: `updateDocument` over a document whose marker uses `getUsers++-` returns a
  result entry with a non-null `warning`, injects the same text as `getUsers`, and reports
  `changed` correctly; a second pass reports `changed: false` and warns again.
- **CLI**: `main([doc])` for that document returns **1** and prints the warning line; the
  document is still written; `main([doc, '--check'])` returns 1 too when nothing is stale.
  Capture stderr to assert the line (the existing CLI tests use temporary directories — follow
  that pattern).
- **Regression**: the two message-regex assertions noted in the contract §9 still pass
  unchanged (`/no "#region missing" found/` etc.). If they do not, **fix the implementation's
  message**, not the test — that is the whole point of the back-compatibility clause.
- **Boundary**: `a+++` still throws (an error, not a warning) end to end through
  `updateDocument` and the CLI.

## Out of scope

- Do not touch `test/fixtures/**`, `doc/**`, `README.md`, `src/**`.
- Do not change `parseMarker`, fences, gitignore, `--out` semantics, or the JSON rule.
- Do not add the vectors gate (step 8) or the docs (step 9).
- Do not remove `codeReference` or `extractDeclaration`.

## Done when

- [ ] `index.mjs` has one matcher implementation, in `lib/section.mjs`, and delegates.
- [ ] `node --test test.mjs` is **fully green** — including every pre-existing test, the
      step 3 block, and the new warning tests.
- [ ] `npx inject-examples --check README.md doc/usage.md` exits 0 and writes nothing.
- [ ] `node cli.mjs README.md --dry-run` reports no changes.
- [ ] `lib/section.mjs` still has no Node imports; `index.mjs` is still the only place that
      reads the disk.
- [ ] No existing test was edited except, at most, the deliberate message-regex pair from the
      contract §9 — and if you touched those, the commit body says why.

## Verification

```bash
node --test test.mjs
npx @hrg/inject-examples --check README.md doc/usage.md; echo "exit=$?"
grep -nE "node:|process\." lib/section.mjs      # expect no matches
```

## Commit

`refactor: delegate section resolution to lib/section.mjs and warn on contradictions`
