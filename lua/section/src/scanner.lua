-- The block scanner, ported from `lib/section.mjs`.
--
-- It walks the masked source into a tree of blocks: classes, methods,
-- properties, statements, region pairs and comment anchors. It owns no
-- language-specific syntax — a lexer supplies the mask, the comments and any
-- declaration shapes a language spells differently — and it is deliberately
-- line-oriented, as the JavaScript is.

local U = require('section.src.units')
local re = require('section.src.re')

local M = {}

-- ---------------------------------------------------------------------------
-- Patterns and word sets
-- ---------------------------------------------------------------------------

local COMMENT_OPENER = re.compile([=[^(?:(?://|--|;|%|'|#|REM\b|<!--|/\*|\*)\s*)+]=], 'i')
local COMMENT_CLOSER = re.compile([=[\s*(?:-->|\*/)$]=], '')
local DOC_OPEN = re.compile([=[^\s*/\*[*!]]=], '')
local DOC_RUN = re.compile([=[^\s*///]=], '')
local ANNOTATION_LINE = re.compile([=[^\s*(?:@[\w.$]|#\[)]=], '')
local DECLARATION_KEYWORD = re.compile(
  [=[\b(?:class|interface|enum|record|struct|trait|object|union)\s+([A-Za-z_$][\w$]*)\b]=], '')
local STATEMENT_BEFORE = re.compile(
  [=[^(?:return|throw|new|await|yield|delete|typeof|case|else|do)\b]=], '')
local PREFIX = re.compile([=[^[\w$<>\[\],.?*&:@\s]*$]=], '')
local STATEMENT_KEYWORD = re.compile(
  [=[\b(if|else|for|while|do|switch|try|catch|finally|synchronized)\b]=], '')
local STATEMENT_KEYWORD_AT_START = re.compile(
  [=[^(?:if|else|elseif|for|while|do|switch|select|try|catch|finally|synchronized|unless|until|when|case)\b]=], 'i')
local REGION_DIRECTIVE = re.compile([=[^(#?)(region|endregion)\b\s*(.*)$]=], 'i')
local REGION_BODY = re.compile([=[^(#?)(region|endregion)\b]=], 'i')
local ANCHOR_NAME = re.compile([=[^([A-Za-z_$][\w$]*)$]=], '')
local GAP = re.compile([=[^[\s+]*$]=], '')
local EXPRESSION_MODIFIER_BEFORE = re.compile("[\\w$>)\\]}]", '')
local CONTINUES_AFTER = re.compile("[,+\\-*/%&|?<(\\[{!~^]\\s*$", '')
local HEADER_CONTINUES = re.compile("[(,;]\\s*$", '')
local WORD_TAIL = re.compile("\\w[\\w$]*[>)\\]}\\s]*$", '')
local THROWS_TAIL = re.compile([=[\bthrows\s+\w]=], '')
local EXTENDS_TAIL = re.compile([=[\b(?:extends|implements)\s+[\w$][\w$.<>,?\[\]\s]*\w]=], '')
local BRACE_LINE = re.compile([=[^\s*\{\s*$]=], '')
local WORD_START = re.compile([=[^[A-Za-z_$][\w$]*]=], '')
local WORD_ONLY = re.compile([=[^[A-Za-z_$][\w$.]*]=], '')
local DOT_NAME = re.compile([=[^\.[A-Za-z_$][\w$]*]=], '')
local BRACKETS = re.compile([=[^\s*\[\s*\]]=], '')
local TYPE_NAME = re.compile([=[^[A-Za-z_$][\w$]*]=], '')
local REST_CONTINUATION = re.compile([=[^\s*([A-Za-z_]+)]=], '')
local ELSE_IF = re.compile([=[^\s*else\s+if\b]=], '')
local WHILE_AFTER_DO = re.compile([=[^\s*while\s*\(]=], '')
local FUNC_ARG_PREFIX = re.compile([=[^func\s*\([^)]*\)\s*]=], '')

local DECLARED_NAME_WORDS = {
  class = true, interface = true, enum = true, record = true,
  struct = true, trait = true, object = true, union = true,
}

local NOT_A_NAME = {
  ['if'] = true, ['for'] = true, ['while'] = true, ['switch'] = true, catch = true,
  ['return'] = true, ['new'] = true, ['do'] = true, ['else'] = true, throw = true,
  await = true, yield = true, typeof = true, delete = true, ['void'] = true,
  ['in'] = true, ['of'] = true, instanceof = true, super = true, ['this'] = true,
  with = true, ['case'] = true, when = true, sizeof = true,
}

local NOT_A_TYPE = {
  ['return'] = true, throw = true, ['new'] = true, ['else'] = true, ['do'] = true,
  ['case'] = true, await = true, yield = true, delete = true, typeof = true,
}

local DECLARATION_MODIFIERS = {
  public = true, protected = true, private = true, static = true, final = true,
  abstract = true, transient = true, volatile = true, synchronized = true,
  native = true, strictfp = true, ['default'] = true, const = true, let = true,
  ['var'] = true, readonly = true, internal = true, open = true, sealed = true,
  lateinit = true, override = true, suspend = true, inline = true, external = true,
  partial = true, ref = true,
}

local HEADER_LINES = 200

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

local function text(units) return U.to(units) end
local function units(value)
  if type(value) == 'table' then return value end
  return U.from(value)
end

local function line_of(starts, offset)
  local low, high = 0, #starts - 1
  while low < high do
    local middle = math.floor((low + high + 1) / 2)
    if starts[middle + 1] <= offset then low = middle else high = middle - 1 end
  end
  return low
end

local function next_non_blank(lines, from)
  for i = from, #lines - 1 do
    if text(U.trim(lines[i + 1])) ~= '' then return i end
  end
  return -1
end

local function end_of_line(source, offset)
  local at = U.indexOf(source, '\n', offset)
  if at == -1 then return #source end
  return at
end

local function escape_regexp(value)
  return (value:gsub('[%*%+%?%^%$%(%)%[%]%{%}%|%.\\]', '\\%0'))
end

local function matching_bracket(source, open, closer)
  local depth = 0
  local opener = source[open + 1]
  for i = open, #source - 1 do
    local char = source[i + 1]
    if char == opener then
      depth = depth + 1
    elseif char == closer:byte(1) then
      depth = depth - 1
      if depth == 0 then return i end
    end
  end
  return -1
end

local function indent_width(line)
  return #line - #U.trimStart(line)
end

local function unit_text_at(source, at)
  return U.to({ source[at + 1] })
end

-- ---------------------------------------------------------------------------
-- Region directives and condition literals
-- ---------------------------------------------------------------------------

local function region_directive(line)
  local value = U.trim(units(line))
  local close_match = re.exec(COMMENT_CLOSER, value, 0)
  if close_match then
    value = U.trim(U.slice(value, 0, close_match.index))
  end
  local commented = re.test(COMMENT_OPENER, value)
  if commented then
    local open_match = re.exec(COMMENT_OPENER, value, 0)
    value = U.trim(U.slice(value, open_match.endpos, #value))
  end
  local match = re.exec(REGION_DIRECTIVE, value, 0)
  if not match then return nil end
  local hash = re.group_text(value, match, 1)
  local kind = re.group_text(value, match, 2):lower()
  if not commented and hash ~= '#' then return nil end
  return { kind = kind, name = text(U.trim(re.group(value, match, 3))) }
end

local function condition_literals(orig_line, from)
  local literals = {}
  local i = from > 0 and from or 0
  while i < #orig_line do
    local ch = orig_line[i + 1]
    local next_ch = orig_line[i + 2]
    if ch == 47 and next_ch == 47 then
      break
    elseif ch == 47 and next_ch == 42 then
      local close = U.indexOf(orig_line, '*/', i + 2)
      i = close == -1 and #orig_line or close + 2
    elseif ch == 34 then
      local j = i + 1
      while j < #orig_line and orig_line[j + 1] ~= 34 do
        if orig_line[j + 1] == 92 then j = j + 1 end
        j = j + 1
      end
      literals[#literals + 1] = { start = i, finish = j }
      i = j + 1
    else
      i = i + 1
    end
  end
  local exact = {}
  for index, literal in ipairs(literals) do
    exact[index] = text(U.slice(orig_line, literal.start + 1, literal.finish))
  end
  local pasted = {}
  local k = 1
  while k <= #literals do
    local merged = text(U.slice(orig_line, literals[k].start + 1, literals[k].finish))
    local m = k + 1
    while m <= #literals do
      local gap = U.slice(orig_line, literals[m - 1].finish + 1, literals[m].start)
      if not re.test(GAP, gap) then break end
      merged = merged .. text(U.slice(orig_line, literals[m].start + 1, literals[m].finish))
      m = m + 1
    end
    pasted[#pasted + 1] = merged
    k = m
  end
  return { exact = exact, pasted = pasted }
end

-- ---------------------------------------------------------------------------
-- Variable declarations
-- ---------------------------------------------------------------------------

local function expression_at(rest)
  local at = U.indexOf(rest, '=', 0)
  while at ~= -1 do
    if rest[at + 2] ~= 61 and at > 0 and re.test(EXPRESSION_MODIFIER_BEFORE, { rest[at] }) then
      return at
    end
    at = U.indexOf(rest, '=', at + 1)
  end
  return -1
end

local function variable_declarators(mask, from, to, options)
  options = options or {}
  local out = {}
  local limit = options.stopAt == nil and to or math.min(to, options.stopAt)
  local depth = 0
  local piece_start = from
  local index = 0
  for at = from, limit - 1 do
    local ch = mask[at + 1]
    if ch == 40 or ch == 91 or ch == 123 or ch == 60 then
      depth = depth + 1
    elseif ch == 41 or ch == 93 or ch == 125 or ch == 62 then
      if depth > 0 then depth = depth - 1 end
    elseif ch == 44 or ch == 59 then
      if depth == 0 then
        local declared = M.parse_variable(mask, piece_start, at, index > 0 and options.inherited == true)
        if declared then out[#out + 1] = declared end
        piece_start = at + 1
        index = index + 1
      end
    end
  end
  local trailing = M.parse_variable(mask, piece_start, limit, index > 0 and options.inherited == true)
  if trailing then out[#out + 1] = trailing end
  return out
end

local function skip_annotation(mask, at, to)
  local slice = U.slice(mask, at + 1, to)
  local name = re.exec(WORD_ONLY, slice, 0)
  if not name then return -1 end
  local scan = at + 1 + (name.endpos - name.index)
  if mask[scan + 1] == 40 then
    local close = matching_bracket(mask, scan, ')')
    if close == -1 or close >= to then return -1 end
    scan = close + 1
  end
  return scan
end

local function type_token_end(mask, at, to)
  local limit = math.min(to, at + 200)
  local name = re.exec(TYPE_NAME, U.slice(mask, at, limit), 0)
  if not name then return -1 end
  local scan = at + (name.endpos - name.index)
  while true do
    local dot = re.exec(DOT_NAME, U.slice(mask, scan, math.min(to, scan + 200)), 0)
    if not dot then break end
    scan = scan + (dot.endpos - dot.index)
  end
  if mask[scan + 1] == 60 then
    local depth = 0
    local cursor = scan
    while cursor < to do
      local ch = mask[cursor + 1]
      if ch == 60 then
        depth = depth + 1
      elseif ch == 62 then
        depth = depth - 1
        if depth == 0 then cursor = cursor + 1; break end
      elseif ch == 59 or ch == 123 or ch == 125 or ch == 10 or ch == 61 then
        return -1
      end
      cursor = cursor + 1
    end
    if depth ~= 0 then return -1 end
    scan = cursor
  end
  while true do
    local brackets = re.exec(BRACKETS, U.slice(mask, scan, math.min(to, scan + 40)), 0)
    if not brackets then break end
    scan = scan + (brackets.endpos - brackets.index)
  end
  return scan
end

local function finish_variable(mask, name, name_at, after_name, to)
  local finish = to
  while finish > name_at and U.is_space(mask[finish]) do finish = finish - 1 end
  local equals_at = nil
  local depth = 0
  local scan = after_name
  while scan < finish do
    local ch = mask[scan + 1]
    if ch == 40 or ch == 91 or ch == 123 or ch == 60 then
      depth = depth + 1
    elseif ch == 41 or ch == 93 or ch == 125 or ch == 62 then
      if depth > 0 then depth = depth - 1 end
    elseif ch == 61 and depth == 0 and mask[scan + 2] ~= 61 and mask[scan] ~= 61 then
      equals_at = scan
      break
    elseif ch == 58 and depth == 0 then
      finish = name_at + #name
      break
    end
    scan = scan + 1
  end
  return {
    name = name,
    nameAt = name_at,
    equalsAt = equals_at,
    endpos = math.max(finish, name_at + #name),
  }
end

--- One declarator out of `mask[from, to)`.
function M.parse_variable(mask, from, to, type_optional)
  local at = from
  local typed = 0
  local untyped = type_optional or false
  while true do
    local rest = U.slice(mask, at, to)
    local trimmed = U.trimStart(rest)
    if #trimmed == 0 then return nil end
    at = at + (#rest - #trimmed)
    if mask[at + 1] == 64 then
      local next_at = skip_annotation(mask, at, to)
      if next_at == -1 then return nil end
      at = next_at
    else
      local word_match = re.exec(WORD_START, U.slice(mask, at, to), 0)
      if not word_match then return nil end
      -- `WORD_START` has no capture group: the word is the whole match.
      local word = text(U.slice(mask, at + word_match.index, at + word_match.endpos))
      local type_end = type_token_end(mask, at, to)
      local after = type_end == -1 and at + #word or type_end
      local tail = U.slice(mask, after, to)
      local tail_trimmed = U.trimStart(tail)
      local next_at = after + (#tail - #tail_trimmed)
      local next_ch = next_at >= to and '' or unit_text_at(mask, next_at)
      local ends_here = next_ch == '' or next_ch == '=' or next_ch == ':'
        or next_ch == ',' or next_ch == ';' or next_ch == ')'
      if ends_here and (typed > 0 or untyped) then
        return finish_variable(mask, word, at, after, to)
      end
      if DECLARATION_MODIFIERS[word] then
        if word == 'const' or word == 'let' or word == 'var' then untyped = true end
        at = after
      elseif type_end == -1 then
        return nil
      else
        typed = typed + 1
        if next_at >= to then return nil end
        at = next_at
      end
    end
  end
end

local function top_level_index_of(mask, from, to, char)
  local depth = 0
  for at = from, to - 1 do
    local ch = mask[at + 1]
    if ch == 40 or ch == 91 or ch == 123 or ch == 60 then
      depth = depth + 1
    elseif ch == 41 or ch == 93 or ch == 125 or ch == 62 then
      if depth > 0 then depth = depth - 1 end
    elseif ch == char:byte(1) and depth == 0 then
      return at
    end
  end
  return -1
end

local function header_variables(mask, from, to, keyword)
  local open = U.indexOf(mask, '(', from)
  if open == -1 or open >= to then return {} end
  local close = matching_bracket(mask, open, ')')
  if close == -1 or close > to then return {} end
  if keyword == 'for' then
    local colon = top_level_index_of(mask, open + 1, close, ':')
    local semicolon = top_level_index_of(mask, open + 1, close, ';')
    local finish = colon ~= -1 and colon or (semicolon ~= -1 and semicolon or close)
    return variable_declarators(mask, open + 1, finish)
  end
  return variable_declarators(mask, open + 1, close)
end

local function declare_variable(parent, variable, starts, blocks)
  local block = M.make_block('property', variable.name, line_of(starts, variable.nameAt))
  block.lineEnd = line_of(starts, math.max(variable.nameAt, variable.endpos - 1))
  block.equalsAt = variable.equalsAt
  block.statementTo = variable.endpos
  block.parent = parent
  block.scope = parent
  block.scopeName = parent.name
  block.scopeLine = parent.declLine
  parent.children[#parent.children + 1] = block
  parent.blocks[#parent.blocks + 1] = block
  blocks[#blocks + 1] = block
  return block
end

-- ---------------------------------------------------------------------------
-- Statement and header spans
-- ---------------------------------------------------------------------------

local function statement_end(masked, starts, from, to, equals, source_lines)
  local decl_line = line_of(starts, from)
  local indent = indent_width(U.slice(masked, from, end_of_line(masked, from)))
  local function next_text_line(line)
    for at = line, #source_lines - 1 do
      if text(U.trim(source_lines[at + 1])) ~= '' then return at end
    end
    return -1
  end

  local depth = 0
  local last = from
  local content_end = from
  local line = decl_line
  while line < #starts and starts[line + 1] < to do
    local line_start = math.max(starts[line + 1], from)
    local line_end = math.min(end_of_line(source_lines[line + 1], 0) + starts[line + 1], to)
    local in_literal = line > decl_line
      and text(U.trim(U.slice(masked, line_start, line_end))) == ''
      and text(U.trim(source_lines[line + 1])) ~= ''
    if line > decl_line and text(U.trim(source_lines[line + 1])) == '' then break end
    if in_literal then
      last = math.max(last, line_end)
      content_end = line_start + #U.trimEnd(source_lines[line + 1])
      line = line + 1
    else
      local stop = false
      for at = line_start, line_end - 1 do
        local char = masked[at + 1]
        if char == 40 or char == 91 or char == 123 then
          depth = depth + 1
        elseif char == 41 or char == 93 or char == 125 then
          if depth == 0 then stop = true; break end
          depth = depth - 1
        elseif char == 59 and depth == 0 then
          return { initializerEnd = at, last = line_of(starts, at), lineEnd = at + 1, equals = equals }
        end
      end
      last = math.max(last, line_end)
      local trimmed = U.trimEnd(source_lines[line + 1])
      if #trimmed > 0 then content_end = starts[line + 1] + #trimmed end
      if stop then break end
      if line > decl_line and depth == 0 then
        if not re.test(CONTINUES_AFTER, U.slice(masked, line_start, line_end)) then
          local next_line = next_text_line(line + 1)
          if next_line == -1 then break end
          if indent_width(source_lines[next_line + 1]) <= indent then break end
        end
      end
      line = line + 1
    end
  end
  local block_end = math.max(last, content_end)
  return {
    initializerEnd = content_end == from and block_end or content_end,
    last = line_of(starts, block_end),
    lineEnd = block_end,
    equals = equals,
  }
end

local function header_end(lex, line, from)
  local mask_lines, starts = lex.maskLines, lex.starts
  local stop = math.min(#mask_lines - 1, line + HEADER_LINES - 1)
  local depth = 0
  local start = from
  local i = line
  while i <= stop do
    local value = mask_lines[i + 1]
    if i > line and text(U.trim(value)) == '' then break end
    if depth == 0 then depth = M.bracket_depth(value, 0, start - starts[i + 1]) end
    local column = math.max(0, start - starts[i + 1])
    while column < #value do
      local char = value[column + 1]
      if depth == 0 and (char == 123 or char == 59) then
        return { endpos = starts[i + 1] + column + 1, last = i }
      end
      local previous = value[column]
      if char == 40 or char == 91 or char == 123 or char == 60 then
        depth = depth + 1
      elseif char == 41 or char == 93 or char == 125 then
        depth = depth - 1
      elseif char == 62 and previous ~= 61 and previous ~= 45 then
        depth = depth - 1
      end
      column = column + 1
    end
    if depth < 0 then depth = 0 end
    start = starts[i + 1] + #value
    local next_line = next_non_blank(mask_lines, i + 1)
    local word = re.test(WORD_TAIL, value)
    local tail = word and (re.test(THROWS_TAIL, value) or re.test(EXTENDS_TAIL, value))
    local continues = depth > 0 or re.test(HEADER_CONTINUES, value) or tail
      or (next_line ~= -1 and re.test(BRACE_LINE, mask_lines[next_line + 1]))
    if not continues then return { endpos = start, last = i } end
    i = i + 1
  end
  i = math.min(i, #mask_lines - 1)
  return { endpos = starts[i + 1] + #mask_lines[i + 1], last = i }
end

function M.bracket_depth(value, from, to)
  if to == nil then to = #value end
  local depth = 0
  for at = from, to - 1 do
    local char = value[at + 1]
    if char == 40 or char == 91 or char == 123 or char == 60 then
      depth = depth + 1
    elseif char == 41 or char == 93 or char == 125 or char == 62 then
      depth = depth - 1
    end
  end
  return depth
end

local function terminator_in(rest)
  local found = {}
  local brace = U.indexOf(rest, '{', 0)
  local semi = U.indexOf(rest, ';', 0)
  local arrow = U.indexOf(rest, '=>', 0)
  if brace ~= -1 then found[#found + 1] = { at = brace, kind = 'brace' } end
  if semi ~= -1 then found[#found + 1] = { at = semi, kind = 'none' } end
  if arrow ~= -1 then found[#found + 1] = { at = arrow, kind = 'arrow' } end
  table.sort(found, function(a, b) return a.at < b.at end)
  return found[1]
end

local function brace_body(masked, starts, open)
  local close = matching_bracket(masked, open, '}')
  if close == -1 then return nil end
  return { open = open, close = close, openLine = line_of(starts, open), closeLine = line_of(starts, close) }
end

local function expression_body(lines, starts, decl_line, at)
  local first = line_of(starts, at)
  local indent = indent_width(lines[decl_line + 1])
  local last = first > decl_line and first or decl_line
  if first > decl_line then
    for i = first + 1, #lines - 1 do
      if text(U.trim(lines[i + 1])) == '' then break end
      if indent_width(lines[i + 1]) <= indent then break end
      last = i
    end
  end
  return { expression = at, expressionEndLine = last, open = nil, close = nil }
end

local function arrow_body(masked, starts, at)
  local brace = U.indexOf(masked, '{', at)
  local line_end = end_of_line(masked, at)
  if brace == -1 or brace > line_end then
    return { expression = at, open = nil, close = nil }
  end
  return brace_body(masked, starts, brace)
end

local function body_span(masked, lines, starts, decl_line, from, name_at, shape_at_body)
  name_at = name_at or from
  if shape_at_body and masked[from + 1] == 61 then
    return expression_body(lines, starts, decl_line, from + 1)
  end

  local header = header_end({ maskLines = lines, starts = starts }, decl_line, name_at)
  local rest = U.slice(masked, from, header.endpos)

  local arrow = U.indexOf(rest, '=>', 0)
  local arrow_at = arrow ~= -1 and from + arrow
    or ((masked[from + 1] == 61 or masked[from + 1] == 62) and from or -1)
  local arrow_here = arrow_at ~= -1 and math.max(0, arrow_at - from) or -1

  if arrow_here == -1 and masked[from] == 123 then return brace_body(masked, starts, from - 1) end

  if arrow_here ~= -1 then
    local at = from + arrow_here + 2
    local brace = U.indexOf(masked, '{', at)
    local line_end = end_of_line(masked, at)
    if brace == -1 or brace > line_end then
      return expression_body(lines, starts, decl_line, at)
    end
    return brace_body(masked, starts, brace)
  end

  local terminator = terminator_in(rest)
  if terminator ~= nil and terminator.kind == 'none' then return nil end
  if terminator ~= nil then
    local brace_at = U.indexOf(masked, '{', from)
    local at = math.max(brace_at, from + terminator.at)
    return brace_body(masked, starts, at)
  end

  local opened_at = U.lastIndexOf(masked, '{', header.endpos - 1)
  if opened_at >= from then return brace_body(masked, starts, opened_at) end

  local equals = expression_at(rest)
  if equals ~= -1 then return expression_body(lines, starts, decl_line, from + equals + 2) end
  local bare = U.indexOf(rest, '=', 0)
  if bare ~= -1 and rest[bare + 2] ~= 61 then
    return expression_body(lines, starts, decl_line, from + bare + 2)
  end

  local next_line = next_non_blank(lines, header.last + 1)
  local indent = indent_width(lines[decl_line + 1])
  if next_line == -1 then return nil end
  local first = lines[next_line + 1]
  if re.test(BRACE_LINE, first) then
    local brace_pos = U.indexOf(first, '{', 0)
    return brace_body(masked, starts, starts[next_line + 1] + brace_pos)
  end

  local search_from = math.max(next_line, header.last)
  local after = U.slice(masked, from, starts[search_from + 1] + #lines[search_from + 1])
  local deferred = terminator_in(after)
  if deferred ~= nil and deferred.kind == 'none' then return nil end
  if deferred ~= nil and deferred.kind == 'brace' then
    return brace_body(masked, starts, from + deferred.at)
  end

  if indent_width(first) > indent then
    local last = next_line
    for i = next_line + 1, #lines - 1 do
      if text(U.trim(lines[i + 1])) == '' then
        -- continue
      elseif indent_width(lines[i + 1]) <= indent then
        break
      else
        last = i
      end
    end
    return {
      indented = true, open = nil, close = nil,
      bodyEndLine = last, bodyFrom = math.max(next_line, header.last + 1),
    }
  end
  return nil
end

local function keyword_body(lines, decl_line, word)
  local indent = indent_width(lines[decl_line + 1])
  for i = decl_line + 1, #lines - 1 do
    local value = text(U.trim(lines[i + 1]))
    if value == '' then
      -- skip
    elseif indent_width(lines[i + 1]) > indent then
      -- skip
    elseif value == word or U.startsWith(U.from(value), word .. ' ') then
      return { openLine = decl_line, closeLine = i }
    else
      return nil
    end
  end
  return nil
end

-- Expose the helpers later sections use.
M.line_of = line_of
M.next_non_blank = next_non_blank
M.end_of_line = end_of_line
M.escape_regexp = escape_regexp
M.matching_bracket = matching_bracket
M.indent_width = indent_width
M.region_directive = region_directive
M.condition_literals = condition_literals
M.expression_at = expression_at
M.variable_declarators = variable_declarators
M.header_variables = header_variables
M.declare_variable = declare_variable
M.statement_end = statement_end
M.header_end = header_end
M.terminator_in = terminator_in
M.brace_body = brace_body
M.expression_body = expression_body
M.arrow_body = arrow_body
M.body_span = body_span
M.keyword_body = keyword_body

-- ---------------------------------------------------------------------------
-- Declaration matching
-- ---------------------------------------------------------------------------

local dynamic_cache = {}

local function dynamic(pattern)
  local compiled = dynamic_cache[pattern]
  if compiled == nil then
    compiled = re.compile(pattern, 'g')
    dynamic_cache[pattern] = compiled
  end
  return compiled
end

local function replace_func_prefix(trimmed)
  local match = re.exec(FUNC_ARG_PREFIX, trimmed, 0)
  if not match then return trimmed end
  return U.concat(U.from('func '), U.slice(trimmed, match.endpos, #trimmed))
end

local function find_word(units_value, word)
  local pattern = re.compile('\\b' .. word .. '\\b', '')
  local match = re.exec(pattern, units_value, 0)
  return match and match.index or -1
end

function M.declaration_on(masked_line, start, name, declared, lex)
  declared = declared or {}
  if name == '' or NOT_A_NAME[name] then return nil end

  for _, entry in ipairs(declared) do
    if entry.name == name then
      return {
        kind = entry.kind or 'method', name = name,
        nameAt = start + entry.headerFrom, headerFrom = start + entry.headerFrom,
      }
    end
  end

  local keyword = re.exec(DECLARATION_KEYWORD, masked_line, 0)
  if keyword then
    local keyword_name = re.group_text(masked_line, keyword, 1)
    if keyword_name == name then
      local after = start + keyword.endpos
      local full = U.slice(masked_line, keyword.index, keyword.endpos)
      local at = start + keyword.index + U.indexOf(full, name, 0)
      return { kind = 'class', name = name, nameAt = at, headerFrom = after }
    end
  end

  local call = dynamic(string.format('(^|[^\\w$.])%s\\s*\\(', escape_regexp(name)))
  for _, match in ipairs(re.exec_all(call, masked_line)) do
    local prefix_len = match.captures[1] and (match.captures[1][2] - match.captures[1][1]) or 0
    local before = U.slice(masked_line, 0, match.index + prefix_len)
    local prefix = replace_func_prefix(U.trim(before))
    if #prefix > 0 and (not re.test(PREFIX, prefix) or re.test(STATEMENT_BEFORE, prefix)) then
      -- not a declaration
    else
      local close = matching_bracket(masked_line, match.index + (match.endpos - match.index) - 1, ')')
      if close ~= -1 then
        return {
          kind = 'method', name = name,
          nameAt = start + match.index + prefix_len,
          headerFrom = start + close + 1,
        }
      end
    end
  end

  if lex ~= nil then
    local across = M.declaration_across(lex, start, name)
    if across ~= nil then return across end
  end

  local assigned = dynamic(string.format(
    '(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?%s\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?',
    escape_regexp(name)))
  for _, match in ipairs(re.exec_all(assigned, masked_line)) do
    local prefix_len = match.captures[1] and (match.captures[1][2] - match.captures[1][1]) or 0
    local after = match.endpos
    local rest = U.slice(masked_line, after, #masked_line)
    local arrow = U.indexOf(rest, '=>', 0)
    local fn = re.exec(re.compile([=[^function\b]=], ''), rest, 0)
    local start_at
    if arrow ~= -1 and (fn == nil or arrow < fn.index) then
      start_at = after + arrow
    elseif fn ~= nil then
      start_at = after + (fn.endpos - fn.index)
    else
      start_at = -1
    end
    if start_at ~= -1 then
      return {
        kind = 'method', name = name,
        nameAt = start + match.index + prefix_len,
        headerFrom = start + start_at,
      }
    end
  end
  return nil
end

function M.declaration_across(lex, start, name)
  local mask, mask_lines, starts = lex.mask, lex.maskLines, lex.starts
  local line = line_of(starts, start)
  local from = start + (#mask_lines[line + 1] - #U.trimStart(mask_lines[line + 1]))
  local header = header_end(lex, line, from)
  if header.last == line then return nil end
  local chunk = U.slice(mask, start, header.endpos)

  local open = dynamic(string.format('(^|[^\\w$.])%s\\s*\\(', escape_regexp(name)))
  for _, match in ipairs(re.exec_all(open, chunk)) do
    local prefix_len = match.captures[1] and (match.captures[1][2] - match.captures[1][1]) or 0
    local column = match.index + prefix_len
    local on = line_of(starts, start + column)
    local before = U.slice(mask_lines[on + 1], 0, start + column - starts[on + 1])
    local prefix = replace_func_prefix(U.trim(before))
    if #prefix > 0 and (not re.test(PREFIX, prefix) or re.test(STATEMENT_BEFORE, prefix)) then
      -- not a declaration
    else
      local close = matching_bracket(chunk, match.index + (match.endpos - match.index) - 1, ')')
      if close ~= -1 then
        return { kind = 'method', name = name, nameAt = start + column, headerFrom = start + close + 1 }
      end
    end
  end

  local assigned = dynamic(string.format(
    '(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?%s\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?',
    escape_regexp(name)))
  for _, match in ipairs(re.exec_all(assigned, chunk)) do
    local prefix_len = match.captures[1] and (match.captures[1][2] - match.captures[1][1]) or 0
    local column = match.index + prefix_len
    local on = line_of(starts, start + column)
    local before = U.slice(mask_lines[on + 1], 0, start + column - starts[on + 1])
    local prefix = U.trim(before)
    if #prefix > 0 and (not re.test(PREFIX, prefix) or re.test(STATEMENT_BEFORE, prefix)) then
      -- not a declaration
    else
      local rest = U.slice(chunk, match.endpos, #chunk)
      local arrow = U.indexOf(rest, '=>', 0)
      if arrow == -1 and not re.test(re.compile([=[^function\b]=], ''), rest) then
        -- not an arrow function
      else
        return {
          kind = 'method', name = name,
          nameAt = start + column,
          headerFrom = start + match.endpos + (arrow == -1 and 0 or arrow),
        }
      end
    end
  end
  return nil
end

-- ---------------------------------------------------------------------------
-- Chains and anchors
-- ---------------------------------------------------------------------------

local function make_segment(masked, starts, keyword, header_line, open, close, cond_from, shared_close)
  local line_start = starts[header_line + 1]
  return {
    headerKeyword = keyword,
    headerLine = header_line,
    open = open,
    close = close,
    condFrom = cond_from,
    condOffset = cond_from - line_start,
    sharedClose = shared_close or false,
    openLine = line_of(starts, open),
    closeLine = line_of(starts, close),
  }
end

local function chain_segments(masked, starts, header_line, keyword, brace_pos, keyword_offset)
  local segments = {}
  local function is_cont(word) return word == 'else' or word == 'catch' or word == 'finally' end
  local cur_keyword = keyword
  local cur_line = header_line
  local open = brace_pos
  local cond_from = keyword_offset
  local i = brace_pos
  local depth = 0
  local AFTER_CLOSE = 64
  while i < #masked do
    local c = masked[i + 1]
    if c == 123 then
      depth = depth + 1
      i = i + 1
    elseif c == 125 then
      depth = depth - 1
      if depth == 0 then
        local rest = U.slice(masked, i + 1, i + 1 + AFTER_CLOSE)
        local word = re.exec(REST_CONTINUATION, rest, 0)
        local cont = word and re.group_text(rest, word, 1)
        if cont ~= nil and not is_cont(cont) then cont = nil end
        if cont == 'else' and re.test(ELSE_IF, rest) then
          local new_open = U.indexOf(masked, '{', i + 1)
          segments[#segments + 1] = make_segment(masked, starts, cur_keyword, cur_line, open, i, cond_from, true)
          local if_at = find_word(rest, 'if')
          cur_keyword = 'if'
          cur_line = line_of(starts, i)
          open = new_open
          cond_from = (i + 1) + if_at
          i = new_open + 1
          depth = 1
        elseif cont ~= nil then
          local new_open = U.indexOf(masked, '{', i + 1)
          segments[#segments + 1] = make_segment(masked, starts, cur_keyword, cur_line, open, i, cond_from, true)
          cur_keyword = cont
          cur_line = line_of(starts, i)
          open = new_open
          cond_from = (i + 1) + word.index
          i = new_open + 1
          depth = 1
        else
          local finish = i
          if cur_keyword == 'do' and re.test(WHILE_AFTER_DO, rest) then
            local semi = U.indexOf(masked, ';', i)
            if semi ~= -1 and semi < end_of_line(masked, i) then finish = semi end
          end
          segments[#segments + 1] = make_segment(masked, starts, cur_keyword, cur_line, open, finish, cond_from, false)
          return segments
        end
      else
        i = i + 1
      end
    else
      i = i + 1
    end
  end
  segments[#segments + 1] = make_segment(masked, starts, cur_keyword, cur_line, open, #masked - 1, cond_from)
  return segments
end

local function leading_anchor(comments, source, lines, starts, open)
  if open == nil then return nil end
  local first = nil
  for _, comment in ipairs(comments) do
    if comment.from > open then
      if re.test(re.compile([=[^\s*$]=], ''), U.slice(source, open + 1, comment.from)) then
        first = comment
        break
      end
    end
  end
  if not first then return nil end
  local comment_line = line_of(starts, first.from)
  local brace_line = line_of(starts, open)
  if comment_line ~= brace_line and comment_line ~= next_non_blank(lines, brace_line + 1) then
    return nil
  end
  local body = U.trim(first.text)
  if re.test(REGION_BODY, body) then return nil end
  local name = re.exec(ANCHOR_NAME, body, 0)
  if not name then return nil end
  return { name = re.group_text(body, name, 1), line = comment_line }
end

local function annotation_start(lines, decl_line, is_annotation)
  is_annotation = is_annotation or function(line) return re.test(ANNOTATION_LINE, line) end
  local found = -1
  for i = decl_line - 1, 0, -1 do
    if text(U.trim(lines[i + 1])) == '' then break end
    if is_annotation(lines[i + 1]) then
      found = i
      break
    end
  end
  if found == -1 then return -1 end
  local start = found
  for i = found - 1, 0, -1 do
    if text(U.trim(lines[i + 1])) == '' or not is_annotation(lines[i + 1]) then break end
    start = i
  end
  -- `bracketBalance` in the JavaScript counts only (), [] and {}; an angle
  -- bracket is a Haskell type signature's arrow, not a bracket.
  local depth = 0
  for i = start, decl_line - 1 do
    if depth == 0 and not is_annotation(lines[i + 1]) then return -1 end
    for at = 1, #lines[i + 1] do
      local char = lines[i + 1][at]
      if char == 40 or char == 91 or char == 123 then
        depth = depth + 1
      elseif char == 41 or char == 93 or char == 125 then
        depth = depth - 1
      end
    end
  end
  if depth ~= 0 then return -1 end
  return start
end

local function doc_comment_start(lines, top)
  local previous = top - 1
  if previous < 0 or text(U.trim(lines[previous + 1])) == '' then return -1 end
  if re.test(DOC_RUN, lines[previous + 1]) then
    local start = previous
    while start - 1 >= 0 and re.test(DOC_RUN, lines[start]) do start = start - 1 end
    return start
  end
  if not re.test(re.compile([=[\*/\s*$]=], ''), lines[previous + 1]) then return -1 end
  for i = previous, 0, -1 do
    if text(U.trim(lines[i + 1])) == '' then return -1 end
    if re.test(DOC_OPEN, lines[i + 1]) then return i end
  end
  return -1
end

-- ---------------------------------------------------------------------------
-- Rendering a declaration
-- ---------------------------------------------------------------------------

local function span(lines, from_line, to_line)
  local from = from_line + 1
  -- A body-less declaration has `closeLine = null` in JavaScript; `null` acts
  -- as the declaration's own line in `Math.max`, and the slice is empty.
  local effective = to_line == nil and from_line or to_line
  return { text = U.to(U.join(lines, '\n')), from = from, to = math.max(from_line, effective) + 1 }
end

local function single(value, at)
  return { text = value, from = at + 1, to = at + 1 }
end

local function render_declaration(lines, source, starts, range, scope, is_annotation)
  local end_line = range.expressionEndLine or range.endLine or range.closeLine
  if scope == 'body' then
    if range.singleLine then
      return span(U.slice(lines, range.declLine, (end_line or 0) + 1), range.declLine, end_line)
    end
    if range.indented then
      local first = range.bodyFrom or (range.declLine + 1)
      return span(U.slice(lines, first, (end_line or 0) + 1), first, end_line)
    end
    if range.expression ~= nil then
      local at = line_of(starts, range.expression)
      local last = range.expressionEndLine or at
      if last > at then
        return span(U.slice(lines, at, last + 1), at, last)
      end
      return single(text(U.trim(U.slice(source, range.expression, end_of_line(source, range.expression)))), at)
    end
    if range.open ~= nil and range.openLine == end_line then
      return single(text(U.trim(U.slice(source, range.open + 1, range.close))), range.openLine)
    end
    return span(U.slice(lines, range.openLine + 1, end_line), range.openLine + 1, end_line - 1)
  end

  local start = range.declLine
  if scope == 'annotated' or scope == 'documented' then
    local annotated = annotation_start(lines, range.declLine, is_annotation)
    if annotated ~= -1 then start = annotated end
    if scope == 'documented' then
      local documented = doc_comment_start(lines, start)
      if documented ~= -1 then start = documented end
    end
  end
  return span(U.slice(lines, start, (end_line or 0) + 1), start, end_line)
end

-- ---------------------------------------------------------------------------
-- Block construction
-- ---------------------------------------------------------------------------

function M.make_block(kind, name, decl_line)
  return {
    kind = kind, name = name, declLine = decl_line,
    open = nil, close = nil, openLine = nil, closeLine = nil,
    indented = false, expression = nil,
    children = {}, blocks = {}, regions = {},
    anchor = nil, conditions = nil,
    parent = nil, scopeName = nil, scopeLine = nil,
    bodyFrom = nil,
  }
end

local function enum_constants(blk, leading, span_value, lex, blocks)
  if leading ~= 'enum' or not span_value or span_value.open == nil
    or span_value.close == nil or span_value.close <= span_value.open then
    return nil
  end
  local mask, starts = lex.mask, lex.starts
  local depth = 0
  local list_end = span_value.close
  local semicolon_line = -1
  for at = span_value.open + 1, span_value.close - 1 do
    local ch = mask[at + 1]
    if ch == 40 or ch == 91 or ch == 123 then
      depth = depth + 1
    elseif ch == 41 or ch == 93 or ch == 125 then
      depth = depth - 1
    elseif ch == 59 and depth == 0 then
      list_end = at
      semicolon_line = line_of(starts, at)
      break
    end
  end
  depth = 0
  local from = span_value.open + 1
  for at = span_value.open + 1, list_end do
    local ch = at == list_end and 44 or mask[at + 1]
    if ch == 40 or ch == 91 or ch == 123 then
      depth = depth + 1
    elseif ch == 41 or ch == 93 or ch == 125 then
      depth = depth - 1
    end
    if ch == 44 and depth == 0 then
      local tokens = M.constant_between(mask, from, at)
      from = at + 1
      if tokens ~= nil then
        local constant = M.make_block('property', tokens.name, line_of(starts, tokens.nameAt))
        constant.lineEnd = line_of(starts, math.max(tokens.nameAt, tokens.endpos - 1))
        constant.enumConstant = true
        constant.nameEnd = tokens.nameAt + #tokens.name
        constant.statementTo = tokens.endpos
        constant.parent = blk
        constant.scope = blk
        constant.scopeName = blk.name
        constant.scopeLine = blk.declLine
        blk.children[#blk.children + 1] = constant
        blk.blocks[#blk.blocks + 1] = constant
        blocks[#blocks + 1] = constant
      end
    end
  end
  if semicolon_line == -1 then return -1 end
  return semicolon_line + 1
end

function M.constant_between(mask, from, to)
  local line_from = from
  for at = from, to do
    if at ~= to and mask[at + 1] ~= 10 then
      -- continue scanning
    else
      local masked = U.slice(mask, line_from, at)
      local name = re.exec(re.compile([=[^\s*([A-Za-z_$][\w$]*)]=], ''), masked, 0)
      if name then
        local name_text = re.group_text(masked, name, 1)
        local name_at = line_from + U.indexOf(masked, name_text, 0)
        local last = to
        while last > name_at and U.is_space(mask[last]) do last = last - 1 end
        return { name = name_text, nameAt = name_at, endpos = math.max(name_at + #name_text, last) }
      end
      if re.test(re.compile([=[^case\b]=], ''), U.trim(masked)) then return nil end
      line_from = at + 1
    end
  end
  return nil
end

-- ---------------------------------------------------------------------------
-- The scope walk
-- ---------------------------------------------------------------------------

local function apply_span(blk, span_value)
  if not span_value then return end
  if span_value.indented then
    blk.indented = true
    local first = span_value.bodyFrom == nil and (blk.declLine + 1) or span_value.bodyFrom
    blk.bodyFrom = first
    blk.closeLine = span_value.bodyEndLine
    blk.endLine = span_value.bodyEndLine
    return
  end
  if span_value.expression ~= nil then
    blk.expression = span_value.expression
    if span_value.expressionEndLine ~= nil then blk.expressionEndLine = span_value.expressionEndLine end
    blk.endLine = nil
    return
  end
  blk.open = span_value.open
  blk.close = span_value.close
  blk.openLine = span_value.openLine
  blk.closeLine = span_value.closeLine
  blk.endLine = span_value.closeLine
end

local function end_line_of(span_value, decl_line)
  if not span_value then return decl_line end
  if span_value.closeLine ~= nil then return span_value.closeLine end
  if span_value.bodyEndLine ~= nil then return span_value.bodyEndLine end
  return decl_line
end

local function register(list, blk, blocks)
  list[#list + 1] = blk
  blocks[#blocks + 1] = blk
end

local function descend(blk, decl_line, span_value, lex, blocks)
  if not span_value or span_value.expression ~= nil or blk.kind == 'property' then return end
  local child_from, child_to
  if span_value.indented then
    child_from = decl_line + 1
    child_to = span_value.bodyEndLine
  elseif span_value.openLine ~= nil then
    child_from = span_value.openLine + 1
    child_to = span_value.closeLine - 1
  else
    return
  end
  if child_from > child_to then return end
  local children = M.build_scope(blk, child_from, child_to, lex, blocks)
  for _, child in ipairs(children) do
    child.parent = blk
    child.scope = blk
    child.scopeName = blk.name
    child.scopeLine = blk.declLine
  end
  for _, child in ipairs(children) do
    blk.children[#blk.children + 1] = child
    blk.blocks[#blk.blocks + 1] = child
  end
end

local function indent_anchor(comments, source, lines, starts, decl_line, body_from, body_to)
  local function first_of_line(comment)
    local line = line_of(starts, comment.from)
    return line == decl_line or re.test(re.compile([=[^\s*$]=], ''), U.slice(source, starts[line + 1], comment.from))
  end
  local first = nil
  for _, comment in ipairs(comments) do
    local line = line_of(starts, comment.from)
    if line < decl_line then
      -- skip
    elseif line > body_to then
      break
    elseif line ~= decl_line and line ~= next_non_blank(lines, decl_line + 1) then
      break
    else
      if first_of_line(comment) then first = comment end
      break
    end
  end
  if not first then return nil end
  local body = U.trim(first.text)
  if re.test(REGION_BODY, body) then return nil end
  local name = re.exec(ANCHOR_NAME, body, 0)
  if not name then return nil end
  return { name = re.group_text(body, name, 1), line = line_of(starts, first.from) }
end

local function header_anchor(lex, decl_line, name_end)
  local found = nil
  for _, comment in ipairs(lex.comments) do
    local line = line_of(lex.starts, comment.from)
    if line < decl_line then
      -- skip
    elseif line > decl_line then
      break
    elseif comment.from >= name_end then
      found = comment
      break
    end
  end
  if not found then return nil end
  local body = U.trim(found.text)
  if re.test(REGION_BODY, body) then return nil end
  local name = re.exec(ANCHOR_NAME, body, 0)
  if not name then return nil end
  return { name = re.group_text(body, name, 1), line = decl_line }
end

local function apply_anchor(blk, lex, span_value, name_end)
  if not span_value then return end
  if span_value.open ~= nil then
    local header_comment = (name_end == nil) and nil or header_anchor(lex, blk.declLine, name_end)
    local anchor = header_comment
      or leading_anchor(lex.comments, lex.source, lex.lines, lex.starts, span_value.open)
    if anchor then blk.anchor = anchor end
    return
  end
  local from = span_value.bodyFrom == nil and (blk.declLine + 1) or span_value.bodyFrom
  local to = span_value.bodyEndLine == nil and blk.declLine or span_value.bodyEndLine
  local anchor = indent_anchor(lex.comments, lex.source, lex.lines, lex.starts, blk.declLine, from, to)
  if anchor then blk.anchor = anchor end
end

function M.pair_regions(lines)
  local out = {}
  local stack = {}
  for index = 0, #lines - 1 do
    local directive = region_directive(lines[index + 1])
    if directive then
      if directive.kind == 'region' then
        stack[#stack + 1] = { name = directive.name, startLine = index }
      elseif #stack > 0 then
        local open = table.remove(stack)
        out[#out + 1] = { name = open.name, startLine = open.startLine, endLine = index }
      end
    end
  end
  return out
end

-- ---------------------------------------------------------------------------
-- buildScope
-- ---------------------------------------------------------------------------

function M.build_scope(owner, from_line, to_line, lex, blocks)
  local mask, mask_lines, source, lines, starts, comments = lex.mask, lex.maskLines, lex.source, lex.lines, lex.starts, lex.comments
  local list = {}
  local i = from_line
  while i <= to_line do
    local m_line = mask_lines[i + 1]
    if text(U.trim(m_line)) == '' then
      i = i + 1
    else
      local start = starts[i + 1]

      local declared = lex.declarations and lex.declarations(m_line) or {}
      local declared_here = {}
      for _, entry in ipairs(declared) do
        if entry.name and not NOT_A_NAME[entry.name] then
          declared_here[#declared_here + 1] = entry
        end
      end
      local function declared_on(name)
        return M.declaration_on(m_line, start, name, {}, lex)
      end

      if #declared_here > 0 then
        local last_end = i
        for _, entry in ipairs(declared_here) do
          local is_line_shape = entry.line == true
          local span_value = nil
          local name_end = -1
          if is_line_shape then
            local eq = U.indexOf(m_line, '=', 0)
            local first = i
            local last = i
            if eq ~= -1 then
              first = line_of(starts, starts[i + 1] + eq + 1)
              last = first
              local indent = indent_width(lines[i + 1])
              for at = first + 1, #lines - 1 do
                if text(U.trim(lines[at + 1])) == '' then break end
                if indent_width(lines[at + 1]) <= indent then break end
                last = at
              end
            end
            span_value = { indented = true, open = nil, close = nil, bodyEndLine = last, bodyFrom = first }
          end
          if entry.body == 'end' then
            span_value = keyword_body(lines, i, entry.end_word or entry['end'] or 'end')
          elseif not is_line_shape then
            local name_at = start + U.indexOf(m_line, entry.name, 0)
            name_end = name_at + #entry.name
            local at = start + entry.headerFrom
            local opened = -1
            if mask[at + 1] == 123 then
              opened = at
            elseif mask[at] == 123 then
              opened = at - 1
            end
            if mask[at + 1] == 61 then
              span_value = expression_body(lines, starts, i, at + 1)
            elseif opened ~= -1 then
              span_value = body_span(mask, mask_lines, starts, i, opened, name_at)
            else
              span_value = body_span(mask, mask_lines, starts, i, at, name_at)
            end
          end
          local blk = M.make_block(entry.kind or 'method', entry.name, i)
          if span_value then
            apply_span(blk, span_value)
            if span_value.expressionEndLine ~= nil then blk.expressionEndLine = span_value.expressionEndLine end
          elseif entry.line then
            blk.endLine = i
            blk.singleLine = true
          else
            blk = nil
          end
          if blk then
            apply_anchor(blk, lex, span_value, name_end)
            register(list, blk, blocks)
            descend(blk, i, span_value, lex, blocks)
            last_end = math.max(last_end, end_line_of(span_value, i))
          end
        end
        i = last_end + 1
      else
        local keyword = re.exec(DECLARATION_KEYWORD, m_line, 0)
        if keyword then
          local full = U.slice(m_line, keyword.index, keyword.endpos)
          local spelled = {}
          for word in text(U.trim(full)):gmatch('%S+') do spelled[#spelled + 1] = word end
          local name = re.group_text(m_line, keyword, 1)
          local name_offset = keyword.index + U.indexOf(full, name, 0)
          local kotlin_enum = #spelled == 2 and spelled[1] == 'enum' and spelled[2] == 'class'
          if kotlin_enum then
            local declared_enum = re.exec(re.compile([=[^enum\s+class\s+([A-Za-z_$][\w$]*)]=], ''),
              U.slice(m_line, keyword.index, #m_line), 0)
            if not declared_enum then
              i = i + 1
              goto continue
            end
            name = re.group_text(U.slice(m_line, keyword.index, #m_line), declared_enum, 1)
            name_offset = keyword.index + (declared_enum.endpos - declared_enum.index) - #name
          end
          if NOT_A_NAME[name] or DECLARED_NAME_WORDS[name] then
            i = i + 1
            goto continue
          end
          local name_at = start + name_offset
          local after = name_at + #name
          local span_value = body_span(mask, mask_lines, starts, i, after, name_at)
          local blk = M.make_block('class', name, i)
          apply_span(blk, span_value)
          local enum_body_from = enum_constants(blk, spelled[1], span_value, lex, blocks)
          apply_anchor(blk, lex, span_value, -1)
          register(list, blk, blocks)
          if enum_body_from == nil then
            descend(blk, i, span_value, lex, blocks)
          elseif enum_body_from ~= -1 then
            local copy = {}
            for key, value in pairs(span_value or {}) do copy[key] = value end
            copy.openLine = enum_body_from - 1
            descend(blk, i, copy, lex, blocks)
          end
          i = end_line_of(span_value, i) + 1
        else
          local method_decl, method_name_at, method_from, method_has_prefix = nil, -1, -1, false
          local call_match = re.compile([=[(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(]=], 'g')
          for _, cm in ipairs(re.exec_all(call_match, m_line)) do
            local nm = re.group_text(m_line, cm, 2)
            local prefix_len = cm.captures[1] and (cm.captures[1][2] - cm.captures[1][1]) or 0
            local before = U.slice(m_line, 0, cm.index + prefix_len)
            local prefix = replace_func_prefix(U.trim(before))
            local skip = false
            if NOT_A_NAME[nm] then skip = true end
            if not skip and #prefix > 0 and (not re.test(PREFIX, prefix) or re.test(STATEMENT_BEFORE, prefix)) then
              skip = true
            end
            if not skip and U.startsWith(prefix, '@') then skip = true end
            if not skip then
              local found = declared_on(nm)
              if found and found.kind == 'method' then
                method_decl = found
                method_name_at = found.nameAt
                method_from = found.headerFrom
                method_has_prefix = #prefix > 0
                break
              end
            end
          end
          if not method_decl then
            local assigned_name = re.compile(
              [=[(^|[^\w$.])(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(?:async\s+)?(?:function\b|[^;]*=>)]=], 'g')
            for _, am in ipairs(re.exec_all(assigned_name, m_line)) do
              local found = M.declaration_on(m_line, start, re.group_text(m_line, am, 2))
              if found and found.kind == 'method' then
                method_decl = found
                method_name_at = found.nameAt
                method_from = found.headerFrom
                method_has_prefix = true
                break
              end
            end
          end
          if method_decl then
            local span_value = body_span(mask, mask_lines, starts, i, method_from, method_name_at)
            if not span_value and not method_has_prefix then
              i = i + 1
              goto continue
            end
            local blk = M.make_block('method', method_decl.name, i)
            apply_span(blk, span_value)
            local list_open = U.indexOf(mask, '(', method_name_at)
            local list_close = list_open == -1 and -1 or matching_bracket(mask, list_open, ')')
            if list_close > list_open then
              for _, variable in ipairs(variable_declarators(mask, list_open + 1, list_close)) do
                declare_variable(blk, variable, starts, blocks)
              end
            end
            apply_anchor(blk, lex, span_value, -1)
            register(list, blk, blocks)
            descend(blk, i, span_value, lex, blocks)
            i = end_line_of(span_value, i) + 1
          else
            local stmt = re.exec(STATEMENT_KEYWORD, m_line, 0)
            if stmt then
              local brace_pos = U.indexOf(mask, '{', start)
              if brace_pos ~= -1 then
                local segs = chain_segments(mask, starts, i, re.group_text(m_line, stmt, 1),
                  brace_pos, start + stmt.index)
                local last_close_line = i
                for _, seg in ipairs(segs) do
                  local blk = M.make_block('statement', nil, seg.headerLine)
                  blk.open = seg.open
                  blk.close = seg.close
                  blk.openLine = seg.openLine
                  blk.closeLine = seg.closeLine
                  blk.sharedClose = seg.sharedClose
                  blk.endLine = seg.closeLine
                  local hdr_start = starts[seg.headerLine + 1]
                  local hdr_end = end_of_line(mask, hdr_start)
                  local cond_line = U.slice(source, hdr_start, hdr_end)
                  blk.conditions = lex.conditionLiterals(cond_line, seg.condOffset)
                  for _, variable in ipairs(header_variables(mask, hdr_start, hdr_end, seg.headerKeyword)) do
                    declare_variable(blk, variable, starts, blocks)
                  end
                  apply_anchor(blk, lex, seg, seg.open + 1)
                  register(list, blk, blocks)
                  descend(blk, seg.headerLine, { openLine = seg.openLine, closeLine = seg.closeLine }, lex, blocks)
                  last_close_line = math.max(last_close_line, seg.closeLine)
                end
                i = last_close_line + 1
              else
                local indent = indent_width(m_line)
                local body_from = i + 1
                local body_end_line = i
                for k = body_from, #lines - 1 do
                  if text(U.trim(lines[k + 1])) == '' then
                    -- skip
                  elseif indent_width(lines[k + 1]) <= indent then
                    break
                  else
                    body_end_line = k
                  end
                end
                if body_end_line > i then
                  local blk = M.make_block('statement', nil, i)
                  local span_value = { indented = true, bodyFrom = body_from, bodyEndLine = body_end_line }
                  apply_span(blk, span_value)
                  local hdr_end = end_of_line(mask, start)
                  blk.conditions = lex.conditionLiterals(U.slice(source, start, hdr_end), stmt.index)
                  apply_anchor(blk, lex, span_value, -1)
                  register(list, blk, blocks)
                  descend(blk, i, span_value, lex, blocks)
                  i = body_end_line + 1
                else
                  i = i + 1
                end
              end
            else
              local declared_variable = M.parse_variable(m_line, 0, #m_line)
              local variable_prefix = nil
              if declared_variable then
                variable_prefix = U.trim(U.slice(m_line, 0, declared_variable.nameAt))
              end
              local variable_is_statement = false
              if variable_prefix ~= nil then
                local first_word = text(variable_prefix):match('^%S+') or ''
                variable_is_statement = NOT_A_TYPE[first_word] or re.test(STATEMENT_KEYWORD_AT_START, variable_prefix)
              end
              if declared_variable and not NOT_A_NAME[declared_variable.name]
                and not variable_is_statement
                and not re.test(STATEMENT_BEFORE, U.trim(U.concat(variable_prefix,
                  U.concat(U.from(' '), U.from(declared_variable.name))))) then
                local statement = statement_end(mask, starts, start, #mask,
                  declared_variable.equalsAt or -1, lines)
                local declared_vars = variable_declarators(mask, start, statement.lineEnd - 1,
                  { inherited = true })
                for index, variable in ipairs(declared_vars) do
                  local blk = declare_variable(owner, variable, starts, blocks)
                  if index == #declared_vars then
                    blk.lineEnd = statement.last
                    blk.statementTo = statement.initializerEnd
                  end
                end
                i = math.max(i, statement.last) + 1
              else
                i = i + 1
              end
            end
          end
        end
      end
      ::continue::
    end
  end
  return list
end

M.apply_span = apply_span
M.end_line_of = end_line_of
M.register = register
M.descend = descend
M.indent_anchor = indent_anchor
M.apply_anchor = apply_anchor
M.header_anchor = header_anchor
M.annotation_start = annotation_start
M.doc_comment_start = doc_comment_start
M.render_declaration = render_declaration
M.span = span
M.single = single
M.leading_anchor = leading_anchor
M.chain_segments = chain_segments
M.make_segment = make_segment
M.enum_constants = enum_constants

return M
