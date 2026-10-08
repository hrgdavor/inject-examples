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
            `"-" may only modify the last path segment of "#region:${rawRef}"`
        );
    }

    if (seg.startsWith('++')) {
        if (seg[2] === '+' || seg[2] === '-') {
            return { modifier: null, name: seg };
        }
        throw new SectionReferenceError(
            `"++" may only modify the last path segment of "#region:${rawRef}"`
        );
    }

    if (seg[0] === '+') {
        if (seg[1] === '+' || seg[1] === '-') {
            return { modifier: null, name: seg };
        }
        throw new SectionReferenceError(
            `"+" may only modify the last path segment of "#region:${rawRef}"`
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
        throw new SectionReferenceError('"#region:" names nothing');
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
        throw new SectionReferenceError(`"#region:${raw}" names nothing`);
    }

    const parts = remainder.split('/');

    if (parts.some((p) => p === '')) {
        throw new SectionReferenceError(`"#region:${raw}" has an empty path segment`);
    }

    if (parts.length > 8) {
        throw new SectionReferenceError(`"#region:${raw}" is deeper than 8 sections`);
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
            const ch = name.includes('+') ? '+' : '-';
            throw new SectionReferenceError(
                `"${ch}" may only modify the last path segment of "#region:${raw}"`
            );
        }

        cleanSegments.push(name);
    }

    if (cleanSegments.some((s) => s === '')) {
        throw new SectionReferenceError(`"#region:${raw}" has an empty path segment`);
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
                `"#region:${raw}" carries more than one modifier`
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
                `"#region:${raw}" carries more than one modifier`
            );
        }
    }

    const scope = scopeFromModifier(modifier);
    const canonical = cleanSegments.join('/') + (modifier || '');

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
 * Whether a masked line declares `name`, and where its header ends. Port of
 * `declarationOn` (index.mjs:279); here the name is returned too so the
 * scanner can index declarations by it.
 *
 * @returns {{ kind: 'class'|'method', name: string, headerFrom: number } | null}
 */
function declarationOn(maskedLine, start, name) {
    if (name === '' || NOT_A_NAME.has(name)) return null;

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
                    segments.push(makeSegment(masked, starts, curKeyword, curLine, open, i, condFrom));
                    const ifAt = (i + 1) + /\bif\b/.exec(rest).index;
                    curKeyword = 'if'; curLine = lineOf(starts, i); open = newOpen; condFrom = ifAt; i = newOpen; depth = 1; continue;
                }
                if (cont) {
                    const newOpen = masked.indexOf('{', i + 1);
                    segments.push(makeSegment(masked, starts, curKeyword, curLine, open, i, condFrom));
                    const kwAt = (i + 1) + word.index;
                    curKeyword = cont; curLine = lineOf(starts, i); open = newOpen; condFrom = kwAt; i = newOpen; depth = 1; continue;
                }
                let end = i;
                if (curKeyword === 'do' && /^\s*while\s*\(/.test(rest)) {
                    const semi = masked.indexOf(';', i);
                    if (semi !== -1) end = semi;
                }
                segments.push(makeSegment(masked, starts, curKeyword, curLine, open, end, condFrom));
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

function makeSegment(masked, starts, keyword, headerLine, open, close, condFrom) {
    const lineStart = starts[headerLine];
    return {
        headerKeyword: keyword,
        headerLine,
        open,
        close,
        condFrom,
        condOffset: condFrom - lineStart,
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
 * Scan a source for blocks and the indexable things in each scope. Pure data
 * (contract §10: no Node imports): the block tree plus region pairs, condition
 * literals and comment anchors, ready for the step-6 resolver.
 *
 * @param {string} text the source text
 * @param {string} [path] unused today; reserved for line-ending/language hints
 * @returns {{ root: Block, blocks: Block[], regions: object[], anchors: object[] }}
 */
export function scanBlocks(text, path) {
    void path;
    const source = text.replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const starts = [];
    let off = 0;
    for (const line of lines) { starts.push(off); off += line.length + 1; }

    const mask = masked(source);
    const maskLines = mask.split('\n');
    const comments = commentsIn(source);
    const blocks = [];
    const anchors = [];

    const root = makeBlock('root', null, -1);
    const top = buildScope(root, 0, lines.length - 1, mask, maskLines, source, lines, starts, comments, blocks);
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

    return { root, blocks, regions, anchors };
}

function makeBlock(kind, name, declLine) {
    return {
        kind, name, declLine,
        open: null, close: null, openLine: null, closeLine: null,
        indented: false, expression: undefined,
        children: [], blocks: [], regions: [],
        anchor: null, conditions: null,
        parent: null,
    };
}

function buildScope(owner, fromLine, toLine, mask, maskLines, source, lines, starts, comments, blocks) {
    const list = [];
    let i = fromLine;
    while (i <= toLine) {
        const mLine = maskLines[i];
        if (mLine.trim() === '') { i++; continue; }
        const start = starts[i];

        const keyword = DECLARATION_KEYWORD.exec(mLine);
        if (keyword && !NOT_A_NAME.has(keyword[1])) {
            const name = keyword[1];
            const headerFrom = start + keyword.index + keyword[0].length;
            const span = bodySpan(mask, maskLines, starts, i, headerFrom);
            const blk = makeBlock('class', name, i);
            applySpan(blk, span, mask, starts);
            applyAnchor(blk, comments, source, lines, starts, span && span.open);
            register(list, blk, blocks);
            descend(blk, i, span, mask, maskLines, source, lines, starts, comments, blocks);
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
            const assignedName = new RegExp('(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_$][\\w$]*)\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?[^;]*=>', 'g');
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
            applyAnchor(blk, comments, source, lines, starts, span && span.open);
            register(list, blk, blocks);
            descend(blk, i, span, mask, maskLines, source, lines, starts, comments, blocks);
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
                    const hdrStart = starts[seg.headerLine];
                    const hdrEnd = endOfLine(mask, hdrStart);
                    const condLine = source.slice(hdrStart, hdrEnd);
                    blk.conditions = conditionLiterals(condLine, seg.condOffset);
                    applyAnchor(blk, comments, source, lines, starts, seg.open);
                    register(list, blk, blocks);
                    descend(blk, seg.headerLine, { openLine: seg.openLine, closeLine: seg.closeLine }, mask, maskLines, source, lines, starts, comments, blocks);
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
function descend(blk, declLine, span, mask, maskLines, source, lines, starts, comments, blocks) {
    if (!span || span.expression !== undefined || blk.kind === 'property') return;
    let childFrom, childTo;
    if (span.indented) { childFrom = declLine + 1; childTo = span.bodyEndLine; }
    else if (span.openLine !== undefined && span.openLine !== null) { childFrom = span.openLine + 1; childTo = span.closeLine - 1; }
    else return;
    if (childFrom > childTo) return;
    const children = buildScope(blk, childFrom, childTo, mask, maskLines, source, lines, starts, comments, blocks);
    for (const c of children) { c.parent = blk; c.scope = blk; }
    blk.children.push(...children);
    blk.blocks.push(...children);
}

function applyAnchor(blk, comments, source, lines, starts, open) {
    const a = leadingAnchor(comments, source, lines, starts, open);
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
