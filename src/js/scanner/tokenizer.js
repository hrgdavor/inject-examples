// ============================================================================
// SHARED TOKENIZER
// One lexical pass over a source, parameterised by a language's comment and
// string syntax. It produces the two facts the section resolver's lexer seam
// needs — a blanked mask and the comment spans — plus the `if` clauses matcher 5
// reads, and it can drive a visitor so a file is enumerable for other uses or
// tests without resolving anything.
//
// It owns NOTHING structural: no braces are matched here, no blocks are built,
// no precedence or modifier is applied. `lib/section.mjs` drives this through a
// lexer adapter (see `makeLexer`) and does all of that, so every engine agrees.
// This module is dependency-free and imports nothing.
// ============================================================================

/** @typedef {{ text: string, from: number, to: number }} Comment */
/** @typedef {{ from: number, to: number, quote: string, multiline: boolean }} StringSpan */
/** @typedef {{ offset: number, brace: number, line: number, col: number, snippet: string, clause: string }} IfClause */

/**
 * A language's lexical syntax.
 * @typedef {object} Syntax
 * @property {string} name
 * @property {string} lineComment            e.g. '//'
 * @property {{ open: string, close: string, nested: boolean }} blockComment
 * @property {Array<{ quote: string, multiline?: boolean, escape?: string, lineScoped?: boolean }>} strings
 *           ordered longest-opener first, so a text block ('"""') is tried
 *           before a single quote ('"').
 */

/** JavaScript / TypeScript: `//`, `/* *\/`, `'` `"` and backtick templates. */
export const JS_SYNTAX = {
  name: 'javascript',
  lineComment: '//',
  blockComment: { open: '/*', close: '*/', nested: false },
  strings: [
    { quote: '`', multiline: true, escape: '\\' },
    { quote: '"', multiline: false, escape: '\\' },
    { quote: "'", multiline: false, escape: '\\' },
  ],
};

/** Java: `//`, `/* *\/`, `'` `"` and text blocks `"""`. */
export const JAVA_SYNTAX = {
  name: 'java',
  lineComment: '//',
  blockComment: { open: '/*', close: '*/', nested: false },
  strings: [
    { quote: '"""', multiline: true, escape: '\\' },
    { quote: '"', multiline: false, escape: '\\' },
    { quote: "'", multiline: false, escape: '\\' },
  ],
};

/** Zig: `//`, NESTED `/* *\/`, `"` and multiline strings `\\` (to end of line). */
export const ZIG_SYNTAX = {
  name: 'zig',
  lineComment: '//',
  blockComment: { open: '/*', close: '*/', nested: true },
  strings: [
    { quote: '\\\\', lineScoped: true },
    { quote: '"', multiline: false, escape: '\\' },
  ],
};

// --- offset helpers ---------------------------------------------------------

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineCol(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, col: offset - starts[low] + 1 };
}

function endOfLine(text, from) {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

// --- readers ----------------------------------------------------------------

/** The end offset and inner body of a block comment starting at `i`. */
function readBlockComment(source, i, bc) {
  const { open, close, nested } = bc;
  if (!nested) {
    const end = source.indexOf(close, i + open.length);
    const to = end === -1 ? source.length : end + close.length;
    return { to, body: source.slice(i + open.length, end === -1 ? source.length : end) };
  }
  let depth = 0;
  let j = i;
  const bodyStart = i + open.length;
  while (j < source.length) {
    if (source.startsWith(open, j)) { depth++; j += open.length; continue; }
    if (source.startsWith(close, j)) {
      depth--;
      j += close.length;
      if (depth === 0) break;
      continue;
    }
    j++;
  }
  const to = j;
  return { to, body: source.slice(bodyStart, Math.max(bodyStart, to - close.length)) };
}

/** The end offset of a string / text block / multiline string starting at `i`. */
function readString(source, i, str) {
  if (str.lineScoped) return endOfLine(source, i);
  const { quote, escape, multiline = false } = str;
  let j = i + quote.length;
  while (j < source.length) {
    const c = source[j];
    if (c === '\n' && !multiline) return j;         // unterminated single-line string
    if (escape && c === escape) { j += 2; continue; }
    if (source.startsWith(quote, j)) return j + quote.length;
    j++;
  }
  return source.length;
}

/** The `if` clauses, read from the mask so a string/comment `if` never counts. */
function extractIfClauses(source, masked, starts) {
  const out = [];
  const re = /\bif\b/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const brace = masked.indexOf('{', m.index);
    if (brace === -1) continue;
    const clause = source.slice(m.index, brace);
    const { line, col } = lineCol(starts, m.index);
    out.push({ offset: m.index, brace, line, col, snippet: clause.trim(), clause });
  }
  return out;
}

/**
 * One lexical pass. Blanks comments and strings to spaces (length and every
 * newline offset preserved — the invariant `lib/section.mjs` asserts), collects
 * the comment spans, and reports the `if` clauses. When a `visitor` is given its
 * hooks fire during the same pass (and `ifClause` once the mask is complete), so
 * a caller can enumerate a file without consuming the returned buffer.
 *
 * @param {string} source
 * @param {Syntax} syntax
 * @param {{ comment?: (c: Comment & {line:number,col:number}) => void,
 *           string?: (s: StringSpan & {line:number,col:number}) => void,
 *           ifClause?: (c: IfClause) => void }} [visitor]
 * @returns {{ masked: string, comments: Comment[], strings: StringSpan[], ifClauses: IfClause[] }}
 */
export function tokenize(source, syntax, visitor) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  const comments = [];
  const strings = [];
  const starts = lineStarts(source);
  const n = source.length;

  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') { i++; continue; }

    if (source.startsWith(syntax.lineComment, i)) {
      const end = endOfLine(source, i);
      const body = source.slice(i + syntax.lineComment.length, end);
      comments.push({ text: body, from: i, to: end });
      visitor?.comment?.({ text: body, from: i, to: end, ...lineCol(starts, i) });
      blank(i, end);
      i = end;
      continue;
    }

    if (source.startsWith(syntax.blockComment.open, i)) {
      const { to, body } = readBlockComment(source, i, syntax.blockComment);
      comments.push({ text: body, from: i, to });
      visitor?.comment?.({ text: body, from: i, to, ...lineCol(starts, i) });
      blank(i, to);
      i = to;
      continue;
    }

    const str = syntax.strings.find((s) => source.startsWith(s.quote, i));
    if (str) {
      const to = readString(source, i, str);
      const span = { from: i, to, quote: str.quote, multiline: !!str.multiline || !!str.lineScoped };
      strings.push(span);
      visitor?.string?.({ ...span, ...lineCol(starts, i) });
      blank(i, to);
      i = to;
      continue;
    }

    i++;
  }

  const masked = out.join('');
  const ifClauses = extractIfClauses(source, masked, starts);
  for (const c of ifClauses) visitor?.ifClause?.(c);
  return { masked, comments, strings, ifClauses };
}

/**
 * A lexer adapter for `lib/section.mjs`: the shape the resolver's optional
 * `lexer` argument wants (`{ name, mask, comments }`), memoised on the last
 * source so one scan pays for `mask` and `comments` together.
 *
 * @param {Syntax} syntax
 * @returns {{ name: string, mask: (s: string) => string, comments: (s: string) => Comment[] }}
 */
export function makeLexer(syntax) {
  let cacheSrc = null;
  let cacheVal = null;
  const scan = (s) => {
    if (s !== cacheSrc) { cacheSrc = s; cacheVal = tokenize(s, syntax); }
    return cacheVal;
  };
  return {
    name: syntax.name,
    mask: (s) => scan(s).masked,
    comments: (s) => scan(s).comments,
  };
}
