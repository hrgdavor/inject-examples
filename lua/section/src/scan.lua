-- The lexical facts a scan needs and the top-level block scan.
--
-- `makeLex` mirrors `lib/section.mjs`: it builds line starts, the mask, the mask
-- lines and the comment spans once, and asserts the mask invariant for a
-- supplied lexer so a broken engine fails loudly.

local U = require('section.src.units')
local mask = require('section.src.mask')
local scanner = require('section.src.scanner')
local errors = require('section.src.errors')

local M = {}

M.DEFAULT_LEXER = { name = 'default', mask = mask.masked, comments = mask.comments_in }

local function normalize_newlines(source)
  local out = {}
  local i = 1
  while i <= #source do
    local unit = source[i]
    if unit == 13 and source[i + 1] == 10 then
      -- drop the CR of a CRLF pair
    else
      out[#out + 1] = unit
    end
    i = i + 1
  end
  return out
end

local function make_lex(source, lexer)
  local L = lexer or M.DEFAULT_LEXER
  local lines = U.split(source, '\n')
  local starts = {}
  local offset = 0
  for _, line in ipairs(lines) do
    starts[#starts + 1] = offset
    offset = offset + #line + 1
  end

  local who = string.format('lexer "%s"', L.name or 'anonymous')
  local masked = L.mask(source)
  if #masked ~= #source then
    errors.raise(errors.coded_error(errors.ERROR_CODES.LEXER_MASK,
      string.format('%s mask must preserve length (%d != %d)', who, #masked, #source)))
  end
  for i = 0, #source - 1 do
    if source[i + 1] == 10 and masked[i + 1] ~= 10 then
      errors.raise(errors.coded_error(errors.ERROR_CODES.LEXER_MASK,
        string.format('%s mask must preserve every newline offset (broken at %d)', who, i)))
    end
  end
  local mask_lines = U.split(masked, '\n')
  local comments = L.comments(source)

  return {
    source = source,
    lines = lines,
    starts = starts,
    mask = masked,
    maskLines = mask_lines,
    comments = comments,
    conditionLiterals = L.conditionLiterals or scanner.condition_literals,
    declarations = L.declarations,
    annotationLine = L.annotationLine,
  }
end

M.make_lex = make_lex

--- Scan a source for blocks: the block tree plus regions, condition literals
--- and comment anchors, ready for the resolver.
function M.scan_blocks(text, path, lexer)
  local source
  if type(text) == 'table' then
    source = normalize_newlines(text)
  else
    source = normalize_newlines(U.from(text))
  end
  local lex = make_lex(source, lexer)
  local lines = lex.lines
  local blocks = {}
  local anchors = {}

  local root = scanner.make_block('root', nil, -1)
  local top = scanner.build_scope(root, 0, #lines - 1, lex, blocks)
  for _, child in ipairs(top) do
    root.children[#root.children + 1] = child
    child.parent = root
    child.scope = root
  end

  local regions = scanner.pair_regions(lines)
  for _, region in ipairs(regions) do
    region.line = region.startLine
    region.kind = 'region'
    region.scope = root
    root.regions[#root.regions + 1] = region
  end
  for _, block in ipairs(blocks) do
    if block.anchor then
      anchors[#anchors + 1] = { line = block.anchor.line, name = block.anchor.name, block = block }
    end
  end

  return { root = root, blocks = blocks, regions = regions, anchors = anchors, lex = lex }
end

return M
