-- The shared tokenizer, ported from `src/js/scanner/tokenizer.js`.
--
-- One pass over a source, parameterised by a language's comment and string
-- syntax. It produces the two facts the resolver's lexer seam needs — a blanked
-- mask and the comment spans — plus the declaration shapes and annotation test
-- a language adds. Structure, precedence and modifiers stay in the resolver.

local U = require('section.src.units')
local re = require('section.src.re')

local M = {}

local function fail(message) error('tokenize: ' .. message, 0) end

local function sorted_longest_first(kinds, open_of)
  local copy = {}
  for i, kind in ipairs(kinds) do copy[i] = kind end
  table.sort(copy, function(a, b)
    return #open_of(a) > #open_of(b)
  end)
  return copy
end

local normalized_cache = setmetatable({}, { __mode = 'k' })

--- Normalise either syntax spelling into the one the engine walks.
function M.normalize_syntax(syntax)
  if not syntax then fail('no syntax given') end
  local cached = normalized_cache[syntax]
  if cached then return cached end

  local line_comments = sorted_longest_first(
    syntax.lineComments or (syntax.lineComment and { syntax.lineComment } or {}),
    function(text) return text end
  )
  local block_comments = sorted_longest_first(
    syntax.blockComments or (syntax.blockComment and { syntax.blockComment } or {}),
    function(block) return block.open end
  )
  local strings = sorted_longest_first(syntax.strings or {}, function(kind)
    return kind.open or kind.quote or ''
  end)

  local normalized_strings = {}
  for _, kind in ipairs(strings) do
    local open = kind.open or kind.quote or ''
    local close = kind.close
    if close == nil then close = kind.open or kind.quote or '' end
    -- `false` is the table's spelling of JavaScript's explicit `escape: null`
    -- (a raw string takes no escapes); an absent field means the default,
    -- a backslash.
    local escape = kind.escape
    if escape == nil then escape = 'backslash' end
    local entry = {
      open = open,
      close = close,
      escape = escape,
      multiline = kind.multiline or kind.lineScoped or false,
      lineScoped = kind.lineScoped or false,
      boundary = kind.boundary or false,
      hashes = kind.hashes or false,
      maxSpan = kind.maxSpan,
      content = kind.content and re.compile(kind.content, '') or nil,
      content_src = kind.content,
      open_units = U.from(open),
      close_units = U.from(close),
    }
    -- A Zig line-scoped string has an empty closer; a hashes type computes its
    -- own; every other string must name a closer.
    if open ~= '' and (close ~= '' or entry.hashes or entry.lineScoped) then
      normalized_strings[#normalized_strings + 1] = entry
    end
  end

  local normalized = {
    _normalized = true,
    name = syntax.name or 'anonymous',
    lineComments = line_comments,
    blockComments = block_comments,
    strings = sorted_longest_first(normalized_strings, function(kind) return kind.open end),
    heredoc = syntax.heredoc or false,
    declarations = syntax.declarations or {},
    annotations = syntax.annotations or {},
  }
  for _, block in ipairs(normalized.blockComments) do
    block.open_units = U.from(block.open)
    block.close_units = U.from(block.close)
  end
  normalized_cache[syntax] = normalized
  return normalized
end

local HEREDOC_OPEN = re.compile(
  [=[^<<(?<angle><)?(?<strip>[-~]?)(?<quote>["'`]?)(?<tag>[A-Za-z_][A-Za-z0-9_]*)\k<quote>]=],
  ''
)

local ID_CHAR = re.compile([=[^[A-Za-z0-9_$]$]=], '')

local function end_of_line(units, from)
  local at = U.indexOf(units, '\n', from)
  if at == -1 then return #units end
  return at
end

local function line_starts(units)
  local starts = { 0 }
  for i = 0, #units - 1 do
    if units[i + 1] == 10 then starts[#starts + 1] = i + 1 end
  end
  return starts
end

local function line_col(starts, offset)
  local low, high = 0, #starts - 1
  while low < high do
    local mid = math.floor((low + high + 1) / 2)
    if starts[mid + 1] <= offset then low = mid else high = mid - 1 end
  end
  return { line = low + 1, col = offset - starts[low + 1] + 1 }
end

local function read_block_comment(source, i, block)
  local open, close = block.open_units, block.close_units
  if not block.nested then
    local at = U.indexOf(source, close, i + #open)
    local to = at == -1 and #source or at + #close
    local body_end = at == -1 and #source or at
    return { to = to, body = U.slice(source, i + #open, body_end) }
  end
  local depth = 0
  local j = i
  local body_start = i + #open
  while j < #source do
    if U.startsWith(source, open, j) then
      depth = depth + 1
      j = j + #open
    elseif U.startsWith(source, close, j) then
      depth = depth - 1
      j = j + #close
      if depth == 0 then break end
    else
      j = j + 1
    end
  end
  local to = j
  local body_end = math.max(body_start, to - #close)
  return { to = to, body = U.slice(source, body_start, body_end) }
end

local ID_CHAR_TEST

local function match_string(source, i, kinds)
  for _, kind in ipairs(kinds) do
    if kind.boundary and i > 0 and ID_CHAR_TEST(source, i - 1) then
      -- skip
    else
      if kind.hashes then
        local prefix = U.slice(kind.open_units, 0, #kind.open_units - 1)
        if U.startsWith(source, prefix, i) then
          local j = i + #prefix
          local hashes = 0
          while source[j + 1] == 35 do hashes = hashes + 1; j = j + 1 end
          if source[j + 1] == 34 then
            local close = U.concat(U.ascii('"'), U.ascii(string.rep('#', hashes)))
            return { kind = kind, bodyFrom = j + 1, close = close }
          end
        end
      elseif U.startsWith(source, kind.open_units, i) then
        return { kind = kind, bodyFrom = i + #kind.open_units, close = kind.close_units }
      end
    end
  end
  return nil
end

-- A tiny helper kept local so the ID_CHAR regex is used the way JavaScript's
-- `/^[A-Za-z0-9_$]/` is: one character at a time.
ID_CHAR_TEST = function(source, at)
  return re.test(ID_CHAR, { source[at + 1] })
end

local function read_string(source, hit)
  local kind = hit.kind
  local body_from = hit.bodyFrom
  local close = hit.close
  if kind.lineScoped then return end_of_line(source, body_from) end

  local must_close = kind.maxSpan ~= nil or kind.content ~= nil
  local escape = kind.escape
  local j = body_from
  while j < #source do
    local c = source[j + 1]
    if c == 10 and not kind.multiline then
      if must_close then return nil end
      return j
    end
    if escape == 'backslash' and c == 92 then
      j = j + 2
    elseif escape == 'doubling' and U.startsWith(source, close, j)
      and U.startsWith(source, close, j + #close) then
      j = j + #close * 2
    elseif U.startsWith(source, close, j) then
      if kind.maxSpan ~= nil and j - body_from > kind.maxSpan then return nil end
      if kind.content and not re.test(kind.content, U.slice(source, body_from, j)) then return nil end
      return j + #close
    else
      j = j + 1
    end
  end
  if must_close then return nil end
  return #source
end

local function match_heredoc(source, i, mode)
  local slice = U.slice(source, i, i + 64)
  local m = re.exec(HEREDOC_OPEN, slice, 0)
  if not m then return nil end
  local strip = m.groups.strip and U.to(U.slice(slice, m.groups.strip[1], m.groups.strip[2])) or ''
  local quote = m.groups.quote and U.to(U.slice(slice, m.groups.quote[1], m.groups.quote[2])) or ''
  if mode == 'strict' and strip == '' and quote == '' then return nil end
  local tag = U.to(U.slice(slice, m.groups.tag[1], m.groups.tag[2]))
  return { tag = tag, length = m.endpos - m.index }
end

local function heredoc_end(source, from, tag)
  local i = from
  while i <= #source do
    local eol = end_of_line(source, i)
    local line = U.trim(U.slice(source, i, eol))
    local text = U.to(line)
    if text == tag or text == tag .. ';' then return eol end
    if eol >= #source then return #source end
    i = eol + 1
  end
  return #source
end

--- One lexical pass. Returns `{ masked, comments, strings, ifClauses, starts }`.
-- `visitor` is accepted for parity with the JavaScript API; it is not needed by
-- the resolver, so only the hooks the port uses are called.
function M.tokenize(source, syntax, visitor)
  -- `make_lexer` normalises once and hands the normalised table back here; a
  -- second pass would compile an already-compiled `content` regex.
  local lang = syntax._normalized and syntax or M.normalize_syntax(syntax)
  local out = {}
  for i = 1, #source do out[i] = source[i] end

  local function blank(from, to)
    for i = from + 1, math.min(to, #out) do
      if out[i] ~= 10 then out[i] = 32 end
    end
  end

  local comments = {}
  local strings = {}
  local starts = line_starts(source)
  local n = #source
  local i = 0

  while i < n do
    local ch = source[i + 1]
    if ch == 10 then
      i = i + 1
    else
      local handled = false

      if lang.heredoc and U.startsWith(source, '<<', i) then
        local heredoc = match_heredoc(source, i, lang.heredoc)
        if heredoc then
          local open_end = end_of_line(source, i)
          local finish = heredoc_end(source, open_end + 1, heredoc.tag)
          blank(open_end + 1, finish)
          i = finish
          handled = true
        end
      end

      if not handled then
        for _, open in ipairs(lang.lineComments) do
          if open == '#' and source[i + 2] == 91 then
            -- `#[attr]` is an attribute, not a comment.
          elseif U.startsWith(source, U.from(open), i) then
            local finish = end_of_line(source, i)
            local body = U.slice(source, i + #open, finish)
            comments[#comments + 1] = { text = body, from = i, to = finish }
            if visitor and visitor.comment then
              local at = line_col(starts, i)
              visitor.comment({ text = body, from = i, to = finish, line = at.line, col = at.col })
            end
            blank(i, finish)
            i = finish
            handled = true
            break
          end
        end
      end

      if not handled then
        local block = nil
        for _, candidate in ipairs(lang.blockComments) do
          if U.startsWith(source, candidate.open_units, i)
            and (not candidate.lineStart or i == 0 or source[i] == 10) then
            block = candidate
            break
          end
        end
        if block then
          local read = read_block_comment(source, i, block)
          comments[#comments + 1] = { text = read.body, from = i, to = read.to }
          if visitor and visitor.comment then
            local at = line_col(starts, i)
            visitor.comment({ text = read.body, from = i, to = read.to, line = at.line, col = at.col })
          end
          blank(i, read.to)
          i = read.to
          handled = true
        end
      end

      if not handled then
        local hit = match_string(source, i, lang.strings)
        if hit then
          local finish = read_string(source, hit)
          if finish ~= nil then
            local span = { from = i, to = finish, quote = hit.kind.open, multiline = hit.kind.multiline }
            strings[#strings + 1] = span
            if visitor and visitor.string then
              local at = line_col(starts, i)
              visitor.string({ from = i, to = finish, quote = hit.kind.open,
                multiline = hit.kind.multiline, line = at.line, col = at.col })
            end
            blank(i, finish)
            i = finish
            handled = true
          end
        end
      end

      if not handled then i = i + 1 end
    end
  end

  return {
    masked = out,
    comments = comments,
    strings = strings,
    ifClauses = {},
    starts = starts,
  }
end

local function past_param_list(mask, finish, limit)
  local depth = 0
  local stop = limit == nil and #mask or math.min(#mask, limit)
  local i = finish - 1
  while i < stop do
    local c = mask[i + 1]
    if c == 40 then
      depth = depth + 1
    elseif c == 41 then
      depth = depth - 1
      if depth == 0 then return i + 1 end
    end
    i = i + 1
  end
  return finish
end

--- A lexer adapter for the resolver, mirroring `makeLexer`.
function M.make_lexer(syntax)
  local lang = M.normalize_syntax(syntax)
  local cache_src, cache_val = nil, nil
  local function scan(source)
    if source ~= cache_src then
      cache_src = source
      cache_val = M.tokenize(source, lang)
    end
    return cache_val
  end

  local lexer = {
    name = lang.name,
    mask = function(source) return scan(source).masked end,
    comments = function(source) return scan(source).comments end,
  }

  if #lang.declarations > 0 then
    local descriptors = {}
    for _, descriptor in ipairs(lang.declarations) do
      descriptors[#descriptors + 1] = {
        kind = descriptor.kind,
        re = re.compile(descriptor.re, ''),
        suffix = descriptor.suffix and re.compile(descriptor.suffix, '') or nil,
        body = descriptor.body,
        end_word = descriptor.end_word,
        line = descriptor.line,
      }
    end
    lexer.declarations = function(masked_line)
      local out = {}
      for _, descriptor in ipairs(descriptors) do
        local match = re.exec(descriptor.re, masked_line, 0)
        if match and match.captures[1] then
          local base = U.slice(masked_line, match.captures[1][1], match.captures[1][2])
          local suffix_text = ''
          local after = match.endpos
          if descriptor.suffix and masked_line[after + 1]
            and re.test(descriptor.suffix, { masked_line[after + 1] }) then
            suffix_text = U.to({ masked_line[after + 1] })
          end
          out[#out + 1] = {
            kind = descriptor.kind or 'method',
            name = U.to(base) .. suffix_text,
            base = U.to(base),
            headerFrom = match.endpos + #suffix_text,
            body = descriptor.body,
            ['end'] = descriptor.end_word,
            line = descriptor.line and true or false,
          }
        end
      end
      return out
    end
  end

  if #lang.annotations > 0 then
    local annotations = {}
    for _, source in ipairs(lang.annotations) do annotations[#annotations + 1] = re.compile(source, '') end
    lexer.annotationLine = function(line)
      for _, compiled in ipairs(annotations) do
        if re.test(compiled, line) then return true end
      end
      return false
    end
  end

  return lexer
end

M.end_of_line = end_of_line
M.past_param_list = past_param_list

return M
