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
// This module is dependency-free and imports only the language table.
//
// A language is DATA (`syntaxes.js`), not code. The knobs below cover what real
// languages need without a parser:
//
//   lineComments    several spellings per language (`//` and `#` in PHP,
//                   `--` in SQL, `'` in VB); `#` is never a comment before `[`,
//                   which keeps a Rust or PHP attribute readable.
//   blockComments   several pairs per language, `nested` (Rust, Kotlin, Zig,
//                   Haskell) and `lineStart` (`=begin` in Ruby).
//   strings         openers of any length, `escape: 'backslash' | 'doubling'`
//                   (SQL `''`, VB `""`, C# `@"…"`), `multiline`, `lineScoped`,
//                   `boundary` (prefixed forms like Python `r"`), `hashes`
//                   (Rust `r#"…"#`), and `maxSpan`/`content` for the one form
//                   that is not a string at all: a Rust lifetime (`'a`) beside
//                   a char literal (`'a'`).
//   heredoc         `<<TAG` … `TAG` bodies (shell, PHP, Ruby); `'strict'`
//                   demands `~`/`-`/quotes after `<<` so Ruby's `array << x`
//                   is never mistaken for one.
//
// The mask invariant is a property of the implementation, not a promise: every
// write goes through `blank()`, which replaces characters with spaces and never
// touches `\n`, so the mask has the same length and every newline at the same
// offset. `lib/section.mjs` asserts it again, naming the lexer.
// ============================================================================

export { JS_SYNTAX, JAVA_SYNTAX, ZIG_SYNTAX } from './syntaxes.js';

/** @typedef {{ text: string, from: number, to: number }} Comment */
/** @typedef {{ from: number, to: number, quote: string, multiline: boolean }} StringSpan */
/** @typedef {{ offset: number, brace: number, line: number, col: number, snippet: string, clause: string }} IfClause */
/** @typedef {{ open: string, close: string, nested?: boolean, lineStart?: boolean }} BlockComment */
/**
 * @typedef {object} StringKind
 * @property {string} open            the literal opener, e.g. `"`, `"""`, `r'`, `@"`
 * @property {string} [close]         the literal closer (defaults to `open`); `hashes` computes it
 * @property {'backslash' | 'doubling' | null} [escape] how the closer is escaped inside
 * @property {boolean} [multiline]    may span lines
 * @property {boolean} [lineScoped]   runs to the end of the line (Zig `\\`)
 * @property {boolean} [boundary]     the opener may not follow an identifier character
 * @property {boolean} [hashes]       Rust raw string: `r#*"` … `"#*`
 * @property {number} [maxSpan]       the closer must be this close (Rust char vs lifetime)
 * @property {RegExp} [content]       and the body must match this (again: char vs lifetime)
 */
/**
 * @typedef {object} Syntax
 * @property {string} name
 * @property {string[]} [lineComments]
 * @property {BlockComment[]} [blockComments]
 * @property {StringKind[]} [strings]
 * @property {boolean | 'strict'} [heredoc]
 */

// --- v1 spells the same facts, so both shapes normalise to one ------- -----

const NORMALIZED = new WeakMap();

/** A boundary-prefixed opener may not follow an identifier character. */
const ID_CHAR = /[A-Za-z0-9_$]/;

/** The opener that appears first at a position wins, so longest first. */
function longestFirst(kinds, open) {
    return [...kinds].sort((left, right) => (open(right).length - open(left).length));
}

/**
 * Normalise either syntax spelling into the one the engine walks:
 * `{ lineComments, blockComments, strings, heredoc }`. The v1 spelling
 * (`lineComment`, `blockComment`, `strings: [{ quote }]`) stays accepted, so
 * the exported `JS_SYNTAX`/`JAVA_SYNTAX`/`ZIG_SYNTAX` keep working unchanged.
 *
 * @param {object} syntax
 * @returns {Syntax}
 */
export function normalizeSyntax(syntax) {
    if (!syntax) throw new Error('tokenize: no syntax given');
    const cached = NORMALIZED.get(syntax);
    if (cached) return cached;

    const lineComments = longestFirst(
        syntax.lineComments ?? (syntax.lineComment ? [syntax.lineComment] : []),
        (text) => text,
    );
    const blockComments = longestFirst(
        syntax.blockComments ?? (syntax.blockComment ? [syntax.blockComment] : []),
        (block) => block.open,
    );
    const strings = longestFirst(
        (syntax.strings ?? []).map((kind) => ({
            open: kind.open ?? kind.quote ?? '',
            close: kind.close ?? kind.open ?? kind.quote ?? '',
            escape: kind.escape === undefined ? 'backslash' : kind.escape,
            multiline: !!kind.multiline || !!kind.lineScoped,
            lineScoped: !!kind.lineScoped,
            boundary: !!kind.boundary,
            hashes: !!kind.hashes,
            maxSpan: kind.maxSpan,
            content: kind.content,
        })).filter((kind) => kind.open !== ''
            && (kind.close !== '' || kind.hashes || kind.lineScoped)),
        (kind) => kind.open,
    );

    const normalized = {
        name: syntax.name ?? 'anonymous',
        lineComments,
        blockComments,
        strings,
        heredoc: syntax.heredoc ?? false,
        declarations: syntax.declarations ?? [],
        annotations: syntax.annotations ?? [],
    };
    NORMALIZED.set(syntax, normalized);
    return normalized;
}

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

/**
 * The string kind that opens at `i`, with the opener length and the closer it
 * implies — `null` when nothing opens there. A `hashes` kind (Rust raw string)
 * reads its own closer: `r#"` closes at `"#`, `r"` at `"`.
 */
function matchString(source, i, kinds) {
    for (const kind of kinds) {
        if (kind.boundary && i > 0 && ID_CHAR.test(source[i - 1])) continue;
        if (kind.hashes) {
            const prefix = kind.open.slice(0, -1);
            if (!source.startsWith(prefix, i)) continue;
            let j = i + prefix.length;
            let hashes = 0;
            while (source[j] === '#') { hashes++; j++; }
            if (source[j] !== '"') continue;
            return { kind, bodyFrom: j + 1, close: `"${'#'.repeat(hashes)}` };
        }
        if (source.startsWith(kind.open, i)) {
            return { kind, bodyFrom: i + kind.open.length, close: kind.close };
        }
    }
    return null;
}

/**
 * The end offset of the string `hit` opens, or `null` when the candidate is not
 * a string after all (a Rust lifetime, a char literal that never closes).
 *
 * `maxSpan` and `content` are the char-versus-lifetime rule: the closer must sit
 * that close, and the body must look like one character (or one escape), so
 * `'a'` is a char while `'a>(x: &'` never is.
 */
function readString(source, hit) {
    const { kind, bodyFrom, close } = hit;
    if (kind.lineScoped) return endOfLine(source, bodyFrom);

    // A constrained kind (a char literal beside a Rust lifetime) must actually
    // close; an unterminated candidate is not a string at all, so the `'` of
    // `&'static str` never swallows the rest of the line.
    const mustClose = kind.maxSpan !== undefined || kind.content !== undefined;
    const escape = kind.escape;
    let j = bodyFrom;
    while (j < source.length) {
        const c = source[j];
        if (c === '\n' && !kind.multiline) return mustClose ? null : j;
        if (escape === 'backslash' && c === '\\') { j += 2; continue; }
        if (escape === 'doubling' && source.startsWith(close, j)
            && source.startsWith(close, j + close.length)) {
            j += close.length * 2;
            continue;
        }
        if (source.startsWith(close, j)) {
            if (kind.maxSpan !== undefined && j - bodyFrom > kind.maxSpan) return null;
            if (kind.content && !kind.content.test(source.slice(bodyFrom, j))) return null;
            return j + close.length;
        }
        j++;
    }
    return mustClose ? null : source.length;
}

/** `<<TAG`, `<<-TAG`, `<<~TAG`, `<<"TAG"` and PHP's `<<<TAG`. */
const HEREDOC_OPEN = /^<<(?<angle><)?(?<strip>[-~]?)(?<quote>["'`]?)(?<tag>[A-Za-z_][A-Za-z0-9_]*)\k<quote>/;

/**
 * The heredoc that opens at `i`, or null. `strict` demands the unambiguous
 * spellings (`<<~`, `<<-`, a quoted tag) so Ruby's `array << x` is never read
 * as one; shell and PHP take the bare `<<TAG` form as well.
 */
function matchHeredoc(source, i, mode) {
    const match = HEREDOC_OPEN.exec(source.slice(i, i + 64));
    if (!match) return null;
    if (mode === 'strict' && match.groups.strip === '' && match.groups.quote === '') return null;
    return { tag: match.groups.tag, length: match[0].length };
}

/** The offset that ends the heredoc body: the terminator line's end of line. */
function heredocEnd(source, from, tag) {
    let i = from;
    while (i <= source.length) {
        const eol = endOfLine(source, i);
        const line = source.slice(i, eol).trim();
        // PHP's terminator may carry the statement's `;` (`EOT;`).
        if (line === tag || line === `${tag};`) return eol;
        if (eol >= source.length) return source.length;
        i = eol + 1;
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
 * @param {Syntax} syntax v1 or v2 spelling; both are accepted
 * @param {{ comment?: (c: Comment & {line:number,col:number}) => void,
 *           string?: (s: StringSpan & {line:number,col:number}) => void,
 *           ifClause?: (c: IfClause) => void }} [visitor]
 * @returns {{ masked: string, comments: Comment[], strings: StringSpan[], ifClauses: IfClause[] }}
 */
export function tokenize(source, syntax, visitor) {
    const lang = normalizeSyntax(syntax);
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

        // Heredocs first: their body spans lines, and `<<` opens nothing else.
        if (lang.heredoc && source.startsWith('<<', i)) {
            const heredoc = matchHeredoc(source, i, lang.heredoc);
            if (heredoc) {
                const openEnd = endOfLine(source, i);
                const end = heredocEnd(source, openEnd + 1, heredoc.tag);
                blank(openEnd + 1, end);
                i = end;
                continue;
            }
        }

        let matched = false;
        for (const open of lang.lineComments) {
            // `#[attr]` is an attribute in Rust and PHP, never a `#` comment.
            if (open === '#' && source[i + 1] === '[') continue;
            if (!source.startsWith(open, i)) continue;
            const end = endOfLine(source, i);
            const body = source.slice(i + open.length, end);
            comments.push({ text: body, from: i, to: end });
            visitor?.comment?.({ text: body, from: i, to: end, ...lineCol(starts, i) });
            blank(i, end);
            i = end;
            matched = true;
            break;
        }
        if (matched) continue;

        const block = lang.blockComments.find((bc) => source.startsWith(bc.open, i)
            && (!bc.lineStart || i === 0 || source[i - 1] === '\n'));
        if (block) {
            const { to, body } = readBlockComment(source, i, block);
            comments.push({ text: body, from: i, to });
            visitor?.comment?.({ text: body, from: i, to, ...lineCol(starts, i) });
            blank(i, to);
            i = to;
            continue;
        }

        const hit = matchString(source, i, lang.strings);
        if (hit) {
            const to = readString(source, hit);
            if (to !== null) {
                const span = { from: i, to, quote: hit.kind.open, multiline: !!hit.kind.multiline };
                strings.push(span);
                visitor?.string?.({ ...span, ...lineCol(starts, i) });
                blank(i, to);
                i = to;
                continue;
            }
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
 * The language's own declaration descriptors and annotation test ride along, in
 * the resolver's shapes: `declarations(maskedLine)` (offsets relative to the
 * line) and `annotationLine(line)`. Neither is built when the language has
 * none, so the resolver's generic shapes stay exactly in charge.
 *
 * @param {Syntax} syntax v1 or v2 spelling
 * @returns {{ name: string, mask: (s: string) => string, comments: (s: string) => Comment[],
 *            declarations?: (line: string) => object[], annotationLine?: (line: string) => boolean }}
 */
export function makeLexer(syntax) {
    const lang = normalizeSyntax(syntax);
    let cacheSrc = null;
    let cacheVal = null;
    const scan = (s) => {
        if (s !== cacheSrc) { cacheSrc = s; cacheVal = tokenize(s, lang); }
        return cacheVal;
    };

    const lexer = {
        name: lang.name,
        mask: (s) => scan(s).masked,
        comments: (s) => scan(s).comments,
    };

    if (lang.declarations.length > 0) {
        lexer.declarations = (maskedLine) => {
            const out = [];
            for (const descriptor of lang.declarations) {
                if (descriptor.re.global) descriptor.re.lastIndex = 0;
                const match = descriptor.re.exec(maskedLine);
                if (!match || !match[1]) continue;
                out.push({
                    kind: descriptor.kind ?? 'method',
                    name: match[1],
                    headerFrom: match.index + match[0].length,
                    body: descriptor.body,
                    end: descriptor.end,
                    line: !!descriptor.line,
                });
            }
            return out;
        };
    }
    if (lang.annotations.length > 0) {
        lexer.annotationLine = (line) => lang.annotations.some((re) => re.test(line));
    }
    return lexer;
}
