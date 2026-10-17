-- The reference grammar, ported from `lib/section.mjs`.
--
-- A reference is one or more comma-separated selectors; each is a `/`-separated
-- path (a modifier is a whole last segment) or a line range. Canonicalisation,
-- the exact messages and the stable codes are part of the contract, so this
-- module mirrors the JavaScript branch for branch.

local U = require('section.src.units')
local re = require('section.src.re')
local errors = require('section.src.errors')

local ERROR_CODES = errors.ERROR_CODES

local M = {}

local NAME = re.compile([=[^[\w.$!?-]+$]=])
local MODIFIER_RUN = re.compile([=[^[-+]{2,}$]=])
local LINE_RANGE_FULL = re.compile([=[^L(\d+)(?::(\d+))?(?:-L(\d+)(?::(\d+))?)?$]=])
local LINE_RANGE_PREFIX = re.compile([=[^L\d]=])
local FIRST_CHAR = re.compile([=[^[\w$/+-]]=])

local function text(units)
  return U.to(units)
end

local function trim(text_value)
  return text_value:match('^%s*(.-)%s*$')
end

local function split(text_value, separator)
  local out = {}
  local start = 1
  while true do
    local at = text_value:find(separator, start, true)
    if not at then
      out[#out + 1] = text_value:sub(start)
      break
    end
    out[#out + 1] = text_value:sub(start, at - 1)
    start = at + #separator
  end
  return out
end

local function is_digit(char)
  return char ~= nil and char >= '0' and char <= '9'
end

local function scope_from_modifier(modifier)
  if modifier == '-' then return 'body' end
  if modifier == '+' then return 'annotated' end
  if modifier == '++' then return 'documented' end
  return 'declaration'
end

local function segment_modifier(segment)
  if segment == '++' then return '++' end
  if segment == '+' then return '+' end
  if segment == '-' then return '-' end
  return nil
end

local function envelope_mark(segment)
  if segment == '^' or segment == '$' then return segment end
  return nil
end

local function envelope_of(segments)
  if #segments < 2 then return nil end
  local mark = envelope_mark(segments[#segments])
  if mark == nil then return nil end
  local parent = {}
  for i = 1, #segments - 1 do parent[i] = segments[i] end
  return { mark = mark, parent = parent }
end

local function assert_name(segment, raw, carries_mark)
  if re.test(NAME, U.from(segment)) then return end
  if carries_mark and envelope_mark(segment) ~= nil then return end
  local first, last = segment:find('%++')
  if first then
    local plus = segment:sub(first, last)
    local before = segment:sub(1, first - 1)
    local message
    if before == '' then
      message = string.format('"%s" is a path segment now; it follows the path, as "#<path>/%s"', plus, plus)
    else
      message = string.format('"%s" is a path segment now; write "#%s/%s"', plus, before, plus)
    end
    errors.raise(errors.grammar_error(ERROR_CODES.MODIFIER_OLD_SPELLING, message, segment))
  end
  errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_SEGMENT,
    string.format('"#%s" names nothing', raw), segment))
end

local function merge_modifiers(modifiers, raw)
  if #modifiers == 0 then return nil end
  if #modifiers == 1 then return modifiers[1] end
  errors.raise(errors.grammar_error(ERROR_CODES.TOO_MANY_MODIFIERS,
    string.format('"#%s" carries more than one modifier', raw)))
end

--- `L<point>` / `L<point>-L<point>`, and nothing else.
local function split_range_modifier(raw)
  local at = 1
  for endpoint = 1, 2 do
    if endpoint == 2 then
      if raw:sub(at, at) ~= '-' then return nil end
      at = at + 1
    end
    if raw:sub(at, at) ~= 'L' or not is_digit(raw:sub(at + 1, at + 1)) then return nil end
    at = at + 2
    while is_digit(raw:sub(at, at)) do at = at + 1 end
    if raw:sub(at, at) == ':' then
      if not is_digit(raw:sub(at + 1, at + 1)) then return nil end
      at = at + 2
      while is_digit(raw:sub(at, at)) do at = at + 1 end
    end
    if raw:sub(at, at) == '-' then
      -- A second `-` starts the range's other end.
    else
      break
    end
  end
  if at == #raw + 1 then return { core = raw } end
  return nil
end

local function line_range_of(raw)
  if not re.test(LINE_RANGE_PREFIX, U.from(raw)) then return nil end
  local function malformed()
    return errors.grammar_error(ERROR_CODES.LINE_RANGE_NOT_A_RANGE,
      string.format('"#%s" is not a line range; write L<line> or L<line>:<column>', raw), raw)
  end
  local split_value = split_range_modifier(raw)
  if split_value == nil then errors.raise(malformed()) end
  local units = U.from(split_value.core)
  local match = re.exec(LINE_RANGE_FULL, units, 0)
  if not match then errors.raise(malformed()) end

  local function point(index, column_index)
    local line = tonumber(text(re.group(units, match, index)))
    local column = nil
    if match.captures[column_index] then
      column = tonumber(text(re.group(units, match, column_index)))
    end
    return { line = line, column = column }
  end
  local from = point(1, 2)
  local to = match.captures[3] and point(3, 4) or nil

  local function zero(at)
    return at.line < 1 or (at.column ~= nil and at.column < 1)
  end
  if zero(from) or (to ~= nil and zero(to)) then
    errors.raise(errors.grammar_error(ERROR_CODES.LINE_RANGE_FROM_1,
      string.format('"#%s" counts lines and columns from 1', raw), raw))
  end
  if to ~= nil then
    local backwards = to.line < from.line
      or (to.line == from.line and to.column ~= nil and from.column ~= nil and to.column < from.column)
    if backwards then
      errors.raise(errors.grammar_error(ERROR_CODES.LINE_RANGE_BACKWARDS,
        string.format('"#%s" ends before it starts', raw), raw))
    end
  end
  return { from = from, to = to }
end

--- Read one path selector; throws on a comma, a line range and a grammar error.
function M.parse_reference(raw)
  if raw == '' then
    errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_REFERENCE, '"#" names nothing'))
  end
  if raw:find(',', 1, true) then
    errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_SELECTOR,
      string.format('"#%s" has an empty selector', raw), raw))
  end
  if raw:find('#', 1, true) then
    errors.raise(errors.grammar_error(ERROR_CODES.SECOND_HASH,
      string.format('"#%s" has a second "#"; a reference names one file', raw), raw))
  end
  if re.test(LINE_RANGE_PREFIX, U.from(raw)) then
    line_range_of(raw)
    errors.raise(errors.grammar_error(ERROR_CODES.LINE_RANGE_AS_PATH,
      string.format('"#%s" is a line range, not a section path', raw), raw))
  end

  local parts = split(raw, '/')
  for _, part in ipairs(parts) do
    if part == '' then
      errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_SEGMENT,
        string.format('"#%s" has an empty path segment', raw), raw))
    end
  end
  if #parts > 8 then
    errors.raise(errors.grammar_error(ERROR_CODES.TOO_DEEP,
      string.format('"#%s" is deeper than 8 sections', raw), raw))
  end

  local modifiers = {}
  local names = {}
  for index, segment in ipairs(parts) do
    local modifier = segment_modifier(segment)
    if modifier ~= nil then
      if index ~= #parts then
        errors.raise(errors.grammar_error(ERROR_CODES.MODIFIER_NOT_LAST,
          string.format('"%s" may only modify the last path segment of "#%s"', modifier, raw), segment))
      end
      modifiers[#modifiers + 1] = modifier
    elseif re.test(MODIFIER_RUN, U.from(segment)) and segment ~= '--' then
      errors.raise(errors.grammar_error(ERROR_CODES.TOO_MANY_MODIFIERS,
        string.format('"#%s" carries more than one modifier', raw), segment))
    else
      assert_name(segment, raw, index == #parts)
      names[#names + 1] = segment
    end
  end

  if #names == 0 then
    local why
    local code
    if segment_modifier(raw) == nil then
      why = string.format('"#%s" carries more than one modifier', raw)
      code = ERROR_CODES.TOO_MANY_MODIFIERS
    else
      why = string.format('"#%s" names nothing', raw)
      code = ERROR_CODES.EMPTY_SEGMENT
    end
    errors.raise(errors.grammar_error(code, why, raw))
  end

  local merged = merge_modifiers(modifiers, raw)
  local scope = scope_from_modifier(merged)
  local canonical = table.concat(names, '/') .. (merged == nil and '' or '/' .. merged)
  return { raw = raw, canonical = canonical, segments = names, selectors = nil, scope = scope }
end

--- Read a whole reference as its selectors.
function M.parse_selectors(raw)
  if raw == '' then
    errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_REFERENCE, '"#" names nothing'))
  end
  local parts = split(raw, ',')
  for _, part in ipairs(parts) do
    if trim(part) == '' then
      errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_SELECTOR,
        string.format('"#%s" has an empty selector', raw), raw))
    end
  end

  local selectors = {}
  local canonical_parts = {}

  for _, part in ipairs(parts) do
    local text_value = trim(part)
    local range = line_range_of(text_value)
    if range ~= nil then
      canonical_parts[#canonical_parts + 1] = text_value
      selectors[#selectors + 1] = { kind = 'lines', raw = text_value, from = range.from, to = range.to }
    elseif re.test(LINE_RANGE_PREFIX, U.from(text_value)) then
      errors.raise(errors.grammar_error(ERROR_CODES.LINE_RANGE_NOT_A_RANGE,
        string.format('"#%s" is not a line range; write L<line> or L<line>:<column>', text_value), text_value))
    else
      local bare = envelope_mark(text_value)
      if bare ~= nil then
        canonical_parts[#canonical_parts + 1] = text_value
        selectors[#selectors + 1] = {
          kind = 'path', raw = text_value, segments = { text_value }, scope = 'declaration',
          envelope = { mark = bare, parent = nil },
        }
      elseif not re.test(FIRST_CHAR, U.from(text_value)) then
        errors.raise(errors.grammar_error(ERROR_CODES.EMPTY_SEGMENT,
          string.format('"#%s" names nothing', text_value), text_value))
      else
        local parsed = M.parse_reference(text_value)
        canonical_parts[#canonical_parts + 1] = parsed.canonical
        selectors[#selectors + 1] = {
          kind = 'path', raw = text_value, segments = parsed.segments, scope = parsed.scope,
          envelope = envelope_of(parsed.segments),
        }
      end
    end
  end

  M.apply_envelope(selectors, raw)

  local canonical = table.concat(canonical_parts, ',')
  local sole = #selectors == 1 and selectors[1] or nil
  return {
    raw = raw,
    canonical = canonical,
    selectors = selectors,
    segments = (sole ~= nil and sole.kind == 'path') and sole.segments or {},
    scope = (sole ~= nil and sole.kind == 'path') and sole.scope or 'declaration',
  }
end

--- Read a reference's envelope as a unit, validating the pair.
function M.apply_envelope(selectors, raw)
  local has_envelope = false
  for _, selector in ipairs(selectors) do
    if selector.envelope then has_envelope = true; break end
  end
  if not has_envelope then return end

  local first = selectors[1]
  local last = selectors[#selectors]
  if #selectors == 1 then
    errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_ALONE,
      string.format('"#%s": a lone "%s" has nothing to %s', raw, first.envelope.mark,
        first.envelope.mark == '^' and 'close' or 'open'), raw))
  end
  if not first.envelope or not last.envelope
    or first.envelope.mark ~= '^' or last.envelope.mark ~= '$' then
    errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_ORDER,
      string.format('"#%s": an envelope is "^" first and "$" last, around what they open and close', raw), raw))
  end
  for index, selector in ipairs(selectors) do
    if selector.envelope and index ~= 1 and index ~= #selectors then
      errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_MARKS,
        string.format('"#%s": an envelope has one "^" and one "$"', raw), raw))
    end
  end

  local named = {}
  if first.envelope.parent ~= nil then named[#named + 1] = first.envelope.parent end
  if last.envelope.parent ~= nil then named[#named + 1] = last.envelope.parent end
  local parent = named[1] or nil
  if parent == nil then
    errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_NO_BLOCK,
      string.format('"#%s": neither "^" nor "$" names a block, so there is nothing to open or close', raw), raw))
  end
  for index = 2, #named do
    if table.concat(named[index], '/') ~= table.concat(parent, '/') then
      errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_MISMATCH,
        string.format('"#%s": "^" opens "%s" and "$" closes "%s"; they must be the same block',
          raw, table.concat(parent, '/'), table.concat(named[index], '/')), raw))
    end
  end

  first.envelope.parent = parent
  last.envelope.parent = parent

  for index = 2, #selectors - 1 do
    local selector = selectors[index]
    if selector.kind == 'path' then
      local prefixed = true
      for offset, segment in ipairs(parent) do
        if selector.segments[offset] ~= segment then prefixed = false; break end
      end
      if not prefixed then
        local replacement = {}
        for _, segment in ipairs(parent) do replacement[#replacement + 1] = segment end
        for _, segment in ipairs(selector.segments) do replacement[#replacement + 1] = segment end
        selector.segments = replacement
        selector.raw = table.concat(replacement, '/')
      end
    end
  end
end

function M.is_single_segment(reference)
  if type(reference) == 'string' then
    return #M.parse_reference(reference).segments == 1
  end
  return #reference.segments == 1
end

function M.final_segment(reference)
  if type(reference) == 'string' then reference = M.parse_reference(reference) end
  return reference.segments[#reference.segments]
end

M.line_range_of = line_range_of
M.split_range_modifier = split_range_modifier
M.scope_from_modifier = scope_from_modifier
M.segment_modifier = segment_modifier
M.envelope_mark = envelope_mark
M.envelope_of = envelope_of

return M
