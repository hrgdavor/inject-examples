/** @typedef {'declaration' | 'body' | 'annotated' | 'documented'} Scope */

/**
 * @typedef {object} Reference
 * @property {string} raw
 * @property {string} canonical
 * @property {string[]} segments
 * @property {Scope} scope
 * @property {null | { kind: 'contradiction', kept: '++' | '+', dropped: '-' }} warning
 */

/**
 * @typedef {{ kind: 'class'|'method'|'property'|'statement'|'anchor'|'root',
 *            name: string|null,
 *            declLine: number, openLine: number|null, closeLine: number|null,
 *            headerFrom: number|null, open: number|null, close: number|null,
 *            indented: boolean,
 *            children: Block[] }} Block
 */

/**
 * The language-specific half of a scan, injected by a caller that knows the
 * file's type. What a lexer owns is *lexical* — blanking comments and string
 * literals, locating the comments — plus, optionally, the two places where a
 * language spells a member differently from the common shape. Structure,
 * precedence and rendering stay here so every engine agrees. When no lexer is
 * supplied (the file type is unknown) the built-in mask and comment reader are
 * used, and the language-neutral declaration shapes apply.
 *
 * @typedef {object} Lexer
 * @property {string} [name] for diagnostics; a failing invariant names it
 * @property {(text: string) => string} mask
 *           comments and string literals blanked to spaces; length and every
 *           `\n` offset must be preserved (asserted once per scan)
 * @property {(text: string) => { text: string, from: number, to: number }[]} comments
 *           comment spans read from the original text, feeding anchors (matcher 6)
 *           and region directives (matcher 1)
 * @property {(line: string, from: number) => { exact: string[], pasted: string[] }} [conditionLiterals]
 *           the double-quoted literals a header line carries (matcher 5);
 *           defaults to the built-in reader when absent
 * @property {(maskedLine: string) => Array<{ kind?: 'class'|'method', name: string,
 *            headerFrom: number, line?: boolean }>} [declarations]
 *           declaration shapes this language adds to the generic ones (Ruby
 *           `def name`, a Haskell binding). The line arrives already masked, so
 *           a name inside a string or comment can never match; `headerFrom` is
 *           the offset in the line where the declaration's body starts, and
 *           `line: true` says the declaration line is itself a complete
 *           selection when no body follows (a one-line Haskell binding).
 * @property {(line: string) => boolean} [annotationLine]
 *           what counts as the annotation directly above a declaration, for the
 *           `+` scope (Haskell's `name ::` type signature); defaults to the
 *           `@Decorator` / `#[attribute]` spellings
 */

/**
 * Error for a malformed section reference.
 */
export class SectionReferenceError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SectionReferenceError';
    }
}

function scopeFromModifier(modifier) {
    if (modifier === '-') return 'body';
    if (modifier === '+') return 'annotated';
    if (modifier === '++') return 'documented';
    return 'declaration';
}

function tokenizeModifierRun(run) {
    const tokens = [];
    let i = 0;
    while (i < run.length) {
        if (i + 1 < run.length && run[i] === '+' && run[i + 1] === '+') {
            tokens.push('++');
            i += 2;
        } else if (run[i] === '+') {
            tokens.push('+');
            i += 1;
        } else if (run[i] === '-') {
            tokens.push('-');
            i += 1;
        } else {
            break;
        }
    }
    return tokens;
}

function extractLeadingModifier(seg, isLastSegment, rawRef) {
    if (seg.length <= 1) return { modifier: null, name: seg };

    if (seg[0] === '-') {
        if (seg[1] === '-' || seg[1] === '+') {
            return { modifier: null, name: seg };
        }
        if (isLastSegment) {
            return { modifier: '-', name: seg.slice(1) };
        }
        throw new SectionReferenceError(
            `"-" may only modify the last path segment of "#${rawRef}"`
        );
    }

    if (seg.startsWith('++')) {
        if (seg[2] === '+' || seg[2] === '-') {
            return { modifier: null, name: seg };
        }
        throw new SectionReferenceError(
            `"++" may only modify the last path segment of "#${rawRef}"`
        );
    }

    if (seg[0] === '+') {
        if (seg[1] === '+' || seg[1] === '-') {
            return { modifier: null, name: seg };
        }
        throw new SectionReferenceError(
            `"+" may only modify the last path segment of "#${rawRef}"`
        );
    }

    return { modifier: null, name: seg };
}

function extractTrailingModifier(name) {
    let i = name.length - 1;
    while (i >= 0 && (name[i] === '+' || name[i] === '-')) {
        i--;
    }
    if (i < name.length - 1) {
        const run = name.slice(i + 1);
        return { name: name.slice(0, i + 1), tokens: tokenizeModifierRun(run) };
    }
    return { name, tokens: [] };
}

/**
 * @throws {SectionReferenceError}
 * @param {string} raw
 * @returns {Reference}
 */
export function parseReference(raw) {
    if (raw === '') {
        throw new SectionReferenceError('"#" names nothing');
    }

    let detached = null;
    let remainder = raw;

    if (raw.startsWith('++')) {
        detached = '++';
        remainder = raw.slice(2);
    } else if (raw.startsWith('+')) {
        detached = '+';
        remainder = raw.slice(1);
    } else if (raw.startsWith('-')) {
        detached = '-';
        remainder = raw.slice(1);
    }

    if (remainder === '') {
        throw new SectionReferenceError(`"#${raw}" names nothing`);
    }

    const parts = remainder.split('/');

    if (parts.some((p) => p === '')) {
        throw new SectionReferenceError(`"#${raw}" has an empty path segment`);
    }

    if (parts.length > 8) {
        throw new SectionReferenceError(`"#${raw}" is deeper than 8 sections`);
    }

    let detachedSecond = null;
    if (detached === null && parts.length === 2) {
        const secondSeg = parts[1];
        if (secondSeg.length > 1 && secondSeg[0] === '-' && secondSeg[1] !== '-' && secondSeg[1] !== '+') {
            detachedSecond = '-';
            parts[1] = secondSeg.slice(1);
        }
    }

    const allModifiers = [];
    const cleanSegments = [];

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const seg = parts[i];

        const { modifier: leadingMod, name: afterLeading } = extractLeadingModifier(
            seg,
            isLast,
            raw
        );

        if (leadingMod) {
            allModifiers.push(leadingMod);
        }

        const { name, tokens: trailingTokens } = extractTrailingModifier(afterLeading);

        if (trailingTokens.length > 0) {
            allModifiers.push(...trailingTokens);
        }

        if (name.includes('+') || name.includes('-')) {
            // A bare name (one segment, nothing detached) keeps today's meaning
            // (contract §5 rule 4): a legacy `#region` name may contain `-`,
            // e.g. `update-document-test`. Any `+`, or a hyphen inside a
            // multi-segment path, is strict (contract §5): modifiers/`/` are
            // structure, never part of a name.
            const isLegacyBareName = parts.length === 1 && detached === null && detachedSecond === null && !name.includes('+');
            if (!isLegacyBareName) {
                const ch = name.includes('+') ? '+' : '-';
                throw new SectionReferenceError(
                    `"${ch}" may only modify the last path segment of "#${raw}"`
                );
            }
        }

        cleanSegments.push(name);
    }

    if (cleanSegments.some((s) => s === '')) {
        throw new SectionReferenceError(`"#${raw}" has an empty path segment`);
    }

    if (detached) allModifiers.unshift(detached);
    if (detachedSecond) allModifiers.unshift(detachedSecond);

    let modifier = null;
    let warning = null;

    if (allModifiers.length === 0) {
        modifier = null;
    } else if (allModifiers.length === 1) {
        modifier = allModifiers[0];
    } else {
        const posCount = allModifiers.filter((m) => m[0] === '+').length;
        const negCount = allModifiers.filter((m) => m[0] === '-').length;
        if (posCount > 1 || negCount > 1) {
            throw new SectionReferenceError(
                `"#${raw}" carries more than one modifier`
            );
        }
        if (allModifiers.includes('++')) {
            modifier = '++';
            warning = { kind: 'contradiction', kept: '++', dropped: '-' };
        } else if (allModifiers.includes('+')) {
            modifier = '+';
            warning = { kind: 'contradiction', kept: '+', dropped: '-' };
        } else {
            throw new SectionReferenceError(
                `"#${raw}" carries more than one modifier`
            );
        }
    }

    const scope = scopeFromModifier(modifier);
    const canonical = cleanSegments.join('/') + (modifier || '');

    if (warning !== null) {
        warning.canonical = canonical;
        warning.message = `"${warning.kept}" contradicts "${warning.dropped}"; using "#${canonical}"`;
    }

    return { raw, canonical, segments: cleanSegments, scope, warning };
}

/**
 * @param {Reference | string} reference
 * @returns {boolean}
 */
export function isSingleSegment(reference) {
    if (typeof reference === 'string') {
        return parseReference(reference).segments.length === 1;
    }
    return reference.segments.length === 1;
}

/**
 * @param {Reference | string} reference
 * @returns {string}
 */
export function finalSegment(reference) {
    if (typeof reference === 'string') {
        reference = parseReference(reference);
    }
    return reference.segments[reference.segments.length - 1];
}

// ============================================================================
// Part A — mask pass
// ============================================================================

/**
 * `text` with every comment and string literal blanked to spaces, newlines
 * kept. Offsets and line structure are untouched, so a brace inside a string
 * or a comment cannot be mistaken for the end of a declaration's body.
 *
 * `#` opens a line comment except before `[`, which keeps a Rust attribute
 * (`#[derive(Debug)]`) readable while hiding a Python or shell comment.
 *
 * Asserts `masked.length === text.length` and that every `\n` is at the
 * same offset in both.
 *
 * @param {string} text
 * @returns {string}
 */
export function masked(text) {
    const out = text.split('');
    const blank = (from, to) => {
        for (let i = from; i < to && i < out.length; i++) {
            if (out[i] !== '\n') out[i] = ' ';
        }
    };

    let i = 0;
    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];
        if (char === '/' && next === '/') {
            const end = endOfLine(text, i);
            blank(i, end);
            i = end;
        } else if (char === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            const end = close === -1 ? text.length : close + 2;
            blank(i, end);
            i = end;
        } else if (char === '#' && next !== '[') {
            const end = endOfLine(text, i);
            blank(i, end);
            i = end;
        } else if (char === '"' || char === "'" || char === '`') {
            const quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
            let j = i + quote.length;
            while (j < text.length) {
                if (text[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (text.startsWith(quote, j)) {
                    j += quote.length;
                    break;
                }
                j++;
            }
            const end = Math.min(j, text.length);
            blank(i, end);
            i = end;
        } else {
            i++;
        }
    }

    if (out.join('').length !== text.length) {
        throw new Error('masked length mismatch');
    }
    for (let k = 0; k < text.length; k++) {
        if (text[k] === '\n' && out[k] !== '\n') {
            throw new Error('newline offset mismatch');
        }
    }

    return out.join('');
}

/**
 * Comment-only spans, per line index: [{ text, from, to }], where text is the
 * comment body (the `//` or `/*` delimiters stripped).
 *
 * Reads the original text — a comment cannot be recovered from the mask.
 * Does not report comment markers that sit inside string literals.
 *
 * @param {string} text
 * @returns {{ text: string, from: number, to: number }[]}
 */
export function commentsIn(text) {
    const result = [];

    let i = 0;
    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '/' && next === '/') {
            const end = endOfLine(text, i);
            const body = text.slice(i + 2, end);
            result.push({ text: body, from: i, to: end });
            i = end;
        } else if (char === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            const end = close === -1 ? text.length : close + 2;
            const body = text.slice(i + 2, close === -1 ? end : close);
            result.push({ text: body, from: i, to: end });
            i = end;
        } else if (char === '"' || char === "'" || char === '`') {
            const quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
            let j = i + quote.length;
            while (j < text.length) {
                if (text[j] === '\\') { j += 2; continue; }
                if (text.startsWith(quote, j)) { j += quote.length; break; }
                j++;
            }
            i = Math.min(j, text.length);
        } else {
            i++;
        }
    }

    return result;
}

// ============================================================================
// Part B — block scanner
// ============================================================================

/** The offset of the line `offset` falls on, given each line's start. */
function lineOf(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

/** The index of the first non-blank line at or after `from`, or -1. */
function nextNonBlank(lines, from) {
    for (let i = from; i < lines.length; i++) {
        if (lines[i].trim() !== '') return i;
    }
    return -1;
}

/** The offset at which the line holding `offset` ends. */
function endOfLine(text, offset) {
    const newline = text.indexOf('\n', offset);
    return newline === -1 ? text.length : newline;
}

/** Escape a name for use inside a regular expression. */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The offset of the bracket that closes the one at `open`, or -1. */
function matchingBracket(text, open, closer) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === text[open]) depth++;
        else if (text[i] === closer) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Constants — kept in step with index.mjs so the two scanners agree.
// ---------------------------------------------------------------------------

const COMMENT_OPENER = /^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i;
const COMMENT_CLOSER = /\s*(?:-->|\*\/)$/;

const DOC_OPEN = /^\s*\/\*[*!]/;
const DOC_RUN = /^\s*\/\/\//;
const ANNOTATION_LINE = /^\s*(?:@[\w.$]|#\[)/;

const DECLARATION_KEYWORD =
    /\b(?:class|interface|enum|record|struct|trait|object|union)\s+([A-Za-z_$][\w$]*)\b/;

const NOT_A_NAME = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'do', 'else',
    'throw', 'await', 'yield', 'typeof', 'delete', 'void', 'in', 'of',
    'instanceof', 'super', 'this', 'with', 'case', 'when', 'sizeof',
]);

const STATEMENT_BEFORE = /^(?:return|throw|new|await|yield|delete|typeof|case|else|do)\b/;
const PREFIX = /^[\w$<>\[\],.?*&:@\s]*$/;

/** Matcher 5 (§6): a statement block opens on a line carrying this keyword. */
const STATEMENT_KEYWORD =
    /\b(if|else|for|while|do|switch|try|catch|finally|synchronized)\b/;

/** How far a line is indented. */
function indentWidth(line) {
    return line.length - line.trimStart().length;
}

/**
 * Read one line as a region directive, or null. Port of `regionDirective`
 * (index.mjs:45) — same spellings, same "bare `region` is prose" rule.
 */
function regionDirective(line) {
    let text = line.trim();
    const closer = COMMENT_CLOSER.exec(text);
    if (closer) text = text.slice(0, closer.index).trim();
    const commented = COMMENT_OPENER.test(text);
    if (commented) text = text.replace(COMMENT_OPENER, '').trim();
    const match = /^(#?)(region|endregion)\b\s*(.*)$/i.exec(text);
    if (!match) return null;
    if (!commented && match[1] !== '#') return null;
    return { kind: match[2].toLowerCase(), name: match[3].trim() };
}

/**
 * The double-quoted string literals a header line carries, read from the
 * original text but with comments skipped — the same blanking the mask does,
 * applied to this line so a literal inside a comment is never reported. Two
 * forms: the byte-exact literal, and the token-pasted form where adjacent
 * literals (separated only by whitespace or `+`) join.
 *
 * @param {string} origLine the original line text
 * @param {number} from     offset in the line to start scanning at (the segment's
 *                          own keyword), so an `if/else-if` chain only reports the
 *                          literals between this keyword and the next.
 * @returns {{ exact: string[], pasted: string[] }}
 */
function conditionLiterals(origLine, from) {
    const literals = [];
    let i = from;
    while (i < origLine.length) {
        const ch = origLine[i];
        const next = origLine[i + 1];
        if (ch === '/' && next === '/') break;
        if (ch === '/' && next === '*') {
            const close = origLine.indexOf('*/', i + 2);
            i = close === -1 ? origLine.length : close + 2;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            while (j < origLine.length && origLine[j] !== '"') {
                if (origLine[j] === '\\') j++;
                j++;
            }
            literals.push({ start: i, end: j });
            i = j + 1;
            continue;
        }
        i++;
    }
    const exact = literals.map((l) => origLine.slice(l.start + 1, l.end));
    const pasted = [];
    for (let k = 0; k < literals.length; k++) {
        let merged = origLine.slice(literals[k].start + 1, literals[k].end);
        let m = k + 1;
        while (m < literals.length) {
            const gap = origLine.slice(literals[m - 1].end + 1, literals[m].start);
            if (!/^[\s+]*$/.test(gap)) break;
            merged += origLine.slice(literals[m].start + 1, literals[m].end);
            m++;
        }
        pasted.push(merged);
        k = m - 1;
    }
    return { exact, pasted };
}

/**
 * A body span, or null when the member has no body to inject (an interface or
 * `abstract` method). Port of `declarationRange` (index.mjs:351) over the mask.
 */
function bodySpan(masked, lines, starts, declLine, headerFrom) {
    const lineEnd = endOfLine(masked, starts[declLine]);
    const rest = masked.slice(headerFrom, Math.max(headerFrom, lineEnd));
    const terminators = [
        { at: rest.indexOf('{'), kind: 'brace' },
        { at: rest.indexOf(';'), kind: 'none' },
        { at: rest.indexOf('=>'), kind: 'arrow' },
    ].filter((o) => o.at !== -1).sort((l, r) => l.at - r.at);
    const first = terminators[0];
    if (first?.kind === 'none') return null;

    if (first?.kind === 'arrow') {
        const open = headerFrom + first.at + 2 + rest.slice(first.at + 2).indexOf('{');
        if (rest.slice(first.at + 2).indexOf('{') === -1) {
            return { expression: headerFrom + first.at + 2, open: null, close: null };
        }
        return braceBody(masked, starts, open);
    }
    if (first?.kind === 'brace') {
        return braceBody(masked, starts, headerFrom + first.at);
    }

    const next = nextNonBlank(lines, declLine + 1);
    if (next === -1) return null;
    if (/^\s*\{/.test(lines[next])) {
        return braceBody(masked, starts, starts[next] + lines[next].indexOf('{'));
    }
    const indent = indentWidth(lines[declLine]);
    if (indentWidth(lines[next]) > indent) {
        let end = next;
        for (let i = next + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;
            if (indentWidth(lines[i]) <= indent) break;
            end = i;
        }
        return { indented: true, open: null, close: null, bodyEndLine: end };
    }
    return null;
}

function braceBody(masked, starts, open) {
    const close = matchingBracket(masked, open, '}');
    if (close === -1) return null;
    return { open, close, openLine: lineOf(starts, open), closeLine: lineOf(starts, close) };
}

/**
 * A body closed by a terminator keyword line (`end` in Ruby), found by
 * indentation: the first line at or left of the declaration's indentation whose
 * trimmed text is the terminator closes the block. This is the convention real
 * Ruby code follows, not a parse — an inner `do … end` is indented further and
 * so is skipped — and when no terminator is found that way the declaration gets
 * no block at all, rather than half a method injected.
 *
 * @returns {{ openLine: number, closeLine: number } | null}
 */
function keywordBody(lines, declLine, word) {
    const indent = indentWidth(lines[declLine]);
    for (let i = declLine + 1; i < lines.length; i++) {
        const text = lines[i].trim();
        if (text === '') continue;
        if (indentWidth(lines[i]) > indent) continue;
        if (text === word || text.startsWith(`${word} `)) return { openLine: declLine, closeLine: i };
        return null;                     // a dedent that is not the terminator
    }
    return null;
}

/**
 * Whether a masked line declares `name`, and where its header ends. Port of
 * `declarationOn` (index.mjs:279); here the name is returned too so the
 * scanner can index declarations by it.
 *
 * `declared` is the lexer's own reading of the line (see the `Lexer` typedef) —
 * the language-specific shapes, checked before the generic ones.
 *
 * @returns {{ kind: 'class'|'method', name: string, headerFrom: number } | null}
 */
function declarationOn(maskedLine, start, name, declared = []) {
    if (name === '' || NOT_A_NAME.has(name)) return null;

    const own = declared.find((entry) => entry.name === name);
    if (own) return { kind: own.kind ?? 'method', name, headerFrom: start + own.headerFrom };

    const keyword = DECLARATION_KEYWORD.exec(maskedLine);
    if (keyword && keyword[1] === name) {
        return { kind: 'class', name, headerFrom: start + keyword.index + keyword[0].length };
    }

    const call = new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}\\s*\\(`, 'g');
    let match;
    while ((match = call.exec(maskedLine)) !== null) {
        const at = start + match.index + match[1].length;
        const before = maskedLine.slice(0, match.index + match[1].length);
        const prefix = before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
        if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
        const paren = start + match.index + match[0].length - 1;
        const close = matchingBracket(maskedLine, paren - start, ')');
        if (close === -1) continue;
        return { kind: 'method', name, headerFrom: start + close + 1 };
    }

    const assigned = new RegExp(
        `(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?${escapeRegExp(name)}\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?`,
        'g',
    );
    while ((match = assigned.exec(maskedLine)) !== null) {
        const after = match.index + match[0].length;
        const rest = maskedLine.slice(after);
        const arrow = rest.indexOf('=>');
        const fn = /^function\b/.exec(rest);
        if (arrow !== -1 && (fn === null || arrow < fn.index)) {
            return { kind: 'method', name, headerFrom: start + after + arrow };
        }
        if (fn) return { kind: 'method', name, headerFrom: start + after + fn[0].length };
    }
    return null;
}

/** Matcher 4: `Type name = …` / `static final Type name = …` / `const name = …`.
 *  A `const`/`let`/`var` needs no type; otherwise at least one type token must
 *  precede the name, which keeps body assignments (`count = 0`) out. */
const PROPERTY_DECL =
    /(?<!\.)\b(?:(const|let|var)\s+|((?:[\w$]+(?:<[^<>]*>)?)(?:\s+[\w$]+(?:<[^<>]*>)?)*?)\s+)([A-Za-z_$][\w$]*)\b\s*=(?!=)/;

/** A word that stands where a type or modifier would, but declares nothing. */
const NOT_A_TYPE = new Set(['return', 'throw', 'new', 'else', 'do', 'case', 'await', 'yield', 'delete', 'typeof']);

/**
 * The segments of an if/else-if (or try/catch) chain opened on this line.
 * Bare-`else` and `do … while` terminators are respected.
 *
 * @returns {{ headerKeyword: string, headerLine: number, open: number,
 *             close: number, openLine: number, closeLine: number }[]}
 */
function chainSegments(masked, starts, headerLine, keyword, bracePos, keywordOffset) {
    const segments = [];
    const isCont = (w) => w === 'else' || w === 'catch' || w === 'finally';
    let curKeyword = keyword;
    let curLine = headerLine;
    let open = bracePos;
    let condFrom = keywordOffset;   // offset of this segment's keyword in the line
    let i = bracePos;
    let depth = 0;
    while (i < masked.length) {
        const c = masked[i];
        if (c === '{') { depth++; i++; continue; }
        if (c === '}') {
            depth--;
            if (depth === 0) {
                const rest = masked.slice(i + 1);
                const word = /^\s*([A-Za-z_]+)/.exec(rest);
                const cont = word && isCont(word[1]) ? word[1] : null;
                if (cont === 'else' && /^\s*else\s+if\b/.test(rest)) {
                    const newOpen = masked.indexOf('{', i + 1);
                    segments.push(makeSegment(masked, starts, curKeyword, curLine, open, i, condFrom, true));
                    const ifAt = (i + 1) + /\bif\b/.exec(rest).index;
                    curKeyword = 'if'; curLine = lineOf(starts, i); open = newOpen; condFrom = ifAt; i = newOpen + 1; depth = 1; continue;
                }
                if (cont === 'else') {
                    // bare `} else {`
                    const newOpen = masked.indexOf('{', i + 1);
                    segments.push(makeSegment(masked, starts, curKeyword, curLine, open, i, condFrom, true));
                    const kwAt = (i + 1) + word.index;
                    curKeyword = cont; curLine = lineOf(starts, i); open = newOpen; condFrom = kwAt; i = newOpen + 1; depth = 1; continue;
                }
                if (cont) {
                    const newOpen = masked.indexOf('{', i + 1);
                    segments.push(makeSegment(masked, starts, curKeyword, curLine, open, i, condFrom, true));
                    const kwAt = (i + 1) + word.index;
                    curKeyword = cont; curLine = lineOf(starts, i); open = newOpen; condFrom = kwAt; i = newOpen + 1; depth = 1; continue;
                }
                let end = i;
                if (curKeyword === 'do' && /^\s*while\s*\(/.test(rest)) {
                    const semi = masked.indexOf(';', i);
                    if (semi !== -1) end = semi;
                }
                segments.push(makeSegment(masked, starts, curKeyword, curLine, open, end, condFrom, false));
                return segments;
            }
            i++;
            continue;
        }
        i++;
    }
    segments.push(makeSegment(masked, starts, curKeyword, curLine, open, masked.length - 1, condFrom));
    return segments;
}

function makeSegment(masked, starts, keyword, headerLine, open, close, condFrom, sharedClose) {
    const lineStart = starts[headerLine];
    return {
        headerKeyword: keyword,
        headerLine,
        open,
        close,
        condFrom,
        condOffset: condFrom - lineStart,
        sharedClose: sharedClose === undefined ? false : sharedClose,
        openLine: lineOf(starts, open),
        closeLine: lineOf(starts, close),
    };
}

/**
 * The leading-comment anchor of a braced block (§6 matcher 6), or null: the
 * comment that is the first thing inside the braces — same line after `{`
 * (`{ //getUsers`), or the next non-blank line. A `#region`/`#endregion` line
 * is never an anchor, and a body whose first thing is code has no anchor.
 *
 * @returns {{ name: string, line: number } | null}
 */
function leadingAnchor(comments, source, lines, starts, open) {
    if (open === null || open === undefined) return null;
    let first = null;
    for (const c of comments) {
        if (c.from <= open) continue;
        if (/^\s*$/.test(source.slice(open + 1, c.from))) first = c;
        break;
    }
    if (!first) return null;
    const commentLine = lineOf(starts, first.from);
    const braceLine = lineOf(starts, open);
    if (commentLine !== braceLine && commentLine !== nextNonBlank(lines, braceLine + 1)) return null;
    const body = first.text.trim();
    if (/^(#?)(region|endregion)\b/i.test(body)) return null;
    const name = /^([A-Za-z_$][\w$]*)$/.exec(body);
    if (!name) return null;
    return { name: name[1], line: commentLine };
}

/**
 * The built-in lexer: the language-agnostic mask and comment reader
 * `scanBlocks` uses when no file-type lexer is supplied — the file's type is
 * unknown, so this default engine masks it. `conditionLiterals` is omitted and
 * falls back to the module reader.
 * @type {Lexer}
 */
const DEFAULT_LEXER = { name: 'default', mask: masked, comments: commentsIn };

/**
 * The lexical facts one scan needs, built once from a {@link Lexer} (defaulting
 * to {@link DEFAULT_LEXER}) and threaded through the scanner. Asserts the mask
 * invariant for a supplied lexer so a bad engine fails loudly, not silently.
 *
 * @param {string} source newline-normalised source
 * @param {Lexer} [lexer]
 * @returns {{ source: string, lines: string[], starts: number[], mask: string,
 *            maskLines: string[], comments: object[],
 *            conditionLiterals: (line: string, from: number) => object }}
 */
function makeLex(source, lexer) {
    const L = lexer || DEFAULT_LEXER;
    const lines = source.split('\n');
    const starts = [];
    let off = 0;
    for (const line of lines) { starts.push(off); off += line.length + 1; }

    const who = `lexer "${L.name ?? 'anonymous'}"`;
    const mask = L.mask(source);
    if (mask.length !== source.length) {
        throw new Error(`${who} mask must preserve length (${mask.length} != ${source.length})`);
    }
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n' && mask[i] !== '\n') {
            throw new Error(`${who} mask must preserve every newline offset (broken at ${i})`);
        }
    }
    const maskLines = mask.split('\n');
    const comments = L.comments(source);

    return {
        source, lines, starts, mask, maskLines, comments,
        conditionLiterals: L.conditionLiterals || conditionLiterals,
        declarations: L.declarations || null,
        annotationLine: L.annotationLine || undefined,
    };
}

/**
 * Scan a source for blocks and the indexable things in each scope. Pure data
 * (contract §10: no Node imports): the block tree plus region pairs, condition
 * literals and comment anchors, ready for the step-6 resolver.
 *
 * @param {string} text the source text
 * @param {string} [path] unused today; reserved for line-ending/language hints
 * @param {Lexer} [lexer] the file type's lexer; the built-in engine when omitted
 * @returns {{ root: Block, blocks: Block[], regions: object[], anchors: object[], lex: object }}
 */
export function scanBlocks(text, path, lexer) {
    void path;
    const source = text.replace(/\r\n/g, '\n');
    const lex = makeLex(source, lexer);
    const { lines } = lex;
    const blocks = [];
    const anchors = [];

    const root = makeBlock('root', null, -1);
    const top = buildScope(root, 0, lines.length - 1, lex, blocks);
    root.children.push(...top);
    for (const c of top) { c.parent = root; c.scope = root; }

    const regions = pairRegions(lines);
    for (const r of regions) {
        r.line = r.startLine;
        r.kind = 'region';
        r.scope = root;
        root.regions.push(r);
    }
    for (const b of blocks) {
        if (b.anchor) anchors.push({ line: b.anchor.line, name: b.anchor.name, block: b });
    }

    return { root, blocks, regions, anchors, lex };
}

// ============================================================================
// Part C — resolve layer (contract §6–§9): matcher precedence, scope walk,
// modifier application. Ports index.mjs's renderDeclaration unchanged.
// ============================================================================

/** The balance of (), [] and {} on one line. */
function bracketBalance(line) {
    let depth = 0;
    for (const char of line) {
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;
    }
    return depth;
}

/**
 * The first line of the annotation block directly above `declLine`, or -1.
 * `isAnnotation` is the language's own test when its lexer supplies one — the
 * `+` scope is "the declaration and what labels it above", which for Haskell is
 * the `name ::` type signature rather than a decorator.
 */
function annotationStart(lines, declLine, isAnnotation = (line) => ANNOTATION_LINE.test(line)) {
    let found = -1;
    for (let i = declLine - 1; i >= 0; i--) {
        if (lines[i].trim() === '') break;
        if (isAnnotation(lines[i])) {
            found = i;
            break;
        }
    }
    if (found === -1) return -1;

    let start = found;
    for (let i = found - 1; i >= 0; i--) {
        if (lines[i].trim() === '' || !isAnnotation(lines[i])) break;
        start = i;
    }

    // The block must be annotations all the way. A statement between the
    // declaration and the annotation means there is no annotation block.
    let depth = 0;
    for (let i = start; i < declLine; i++) {
        if (depth === 0 && !isAnnotation(lines[i])) return -1;
        depth += bracketBalance(lines[i]);
    }
    return depth === 0 ? start : -1;
}

/** The first line of the doc comment directly above `top`, or -1. */
function docCommentStart(lines, top) {
    const previous = top - 1;
    if (previous < 0 || lines[previous].trim() === '') return -1;

    if (DOC_RUN.test(lines[previous])) {
        let start = previous;
        while (start - 1 >= 0 && DOC_RUN.test(lines[start - 1])) start--;
        return start;
    }
    if (!/\*\/\s*$/.test(lines[previous])) return -1;
    for (let i = previous; i >= 0; i--) {
        if (lines[i].trim() === '') return -1;
        if (DOC_OPEN.test(lines[i])) return i;
    }
    return -1;
}

/**
 * The text one declaration contributes, under one scope. Port of
 * `renderDeclaration` (index.mjs:445) unchanged; `range` carries
 * `declLine`, `endLine`, `open`/`close`/`openLine`, `indented`, `expression`.
 *
 * `singleLine` marks a declaration a language writes without a body — a
 * one-line Haskell binding: its declaration *is* the line, so the body scope
 * returns the same text instead of an empty slice.
 *
 * `isAnnotation` is the lexer's own annotation test, when it has one.
 */
function renderDeclaration(lines, source, starts, range, scope, isAnnotation) {
    const endLine = range.endLine !== undefined ? range.endLine : range.closeLine;
    if (scope === 'body') {
        if (range.singleLine) return span(lines.slice(range.declLine, endLine + 1), range.declLine, endLine);
        if (range.indented) return span(lines.slice(range.declLine + 1, endLine + 1), range.declLine + 1, endLine);
        if (range.expression !== undefined) {
            const at = lineOf(starts, range.expression);
            return single(source.slice(range.expression, endOfLine(source, range.expression)).trim(), at);
        }
        if (range.openLine === endLine) {
            return single(source.slice(range.open + 1, range.close).trim(), range.openLine);
        }
        return span(lines.slice(range.openLine + 1, endLine), range.openLine + 1, endLine - 1);
    }

    let start = range.declLine;
    if (scope === 'annotated' || scope === 'documented') {
        const annotated = annotationStart(lines, range.declLine, isAnnotation);
        if (annotated !== -1) start = annotated;
        if (scope === 'documented') {
            const documented = docCommentStart(lines, start);
            if (documented !== -1) start = documented;
        }
    }
    return span(lines.slice(start, endLine + 1), start, endLine);
}

/**
 * A rendered section: the text, and the **1-based inclusive line range** it came from.
 *
 * The span exists because a host that navigates needs to know *where* the section is, not only what it
 * says — a click lands on a line. `fromLine`/`toLine` are the 0-based bounds of the slice the text was
 * made from, so no second search is needed to find it again.
 *
 * @param {string[]} lines the slice's own lines
 * @param {number} fromLine the slice's first line, 0-based
 * @param {number} toLine the slice's last line, 0-based inclusive (below `fromLine` when the slice is empty)
 */
function span(lines, fromLine, toLine) {
    const from = fromLine + 1;
    return { text: lines.join('\n'), from, to: Math.max(fromLine, toLine) + 1 };
}

/** A one-line section: the same as {@link span} with both bounds on that line (0-based). */
function single(text, at) {
    return { text, from: at + 1, to: at + 1 };
}

/**
 * The matcher-precedence lookup of `segment` inside one scope, matchers 1–6,
 * considering only this scope's own members (no descent). Returns the matches of
 * the **first matcher that has any**, in walk order — usually one, but a name may
 * be declared more than once at one level (a Rust `struct Cart` beside its
 * `impl Cart`), and the caller retries them. The first element is always the hit
 * the contract's "first in walk order" rule names.
 *
 * @param {object} scope
 * @param {string} segment
 * @param {boolean} descended
 * @returns {Array<{ kind: string, block: object, headerLine?: number } | { region: object }>}
 */
function matchSegment(scope, segment, descended) {
    // 1 — region directive (modifier ignored).
    const regions = scope.regions.filter((r) => r.name === segment);
    if (regions.length > 1) {
        throw new Error(`"#region ${segment}" appears ${regions.length} times; region names must be unique`);
    }
    if (regions.length === 1) return [{ region: regions[0] }];

    // When we have descended *into* this block, its own comment anchor (the
    // block named by a leading comment) is in scope for this segment. Checked
    // early so `handler/getUsers` resolves to the handler block itself.
    if (descended && scope.anchor && scope.anchor.name === segment) {
        return [{ kind: 'anchor', block: scope, headerLine: scope.anchor.line }];
    }

    // 2 — class-like, 3 — method/function (body-carrying), 4 — property. Every
    // same-named declaration of the winning kind is a candidate, in source order.
    const named = (kind) => scope.children.filter((b) => b.kind === kind && b.name === segment);
    const klass = named('class');
    if (klass.length > 0) return klass.map((block) => ({ kind: 'declaration', block }));
    const method = named('method');
    if (method.length > 0) return method.map((block) => ({ kind: 'declaration', block }));
    const prop = named('property');
    if (prop.length > 0) return prop.map((block) => ({ kind: 'property', block }));

    // 5 — condition literal: this scope's own condition (when the scope is a
    // statement block) or a direct statement child. Deeper statements are
    // reached only by the level-order descent in `searchSegments`, never by a
    // sweep here, so a shallower sibling declaration or anchor outranks a
    // same-named block nested inside an earlier sibling (rule 5).
    if (scope.kind === 'statement' && scope.conditions && scope.conditions.pasted.includes(segment)) {
        return [{ kind: 'condition', block: scope, headerLine: scope.declLine }];
    }
    const cond = scope.children.filter(
        (c) => c.kind === 'statement' && c.conditions && c.conditions.pasted.includes(segment),
    );
    if (cond.length > 0) return cond.map((block) => ({ kind: 'condition', block, headerLine: block.declLine }));

    // 6 — comment anchor: a child block in this scope whose anchor names the segment.
    const anchored = scope.children.filter((b) => b.anchor && b.anchor.name === segment);
    if (anchored.length > 0) {
        return anchored.map((block) => ({ kind: 'anchor', block, headerLine: block.anchor.line }));
    }

    return [];
}

/** Whether a matched block can hold nested sections (a scope for the walk). */
function isContainer(block) {
    if (block.kind === 'property') return false;
    return block.children.length > 0 || block.indented === true
        || (block.openLine !== null && block.openLine !== undefined && block.openLine < block.closeLine);
}

/**
 * The text `block` contributes under `scope`, per contract §8. `ctx` carries
 * `lines`, `source`, `starts` and the lexer's optional `annotationLine`.
 */
function renderBlock(block, scope, ctx, matchKind) {
    const { lines, source, starts } = ctx;
    const isAnchor = matchKind === 'anchor' || matchKind === 'condition';
    if (!isAnchor && (block.kind === 'class' || block.kind === 'method')) {
        return renderDeclaration(lines, source, starts, block, scope, ctx.annotationLine);
    }
    if (!isAnchor && block.kind === 'property') {
        if (scope === 'body') {
            const eq = source.indexOf('=', starts[block.declLine]);
            if (eq !== -1) {
                const lineEnd = endOfLine(source, starts[block.declLine]);
                return single(source.slice(eq + 1, lineEnd).replace(/;\s*$/, '').trim(), block.declLine);
            }
        }
        return single(lines[block.declLine].trimEnd(), block.declLine);
    }
    // condition literal or comment anchor: the block is the unit. Its first
    // line is the declaration/header line (for an anchor on the open line the
    // anchor comment rides along; for a next-line anchor the header still
    // leads). Body excludes everything up to and including the anchor line.
    const anchorLine = block.anchor ? block.anchor.line : null;
    const firstLine = block.declLine;
    const lastLine = block.closeLine;
    if (scope === 'body') {
        // Body is strictly inside the braces, and for an anchor the anchor
        // comment line is excluded (it may sit on the open line or the next).
        const bodyFrom = Math.max(block.openLine, anchorLine === null ? block.openLine : anchorLine);
        if (bodyFrom >= block.closeLine) {
            // The slice is trimmed, so the span has to account for the blank
            // lines the trim removed at either end — a click lands on the
            // section's first real line, not on the brace.
            const raw = source.slice(block.open + 1, block.close);
            const skipped = raw.length - raw.trimStart().length;
            const dropped = raw.length - raw.trimEnd().length;
            const from = lineOf(starts, block.open + 1 + skipped);
            const to = lineOf(starts, block.close - dropped);
            return { text: raw.trim(), from: from + 1, to: Math.max(from, to) + 1 };
        }
        return span(lines.slice(bodyFrom + 1, block.closeLine), bodyFrom + 1, block.closeLine - 1);
    }
    // A non-final chain segment (`if … } else if …`) shares its closing `}`
    // with the continuation on the same line: end the declaration at the brace,
    // not at the whole line.
    if (block.sharedClose) {
        return span(source.slice(starts[firstLine], block.close + 1).split('\n').map((l) => l.replace(/\s+$/, '')),
            firstLine, lineOf(starts, block.close));
    }
    return span(lines.slice(firstLine, lastLine + 1), firstLine, lastLine);
}

/**
 * Resolve a section reference to text, exposing the reference and any
 * contradiction warning. `resolveSection` is `planSection(...).text`.
 *
 * @param {string} text the target file's content
 * @param {string} reference the `#` fragment content
 * @param {Lexer} [lexer] the file type's lexer; the built-in default engine when omitted
 * @returns {{ text: string, reference: Reference }}
 * @throws {SectionReferenceError} malformed reference
 * @throws {Error} the reference is well formed but matches nothing
 */
export function planSection(text, reference, lexer) {
    const ref = parseReference(reference);
    const source = text.replace(/\r\n/g, '\n');
    const scan = scanBlocks(source, undefined, lexer);
    const { lines, starts } = scan.lex;
    const ctx = { lines, source, starts, annotationLine: scan.lex.annotationLine };

    // Resolve every segment but the last to a container, retrying same-named
    // candidates (a Rust `struct Cart` beside its `impl Cart`), then take the
    // final segment's first match in walk order as the selection.
    const final = resolvePath(ref.segments, 0, scan.root, false, null);

    let rendered;
    let kind;
    if (final.region) {
        rendered = span(lines.slice(final.region.startLine + 1, final.region.endLine),
            final.region.startLine + 1, final.region.endLine - 1);
        kind = 'region';
    } else {
        rendered = renderBlock(final.block, ref.scope, ctx, final.kind);
        kind = final.kind;
    }
    return {
        text: rendered.text, reference: ref,
        startLine: rendered.from, endLine: rendered.to, kind,
    };
}

/**
 * The text a section reference stands for.
 *
 * @param {string} text the target file's content
 * @param {string} reference the `#` fragment content
 * @param {Lexer} [lexer] the file type's lexer; the built-in default engine when omitted
 * @throws {SectionReferenceError} malformed reference
 * @throws {Error} the reference is fine but matches nothing
 */
export function resolveSection(text, reference, lexer) {
    return planSection(text, reference, lexer).text;
}

/**
 * The text a single named declaration contributes, or null when the name
 * declares nothing. Backed by the block scanner (contract §6): searches the
 * whole file at any depth, prefers a class-like over a same-named member, and
 * throws on a genuine overload pair. This is `extractDeclaration`'s semantics,
 * unchanged — it never matches a `#region` directive, only declarations.
 *
 * @param {string} text
 * @param {string} name
 * @param {Scope} [scope]
 * @returns {string | null}
 */
export function extractDeclaration(text, name, scope = 'declaration') {
    if (name === '') return null;
    const source = text.replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const starts = [];
    let off = 0;
    for (const line of lines) { starts.push(off); off += line.length + 1; }
    const scan = scanBlocks(source);

    const found = [];
    const hasBody = (b) => b.singleLine === true || b.expression !== undefined || b.indented
        || (b.openLine !== null && b.openLine !== undefined);
    const walk = (scopeBlock) => {
        for (const b of scopeBlock.children) {
            if ((b.kind === 'class' || b.kind === 'method' || b.kind === 'property') && b.name === name && hasBody(b)) found.push(b);
            walk(b);
        }
    };
    walk(scan.root);
    if (found.length === 0) return null;

    const classes = found.filter((b) => b.kind === 'class');
    const chosen = classes.length > 0 ? classes : found;
    if (chosen.length > 1) throw new Error(`"${name}" is declared ${chosen.length} times; names must be unique`);

    return renderDeclaration(lines, source, starts, chosen[0], scope).text;
}

/**
 * Find every `segment` in the shallowest level of `scope` that has one, in walk
 * order, applying matcher precedence per scope. Scopes are visited level by
 * level — every sibling at the current depth is tried with the full matcher
 * table, left to right, before the walk descends into any block they contain
 * (contract §6 walk order, as amended: siblings before deeper blocks).
 *
 * Usually there is one hit. A name may be declared more than once at one level —
 * a Rust `struct Cart` beside its `impl Cart`, two `impl` blocks for one type —
 * and the caller then retries the siblings, so `Cart/add` can reach the impl
 * when the struct does not hold `add`.
 */
function searchSegments(segment, scope, descended) {
    let level = [{ scope, descended }];
    while (level.length > 0) {
        const hits = [];
        for (const node of level) hits.push(...matchSegment(node.scope, segment, node.descended));
        if (hits.length > 0) return hits;
        const deeper = [];
        for (const node of level) {
            for (const child of node.scope.children) {
                deeper.push({ scope: child, descended: true });
            }
        }
        level = deeper;
    }
    return [];
}

/**
 * Resolve `segments[index..]` starting at `scope`, retrying same-named
 * candidates: a candidate that cannot be a scope, or that does not hold the rest
 * of the path, gives way to the next one at the same level. The **last** segment
 * is not retried — its first match in walk order is the selection, as the
 * contract says — so a path is only ambiguous when the *scopes* disagree, and
 * the error names the first candidate that failed, exactly as before.
 *
 * @param {string[]} segments
 * @param {number} index
 * @param {object} scope
 * @param {boolean} descended
 * @param {string | null} prevName
 * @returns {{ kind: string, block: object, headerLine?: number } | { region: object }}
 */
function resolvePath(segments, index, scope, descended, prevName) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    const candidates = searchSegments(segment, scope, descended);

    if (candidates.length === 0) {
        // The whole reference is one name that matched nothing: the message the
        // contract has always used names both engines it could have come from.
        if (index === 0 && last) {
            throw new Error(`no "#region ${segment}" found, and no section named "${segment}"`);
        }
        throw new Error(`no section named "${segment}" in "${prevName ?? ''}"`);
    }

    let failure = null;
    for (const found of candidates) {
        if (last) return found;
        if (found.region || !isContainer(found.block)) {
            if (failure === null) failure = new Error(`"${segment}" is not a container`);
            continue;
        }
        try {
            return resolvePath(segments, index + 1, found.block, true, segment);
        } catch (err) {
            if (failure === null) failure = err;
        }
    }
    throw failure;
}

function makeBlock(kind, name, declLine) {
    return {
        kind, name, declLine,
        open: null, close: null, openLine: null, closeLine: null,
        indented: false, expression: undefined,
        children: [], blocks: [], regions: [],
        anchor: null, conditions: null,
        parent: null,
        scopeName: null, scopeLine: null,
    };
}

function buildScope(owner, fromLine, toLine, lex, blocks) {
    const { mask, maskLines, source, lines, starts, comments } = lex;
    const list = [];
    let i = fromLine;
    while (i <= toLine) {
        const mLine = maskLines[i];
        if (mLine.trim() === '') { i++; continue; }
        const start = starts[i];

        // The language's own declaration shapes first: they are more specific
        // than the generic ones (Ruby `def name`, a Haskell binding).
        const declared = lex.declarations ? lex.declarations(mLine) : [];
        const declaredHere = declared.filter((entry) => entry.name && !NOT_A_NAME.has(entry.name));
        if (declaredHere.length > 0) {
            let lastEnd = i;
            for (const entry of declaredHere) {
                const span = entry.body === 'end'
                    ? keywordBody(lines, i, entry.end ?? 'end')
                    : bodySpan(mask, maskLines, starts, i, start + entry.headerFrom);
                const blk = makeBlock(entry.kind ?? 'method', entry.name, i);
                if (span) applySpan(blk, span, mask, starts);
                else if (entry.line) { blk.endLine = i; blk.singleLine = true; }
                else continue;                       // nothing to inject
                applyAnchor(blk, lex, span && span.open);
                register(list, blk, blocks);
                descend(blk, i, span, lex, blocks);
                lastEnd = Math.max(lastEnd, endLineOf(span, i));
            }
            i = lastEnd + 1;
            continue;
        }

        const keyword = DECLARATION_KEYWORD.exec(mLine);
        if (keyword && !NOT_A_NAME.has(keyword[1])) {
            const name = keyword[1];
            const headerFrom = start + keyword.index + keyword[0].length;
            const span = bodySpan(mask, maskLines, starts, i, headerFrom);
            const blk = makeBlock('class', name, i);
            applySpan(blk, span, mask, starts);
            applyAnchor(blk, lex, span && span.open);
            register(list, blk, blocks);
            descend(blk, i, span, lex, blocks);
            i = endLineOf(span, i) + 1;
            continue;
        }

        let methodDecl = null;
        let methodHasPrefix = false;
        const callMatch = new RegExp('(^|[^\\w$.])([A-Za-z_$][\\w$]*)\\s*\\(', 'g');
        let cm;
        while ((cm = callMatch.exec(mLine)) !== null) {
            const nm = cm[2];
            if (NOT_A_NAME.has(nm)) continue;
            const before = mLine.slice(0, cm.index + cm[1].length);
            const prefix = before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
            if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
            const found = declarationOn(mLine, start, nm);
            if (found && found.kind === 'method') { methodDecl = found; methodHasPrefix = prefix !== ''; break; }
        }
        if (!methodDecl) {
            const assignedName = new RegExp('(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_$][\\w$]*)\\b[^=\\n]*=\\s*(?:async\\s+)?(?:function\\b|[^;]*=>)', 'g');
            let am;
            while ((am = assignedName.exec(mLine)) !== null) {
                const found = declarationOn(mLine, start, am[2]);
                if (found && found.kind === 'method') { methodDecl = found; methodHasPrefix = true; break; }
            }
        }
        if (methodDecl) {
            const span = bodySpan(mask, maskLines, starts, i, methodDecl.headerFrom);
            if (!span && !methodHasPrefix) { i++; continue; } // a bare `foo();` call, not a declaration
            const blk = makeBlock('method', methodDecl.name, i);
            applySpan(blk, span, mask, starts);
            applyAnchor(blk, lex, span && span.open);
            register(list, blk, blocks);
            descend(blk, i, span, lex, blocks);
            i = endLineOf(span, i) + 1;
            continue;
        }

        const stmt = STATEMENT_KEYWORD.exec(mLine);
        if (stmt) {
            const bracePos = mask.indexOf('{', start);
            if (bracePos !== -1) {
                const segs = chainSegments(mask, starts, i, stmt[1], bracePos, stmt.index);
                let lastCloseLine = i;
                for (const seg of segs) {
                    const blk = makeBlock('statement', null, seg.headerLine);
                    blk.open = seg.open; blk.close = seg.close;
                    blk.openLine = seg.openLine; blk.closeLine = seg.closeLine;
                    blk.sharedClose = seg.sharedClose;
                    blk.endLine = seg.closeLine;
                    const hdrStart = starts[seg.headerLine];
                    const hdrEnd = endOfLine(mask, hdrStart);
                    const condLine = source.slice(hdrStart, hdrEnd);
                    blk.conditions = lex.conditionLiterals(condLine, seg.condOffset);
                    applyAnchor(blk, lex, seg.open);
                    register(list, blk, blocks);
                    descend(blk, seg.headerLine, { openLine: seg.openLine, closeLine: seg.closeLine }, lex, blocks);
                    lastCloseLine = Math.max(lastCloseLine, seg.closeLine);
                }
                i = lastCloseLine + 1;
                continue;
            }
        }

        const prop = PROPERTY_DECL.exec(mLine);
        if (prop && !NOT_A_NAME.has(prop[3]) && !STATEMENT_BEFORE.test(prop[0].trim()) && !(prop[2] && NOT_A_TYPE.has(prop[2].trim().split(/\s+/)[0]))) {
            const blk = makeBlock('property', prop[3], i);
            blk.lineEnd = i;
            register(list, blk, blocks);
            i++;
            continue;
        }

        i++;
    }
    return list;
}

function applySpan(blk, span, mask, starts) {
    void mask; void starts;
    if (!span) return;
    if (span.indented) { blk.indented = true; blk.closeLine = span.bodyEndLine; blk.endLine = span.bodyEndLine; return; }
    if (span.expression !== undefined) { blk.expression = span.expression; blk.endLine = blk.declLine; return; }
    blk.open = span.open; blk.close = span.close;
    blk.openLine = span.openLine; blk.closeLine = span.closeLine;
    blk.endLine = span.closeLine;
}

function endLineOf(span, declLine) {
    if (!span) return declLine;
    if (span.closeLine !== undefined && span.closeLine !== null) return span.closeLine;
    if (span.bodyEndLine !== undefined) return span.bodyEndLine;
    return declLine;
}

function register(list, blk, blocks) {
    list.push(blk);
    blocks.push(blk);
}

// Scan `blk`'s own body and attach the blocks it directly contains. `blk` is
// the scope for those children: `child.parent` and `child.scope` are `blk`.
function descend(blk, declLine, span, lex, blocks) {
    if (!span || span.expression !== undefined || blk.kind === 'property') return;
    let childFrom, childTo;
    if (span.indented) { childFrom = declLine + 1; childTo = span.bodyEndLine; }
    else if (span.openLine !== undefined && span.openLine !== null) { childFrom = span.openLine + 1; childTo = span.closeLine - 1; }
    else return;
    if (childFrom > childTo) return;
    const children = buildScope(blk, childFrom, childTo, lex, blocks);
    for (const c of children) {
        c.parent = blk;
        c.scope = blk;
        c.scopeName = blk.name;
        c.scopeLine = blk.declLine;
    }
    blk.children.push(...children);
    blk.blocks.push(...children);
}

function applyAnchor(blk, lex, open) {
    // No opening offset (an indented body, a keyword-delimited `end` block):
    // there is no brace to hang a comment anchor on, and a missing offset must
    // not be searched as if it were line 0.
    if (open === undefined || open === null) return;
    const a = leadingAnchor(lex.comments, lex.source, lex.lines, lex.starts, open);
    if (a) blk.anchor = a;
}

function pairRegions(lines) {
    const out = [];
    const stack = [];
    lines.forEach((line, index) => {
        const directive = regionDirective(line);
        if (!directive) return;
        if (directive.kind === 'region') stack.push({ name: directive.name, startLine: index });
        else if (stack.length) {
            const open = stack.pop();
            out.push({ name: open.name, startLine: open.startLine, endLine: index });
        }
    });
    return out;
}
