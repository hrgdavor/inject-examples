# @hrg/inject-examples

Keep the code samples in your Markdown honest.

This project [dogfoods](https://en.wikipedia.org/wiki/Dogfooding) its own
documentation: [`doc/usage.md`](./doc/usage.md) is written with inject-examples
itself, and every file it shows is exercised by the test suite.

A **marker** is a line that is nothing but a link to a real file, labelled with
that same path. The fenced code block that follows it is replaced — byte for
byte — with that file's content. Because the text is *copied* rather than typed,
your README cannot drift from the files your tests use.

````markdown
[test/fixtures/before.md](./test/fixtures/before.md)

```markdown
...this block is generated from test/fixtures/before.md...
```
````

Prefix a fragment with `#region:<name>` to inject just one part of a larger
file, so a sample can show a slice of a big source file without duplicating it:

```markdown
[test/fixtures/example.ts](./test/fixtures/example.ts#region:table)
```

What the name may be depends on the file's type: a `#region` directive, a
method or inner class by name, or — for `.json`, which has no comments — a list
of keys. See [Region rules by file type](#region-rules-by-file-type).

No dependencies. Node 18+. Works as a CLI and as a library.

A detailed usage guide lives in [`doc/usage.md`](./doc/usage.md).

## Install

```bash
npm install --save-dev @hrg/inject-examples
```

Or run it without installing:

```bash
npx @hrg/inject-examples --check
```

## Quick start

1. Add a marker and an empty block to your `README.md`:

   ````markdown
   [test/fixtures/before.md](./test/fixtures/before.md)

   ```markdown
   ```
   ````

2. Run it:

   ```bash
   npx @hrg/inject-examples
   ```

3. Commit the result, and add a check to CI:

   ```bash
   npx @hrg/inject-examples --check
   ```

`--check` exits `1` when any block differs from its file, so CI fails the moment
someone edits a fixture without regenerating the docs.

## What counts as a marker

A line is a marker when **all** of these hold:

- The whole line is a single Markdown link, `[label](destination)` — nothing
  before or after it (leading and trailing spaces are ignored).
- The label names the same path as the destination, with or without a leading
  `./`.
- The destination is a path, not a URL (no `http:`, `mailto:`, etc.).
- Any fragment is either absent or exactly `#region:<name>`.

So `[test/fixtures/after.md](./test/fixtures/after.md)` injects, while
`[the docs](./doc/usage.md)` and `[install](./doc/usage.md#install)` are
ordinary links and are left alone.

Lines inside fenced blocks are never markers: whatever a fence contains is
content, even when it looks exactly like a marker — which is why this
README's own examples are safe.

The block that gets replaced must be the next thing after the marker. Blank
lines in between are fine; any other text is an error, reported with the marker
that caused it. A block closes on the first fence line that is at least as long
as the one that opened it, so if the file's content contains fence lines of its
own, wrap the block in a longer fence (four backticks instead of three).

## Regions

Mark the part of a file to inject with the region convention the major editors
share. The directive lines themselves are never injected — only what lies
between them:

```ts
// #region table
| name | qty |
| ---- | --- |
| bolt | 12  |
// #endregion
```

then

```markdown
[test/fixtures/example.ts](./test/fixtures/example.ts#region:table)
```

Any of the usual comment prefixes is accepted, in any language:

| Spelling | Seen in |
| --- | --- |
| `#region name` / `#endregion` | C#, Razor |
| `// #region name` / `// #endregion` | VS Code folding |
| `//region name` / `//endregion` | JetBrains IDEs |
| `<!-- #region name -->` | HTML, Markdown |
| `/* #region name */` | C-style block comments |
| `-- #region`, `; #region`, `% #region`, `' #region`, `REM #region` | SQL, INI, VB, TeX |

Rules:

- Region names must be unique within a file; a duplicate is an error.
- An unclosed region is an error.
- Regions may not be interleaved: opening `#region b` inside `#region a`
  before `a` is closed is an error.
- A bare `region name` line with no comment prefix is treated as prose, not a
  directive — keep the `#` (or add a comment style) so ordinary text is safe.

## Region rules by file type

`#region:<reference>` means "the piece of this file called `<reference>`". What
the reference may say — and what comes back — is decided by the file's
**type**: each type has one rule, and the reference is handed to the rule that
claims the file's extension. Two rules ship; the library takes more.

### Code — the default rule

One rule covers every type no other rule claims: source code, `.md`, `.txt`,
anything. An explicit `#region <name>` directive always wins. When the file has
none, the name is looked for as a **declaration** — a method, constructor,
function or class-like declaration (`class`, `interface`, `enum`, `record`,
`struct`, `trait`, `object`), nested or not. The declaration *is* the region, so
code needs no region comments added to it:

````markdown
[test/fixtures/Example.java](./test/fixtures/Example.java#region:++toString)

```java
    /** Add one item to this cart. */
    @Override
    public String toString() {
        return String.join(",", items);
    }
```
````

A `-`, `+` or `++` before the name selects how much of the declaration comes
with it:

| Reference | Injected text |
| --- | --- |
| `#region:add` | the declaration: signature through closing brace |
| `#region:-add` | the body only, without the signature |
| `#region:+add` | the declaration **and the annotations above it** (`@Override`, `#[test]`, a decorator) |
| `#region:++add` | the declaration, its annotations, **and the doc comment above them** (a `/** … */` block or a run of `///` lines) |

A declaration is injected verbatim, indentation and all. Region names must be
unique, and so must declaration names — two methods named `add` are an error,
exactly as two `#region add`s are; wrap one in `#region` comments to pick it.
A class name beats a same-named constructor, and nothing matching at all is an
error (`--lenient` reports it and leaves the block as written).

The match is a heuristic, not a parser: declaration-shaped lines, with brackets
counted over text whose comments and string literals are blanked, so a `}`
inside a string cannot end a body. Braced languages — Java, C#, C/C++, JS/TS,
Go, Rust, PHP, Kotlin, Swift — are followed by their braces; Python and Ruby by
indentation.

### JSON — its own rule

JSON has no comments to hang a region directive on, so `.json` files get a rule
of their own: the reference is one or more **keys**, comma-separated and
written as dotted paths from the top level, and the selection is rendered as
valid JSON — braces and all:

````markdown
[package.json](./package.json#region:name,scripts.test)

```json
{
  "name": "@hrg/inject-examples",
  "scripts": {
    "test": "node --test test.mjs"
  }
}
```
````

`scripts.test` picks a nested key and `keywords.0` an element of an array (only
the elements named, in order). A missing key, an index out of range, a
top-level value that is not an object, or text that is not JSON is an error.
Unlike the code rule this one *renders* the selection rather than copying
bytes, because a selection of keys has to be re-printed to stay valid JSON.

### Adding a rule for another type

A rule is a plain object: a name, the extensions it claims, and a `resolve`.
`options.regionRules` replaces the built-in set, so pass the built-ins plus
your own:

```js
const toml = {
    name: 'toml',
    extensions: ['toml'],
    resolve: (text, region) => extractRegion(text, region),
};

updateDocument(doc, { regionRules: [toml, ...REGION_RULES] });
```

The first rule claiming the file's extension wins, and `code` is the fallback,
so one rule for one type leaves every other type exactly as it was.
[`doc/usage.md`](./doc/usage.md#region-rules-by-file-type) works through both
rules with live examples.

## Skipping gitignored files

By default, a marker whose target file is gitignored is **skipped**: its block
is left exactly as written and reported as `skipped`. Skipping is not an error
— a sample of `node_modules` content is usually kept static on purpose — and
`--check` never counts a skipped block as stale.

Rules are collected the way git does it: the `.gitignore` in the document's
directory, then each `.gitignore` higher up the tree; the closest file wins and
a `!` rule un-ignores. Opt out or override with `--no-gitignore` or
`--gitignore <file>`. The library equivalent is the `gitignore` option of
`updateDocument` (`false`, `{ file }`, or `true` for the default walk-up).

## Tolerating broken includes (`--lenient`)

By default the tool is all-or-nothing: one marker it cannot resolve — its file
does not exist, its region is missing, ambiguous, unclosed or interleaved, or
its block cannot be found — aborts the run and rewrites nothing. That is the
right default, because a half-refreshed document is worse than an untouched
one.

With `--lenient` a broken *include* is tolerated: the marker is reported with
its line number, its block is left exactly as written, and the remaining
markers are refreshed as usual. The run still ends `1` — a broken include is an
error to be fixed, not a success — but the healthy parts of the document are no
longer held hostage by it:

```
$ inject-examples --lenient
updated  [test/fixtures/before.md](./test/fixtures/before.md)
failed   [test/fixtures/missing.md](./test/fixtures/missing.md)
updated  [test/fixtures/after.md](./test/fixtures/after.md)

README.md: 2 updated, 1 failed.
```

What `--lenient` deliberately does **not** tolerate: a duplicated marker, or
stray text where a block should be. Those are a broken *document*, not a
broken include — they still abort the run, in every mode, with exit `1` and
nothing written.

In the library this is the `lenient` option of `updateDocument`; a
failure-skipped marker shows up in `results` as `{ marker, content: null,
changed: false, skipped: true, failure: <cause> }`, distinct from a gitignored
skip, which has no `failure`.

## CLI

```
inject-examples [options] [file|dir ...]
```

Any number of documents and directories may be given in one run; with no target
the tool updates `README.md`. A directory expands to every `*.md` below it,
recursively — `node_modules` and dot-directories are skipped — and every
document is processed with the same options; the run exits with the worst code
any of them produced.

Marker paths resolve relative to the directory holding each document, unless
`--root` says otherwise.

| Option | Meaning |
| --- | --- |
| `-c`, `--check` | Write nothing; exit `1` if any block is stale |
| `-n`, `--dry-run` | Write nothing; report what would change |
| `-o`, `--out <file>` | Write the processed document to `<file>` instead of updating the input in place; the input is never modified, and exactly one input file is required |
| `-r`, `--root <dir>` | Base directory for the paths the markers name (default: the document's directory) |
| `-g`, `--gitignore <file>` | Skip markers whose target file is ignored by this `.gitignore` file (default: the walk-up search above) |
| `--no-gitignore` | Do not apply any `.gitignore` rules |
| `-q`, `--quiet` | Print only the closing summary |
| `--allow-empty` | Succeed when the document has no markers |
| `-l`, `--lenient` | Tolerate broken includes: report and leave as written any marker that cannot be resolved (see below) |
| `-h`, `--help` | Show help |
| `-V`, `--version` | Show the version |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every block is up to date, or was rewritten |
| `1` | A block is stale in `--check` mode, a document or directory is unreadable, a directory holds no Markdown, a marker is malformed, or (with `--lenient`) a marker could not be resolved |
| `2` | The command line itself was wrong |

### Output

```
$ inject-examples --check
ok       [test/fixtures/before.md](./test/fixtures/before.md)
stale    [test/fixtures/after.md](./test/fixtures/after.md)
skipped  [node_modules/dep.js](./node_modules/dep.js)

README.md is stale: 1 of 2 block(s) differ from their files.
Run: inject-examples README.md
```

A difference is reported as `stale` under `--check` and `--dry-run` (nothing was
written) and as `updated` on a normal run. A gitignored target is reported as
`skipped` and never counts as stale. A marker that `--lenient` could not
resolve is reported as `failed` — and, unlike `skipped`, it is an error: the
run ends `1` and the marker's block is left as written.

## Recipes

### npm scripts

```json
{
  "scripts": {
    "docs:build": "inject-examples",
    "docs:check": "inject-examples --check"
  }
}
```

### GitHub Actions

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
- run: npm ci
- run: npx @hrg/inject-examples --check
```

### Several documents

```bash
inject-examples README.md docs/GUIDE.md   # one run, two documents
inject-examples docs/                     # every *.md under docs/, recursively
inject-examples docs/GUIDE.md --root .
```

### Documentation in a subfolder

Write the markers relative to the document itself — `../fixtures/a.md` —
because that is how a reader resolves the same link, and the default root is
the document's own directory, so no `--root` is needed:

```bash
inject-examples docs/GUIDE.md
```

If you write root-relative paths instead, point `--root` at the root.

### Processing a document into a new file

`--out` writes the processed document to a separate file — the input is
never touched, and the destination's missing parent directories are created:

```bash
inject-examples --out dist/GUIDE.md docs/GUIDE.md
```

`--check --out` is the CI form: it verifies an existing copy and writes
nothing, exiting `1` when the copy is stale or missing:

```bash
inject-examples --check --out dist/GUIDE.md docs/GUIDE.md
```

The copy keeps the input's relative links, so its links point at the input's
neighbours — treat it as a build artifact, or rewrite the links afterwards.

### Run it before every commit

`.git/hooks/pre-commit`:

```bash
#!/bin/sh
npx @hrg/inject-examples --check || {
  echo "README examples are out of date; run: npx @hrg/inject-examples"
  exit 1
}
```

## Library

The same engine is exported for scripts and tests. `updateDocument` is pure —
it reads only through the `readFile` you pass and never writes:

```js
import { updateDocument, findMarkers, extractRegion, parseMarker } from '@hrg/inject-examples';

const result = updateDocument(readmeText, { root: process.cwd() });

result.text;      // the rewritten document
result.changed;   // true when anything differed
result.markers;   // every marker found, in order (each carries its line `index`)
result.results;   // [{ marker, content, changed, skipped }, ...]; a lenient
                  // failure-skip adds `failure: <cause>` to the entry
```

Inject from memory — handy in tests:

```js
const files = { 'fixtures/a.md': 'hello\n' };
const { text } = updateDocument(doc, { readFile: (p) => files[p] });
```

| Export | Purpose |
| --- | --- |
| `updateDocument(text, options)` | Rewrite every block in a document; `options` may set `root`, `readFile`, `gitignore`, `isIgnored`, `regionRules` and `lenient` |
| `injectInto(lines, marker, content, startIndex?, language?)` | Replace one block; a bare fence is given `language`; returns `{ lines, changed }` |
| `findMarkers(lines)` / `parseMarker(line)` | Discover markers |
| `fenceRanges(lines)` | The fenced blocks in a document |
| `resolveMarker(marker, read, rule?)` | The text a marker stands for, resolved by the file's type |
| `extractRegion(text, name)` / `regionDirective(line)` | Region directive parsing |
| `ruleFor(path, rules?)` | The region rule that resolves a reference in `path` |
| `REGION_RULES` / `CODE_RULE` / `JSON_RULE` | The built-in rules; `code` is the fallback for every unclaimed type |
| `extractCodeRegion(text, region)` | The default rule: a region directive, or a named declaration |
| `extractDeclaration(text, name, scope?)` | The text of one declaration, or `null`; `scope` is the `-`/`+`/`++` |
| `extractJsonRegion(text, region)` | The `.json` rule: dotted key paths, rendered as valid JSON |
| `codeReference(reference)` | Split a `-`/`+`/`++` modifier from the name it applies to |
| `normalize(text)` | LF endings, one trailing newline removed |
| `fileLanguage(path)` | The fence language a file's extension implies, or `null` |
| `fileReader(root)` | A `readFile` that resolves against a root |
| `parseIgnoreFile(text)` | Parse one `.gitignore` into rules |
| `loadIgnoreRules(root, read)` | Walk up from `root` collecting `.gitignore` rules |
| `isIgnoredPath(root, path, ruleFiles)` | Test one path against collected rules |
| `IncludeError` | The error type for a broken include — the one `--lenient` tolerates |
| `FENCE` | The fence prefix (` ``` `) |

## Behaviour notes

- **Normalisation.** Content is injected with LF endings and no trailing
  newline — exactly the text between the fences, except in the JSON rule, which
  renders its selection. A file ending in `\n` and one that does not therefore
  inject identically, so `--check` will not flicker between operating systems.
  The document's own endings (LF or CRLF) are preserved everywhere outside the
  block body.
- **Regions are read by file type.** A `.json` reference is a list of dotted
  key paths and the block is *rendered* (`JSON.stringify(…, 2)`), because a
  selection of keys has to be re-printed to stay valid JSON. Every other type
  uses the code rule, which injects verbatim — a region's lines, or a matched
  declaration from its first line through its closing brace.
- **Duplicated markers** in one document are an error, not a silent double
  injection.
- **No markers at all** is an error, because it usually means the file argument
  or the `--root` is wrong. Pass `--allow-empty` to allow it.
- **Only the block body changes — except the fence's language tag.** The
  marker line and everything outside the block are left untouched. If the
  opening fence has no language, the tool adds one from the file's extension
  (`example.ts` becomes a `typescript` block), so the block highlights; a fence
  that already names a language is never touched.
- **`--out` never writes the input.** The processed document is written to the
  destination file only; a directory or several files with `--out` is a
  usage error (exit `2`), and a run that ends `1` writes no output.
- **Path traversal.** Marker paths resolve against the root and may contain
  `../`: the tool trusts the document it runs on, as it should a `pre-commit`
  hook it installed itself.
- **Gitignore subset.** Comments, `!` negation, leading `/` anchoring,
  trailing `/`, `**`, `*`, `?`, character classes and backslash escapes are
  supported. Quoted patterns and trailing-space escapes are not.
- **Links in this repository's docs must be functional.** No fake links: a
  prose Markdown link (outside fenced blocks and inline code) must be an
  external URL, a heading that exists in the same document, or a file that
  exists in the repository (resolved against the document's own directory,
  the way Markdown links normally resolve). Fenced and inline-code examples
  are data, not navigation, so a `failed` demo marker there is exempt.
  `test.mjs` enforces this over every `.md` file in the repository.

## What this deliberately does not do

This tool was ported from an older include mechanism that also had looser
behaviours. None of them are supported here, and none are planned:

- **No `~suffix` lookup.** A marker names one path; there is no
  `<label>~<suffix>` spelling that would let a label stand for several files
  sharing a stem.
- **No glob patterns.** A path is a document or a directory; the CLI does not
  expand `docs/*.md` itself. A shell that expands the pattern before the CLI
  sees it is fine — the CLI accepts any number of paths.
- **No alternate fence styles.** Fences are CommonMark backtick fences only:
  three or more backticks, and a closer that is at least as long. Tilde
  (~~~) fences are not recognised, anywhere.
- **No `../`-strip fallback.** When a marker's path does not exist, the tool
  does not retry it with a leading `../` removed (or otherwise reshaped): the
  path is either resolved or the include is broken. A wrong root is a bug in
  the document, and `--root` exists to fix it.

Each of these would add ways for a marker to *almost* mean something else,
which is exactly the drift this tool exists to prevent.

## Publishing

The package is published as `@hrg/inject-examples` under the `hrg` npm
organization; `publishConfig` sets `access` to `public`, so a plain
`npm publish` publishes it publicly:

```bash
cd inject-examples
npm test                 # node --test
npm pack --dry-run       # inspect exactly what ships
npm publish
```

`npm install -g @hrg/inject-examples` puts the CLI on the PATH globally: the
`bin` entry in `package.json` points at `cli.mjs` (which carries the
`#!/usr/bin/env node` shebang), and npm wires the `inject-examples` command
into the global bin directory. The same `bin` entry is what `npx
@hrg/inject-examples` and a dev-dependency install run locally.

`package.json` carries the [repository](https://github.com/hrgdavor/inject-examples)
field, so npm links the package page to the GitHub repository.

Only `cli.mjs`, `index.mjs`, `README.md` and `LICENSE` ship (`files` in
`package.json`); the test file stays out.

## License

MIT
