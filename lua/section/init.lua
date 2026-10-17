-- `section` — the Lua implementation of `lib/section.mjs`.
--
-- Public surface, shaped like the JavaScript module: parse a reference, scan a
-- source into blocks, resolve it to text and a plan, or ask a best-effort host's
-- question without throwing. Text in, text out; no filesystem, no editor types.

local U = require('section.src.units')
local parser = require('section.src.parser')
local mask = require('section.src.mask')
local scan = require('section.src.scan')
local resolver = require('section.src.resolver')
local errors = require('section.src.errors')
local lexers = require('section.src.scanner.lexers')

local M = {}

M.ERROR_CODES = errors.ERROR_CODES
M.SectionReferenceError = errors.SectionReferenceError

local function as_units(value)
  if type(value) == 'table' then return value end
  return U.from(value)
end

--- `text` with comments and strings blanked, as a Lua (UTF-8) string.
function M.masked(value)
  return U.to(mask.masked(as_units(value)))
end

--- Comment spans of `text`, delimiters stripped.
function M.comments_in(value)
  return mask.comments_in(as_units(value))
end

function M.parse_selectors(raw)
  return parser.parse_selectors(raw)
end

function M.parse_reference(raw)
  return parser.parse_reference(raw)
end

function M.is_single_segment(reference)
  return parser.is_single_segment(reference)
end

function M.final_segment(reference)
  return parser.final_segment(reference)
end

function M.scan_blocks(value, path, lexer)
  return scan.scan_blocks(as_units(value), path, lexer)
end

function M.plan_section(value, reference, lexer)
  return resolver.plan_section(as_units(value), reference, lexer)
end

function M.resolve_section(value, reference, lexer)
  return resolver.resolve_section(as_units(value), reference, lexer)
end

function M.diagnose(value, reference, lexer)
  return resolver.diagnose(as_units(value), reference, lexer)
end

function M.deepest_resolvable_prefix(value, reference, lexer)
  return resolver.deepest_resolvable_prefix(as_units(value), reference, lexer)
end

function M.extract_declaration(value, name, scope)
  return resolver.extract_declaration(as_units(value), name, scope)
end

--- The per-type lexer for a path, or nil for an unknown type.
function M.lexer_for(path)
  return lexers.lexer_for(path)
end

M.units = U

return M
