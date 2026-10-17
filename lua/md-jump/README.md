# md-jump.nvim

Jump to Markdown links in Neovim with full
[inject-examples](https://github.com/hrgdavor/inject-examples) compatibility.

The original md-jump.nvim is vendored here: same keymaps, same link reader,
same `gx` / `<CR>` / `gX` layout. The difference is underneath — it now calls
the pure-Lua [section resolver](../section/README.md) instead of a second,
approximate Lua implementation or a Node process. A `#fragment` is resolved
with the same rules, messages and causes as `lib/section.mjs`, so the plugin
needs no `@hrg/inject-examples` install.

## Features

- `gx` / `<CR>` in a Markdown buffer jumps to the link under the cursor.
- `#ref` is a **code jump**: `Cart/Line/render`, `Cart/Line/render/++`,
  `L10-L20`, `L13:9-L13:21`, a `#region` name, a declaration, a condition
  literal or a comment anchor.
- A Markdown target's `#fragment` is tried as a **heading** first, then as a
  code reference.
- The whole jump policy of `lib/jump.mjs`: `resolved`, `nearest`, `ambiguous`
  and `file-start`, and the diagnosis behind every landing line.
- `gX` (or `:MdJumpGate`) checks every Markdown link in the document in one
  pass (fenced code skipped) and fills the quickfix list with each failure, its
  line and its stable code.
- External URLs via `vim.ui.open`.
- Pure Lua, zero dependencies, and no Node fallback.

## Install

The repository root is the plugin: `lua/md-jump/`, `lua/section/`,
`plugin/md-jump.lua` and `doc/md-jump.txt` are all where Neovim expects them.

### lazy.nvim

```lua
{
  "hrgdavor/inject-examples",
  ft = "markdown",
  config = function()
    require("md-jump").setup()
  end,
}
```

`ft = "markdown"` is enough: the plugin creates its buffer-local maps when the
filetype is set. If you install only the plugin directory, keep `lua/section`
beside it — the plugin's first line is `require("section")`.

### Manual

```sh
git clone https://github.com/hrgdavor/inject-examples
```

Then, in `init.lua`:

```lua
vim.opt.runtimepath:append("/path/to/inject-examples")
require("md-jump").setup()
```

Or from a running Neovim:

```vim
:set runtimepath+=/path/to/inject-examples
:lua require("md-jump").setup()
```

`:helptags doc` (or `:helptags ALL`) makes `:help md-jump` available.

## Setup

```lua
require("md-jump").setup({
  default_profile = "jump/editor", -- or "jump/gate"
  keymaps = true,
  external_opener = nil,           -- default: vim.ui.open
})
```

| Option            | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `default_profile` | `jump/editor` lands usefully and says how; `jump/gate` refuses anything not exact |
| `keymaps`         | Create the buffer-local `gx`, `<CR>` and `gX` maps (default `true`)               |
| `external_opener` | A function called with an external URL; defaults to `vim.ui.open`                 |

## Usage

In a Markdown buffer:

| Key    | Command          | What it does                                              |
| ------ | ---------------- | --------------------------------------------------------- |
| `gx`   | `:MdJump`        | Jump to the link under the cursor                         |
| `<CR>` | `:MdJump`        | The same                                                  |
| `gX`   | `:MdJumpGate`    | Resolve every link in the buffer; quickfix on failure     |

Supported links:

```markdown
[label](./file.md)
[label](./file.md#heading)
[label](./src/Cart.java#Cart/Line/render)
[label](./main.go#L10-L20)
[label](./Cart.java#L13:9-L13:21)
[label](./Cart.java#Cart/Line/render/++)
[label](./Cart.java#Cart/^,toString,$)
```

A landing line that is not exact is reported rather than hidden:

- `nearest` — the deepest prefix that still resolves (a renamed member lands
  on its enclosing block);
- `ambiguous` — the name of a member several blocks answer to, with the
  candidates in the diagnosis;
- `file-start` — the file is the right place, the reference is not found.

`gX` is strict: every link in the buffer is read, and every failure is
reported, each with its line and stable code (`resolution/not-found`,
`grammar/line-range-not-a-range`, …). Fenced code is skipped, because a code
sample is not navigation; a Markdown heading the document owns is not a failure.
The quickfix list's text includes the code so a CI-style review can grep it.

## What changed from md-jump.nvim

- The Node fallback (`use_node`) is removed. The Lua resolver is the
  implementation, so there is no `@hrg/inject-examples` dependency and no
  process to spawn.
- The naive `lua_jump` approximation is gone: names, paths, scopes,
  modifiers, envelopes, regions, condition literals and anchors all use the
  ported resolver and the same corpus the JavaScript suite uses.
- Heading anchors are kept for Markdown targets (the original plugin had them
  in its own reader); code references are resolved first for non-Markdown
  targets.
- `gate()` now uses the jump gate, reports **every** failing link, and puts the
  line numbers and codes in the quickfix list.

## License

MIT
