# Step 5 — Scanner layer (`lib/section.mjs`)

**Depends on:** [00-contract.md](00-contract.md), step 4. **Blocks:** step 6.
**Size:** medium-large — this is the biggest step. One commit.

## Goal

Add to `lib/section.mjs` the two things the resolver needs to answer "is there a block named
X here": the **mask pass** (blank out comments and string literals so brackets can be
counted) and the **block scanner** (find every block, and every nameable thing inside it).

The scanner returns **data only**. It produces no injected strings and makes no modifier
decisions — that is step 6. Keeping the split sharp is what keeps both steps small.

## Part A — the mask pass

Port `strippedCode` from `index.mjs:222` into `lib/section.mjs` (same algorithm, same
behaviour; `index.mjs` keeps its copy until step 7 and then imports this one).

Required behaviour, all of which already holds today and must not regress:

- `//` to end of line, `/* … */` (including an unterminated one, which runs to EOF), and `#`
  to end of line are blanked — **except** `#` immediately followed by `[`, which keeps a
  Rust attribute (`#[derive(Debug)]`) readable.
- `"`, `'` and backtick strings are blanked, including triple-quoted forms (`"""`, `'''`,
  and a backtick fence of three) and backslash escapes.
- Blanking replaces characters with spaces but **never touches `\n`**, so every offset and
  every line boundary is preserved: `masked.length === text.length` and line *n* occupies the
  same offsets in both. Assert both.
- Astral characters (`𝕏`) are two UTF-16 code units, exactly as today.

Also export a **line scanner** for the next part:

```js
/** Comment-only spans, per line index: [{ text, from, to }], where text is the comment
 *  body (the `//` or `/*` delimiters stripped). */
export function commentsIn(text) {}
```

`commentsIn` must read the **original** text (a comment cannot be recovered from the mask)
and must not report comment markers that sit inside string literals. This matters: comment
anchors (§6 matcher 6) are found through this function, while everything structural is found
through the mask.

## Part B — the scanner

```js
export function scanBlocks(text, path) {}   // path is used only for line-ending/language
                                            // decisions if needed; document what it is for
```

`scanBlocks` returns the block tree plus, per scope, the indexable things in it. Define the
shapes in the module and document them; a workable structure:

```js
/** @typedef {{ kind: 'class'|'method'|'property'|'statement'|'anchor'|'root',
 *              name: string|null,
 *              declLine: number, openLine: number|null, closeLine: number|null,
 *              headerFrom: number|null, open: number|null, close: number|null,
 *              indented: boolean,
 *              children: Block[] }} Block */
```

Requirements:

- **Braced blocks**: `class`/`interface`/`enum`/`record`/`struct`/`trait`/`object`/`union`
  (matcher 2), named methods/constructors/functions/arrow-valued properties **with a body**
  (matcher 3), field/constant declarations (matcher 4), and statement blocks — `if`, `else`,
  `for`, `while`, `do`, `switch`, `try`, `catch`, `finally`, `synchronized` (matcher 5).
- **Body-less members are skipped**: an interface method, or an `abstract` one, has nothing
  to inject. Today's `declarationRange` returns `null` for these; preserve that.
- **Indented blocks** (Python/Ruby) still work, as today: no brace, body delimited by
  indentation, `indented: true`. A statement block in an indented language has no brace, so
  **comment anchors do not apply** there (contract §6 matcher 6 says "braced block").
- **Allman braces** (`void run()` newline `{`) and **arrow bodies** (`=> { … }`, and the
  expression form `=> expr`) keep today's handling.
- **Nesting**: children are the blocks contained in a block's body, in source order.
- **Nesting depth is bounded by the text**, not by the 8-segment reference cap. A deep file
  must not blow the stack: if you recurse, make the recursion depth proportional to nesting
  (fine for real files) and note the assumption; do not recurse per character.

### Per-scope indexes the scanner must expose

For each scope (the file as scope 0, and every block), the scanner must make these
answerable — a list, or a method, your choice, but the information must be there:

1. **Region directives** (matcher 1): every `#region <name>` … `#endregion` pair whose
   enclosing scope is this one, with the line span *strictly between* the directives.
   Reuse the existing `regionDirective` and `extractRegion` semantics from `index.mjs`
   (comment prefixes, the C# `#region` without a prefix, bare `region x` is prose). Duplicate
   names in one scope must be detectable (step 6 throws on them).
   A dangling `#endregion` or an unclosed `#region` keeps today's behaviour: reportable.
2. **Declarations** (matchers 2–4): name → block(s), in source order.
3. **Condition literals** (matcher 5): for each statement block, the exact double-quoted
   string literals on its header line. Record:
   - both the **byte-exact** literal, and a **token-pasted** form (adjacent literals joined,
     so `"get" "Users"` and `"get"+"Users"` yield `getUsers`); the matcher uses the
     token-pasted form, which is a strict superset of the byte-exact form;
   - the literal must be a string literal in the code, never text inside a comment (so read
     it from the mask or from `commentsIn`, but not from raw text);
   - `"getUsers".equals(methodName)` therefore yields `getUsers`.
4. **Comment anchors** (matcher 6): for each **braced** block, the comment that is the first
   non-blank thing after the opening brace — same line (`{ //getUsers`) or the next non-blank
   line. Record the comment line index and the anchor name. Rules:
   - the comment body is trimmed, and the name is the **whole** trimmed body, so `//getUsers`
     gives `getUsers` and `// getUsers` gives `getUsers` too;
   - `#region` / `#endregion` comment lines are **never** anchors;
   - a comment that is not the first thing in the block is not an anchor;
   - `/*name*/` is also an anchor form.

## Tests to add in this step

Unit-test the scanner directly, in `test.mjs`, in its own delimited section. At minimum:

- `masked.length === text.length`, and every `\n` is at the same offset in both.
- Braces and the words `region` inside strings and comments do not affect the mask's bracket
  structure: `String s = "}";`, `/* } */`, `// }`, `"a // b"`, `'#'`.
- A `#` comment vs a `#[attr]` attribute.
- Triple-quoted and escaped-quote strings.
- `scanBlocks` finds: a nested class and its methods; an Allman method; an arrow body and an
  expression-bodied arrow; a body-less interface method (present as a name, but with no
  injectable range); a Python indented method; a statement block.
- Condition literals: `if ("getUsers".equals(m))` yields `getUsers`; `String s = "getUsers";`
  yields **nothing**; a literal in a comment yields nothing; `while`/`switch`/`catch` headers
  yield their literals.
- Comment anchors: same-line and next-line forms, `// getUsers`, `/*getUsers*/`,
  `// #region foo` is **not** an anchor, and a non-first comment is not an anchor.
- Region directives: `example.ts`'s `table` and `config` regions scan with the right spans.

## Out of scope

- No resolution, no precedence, no modifier application (step 6).
- Do not touch `index.mjs` — it keeps its own copies until step 7.
- Do not change step 3's expectations or step 4's `parseReference`.
- Do not touch `src/**`, `doc/**`, `README.md`, `test/fixtures/**`.

## Done when

- [ ] `masked`, `commentsIn` and `scanBlocks` are exported and unit-tested as above.
- [ ] The step 3 resolution tests are **still red**, and still red for a resolution reason.
- [ ] Every step 4 test still passes.
- [ ] `node --test test.mjs` shows no new failures outside the intended red set.
- [ ] `lib/section.mjs` still imports nothing from Node (grep for `node:`, `process.`).

## Verification

```bash
node --test test.mjs
grep -nE "node:|process\.|require\(" lib/section.mjs    # expect no matches
```

Sanity-check the scanner by dumping it, for example:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { scanBlocks } from './lib/section.mjs';
const text = readFileSync('test/fixtures/Anchors.java', 'utf8');
console.log(JSON.stringify(scanBlocks(text), null, 1));
"
```

The anchors in `Anchors.java` must be visible as blocks with the right line spans.

## Commit

`feat(section): add the mask pass and the block scanner`
