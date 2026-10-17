-- The code-jump profile, ported from `lib/jump.mjs`.
--
-- A jump turns a reference into a cursor: every answer comes from `diagnose`,
-- and the policy is what a failure means to a reader (land usefully, say how)
-- or to a gate (refuse anything not exact). `jump_gate` reads a whole Markdown
-- document and reports every failing marker in one pass; it is the document
-- layer's smallest useful shape, enough for the Neovim plugin and the profile
-- corpus.

local U = require('section.src.units')
local resolver = require('section.src.resolver')

local M = {}

M.PROFILES = { 'jump/editor', 'jump/gate' }

function M.is_profile(name)
  for _, profile in ipairs(M.PROFILES) do
    if profile == name then return true end
  end
  return false
end

local function line_count_of(ranges, fallback)
  fallback = fallback or 1
  if not ranges or #ranges == 0 then return fallback end
  local first = ranges[1]
  local last = ranges[#ranges]
  return math.max(1, last.to - first.from + 1)
end

local function normalized_lines(value)
  local source = U.from(value)
  local out = {}
  for i = 1, #source do
    if not (source[i] == 13 and source[i + 1] == 10) then out[#out + 1] = source[i] end
  end
  -- `replace(/\n$/, '')` removes exactly one trailing newline.
  if out[#out] == 10 then out[#out] = nil end
  return U.split(out, '\n')
end

local function last_line_target(path, value, diagnosis)
  local lines = normalized_lines(value)
  return {
    path = path,
    firstLine = math.max(1, #lines),
    lineCount = 1,
    cause = 'nearest',
    plan = nil,
    candidates = nil,
    code = diagnosis and diagnosis.code or nil,
    diagnosis = diagnosis,
  }
end

local function file_start_target(path, diagnosis)
  return {
    path = path,
    firstLine = 1,
    lineCount = 1,
    cause = 'file-start',
    plan = nil,
    candidates = nil,
    code = diagnosis and diagnosis.code or nil,
    diagnosis = diagnosis,
  }
end

local function nearest_target(path, value, reference, lexer, diagnosis)
  local prefix = resolver.deepest_resolvable_prefix(value, reference, lexer)
  if prefix == nil then return nil end
  return {
    path = path,
    firstLine = prefix.firstLine,
    lineCount = 1,
    cause = 'nearest',
    plan = nil,
    candidates = nil,
    code = diagnosis and diagnosis.code or nil,
    diagnosis = diagnosis,
  }
end

local function ambiguous_target(path, value, reference, lexer, diagnosis)
  local candidates = (diagnosis and diagnosis.candidates) or {}
  local prefix = resolver.deepest_resolvable_prefix(value, reference, lexer)
  if prefix ~= nil then
    return {
      path = path,
      firstLine = prefix.firstLine,
      lineCount = 1,
      cause = 'ambiguous',
      plan = nil,
      candidates = candidates,
      code = diagnosis and diagnosis.code or nil,
      diagnosis = diagnosis,
    }
  end
  local first = candidates[1]
  if first ~= nil and first.startLine ~= nil then
    return {
      path = path,
      firstLine = first.startLine,
      lineCount = math.max(1, (first.endLine or first.startLine) - first.startLine + 1),
      cause = 'ambiguous',
      plan = nil,
      candidates = candidates,
      code = diagnosis and diagnosis.code or nil,
      diagnosis = diagnosis,
    }
  end
  return nil
end

local function landed(target, profile)
  return { ok = true, target = target, profile = profile }
end

--- Resolve a reference into a cursor. Never throws for a failed resolve.
function M.jump(value, reference, options)
  options = options or {}
  local profile = options.profile or 'jump/editor'
  if not M.is_profile(profile) then
    error(string.format('"%s" is not a jump profile; write jump/editor or jump/gate', profile), 0)
  end
  local path = options.path or ''
  local diagnosis = resolver.diagnose(value, reference, options.lexer)

  if diagnosis.status == 'ok' then
    return landed({
      path = path,
      firstLine = diagnosis.firstLine,
      lineCount = line_count_of(diagnosis.plan.ranges),
      cause = 'resolved',
      plan = diagnosis.plan,
      candidates = nil,
      code = nil,
      diagnosis = nil,
    }, profile)
  end

  if profile == 'jump/gate' then
    return { ok = false, failure = diagnosis, profile = profile }
  end

  local ladder
  if diagnosis.code == 'resolution/ambiguous' then
    ladder = ambiguous_target(path, value, reference, options.lexer, diagnosis)
  elseif diagnosis.code == 'resolution/line-range-past-end' then
    ladder = last_line_target(path, value, diagnosis)
  else
    ladder = nearest_target(path, value, reference, options.lexer, diagnosis)
  end
  return landed(ladder or file_start_target(path, diagnosis), profile)
end

function M.is_refused(outcome)
  return outcome.ok == false
end

function M.refusal(outcome)
  if outcome.ok then error('this outcome landed; there is no failure to read', 0) end
  return outcome.failure
end

-- ---------------------------------------------------------------------------
-- The gate over a document
-- ---------------------------------------------------------------------------

local function parse_marker(line)
  -- A marker is a line that is nothing but `[label](path#reference)`. This is
  -- the shape the profile corpus uses and the shape a navigation document
  -- carries; a marker with prose around it is not a marker.
  local label, dest = line:match('^%s*%[([^%]]+)%]%((.-)%)%s*$')
  if not dest then return nil end
  local path = dest:gsub('^%s+', ''):gsub('%s+$', '')
  path = path:match('^<([^>]*)>$') or path
  local hash = path:find('#', 1, true)
  if hash then
    return { raw = line, path = path:sub(1, hash - 1), reference = path:sub(hash + 1) }
  end
  return { raw = line, path = path, reference = nil }
end

--- Resolve every marker in `document` and report every failure in one pass.
--
-- `options.readFile(relativePath)` is required; `options.lexerFor` is optional
-- and defaults to the per-extension lexer table. The result is
-- `{ passed, checked, failures }`, where each failure names the marker, its
-- reference, the message and the stable code.
function M.jump_gate(document, options)
  options = options or {}
  local read = options.readFile
  if type(read) ~= 'function' then
    error('jumpGate needs a readFile: it resolves markers against the files they name', 0)
  end
  local lexer_for = options.lexerFor
  if lexer_for == nil then
    local lexers = require('section.src.scanner.lexers')
    lexer_for = lexers.lexer_for
  end

  local lines = U.split(U.from(document), '\n')
  local failures = {}
  local checked = 0
  local in_fence = false
  for line_index, units_line in ipairs(lines) do
    local line = U.to(units_line)
    if line:match('^%s*```') then
      in_fence = not in_fence
    elseif not in_fence then
      local marker = parse_marker(line)
      if marker then
        checked = checked + 1
        local ok, source = pcall(read, marker.path)
        if not ok then
          failures[#failures + 1] = {
            marker = marker.raw, path = marker.path, reference = marker.reference,
            line = line_index, message = tostring(source), code = nil, selector = nil, scope = nil,
          }
        else
          local d = resolver.diagnose(source, marker.reference or '', lexer_for(marker.path))
          if d.status ~= 'ok' then
            failures[#failures + 1] = {
              marker = marker.raw, path = marker.path, reference = marker.reference,
              line = line_index, message = d.error and d.error.message or '', code = d.code,
              selector = d.selector, scope = d.scope,
            }
          end
        end
      end
    end
  end
  return { passed = #failures == 0, checked = checked, failures = failures }
end

M.line_count_of = line_count_of

return M
