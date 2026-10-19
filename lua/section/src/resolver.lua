-- The resolve layer, ported from `lib/section.mjs`.
--
-- Matcher precedence, the sibling-first walk, per-selector scopes, envelopes,
-- line ranges and the exact failure messages all live here. It is the same
-- algorithm as the JavaScript; the ports' corpus is what keeps it honest.

local U = require('section.src.units')
local errors = require('section.src.errors')
local parser = require('section.src.parser')
local scanner = require('section.src.scanner')
local scan_module = require('section.src.scan')

local ERROR_CODES = errors.ERROR_CODES

local M = {}

local function text(units) return U.to(units) end

local function normalize_source(value)
  local source = type(value) == 'table' and value or U.from(value)
  local out = {}
  for i = 1, #source do
    local unit = source[i]
    if unit == 13 and source[i + 1] == 10 then
      -- drop the CR of a CRLF pair
    else
      out[#out + 1] = unit
    end
  end
  return out
end

local function contains(list, value)
  for _, item in ipairs(list or {}) do
    if item == value then return true end
  end
  return false
end

local function line_range_span(lex, range, raw)
  local source, lines, starts = lex.source, lex.lines, lex.starts
  local from_line = range.from.line
  local to = range.to or range.from
  local to_line = to.line
  local total = #source == 0 and 0 or #lines
  if from_line > total or to_line > total then
    errors.raise(errors.resolution_error(ERROR_CODES.LINE_RANGE_PAST_END,
      string.format('"#%s": the file has %d line(s)', raw, total), { selector = raw }))
  end
  if range.from.column ~= nil and range.from.column - 1 >= #lines[from_line] then
    errors.raise(errors.resolution_error(ERROR_CODES.LINE_RANGE_COLUMN_PAST_END,
      string.format('"#%s": line %d has %d character(s)', raw, from_line, #lines[from_line]),
      { selector = raw }))
  end
  local start = starts[from_line] + (range.from.column == nil and 0 or range.from.column - 1)
  local finish
  if range.to ~= nil and range.to.column ~= nil then
    if range.to.column - 1 >= #lines[to_line] then
      errors.raise(errors.resolution_error(ERROR_CODES.LINE_RANGE_COLUMN_PAST_END,
        string.format('"#%s": line %d has %d character(s)', raw, to_line, #lines[to_line]),
        { selector = raw }))
    end
    finish = starts[to_line] + range.to.column
  else
    finish = scanner.end_of_line(source, starts[to_line])
  end
  return {
    text = text(U.slice(source, start, finish)),
    range = { from = from_line, to = to_line },
  }
end

local function span(lines, from_line, to_line)
  return scanner.span(lines, from_line, to_line)
end

local function single(value, at)
  return scanner.single(value, at)
end

local function trimmed_slice(source, starts, from, to)
  local raw = U.slice(source, from, math.max(from, to))
  local value = U.trim(raw)
  local dropped = #raw - #U.trimEnd(raw)
  local at = math.min(#starts - 1, scanner.line_of(starts, math.min(from, #source)))
  if #value == 0 then return { text = '', from = at + 1, to = at + 1 } end
  local first = from + (#raw - #U.trimStart(raw))
  local last = math.max(first, to - dropped - 1)
  return {
    text = text(value),
    from = scanner.line_of(starts, first) + 1,
    to = scanner.line_of(starts, last) + 1,
  }
end

local function last_declaration_line(block)
  if block.endLine ~= nil then return block.endLine end
  if block.closeLine ~= nil then return block.closeLine end
  return block.declLine
end

local function render_block(block, scope, ctx, match_kind)
  local lines, source, starts = ctx.lines, ctx.source, ctx.starts
  local is_anchor = match_kind == 'anchor' or match_kind == 'condition'
  if not is_anchor and (block.kind == 'class' or block.kind == 'method') then
    return scanner.render_declaration(lines, source, starts, block, scope, ctx.annotationLine)
  end
  if not is_anchor and block.kind == 'property' then
    local last = (block.lineEnd == nil or block.lineEnd < block.declLine) and block.declLine or block.lineEnd
    if scope == 'body' then
      if block.enumConstant == true then
        local from = block.nameEnd or -1
        if from == -1 or from >= block.statementTo then return single('', block.declLine) end
        return trimmed_slice(source, starts, from, block.statementTo)
      end
      local at = block.equalsAt or -1
      if at == -1 or at >= block.statementTo then return single('', block.declLine) end
      return trimmed_slice(source, starts, at + 1, block.statementTo)
    end
    block.endLine = last
    return scanner.render_declaration(lines, source, starts, block, scope, ctx.annotationLine)
  end

  local anchor_line = block.anchor and block.anchor.line or nil
  local first_line = block.declLine
  local last_line = block.closeLine
  if scope == 'body' then
    local body_from = math.max(block.openLine, anchor_line == nil and block.openLine or anchor_line)
    if body_from >= block.closeLine then
      local raw = U.slice(source, block.open + 1, block.close)
      local trimmed = U.trim(raw)
      local skipped = #raw - #U.trimStart(raw)
      local dropped = #raw - #U.trimEnd(raw)
      local from = scanner.line_of(starts, block.open + 1 + skipped)
      local to = scanner.line_of(starts, block.close - dropped)
      return { text = text(trimmed), from = from + 1, to = math.max(from, to) + 1 }
    end
    return span(U.slice(lines, body_from + 1, block.closeLine), body_from + 1, block.closeLine - 1)
  end
  if block.sharedClose then
    local raw = U.slice(source, starts[first_line + 1], block.close + 1)
    local parts = U.split(raw, '\n')
    local trimmed = {}
    for index, part in ipairs(parts) do trimmed[index] = U.trimEnd(part) end
    return span(trimmed, first_line, scanner.line_of(starts, block.close))
  end
  return span(U.slice(lines, first_line, last_line + 1), first_line, last_line)
end

local function slice_ranges(range, value, lead)
  if lead <= 0 or lead >= #value then return { range } end
  local lines_taken = #U.split(U.from(value:sub(lead + 1)), '\n')
  return {
    { from = range.from, to = range.from },
    { from = math.max(range.from + 1, range.to - lines_taken + 1), to = range.to },
  }
end

local function match_segment(scope, segment, descended)
  local regions = {}
  for _, region in ipairs(scope.regions) do
    if region.name == segment then regions[#regions + 1] = region end
  end
  if #regions > 1 then
    errors.raise(errors.resolution_error(ERROR_CODES.REGION_DUPLICATED,
      string.format('"#region %s" appears %d times; region names must be unique', segment, #regions),
      { selector = segment, scope = scope.name }))
  end
  if #regions == 1 then return { { region = regions[1] } } end

  if descended and scope.anchor and scope.anchor.name == segment then
    return { { kind = 'anchor', block = scope, headerLine = scope.anchor.line } }
  end

  local function named(kind)
    local out = {}
    for _, block in ipairs(scope.children) do
      if block.kind == kind and block.name == segment then out[#out + 1] = block end
    end
    return out
  end
  local class = named('class')
  if #class > 0 then
    local out = {}
    for _, block in ipairs(class) do out[#out + 1] = { kind = 'declaration', block = block } end
    return out
  end
  local method = named('method')
  if #method > 0 then
    local out = {}
    for _, block in ipairs(method) do out[#out + 1] = { kind = 'declaration', block = block } end
    return out
  end
  local property = named('property')
  if #property > 0 then
    local out = {}
    for _, block in ipairs(property) do out[#out + 1] = { kind = 'property', block = block } end
    return out
  end

  if scope.kind == 'statement' and scope.conditions
    and contains(scope.conditions.pasted, segment) then
    return { { kind = 'condition', block = scope, headerLine = scope.declLine } }
  end
  local conditions = {}
  for _, child in ipairs(scope.children) do
    if child.kind == 'statement' and child.conditions
      and contains(child.conditions.pasted, segment) then
      conditions[#conditions + 1] = { kind = 'condition', block = child, headerLine = child.declLine }
    end
  end
  if #conditions > 0 then return conditions end

  local anchored = {}
  for _, block in ipairs(scope.children) do
    if block.anchor and block.anchor.name == segment then
      anchored[#anchored + 1] = { kind = 'anchor', block = block, headerLine = block.anchor.line }
    end
  end
  if #anchored > 0 then return anchored end
  return {}
end

local function is_container(block)
  if block.kind == 'property' then return false end
  return #block.children > 0 or block.indented == true
    or (block.openLine ~= nil and block.openLine < block.closeLine)
end

local function search_segments(segment, scope, descended)
  local level = { { scope = scope, descended = descended } }
  while #level > 0 do
    local hits = {}
    for _, node in ipairs(level) do
      for _, hit in ipairs(match_segment(node.scope, segment, node.descended)) do
        hits[#hits + 1] = hit
      end
    end
    if #hits > 0 then return hits end
    local deeper = {}
    for _, node in ipairs(level) do
      for _, child in ipairs(node.scope.children) do
        deeper[#deeper + 1] = { scope = child, descended = true }
      end
    end
    level = deeper
  end
  return {}
end

local function resolve_path(segments, index, scope, descended, prev_name)
  local segment = segments[index + 1]
  local last = index == #segments - 1
  local candidates = search_segments(segment, scope, descended)

  if #candidates == 0 then
    if index == 0 and last then
      errors.raise(errors.resolution_error(ERROR_CODES.NOT_FOUND,
        string.format('no "#region %s" found, and no section named "%s"', segment, segment),
        { selector = segment, scope = '<file>' }))
    end
    errors.raise(errors.resolution_error(ERROR_CODES.NOT_FOUND,
      string.format('no section named "%s" in "%s"', segment, prev_name or ''),
      { selector = segment, scope = prev_name or '<file>' }))
  end

  if last and #candidates > 1 then
    local blocks = {}
    for _, found in ipairs(candidates) do blocks[#blocks + 1] = found.block end
    errors.raise(errors.resolution_error(ERROR_CODES.AMBIGUOUS,
      string.format('"%s" is declared %d times; names must be unique', segment, #candidates),
      { selector = segment, scope = scope.name, candidates = errors.candidate_info(blocks) }))
  end

  local failure = nil
  local matched = nil
  for _, found in ipairs(candidates) do
    if last then return found end
    if found.region or not is_container(found.block) then
      if failure == nil then
        failure = errors.resolution_error(ERROR_CODES.NOT_A_CONTAINER,
          string.format('"%s" is not a container', segment),
          { selector = segment, scope = scope.name })
      end
    else
      local ok, resolved = pcall(resolve_path, segments, index + 1, found.block, true, segment)
      if not ok then
        if failure == nil then failure = resolved end
      else
        if matched ~= nil then
          local blocks = {}
          for _, candidate in ipairs(candidates) do blocks[#blocks + 1] = candidate.block end
          errors.raise(errors.resolution_error(ERROR_CODES.AMBIGUOUS,
            string.format('"%s" is declared %d times; names must be unique', segment, #candidates),
            { selector = segment, scope = scope.name, candidates = errors.candidate_info(blocks) }))
        end
        matched = resolved
      end
    end
  end
  if matched ~= nil then return matched end
  errors.raise(failure)
end

local function resolve_within(block, segments)
  if #segments == 1 then
    local candidates = match_segment(block, segments[1], true)
    if #candidates == 0 then
      errors.raise(errors.resolution_error(ERROR_CODES.NOT_FOUND,
        string.format('no section named "%s" in "%s"', segments[1], block.name),
        { selector = segments[1], scope = block.name }))
    end
    if #candidates > 1 then
      local blocks = {}
      for _, found in ipairs(candidates) do blocks[#blocks + 1] = found.block end
      errors.raise(errors.resolution_error(ERROR_CODES.AMBIGUOUS,
        string.format('"%s" is declared %d times; names must be unique', segments[1], #candidates),
        { selector = segments[1], scope = block.name, candidates = errors.candidate_info(blocks) }))
    end
    return candidates[1]
  end
  return resolve_path(segments, 1, block, true, block.name)
end

local function selector_part(selector, scope, scan, ctx)
  local final
  local ok, value = pcall(function()
    if scope == scan.root then
      return resolve_path(selector.segments, 0, scope, false, nil)
    end
    return resolve_within(scope, selector.segments)
  end)
  if not ok then
    if scope == scan.root then errors.raise(value) end
    local relayed = errors.resolution_error(value.code, value.message,
      { selector = selector.raw, scope = scope.name, candidates = value.candidates })
    errors.raise(relayed)
  end
  final = value

  local rendered, slice, kind
  local lines, source, starts = scan.lex.lines, scan.lex.source, scan.lex.starts
  if final.region then
    -- A region is the whole marked span: the opening directive through the
    -- closing one, like a declaration with its signature. `/-` is the body.
    if selector.scope == 'body' then
      rendered = span(U.slice(lines, final.region.startLine + 1, final.region.endLine),
        final.region.startLine + 1, final.region.endLine - 1)
    else
      rendered = span(U.slice(lines, final.region.startLine, final.region.endLine + 1),
        final.region.startLine, final.region.endLine)
    end
    slice = { from = rendered.from, to = rendered.to }
    kind = 'region'
  else
    rendered = render_block(final.block, selector.scope, ctx, final.kind)
    kind = final.kind
    if final.kind == 'condition' then
      slice = { from = final.headerLine + 1, to = last_declaration_line(final.block) + 1 }
    elseif final.kind == 'anchor' then
      local anchor_line = final.block.anchor ~= nil and final.block.anchor.line or final.block.declLine
      slice = { from = anchor_line + 1, to = last_declaration_line(final.block) + 1 }
    else
      slice = { from = rendered.from, to = rendered.to }
    end
  end

  local head = U.slice(source, starts[slice.from], starts[slice.to + 1])
  local lead = 0
  if U.startsWith(U.from(rendered.text), head, 0) then lead = #head end
  return { text = rendered.text, kind = kind, ranges = slice_ranges(slice, rendered.text, lead) }
end

local function envelope_part(selector, scan, block)
  local lines = scan.lex.lines
  local is_head = selector.envelope.mark == '^'
  local to = is_head
    and math.min(block.openLine or block.declLine, last_declaration_line(block))
    or last_declaration_line(block)
  local from = is_head and block.declLine or to
  local value = text(U.join(U.slice(lines, from, to + 1), '\n'))
  return { text = value, ranges = { { from = from + 1, to = to + 1 } }, kind = 'envelope' }
end

local function resolve_envelope(selectors, scan, ctx)
  local has_envelope = false
  for _, selector in ipairs(selectors) do
    if selector.envelope then has_envelope = true; break end
  end
  if not has_envelope then return nil end

  local open = selectors[1]
  local close = selectors[#selectors]
  local parent = open.envelope.parent

  local matched = nil
  local blocks = nil
  if #parent == 1 then
    matched = match_segment(scan.root, parent[1], false)
    blocks = {}
    for _, match in ipairs(matched) do
      if not match.region then blocks[#blocks + 1] = match.block end
    end
  else
    local found = resolve_path(parent, 0, scan.root, false, nil)
    if found.region then
      errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_REGION,
        string.format('"#%s": a region has no declaration to open or close', open.raw), open.raw))
    end
    blocks = { found.block }
  end
  if #blocks == 0 then
    if matched ~= nil then
      for _, match in ipairs(matched) do
        if match.region then
          errors.raise(errors.grammar_error(ERROR_CODES.ENVELOPE_REGION,
            string.format('"#%s": a region has no declaration to open or close', open.raw), open.raw))
        end
      end
    end
    errors.raise(errors.resolution_error(ERROR_CODES.REGION_NOT_FOUND,
      string.format('no "#region %s" found, and no section named "%s"', parent[1], parent[1]),
      { selector = parent[1], scope = nil }))
  end

  local interior = {}
  for index = 2, #selectors - 1 do interior[#interior + 1] = selectors[index] end

  local parts = {}
  local scopes = {}
  local failure = nil
  for _, block in ipairs(blocks) do
    if is_container(block) then
      local tried = nil
      local ok = true
      local failure_value = nil
      for _, selector in ipairs(interior) do
        if selector.kind == 'path' then
          tried = selector
          local success, value = pcall(selector_part, selector, block, scan, ctx)
          if not success then
            ok = false
            failure_value = value
            break
          end
        end
      end
      if ok then
        for _, selector in ipairs({ open, close }) do
          parts[selector] = envelope_part(selector, scan, block)
          scopes[selector] = block
        end
        for _, selector in ipairs(interior) do scopes[selector] = block end
        return { parts = parts, scopes = scopes }
      end
      if failure == nil then
        failure = errors.resolution_error(failure_value.code, failure_value.message, {
          selector = tried and tried.raw or nil,
          scope = table.concat(parent, '/'),
          candidates = failure_value.candidates,
        })
      end
    end
  end
  if failure ~= nil then errors.raise(failure) end
  errors.raise(errors.resolution_error(ERROR_CODES.NOT_A_CONTAINER,
    string.format('"%s" is not a container', table.concat(parent, ',')),
    { selector = table.concat(parent, '/'), scope = nil }))
end

--- Resolve a reference to text plus the reference, bounds, ranges and kind.
function M.plan_section(source, reference, lexer)
  local ref = parser.parse_selectors(reference)
  local normalized = normalize_source(source)
  local scan = scan_module.scan_blocks(normalized, nil, lexer)
  local ctx = {
    lines = scan.lex.lines,
    source = scan.lex.source,
    starts = scan.lex.starts,
    annotationLine = scan.lex.annotationLine,
  }

  local envelope = resolve_envelope(ref.selectors, scan, ctx)
  local parts = {}
  for _, selector in ipairs(ref.selectors) do
    if selector.kind == 'lines' then
      local picked = line_range_span(scan.lex, selector, selector.raw)
      parts[#parts + 1] = { text = picked.text, kind = 'lines', ranges = { picked.range } }
    elseif selector.envelope then
      parts[#parts + 1] = envelope.parts[selector]
    else
      local scope = envelope and envelope.scopes[selector] or scan.root
      parts[#parts + 1] = selector_part(selector, scope, scan, ctx)
    end
  end

  local values = {}
  for _, part in ipairs(parts) do values[#values + 1] = U.from(part.text) end
  local joined = text(U.join(values, '\n'))

  local ranges = {}
  for _, part in ipairs(parts) do
    for _, range in ipairs(part.ranges) do
      local last = ranges[#ranges]
      if last and range.from >= last.from and range.from <= last.to + 1 then
        last.to = math.max(last.to, range.to)
      else
        ranges[#ranges + 1] = { from = range.from, to = range.to }
      end
    end
  end
  local from, to = math.huge, -math.huge
  for _, range in ipairs(ranges) do
    from = math.min(from, range.from)
    to = math.max(to, range.to)
  end

  return {
    text = joined,
    reference = ref,
    startLine = from ~= math.huge and from or 1,
    endLine = to ~= -math.huge and to or 1,
    ranges = ranges,
    kind = #parts == 1 and parts[1].kind or 'multiple',
  }
end

function M.resolve_section(source, reference, lexer)
  return M.plan_section(source, reference, lexer).text
end

--- Resolve without throwing: the diagnosis surface of RFC 1 §5.3.
function M.diagnose(source, reference, lexer)
  local ok, plan = pcall(M.plan_section, source, reference, lexer)
  if ok then
    return {
      status = 'ok',
      plan = plan,
      firstLine = #plan.ranges > 0 and plan.ranges[1].from or plan.startLine,
      error = nil,
      code = nil,
      selector = nil,
      scope = nil,
      candidates = nil,
      advice = nil,
    }
  end
  local value = plan
  local code = type(value) == 'table' and value.code or nil
  return {
    status = code ~= nil and code:sub(1, 8) == 'grammar/' and 'invalid' or 'failed',
    plan = nil,
    firstLine = nil,
    error = value,
    code = code,
    selector = type(value) == 'table' and value.selector or nil,
    scope = type(value) == 'table' and value.scope or nil,
    candidates = type(value) == 'table' and value.candidates or nil,
    advice = code ~= nil and code:sub(1, 8) == 'grammar/' and value.message or nil,
  }
end

--- The deepest prefix of a path that still resolves, or nil.
function M.deepest_resolvable_prefix(source, reference, lexer)
  local ok, parsed = pcall(parser.parse_selectors, reference)
  if not ok then return nil end
  local first = parsed.selectors[1]
  if first == nil or first.kind ~= 'path' then return nil end
  for depth = #first.segments - 1, 1, -1 do
    local prefix_segments = {}
    for index = 1, depth do prefix_segments[index] = first.segments[index] end
    local prefix = table.concat(prefix_segments, '/')
    local attempt = M.diagnose(source, prefix, lexer)
    if attempt.status == 'ok' then
      return { reference = prefix, firstLine = attempt.firstLine, segments = prefix_segments }
    end
  end
  return nil
end

--- The text a single named declaration contributes, or nil.
function M.extract_declaration(source, name, scope)
  scope = scope or 'declaration'
  if name == '' then return nil end
  local normalized = normalize_source(source)
  local scan = scan_module.scan_blocks(normalized, nil, nil)
  local lines, starts = scan.lex.lines, scan.lex.starts

  local function has_body(block)
    return block.singleLine == true or block.expression ~= nil or block.indented
      or block.openLine ~= nil or block.kind == 'property'
  end
  local found = {}
  local function walk(scope_block)
    for _, block in ipairs(scope_block.children) do
      if (block.kind == 'class' or block.kind == 'method' or block.kind == 'property')
        and block.name == name and has_body(block) then
        found[#found + 1] = block
      end
      walk(block)
    end
  end
  walk(scan.root)
  if #found == 0 then return nil end

  local classes = {}
  for _, block in ipairs(found) do
    if block.kind == 'class' then classes[#classes + 1] = block end
  end
  local chosen = #classes > 0 and classes or found
  if #chosen > 1 then
    errors.raise(errors.resolution_error(ERROR_CODES.AMBIGUOUS,
      string.format('"%s" is declared %d times; names must be unique', name, #chosen),
      { selector = name, scope = nil, candidates = errors.candidate_info(chosen) }))
  end
  local ctx = { lines = lines, source = scan.lex.source, starts = starts, annotationLine = nil }
  return render_block(chosen[1], scope, ctx, 'text').text
end

M.match_segment = match_segment
M.render_block = render_block
M.search_segments = search_segments
M.resolve_path = resolve_path
M.trimmed_slice = trimmed_slice
M.line_range_span = line_range_span

return M
