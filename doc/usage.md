# Using inject-examples

A detailed guide to using inject-examples in a real project.

The JavaScript implementation is the source of truth for everything described
here. The Zig port under `src/` is written to match it byte for byte, and the
JavaScript is the one that wins when they disagree; see
[The Zig port](../README.md#the-zig-port).

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
- [Writing a processed copy](#writing-a-processed-copy)
- [Skipping gitignored files](#skipping-gitignored-files)
- [Tolerating broken includes](#tolerating-broken-includes)
- [Recipes](#recipes)
- [Using the library](#using-the-library)
- [Examples and tests share the same files](#examples-and-tests-share-the-same-files)
- [Keeping this document in sync](#keeping-this-document-in-sync)

## How this document is built

The whole document is one argument to the tool. Two commands keep it honest:

```
npx @hrg/inject-examples doc/usage.md
npx @hrg/inject-examples --check doc/usage.md
```

- The document lives in a subfolder, so its markers use paths relative to the
  document itself — `../test/fixtures/before.md` — which is how a reader
  resolves the same link, and what the tool's default root (the document's
  directory) expects, so no `--root` is needed.
- The first command rewrites every block below a marker with the file's
  current text. The second only reports: anything stale or failed ends with
  exit `1` and writes nothing — that is the CI hook.
- This document ships with the repository, not with the npm package: the
  package's `files` field contains `cli.mjs`, `index.mjs`, `lib/`,
  `src/js/scanner/`, `doc/languages.md`, `doc/section-matching.md`, `README.md`
  and `LICENSE`, but not this guide or its fixtures — those live in the source
  tree, where CI can check them in.

## What ships

The entire published package, verbatim:

[../package.json](../package.json)

```json
{
  "name": "@hrg/inject-examples",
  "version": "1.2.2",
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
    "./lib/section.mjs": "./lib/section.mjs",
    "./lib/jump.mjs": "./lib/jump.mjs",
    "./src/js/scanner/lexers.js": "./src/js/scanner/lexers.js",
    "./package.json": "./package.json"
  },
  "bin": {
    "inject-examples": "./cli.mjs"
  },
  "files": [
    "cli.mjs",
    "index.mjs",
    "README.md",
    "LICENSE",
    "lib",
    "src/js/scanner",
    "doc/languages.md",
    "doc/section-matching.md",
    "doc/rfc"
  ],
  "engines": {
    "node": ">=18"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "prepublishOnly": "node cli.mjs --quiet doc/usage.md && npm test",
    "test": "node --test test.mjs && node --test lib/jump.test.mjs && tsc --noEmit && node tools/section-vectors.mjs --check && node tools/lexical-vectors.mjs --check && node tools/profile-vectors.mjs --check && node tools/zig-vectors.mjs --check && node tools/error-codes-zig.mjs --check && node tools/conformance-manifest.mjs --check && node tools/package-contents.mjs --check",
    "vectors": "node tools/section-vectors.mjs",
    "lexical:vectors": "node tools/lexical-vectors.mjs",
    "profile:vectors": "node tools/profile-vectors.mjs",
    "zig:vectors": "node tools/zig-vectors.mjs",
    "manifest": "node tools/conformance-manifest.mjs",
    "oracle": "node tools/mask-oracle.mjs",
    "compare:zig": "node tools/compare-zig.mjs",
    "test:lua": "lua lua/section/tests/run.lua",
    "test:lua:jit": "luajit lua/section/tests/run.lua",
    "test:nvim": "nvim --headless -u NONE --cmd \"set rtp+=.\" -l lua/md-jump/tests/smoke.lua",
    "typecheck": "tsc --noEmit",
    "demo": "bun tools/build-demo.mjs --pages inject --pages jump",
    "demo:check": "bun tools/build-demo.mjs --pages inject --pages jump --check"
  },
  "devDependencies": {
    "@types/node": "^26.6.5",
    "highlight.js": "^11.12.0",
    "typescript": "^7.0.2"
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

[../test/fixtures/before.md](../test/fixtures/before.md)

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
`index.mjs` by its section:

[../index.mjs#parseMarker](../index.mjs#parseMarker)

```javascript
// #region parseMarker
/**
 * Read one line as an injection marker, or return null.
 *
 * A marker is a line that is nothing but a link to a real path, labelled with
 * that same path — optionally naming a section in the fragment, which both the
 * label and the destination may carry:
 *
 *     [fixtures/example-1/before.md](./fixtures/example-1/before.md)
 *     [fixtures/example-4/source.md](./fixtures/example-4/source.md#table)
 *     [fixtures/example-4/source.md#table](./fixtures/example-4/source.md#table)
 *
 * @returns {{ raw: string, path: string, reference: string | null } | null}
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
    // The label mirrors what the link points at. A link that names a section
    // writes the fragment in both places — `[path#section](./path#section)` — so
    // the label is accepted as either the path alone or the whole destination;
    // comparing it against the path alone rejected every section marker.
    if (
        withoutDotSlash(label) !== withoutDotSlash(path) &&
        withoutDotSlash(label) !== withoutDotSlash(destination)
    ) {
        return null;
    }

    // Normalise away a leading `./` so `path` is directly usable as a path.
    const relativePath = withoutDotSlash(path);
    // An empty path means an in-page navigation link (`[text](#anchor)`), never
    // a marker: a marker names a file.
    if (relativePath === '') return null;

    if (fragment === '') return { raw: line.trim(), path: relativePath, reference: null };

    return { raw: line.trim(), path: relativePath, reference: fragment };
}
// #endregion
```

## Regions

When only part of a file belongs in the document, the file carries region
directives and the marker names the region. The next block is one region of
`test/fixtures/example.ts`:

[../test/fixtures/example.ts#table](../test/fixtures/example.ts#table)

```typescript
// #region table
| name | qty |
| ---- | --- |
| bolt | 12  |
// #endregion
```

The same file, a different region, through the same kind of marker — two
markers may point at different regions of one file, because the duplicate
rule only forbids identical marker text:

[../test/fixtures/example.ts#config](../test/fixtures/example.ts#config)

```typescript
// #region config
export const config = { retries: 3 };
// #endregion
```

Region directives come in the comment spellings a project actually uses —
`//`, `#`, `--`, `;`, `%`, `'`, `REM`, `<!--` and `/* */` — and the comment
prefix is stripped before the name is read. A region is injected with its own
directive lines by default — the opening `#region <name>` through
`#endregion` — just as a declaration carries its signature; `#name/-` selects
the body between them. The rules:

- `#region <name>` opens a named region; `#endregion` closes it (a bare
  `#region` closes the unnamed one).
- A block may instead be named **without any region directive**: the braces
  already mark its start and end, so `{//<name>` (or a `//<name>` line just
  inside the block) is enough — no `#region` prefix and no `#endregion` are
  needed.
- A file must contain at least one directive, and a region name may appear
  only once — a missing, duplicate or unclosed region is an error.
- `#region` in code without a comment prefix, e.g. C#, is not a directive;
  the same line inside a comment is.

Any of the usual comment prefixes is accepted, in any language:

| Spelling                                                            | Seen in                         |
| ------------------------------------------------------------------- | ------------------------------- |
| `#region name` / `#endregion`                                       | C#, Razor                       |
| `// #region name` / `// #endregion`                                 | VS Code folding                 |
| `//region name` / `//endregion`                                     | JetBrains IDEs                  |
| `<!-- #region name -->`                                             | HTML, Markdown                  |
| `/* #region name */`                                                | C-style block comments          |
| `-- #region`, `; #region`, `% #region`, `' #region`, `REM #region`  | SQL, INI, VB, TeX               |

A block can also be named as a **region shorthand**: write the name at the
opening brace (`{//name`, `{// name`) or on the first line inside the block
(`//name`). The braces are the block's own start and end markers, so there is no
`region` prefix and no ending comment; the block may be bare (`{ … }`) or carry a
`while`, `if` or declaration prefix. The default selection is the block, from
its opening line through the matching closer — a one-line `{/*name*/ … }` block
included — so that prefix comes with it; `/-` selects the body without the
opening line (and without a next-line anchor line too). A region keeps its
directives and a declaration keeps its signature the same way, so the three
targets read alike.


## Region rules by file type

`#<reference>` means "the piece of this file called `<reference>`". What
the reference may say — and what comes back — depends on the file's **type**:
each type has one rule, and the reference is handed to the rule that claims the
file's extension. Six rules ship — JSON, YAML, TOML, INI, CSS and the `code`
fallback — and a seventh is a few lines in a `regionRules`
array (see [Adding a rule for another type](#adding-a-rule-for-another-type)).

A reference is one or more **selectors** separated by commas, and every rule
reads the list that way: the pieces are resolved in the order they were written
and injected in that order, one after another. What a single selector may say is
the rule's business — a name, a key path, or a line range — and a reference of
one selector is the ordinary case of a list of one.

### The default rule: code, and everything else

One rule covers every type no other rule claims — source code, `README.md`,
`.txt`, anything. In a file that carries an explicit region directive,
`#region <name>` opens and `#endregion` closes it, and the whole region from the
opening directive through the closing one is injected — `/-` selects the body
between them — exactly as [Regions](#regions) describes.

When the file carries no such directive, the name is looked for as a
**declaration**: a method, constructor, function, or class-like declaration
(`class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`) named
`<name>`. The match is the text from the declaration's first line through its
closing brace — or, in an indentation language such as Python, through the last
line of its indented block. Nothing has to be added to the code first: the
declaration *is* the region.

A `-`, `+` or `++` **segment** after the path selects how much of that
declaration comes with it:

| Reference | Injected text                                                                          |
| --------- | -------------------------------------------------------------------------------------- |
| `#add`    | the declaration: signature through closing brace                                       |
| `#add/-`  | the body only, without the signature                                                   |
| `#add/+`  | the declaration **and the annotations above it** (`@Override`, `#[test]`, a decorator) |
| `#add/++` | the declaration, its annotations, **and the doc comment above them** (a `/** … */` block or a run of `///` lines) |

All four, against `test/fixtures/Example.java` — first the declaration itself:

[../test/fixtures/Example.java#toString](../test/fixtures/Example.java#toString)

```java
    public String toString() {
        return String.join(",", items);
    }
```

then its body alone:

[../test/fixtures/Example.java#toString/-](../test/fixtures/Example.java#toString/-)

```java
        return String.join(",", items);
```

then the declaration with its annotation:

[../test/fixtures/Example.java#toString/+](../test/fixtures/Example.java#toString/+)

```java
    @Override
    public String toString() {
        return String.join(",", items);
    }
```

then annotation and doc comment together:

[../test/fixtures/Example.java#toString/++](../test/fixtures/Example.java#toString/++)

```java
    /** Add one item to this cart. */
    @Override
    public String toString() {
        return String.join(",", items);
    }
```

The name may equally be a class-like declaration, nested or not:

[../test/fixtures/Example.java#Line](../test/fixtures/Example.java#Line)

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
- Matching is not a parser. It reads declaration-shaped lines and counts
  brackets over text whose comments and string literals are blanked, so a `}`
  inside a string cannot end a body. JavaScript/TypeScript, Java and Zig get
  that blanking from a real tokenizer, exact to the language's syntax; other
  types fall back to a best-effort union of the comment and string spellings.
  Braced languages — Java, C#, C/C++, JavaScript/TypeScript, Go, Rust, PHP,
  Kotlin, Swift — are followed by their braces; Python and Ruby by indentation.
- The declaration is injected verbatim, indentation and all, so a nested method
  keeps the indentation it has in its file.

#### Section paths and code anchors

A slash-separated reference descends block by block, so a name can be reached
by its location rather than only by its (possibly ambiguous) name. `Cart` names
the class, `Cart/Line` the inner class inside it, and `Cart/Line/render` the
method inside that. This is the nested `render`, not the outer class:

[../test/fixtures/Example.java#Cart/Line/render](../test/fixtures/Example.java#Cart/Line/render)

```java
        String render() {
            return name + " x" + quantity;
        }
```

Within a scope a segment may also match a block by what it **contains**. A
statement whose header carries the name as a double-quoted string is a
**condition literal**; a block whose opening is marked by a leading comment is a
**comment anchor**. `Anchors.java` has both — a `dispatch` method with an
`if ("getUsers".equals(...))`, and a `handler` method opened with `//getUsers`:

[../test/fixtures/Anchors.java#dispatch/getUsers](../test/fixtures/Anchors.java#dispatch/getUsers)

```java
        if ("getUsers".equals(methodName)) {
            System.out.println("users");
        }
```

The `-` modifier selects how much of the match comes along; here the
condition's body alone, without the `if (...) {` header or its closing brace:

[../test/fixtures/Anchors.java#dispatch/getUsers/-](../test/fixtures/Anchors.java#dispatch/getUsers/-)

```java
            System.out.println("users");
```

A name that is hard to reach by path can be reached by its anchor comment
instead. This reaches the `handler` block by the `//getUsers` that opens it:

[../test/fixtures/Anchors.java#handler/getUsers](../test/fixtures/Anchors.java#handler/getUsers)

```java
    public void handler() { //getUsers
        System.out.println("anchor same line");
    }
```

The modifier is a **segment of its own**, written after the `/` that delimits the
path: `render/-` is the body of `render`, `render/+` the declaration with its
annotations, `render/++` with its doc comment. It is legal only as the last
segment — `Cart/Line/-/render` is an error, because a modifier describes the
selection and nothing is selected until the path ends — and `+` never occurs
inside a name, so a `render-` is a name no file declares, and the message for it
says what to write instead:

```text
inject-examples: [a.java#render++](./a.java#render++): "++" is a path segment now; write "#render/++"
```

A name may contain `-` (`item-list`, `update-document-test`) and a CSS custom
property may begin with `--`; only a whole segment is ever a modifier.

The full grammar is in [section-matching.md](./section-matching.md), and the
matcher is one dependency-free module, [lib/section.mjs](../lib/section.mjs)
(documented in its own [lib/README.md](../lib/README.md)).

#### Line ranges, when a name will not do

A selector may also be a **line range**, for a file whose structure the matchers
cannot see — a config fragment, a log, a table in a comment. `L<line>` is one
line, `L<line>:<column>` starts at a column of it, and `L<line>-L<line>` is a
range; lines and columns are counted from 1, both ends are inclusive, and an
endpoint with no column runs to the end of its line:

| Reference     | Injected text                                            |
| ------------- | -------------------------------------------------------- |
| `#L12-L14`    | lines 12, 13 and 14, verbatim                            |
| `#L13`        | line 13 alone                                            |
| `#L13:9`      | line 13 from its ninth character to the end of the line  |
| `#L4:8-L4:22` | from the eighth character of line 4 to its twenty-second |

The three lines of `toString`, named by number rather than by name:

[../test/fixtures/Example.java#L12-L14](../test/fixtures/Example.java#L12-L14)

```java
    public String toString() {
        return String.join(",", items);
    }
```

A range that asks for lines the file does not have is an error — `#L31` in a
30-line file, `#L2:1` on a blank line — never a silent clamp: a range that
quietly became a different range is the drift this tool exists to prevent. A
range takes no modifier (`#L40+` is malformed, because the `+` would have to be
read as part of the range); a modifier written in front of the whole reference
belongs to the reference, and a range ignores it.

Because the comma is the contract every rule shares, one reference may name
several pieces and they are injected in the order written — a name and a range
mix freely. The annotated `toString`, then the inner `Line` class:

[../test/fixtures/Example.java#toString/+,L16-L20](../test/fixtures/Example.java#toString/+,L16-L20)

```java
    @Override
    public String toString() {
        return String.join(",", items);
    }
    /** One line of a cart. */
    public static class Line {
        private final String name;
        private final int quantity;

```

(`#add,remove` names two methods the same way, and `#scripts/test,keywords/0`
two JSON keys — the list is general, and how a rule joins its pieces is the
rule's own business.)

### The JSON rule

JSON has no comments to hang a region directive on, so `.json` gets a rule of
its own: `#<reference>` names one or more **keys**, comma-separated,
each a `/`-separated path from the top level. The selected values are rendered as
valid JSON — braces and all — in the order they are listed.

Top-level keys and a nested one, from `package.json`:

[../package.json#name,version,scripts/test](../package.json#name,version,scripts/test)

```json
{
  "name": "@hrg/inject-examples",
  "version": "1.2.2",
  "scripts": {
    "test": "node --test test.mjs && node --test lib/jump.test.mjs && tsc --noEmit && node tools/section-vectors.mjs --check && node tools/lexical-vectors.mjs --check && node tools/profile-vectors.mjs --check && node tools/zig-vectors.mjs --check && node tools/error-codes-zig.mjs --check && node tools/conformance-manifest.mjs --check && node tools/package-contents.mjs --check"
  }
}
```

An array keeps only the elements named, in order:

[../package.json#keywords/0,keywords/2](../package.json#keywords/0,keywords/2)

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

### The YAML, TOML and INI rules

The three config formats have the same problem as JSON and the same answer: a
reference is a path to a key — the same `/`-separated path a code reference
uses — and the selection is rendered with the ancestors that hold it, so the
block is valid source on its own: a bare `port: 8080` is not a YAML document,
`server:` above it makes one.

| Reference      | `.yaml`                                             | `.toml`                      | `.ini`                                          |
| -------------- | --------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| `#server`      | the `server:` mapping                               | the whole `[server]` table   | the whole `[server]` section                    |
| `#server/port` | `server:` and its `port:` entry                     | `[server]` and `port = 8080` | `[server]` and `port = 8080`                    |
| `#a/b/c`       | every ancestor, re-indented to two spaces per level | `[a.b]` and its key          | an error — INI has sections and keys, no deeper |

The three spellings of one demo config, under `docs/samples/` — the same
`server` key asked of a YAML, a TOML and an INI file:

[../docs/samples/app.yaml#server/port](../docs/samples/app.yaml#server/port)

```yaml
server:
  port: 8080
```

[../docs/samples/app.toml#server/hosts](../docs/samples/app.toml#server/hosts)

```toml
[server]
hosts = [
  "a.example",
  "b.example",
]
```

[../docs/samples/app.ini#server/port](../docs/samples/app.ini#server/port)

```ini
[server]
port = 8080
```

A deeper key arrives with every ancestor it needs, re-indented, so the block
still reads as the document it came from:

[../docs/samples/app.yaml#server/tls/enabled](../docs/samples/app.yaml#server/tls/enabled)

```yaml
server:
  tls:
    enabled: true
```

A `/` separates the keys of the *reference*, for every rule alike — it is not
the format's own spelling. A key that itself contains a dot is therefore still
addressable — `#a/b.c` selects the key `b.c` under `a` — and a quoted segment
(`#a/"b.c"`) says the same thing explicitly, because these formats let a key be
quoted in the source. A TOML *header* keeps the format's own dots (`[a.b]`),
which is the format's spelling and not the reference's.

A YAML selection keeps its blank and nested lines; a TOML value that spans lines
(an array, an inline table) comes with its continuation lines; INI quotes
nothing back — both the `key = value` and the `key: value` spellings are read. A
missing key, a missing table or section, and a path the format cannot express
are all errors, reported by `--lenient` like any other broken include. A
duplicated key, table or section is an error too, rather than the first one to
appear.

### The CSS rule

CSS has no members to search, so `.css` gets a rule of its own — but its
vocabulary is CSS's. A reference names a **rule**, not a declaration: a style
rule by the rightmost simple selector of its selector list, or an at-rule by its
keyword and parameter. `/` descends the nesting CSS already has, so a rule inside
a media query is a child of it and no descendant syntax is needed.

| Reference                      | Injected text                                     |
| ------------------------------ | ------------------------------------------------- |
| `#.card`                       | the rule: selector through closing brace          |
| `#.card-`                      | its declarations alone, without the selector      |
| `#@media`                      | the whole media block                             |
| `#@media:screen`               | the media block whose parameter contains `screen` |
| `#@keyframes:pulse`            | the `@keyframes` block named `pulse`              |
| `#@media/.card`                | the `.card` rule the media block holds            |
| `#.card[data-variant=compact]` | the rule whose selector carries that attribute    |

A rule with a compound selector is named by its **rightmost simple selector**, so
`li.item` is `.item` and `ul > li.item` is `.item` too; `:root` is a name of its
own. Two rules may share a name — a base rule and a variant — and a bare name
that matches more than one block is an error, exactly as two `#region`s of one
name are. The **predicate** written after the name is how you say which:
`[data-variant=compact]` reads that attribute from the selector, `[sel=:hover]`
its selector text, and `[--brand]` a custom property the block declares.

A stylesheet may still carry `#region` directives — `/* #region name */` — and
they resolve as they do anywhere: a bare name that is a region is the region, and
a `.`/`@` name is never one, so a class name and a region name cannot collide.

The design tokens of `docs/samples/site.css`, and the `.card` rule the media
query overrides:

[../docs/samples/site.css#:root](../docs/samples/site.css#:root)

```css
:root {
  --brand: #1f6feb;
  --radius: 6px;
}
```

[../docs/samples/site.css#@media/.card/-](../docs/samples/site.css#@media/.card/-)

```css
grid-template-columns: 1fr 1fr;
```

A CSS selection is the file's own bytes, like a code declaration: the rule
**copies** the lines it names, so the indentation you see is the file's.

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

[../test/fixtures/fenced.md](../test/fixtures/fenced.md)

````markdown
Prose, then a nested fence:

```js
const x = 1;
```

And prose after it.
````

## Running the CLI

```
inject-examples [--root <dir>] [--check] [--dry-run] [-o, --out <file>]
                [--allow-empty] [-l, --lenient] [-g <file>] [--no-gitignore]
                [-q] <file|dir> ...
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
- `-o, --out <file>` — write the processed document to `<file>` instead of
  updating the input in place (below); exactly one input file is required.
- `--allow-empty` — succeed when the document contains no markers at all.
  Markers that were all skipped still resolve nothing, and still fail.
- `--lenient` — tolerate broken includes (below).
- `-g <file>`, `--no-gitignore` — override or disable gitignore handling.
- `-q` — print only the per-document summary line.

Exit codes: `0` on success; `1` on a stale block, an unreadable file or
directory, a directory that holds no Markdown, a malformed marker, a document
whose markers all resolved nothing, or (with `--lenient`) a marker that could
not be resolved; `2` on a usage error, such as a `--out` run given a directory
or more than one file. With several targets the code is the worst of the run.

Every document ends with one summary line, even with `-q`:

```text
doc/usage.md: 8 markers, 0 stale
```

The second count is `stale` under `--check`/`--dry-run` and `updated` when the
document is written; `failed` and `skipped` are added when they are non-zero.
`--out` names both files. A document with markers where every one was skipped
prints `N markers, 0 stale, N skipped` and exits `1`: a run that checked
nothing is not a passing run. `--allow-empty` only covers a document with no
markers at all.

The tool's own output for a clean run over this document:

[../test/fixtures/after.md](../test/fixtures/after.md)

```markdown
$ npx @hrg/inject-examples doc/usage.md
doc/usage.md: 27 markers, 0 updated
```

A check run over a document with one stale block and one gitignored target:

```
$ inject-examples --check
ok       [test/fixtures/before.md](./test/fixtures/before.md)
stale    [test/fixtures/after.md](./test/fixtures/after.md)
skipped  [node_modules/dep.js](./node_modules/dep.js)
README.md: 3 markers, 1 stale, 1 skipped

README.md is stale: 1 of 2 block(s) differ from their files.
Run: inject-examples README.md
```

A difference is reported as `stale` under `--check` and `--dry-run` (nothing was
written) and as `updated` on a normal run. A gitignored target is reported as
`skipped` and never counts as stale. A marker that `--lenient` could not resolve
is reported as `failed` — and, unlike `skipped`, it is an error: the run ends
`1` and the marker's block is left as written.

## Writing a processed copy

For a build step, the processed document can go to a different file while the
input stays untouched:

```
npx @hrg/inject-examples --out dist/usage.md doc/usage.md
```

- Markers still resolve against the input's own directory, exactly as in the
  in-place run; the input is never written — only the destination file is.
- The destination may live anywhere: missing parent directories are created.
  Exactly one input file is required; a directory or several files is a
  usage error (exit `2`).
- `--check --out` verifies an existing copy instead of writing one: it ends
  `1` when the copy is stale or missing, and writes nothing — the CI hook
  for a build artifact.
- `--dry-run`, `--lenient` and `-q` compose as usual: `--dry-run` reports the
  write; `--lenient` leaves a broken include's block as written in the copy
  and still ends `1`.
- The copy keeps the input's relative links, so its links point at the
  input's neighbours, not the copy's own: treat the copy as a build artifact,
  or rewrite the links afterwards.

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

## Tolerating broken includes

With `--lenient`, a marker whose file or region cannot be read — or whose
block cannot be found — is reported with its line number, left as written,
and the run continues; the run still ends `1`, because a broken include is
an error to be fixed, not a success. Duplicate markers and stray text where a
block should be stay strict in every mode.

A run over a document with one broken include beside two healthy ones:

```
$ inject-examples --lenient
updated  [test/fixtures/before.md](./test/fixtures/before.md)
failed   [test/fixtures/missing.md](./test/fixtures/missing.md)
updated  [test/fixtures/after.md](./test/fixtures/after.md)

README.md: 2 updated, 1 failed.
```

In the library this is the `lenient` option of `updateDocument`; a
failure-skipped marker shows up in `results` as `{ marker, content: null,
changed: false, skipped: true, failure: <cause> }`, distinct from a gitignored
skip, which has no `failure`.

## Recipes

The command lines a real project ends up with, as a starting point.

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

### Run it before every commit

`.git/hooks/pre-commit`:

```bash
#!/bin/sh
npx @hrg/inject-examples --check || {
  echo "README examples are out of date; run: npx @hrg/inject-examples"
  exit 1
}
```

Writing the processed document to a separate file, and the CI form of that
check, are in [Writing a processed copy](#writing-a-processed-copy) and
[Keeping this document in sync](#keeping-this-document-in-sync).

## Using the library

The CLI is a thin wrapper over one function, `updateDocument(text, options)`;
the library is pure and reads only through the `readFile` you hand it, which
is why the test suite drives it in memory. The block below is the real test
that drives the engine — a live marker into `test.mjs`, by its section:

[../test.mjs#update-document-test](../test.mjs#update-document-test)

```javascript
// #region update-document-test
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
// #endregion
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
  this repository — `package.json`, `index.mjs`, `test.mjs`,
  `test/fixtures/before.md`, `test/fixtures/after.md`,
  `test/fixtures/example.ts`, `test/fixtures/Example.java`,
  `test/fixtures/Anchors.java`, `test/fixtures/fenced.md`,
  `docs/samples/site.css`, `docs/samples/app.yaml`, `docs/samples/app.toml`
  and `docs/samples/app.ini`. Nothing was invented for the docs; each shown
  block is the current content of a file the repository owns.
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
  document's own directory, the standard Markdown convention this document's
  markers follow. Fenced blocks and inline code are data, not navigation, so
  illustrative markers there — such as a `failed` demo — are exempt, exactly
  as marker-like lines inside fences are inert. A test in `test.mjs` enforces
  this rule over every Markdown file in the repository.

## Keeping this document in sync

Regenerate whenever a shown file changes, and check in CI:

```
npx @hrg/inject-examples doc/usage.md
npx @hrg/inject-examples --check doc/usage.md
```

A stale block fails the check with the marker's line number and a `stale`
label, and writes nothing; regenerate and commit. As a CI step:

```yaml
- name: Check injected examples
  run: npx @hrg/inject-examples --check doc/usage.md
```
