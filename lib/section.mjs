/** @typedef {'declaration' | 'body' | 'annotated' | 'documented'} Scope */

/**
 * One selector of a reference: a semantic path, resolved by the matcher
 * precedence and the sibling-first walk, or an explicit line range
 * (`L40:12-L44:3`), which selects verbatim lines and consults no matcher.
 *
 * `segments` are the path's **names**. A trailing modifier (`++`, `+`, `-`) is
 * not one of them: it is the path's last `/`-separated segment, it names
 * nothing, and it is reported as the selector's `scope`.
 *
 * @typedef {{ kind: 'path', raw: string, segments: string[], scope: Scope }
 *         | { kind: 'lines', raw: string, from: LinePoint, to: LinePoint | null }} Selector
 */

/** One endpoint of a line range; `column` is 1-based, or null for the whole line. */
/**
 * @typedef {object} LinePoint
 * @property {number} line
 * @property {number | null} column
 */

/**
 * A section reference: one or more selectors, in the order written.
 *
 * A reference of one `path` selector keeps every field the single-reference
 * grammar ever had — `segments` and `scope`. A reference of one `lines`
 * selector reports no path (`segments: []`) and a `declaration` scope, because
 * a line range has no name and no modifier of its own; the selectors carry the
 * ranges.
 *
 * @typedef {object} Reference
 * @property {string} raw
 * @property {string} canonical
 * @property {Selector[]} selectors
 * @property {string[]} segments the last path selector's name segments, or [] for a line range
 * @property {Scope} scope the last path selector's scope, `declaration` for a range
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
 * file's type. What a lexer owns is *lexical* â€” blanking comments and string
 * literals, locating the comments â€” plus, optionally, the two places where a
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
 * @property {(maskedLine: string) => Array<{ kind?: 'class'|'method'|'property', name: string,
 *            headerFrom: number, body?: string, end?: string, line?: boolean }>} [declarations]
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

/**
 * The modifier a path **segment** is, or null when the segment is a name.
 *
 * A modifier is a segment of its own, written after the `/` that delimits it —
 * `toString/++`, `getUsers/-` — and it is legal only as the **last** segment of
 * a path. Writing it as part of a name is not a spelling of the same thing any
 * more: the name is matched as the file spells it, so a `toString++` is the
 * name `toString++`, which no file declares.
 *
 * `-` is a modifier only as the whole segment. `--` and `---` are names, which
 * is what keeps a CSS custom property (`--brand`) and a hyphenated identifier
 * addressable; a run of three or more `+` is neither, and is rejected.
 *
 * @param {string} segment
 * @returns {'++' | '+' | '-' | null}
 */
function segmentModifier(segment) {
    if (segment === '++') return '++';
    if (segment === '+') return '+';
    if (segment === '-') return '-';
    return null;
}

/**
 * A name character: a `-` is one, a `+` never is, and Ruby's `!` and `?` are
 * because a language may spell a method with them (`add!`, `empty?`). A `!` is
 * therefore part of a name and never a modifier, which is why the grammar has no
 * `!` among the modifier segments it reads.
 */
const NAME = /^[\w.$!?-]+$/;

/**
 * A path's **envelope marks**, as the last segment of its path: `^` is the
 * parent block's own first lines and `$` its last, written on the parent's path.
 *
 * They are whole segments and nothing else, which is what keeps them out of every
 * name: a sentinel is never the only segment of its path (there would be no
 * parent to open or close), and a `$` that is part of a name is not a sentinel
 * because the segment is longer than it. `foo$` is therefore the name `foo$`
 * while `foo/$` is the last line of `foo`.
 */
const ENVELOPE_MARKS = new Set(['^', '$']);

/** Is this segment a whole envelope mark? */
function envelopeMark(segment) {
    return ENVELOPE_MARKS.has(segment) ? segment : null;
}

/**
 * The path before an envelope mark, or null when the segment does not carry one.
 *
 * `Inventory/^` opens `Inventory` and `Inventory/Item/$` closes the `Item` inside
 * it; a bare `^` has no parent and is not a mark at all.
 *
 * @param {string[]} segments
 * @returns {{ mark: '^' | '$', parent: string[] } | null}
 */
function envelopeOf(segments) {
    if (segments.length < 2) return null;
    const mark = envelopeMark(segments[segments.length - 1]);
    if (mark === null) return null;
    return { mark, parent: segments.slice(0, -1) };
}

/** A segment that is nothing but modifier characters (`--`, `---`, `+++`). */
const MODIFIER_RUN = /^[-+]{2,}$/;

/**
 * Reject a name this grammar cannot carry, with the message that says why.
 *
 * `+` has no meaning inside a name at all, and the only thing a user means by it
 * is a modifier — so the message names the spelling that works rather than
 * leaving them with "names nothing". A `+` that *opens* a segment is the old
 * prefix form (`+toString`), whose replacement has the path before it.
 *
 * A whole envelope mark (`^`, `$`) is not a name but is a legal last segment,
 * which `carriesMark` allows; `^` anywhere earlier is the "names nothing" error,
 * because there is no parent for it to open.
 *
 * @param {string} segment a segment already known not to be a whole modifier
 * @param {string} raw the reference as written, for the message
 * @param {boolean} carriesMark whether this segment may be an envelope mark
 */
function assertName(segment, raw, carriesMark = false) {
    if (NAME.test(segment)) return;
    if (carriesMark && envelopeMark(segment) !== null) return;
    const plus = /\++/.exec(segment);
    if (plus) {
        const before = segment.slice(0, plus.index);
        throw new SectionReferenceError(before === ''
            ? `"${plus[0]}" is a path segment now; it follows the path, as "#<path>/${plus[0]}"`
            : `"${plus[0]}" is a path segment now; write "#${before}/${plus[0]}"`);
    }
    throw new SectionReferenceError(`"#${raw}" names nothing`);
}

/** The scope name a modifier selects, or `declaration` for none. */
function mergeModifiers(modifiers, raw) {
    if (modifiers.length === 0) return null;
    if (modifiers.length === 1) return modifiers[0];

    // Two modifiers on one path. `+++` is the only spelling that reaches here
    // (any other run puts a modifier before the last segment, which the path
    // reader rejects first), and it is malformed rather than contradictory:
    // there is no section that is two scopes at once.
    throw new SectionReferenceError(`"#${raw}" carries more than one modifier`);
}

/** A whole line range, in the form `lineRangeOf` accepts. */
const LINE_RANGE_FULL = /^L(\d+)(?::(\d+))?(?:-L(\d+)(?::(\d+))?)?$/;

/** Does this selector at least begin like a line range (`L40`)? */
const LINE_RANGE_PREFIX = /^L\d/;

/**
 * Read `raw` as a line-range selector, or return null when it is not one.
 *
 * The accepted spellings are `L40` (one line), `L40:12` (from column 12 of that
 * line), `L40-L44` and `L40:12-L44:3`. An endpoint ending in `:` is deliberately
 * not accepted: it would mean "to the end of the line", which writing the point
 * alone already says.
 *
 * Throws when the text claims to be a line range and is not one â€” `L40-`,
 * `L40:x`, `L0`, `L5-L2`, and a range carrying a modifier (`L40-L44+`) â€” because
 * a reference that opens `L<digit>` is a line range or a typo, never a name.
 * (`Lx` is still a name: it does not open with a digit, so it parses as a path
 * and fails to match, as any other name would.)
 *
 * @param {string} raw one selector, trimmed
 * @returns {{ from: LinePoint, to: LinePoint | null } | null}
 */
function lineRangeOf(raw) {
    if (!LINE_RANGE_PREFIX.test(raw)) return null;

    const malformed = () => new SectionReferenceError(
        `"#${raw}" is not a line range; write L<line> or L<line>:<column>`,
    );
    const split = splitRangeModifier(raw);
    if (split === null) throw malformed();

    const match = LINE_RANGE_FULL.exec(split.core);
    if (!match) throw malformed();

    const point = (line, column) => ({
        line: Number(line),
        column: column === undefined ? null : Number(column),
    });
    const from = point(match[1], match[2]);
    const to = match[3] === undefined ? null : point(match[3], match[4]);

    const zero = (at) => at.line < 1 || (at.column !== null && at.column < 1);
    if (zero(from) || (to !== null && zero(to))) {
        throw new SectionReferenceError(`"#${raw}" counts lines and columns from 1`);
    }
    if (to !== null) {
        const backwards = to.line < from.line
            || (to.line === from.line && to.column !== null && from.column !== null && to.column < from.column);
        if (backwards) throw new SectionReferenceError(`"#${raw}" ends before it starts`);
    }

    return { from, to };
}

/**
 * Read `L<point>` and `L<point>-L<point>`, and nothing else.
 *
 * A line range takes no modifier: there is nothing about a verbatim slice of
 * lines for `+` to add, and the `-` of the range is already spoken for, so a
 * selector that is not exactly one of the two forms is not a range at all.
 *
 * @param {string} raw
 * @returns {{ core: string, tokens: [] } | null}
 */
function splitRangeModifier(raw) {
    let at = 0;
    for (let endpoint = 0; endpoint < 2; endpoint++) {
        if (endpoint === 1) {
            if (raw[at] !== '-') return null;
            at++;
        }
        if (raw[at] !== 'L' || !isDigit(raw[at + 1])) return null;
        at += 2;
        while (isDigit(raw[at])) at++;
        if (raw[at] === ':') {
            if (!isDigit(raw[at + 1])) return null;
            at += 2;
            while (isDigit(raw[at])) at++;
        }
        // An endpoint is complete here; a second `-` starts the range's other end.
        if (raw[at] === '-') continue;
        break;
    }

    return at === raw.length ? { core: raw, tokens: [] } : null;
}

/** A decimal digit, as `\d` reads it in the grammar's own patterns. */
function isDigit(char) {
    return char !== undefined && char >= '0' && char <= '9';
}

/**
 * Read a whole reference as its selectors, or throw.
 *
 * A reference is one or more selectors separated by `,`: each is either a
 * semantic path (`Cart/Line/render/++`) or a line range (`L40:12-L44:3`). The
 * comma is the composition contract every rule shares — the data-format rules
 * have always read it as "one more key" — and a single path selector is the
 * degenerate case of it: everything `parseReference` accepts parses here to the
 * same canonical spelling, the same segments and the same scope.
 *
 * A modifier belongs to the selector whose path carries it, so
 * `add/-,render/++` is two selectors that each say what they mean and nothing
 * is ambiguous between them. A line range carries no modifier: its own `-` is
 * spoken for by the range, and there is nothing about a verbatim slice of lines
 * for a scope to widen.
 *
 * @throws {SectionReferenceError}
 * @param {string} raw
 * @returns {Reference}
 */
export function parseSelectors(raw) {
    if (raw === '') {
        throw new SectionReferenceError('"#" names nothing');
    }

    const parts = raw.split(',');
    if (parts.some((part) => part.trim() === '')) {
        throw new SectionReferenceError(`"#${raw}" has an empty selector`);
    }

    /** @type {Selector[]} */
    const selectors = [];
    /** The canonical spelling of every path selector, in the order written. */
    const canonicalParts = [];

    for (const part of parts) {
        const text = part.trim();
        // A selector that opens `L<digit>` is a line range or a typo, never a
        // name — read as a range before anything else, so `L40-` reports the
        // range rather than a path about a name nobody meant.
        const range = lineRangeOf(text);
        if (range !== null) {
            canonicalParts.push(text);
            selectors.push({ kind: 'lines', raw: text, from: range.from, to: range.to });
            continue;
        }
        if (LINE_RANGE_PREFIX.test(text)) {
            throw new SectionReferenceError(
                `"#${text}" is not a line range; write L<line> or L<line>:<column>`,
            );
        }
        // A mark may be written bare — `Inventory/^,toString,$` — and then it is
        // the *other* mark's parent it refers to, so the path is named once. The
        // bare spelling is a whole selector of one segment, which no path reaches
        // because a mark needs a parent.
        const bare = envelopeMark(text);
        if (bare !== null) {
            canonicalParts.push(text);
            selectors.push({
                kind: 'path', raw: text, segments: [text], scope: 'declaration',
                envelope: { mark: bare, parent: null },
            });
            continue;
        }

        if (!/^[\w$/+-]/.test(text)) {
            throw new SectionReferenceError(`"#${text}" names nothing`);
        }

        const parsed = parseReference(text);
        canonicalParts.push(parsed.canonical);
        selectors.push({
            kind: 'path', raw: text, segments: parsed.segments, scope: parsed.scope,
            envelope: envelopeOf(parsed.segments),
        });
    }

    applyEnvelope(selectors, raw);

    const canonical = canonicalParts.join(',');

    // A reference of one path selector carries a scope the resolver applies; a
    // line range has none, and a mixed reference resolves each selector with its
    // own.
    const sole = selectors.length === 1 ? selectors[0] : null;

    return {
        raw,
        canonical,
        selectors,
        segments: sole !== null && sole.kind === 'path' ? sole.segments : [],
        scope: sole !== null && sole.kind === 'path' ? sole.scope : 'declaration',
    };
}

/**
 * Read one **path** selector: a `/`-separated path whose last segment may be a
 * modifier. Throws on a comma (that is `parseSelectors`), on a line range, and
 * on a grammar error.
 *
 * The path is the whole of what a reference names, so the modifier is written
 * where the path ends: `toString/++` is the documented method, `toString/-` its
 * body, `getUsers/+` the method with its annotations. A modifier is legal only
 * as the **last** segment, and only once — `a/++/b` and `a/++/-` are both
 * errors, because a modifier describes the selection, and nothing is selected
 * until the path ends.
 *
 * A name may contain `-` (`item-list`, `update-document-test`) but never `+`.
 * That is what makes the two unmistakable: a `-` is a modifier only as a whole
 * segment, and a `+` is only ever one.
 *
 * @throws {SectionReferenceError}
 * @param {string} raw
 * @returns {Reference}
 */
export function parseReference(raw) {
    if (raw === '') {
        throw new SectionReferenceError('"#" names nothing');
    }
    if (raw.includes(',')) {
        throw new SectionReferenceError(`"#${raw}" has an empty selector`);
    }
    // A reference names a section of **one** file, and the file is the path the
    // marker's link already carries. A second `#` is therefore never a nested
    // reference — it is a link that was written into the fragment by mistake, and
    // reading it as a name would send the reader to a section that cannot exist.
    if (raw.includes('#')) {
        throw new SectionReferenceError(`"#${raw}" has a second "#"; a reference names one file`);
    }
    if (LINE_RANGE_PREFIX.test(raw)) {
        lineRangeOf(raw);           // throws when the spelling is malformed
        throw new SectionReferenceError(`"#${raw}" is a line range, not a section path`);
    }

    const parts = raw.split('/');
    if (parts.some((part) => part === '')) {
        throw new SectionReferenceError(`"#${raw}" has an empty path segment`);
    }
    if (parts.length > 8) {
        throw new SectionReferenceError(`"#${raw}" is deeper than 8 sections`);
    }

    const modifiers = [];
    const names = [];
    for (let index = 0; index < parts.length; index++) {
        const segment = parts[index];
        const modifier = segmentModifier(segment);
        if (modifier !== null) {
            if (index !== parts.length - 1) {
                throw new SectionReferenceError(
                    `"${modifier}" may only modify the last path segment of "#${raw}"`
                );
            }
            modifiers.push(modifier);
            continue;
        }
        // A segment of nothing but modifiers (`+++`, `---`) is two of them on one
        // segment. `--` and `--brand` are names: a CSS custom property is one.
        if (MODIFIER_RUN.test(segment) && segment !== '--') {
            throw new SectionReferenceError(`"#${raw}" carries more than one modifier`);
        }
        assertName(segment, raw, index === parts.length - 1);
        names.push(segment);
    }

    if (names.length === 0) {
        // A path of modifiers has no subject: `-` is the old body scope, and
        // `++`/`+` name nothing at all. Say that rather than "more than one
        // modifier" about a single one.
        const why = segmentModifier(raw) === null
            ? `"#${raw}" carries more than one modifier`
            : `"#${raw}" names nothing`;
        throw new SectionReferenceError(why);
    }

    const merged = mergeModifiers(modifiers, raw);
    const scope = scopeFromModifier(merged);
    const canonical = names.join('/') + (merged === null ? '' : `/${merged}`);

    return { raw, canonical, segments: names, selectors: null, scope };
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
// Part A â€” mask pass
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
 * Reads the original text â€” a comment cannot be recovered from the mask.
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
// Part B â€” block scanner
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
// Constants â€” kept in step with index.mjs so the two scanners agree.
// ---------------------------------------------------------------------------

const COMMENT_OPENER = /^(?:(?:\/\/|--|;|%|'|#|REM\b|<!--|\/\*|\*)\s*)+/i;
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

/** Matcher 5 (Â§6): a statement block opens on a line carrying this keyword. */
const STATEMENT_KEYWORD =
    /\b(if|else|for|while|do|switch|try|catch|finally|synchronized)\b/;

/** The same keyword, as the *first* word of a line: `If name = … Then`. */
const STATEMENT_KEYWORD_AT_START =
    /^(?:if|else|elseif|for|while|do|switch|select|try|catch|finally|synchronized|unless|until|when|case)\b/i;

/** How far a line is indented. */
function indentWidth(line) {
    return line.length - line.trimStart().length;
}

/**
 * Read one line as a region directive, or null. Port of `regionDirective`
 * (index.mjs:45) â€” same spellings, same "bare `region` is prose" rule.
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
 * original text but with comments skipped â€” the same blanking the mask does,
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
    // `from` is an offset in the line, and a negative one would make the scan
    // below walk *backwards*: `i` only ever grows inside the loop, so a start
    // before zero means the loop cannot reach the end by advancing and instead
    // spins until `i` climbs back past it — a hang proportional to the line's
    // length, which is how a wrong offset turns into a quadratic scan.
    let i = from > 0 ? from : 0;
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
 *
 * `header` is the declaration's header as a slice of the mask â€” one line, or the
 * several a wrapped parameter list spans â€” ending at the `{` or `;` that ends it.
 */
/**
 * The offset of the `=` that introduces an expression body, or -1.
 *
 * `fun label(\n    x: Int\n): String = if (x > 0) "yes" else "no"` is a function
 * whose body is an expression, and a wrapped header is what puts that `=` on a
 * later line. A `=` that stands for `==`, `<=`, `>=`, `!=` or `+=` is not a body
 * â€” and neither is a type annotation's (`name: Type =`), which is why the
 * character right after the `=` must not be `=`, and the last character before
 * it must close something: a type, a bracket or a `>`.
 *
 * @param {string} rest the header, from the end of the declaration's name
 * @returns {number}
 */
function expressionAt(rest) {
    for (let at = rest.indexOf('='); at !== -1; at = rest.indexOf('=', at + 1)) {
        if (rest[at + 1] === '=') continue;
        if (at > 0 && /[\w$>)\]}]/.test(rest[at - 1])) return at;
    }
    return -1;
}

/**
 * Where a *property's* statement ends.
 *
 * A field is a statement, and the statement is the selection — so the span has
 * to be the whole of it and not the line its name is written on. For a language
 * that terminates its statements the `;` decides, and it is the first one met
 * with every bracket closed: a `{` with every bracket closed is ordinarily the
 * body and would end a declaration header, but inside a field's *expression* a
 * `{` opens one — the lambda of `Runnable arrow = () -> { … };`, an array or an
 * anonymous-class initialiser — so the scan tracks the brackets themselves and
 * the `;` closes the statement wherever the initialiser left it.
 *
 * A language with no `;` (Kotlin, Go, C#, Python) needs the other half of the
 * rule: the statement also ends at the end of a line that closes every bracket
 * it opened, when nothing about the next line continues it. Two things continue
 * it — a line that ends on an operator, a comma or an opening bracket (a wrapped
 * expression), or a next line indented **deeper** than the declaration (the
 * body of a lambda, the continuation of a wrapped call). A next line at the
 * declaration's own indentation starts a sibling instead, and reading on would
 * take that sibling's text into the property — which is exactly how a
 * `;`-less property whose initialiser hides a brace in a raw string, a text
 * block or a template literal used to swallow the member after it.
 *
 * @param {string} masked the whole mask
 * @param {number[]} starts each line's own offset in the mask
 * @param {number} from the offset the statement starts at (its own line's start)
 * @param {number} to the last offset the scan may look at
 * @returns {{ end: number, last: number, equals: number }}
 *   `end` is one past the `;` that ended the statement (or the end of its last
 *   line when nothing did), `last` the 0-based line of its last character, and
 *   `equals` the offset of the `=` that opened its initialiser, or -1.
 */
function statementEnd(masked, starts, from, to, equals, sourceLines) {
    const declLine = lineOf(starts, from);
    const indent = indentWidth(masked.slice(from, endOfLine(masked, from)));
    // The first source line at or after `line` that has text on it, or -1.
    const nextTextLine = (line) => {
        for (let at = line; at < sourceLines.length; at++) {
            if (sourceLines[at].trim() !== '') return at;
        }
        return -1;
    };
    let depth = 0;
    let last = from;
    let contentEnd = from;
    for (let line = declLine; line < starts.length && starts[line] < to; line++) {
        const lineStart = Math.max(starts[line], from);
        // Levels are read from the **source**, never the mask: the mask blanks a
        // literal's delimiters, so its `endOfLine` cuts a line short wherever one
        // sits (`    """` is seven columns of bytes and five of mask).
        const lineEnd = Math.min(endOfLine(sourceLines[line], 0) + starts[line], to);
        const inLiteral = line > declLine
            && masked.slice(lineStart, lineEnd).trim() === ''
            && sourceLines[line].trim() !== '';
        if (line > declLine && sourceLines[line].trim() === '') break;
        if (inLiteral) {
            // A line the mask blanked but the source did not is part of a string
            // literal that spans lines. It is not a statement boundary — neither
            // its indentation nor its own braces mean anything, since both are the
            // literal's own text — so the statement simply reaches through it, and
            // the literal's closing line comes with it.
            last = Math.max(last, lineEnd);
            contentEnd = lineStart + sourceLines[line].trimEnd().length;
            continue;
        }
        let stop = false;
        for (let at = lineStart; at < lineEnd; at++) {
            const char = masked[at];
            if (char === '(' || char === '[' || char === '{') depth++;
            else if (char === ')' || char === ']' || char === '}') {
                if (depth === 0) { stop = true; break; }
                depth--;
            } else if (char === ';' && depth === 0) {
                return { initializerEnd: at, last: lineOf(starts, at), lineEnd: at + 1, equals };
            }
        }
        // The statement so far reaches the end of this line, `;` or not, and its
        // text ends there — before the newline, and before any trailing blank.
        last = Math.max(last, lineEnd);
        const text = sourceLines[line].trimEnd();
        if (text !== '') contentEnd = starts[line] + text.length;
        if (stop) break;
        if (line > declLine && depth === 0) {
            // Nothing continues this line: it closes what it opened and does not
            // end on an operator or an opening bracket. An `=` that ends a line is
            // not punctuation here — the initialiser may be an expression the next
            // line carries, which the indentation decides — so a line like
            // `val note =` does not keep the scan alive on its own.
            if (!/[,+\-*/%&|?<(\[{!~^]\s*$/.test(masked.slice(lineStart, lineEnd))) {
                const next = nextTextLine(line + 1);
                if (next === -1) break;
                if (indentWidth(sourceLines[next]) <= indent) break;
            }
        }
    }
    // The scan stopped on a line that ends the statement. Its declaration reaches
    // the end of that line, and its initialiser's own text stops at the last real
    // character the statement has — never at the newline, and never at the end of
    // the file.
    const blockEnd = Math.max(last, contentEnd);
    return {
        initializerEnd: contentEnd === from ? blockEnd : contentEnd,
        last: lineOf(starts, blockEnd),
        lineEnd: blockEnd,
        equals,
    };
}

/**
 * Where a declaration's header ends, starting at `from` on `line`.
 *
 * Wrapping a parameter list is formatting, not a different declaration, so a
 * header may span lines â€” but only while it could still be a header. It ends at
 * the first `{` or `;` met with every bracket closed, and stops at the blank line
 * or the line that cannot continue it (a body-less member, a declaration the mask
 * cut short). Counting every bracket â€” `(`, `[`, `{`, `<` â€” is what makes a
 * wrapped parameter list, a wrapped generic list and a wrapped `throws` one rule;
 * a `{` inside the header's own brackets (a lambda default, an array
 * initialiser) is not the body's brace, because a bracket is open. The scan is
 * bounded, so a header that is never closed is not followed through the file.
 *
 * @param {object} lex the scan's lexical facts
 * @param {number} line the line the declaration starts on
 * @param {number} from the offset in the mask the header starts at
 * @returns {{ end: number, last: number }} the offset just past the `{`/`;` that
 *   ends the header (or the end of its last line), and that line's index
 */
function headerEnd(lex, line, from) {
    const { maskLines, starts } = lex;
    const stop = Math.min(maskLines.length - 1, line + HEADER_LINES - 1);
    // Everything before where the header starts is already the declaration's
    // name; its brackets are not the header's, so the count begins after them.
    let depth = 0;
    let start = from;
    let i = line;
    for (; i <= stop; i++) {
        const text = maskLines[i];
        if (i > line && text.trim() === '') break;
        if (depth === 0) depth = bracketDepth(text, 0, start - starts[i]);
        for (let column = Math.max(0, start - starts[i]); column < text.length; column++) {
            const char = text[column];
            // A `{` or `;` with every bracket closed ends the header, and is
            // part of it: the body starts after it.
            if (depth === 0 && (char === '{' || char === ';')) {
                return { end: starts[i] + column + 1, last: i };
            }
            // An arrow's `>` is not a closing angle bracket: `=>` and `->` are
            // punctuation, and counting one as a bracket ends a header that was
            // still open.
            const previous = text[column - 1];
            if (char === '(' || char === '[' || char === '{' || char === '<') depth++;
            else if (char === ')' || char === ']' || char === '}') depth--;
            else if (char === '>' && previous !== '=' && previous !== '-') depth--;
        }
        // A closer with nothing open is not an error and does not end the header.
        // A `<` that a generic list should have balanced may have been a
        // less-than (`class Wrapped<\n        T extends Comparable<T>,`), and the
        // first `>` then reads as one closer too many; ending the header there
        // would leave the whole declaration bodyless. The count is therefore
        // taken from the top of the next line, so a line never ends in debt.
        depth = Math.max(0, depth);
        start = starts[i] + text.length;
        // A header continues while a bracket is open, while the line ends on a
        // separator, and onto a `{` alone on the next line â€” the Allman brace,
        // which no other rule reaches. A `{` at the end of the header's own line
        // was already found above.
        //
        // A *name* may end a header line that is still mid-declaration, which no
        // separator reveals: a wrapped class header writes its supertype on a
        // line of its own (`implements Renderer<T>`), and the `{` follows on the
        // next one. Only the heads that can open such a tail are followed â€” a
        // `throws`, or an `extends`/`implements` clause with an identifier still
        // after the keyword â€” so a bodyless member that happens to end on a word
        // (`abstract String label(\n  int width)`) keeps its indented body.
        const next = nextNonBlank(maskLines, i + 1);
        const word = /\w[\w$]*[>)\]}\s]*$/.test(text);
        const tail = word && (
            /\bthrows\s+\w/.test(text)
            || /\b(?:extends|implements)\s+[\w$][\w$.<>,?\[\]\s]*\w/.test(text));
        const continues = depth > 0 || /[(,;]\s*$/.test(text) || tail
            || (next !== -1 && /^\s*\{\s*$/.test(maskLines[next]));
        if (!continues) return { end: start, last: i };
    }
    i = Math.min(i, maskLines.length - 1);
    return { end: starts[i] + maskLines[i].length, last: i };
}

/** How much `text` opens across every bracket a header can hold, from `from`. */
function bracketDepth(text, from, to) {
    let depth = 0;
    for (let at = from; at < (to === undefined ? text.length : to); at++) {
        const char = text[at];
        if (char === '(' || char === '[' || char === '{' || char === '<') depth++;
        else if (char === ')' || char === ']' || char === '}' || char === '>') depth--;
    }
    return depth;
}

/**
 * The first of `{`, `;` and `=>` in a header, in the order they appear â€” the
 * thing that ended it. A `;` means no body, a `{` opens one, and `=>` is an
 * arrow; whichever comes first is what the header ended with.
 *
 * @param {string} rest the header, from the end of the declaration's name
 * @returns {{ at: number, kind: 'brace'|'none'|'arrow' } | null}
 */
function terminatorIn(rest) {
    const found = [
        { at: rest.indexOf('{'), kind: 'brace' },
        { at: rest.indexOf(';'), kind: 'none' },
        { at: rest.indexOf('=>'), kind: 'arrow' },
    ].filter((o) => o.at !== -1).sort((l, r) => l.at - r.at);
    return found.length === 0 ? null : found[0];
}

/**
 * A body span, or null when the member has no body to inject (an interface or
 * `abstract` method). Port of `declarationRange` (index.mjs:351) over the mask.
 *
 * `from` is where the declaration's header starts in the mask â€” after its name,
 * for the matchers that stop there â€” and the header is followed to its `{` or `;`
 * wherever that is, which is what lets a wrapped parameter list resolve.
 */
function bodySpan(masked, lines, starts, declLine, from, nameAt = from, shapeAtBody = false) {
    if (process.env.DSH_TRACE) console.error('BS-IN', declLine, 'from', from, 'nameAt', nameAt, 'prev', JSON.stringify(masked[from - 1]), 'at', JSON.stringify(masked[from]));
    // A shape whose own `headerFrom` is the `=` itself (a Haskell binding, a Rust
    // `const`) states its expression body directly; the expression is what
    // follows, and its own lines are indented under the declaration. Only a shape
    // says this: for a `const pick = (a) => …` the `=` is an assignment, not the
    // body, and the arrow after it is what the body is read from.
    if (shapeAtBody && masked[from] === '=') return expressionBody(lines, starts, declLine, from + 1);

    const header = headerEnd({ maskLines: lines, starts }, declLine, nameAt);
    const rest = masked.slice(from, header.end);

    // The arrow that opens the body, read first: for `(n) => n + 1;` the `=>` is
    // what declares the member's body, and the `;` after it closes that body
    // rather than declaring a body-less member. A caller's `from` may also sit on
    // the `=` or the `>` of the arrow itself.
    const arrow = rest.indexOf('=>');
    const arrowAt = arrow !== -1 ? from + arrow : masked[from] === '=' || masked[from] === '>' ? from : -1;
    const arrowHere = arrowAt !== -1 ? Math.max(0, arrowAt - from) : -1;

    // The header's own scan ended on the `{` that opens the body (a shape like
    // `impl Cart {`, or any caller whose `from` sits just after it), so the body
    // is cut from that column and never from a later brace in the body.
    if (arrowHere === -1 && masked[from - 1] === '{') return braceBody(masked, starts, from - 1);

    if (arrowHere !== -1) {
        const at = from + arrowHere + 2;
        const brace = masked.indexOf('{', at);
        const lineEnd = endOfLine(masked, at);
        if (brace === -1 || brace > lineEnd) {
            return expressionBody(lines, starts, declLine, at);
        }
        return braceBody(masked, starts, brace);
    }

    const terminator = terminatorIn(rest);

    // A `;` with every bracket closed is a member with no body to inject.
    if (terminator !== null && terminator.kind === 'none') return null;

    if (terminator !== null) {
        // `from` may already be the terminator's own column (a shape whose offset
        // is the `{`) or a character or two before it.
        const at = Math.max(masked.indexOf('{', from), from + terminator.at);
        return braceBody(masked, starts, at);
    }

    // The header itself ended on the `{` that opens the body (a shape like
    // `impl Cart {`), so the body is cut from that column.
    const openedAt = masked.lastIndexOf('{', header.end - 1);
    if (openedAt >= from) return braceBody(masked, starts, openedAt);

    // An `=` opens an expression body, and is checked before the indentation
    // rule: an indented line after a `=` is part of the *expression*, not a body.
    // `expressionAt` wants a word character before the `=`, which is how a Kotlin
    // `): String = expr` and a `fun f(): T = expr` both spell one; an `=` that only
    // a space precedes is still the body's, because the caller has already decided
    // this is a declaration. The remainder may begin *at* the `=` (the header ended
    // on it), so the expression starts one past whichever `=` was found.
    const equals = expressionAt(rest);
    if (equals !== -1) return expressionBody(lines, starts, declLine, from + equals + 2);
    const bare = rest.indexOf('=');
    if (bare !== -1 && rest[bare + 1] !== '=') {
        return expressionBody(lines, starts, declLine, from + bare + 2);
    }

    // No terminator on the header's own lines. The body is then the next block:
    // a `{` on a later line (a wrapped `) throws X` line, an Allman brace) or the
    // indented block the declaration's own indentation governs.
    const next = nextNonBlank(lines, header.last + 1);
    const indent = indentWidth(lines[declLine]);
    if (next === -1) return null;

    // The next line, if it opens the body itself.
    const first = lines[next];
    if (/^\s*\{/.test(first)) return braceBody(masked, starts, starts[next] + first.indexOf('{'));

    // A line that still belongs to the declaration — a `throws` clause, a return
    // type — puts the `{` after it. A wrapped header's body starts after the last
    // of its lines, so the search begins there.
    const searchFrom = Math.max(next, header.last);
    const after = masked.slice(from, starts[searchFrom] + lines[searchFrom].length);
    const deferred = terminatorIn(after);
    if (deferred !== null && deferred.kind === 'none') return null;
    if (deferred !== null && deferred.kind === 'brace') {
        return braceBody(masked, starts, from + deferred.at);
    }

    if (indentWidth(first) > indent) {
        let last = next;
        for (let i = next + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;
            if (indentWidth(lines[i]) <= indent) break;
            last = i;
        }
        // A wrapped header's own lines are not part of its body.
        return {
            indented: true, open: null, close: null,
            bodyEndLine: last, bodyFrom: Math.max(next, header.last + 1),
        };
    }
    return null;
}

/**
 * An expression body beginning at `at`: it runs to the end of its line, and on
 * through the indented lines that follow it â€” a `do` block, a `where` clause â€”
 * which the declaration's own indentation governs.
 */
function expressionBody(lines, starts, declLine, at) {
    const first = lineOf(starts, at);
    const indent = indentWidth(lines[declLine]);
    // A body that starts on the declaration's own line is the rest of that line
    // (`const inc = (n) => n + 1;`); the lines below belong to it only when it
    // starts on a later one and they are indented under the declaration — a `do`
    // block under a wrapped `main = do`.
    let last = first > declLine ? first : declLine;
    if (first > declLine) {
        for (let i = first + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') break;
            if (indentWidth(lines[i]) <= indent) break;
            last = i;
        }
    }
    if (process.env.DSH_TRACE) console.error('EXPR-BODY', 'declLine', declLine, 'at', at, 'first', first, 'last', last, 'indent', indent, 'next', JSON.stringify(lines[first + 1]));
    return { expression: at, expressionEndLine: last, open: null, close: null };
}

/**
 * The body of an arrow function, whose `=>` is at `at`: a brace expression, or
 * an expression that runs to the end of the line the `=>` is on.
 */
function arrowBody(masked, starts, at) {
    const brace = masked.indexOf('{', at);
    const lineEnd = endOfLine(masked, at);
    return brace === -1 || brace > lineEnd
        ? { expression: at, open: null, close: null }
        : braceBody(masked, starts, brace);
}

/**
 * How far a declaration's header may run past the line it starts on.
 *
 * Wrapping a parameter list is formatting, not a different declaration, so the
 * header of a member may span lines â€” but only until the `{` or `;` that ends
 * it, and only while the text still looks like a header: brackets may be open,
 * a line may end on an operator, and an annotation may start one. A header that
 * is not closed within this many lines is not followed, rather than scanned to
 * the end of the file.
 */
const HEADER_LINES = 200;

function braceBody(masked, starts, open) {
    const close = matchingBracket(masked, open, '}');
    if (close === -1) return null;
    return { open, close, openLine: lineOf(starts, open), closeLine: lineOf(starts, close) };
}

/**
 * A body closed by a terminator keyword line (`end` in Ruby), found by
 * indentation: the first line at or left of the declaration's indentation whose
 * trimmed text is the terminator closes the block. This is the convention real
 * Ruby code follows, not a parse â€” an inner `do â€¦ end` is indented further and
 * so is skipped â€” and when no terminator is found that way the declaration gets
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
 * Whether a declaration on `line` names `name`, and where its header begins.
 *
 * The declaration is read from its own line whenever that line says everything
 * there is to say, which is the only shape the matcher ever had to read. A
 * header that wraps â€” a parameter list, a generic list, a `throws` clause â€” is
 * not readable that way, because the closing bracket sits on a later line; for
 * those, {@link declarationAcross} reads the header the scanner followed
 * ({@link headerEnd}). The line's own reading is what decides *whether* there is
 * a declaration at all â€” a bare name that merely appears inside a wrapped
 * construct must not become one.
 *
 * @param {string} maskedLine the line as the mask has it
 * @param {number} start the offset of that line in the mask
 * @param {string} name the name being looked for
 * @param {Array<object>} [declared] the lexer's own shapes for this line
 * @param {object} [lex] the scan's lexical facts, when the caller has them
 * @returns {{ kind: 'class'|'method', name: string,
 *             nameAt: number, headerFrom: number } | null}
 *   `nameAt` is where the declared name starts, for a header scan that counts
 *   brackets from it; `headerFrom` is where the body's search starts.
 */
function declarationOn(maskedLine, start, name, declared = [], lex = null) {
    if (name === '' || NOT_A_NAME.has(name)) return null;

    const own = declared.find((entry) => entry.name === name);
    if (own) {
        return {
            kind: own.kind ?? 'method', name,
            nameAt: start + own.headerFrom, headerFrom: start + own.headerFrom,
        };
    }

    const keyword = DECLARATION_KEYWORD.exec(maskedLine);
    if (keyword && keyword[1] === name) {
        const after = start + keyword.index + keyword[0].length;
        const at = start + keyword.index + keyword[0].indexOf(name);
        return { kind: 'class', name, nameAt: at, headerFrom: after };
    }

    const call = new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}\\s*\\(`, 'g');
    let match;
    while ((match = call.exec(maskedLine)) !== null) {
        const before = maskedLine.slice(0, match.index + match[1].length);
        const prefix = before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
        if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
        const close = matchingBracket(maskedLine, match.index + match[0].length - 1, ')');
        if (close === -1) continue;
        return {
            kind: 'method', name,
            nameAt: start + match.index + match[1].length,
            headerFrom: start + close + 1,
        };
    }

    if (lex !== null) {
        // The parameter list may close on a later line, where only the whole
        // header can see it.
        const across = declarationAcross(lex, start, name);
        if (across !== null) return across;
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
        const start_ = arrow !== -1 && (fn === null || arrow < fn.index) ? after + arrow
            : fn !== null ? after + fn[0].length
                : -1;
        if (start_ === -1) continue;
        return {
            kind: 'method', name,
            nameAt: start + match.index + match[1].length,
            headerFrom: start + start_,
        };
    }
    return null;
}

/**
 * The same matchers, run over the whole header instead of one line.
 *
 * The header is followed from the declaration's line to its `{` or `;`
 * ({@link headerEnd}), because that is the only slice in which the closing
 * bracket of a wrapped parameter list exists. `name(` must still open the name,
 * and the text before it â€” on the line it is written on â€” must still read as a
 * return type, a modifier list or nothing, so a name that merely appears inside
 * a wrapped argument list is not a declaration.
 *
 * @param {object} lex the scan's lexical facts
 * @param {number} start the offset of the declaration's line in the mask
 * @param {string} name
 * @returns {{ kind: 'method', name: string, headerFrom: number } | null}
 */
function declarationAcross(lex, start, name) {
    const { mask, maskLines, starts } = lex;
    const line = lineOf(starts, start);
    const from = start + (maskLines[line].length - maskLines[line].trimStart().length);
    const header = headerEnd(lex, line, from);
    if (header.last === line) return null;
    const text = mask.slice(start, header.end);

    const open = new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}\\s*\\(`, 'g');
    let match;
    while ((match = open.exec(text)) !== null) {
        const column = match.index + match[1].length;
        const on = lineOf(starts, start + column);
        const before = maskLines[on].slice(0, start + column - starts[on]);
        const prefix = before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
        if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
        const close = matchingBracket(text, match.index + match[0].length - 1, ')');
        if (close === -1) continue;
        return { kind: 'method', name, nameAt: start + column, headerFrom: start + close + 1 };
    }

    const assigned = new RegExp(
        `(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?${escapeRegExp(name)}\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?`,
        'g',
    );
    while ((match = assigned.exec(text)) !== null) {
        const column = match.index + match[1].length;
        const on = lineOf(starts, start + column);
        const before = maskLines[on].slice(0, start + column - starts[on]);
        const prefix = before.trim();
        if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
        const rest = text.slice(match.index + match[0].length);
        const arrow = rest.indexOf('=>');
        if (arrow === -1 && !/^function\b/.test(rest)) continue;
        return {
            kind: 'method', name,
            nameAt: start + column,
            headerFrom: start + match.index + match[0].length + (arrow === -1 ? 0 : arrow),
        };
    }
    return null;
}

/** Matcher 4: `Type name = …` / `static final Type name = …` / `const name = …`.
 *  A `const`/`let`/`var` needs no type; otherwise at least one type token must
 *  precede the name, which keeps body assignments (`count = 0`) out. A type token
 *  is a whole type: a qualified name (`java.util.List`), a generic list of them
 *  (`Map<String, Integer>`), an array of them (`int[]`, `String[][]`), or any
 *  nesting of the three — a field whose type is one of those is a field like any
 *  other, and refusing it hid the declaration entirely. */
const TYPE_TOKEN = String.raw`[\w$]+(?:\.[\w$]+)*(?:\s*<[^<>]*>)?(?:\s*\[\s*\])*`;
const PROPERTY_DECL = new RegExp(
    String.raw`(?<!\.)\b(?:(const|let|var)\s+|((?:${TYPE_TOKEN})(?:\s+(?:${TYPE_TOKEN}))*?)\s+)`
    + String.raw`([A-Za-z_$][\w$]*)\b\s*=(?!=)`,
);

/** A word that stands where a type or modifier would, but declares nothing. */
const NOT_A_TYPE = new Set(['return', 'throw', 'new', 'else', 'do', 'case', 'await', 'yield', 'delete', 'typeof']);

/**
 * The segments of an if/else-if (or try/catch) chain opened on this line.
 * Bare-`else` and `do â€¦ while` terminators are respected.
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
    // What may follow a closing brace is a continuation keyword and, for `do`, a
    // `while`. Both are close by, so the look-ahead is a bounded window rather
    // than the rest of the file: slicing to the end here made the scan quadratic
    // in the statements a file holds, because each of them copied everything
    // below it.
    const AFTER_CLOSE = 64;
    while (i < masked.length) {
        const c = masked[i];
        if (c === '{') { depth++; i++; continue; }
        if (c === '}') {
            depth--;
            if (depth === 0) {
                const rest = masked.slice(i + 1, i + 1 + AFTER_CLOSE);
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
                    if (semi !== -1 && semi < endOfLine(masked, i)) end = semi;
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
 * The leading-comment anchor of a braced block (Â§6 matcher 6), or null: the
 * comment that is the first thing inside the braces â€” same line after `{`
 * (`{ //getUsers`), or the next non-blank line. A `#region`/`#endregion` line
 * is never an anchor, and a body whose first thing is code has no anchor.
 *
 * The body may hold several comments, and the one the braced block opens with is
 * the first whose whole `{`-to-comment gap is blank — a comment further in has
 * code before it and does not anchor the block. (A comment above the block is not
 * a candidate either: it is before the `{`.)
 *
 * @returns {{ name: string, line: number } | null}
 */
function leadingAnchor(comments, source, lines, starts, open) {
    if (open === null || open === undefined) return null;
    let first = null;
    for (const c of comments) {
        if (c.from <= open) continue;
        // The comment that is the first thing inside the braces: everything
        // between the `{` and it is blank. The body may hold several comments, so
        // the scan looks for that one rather than judging the first it meets — a
        // trailing comment on the declaration's own line is before the `{`.
        if (/^\s*$/.test(source.slice(open + 1, c.from))) {
            first = c;
            break;
        }
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
 * `scanBlocks` uses when no file-type lexer is supplied â€” the file's type is
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
 * (contract Â§10: no Node imports): the block tree plus region pairs, condition
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
// Part C â€” resolve layer (contract Â§6â€“Â§9): matcher precedence, scope walk,
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
 * `isAnnotation` is the language's own test when its lexer supplies one â€” the
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
 * `singleLine` marks a declaration a language writes without a body â€” a
 * one-line Haskell binding: its declaration *is* the line, so the body scope
 * returns the same text instead of an empty slice.
 *
 * `isAnnotation` is the lexer's own annotation test, when it has one.
 */
function renderDeclaration(lines, source, starts, range, scope, isAnnotation) {
    // An expression body carries the line its expression ends on; every other
    // shape carries the line its body closes on.
    const endLine = range.expressionEndLine !== undefined ? range.expressionEndLine
        : range.endLine !== undefined ? range.endLine
            : range.closeLine;
    if (scope === 'body') {
        if (range.singleLine) return span(lines.slice(range.declLine, endLine + 1), range.declLine, endLine);
        if (range.indented) {
            // A wrapped header's lines belong to the declaration, not the body,
            // so the body starts after the last of them.
            const first = range.bodyFrom === undefined ? range.declLine + 1 : range.bodyFrom;
            return span(lines.slice(first, endLine + 1), first, endLine);
        }        if (range.expression !== undefined) {
            const at = lineOf(starts, range.expression);
            // The expression may be a block, whose lines the declaration's own
            // indentation governs (`main = do` then an indented body).
            const last = range.expressionEndLine === undefined ? at : range.expressionEndLine;
            if (last > at) return span(lines.slice(at, last + 1), at, last);
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
 * says â€” a click lands on a line. `fromLine`/`toLine` are the 0-based bounds of the slice the text was
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
 * The matcher-precedence lookup of `segment` inside one scope, matchers 1â€“6,
 * considering only this scope's own members (no descent). Returns the matches of
 * the **first matcher that has any**, in walk order â€” usually one, but a name may
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
    // 1 â€” region directive (modifier ignored).
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

    // 2 â€” class-like, 3 â€” method/function (body-carrying), 4 â€” property. Every
    // same-named declaration of the winning kind is a candidate, in source order.
    const named = (kind) => scope.children.filter((b) => b.kind === kind && b.name === segment);
    const klass = named('class');
    if (klass.length > 0) return klass.map((block) => ({ kind: 'declaration', block }));
    const method = named('method');
    if (method.length > 0) return method.map((block) => ({ kind: 'declaration', block }));
    const prop = named('property');
    if (prop.length > 0) return prop.map((block) => ({ kind: 'property', block }));

    // 5 â€” condition literal: this scope's own condition (when the scope is a
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

    // 6 â€” comment anchor: a child block in this scope whose anchor names the segment.
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
 * The bytes strictly between `from` and `to` of `source`, trimmed, with the
 * line range the trimmed text still covers.
 *
 * A slice that is trimmed has to answer for the lines the trim removed: a click
 * on a body belongs to its first real line, not to the blank line above it, and
 * a slice that trims to nothing still reports the line it would have started
 * on rather than a range that runs backwards. `1-based`, both ends inclusive.
 *
 * @returns {{ text: string, from: number, to: number }}
 */
function trimmedSlice(source, starts, from, to) {
    const raw = source.slice(from, Math.max(from, to));
    const text = raw.trim();
    const dropped = raw.length - raw.trimEnd().length;
    const at = Math.min(starts.length - 1, lineOf(starts, Math.min(from, source.length)));
    if (text === '') return { text, from: at + 1, to: at + 1 };
    const first = from + (raw.length - raw.trimStart().length);
    const last = Math.max(first, to - dropped - 1);
    return { text, from: lineOf(starts, first) + 1, to: lineOf(starts, last) + 1 };
}

/**
 * The text `block` contributes under `scope`, per contract Â§8. `ctx` carries
 * `lines`, `source`, `starts` and the lexer's optional `annotationLine`.
 */
function renderBlock(block, scope, ctx, matchKind) {
    const { lines, source, starts } = ctx;
    const isAnchor = matchKind === 'anchor' || matchKind === 'condition';
    if (!isAnchor && (block.kind === 'class' || block.kind === 'method')) {
        return renderDeclaration(lines, source, starts, block, scope, ctx.annotationLine);
    }
    if (!isAnchor && block.kind === 'property') {
        // The whole statement, from the line its name is written on through the
        // line its `;` is on — which is a later line for a lambda or an array
        // initialiser, and the same line for a plain field.
        const last = block.lineEnd === undefined || block.lineEnd < block.declLine
            ? block.declLine : block.lineEnd;
        if (scope === 'body') {
            // `-` selects the initialiser expression: the bytes between the `=`
            // that opens it and the end of the statement's own text. A member with
            // no initialiser has an empty body, reported on its own line.
            const at = block.equalsAt ?? -1;
            if (at === -1 || at >= block.statementTo) return single('', block.declLine);
            return trimmedSlice(source, starts, at + 1, block.statementTo);
        }
        // The statement's own last line is what the `+`/`++` scopes extend from,
        // so a field takes its `@Annotation` and its doc comment exactly as a
        // method does — a field is a declaration too, and the annotation above it
        // belongs to it.
        block.endLine = last;
        return renderDeclaration(lines, source, starts, block, scope, ctx.annotationLine);
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
            // lines the trim removed at either end â€” a click lands on the
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
    // A non-final chain segment (`if â€¦ } else if â€¦`) shares its closing `}`
    // with the continuation on the same line: end the declaration at the brace,
    // not at the whole line.
    if (block.sharedClose) {
        return span(source.slice(starts[firstLine], block.close + 1).split('\n').map((l) => l.replace(/\s+$/, '')),
            firstLine, lineOf(starts, block.close));
    }
    return span(lines.slice(firstLine, lastLine + 1), firstLine, lastLine);
}

/**
 * Where one rendered slice came from: its line range, and how much of the
 * slice's own text belongs to it.
 *
 * A slice is one line range in almost every case, and `lead` is what makes it
 * more than one: a rendering may *prepend* a line of its own invention (the
 * `if` of a condition literal, the header of a chain segment) before the lines
 * the reference names, and then the lead belongs to the header line and the
 * rest to the lines that follow.
 *
 * @param {{ from: number, to: number }} range the slice's own bounds, 1-based
 * @param {string} text the rendered text
 * @param {number} lead how many of `text`'s characters precede `range`
 * @returns {Array<{ from: number, to: number }>}
 */
function sliceRanges(range, text, lead) {
    if (lead <= 0 || lead >= text.length) return [range];
    const linesTaken = text.slice(lead).split('\n').length;
    return [
        { from: range.from, to: range.from },
        { from: Math.max(range.from + 1, range.to - linesTaken + 1), to: range.to },
    ];
}

/** The last line (`from`..`to`) of a block's declaration, for the spans below. */
function lastDeclarationLine(block) {
    if (block.endLine !== undefined && block.endLine !== null) return block.endLine;
    if (block.closeLine !== null && block.closeLine !== undefined) return block.closeLine;
    return block.declLine;
}

/**
 * The lines a line-range selector names, as text and as a span.
 *
 * Lines are counted from 1 and columns from 1, both inclusive. A column is a
 * character offset *within* its line: `L40:12` starts at the twelfth character
 * of line 40, and the range runs to the end of its last line unless the other
 * endpoint names a column too. Anything the file does not have is an error
 * rather than a clamp â€” a range that silently became a different range is
 * exactly the drift a reference to a line number is for.
 *
 * @param {object} lex the scan's lexical facts
 * @param {{ from: LinePoint, to: LinePoint | null }} range
 * @param {string} raw the selector as written, for the messages
 * @returns {{ text: string, range: { from: number, to: number } }}
 */
function lineRangeSpan(lex, range, raw) {
    const { source, lines, starts } = lex;
    const fromLine = range.from.line;
    const to = range.to ?? range.from;
    const toLine = to.line;

    // `lines` is split on `\n`, so a file ending in a newline has a final empty
    // entry: the file's last line is the last entry that is not that emptiness.
    const total = source === '' ? 0 : lines.length;
    if (fromLine > total || toLine > total) {
        throw new Error(`"#${raw}": the file has ${total} line(s)`);
    }
    if (range.from.column !== null && range.from.column - 1 >= lines[fromLine - 1].length) {
        throw new Error(`"#${raw}": line ${fromLine} has ${lines[fromLine - 1].length} character(s)`);
    }

    const start = starts[fromLine - 1] + (range.from.column === null ? 0 : range.from.column - 1);
    let end;
    if (range.to !== null && range.to.column !== null) {
        if (range.to.column - 1 >= lines[toLine - 1].length) {
            throw new Error(`"#${raw}": line ${toLine} has ${lines[toLine - 1].length} character(s)`);
        }
        // Both columns are inclusive, so the slice runs one past the character
        // the second column names.
        end = starts[toLine - 1] + range.to.column;
    } else {
        end = endOfLine(source, starts[toLine - 1]);
    }

    return { text: source.slice(start, end), range: { from: fromLine, to: toLine } };
}

/**
 * Resolve a section reference to text, exposing the reference and any
 * contradiction warning. `resolveSection` is `planSection(...).text`.
 *
 * A reference is one or more selectors (`add,L40-L44`): each contributes its
 * own text, and the texts are joined with a newline in the order the selectors
 * were written. `ranges` says where each contribution came from â€” one line
 * range per selector, so a reference that names two far-apart pieces highlights
 * the two pieces and not the gap between them â€” and `startLine`/`endLine` are
 * the outermost bounds of the whole selection.
 *
 * @param {string} text the target file's content
 * @param {string} reference the `#` fragment content
 * @param {Lexer} [lexer] the file type's lexer; the built-in default engine when omitted
 * @returns {{ text: string, reference: Reference, startLine: number, endLine: number,
 *            ranges: Array<{ from: number, to: number }>,
 *            kind: 'region' | 'declaration' | 'property' | 'condition' | 'anchor'
 *                  | 'lines' | 'multiple' }}
 * @throws {SectionReferenceError} malformed reference
 * @throws {Error} the reference is well formed but matches nothing
 */
export function planSection(text, reference, lexer) {
    const ref = parseSelectors(reference);
    const source = text.replace(/\r\n/g, '\n');
    const scan = scanBlocks(source, undefined, lexer);
    const { lines, starts } = scan.lex;
    const ctx = { lines, source, starts, annotationLine: scan.lex.annotationLine };

    // An envelope is resolved first, and as a unit: the parent it names may be a
    // name several blocks answer to (a Rust type with three `impl`s), and which
    // one is meant is decided by what the marks wrap — the candidate that holds
    // the member. That is the same retry a path uses, one level up, so it is done
    // once for the whole reference rather than per selector.
    const envelope = resolveEnvelope(ref.selectors, scan, ctx);

    const parts = [];
    for (const selector of ref.selectors) {
        if (selector.kind === 'lines') {
            const picked = lineRangeSpan(scan.lex, selector, selector.raw);
            parts.push({ text: picked.text, kind: 'lines', ranges: [picked.range] });
            continue;
        }

        // A parent's own opening or closing lines, taken verbatim around whatever
        // sits between the marks.
        if (selector.envelope) {
            parts.push(envelope.parts.get(selector));
            continue;
        }

        parts.push(selectorPart(selector, envelope?.scopes.get(selector) ?? scan.root, scan, ctx));
    }

    const joined = parts.map((part) => part.text).join('\n');
    const ranges = [];
    for (const part of parts) {
        for (const range of part.ranges) {
            const last = ranges[ranges.length - 1];
            // Adjacent pieces join (`L1` and `L2` are one highlight). The pieces
            // stay in the order the selectors were written, because that is the
            // order the text is in.
            if (last && range.from >= last.from && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
            else ranges.push({ ...range });
        }
    }
    const from = ranges.reduce((low, range) => Math.min(low, range.from), Infinity);
    const to = ranges.reduce((high, range) => Math.max(high, range.to), -Infinity);

    return {
        text: joined, reference: ref,
        startLine: Number.isFinite(from) ? from : 1,
        endLine: Number.isFinite(to) ? to : 1,
        ranges,
        kind: parts.length === 1 ? parts[0].kind : 'multiple',
    };
}

/**
 * Read a reference that carries envelope marks: a parent declaration's own first
 * and last lines, wrapped around the members selected from inside it.
 *
 * `Inventory/^,toString,$` is the class's opening line, the `toString` method,
 * and the class's closing line. The marks say which block is being opened and
 * closed, and the path may be written on **either** of them: a bare mark refers
 * to the parent the other one names, so the path is written once rather than on
 * every selector. What sits **between** the marks is read inside that block, and
 * a selector that already names the parent is left alone, so the long form
 * (`Inventory/^,Inventory/toString,Inventory/$`) means the same thing.
 *
 * A mark is a whole segment of a path, so it cannot be confused with a name. What
 * has to be checked is that the pair makes sense: both ends present, one parent
 * between them, and in the `^` then `$` order. Anything else is an error rather
 * than a silent reading of something the user did not write.
 *
 * @param {object[]} selectors the parsed selectors, rewritten in place
 * @param {string} raw the reference as written, for the messages
 */
function applyEnvelope(selectors, raw) {
    if (!selectors.some((selector) => selector.envelope)) return;

    const first = selectors[0];
    const last = selectors[selectors.length - 1];
    if (selectors.length === 1) {
        throw new SectionReferenceError(
            `"#${raw}": a lone "${first.envelope.mark}" has nothing to ${first.envelope.mark === '^' ? 'close' : 'open'}`,
        );
    }
    if (!first.envelope || !last.envelope
        || first.envelope.mark !== '^' || last.envelope.mark !== '$') {
        throw new SectionReferenceError(
            `"#${raw}": an envelope is "^" first and "$" last, around what they open and close`,
        );
    }
    if (selectors.some((selector) => selector.envelope && selector !== first && selector !== last)) {
        throw new SectionReferenceError(`"#${raw}": an envelope has one "^" and one "$"`);
    }
    // The path may be on either end; where both are written they must agree.
    const named = [first.envelope.parent, last.envelope.parent].filter((parent) => parent !== null);
    const parent = named[0] ?? null;
    if (parent === null) {
        throw new SectionReferenceError(
            `"#${raw}": neither "^" nor "$" names a block, so there is nothing to open or close`,
        );
    }
    for (const other of named.slice(1)) {
        if (other.join('/') !== parent.join('/')) {
            throw new SectionReferenceError(
                `"#${raw}": "^" opens "${parent.join('/')}" and "$" closes "${other.join('/')}"; `
                + 'they must be the same block',
            );
        }
    }

    first.envelope.parent = parent;
    last.envelope.parent = parent;

    // What sits between the marks is read inside the block they name. A selector
    // that already starts with the parent's own path is left as written: it says
    // the same thing, and prepending the prefix twice would name nothing.
    for (const selector of selectors.slice(1, -1)) {
        if (selector.kind !== 'path') continue;
        const prefixed = parent.every((segment, index) => selector.segments[index] === segment);
        if (!prefixed) {
            selector.segments = [...parent, ...selector.segments];
            selector.raw = selector.segments.join('/');
        }
    }
}

/**
 * Resolve one path selector inside `scope` into its text and ranges.
 *
 * Every segment but the last is a container to descend into, retrying same-named
 * candidates (a Rust `struct Cart` beside its `impl Cart`); the last segment's
 * first match in walk order is the selection. The scope is the whole file for an
 * ordinary selector, and the block an envelope names for a selector written
 * between its marks.
 */
function selectorPart(selector, scope, scan, ctx) {
    const { lines, source, starts } = scan.lex;
    let final;
    try {
        final = scope === scan.root
            ? resolvePath(selector.segments, 0, scope, false, null)
            : resolveWithin(scope, selector.segments);
    } catch (err) {
        // Inside an envelope the parent is already chosen, so a failure here is
        // the reference's own: say which selector could not be read.
        if (scope === scan.root) throw err;
        throw new Error(err.message);
    }

    let rendered;
    let slice;
    let kind;
    if (final.region) {
        rendered = span(lines.slice(final.region.startLine + 1, final.region.endLine),
            final.region.startLine + 1, final.region.endLine - 1);
        // The region's own span is the rendered slice's: the directive lines
        // are not part of it, and the slice is exactly the lines between them.
        slice = { from: rendered.from, to: rendered.to };
        kind = 'region';
    } else {
        rendered = renderBlock(final.block, selector.scope, ctx, final.kind);
        kind = final.kind;
        if (final.kind === 'condition') {
            // The header line the matcher cites is rendered ahead of the
            // block's own first line; it is the first line of the slice.
            slice = { from: final.headerLine + 1, to: lastDeclarationLine(final.block) + 1 };
        } else if (final.kind === 'anchor') {
            const anchorLine = final.block.anchor !== null ? final.block.anchor.line : final.block.declLine;
            slice = { from: anchorLine + 1, to: lastDeclarationLine(final.block) + 1 };
        } else {
            slice = { from: rendered.from, to: rendered.to };
        }
    }

    // A rendering may prepend a line of its own invention — the `if` of a
    // condition literal, the brace line of a body that opens below its
    // header — before the lines the span names, so the span is only exact
    // for the part of the text that matches the source; the lead is the
    // header line's own.
    const head = source.slice(starts[slice.from - 1], starts[slice.to]);
    const lead = rendered.text.startsWith(head) ? head.length : 0;
    return { text: rendered.text, kind, ranges: sliceRanges(slice, rendered.text, lead) };
}

/**
 * Resolve a path whose **first** segment is a member of `block`, exactly as
 * `Cart/add` resolves inside `Cart`: the rest of the path is searched in that
 * block and nothing else is considered.
 */
function resolveWithin(block, segments) {
    if (segments.length === 1) {
        const candidates = matchSegment(block, segments[0], true);
        if (candidates.length === 0) throw new Error(`no section named "${segments[0]}" in "${block.name}"`);
        if (candidates.length > 1) {
            throw new Error(`"${segments[0]}" is declared ${candidates.length} times; names must be unique`);
        }
        return candidates[0];
    }
    return resolvePath(segments, 1, block, true, block.name);
}

/**
 * Resolve one envelope selector: the first lines of the block its path names, or
 * the last one.
 *
 * The lines are taken verbatim, because that is what the envelope is *for*: a
 * method copied out of a class reads as a fragment, and the declaration that
 * holds it is what makes it read as code.
 *
 * The head is the declaration's **opening lines** — where the name is written,
 * through the line its body opens on, so a wrapped signature comes whole. The tail
 * is the block's **closing line**. Each is a piece of its own, so a member
 * selected between them is a third: the three are disjoint, which is what lets a
 * host point at the declaration, the member and the end of the block separately
 * instead of at everything between them.
 *
 * @param {object} selector the `^` or `$` selector
 * @param {object} scan the scan of the target file
 * @returns {{ text: string, ranges: { from: number, to: number }[], kind: string }}
 */
function envelopePart(selector, scan, block) {
    const { lines } = scan.lex;
    const isHead = selector.envelope.mark === '^';
    const to = isHead
        ? Math.min(block.openLine ?? block.declLine, lastDeclarationLine(block))
        : lastDeclarationLine(block);
    const from = isHead ? block.declLine : to;
    // The text is exactly the range: a tail is the closing line and not the block
    // it closes, and the caller rebuilds nothing for an envelope.
    const text = lines.slice(from, to + 1).join('\n');
    return { text, ranges: [{ from: from + 1, to: to + 1 }], kind: 'envelope' };
}

/**
 * The block an envelope mark names. The whole path before the mark is a scope, so
 * it resolves exactly as it would mid-path: a name that matches nothing is
 * `no section named "…" in "…"`, and a name several blocks answer to is the
 * ambiguity error, never a guess.
 */
function resolveEnvelopeParent(selector, scan) {
    const final = resolvePath(selector.envelope.parent, 0, scan.root, false, null);
    if (final.region) {
        throw new SectionReferenceError(
            `"${selector.raw}": a region has no declaration to open or close`,
        );
    }
    return final.block;
}

/**
 * Read a reference's envelope as a unit: which block the marks open and close,
 * and the opening and closing pieces for it.
 *
 * Which block is meant is decided by what the marks **wrap**, not by the name —
 * the same retry a path uses one level up. A Rust type has a `struct` and one or
 * more `impl` blocks, all of them answering to the type's name, so `Cart/^,add,$`
 * is the `impl` that holds `add`; a type with a single declaration has one
 * candidate and no retry at all.
 *
 * @param {object[]} selectors every parsed selector, in written order
 * @param {object} scan the scan of the target file
 * @param {object} ctx the rendering context (source lines and offsets)
 * @returns {{ selectors: object[], parts: Map<object, object>, scopes: Map<object, object> } | null}
 *   the envelope, or null when the reference has none
 */
function resolveEnvelope(selectors, scan, ctx) {
    if (!selectors.some((selector) => selector.envelope)) return null;

    const open = selectors[0];
    const close = selectors[selectors.length - 1];
    const parent = open.envelope.parent;

    // A one-segment parent is asked for *every* block it names, because the marks
    // choose among them: a Rust type is a `struct` beside one or more `impl`s, and
    // the envelope is whichever one holds the member. A path of several segments
    // already decided, so there is one candidate.
    const listed = parent.length === 1 ? matchedCandidates(parent[0], scan.root, false) : null;
    const blocks = listed ?? [resolvePath(parent, 0, scan.root, false, null)].map((found) => {
        if (found.region) {
            throw new SectionReferenceError(`"#${open.raw}": a region has no declaration to open or close`);
        }
        return found.block;
    });
    if (blocks.length === 0) {
        throw new Error(`no "#region ${parent[0]}" found, and no section named "${parent[0]}"`);
    }

    const interior = selectors.slice(1, -1);
    const parts = new Map();
    const scopes = new Map();

    let failure = null;
    for (const block of blocks) {
        if (!isContainer(block)) continue;
        try {
            // Every interior selector has to resolve inside this candidate, or
            // this is not the block the envelope is about.
            for (const selector of interior) {
                if (selector.kind !== 'path') continue;
                selectorPart(selector, block, scan, ctx);
            }
        } catch (err) {
            // One message, naming the selector as the *user* wrote it rather than
            // the parent-qualified spelling the envelope reads it as.
            if (failure === null) failure = new Error(err.message);
            continue;
        }
        for (const selector of [open, close]) {
            parts.set(selector, envelopePart(selector, scan, block));
            scopes.set(selector, block);
        }
        for (const selector of interior) scopes.set(selector, block);
        return { parts, scopes };
    }
    throw failure ?? new Error(`"${parent.join('/')}" is not a container`);
}

/**
 * The candidates a single name answers to in one scope, without the ambiguity
 * check: an envelope asks them in turn.
 */
function matchedCandidates(name, scope, descended) {
    return matchSegment(scope, name, descended)
        .filter((match) => !match.region)
        .map((match) => match.block);
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
 * declares nothing. Backed by the block scanner (contract Â§6): searches the
 * whole file at any depth, prefers a class-like over a same-named member, and
 * throws on a genuine overload pair. This is `extractDeclaration`'s semantics,
 * unchanged â€” it never matches a `#region` directive, only declarations.
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
 * level â€” every sibling at the current depth is tried with the full matcher
 * table, left to right, before the walk descends into any block they contain
 * (contract Â§6 walk order, as amended: siblings before deeper blocks).
 *
 * Usually there is one hit. A name may be declared more than once at one level â€”
 * a Rust `struct Cart` beside its `impl Cart`, two `impl` blocks for one type â€”
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
 * Resolve `segments[index..]` starting at `scope`.
 *
 * A name declared more than once at one level is **ambiguous**, and ambiguity is
 * an error, never a guess: `#add` must not inject the first of two `add`s, and
 * `#Cart` must not inject the `struct` when an `impl Cart` sits beside it. The
 * message names the name and the count.
 *
 * What is *not* ambiguity is a name that several blocks share where the rest of
 * the path decides: a Rust `struct Cart` beside its `impl Cart` blocks all
 * answer to `Cart`, and `Cart/add` is resolved by retrying them in walk order —
 * the one that holds `add` wins, and the others are not candidates for the
 * selection at all. Only a last segment (or a set of candidates whose descents
 * *all* succeed) is ambiguous.
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

    // The selection itself: nothing follows, so a second candidate is a second
    // answer and the reference does not say which one it wants.
    if (last && candidates.length > 1) {
        throw new Error(`"${segment}" is declared ${candidates.length} times; names must be unique`);
    }

    let failure = null;
    let matched = null;
    for (const found of candidates) {
        if (last) return found;
        if (found.region || !isContainer(found.block)) {
            if (failure === null) failure = new Error(`"${segment}" is not a container`);
            continue;
        }
        let resolved = null;
        try {
            resolved = resolvePath(segments, index + 1, found.block, true, segment);
        } catch (err) {
            if (failure === null) failure = err;
            continue;
        }
        // Two candidates both holding the rest of the path is the same ambiguity
        // one level down: the path does not choose between them. Decided after
        // the catch, because the throw belongs to this frame, not that one.
        if (matched !== null) {
            throw new Error(`"${segment}" is declared ${candidates.length} times; names must be unique`);
        }
        matched = resolved;
    }
    if (matched !== null) return matched;
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
        bodyFrom: undefined,
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
        // than the generic ones (Ruby `def name`, a Haskell binding). A shape a
        // language declares is read from its own line, which is how those
        // languages spell one.
        const declared = lex.declarations ? lex.declarations(mLine) : [];
        const declaredHere = declared.filter((entry) => entry.name && !NOT_A_NAME.has(entry.name));
        /** Read a candidate name as a declaration, its own line first. */
        const declaredOn = (name) => declarationOn(mLine, start, name, [], lex);
        // A segment the language declares with a suffix (`add!`) is that name and
        // not the name plus a modifier. Ruby's `!`, `?` and `=` are part of an
        // identifier, so the segment is the key to the declaration above it.
        const suffixedHere = new Map();
        for (const entry of declaredHere) {
            if (entry.base && entry.base !== entry.name) suffixedHere.set(entry.name, entry);
        }
        if (declaredHere.length > 0) {
            let lastEnd = i;
            for (const entry of declaredHere) {
                // A shape that declares itself complete on its own line (a Rust
                // field, a one-line Haskell binding) is a selection of that line;
                // only a shape that opens a body is followed for one.
                const isLineShape = entry.line === true;
                // A one-line shape (`add x y = x + y`) is a selection of its own
                // line. Its *body* is what an expression it states extends into —
                // an indented `do` block — and is empty when it states none, so
                // the body starts where it ends and the slice comes out empty.
                let span = null;
                let nameEnd = -1;
                if (isLineShape) {
                    // A one-line shape states its body with the `=` on its line: the
                    // body is what follows that `=`, extended by any indented lines
                    // below (a `do` block). With no `=` there is no body, so it
                    // starts where it ends and the slice is empty.
                    const eq = maskLines[i].indexOf('=');
                    let first = i;
                    let last = i;
                    if (eq !== -1) {
                        first = lineOf(starts, starts[i] + eq + 1);
                        last = first;
                        const indent = indentWidth(lines[i]);
                        for (let at = first + 1; at < lines.length; at++) {
                            if (lines[at].trim() === '') break;
                            if (indentWidth(lines[at]) <= indent) break;
                            last = at;
                        }
                    }
                    span = { indented: true, open: null, close: null, bodyEndLine: last, bodyFrom: first };
                }
                if (entry.body === 'end') {
                    // A shape whose body a keyword line closes (Ruby `end`, VB
                    // `End`) keeps the declaration line as its header.
                    span = keywordBody(lines, i, entry.end ?? 'end');
                } else if (!isLineShape) {
                    // A shape says where its body begins. An `=` is an expression
                    // body and is read as such. A `{` — or an offset just past one,
                    // which is how a shape that opens a brace body states it — is
                    // a brace body, scanned from the shape's own name so brackets
                    // before it cannot offset the depth. Anything else is followed
                    // normally: a class whose members are indented, a wrapped
                    // shape, or a shape that carries no body of its own.
                    const nameAt = start + mLine.indexOf(entry.name);
                    nameEnd = nameAt + entry.name.length;
                    const at = start + entry.headerFrom;
                    const opened = mask[at] === '{' ? at : mask[at - 1] === '{' ? at - 1 : -1;
                    // A shape that states where its body begins says so with the
                    // offset just past the `{`; when it names no body (the match
                    // ends at the name), the header is followed from there — the
                    // same scan the generic `name(` shape gets, which spans a
                    // wrapped parameter list and finds the `{` or `=` after it.
                    if (mask[at] === '=') {
                        span = expressionBody(lines, starts, i, at + 1);
                    } else if (opened !== -1) {
                        span = bodySpan(mask, maskLines, starts, i, opened, nameAt);
                    } else {
                        span = bodySpan(mask, maskLines, starts, i, at, nameAt);
                    }
                }
                const blk = makeBlock(entry.kind ?? 'method', entry.name, i);
                if (process.env.DSH_TRACE) console.error('SHAPE', entry.name, 'isLine', isLineShape, 'spanType', typeof span, 'span', JSON.stringify(span));
                if (span) {
                    applySpan(blk, span, mask, starts);
                    if (span.expressionEndLine !== undefined) blk.expressionEndLine = span.expressionEndLine;
                }
                // A shape complete on its own line (a Rust field, a one-line
                // binding) is a selection even when no body was found.
                else if (entry.line) { blk.endLine = i; blk.singleLine = true; }
                else continue;                       // nothing to inject
                applyAnchor(blk, lex, span, nameEnd);
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
            const after = start + keyword.index + keyword[0].length;
            const nameAt = start + keyword.index + keyword[0].indexOf(name);
            const span = bodySpan(mask, maskLines, starts, i, after, nameAt);
            const blk = makeBlock('class', name, i);
            applySpan(blk, span, mask, starts);
            applyAnchor(blk, lex, span, -1);
            register(list, blk, blocks);
            descend(blk, i, span, lex, blocks);
            i = endLineOf(span, i) + 1;
            continue;
        }

        let methodDecl = null;
        let methodNameAt = -1;
        let methodFrom = -1;
        let methodHasPrefix = false;
        const callMatch = new RegExp('(^|[^\\w$.])([A-Za-z_$][\\w$]*)\\s*\\(', 'g');
        let cm;
        while ((cm = callMatch.exec(mLine)) !== null) {
            const nm = cm[2];
            if (NOT_A_NAME.has(nm)) continue;
            const before = mLine.slice(0, cm.index + cm[1].length);
            const prefix = before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
            if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
            // An annotation that carries arguments — Kotlin's `@JvmName("addOne")`,
            // a decorator — ends in `(` and a word, so the call shape reads it as a
            // method named after the annotation, and the body that candidate finds
            // is the declaration below it. An `@`-introduced name is never a
            // declaration: no language declares one that way.
            if (prefix.trimStart().startsWith('@')) continue;
            const found = declaredOn(nm);
            if (found && found.kind === 'method') {
                methodDecl = found;
                methodNameAt = found.nameAt;
                methodFrom = found.headerFrom;
                methodHasPrefix = prefix !== '';
                break;
            }
        }
        if (!methodDecl) {
            const assignedName = new RegExp('(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_$][\\w$]*)\\b[^=\\n]*=\\s*(?:async\\s+)?(?:function\\b|[^;]*=>)', 'g');
            let am;
            while ((am = assignedName.exec(mLine)) !== null) {
                const found = declarationOn(mLine, start, am[2]);
                if (found && found.kind === 'method') {
                    methodDecl = found;
                    methodNameAt = found.nameAt;
                    methodFrom = found.headerFrom;
                    methodHasPrefix = true;
                    break;
                }
            }
        }
        if (methodDecl) {
            const span = bodySpan(mask, maskLines, starts, i, methodFrom, methodNameAt);
            if (!span && !methodHasPrefix) { i++; continue; } // a bare `foo();` call, not a declaration
            const blk = makeBlock('method', methodDecl.name, i);
            applySpan(blk, span, mask, starts);
            applyAnchor(blk, lex, span, -1);
            register(list, blk, blocks);
            descend(blk, i, span, lex, blocks);
            i = endLineOf(span, i) + 1;
            continue;
        }

        const stmt = STATEMENT_KEYWORD.exec(mLine);
        if (stmt) {
            const bracePos = mask.indexOf('{', start);
            if (bracePos !== -1) {
                // `makeSegment` reports the condition's offset within its line, so
                // the keyword's own offset is given to it in mask coordinates —
                // `stmt.index` is relative to the line.
                const segs = chainSegments(mask, starts, i, stmt[1], bracePos, start + stmt.index);
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
                    applyAnchor(blk, lex, seg, seg.open + 1);
                    register(list, blk, blocks);
                    descend(blk, seg.headerLine, { openLine: seg.openLine, closeLine: seg.closeLine }, lex, blocks);
                    lastCloseLine = Math.max(lastCloseLine, seg.closeLine);
                }
                i = lastCloseLine + 1;
                continue;
            }

            // The same statement, closed by indentation rather than a brace —
            // Python's `if`, Ruby's `if`/`elsif`, VB's `If`/`ElseIf`. Only a
            // statement block carries its header's literals, so without this a
            // condition literal in a language that does not brace its blocks is
            // unreachable at any depth.
            const indent = indentWidth(mLine);
            const bodyFrom = i + 1;
            let bodyEndLine = i;
            for (let k = bodyFrom; k < lines.length; k++) {
                if (lines[k].trim() === '') continue;
                if (indentWidth(lines[k]) <= indent) break;
                bodyEndLine = k;
            }
            if (bodyEndLine > i) {
                const blk = makeBlock('statement', null, i);
                const span = { indented: true, bodyFrom, bodyEndLine };
                applySpan(blk, span, mask, starts);
                const hdrEnd = endOfLine(mask, start);
                blk.conditions = lex.conditionLiterals(source.slice(start, hdrEnd), stmt.index);
                applyAnchor(blk, lex, span, -1);
                register(list, blk, blocks);
                descend(blk, i, span, lex, blocks);
                i = bodyEndLine + 1;
                continue;
            }
        }

        const prop = PROPERTY_DECL.exec(mLine);
        // A property's type and modifiers are words, so a statement keyword in
        // that position means this is not a declaration: VB writes `If name =
        // "count" Then` with the same `=` an assignment uses, and reading it as a
        // property named `name` hides the condition literal that names the block.
        // The keyword is the *first* word, so the test is anchored — `methodName`
        // contains the letters of `if` and is not a keyword.
        const propPrefix = prop && prop[2] ? prop[2].trim().split(/\s+/)[0] : null;
        const propIsStatement = propPrefix !== null
            && (NOT_A_TYPE.has(propPrefix) || STATEMENT_KEYWORD_AT_START.test(propPrefix));
        if (prop && !NOT_A_NAME.has(prop[3])
            && !STATEMENT_BEFORE.test(prop[0].trim())
            && !propIsStatement) {
            const blk = makeBlock('property', prop[3], i);
            // The whole statement is the selection, `;` and all. The scan starts
            // at the top of the declaration's own line, where every bracket is
            // closed by construction, and follows it to its `;` — so a lambda, an
            // array or an anonymous-class initialiser inside it is the
            // statement's own brace and not the end of the statement. The `=` is
            // the one the matcher's own look-ahead found, so the initialiser is
            // read from the same place in every shape.
            const equals = start + prop.index + prop[0].lastIndexOf('=');
            const statement = statementEnd(mask, starts, start, mask.length, equals, lines);
            blk.lineEnd = statement.last;
            blk.statementTo = statement.initializerEnd;
            blk.equalsAt = statement.equals;
            register(list, blk, blocks);
            i = Math.max(i, statement.last) + 1;
            continue;
        }

        i++;
    }
    return list;
}

function applySpan(blk, span, mask, starts) {
    void mask; void starts;
    if (!span) return;
    if (span.indented) {
        blk.indented = true;
        // The body starts at `bodyFrom` when the header wrapped (its own lines are
        // the declaration's, not the body's) and runs to `bodyEndLine`. A
        // one-line shape that was not extended has its body before it starts,
        // which is what makes that body empty.
        const first = span.bodyFrom === undefined ? blk.declLine + 1 : span.bodyFrom;
        blk.bodyFrom = first;
        blk.closeLine = span.bodyEndLine;
        blk.endLine = span.bodyEndLine;
        return;
    }
    if (span.expression !== undefined) {
        blk.expression = span.expression;
        if (span.expressionEndLine !== undefined) blk.expressionEndLine = span.expressionEndLine;
        // An expression body is rendered from its own offset, so no `endLine` may
        // be left behind for `renderDeclaration` to prefer over it.
        delete blk.endLine;
        return;
    }
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

/**
 * The anchor of an **indented** block (a Python `def`, a Ruby `def`): the
 * trailing comment on its header line, or a comment that is the first thing in
 * its body. There is no brace to open, so the body starts at `bodyFrom` and the
 * candidate must be that line or the declaration's own.
 *
 * @returns {{ name: string, line: number } | null}
 */
function indentAnchor(comments, source, lines, starts, declLine, bodyFrom, bodyTo) {
    const firstOfLine = (c) => {
        const line = lineOf(starts, c.from);
        // On the declaration's own line the comment *is* the trailing comment —
        // `def legacy(self):  #count` — so nothing needs to precede it.
        return line === declLine || /^\s*$/.test(source.slice(starts[line], c.from));
    };

    let first = null;
    for (const c of comments) {
        const line = lineOf(starts, c.from);
        if (line < declLine) continue;
        if (line > bodyTo) break;
        if (line !== declLine && line !== nextNonBlank(lines, declLine + 1)) break;
        if (firstOfLine(c)) first = c;
        break;
    }
    if (!first) return null;
    const body = first.text.trim();
    if (/^(#?)(region|endregion)\b/i.test(body)) return null;
    const name = /^([A-Za-z_$][\w$]*)$/.exec(body);
    if (!name) return null;
    return { name: name[1], line: lineOf(starts, first.from) };
}

function applyAnchor(blk, lex, span, nameEnd) {
    if (!span) return;
    if (span.open !== undefined && span.open !== null) {
        // A header whose `{` is on a later line carries its anchor on the
        // declaration's own line — `Legacy() //count` with `{` below it — so the
        // header's own comment is a candidate after the name.
        const headerComment = nameEnd === undefined || nameEnd === null
            ? null
            : headerAnchor(lex, blk.declLine, nameEnd);
        const a = headerComment
            ?? leadingAnchor(lex.comments, lex.source, lex.lines, lex.starts, span.open);
        if (a) blk.anchor = a;
        return;
    }
    // An indented body (a Python `def`, a Ruby `def`) or a keyword-delimited one
    // (`End Function`): no brace, so the anchor is looked for on the declaration's
    // header line and in the first line of the body.
    const from = span.bodyFrom === undefined ? blk.declLine + 1 : span.bodyFrom;
    const to = span.bodyEndLine === undefined ? blk.declLine : span.bodyEndLine;
    const a = indentAnchor(lex.comments, lex.source, lex.lines, lex.starts, blk.declLine, from, to);
    if (a) blk.anchor = a;
}

/**
 * The anchor a braced declaration carries on its **header** line, after its name:
 * `public void Legacy() //count`, with the body's `{` on the next line.
 *
 * @returns {{ name: string, line: number } | null}
 */
function headerAnchor(lex, declLine, nameEnd) {
    let found = null;
    for (const c of lex.comments) {
        const line = lineOf(lex.starts, c.from);
        if (line < declLine) continue;
        if (line > declLine) break;
        if (c.from < nameEnd) continue;
        found = c;
        break;
    }
    if (!found) return null;
    const body = found.text.trim();
    if (/^(#?)(region|endregion)\b/i.test(body)) return null;
    const name = /^([A-Za-z_$][\w$]*)$/.exec(body);
    if (!name) return null;
    return { name: name[1], line: declLine };
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
