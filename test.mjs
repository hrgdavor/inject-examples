/**
 * Tests for inject-examples. Run with `npm test` (node --test).
 *
 * The library is exercised entirely in memory — every read goes through a stub
 * `readFile`, so no fixture tree is needed and no file is ever written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CODE_RULE,
    JSON_RULE,
    REGION_RULES,
    codeReference,
    extractCodeRegion,
    extractDeclaration,
    extractJsonRegion,
    extractRegion,
    fenceRanges,
    fileLanguage,
    fileReader,
    findMarkers,
    injectInto,
    isIgnoredPath,
    normalize,
    parseIgnoreFile,
    parseMarker,
    regionDirective,
    resolveMarker,
    ruleFor,
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
// Region rules by file type — the code rule
// ---------------------------------------------------------------------------

const JAVA = [
    'package example;',
    '',
    '/** A cart of items. */',
    'public class Cart {',
    '    /** Add one item to this cart. */',
    '    @Override',
    '    public String toString() {',
    '        return String.join(",", items);',
    '    }',
    '',
    '    /** One line of a cart. */',
    '    public static class Line {',
    '        Line(String name) {',
    '            this.name = name;',
    '        }',
    '    }',
    '}',
].join('\n');

test('codeReference reads the scope modifiers', () => {
    assert.deepEqual(codeReference('add'), { scope: 'declaration', name: 'add' });
    assert.deepEqual(codeReference('-add'), { scope: 'body', name: 'add' });
    assert.deepEqual(codeReference('+add'), { scope: 'annotated', name: 'add' });
    assert.deepEqual(codeReference('++add'), { scope: 'documented', name: 'add' });
    assert.deepEqual(codeReference('++'), { scope: 'documented', name: '' });
});

test('extractDeclaration matches a method and a class-like declaration', () => {
    assert.equal(extractDeclaration(JAVA, 'toString'),
        '    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(extractDeclaration(JAVA, 'Line'),
        '    public static class Line {\n'
        + '        Line(String name) {\n'
        + '            this.name = name;\n'
        + '        }\n'
        + '    }');
    assert.equal(extractDeclaration(JAVA, 'missing'), null, 'nothing found is null, not an error');
    assert.equal(extractDeclaration(JAVA, ''), null);
});

test('extractDeclaration prefers a class over its same-named constructor', () => {
    const java = ['public class Cart {', '    Cart() {', '        init();', '    }', '}'].join('\n');
    assert.equal(extractDeclaration(java, 'Cart'), java);
});

test('extractDeclaration scopes: -, + and ++', () => {
    assert.equal(extractDeclaration(JAVA, 'toString', 'body'), '        return String.join(",", items);');
    assert.equal(extractDeclaration(JAVA, 'toString', 'annotated'),
        '    @Override\n    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(extractDeclaration(JAVA, 'toString', 'documented'),
        '    /** Add one item to this cart. */\n'
        + '    @Override\n'
        + '    public String toString() {\n'
        + '        return String.join(",", items);\n'
        + '    }');
    // `++` without a doc comment above is `+`; `+` without an annotation is
    // the declaration.
    assert.equal(extractDeclaration(JAVA, 'Line', 'documented'),
        '    /** One line of a cart. */\n'
        + '    public static class Line {\n'
        + '        Line(String name) {\n'
        + '            this.name = name;\n'
        + '        }\n'
        + '    }');
    assert.equal(extractDeclaration(JAVA, 'Line', 'annotated'), extractDeclaration(JAVA, 'Line'));
});

test('extractDeclaration follows indented and Allman bodies', () => {
    const python = [
        'class Cart:',
        '    def add(self, item):',
        '        self.items.append(item)',
        '        return self',
        '',
        'def helper():',
        '    pass',
    ].join('\n');
    assert.equal(extractDeclaration(python, 'add'),
        '    def add(self, item):\n        self.items.append(item)\n        return self');
    assert.equal(extractDeclaration(python, 'add', 'body'),
        '        self.items.append(item)\n        return self');

    const allman = ['public class A', '{', '    void run()', '    {', '        go();', '    }', '}'].join('\n');
    assert.equal(extractDeclaration(allman, 'run'), '    void run()\n    {\n        go();\n    }');
    assert.equal(extractDeclaration(allman, 'A', 'body'), '    void run()\n    {\n        go();\n    }');
});

test('extractDeclaration is not fooled by braces in strings or comments', () => {
    const tricky = [
        'class T {',
        '    void go() {',
        '        String s = "}";',
        '        /* } */ // }',
        '    }',
        '}',
    ].join('\n');
    assert.equal(extractDeclaration(tricky, 'go'),
        '    void go() {\n        String s = "}";\n        /* } */ // }\n    }');
});

test('extractDeclaration reads assigned and arrow functions', () => {
    assert.equal(extractDeclaration('const pick = (a) => {\n    return a;\n};', 'pick'),
        'const pick = (a) => {\n    return a;\n};');
    assert.equal(extractDeclaration('const inc = (n) => n + 1;', 'inc', 'body'), 'n + 1;');
    assert.equal(extractDeclaration('  handler = async (event) => {\n    go(event);\n  };', 'handler'),
        '  handler = async (event) => {\n    go(event);\n  };');
    assert.equal(extractDeclaration('const run = function () { go(); };', 'run'),
        'const run = function () { go(); };');
    assert.equal(extractDeclaration('const type: Fn = (a) => a;', 'type', 'body'), 'a;');
});

test('extractDeclaration rejects ambiguous names and ignores calls', () => {
    const overloaded = ['class A {', '    void run() {}', '    void run(int x) {}', '}'].join('\n');
    assert.throws(() => extractDeclaration(overloaded, 'run'), /"run" is declared 2 times/);
    assert.equal(extractDeclaration('add(x);\nrun();', 'add'), null, 'a call is not a declaration');
    assert.equal(extractDeclaration('interface Opts {\n    void add(int x);\n}', 'add'), null,
        'a body-less declaration has nothing to inject');
});

test('extractCodeRegion prefers an explicit region directive', () => {
    const text = ['// #region add', 'the region body', '// #endregion', '', 'void add() { body(); }'].join('\n');
    assert.equal(extractCodeRegion(text, 'add'), 'the region body');
    assert.equal(extractCodeRegion(text, '-add'), 'the region body', 'a modifier cannot change a region');
});

test('extractCodeRegion reads declarations and fails loudly on nothing', () => {
    assert.equal(extractCodeRegion(JAVA, '+toString'),
        '    @Override\n    public String toString() {\n        return String.join(",", items);\n    }');
    assert.throws(
        () => extractCodeRegion(JAVA, 'missing'),
        /no "#region missing" found, and no method or inner class named "missing"/,
    );
    assert.throws(() => extractCodeRegion(JAVA, '+'), /names nothing/);
});

// ---------------------------------------------------------------------------
// Region rules by file type — the JSON rule
// ---------------------------------------------------------------------------

const JSON_DOC = [
    '{',
    '  "name": "acme",',
    '  "version": "1.0.0",',
    '  "scripts": {',
    '    "build": "make",',
    '    "test": "make test"',
    '  },',
    '  "keywords": ["docs", "examples", "sync"]',
    '}',
].join('\n');

test('extractJsonRegion selects top-level keys and forms valid JSON', () => {
    const selected = extractJsonRegion(JSON_DOC, 'name,version');
    assert.equal(selected, '{\n  "name": "acme",\n  "version": "1.0.0"\n}');
    assert.deepEqual(JSON.parse(selected), { name: 'acme', version: '1.0.0' });
});

test('extractJsonRegion follows dotted paths and array elements', () => {
    assert.deepEqual(
        JSON.parse(extractJsonRegion(JSON_DOC, 'scripts.test,name')),
        { scripts: { test: 'make test' }, name: 'acme' },
        'listed order, nested keys merged',
    );
    assert.deepEqual(
        JSON.parse(extractJsonRegion(JSON_DOC, 'keywords.0,keywords.2')),
        { keywords: ['docs', 'sync'] },
        'only the elements named, in order',
    );
});

test('extractJsonRegion fails loudly on missing keys and bad documents', () => {
    assert.throws(() => extractJsonRegion(JSON_DOC, 'scripts.nope'), /"scripts.nope": no key "nope"/);
    assert.throws(() => extractJsonRegion(JSON_DOC, 'keywords.x'), /is not an array index/);
    assert.throws(() => extractJsonRegion(JSON_DOC, 'keywords.9'), /no element 9/);
    assert.throws(() => extractJsonRegion(JSON_DOC, ','), /names no keys/);
    assert.throws(() => extractJsonRegion('not json', 'a'), /not valid JSON/);
    assert.throws(() => extractJsonRegion('[1, 2]', 'a'), /top-level JSON value is not an object/);
    assert.throws(() => extractJsonRegion('null', 'a'), /top-level JSON value is not an object/);
});

test('ruleFor sends .json to the JSON rule and everything else to code', () => {
    assert.equal(ruleFor('package.json').name, 'json');
    assert.equal(ruleFor('./a/b.JSON').name, 'json', 'extensions are case-insensitive');
    assert.equal(ruleFor('index.mjs').name, 'code');
    assert.equal(ruleFor('README.md').name, 'code');
    assert.equal(ruleFor('.gitignore').name, 'code');
    assert.equal(ruleFor('noext').name, 'code');
    assert.equal(ruleFor('a.json', [JSON_RULE, CODE_RULE]).name, 'json');
    assert.equal(ruleFor('a.json', []).name, 'code', 'a rule set with no match falls back');
    assert.deepEqual(REGION_RULES, [JSON_RULE, CODE_RULE]);
});

test('resolveMarker resolves a region by the file type', () => {
    const files = { 'data.json': JSON_DOC, 'code.ts': 'const add = (a) => a;\n' };
    const read = reader(files);
    assert.equal(
        resolveMarker(parseMarker('[data.json](./data.json#region:name)'), read),
        '{\n  "name": "acme"\n}',
    );
    assert.equal(
        resolveMarker(parseMarker('[code.ts](./code.ts#region:add)'), read),
        'const add = (a) => a;',
    );
    assert.equal(
        resolveMarker(parseMarker('[data.json](./data.json)'), read),
        JSON_DOC,
        'a whole file ignores the rules',
    );
});

test('updateDocument injects a JSON selection and is idempotent', () => {
    const files = { 'data.json': JSON_DOC };
    const doc = ['[data.json](./data.json#region:scripts)', '```', 'stale', '```'].join('\n');
    const read = reader(files);

    const first = updateDocument(doc, { readFile: read });
    assert.equal(first.changed, true);
    assert.match(first.text, /"test": "make test"/);
    assert.match(first.text, /^```json$/m, 'the fence still gets the file language');

    const second = updateDocument(first.text, { readFile: read });
    assert.equal(second.changed, false, 'a second pass is a no-op');
});

test('updateDocument takes a custom rule set', () => {
    const files = { 'notes.txt': 'one\n-- eight --\ntwo\n' };
    const doc = ['[notes.txt](./notes.txt#region:eight)', '```', 'stale', '```'].join('\n');
    const custom = {
        name: 'dashes',
        extensions: ['txt'],
        resolve: (text, region) => text.split('\n')[text.split('\n').indexOf(`-- ${region} --`) + 1],
    };

    const result = updateDocument(doc, { readFile: reader(files), regionRules: [custom] });
    assert.match(result.text, /^two$/m);
    assert.doesNotMatch(result.text, /stale/);
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
    assert.match(text, /"name": "@hrg\/inject-examples"/);
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

test('injectInto gives a bare fence the language it is passed', () => {
    const bare = ['[a.ts](./a.ts)', '```', 'old', '```'];
    const result = injectInto(bare, '[a.ts](./a.ts)', 'new', 0, 'typescript');
    assert.deepEqual(result.lines, ['[a.ts](./a.ts)', '```typescript', 'new', '```']);
    assert.equal(result.changed, true);

    // A fence that already names a language is left as written.
    const tagged = ['[a.ts](./a.ts)', '```cpp', 'same', '```'];
    const kept = injectInto(tagged, '[a.ts](./a.ts)', 'same', 0, 'typescript');
    assert.deepEqual(kept.lines, ['[a.ts](./a.ts)', '```cpp', 'same', '```']);
    assert.equal(kept.changed, false);

    // No language passed: a bare fence stays bare.
    const noLang = injectInto(bare, '[a.ts](./a.ts)', 'new', 0);
    assert.deepEqual(noLang.lines, ['[a.ts](./a.ts)', '```', 'new', '```']);

    // Indentation and CRLF endings are preserved when the fence gains a language.
    const crlf = ['[a.ts](./a.ts)', '  ```\r', 'old', '  ```\r'];
    const keptCrlf = injectInto(crlf, '[a.ts](./a.ts)', 'new', 0, 'typescript');
    assert.deepEqual(keptCrlf.lines, ['[a.ts](./a.ts)', '  ```typescript\r', 'new', '  ```\r']);
});

// ---------------------------------------------------------------------------
// fileLanguage
// ---------------------------------------------------------------------------

test('fileLanguage maps extensions to fence languages', () => {
    assert.equal(fileLanguage('src/app.ts'), 'typescript');
    assert.equal(fileLanguage('src/app.tsx'), 'tsx');
    assert.equal(fileLanguage('app.js'), 'javascript');
    assert.equal(fileLanguage('app.mjs'), 'javascript');
    assert.equal(fileLanguage('app.cjs'), 'javascript');
    assert.equal(fileLanguage('config.json'), 'json');
    assert.equal(fileLanguage('doc.md'), 'markdown');
    assert.equal(fileLanguage('doc.markdown'), 'markdown');
    assert.equal(fileLanguage('script.py'), 'python');
    assert.equal(fileLanguage('run.sh'), 'bash');
    assert.equal(fileLanguage('style.css'), 'css');
    assert.equal(fileLanguage('page.html'), 'html');
    assert.equal(fileLanguage('data.yml'), 'yaml');
    assert.equal(fileLanguage('APP.TS'), 'typescript', 'extensions are case-insensitive');
    assert.equal(fileLanguage('noext'), null, 'no extension is unknown');
    assert.equal(fileLanguage('.gitignore'), null, 'a dotfile has no extension');
    assert.equal(fileLanguage('notes.txt'), null, 'unknown extensions stay unknown');
});

test('updateDocument gives a bare fence the language of the marker file', () => {
    const files = { 'fixtures/one.ts': 'code\n' };
    const doc = ['[fixtures/one.ts](./fixtures/one.ts)', '```', 'stale', '```'].join('\n');
    const read = reader(files);

    const first = updateDocument(doc, { readFile: read });
    assert.equal(first.changed, true);
    assert.match(first.text, /^```typescript$/m);
    assert.match(first.text, /code/);

    const second = updateDocument(first.text, { readFile: read });
    assert.equal(second.changed, false, 'the added language is not re-added');
});

test('updateDocument leaves a bare fence bare for unknown extensions', () => {
    const files = { 'fixtures/notes.txt': 'notes\n' };
    const doc = ['[fixtures/notes.txt](./fixtures/notes.txt)', '```', 'stale', '```'].join('\n');
    const result = updateDocument(doc, { readFile: reader(files) });
    assert.equal(result.changed, true, 'the content is still replaced');
    assert.match(result.text, /^```\n/m, 'the fence stays bare');
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

// #region update-document-test
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
// #endregion

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
    assert.equal(
        result.results[0].failure,
        'no "#region missing" found, and no method or inner class named "missing"',
    );
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
});

test('parseArgs collects every positional target, files and directories alike', () => {
    assert.deepEqual(parseArgs(['a.md', 'b.md']).files, ['a.md', 'b.md']);
    assert.deepEqual(parseArgs(['docs/', 'a.md']).files, ['docs/', 'a.md']);
    assert.deepEqual(parseArgs(['--', '-weird-name.md']).files, ['-weird-name.md']);
    assert.deepEqual(parseArgs([]).files, ['README.md'], 'the default is still README.md');
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

test('parseArgs reads --out', () => {
    assert.equal(parseArgs(['--out', 'dist.md', 'f.md']).out, 'dist.md');
    assert.equal(parseArgs(['-o', 'dist.md']).out, 'dist.md');
    assert.equal(parseArgs(['--out=dist.md', 'f.md']).out, 'dist.md');
    assert.throws(() => parseArgs(['f.md', '--out']), UsageError, 'a missing value is a usage error');
});

test('main --out writes a processed copy elsewhere and leaves the input alone', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-out-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'a.md'), 'real content\n');
    const docPath = join(srcDir, 'doc.md');
    const original = [
        '[a.md](./a.md)',
        '',
        '```markdown',
        'stale content',
        '```',
        '',
    ].join('\n');
    writeFileSync(docPath, original);
    const outPath = join(dir, 'dist', 'out.md');

    // The copy may live in a different folder; the missing parent is created.
    assert.equal(main([docPath, '--out', outPath]), 0);
    const copy = readFileSync(outPath, 'utf8');
    assert.match(copy, /real content/);
    assert.doesNotMatch(copy, /stale content/);
    assert.equal(readFileSync(docPath, 'utf8'), original, 'the input is untouched');

    // A second pass writes nothing more.
    assert.equal(main([docPath, '--out', outPath]), 0, 'idempotent');

    // --check verifies the copy and writes nothing.
    assert.equal(main([docPath, '--out', outPath, '--check']), 0, 'a fresh copy passes');
    writeFileSync(outPath, 'old output\n');
    assert.equal(main([docPath, '--out', outPath, '--check']), 1, 'a stale copy fails');
    assert.equal(readFileSync(outPath, 'utf8'), 'old output\n', 'check wrote nothing');
    rmSync(outPath);
    assert.equal(main([docPath, '--out', outPath, '--check']), 1, 'a missing copy fails');

    // --dry-run reports and writes nothing.
    assert.equal(main([docPath, '--out', outPath, '--dry-run']), 0);
    assert.equal(existsSync(outPath), false, 'dry-run wrote nothing');

    // A broken include: strict aborts without writing; lenient writes the
    // resolvable parts and still exits 1.
    const brokenDoc = [
        '[a.md](./a.md)',
        '```',
        'stale content',
        '```',
        '[missing.md](./missing.md)',
        '```',
        'stale dead',
        '```',
    ].join('\n');
    writeFileSync(docPath, brokenDoc);
    assert.equal(main([docPath, '--out', outPath]), 1, 'strict mode aborts');
    assert.equal(existsSync(outPath), false, 'strict wrote no output');
    assert.equal(main([docPath, '--out', outPath, '--lenient']), 1);
    const lenientCopy = readFileSync(outPath, 'utf8');
    assert.match(lenientCopy, /real content/);
    assert.match(lenientCopy, /stale dead/, 'the dead marker\'s block is kept as written');
    assert.equal(main([docPath, '--out', outPath, '--check', '--lenient']), 1, 'a failed include fails --check too');
    assert.equal(readFileSync(docPath, 'utf8'), brokenDoc, 'the input was never modified');

    // --out is a usage error with a directory or several files.
    assert.equal(main([srcDir, '--out', outPath]), 2, 'a directory is a usage error');
    assert.equal(main([docPath, join(srcDir, 'a.md'), '--out', outPath]), 2, 'two files are a usage error');
});

test('main expands a directory to every *.md below it, skipping the noise', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-tree-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'docs', 'nested'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(dir, 'docs', '.hidden'), { recursive: true });
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'one.md'), 'one\n');
    writeFileSync(join(dir, 'fixtures', 'two.md'), 'two\n');

    const page = (target, content) => [
        `[${target}](${target})`,
        '```markdown',
        content,
        '```',
        '',
    ].join('\n');
    const index = join(dir, 'docs', 'README.md');
    const guide = join(dir, 'docs', 'nested', 'GUIDE.md');
    const vendored = join(dir, 'docs', 'node_modules', 'dep', 'README.md');
    const hidden = join(dir, 'docs', '.hidden', 'README.md');
    writeFileSync(index, page('../fixtures/one.md', 'stale one'));
    writeFileSync(guide, page('../../fixtures/two.md', 'stale two'));
    writeFileSync(join(dir, 'docs', 'notes.txt'), 'not markdown\n');
    // Neither of these two may be reached: each carries a dead marker, which
    // in strict mode would end the run with exit 1.
    writeFileSync(vendored, page('missing.md', 'stale'));
    writeFileSync(hidden, page('missing.md', 'stale'));

    const docs = join(dir, 'docs');
    assert.equal(main([docs, '--check']), 1, 'both documents are stale at first');
    assert.equal(main([docs]), 0, 'one run rewrites the whole tree');
    assert.match(readFileSync(index, 'utf8'), /one/);
    assert.match(readFileSync(guide, 'utf8'), /two/);
    assert.equal(main([docs, '--check']), 0);
    assert.match(readFileSync(hidden, 'utf8'), /stale/, 'dot-directories are left alone');
    assert.match(readFileSync(vendored, 'utf8'), /stale/, 'node_modules is left alone');
});

test('a directory with no Markdown is a failure, not a silent success', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-empty-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'notes.txt'), 'not markdown\n');
    assert.equal(main([join(dir, 'docs'), '--check']), 1);
});

test('several targets run in one pass and the worst code wins', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-many-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'a.md'), 'real a\n');
    const page = (content) => [
        '[fixtures/a.md](fixtures/a.md)',
        '```markdown',
        content,
        '```',
        '',
    ].join('\n');
    const healthy = join(dir, 'healthy.md');
    const stale = join(dir, 'stale.md');
    writeFileSync(healthy, page('real a'));
    writeFileSync(stale, page('stale a'));

    assert.equal(main([healthy, stale, '--check']), 1, 'the stale document decides the code');
    assert.equal(main([healthy, '--check']), 0);

    // A target that cannot be read is reported, and the run carries on: the
    // document after it is still rewritten.
    assert.equal(main([join(dir, 'missing.md'), stale]), 1);
    assert.match(readFileSync(stale, 'utf8'), /real a/);

    assert.equal(main([healthy, stale, '--check']), 0, 'everything is in sync now');
});

// ---------------------------------------------------------------------------
// Shared fixtures — the files that back both the docs and the tests
// ---------------------------------------------------------------------------
//
// doc/usage.md injects these files with live markers, and the tests below
// read them through the real fileReader. The overlap is deliberate: an
// example shown in the docs is test data, not prose, so it cannot drift
// from what the tests prove.

test('the fixtures that back the docs are real files with stable content', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const read = fileReader(root);

    assert.equal(normalize(read('test/fixtures/before.md')),
        "## Example\n\n```ts\nimport { inject } from 'acme';\n\ninject('a', 'b');\n```");
    assert.equal(normalize(read('test/fixtures/after.md')),
        '$ npx @hrg/inject-examples doc/usage.md\ndoc/usage.md updated.');
    assert.equal(normalize(read('test/fixtures/fenced.md')),
        "Prose, then a nested fence:\n\n```js\nconst x = 1;\n```\n\nAnd prose after it.");
    assert.equal(extractRegion(read('test/fixtures/example.ts'), 'table'),
        '| name | qty |\n| ---- | --- |\n| bolt | 12  |');
    assert.equal(extractRegion(read('test/fixtures/example.ts'), 'config'),
        'export const config = { retries: 3 };');

    // The declarations the "Region rules by file type" section injects: an
    // annotated, documented method and an inner class.
    const java = read('test/fixtures/Example.java');
    assert.equal(extractDeclaration(java, 'toString', 'annotated'),
        '    @Override\n'
        + '    public String toString() {\n'
        + '        return String.join(",", items);\n'
        + '    }');
    assert.equal(extractDeclaration(java, 'toString', 'documented'),
        '    /** Add one item to this cart. */\n'
        + '    @Override\n'
        + '    public String toString() {\n'
        + '        return String.join(",", items);\n'
        + '    }');
    assert.equal(extractDeclaration(java, 'toString', 'body'), '        return String.join(",", items);');
    assert.equal(extractDeclaration(java, 'Line'),
        '    public static class Line {\n'
        + '        private final String name;\n'
        + '        private final int quantity;\n'
        + '\n'
        + '        Line(String name, int quantity) {\n'
        + '            this.name = name;\n'
        + '            this.quantity = quantity;\n'
        + '        }\n'
        + '\n'
        + '        String render() {\n'
        + '            return name + " x" + quantity;\n'
        + '        }\n'
        + '    }');
});

test('the region markers in index.mjs and test.mjs resolve to real code', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const read = fileReader(root);

    const parse = resolveMarker(parseMarker('[index.mjs](index.mjs#region:parseMarker)'), read);
    assert.match(parse, /^\/\*\*\n \* Read one line as an injection marker/);
    assert.match(parse, /export function parseMarker\(line\)/);

    const testCode = resolveMarker(parseMarker('[test.mjs](test.mjs#region:update-document-test)'), read);
    assert.match(testCode, /updateDocument rewrites every marker and is idempotent/);
    assert.match(testCode, /a second pass is a no-op/);
});

test('a fixture-backed doc is rewritten when its block goes stale', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const read = fileReader(root);
    const stale = ['[test/fixtures/after.md](test/fixtures/after.md)', '```', 'old output', '```'].join('\n');

    const result = updateDocument(stale, { root, readFile: read, gitignore: false });
    assert.equal(result.changed, true, 'the stale block is detected and rewritten');
    assert.match(result.text, /\$ npx @hrg\/inject-examples doc\/usage\.md/);

    const second = updateDocument(result.text, { root, readFile: read, gitignore: false });
    assert.equal(second.changed, false, 'a second pass is a no-op');
});

test('content that contains fences is replaced inside a longer fence', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const read = fileReader(root);
    const doc = ['[test/fixtures/fenced.md](test/fixtures/fenced.md)', '````', 'old', '````'].join('\n');

    const result = updateDocument(doc, { root, readFile: read, gitignore: false });
    assert.equal(result.changed, true);
    assert.match(result.text, /const x = 1;/);
    assert.match(result.text, /^````markdown\n/m, 'a bare fence gets the file language too');

    const second = updateDocument(result.text, { root, readFile: read, gitignore: false });
    assert.equal(second.changed, false, 'a second pass is a no-op');
});

test('the documentation stays in sync with the files it shows', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(join(root, 'doc', 'usage.md'), 'utf8');
    const result = updateDocument(doc, { root: join(root, 'doc'), gitignore: false });

    assert.equal(result.changed, false, 'doc/usage.md must match its fixtures');
    assert.equal(result.markers.length, 15, 'one marker per shown file, region or declaration');
    for (const entry of result.results) {
        assert.equal(entry.skipped, false);
        assert.equal(entry.failure, undefined);
    }
});

// ---------------------------------------------------------------------------
// Doc links must be functional
// ---------------------------------------------------------------------------
//
// General rule for this repository: no fake links in the docs. Every
// Markdown link in a document's prose must be navigable — it is either an
// external URL, an in-page link to a heading that exists in the same
// document, or a file that exists in the repository (file links resolve
// against the document's own directory, the standard Markdown convention
// the docs follow).
// Content inside fenced blocks and inside inline code is data, not
// navigation: an illustrative marker there — e.g. the `failed` demo in the
// README's CLI output — is exempt, exactly as marker-like lines inside
// fences are inert.

test('every link in the docs is functional', () => {
    const root = dirname(fileURLToPath(import.meta.url));

    const mdFiles = readdirSync(root, { recursive: true })
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(root, name));
    assert.ok(mdFiles.length >= 3, 'README and doc/usage.md must be present');

    const slugify = (heading) =>
        heading.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-');

    for (const file of mdFiles) {
        const rel = file.slice(root.length + 1);
        const lines = readFileSync(file, 'utf8').split('\n');

        const fences = fenceRanges(lines);
        const fenced = (i) => fences.some(([a, b]) => i >= a && i <= b);

        const slugs = new Set();
        for (let i = 0; i < lines.length; i++) {
            if (fenced(i)) continue;
            const heading = /^#{1,6} +(.+)$/.exec(lines[i]);
            if (heading) slugs.add(slugify(heading[1]));
        }

        for (let i = 0; i < lines.length; i++) {
            if (fenced(i)) continue;
            const prose = lines[i].replace(/`[^`]*`/g, '');
            for (const link of prose.matchAll(/\[[^\]]+\]\(([^()\s]+)\)/g)) {
                const dest = link[1];
                if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue; // external URL
                const [pathPart, fragment] = dest.split('#');
                if (pathPart === '') {
                    assert.ok(slugs.has(fragment), `${rel}:${i + 1}: no such heading ${dest}`);
                } else {
                    const target = resolve(dirname(file), pathPart);
                    assert.ok(existsSync(target), `${rel}:${i + 1}: ${dest} does not exist`);
                }
            }
        }
    }
});
