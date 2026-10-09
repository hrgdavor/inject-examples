/**
 * build-demo.mjs — the demo page generator.
 *
 * The page at `docs/index.html` is not edited by hand. It is built from
 * `docs/demo.md`, a Markdown document that is also read by people:
 *
 *   - the first column lists the document's `##` sections as numbered
 *     paragraphs, each with its prose explanation and its clickable targets;
 *   - the second column is the target file itself, from `docs/samples/`, one
 *     line per source line, with the selected range highlighted;
 *   - the third column renders the document the way GitHub renders it, code
 *     fences highlighted and all, and marks the marker line and the injected
 *     block of the selected target.
 *
 * Code is highlighted with the project's own tokenizers (`src/js/scanner/`) for
 * Java, JavaScript/TypeScript and Zig — the same lexical pass the resolver uses
 * — so a comment or string never mis-colours the code beside it.
 *
 * Both the reference text and its line range are resolved with the library the
 * tool ships (`lib/section.mjs` through `index.mjs`), so the page cannot claim
 * a range the tool would not inject. The document's own fenced blocks are kept
 * in sync by `inject-examples docs/demo.md`; the tests in `test.mjs` assert
 * that, and that this file produces exactly the committed `docs/index.html`.
 *
 * Run it with Bun (or Node — nothing here is Bun-specific):
 *
 *     bun tools/build-demo.mjs           # write docs/index.html
 *     bun tools/build-demo.mjs --check   # exit 1 when it is stale
 *
 * The module is pure apart from its `run()` entry point: `buildModel` reads
 * only through the `read` it is handed, and `renderPage` is a function of the
 * model, so the generator itself is testable in memory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fenceRanges, fileLanguage, fileReader, normalize, parseMarker, ruleFor, CODE_RULE } from '../index.mjs';
import { planSection } from '../lib/section.mjs';
import { lexerFor } from '../src/js/scanner/lexers.js';
import { JAVA_SYNTAX, JS_SYNTAX, ZIG_SYNTAX, tokenize } from '../src/js/scanner/tokenizer.js';

/** The repository root — this file lives in `tools/`. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The document the page is built from, relative to the root. */
export const DEFAULT_DOC = 'docs/demo.md';

/** The page this generator writes, relative to the root. */
export const DEFAULT_OUT = 'docs/index.html';

const HELP = `usage: bun tools/build-demo.mjs [options]

  --doc <file>    source document (default: ${DEFAULT_DOC})
  --out <file>    page to write (default: ${DEFAULT_OUT})
  --root <dir>    base directory the paths resolve against
  -c, --check     write nothing; exit 1 when the page is stale
  -h, --help      show this help`;

// ---------------------------------------------------------------------------
// Reading the source document
// ---------------------------------------------------------------------------

/** Slashes, always: a document's paths are written with `/`, even on Windows. */
const slashes = (path) => path.replace(/\\/g, '/');

/** The directory part of a `/`-separated path, or `.` when there is none. */
function posixDirname(path) {
    const cut = path.lastIndexOf('/');
    return cut === -1 ? '.' : path.slice(0, cut);
}

/** Drop blank lines from both ends of a run of document lines. */
function trimBlank(lines) {
    let from = 0;
    let to = lines.length;
    while (from < to && lines[from].trim() === '') from++;
    while (to > from && lines[to - 1].trim() === '') to--;
    return lines.slice(from, to);
}

/**
 * Split the document into a title, an intro and numbered sections.
 *
 * Markers inside fenced blocks are not markers (`fenceRanges` and
 * `parseMarker` decide that, exactly as the tool does), so a section's code
 * examples never register as targets.
 *
 * @param {string} text
 * @returns {{ title: string, intro: object[], sections: Array<{ title: string, blocks: object[] }> }}
 */
export function parseDemoDoc(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const fences = fenceRanges(lines);
    const fenced = (index) => fences.some(([from, to]) => index >= from && index <= to);

    const doc = { title: '', intro: [], sections: [] };
    let section = null;
    let pending = [];

    const blocks = () => (section ? section.blocks : doc.intro);
    const flush = () => {
        const body = trimBlank(pending).join('\n');
        pending = [];
        if (body !== '') blocks().push({ type: 'prose', text: body });
    };

    for (let i = 0; i < lines.length; i++) {
        if (fenced(i)) continue;
        const line = lines[i];

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flush();
            if (heading[1].length === 1) {
                doc.title = heading[2].trim();
            } else if (heading[1].length === 2) {
                section = { title: heading[2].trim(), blocks: [] };
                doc.sections.push(section);
            } else {
                blocks().push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
            }
            continue;
        }

        const marker = parseMarker(line);
        if (marker) {
            flush();
            blocks().push({ type: 'marker', marker, line: i + 1 });
            continue;
        }

        pending.push(line);
    }
    flush();

    return doc;
}

// ---------------------------------------------------------------------------
// Locating a reference in its file
// ---------------------------------------------------------------------------

/** 1-based line number of the character at `index`. */
function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
    return line;
}

/**
 * The offset of `needle` in `text`, preferring an occurrence that starts at the
 * beginning of a line and ends at the end of one — a resolved declaration or
 * region is a whole-line slice, so that preference keeps the first *loose* hit
 * (a fragment of a longer line) from winning over the real one.
 */
function findOccurrence(text, needle) {
    let loose = -1;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const startsLine = at === 0 || text[at - 1] === '\n';
        const after = at + needle.length;
        const endsLine = after >= text.length || text[after] === '\n';
        if (startsLine && endsLine) return at;
        if (loose === -1) loose = at;
    }
    return loose;
}

/**
 * The 1-based `[from, to]` line range `injected` occupies in `source`, or null
 * when it cannot be located (a rendered reference, such as the JSON rule's, is
 * not a byte slice of its file).
 *
 * A whole-file reference (`reference === null`) is every line.
 *
 * @param {string} source
 * @param {string} injected the text the reference resolves to
 * @param {string | null} [reference] the `#fragment` as written, or null
 * @returns {{ from: number, to: number } | null}
 */
export function locateRange(source, injected, reference = null) {
    const text = source.replace(/\r\n/g, '\n');
    if (reference === null) {
        const body = text.replace(/\n$/, '');
        return body === '' ? null : { from: 1, to: body.split('\n').length };
    }
    if (injected === '') return null;
    const at = findOccurrence(text, injected);
    if (at === -1) return null;
    return { from: lineOf(text, at), to: lineOf(text, at + injected.length - 1) };
}

// ---------------------------------------------------------------------------
// Building the model
// ---------------------------------------------------------------------------

function loadFile(files, path, read) {
    const known = files.get(path);
    if (known) return known;

    const text = normalize(read(path));
    const file = {
        path,
        slug: path.replace(/[^\w]+/g, '-').replace(/^-|-$/g, ''),
        label: path.slice(path.lastIndexOf('/') + 1),
        display: path,
        language: fileLanguage(path) ?? 'text',
        text,
        lines: text === '' ? [] : text.split('\n'),
    };
    files.set(path, file);
    return file;
}

/**
 * Resolve one marker into the model entry the page needs: the text it injects
 * and the lines of the file it injects them from.
 */
function resolveTarget(marker, file, sectionIndex, targetIndex, warn) {
    const rule = ruleFor(marker.path);
    let text;
    let range = null;

    if (marker.reference === null) {
        text = file.text;
        range = locateRange(file.text, text, null);
    } else if (rule === CODE_RULE) {
        const plan = planSection(file.text, marker.reference, lexerFor(marker.path));
        text = plan.text;
        if (plan.reference.warning) {
            warn(`${marker.path}#${marker.reference}: ${plan.reference.warning.kind} modifier; using "${plan.reference.kept}"`);
        }
        range = locateRange(file.text, text, marker.reference);
        if (range === null) {
            throw new Error(`${marker.raw}: the lines of "#${marker.reference}" cannot be located in ${marker.path}`);
        }
    } else {
        text = rule.resolve(file.text, marker.reference, marker.path);
    }

    return {
        id: `t-${sectionIndex + 1}-${targetIndex + 1}`,
        section: sectionIndex + 1,
        raw: marker.raw,
        path: marker.path,
        reference: marker.reference,
        fileLabel: file.label,
        fileDisplay: file.display,
        label: marker.reference === null ? 'whole file' : `#${marker.reference}`,
        from: range ? range.from : null,
        to: range ? range.to : null,
        text,
    };
}

/**
 * Turn the source document plus its target files into everything the page
 * renders. Reads only through `options.read`, so a test can pass a stub.
 *
 * @param {{ root?: string, docPath?: string, read?: (path: string) => string,
 *           onWarning?: (message: string) => void }} [options]
 */
export function buildModel(options = {}) {
    const root = options.root ?? REPO_ROOT;
    const docPath = slashes(options.docPath ?? DEFAULT_DOC);
    const read = options.read ?? fileReader(root);
    const warn = options.onWarning ?? (() => {});

    const docText = read(docPath);
    const doc = parseDemoDoc(docText);
    const docDir = posixDirname(docPath);
    const readTarget = (path) => read(docDir === '.' ? path : `${docDir}/${path}`);

    // A marker outside a `##` section would have no numbered paragraph to live
    // in; it is almost always a heading that was forgotten, so say so.
    const stray = doc.intro.find((block) => block.type === 'marker');
    if (stray) {
        throw new Error(`${docPath}:${stray.line}: a marker outside any "##" section has no paragraph to live in`);
    }

    const files = new Map();
    const sections = [];
    let exampleCount = 0;

    doc.sections.forEach((section, sectionIndex) => {
        const examples = [];
        for (const block of section.blocks) {
            if (block.type !== 'marker') continue;
            const file = loadFile(files, block.marker.path, readTarget);
            file.display = docDir === '.' ? file.path : `${docDir}/${file.path}`;
            const target = resolveTarget(block.marker, file, sectionIndex, examples.length, warn);
            target.line = block.line;
            examples.push(target);
        }
        exampleCount += examples.length;
        sections.push({
            title: section.title,
            html: renderBlocks(section.blocks),
            examples,
        });
    });

    // The third column renders the document itself; the marker lines carry the
    // target's id so a click can highlight the exact spot in the Markdown.
    const markerIds = new Map();
    for (const section of sections) {
        for (const example of section.examples) markerIds.set(example.line, example.id);
    }

    return {
        title: doc.title,
        docPath,
        introHtml: renderBlocks(doc.intro),
        sections,
        files: [...files.values()],
        exampleCount,
        markdownHtml: renderMarkdown(docText, { markerIds }),
    };
}

// ---------------------------------------------------------------------------
// A small Markdown subset, enough for the prose of a demo document
// ---------------------------------------------------------------------------

/** Escape the five characters that would otherwise be markup. */
export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Inline code, bold and links — everything else is escaped text. */
export function renderInline(text) {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** Paragraphs, bullet lists and sub-headings — the subset the demo document uses. */
export function renderProse(text) {
    return text
        .split(/\n{2,}/)
        .map((paragraph) => {
            const body = paragraph.trim();
            if (body === '') return '';
            const rows = body.split('\n');
            if (rows.every((row) => /^\s*[-*]\s+/.test(row))) {
                const items = rows.map((row) => `  <li>${renderInline(row.replace(/^\s*[-*]\s+/, ''))}</li>`);
                return `<ul>\n${items.join('\n')}\n</ul>`;
            }
            return `<p>${renderInline(rows.map((row) => row.trim()).join(' '))}</p>`;
        })
        .filter((html) => html !== '')
        .join('\n');
}

/** The HTML of a section's non-marker blocks, in document order. */
export function renderBlocks(blocks) {
    return blocks
        .map((block) => {
            if (block.type === 'prose') return renderProse(block.text);
            if (block.type === 'heading') return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
            return '';
        })
        .filter((html) => html !== '')
        .join('\n');
}

// ---------------------------------------------------------------------------
// The document as GitHub renders it (the third column)
// ---------------------------------------------------------------------------
//
// The same Markdown that drives the page is also shown rendered, because that
// is the use case: a reader sees the prose, the marker link and the injected
// block in place. Every block carries its source line numbers, and a marker
// carries the id of the target it belongs to, so selecting a target can light
// up the exact spot in the rendered document.

/** The fenced blocks of `lines`: opener index -> `{ close, info }`. */
function fenceInfo(lines) {
    const map = new Map();
    for (const [open, close] of fenceRanges(lines)) {
        const info = /^\s*`{3,}(.*)$/.exec(lines[open]);
        map.set(open, { close, info: info ? info[1].trim() : '' });
    }
    return map;
}

/** The marker line directly above fence `open`, as a 1-based line number. */
function precedingMarkerLine(lines, open) {
    let i = open - 1;
    while (i >= 0 && lines[i].trim() === '') i--;
    return i >= 0 && parseMarker(lines[i]) ? i + 1 : null;
}

/** One fenced block, highlighted in its language, with the target it injects for. */
function renderFence(lines, open, fence, markerIds) {
    const markerLine = precedingMarkerLine(lines, open);
    const id = markerLine !== null ? markerIds.get(markerLine) : undefined;
    const language = fence.info.split(/\s+/)[0];
    const code = lines.slice(open + 1, fence.close).join('\n');
    return `<pre class="md-pre"${id ? ` data-inject="${id}"` : ''}`
        + ` data-md-from="${open + 1}" data-md-to="${fence.close + 1}">`
        + `<code${language ? ` class="language-${escapeHtml(language)}"` : ''}>`
        + `${highlightCode(code, language)}</code></pre>`;
}

/** One marker line, rendered the way Markdown would render it — as a link. */
function renderMarker(line, id) {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(line.trim());
    const label = link ? renderInline(link[1]) : escapeHtml(line.trim());
    const href = link ? escapeHtml(link[2]) : '#';
    return `<p class="md-marker" data-marker="${id}"><a href="${href}">${label}</a>`
        + `<span class="md-badge">inject</span></p>`;
}

/**
 * Render a document with the small GitHub-shaped subset this page needs:
 * headings, paragraphs, bullet lists and fenced code, each wrapper carrying
 * `data-md-from`/`data-md-to` line anchors and each `##` opening a section.
 *
 * The document's lead — its title and intro before the first `##` — is left
 * out, exactly as the targets column leaves it out: it is already the page
 * banner, and repeating it would only push the first example down. A document
 * with no `##` at all is rendered whole, as its own single section.
 *
 * @param {string} text
 * @param {{ markerIds?: Map<number, string> }} [options] marker line -> target id
 */
export function renderMarkdown(text, options = {}) {
    const markerIds = options.markerIds ?? new Map();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const fences = fenceInfo(lines);
    const ranges = fenceRanges(lines);
    const inFence = (index) => ranges.some(([from, to]) => index >= from && index <= to);
    const html = [];
    let opened = false;
    let section = 0;

    const openSection = (index) => {
        if (opened) html.push('</section>');
        html.push(`<section class="md-section" data-md-section="${index}">`);
        opened = true;
    };
    const markerAt = (index) => {
        const marker = parseMarker(lines[index]);
        return marker && markerIds.has(index + 1) ? marker : null;
    };

    const firstSection = lines.findIndex((line, index) => !inFence(index) && /^##\s+/.test(line));
    let i = firstSection === -1 ? 0 : firstSection;
    if (firstSection === -1) openSection(0);

    while (i < lines.length) {
        const fence = fences.get(i);
        if (fence) {
            html.push(renderFence(lines, i, fence, markerIds));
            i = fence.close + 1;
            continue;
        }

        const line = lines[i];
        if (line.trim() === '') {
            i++;
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            if (level === 2) openSection(++section);
            html.push(`<h${level} data-md-from="${i + 1}" data-md-to="${i + 1}">`
                + `${renderInline(heading[2].trim())}</h${level}>`);
            i++;
            continue;
        }

        if (markerAt(i)) {
            html.push(renderMarker(line, markerIds.get(i + 1)));
            i++;
            continue;
        }

        if (/^\s*[-*]\s+/.test(line)) {
            const from = i;
            const items = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
                i++;
            }
            html.push(`<ul data-md-from="${from + 1}" data-md-to="${i}">\n${items.join('\n')}\n</ul>`);
            continue;
        }

        const from = i;
        const rows = [];
        while (i < lines.length && lines[i].trim() !== '' && !fences.has(i)
            && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])
            && !(rows.length > 0 && markerAt(i))) {
            rows.push(lines[i].trim());
            i++;
        }
        html.push(`<p data-md-from="${from + 1}" data-md-to="${i}">${renderInline(rows.join(' '))}</p>`);
    }

    if (opened) html.push('</section>');
    return html.join('\n');
}

// ---------------------------------------------------------------------------
// Code rendering
// ---------------------------------------------------------------------------

const JAVA_KEYWORDS = new Set([
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
    'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
    'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
    'new', 'package', 'private', 'protected', 'public', 'record', 'return', 'sealed', 'short',
    'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
    'try', 'var', 'void', 'volatile', 'while', 'true', 'false', 'null', 'yield', 'permits',
]);

const JS_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
    'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return',
    'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
    'var', 'void', 'while', 'with', 'yield',
]);

const TS_KEYWORDS = new Set([
    ...JS_KEYWORDS,
    'abstract', 'any', 'asserts', 'declare', 'enum', 'implements', 'interface', 'is', 'keyof',
    'namespace', 'never', 'private', 'protected', 'public', 'readonly', 'satisfies', 'type', 'unique',
    'unknown',
]);

const ZIG_KEYWORDS = new Set([
    'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'async', 'await', 'break', 'catch',
    'comptime', 'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error', 'export', 'extern',
    'fn', 'for', 'if', 'inline', 'linksection', 'noalias', 'nosuspend', 'opaque', 'or', 'orelse',
    'packed', 'pub', 'resume', 'return', 'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try',
    'union', 'unreachable', 'usingnamespace', 'var', 'volatile', 'while',
]);

/** The languages a fenced block can be highlighted in, by fence info string. */
const HIGHLIGHTERS = {
    java: { syntax: JAVA_SYNTAX, keywords: JAVA_KEYWORDS },
    javascript: { syntax: JS_SYNTAX, keywords: JS_KEYWORDS },
    typescript: { syntax: JS_SYNTAX, keywords: TS_KEYWORDS },
    zig: { syntax: ZIG_SYNTAX, keywords: ZIG_KEYWORDS },
};

/** Fence info-string aliases, as the extensions of `lexers.js` spell them. */
const LANGUAGE_ALIASES = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
};

/** The highlighter a fence language names, or null when it has none. */
export function highlighterFor(language) {
    if (!language) return null;
    const name = String(language).toLowerCase();
    return HIGHLIGHTERS[LANGUAGE_ALIASES[name] ?? name] ?? null;
}

const CODE_TOKEN = /@[A-Za-z_$][\w$]*|\d[\w.]*|[A-Za-z_$][\w$]*/g;

/** Highlight the identifiers of one run of plain (non-comment, non-string) text. */
function renderPlain(text, keywords) {
    let html = '';
    let last = 0;
    for (const match of text.matchAll(CODE_TOKEN)) {
        const token = match[0];
        html += escapeHtml(text.slice(last, match.index));
        let cls = null;
        if (token.startsWith('@')) cls = 'tok-a';
        else if (keywords && keywords.has(token)) cls = 'tok-k';
        else if (/^\d/.test(token)) cls = 'tok-n';
        else if (/^[A-Z]/.test(token)) cls = 'tok-t';
        html += cls === null ? escapeHtml(token) : `<span class="${cls}">${escapeHtml(token)}</span>`;
        last = match.index + token.length;
    }
    return html + escapeHtml(text.slice(last));
}

/**
 * A class per character: 0 plain, 1 comment, 2 string. The spans come from the
 * project's own tokenizer, so the highlighting agrees with the lexer the
 * resolver uses for that file type.
 */
export function codeKinds(text, language) {
    const kinds = new Array(text.length).fill(0);
    const highlighter = highlighterFor(language);
    if (!highlighter) return kinds;
    const { comments, strings } = tokenize(text, highlighter.syntax);
    for (const span of strings) {
        for (let i = span.from; i < span.to && i < kinds.length; i++) kinds[i] = 2;
    }
    for (const span of comments) {
        for (let i = span.from; i < span.to && i < kinds.length; i++) kinds[i] = 1;
    }
    return kinds;
}

/** One source line, split by its character kinds and highlighted. */
function renderLine(line, kinds, offset, keywords) {
    let html = '';
    let i = 0;
    while (i < line.length) {
        const kind = kinds[offset + i];
        let j = i;
        while (j < line.length && kinds[offset + j] === kind) j++;
        const chunk = line.slice(i, j);
        if (kind === 1) html += `<span class="tok-c">${escapeHtml(chunk)}</span>`;
        else if (kind === 2) html += `<span class="tok-s">${escapeHtml(chunk)}</span>`;
        else html += renderPlain(chunk, keywords);
        i = j;
    }
    return html;
}

/**
 * A code block as highlighted HTML, newlines kept (so it can sit in a `<pre>`).
 * An unknown language is escaped and left plain.
 */
export function highlightCode(text, language) {
    const keywords = highlighterFor(language)?.keywords ?? null;
    const kinds = codeKinds(text, language);
    let offset = 0;
    return text
        .split('\n')
        .map((line) => {
            const html = renderLine(line, kinds, offset, keywords);
            offset += line.length + 1;
            return html;
        })
        .join('\n');
}

/** The whole file as `<span class="line">` rows, numbered from 1. */
export function renderSourceLines(file) {
    const keywords = highlighterFor(file.language)?.keywords ?? null;
    const kinds = codeKinds(file.text, file.language);
    let offset = 0;
    return file.lines
        .map((line, index) => {
            const html = renderLine(line, kinds, offset, keywords);
            offset += line.length + 1;
            return `<span class="line" id="${escapeHtml(file.slug)}-L${index + 1}" data-line="${index + 1}">`
                + `<span class="ln">${index + 1}</span><span class="lc">${html}</span></span>`;
        })
        .join('');
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --head: #ffffff; --fg: #1f2328; --muted: #6b7280;
  --line: #e2e5e9; --chip: #f1f3f5; --accent: #1f6feb; --accent-soft: #e7f0ff; --accent-fg: #0b4fbd;
  --hl: #fff3bf; --hl-edge: #e6c34a;
  --code-fg: #24292f; --code-c: #6a737d; --code-s: #0a7d3c; --code-k: #cf222e;
  --code-a: #8250df; --code-n: #0550ae; --code-t: #953800;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --panel: #161b22; --head: #161b22; --fg: #e6edf3; --muted: #9198a1;
    --line: #30363d; --chip: #21262d; --accent: #4c8dff; --accent-soft: #16283f; --accent-fg: #a8c7ff;
    --hl: #3a3316; --hl-edge: #8a7420;
    --code-fg: #e6edf3; --code-c: #8b949e; --code-s: #7ee787; --code-k: #ff7b72;
    --code-a: #d2a8ff; --code-n: #79c0ff; --code-t: #ffa657;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.page { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }

/* A short, full-width banner: title and note on one row, the intro under it. */
.page-head { background: var(--head); border-bottom: 1px solid var(--line); padding: .45rem .9rem .5rem; }
.head-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.page-head h1 { margin: 0; font-size: 1.12rem; }
.page-head p { margin: .15rem 0 0; max-width: none; }
.page-head .intro p { margin: .2rem 0 0; }
.page-head .note { margin: 0; color: var(--muted); font-size: .78rem; }

/* Three columns: targets, source, and the document as it renders. */
.split {
  display: grid; min-height: 0;
  grid-template-columns: minmax(270px, 23%) minmax(0, 38.5%) minmax(0, 38.5%);
}
.pane { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
.pane-left { grid-template-rows: auto minmax(0, 1fr); border-right: 1px solid var(--line); }
.pane-mid { grid-template-rows: auto auto minmax(0, 1fr); border-right: 1px solid var(--line); background: var(--panel); }
.pane-right { grid-template-rows: auto minmax(0, 1fr); background: #ffffff; }
.col-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: .6rem;
  padding: .42rem .85rem; border-bottom: 1px solid var(--line); background: var(--head);
  font: 600 .72rem/1.4 ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
}
.col-note { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: .74rem; opacity: .85; }

.examples { list-style: none; margin: 0; padding: .3rem 1rem 5rem; overflow: auto; min-height: 0; }
.example { padding: .9rem 0 1.1rem; border-bottom: 1px solid var(--line); }
.example:last-child { border-bottom: 0; }
.example h2 { display: flex; gap: .55rem; align-items: baseline; margin: 0 0 .4rem; font-size: 1rem; }
.example h2 .num {
  flex: none; min-width: 1.55rem; height: 1.55rem; border-radius: 50%; background: var(--chip);
  color: var(--muted); font: 600 .78rem/1.55rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: center;
}
.example p { margin: .35rem 0; }
.example ul { margin: .35rem 0; padding-left: 1.2rem; }
.example code { background: var(--chip); border-radius: 4px; padding: .05rem .3rem; font-size: .87em; }
.targets { list-style: none; margin: .6rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .45rem; }
.target {
  display: inline-flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; max-width: 100%;
  border: 1px solid var(--line); background: var(--panel); color: inherit; border-radius: 999px;
  padding: .28rem .75rem; cursor: pointer; text-align: left;
  font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.target:hover { border-color: var(--accent); }
.target:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chip-file { color: var(--muted); white-space: nowrap; }
.chip-ref { font-weight: 600; white-space: nowrap; }
.target-item.selected .target { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-fg); }
.target-item.selected .chip-file { color: inherit; opacity: .75; }
.snippet {
  display: none; margin: .5rem 0 0; padding: .55rem .7rem; border: 1px solid var(--line);
  border-radius: 8px; background: var(--panel); max-height: 18rem; overflow: auto; font-size: 12.5px;
}
.target-item.selected .snippet { display: block; }
.snippet .marker { display: block; color: var(--muted); margin-bottom: .4rem; white-space: pre-wrap; word-break: break-all; }
.snippet code { font: inherit; white-space: pre; }

.file-tabs { display: flex; gap: .3rem; padding: .4rem .7rem; border-bottom: 1px solid var(--line); overflow-x: auto; }
.file-tab {
  border: 1px solid transparent; background: none; color: var(--muted); border-radius: 6px; white-space: nowrap;
  padding: .25rem .6rem; cursor: pointer; font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.file-tab.active { color: var(--fg); background: var(--chip); border-color: var(--line); }
.file-view { overflow: auto; min-height: 0; }
.file { display: none; }
.file.active { display: block; }
.code {
  margin: 0; padding: .6rem 0 3rem; color: var(--code-fg);
  font: 12.75px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.line { display: block; border-left: 3px solid transparent; padding-right: .9rem; }
.line .ln { display: inline-block; width: 3.6rem; padding-right: .8rem; text-align: right; color: var(--muted); user-select: none; }
.line .lc { white-space: pre; }
.line.hl { background: var(--hl); border-left-color: var(--hl-edge); }
.line.hl .ln { color: var(--fg); font-weight: 600; }
.tok-c { color: var(--code-c); font-style: italic; }
.tok-s { color: var(--code-s); }
.tok-k { color: var(--code-k); }
.tok-a { color: var(--code-a); }
.tok-n { color: var(--code-n); }
.tok-t { color: var(--code-t); }

/* The third column is deliberately GitHub's light rendering, page theme or not. */
.md-scroll { overflow: auto; min-height: 0; background: #ffffff; }
.md {
  background: #ffffff; color: #1f2328; padding: .9rem 1.1rem 4rem;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
.md h1, .md h2 { border-bottom: 1px solid #d1d9e0; padding-bottom: .25em; }
.md h1 { font-size: 1.5em; margin: .4em 0 .5em; }
.md h2 { font-size: 1.2em; margin: 1.1em 0 .4em; }
.md h3 { font-size: 1.05em; margin: 1em 0 .35em; }
.md p { margin: 0 0 .8em; }
.md ul { margin: 0 0 .8em; padding-left: 1.5em; }
.md a { color: #0969da; text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md code {
  background: rgba(175, 184, 193, .2); border-radius: 6px; padding: .15em .35em;
  font: .86em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.md .md-pre { background: #f6f8fa; border-radius: 6px; padding: .75rem .9rem; margin: 0 0 .9em; overflow: auto; }
.md .md-pre code { background: none; padding: 0; font-size: .84em; line-height: 1.45; }
/* GitHub light's own token colours: the column stays light in either theme. */
.md .tok-c { color: #6e7781; font-style: italic; }
.md .tok-s { color: #0a3069; }
.md .tok-k { color: #cf222e; }
.md .tok-a { color: #8250df; }
.md .tok-n { color: #0550ae; }
.md .tok-t { color: #953800; }
.md .md-marker { display: flex; align-items: center; gap: .5rem; margin: 0 0 .5rem; }
.md .md-badge {
  font: 600 10px/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .05em;
  color: #1a7f37; background: #dafbe1; border: 1px solid #aceebb; border-radius: 999px; padding: .25em .5em;
}
.md-section { border-left: 3px solid transparent; padding-left: .75rem; margin-left: -.75rem; border-radius: 4px; }
.md-section-active { border-left-color: #0969da; background: #f6f8fa; }
.md .md-hit { background: #fff8c5; box-shadow: inset 0 0 0 1px rgba(212, 167, 44, .45); border-radius: 6px; }
.md .md-pre.md-hit { background: #fff8c5; }
.md .md-marker.md-hit { padding: .2rem .45rem; margin-left: -.45rem; }

@media (max-width: 1150px) {
  .page { height: auto; min-height: 100vh; grid-template-rows: auto auto; }
  .split { grid-template-columns: minmax(0, 1fr); }
  .pane { height: 70vh; }
  .pane-left, .pane-mid { border-right: 0; border-bottom: 1px solid var(--line); }
}
`.trim();

const SCRIPT = `
(function () {
  var targets = Array.prototype.slice.call(document.querySelectorAll('.target'));
  var items = Array.prototype.slice.call(document.querySelectorAll('.target-item'));
  var lines = Array.prototype.slice.call(document.querySelectorAll('.line'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.file-tab'));
  var files = Array.prototype.slice.call(document.querySelectorAll('.file'));
  var mdSections = Array.prototype.slice.call(document.querySelectorAll('[data-md-section]'));
  var mdHits = Array.prototype.slice.call(document.querySelectorAll('.md-marker, .md-pre'));

  function showFile(name) {
    files.forEach(function (file) { file.classList.toggle('active', file.dataset.file === name); });
    tabs.forEach(function (tab) { tab.classList.toggle('active', tab.dataset.file === name); });
  }

  function select(target, keepScroll, keepHash) {
    var item = target.closest('.target-item');
    items.forEach(function (other) { other.classList.toggle('selected', other === item); });
    targets.forEach(function (other) { other.setAttribute('aria-pressed', String(other === target)); });

    lines.forEach(function (line) { line.classList.remove('hl'); });
    showFile(target.dataset.file);

    var from = Number(target.dataset.from);
    var to = Number(target.dataset.to);
    var shown = document.querySelector('.file.active');
    var first = null;
    if (shown) {
      Array.prototype.forEach.call(shown.querySelectorAll('.line'), function (line) {
        var n = Number(line.dataset.line);
        if (n >= from && n <= to) {
          line.classList.add('hl');
          if (first === null) first = line;
        }
      });
    }

    // The same target, in the rendered Markdown: its section, its marker line
    // and the block that injection filled.
    mdSections.forEach(function (section) {
      section.classList.toggle('md-section-active', section.dataset.mdSection === target.dataset.section);
    });
    mdHits.forEach(function (hit) { hit.classList.remove('md-hit'); });
    var marker = document.querySelector('[data-marker="' + item.id + '"]');
    var inject = document.querySelector('[data-inject="' + item.id + '"]');
    if (marker) marker.classList.add('md-hit');
    if (inject) inject.classList.add('md-hit');

    if (!keepScroll) {
      if (first) first.scrollIntoView({ block: 'nearest' });
      if (marker) marker.scrollIntoView({ block: 'center' });
    }
    if (!keepHash) history.replaceState(null, '', '#' + item.id);
  }

  targets.forEach(function (target) {
    target.addEventListener('click', function () { select(target, false, false); });
  });

  var wanted = location.hash.slice(1);
  var initial = targets.filter(function (target) {
    return target.closest('.target-item').id === wanted;
  })[0];
  if (initial) select(initial, false, true);
})();
`.trim();

/** The left pane: numbered sections, prose, and the clickable targets. */
function renderSection(section, index) {
    const targets = section.examples
        .map((example) => [
            `<li class="target-item" id="${example.id}">`,
            `<button class="target" type="button" data-file="${escapeHtml(example.path)}"`,
            ` data-section="${example.section}"`,
            ` data-from="${example.from ?? 0}" data-to="${example.to ?? 0}"`,
            ` aria-pressed="false" aria-controls="${example.id}-snippet">`,
            `<span class="chip-file">${escapeHtml(example.fileLabel)}</span>`,
            `<span class="chip-ref">${escapeHtml(example.label)}</span>`,
            `</button>`,
            `<pre class="snippet" id="${example.id}-snippet"><span class="marker">${escapeHtml(example.raw)}</span>`,
            `<code>${escapeHtml(example.text)}</code></pre>`,
            `</li>`,
        ].join(''))
        .join('\n');

    return [
        `<li class="example" id="ex-${index + 1}">`,
        `<h2><span class="num">${index + 1}</span>${escapeHtml(section.title)}</h2>`,
        section.html,
        `<ul class="targets">`,
        targets,
        `</ul>`,
        `</li>`,
    ].join('\n');
}

/** The right pane: one tab and one code pane per target file. */
function renderFiles(files) {
    const tabs = files
        .map((file, index) => `<button class="file-tab${index === 0 ? ' active' : ''}" type="button"`
            + ` data-file="${escapeHtml(file.path)}">${escapeHtml(file.display)}</button>`)
        .join('\n');
    const panes = files
        .map((file, index) => `<div class="file${index === 0 ? ' active' : ''}" data-file="${escapeHtml(file.path)}"`
            + ` aria-label="${escapeHtml(file.display)}">`
            + `<pre class="code">${renderSourceLines(file)}</pre></div>`)
        .join('\n');
    return { tabs, panes };
}

/**
 * The whole page, as one self-contained HTML document — no network, no build
 * step, no runtime dependency. Open it from the filesystem and it works.
 */
export function renderPage(model) {
    const { tabs, panes } = renderFiles(model.files);
    const sections = model.sections.map(renderSection).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<div class="page">
<header class="page-head">
<div class="head-row">
<h1>${escapeHtml(model.title)}</h1>
<p class="note">Generated from <code>${escapeHtml(model.docPath)}</code> by <code>tools/build-demo.mjs</code> — edit the Markdown, not this file.</p>
</div>
<div class="intro">
${model.introHtml}
</div>
</header>
<main class="split">
<section class="pane pane-left" aria-label="Targets">
<div class="col-head">Targets<span class="col-note">click one to highlight it</span></div>
<ol class="examples">
${sections}
</ol>
</section>
<section class="pane pane-mid" aria-label="Source file">
<div class="col-head">Source file<span class="col-note">lines the target selects</span></div>
<div class="file-tabs" role="tablist">
${tabs}
</div>
<div class="file-view">
${panes}
</div>
</section>
<section class="pane pane-right" aria-label="Rendered Markdown">
<div class="col-head">Markdown<span class="col-note">as it reads, injections in place</span></div>
<div class="md-scroll">
<article class="md">
${model.markdownHtml}
</article>
</div>
</section>
</main>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}

/** Build the page from a document and its target files. */
export function buildDemo(options = {}) {
    const model = buildModel(options);
    return { html: renderPage(model), model };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/**
 * Parse `argv` and build, check or write the page. Returns the process exit
 * code and never calls `process.exit`, so tests can drive it.
 */
export function run(argv = [], io = {}) {
    const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
    const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
    const options = { root: REPO_ROOT, docPath: DEFAULT_DOC, outPath: DEFAULT_OUT, check: false };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-c' || arg === '--check') options.check = true;
        else if (arg === '--root') options.root = resolve(argv[++i] ?? '.');
        else if (arg === '--doc') options.docPath = argv[++i];
        else if (arg === '-o' || arg === '--out') options.outPath = argv[++i];
        else if (arg === '-h' || arg === '--help') { out(HELP); return 0; }
        else { err(`build-demo: unknown argument: ${arg}`); return 2; }
    }
    if (!options.docPath || !options.outPath) {
        err('build-demo: --doc and --out need a value');
        return 2;
    }

    let built;
    try {
        built = buildDemo({ root: options.root, docPath: options.docPath, onWarning: (m) => err(`build-demo: warn: ${m}`) });
    } catch (cause) {
        err(`build-demo: ${cause.message}`);
        return 1;
    }

    const page = resolve(options.root, options.outPath);
    const current = existsSync(page) ? readFileSync(page, 'utf8') : null;

    if (options.check) {
        if (current === built.html) {
            out(`ok      ${options.outPath}`);
            return 0;
        }
        out(`${current === null ? 'missing' : 'stale'} ${options.outPath}`);
        out('Run: bun tools/build-demo.mjs');
        return 1;
    }

    if (current === built.html) {
        out(`ok      ${options.outPath} (unchanged)`);
        return 0;
    }
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, built.html);
    out(`wrote   ${options.outPath} (${built.model.exampleCount} target(s) in ${built.model.files.length} file(s))`);
    return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked || import.meta.main === true) {
    process.exitCode = run(process.argv.slice(2));
}
