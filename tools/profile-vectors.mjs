#!/usr/bin/env node
// @ts-check

/**
 * The **profile corpus**: the jump policy of RFC 2, as data.
 *
 * `test/vectors/section-vectors.json` pins what a reference *resolves to*. This
 * file pins the question that sits on top of it and is deliberately different
 * for each reading ([RFC 1 §5.2](../doc/rfc/section-mapping.md)):
 *
 *   - **`jump/editor`** may land on an approximation, and a target that is not
 *     `resolved` is useful — provided it says how it got there, which is what
 *     `cause` records.
 *   - **`jump/gate`** refuses every one of those bands, and the failure is a
 *     value: the code a host branches on, never a message it parses.
 *
 * So a row is discriminating only where the two readings **disagree**. A row that
 * both profiles answer the same way is not worth having for the policy — the
 * resolver corpus already covers it — and this generator says so rather than
 * padding the file with rows that prove nothing.
 *
 * The document half is the same question one level up: a whole document, and the
 * **every**-failure report a gate must produce in one pass. A gate that stops at
 * the first broken reference is useless as a fix list, so `broken.md` carries one
 * reference of every band and the corpus records all of them.
 *
 * Every file's content is embedded, so a consumer needs no disk:
 *
 *     const files = new Map(doc.files);
 *     const readFile = (path) => files.get(path);
 *
 *   node tools/profile-vectors.mjs           write/update the corpus
 *   node tools/profile-vectors.mjs --check   compare; exit 1 and diff on drift
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jump, jumpGate, isRefused, refusal } from '../lib/jump.mjs';
import { lexerFor } from '../src/js/scanner/lexers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'vectors', 'profile-vectors.json');
const FIXTURES = 'test/fixtures/jump';

/** The target files a profile row resolves against, and their own text. */
const TARGETS = [
    { path: 'Cart.java', id: 'cart' },
    { path: 'Duplicate.java', id: 'duplicate' },
];

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const sourceOf = (id) => {
    const target = TARGETS.find((entry) => entry.id === id);
    if (target === undefined) throw new Error(`no target fixture "${id}"`);
    return read(`${FIXTURES}/${target.path}`);
};

/**
 * The resolution rows. `editor` is what a reader gets; `gate` is the band a gate
 * refuses, or null when it resolves. Every row here is a case where at least one
 * of the two is not a plain `resolved` — the rows where the profiles differ, or
 * where the editor's `cause` is the whole point.
 */
const RESOLUTIONS = [
    // A line range the file does not reach: the gate refuses it, the editor
    // clamps to the end of the file the reader asked about.
    { input: 'cart', reference: 'L99', editor: { firstLine: 24, cause: 'nearest' },
      gate: 'resolution/line-range-past-end' },

    // A name that is gone: the deepest prefix that is not. This is the rung that
    // makes a rename survivable, so it is asserted by line, not just by cause.
    { input: 'cart', reference: 'Cart/Line/renderr', editor: { firstLine: 17, cause: 'nearest' },
      gate: 'resolution/not-found' },
    { input: 'cart', reference: 'Cart/Cart', editor: { firstLine: 7, cause: 'nearest' },
      gate: 'resolution/not-found' },
    { input: 'cart', reference: 'missing', editor: { firstLine: 1, cause: 'file-start' },
      gate: 'resolution/not-found' },

    // A property used as if it held something: found, and not a container.
    { input: 'cart', reference: 'items/nope', editor: { firstLine: 8, cause: 'nearest' },
      gate: 'resolution/not-a-container' },

    // A name two blocks answer to: the editor picks visibly and reports the
    // candidates; the gate refuses, because it cannot choose for the reader.
    { input: 'duplicate', reference: 'add', editor: { firstLine: 4, cause: 'ambiguous' },
      gate: 'resolution/ambiguous' },

    // Malformed as written: there is nothing to be nearest *to*, so the editor
    // lands in the right file and the repair advice rides in the diagnosis.
    { input: 'cart', reference: 'L99-', editor: { firstLine: 1, cause: 'file-start' },
      gate: 'grammar/line-range-not-a-range' },
    { input: 'cart', reference: '', editor: { firstLine: 1, cause: 'file-start' },
      gate: 'grammar/empty-reference' },
];

/** The document rows: a whole document through the gate. */
const DOCUMENTS = [
    {
        id: 'clean',
        document: 'clean.md',
        requestedFiles: ['Cart.java'],
        outcome: { passed: true, checked: 1, failures: [] },
        note: 'every reference resolves, so the gate is quiet',
    },
    {
        id: 'broken',
        document: 'broken.md',
        requestedFiles: ['Cart.java', 'Duplicate.java'],
        outcome: {
            passed: false,
            checked: 6,
            failures: [
                { reference: 'missing', code: 'resolution/not-found', selector: 'missing' },
                { reference: 'L99', code: 'resolution/line-range-past-end', selector: 'L99' },
                { reference: 'L99-', code: 'grammar/line-range-not-a-range', selector: 'L99-' },
                { reference: 'items/nope', code: 'resolution/not-a-container', selector: 'items' },
                { reference: 'add', code: 'resolution/ambiguous', selector: 'add' },
            ],
        },
        note: 'one reference of every band, and every failure is reported in one pass',
    },
];

/** One resolution row, as it is written. */
function buildResolution(c) {
    const source = sourceOf(c.input);
    const path = `${FIXTURES}/${TARGETS.find((entry) => entry.id === c.input).path}`;
    const file = path.slice(path.lastIndexOf('/') + 1);
    const lexer = lexerFor(file);

    const editor = jump(source, c.reference, { lexer, path: file });
    if (!editor.ok) {
        throw new Error(`${c.reference}: the editor must always land, but it did not`);
    }
    if (editor.target.cause !== c.editor.cause) {
        throw new Error(`${c.reference}: cause ${editor.target.cause}, expected ${c.editor.cause}`);
    }
    if (editor.target.firstLine !== c.editor.firstLine) {
        throw new Error(`${c.reference}: lands on ${editor.target.firstLine}, expected ${c.editor.firstLine}`);
    }

    const gate = jump(source, c.reference, { lexer, path: file, profile: 'jump/gate' });
    const gateCode = isRefused(gate) ? refusal(gate).code : null;    const expectedGate = c.gate ?? null;
    if (gateCode !== expectedGate) {
        throw new Error(`${c.reference}: gate code ${gateCode}, expected ${expectedGate}`);
    }
    // A row earns its place in *this* corpus when the policy shows in it: either
    // the two readings disagree (the gate refuses what the editor lands on), or
    // the editor's answer is something the resolver corpus does not record — a
    // landing line, or a `cause` that says the answer was approximated. What is
    // redundant is a row where the editor resolved *exactly* and the gate
    // resolved too: the resolver corpus already pins that, down to the bytes.
    if (gateCode === null && editor.target.cause === 'resolved') {
        throw new Error(`${c.reference}: both readings resolve exactly — that row belongs in the resolver corpus`);
    }

    const row = {
        name: c.input === 'cart' ? `cart:${c.reference}` : `${c.input}:${c.reference}`,
        file,
        reference: c.reference,
        editor: { firstLine: editor.target.firstLine, cause: editor.target.cause },
        gate: gateCode,
    };
    if (c.note !== undefined) row.note = c.note;
    return row;
}

/** One document row, as it is written. */
function buildDocument(c) {
    const text = read(`${FIXTURES}/${c.document}`);
    const files = c.requestedFiles.map((path) => [
        path,
        read(`${FIXTURES}/${path}`),
    ]);
    const gate = jumpGate(text, {
        readFile: (path) => {
            const found = files.find(([name]) => name === path);
            if (found === undefined) throw new Error(`ENOENT: ${path}`);
            return found[1];
        },
    });

    if (gate.passed !== c.outcome.passed) {
        throw new Error(`${c.document}: passed ${gate.passed}, expected ${c.outcome.passed}`);
    }
    if (gate.checked !== c.outcome.checked) {
        throw new Error(`${c.document}: checked ${gate.checked}, expected ${c.outcome.checked}`);
    }
    const actual = gate.failures.map((failure) => ({
        reference: failure.reference,
        code: failure.code,
        selector: failure.selector,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(c.outcome.failures)) {
        throw new Error(`${c.document}: failures\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(c.outcome.failures)}`);
    }

    return {
        name: c.document.replace(/\.md$/, ''),
        document: text,
        files,
        outcome: {
            passed: c.outcome.passed,
            checked: c.outcome.checked,
            failures: actual,
        },
        ...(c.note === undefined ? {} : { note: c.note }),
    };
}

const corpus = {
    $comment: [
        'Generated by tools/profile-vectors.mjs — do not hand-edit.',
        'The jump policy of RFC 2: what an editor lands on, what a gate refuses.',
        'A row is discriminating only where the two readings disagree; the generator',
        'refuses a row that both answer the same way. Asserted by test.mjs, and by',
        'test/vectors/manifest.json, which maps the suite for a port.',
    ],
    spec: 'jump',
    version: '0.1-draft',
    normative: 'doc/rfc/code-jump.md',
    profiles: ['jump/editor', 'jump/gate'],
    resolutions: RESOLUTIONS.map(buildResolution),
    documents: DOCUMENTS.map(buildDocument),
};

const serialise = () => `${JSON.stringify(corpus, null, 2)}\n`;
const out = serialise();

if (process.argv.includes('--check')) {
    let committed;
    try {
        committed = readFileSync(OUT, 'utf8');
    } catch {
        console.error('test/vectors/profile-vectors.json is missing; run: node tools/profile-vectors.mjs');
        process.exit(1);
    }
    if (committed === out) {
        console.log('profile-vectors: ok');
        process.exit(0);
    }
    const want = committed.replace(/\r\n/g, '\n').split('\n');
    const have = out.replace(/\r\n/g, '\n').split('\n');
    console.error('profile-vectors drift: the corpus does not match lib/jump.mjs.');
    for (let i = 0; i < Math.max(want.length, have.length); i++) {
        if (want[i] !== have[i]) {
            console.error(`  line ${i + 1}:`);
            console.error(`    committed: ${JSON.stringify(want[i] ?? '')}`);
            console.error(`    expected:  ${JSON.stringify(have[i] ?? '')}`);
        }
    }
    process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out, 'utf8');
console.log(`wrote ${corpus.resolutions.length} resolution and ${corpus.documents.length} document profile vectors to test/vectors/profile-vectors.json`);
