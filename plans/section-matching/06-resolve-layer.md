# Step 6 — Resolve layer (`lib/section.mjs`)

**Depends on:** [00-contract.md](00-contract.md), step 5. **Blocks:** step 7.
**Size:** medium. One commit.

## Goal

Turn a parsed reference plus a scanned file into the text to inject: matcher precedence, the
scope walk for slashed paths, and modifier application. This is the step that makes every
step 3 test green.

## API to add

```js
/**
 * The text a section reference stands for.
 * @param {string} text        the target file's content
 * @param {string} reference   the section reference (`#region:` fragment content)
 * @throws {SectionReferenceError} malformed reference
 * @throws {Error}                 the reference is fine but matches nothing
 */
export function resolveSection(text, reference) {}

/**
 * The same resolution, with the warning surfaced instead of swallowed.
 * @returns {{ text: string, reference: Reference }}
 *          `reference.warning` is non-null for a contradictory modifier (contract §11)
 */
export function planSection(text, reference) {}
```

`resolveSection` is the convenience form and is what the rule registry calls; `planSection`
exists because a pure module cannot log, and step 7 needs the warning to print it. Both share
one implementation — `resolveSection` is `planSection(...).text`.

## The resolution algorithm

1. `parseReference(reference)`; on a malformed reference the `SectionReferenceError`
   propagates (step 4).
2. Blank the file (step 5) and scan it into scopes (step 5).
3. **Walk the segments.** For segments before the last: resolve the segment in the current
   scope, then require the result to be a **container** (a block with a body). If the segment
   matches nothing, throw `no section named "<name>" in "<previous>"`; if it matches
   something with no body, throw `"<name>" is not a container`.
4. **For the last segment**, match in precedence order (contract §6) within the current
   scope:

   | # | Matcher | Resolution |
   | --- | --- | --- |
   | 1 | Region directive | the lines strictly between the directives. A duplicate name in one scope is an error. **The trailing modifier is ignored.** |
   | 2 | Class-like declaration | the block's declaration (or the modified part, §8) |
   | 3 | Method / function | the same, for a body-carrying member |
   | 4 | Property | the whole statement; `-` gives the initialiser expression when there is one |
   | 5 | Condition literal | the block, header line through closing brace; `-` gives the body inside the braces |
   | 6 | Comment anchor | the block, **including the anchor comment line**; `-` gives the body only |

5. **If nothing matched in this scope**, descend into every child block of this scope, left to
   right (source order), depth first, and retry step 4 at each. First hit wins, and the walk
   stops there. This is what makes a bare name find a nested method.
6. If the whole walk finds nothing: `no "#region <name>" found, and no section named "<name>"`
   — keep that prefix, it is asserted by existing tests (contract §9).

Important consequences, each of which deserves a test:

- A single-segment reference searches the file at any depth; a slashed reference searches the
  first segment globally, then every later segment **only inside the scope the previous one
  found**.
- Class beats a same-named constructor (matcher 2 before 3), as today.
- A top-level `#region add` beats a method named `add`, because matcher 1 outranks matcher 3.
- Depth descent happens **only after** matchers 1–6 have failed *in the current scope*, so an
  outer candidate always wins over a nested one at the same segment.

## Modifier application (contract §8)

- **Declaration** — reuse the existing renderer. `renderDeclaration`, `annotationStart` and
  `docCommentStart` are already correct in `index.mjs` (lines ~399–465); move them into
  `lib/section.mjs` unchanged rather than rewriting them, and keep their exact output.
- **Region** — ignore the modifier entirely: `add+` and `add` inject the same lines.
- **Condition literal / comment anchor** — the block is the unit:
  - no modifier or `+` → from the block's first line through its closing brace, where the
    first line is the anchor comment line, or the statement header line for a literal;
  - `-` → the text strictly inside the braces. On a single-line block
    (`void handler() { //getUsers ... }` written on one line) `-` is the text between the
    braces, trimmed — the same rule today's `renderDeclaration` uses for `body` scope;
  - `++` behaves like `+` (there is nothing to document).
- **Property** — the whole statement for no modifier, `+`/`++`; the initialiser expression
  (trimmed, without the trailing `;`) for `-` when there is one, and the whole statement when
  there is not.

## Tests this step must make pass

All of step 3's resolution tests (contract §12), against the real fixtures:

- **`Example.java`**: `toString` and its `-`/`+`/`++` forms and their old-spelling
  equivalents, `Line`, `Cart/Line`, `Cart/toString`, `Cart/Line/render`,
  `Cart/Line/render-`, `Cart/Line/-render`, `Cart/Line-`.
- **`Anchors.java`**: `getUsers`, `getUsers-`, `dispatch/getUsers`, `getOrders`,
  `handler/getUsers`, `handler/getUsers-`, `other/getOrders`, `other/getOrders-`, and the
  negative `commentFromString/getUsers`.
- **Errors**: `Line/toString`, `Cart/Line/render/extra`, `Cart/Cart`, `nope/deeper`, and
  `getusers` (case-sensitive miss).
- **Walk order**: `getUsers` on `Anchors.java` is matched by the condition literal in
  `dispatch`, not the anchor on `handler` — `dispatch` comes first. Pin it.
- **Ambiguity pin**: two inner classes each with a `render`; `Line/render` resolves the right
  one, and the bare `render` resolves to whichever comes first in the walk. Add the second
  `render` in an in-memory text (not to the shared fixture, which step 3 froze) so the fixture
  bytes do not change under an already-committed step.
- **Contradiction warnings**: `getUsers++-` resolves to the same text as `getUsers`, with
  `planSection(...).reference.warning` non-null. This is where step 3's `TODO(step 4)` comment
  gets its assertion.

## Out of scope

- Do not touch `index.mjs` (step 7). `extractCodeRegion`, `extractDeclaration`, `codeReference`
  and `strippedCode` all still live there and must keep working.
- Do not add `resolveSection` to `CODE_RULE` yet — that is step 7.
- Do not touch `doc/**`, `README.md`, `test/fixtures/**`, `src/**`.
- Do not implement the CLI warning output or an exit code — step 7.

## Done when

- [ ] `resolveSection` and `planSection` are exported; every step 3 resolution test passes.
- [ ] Every earlier step's tests still pass (no regression in `parseReference` or the
      scanner).
- [ ] `lib/section.mjs` still imports nothing from Node.
- [ ] No step 3 expectation was edited to make a test pass. If one genuinely is wrong, stop
      and report it rather than changing it — the contract is the source of truth.
- [ ] `node --test test.mjs` is green for the section tests; the remaining red set, if any,
      is only what step 7 or 8 owns.

## Verification

```bash
node --test test.mjs
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { resolveSection } from './lib/section.mjs';
const t = readFileSync('test/fixtures/Example.java', 'utf8');
console.log(JSON.stringify(resolveSection(t, 'Cart/Line/render-')));
"
```

## Commit

`feat(section): resolve sections by matcher precedence, scope walk and modifier`
