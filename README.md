# inject-examples

Keep the code samples in your Markdown honest.

A **marker** is a line that is nothing but a link to a real file, labelled with
that same path. The fenced code block that follows it is replaced — byte for
byte — with that file's content. Because the text is *copied* rather than typed,
your README cannot drift from the files your tests use.

````markdown
[fixtures/before.md](./fixtures/before.md)

```markdown
...this block is generated from fixtures/before.md...
```
````

Prefix a fragment with `#region:<name>` to inject just one part of a larger
file, so a sample can show a slice of a big source file without duplicating it:

```markdown
[src/app.ts](./src/app.ts#region:table)
```

No dependencies. Node 18+. Works as a CLI and as a library.

## Install

```bash
npm install --save-dev inject-examples
```

Or run it without installing:

```bash
npx inject-examples --check
```

## Quick start

1. Add a marker and an empty block to your `README.md`:

   ```markdown
   [fixtures/before.md](./fixtures/before.md)

   ```markdown
   ```
   ```

2. Run it:

   ```bash
   npx inject-examples
   ```

3. Commit the result, and add a check to CI:

   ```bash
   npx inject-examples --check
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

So `[fixtures/a.md](./fixtures/a.md)` injects, while
`[the docs](./docs/README.md)` and `[a.md](./a.md#install)` are ordinary links
and are left alone.

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
[src/app.ts](./src/app.ts#region:table)
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
updated  [fixtures/a.md](./fixtures/a.md)
failed   [fixtures/missing.md](./fixtures/missing.md)
updated  [fixtures/b.md](./fixtures/b.md)

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
inject-examples [options] [file]
```

`file` defaults to `README.md`. Marker paths resolve relative to the directory
holding that document, unless `--root` says otherwise.

| Option | Meaning |
| --- | --- |
| `-c`, `--check` | Write nothing; exit `1` if any block is stale |
| `-n`, `--dry-run` | Write nothing; report what would change |
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
| `1` | A block is stale in `--check` mode, the file is unreadable, a marker is malformed, or (with `--lenient`) a marker could not be resolved |
| `2` | The command line itself was wrong |

### Output

```
$ inject-examples --check
ok       [fixtures/before.md](./fixtures/before.md)
stale    [fixtures/after.md](./fixtures/after.md)
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
- run: npx inject-examples --check
```

### Several documents

```bash
inject-examples README.md
inject-examples docs/GUIDE.md --root .
```

### Documentation in a subfolder

Links are usually written relative to the repository root, not to the document.
Point `--root` at the root and the markers keep working from anywhere:

```bash
inject-examples --root . docs/GUIDE.md
```

### Run it before every commit

`.git/hooks/pre-commit`:

```bash
#!/bin/sh
npx inject-examples --check || {
  echo "README examples are out of date; run: npx inject-examples"
  exit 1
}
```

## Library

The same engine is exported for scripts and tests. `updateDocument` is pure —
it reads only through the `readFile` you pass and never writes:

```js
import { updateDocument, findMarkers, extractRegion, parseMarker } from 'inject-examples';

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
| `updateDocument(text, options)` | Rewrite every block in a document; `options` may set `root`, `readFile`, `gitignore`, `isIgnored` and `lenient` |
| `injectInto(lines, marker, content, startIndex?)` | Replace one block; returns `{ lines, changed }` |
| `findMarkers(lines)` / `parseMarker(line)` | Discover markers |
| `fenceRanges(lines)` | The fenced blocks in a document |
| `resolveMarker(marker, read)` | The text a marker stands for |
| `extractRegion(text, name)` / `regionDirective(line)` | Region parsing |
| `normalize(text)` | LF endings, one trailing newline removed |
| `fileReader(root)` | A `readFile` that resolves against a root |
| `parseIgnoreFile(text)` | Parse one `.gitignore` into rules |
| `loadIgnoreRules(root, read)` | Walk up from `root` collecting `.gitignore` rules |
| `isIgnoredPath(root, path, ruleFiles)` | Test one path against collected rules |
| `IncludeError` | The error type for a broken include — the one `--lenient` tolerates |
| `FENCE` | The fence prefix (` ``` `) |

## Behaviour notes

- **Normalisation.** Content is injected with LF endings and no trailing
  newline — exactly the text between the fences. A file ending in `\n` and one
  that does not therefore inject identically, so `--check` will not flicker
  between operating systems. The document's own endings (LF or CRLF) are
  preserved everywhere outside the block body.
- **Duplicated markers** in one document are an error, not a silent double
  injection.
- **No markers at all** is an error, because it usually means the file argument
  or the `--root` is wrong. Pass `--allow-empty` to allow it.
- **Only the block body changes.** The marker line, the fence, the fence's
  language tag and everything outside the block are left untouched.
- **Path traversal.** Marker paths resolve against the root and may contain
  `../`: the tool trusts the document it runs on, as it should a `pre-commit`
  hook it installed itself.
- **Gitignore subset.** Comments, `!` negation, leading `/` anchoring,
  trailing `/`, `**`, `*`, `?`, character classes and backslash escapes are
  supported. Quoted patterns and trailing-space escapes are not.

## What this deliberately does not do

This tool was ported from an older include mechanism that also had looser
behaviours. None of them are supported here, and none are planned:

- **No `~suffix` lookup.** A marker names one path; there is no
  `<label>~<suffix>` spelling that would let a label stand for several files
  sharing a stem.
- **No glob arguments.** The CLI takes exactly one file argument. There are no
  glob patterns and no directory arguments; run the tool per document.
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

The package is ready to publish as-is:

```bash
cd inject-examples
npm test                 # node --test
npm pack --dry-run       # inspect exactly what ships
npm publish              # add --access public if you scope the name
```

Before the first publish, consider adding `"repository"` and `"homepage"` to
`package.json` — npm shows them on the package page. If the name
`inject-examples` is taken, publish under a scope (`@you/inject-examples`) or
pick another name; nothing in the code depends on it.

Only `cli.mjs`, `index.mjs`, `README.md` and `LICENSE` ship (`files` in
`package.json`); the test file stays out.

## License

MIT
