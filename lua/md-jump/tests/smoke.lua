-- The Neovim plugin smoke test.
--
-- Run with the repository root on the runtimepath:
--
--   nvim --headless -u NONE --cmd "set rtp+=." -l lua/md-jump/tests/smoke.lua
--
-- It creates its target files under `.tmp/` (gitignored), checks a code jump, a
-- heading anchor and the gate's quickfix list, and exits 0 only when all three
-- work. This is the one layer the plain Lua gate cannot reach (`vim.api`).

local root = vim.fn.getcwd()
local md = require('md-jump')
md.setup({ keymaps = false })

local dir = root .. '/.tmp/md-jump-smoke'
vim.fn.delete(dir, 'rf')
vim.fn.mkdir(dir, 'p')

local target = dir .. '/Cart.java'
local doc = dir .. '/doc.md'
local function write(path, text)
  local file = assert(io.open(path, 'wb'))
  file:write(text)
  file:close()
end
write(target, 'public class Cart {\n    public String render() {\n        return "x";\n    }\n}\n')
write(doc, '[Cart.java#render](./Cart.java#render)\n')

vim.cmd('edit ' .. vim.fn.fnameescape(doc))
vim.api.nvim_buf_set_lines(0, 0, -1, false, { '[Cart.java#render](./Cart.java#render)' })
vim.api.nvim_win_set_cursor(0, { 1, 10 })
md.jump()
local line = vim.api.nvim_win_get_cursor(0)[1]
local name = vim.api.nvim_buf_get_name(0)
assert(vim.fn.fnamemodify(name, ':t') == 'Cart.java', 'jump opened the wrong file')
assert(line == 2, 'jump landed on line ' .. line .. ', want 2')

-- A heading anchor on a Markdown target.
write(doc, '# Usage\n\n[Usage](#usage)\n')
vim.cmd('edit! ' .. vim.fn.fnameescape(doc))
vim.api.nvim_buf_set_lines(0, 0, -1, false, { '# Usage', '', '[Usage](#usage)' })
vim.api.nvim_win_set_cursor(0, { 3, 10 })
md.jump()
assert(vim.api.nvim_win_get_cursor(0)[1] == 1, 'heading jump failed')

-- The gate reports every broken reference, with its line and code.
write(doc, '# Broken\n\n[Cart.java#missing](./Cart.java#missing)\n\n[Cart.java#L99](./Cart.java#L99)\n')
vim.cmd('edit! ' .. vim.fn.fnameescape(doc))
vim.api.nvim_buf_set_lines(0, 0, -1, false, {
  '# Broken', '', '[Cart.java#missing](./Cart.java#missing)', '', '[Cart.java#L99](./Cart.java#L99)',
})
md.gate()
local items = vim.fn.getqflist()
assert(#items == 2, 'gate reported ' .. #items .. ' failures, want 2')
assert(items[1].lnum == 3 and items[2].lnum == 5, 'gate line numbers are wrong')
assert(items[1].text:find('resolution/not-found', 1, true), 'gate lost the first code')
assert(items[2].text:find('resolution/line-range-past-end', 1, true), 'gate lost the second code')

print('md-jump smoke: jump, heading and gate all ok')
os.exit(0)
