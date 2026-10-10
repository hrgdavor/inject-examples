# `rust/section` — the Rust implementation

A Rust implementation of the file-section matcher: it resolves a `#<reference>`
against the text of a file, the way [`lib/section.mjs`](../../lib/section.mjs)
does. [doc/section-matching.md](../../doc/section-matching.md) is the normative
specification, and the JavaScript is the source of truth — **a port mirrors, it
does not lead** ([plans/zig-port.md](../../plans/zig-port.md) §2), so a
disagreement here is a bug here.

## Status

| Layer | State |
| --- | --- |
| Reference parsing, canonicalisation, errors, the contradiction warning | **ported** — pinned by every grammar and warning vector |
| Mask pass (`masked`, `comments_in`) and the lexer seam | **ported** — pinned by the mask rows of the lexical corpus, over every entry |
| Per-language tokenizer and table | **ported** — all eighteen entries, and the extension registry |
| Declaration shapes (`declarations`) | **ported** — pinned by the shape rows of the lexical corpus |
| Block scanner (`scan_blocks`) | **partial** — the `Block` model, the span readers, the region and anchor helpers and every generic matcher are written and unit-tested, but nothing composes them: there is no `scan_blocks` driver, so the `Scan` struct has no producer |
| Resolution (`resolve_section`, `extract_declaration`) | not started |

Parity means matching the JavaScript's *answers*, not only its text: `plan_section` must return the
**1-based inclusive line span** (`start_line`/`end_line`) the text came from and the **matcher** that
found it (`kind` — `region`, `declaration`, `property`, `condition` or `anchor`), because a host
navigates to the span and explains itself with the kind, and `test/vectors/section-vectors.json` pins
both. The Java port in [`java/section`](../../java/section) already does all of this and is the
blueprint for what is left here.

One Rust-specific decision worth knowing: every offset counts **UTF-16 code units**, as the JavaScript
does, so the mask pass works over `Vec<u16>` and converts at its edges. A Rust `char` is a scalar value,
not a code unit, so indexing a `&str` by characters would drift from the JavaScript on any input with an
astral-plane character.

A third implementation needs its own answer to how it is held at parity
(`plans/zig-port.md` §6). This one's answer is the generated corpora, read directly:

```sh
cargo test                 # the gate
cargo test -- --nocapture  # also prints what is asserted and what is pending
```

`tests/vectors.rs` reads
[`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json) —
the same 124 vectors `node tools/section-vectors.mjs --check` holds the JavaScript
to — and asserts every vector the ported layers can answer. It fails if a vector
is neither asserted nor counted, so the remaining work is visible rather than
silently skipped.

`tests/lexical.rs` reads
[`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json),
generated from the JavaScript by `tools/lexical-vectors.mjs`: one **mask** row
per lexer entry — all eighteen, plus the built-in engine for an unknown type —
and one **shape** row per discriminating declaration spelling. This is the gate
that holds the two ported lexical layers: the resolution vectors only exercise
the six lexer entries their fixtures name, so a mistranslated matcher for any of
the other twelve — `publisher: String,` read as the field `lisher`, no
declaration found in `impl<T: Clone> Display for Cart<T> {` — would otherwise
pass every gate. The Zig port keeps a *generated* copy of both corpora because it
has no JSON reader; reading them directly is deliberately better here, since a
file that cannot drift needs no drift gate.

## Boundary

The library has **no dependencies**, by the same rule that keeps
`lib/section.mjs` vendorable: pure text in, text out, no filesystem, no
environment, no editor types, no CLI. `serde_json` is a test-only dependency, used
by the vector harness. Everything a caller needs is a `&str` and a reference.

The language table is data plus a lexer, not a parser, per the design boundary the
plan set keeps: adding a language is one entry and one extension line, never new
matching logic.

## Why it exists

It is an implementation example first and a dependency second: the Zed editor
panel that can be asked to open a file at a location uses it for structural
targets (`path#Cart/Line/render`), so the code that ships and the code that
demonstrates the syntax are the same code.
