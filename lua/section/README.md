# `lua/section` — the Lua implementation

A pure-Lua implementation of the file-section matcher: it resolves a
`#<reference>` against the text of a file, the way
[`lib/section.mjs`](../../lib/section.mjs) does.
[doc/section-matching.md](../../doc/section-matching.md) is the normative
specification, and the JavaScript is the source of truth — **a port mirrors, it
does not lead** ([plans/zig-port.md](../../plans/zig-port.md) §2), so a
disagreement here is a bug here.

It exists for the hosts that cannot import an ES module and do not want a
sidecar: Neovim (LuaJIT), a plain Lua script, or an embedded Lua in another
program. The [Neovim plugin](../md-jump/README.md) in this repository is the
first consumer. The port's goals, decisions and gates are in
[plans/lua-port.md](../../plans/lua-port.md).

## Status

| Layer                                                                              | State                                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Reference parsing, canonicalisation, exact messages and stable codes               | **ported** — every grammar vector, including the one row the corpus marks `"parser": "path"`        |
| Mask pass (`masked`, `commentsIn`) and the lexer seam                              | **ported** — pinned by every mask row, over every lexer entry                                       |
| Per-language tokenizer and table                                                   | **ported** — all nineteen entries and the extension registry                                        |
| Declaration shapes (`declarations`)                                                | **ported** — pinned by every shape row, including Kotlin `fun` and Ruby suffixes                    |
| Block scanner (`scanBlocks`)                                                       | **ported** — the block model, span readers, regions, anchors, condition literals, enum constants, variable declarations |
| Resolution (`planSection`, `resolveSection`, `extractDeclaration`)                 | **ported** — all 310 section vectors: text, `startLine`/`endLine`, `ranges`, `kind`, error and code |
| Envelopes (`Inventory/^,toString,$`)                                               | **ported** — whole-segment marks, parent retry and the three pieces                                 |
| Code-jump profile (`jump`, `jumpGate`)                                             | **ported** — editor and gate profiles, every profile vector                                         |

The gate is green:

```sh
lua lua/section/tests/run.lua        # Lua 5.4
luajit lua/section/tests/run.lua     # LuaJIT
nvim -l lua/section/tests/run.lua    # the Neovim LuaJIT
# lua section: 310 section rows, 46 masks, 53 shapes, 10 profile rows — all matching
```

The harness reads [`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json),
[`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json)
and [`test/vectors/profile-vectors.json`](../../test/vectors/profile-vectors.json)
**directly**, from the repository, so a corpus change reaches every port at
once. It fails if a row is neither asserted nor counted.

## Use it

Put `lua/` on `package.path` (or the repository root on Neovim's
`runtimepath`), then:

```lua
local section = require('section')

local text = section.resolve_section(source, 'Cart/Line/render/-', section.lexer_for('Cart.java'))
local plan = section.plan_section(source, 'L12-L14')
-- plan.text, plan.startLine, plan.endLine, plan.ranges, plan.kind

local answer = section.diagnose(source, 'Cart/Line/renderr')
-- answer.status ('ok' | 'failed' | 'invalid'), answer.firstLine, answer.code,
-- answer.selector, answer.scope, answer.candidates, answer.advice
```

The export names mirror the JavaScript module: `parse_selectors`,
`parse_reference`, `resolve_section`, `plan_section`, `diagnose`,
`deepest_resolvable_prefix`, `scan_blocks`, `extract_declaration`, `masked`,
`comments_in`, `is_single_segment`, `final_segment`, `ERROR_CODES` and
`lexer_for`.

A failure is a Lua table, not a string, so a caller reads the contract fields
rather than matching prose:

```lua
local ok, failure = pcall(section.plan_section, source, 'nope', lexer)
if not ok then
  print(failure.message, failure.code)   -- 'no "#region nope" …', 'resolution/not-found'
end
```

The jump profile has the same two readings as `lib/jump.mjs`:

```lua
local jump = require('section.src.jump')

local landed = jump.jump(source, 'Cart/Line/renderr', { lexer = lexer, profile = 'jump/editor' })
-- landed.ok, landed.target.firstLine, landed.target.cause  ('resolved' | 'nearest' | …)

local refused = jump.jump(source, 'Cart/Line/renderr', { lexer = lexer, profile = 'jump/gate' })
-- refused.ok == false, refused.failure.code
```

`jump.jump_gate(documentText, { readFile = fn, lexerFor = section.lexer_for })`
resolves every marker line in a Markdown document and returns
`{ passed, checked, failures }`, each failure naming its `line`, `reference`,
`message`, `code`, `selector` and `scope`. It is the smallest useful document
layer: markers, fences and every failing reference in one pass. It is not the
full `index.mjs` document engine — no gitignore, no injection, no rewriting.

## Boundary

- **No dependencies.** The regular-expression engine
  ([`src/re.lua`](./src/re.lua)) is part of the port; the language table is data.
- **Pure.** Text in, text out; no filesystem, no environment, no editor types,
  no CLI.
- **UTF-16 offsets.** Every offset counts UTF-16 code units, as JavaScript does
  and as the Rust port does, so a mask preserves length and every newline
  offset even through an astral-plane character. Lua strings are UTF-8 at the
  API edge; [`src/units.lua`](./src/units.lua) is the bridge.
- **Patterns, not approximations.** The resolver and tokenizer are defined by
  JavaScript regular expressions, so the port keeps the patterns as written and
  interprets the subset they use: alternation, greedy and lazy quantifiers,
  character classes, `\b`, lookahead, lookbehind, named groups and
  backreferences. Translating them into Lua patterns would be a second
  specification.

## The Neovim plugin

The repository root is also a Neovim plugin:
[`lua/md-jump`](../md-jump/README.md) and
[`plugin/md-jump.lua`](../../plugin/md-jump.lua) read `gx` / `<CR>` links and
`gX` gates a document, using this resolver instead of a Node fallback. The
plugin's help is [`doc/md-jump.txt`](../../doc/md-jump.txt).

## Layout

| File                                                       | Mirrors                                            |
| ---------------------------------------------------------- | -------------------------------------------------- |
| [`init.lua`](./init.lua)                                   | the public surface of `lib/section.mjs`            |
| [`src/parser.lua`](./src/parser.lua)                       | reference parsing and envelopes                    |
| [`src/mask.lua`](./src/mask.lua)                           | the built-in mask pass                             |
| [`src/scan.lua`](./src/scan.lua)                           | `makeLex` and `scanBlocks`                         |
| [`src/scanner.lua`](./src/scanner.lua)                     | the block scanner and matchers                     |
| [`src/resolver.lua`](./src/resolver.lua)                   | matcher precedence, the walk, rendering, envelopes |
| [`src/jump.lua`](./src/jump.lua)                           | `lib/jump.mjs` (profiles and the document gate)    |
| [`src/scanner/syntaxes.lua`](./src/scanner/syntaxes.lua)   | `src/js/scanner/syntaxes.js`                       |
| [`src/scanner/tokenizer.lua`](./src/scanner/tokenizer.lua) | `src/js/scanner/tokenizer.js`                      |
| [`src/scanner/lexers.lua`](./src/scanner/lexers.lua)       | `src/js/scanner/lexers.js`                         |
| [`src/units.lua`](./src/units.lua)                         | the UTF-16 runtime JavaScript gets for free        |
| [`src/re.lua`](./src/re.lua)                               | the JavaScript regex subset the source uses        |
| [`tests/run.lua`](./tests/run.lua)                         | the corpus gate                                    |
