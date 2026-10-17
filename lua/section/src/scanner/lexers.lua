-- The extension → lexer registry, a port of `src/js/scanner/lexers.js`.
--
-- An extension with no entry returns nil, and the resolver then uses its
-- built-in default engine, exactly as the JavaScript does.

local tokenizer = require('section.src.scanner.tokenizer')
local syntaxes = require('section.src.scanner.syntaxes')

local M = {}

local EXTENSIONS = {
  js = 'javascript', mjs = 'javascript', cjs = 'javascript', jsx = 'javascript',
  ts = 'typescript', tsx = 'typescript', mts = 'typescript', cts = 'typescript',
  java = 'java',
  zig = 'zig',
  go = 'go',
  rs = 'rust',
  py = 'python', pyi = 'python',
  cs = 'csharp',
  kt = 'kotlin', kts = 'kotlin',
  php = 'php', phtml = 'php',
  rb = 'ruby', rake = 'ruby', gemspec = 'ruby',
  sql = 'sql',
  sh = 'shell', bash = 'shell', zsh = 'shell',
  vb = 'vb', bas = 'vb', vbs = 'vb',
  hs = 'haskell', lhs = 'haskell',
  yaml = 'yaml', yml = 'yaml',
  toml = 'toml',
  ini = 'ini', cfg = 'ini', properties = 'ini',
  css = 'css',
}

local LEXERS = {}
for extension, name in pairs(EXTENSIONS) do
  LEXERS[extension] = tokenizer.make_lexer(syntaxes.SYNTAXES[name])
end

--- The lexer for `path`'s extension, or nil when the type is unknown.
function M.lexer_for(path)
  -- The position just past the last dot, mirroring `lastIndexOf('.')`; a dot
  -- at the start of the name (a hidden file) has no extension.
  local after_dot = path:match('.*%.()')
  if not after_dot or after_dot <= 2 then return nil end
  local extension = path:sub(after_dot):lower()
  return LEXERS[extension]
end

M.EXTENSIONS = EXTENSIONS
M.LEXERS = LEXERS

return M
