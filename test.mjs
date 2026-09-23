/**
 * Tests for inject-examples. Run with `npm test` (node --test).
 *
 * The library is exercised entirely in memory — every read goes through a stub
 * `readFile`, so no fixture tree is needed and no file is ever written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    extractRegion,
    fenceRanges,
    fileReader,
    findMarkers,
    injectInto,
    isIgnoredPath,
    normalize,
    parseIgnoreFile,
    parseMarker,
    regionDirective,
    resolveMarker,
    updateDocument,
} from './index.mjs';

import { main, parseArgs, UsageError } from './cli.mjs';

/** A `readFile` stub over a plain object of path -> text. */
const reader = (files) => (path) => {
    if (!(path in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = 'ENOENT';
        throw err;
    }
    return files[path];
};

// ---------------------------------------------------------------------------
// regionDirective
// ---------------------------------------------------------------------------

test('regionDirective accepts the common comment spellings', () => {
    const cases = [
        ['#region table', 'region', 'table'],
        ['#endregion', 'endregion', ''],
        ['// #region table', 'region', 'table'],
        ['//region table', 'region', 'table'],
        ['// #endregion', 'endregion', ''],
        ['<!-- #region table -->', 'region', 'table'],
        ['/* #region table */', 'region', 'table'],
        ['-- #region table', 'region', 'table'],
        ['; #region table', 'region', 'table'],
        ['REM #region table', 'region', 'table'],
        ['    #region  spaced   name  ', 'region', 'spaced   name'],
        ['#region', 'region', ''],
    ];
    for (const [line, kind, name] of cases) {
        assert.deepEqual(regionDirective(line), { kind, name }, `line: ${line}`);
    }
});

test('regionDirective ignores prose and unknown words', () => {
    assert.equal(regionDirective('region table'), null, 'a bare `region` line is prose');
    assert.equal(regionDirective('endregion'), null, 'a bare `endregion` line is prose');
    assert.equal(regionDirective('The #region directive is nice.'), null);
    assert.equal(regionDirective(''), null);
    assert.equal(regionDirective('# regional planning'), null, 'prefix must match a whole word');
});

// ---------------------------------------------------------------------------
// extractRegion
// ---------------------------------------------------------------------------

test('extractRegion returns the lines between the directives, exclusive', () => {
    const text = ['before', '#region table', 'a', 'b', '#endregion', 'after'].join('\n');
    assert.equal(extractRegion(text, 'table'), 'a\nb');
});

test('extractRegion handles CRLF and empty regions', () => {
    const crlf = ['#region t', 'a', '#endregion'].join('\r\n');
    assert.equal(extractRegion(crlf, 't'), 'a');
    assert.equal(extractRegion('#region t\n#endregion', 't'), '');
});

test('extractRegion fails loudly on missing, ambiguous and unclosed regions', () => {
    assert.throws(() => extractRegion('#region other\nx\n#endregion', 'table'), /no "#region table" found/);
    assert.throws(
        () => extractRegion('#region t\n#endregion\n#region t\n#endregion', 't'),
        /appears 2 times/,
    );
    assert.throws(() => extractRegion('#region t\nx', 't'), /never closed/);
});

// ---------------------------------------------------------------------------
// parseMarker
// ---------------------------------------------------------------------------

test('parseMarker reads a whole-file marker', () => {
    assert.deepEqual(parseMarker('[fixtures/a.md](./fixtures/a.md)'), {
        raw: '[fixtures/a.md](./fixtures/a.md)',
        path: 'fixtures/a.md',
        region: null,
    });
    assert.deepEqual(parseMarker('[fixtures/a.md](fixtures/a.md)')?.path, 'fixtures/a.md');
    assert.deepEqual(parseMarker('  [a.md](./a.md)  ')?.raw, '[a.md](./a.md)', 'outer space is trimmed');
});

test('parseMarker reads a region marker', () => {
    assert.deepEqual(parseMarker('[src/app.ts](./src/app.ts#region:table)'), {
        raw: '[src/app.ts](./src/app.ts#region:table)',
        path: 'src/app.ts',
        region: 'table',
    });
});

test('parseMarker leaves ordinary links alone', () => {
    assert.equal(parseMarker('[the docs](./docs/README.md)'), null, 'label must name the path');
    assert.equal(parseMarker('[a.md](./a.md#install)'), null, 'only `region:` is special');
    assert.equal(parseMarker('[https://x.dev](https://x.dev)'), null, 'a URL is not a path');
    assert.equal(parseMarker('[a.md](./a.md) and more'), null, 'the line must be only the link');
    assert.equal(parseMarker('plain text'), null);
    assert.equal(parseMarker(''), null);
});

test('findMarkers keeps document order', () => {
    const lines = ['# T', '[a.md](./a.md)', '```', 'x', '```', '[b.md](./b.md)'];
    assert.deepEqual(findMarkers(lines).map((m) => m.path), ['a.md', 'b.md']);
});

// ---------------------------------------------------------------------------
// normalize / resolveMarker
// ---------------------------------------------------------------------------

test('normalize strips CRLF and one trailing newline', () => {
    assert.equal(normalize('a\r\nb\r\n'), 'a\nb');
    assert.equal(normalize('a\nb\n'), 'a\nb');
    assert.equal(normalize('a\nb'), 'a\nb', 'no trailing newline is left alone');
    assert.equal(normalize('a\n\n'), 'a\n', 'only one newline goes');
});

test('resolveMarker reads a whole file or one region of it', () => {
    const files = {
        'whole.md': 'one\ntwo\n',
        'big.md': '#region table\n| a |\n#endregion\nunused\n',
    };
    const read = reader(files);
    assert.equal(resolveMarker(parseMarker('[whole.md](./whole.md)'), read), 'one\ntwo');
    assert.equal(
        resolveMarker(parseMarker('[big.md](./big.md#region:table)'), read),
        '| a |',
    );
});

test('fileReader resolves relative paths against its root', () => {
    const text = fileReader(dirname(fileURLToPath(import.meta.url)))('package.json');
    assert.match(text, /"name": "inject-examples"/);
});

// ---------------------------------------------------------------------------
// injectInto
// ---------------------------------------------------------------------------

test('injectInto replaces the block body and reports a change', () => {
    const lines = ['[a.md](./a.md)', '```markdown', 'old', '```'];
    const result = injectInto(lines, '[a.md](./a.md)', 'new\ntext');
    assert.deepEqual(result.lines, ['[a.md](./a.md)', '```markdown', 'new', 'text', '```']);
    assert.equal(result.changed, true);
});

test('injectInto reports no change when the body already matches', () => {
    const lines = ['[a.md](./a.md)', '```', 'same', '```'];
    assert.equal(injectInto(lines, '[a.md](./a.md)', 'same').changed, false);
});

test('injectInto tolerates blank lines but not stray text before the fence', () => {
    const blank = ['[a.md](./a.md)', '', '', '```', 'x', '```'];
    assert.equal(injectInto(blank, '[a.md](./a.md)', 'y').changed, true);
    const stray = ['[a.md](./a.md)', 'prose', '```', 'x', '```'];
    assert.throws(() => injectInto(stray, '[a.md](./a.md)', 'y'), /expected a fenced code block/);
});

test('injectInto fails when the block is missing or unclosed', () => {
    assert.throws(() => injectInto(['[a.md](./a.md)'], '[a.md](./a.md)', 'x'), /no code block/);
    assert.throws(() => injectInto(['[a.md](./a.md)', '```', 'x'], '[a.md](./a.md)', 'x'), /unclosed/);
    assert.throws(() => injectInto(['nope'], '[a.md](./a.md)', 'x'), /marker not found/);
});

// ---------------------------------------------------------------------------
// updateDocument
// ---------------------------------------------------------------------------

const DOC = [
    '# Title',
    '',
    '[fixtures/one.md](./fixtures/one.md)',
    '',
    '```markdown',
    'stale content',
    '```',
    '',
    'Some prose.',
    '',
    '[fixtures/big.md](./fixtures/big.md#region:table)',
    '',
    '```markdown',
    'stale region',
    '```',
    '',
].join('\n');

const FILES = {
    'fixtures/one.md': 'first line\nsecond line\n',
    'fixtures/big.md': 'noise\n#region table\n| a | b |\n#endregion\nnoise\n',
};

test('updateDocument rewrites every marker and is idempotent', () => {
    const read = reader(FILES);
    const first = updateDocument(DOC, { readFile: read });

    assert.equal(first.markers.length, 2);
    assert.equal(first.changed, true);
    assert.deepEqual(first.results.map((r) => r.changed), [true, true]);
    assert.match(first.text, /first line\nsecond line/);
    assert.match(first.text, /\| a \| b \|/);
    assert.doesNotMatch(first.text, /stale content|stale region/);

    const second = updateDocument(first.text, { readFile: read });
    assert.equal(second.changed, false, 'a second pass is a no-op');
    assert.deepEqual(second.results.map((r) => r.changed), [false, false]);
    assert.equal(second.text, first.text);
});

test('updateDocument keeps surrounding text intact', () => {
    const { text } = updateDocument(DOC, { readFile: reader(FILES) });
    assert.match(text, /^# Title\n/);
    assert.match(text, /\nSome prose\.\n/);
    assert.ok(text.endsWith('```\n'), 'trailing newline survives');
});

test('updateDocument reports an empty document rather than throwing', () => {
    const result = updateDocument('# No markers here\n', { readFile: reader({}) });
    assert.deepEqual(result.markers, []);
    assert.equal(result.changed, false);
});

test('updateDocument surfaces a bad marker path with its marker', () => {
    const doc = ['[missing.md](./missing.md)', '```', 'x', '```'].join('\n');
    assert.throws(
        () => updateDocument(doc, { readFile: reader({}) }),
        /\[missing\.md\]\(\.\/missing\.md\): ENOENT/,
    );
});

test('updateDocument rejects a duplicated marker', () => {
    const doc = ['[a.md](./a.md)', '```', 'x', '```', '[a.md](./a.md)', '```', 'y', '```'].join('\n');
    assert.throws(() => updateDocument(doc, { readFile: reader({ 'a.md': 'z' }) }), /duplicate marker/);
});

// ---------------------------------------------------------------------------
// Fence scanning
// ---------------------------------------------------------------------------

test('fenceRanges finds balanced, nested and unclosed fences', () => {
    const simple = ['text', '```', 'x', '```', 'end'];
    assert.deepEqual(fenceRanges(simple), [[1, 3]]);

    // An inner fence one backtick short does not close the outer fence.
    const nested = ['````', '```', 'x', '```', '````'];
    assert.deepEqual(fenceRanges(nested), [[0, 4]]);

    // An unclosed fence swallows the rest of the document.
    const unclosed = ['```', 'x', 'y'];
    assert.deepEqual(fenceRanges(unclosed), [[0, 2]]);

    // Indented fences (list or block quote nesting) still count.
    const indented = ['intro', '   ```js', '   x', '   ```', 'out'];
    assert.deepEqual(fenceRanges(indented), [[1, 3]]);
});

test('findMarkers skips marker lines inside fences and reports their index', () => {
    const lines = [
        '# doc',
        '```markdown',
        '[a.md](./a.md)',
        '```',
        '[b.md](./b.md)',
        '```',
        'old',
        '```',
    ];
    const markers = findMarkers(lines);
    assert.deepEqual(markers.map((m) => [m.path, m.index]), [['b.md', 4]]);
});

// ---------------------------------------------------------------------------
// extractRegion — interleaving
// ---------------------------------------------------------------------------

test('extractRegion rejects interleaved regions', () => {
    const text = ['#region a', '#region b', 'x', '#endregion', '#endregion'].join('\n');
    assert.throws(() => extractRegion(text, 'a'), /interleaved with "#region b"/);
});

// ---------------------------------------------------------------------------
// injectInto — fence length and line index
// ---------------------------------------------------------------------------

test('injectInto closes only on a fence at least as long as the opener', () => {
    // A shorter inner fence is content, not a closer.
    const inner = ['[a.md](./a.md)', '````', '```', 'inner', '```', '````'];
    const byIndex = injectInto(inner, '[a.md](./a.md)', 'x', 0);
    assert.deepEqual(byIndex.lines, ['[a.md](./a.md)', '````', 'x', '````']);

    // An equal-length fence closes the block.
    const equal = ['[a.md](./a.md)', '````', '```', '````'];
    const byText = injectInto(equal, '[a.md](./a.md)', 'y');
    assert.deepEqual(byText.lines, ['[a.md](./a.md)', '````', 'y', '````']);
});

test('updateDocument handles CRLF documents without reformatting them', () => {
    const doc = ['[a.md](./a.md)', '', '```markdown', 'stale', '```'].join('\r\n');
    const options = { root: process.cwd(), readFile: reader({ 'a.md': 'real\r\n' }), gitignore: false };

    const first = updateDocument(doc, options);
    assert.equal(first.changed, true);
    assert.ok(first.text.includes('\r\n'), 'CRLF endings are preserved');

    const second = updateDocument(first.text, options);
    assert.equal(second.changed, false, 'a CRLF document must not read as stale');
});

test('updateDocument stays stable when file content contains marker-like lines', () => {
    const files = {
        'a.md': '[probe.md](./probe.md)\nreal content\n',
        'probe.md': 'probe\n',
    };
    const doc = ['[a.md](./a.md)', '```', 'stale', '```'].join('\n');
    const read = reader(files);
    const options = { root: process.cwd(), readFile: read, gitignore: false };

    const first = updateDocument(doc, options);
    assert.equal(first.changed, true);
    assert.match(first.text, /real content/);

    const second = updateDocument(first.text, options);
    assert.equal(second.changed, false, 'the probe line must not be treated as a marker');
    assert.equal(second.text, first.text);
});

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

test('parseIgnoreFile parses comments, negation, anchors and globs', () => {
    const rules = parseIgnoreFile(' # comment\n\n!lib\n/dist/\n*.min.js\n**/cache\n');
    assert.equal(rules.length, 4);
    assert.deepEqual(
        rules.map((r) => [r.negated, r.anchored]),
        [[true, false], [false, true], [false, false], [false, true]],
    );
});

test('isIgnoredPath applies gitignore semantics', () => {
    const root = process.cwd();
    const files = [{ dir: root, rules: parseIgnoreFile('node_modules\n/build/\n*.map\n!keep.map\n') }];

    // A directory rule ignores everything beneath it, at any depth.
    assert.ok(isIgnoredPath(root, 'node_modules/react/index.js', files));
    assert.ok(isIgnoredPath(root, 'packages/node_modules/x.js', files));
    assert.ok(!isIgnoredPath(root, 'src/index.js', files));

    // An anchored rule only matches from the root.
    assert.ok(isIgnoredPath(root, 'build/out.js', files));
    assert.ok(!isIgnoredPath(root, 'src/build/out.js', files));

    // A glob plus a negation.
    assert.ok(isIgnoredPath(root, 'out.map', files));
    assert.ok(!isIgnoredPath(root, 'keep.map', files), 'the later ! rule wins');
});

test('isIgnoredPath lets the closest .gitignore win', () => {
    const root = process.cwd();
    const outer = { dir: root, rules: parseIgnoreFile('!build\n') };
    const inner = { dir: join(root, 'sub'), rules: parseIgnoreFile('build\n') };

    // `sub/build/...` is ignored by the inner file even though the outer
    // file un-ignores it: the deeper file is evaluated last and wins.
    assert.ok(isIgnoredPath(root, 'sub/build/x.js', [outer, inner]));
    assert.ok(!isIgnoredPath(root, 'build/x.js', [outer, inner]));
});

test('updateDocument skips gitignored markers and leaves their block', () => {
    const root = join(process.cwd(), '.fake-root');
    const files = {
        'a.md': 'kept\n',
        'node_modules/dep.js': 'ignored\n',
    };
    const doc = [
        '[a.md](./a.md)',
        '```',
        'stale',
        '```',
        '[node_modules/dep.js](./node_modules/dep.js)',
        '```',
        'untouched',
        '```',
    ].join('\n');
    const read = reader(files);
    const options = {
        root,
        readFile: read,
        gitignore: [{ dir: root, rules: parseIgnoreFile('node_modules\n') }],
    };

    const first = updateDocument(doc, options);
    assert.equal(first.changed, true);
    assert.deepEqual(
        first.results.map((r) => [r.skipped, r.changed]),
        [[false, true], [true, false]],
    );
    assert.equal(first.results[1].content, null);
    assert.match(first.text, /untouched/);
    assert.match(first.text, /kept/);
    assert.doesNotMatch(first.text, /stale|ignored/);

    const second = updateDocument(first.text, options);
    assert.equal(second.changed, false, 'skipping is idempotent too');
});

test('updateDocument honours gitignore: false and an explicit ignore file', () => {
    const root = join(process.cwd(), '.fake-root');
    const doc = ['[node_modules/dep.js](./node_modules/dep.js)', '```', 'old', '```'].join('\n');

    // Off: the marker is processed even though it would be ignored.
    const off = updateDocument(doc, {
        root,
        readFile: reader({ 'node_modules/dep.js': 'live\n' }),
        gitignore: false,
    });
    assert.equal(off.results[0].skipped, false);
    assert.match(off.text, /live/);

    // Explicit file: read through the stub, dir resolves to root.
    const on = updateDocument(doc, {
        root,
        readFile: reader({ 'node_modules/dep.js': 'live\n', 'ci.txt': 'node_modules\n' }),
        gitignore: { file: 'ci.txt' },
    });
    assert.equal(on.results[0].skipped, true);
    assert.match(on.text, /old/);

    // Default (walk up): a stub reader with no .gitignore files finds no rules.
    const def = updateDocument(doc, {
        root,
        readFile: reader({ 'node_modules/dep.js': 'live\n' }),
    });
    assert.equal(def.results[0].skipped, false);
});

// ---------------------------------------------------------------------------
// updateDocument — lenient
// ---------------------------------------------------------------------------

test('updateDocument with lenient skips a dead marker and keeps the rest', () => {
    const files = {
        'fixtures/one.md': 'first\n',
        'fixtures/two.md': 'second\n',
    };
    const doc = [
        '[fixtures/one.md](./fixtures/one.md)',
        '```',
        'stale one',
        '```',
        '[fixtures/missing.md](./fixtures/missing.md)',
        '```',
        'stale dead',
        '```',
        '[fixtures/two.md](./fixtures/two.md)',
        '```',
        'stale two',
        '```',
    ].join('\n');
    const read = reader(files);

    const result = updateDocument(doc, { readFile: read, lenient: true });
    assert.equal(result.changed, true);
    assert.deepEqual(
        result.results.map((entry) => [entry.changed, entry.skipped, Boolean(entry.failure)]),
        [
            [true, false, false],
            [false, true, true],
            [true, false, false],
        ],
    );
    assert.match(result.text, /first/);
    assert.match(result.text, /second/);
    assert.match(result.text, /stale dead/, 'the dead marker\'s block is kept as written');
    assert.doesNotMatch(result.text, /stale one|stale two/);

    const second = updateDocument(result.text, { readFile: read, lenient: true });
    assert.equal(second.changed, false, 'a second pass is a no-op');
});

test('updateDocument stays strict without lenient', () => {
    const doc = ['[missing.md](./missing.md)', '```', 'old', '```'].join('\n');
    assert.throws(
        () => updateDocument(doc, { readFile: reader({}) }),
        /\[missing\.md\]\(\.\/missing\.md\): ENOENT/,
    );
    assert.throws(
        () => updateDocument(doc, { readFile: reader({}), lenient: false }),
        /\[missing\.md\]\(\.\/missing\.md\): ENOENT/,
    );
});

test('lenient tolerates region and fence failures and keeps their blocks', () => {
    const files = { 'big.md': 'noise\n#region table\nx\n#endregion\n' };
    const read = reader(files);

    // A region that does not exist.
    let doc = ['[big.md](./big.md#region:missing)', '```', 'old', '```'].join('\n');
    let result = updateDocument(doc, { readFile: read, lenient: true });
    assert.equal(result.results[0].failure, 'no "#region missing" found');
    assert.match(result.text, /old/);

    // An unclosed fence.
    doc = ['[big.md](./big.md)', '```', 'old'].join('\n');
    result = updateDocument(doc, { readFile: read, lenient: true });
    assert.match(result.results[0].failure, /unclosed code block/);
    assert.match(result.text, /old/);

    // No fence after the marker at all.
    doc = ['[big.md](./big.md)', ''].join('\n');
    result = updateDocument(doc, { readFile: read, lenient: true });
    assert.match(result.results[0].failure, /no code block/);
});

test('lenient keeps duplicate markers and stray text strict', () => {
    const read = reader({ 'a.md': 'z\n' });

    const dup = [
        '[a.md](./a.md)', '```', 'x', '```',
        '[a.md](./a.md)', '```', 'y', '```',
    ].join('\n');
    assert.throws(() => updateDocument(dup, { readFile: read, lenient: true }), /duplicate marker/);

    const stray = ['[a.md](./a.md)', 'prose', '```', 'x', '```'].join('\n');
    assert.throws(() => updateDocument(stray, { readFile: read, lenient: true }), /expected a fenced code block/);
});

test('lenient keeps gitignored skips distinct from failures', () => {
    const root = join(process.cwd(), '.fake-root');
    const doc = [
        '[missing.md](./missing.md)',
        '```',
        'old',
        '```',
        '[node_modules/dep.js](./node_modules/dep.js)',
        '```',
        'static',
        '```',
    ].join('\n');
    const result = updateDocument(doc, {
        root,
        readFile: reader({ 'node_modules/dep.js': 'ignored\n' }),
        gitignore: [{ dir: root, rules: parseIgnoreFile('node_modules\n') }],
        lenient: true,
    });
    const [dead, ignored] = result.results;
    assert.equal(dead.skipped, true);
    assert.ok(dead.failure, 'a failure-skip carries its cause');
    assert.equal(ignored.skipped, true);
    assert.equal(ignored.failure, undefined, 'a gitignored skip is a success, not a failure');
    assert.equal(result.changed, false);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('parseArgs reads the gitignore flags and rejects conflicts', () => {
    assert.equal(parseArgs(['docs/G.md', '-g', 'ci.txt']).gitignoreFile, 'ci.txt');
    assert.equal(parseArgs(['--gitignore=ci.txt', 'f.md']).gitignoreFile, 'ci.txt');
    assert.equal(parseArgs(['--no-gitignore']).noGitignore, true);
    assert.throws(() => parseArgs(['-g', 'a.txt', '--no-gitignore']), UsageError);
    assert.throws(() => parseArgs(['--bogus']), UsageError);
    assert.throws(() => parseArgs(['a.md', 'b.md']), UsageError);
});

test('main checks, updates and skips gitignored markers', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'a.md'), 'real content\n');
    const readmePath = join(dir, 'README.md');
    const readme = [
        '[fixtures/a.md](./fixtures/a.md)',
        '',
        '```markdown',
        'stale content',
        '```',
        '',
    ].join('\n');
    writeFileSync(readmePath, readme);

    assert.equal(main([readmePath, '--check']), 1, 'stale at first');

    assert.equal(main([readmePath]), 0, 'rewrites in place');
    const updated = readFileSync(readmePath, 'utf8');
    assert.match(updated, /real content/);
    assert.doesNotMatch(updated, /stale content/);
    assert.equal(main([readmePath, '--check']), 0, 'up to date after update');

    writeFileSync(join(dir, 'ci.txt'), 'fixtures\n');
    assert.equal(main([readmePath, '--check', '-g', join(dir, 'ci.txt')]), 0, 'skipped markers are not stale');
    assert.equal(main([readmePath, '--check', '--no-gitignore']), 0);
    assert.equal(main([readmePath, '--check', '--gitignore', join(dir, 'missing.txt')]), 1, 'unreadable gitignore fails');
    assert.equal(main(['--bogus']), 2, 'unknown option is a usage error');
});

test('parseArgs reads --lenient', () => {
    assert.equal(parseArgs(['--lenient']).lenient, true);
    assert.equal(parseArgs(['-l', 'f.md']).lenient, true);
    assert.equal(parseArgs(['f.md']).lenient, false);
});

test('main --lenient refreshes live markers, reports dead ones, exits 1', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-lenient-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'a.md'), 'real a\n');
    writeFileSync(join(dir, 'fixtures', 'b.md'), 'real b\n');
    const readmePath = join(dir, 'README.md');
    writeFileSync(readmePath, [
        '[fixtures/a.md](./fixtures/a.md)',
        '```',
        'stale a',
        '```',
        '[fixtures/missing.md](./fixtures/missing.md)',
        '```',
        'stale dead',
        '```',
        '[fixtures/b.md](./fixtures/b.md)',
        '```',
        'stale b',
        '```',
    ].join('\n'));

    // Default: strict — aborts, writes nothing, exit 1.
    assert.equal(main([readmePath]), 1, 'strict mode aborts on the dead marker');
    assert.doesNotMatch(readFileSync(readmePath, 'utf8'), /real a/, 'nothing is written');

    // --lenient: live markers refreshed, dead one reported, exit 1.
    assert.equal(main([readmePath, '--lenient']), 1);
    const updated = readFileSync(readmePath, 'utf8');
    assert.match(updated, /real a/);
    assert.match(updated, /real b/);
    assert.match(updated, /stale dead/, 'the dead marker\'s block is kept as written');

    // A second pass changes nothing but still exits 1 (the dead marker persists).
    assert.equal(main([readmePath, '--lenient']), 1);

    // --lenient --check: no writes, same exit code.
    assert.equal(main([readmePath, '--lenient', '--check']), 1);
    assert.match(readFileSync(readmePath, 'utf8'), /real a/, 'check wrote nothing');

    // A fully healthy document exits 0 in every mode.
    writeFileSync(readmePath, ['[fixtures/a.md](./fixtures/a.md)', '```', 'real a', '```'].join('\n'));
    assert.equal(main([readmePath]), 0);
    assert.equal(main([readmePath, '--lenient']), 0);
    assert.equal(main([readmePath, '--check']), 0);
    assert.equal(main([readmePath, '--lenient', '--check']), 0);
});

test('main --lenient --check exits 0 when only gitignored skips remain', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-lenient-ig-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    writeFileSync(join(dir, 'ci.txt'), 'node_modules\n');
    const readmePath = join(dir, 'README.md');
    writeFileSync(readmePath, [
        '[node_modules/dep.js](./node_modules/dep.js)',
        '```',
        'static content',
        '```',
    ].join('\n'));

    assert.equal(main([readmePath, '--check', '-g', join(dir, 'ci.txt')]), 0);
    assert.equal(main([readmePath, '--lenient', '--check', '-g', join(dir, 'ci.txt')]), 0);
});
