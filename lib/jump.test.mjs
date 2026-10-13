/**
 * Tests for the code-jump profile — `lib/jump.mjs`, RFC 2.
 *
 * The resolver's own correctness is the main suite's business and the corpus's;
 * what these tests pin is the **policy** on top of it: which line a cursor lands
 * on, what a failure means to an editor, and what it means to a gate. The two
 * readings are deliberately different, so a test that passes under both proves
 * nothing — every assertion here is chosen to fail if the profiles collapse.
 *
 *   node --test lib/jump.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jump, jumpGate, isProfile, PROFILES } from './jump.mjs';
import { ERROR_CODES } from './section.mjs';
import { lexerFor } from '../src/js/scanner/lexers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => readFileSync(join(ROOT, 'test/fixtures', name), 'utf8');
/** A jump fixture, whose directory the corpus records relative to `test/fixtures`. */
const jumpFixture = (name) => fixture(`jump/${name}`);

/** Example.java: `Cart` opens on 7, `toString` is 12–14, `Line` 17–29, `render` 26–28. */
const EXAMPLE = fixture('Example.java');
const EXAMPLE_LEXER = lexerFor('Example.java');
/** Two `add` methods at one level: the ambiguity band, in its smallest shape. */
const DUPLICATE = fixture('Duplicate.java');
const DUPLICATE_LEXER = lexerFor('Duplicate.java');

/** A jump over `Example.java`, with the file named as the link would name it. */
const at = (reference, profile) => jump(EXAMPLE, reference, {
    lexer: EXAMPLE_LEXER, path: 'Example.java', profile,
});

test('RFC 2 §3.1: a resolved jump lands on the first range, not on startLine', () => {
    const resolved = at('toString');
    assert.equal(resolved.ok, true);
    assert.equal(resolved.target.cause, 'resolved');
    assert.equal(resolved.target.firstLine, 12);
    assert.equal(resolved.target.lineCount, 3);
    assert.equal(resolved.target.plan.text, at('toString').target.plan.text, 'the plan is the resolver\'s own');

    // The reference names line 26 first, then a method near the top: `startLine` is
    // the outermost bound (12) and the cursor belongs on 26, because that is what
    // was written first (RFC 1 §3.5).
    const mixed = at('L26,toString');
    assert.equal(mixed.target.plan.startLine, 12);
    assert.equal(mixed.target.firstLine, 26);
    assert.notEqual(mixed.target.firstLine, mixed.target.plan.startLine,
        'firstLine is not startLine, and a jump that confuses them lands in the wrong place');
});

test('RFC 2 §3.3: an envelope lands on the head, and a modifier lands where it asked', () => {
    const envelope = at('Cart/^,toString,$');
    assert.equal(envelope.target.cause, 'resolved');
    assert.equal(envelope.target.firstLine, 7, 'the head: the parent declaration line');
    assert.equal(envelope.target.plan.ranges.length, 3);

    assert.equal(at('Cart/Line/render/-').target.firstLine, 27, '`-` lands on the body');
    assert.equal(at('Cart/Line/render').target.firstLine, 26, 'the declaration lands on the signature');
});

test('RFC 2 §4.4: a range past the end clamps to the last line in an editor, and fails a gate', () => {
    const lines = EXAMPLE.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
    const editor = at('L31');
    assert.equal(editor.ok, true, 'an editor never fails a keystroke it can land');
    assert.equal(editor.target.cause, 'nearest');
    assert.equal(editor.target.firstLine, lines, 'the end of the file the reader asked about');

    const gate = at('L31', 'jump/gate');
    assert.equal(gate.ok, false);
    assert.equal(gate.failure.code, ERROR_CODES.LINE_RANGE_PAST_END);
});

test('RFC 2 §4.3: a name that is gone lands on the deepest prefix that is not', () => {
    // The rung that makes a rename survivable: `render` renamed to `paint` leaves
    // the reference `Cart/Line/render` landing on `Line`, one keystroke from the
    // new name, rather than at the file head.
    const nearest = at('Cart/Line/renderr');
    assert.equal(nearest.ok, true);
    assert.equal(nearest.target.cause, 'nearest');
    assert.equal(nearest.target.firstLine, 17, '`Line` starts at 17');
    assert.equal(nearest.target.code, ERROR_CODES.NOT_FOUND, 'the diagnosis rides along');

    // Nothing of the path resolves, so the rung below it is the file itself.
    const head = at('nope/deeper');
    assert.equal(head.ok, true);
    assert.equal(head.target.cause, 'file-start');
    assert.equal(head.target.firstLine, 1);

    // A malformed reference was never resolved, so there is no prefix to walk:
    // the file is still the right place, and the advice names the repair.
    const malformed = at('L40-');
    assert.equal(malformed.target.cause, 'file-start');
    assert.equal(malformed.target.code, ERROR_CODES.LINE_RANGE_NOT_A_RANGE);
    assert.ok(malformed.target.diagnosis.advice !== null, 'a grammar failure carries the repair');
});

test('RFC 2 §4.2: an ambiguous name is picked visibly in an editor and refused by a gate', () => {
    const editor = jump(DUPLICATE, 'add', {
        lexer: DUPLICATE_LEXER, path: 'Duplicate.java',
    });
    assert.equal(editor.ok, true);
    assert.equal(editor.target.cause, 'ambiguous', 'never a silent choice');
    assert.equal(editor.target.code, ERROR_CODES.AMBIGUOUS);
    assert.ok(Array.isArray(editor.target.candidates) && editor.target.candidates.length === 2,
        'the candidates are reported, so a host can offer a picker');
    assert.ok(Number.isInteger(editor.target.firstLine));
    assert.equal(editor.target.plan, null, 'an approximation never hands back a plan');

    const gate = jump(DUPLICATE, 'add', {
        lexer: DUPLICATE_LEXER, path: 'Duplicate.java', profile: 'jump/gate',
    });
    assert.equal(gate.ok, false, 'the gate cannot pick, so it fails');
    assert.equal(gate.failure.code, ERROR_CODES.AMBIGUOUS);
});

test('RFC 2 §5: the profiles are the same on a resolve and opposite on a failure', () => {
    assert.deepEqual([...PROFILES], ['jump/editor', 'jump/gate']);
    assert.equal(isProfile('jump/gate'), true);
    assert.equal(isProfile('jump/IDE'), false, 'a typo is not a profile');

    // The same exact reference answers identically: the gate is not a stricter
    // resolver, it is a different policy over one resolver.
    for (const reference of ['toString', 'Cart/Line/render/-', 'L26,toString', 'Cart/^,toString,$']) {
        const editor = at(reference);
        const gate = at(reference, 'jump/gate');
        assert.equal(gate.ok, true, `${reference} resolves for the gate too`);
        assert.deepEqual(gate.target, editor.target, `${reference}: one answer, two policies`);
    }

    // Every band the gate refuses is a band the editor lands.
    for (const reference of ['renderr', 'Cart/Cart', 'L31', 'L40-', '']) {
        assert.equal(at(reference).ok, true, `editor lands on "${reference}"`);
        assert.equal(at(reference, 'jump/gate').ok, false, `gate refuses "${reference}"`);
    }
});

test('RFC 2 §2: an unknown profile is a programming error, not a reference failure', () => {
    assert.throws(() => at('toString', 'jump/lenient'), /is not a jump profile/);
});

test('RFC 2 §5.1: the gate reports every failing reference in one run', () => {
    const doc = [
        '[Example.java#toString](Example.java#toString)',
        '',
        '```java',
        'x',
        '```',
        '',
        '[Example.java#renderr](Example.java#renderr)',
        '',
        '```java',
        'y',
        '```',
        '',
        '[Example.java#L40-](Example.java#L40-)',
        '',
        '```java',
        'z',
        '```',
        '',
        '[Example.java#L31](Example.java#L31)',
        '',
        '```java',
        'w',
        '```',
    ].join('\n');
    const read = (path) => {
        if (path === 'Example.java') return EXAMPLE;
        throw new Error(`ENOENT: ${path}`);
    };

    const gate = jumpGate(doc, { readFile: read, lexerFor });
    assert.equal(gate.checked, 4, 'every marker is looked at, not just the first broken one');
    assert.equal(gate.passed, false);
    assert.deepEqual(gate.failures.map((failure) => failure.reference),
        ['renderr', 'L40-', 'L31'], 'one marker resolves; three do not, and all three are reported');
    assert.deepEqual(gate.failures.map((failure) => failure.code),
        [ERROR_CODES.NOT_FOUND, ERROR_CODES.LINE_RANGE_NOT_A_RANGE, ERROR_CODES.LINE_RANGE_PAST_END]);
    assert.deepEqual(gate.failures.map((failure) => failure.selector), ['renderr', 'L40-', 'L31'],
        'the selector at fault is reported, not only the prose');
    for (const failure of gate.failures) {
        assert.equal(failure.path, 'Example.java');
        assert.equal(typeof failure.message, 'string');
        assert.ok(failure.message.length > 0);
    }
});

test('RFC 2 §5.1: a clean document passes the gate, and a file it cannot read is a failure', () => {
    const clean = [
        '[Example.java#toString](Example.java#toString)',
        '',
        '```java',
        'x',
        '```',
    ].join('\n');
    const gate = jumpGate(clean, { readFile: () => EXAMPLE, lexerFor });
    assert.equal(gate.passed, true);
    assert.equal(gate.checked, 1);
    assert.deepEqual(gate.failures, []);

    const missing = jumpGate(clean, {
        readFile: () => { throw new Error('ENOENT: no such file'); },
        lexerFor,
    });
    assert.equal(missing.passed, false);
    assert.equal(missing.failures.length, 1);
    assert.match(missing.failures[0].message, /ENOENT/);
    assert.equal(missing.failures[0].code, null, 'the file could not be read, so there is no band to report');

    assert.throws(() => jumpGate(clean, {}), /needs a readFile/);
});

// ---------------------------------------------------------------------------
// The profile corpus: the policy, as data
// ---------------------------------------------------------------------------
//
// `test/vectors/profile-vectors.json` is generated from this implementation by
// `tools/profile-vectors.mjs`, and a port that implements a profile is held to
// it. The rows are only the cases where the policy shows — where the two
// readings disagree, or where the editor's answer is one the resolver corpus
// does not record. A row both readings answer exactly is not in the file, and the
// generator refuses one.

const PROFILE_CORPUS = JSON.parse(
    readFileSync(join(ROOT, 'test/vectors/profile-vectors.json'), 'utf8'),
);

test('profile corpus §1: the file describes the policy, and every profile it names exists', () => {
    assert.equal(PROFILE_CORPUS.spec, 'jump');
    assert.deepEqual(PROFILE_CORPUS.profiles, [...PROFILES], 'the corpus names exactly the profiles this module has');
    assert.ok(PROFILE_CORPUS.resolutions.length >= 8, 'a substantial policy set');
    assert.ok(PROFILE_CORPUS.documents.length >= 2, 'the document half is covered too');
});

test('profile corpus §2: the editor corpus rows are the landing lines, and no row is self-satisfied', () => {
    for (const row of PROFILE_CORPUS.resolutions) {
        const source = jumpFixture(row.file);
        const lexer = lexerFor(row.file);

        const editor = jump(source, row.reference, { lexer, path: row.file });
        assert.equal(editor.ok, true, `${row.name}: the editor always lands`);
        assert.equal(editor.target.cause, row.editor.cause, `${row.name}: cause`);
        assert.equal(editor.target.firstLine, row.editor.firstLine, `${row.name}: landing line`);

        // No row may be one where both readings resolve exactly: that is the
        // resolver corpus's business, and the generator refuses it too.
        const gate = jump(source, row.reference, { lexer, path: row.file, profile: 'jump/gate' });
        const bothExact = gate.ok && editor.target.cause === 'resolved';
        assert.equal(bothExact, false, `${row.name}: a row both readings answer exactly proves nothing about the policy`);
    }
});

test('profile corpus §3: the editor is the only tolerant reading, exactly as far as the rows say', () => {
    for (const row of PROFILE_CORPUS.resolutions) {
        const source = jumpFixture(row.file);
        const lexer = lexerFor(row.file);
        const gate = jump(source, row.reference, { lexer, path: row.file, profile: 'jump/gate' });

        if (row.gate === null) {
            assert.equal(gate.ok, true, `${row.name}: the gate resolves this one too`);
            continue;
        }
        assert.equal(gate.ok, false, `${row.name}: the gate refuses what the editor lands on`);
        assert.equal(gate.failure.code, row.gate, `${row.name}: the band the gate refuses`);
        // The band must be a real code, not a string that merely looks like one.
        assert.ok(Object.values(ERROR_CODES).includes(row.gate), `${row.name}: "${row.gate}" is in the registry`);

        // And the editor really did land somewhere: a gate row is only interesting
        // because the other reading still answered.
        const editor = jump(source, row.reference, { lexer, path: row.file });
        assert.equal(editor.ok, true, `${row.name}: the editor answers where the gate refuses`);
    }
});

test('profile corpus §4: a document row reports every failing reference in one pass', () => {
    for (const row of PROFILE_CORPUS.documents) {
        const files = new Map(row.files);
        const gate = jumpGate(row.document, {
            readFile: (path) => {
                if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
                return files.get(path);
            },
        });

        assert.equal(gate.passed, row.outcome.passed, `${row.name}: passed`);
        assert.equal(gate.checked, row.outcome.checked, `${row.name}: checked`);
        assert.deepEqual(
            gate.failures.map((failure) => ({
                reference: failure.reference,
                code: failure.code,
                selector: failure.selector,
            })),
            row.outcome.failures,
            `${row.name}: every failure, with the band and the selector at fault`,
        );
        // A gate is a fix list: the rows must be more than one where the document
        // has more than one broken reference, or "reports everything" is untested.
        if (row.outcome.failures.length > 1) {
            assert.ok(gate.failures.length > 1, `${row.name}: this document exists to prove one pass reports all of them`);
        }
    }
});

test('profile corpus §5: the row keys are pinned, so a port reads one shape', () => {
    for (const row of PROFILE_CORPUS.resolutions) {
        const keys = Object.keys(row).filter((key) => key !== 'note').sort();
        assert.deepEqual(keys, ['editor', 'file', 'gate', 'name', 'reference'], `${row.name}: resolution row keys`);
        assert.deepEqual(Object.keys(row.editor).sort(), ['cause', 'firstLine'], `${row.name}: editor keys`);
    }
    for (const row of PROFILE_CORPUS.documents) {
        const keys = Object.keys(row).filter((key) => key !== 'note').sort();
        assert.deepEqual(keys, ['document', 'files', 'name', 'outcome'], `${row.name}: document row keys`);
        for (const failure of row.outcome.failures) {
            assert.deepEqual(Object.keys(failure).sort(), ['code', 'reference', 'selector'],
                `${row.name}: failure row keys`);
        }
    }
    // Everything a consumer needs is embedded: a port needs no disk to run this.
    for (const row of PROFILE_CORPUS.documents) {
        assert.ok(typeof row.document === 'string' && row.document.length > 0, `${row.name}: the document text is embedded`);
        assert.ok(Array.isArray(row.files) && row.files.length > 0, `${row.name}: the files it reads are embedded`);
        for (const [path, text] of row.files) {
            assert.equal(typeof path, 'string');
            assert.equal(typeof text, 'string');
        }
    }
});
