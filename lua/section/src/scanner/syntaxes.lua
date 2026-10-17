-- The language table, as data.
--
-- This is a direct port of `src/js/scanner/syntaxes.js`: one entry per
-- language, and the tokenizer walks it. Adding a language is one object here
-- plus one line in `lexers.lua`; no matching logic lives in this file.
--
-- A declaration descriptor's `re` is a JavaScript regular expression, kept in
-- its own spelling and interpreted by `section.src.re`, so the port cannot
-- drift from the source of truth by rewriting a pattern into Lua patterns.

local C_LINE = { '//' }
local C_BLOCK = { { open = '/*', close = '*/', nested = false } }

-- A Rust char literal: `'a'`, `'\n'`, `' '` — closed within a few characters.
local SINGLE_CHAR = {
  open = "'", close = "'", escape = 'backslash', maxSpan = 12,
  content = [=[^(?:\\.{1,10}|[^\n\\]{1,2})$]=],
}

local RUBY_DECLARATIONS = {
  {
    kind = 'method',
    re = [=[^\s*def\s+(?:self\.)?([A-Za-z_]\w*)]=],
    suffix = [=[^[?!=]$]=],
    body = 'end',
    end_word = 'end',
  },
}

local HASKELL_DECLARATIONS = {
  {
    kind = 'method',
    re = [=[^(?!(?:data|newtype|type|class|instance|module|import|infix[lr]?|foreign|deriving|default)\b)([a-z_][\w']*)\b[^=\n]*=]=],
    line = true,
  },
  {
    kind = 'class',
    re = [=[^(?:data|newtype|type|class)\s+(?:\([^)]*\)\s*=>\s*)?([A-Z][\w']*)]=],
  },
}

local HASKELL_ANNOTATIONS = { [=[^\s*[\w']+\s*::]=] }

local RUST_DECLARATIONS = {
  {
    kind = 'class',
    re = [=[^\s*impl\b[^{]*?\b([A-Za-z_][\w:]*)\s*(?:<[^>]*>)?\s*(?:where\b[^{]*)?\{]=],
  },
  {
    kind = 'property',
    re = [=[^\s*(?:pub\s+)?([A-Za-z_]\w*)\s*:]=],
    line = true,
  },
}

local VB_DECLARATIONS = {
  {
    kind = 'class',
    re = [=[^\s*(?:Public|Private|Friend|Protected)?\s*(?:NotInheritable\s+|MustInherit\s+)?(?:Class|Module|Structure)\s+(\w+)]=],
    body = 'end',
    end_word = 'End',
  },
  {
    kind = 'method',
    re = [=[^\s*[\w\s]*?\b(?:Sub|Function)\s+(\w+)]=],
    body = 'end',
    end_word = 'End',
  },
}

local KOTLIN_DECLARATIONS = {
  {
    kind = 'method',
    re = [=[^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|private|protected|internal|open|override|suspend|inline|operator|tailrec|abstract|final|external|expect|actual|infix\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?, ]+\.)?([A-Za-z_]\w*)]=],
  },
}

local JS_SYNTAX = {
  name = 'javascript',
  lineComments = C_LINE,
  blockComments = C_BLOCK,
  strings = {
    { open = '`', close = '`', escape = 'backslash', multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = 'backslash' },
  },
}

local JAVA_SYNTAX = {
  name = 'java',
  lineComments = C_LINE,
  blockComments = C_BLOCK,
  strings = {
    { open = '"""', close = '"""', escape = 'backslash', multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = 'backslash' },
  },
}

local ZIG_SYNTAX = {
  name = 'zig',
  lineComments = C_LINE,
  blockComments = { { open = '/*', close = '*/', nested = true } },
  strings = {
    { open = '\\\\', close = '', lineScoped = true },
    { open = '"', close = '"', escape = 'backslash' },
  },
}

local GO_SYNTAX = {
  name = 'go',
  lineComments = C_LINE,
  blockComments = C_BLOCK,
  strings = {
    { open = '`', close = '`', escape = false, multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    SINGLE_CHAR,
  },
}

local RUST_SYNTAX = {
  name = 'rust',
  lineComments = C_LINE,
  blockComments = { { open = '/*', close = '*/', nested = true } },
  strings = {
    { open = 'br"', close = '"', escape = false, multiline = true, boundary = true, hashes = true },
    { open = 'r"', close = '"', escape = false, multiline = true, boundary = true, hashes = true },
    { open = 'b"', close = '"', escape = 'backslash', boundary = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "b'", close = "'", escape = 'backslash', boundary = true, maxSpan = 12,
      content = [=[^(?:\\.{1,10}|[^\n\\]{1,2})$]=] },
    SINGLE_CHAR,
  },
  declarations = RUST_DECLARATIONS,
}

local PYTHON_SYNTAX = {
  name = 'python',
  lineComments = { '#' },
  blockComments = {},
  strings = {
    { open = 'r"""', close = '"""', escape = false, multiline = true, boundary = true },
    { open = "r'''", close = "'''", escape = false, multiline = true, boundary = true },
    { open = 'rb"', close = '"', escape = false, boundary = true },
    { open = "rb'", close = "'", escape = false, boundary = true },
    { open = 'br"', close = '"', escape = false, boundary = true },
    { open = "br'", close = "'", escape = false, boundary = true },
    { open = 'r"', close = '"', escape = false, boundary = true },
    { open = "r'", close = "'", escape = false, boundary = true },
    { open = '"""', close = '"""', escape = 'backslash', multiline = true },
    { open = "'''", close = "'''", escape = 'backslash', multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = 'backslash' },
  },
}

local CSHARP_SYNTAX = {
  name = 'csharp',
  lineComments = C_LINE,
  blockComments = C_BLOCK,
  strings = {
    { open = '$@"', close = '"', escape = 'doubling', multiline = true, boundary = true },
    { open = '@$"', close = '"', escape = 'doubling', multiline = true, boundary = true },
    { open = '@"', close = '"', escape = 'doubling', multiline = true, boundary = true },
    { open = '"""', close = '"""', escape = false, multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = 'backslash' },
  },
}

local KOTLIN_SYNTAX = {
  name = 'kotlin',
  lineComments = C_LINE,
  blockComments = { { open = '/*', close = '*/', nested = true } },
  strings = {
    { open = '"""', close = '"""', escape = false, multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = 'backslash' },
  },
  declarations = KOTLIN_DECLARATIONS,
}

local PHP_SYNTAX = {
  name = 'php',
  lineComments = { '//', '#' },
  blockComments = C_BLOCK,
  strings = {
    { open = '"', close = '"', escape = 'backslash', multiline = true },
    { open = "'", close = "'", escape = 'backslash', multiline = true },
  },
  heredoc = true,
}

local RUBY_SYNTAX = {
  name = 'ruby',
  lineComments = { '#' },
  blockComments = { { open = '=begin', close = '=end', lineStart = true } },
  strings = {
    { open = '"', close = '"', escape = 'backslash', multiline = true },
    { open = "'", close = "'", escape = 'backslash', multiline = true },
    { open = '`', close = '`', escape = 'backslash', multiline = true },
  },
  heredoc = 'strict',
  declarations = RUBY_DECLARATIONS,
}

local SQL_SYNTAX = {
  name = 'sql',
  lineComments = { '--' },
  blockComments = { { open = '/*', close = '*/', nested = false } },
  strings = {
    { open = '$$', close = '$$', escape = false, multiline = true },
    { open = "'", close = "'", escape = 'doubling' },
    { open = '"', close = '"', escape = 'doubling' },
    { open = '`', close = '`', escape = 'doubling' },
  },
}

local SHELL_SYNTAX = {
  name = 'shell',
  lineComments = { '#' },
  blockComments = {},
  strings = {
    { open = "'", close = "'", escape = false, multiline = true },
    { open = '"', close = '"', escape = 'backslash', multiline = true },
    { open = '`', close = '`', escape = 'backslash', multiline = true },
  },
  heredoc = true,
}

local VB_SYNTAX = {
  name = 'vb',
  lineComments = { "'" },
  blockComments = {},
  strings = { { open = '"', close = '"', escape = 'doubling' } },
  declarations = VB_DECLARATIONS,
}

local HASKELL_SYNTAX = {
  name = 'haskell',
  lineComments = { '--' },
  blockComments = { { open = '{-', close = '-}', nested = true } },
  strings = {
    { open = '"', close = '"', escape = 'backslash', multiline = true },
    { open = "'", close = "'", escape = 'backslash' },
  },
  declarations = HASKELL_DECLARATIONS,
  annotations = HASKELL_ANNOTATIONS,
}

local YAML_SYNTAX = {
  name = 'yaml',
  lineComments = { '#' },
  blockComments = {},
  strings = {
    { open = '"', close = '"', escape = 'backslash', multiline = true },
    { open = "'", close = "'", escape = 'doubling', multiline = true },
  },
}

local TOML_SYNTAX = {
  name = 'toml',
  lineComments = { '#' },
  blockComments = {},
  strings = {
    { open = '"""', close = '"""', escape = 'backslash', multiline = true },
    { open = "'''", close = "'''", escape = false, multiline = true },
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = false },
  },
}

local CSS_SYNTAX = {
  name = 'css',
  lineComments = {},
  blockComments = C_BLOCK,
  strings = {
    { open = '"', close = '"', escape = 'backslash' },
    { open = "'", close = "'", escape = 'backslash' },
  },
}

local INI_SYNTAX = {
  name = 'ini',
  lineComments = { ';', '#' },
  blockComments = {},
  strings = {
    { open = '"', close = '"', escape = false },
    { open = "'", close = "'", escape = false },
  },
}

local SYNTAXES = {
  javascript = JS_SYNTAX,
  typescript = { name = 'typescript', lineComments = JS_SYNTAX.lineComments,
    blockComments = JS_SYNTAX.blockComments, strings = JS_SYNTAX.strings },
  java = JAVA_SYNTAX,
  zig = ZIG_SYNTAX,
  go = GO_SYNTAX,
  rust = RUST_SYNTAX,
  python = PYTHON_SYNTAX,
  csharp = CSHARP_SYNTAX,
  kotlin = KOTLIN_SYNTAX,
  php = PHP_SYNTAX,
  ruby = RUBY_SYNTAX,
  sql = SQL_SYNTAX,
  shell = SHELL_SYNTAX,
  vb = VB_SYNTAX,
  haskell = HASKELL_SYNTAX,
  yaml = YAML_SYNTAX,
  toml = TOML_SYNTAX,
  ini = INI_SYNTAX,
  css = CSS_SYNTAX,
}

return {
  SYNTAXES = SYNTAXES,
  JS_SYNTAX = JS_SYNTAX,
  JAVA_SYNTAX = JAVA_SYNTAX,
  ZIG_SYNTAX = ZIG_SYNTAX,
}
