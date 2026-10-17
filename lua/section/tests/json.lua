-- A small JSON decoder for the conformance corpora.
--
-- Standard Lua has no JSON library and the ports in this repository read the
-- corpora directly rather than keeping a generated copy. This decoder is
-- test-only: objects become tables, arrays become sequences, and `null` becomes
-- the sentinel `json.null` so a missing field and a null field stay distinct.

local M = {}

M.null = setmetatable({}, { __tostring = function() return 'null' end })

local function utf8_char(cp)
  if cp < 0x80 then return string.char(cp) end
  if cp < 0x800 then
    return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + cp % 0x40)
  end
  if cp < 0x10000 then
    return string.char(0xE0 + math.floor(cp / 0x1000),
      0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
  end
  return string.char(0xF0 + math.floor(cp / 0x40000),
    0x80 + math.floor(cp / 0x1000) % 0x40,
    0x80 + math.floor(cp / 0x40) % 0x40,
    0x80 + cp % 0x40)
end

local Parser = {}
Parser.__index = Parser

local function error_at(p, message)
  local line = 1
  local col = 1
  for i = 1, p.i - 1 do
    if p.text:sub(i, i) == '\n' then line = line + 1; col = 1 else col = col + 1 end
  end
  error(string.format('json:%d:%d: %s', line, col, message), 0)
end

local function skip_space(p)
  while true do
    local c = p.text:sub(p.i, p.i)
    if c == ' ' or c == '\t' or c == '\n' or c == '\r' then p.i = p.i + 1 else break end
  end
end

local function parse_value(p)
  skip_space(p)
  local c = p.text:sub(p.i, p.i)
  if c == '{' then
    p.i = p.i + 1
    local out = {}
    skip_space(p)
    if p.text:sub(p.i, p.i) == '}' then p.i = p.i + 1; return out end
    while true do
      skip_space(p)
      if p.text:sub(p.i, p.i) ~= '"' then error_at(p, 'expected an object key') end
      local key = parse_value(p)
      skip_space(p)
      if p.text:sub(p.i, p.i) ~= ':' then error_at(p, 'expected ":"') end
      p.i = p.i + 1
      out[key] = parse_value(p)
      skip_space(p)
      local next_char = p.text:sub(p.i, p.i)
      if next_char == ',' then p.i = p.i + 1
      elseif next_char == '}' then p.i = p.i + 1; break
      else error_at(p, 'expected "," or "}"') end
    end
    return out
  elseif c == '[' then
    p.i = p.i + 1
    local out = {}
    skip_space(p)
    if p.text:sub(p.i, p.i) == ']' then p.i = p.i + 1; return out end
    while true do
      out[#out + 1] = parse_value(p)
      skip_space(p)
      local next_char = p.text:sub(p.i, p.i)
      if next_char == ',' then p.i = p.i + 1
      elseif next_char == ']' then p.i = p.i + 1; break
      else error_at(p, 'expected "," or "]"') end
    end
    return out
  elseif c == '"' then
    p.i = p.i + 1
    local out = {}
    while true do
      local char = p.text:sub(p.i, p.i)
      if char == '' then error_at(p, 'unterminated string') end
      if char == '"' then p.i = p.i + 1; break end
      if char == '\\' then
        local esc = p.text:sub(p.i + 1, p.i + 1)
        p.i = p.i + 2
        if esc == '"' or esc == '\\' or esc == '/' then out[#out + 1] = esc
        elseif esc == 'b' then out[#out + 1] = '\b'
        elseif esc == 'f' then out[#out + 1] = '\f'
        elseif esc == 'n' then out[#out + 1] = '\n'
        elseif esc == 'r' then out[#out + 1] = '\r'
        elseif esc == 't' then out[#out + 1] = '\t'
        elseif esc == 'u' then
          local hex = p.text:sub(p.i, p.i + 3)
          if not hex:match('^%x%x%x%x$') then error_at(p, 'bad \\u escape') end
          local cp = tonumber(hex, 16)
          p.i = p.i + 4
          if cp >= 0xD800 and cp <= 0xDBFF then
            local low_hex = p.text:sub(p.i + 2, p.i + 5)
            if p.text:sub(p.i, p.i + 1) == '\\u' and low_hex:match('^%x%x%x%x$') then
              local low = tonumber(low_hex, 16)
              if low >= 0xDC00 and low <= 0xDFFF then
                cp = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00)
                p.i = p.i + 6
              end
            end
          end
          out[#out + 1] = utf8_char(cp)
        else
          error_at(p, 'bad escape')
        end
      else
        out[#out + 1] = char
        p.i = p.i + 1
      end
    end
    return table.concat(out)
  elseif c == 't' and p.text:sub(p.i, p.i + 3) == 'true' then
    p.i = p.i + 4; return true
  elseif c == 'f' and p.text:sub(p.i, p.i + 4) == 'false' then
    p.i = p.i + 5; return false
  elseif c == 'n' and p.text:sub(p.i, p.i + 3) == 'null' then
    p.i = p.i + 4; return M.null
  elseif c == '-' or c:match('^%d$') then
    local start = p.i
    if c == '-' then p.i = p.i + 1 end
    while p.text:sub(p.i, p.i):match('^%d$') do p.i = p.i + 1 end
    if p.text:sub(p.i, p.i) == '.' then
      p.i = p.i + 1
      while p.text:sub(p.i, p.i):match('^%d$') do p.i = p.i + 1 end
    end
    local exp = p.text:sub(p.i, p.i)
    if exp == 'e' or exp == 'E' then
      p.i = p.i + 1
      local sign = p.text:sub(p.i, p.i)
      if sign == '+' or sign == '-' then p.i = p.i + 1 end
      while p.text:sub(p.i, p.i):match('^%d$') do p.i = p.i + 1 end
    end
    return tonumber(p.text:sub(start, p.i - 1))
  end
  error_at(p, 'unexpected character ' .. string.format('%q', c))
end

function M.decode(text)
  local p = setmetatable({ text = text, i = 1 }, Parser)
  local value = parse_value(p)
  skip_space(p)
  if p.i <= #text then error_at(p, 'trailing input') end
  return value
end

function M.read_file(path)
  local file, err = io.open(path, 'rb')
  if not file then error('json: cannot read ' .. path .. ': ' .. tostring(err), 0) end
  local text = file:read('*a')
  file:close()
  return M.decode(text)
end

return M
