-- The built-in mask pass, ported from `lib/section.mjs`.
--
-- This is the language-agnostic union used when no file-type lexer is supplied:
-- `//`, `/* */`, `#` (but not `#[`), `"`, `'` and backtick strings, with a
-- triple-quote form. It is also the default lexer's `mask` and `comments`.

local U = require('section.src.units')

local M = {}

local function fail(code, message)
  local error_value = { code = code, message = message }
  error(error_value, 0)
end

local function end_of_line(units, offset)
  local at = U.indexOf(units, '\n', offset)
  if at == -1 then return #units end
  return at
end

local function blank(out, from, to)
  for i = from + 1, math.min(to, #out) do
    if out[i] ~= 10 then out[i] = 32 end
  end
end

local function string_at(units, i)
  local char = units[i + 1]
  if char ~= 34 and char ~= 39 and char ~= 96 then return nil end
  local quote = { char }
  if units[i + 2] == char and units[i + 3] == char then quote = { char, char, char } end
  local j = i + #quote
  while j < #units do
    if units[j + 1] == 92 then
      j = j + 2
    elseif U.startsWith(units, quote, j) then
      j = j + #quote
      break
    else
      j = j + 1
    end
  end
  return math.min(j, #units)
end

--- Comments and string literals blanked to spaces, newlines kept.
function M.masked(units)
  local out = {}
  for i = 1, #units do out[i] = units[i] end
  local i = 0
  while i < #units do
    local char = units[i + 1]
    local next_char = units[i + 2]
    if char == 47 and next_char == 47 then
      local finish = end_of_line(units, i)
      blank(out, i, finish)
      i = finish
    elseif char == 47 and next_char == 42 then
      local close = U.indexOf(units, '*/', i + 2)
      local finish = close == -1 and #units or close + 2
      blank(out, i, finish)
      i = finish
    elseif char == 35 and next_char ~= 91 then
      local finish = end_of_line(units, i)
      blank(out, i, finish)
      i = finish
    else
      local finish = string_at(units, i)
      if finish then
        blank(out, i, finish)
        i = finish
      else
        i = i + 1
      end
    end
  end

  if #out ~= #units then
    fail('resolution/lexer-mask', 'masked length mismatch')
  end
  for k = 0, #units - 1 do
    if units[k + 1] == 10 and out[k + 1] ~= 10 then
      fail('resolution/lexer-mask', 'newline offset mismatch')
    end
  end
  return out
end

--- Comment-only spans: `{ text, from, to }`, delimiters stripped.
function M.comments_in(units)
  local result = {}
  local i = 0
  while i < #units do
    local char = units[i + 1]
    local next_char = units[i + 2]
    if char == 47 and next_char == 47 then
      local finish = end_of_line(units, i)
      result[#result + 1] = { text = U.slice(units, i + 2, finish), from = i, to = finish }
      i = finish
    elseif char == 47 and next_char == 42 then
      local close = U.indexOf(units, '*/', i + 2)
      local finish = close == -1 and #units or close + 2
      local body_end = close == -1 and finish or close
      result[#result + 1] = { text = U.slice(units, i + 2, body_end), from = i, to = finish }
      i = finish
    else
      local finish = string_at(units, i)
      if finish then i = finish else i = i + 1 end
    end
  end
  return result
end

return M
