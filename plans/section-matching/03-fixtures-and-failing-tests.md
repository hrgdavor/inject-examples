# Step 3 — Fixtures and failing tests

**Depends on:** [00-contract.md](00-contract.md), step 1 (harness off).
**Blocks:** steps 4–6 (they make these tests pass). **Size:** medium. One commit.

## Goal

Fix the **expected bytes** before writing the algorithm. This step adds one fixture file and
a block of failing tests that pin every case in the contract's worked examples (§12) plus the
grammar errors and the contradiction warning. Steps 4–6 then have an unambiguous target and
are forbidden from editing these expectations to make themselves pass.

## The discipline (read this before writing a single expectation)

- Every expected string below is **derived from the fixture bytes** in this document. Copy
  the derivation, do not re-invent it, and do not "adjust" an expectation to match what the
  implementation produces. If an expectation looks wrong, stop and report — do not edit it.
- Indentation is part of the expected value. The fixtures use four spaces per level.
- Tests must fail **for the right reason** at the end of this step: `assert.throws` cases
  generally already pass (today's code rejects almost every new reference), while the
  positive cases fail because today's matcher cannot find the section. A positive case that
  *passes* now means the expectation is wrong — investigate before continuing.

## Task 1 — the fixture

Create `test/fixtures/Anchors.java` with exactly these bytes (four-space indentation, LF
endings, trailing newline):

```java
package example;

/** A dispatch table keyed by method name. */
public class Anchors {
    /** Run one named method. */
    public void dispatch(String methodName) {
        if ("getUsers".equals(methodName)) {
            System.out.println("users");
        } else if ("getOrders".equals(methodName)) {
            System.out.println("orders");
        }
    }

    public void handler() { //getUsers
        System.out.println("anchor same line");
    }

    public void other() {
        //getOrders
        System.out.println("anchor next line");
    }

    public void commentFromString() {
        String s = "getUsers";
        System.out.println(s);
    }
}
```

Notes on what each part is for:

- `dispatch` carries two **condition literals** in the same method, so "first match wins"
  and case-sensitivity both have something to bite on.
- `handler` is a **same-line comment anchor** (`{ //getUsers`).
- `other` is a **next-line comment anchor** (`{` then `//getOrders`).
- `commentFromString` is the **negative case**: a string literal that merely mentions a name
  must not match.

Do not add `#region` directives to this file: it exercises the code matchers only. Region
behaviour is already covered by `test/fixtures/example.ts`.

## Task 2 — the test block

Add a clearly delimited block of tests to `test.mjs`, following the file's existing style
(it imports from `./index.mjs`; the new cases may import from `./lib/section.mjs` **only in
step 4 and later** — in this step, import from `./index.mjs` and call the existing
`extractCodeRegion`, so the failing tests exercise today's entry point and stay valid once
step 7 wires it through).

Read the fixture with the existing `fileReader` / `read` helper, as the current
java-fixture test does, so the tests use the real file bytes.

### 2a. Existing `Example.java` behaviour must not change

Pin these with the values already asserted elsewhere in `test.mjs` (reuse them verbatim;
they are today's behaviour and must stay byte-identical):

| Reference | Expected |
| --- | --- |
| `toString` | declaration, 3 lines, indented 4 |
| `toString-` and `-toString` | `        return String.join(",", items);` |
| `toString+` and `+toString` | `@Override` line + declaration |
| `toString++` and `++toString` | doc comment + `@Override` + declaration |
| `Line` | the whole inner class, 11 lines |
| `Cart/Line` | identical to `Line` |
| `Cart/toString` | identical to `toString` |

### 2b. New nested behaviour

For `Example.java`, pin as `assert.equal` against string literals built from the fixture:

| Reference | Expected |
| --- | --- |
| `Cart/Line/render` | `        String render() {\n            return name + " x" + quantity;\n        }` |
| `Cart/Line/render-` | `            return name + " x" + quantity;` |
| `Cart/Line/-render` | same as `Cart/Line/render-` (canonicalisation) |
| `Cart/Line-` | `Line`'s declaration minus its first line and its last line: the two field lines, the blank line, the constructor, the blank line, and `render` — indented 8, with no `public static class Line {` and no closing `    }` |

State `Cart/Line-` as a string literal of six lines:
`        private final String name;`, `        private final int quantity;`, ``, the
constructor's four lines (indented 8), ``, and `render`'s three lines (indented 8). Build it
by slicing the fixture in the test if that is clearer, but assert on the exact joined text.

### 2c. Anchors (against `Anchors.java`)

| Reference | Expected |
| --- | --- |
| `getUsers` | the whole first `if` block of `dispatch`: `        if ("getUsers".equals(methodName)) {` newline `            System.out.println("users");` newline `        }` |
| `getUsers-` | `            System.out.println("users");` |
| `dispatch/getUsers` | identical to `getUsers` |
| `getOrders` | the `else if` block: `        } else if ("getOrders".equals(methodName)) {` … — pin exactly what the fixture says, including the leading `} ` |
| `getUsers` on the anchor fixture | **ambiguous**: both the condition literal in `dispatch` and the comment anchor on `handler` are candidates. Assert **first match wins** and pin which one (depth-first, left to right: `dispatch` comes first, so its `if` block wins). Add a second test asserting `handler/getUsers` reaches the anchor case |
| `handler/getUsers` | `    public void handler() { //getUsers` newline `        System.out.println("anchor same line");` newline `    }` |
| `handler/getUsers-` | `        System.out.println("anchor same line");` |
| `other/getOrders` | `    public void other() {` newline `        //getOrders` newline `        System.out.println("anchor next line");` newline `    }` |
| `other/getOrders-` | `        System.out.println("anchor next line");` |
| `commentFromString/getUsers` | **error**: `"getUsers"` appears only in a local variable's initialiser, not in a statement header, and there is no `getUsers` anchor in that method — so the segment matches nothing |
| `commentFromString/getUsers-` | same error |

### 2d. Grammar errors (must throw)

Assert `assert.throws(..., /<message fragment>/)` for each, using the contract §9 message
shapes — this subtask is the step's coverage of the error catalogue, and step 4 calls it
"test group 4":

`''` → names nothing; `'a/'`, `'/a'`, `'a//b'` → empty path segment; `'a/+b'`, `'a/b/-c'` →
modifier only at the last path segment; `'a+++'`, `'a---'` → more than one modifier;
`'a/b/c/d/e/f/g/h/i'` (9 segments) → deeper than 8 sections.

Leave `'a--'` out of this step's error list: it is rejected as *two modifiers* by the same
rule as `a+++`, so it belongs with that assertion if you want it.

### 2e. The contradiction warning

Assert that a contradictory reference **is not an error** and resolves to the dominant
reading, for `'getUsers++-'`, `'getUsers-++'`, `'getUsers+-'`, `'getUsers-+'`:

- resolved text equals the plain `getUsers` text (the `-` is dropped);
- a warning is reported.

The warning's reporting surface is defined in step 4 (`parseReference` returns a `warning`
field) and step 7 (the CLI prints it and exits 1). In **this** step, write the assertions
against the piece that exists now — the resolved text — and add a `TODO(step 4)` comment for
the `warning` field assertion, so the intent is recorded where it will be finished.

## Out of scope

- Do not create `lib/section.mjs` (steps 4–6).
- Do not modify `index.mjs` (step 7).
- Do not modify `doc/usage.md`, `README.md`, or `test.mjs:1290`'s count.
- Do not "fix" any existing test.
- Do not touch `src/**`.

## Done when

- [ ] `test/fixtures/Anchors.java` exists with the bytes above.
- [ ] The new tests are present, named clearly, and grouped with a comment header.
- [ ] The suite runs: `node --test test.mjs` — the new positive tests **fail**, and every
      pre-existing test still **passes**.
- [ ] Every failure message points at a section the old matcher cannot find (an error such
      as `no "#region …" found`), not at a syntax/parse error in the test file itself.
- [ ] No expectation was copied from an implementation run; each traces to a fixture slice.
- [ ] `git diff --stat` shows only `test.mjs` and the new fixture.

## Verification

```bash
node --test test.mjs          # expect new failures, zero new failures elsewhere
git status --short            # expect exactly test.mjs and test/fixtures/Anchors.java
```

Record in the commit body how many tests fail and that the failures are the intended
targets — the next agent needs to know the red state is deliberate.

## Commit

`test: pin the file-section matching contract as failing tests`
