# Using inject-examples

A detailed guide to using inject-examples in a real project.

This document is built with the tool it documents: each code block below that
follows a marker line is not typed by hand. The marker names a real file in
this repository, and the tool rewrites the block with the file's current
content, so the document cannot drift from the files it shows. Every file
shown here is also exercised by the test suite — the examples are test data,
not prose; see [Examples and tests share the same files](#examples-and-tests-share-the-same-files).

## Contents

- [How this document is built](#how-this-document-is-built)
- [What ships](#what-ships)
- [Quick start](#quick-start)
- [Markers](#markers)
- [Regions](#regions)
- [Region rules by file type](#region-rules-by-file-type)
- [Fences](#fences)
- [Running the CLI](#running-the-cli)
- [Tolerating broken includes](#tolerating-broken-includes)
- [Using the library](#using-the-library)
- [Examples and tests share the same files](#examples-and-tests-share-the-same-files)
- [Keeping this document in sync](#keeping-this-document-in-sync)

## How this document is built

The whole document is one argument to the tool. Two commands keep it honest:

```
npx @hrg/inject-examples --root . doc/usage.md
npx @hrg/inject-examples --root . --check doc/usage.md
```

- `--root .` sets the root to the repository root. The document lives in a
  subfolder, so its markers use root-relative paths — `test/fixtures/before.md`
  — instead of `../` traversal. That is the same recipe the README gives for
  documents in subfolders, applied here to this document itself.
- The first command rewrites every block below a marker with the file's
  current text. The second only reports: anything stale or failed ends with
  exit `1` and writes nothing — that is the CI hook.
- This document ships with the repository, not with the npm package: the
  package's `files` field contains only `cli.mjs`, `index.mjs`, `README.md`
  and `LICENSE`, so the docs and their fixtures live in the source tree,
  where CI can check them in.

## What ships

The entire published package, verbatim:

[package.json](package.json)

```json
{
  "name": "@hrg/inject-examples",
  "version": "1.0.1",
  "description": "Keep Markdown examples in sync with the real files they show — inject file content, or one region of it, into the fenced block that follows a link.",
  "keywords": [
    "markdown",
    "readme",
    "documentation",
    "docs",
    "examples",
    "fixtures",
    "inject",
    "sync",
    "cli",
    "region",
    "gitignore"
  ],
  "license": "MIT",
  "author": "Davor Hrg",
  "repository": {
    "type": "git",
    "url": "https://github.com/hrgdavor/inject-examples"
  },
  "type": "module",
  "sideEffects": false,
  "main": "./index.mjs",
  "exports": {
    ".": "./index.mjs",
    "./cli.mjs": "./cli.mjs",
    "./package.json": "./package.json"
  },
  "bin": {
    "inject-examples": "./cli.mjs"
  },
  "files": [
    "cli.mjs",
    "index.mjs",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "test": "node --test test.mjs"
  }
}
```

## Quick start

Four steps:

1. Install the tool as a dev dependency: `npm install --save-dev @hrg/inject-examples`.
2. Add a marker line above the fenced block that should hold the file's
   content. The block may start empty or stale; the tool fills it.
3. Run the tool once: `npx @hrg/inject-examples <file>`.
4. Add the check to CI: `npx @hrg/inject-examples --check <file>`, so a stale block
   fails the build until it is regenerated and committed.

The next block is a live marker: it names `test/fixtures/before.md`, and the
tool keeps the block equal to that file. In a fresh repository the block
would start empty or stale; after one run it contains exactly what you see
here.

[test/fixtures/before.md](test/fixtures/before.md)

````markdown
## Example

```ts
import { inject } from 'acme';

inject('a', 'b');
```
````

Note the four-backtick fence: the fixture's own content contains
three-backtick fences, so its wrapper must be longer — see [Fences](#fences).

## Markers

A marker is a line that is nothing but a link, where the link's label names
the same path as its destination:

- The line is a label and a destination in square and round brackets, and
  nothing else.
- The label and the destination must be the same text, apart from a leading
  `./`.
- No URL scheme — `https://…` makes the line an ordinary link, never a marker.
- The only fragment allowed is one that names a region.
- Marker lines inside fenced blocks are inert, so this document can show
  marker syntax without injecting itself.

The document is scanned for markers from last to first, and each marker's
block is replaced in place — so a file whose *content* contains a line that
looks like a marker still works: injected content is data, not a new marker.

This is the real code that decides whether a line is a marker, injected from
`index.mjs` by its region:

[index.mjs](index.mjs#region:parseMarker)

```javascript
/**
 * Read one line as an injection marker, or return null.
 *
 * A marker is a line that is nothing but a link to a real path, labelled with
 * that same path — optionally naming a region in the fragment:
 *
 *     [fixtures/example-1/before.md](./fixtures/example-1/before.md)
 *     [fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)
 *
 * @returns {{ raw: string, path: string, region: string | null } | null}
 */
export function parseMarker(line) {
    const match = LINK.exec(line.trim());
    if (!match) return null;

    const [, label, destination] = match;
    if (HAS_SCHEME.test(destination)) return null;

    const hash = destination.indexOf('#');
    const path = hash === -1 ? destination : destination.slice(0, hash);
    const fragment = hash === -1 ? '' : destination.slice(hash + 1);

    const withoutDotSlash = (value) => value.replace(/^\.\//, '');
    if (withoutDotSlash(label) !== withoutDotSlash(path)) return null;

    // Normalise away a leading `./` so `path` is directly usable as a path.
    const relativePath = withoutDotSlash(path);
    if (relativePath === '') return null;

    if (fragment === '') return { raw: line.trim(), path: relativePath, region: null };

    // An unknown fragment means this is an ordinary link, not a marker.
    const region = /^region:(.+)$/.exec(fragment);
    if (!region) return null;
    return { raw: line.trim(), path: relativePath, region: region[1] };
}
```

## Regions

When only part of a file belongs in the document, the file carries region
directives and the marker names the region. The next block is one region of
`test/fixtures/example.ts`:

[test/fixtures/example.ts](test/fixtures/example.ts#region:table)

```typescript
| name | qty |
| ---- | --- |
| bolt | 12  |
```

The same file, a different region, through the same kind of marker — two
markers may point at different regions of one file, because the duplicate
rule only forbids identical marker text:

[test/fixtures/example.ts](test/fixtures/example.ts#region:config)

```typescript
export const config = { retries: 3 };
```

Region directives come in the comment spellings a project actually uses —
`//`, `#`, `--`, `;`, `%`, `'`, `REM`, `<!--` and `/* */` — and the comment
prefix is stripped before the name is read. The rules:

- `#region <name>` opens a named region; `#endregion` closes it (a bare
  `#region` closes the unnamed one).
- A file must contain at least one directive, and a region name may appear
  only once — a missing, duplicate or unclosed region is an error.
- `#region` in code without a comment prefix, e.g. C#, is not a directive;
  the same line inside a comment is.

## Region rules by file type

`#region:<reference>` means "the piece of this file called `<reference>`". What
the reference may say — and what comes back — depends on the file's **type**:
each type has one rule, and the reference is handed to the rule that claims the
file's extension. Two rules ship, and a third is a few lines in a `regionRules`
array (see [Adding a rule for another type](#adding-a-rule-for-another-type)).

### The default rule: code, and everything else

One rule covers every type no other rule claims — source code, `README.md`,
`.txt`, `.ini`, anything. In a file that carries an explicit region directive,
`#region <name>` opens and `#endregion` closes it and the lines strictly
between them are injected, exactly as [Regions](#regions) describes.

When the file carries no such directive, the name is looked for as a
**declaration**: a method, constructor, function, or class-like declaration
(`class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`) named
`<name>`. The match is the text from the declaration's first line through its
closing brace — or, in an indentation language such as Python, through the last
line of its indented block. Nothing has to be added to the code first: the
declaration *is* the region.

A `-`, `+` or `++` in front of the name selects how much of that declaration
comes with it:

| Reference | Injected text |
| --- | --- |
| `#region:add` | the declaration: signature through closing brace |
| `#region:-add` | the body only, without the signature |
| `#region:+add` | the declaration **and the annotations above it** (`@Override`, `#[test]`, a decorator) |
| `#region:++add` | the declaration, its annotations, **and the doc comment above them** (a `/** … */` block or a run of `///` lines) |

All four, against `test/fixtures/Example.java` — first the declaration itself:

[test/fixtures/Example.java](test/fixtures/Example.java#region:toString)

```java
    public String toString() {
        return String.join(",", items);
    }
```

then its body alone:

[test/fixtures/Example.java](test/fixtures/Example.java#region:-toString)

```java
        return String.join(",", items);
```

then the declaration with its annotation:

[test/fixtures/Example.java](test/fixtures/Example.java#region:+toString)

```java
    @Override
    public String toString() {
        return String.join(",", items);
    }
```

then annotation and doc comment together:

[test/fixtures/Example.java](test/fixtures/Example.java#region:++toString)

```java
    /** Add one item to this cart. */
    @Override
    public String toString() {
        return String.join(",", items);
    }
```

The name may equally be a class-like declaration, nested or not:

[test/fixtures/Example.java](test/fixtures/Example.java#region:Line)

```java
    public static class Line {
        private final String name;
        private final int quantity;

        Line(String name, int quantity) {
            this.name = name;
            this.quantity = quantity;
        }

        String render() {
            return name + " x" + quantity;
        }
    }
```

What the code rule does, and does not, promise:

- An explicit `#region <name>` directive always wins, wherever the file has
  one; a `-`/`+`/`++` reference still resolves to it, because a region is
  already exactly its body.
- Names must be unique. Two methods named `add` in one file — an overload pair
  — are an error, as two regions of one name are; wrap one of them in `#region`
  comments to disambiguate. A class name beats a same-named constructor.
- Nothing matching at all is an error naming the reference; `--lenient` reports
  it with its line number and leaves the block as written.
- Matching is a heuristic, not a parser. It reads declaration-shaped lines and
  counts brackets over text whose comments and string literals are blanked, so
  a `}` inside a string cannot end a body. Braced languages — Java, C#, C/C++,
  JavaScript/TypeScript, Go, Rust, PHP, Kotlin, Swift — are followed by their
  braces; Python and Ruby by indentation.
- The declaration is injected verbatim, indentation and all, so a nested method
  keeps the indentation it has in its file.

### The JSON rule

JSON has no comments to hang a region directive on, so `.json` gets a rule of
its own: `#region:<reference>` names one or more **keys**, comma-separated,
each a dotted path from the top level. The selected values are rendered as
valid JSON — braces and all — in the order they are listed.

Top-level keys and a nested one, from `package.json`:

[package.json](package.json#region:name,version,scripts.test)

```json
{
  "name": "@hrg/inject-examples",
  "version": "1.0.1",
  "scripts": {
    "test": "node --test test.mjs"
  }
}
```

An array keeps only the elements named, in order:

[package.json](package.json#region:keywords.0,keywords.2)

```json
{
  "keywords": [
    "markdown",
    "documentation"
  ]
}
```

- `scripts.test` is a nested key, `keywords.0` an element of an array. There is
  no slice syntax: name every element you want.
- A missing key, an index out of range, a document whose top level is not an
  object, or text that is not JSON at all is an error; `--lenient` reports it
  and leaves the block as written.
- Unlike the code rule, this one **renders** the selection
  (`JSON.stringify(selection, null, 2)`) instead of copying bytes: a selection
  of keys has to be re-printed to stay valid JSON, so whitespace and number
  formatting in the block belong to the renderer, not to the file. Keys appear
  in the order the reference lists them.

### Adding a rule for another type

A rule is a plain object: a name, the extensions it claims, and a `resolve`:

```js
import { REGION_RULES, extractRegion } from '@hrg/inject-examples';

const toml = {
    name: 'toml',
    extensions: ['toml'],
    resolve: (text, region) => extractRegion(text, region),
};

updateDocument(doc, { regionRules: [toml, ...REGION_RULES] });
```

`resolve(text, region, path)` returns the text to inject, or throws to fail the
include. The first rule claiming the file's extension wins and `code` is the
fallback, so one rule for one type leaves every other type exactly as it was.

## Fences

The block a marker stands for is a fenced code block immediately below the
marker (blank lines are allowed in between). Fences follow CommonMark:

- The opener is a run of three or more backticks, optionally followed by an
  info string.
- The closer is a pure backtick run of at least the opener's length, with no
  info string.
- A fence left open at the end of the document swallows the rest of the
  document; that is reported as an error (and, with `--lenient`, tolerated).
- If the opening fence has no info string, the tool adds one from the marker's
  file extension — `index.mjs` opens a `javascript` block, `package.json` a
  `json` block — so the injected content is highlighted. A fence that already
  names a language is left as written.

The next block shows why the longer fence matters: the fixture contains
three-backtick fences of its own, so its wrapper is four backticks.

[test/fixtures/fenced.md](test/fixtures/fenced.md)

````markdown
Prose, then a nested fence:

```js
const x = 1;
```

And prose after it.
````

## Running the CLI

```
inject-examples [--root <dir>] [--check] [--dry-run] [--allow-empty]
                [-l, --lenient] [-g <file>] [--no-gitignore] [-q]
                <file|dir> ...
```

`<file|dir> ...` is any number of documents and directories, and defaults to
`README.md`. A directory expands to every `*.md` below it, recursively —
`node_modules` and dot-directories are skipped — and each document is processed
with the same options; the run exits with the worst code any of them produced.
Within one run, a document that fails does not stop the ones after it.

The options, as the tool's own `--help` documents them:

- `--root <dir>` — the base every marker path resolves against; the default
  is the document's directory.
- `--check` — report only; nothing is written; stale or failed markers end
  with exit `1`.
- `--dry-run` — show what would change; write nothing.
- `--allow-empty` — succeed when the document has no markers.
- `--lenient` — tolerate broken includes (below).
- `-g <file>`, `--no-gitignore` — override or disable gitignore handling.
- `-q` — print only the closing summary.

Exit codes: `0` on success; `1` on a stale block, an unreadable file or
directory, a directory that holds no Markdown, a malformed marker, or (with
`--lenient`) a marker that could not be resolved; `2` on a usage error. With
several targets the code is the worst of the run.

The tool's own output for a clean run over this document:

[test/fixtures/after.md](test/fixtures/after.md)

```markdown
$ npx @hrg/inject-examples --root . doc/usage.md
doc/usage.md updated.
```

## Tolerating broken includes

With `--lenient`, a marker whose file or region cannot be read — or whose
block cannot be found — is reported with its line number, left as written,
and the run continues; the run still ends `1`, because a broken include is
an error to be fixed, not a success. Duplicate markers and stray text where a
block should be stay strict in every mode. The README's
"Tolerating broken includes" section has the worked example.

## Using the library

The CLI is a thin wrapper over one function, `updateDocument(text, options)`;
the library is pure and reads only through the `readFile` you hand it, which
is why the test suite drives it in memory. The block below is the real test
that drives the engine — a live marker into `test.mjs`'s region:

[test.mjs](test.mjs#region:update-document-test)

```javascript
test('updateDocument rewrites every marker and is idempotent', () => {
    const read = reader(FILES);
    const first = updateDocument(DOC, { readFile: read });

    assert.equal(first.markers.length, 2);
    assert.equal(first.changed, true);
    assert.deepEqual(first.results.map((r) => r.changed), [true, true]);
    assert.match(first.text, /first line\nsecond line/);
    assert.match(first.text, /\| a \| b \|/);
    assert.doesNotMatch(first.text, /stale content|stale region/);

    const second = updateDocument(first.text, { readFile: read });
    assert.equal(second.changed, false, 'a second pass is a no-op');
    assert.deepEqual(second.results.map((r) => r.changed), [false, false]);
    assert.equal(second.text, first.text);
});
```

`updateDocument` returns `{ text, changed, markers, results }`: the rewritten
document, whether anything changed, the markers found, and one entry per
marker carrying `{ marker, content, changed, skipped }` — plus a `failure`
field when `--lenient` skipped a broken include.

Its `options` include the region rules: `regionRules` replaces the built-in set
(`REGION_RULES`), and the library exports the pieces of the two rules that
ship — `ruleFor(path)`, `extractCodeRegion(text, region)`,
`extractDeclaration(text, name, scope)`, `extractJsonRegion(text, region)` and
`codeReference(reference)` — so a rule for another type can be assembled from
them rather than re-invented.

## Examples and tests share the same files

This is the policy that keeps the documentation honest, and it is worth
stating because it is deliberate:

- **No documentation-only examples.** Every file injected above exists in
  this repository — `package.json`, `test/fixtures/before.md`,
  `test/fixtures/after.md`, `test/fixtures/example.ts`,
  `test/fixtures/Example.java`, `test/fixtures/fenced.md`, `index.mjs` and
  `test.mjs`. Nothing was invented for the docs; each shown block is the
  current content of a file the repository owns.
- **The fixtures are test data.** The files under `test/fixtures/` are read
  by `test.mjs` through the real `fileReader`, and the tests below pin their
  content. The same files are what the markers above inject — including the
  declarations, which the tests resolve with the same code rule the tool uses.
- **One test runs the engine over this very document.** If any block here
  drifts from its file — a fixture edited, a method renamed, a key removed —
  the test fails, exactly like the CI `--check` run.
- **The rule for adding examples.** When you add an example to the docs, add
  its file and a test that uses it, or the example is decorative and can
  drift silently. Examples and tests deliberately overlap here, because the
  script exists to make shown code equal to real code; an example the tests
  never touch defeats that purpose.
- **Links in the docs must be functional.** No fake links: a Markdown link
  in a document's prose (outside fenced blocks and inline code) must navigate
  somewhere real — an external URL, a heading that exists in the same
  document, or a file that exists in the repository, resolved against the
  repository root, the same `--root .` convention this document uses. Fenced
  blocks and inline code are data, not navigation, so illustrative markers
  there — such as a `failed` demo — are exempt, exactly as marker-like lines
  inside fences are inert. A test in `test.mjs` enforces this rule over every
  Markdown file in the repository.

## Keeping this document in sync

Regenerate whenever a shown file changes, and check in CI:

```
npx @hrg/inject-examples --root . doc/usage.md
npx @hrg/inject-examples --root . --check doc/usage.md
```

A stale block fails the check with the marker's line number and a `stale`
label, and writes nothing; regenerate and commit. As a CI step:

```yaml
- name: Check injected examples
  run: npx @hrg/inject-examples --root . --check doc/usage.md
```
