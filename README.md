# @hrg/inject-examples

Keep the code samples in your Markdown honest and target code sections semantically instead of line numbers that can drift much more easily. [demo page](https://hrgdavor.github.io/inject-examples/)

This project [dogfoods](https://en.wikipedia.org/wiki/Dogfooding) its own
documentation: [`doc/usage.md`](./doc/usage.md) is written with inject-examples
itself, and every file it shows is exercised by the test suite. The
[demo page](./docs/index.html) goes one step further — it is built from
[`docs/demo.md`](./docs/demo.md), a Markdown document that this tool keeps in
sync and a generator turns into a clickable page (see
[The demo page](#the-demo-page)).

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

Add a `#<name>` fragment to inject just one part of a larger
file, so a sample can show a slice of a big source file without duplicating it:

```markdown
[test/fixtures/example.ts](./test/fixtures/example.ts#table)
```

What the name may be depends on the file's type: a `#region` directive, a
method or inner class by name, or — for `.json`, which has no comments — a list
of keys. See [Region rules by file type](#region-rules-by-file-type).

No dependencies. Node 18+. Works as a CLI and as a library.

The JavaScript implementation — [`index.mjs`](./index.mjs) and
[`cli.mjs`](./cli.mjs) — is the source of truth: when the two disagree about a
byte, the JavaScript is right and the Zig port in `src/` follows. See
[The Zig port](#the-zig-port).

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
- A fragment names the section to inject.

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
[test/fixtures/example.ts](./test/fixtures/example.ts#table)
```

That pair, written live in this very README, is kept honest by the tool — the
block below is not typed by hand; `inject-examples` rewrites it from the file:

[test/fixtures/example.ts](./test/fixtures/example.ts#table)

```ts
| name | qty |
| ---- | --- |
| bolt | 12  |
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

`#<reference>` means "the piece of this file called `<reference>`". What
the reference may say — and what comes back — is decided by the file's
**type**: each type has one rule, and the reference is handed to the rule that
claims the file's extension. Five rules ship — JSON, YAML, TOML, INI and the
`code` fallback; the library takes more.

### Code — the default rule

One rule covers every type no other rule claims: source code, `.md`, `.txt`,
anything. An explicit `#region <name>` directive always wins. When the file has
none, the name is looked for as a **declaration** — a method, constructor,
function or class-like declaration (`class`, `interface`, `enum`, `record`,
`struct`, `trait`, `object`), nested or not. The declaration *is* the region, so
code needs no region comments added to it:

````markdown
[test/fixtures/Example.java](./test/fixtures/Example.java#++toString)

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
| `#add` | the declaration: signature through closing brace |
| `#-add` | the body only, without the signature |
| `#+add` | the declaration **and the annotations above it** (`@Override`, `#[test]`, a decorator) |
| `#++add` | the declaration, its annotations, **and the doc comment above them** (a `/** … */` block or a run of `///` lines) |

A declaration is injected verbatim, indentation and all. Region names must be
unique, and so must declaration names — two methods named `add` are an error,
exactly as two `#region add`s are; wrap one in `#region` comments to pick it.
A class name beats a same-named constructor, and nothing matching at all is an
error (`--lenient` reports it and leaves the block as written).

The match is not a parser: it reads declaration-shaped lines and counts brackets
over text whose comments and string literals are blanked, so a `}` inside a
string cannot end a body. That blanking is done by a real tokenizer for the
eighteen languages in [`src/js/scanner/syntaxes.js`](./src/js/scanner/syntaxes.js)
— JavaScript/TypeScript, Java, Zig, Go, Rust, Python, C#, Kotlin, PHP, Ruby, SQL,
Shell, VB, Haskell, YAML, TOML and INI — exact to each language's own syntax:
template literals, text blocks, nested block comments, raw and verbatim strings,
doubling escapes, `<<EOF` heredocs, and a Rust `'a` lifetime that is not a char
literal. [doc/languages.md](./doc/languages.md) lists every entry, the construct
it exists for and its extensions. For every other type a best-effort union of the
comment and string spellings stands in, so an unknown type still resolves, just
less precisely. The
table is data: adding a language is one object there plus one extension line in
`lexers.js`, and the places a language spells a member differently from the
common shape — Ruby's paren-less `def add`, Haskell's `add x y = …` binding with
its `name ::` signature, Rust's `impl Cart { … }` and its `name: Type,` fields —
are declared there too, as shapes the resolver indexes rather than parses. Braced
languages — Java, C#, C/C++, JS/TS, Go, Rust, PHP, Kotlin, Swift — are followed
by their braces; Python and Ruby by indentation.

#### Section paths and code anchors

A name is hard to hit when a file has two methods called `render`. The code
reference is therefore a **path**: slash-separated segments, each naming a block
*inside* the one before it, so `Cart/Line/render` means the `render` method of
the `Line` class of the `Cart` class. Only the last segment selects the text to
inject; the ones before it are scopes to descend:

When a scope name is declared more than once at one level the path **retries the
candidates**, taking the first that can hold the rest of the path — a Rust type's
members live in its `impl` blocks, which are siblings of the `struct` with the
same name, so `Cart/add` and `Cart/items` both resolve while a *last* segment
still takes the first match in walk order.

````markdown
[test/fixtures/Example.java](./test/fixtures/Example.java#Cart/Line/render)

```java
        String render() {
            return name + " x" + quantity;
        }
```
````

Inside a scope a segment may also be matched by what a block **contains**, not
just what it declares:

- a **condition literal** — a statement whose header carries the name as a
  double-quoted string. `dispatch/getUsers` selects the `if ("getUsers".equals(…))`
  block, braces and all:

````markdown
[test/fixtures/Anchors.java](./test/fixtures/Anchors.java#dispatch/getUsers)

```java
        if ("getUsers".equals(methodName)) {
            System.out.println("users");
        }
```
````

- a **comment anchor** — a block whose opening is marked by a leading comment.
  The block in the fixture opens `public void handler() { //getUsers`, so
  `handler/getUsers` names it by that comment.

The scope modifier is **trailing** (`render-`, `render+`, `render++`); the old
leading spelling (`-render`, `+render`, `++render`) still works and is
canonicalised. A reference that asks for two readings at once — a `+` against a
`-`, as in `getUsers++-` — resolves to the wider reading, but the CLI warns and
exits 1, because a contradiction is almost always a typo:

```text
inject-examples: warn: doc/usage.md:42: [a.java](./a.java#getUsers++-): "++" contradicts "-"; using "#getUsers++"
```

The full grammar — every accepted form, every error and its exact message — is
spelled out in [doc/section-matching.md](./doc/section-matching.md). Matching
lives in a single dependency-free module,
[lib/section.mjs](./lib/section.mjs), which other projects can import directly
(see [lib/README.md](./lib/README.md)).

### JSON — its own rule

JSON has no comments to hang a region directive on, so `.json` files get a rule
of their own: the reference is one or more **keys**, comma-separated and
written as dotted paths from the top level, and the selection is rendered as
valid JSON — braces and all:

````markdown
[package.json](./package.json#name,scripts.test)

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

### YAML, TOML and INI — their own rules

The three config formats have the same problem as JSON and the same answer: a
reference is a dotted path to a key, and the selection is rendered with the
ancestors that hold it, so the block is valid source on its own — a bare
`port: 8080` is not a YAML document, `server:` above it makes one:

| Reference | `.yaml` | `.toml` | `.ini` |
| --- | --- | --- | --- |
| `#server` | the `server:` mapping | the whole `[server]` table | the whole `[server]` section |
| `#server.port` | `server:` and its `port:` entry | `[server]` and `port = 8080` | `[server]` and `port = 8080` |
| `#a.b.c` | every ancestor, re-indented to two spaces per level | `[a.b]` and its key | an error — INI has sections and keys, no deeper |

A YAML selection keeps its blank and nested lines; a TOML value that spans lines
(an array, an inline table) comes with its continuation lines; INI quotes
nothing back — both the `key = value` and the `key: value` spellings are read.
A missing key, a missing table or section, and a path the format cannot express
are all errors, reported by `--lenient` like any other broken include.

### Adding a rule for another type

A rule is a plain object: a name, the extensions it claims, and a `resolve`.
`options.regionRules` replaces the built-in set, so pass the built-ins plus
your own:

```js
const env = {
    name: 'env',
    extensions: ['env'],
    resolve: (text, region) => extractRegion(text, region),
};

updateDocument(doc, { regionRules: [env, ...REGION_RULES] });
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

## The demo page

[`docs/index.html`](./docs/index.html) is a three-column page — the targets, the
sample files, and the document rendered the way GitHub renders it, code fences
syntax-highlighted and all. The document's lead — its title and intro before the
first `##` — is the page banner in both places, so the rendered column starts at
the first section. Every target syntax is clickable: clicking one switches the
middle column to that target's file, highlights the lines the reference selects,
and marks the matching marker and injected block in the rendered Markdown. It is
generated, never hand-written:

- [`docs/demo.md`](./docs/demo.md) is the source: an ordinary Markdown document,
  readable on its own, whose markers this tool keeps in sync exactly as it keeps
  `doc/usage.md`. It has a section per [supported language](./doc/languages.md)
  and per config format — Java, Go, Rust, Python, C#, Kotlin, PHP, Ruby, SQL,
  Shell, VB, Haskell, Zig, YAML, TOML, INI and JSON.
- [`docs/samples/`](./docs/samples) holds one small sample per section, each
  written to show the construct its language needs a lexer for (a nested comment,
  a raw string, a heredoc, a doubled quote) beside a member to select.
- [`tools/build-demo.mjs`](./tools/build-demo.mjs) reads the document, resolves
  every marker with the library — so the page cannot highlight a range the tool
  would not inject — renders every sample with the same comment/string spans the
  resolver's lexer produces, and writes the page. A rule that *renders* its
  selection (JSON, YAML, TOML, INI) has no byte slice to find, so the page matches
  the rendered lines back to the source by key and highlights where the selected
  keys are written — one range per group of adjacent lines, so two keys far apart
  are two highlights rather than one covering everything between them.

```bash
bun tools/build-demo.mjs           # write docs/index.html
bun tools/build-demo.mjs --check   # exit 1 when it is stale
```

To add an example: put the sample in `docs/samples/`, write a `##` section with
its prose and a marker in `docs/demo.md`, run `inject-examples docs/demo.md` to
fill the block, then run the generator — the page grows a numbered paragraph, a
clickable target and, when the file is new, a tab in the middle column. `npm test`
fails when the committed page is not exactly what the generator writes, when the
document has drifted from a sample, or when a sample's language stops being
highlighted.

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
| `REGION_RULES` / `CODE_RULE` / `JSON_RULE` / `YAML_RULE` / `TOML_RULE` / `INI_RULE` | The built-in rules; `code` is the fallback for every unclaimed type |
| `extractCodeRegion(text, region)` | The default rule: a region directive, or a named declaration |
| `extractDeclaration(text, name, scope?)` | The text of one declaration, or `null`; `scope` is the `-`/`+`/`++` |
| `extractJsonRegion(text, region)` | The `.json` rule: dotted key paths, rendered as valid JSON |
| `extractYamlRegion(text, region)` | The `.yaml` rule: a dotted key path, rendered with its ancestors |
| `extractTomlRegion(text, region)` | The `.toml` rule: a key with its `[table]`, or a whole table |
| `extractIniRegion(text, region)` | The `.ini` rule: `section.key`, a whole section, or a leading key |
| `codeReference(reference)` | Split a `-`/`+`/`++` modifier from the name it applies to |
| `normalize(text)` | LF endings, one trailing newline removed |
| `fileLanguage(path)` | The fence language a file's extension implies, or `null` |
| `fileReader(root)` | A `readFile` that resolves against a root |
| `parseIgnoreFile(text)` | Parse one `.gitignore` into rules |
| `loadIgnoreRules(root, read)` | Walk up from `root` collecting `.gitignore` rules |
| `isIgnoredPath(root, path, ruleFiles)` | Test one path against collected rules |
| `IncludeError` | The error type for a broken include — the one `--lenient` tolerates |
| `FENCE` | The fence prefix (` ``` `) |

## The tokenizer corpus and the oracle

The languages in `src/js/scanner/syntaxes.js` are checked two ways.

- **The corpus** — `PROBES` in [`tools/mask-oracle.mjs`](./tools/mask-oracle.mjs)
  is one entry per language per construct, naming the words the mask must hide
  and the words it must keep. `test.mjs` runs the whole corpus, so a new corpus
  entry is a new test and needs no dependency.
- **The oracle** — `npm run oracle` additionally highlights each probe with
  [highlight.js](https://highlightjs.org) and checks the direction that matters:
  every region the highlighter calls a comment or a string must be blank in our
  mask. Blanking *more* is the conservative direction and is allowed; a region
  our mask knows nothing about is reported. `--emit` prints what the highlighter
  saw, `--self-test` proves the check can fail, and `--no-oracle` runs the
  corpus alone.

highlight.js is a **devDependency for this check only** — the published package
still has no runtime dependencies, and `files` does not ship `tools/`.

## Behaviour notes

- **Normalisation.** Content is injected with LF endings and no trailing
  newline — exactly the text between the fences, except in the data-format rules
  (JSON, YAML, TOML, INI), which render their selection. A file ending in `\n`
  and one that does not therefore inject identically, so `--check` will not
  flicker between operating systems. The document's own endings (LF or CRLF) are
  preserved everywhere outside the block body.
- **Regions are read by file type.** A `.json` reference is a list of dotted
  key paths and the block is *rendered* (`JSON.stringify(…, 2)`), because a
  selection of keys has to be re-printed to stay valid JSON; `.yaml`, `.toml`
  and `.ini` references are dotted paths too, rendered with the ancestors that
  hold the key so the block stands on its own. Every other type uses the code
  rule, which injects verbatim — a region's lines, or a matched declaration from
  its first line through its closing brace.
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

`files` in `package.json` limits the package to `cli.mjs`, `index.mjs`, `lib/`,
`src/js/scanner/`, `doc/languages.md`, `doc/section-matching.md`, `README.md` and
`LICENSE`; the tests and fixtures stay out.

## The matcher ports: Rust and Java

[`lib/section.mjs`](./lib/section.mjs) is the section matcher on its own — one
dependency-free ES module another project can import or copy. Two ports of *that
module* (not of the CLI) live beside it, for consumers that cannot import an ES
module:

| Port | Where | Gate | State |
| --- | --- | --- | --- |
| Rust | [`rust/section`](./rust/section) | `cargo test` | parse, mask and shape layers; the scanner driver and resolution to come |
| Java | [`java/section`](./java/section) | `mvn test` | complete — all 124 vectors, the language table and the lexical corpus included |

Both read [`test/vectors/section-vectors.json`](./test/vectors/section-vectors.json)
— the same 124 vectors the JavaScript gate uses — directly, rather than keeping a
generated copy, and both fail if a vector is neither asserted nor counted, so a
layer still to come stays visible instead of silently skipped. Both read the
lexical corpus too — [`test/vectors/lexical-vectors.json`](./test/vectors/lexical-vectors.json),
generated by `tools/lexical-vectors.mjs`, one mask row per lexer entry and one
shape row per discriminating declaration spelling — because the resolution
vectors can only exercise the six lexer entries their fixtures name. The rule is
the one the Zig port follows: **the JavaScript is the source of truth, and a port
mirrors rather than leads**.

The Java one is a Maven artifact (`hr.hrg.inject:inject-examples`) whose POM
carries the metadata Maven Central asks for and attaches the sources and javadoc
jars, so a release is a matter of the credentials and the Central Portal plugin;
until then, `mvn install` puts it in your local repository. Like the ES module it
ports, it has no runtime dependencies — that is what makes it vendorable, and what
keeps a JVM host from taking on a web stack to resolve a `#<reference>`.

## The Zig port

**The JavaScript implementation is the source of truth.** `index.mjs` and
`cli.mjs` define what this tool does; the Zig code is the one that moves when
the two disagree.

`build.zig`, `build.zig.zon` and `src/` hold a second implementation of this
exact tool in Zig, written against Zig 0.16.0. It is not a rewrite-with-ideas:
its job is to produce the same bytes the JavaScript one produces, in every mode,
on every input. The matching rules the JavaScript side grew — the per-type
lexers of [`src/js/scanner/`](./src/js/scanner), the section path and modifier
grammar of [`lib/section.mjs`](./lib/section.mjs), and the YAML, TOML and INI
region rules — are ported, and **porting is allowed**: the syntax is settled, so
the port is kept at parity by gates rather than frozen. The goals, the gates and
the rules for changing something after the port are in
[`plans/zig-port.md`](./plans/zig-port.md), the plan that owns the port.

```bash
zig build                     # -> zig-out/inject-examples(.exe)
zig build test                # the ported test suite, all in memory
node tools/compare-zig.mjs    # differential harness: JS vs Zig, byte for byte
```

The binary is a drop-in stand-in for `node cli.mjs`: the same flags in all of
their spellings, the same `inject-examples: …` messages on stderr, the same
in-place and `--out` rewriting, and the same exit codes (0 for up to date or
updated, 1 for stale or malformed, 2 for a wrong command line).

Tagging `v*` runs `.github/workflows/release.yml`, which cross-builds
`ReleaseSafe` binaries for x86_64 Linux, Windows, x86_64 macOS and aarch64
macOS, and attaches them to a GitHub release. Every push and pull request runs
`.github/workflows/ci.yml`: the JavaScript suite (with the section-vector drift
gate), `zig build test` (with the generated conformance corpus), and the
differential harness. That is the Zig side only: `npm publish` ships the
JavaScript package, a `v*` tag ships the binaries.

Five JavaScript details decide byte equality, so the Zig code mirrors them
exactly instead of approximating:

| JS behaviour                        | how the Zig port mirrors it                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| every index and length is a code unit | text is handled as UTF-16 code units, not bytes, so `.length`, slices and regex scans agree on astral characters |
| `String.prototype.trim` and `/\s/`  | the same 25-code-unit set V8 uses — tab through U+FEFF, and *not* U+0085                                          |
| `JSON.parse` / `JSON.stringify`     | V8's own messages (position, line, column, the embedded input), escaping, number spelling and key order           |
| `readFileSync(path, 'utf8')`        | the WHATWG utf-8 decoder: one U+FFFD per invalid maximal subpart, and one for an unpaired surrogate on the way out |
| `node:path`, `resolve` especially   | `std.fs.path`, with the working directory named explicitly, because Zig's `resolve` will not anchor a relative path |

Two JavaScript quirks that a "clean" port would have smoothed over are
reproduced instead, because they are observable: `.constructor` and `.__proto__`
are reachable as fence languages (the language table is an ordinary object, and
those are its inherited members), and a merged JSON selection drops a
`__proto__` key for the same reason.

One divergence is deliberate, and it is now only about *matching*. A `.gitignore`
glob whose generated regular expression is invalid in JavaScript (`[?-!*]`, or
`[a\]x`) is dropped by the JS tool — the rule cannot be honoured, so nothing is
excluded by it — while the Zig port matches the glob as written and carries on.
Neither side fails the run. A rule like that is broken either way.

The library side is importable as well: the whole of `index.mjs` lives in
`src/root.zig`, exposed as the `inject_examples` module of the package —
`updateDocument`, `resolveMarker`, `parseMarker`, `findMarkers`, `injectInto`,
`extractRegion`, `extractCodeRegion`, `extractJsonRegion`, `ruleFor`,
`fileLanguage`, `parseIgnoreFile`, `isIgnoredPath`, `normalize` and the
`utf8Decode` / `utf8Encode` pair. Only `fileReader` has no twin: a Zig library
has no working directory of its own, so the CLI hands `updateDocument` a
`Reader` that resolves against the root and reads what is there.

The JavaScript side has caught up in the Zig port: the per-type lexers, the
declaration shapes they add, and the `extractYamlRegion` / `extractTomlRegion` /
`extractIniRegion` rules are all there. `src/section.zig` mirrors
`lib/section.mjs`, `src/scanner/` mirrors `src/js/scanner/`, and
`src/data_rules.zig` holds the three config-format rules. Two gates hold them
together:

- `src/section_vectors.zig` is generated by `tools/zig-vectors.mjs` from
  `test/vectors/section-vectors.json` and `test/vectors/lexical-vectors.json` —
  the corpora `test.mjs` holds the JavaScript implementation to — and
  `zig build test` runs every case of both. `node tools/zig-vectors.mjs --check`
  fails when the committed file is stale.
- `tools/compare-zig.mjs` is the proof. It runs both tools over a corpus made of
  edge cases and hard spellings — markers in fences, a generic `impl`, a
  `pub`-prefixed field name, a primed Haskell binding, CRLF documents, JSON
  regions with every error shape, gitignore rules, `--out`, directories, missing
  files, usage errors — plus a reference corpus that resolves every construct the
  per-type lexers exist for and every data-format rule, plus a seeded fuzzer that
  builds random documents and target files, and compares stdout, stderr, exit code
  and every rewritten file byte for byte. `--seed N` and `--rounds N` vary the
  corpus.

All five gates — the JavaScript suite, the Zig suite, the differential, the Java
port and the Rust port — plus `zig fmt --check` and `cargo fmt --check` run on
every push and pull request in
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## License

MIT
