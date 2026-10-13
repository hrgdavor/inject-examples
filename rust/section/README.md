# `rust/section` — the Rust implementation

A Rust implementation of the file-section matcher: it resolves a `#<reference>`
against the text of a file, the way [`lib/section.mjs`](../../lib/section.mjs)
does. [doc/section-matching.md](../../doc/section-matching.md) is the normative
specification, and the JavaScript is the source of truth — **a port mirrors, it
does not lead** ([plans/zig-port.md](../../plans/zig-port.md) §2), so a
disagreement here is a bug here.

## Status

| Layer                                                                              | State                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Reference parsing, canonicalisation, errors                                        | **ported** — pinned by every grammar vector, including the one row the corpus marks `"parser": "path"`, which is fed to the single-path `parse_reference` rather than to `parse_selectors` |
| Stable failure codes (`ERROR_CODES`)                                               | **ported** — `ErrorCode` mirrors the JavaScript registry string for string, and every vector asserts its `code` beside its message (the message text is byte-identical to before the codes were added) |
| Mask pass (`masked`, `comments_in`) and the lexer seam                             | **ported** — pinned by the mask rows of the lexical corpus, over every entry |
| Per-language tokenizer and table                                                   | **ported** — all eighteen entries, and the extension registry                |
| Declaration shapes (`declarations`)                                                | **ported** — pinned by every shape row of the lexical corpus, including the six Kotlin `fun` spellings, which the hand-written matcher answers without a regex engine |
| Block scanner (`scan_blocks`)                                                      | **ported** — the `Block` model, the span readers, the region and anchor helpers, every generic matcher, and the driver that composes them into a `Scan` |
| Resolution (`plan_section`, `resolve_section`, `extract_declaration`)              | **ported** — the walk, the per-selector scopes, the line ranges, the matcher `kind` and the diagnosis are all here, and every one of the 280 vectors resolves as the JavaScript does |
| Envelopes (`Inventory/^,toString,$`)                                               | **ported** — `^` and `$` are whole-segment marks on a path (`Envelope`), read as one unit before the per-selector loop: the head is the parent's declaration line through the line its body opens on, the tail is its last declaration line, and what sits between the marks is read **inside** the parent. The marks **retry** a name several blocks answer to, so `Cart/^,add,$` names the `impl` that holds `add` |
| Regions a bare name reaches (`catalog`), an indented condition, an indented anchor | **ported** — a `#`-prefixed region directive, a condition literal in a statement closed by indentation, and a comment anchor on an indented block's header line or as the first thing in its body, pinned by the four `test/fixtures/Hash.py` vectors (`hash-region-bare-name`, `hash-indented-condition`, `hash-indented-condition-second`, `hash-indented-anchor`) |

The port is complete: `tests/vectors.rs` asserts all 280 vectors and disagrees on
none, and every suite the crate ships is green. No vector that passed before the
codes were added fails now, and no expectation was relaxed to make the codes fit.

Parity means matching the JavaScript's *answers*, not only its text: `plan_section` must return the
**1-based inclusive line span** (`start_line`/`end_line`) the text came from and the **matcher** that
found it (`kind` — `region`, `declaration`, `property`, `condition`, `anchor`, the `envelope` a mark
contributes, `lines` for a line range, or `multiple` when the reference had several selectors), because
a host navigates to the span and explains itself with the kind, and
`test/vectors/section-vectors.json` pins both. It also pins the **stable failure code** a host branches
on, and so does `tests/vectors.rs`.

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
the same 280 vectors `node tools/section-vectors.mjs --check` holds the JavaScript
to — and asserts every vector the ported layers can answer, its message and its
stable `code` alike. It fails if a vector
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
