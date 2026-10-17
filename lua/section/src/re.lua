-- A small JavaScript-flavoured regular-expression engine over UTF-16 units.
--
-- The resolver and the tokenizer are defined by JavaScript regular expressions.
-- Translating each one into Lua patterns would be a second specification, and a
-- subtly different one: greedy alternation, `\b`, lookbehind, a named group and
-- a backreference all matter. So the port keeps the patterns as written and
-- interprets the subset they use:
--
--   literals, `.`, `[...]` (negated, ranges, `\w \d \s`), `^ $ \b \B`,
--   groups `(...)`, `(?:...)`, lookahead `(?=...)` `(?!...)`,
--   lookbehind `(?<=...)` `(?<!...)`, named groups `(?<name>...)`,
--   alternation, `* + ? {n} {n,} {n,m}` with lazy forms, and backreferences
--   `\1` / `\k<name>`, plus the `i` flag.
--
-- Matching is a backtracking matcher over the unit array; the order is
-- leftmost-first and greedy, as JavaScript's is. A quantifier over a single
-- character, class or `.` is matched iteratively, so a long run of spaces does
-- not become a deep call stack.
--
-- Every match is 0-based, half-open, and captures are `{from, to}` pairs.

local U = require('section.src.units')

local M = {}

local function fail(fmt, ...) error(string.format(fmt, ...), 0) end

local function ascii_lower(u)
  if u >= 65 and u <= 90 then return u + 32 end
  return u
end

local function ascii_upper(u)
  if u >= 97 and u <= 122 then return u - 32 end
  return u
end

-- ---------------------------------------------------------------------------
-- Parser
-- ---------------------------------------------------------------------------

local Parser = {}
Parser.__index = Parser

local function new_parser(pattern)
  return setmetatable({ s = pattern, i = 1, ncaps = 0, names = {} }, Parser)
end

function Parser:peek(offset)
  local at = self.i + (offset or 0)
  if at > #self.s then return nil end
  return self.s:sub(at, at)
end

function Parser:take()
  local c = self:peek()
  self.i = self.i + 1
  return c
end

function Parser:eat(text)
  if self.s:sub(self.i, self.i + #text - 1) == text then
    self.i = self.i + #text
    return true
  end
  return false
end

local parse_alt, parse_seq, parse_atom, parse_quant

local function literal_node(u)
  return { t = 'char', v = u }
end

local function class_item(kind, a, b)
  return { kind = kind, lo = a, hi = b }
end

-- One escape inside a character class. Returns one item (or a class item list).
local function class_escape(p)
  local c = p:take()
  if c == nil then fail('regex: trailing backslash in class') end
  if c == 'd' then return { class_item('class', 'd') } end
  if c == 'D' then return { class_item('class', 'D') } end
  if c == 'w' then return { class_item('class', 'w') } end
  if c == 'W' then return { class_item('class', 'W') } end
  if c == 's' then return { class_item('class', 's') } end
  if c == 'S' then return { class_item('class', 'S') } end
  if c == 'n' then return { class_item('char', 10) } end
  if c == 'r' then return { class_item('char', 13) } end
  if c == 't' then return { class_item('char', 9) } end
  if c == 'f' then return { class_item('char', 12) } end
  if c == 'v' then return { class_item('char', 11) } end
  if c == 'b' then return { class_item('char', 8) } end
  if c == '0' then return { class_item('char', 0) } end
  if c == 'x' then
    local hex = p.s:sub(p.i, p.i + 1)
    if #hex == 2 and hex:match('^%x%x$') then
      p.i = p.i + 2
      return { class_item('char', tonumber(hex, 16)) }
    end
    return { class_item('char', string.byte('x')) }
  end
  if c == 'u' then
    local hex = p.s:sub(p.i, p.i + 3)
    if #hex == 4 and hex:match('^%x%x%x%x$') then
      p.i = p.i + 4
      return { class_item('char', tonumber(hex, 16)) }
    end
    return { class_item('char', string.byte('u')) }
  end
  return { class_item('char', string.byte(c)) }
end

local function parse_class(p)
  -- The opening `[` has been taken.
  local negated = false
  if p:peek() == '^' then negated = true; p:take() end
  local items = {}
  local first = true
  while true do
    local c = p:peek()
    if c == nil then fail('regex: unterminated character class') end
    if c == ']' and not first then p:take(); break end
    first = false
    if c == '\\' then
      p:take()
      for _, item in ipairs(class_escape(p)) do items[#items + 1] = item end
    elseif c == '-' and p:peek(1) == ']' then
      p:take()
      items[#items + 1] = class_item('char', string.byte('-'))
    else
      p:take()
      local lo = string.byte(c)
      if p:peek() == '-' and p:peek(1) ~= ']' and p:peek(1) ~= nil then
        p:take()
        local hi_char = p:take()
        local hi
        if hi_char == '\\' then
          local escaped = class_escape(p)
          hi = escaped[1].lo
        else
          hi = string.byte(hi_char)
        end
        items[#items + 1] = class_item('range', lo, hi)
      else
        items[#items + 1] = class_item('char', lo)
      end
    end
  end
  return { t = 'class', negated = negated, items = items }
end

local function parse_group(p)
  -- `(` has been taken.
  if p:peek() == '?' then
    local c2 = p:peek(1)
    if c2 == ':' then
      p.i = p.i + 2
      local inner = parse_alt(p)
      if p:take() ~= ')' then fail('regex: missing )') end
      return { t = 'seq', items = { inner } }
    elseif c2 == '=' or c2 == '!' then
      p.i = p.i + 2
      local inner = parse_alt(p)
      if p:take() ~= ')' then fail('regex: missing )') end
      return { t = 'look', ahead = true, negated = c2 == '!', node = inner }
    elseif c2 == '<' then
      local c3 = p:peek(2)
      if c3 == '=' or c3 == '!' then
        p.i = p.i + 3
        local inner = parse_alt(p)
        if p:take() ~= ')' then fail('regex: missing )') end
        return { t = 'look', ahead = false, negated = c3 == '!', node = inner }
      end
      -- A named capture: (?<name> ... )
      p.i = p.i + 2
      local name = {}
      while p:peek() ~= '>' do
        local ch = p:take()
        if ch == nil then fail('regex: unterminated group name') end
        name[#name + 1] = ch
      end
      p:take()
      p.ncaps = p.ncaps + 1
      local index = p.ncaps
      p.names[table.concat(name)] = index
      local inner = parse_alt(p)
      if p:take() ~= ')' then fail('regex: missing )') end
      return { t = 'group', index = index, node = inner }
    end
    fail('regex: unsupported group')
  end
  p.ncaps = p.ncaps + 1
  local index = p.ncaps
  local inner = parse_alt(p)
  if p:take() ~= ')' then fail('regex: missing )') end
  return { t = 'group', index = index, node = inner }
end

local function parse_escape(p)
  local c = p:take()
  if c == nil then fail('regex: trailing backslash') end
  if c == 'b' then return { t = 'anchor', kind = 'word' } end
  if c == 'B' then return { t = 'anchor', kind = 'not-word' } end
  if c == 'd' then return { t = 'class', negated = false, items = { class_item('class', 'd') } } end
  if c == 'D' then return { t = 'class', negated = false, items = { class_item('class', 'D') } } end
  if c == 'w' then return { t = 'class', negated = false, items = { class_item('class', 'w') } } end
  if c == 'W' then return { t = 'class', negated = false, items = { class_item('class', 'W') } } end
  if c == 's' then return { t = 'class', negated = false, items = { class_item('class', 's') } } end
  if c == 'S' then return { t = 'class', negated = false, items = { class_item('class', 'S') } } end
  if c == 'n' then return literal_node(10) end
  if c == 'r' then return literal_node(13) end
  if c == 't' then return literal_node(9) end
  if c == 'f' then return literal_node(12) end
  if c == 'v' then return literal_node(11) end
  if c == '0' then return literal_node(0) end
  if c == 'x' then
    local hex = p.s:sub(p.i, p.i + 1)
    if #hex == 2 and hex:match('^%x%x$') then
      p.i = p.i + 2
      return literal_node(tonumber(hex, 16))
    end
    return literal_node(string.byte('x'))
  end
  if c == 'u' then
    local hex = p.s:sub(p.i, p.i + 3)
    if #hex == 4 and hex:match('^%x%x%x%x$') then
      p.i = p.i + 4
      local cp = tonumber(hex, 16)
      if cp > 0xFFFF then
        cp = cp - 0x10000
        return { t = 'seq', items = {
          literal_node(0xD800 + math.floor(cp / 0x400)),
          literal_node(0xDC00 + cp % 0x400),
        } }
      end
      return literal_node(cp)
    end
    return literal_node(string.byte('u'))
  end
  if c == 'k' and p:peek() == '<' then
    p:take()
    local name = {}
    while p:peek() ~= '>' do
      local ch = p:take()
      if ch == nil then fail('regex: unterminated backreference') end
      name[#name + 1] = ch
    end
    p:take()
    return { t = 'backref', name = table.concat(name) }
  end
  if c >= '1' and c <= '9' then
    return { t = 'backref', index = tonumber(c) }
  end
  return literal_node(string.byte(c))
end

function Parser:parse_atom()
  local c = self:peek()
  if c == nil then fail('regex: unexpected end') end
  if c == '(' then
    self:take()
    return parse_group(self)
  elseif c == '[' then
    self:take()
    return parse_class(self)
  elseif c == '.' then
    self:take()
    return { t = 'any' }
  elseif c == '^' then
    self:take()
    return { t = 'anchor', kind = 'start' }
  elseif c == '$' then
    self:take()
    return { t = 'anchor', kind = 'end' }
  elseif c == '\\' then
    self:take()
    return parse_escape(self)
  elseif c == '*' or c == '+' or c == '?' then
    fail('regex: nothing to repeat')
  else
    self:take()
    return literal_node(string.byte(c))
  end
end

local function parse_quantifier(p)
  local c = p:peek()
  local function lazy_after()
    if p:peek() == '?' then p:take(); return true end
    return false
  end
  if c == '*' then p:take(); return 0, nil, not lazy_after() end
  if c == '+' then p:take(); return 1, nil, not lazy_after() end
  if c == '?' then p:take(); return 0, 1, not lazy_after() end
  if c == '{' then
    local rest = p.s:sub(p.i)
    local min_s, comma, max_s, tail = rest:match('^{(%d+)(,?)(%d*)}(.*)$')
    if min_s then
      local min = tonumber(min_s)
      local max
      if comma == ',' then
        if max_s == '' then max = nil else max = tonumber(max_s) end
      else
        max = min
      end
      p.i = p.i + (#rest - #tail)
      local lazy = lazy_after()
      return min, max, not lazy
    end
    return nil
  end
  return nil
end

function Parser:parse_quant(atom)
  local min, max, greedy = parse_quantifier(self)
  if min == nil then return atom end
  return { t = 'quant', node = atom, min = min, max = max, greedy = greedy }
end

function parse_seq(p)
  local items = {}
  while true do
    local c = p:peek()
    if c == nil or c == ')' or c == '|' then break end
    local atom = p:parse_atom()
    atom = p:parse_quant(atom)
    items[#items + 1] = atom
  end
  return { t = 'seq', items = items }
end

function parse_alt(p)
  local branches = { parse_seq(p) }
  while p:peek() == '|' do
    p:take()
    branches[#branches + 1] = parse_seq(p)
  end
  if #branches == 1 then return branches[1] end
  return { t = 'alt', branches = branches }
end

-- ---------------------------------------------------------------------------
-- Matcher
-- ---------------------------------------------------------------------------

local function class_matches(node, u, icase)
  -- There is no character past the end of the subject: a negated class must
  -- not match "the absence of a character" there (JavaScript does not).
  if u == nil then return false end
  local function test(unit)
    if unit == nil then return false end
    for _, item in ipairs(node.items) do
      if item.kind == 'char' then
        if unit == item.lo then return true end
      elseif item.kind == 'range' then
        if unit >= item.lo and unit <= item.hi then return true end
      else
        local name = item.lo
        if name == 'd' then
          if unit >= 48 and unit <= 57 then return true end
        elseif name == 'D' then
          if not (unit >= 48 and unit <= 57) then return true end
        elseif name == 'w' then
          if U.is_word(unit) then return true end
        elseif name == 'W' then
          if not U.is_word(unit) then return true end
        elseif name == 's' then
          if U.is_space(unit) then return true end
        elseif name == 'S' then
          if not U.is_space(unit) then return true end
        end
      end
    end
    return false
  end

  local found = test(u)
  if not found and icase then
    local other = (u >= 65 and u <= 90) and u + 32 or ((u >= 97 and u <= 122) and u - 32 or u)
    if other ~= u then found = test(other) end
  end
  if node.negated then return not found end
  return found
end

local function node_char_matches(node, u, icase)
  if node.t == 'any' then return u ~= nil and u ~= 10 and u ~= 13 and u ~= 0x2028 and u ~= 0x2029 end
  if node.t == 'char' then
    if icase then return ascii_lower(u or -1) == ascii_lower(node.v) end
    return u == node.v
  end
  if node.t == 'class' then return class_matches(node, u, icase) end
  return false
end

local function at_end(units, pos)
  local n = #units
  if pos == n then return true end
  -- JavaScript `$` also matches before a final line terminator.
  if pos == n - 1 and (units[n] == 10 or units[n] == 13 or units[n] == 0x2028 or units[n] == 0x2029) then
    return true
  end
  if pos == n - 2 and units[n - 1] == 13 and units[n] == 10 then return true end
  return false
end

local function is_word_at(units, pos)
  return U.is_word(units[pos + 1])
end

local match_node

-- Match a sequence of nodes with continuation `k`.
local function match_seq(items, index, units, pos, caps, k, ctx)
  if index > #items then return k(pos, caps) end
  local node = items[index]
  return match_node(node, units, pos, caps, function(p2, c2)
    return match_seq(items, index + 1, units, p2, c2, k, ctx)
  end, ctx)
end

local function run_sub(node, units, pos, caps, ctx)
  return match_node(node, units, pos, caps, function(p2, c2)
    return { pos = p2, caps = c2 }
  end, ctx)
end

local function merge_caps(into, from)
  for index, value in pairs(from) do
    if value ~= nil then into[index] = value end
  end
end

match_node = function(node, units, pos, caps, k, ctx)
  local t = node.t
  if t == 'seq' then
    return match_seq(node.items, 1, units, pos, caps, k, ctx)
  elseif t == 'alt' then
    for _, branch in ipairs(node.branches) do
      local saved = {}
      for index, value in pairs(caps) do saved[index] = value end
      local r = match_node(branch, units, pos, caps, k, ctx)
      if r then return r end
      for index in pairs(caps) do caps[index] = nil end
      for index, value in pairs(saved) do caps[index] = value end
    end
    return nil
  elseif t == 'char' or t == 'any' or t == 'class' then
    local u = units[pos + 1]
    if node_char_matches(node, u, ctx.icase) then return k(pos + 1, caps) end
    return nil
  elseif t == 'anchor' then
    if node.kind == 'start' then
      if pos == 0 then return k(pos, caps) end
    elseif node.kind == 'end' then
      if at_end(units, pos) then return k(pos, caps) end
    elseif node.kind == 'word' then
      if is_word_at(units, pos - 1) ~= is_word_at(units, pos) then return k(pos, caps) end
    elseif node.kind == 'not-word' then
      if is_word_at(units, pos - 1) == is_word_at(units, pos) then return k(pos, caps) end
    end
    return nil
  elseif t == 'group' then
    local index = node.index
    return match_node(node.node, units, pos, caps, function(p2, c2)
      local old = c2[index]
      c2[index] = { pos, p2 }
      local r = k(p2, c2)
      c2[index] = old
      return r
    end, ctx)
  elseif t == 'backref' then
    local index = node.index
    if index == nil then index = ctx.re.names[node.name] end
    local cap = caps[index]
    if cap == nil then return k(pos, caps) end
    local from, to = cap[1], cap[2]
    local length = to - from
    for i = 0, length - 1 do
      if units[pos + 1 + i] ~= units[from + 1 + i] then return nil end
    end
    return k(pos + length, caps)
  elseif t == 'look' then
    if node.ahead then
      local res = run_sub(node.node, units, pos, caps, ctx)
      if node.negated then
        if res then return nil end
        return k(pos, caps)
      end
      if not res then return nil end
      merge_caps(caps, res.caps)
      return k(pos, caps)
    end
    -- Lookbehind: try every start at or before `pos` and require the match to
    -- end exactly at `pos`.
    local found = nil
    for start = 0, pos do
      local res = run_sub(node.node, units, start, {}, ctx)
      if res and res.pos == pos then found = res; break end
    end
    if node.negated then
      if found then return nil end
      return k(pos, caps)
    end
    if not found then return nil end
    merge_caps(caps, found.caps)
    return k(pos, caps)
  elseif t == 'quant' then
    local min, max, greedy = node.min, node.max, node.greedy
    local child = node.node
    local simple = child.t == 'char' or child.t == 'any' or child.t == 'class'
    if simple then
      -- Iterative fast path: positions[count + 1] is where `count` matches end.
      local positions = { pos }
      local at = pos
      while max == nil or (#positions - 1) < max do
        local u = units[at + 1]
        if not node_char_matches(child, u, ctx.icase) then break end
        at = at + 1
        positions[#positions + 1] = at
      end
      local highest = #positions - 1
      local function try(count)
        if count < min then return nil end
        return k(positions[count + 1], caps)
      end
      if greedy then
        for count = highest, min, -1 do
          local r = try(count)
          if r then return r end
        end
        return nil
      end
      for count = min, highest do
        local r = try(count)
        if r then return r end
      end
      return nil
    end

    local function rep(count, at, c)
      local function more()
        if max ~= nil and count >= max then return nil end
        return match_node(child, units, at, c, function(p2, c2)
          if p2 == at then
            if count + 1 >= min then return k(p2, c2) end
            return nil
          end
          return rep(count + 1, p2, c2)
        end, ctx)
      end
      local function stop()
        if count >= min then return k(at, c) end
        return nil
      end
      if greedy then return more() or stop() end
      return stop() or more()
    end
    return rep(0, pos, caps)
  end
  fail('regex: unknown node %s', tostring(t))
end

-- ---------------------------------------------------------------------------
-- Public surface
-- ---------------------------------------------------------------------------

function M.compile(pattern, flags)
  flags = flags or ''
  local p = new_parser(pattern)
  local node = parse_alt(p)
  if p.i <= #p.s then fail('regex: trailing input at %d in %q', p.i, pattern) end
  return {
    pattern = pattern,
    flags = flags,
    node = node,
    ncaps = p.ncaps,
    names = p.names,
    icase = flags:find('i', 1, true) ~= nil,
    global = flags:find('g', 1, true) ~= nil,
    lastIndex = 0,
  }
end

--- Search `units` from `start` (0-based) for the first match. Returns a match
--- `{ index, endpos, captures = {{from, to}, ...}, groups = { name = {...} } }`
--- or nil. Captures are 0-based, half-open; an unmatched group is nil.
function M.exec(re, units, start)
  local ctx = { re = re, icase = re.icase }
  start = start or 0
  if start < 0 then start = 0 end
  for s = start, #units do
    local caps = {}
    local out = match_node(re.node, units, s, caps, function(p, c)
      local captures = {}
      for i = 1, re.ncaps do
        if c[i] ~= nil then captures[i] = { c[i][1], c[i][2] } end
      end
      local groups = {}
      for name, index in pairs(re.names) do groups[name] = captures[index] end
      return { index = s, endpos = p, captures = captures, groups = groups }
    end, ctx)
    if out then
      re.lastIndex = out.endpos
      return out
    end
  end
  re.lastIndex = 0
  return nil
end

function M.test(re, units)
  return M.exec(re, units, 0) ~= nil
end

--- Capture `i` of a match, as units (or nil).
function M.group(units, match, i)
  local cap = match and match.captures[i]
  if not cap then return nil end
  return U.slice(units, cap[1], cap[2])
end

function M.group_text(units, match, i)
  local value = M.group(units, match, i)
  return value and U.to(value) or nil
end

--- Global matches, in order.
function M.exec_all(re, units)
  local out = {}
  local at = 0
  while at <= #units do
    local m = M.exec(re, units, at)
    if not m then break end
    out[#out + 1] = m
    if m.endpos == at then at = at + 1 else at = m.endpos end
  end
  return out
end

--- A quick `re.test` for callers that have an ASCII line as a Lua string.
function M.test_string(re, text)
  return M.test(re, U.from(text))
end

function M.exec_string(re, text)
  return M.exec(re, U.from(text), 0)
end

M.U = U

return M
