/**
 * build-demo.mjs — the demo page generator.
 *
 * The page at `docs/index.html` is not edited by hand. It is built from
 * `docs/demo.md`, a Markdown document that is also read by people:
 *
 *   - every `##` section is one numbered paragraph in the left pane, with its
 *     prose explanation rendered above the targets it shows;
 *   - every inject-examples marker in a section is one clickable target: the
 *     chip shows the syntax as written, and clicking it highlights the lines
 *     that reference selects in the file on the right;
 *   - the right pane is the target file itself, from `docs/samples/`, with a
 *     plain Java highlighter (the project's own tokenizer supplies the comment
 *     and string spans) and a line per source line.
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
import { JAVA_SYNTAX, tokenize } from '../src/js/scanner/tokenizer.js';

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
        raw: marker.raw,
        path: marker.path,
        reference: marker.reference,
        fileLabel: file.label,
        fileDisplay: file.display,
        label: marker.reference === null ? 'whole file' : `#${marker.reference}`,
        from: range ? range.from : null,
        to: range ? range.to : null,
        span: range === null ? 'rendered' : (range.from === range.to ? `L${range.from}` : `L${range.from}–${range.to}`),
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

    const doc = parseDemoDoc(read(docPath));
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
            examples.push(resolveTarget(block.marker, file, sectionIndex, examples.length, warn));
        }
        exampleCount += examples.length;
        sections.push({
            title: section.title,
            html: renderBlocks(section.blocks),
            examples,
        });
    });

    return {
        title: doc.title,
        docPath,
        introHtml: renderBlocks(doc.intro),
        sections,
        files: [...files.values()],
        exampleCount,
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

const JAVA_TOKEN = /@[A-Za-z_$][\w$]*|\d[\w.]*|[A-Za-z_$][\w$]*/g;

/** Highlight the identifiers of one run of plain (non-comment, non-string) text. */
function renderPlain(text) {
    let html = '';
    let last = 0;
    for (const match of text.matchAll(JAVA_TOKEN)) {
        const token = match[0];
        html += escapeHtml(text.slice(last, match.index));
        let cls = null;
        if (token.startsWith('@')) cls = 'tok-a';
        else if (JAVA_KEYWORDS.has(token)) cls = 'tok-k';
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
 * resolver uses.
 */
export function javaKinds(text) {
    const kinds = new Array(text.length).fill(0);
    const { comments, strings } = tokenize(text, JAVA_SYNTAX);
    for (const span of strings) {
        for (let i = span.from; i < span.to && i < kinds.length; i++) kinds[i] = 2;
    }
    for (const span of comments) {
        for (let i = span.from; i < span.to && i < kinds.length; i++) kinds[i] = 1;
    }
    return kinds;
}

/** One source line, split by its character kinds and highlighted. */
function renderLine(line, kinds, offset) {
    let html = '';
    let i = 0;
    while (i < line.length) {
        const kind = kinds[offset + i];
        let j = i;
        while (j < line.length && kinds[offset + j] === kind) j++;
        const chunk = line.slice(i, j);
        if (kind === 1) html += `<span class="tok-c">${escapeHtml(chunk)}</span>`;
        else if (kind === 2) html += `<span class="tok-s">${escapeHtml(chunk)}</span>`;
        else html += renderPlain(chunk);
        i = j;
    }
    return html;
}

/** The whole file as `<span class="line">` rows, numbered from 1. */
export function renderSourceLines(file) {
    const kinds = file.language === 'java' ? javaKinds(file.text) : new Array(file.text.length).fill(0);
    let offset = 0;
    return file.lines
        .map((line, index) => {
            const html = renderLine(line, kinds, offset);
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
.page-head { background: var(--head); border-bottom: 1px solid var(--line); padding: .8rem 1.1rem .7rem; }
.page-head h1 { margin: 0 0 .35rem; font-size: 1.25rem; }
.page-head p { margin: .3rem 0; max-width: 90ch; }
.page-head .note { color: var(--muted); font-size: .8rem; }
.split { display: grid; grid-template-columns: minmax(300px, 42%) minmax(0, 1fr); min-height: 0; }
.pane { min-height: 0; overflow: auto; }
.pane-left { border-right: 1px solid var(--line); padding: .2rem 1.1rem 5rem; }
.pane-right { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--panel); }
.examples { list-style: none; margin: 0; padding: 0; }
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
  display: inline-flex; gap: .5rem; align-items: baseline; max-width: 100%;
  border: 1px solid var(--line); background: var(--panel); color: inherit; border-radius: 999px;
  padding: .28rem .75rem; cursor: pointer; text-align: left;
  font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.target:hover { border-color: var(--accent); }
.target:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chip-file { color: var(--muted); }
.chip-ref { font-weight: 600; }
.chip-lines { color: var(--muted); font-size: .92em; }
.target-item.selected .target { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-fg); }
.target-item.selected .chip-file, .target-item.selected .chip-lines { color: inherit; opacity: .75; }
.snippet {
  display: none; margin: .5rem 0 0; padding: .55rem .7rem; border: 1px solid var(--line);
  border-radius: 8px; background: var(--panel); max-height: 18rem; overflow: auto; font-size: 12.5px;
}
.target-item.selected .snippet { display: block; }
.snippet .marker { display: block; color: var(--muted); margin-bottom: .4rem; white-space: pre-wrap; word-break: break-all; }
.snippet code { font: inherit; white-space: pre; }
.file-tabs { display: flex; gap: .3rem; padding: .5rem .8rem; border-bottom: 1px solid var(--line); }
.file-tab {
  border: 1px solid transparent; background: none; color: var(--muted); border-radius: 6px;
  padding: .25rem .6rem; cursor: pointer; font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.file-tab.active { color: var(--fg); background: var(--chip); border-color: var(--line); }
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
@media (max-width: 820px) {
  .split { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1.3fr); }
  .pane-left { border-right: 0; border-bottom: 1px solid var(--line); }
}
`.trim();

const SCRIPT = `
(function () {
  var targets = Array.prototype.slice.call(document.querySelectorAll('.target'));
  var items = Array.prototype.slice.call(document.querySelectorAll('.target-item'));
  var lines = Array.prototype.slice.call(document.querySelectorAll('.line'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.file-tab'));
  var files = Array.prototype.slice.call(document.querySelectorAll('.file'));

  function showFile(name) {
    files.forEach(function (file) { file.classList.toggle('active', file.dataset.file === name); });
    tabs.forEach(function (tab) { tab.classList.toggle('active', tab.dataset.file === name); });
  }

  function select(target, keepScroll, keepHash) {
    items.forEach(function (item) { item.classList.toggle('selected', item.contains(target)); });
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
    if (first && !keepScroll) first.scrollIntoView({ block: 'nearest' });
    if (!keepHash) history.replaceState(null, '', '#' + target.closest('.target-item').id);
  }

  targets.forEach(function (target) {
    target.addEventListener('click', function () { select(target, false, false); });
  });

  var wanted = location.hash.slice(1);
  var initial = targets.filter(function (target) {
    return target.closest('.target-item').id === wanted;
  })[0];
  if (initial) select(initial, true, true);
})();
`.trim();

/** The left pane: numbered sections, prose, and the clickable targets. */
function renderSection(section, index) {
    const targets = section.examples
        .map((example) => [
            `<li class="target-item" id="${example.id}">`,
            `<button class="target" type="button" data-file="${escapeHtml(example.path)}"`,
            ` data-from="${example.from ?? 0}" data-to="${example.to ?? 0}"`,
            ` aria-pressed="false" aria-controls="${example.id}-snippet">`,
            `<span class="chip-file">${escapeHtml(example.fileLabel)}</span>`,
            `<span class="chip-ref">${escapeHtml(example.label)}</span>`,
            `<span class="chip-lines">${escapeHtml(example.span)}</span>`,
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
<h1>${escapeHtml(model.title)}</h1>
${model.introHtml}
<p class="note">Generated from <code>${escapeHtml(model.docPath)}</code> by <code>tools/build-demo.mjs</code> — edit the Markdown, not this file.</p>
</header>
<main class="split">
<section class="pane pane-left" aria-label="Examples">
<ol class="examples">
${sections}
</ol>
</section>
<section class="pane pane-right" aria-label="Source files">
<div class="file-tabs" role="tablist">
${tabs}
</div>
${panes}
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
