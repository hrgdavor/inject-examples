-- md-jump.nvim, on the pure-Lua section resolver.
--
-- A Markdown link's `#fragment` is a code reference (`Cart/Line/render`,
-- `L10-L20`), a heading anchor, or a region. The resolver is
-- `require("section")` — the Lua port of `lib/section.mjs` in this repository —
-- so the plugin needs no Node process and no `@hrg/inject-examples` install.
--
-- The original md-jump.nvim is the source of the keymaps, the link reader and
-- the `gx` / `<CR>` / `gX` layout; its Node fallback is gone, because the Lua
-- resolver is the same implementation the Node path called.

local section = require('section')
local jump_profile = require('section.src.jump')

local M = {}

M.config = {
  external_opener = nil,
  default_profile = 'jump/editor',
  keymaps = true,
}

local function notify(message, level)
  vim.notify('md-jump: ' .. message, level or vim.log.levels.INFO)
end

local function attach_keymaps(buf)
  if not M.config.keymaps then return end
  vim.keymap.set('n', 'gx', function() M.jump() end,
    { buffer = buf, desc = 'md-jump: jump to the link under the cursor' })
  vim.keymap.set('n', '<CR>', function() M.jump() end,
    { buffer = buf, desc = 'md-jump: jump to the link under the cursor (markdown)' })
  vim.keymap.set('n', 'gX', function() M.gate() end,
    { buffer = buf, desc = 'md-jump: check every link in this document' })
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})
  if not M._setup_done then
    M._setup_done = true
    vim.api.nvim_create_autocmd('FileType', {
      pattern = 'markdown',
      callback = function(ev) attach_keymaps(ev.buf) end,
    })
    vim.api.nvim_create_user_command('MdJump', function() M.jump() end, { desc = 'md-jump: jump to link' })
    vim.api.nvim_create_user_command('MdJumpGate', function() M.gate() end, { desc = 'md-jump: gate this document' })
  end
  -- `setup` may run from a `FileType` autocmd, after the event already fired.
  if vim.bo.filetype == 'markdown' then attach_keymaps(0) end
end

-- ---------------------------------------------------------------------------
-- Reading the link under the cursor
-- ---------------------------------------------------------------------------

local function find_link_at_cursor()
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1
  for start_at, label, dest, end_at in line:gmatch('()%[([^%]]-)%]%(([^%)]+)%)()') do
    if col >= start_at and col <= end_at then
      return { label = label, dest = dest, s = start_at, e = end_at }
    end
  end
  return nil
end

local function parse_dest(raw)
  raw = raw:gsub('^%s+', ''):gsub('%s+$', '')
  local path
  local angled = raw:match('^<([^>]*)>')
  if angled then
    path = angled
  else
    path = raw:match('^([^%s"]+)') or ''
    path = path:gsub('^<', ''):gsub('>$', '')
  end
  local hash
  local hash_at = path:find('#', 1, true)
  if hash_at then
    hash = path:sub(hash_at + 1)
    path = path:sub(1, hash_at - 1)
  end
  return { path = path, hash = hash, raw = raw }
end

local function is_url(path)
  return path:match('^https?://') or path:match('^ftp://') or path:match('^www%.') or path:match('^mailto:')
end

local function resolve_path(base_dir, relative)
  if relative == '' then return nil end
  if relative:match('^/') or relative:match('^%a:[/\\]') then return relative end
  return vim.fn.fnamemodify(base_dir .. '/' .. relative, ':p')
end

local function same_file(a, b)
  return vim.fn.fnamemodify(a, ':p') == vim.fn.fnamemodify(b, ':p')
end

local function read_source(path, current)
  if current then
    return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\n')
  end
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then return nil end
  return table.concat(lines, '\n')
end

-- ---------------------------------------------------------------------------
-- Markdown headings
-- ---------------------------------------------------------------------------
--
-- A navigation document points at its own headings as often as at code. The
-- section resolver deliberately knows nothing about Markdown; the fragment is
-- read as a heading first for a `.md` target, and as a section reference only
-- when no heading has that slug.

local function heading_slug(text)
  local slug = text:lower()
  slug = slug:gsub('<[^>]+>', '')
  slug = slug:gsub('[^%w%- ]', '')
  slug = slug:gsub('%s+', '-')
  return slug
end

local function heading_line(source, reference)
  local wanted = reference:lower()
  local wanted_slug = heading_slug(reference)
  local line_number = 0
  for line in (source .. '\n'):gmatch('(.-)\n') do
    line_number = line_number + 1
    local hashes, title = line:match('^(#+)%s+(.+)$')
    if hashes then
      local title_slug = heading_slug(title)
      local title_lower = title:lower()
      if title_slug == wanted_slug or title_lower == wanted or title_slug == wanted then
        return line_number
      end
    end
  end
  return nil
end

local function is_markdown_path(path)
  return path:lower():match('%.md$') ~= nil or path:lower():match('%.markdown$') ~= nil
end

-- ---------------------------------------------------------------------------
-- Jumping
-- ---------------------------------------------------------------------------

local function open_target(path, current)
  if not current then vim.cmd('edit ' .. vim.fn.fnameescape(path)) end
end

local function place_cursor(line)
  vim.api.nvim_win_set_cursor(0, { math.max(1, line or 1), 0 })
  vim.cmd('normal! zz')
end

function M.jump(opts)
  opts = opts or {}
  local link = find_link_at_cursor()
  if not link then
    notify('no link under the cursor')
    return
  end
  local parsed = parse_dest(link.dest)
  if is_url(parsed.path) then
    local url = parsed.path
    if parsed.hash ~= nil and parsed.hash ~= '' then url = url .. '#' .. parsed.hash end
    if M.config.external_opener then
      M.config.external_opener(url)
    else
      vim.ui.open(url)
    end
    return
  end

  local current_name = vim.api.nvim_buf_get_name(0)
  local base = vim.fn.fnamemodify(current_name, ':h')
  if base == '' then base = vim.fn.getcwd() end
  local target_path
  if parsed.path == '' then
    target_path = current_name
  else
    target_path = resolve_path(base, parsed.path)
  end
  if not target_path or vim.fn.filereadable(target_path) == 0 then
    notify('not found: ' .. (parsed.path or ''), vim.log.levels.WARN)
    return
  end
  local current = same_file(target_path, current_name)
  local source = read_source(target_path, current)
  if source == nil then
    notify('cannot read: ' .. target_path, vim.log.levels.WARN)
    return
  end

  -- A link with no fragment opens the file at its first line.
  if parsed.hash == nil or parsed.hash == '' then
    open_target(target_path, current)
    place_cursor(1)
    return
  end

  -- A Markdown target's fragment is a heading when one matches.
  if is_markdown_path(target_path) then
    local heading = heading_line(source, parsed.hash)
    if heading then
      open_target(target_path, current)
      place_cursor(heading)
      return
    end
  end

  local outcome = jump_profile.jump(source, parsed.hash, {
    lexer = section.lexer_for(target_path),
    path = target_path,
    profile = opts.profile or M.config.default_profile,
  })

  if outcome.ok then
    open_target(target_path, current)
    local target = outcome.target
    place_cursor(target.firstLine)
    if target.cause ~= 'resolved' then
      notify(string.format('landed at line %d (%s)', target.firstLine, target.cause), vim.log.levels.INFO)
    end
  else
    local failure = outcome.failure
    notify(string.format('%s [%s]', failure.error and failure.error.message or 'does not resolve',
      failure.code or 'no code'), vim.log.levels.WARN)
  end
end

-- ---------------------------------------------------------------------------
-- The gate over the current document
-- ---------------------------------------------------------------------------

local function document_base()
  local name = vim.api.nvim_buf_get_name(0)
  local base = vim.fn.fnamemodify(name, ':h')
  if base == '' then base = vim.fn.getcwd() end
  return base
end

-- Every Markdown link in the buffer, not only a marker line: an editor's gate
-- is about the prose a reader sees, and the original md-jump.nvim checked all
-- of it. Fenced blocks are code examples, not navigation, so they are skipped.
local function links_in(fence_free_line)
  local out = {}
  for dest in fence_free_line:gmatch('%[[^%]]-%]%(([^%)]+)%)') do
    out[#out + 1] = dest
  end
  return out
end

local function check_link(line_number, dest, current_name, base)
  local parsed = parse_dest(dest)
  if is_url(parsed.path) then return nil end
  if parsed.path == '' and current_name == '' then return nil end

  local target_path = parsed.path == '' and current_name or resolve_path(base, parsed.path)
  if not target_path or vim.fn.filereadable(target_path) == 0 then
    return {
      line = line_number, path = parsed.path, reference = parsed.hash,
      message = 'not found: ' .. (parsed.path or ''), code = 'not-found',
    }
  end
  if parsed.hash == nil or parsed.hash == '' then return nil end

  local current = same_file(target_path, current_name)
  local source = read_source(target_path, current)
  if source == nil then
    return {
      line = line_number, path = parsed.path, reference = parsed.hash,
      message = 'cannot read: ' .. parsed.path, code = 'not-found',
    }
  end
  if is_markdown_path(target_path) and heading_line(source, parsed.hash) then return nil end

  local diagnosis = section.diagnose(source, parsed.hash, section.lexer_for(target_path))
  if diagnosis.status == 'ok' then return nil end
  return {
    line = line_number, path = parsed.path, reference = parsed.hash,
    message = diagnosis.error and diagnosis.error.message or 'does not resolve',
    code = diagnosis.code,
    selector = diagnosis.selector,
    scope = diagnosis.scope,
  }
end

function M.gate()
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local current_name = vim.api.nvim_buf_get_name(0)
  local base = document_base()
  local failures = {}
  local checked = 0
  local in_fence = false
  for index, line in ipairs(lines) do
    if line:match('^%s*```') then
      in_fence = not in_fence
    elseif not in_fence then
      for _, dest in ipairs(links_in(line)) do
        checked = checked + 1
        local failure = check_link(index, dest, current_name, base)
        if failure then failures[#failures + 1] = failure end
      end
    end
  end

  if #failures == 0 then
    vim.fn.setqflist({}, ' ', { title = 'md-jump gate', items = {} })
    notify(string.format('all %d link(s) resolve', checked))
    return
  end

  local items = {}
  for _, failure in ipairs(failures) do
    items[#items + 1] = {
      lnum = failure.line or 1,
      col = 1,
      text = string.format('%s [%s]', failure.message,
        failure.code or (failure.reference or 'no reference')),
    }
  end
  vim.fn.setqflist({}, ' ', { title = 'md-jump gate', items = items })
  vim.cmd('copen')
  notify(string.format('%d of %d link(s) do not resolve', #failures, checked), vim.log.levels.WARN)
end

-- The link reader is useful to a host that wants to resolve a link itself.
M.find_link_at_cursor = find_link_at_cursor
M.parse_dest = parse_dest
M.heading_line = heading_line
M.links_in = links_in

return M
