# The Lua port — the Neovim implementation

**Status: complete, gated by the shared corpora.**

The Lua port is the fourth port of the section matcher (after Zig, Java and
Rust) and the first one a Neovim host can load with no process, no ES module and
no Node dependency. It lives in [`lua/section`](../lua/section); the Neovim plugin
vendored from `md-jump.nvim` lives beside it in
[`lua/md-jump`](../lua/md-jump), with `plugin/md-jump.lua` and
[`doc/md-jump.txt`](../doc/md-jump.txt) at the repository root.

## 1. Why it exists

`md-jump.nvim` originally carried two implementations: a naive pure-Lua
approximation of the jump policy and an optional Node fallback that imported
`@hrg/inject-examples/lib/jump.mjs` for exactness. The approximation disagreed
with the resolver on paths, scopes, modifiers, regions, anchors and envelopes;
the Node fallback required a JavaScript runtime inside an editor that already
has Lua.

The Lua port removes both halves of that compromise. The plugin now calls the
same resolver the other ports do, and the resolver is held to the same corpora.

## 2. The rule

**The JavaScript is the source of truth.** `lib/section.mjs`,
`lib/jump.mjs`, `src/js/scanner/**` and the corpora define what the tool does.
A disagreement in Lua is a bug in Lua. The port mirrors the JavaScript file for
file:

| JavaScript                    | Lua                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `lib/section.mjs`             | [`lua/section/init.lua`](../lua/section/init.lua), `src/parser.lua`, `src/mask.lua`, `src/scan.lua`, `src/scanner.lua`, `src/resolver.lua` |
| `lib/jump.mjs`                | [`lua/section/src/jump.lua`](../lua/section/src/jump.lua)                           |
| `src/js/scanner/syntaxes.js`  | [`lua/section/src/scanner/syntaxes.lua`](../lua/section/src/scanner/syntaxes.lua)   |
| `src/js/scanner/tokenizer.js` | [`lua/section/src/scanner/tokenizer.lua`](../lua/section/src/scanner/tokenizer.lua) |
| `src/js/scanner/lexers.js`    | [`lua/section/src/scanner/lexers.lua`](../lua/section/src/scanner/lexers.lua)       |

## 3. Two design decisions

**UTF-16 code units.** Every offset in the JavaScript counts UTF-16 code units.
Lua strings are UTF-8, so the port decodes a source once into an array of unit
numbers (`lua/section/src/units.lua`), scans that array and encodes back at the
API edge. The mask therefore preserves length and every newline offset even
through an astral-plane character, and a `nameAt`/`headerFrom` offset agrees
with the JavaScript and with the Rust port's `Vec<u16>`.

**Patterns, not approximations.** The resolver and tokenizer are defined by
JavaScript regular expressions. Translating them into Lua patterns would be a
second, subtly different specification, so the port keeps the patterns as
written and interprets the subset they use
([`lua/section/src/re.lua`](../lua/section/src/re.lua)): alternation, greedy and
lazy quantifiers, character classes, `^`/`$`/`\b`, lookahead, lookbehind, named
groups and backreferences. The engine is part of the port; there is no
dependency.

## 4. Scope

Ported:

- the reference grammar, canonicalisation, messages and stable codes;
- the mask pass, the language table, the tokenizer, the lexers and every
  declaration shape;
- the block scanner, the matcher precedence, the sibling-first walk, the
  modifiers, envelopes, regions, condition literals and anchors;
- `planSection`, `resolveSection`, `diagnose`, `deepestResolvablePrefix`,
  `extractDeclaration`;
- the jump profiles (`jump/editor`, `jump/gate`) and a small document gate
  (`jumpGate`) over marker lines, enough for the plugin and the profile corpus.

Not ported, because a port of `lib/section.mjs` and `lib/jump.mjs` does not own
them:

- the CLI, `index.mjs`, data-format rules, gitignore handling and file
  rewriting (RFC 3's document layer);
- the Zig differential harness (it compares exactly two tools, and Lua has no
  binary to compare).

`jumpGate` is deliberately the profile's smallest useful document layer: marker
lines, fenced blocks skipped, every failing reference in one pass. It is not a
claim to be `index.mjs`.

## 5. The gates

| Gate          | Command                                                                     | What it proves                                        |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Lua 5.4       | `lua lua/section/tests/run.lua`                                             | every section, lexical and profile row                |
| LuaJIT        | `luajit lua/section/tests/run.lua`                                          | the Neovim Lua version, same rows                     |
| Neovim LuaJIT | `nvim --headless -u NONE -l lua/section/tests/run.lua`                      | the host that matters                                 |
| Plugin smoke  | `nvim --headless -u NONE --cmd "set rtp+=." -l lua/md-jump/tests/smoke.lua` | a code jump, a heading anchor and the gate's quickfix |

The harness reads `test/vectors/section-vectors.json`,
`test/vectors/lexical-vectors.json` and `test/vectors/profile-vectors.json`
directly, so a corpus change reaches the Lua port without a generated copy.
Every row is asserted; a row that is neither asserted nor counted fails the
accounting check. The profile rows are asserted because the port offers a
profile; a resolver-only port may skip them (RFC 1 §6.3).

CI runs the first three and the smoke test in the `lua` job of
[.github/workflows/ci.yml](../.github/workflows/ci.yml).

## 6. Changing something after the port

The order is the one [`plans/zig-port.md`](./zig-port.md) §5 states: change the
JavaScript first, add or update the corpus row, regenerate the JavaScript
corpora (`node tools/section-vectors.mjs`, `node tools/lexical-vectors.mjs`,
`node tools/profile-vectors.mjs`), then make the same change here and run the
Lua gate beside the JavaScript, Zig, Java and Rust gates. A semantics change
that is not in the JavaScript first does not land.

## 7. The Neovim plugin

The plugin keeps `md-jump.nvim`'s keymaps and link reader and changes what is
underneath:

- `gx` / `<CR>` call `jump/editor`, and a landing that is not exact says
  `nearest`, `ambiguous` or `file-start` rather than hiding it;
- `gX` / `:MdJumpGate` reads every Markdown link (fenced code skipped),
  resolves it with the gate profile and fills the quickfix list with every
  failure, its line and its stable code;
- a `.md` target's fragment is tried as a heading first, then as a code
  reference;
- the `use_node` fallback is gone.

Install, options and keymaps are in [`lua/md-jump/README.md`](../lua/md-jump/README.md)
and `:help md-jump`.
