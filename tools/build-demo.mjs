/**
 * build-demo.mjs — the demo page generator.
 *
 * The pages under `docs/` are not edited by hand. They are built from
 * `docs/demo.md`, a Markdown document that is also read by people:
 *
 *   - the first column is two stacked sections: the numbered `##` sections with
 *     the clickable target of every example and nothing else, and below them the
 *     description the selected example is explained by;
 *   - the second column is the target file itself, from `docs/samples/`, one
 *     line per source line, with the selected range highlighted;
 *   - the third column renders the document the way GitHub renders it, code
 *     fences highlighted and all, and marks the marker line and the injected
 *     block of the selected target.
 *
 * One document, one page per language. The document is written for a reader;
 * `PAGES` decides where each of its `##` sections is published, and a hamburger
 * menu on every page links them all. `docs/inject/index.html` is the overview — the
 * examples that are about the tool itself, whatever language the sample happens
 * to be written in, closing with an index that links every language page — and
 * `docs/inject/languages/<slug>.html` holds the examples of one language or format, so
 * a reader can stay in the language they came for.
 *
 * Code is highlighted with the project's own tokenizers (`src/js/scanner/`) for
 * Java, JavaScript/TypeScript and Zig — the same lexical pass the resolver uses
 * — so a comment or string never mis-colours the code beside it.
 *
 * Both the reference text and its line range are resolved with the library the
 * tool ships (`lib/section.mjs` through `index.mjs`), so a page cannot claim
 * a range the tool would not inject. The document's own fenced blocks are kept
 * in sync by `inject-examples docs/demo.md`; the tests in `test.mjs` assert
 * that, and that this file produces exactly the committed pages.
 *
 * Run it with Bun (or Node — nothing here is Bun-specific):
 *
 *     bun tools/build-demo.mjs           # write every page
 *     bun tools/build-demo.mjs --check   # exit 1 when one is stale
 *
 * The module is pure apart from its `run()` entry point: `buildModel` reads
 * only through the `read` it is handed, and `renderPage` is a function of the
 * model, so the generator itself is testable in memory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fenceRanges, fileLanguage, fileReader, normalize, parseMarker, ruleFor, CODE_RULE, CSS_RULE } from '../index.mjs';
import { planSection } from '../lib/section.mjs';
import { lexerFor } from '../src/js/scanner/lexers.js';
import { tokenize } from '../src/js/scanner/tokenizer.js';
import { SYNTAXES } from '../src/js/scanner/syntaxes.js';

/** The repository root — this file lives in `tools/`. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The document the pages are built from, relative to the root. */
export const DEFAULT_DOC = 'docs/demo.md';

/** The overview page this generator writes, relative to the root. */
export const DEFAULT_OUT = 'docs/inject/index.html';

/** Where the per-language pages are written, relative to the overview page. */
export const LANGUAGES_DIR = 'languages';

/**
 * Every page, in the order the document lists them. Each one owns a run of `##`
 * sections, named by `sections` — and that list is the page's, not the
 * document's: a section may sit anywhere in the file and still be published on
 * the page it belongs to. A section no page claims stays on the overview.
 *
 * `group` is the menu's heading and `order` is the menu's order (the pages are
 * listed in document order instead, so their line ranges tile the document);
 * `label` is what the menu calls the page, and `title` is its banner title.
 * `slug` names the file and `sample` is the sample file the page is about.
 */
export const PAGES = [
    { slug: 'overview', label: 'Overview', title: 'Overview', sample: null, group: 'This page', order: 0,
        sections: ['A named region', 'A declaration, and how much of it comes along', 'A nested declaration',
            'A condition literal', 'A named block', 'The whole file'],
        blurb: 'the examples that are about the tool itself, whatever language the sample is written in' },
    // Languages. Each page earns its sections from what the language actually
    // needs to show: a braced language can anchor a block with a trailing
    // comment where an indented one uses a condition literal, and not every
    // language has annotations to bring along.
    { slug: 'java', label: 'Java', title: 'Java', group: 'Languages', order: 1, sample: 'samples/Inventory.java',
        blurb: 'the scopes inside a file, the literal a block tests, and line numbers',
        sections: ['Java: a path into the file', 'Java: line numbers, and several pieces at once',
            'Java: an envelope around a member'] },
    { slug: 'javascript', label: 'JavaScript / TypeScript', title: 'JavaScript and TypeScript', group: 'Languages',
        order: 2, sample: 'samples/cart.js', blurb: 'a template that hides its braces',
        sections: ['JavaScript: regions, declarations and modifiers', 'JavaScript: a template, a condition and an anchor',
            'JavaScript: an envelope around a member'] },
    { slug: 'go', label: 'Go', title: 'Go', group: 'Languages', order: 3, sample: 'samples/Cart.go',
        blurb: 'a raw string is not code',
        sections: ['Go: regions and declarations', 'Go: a switch literal and a trailing comment'] },
    { slug: 'rust', label: 'Rust', title: 'Rust', group: 'Languages', order: 4, sample: 'samples/Cart.rs',
        blurb: 'the members live in the impl',
        sections: ['Rust: regions and the impls', 'Rust: two impls, a literal and an anchor', 'Rust: an envelope is the impl'] },
    { slug: 'python', label: 'Python', title: 'Python', group: 'Languages', order: 5, sample: 'samples/Cart.py',
        blurb: 'triple quotes, indentation, and decorators',
        sections: ['Python: regions, defs and decorators', 'Python: an indented condition and an anchor', 'Python: an envelope restores the indentation'] },
    { slug: 'csharp', label: 'C#', title: 'C#', group: 'Languages', order: 6, sample: 'samples/Cart.cs',
        blurb: 'a verbatim string keeps its quotes',
        sections: ['C#: regions and declarations', 'C#: a condition and an anchor', 'C#: an envelope around a method'] },
    { slug: 'kotlin', label: 'Kotlin', title: 'Kotlin', group: 'Languages', order: 7, sample: 'samples/Cart.kt',
        blurb: 'nested comments, raw strings, and annotations',
        sections: ['Kotlin: regions and declarations', 'Kotlin: a condition and an anchor', 'Kotlin: an envelope around a method'] },
    { slug: 'php', label: 'PHP', title: 'PHP', group: 'Languages', order: 8, sample: 'samples/Cart.php',
        blurb: 'a heredoc is not code',
        sections: ['PHP: regions and declarations', 'PHP: a condition and an anchor', 'PHP: an envelope around a method'] },
    { slug: 'ruby', label: 'Ruby', title: 'Ruby', group: 'Languages', order: 9, sample: 'samples/Cart.rb',
        blurb: 'def, end, and the shift operator',
        sections: ['Ruby: regions, defs and end', 'Ruby: a condition and an anchor', 'Ruby: an envelope around a method'] },
    { slug: 'shell', label: 'Shell', title: 'Shell', group: 'Languages', order: 10, sample: 'samples/run.sh',
        blurb: 'a heredoc is not code either, and regions are how a script is addressed',
        sections: ['Shell: regions and functions', 'Shell: a heredoc and an anchor'] },
    { slug: 'vb', label: 'VB', title: 'VB', group: 'Languages', order: 11, sample: 'samples/Form.vb',
        blurb: 'a function and its End',
        sections: ['VB: regions and declarations', 'VB: an anchor', 'VB: an envelope around a function'] },
    { slug: 'haskell', label: 'Haskell', title: 'Haskell', group: 'Languages', order: 12, sample: 'samples/Main.hs',
        blurb: 'a binding and its signature',
        sections: ['Haskell: bindings and signatures', 'Haskell: a condition in a binding'] },
    { slug: 'zig', label: 'Zig', title: 'Zig', group: 'Languages', order: 13, sample: 'samples/Nesting.zig',
        blurb: 'a nested comment hides a decoy',
        sections: ['Zig: regions and declarations', 'Zig: a nested comment, a switch and an anchor'] },
    // Config formats.
    { slug: 'yaml', label: 'YAML', title: 'YAML', group: 'Config formats', order: 14, sample: 'samples/app.yaml',
        blurb: 'a key path',
        sections: ['YAML: a key path', 'YAML: several keys at once'] },
    { slug: 'toml', label: 'TOML', title: 'TOML', group: 'Config formats', order: 15, sample: 'samples/app.toml',
        blurb: 'a table and its key',
        sections: ['TOML: tables and keys', 'TOML: nested tables'] },
    { slug: 'ini', label: 'INI', title: 'INI', group: 'Config formats', order: 16, sample: 'samples/app.ini',
        blurb: 'a section and its key',
        sections: ['INI: sections and keys', 'INI: a leading key'] },
    { slug: 'json', label: 'JSON', title: 'JSON', group: 'Config formats', order: 17, sample: 'samples/api.json',
        blurb: 'keys, nested and several at once',
        sections: ['JSON: keys', 'JSON: a nested key'] },
    { slug: 'css', label: 'CSS', title: 'CSS', group: 'Styles', order: 18, sample: 'samples/site.css',
        blurb: 'a rule, an at-rule, and the nesting between',
        sections: ['CSS: rules and at-rules', 'CSS: a predicate, and a region'] },
];

/** The overview is the first page and the one a reader lands on. */
export const OVERVIEW = PAGES[0];

/**
 * The **code-jump** page set: the second document, built by the same generator.
 *
 * It exists because the tool has two use cases ([RFC 1](../doc/rfc/section-mapping.md)),
 * and one demo cannot show both well. `docs/demo.md` is about **injection** — the
 * exact text a reference puts into a document. This set is about **navigation** —
 * the line a reference takes a reader to, and what a host does when it cannot
 * get there ([RFC 2](../doc/rfc/code-jump.md)).
 *
 * The two are deliberately **independent**: neither menu lists the other and no
 * page links across, so a reader can read either one on its own. What they share
 * is the sample files and the reference grammar they demonstrate.
 */
export const JUMP_DOC = 'docs/jump-demo.md';
export const JUMP_OUT = 'docs/jump/index.html';

export const JUMP_PAGES = [
    { slug: 'overview', label: 'Overview', title: 'Overview', sample: null, group: 'This page', order: 0,
        sections: ['A jump lands on one line', 'A region lands inside it',
            'A named block lands on its opening line',
            'An envelope lands on the declaration that holds the member',
            'When the exact block is gone', 'When two blocks answer to one name'],
        blurb: 'what a reference points at, and where a reader arrives' },
    // Languages. A navigation page is short on purpose: it shows the constructs
    // of that language a reader actually jumps to, and the line each one starts
    // on — not every example the injection demo has to offer.
    { slug: 'java', label: 'Java', title: 'Java', group: 'Languages', order: 1, sample: 'samples/Inventory.java',
        blurb: 'a class, a nested class, and the member inside it',
        sections: ['Java: a declaration and the member nested in it', 'Java: a modifier moves the landing line'] },
    { slug: 'javascript', label: 'JavaScript / TypeScript', title: 'JavaScript and TypeScript', group: 'Languages',
        order: 2, sample: 'samples/cart.js', blurb: 'a member, its annotation, and a region',
        sections: ['JavaScript: a member, its body and its annotation'] },
    { slug: 'go', label: 'Go', title: 'Go', group: 'Languages', order: 3, sample: 'samples/Cart.go',
        blurb: 'top-level functions and a region',
        sections: ['Go: a function and a switch literal'] },
    { slug: 'rust', label: 'Rust', title: 'Rust', group: 'Languages', order: 4, sample: 'samples/Cart.rs',
        blurb: 'a name two impls answer to, and the one that holds the member',
        sections: ['Rust: a member two impls answer to', 'Rust: the envelope names the impl'] },
    { slug: 'python', label: 'Python', title: 'Python', group: 'Languages', order: 5, sample: 'samples/Cart.py',
        blurb: 'a method, its body, and the class around it',
        sections: ['Python: an indented method and its class'] },
    { slug: 'csharp', label: 'C#', title: 'C#', group: 'Languages', order: 6, sample: 'samples/Cart.cs',
        blurb: 'a method and the line its body starts on',
        sections: ['C#: a method and its body'] },
    { slug: 'kotlin', label: 'Kotlin', title: 'Kotlin', group: 'Languages', order: 7, sample: 'samples/Cart.kt',
        blurb: 'a fun and the body it opens',
        sections: ['Kotlin: a fun and its body'] },
    { slug: 'php', label: 'PHP', title: 'PHP', group: 'Languages', order: 8, sample: 'samples/Cart.php',
        blurb: 'a method and the heredoc that is not code',
        sections: ['PHP: a method and its heredoc'] },
    { slug: 'ruby', label: 'Ruby', title: 'Ruby', group: 'Languages', order: 9, sample: 'samples/Cart.rb',
        blurb: 'a def, its body, and the end that closes it',
        sections: ['Ruby: a def and the end that closes it'] },
    { slug: 'shell', label: 'Shell', title: 'Shell', group: 'Languages', order: 10, sample: 'samples/run.sh',
        blurb: 'a function, a region, and the heredoc between them',
        sections: ['Shell: a function and the region around it'] },
    { slug: 'vb', label: 'VB', title: 'VB', group: 'Languages', order: 11, sample: 'samples/Form.vb',
        blurb: 'a function and the End that closes it',
        sections: ['VB: a function and its End'] },
    { slug: 'haskell', label: 'Haskell', title: 'Haskell', group: 'Languages', order: 12, sample: 'samples/Main.hs',
        blurb: 'a binding and the signature above it',
        sections: ['Haskell: a binding and its signature'] },
    { slug: 'zig', label: 'Zig', title: 'Zig', group: 'Languages', order: 13, sample: 'samples/Nesting.zig',
        blurb: 'a function and the nested comment that hides a decoy',
        sections: ['Zig: a function and a region'] },
    // Config formats: a jump lands on the line the key is written on, which is
    // the whole of what navigation needs from a data rule.
    { slug: 'yaml', label: 'YAML', title: 'YAML', group: 'Config formats', order: 14, sample: 'samples/app.yaml',
        blurb: 'the line a key path is written on',
        sections: ['YAML: a key path'] },
    { slug: 'toml', label: 'TOML', title: 'TOML', group: 'Config formats', order: 15, sample: 'samples/app.toml',
        blurb: 'a key inside a table',
        sections: ['TOML: a table and a key'] },
    { slug: 'ini', label: 'INI', title: 'INI', group: 'Config formats', order: 16, sample: 'samples/app.ini',
        blurb: 'a section and a key',
        sections: ['INI: a section and a key'] },
    { slug: 'json', label: 'JSON', title: 'JSON', group: 'Config formats', order: 17, sample: 'samples/api.json',
        blurb: 'a nested key',
        sections: ['JSON: a nested key'] },
    { slug: 'css', label: 'CSS', title: 'CSS', group: 'Styles', order: 18, sample: 'samples/site.css',
        blurb: 'an at-rule and the rule nested in it',
        sections: ['CSS: an at-rule and a rule inside it'] },
];

/**
 * A page set is a whole build: its pages, its document, where its overview goes,
 * and — for the navigation demo — how it differs.
 *
 * `mode` is `'inject'` or `'jump'`. An injection document writes a reference as a
 * marker followed by the block it fills; a jump document writes it as the link it
 * is, because a jump has nothing to put in the document. `landing` is the same
 * distinction on the page: an injection target highlights the text it injects,
 * while a navigation target highlights the single line a reader lands on.
 * `layout` picks the page frame — the injection demo's three columns, or the
 * navigation demo's source file beside the document.
 */
export const PAGE_SETS = {
    inject: {
        pages: PAGES, docPath: DEFAULT_DOC, outPath: DEFAULT_OUT,
        mode: 'inject', landing: false, layout: 'three-column',
    },
    jump: {
        pages: JUMP_PAGES, docPath: JUMP_DOC, outPath: JUMP_OUT,
        mode: 'jump', landing: true, layout: 'source-document',
    },
};
/** The overview of a page set: the first entry, and the one a reader lands on. */
const overviewOf = (pages) => pages[0];

/** The site's name, for the `<title>` of every page. */
const SITE = 'inject-examples';

/** The page a `##` section is published on: the one whose `sections` names it. */
export function pageOfSection(section, pages = PAGES) {
    return (pages.find((page) => page.sections.includes(section.title)) ?? overviewOf(pages)).slug;
}

/** The set a `--pages` name means, or `null` when there is no such set. */
export function pageSet(name) {
    return Object.hasOwn(PAGE_SETS, name) ? PAGE_SETS[name] : null;
}

const HELP = `usage: bun tools/build-demo.mjs [options]

  --pages <name>  which page set to build: ${Object.keys(PAGE_SETS).join(' or ')}
                  (default: inject). A set carries its own document and overview.
  --doc <file>    source document (default: ${DEFAULT_DOC})
  --out <file>    overview page to write (default: ${DEFAULT_OUT})
  --root <dir>    base directory the paths resolve against
  -c, --check     write nothing; exit 1 when a page is stale
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

/** Join a `/`-separated path onto a directory, leaving an absolute one alone. */
function joinPath(dir, path) {
    if (dir === '.' || path.startsWith('/')) return path;
    return path.startsWith('./') ? `${dir}/${path.slice(2)}` : `${dir}/${path}`;
}

/** Where a page is written, relative to the root: the overview, or a language page. */
export function pagePath(page, outPath = DEFAULT_OUT, overviewSlug = OVERVIEW.slug) {
    if (page.slug === overviewSlug) return outPath;
    return page.file ?? joinPath(posixDirname(slashes(outPath)), `${LANGUAGES_DIR}/${page.slug}.html`);
}

/** The `href` that reaches `to` from `from` — both page paths, relative to the root. */
export function pageHref(from, to) {
    const fromDir = posixDirname(from);
    const fromParts = fromDir === '.' ? [] : fromDir.split('/');
    const toParts = to.split('/');
    let shared = 0;
    while (shared < fromParts.length && shared < toParts.length - 1 && fromParts[shared] === toParts[shared]) shared++;
    return [...fromParts.slice(shared).map(() => '..'), ...toParts.slice(shared)].join('/') || toParts[toParts.length - 1];
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
 * A section is its prose and its examples, and each example is one marker with
 * the prose that explains it. That prose is the run of blocks *immediately above*
 * the marker: a document says what an example is before it shows the link, so
 * `[samples/Inventory.java#catalog](./samples/Inventory.java#catalog)` explains
 * itself with the paragraph above it, and the code fence below it is its content.
 * The prose above a section's first marker is the section's own explanation, and
 * it explains that example too.
 *
 * Markers inside fenced blocks are not markers (`fenceRanges` and `parseMarker`
 * decide that, exactly as the tool does), so a section's code examples never
 * register as targets.
 * A section is published on the page the set's `pages` names it on, and a section
 * no page claims stays on the overview.
 *
 * @param {string} text
 * @param {Array<object>} [pages] the page set the document is published on
 * @returns {{ title: string, intro: object[], sections: Array<{ title: string, page: string, lead: object[], examples: object[] }> }}
 */
export function parseDemoDoc(text, pages = PAGES) {
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
                const title = heading[2].trim();
                section = { title, page: pageOfSection({ title }, pages), line: i + 1, blocks: [], examples: [] };
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

    for (const part of doc.sections) {
        // The prose above a marker is what explains it: a document names the
        // thing before it shows the link. That is why `lead` is reset *after*
        // each marker and the trailing run belongs to no example at all — a
        // paragraph that names nothing above it names nothing at all.
        let lead = [];
        for (const block of part.blocks) {
            if (block.type !== 'marker') {
                lead.push(block);
                continue;
            }
            // Everything written above the first marker is the section's own
            // explanation, and that marker's too.
            const blocks = lead;
            lead = [];
            part.examples.push({ marker: block.marker, line: block.line, blocks });
        }
        part.lead = lead;
    }

    return doc;
}

/**
 * Is a section's own prose only its heading restated?
 *
 * A section usually says everything it has to say in the paragraph above its
 * first link, so a first paragraph repeating the title is the section's name and
 * not an explanation — the (possibly empty) rest is what the example says about
 * itself. Examples that share a section have no prose of their own either, and
 * the pane would otherwise show the section's paragraph under every one of them.
 */
function withoutRestatedTitle(title, blocks) {
    const first = blocks[0];
    if (!first || first.type !== 'prose') return blocks;
    const [one, ...rest] = first.text.split(/\n{2,}/);
    return one.trim() === title ? [{ ...first, text: rest.join('\n\n') }, ...blocks.slice(1)] : blocks;
}

/**
 * The blocks the description pane shows for one example: the prose written above
 * its marker, minus a paragraph that only restates the section's title.
 *
 * An example with nothing of its own falls back, in order, to the prose above the
 * section's **next** marker — a paragraph that introduces an example the section
 * writes after it, as the overview's "The whole file" is introduced by the
 * sentence above it — and to the prose above the section's first marker, which
 * explains all of the section's examples. Only a section that says nothing at all
 * leaves the pane empty.
 *
 * @param {{ title: string, lead: object[], examples: object[] }} section
 * @param {object} example
 * @returns {object[]}
 */
export function exampleBlocks(section, example) {
    const own = withoutRestatedTitle(section.title, example.blocks ?? []);
    if (own.some((block) => block.type === 'prose')) return own;

    const index = section.examples.indexOf(example);
    const candidates = [
        section.lead,
        section.examples[index + 1]?.blocks,
        section.examples[0]?.blocks,
    ];
    for (const candidate of candidates) {
        const blocks = withoutRestatedTitle(section.title, candidate ?? []);
        if (blocks.some((block) => block.type === 'prose')) return blocks;
    }
    return own;
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
 * Where a *rendered* selection sits in its file.
 *
 * The JSON/YAML/TOML/INI rules re-print or re-frame what they select, so the
 * result is not a byte slice `locateRange` could find. But it is built from the
 * file's own lines, so each rendered line can be matched back to the source line
 * it came from: a line that carries a key (`a:` in YAML, `key =` in TOML/INI,
 * `"key":` in JSON, `[table]` in either) matches the first source line at or after
 * the previous match with the **same key**, and anything else (an array element)
 * matches by exact text. The range runs from the first match to the last; when
 * nothing matches there is no highlight — the snippet is still the whole story.
 *
 * This is a display concern, so it lives here rather than on the rule: a rule
 * answers "what do these keys say", the page answers "where do they sit".
 *
 * @param {string} source the target file
 * @param {string} injected the rendered selection
 * @returns {{ ranges: Array<[number, number]> } | null} 1-based, contiguous,
 *          in file order — one per group of adjacent lines, so two keys far
 *          apart are two ranges rather than one that highlights everything
 *          between them
 */
export function locateRendered(source, injected) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const textOf = (line) => line.trim().replace(/,$/, '');
    const keyOf = (line) => {
        const text = line.trim();
        const header = /^\[([^\]]+)\]$/.exec(text);
        if (header) return header[1].trim();
        const quoted = /^"((?:[^"\\]|\\.)*)"\s*:/.exec(text);
        if (quoted) return quoted[1];
        const pair = /^([A-Za-z0-9_.-]+)\s*[:=]/.exec(text);
        return pair ? pair[1] : null;
    };

    let index = 0;
    const hits = [];
    for (const rendered of injected.split('\n')) {
        const text = textOf(rendered);
        if (text === '' || /^[{}[\]]$/.test(text)) continue;
        const key = keyOf(rendered);
        const at = lines.findIndex((line, i) => {
            if (i < index) return false;
            return key === null ? textOf(line) === text : keyOf(line) === key;
        });
        if (at === -1) continue;
        hits.push(at);
        index = at + 1;
    }
    if (hits.length === 0) return null;

    const ranges = [];
    for (const at of hits) {
        const last = ranges[ranges.length - 1];
        if (last && at === last[1]) last[1] = at + 1;
        else ranges.push([at + 1, at + 1]);
    }
    return { ranges };
}

/**
 * Where a **CSS** selection sits in its file.
 *
 * A CSS rule selects its own bytes, so unlike a rendered data selection its text
 * *is* a slice of the file — but a reference may name several rules, and the
 * injected text is those slices joined with a newline, which is not one slice.
 * The rule's own `ranges` answer that exactly (and for `-` they are the
 * declarations alone, which is not a whole-line slice either), so they are taken
 * from there and the text is only used to confirm the slice.
 *
 * @param {{ ranges: (text: string, reference: string) => Array<{ from: number, to: number }> }} css
 * @param {string} source the target file
 * @param {string} reference the `#fragment` as written
 * @param {string} injected the text the reference resolves to
 * @returns {{ ranges: Array<[number, number]> } | null}
 */
export function locateCss(css, source, reference, injected) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const ranges = css.ranges(source, reference).map(({ from, to }) => [from, to]);
    if (ranges.length === 0) return null;
    const from = Math.min(...ranges.map(([first]) => first));
    const to = Math.max(...ranges.map(([, last]) => last));
    const slice = lines.slice(from - 1, to).join('\n');
    if (!slice.includes(injected)) return null;
    return { ranges };
}

/**
 * Resolve one marker into the model entry the page needs: the text it injects
 * and the lines of the file it injects them from.
 *
 * `idPrefix` separates one page's targets from another's. Two pages may show the
 * same example — the Overview introduces the tool with Java's own sample, and the
 * Java page works the same reference in detail — and an id is an element id on one
 * page, so each page names its targets in its own space.
 */
function resolveTarget(marker, file, sectionIndex, targetIndex, warn, idPrefix = '', landing = false) {
    const rule = ruleFor(marker.path);
    let text;
    let ranges = null;
    // A rule that *renders* its selection re-prints or re-frames it, so the
    // result is not a byte slice of the file. Code and CSS both answer with the
    // lines they selected, so neither is rendered here.
    const rendered = rule !== CODE_RULE && rule !== CSS_RULE && marker.reference !== null;

    if (marker.reference === null) {
        text = file.text;
        const range = locateRange(file.text, text, null);
        ranges = range ? [[range.from, range.to]] : null;
    } else if (rule === CODE_RULE) {
        const plan = planSection(file.text, marker.reference, lexerFor(marker.path));
        text = plan.text;
        if (plan.reference.warning) {
            warn(`${marker.path}#${marker.reference}: ${plan.reference.warning.kind} modifier; using "${plan.reference.kept}"`);
        }
        // The plan knows exactly which lines each selector came from — a
        // reference of several selectors, or a line range, has more than one
        // place to point at — so the page does not have to find them again.
        ranges = plan.ranges.map((range) => [range.from, range.to]);
        // A jump lands on one line: the page highlights where the reader
        // arrives, not the span the reference covers.
        if (landing && ranges.length > 0) ranges = [[ranges[0][0], ranges[0][0]]];
        if (ranges.length === 0) {
            throw new Error(`${marker.raw}: the lines of "#${marker.reference}" cannot be located in ${marker.path}`);
        }
    } else if (rule === CSS_RULE) {
        text = rule.resolve(file.text, marker.reference, marker.path);
        ranges = locateCss(rule, file.text, marker.reference, text)?.ranges ?? null;
        if (landing && ranges !== null && ranges.length > 0) ranges = [[ranges[0][0], ranges[0][0]]];
        if (ranges === null) {
            throw new Error(`${marker.raw}: the lines of "#${marker.reference}" cannot be located in ${marker.path}`);
        }
    } else {
        text = rule.resolve(file.text, marker.reference, marker.path);
        ranges = locateRendered(file.text, text)?.ranges ?? null;
        if (landing && ranges !== null && ranges.length > 0) ranges = [[ranges[0][0], ranges[0][0]]];
    }

    return {
        id: `${idPrefix}t-${sectionIndex + 1}-${targetIndex + 1}`,
        section: sectionIndex + 1,
        raw: marker.raw,
        path: marker.path,
        reference: marker.reference,
        rendered,
        fileLabel: file.label,
        fileDisplay: file.display,
        label: marker.reference === null ? 'whole file' : `#${marker.reference}`,
        from: ranges ? ranges[0][0] : null,
        to: ranges ? ranges[ranges.length - 1][1] : null,
        ranges,
        text,
    };
}

/**
 * Turn the source document plus its target files into everything every page
 * renders. Reads only through `options.read`, so a test can pass a stub.
 *
 * The document is parsed once and published as `PAGES.length` pages: each one
 * gets the sections the document routed to it, its own rendered Markdown, and
 * the menu every page shares.
 *
 * @param {{ root?: string, docPath?: string, read?: (path: string) => string,
 *           onWarning?: (message: string) => void, outPath?: string }} [options]
 */
export function buildModel(options = {}) {
    const root = options.root ?? REPO_ROOT;
    const docPath = slashes(options.docPath ?? DEFAULT_DOC);
    const outPath = slashes(options.outPath ?? DEFAULT_OUT);
    const read = options.read ?? fileReader(root);
    const warn = options.onWarning ?? (() => {});
    // The page set: `PAGES` by default, `JUMP_PAGES` for the navigation demo. A
    // set is a record, not a document's order, so the same generator builds both.
    const pages = options.pages ?? PAGES;
    const overviewSlug = overviewOf(pages).slug;
    const mode = options.mode ?? 'inject';
    const landing = options.landing ?? false;
    const layout = options.layout ?? 'three-column';

    const docText = read(docPath);
    const doc = parseDemoDoc(docText, pages);
    const docDir = posixDirname(docPath);
    const readTarget = (path) => read(docDir === '.' ? path : `${docDir}/${path}`);
    // Prose link: written beside the document, so it is relative to it — a page
    // at the document's own path resolves it as written, and a page nested below
    // that path makes it climb back up to it.
    const climb = (fromPath) => {
        const depth = joinPath(posixDirname(outPath), LANGUAGES_DIR).split('/').length
            - posixDirname(outPath).split('/').length;
        const climbs = posixDirname(fromPath) === posixDirname(outPath) ? 0 : depth;
        return '../'.repeat(climbs);
    };
    const linkTo = (fromPath) => (href) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
        return `${climb(fromPath)}${joinPath(docDir, href.replace(/^\.\//, ''))}`;
    };

    // A marker outside a `##` section would have no numbered paragraph to live
    // in; it is almost always a heading that was forgotten, so say so.
    const stray = doc.intro.find((block) => block.type === 'marker');
    if (stray) {
        throw new Error(`${docPath}:${stray.line}: a marker outside any "##" section has no paragraph to live in`);
    }

    // Every page names every other one, so the menu is the first thing built —
    // in menu order, which is not the document's.
    const paths = new Map(pages.map((entry) => [entry.slug, pagePath(entry, outPath, overviewSlug)]));
    const nav = [...pages].sort((a, b) => a.order - b.order).map((entry) => ({
        slug: entry.slug,
        label: entry.label,
        group: entry.group ?? null,
        title: entry.title,
        blurb: entry.blurb,
        sample: entry.sample,
    }));

    // The lines of the document each page owns: a section runs to the line before
    // the next one's heading, so the pages tile the document and the third column
    // can render one page's stretch of it with the document's own line numbers.
    const lineCount = docText.replace(/\r\n/g, '\n').split('\n').length;
    const spans = new Map();
    doc.sections.forEach((part, index) => {
        const next = doc.sections[index + 1];
        spans.set(part, [part.line, next ? next.line - 1 : lineCount]);
    });

    const files = new Map();
    const built = [];
    let exampleCount = 0;

    for (const [pageIndex, entry] of pages.entries()) {
        const pageFile = paths.get(entry.slug);
        const resolveLink = linkTo(pageFile);
        const owned = doc.sections.filter((part) => part.page === entry.slug);
        // A page named a section the document does not have is a typo in `PAGES`,
        // and it would silently publish an empty page; say so instead.
        const missing = entry.sections.filter((title) => !doc.sections.some((part) => part.title === title));
        if (missing.length > 0) {
            throw new Error(`${docPath}: no section named ${missing.map((title) => `"${title}"`).join(', ')}`);
        }
        if (entry.slug !== overviewSlug && owned.length === 0) {
            throw new Error(`the page "${entry.slug}" owns no section; PAGES and ${docPath} disagree`);
        }

        const sections = owned.map((part) => {
            const sectionIndex = doc.sections.indexOf(part);
            // A page names its targets in its own space, so the same reference
            // shown on two pages does not collide as an element id: the overview
            // introduces the tool with Java's sample, and the Java page works the
            // same reference in detail.
            const idPrefix = entry.slug === overviewSlug ? '' : `${entry.slug}-`;
            const examples = part.examples.map((example, index) => {
                const file = loadFile(files, example.marker.path, readTarget);
                file.display = docDir === '.' ? file.path : `${docDir}/${file.path}`;
                const target = resolveTarget(example.marker, file, sectionIndex, index, warn, idPrefix, landing);
                target.line = example.line;
                // The panes carry different renderings of the same prose: the
                // title is the heading above it in the left column, and the
                // description is what that column shows while this target is
                // the selected one.
                target.title = part.title;
                target.description = renderBlocks(exampleBlocks(part, example), resolveLink);
                return target;
            });
            exampleCount += examples.length;
            return {
                title: part.title,
                examples,
                // A section with no example of its own still has something to say
                // — the overview's index is one — and the description pane is
                // where the left column can show it.
                note: examples.length === 0 ? renderBlocks(part.lead, resolveLink) : '',
            };
        });

        // The third column renders the document itself, the stretch of it this
        // page owns; a marker line carries its target's id, so a click can
        // highlight the exact spot in the Markdown.
        const markerIds = new Map();
        const landings = new Map();
        for (const section of sections) {
            for (const example of section.examples) {
                markerIds.set(example.line, example.id);
                // A navigation page sends the reader to one line; the page carries
                // that line so a click needs no resolver of its own.
                if (landing && example.ranges && example.ranges.length > 0) {
                    landings.set(example.line, example.ranges[0]);
                }
            }
        }
        const ranges = owned.map((part) => spans.get(part));

        built.push({
            ...entry,
            index: pageIndex,
            path: pageFile,
            isOverview: entry.slug === overviewSlug,
            sections,
            examples: sections.flatMap((section) => section.examples),
            // Only the files this page's examples read: the source column gets a
            // tab per file, and a tab for a sample the page never shows is noise.
            files: [...new Set(sections.flatMap((section) => section.examples.map((example) => example.path)))]
                .map((path) => files.get(path)),
            // The core examples are the document's own lead, so the overview
            // shows the banner; a language page has its own title to get to.
            introHtml: entry.slug === overviewSlug ? renderBlocks(doc.intro, resolveLink) : '',
            markdownHtml: renderMarkdown(docText, { markerIds, landings, ranges, resolveLink, jumpMode: mode === 'jump' }),
            menu: nav.map((item) => ({ ...item, href: pageHref(pageFile, paths.get(item.slug)) })),
        });
    }

    return {
        title: doc.title,
        docPath,
        outPath,
        // The set's overview slug, so a renderer can tell the one page whose
        // name says nothing about what it holds — the only one that describes
        // itself in the menu.
        overviewSlug,
        mode,
        landing,
        layout,
        pages: built,
        nav,
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

/**
 * Inline code, bold and links — everything else is escaped text. A link's href
 * is handed to `resolve` (the identity by default) so a document's relative
 * paths can be re-pointed at where the page lives.
 */
export function renderInline(text, resolve = (href) => href) {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => `<a href="${resolve(href)}">${label}</a>`);
}

/** Paragraphs, bullet lists and sub-headings — the subset the demo document uses. */
export function renderProse(text, resolve) {
    return text
        .split(/\n{2,}/)
        .map((paragraph) => {
            const body = paragraph.trim();
            if (body === '') return '';
            const rows = body.split('\n');
            if (rows.every((row) => /^\s*[-*]\s+/.test(row))) {
                const items = rows.map((row) => `  <li>${renderInline(row.replace(/^\s*[-*]\s+/, ''), resolve)}</li>`);
                return `<ul>\n${items.join('\n')}\n</ul>`;
            }
            return `<p>${renderInline(rows.map((row) => row.trim()).join(' '), resolve)}</p>`;
        })
        .filter((html) => html !== '')
        .join('\n');
}

/** The HTML of a section's non-marker blocks, in document order. */
export function renderBlocks(blocks, resolve) {
    return blocks
        .map((block) => {
            if (block.type === 'prose') return renderProse(block.text, resolve);
            if (block.type === 'heading') return `<h${block.level}>${renderInline(block.text, resolve)}</h${block.level}>`;
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
function renderMarker(line, id, resolve, jumpMode = false, landing = null) {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(line.trim());
    const label = link ? renderInline(link[1], resolve) : escapeHtml(line.trim());
    const href = link ? escapeHtml(resolve(link[2])) : '#';
    // The marker is a link either way. What differs is what it *is*: an
    // injection marker stands for the block under it, a jump marker is a
    // destination and nothing else.
    const badge = jumpMode ? 'jump' : 'inject';
    // A jump page has no targets column, so the landing line travels on the
    // paragraph instead — the generator resolved it from the same reference the
    // link spells out. The file needs no attribute: the link's own href names it.
    const lands = landing ? ` data-landing="${landing[0]}-${landing[1]}"` : '';
    return `<p class="md-marker" data-marker="${id}"${lands}><a href="${href}">${label}</a>`
        + `<span class="md-badge">${badge}</span></p>`;
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
 * When a page owns only part of the document, `ranges` restricts the render to
 * those line ranges — the document's own line numbers are still what the anchors
 * carry, so the rendered column and the document agree — and the sections are
 * numbered from 1 within the page, matching the targets column beside it.
 *
 * @param {string} text
 * @param {{ markerIds?: Map<number, string>, ranges?: Array<[number, number]>,
 *           resolveLink?: (href: string) => string }} [options]
 *        marker line -> target id, the lines this page owns, and where a prose
 *        link points on the page
 */
export function renderMarkdown(text, options = {}) {
    const markerIds = options.markerIds ?? new Map();
    const resolve = options.resolveLink ?? ((href) => href);
    const jumpMode = options.jumpMode ?? false;
    const landings = options.landings ?? new Map();
    const owned = options.ranges ?? null;
    const wanted = (index) => owned === null || owned.some(([from, to]) => index + 1 >= from && index + 1 <= to);

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
            if (wanted(i)) html.push(renderFence(lines, i, fence, markerIds));
            i = fence.close + 1;
            continue;
        }

        const line = lines[i];
        if (line.trim() === '' || !wanted(i)) {
            i++;
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            if (level === 2) openSection(++section);
            html.push(`<h${level} data-md-from="${i + 1}" data-md-to="${i + 1}">`
                + `${renderInline(heading[2].trim(), resolve)}</h${level}>`);
            i++;
            continue;
        }

        if (markerAt(i)) {
            html.push(renderMarker(line, markerIds.get(i + 1), resolve, jumpMode, landings.get(i + 1)));
            i++;
            continue;
        }

        if (/^\s*[-*]\s+/.test(line)) {
            const from = i;
            const items = [];
            while (i < lines.length && wanted(i) && /^\s*[-*]\s+/.test(lines[i])) {
                items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''), resolve)}</li>`);
                i++;
            }
            html.push(`<ul data-md-from="${from + 1}" data-md-to="${i}">\n${items.join('\n')}\n</ul>`);
            continue;
        }

        const from = i;
        const rows = [];
        while (i < lines.length && wanted(i) && lines[i].trim() !== '' && !fences.has(i)
            && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])
            && !(rows.length > 0 && markerAt(i))) {
            rows.push(lines[i].trim());
            i++;
        }
        html.push(`<p data-md-from="${from + 1}" data-md-to="${i}">${renderInline(rows.join(' '), resolve)}</p>`);
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

const GO_KEYWORDS = new Set([
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
    'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
    'struct', 'switch', 'type', 'var', 'nil', 'true', 'false', 'iota', 'make', 'new', 'append', 'len',
]);

const RUST_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
    'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
    'where', 'while',
]);

const PYTHON_KEYWORDS = new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
    'True', 'False', 'None', 'self',
]);

const CSHARP_KEYWORDS = new Set([
    'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
    'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum',
    'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'get',
    'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace',
    'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
    'readonly', 'record', 'ref', 'return', 'sealed', 'set', 'short', 'sizeof', 'static', 'string',
    'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unsafe', 'ushort',
    'using', 'var', 'virtual', 'void', 'volatile', 'while',
]);

const KOTLIN_KEYWORDS = new Set([
    'abstract', 'actual', 'as', 'break', 'by', 'catch', 'class', 'companion', 'const', 'constructor',
    'continue', 'data', 'do', 'else', 'enum', 'expect', 'external', 'false', 'final', 'finally', 'for',
    'fun', 'get', 'if', 'import', 'in', 'infix', 'init', 'inline', 'inner', 'interface', 'internal',
    'is', 'lateinit', 'null', 'object', 'open', 'operator', 'out', 'override', 'package', 'private',
    'protected', 'public', 'reified', 'return', 'sealed', 'set', 'super', 'suspend', 'tailrec', 'this',
    'throw', 'true', 'try', 'typealias', 'val', 'var', 'vararg', 'when', 'where', 'while',
]);

const PHP_KEYWORDS = new Set([
    'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone', 'const',
    'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enum', 'extends',
    'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements',
    'include', 'instanceof', 'interface', 'isset', 'list', 'match', 'namespace', 'new', 'or', 'print',
    'private', 'protected', 'public', 'readonly', 'require', 'return', 'static', 'switch', 'throw',
    'trait', 'try', 'unset', 'use', 'var', 'while', 'yield', 'true', 'false', 'null',
]);

const RUBY_KEYWORDS = new Set([
    'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined', 'do', 'else', 'elsif', 'end',
    'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue',
    'retry', 'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while',
    'yield', 'attr_accessor', 'require', 'require_relative', 'new',
]);

const SQL_KEYWORDS = new Set([
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
    'table', 'alter', 'drop', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order',
    'having', 'limit', 'offset', 'union', 'all', 'distinct', 'as', 'and', 'or', 'not', 'null', 'is',
    'in', 'like', 'between', 'exists', 'case', 'when', 'then', 'else', 'end', 'primary', 'key',
    'foreign', 'references', 'index', 'view', 'begin', 'commit', 'rollback', 'with',
]);

const SHELL_KEYWORDS = new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
    'function', 'select', 'time', 'return', 'exit', 'export', 'local', 'readonly', 'declare',
    'typeset', 'unset', 'shift', 'eval', 'exec', 'trap', 'set', 'source', 'alias', 'echo', 'cd',
]);

const VB_KEYWORDS = new Set([
    'dim', 'as', 'new', 'nothing', 'true', 'false', 'if', 'then', 'else', 'elseif', 'end', 'select',
    'case', 'for', 'each', 'next', 'while', 'do', 'loop', 'sub', 'function', 'class', 'module',
    'structure', 'interface', 'public', 'private', 'protected', 'friend', 'shared', 'overrides',
    'mustoverride', 'inherits', 'implements', 'imports', 'namespace', 'return', 'byval', 'byref',
    'optional', 'paramarray', 'string', 'integer', 'boolean', 'double', 'object', 'me', 'mybase',
]);

const HASKELL_KEYWORDS = new Set([
    'case', 'class', 'data', 'default', 'deriving', 'do', 'else', 'foreign', 'if', 'import', 'in',
    'infix', 'infixl', 'infixr', 'instance', 'let', 'module', 'newtype', 'of', 'then', 'type',
    'where', 'forall', 'mdo', 'proc', 'rec',
]);

const JSON_KEYWORDS = new Set(['true', 'false', 'null']);

/**
 * CSS has no keywords to highlight: what a reader recognises is the at-rule
 * (`@media`) and the property name. `renderPlain` already colours a `@`-word as
 * `tok-a`, so the table only needs the property names it calls keywords — one
 * word each, because the tokenizer reads a hyphen as a word boundary.
 */
const CSS_KEYWORDS = new Set([
    'display', 'position', 'color', 'background', 'gap', 'row', 'column', 'padding', 'margin',
    'border', 'radius', 'grid', 'flex', 'align', 'items', 'justify', 'content', 'font', 'family',
    'size', 'opacity', 'transform', 'transition', 'src', 'width', 'height', 'top', 'left',
]);

/** JSON is display-only here: the resolver reads it by rule (see `JSON_RULE`). */
const JSON_SYNTAX = {
    name: 'json',
    lineComments: [],
    blockComments: [],
    strings: [{ open: '"', close: '"', escape: 'backslash' }],
};

/**
 * The languages a file or a fenced block can be highlighted in, by the fence
 * language `fileLanguage` names. Comment and string spans come from the same
 * syntax table the resolver's lexers use (`syntaxes.js`), so the page shows
 * exactly what the tool considers a comment or a string; the keyword sets are a
 * display concern and live here.
 */
const HIGHLIGHTERS = {
    java: { syntax: SYNTAXES.java, keywords: JAVA_KEYWORDS },
    javascript: { syntax: SYNTAXES.javascript, keywords: JS_KEYWORDS },
    typescript: { syntax: SYNTAXES.typescript, keywords: TS_KEYWORDS },
    zig: { syntax: SYNTAXES.zig, keywords: ZIG_KEYWORDS },
    go: { syntax: SYNTAXES.go, keywords: GO_KEYWORDS },
    rust: { syntax: SYNTAXES.rust, keywords: RUST_KEYWORDS },
    python: { syntax: SYNTAXES.python, keywords: PYTHON_KEYWORDS },
    csharp: { syntax: SYNTAXES.csharp, keywords: CSHARP_KEYWORDS },
    kotlin: { syntax: SYNTAXES.kotlin, keywords: KOTLIN_KEYWORDS },
    php: { syntax: SYNTAXES.php, keywords: PHP_KEYWORDS },
    ruby: { syntax: SYNTAXES.ruby, keywords: RUBY_KEYWORDS },
    sql: { syntax: SYNTAXES.sql, keywords: SQL_KEYWORDS, fold: true },
    bash: { syntax: SYNTAXES.shell, keywords: SHELL_KEYWORDS },
    vb: { syntax: SYNTAXES.vb, keywords: VB_KEYWORDS, fold: true },
    haskell: { syntax: SYNTAXES.haskell, keywords: HASKELL_KEYWORDS },
    yaml: { syntax: SYNTAXES.yaml, keywords: null },
    toml: { syntax: SYNTAXES.toml, keywords: null },
    ini: { syntax: SYNTAXES.ini, keywords: null },
    json: { syntax: JSON_SYNTAX, keywords: JSON_KEYWORDS },
    css: { syntax: SYNTAXES.css, keywords: CSS_KEYWORDS },
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
function renderPlain(text, keywords, fold) {
    let html = '';
    let last = 0;
    for (const match of text.matchAll(CODE_TOKEN)) {
        const token = match[0];
        html += escapeHtml(text.slice(last, match.index));
        let cls = null;
        if (token.startsWith('@')) cls = 'tok-a';
        else if (keywords && keywords.has(fold ? token.toLowerCase() : token)) cls = 'tok-k';
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
function renderLine(line, kinds, offset, keywords, fold) {
    let html = '';
    let i = 0;
    while (i < line.length) {
        const kind = kinds[offset + i];
        let j = i;
        while (j < line.length && kinds[offset + j] === kind) j++;
        const chunk = line.slice(i, j);
        if (kind === 1) html += `<span class="tok-c">${escapeHtml(chunk)}</span>`;
        else if (kind === 2) html += `<span class="tok-s">${escapeHtml(chunk)}</span>`;
        else html += renderPlain(chunk, keywords, fold);
        i = j;
    }
    return html;
}

/**
 * A code block as highlighted HTML, newlines kept (so it can sit in a `<pre>`).
 * An unknown language is escaped and left plain.
 */
export function highlightCode(text, language) {
    const highlighter = highlighterFor(language);
    const kinds = codeKinds(text, language);
    let offset = 0;
    return text
        .split('\n')
        .map((line) => {
            const html = renderLine(line, kinds, offset, highlighter?.keywords ?? null, highlighter?.fold === true);
            offset += line.length + 1;
            return html;
        })
        .join('\n');
}

/** The whole file as `<span class="line">` rows, numbered from 1. */
export function renderSourceLines(file) {
    const highlighter = highlighterFor(file.language);
    const kinds = codeKinds(file.text, file.language);
    let offset = 0;
    return file.lines
        .map((line, index) => {
            const html = renderLine(line, kinds, offset, highlighter?.keywords ?? null, highlighter?.fold === true);
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
.head-title { display: flex; align-items: center; gap: .6rem; min-width: 0; }
.page-head h1 { margin: 0; font-size: 1.12rem; }
.page-head p { margin: .15rem 0 0; max-width: none; }
.page-head .intro p { margin: .2rem 0 0; }
.page-head .note { margin: 0; color: var(--muted); font-size: .78rem; }
.page-sub { color: var(--muted); font-size: .84rem; }

/* The hamburger and its menu: one page per language, from any page.
   The menu is a popover — light dismiss, Escape and the top layer come with it —
   and CSS anchor positioning pins it to the button, so it follows the banner
   wherever the button lands. A browser without either API falls back to a
   scroll-away block, kept usable by the small script below. */
.menu-wrap { position: relative; flex: none; }
.menu-toggle {
  display: flex; align-items: center; gap: .45rem; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--fg);
  border-radius: 8px; padding: .3rem .55rem; font: 500 .8rem/1.2 ui-sans-serif, system-ui, sans-serif;
  anchor-name: --examples-menu;
}
.menu-toggle:hover { border-color: var(--accent); }
.menu-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.menu-toggle[aria-expanded="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-fg); }
.menu-bars {
  flex: none; width: 14px; height: 10px;
  background:
    linear-gradient(currentColor, currentColor) 0 0 / 100% 2px no-repeat,
    linear-gradient(currentColor, currentColor) 0 4px / 100% 2px no-repeat,
    linear-gradient(currentColor, currentColor) 0 8px / 100% 2px no-repeat;
}
@supports selector(:popover-open) and (position-anchor: --examples-menu) {
  .menu {
    position-anchor: --examples-menu;
    position-area: bottom span-right;
    position-try-fallbacks: bottom span-left, top span-right, top span-left;
  }
}
@supports not (selector(:popover-open) and (position-anchor: --examples-menu)) {
  .menu { position: absolute; top: 100%; left: 0; }
  /* Without the popover API the attribute does not hide anything, so the menu
     starts hidden here and the script below opens it. */
  .menu:not([data-open]) { display: none; }
}
.menu {
  margin: .4rem 0 0; margin-top: .4rem; padding: .4rem; width: min(28rem, 82vw); max-height: min(70vh, 34rem); overflow: auto;
  background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, .18); inset: auto;
}
.menu:popover-open { display: block; }
.menu-head {
  margin: .2rem .5rem .45rem; color: var(--muted); font-size: .72rem; text-transform: uppercase;
  letter-spacing: .06em; font-weight: 600;
}
.menu-group {
  display: block; margin: .5rem .5rem .25rem; color: var(--muted); font-size: .72rem;
  text-transform: uppercase; letter-spacing: .06em; font-weight: 600;
}
.menu-item {
  display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
  gap: .1rem .5rem; padding: .35rem .5rem; border-radius: 7px; color: inherit;
  text-decoration: none; border: 1px solid transparent;
}
.menu-item:hover { background: var(--chip); }
.menu-item.current { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-fg); }
/* Flex, and never a column: the language stays on the left and the file it reads
   is pushed to the right edge, so the file names scan down the menu as one
   column. Nothing here may wrap, so a layout that disagrees still cannot put the
   file on a line of its own. */
.menu-item.with-sample { gap: 1rem; }
.menu-label { flex: none; font-weight: 600; white-space: nowrap; }
.menu-item.current .menu-label::after { content: " · current"; font-weight: 400; opacity: .7; }
.menu-blurb { flex: 1 0 100%; color: var(--muted); font-size: .8rem; }
.menu-item.current .menu-blurb { color: inherit; opacity: .8; }
.menu-sample {
  display: block; flex: none; color: var(--muted); font-size: .74rem; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.menu-item.current .menu-sample { color: inherit; opacity: .75; }

/* Three columns: targets, source, and the document as it renders. */
.split {
  display: grid; min-height: 0;
  grid-template-columns: minmax(270px, 23%) minmax(0, 38.5%) minmax(0, 38.5%);
}
.pane { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
.pane-left { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); border-right: 1px solid var(--line); }
.pane-mid { grid-template-rows: auto auto minmax(0, 1fr); border-right: 1px solid var(--line); background: var(--panel); }
.pane-right { grid-template-rows: auto minmax(0, 1fr); background: #ffffff; }
.col-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: .6rem;
  padding: .42rem .85rem; border-bottom: 1px solid var(--line); background: var(--head);
  font: 600 .72rem/1.4 ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
}
.col-note { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: .74rem; opacity: .85; }

/* The left pane is two stacked sections: the targets, then the description the
   selected one is explained by. */
.pane-left > .pane-section { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
.pane-left > .pane-section + .pane-section { border-top: 1px solid var(--line); }

.examples { list-style: none; margin: 0; padding: .3rem 1rem 2rem; overflow: auto; min-height: 0; }
.example { padding: .8rem 0 .9rem; border-bottom: 1px solid var(--line); }
.example:last-child { border-bottom: 0; }
.example h3 { display: flex; gap: .55rem; align-items: baseline; margin: 0 0 .4rem; font-size: 1rem; }
.example h3 .num {
  flex: none; min-width: 1.55rem; height: 1.55rem; border-radius: 50%; background: var(--chip);
  color: var(--muted); font: 600 .78rem/1.55rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: center;
}
.targets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .45rem; }
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
.target[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-fg); }
.target[aria-pressed="true"] .chip-file { color: inherit; opacity: .75; }

/* The description pane: the prose of the selected example, and nothing else —
   no snippet, since the target's text is what the middle column shows. */
.desc-panel { min-height: 0; overflow: auto; padding: .85rem 1rem 4rem; }
.desc-panel h2 {
  display: flex; gap: .55rem; align-items: baseline; margin: 0 0 .5rem;
  font-size: .95rem; text-transform: none; letter-spacing: 0; color: var(--fg);
}
.desc-panel h2 .num {
  flex: none; min-width: 1.4rem; height: 1.4rem; border-radius: 50%; background: var(--chip);
  color: var(--muted); font: 600 .74rem/1.4rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: center;
}
.desc-panel .desc { display: none; font-size: .92rem; }
.desc-panel .desc.active { display: block; }
.desc-panel .desc p { margin: .35rem 0 .7rem; }
.desc-panel .desc ul { margin: .35rem 0 .7rem; padding-left: 1.2rem; }
.desc-panel .desc h3 { margin: .9rem 0 .35rem; font-size: .95rem; }
.desc-panel .desc h4, .desc-panel .desc h5, .desc-panel .desc h6 { margin: .8rem 0 .3rem; font-size: .9rem; }
.desc-panel .desc code { background: var(--chip); border-radius: 4px; padding: .05rem .3rem; font-size: .87em; }
.desc-empty { margin: .3rem 0 .8rem; color: var(--muted); font-size: .84rem; }
.desc-note {
  padding: .1rem 0 .8rem; margin-bottom: .8rem; border-bottom: 1px solid var(--line);
  font-size: .92rem;
}
/* What the pane says before anything is selected: the sections that offer no
   example explain themselves here, and the hint says how to pick one. */
.desc-panel.filled .desc-empty, .desc-panel.filled .desc-note { display: none; }
.desc-note p { margin: .35rem 0 .7rem; }
.desc-note ul { margin: .35rem 0 .7rem; padding-left: 1.2rem; }
.desc-note li { margin: .15rem 0; }
.desc-note code { background: var(--chip); border-radius: 4px; padding: .05rem .3rem; font-size: .87em; }
.desc-note a { color: var(--accent); }

/* No tab strip: the header names the file, and a page is read one target at a
   time, so the pane shows one file at a time. The path is emphasised there
   because it is the answer to "where am I reading?". */
#source-path { color: var(--fg); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
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

/**
 * The navigation demo's own CSS: a jump page has no targets column, so the file
 * and the document share the width. Injection pages do not ship it.
 */
const JUMP_STYLE = `
/* A jump page has no targets column: the file and the document share the width. */
.split.source-document { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
`.trim();

/**
 * A navigation page's own script: the document's inline links are the
 * navigation, and a click puts the reader on the single line the reference lands
 * on. It runs after the shared script, which has already wired the source
 * column's header.
 */
const JUMP_SCRIPT = `
(function () {
  var lines = Array.prototype.slice.call(document.querySelectorAll('.line'));
  var markerHits = Array.prototype.slice.call(document.querySelectorAll('.md-marker'));
  var jumpLinks = Array.prototype.slice.call(document.querySelectorAll('.md-marker > a'));

  var sourcePath = document.getElementById('source-path');
  function showFile(name) {
    var files = Array.prototype.slice.call(document.querySelectorAll('.file'));
    files.forEach(function (file) { file.classList.toggle('active', file.dataset.file === name); });
    if (sourcePath) sourcePath.textContent = name;
  }

  // A jump click does one thing: put the reader on the line the reference lands
  // on. Nothing is injected, so there is no block to light up and no description
  // to swap — the prose around the link already says what it means.
  function jump(link) {
    var item = link.closest('[data-marker]');
    jumpLinks.forEach(function (other) { other.setAttribute('aria-current', String(other === link)); });
    lines.forEach(function (line) { line.classList.remove('hl'); });
    // The link's own href names the file it points into; the source column keys
    // its panes by the path as the *document* writes it. Both are known here, so
    // the match is made without a regular expression: no escaping survives a
    // nested template literal intact.
    var href = link.getAttribute('href').split('#')[0].split('/');
    var parts = href.filter(function (part) { return part !== '..' && part !== '' && part !== '.'; });
    var name = parts.join('/');
    var match = null;
    Array.prototype.forEach.call(document.querySelectorAll('.file'), function (file) {
      var candidate = file.dataset.file;
      var tail = name.slice(name.length - candidate.length);
      if (tail === candidate && (name.length === candidate.length || name.charAt(name.length - candidate.length - 1) === '/')) {
        if (match === null || candidate.length > match.length) match = candidate;
      }
    });
    showFile(match);
    if (match === null) return;

    // The reference lands on ONE line: the first line of what it selects.
    var from = Number(link.dataset.from);
    var to = Number(link.dataset.to);
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
    markerHits.forEach(function (hit) { hit.classList.remove('md-hit'); });
    if (item) item.classList.add('md-hit');
    if (first) first.scrollIntoView({ block: 'center' });
  }

  // Each link carries the line its reference lands on, resolved by the generator
  // from the very reference the link spells out.
  jumpLinks.forEach(function (link) {
    var item = link.closest('[data-marker]');
    var landing = (item && item.dataset.landing) ? item.dataset.landing.split('-') : [];
    link.dataset.from = landing[0] || '0';
    link.dataset.to = landing[1] || landing[0] || '0';
    link.addEventListener('click', function (event) {
      event.preventDefault();
      jump(link);
    });
  });
})();
`.trim();

const SCRIPT = `
(function () {
  var targets = Array.prototype.slice.call(document.querySelectorAll('.target'));
  var lines = Array.prototype.slice.call(document.querySelectorAll('.line'));
  var files = Array.prototype.slice.call(document.querySelectorAll('.file'));
  var mdSections = Array.prototype.slice.call(document.querySelectorAll('[data-md-section]'));
  var mdHits = Array.prototype.slice.call(document.querySelectorAll('.md-marker, .md-pre'));
  var descriptions = Array.prototype.slice.call(document.querySelectorAll('.desc'));

  // The examples menu is a popover: the browser opens it, light-dismisses it,
  // closes it on Escape and keeps it in the top layer, and the button that
  // invokes it is wired by popovertarget. A browser without the API gets the
  // button wired by hand and the data-open attribute the fallback CSS reads.
  if (!('showPopover' in HTMLElement.prototype)) {
    var menu = document.querySelector('.menu');
    var toggle = document.querySelector('.menu-toggle');
    if (menu && toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      var setMenu = function (open) {
        menu.toggleAttribute('data-open', open);
        toggle.setAttribute('aria-expanded', String(open));
      };
      toggle.addEventListener('click', function () { setMenu(!menu.hasAttribute('data-open')); });
      document.addEventListener('click', function (event) {
        if (menu.hasAttribute('data-open') && !menu.contains(event.target)) setMenu(false);
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && menu.hasAttribute('data-open')) { setMenu(false); toggle.focus(); }
      });
    }
  }

  // The column header says which file the pane is showing: there are no tabs, so
  // this is the only place that answers "where am I reading?".
  var sourcePath = document.getElementById('source-path');
  function showFile(name) {
    files.forEach(function (file) { file.classList.toggle('active', file.dataset.file === name); });
    if (sourcePath) sourcePath.textContent = name;
  }

  function select(target, keepScroll, keepHash) {
    var item = target.closest('.target-item');
    targets.forEach(function (other) { other.setAttribute('aria-pressed', String(other === target)); });
    // The link that was clicked stays visible: a description can be long, and
    // with the panel scrolled the target is what says which example it belongs to.
    if (!keepScroll) target.scrollIntoView({ block: 'nearest' });

    // The second left-hand section is the description of the selected example,
    // and only it: the example link itself never grows a footnote.
    descriptions.forEach(function (desc) {
      desc.classList.toggle('active', desc.dataset.desc === item.id);
    });
    var panel = document.querySelector('.desc-panel');
    if (panel) {
      panel.classList.toggle('filled', panel.querySelector('.desc.active') !== null);
      panel.scrollTop = 0;
    }

    lines.forEach(function (line) { line.classList.remove('hl'); });
    showFile(target.dataset.file);

    var from = Number(target.dataset.from);
    var to = Number(target.dataset.to);
    var ranges = (target.dataset.ranges || '').split(',').filter(Boolean).map(function (range) {
      var ends = range.split('-');
      return [Number(ends[0]), Number(ends[1])];
    });
    if (ranges.length === 0) ranges = [[from, to]];
    var shown = document.querySelector('.file.active');
    var first = null;
    if (shown) {
      Array.prototype.forEach.call(shown.querySelectorAll('.line'), function (line) {
        var n = Number(line.dataset.line);
        var hit = ranges.some(function (range) { return n >= range[0] && n <= range[1]; });
        if (hit) {
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

/**
 * The first left-hand section: numbered titles and their example links, and
 * nothing else — no prose, and no snippet below a link. What an example *means*
 * is the second section's business, and clicking a link swaps it there. A
 * section with no example of its own has no link to offer, so it is not listed
 * here; its prose is a note in the description pane instead.
 */
function renderSection(section, index) {
    const targets = section.examples
        .map((example) => [
            `<li class="target-item" id="${example.id}">`,
            `<button class="target" type="button" data-file="${escapeHtml(example.path)}"`,
            ` data-section="${example.section}"`,
            ` data-from="${example.from ?? 0}" data-to="${example.to ?? 0}"`,
            ` data-ranges="${(example.ranges ?? []).map(([from, to]) => `${from}-${to}`).join(',')}"`,
            ` aria-pressed="false" aria-controls="${example.id}-desc"`,
            ` title="${escapeHtml(example.raw)}">`,
            `<span class="chip-file">${escapeHtml(example.fileLabel)}</span>`,
            `<span class="chip-ref">${escapeHtml(example.label)}</span>`,
            `</button>`,
            `</li>`,
        ].join(''))
        .join('\n');

    return [
        `<li class="example" id="ex-${index + 1}">`,
        `<h3><span class="num">${index + 1}</span>${escapeHtml(section.title)}</h3>`,
        `<ul class="targets">`,
        targets,
        `</ul>`,
        `</li>`,
    ].join('\n');
}

/** The left column's list: the sections that have an example to offer. */
function renderSections(page) {
    return page.sections
        .filter((section) => section.examples.length > 0)
        .map((section) => renderSection(section, page.sections.indexOf(section)))
        .join('\n');
}

/**
 * The second left-hand section: the prose of the sections that have no example
 * to select — the overview's language index is the one that matters — then one
 * block per example, of which the selected one is the only one shown. Every
 * block carries its title, so the pane says what it is describing.
 */
function renderDescriptions(page) {
    const notes = page.sections
        .filter((section) => section.examples.length === 0 && section.note !== '')
        .map((section) => `<div class="desc-note"><h2>${escapeHtml(section.title)}</h2>${section.note}</div>`)
        .join('\n');

    const blocks = page.sections
        .flatMap((section, index) => section.examples.map((example) => [
            `<div class="desc" id="${example.id}-desc" data-desc="${example.id}">`,
            `<h2><span class="num">${index + 1}</span>${escapeHtml(example.title)}</h2>`,
            example.description,
            `</div>`,
        ].join('\n')))
        .join('\n');
    return notes === '' ? blocks : `${notes}\n${blocks}`;
}

/**
 * The source pane: one code pane per file the page's targets read, the first one
 * shown. Which file is on screen is named in the column header — and nothing else
 * is, because the page is read one target at a time.
 */
function renderFiles(files) {
    const panes = files
        .map((file, index) => `<div class="file${index === 0 ? ' active' : ''}" data-file="${escapeHtml(file.path)}"`
            + ` aria-label="${escapeHtml(file.display)}">`
            + `<pre class="code">${renderSourceLines(file)}</pre></div>`)
        .join('\n');
    return { panes, firstFile: files.length > 0 ? files[0].path : '' };
}

/**
 * The menu every page shares: a hamburger button and the popover it opens.
 *
 * The popover is the platform's own — light dismiss, Escape and the top layer
 * come with it — and CSS anchor positioning pins it to the button wherever the
 * banner puts that. The button's `popovertarget` makes it the popover's
 * invoker, so the two stay in step without a line of script.
 */
function renderMenu(page) {
    // The set's overview is the one page whose name says nothing about what it
    // holds, so it is the only entry that describes itself. The nav is in menu
    // order, and `order: 0` is the overview in every set.
    const overviewSlug = page.menu[0].slug;
    const items = page.menu
        .map((item, index, all) => {
            const note = item.group !== null && (index === 0 || all[index - 1].group !== item.group)
                ? `<span class="menu-group" role="presentation">${escapeHtml(item.group)}</span>`
                : '';
            const current = item.slug === page.slug;
            const sample = item.sample ? `<span class="menu-sample">${escapeHtml(item.sample)}</span>` : '';
            // Only the Overview says what it is; a language page is what its name
            // says it is, and a blurb under every entry made the menu a paragraph
            // to read instead of a list to scan.
            const blurb = item.slug === overviewSlug
                ? `<span class="menu-blurb">${escapeHtml(item.blurb)}</span>`
                : '';
            const classes = ['menu-item'];
            if (current) classes.push('current');
            if (sample !== '') classes.push('with-sample');
            if (blurb !== '') classes.push('with-blurb');
            return `${note}<a class="${classes.join(' ')}" href="${escapeHtml(item.href)}"`
                + `${current ? ' aria-current="page"' : ''}>`
                + `<span class="menu-label">${escapeHtml(item.label)}</span>`
                + sample
                + blurb
                + `</a>`;
        })
        .join('\n');

    return [
        `<button class="menu-toggle" type="button" popovertarget="menu" aria-label="Examples by language">`,
        `<span class="menu-bars" aria-hidden="true"></span>`,
        `<span class="menu-word">Examples</span>`,
        `</button>`,
        // The width is set inline as well as in the stylesheet, so a host that
        // serves a cached copy of the page's CSS cannot leave the menu narrow.
        `<nav class="menu" id="menu" popover aria-label="Example pages" style="width: min(28rem, 82vw)">`,
        `<p class="menu-head">One page per language</p>`,
        items,
        `</nav>`,
    ].join('\n');
}

/**
 * The whole page, as one self-contained HTML document — no network, no build
 * step, no runtime dependency. Open it from the filesystem and it works.
 */
export function renderPage(model) {
    const page = model.page;
    const { panes, firstFile } = renderFiles(page.files);
    const sections = renderSections(page);
    const descriptions = renderDescriptions(page);
    const title = `${page.isOverview ? 'Overview' : page.title} — ${SITE}`;
    // A jump page has no left column: the document's own inline links are the
    // navigation, so there is no list of targets and nothing to describe
    // separately — the prose around a link explains it where it is written.
    const linkOnly = model.layout === 'source-document';
    const leftPane = linkOnly ? '' : `<section class="pane pane-left" aria-label="Targets">
<div class="pane-section">
<div class="col-head">Targets<span class="col-note">titles and example links</span></div>
<ol class="examples">
${sections}
</ol>
</div>
<div class="pane-section">
<div class="col-head">Description<span class="col-note">of the selected example</span></div>
<div class="desc-panel">
<p class="desc-empty">Click an example link above to read what it demonstrates.</p>
${descriptions}
</div>
</div>
</section>`;
    // The column header names the file on screen, so the reader always knows
    // which sample the pane belongs to without a tab strip to scan.
    const sourceNote = linkOnly ? 'the line the reference lands on' : 'lines the target selects';
    const markdownNote = linkOnly
        ? 'the references, as they are written'
        : 'as it reads, injections in place';
    const markdownHead = linkOnly ? 'Code navigation' : 'Markdown';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}${linkOnly ? `\n${JUMP_STYLE}` : ''}
</style>
</head>
<body>
<div class="page">
<header class="page-head">
<div class="head-row">
<div class="head-title">
<div class="menu-wrap">
${renderMenu(page)}
</div>
<h1>${escapeHtml(page.isOverview ? model.title : page.title)}</h1>
</div>
<p class="note">Generated from <code>${escapeHtml(model.docPath)}</code> by <code>tools/build-demo.mjs</code> — edit the Markdown, not this file.</p>
</div>
${page.isOverview ? '' : `<p class="page-sub">${escapeHtml(page.blurb)}</p>`}
<div class="intro">
${page.introHtml}
</div>
</header>
<main class="split${linkOnly ? ' source-document' : ''}">
${leftPane}
<section class="pane pane-mid" aria-label="Source file">
<div class="col-head">Source file<span class="col-note" id="source-path" data-note="${sourceNote}">${escapeHtml(firstFile)}</span></div>
<div class="file-view">
${panes}
</div>
</section>
<section class="pane pane-right" aria-label="Rendered Markdown">
<div class="col-head">${markdownHead}<span class="col-note">${markdownNote}</span></div>
<div class="md-scroll">
<article class="md">
${page.markdownHtml}
</article>
</div>
</section>
</main>
</div>
<script>
${SCRIPT}
</script>${linkOnly ? `
<script>
${JUMP_SCRIPT}
</script>` : ''}
</body>
</html>
`;
}

/**
 * Build every page from a document and its target files: the model, and one
 * rendered page per file it writes.
 */
export function buildDemo(options = {}) {
    const model = buildModel(options);
    const html = model.pages.map((page) => ({ page, html: renderPage({ ...model, page }) }));
    return { html: html[0].html, model, pages: html };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/**
 * Parse `argv` and build, check or write every page. Returns the process exit
 * code and never calls `process.exit`, so tests can drive it.
 *
 * `--pages` may be given more than once, and each one is a complete build of its
 * own set — `--pages inject --pages jump` refreshes both demos in one run, which
 * is what `npm run demo` needs (a shell `;` does not survive npm's Windows shim).
 */
export function run(argv = [], io = {}) {
    const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
    const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
    const options = {
        root: REPO_ROOT, docPath: DEFAULT_DOC, outPath: DEFAULT_OUT, pages: PAGES, check: false,
        mode: 'inject', landing: false, layout: 'three-column',
    };
    // The sets named by `--pages`, in the order they were asked for. Empty means
    // the default, single-set build.
    const sets = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-c' || arg === '--check') options.check = true;
        else if (arg === '--root') options.root = resolve(argv[++i] ?? '.');
        else if (arg === '--doc') options.docPath = argv[++i];
        else if (arg === '-o' || arg === '--out') options.outPath = argv[++i];
        else if (arg === '--pages') {
            const name = argv[++i];
            const set = pageSet(name);
            if (set === null) {
                err(`build-demo: no page set named "${name}"; write ${Object.keys(PAGE_SETS).join(' or ')}`);
                return 2;
            }
            sets.push(set);
        }
        else if (arg === '-h' || arg === '--help') { out(HELP); return 0; }
        else { err(`build-demo: unknown argument: ${arg}`); return 2; }
    }

    if (sets.length > 0) {
        // One `--pages` alone builds that set; with `--doc`/`--out` also given,
        // the explicit paths win, which is what the tests drive.
        let status = 0;
        for (const set of sets) {
            const explicitDoc = argv.includes('--doc');
            const explicitOut = argv.includes('-o') || argv.includes('--out');
            status = Math.max(status, buildOne({
                ...options,
                pages: set.pages,
                docPath: explicitDoc ? options.docPath : set.docPath,
                outPath: explicitOut ? options.outPath : set.outPath,
                mode: set.mode,
                landing: set.landing,
                layout: set.layout,
            }, { out, err }));
        }
        return status;
    }

    return buildOne(options, { out, err });
}

/** Build, check or write one page set. Returns its exit code. */
function buildOne(options, { out, err }) {
    if (!options.docPath || !options.outPath) {
        err('build-demo: --doc and --out need a value');
        return 2;
    }

    let built;
    try {
        built = buildDemo({
            root: options.root,
            docPath: options.docPath,
            outPath: options.outPath,
            pages: options.pages,
            // How this set differs: a jump document links instead of injecting,
            // and its pages highlight a landing line in a two-column frame.
            mode: options.mode,
            landing: options.landing,
            layout: options.layout,
            onWarning: (m) => err(`build-demo: warn: ${m}`),
        });
    } catch (cause) {
        err(`build-demo: ${cause.message}`);
        return 1;
    }

    // `--out` says where the overview goes, and the language pages follow it. A
    // page that would land outside the overview's own directory would write into
    // the source tree, which is never what the flag meant, so refuse it.
    const outDir = posixDirname(slashes(options.outPath));
    const stray = built.pages.find(({ page }) => !page.isOverview && posixDirname(page.path) === outDir);
    if (stray) {
        err(`build-demo: ${options.outPath} leaves no room for the language pages beside it`);
        return 2;
    }

    // Every page, written or checked: a stale language page is as much a stale
    // page as a stale overview.
    const written = built.pages.map(({ page, html }) => {
        const file = resolve(options.root, page.path);
        return { page, file, html, current: existsSync(file) ? readFileSync(file, 'utf8') : null };
    });

    if (options.check) {
        const stale = written.filter((entry) => entry.current !== entry.html);
        if (stale.length === 0) {
            out(`ok      ${written.length} page(s)`);
            return 0;
        }
        for (const entry of stale) out(`${entry.current === null ? 'missing' : 'stale'} ${entry.page.path}`);
        out('Run: bun tools/build-demo.mjs');
        return 1;
    }

    let changed = 0;
    for (const entry of written) {
        if (entry.current === entry.html) continue;
        mkdirSync(dirname(entry.file), { recursive: true });
        writeFileSync(entry.file, entry.html);
        out(`wrote   ${entry.page.path}`);
        changed++;
    }
    if (changed === 0) out(`ok      ${written.length} page(s) (unchanged)`);
    else out(`built   ${written.length} page(s), ${built.model.exampleCount} target(s) in ${built.model.files.length} file(s)`);
    return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked || import.meta.main === true) {
    process.exitCode = run(process.argv.slice(2));
}
