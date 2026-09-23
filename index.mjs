/**
 * inject-examples — library.
 *
 * Keeps a Markdown document honest: a *marker* line that is nothing but a link
 * to a real file is followed by a fenced code block, and that block is replaced
 * verbatim with the file's text (or with one region of it). Because the text is
 * copied rather than typed, the document cannot drift from the file it shows.
 * A fence left without a language is given the file's, so the block highlights.
 *
 * What `#region:<name>` means depends on the file's type: each type has one
 * rule, and the reference is handed to the rule that claims the file's
 * extension. A code file resolves a region directive, or a method or inner
 * class by name; a `.json` file, which has no comments to hang a directive on,
 * resolves a list of keys. See `REGION_RULES` and `ruleFor`.
 *
 * This module is pure: it reads only through the `readFile` you hand it, so it
 * is safe to unit-test and to embed. `cli.mjs` is the thin executable wrapper.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** A fence is a line starting with this; three backticks, per CommonMark. */
export const FENCE = '```';

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

// `//`, `#`, `--`, `;`, `%`, `'`, REM, <!-- and /* ... */ are all comment
// spellings seen in the wild; strip whichever one opens the line.
const COMMENT_OPENER = /^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i;
const COMMENT_CLOSER = /\s*(?:-->|\*\/)$/;

/**
 * Read one line as a region directive, or return null.
 *
 * Accepts the spellings the major editors share — `#region name` /
 * `#endregion`, `// #region name`, `//region name`, `<!-- #region name -->`
 * and the C-style block form — under any comment prefix.
 *
 * @returns {{ kind: 'region' | 'endregion', name: string } | null}
 */
export function regionDirective(line) {
    let text = line.trim();

    const closer = COMMENT_CLOSER.exec(text);
    if (closer) text = text.slice(0, closer.index).trim();

    const commented = COMMENT_OPENER.test(text);
    if (commented) text = text.replace(COMMENT_OPENER, '').trim();

    const match = /^(#?)(region|endregion)\b\s*(.*)$/i.exec(text);
    if (!match) return null;
    // A bare `region foo` line is prose, not a directive: without a comment
    // prefix the C# spelling (`#region`) is required.
    if (!commented && match[1] !== '#') return null;

    return { kind: match[2].toLowerCase(), name: match[3].trim() };
}

/**
 * The lines strictly between `#region <name>` and the next `#endregion`.
 *
 * Throws when the region is missing, ambiguous, interleaved with another
 * region, or never closed.
 */
export function extractRegion(text, name) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const starts = [];
    const ends = [];

    lines.forEach((line, index) => {
        const directive = regionDirective(line);
        if (!directive) return;
        if (directive.kind === 'region') {
            if (directive.name === name) starts.push(index);
        } else {
            ends.push(index);
        }
    });

    if (starts.length === 0) throw new Error(`no "#region ${name}" found`);
    if (starts.length > 1) {
        throw new Error(`"#region ${name}" appears ${starts.length} times; region names must be unique`);
    }

    const end = ends.find((index) => index > starts[0]);
    if (end === undefined) throw new Error(`"#region ${name}" is never closed by an #endregion`);

    const interleaved = lines
        .slice(starts[0] + 1, end)
        .map((line) => regionDirective(line))
        .find((directive) => directive !== null && directive.kind === 'region');
    if (interleaved) {
        throw new Error(`"#region ${name}" is interleaved with "#region ${interleaved.name}"`);
    }

    return lines.slice(starts[0] + 1, end).join('\n');
}

// ---------------------------------------------------------------------------
// Region rules by file type
// ---------------------------------------------------------------------------
//
// A marker's `#region:<reference>` means "the piece of this file called
// <reference>". What the reference may say, and what comes back, depends on
// the file's type: each type has one rule, and the reference is handed to the
// rule that claims the file's extension. `code` is the fallback, so a single
// rule serves every language no other rule claims.

/**
 * Split a code reference into its scope modifier and the name it applies to.
 *
 * `-`, `+` and `++` select how much of a matched declaration is injected: its
 * body alone, the declaration with the annotations above it, or those with the
 * doc comment above them too. Without a modifier the declaration itself is
 * injected. An explicit region directive is unaffected — a region is already
 * exactly its body.
 *
 * @param {string} reference
 * @returns {{ scope: 'declaration' | 'body' | 'annotated' | 'documented', name: string }}
 */
export function codeReference(reference) {
    const modifier = /^(\+\+|[-+])/.exec(reference);
    if (!modifier) return { scope: 'declaration', name: reference };
    const scope = modifier[1] === '-' ? 'body' : modifier[1] === '+' ? 'annotated' : 'documented';
    return { scope, name: reference.slice(modifier[1].length) };
}

/** A line that opens a doc comment, or one of a run of `///` lines. */
const DOC_OPEN = /^\s*\/\*[*!]/;
const DOC_RUN = /^\s*\/\/\//;

/** A Java/C#/TypeScript decorator, or a Rust attribute. */
const ANNOTATION_LINE = /^\s*(?:@[\w.$]|#\[)/;

/** The keyword and the name of a class-like declaration. */
const DECLARATION_KEYWORD =
    /\b(?:class|interface|enum|record|struct|trait|object|union)\s+([A-Za-z_$][\w$]*)\b/;

/** Keywords that can stand where a name would, but never declare one. */
const NOT_A_NAME = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'do', 'else',
    'throw', 'await', 'yield', 'typeof', 'delete', 'void', 'in', 'of',
    'instanceof', 'super', 'this', 'with', 'case', 'when', 'sizeof',
]);

/** A statement keyword a declaration's prefix may not start with. */
const STATEMENT_BEFORE = /^(?:return|throw|new|await|yield|delete|typeof|case|else|do)\b/;

/** What may precede a declared name: modifiers and a type, nothing else. */
const PREFIX = /^[\w$<>\[\],.?*&:@\s]*$/;

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

/** How far a line is indented. */
function indentWidth(line) {
    return line.length - line.trimStart().length;
}

/** The balance of (), [] and {} on one line. */
function bracketBalance(line) {
    let depth = 0;
    for (const char of line) {
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;
    }
    return depth;
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

/** Escape a name for use inside a regular expression. */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` with every comment and string literal blanked to spaces, newlines
 * kept. Offsets and line structure are untouched, so a brace inside a string
 * or a comment cannot be mistaken for the end of a declaration's body.
 *
 * `#` opens a line comment except before `[`, which keeps a Rust attribute
 * (`#[derive(Debug)]`) readable while hiding a Python or shell comment.
 */
function strippedCode(text) {
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
    return out.join('');
}

/**
 * Whether one stripped line declares something named `name`, and where the
 * declaration's header ends — after the name for a class-like declaration,
 * after the parameter list for a method.
 *
 * @returns {{ kind: 'class' | 'method', headerFrom: number } | null}
 */
function declarationOn(source, start, length, name) {
    if (name === '' || NOT_A_NAME.has(name)) return null;
    const line = source.slice(start, start + length);
    const escape = escapeRegExp(name);

    const keyword = DECLARATION_KEYWORD.exec(line);
    if (keyword && keyword[1] === name) {
        return { kind: 'class', headerFrom: start + keyword.index + keyword[0].length };
    }

    // `name(…)` — a method, function, constructor or object-literal method.
    const call = new RegExp(`(^|[^\\w$.])${escape}\\s*\\(`, 'g');
    let match;
    while ((match = call.exec(line)) !== null) {
        const at = start + match.index + match[1].length;
        const before = source.slice(start, at);
        // A Go receiver, `func (c *Cart) Add(…)`, belongs to the declaration
        // but not to the name.
        const prefix = before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
        if (prefix !== '' && (!PREFIX.test(prefix) || STATEMENT_BEFORE.test(prefix))) continue;
        const paren = start + match.index + match[0].length - 1;
        const close = matchingBracket(source, paren, ')');
        if (close === -1) continue;
        return { kind: 'method', headerFrom: close + 1 };
    }

    // `const name = (…) =>`, a class field `name = (…) =>`, `name = function …`
    // — an assignment that defines a function, where an `=` replaces the
    // return type a method would carry.
    const assigned = new RegExp(
        `(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?${escape}\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?`,
        'g',
    );
    while ((match = assigned.exec(line)) !== null) {
        const after = start + match.index + match[0].length;
        const rest = source.slice(after, start + length);
        const arrow = rest.indexOf('=>');
        const fn = /^function\b/.exec(rest);
        if (arrow !== -1 && (fn === null || arrow < fn.index)) {
            return { kind: 'method', headerFrom: after + arrow };
        }
        if (fn) return { kind: 'method', headerFrom: after + fn[0].length };
    }
    return null;
}

/**
 * The range of a declaration whose body is the braces opened at `open`.
 *
 * @returns {{ kind: string, declLine: number, endLine: number, open: number,
 *             close: number, openLine: number } | null}
 */
function braced(source, starts, kind, declLine, open) {
    const close = matchingBracket(source, open, '}');
    if (close === -1) return null;
    return {
        kind,
        declLine,
        openLine: lineOf(starts, open),
        open,
        close,
        endLine: lineOf(starts, close),
    };
}

/**
 * Where a declaration found on `declLine` begins and ends.
 *
 * @returns {{ kind: string, declLine: number, endLine: number, open?: number,
 *             close?: number, openLine?: number, expression?: number,
 *             indented?: boolean } | null}
 */
function declarationRange(lines, source, starts, declLine, declaration) {
    const from = declaration.headerFrom;
    const lineEnd = endOfLine(source, starts[declLine]);
    const rest = source.slice(from, Math.max(from, lineEnd));

    const terminators = [
        { at: rest.indexOf('{'), kind: 'brace' },
        { at: rest.indexOf(';'), kind: 'none' },
        { at: rest.indexOf('=>'), kind: 'arrow' },
    ].filter((option) => option.at !== -1).sort((left, right) => left.at - right.at);

    const first = terminators[0];
    if (first?.kind === 'none') return null; // a declaration with no body

    if (first?.kind === 'arrow') {
        const body = rest.slice(first.at + 2).indexOf('{');
        if (body === -1) {
            // An expression-bodied arrow function: the body is the expression.
            return { kind: declaration.kind, declLine, endLine: declLine, expression: from + first.at + 2 };
        }
        return braced(source, starts, declaration.kind, declLine, from + first.at + 2 + body);
    }
    if (first?.kind === 'brace') {
        return braced(source, starts, declaration.kind, declLine, from + first.at);
    }

    // Nothing on the declaration's own line: an Allman brace, or an indented
    // block on the next non-blank line (Python, Ruby, …).
    const next = nextNonBlank(lines, declLine + 1);
    if (next === -1) return null;

    if (/^\s*\{/.test(lines[next])) {
        return braced(source, starts, declaration.kind, declLine, starts[next] + lines[next].indexOf('{'));
    }

    const indent = indentWidth(lines[declLine]);
    if (indentWidth(lines[next]) > indent) {
        let end = next;
        for (let i = next + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue; // a blank line inside the block
            if (indentWidth(lines[i]) <= indent) break;
            end = i;
        }
        return { kind: declaration.kind, declLine, endLine: end, indented: true };
    }
    return null;
}

/** The first line of the annotation block directly above `declLine`, or -1. */
function annotationStart(lines, declLine) {
    let found = -1;
    for (let i = declLine - 1; i >= 0; i--) {
        if (lines[i].trim() === '') break;
        if (ANNOTATION_LINE.test(lines[i])) {
            found = i;
            break;
        }
    }
    if (found === -1) return -1;

    let start = found;
    for (let i = found - 1; i >= 0; i--) {
        if (lines[i].trim() === '' || !ANNOTATION_LINE.test(lines[i])) break;
        start = i;
    }

    // The block must be annotations all the way. A statement between the
    // declaration and the annotation means there is no annotation block.
    let depth = 0;
    for (let i = start; i < declLine; i++) {
        if (depth === 0 && !ANNOTATION_LINE.test(lines[i])) return -1;
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

/** The text one declaration contributes, under one scope. */
function renderDeclaration(lines, source, starts, range, scope) {
    if (scope === 'body') {
        if (range.indented) return lines.slice(range.declLine + 1, range.endLine + 1).join('\n');
        if (range.expression !== undefined) {
            return source.slice(range.expression, endOfLine(source, range.expression)).trim();
        }
        if (range.openLine === range.endLine) return source.slice(range.open + 1, range.close).trim();
        return lines.slice(range.openLine + 1, range.endLine).join('\n');
    }

    let start = range.declLine;
    if (scope === 'annotated' || scope === 'documented') {
        const annotated = annotationStart(lines, range.declLine);
        if (annotated !== -1) start = annotated;
        if (scope === 'documented') {
            const documented = docCommentStart(lines, start);
            if (documented !== -1) start = documented;
        }
    }
    return lines.slice(start, range.endLine + 1).join('\n');
}

/**
 * The text a named declaration occupies, or null when `name` declares nothing.
 *
 * A declaration is a method, constructor, function or class-like declaration
 * (`class`, `interface`, `enum`, `record`, `struct`, `trait`, `object`) whose
 * name is `name`. A class name beats a same-named constructor; two real
 * declarations of one name — an overload pair — are an error, exactly as two
 * regions of one name are.
 *
 * The matcher is a heuristic, not a parser: it reads declaration-shaped lines
 * and counts brackets over text whose comments and string literals are
 * blanked, which covers the ordinary spellings of Java, C#, C/C++,
 * JavaScript/TypeScript, Go, Rust, PHP, Kotlin and Swift. Python and Ruby,
 * whose bodies are indented rather than braced, are followed by indentation.
 *
 * @param {string} text
 * @param {string} name
 * @param {'declaration' | 'body' | 'annotated' | 'documented'} [scope]
 * @returns {string | null}
 */
export function extractDeclaration(text, name, scope = 'declaration') {
    const source = text.replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const starts = [];
    let offset = 0;
    for (const line of lines) {
        starts.push(offset);
        offset += line.length + 1;
    }
    const stripped = strippedCode(source);

    const found = [];
    for (let i = 0; i < lines.length; i++) {
        const declaration = declarationOn(stripped, starts[i], lines[i].length, name);
        if (!declaration) continue;
        const range = declarationRange(lines, stripped, starts, i, declaration);
        if (range) found.push(range);
    }
    if (found.length === 0) return null;

    const classes = found.filter((range) => range.kind === 'class');
    const chosen = classes.length > 0 ? classes : found;
    if (chosen.length > 1) {
        throw new Error(`"${name}" is declared ${chosen.length} times; names must be unique`);
    }
    return renderDeclaration(lines, stripped, starts, chosen[0], scope);
}

/** Whether the file carries an explicit `#region <name>` directive. */
function hasRegionDirective(text, name) {
    return text.replace(/\r\n/g, '\n').split('\n').some((line) => {
        const directive = regionDirective(line);
        return directive !== null && directive.kind === 'region' && directive.name === name;
    });
}

/**
 * The default rule: code, and every other type no rule claims.
 *
 * An explicit `#region <name>` directive wins wherever the file has one, and
 * the reference's scope modifier is ignored for it — a region is already
 * exactly its body. Otherwise the name is looked for as a declaration, and the
 * modifier decides how much of it comes along. Nothing matching is an error.
 */
export function extractCodeRegion(text, region) {
    const { scope, name } = codeReference(region);
    if (name === '') throw new Error(`"#region:${region}" names nothing`);

    if (hasRegionDirective(text, region)) return extractRegion(text, region);
    if (name !== region && hasRegionDirective(text, name)) return extractRegion(text, name);

    const declaration = extractDeclaration(text, name, scope);
    if (declaration !== null) return declaration;

    throw new Error(`no "#region ${name}" found, and no method or inner class named "${name}"`);
}

/**
 * The rule for `.json`: a region is a list of keys, because JSON has no
 * comments to hang a region directive on.
 *
 * `#region:a,b.c` names one or more dotted paths from the top level,
 * comma-separated. The selected values are rendered as valid JSON — one
 * object, braces and all — in the order they were named. An array keeps only
 * the elements named, in order, so `keywords.0` is a one-element array.
 */
export function extractJsonRegion(text, region) {
    const paths = region.split(',').map((path) => path.trim()).filter((path) => path !== '');
    if (paths.length === 0) throw new Error(`"#region:${region}" names no keys`);

    let root;
    try {
        root = JSON.parse(text);
    } catch (err) {
        throw new Error(`not valid JSON: ${err.message}`);
    }
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error('the top-level JSON value is not an object');
    }

    const selected = paths.map((path) => selectKeys(root, path.split('.'), path));
    return JSON.stringify(selected.reduce(mergeSelections), null, 2);
}

/** One dotted path of `source`, wrapped in the containers that hold it. */
function selectKeys(source, segments, path) {
    if (segments.length === 0) return source;
    const [segment, ...rest] = segments;

    if (Array.isArray(source)) {
        if (!/^\d+$/.test(segment)) throw new Error(`"${path}": "${segment}" is not an array index`);
        if (Number(segment) >= source.length) throw new Error(`"${path}": no element ${segment}`);
        return [selectKeys(source[Number(segment)], rest, path)];
    }
    if (source === null || typeof source !== 'object') {
        throw new Error(`"${path}": cannot read "${segment}"`);
    }
    if (!Object.prototype.hasOwnProperty.call(source, segment)) {
        throw new Error(`"${path}": no key "${segment}"`);
    }
    return { [segment]: selectKeys(source[segment], rest, path) };
}

/** Whether `value` is a JSON object rather than an array or a scalar. */
function isJsonObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Merge two selections: sibling keys together, selected elements in order. */
function mergeSelections(left, right) {
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
    if (isJsonObject(left) && isJsonObject(right)) {
        const merged = { ...left };
        for (const [key, value] of Object.entries(right)) {
            merged[key] = key in merged ? mergeSelections(merged[key], value) : value;
        }
        return merged;
    }
    return right;
}

// ---------------------------------------------------------------------------
// The rule registry
// ---------------------------------------------------------------------------

/**
 * The default rule, for source code and for every file type no other rule
 * claims: region directives and named declarations both resolve here.
 *
 * @type {{ name: string, extensions: string[],
 *          resolve: (text: string, region: string, path: string) => string }}
 */
export const CODE_RULE = { name: 'code', extensions: [], resolve: extractCodeRegion };

/** The rule for `.json`: a region is a dotted list of keys. */
export const JSON_RULE = { name: 'json', extensions: ['json'], resolve: extractJsonRegion };

/** The built-in rules, most specific first; `code` is the fallback. */
export const REGION_RULES = [JSON_RULE, CODE_RULE];

/**
 * The rule that resolves a reference in `path`.
 *
 * The first rule claiming the file's extension wins; when none does, the
 * default code rule applies. Pass your own array of rules to add a rule for
 * another type — `updateDocument` takes one as `regionRules`.
 *
 * @param {string} path
 * @param {Array<{ name: string, extensions: string[], resolve: Function }>} [rules]
 */
export function ruleFor(path, rules = REGION_RULES) {
    const dot = path.lastIndexOf('.');
    const extension = dot <= 0 ? '' : path.slice(dot + 1).toLowerCase();
    return rules.find((rule) => rule.extensions.includes(extension)) ?? CODE_RULE;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/** True for `https:`, `mailto:`, `data:` — an ordinary link, never a marker. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// #region parseMarker
/**
 * Read one line as an injection marker, or return null.
 *
 * A marker is a line that is nothing but a link to a real path, labelled with
 * that same path — optionally naming a region in the fragment:
 *
 *     [fixtures/example-1/before.md](./fixtures/example-1/before.md)
 *     [fixtures/example-4/source.md](./fixtures/example-4/source.md#region:table)
 *
 * @returns {{ raw: string, path: string, region: string | null } | null}
 */
export function parseMarker(line) {
    const match = LINK.exec(line.trim());
    if (!match) return null;

    const [, label, destination] = match;
    if (HAS_SCHEME.test(destination)) return null;

    const hash = destination.indexOf('#');
    const path = hash === -1 ? destination : destination.slice(0, hash);
    const fragment = hash === -1 ? '' : destination.slice(hash + 1);

    const withoutDotSlash = (value) => value.replace(/^\.\//, '');
    if (withoutDotSlash(label) !== withoutDotSlash(path)) return null;

    // Normalise away a leading `./` so `path` is directly usable as a path.
    const relativePath = withoutDotSlash(path);
    if (relativePath === '') return null;

    if (fragment === '') return { raw: line.trim(), path: relativePath, region: null };

    // An unknown fragment means this is an ordinary link, not a marker.
    const region = /^region:(.+)$/.exec(fragment);
    if (!region) return null;
    return { raw: line.trim(), path: relativePath, region: region[1] };
}
// #endregion

/**
 * A line that opens a fenced block: three or more backticks, optionally
 * indented (CommonMark allows up to three spaces, but fences nested in lists
 * or block quotes use more, so any indentation is accepted).
 */
const FENCE_OPEN = /^\s*(`{3,})([^\r\n]*\r?)$/;

/**
 * A line that closes a fenced block: nothing but backticks and whitespace,
 * and no info string.
 */
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;

/**
 * The [start, end] line ranges of every fenced block in `lines`.
 *
 * An opening fence closes at the first later line that is a pure backtick run
 * at least as long as the opener (per CommonMark); a fence left open at the
 * end of the document swallows the rest of the document.
 *
 * @param {string[]} lines
 * @returns {Array<[number, number]>}
 */
export function fenceRanges(lines) {
    const ranges = [];
    let open = -1;
    let openLen = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (open === -1) {
            const openMatch = FENCE_OPEN.exec(line);
            if (openMatch) {
                open = i;
                openLen = openMatch[1].length;
            }
        } else {
            const closeMatch = FENCE_CLOSE.exec(line);
            if (closeMatch && closeMatch[1].length >= openLen) {
                ranges.push([open, i]);
                open = -1;
            }
        }
    }
    if (open !== -1) ranges.push([open, lines.length - 1]);
    return ranges;
}

/**
 * Every marker line in a document, in order, with its line `index`.
 *
 * Marker lines inside fenced blocks are not markers: inside a fence, a line
 * that looks like a marker is content (or a syntax example), and a document's
 * own examples must not inject themselves.
 *
 * @param {string[]} lines
 * @returns {Array<{ raw: string, path: string, region: string | null, index: number }>}
 */
export function findMarkers(lines) {
    const markers = [];
    const ranges = fenceRanges(lines);
    const insideFence = (index) => ranges.some(([start, end]) => index >= start && index <= end);
    for (let i = 0; i < lines.length; i++) {
        if (insideFence(i)) continue;
        const marker = parseMarker(lines[i]);
        if (marker) {
            marker.index = i;
            markers.push(marker);
        }
    }
    return markers;
}

// ---------------------------------------------------------------------------
// Reading the text a marker stands for
// ---------------------------------------------------------------------------

/** LF endings, and no trailing newline: exactly the text between the fences. */
export function normalize(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

/** A `readFile(relativePath) => string` that resolves paths against `root`. */
export function fileReader(root = process.cwd()) {
    const base = resolve(root);
    return (relativePath) => readFileSync(resolve(base, relativePath), 'utf8');
}

/**
 * The text a marker stands for: a whole file, or one region of one.
 *
 * Which rule reads the region is decided by the marker's path — a `.json`
 * reference is a list of keys, a code reference may name a method or an inner
 * class — unless a rule is passed in.
 *
 * @param {{ path: string, region: string | null }} marker
 * @param {(relativePath: string) => string} read resolves a path to its text
 * @param {{ resolve: (text: string, region: string, path: string) => string }} [rule]
 */
export function resolveMarker(marker, read, rule = ruleFor(marker.path)) {
    const text = read(marker.path);
    return marker.region === null ? normalize(text) : rule.resolve(text, marker.region, marker.path);
}

// ---------------------------------------------------------------------------
// Fence language
// ---------------------------------------------------------------------------

// Extension to the language identifier a Markdown fence carries for
// highlighting — GitHub's list, where `typescript` is not `ts` and `.mjs`
// is `javascript`.
const LANGUAGES = {
    c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    htm: 'html', html: 'html',
    ini: 'ini',
    java: 'java',
    cjs: 'javascript', js: 'javascript', mjs: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    php: 'php',
    pl: 'perl',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    bash: 'bash', sh: 'bash',
    sql: 'sql',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'tsx',
    xml: 'xml',
    yaml: 'yaml', yml: 'yaml',
};

/**
 * The language a file's extension implies for a fence's info string, or null
 * when the extension is unknown — a bare fence then stays bare.
 *
 * @param {string} path a path, with or without a leading `./`
 * @returns {string | null}
 */
export function fileLanguage(path) {
    const dot = path.lastIndexOf('.');
    if (dot <= 0) return null;
    return LANGUAGES[path.slice(dot + 1).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Updating a document
// ---------------------------------------------------------------------------

/**
 * An error the `lenient` mode tolerates: the marker's *include* is broken —
 * its file or region cannot be read, or the block it names cannot be found —
 * while the document itself is well-formed. Errors the document itself
 * carries (a duplicate marker, stray text where the block should be) are
 * plain `Error`s and stay strict in every mode.
 */
export class IncludeError extends Error {}

/**
 * Replace the body of the fenced block that follows `marker` in `lines`.
 *
 * The fence must come immediately after the marker; blank lines in between are
 * allowed, anything else is an error. The opening fence may be a run of three
 * or more backticks; the closing fence must be a pure backtick run at least as
 * long as the opener, so a file whose content contains fence lines of its own
 * can be wrapped in a longer fence.
 *
 * When `language` is given and the opening fence has no info string, the fence
 * is given one — so a bare block becomes a highlighted one. A fence that
 * already carries a language is never touched.
 *
 * `startIndex` is the marker's line index; when omitted, the marker is located
 * by exact text. The index form is what `updateDocument` uses, so a document
 * whose own content contains a marker line still works.
 *
 * @param {string[]} lines
 * @param {string} marker the exact marker line
 * @param {string} content
 * @param {number} [startIndex]
 * @param {string | null} [language]
 * @returns {{ lines: string[], changed: boolean }}
 */
export function injectInto(lines, marker, content, startIndex, language = null) {
    let markerIndex;
    if (typeof startIndex === 'number') {
        if (lines[startIndex]?.trim() !== marker) throw new Error(`marker not found: ${marker}`);
        markerIndex = startIndex;
    } else {
        markerIndex = lines.findIndex((line) => line.trim() === marker);
        if (markerIndex === -1) throw new Error(`marker not found: ${marker}`);
    }

    let open = -1;
    let openLen = 0;
    let openInfo = '';
    for (let i = markerIndex + 1; i < lines.length; i++) {
        const openMatch = FENCE_OPEN.exec(lines[i]);
        if (openMatch) {
            open = i;
            openLen = openMatch[1].length;
            openInfo = openMatch[2];
            break;
        }
        if (lines[i].trim() !== '') {
            throw new Error(`expected a fenced code block right after ${marker}`);
        }
    }
    if (open === -1) throw new IncludeError(`no code block after ${marker}`);

    let close = -1;
    for (let i = open + 1; i < lines.length; i++) {
        const closeMatch = FENCE_CLOSE.exec(lines[i]);
        if (closeMatch && closeMatch[1].length >= openLen) {
            close = i;
            break;
        }
    }
    if (close === -1) throw new IncludeError(`unclosed code block after ${marker}`);

    // A fence without a language cannot highlight: give it the file's, keeping
    // the document's own indentation and line endings intact.
    let fenceChanged = false;
    if (language && openInfo.replace(/\r$/, '').trim() === '') {
        const openLine = lines[open];
        const indent = openLine.slice(0, openLine.indexOf('`'));
        lines = [...lines];
        lines[open] = indent + '`'.repeat(openLen) + language
            + (openLine.endsWith('\r') ? '\r' : '');
        fenceChanged = true;
    }

    const current = lines.slice(open + 1, close).map((line) => line.replace(/\r$/, '')).join('\n');
    const next = [...lines.slice(0, open + 1), ...content.split('\n'), ...lines.slice(close)];

    return { lines: next, changed: current !== content || fenceChanged };
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/**
 * Translate a gitignore glob into a regex body (unanchored, no capture).
 *
 * Supports `**`, `*`, `?`, `[...]`, `[!...]` and backslash escapes; `*` and
 * `?` never cross a path separator.
 */
function globToRegex(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i++;
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else if (c === '[') {
            let j = i + 1;
            const invert = pattern[j] === '!' || pattern[j] === '^';
            if (invert) j++;
            if (pattern[j] === ']') j++;
            const close = pattern.indexOf(']', j);
            if (close === -1) {
                out += '\\[';
            } else {
                out += `[${invert ? '^' : ''}${pattern.slice(j, close)}]`;
                i = close;
            }
        } else if (c === '\\') {
            out += `\\${pattern[i + 1] ?? '\\'}`;
            i++;
        } else {
            out += c.replace(/[.+^${}()|?\\]/g, '\\$&');
        }
    }
    return out;
}

/**
 * Parse one .gitignore file into rules, in line order.
 *
 * Supported: comments (`#`), blank lines, negation (`!`), leading `/`
 * anchoring, trailing `/` (directory), `**`, `*`, `?`, character classes and
 * backslash escapes. A rule names a whole path component — so a rule for a
 * directory ignores everything beneath it. Quoted patterns and trailing-space
 * escapes are not supported.
 */
export function parseIgnoreFile(text) {
    const rules = [];
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        let line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;

        let negated = false;
        if (line.startsWith('!')) {
            negated = true;
            line = line.slice(1);
        }
        if (line === '') continue;

        let anchored = false;
        if (line.startsWith('/')) {
            anchored = true;
            line = line.slice(1);
        }
        if (line.endsWith('/')) line = line.slice(0, -1);
        if (line === '') continue;
        if (line.includes('/')) anchored = true;

        const re = new RegExp(`^(?:${globToRegex(line)})$`);
        rules.push({ negated, anchored, re });
    }
    return rules;
}

/**
 * Collect .gitignore rules from `root` upward to the filesystem root,
 * shallowest first, so that a rule in a .gitignore closer to the file wins
 * (git's behaviour). Every read goes through `read`, so this stays pure.
 *
 * @param {string} root
 * @param {(relativePath: string) => string} read
 * @returns {Array<{ dir: string, rules: Array<{ negated: boolean, anchored: boolean, re: RegExp }> }>}
 */
export function loadIgnoreRules(root, read) {
    const base = resolve(root);
    const files = [];
    let dir = base;
    for (;;) {
        const rel = relative(base, join(dir, '.gitignore')) || '.gitignore';
        let text = null;
        try {
            text = read(rel);
        } catch {
            text = null;
        }
        if (text !== null) {
            const rules = parseIgnoreFile(text);
            if (rules.length > 0) files.push({ dir, rules });
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return files.reverse();
}

/**
 * Whether `relativePath` (resolved against `root`) is ignored by the
 * collected rules. Rules are evaluated shallowest .gitignore first; the last
 * matching rule decides, and a `!` rule un-ignores.
 *
 * @param {string} root
 * @param {string} relativePath
 * @param {Array<{ dir: string, rules: Array<{ negated: boolean, anchored: boolean, re: RegExp }> }>} ruleFiles
 * @returns {boolean}
 */
export function isIgnoredPath(root, relativePath, ruleFiles) {
    if (ruleFiles.length === 0) return false;
    const abs = resolve(root, relativePath);
    let ignored = false;
    for (const { dir, rules } of ruleFiles) {
        const rel = relative(dir, abs);
        if (rel === '' || rel.startsWith('..')) continue;
        const parts = rel.split(/[/\\]/);
        for (const rule of rules) {
            if (rule.anchored) {
                let acc = '';
                for (const seg of parts) {
                    acc = acc === '' ? seg : `${acc}/${seg}`;
                    if (rule.re.test(acc)) ignored = !rule.negated;
                }
            } else if (parts.some((seg) => rule.re.test(seg))) {
                ignored = !rule.negated;
            }
        }
    }
    return ignored;
}

/**
 * Resolve the ignore function for `options`.
 *
 * Default: search upward from `root` for .gitignore files (git's behaviour),
 * reading them through `read`. `options.gitignore` may be `false` (disable),
 * `{ file }` (one explicit file, resolved against `root`), or a ready-made
 * array of `{ dir, rules }` objects. `options.isIgnored(relativePath)`
 * overrides everything.
 *
 * @returns {((relativePath: string) => boolean) | null}
 */
function makeIgnorer(options, root, read) {
    if (typeof options.isIgnored === 'function') return options.isIgnored;
    if (options.gitignore === false) return null;

    let ruleFiles;
    if (Array.isArray(options.gitignore)) {
        ruleFiles = options.gitignore;
    } else if (options.gitignore && typeof options.gitignore === 'object') {
        const file = options.gitignore.file;
        let text;
        try {
            text = read(isAbsolute(file) ? relative(root, file) : file);
        } catch (err) {
            throw new Error(`cannot read gitignore file ${file}: ${err.message}`);
        }
        const dir = isAbsolute(file) ? dirname(file) : root;
        ruleFiles = [{ dir, rules: parseIgnoreFile(text) }];
    } else {
        ruleFiles = loadIgnoreRules(root, read);
    }
    return (relativePath) => isIgnoredPath(root, relativePath, ruleFiles);
}

// ---------------------------------------------------------------------------
// Full document
// ---------------------------------------------------------------------------

/**
 * Rewrite every injected block in `text`.
 *
 * Nothing is written to disk: the caller decides what to do with the result.
 * A document with no markers yields `markers: []` — refusing that is the CLI's
 * job, not the library's.
 *
 * Markers whose target file is gitignored are skipped: their block is left
 * untouched and reported with `skipped: true`.
 *
 * An opening fence without a language tag is given the language the marker's
 * file extension implies, so the block highlights; a fence that already names
 * a language is left as written.
 *
 * What a region reference means depends on the file's type: the rule that
 * claims the file's extension reads it (see `REGION_RULES`), and
 * `options.regionRules` replaces the built-in set — pass the built-ins plus
 * your own to add a rule for another type.
 *
 * With `lenient: true`, a marker whose include is broken — its file or
 * region cannot be read, or its block cannot be found — is skipped with
 * `failure` set to the cause and the run continues, its block left as
 * written. A duplicate marker or stray text where the block should be is
 * still an error, in every mode.
 *
 * @param {string} text the document to update
 * @param {{ root?: string,
 *          readFile?: (relativePath: string) => string,
 *          gitignore?: false | true | { file: string } |
 *            Array<{ dir: string, rules: Array<{ negated: boolean, anchored: boolean, re: RegExp }> }>,
 *          isIgnored?: (relativePath: string) => boolean,
 *          regionRules?: Array<{ name: string, extensions: string[], resolve: Function }>,
 *          lenient?: boolean }} [options]
 * @returns {{ text: string, changed: boolean, markers: object[], results: object[] }}
 */
export function updateDocument(text, options = {}) {
    const root = options.root ?? process.cwd();
    const read = options.readFile ?? fileReader(root);
    const isIgnored = makeIgnorer(options, root, read);
    const lenient = options.lenient === true;
    const rules = options.regionRules ?? REGION_RULES;

    let lines = text.split('\n');
    const markers = findMarkers(lines);
    const seen = new Set();
    const results = [];

    // Backwards, so each marker's original line index stays valid after the
    // blocks behind it have been rewritten.
    for (let i = markers.length - 1; i >= 0; i--) {
        const marker = markers[i];
        if (seen.has(marker.raw)) throw new Error(`duplicate marker: ${marker.raw}`);
        seen.add(marker.raw);

        if (isIgnored && isIgnored(marker.path)) {
            results.push({ marker, content: null, changed: false, skipped: true });
            continue;
        }

        let content;
        try {
            content = resolveMarker(marker, read, ruleFor(marker.path, rules));
        } catch (err) {
            if (!lenient) throw new Error(`${marker.raw}: ${err.message}`);
            results.push({ marker, content: null, changed: false, skipped: true, failure: err.message });
            continue;
        }

        let injected;
        try {
            injected = injectInto(lines, marker.raw, content, marker.index, fileLanguage(marker.path));
        } catch (err) {
            if (!lenient || !(err instanceof IncludeError)) throw err;
            results.push({ marker, content: null, changed: false, skipped: true, failure: err.message });
            continue;
        }

        lines = injected.lines;
        results.push({ marker, content, changed: injected.changed, skipped: false });
    }

    results.reverse();

    const updated = lines.join('\n');
    return { text: updated, changed: updated !== text, markers, results };
}
