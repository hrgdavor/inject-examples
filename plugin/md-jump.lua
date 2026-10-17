-- Keep the plugin from loading twice when a runtimepath has both the repo and
-- a copy of the plugin directory.
if vim.g.loaded_md_jump then return end
vim.g.loaded_md_jump = 1
