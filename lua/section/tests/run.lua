-- The Lua conformance gate.
--
-- Reads the same corpora the JavaScript suite and the other ports read, from
-- the repository, and asserts every row:
--
--   test/vectors/section-vectors.json  — grammar and resolution
--   test/vectors/lexical-vectors.json  — masks and declaration shapes
--   test/vectors/profile-vectors.json  — the jump profile, when it is offered
--
-- Run it from anywhere:
--
--   lua lua/section/tests/run.lua
--   luajit lua/section/tests/run.lua
--   nvim -l lua/section/tests/run.lua          -- the Neovim LuaJIT
--
-- Exit 0 only when every row agrees. A row that is neither asserted nor
-- counted as pending fails the accounting check, so nothing can silently leave
-- the gate.

local script = debug.getinfo(1, 'S').source:sub(2)
local script_dir = script:match('^(.*)[/\\]') or '.'
local root = script_dir .. '/../../..'
package.path = root .. '/lua/?.lua;' .. root .. '/lua/?/init.lua;' .. package.path

io.stdout:setvbuf('no')

local json = require('section.tests.json')
local U = require('section.src.units')
local section = require('section')
local lexers = require('section.src.scanner.lexers')
local mask = require('section.src.mask')
local jump = require('section.src.jump')

local failures = {}
local function fail(message) failures[#failures + 1] = message end

local function is_null(value) return value == json.null end
local function optional(value) if is_null(value) then return nil end return value end
local function read_file(path)
  local file, err = io.open(root .. '/' .. path, 'rb')
  if not file then error('cannot read ' .. path .. ': ' .. tostring(err), 0) end
  local text = file:read('*a')
  file:close()
  return text
end

local function first_lines(value)
  local out = {}
  for line in value:gmatch('[^\n]*') do
    out[#out + 1] = line
    if #out == 3 then break end
  end
  return table.concat(out, '\\n')
end

local function ranges_equal(got, want)
  if #got ~= #want then return false end
  for i = 1, #got do
    if got[i].from ~= want[i][1] or got[i].to ~= want[i][2] then return false end
  end
  return true
end

-- ---------------------------------------------------------------------------
-- Section vectors
-- ---------------------------------------------------------------------------

local section_vectors = json.read_file(root .. '/test/vectors/section-vectors.json')
local section_asserted = 0
for _, row in ipairs(section_vectors) do
  local name = row.name or '<unnamed>'
  local reference = row.reference or ''
  local expected_error = optional(row.error)
  local expected_code = optional(row.code)
  local input = optional(row.input)
  section_asserted = section_asserted + 1

  if input == nil then
    local parser_kind = optional(row.parser)
    local ok, value
    if parser_kind == 'path' then
      ok, value = pcall(section.parse_reference, reference)
    else
      ok, value = pcall(section.parse_selectors, reference)
    end
    if expected_error ~= nil then
      if ok then
        fail(string.format('%s: parsed, want error %q', name, expected_error))
      else
        if type(value) ~= 'table' or value.message ~= expected_error then
          fail(string.format('%s: error %q, want %q', name,
            tostring(type(value) == 'table' and value.message or value), expected_error))
        end
        if (type(value) == 'table' and value.code) ~= expected_code then
          fail(string.format('%s: code %q, want %q', name,
            tostring(type(value) == 'table' and value.code), tostring(expected_code)))
        end
      end
    elseif ok then
      if expected_code ~= nil then
        fail(string.format('%s: parsed, want error with code %q', name, expected_code))
      end
    else
      fail(string.format('%s: failed %q, want success', name,
        tostring(type(value) == 'table' and value.message or value)))
    end
  else
    local file_ok, source = pcall(read_file, input)
    if not file_ok then
      fail(string.format('%s: %s', name, tostring(source)))
    else
      local lexer = lexers.lexer_for(input)
      local ok, plan = pcall(section.plan_section, source, reference, lexer)
      if expected_error ~= nil then
        if ok then
          fail(string.format('%s: resolved to %q, want error %q', name, first_lines(plan.text), expected_error))
        else
          if type(plan) ~= 'table' or plan.message ~= expected_error then
            fail(string.format('%s: error %q, want %q', name,
              tostring(type(plan) == 'table' and plan.message or plan), expected_error))
          end
          if (type(plan) == 'table' and plan.code) ~= expected_code then
            fail(string.format('%s: code %q, want %q', name,
              tostring(type(plan) == 'table' and plan.code), tostring(expected_code)))
          end
        end
      elseif not ok then
        fail(string.format('%s: failed %q, want success', name,
          tostring(type(plan) == 'table' and plan.message or plan)))
      else
        if plan.text ~= (row.text or '') then
          fail(string.format('%s: text %q, want %q', name, first_lines(plan.text), first_lines(row.text or '')))
        end
        if plan.kind ~= row.kind then
          fail(string.format('%s: kind %q, want %q', name, tostring(plan.kind), tostring(row.kind)))
        end
        if plan.startLine ~= row.startLine then
          fail(string.format('%s: startLine %s, want %s', name, tostring(plan.startLine), tostring(row.startLine)))
        end
        if plan.endLine ~= row.endLine then
          fail(string.format('%s: endLine %s, want %s', name, tostring(plan.endLine), tostring(row.endLine)))
        end
        local want_ranges = {}
        for _, pair in ipairs(row.ranges or {}) do want_ranges[#want_ranges + 1] = { pair[1], pair[2] } end
        if not ranges_equal(plan.ranges, want_ranges) then
          local got = {}
          for _, range in ipairs(plan.ranges) do got[#got + 1] = string.format('%d-%d', range.from, range.to) end
          local wanted = {}
          for _, range in ipairs(want_ranges) do wanted[#wanted + 1] = string.format('%d-%d', range[1], range[2]) end
          fail(string.format('%s: ranges %s, want %s', name, table.concat(got, ','), table.concat(wanted, ',')))
        end
      end
    end
  end
end
if section_asserted ~= #section_vectors then
  fail('section vector accounting is wrong')
end

-- ---------------------------------------------------------------------------
-- Lexical vectors
-- ---------------------------------------------------------------------------

local lexical = json.read_file(root .. '/test/vectors/lexical-vectors.json')
local masks_asserted, shapes_asserted = 0, 0
for _, row in ipairs(lexical.masks) do
  local source = U.from(row.source)
  local lexer = row.path and not is_null(row.path) and lexers.lexer_for(row.path) or nil
  local masked = lexer and lexer.mask(source) or mask.masked(source)
  local got = U.to(masked)
  masks_asserted = masks_asserted + 1
  if got ~= row.masked then
    fail(string.format('%s: mask %q, want %q', row.name, got, row.masked))
  end
  if #masked ~= #source then
    fail(string.format('%s: mask length %d, source %d', row.name, #masked, #source))
  end
  for i = 1, #source do
    if source[i] == 10 and masked[i] ~= 10 then
      fail(string.format('%s: newline moved at %d', row.name, i - 1))
      break
    end
  end
end
if masks_asserted ~= #lexical.masks then fail('mask vector accounting is wrong') end

for _, row in ipairs(lexical.shapes) do
  local lexer = lexers.lexer_for(row.path)
  local declared = lexer.declarations(U.from(row.line))
  shapes_asserted = shapes_asserted + 1
  if #declared ~= #row.declared then
    fail(string.format('%s (%q): %d declarations, want %d', row.name, row.line, #declared, #row.declared))
  else
    for index, want in ipairs(row.declared) do
      local got = declared[index]
      local function field(name)
        local value = want[name]
        if is_null(value) then return nil end
        return value
      end
      local line_bool = got.line and true or false
      if got.kind ~= field('kind') or got.name ~= field('name')
        or got.headerFrom ~= field('headerFrom')
        or got.body ~= field('body') or got['end'] ~= field('end')
        or line_bool ~= (field('line') or false) then
        fail(string.format('%s (%q) [%d]: got {%s,%s,%s,%s,%s,%s}',
          row.name, row.line, index, tostring(got.kind), tostring(got.name), tostring(got.headerFrom),
          tostring(got.body), tostring(got['end']), tostring(line_bool)))
      end
    end
  end
end
if shapes_asserted ~= #lexical.shapes then fail('shape vector accounting is wrong') end

-- ---------------------------------------------------------------------------
-- Profile vectors (the jump profile this port offers)
-- ---------------------------------------------------------------------------

local profile = json.read_file(root .. '/test/vectors/profile-vectors.json')
local profile_asserted = 0
for _, row in ipairs(profile.resolutions) do
  local source = read_file('test/fixtures/jump/' .. row.file)
  local lexer = lexers.lexer_for(row.file)
  profile_asserted = profile_asserted + 1
  local editor = jump.jump(source, row.reference, { lexer = lexer, path = row.file, profile = 'jump/editor' })
  if not editor.ok then
    fail(row.name .. ': editor refused')
  else
    if editor.target.firstLine ~= row.editor.firstLine then
      fail(string.format('%s: editor firstLine %s, want %s', row.name,
        tostring(editor.target.firstLine), tostring(row.editor.firstLine)))
    end
    if editor.target.cause ~= row.editor.cause then
      fail(string.format('%s: editor cause %s, want %s', row.name,
        tostring(editor.target.cause), tostring(row.editor.cause)))
    end
  end
  local gate = jump.jump(source, row.reference, { lexer = lexer, path = row.file, profile = 'jump/gate' })
  if is_null(row.gate) then
    if not gate.ok then fail(row.name .. ': gate refused, want success') end
  elseif gate.ok then
    fail(row.name .. ': gate landed, want ' .. row.gate)
  elseif gate.failure.code ~= row.gate then
    fail(string.format('%s: gate code %s, want %s', row.name, tostring(gate.failure.code), row.gate))
  end
end

for _, row in ipairs(profile.documents) do
  local files = {}
  for _, pair in ipairs(row.files) do files[pair[1]] = pair[2] end
  profile_asserted = profile_asserted + 1
  local result = jump.jump_gate(row.document, {
    readFile = function(path)
      local source = files[path]
      if source == nil then error('missing fixture ' .. tostring(path), 0) end
      return source
    end,
  })
  if result.passed ~= row.outcome.passed or result.checked ~= row.outcome.checked
    or #result.failures ~= #row.outcome.failures then
    fail(string.format('%s: gate passed=%s checked=%s failures=%d, want passed=%s checked=%s failures=%d',
      row.name, tostring(result.passed), tostring(result.checked), #result.failures,
      tostring(row.outcome.passed), tostring(row.outcome.checked), #row.outcome.failures))
  else
    for i, want in ipairs(row.outcome.failures) do
      local got = result.failures[i]
      if got.reference ~= want.reference or got.code ~= want.code or got.selector ~= want.selector then
        fail(string.format('%s failure %d: %s/%s/%s, want %s/%s/%s', row.name, i,
          tostring(got.reference), tostring(got.code), tostring(got.selector),
          tostring(want.reference), tostring(want.code), tostring(want.selector)))
      end
    end
  end
end
if profile_asserted ~= (#profile.resolutions + #profile.documents) then
  fail('profile vector accounting is wrong')
end

-- ---------------------------------------------------------------------------

if #failures > 0 then
  print(string.format('%d failure(s):', #failures))
  for _, message in ipairs(failures) do print('  ' .. message) end
  os.exit(1)
end

print(string.format(
  'lua section: %d section rows, %d masks, %d shapes, %d profile rows — all matching',
  section_asserted, masks_asserted, shapes_asserted, profile_asserted))
