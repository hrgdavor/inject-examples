-- UTF-16 code units, the way JavaScript sees a string.
--
-- Every offset in `lib/section.mjs` and `src/js/scanner/tokenizer.js` counts
-- UTF-16 code units, and the Lua port mirrors that: a string is decoded once
-- into an array of unit numbers, all scanning happens on that array, and text is
-- encoded back only at the API edge. Lua has no UTF-16 type, so this module is
-- the bridge.
--
-- The functions below mirror the JavaScript string methods the port uses. They
-- are deliberately small and dependency-free (Lua 5.1 / LuaJIT compatible).

local M = {}

local floor = math.floor

local function utf8_decode_error() return 0xFFFD end

-- Decode one UTF-8 sequence at byte offset `i` (1-based). Returns the code
-- point (with Unicode replacement on malformed input) and the next byte offset.
local function decode_at(s, i)
  local b = s:byte(i)
  if b < 0x80 then return b, i + 1 end
  if b >= 0xC2 and b <= 0xDF then
    local b2 = s:byte(i + 1)
    if b2 and b2 >= 0x80 and b2 <= 0xBF then
      return (b - 0xC0) * 0x40 + (b2 - 0x80), i + 2
    end
    return 0xFFFD, i + 1
  end
  if b >= 0xE0 and b <= 0xEF then
    local b2, b3 = s:byte(i + 1), s:byte(i + 2)
    if b2 and b3 and b2 >= 0x80 and b2 <= 0xBF and b3 >= 0x80 and b3 <= 0xBF then
      local cp = (b - 0xE0) * 0x1000 + (b2 - 0x80) * 0x40 + (b3 - 0x80)
      -- Overlong forms and surrogates are invalid UTF-8.
      if cp < 0x800 or (cp >= 0xD800 and cp <= 0xDFFF) then return 0xFFFD, i + 1 end
      return cp, i + 3
    end
    return 0xFFFD, i + 1
  end
  if b >= 0xF0 and b <= 0xF4 then
    local b2, b3, b4 = s:byte(i + 1), s:byte(i + 2), s:byte(i + 3)
    if b2 and b3 and b4 and b2 >= 0x80 and b2 <= 0xBF
      and b3 >= 0x80 and b3 <= 0xBF and b4 >= 0x80 and b4 <= 0xBF then
      local cp = (b - 0xF0) * 0x40000 + (b2 - 0x80) * 0x1000 + (b3 - 0x80) * 0x40 + (b4 - 0x80)
      if cp < 0x10000 or cp > 0x10FFFF then return 0xFFFD, i + 1 end
      return cp, i + 4
    end
    return 0xFFFD, i + 1
  end
  return 0xFFFD, i + 1
end

-- Encode one code point as UTF-8. Unpaired surrogates become U+FFFD, which is
-- what the WHATWG decoder the JavaScript runtime uses does on the way out.
local function encode_cp(cp)
  if cp < 0 or cp > 0x10FFFF or (cp >= 0xD800 and cp <= 0xDFFF) then cp = 0xFFFD end
  if cp < 0x80 then return string.char(cp) end
  if cp < 0x800 then
    return string.char(0xC0 + floor(cp / 0x40), 0x80 + cp % 0x40)
  end
  if cp < 0x10000 then
    return string.char(0xE0 + floor(cp / 0x1000), 0x80 + floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
  end
  return string.char(
    0xF0 + floor(cp / 0x40000),
    0x80 + floor(cp / 0x1000) % 0x40,
    0x80 + floor(cp / 0x40) % 0x40,
    0x80 + cp % 0x40
  )
end

--- Decode a UTF-8 string into an array of UTF-16 code units.
function M.from(s)
  local out = {}
  local n = #s
  local i = 1
  while i <= n do
    local cp, next_at = decode_at(s, i)
    if cp > 0xFFFF then
      cp = cp - 0x10000
      out[#out + 1] = 0xD800 + floor(cp / 0x400)
      out[#out + 1] = 0xDC00 + cp % 0x400
    else
      out[#out + 1] = cp
    end
    i = next_at
  end
  return out
end

--- Encode an array of UTF-16 code units as UTF-8.
function M.to(units)
  local parts = {}
  local i = 1
  while i <= #units do
    local u = units[i]
    if u >= 0xD800 and u <= 0xDBFF and i < #units then
      local lo = units[i + 1]
      if lo >= 0xDC00 and lo <= 0xDFFF then
        local cp = 0x10000 + (u - 0xD800) * 0x400 + (lo - 0xDC00)
        parts[#parts + 1] = encode_cp(cp)
        i = i + 2
      else
        parts[#parts + 1] = encode_cp(u)
        i = i + 1
      end
    else
      parts[#parts + 1] = encode_cp(u)
      i = i + 1
    end
  end
  return table.concat(parts)
end

--- The UTF-16 length of a UTF-8 string, without keeping the decoded array.
function M.length_of(s)
  local n = 0
  local i = 1
  while i <= #s do
    local cp, next_at = decode_at(s, i)
    n = n + (cp > 0xFFFF and 2 or 1)
    i = next_at
  end
  return n
end

--- Decode a Lua string as a regex pattern's own text (ASCII, but a literal
--- non-ASCII pattern character is allowed).
function M.pattern_units(s)
  return M.from(s)
end

--- An ASCII string as units (the common case: names, separators).
function M.ascii(s)
  local out = {}
  for i = 1, #s do out[i] = s:byte(i) end
  return out
end

function M.is_ascii(units)
  for i = 1, #units do
    if units[i] > 127 then return false end
  end
  return true
end

--- Slice `[from, to)` with JavaScript `slice` clamping (negative indices count
--- from the end; a missing `to` means the end). Offsets are 0-based.
function M.slice(units, from, to)
  local n = #units
  from = from or 0
  if from < 0 then from = math.max(0, n + from) end
  if from > n then from = n end
  if to == nil then to = n end
  if to < 0 then to = math.max(0, n + to) end
  if to > n then to = n end
  if to < from then to = from end
  local out = {}
  for i = from + 1, to do out[#out + 1] = units[i] end
  return out
end

--- JavaScript `substr`: `from` (0-based) and `length`.
function M.substr(units, from, length)
  local n = #units
  if from < 0 then from = math.max(0, n + from) end
  if length == nil then length = n - from end
  local to = math.min(n, from + math.max(0, length))
  return M.slice(units, from, to)
end

function M.charAt(units, at)
  return units[at + 1]
end

local function units_equal_at(units, at, needle)
  if at < 0 or at + #needle > #units then return false end
  for i = 1, #needle do
    if units[at + i] ~= needle[i] then return false end
  end
  return true
end

--- `String.prototype.indexOf`, for a unit needle or an ASCII/Lua string.
function M.indexOf(units, needle, from)
  if type(needle) == 'string' then needle = M.from(needle) end
  from = from or 0
  if from < 0 then from = 0 end
  local last = #units - #needle
  for at = from, last do
    if units_equal_at(units, at, needle) then return at end
  end
  return -1
end

--- `String.prototype.lastIndexOf`, 0-based, or -1.
function M.lastIndexOf(units, needle, from)
  if type(needle) == 'string' then needle = M.from(needle) end
  local last = #units - #needle
  local at = from == nil and last or math.min(from, last)
  for i = at, 0, -1 do
    if units_equal_at(units, i, needle) then return i end
  end
  return -1
end

function M.startsWith(units, prefix, at)
  if type(prefix) == 'string' then prefix = M.from(prefix) end
  return units_equal_at(units, at or 0, prefix)
end

function M.endsWith(units, suffix, to)
  if type(suffix) == 'string' then suffix = M.from(suffix) end
  local n = #units
  to = to == nil and n or to
  return units_equal_at(units, to - #suffix, suffix)
end

function M.equals(a, b)
  if #a ~= #b then return false end
  for i = 1, #a do if a[i] ~= b[i] then return false end end
  return true
end

function M.equals_string(a, s)
  if #a ~= #s then return false end
  for i = 1, #a do if a[i] ~= s:byte(i) then return false end end
  return true
end

-- The JavaScript `\s` / `trim` whitespace set: tab through U+FEFF, and not
-- U+0085. Kept in one place because both the masker and the regex engine use it.
function M.is_space(u)
  if u == nil then return false end
  return u == 9 or u == 10 or u == 11 or u == 12 or u == 13 or u == 32
    or u == 0xA0 or u == 0x1680 or (u >= 0x2000 and u <= 0x200A)
    or u == 0x2028 or u == 0x2029 or u == 0x202F or u == 0x205F
    or u == 0x3000 or u == 0xFEFF
end

function M.is_word(u)
  if u == nil then return false end
  return (u >= 48 and u <= 57) or (u >= 65 and u <= 90) or (u >= 97 and u <= 122) or u == 95
end

function M.is_digit(u)
  return u ~= nil and u >= 48 and u <= 57
end

function M.trimStart(units)
  local at = 0
  while at < #units and M.is_space(units[at + 1]) do at = at + 1 end
  return M.slice(units, at, #units)
end

function M.trimEnd(units)
  local at = #units
  while at > 0 and M.is_space(units[at]) do at = at - 1 end
  return M.slice(units, 0, at)
end

function M.trim(units)
  return M.trimEnd(M.trimStart(units))
end

--- Split on a literal separator (a string or unit array). An empty separator
--- splits into single units, as the scanner does not need that spelling.
function M.split(units, sep)
  if type(sep) == 'string' then sep = M.from(sep) end
  local out = {}
  local start = 0
  while true do
    local at = M.indexOf(units, sep, start)
    if at == -1 then
      out[#out + 1] = M.slice(units, start, #units)
      break
    end
    out[#out + 1] = M.slice(units, start, at)
    start = at + #sep
  end
  return out
end

function M.join(list, sep)
  if type(sep) == 'string' then sep = M.from(sep) end
  local out = {}
  for i = 1, #list do
    if i > 1 then
      for j = 1, #sep do out[#out + 1] = sep[j] end
    end
    local item = list[i]
    for j = 1, #item do out[#out + 1] = item[j] end
  end
  return out
end

function M.concat(a, b)
  local out = {}
  for i = 1, #a do out[#out + 1] = a[i] end
  for i = 1, #b do out[#out + 1] = b[i] end
  return out
end

--- A first line or a debug label, for test failures.
function M.first(text, n)
  local units = type(text) == 'table' and text or M.from(text)
  if #units <= (n or 80) then return M.to(units) end
  return M.to(M.slice(units, 0, n or 80)) .. '…'
end

return M
