# Supported languages

`inject-examples` is language-neutral where it counts: the block tree, matcher
precedence, the sibling-first walk, the modifiers and the rendering all live in
[`lib/section.mjs`](../lib/section.mjs) and know nothing about any language. The
only language-specific work is **lexical** — blanking comments and string
literals so a `}` inside one cannot end a body, and locating the comments that
name anchors and regions.

That work is a **lexer entry**, and a type only earns one where the built-in
default mask would be *wrong* for it. A type with no entry still resolves: it
falls back to the language-agnostic union of the comment and string spellings,
which is conservative and usually right. The full grammar of a reference — paths,
scopes, modifiers, errors — is in
[section-matching.md](./section-matching.md).

## Languages

`src/js/scanner/syntaxes.js` is the table; `src/js/scanner/lexers.js` maps the
extensions. Each entry exists for the construct in the third column, and the
fourth links the sample the [demo page](../docs/index.html) shows it with.

| language | extensions | the construct the entry exists for | sample |
| --- | --- | --- | --- |
| `javascript` | `js` `mjs` `cjs` `jsx` | backtick templates, which span lines and hide braces | — |
| `typescript` | `ts` `tsx` `mts` `cts` | as JavaScript | — |
| `java` | `java` | text blocks (`"""`) | [Inventory.java](../docs/samples/Inventory.java) |
| `zig` | `zig` | **nested** block comments, `\\` multiline strings | [Nesting.zig](../docs/samples/Nesting.zig) |
| `go` | `go` | backtick raw strings, which take no escapes | [Cart.go](../docs/samples/Cart.go) |
| `rust` | `rs` | nested comments, `r#"…"#`, `'a` (lifetime) versus `'a'` (char), `impl` scopes and `name: Type,` fields | [Cart.rs](../docs/samples/Cart.rs) |
| `python` | `py` `pyi` | `"""` / `'''`, raw `r"…"`, indented bodies | [Cart.py](../docs/samples/Cart.py) |
| `csharp` | `cs` | verbatim `@"…""…"`, raw `"""` | [Cart.cs](../docs/samples/Cart.cs) |
| `kotlin` | `kt` `kts` | nested comments, `"""` | [Cart.kt](../docs/samples/Cart.kt) |
| `php` | `php` `phtml` | `<<<EOT` heredocs; `#[Attribute]` is not a `#` comment | [Cart.php](../docs/samples/Cart.php) |
| `ruby` | `rb` `rake` `gemspec` | `def name` with no parens closed by `end`, `=begin`, `<<~TAG` heredocs while `<<` stays a shift | [Cart.rb](../docs/samples/Cart.rb) |
| `sql` | `sql` | `''` doubling, `$$ … $$`; regions carry the sample | [report.sql](../docs/samples/report.sql) |
| `shell` | `sh` `bash` `zsh` | `<<EOF` heredocs, single quotes that take no escapes | [run.sh](../docs/samples/run.sh) |
| `vb` | `vb` `bas` `vbs` | `Class`/`Module`, `Sub`/`Function` closed by `End …`, `""` doubling | [Form.vb](../docs/samples/Form.vb) |
| `haskell` | `hs` `lhs` | nested `{- -}`, string gaps, `name … = …` bindings and `data`/`class` declarations | [Main.hs](../docs/samples/Main.hs) |
| `yaml` | `yaml` `yml` | `'…'` doubling and quoted `#`; the region rule reads key paths | [app.yaml](../docs/samples/app.yaml) |
| `toml` | `toml` | `"""` / `'''`; the region rule reads tables and keys | [app.toml](../docs/samples/app.toml) |
| `ini` | `ini` `cfg` `properties` | `;` and `#` comments; the region rule reads `section.key` | [app.ini](../docs/samples/app.ini) |

## Config formats

Four formats are not code and have no members to search, so each gets a **region
rule** instead of a lexer: the reference is a path to a key, and the selection is
*rendered* as valid source of that format, with the ancestors that hold the key.

| format | extensions | reference | selection |
| --- | --- | --- | --- |
| JSON | `json` | `#name,scripts.test`, `#keywords.0` | re-printed as valid JSON, comma-separated paths merged |
| YAML | `yaml` `yml` | `#server.port`, `#server` | the key with the mappings that hold it, re-indented to two spaces |
| TOML | `toml` | `#server.port`, `#server` | the key above its `[table]` header, or the whole table |
| INI | `ini` `cfg` `properties` | `#server.port`, `#section`, `#key` | the key under its `[section]`, or the whole section |

A missing key, a missing table or section, an index out of range, and a path the
format cannot express are errors; `--lenient` reports them like any other broken
include. `.json` files are the reason the built-in rule set exists — see
[Region rules by file type](../README.md#region-rules-by-file-type).

## Member shapes

The generic matcher finds `name(` declarations and the usual class-like keywords
(`class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`, `union`) in
braced and indented languages. A few languages spell members another way, and
those shapes are declared as data beside the comments and strings:

- **Ruby** — `def name` (parentheses optional, `self.` not part of the name),
  closed by its `end` line.
- **VB** — `Class`/`Module`/`Structure` and `Sub`/`Function`, closed by the
  matching `End …` line.
- **Haskell** — a top-level binding (`add x y = x + y`) with its `name ::` type
  signature as the annotation the `+` scope brings along, plus `data`, `newtype`,
  `type` and `class` declarations.
- **Rust** — `impl Type { … }` (and `impl Trait for Type`) as a scope named after
  the type, so a type's methods and its `struct` are siblings answering to one
  name; the path retries them. `name: Type,` fields are members too.

## Adding a language

1. **The syntax** — one object in
   [`src/js/scanner/syntaxes.js`](../src/js/scanner/syntaxes.js): `lineComments`,
   `blockComments` (`nested`, `lineStart`), `strings` (`open`/`close`,
   `escape: 'backslash' | 'doubling' | null`, `multiline`, `lineScoped`,
   `boundary`, `hashes`, `maxSpan`/`content`), `heredoc`, and — only where the
   generic matcher is blind — `declarations` and `annotations`. The knobs and
   their meaning are documented at the top of
   [`tokenizer.js`](../src/js/scanner/tokenizer.js).
2. **The extensions** — one line in `EXTENSIONS` in
   [`lexers.js`](../src/js/scanner/lexers.js).
3. **The cases** — probe entries (`hidden` and `kept` words) in the corpus in
   [`tools/mask-oracle.mjs`](../tools/mask-oracle.mjs). `test.mjs` runs the corpus,
   so one entry is one test.
4. **The check** — `node tools/mask-oracle.mjs` cross-checks the corpus against
   [highlight.js](https://highlightjs.org) (a devDependency, never shipped): every
   region it calls a comment or a string must be blank in our mask. Blanking more
   is allowed and usual; a region our mask does not know is reported.

Nothing in `lib/section.mjs` changes: an entry changes **what is blanked**, and a
declaration shape only adds a block to index. Precedence, the walk, the modifiers
and the rendering are the same for every language, which is why a new entry
cannot change an existing answer — `node tools/section-vectors.mjs --check` is the
proof, and those golden vectors are also the conformance set for a substitute
engine ([section-matching.md](./section-matching.md)).

## See also

- [The demo page](../docs/index.html) — one section per language and format,
  clickable targets, the file on the right.
- [section-matching.md](./section-matching.md#tokenizers) — the normative
  description of the lexer seam and the mask invariant.
- [lib/README.md](../lib/README.md) — the resolver as a vendorable module, for a
  project that wants to inject its own lexer.
