-- The stable failure codes and the two failure shapes of `lib/section.mjs`.
--
-- A malformed reference and a file that cannot answer it are different bands,
-- and a host branches on the code rather than on prose. The Lua port keeps the
-- same registry so a corpus row's `code` can be asserted beside its message.

local M = {}

M.ERROR_CODES = {
  EMPTY_REFERENCE = 'grammar/empty-reference',
  EMPTY_SELECTOR = 'grammar/empty-selector',
  EMPTY_SEGMENT = 'grammar/empty-segment',
  TOO_DEEP = 'grammar/too-deep',
  SECOND_HASH = 'grammar/second-hash',
  LINE_RANGE_AS_PATH = 'grammar/line-range-as-path',
  LINE_RANGE_NOT_A_RANGE = 'grammar/line-range-not-a-range',
  LINE_RANGE_FROM_1 = 'grammar/line-range-from-1',
  LINE_RANGE_BACKWARDS = 'grammar/line-range-backwards',
  MODIFIER_NOT_LAST = 'grammar/modifier-not-last',
  MODIFIER_OLD_SPELLING = 'grammar/modifier-old-spelling',
  TOO_MANY_MODIFIERS = 'grammar/too-many-modifiers',

  LINE_RANGE_PAST_END = 'resolution/line-range-past-end',
  LINE_RANGE_COLUMN_PAST_END = 'resolution/line-range-column-past-end',
  NOT_FOUND = 'resolution/not-found',
  AMBIGUOUS = 'resolution/ambiguous',
  NOT_A_CONTAINER = 'resolution/not-a-container',
  REGION_NOT_FOUND = 'resolution/region-not-found',
  EMPTY_KEY = 'resolution/empty-key',
  REGION_DUPLICATED = 'resolution/region-duplicated',
  KEY_DUPLICATED = 'resolution/key-duplicated',
  ENVELOPE_ALONE = 'resolution/envelope-alone',
  ENVELOPE_ORDER = 'resolution/envelope-order',
  ENVELOPE_MARKS = 'resolution/envelope-marks',
  ENVELOPE_MISMATCH = 'resolution/envelope-mismatch',
  ENVELOPE_NO_BLOCK = 'resolution/envelope-no-block',
  ENVELOPE_REGION = 'resolution/envelope-region',
  LEXER_MASK = 'resolution/lexer-mask',
}

local ErrorMeta = {}
ErrorMeta.__index = ErrorMeta
ErrorMeta.__tostring = function(self) return self.message end

local function make_error(name, message, diagnosis)
  return setmetatable({
    name = name,
    message = message,
    code = diagnosis and diagnosis.code or nil,
    selector = diagnosis and diagnosis.selector or nil,
    scope = diagnosis and diagnosis.scope or nil,
    candidates = diagnosis and diagnosis.candidates or nil,
  }, ErrorMeta)
end

--- A grammar failure: the reference is malformed and no file was read.
function M.grammar_error(code, message, selector)
  return make_error('SectionReferenceError', message, { code = code, selector = selector })
end

--- A plain Error carrying a code (a lexer that broke its own mask).
function M.coded_error(code, message)
  return make_error('Error', message, { code = code })
end

--- A resolution failure: well formed, and the file cannot answer it.
function M.resolution_error(code, message, extra)
  extra = extra or {}
  return make_error('Error', message, {
    code = code,
    selector = extra.selector,
    scope = extra.scope,
    candidates = extra.candidates,
  })
end

--- Throw a failure value without letting Lua add a source position.
function M.raise(value)
  error(value, 0)
end

--- What a name answered to, as the diagnosis reports it.
function M.candidate_info(blocks)
  local out = {}
  for i, block in ipairs(blocks) do
    out[i] = {
      name = block.name,
      kind = block.kind,
      startLine = block.declLine,
      endLine = block.closeLine or block.declLine,
    }
  end
  return out
end

return M
