/**
 * inject-examples — library.
 *
 * Keeps a Markdown document honest: a *marker* line that is nothing but a link
 * to a real file is followed by a fenced code block, and that block is replaced
 * verbatim with the file's text (or with one region of it). Because the text is
 * copied rather than typed, the document cannot drift from the file it shows.
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
// Markers
// ---------------------------------------------------------------------------

const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/** True for `https:`, `mailto:`, `data:` — an ordinary link, never a marker. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

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
 * @param {{ path: string, region: string | null }} marker
 * @param {(relativePath: string) => string} read resolves a path to its text
 */
export function resolveMarker(marker, read) {
    const text = read(marker.path);
    return marker.region ? extractRegion(text, marker.region) : normalize(text);
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
 * `startIndex` is the marker's line index; when omitted, the marker is located
 * by exact text. The index form is what `updateDocument` uses, so a document
 * whose own content contains a marker line still works.
 *
 * @param {string[]} lines
 * @param {string} marker the exact marker line
 * @param {string} content
 * @param {number} [startIndex]
 * @returns {{ lines: string[], changed: boolean }}
 */
export function injectInto(lines, marker, content, startIndex) {
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
    for (let i = markerIndex + 1; i < lines.length; i++) {
        const openMatch = FENCE_OPEN.exec(lines[i]);
        if (openMatch) {
            open = i;
            openLen = openMatch[1].length;
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

    const current = lines.slice(open + 1, close).map((line) => line.replace(/\r$/, '')).join('\n');
    const next = [...lines.slice(0, open + 1), ...content.split('\n'), ...lines.slice(close)];

    return { lines: next, changed: current !== content };
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
 *          lenient?: boolean }} [options]
 * @returns {{ text: string, changed: boolean, markers: object[], results: object[] }}
 */
export function updateDocument(text, options = {}) {
    const root = options.root ?? process.cwd();
    const read = options.readFile ?? fileReader(root);
    const isIgnored = makeIgnorer(options, root, read);
    const lenient = options.lenient === true;

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
            content = resolveMarker(marker, read);
        } catch (err) {
            if (!lenient) throw new Error(`${marker.raw}: ${err.message}`);
            results.push({ marker, content: null, changed: false, skipped: true, failure: err.message });
            continue;
        }

        let injected;
        try {
            injected = injectInto(lines, marker.raw, content, marker.index);
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
