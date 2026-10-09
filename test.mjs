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
    planMarker,
    regionDirective,
    resolveMarker,
    ruleFor,
    updateDocument,
} from './index.mjs';

import { main, parseArgs, UsageError } from './cli.mjs';

import { lexerFor, LEXERS } from './src/js/scanner/lexers.js';
import { lexerJS, scanJS, visitJS } from './src/js/scanner/scanJS.js';
import { lexerJava, scanJava, visitJava } from './src/js/scanner/scanJava.js';
import { lexerZig, scanZig, visitZig } from './src/js/scanner/scanZig.js';
import { tokenize, JS_SYNTAX, JAVA_SYNTAX, ZIG_SYNTAX } from './src/js/scanner/tokenizer.js';

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
        /no "#region missing" found/,
    );
    assert.throws(() => extractCodeRegion(JAVA, '+'), /names nothing/);
});

// ---------------------------------------------------------------------------
// File-section matching — contract pins (step 3 of plan/section-matching)
// ---------------------------------------------------------------------------
// Positive cases fail today because extractCodeRegion does not yet resolve
// `/`-paths, trailing modifiers, condition literals or comment anchors.
// The grammar-error tests assert the §9 catalogue shapes; those already
// matching today's rejection message pass, the rest are the red state
// step 4 resolves.

const ANCHORS = fileReader(dirname(fileURLToPath(import.meta.url)))('test/fixtures/Anchors.java');
const EXAMPLE = fileReader(dirname(fileURLToPath(import.meta.url)))('test/fixtures/Example.java');

// --- 2a: existing Example.java modifiers must stay byte-identical ---
test('section-matching: existing Example.java modifiers are unchanged', () => {
    assert.equal(extractCodeRegion(EXAMPLE, 'toString'),
        '    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(extractCodeRegion(EXAMPLE, 'toString-'),
        '        return String.join(",", items);');
    assert.equal(extractCodeRegion(EXAMPLE, '-toString'),
        '        return String.join(",", items);');
    assert.equal(extractCodeRegion(EXAMPLE, 'toString+'),
        '    @Override\n    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(extractCodeRegion(EXAMPLE, '+toString'),
        '    @Override\n    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(extractCodeRegion(EXAMPLE, 'toString++'),
        '    /** Add one item to this cart. */\n'
        + '    @Override\n'
        + '    public String toString() {\n'
        + '        return String.join(",", items);\n'
        + '    }');
    assert.equal(extractCodeRegion(EXAMPLE, '++toString'),
        '    /** Add one item to this cart. */\n'
        + '    @Override\n'
        + '    public String toString() {\n'
        + '        return String.join(",", items);\n'
        + '    }');
    assert.equal(extractCodeRegion(EXAMPLE, 'Line'),
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

// --- 2b: nested references on Example.java (positive — fail today) ---
test('section-matching: nested references on Example.java', () => {
    assert.equal(extractCodeRegion(EXAMPLE, 'Cart/Line/render'),
        '        String render() {\n            return name + " x" + quantity;\n        }');
    assert.equal(extractCodeRegion(EXAMPLE, 'Cart/Line/render-'),
        '            return name + " x" + quantity;');
    assert.equal(extractCodeRegion(EXAMPLE, 'Cart/Line/-render'),
        '            return name + " x" + quantity;');
    assert.equal(extractCodeRegion(EXAMPLE, 'Cart/Line-'),
        '        private final String name;\n'
        + '        private final int quantity;\n'
        + '\n'
        + '        Line(String name, int quantity) {\n'
        + '            this.name = name;\n'
        + '            this.quantity = quantity;\n'
        + '        }\n'
        + '\n'
        + '        String render() {\n'
        + '            return name + " x" + quantity;\n'
        + '        }');
});

// --- 2c: anchors and condition literals on Anchors.java ---
test('section-matching: anchors and condition literals on Anchors.java', () => {
    // Sibling before deeper: handler's anchor is a member of the class scope,
    // so it beats the condition literal nested inside dispatch, even though
    // dispatch comes first in the file.
    assert.equal(extractCodeRegion(ANCHORS, 'getUsers'),
        '    public void handler() { //getUsers\n'
        + '        System.out.println("anchor same line");\n'
        + '    }');
    assert.equal(extractCodeRegion(ANCHORS, 'getUsers-'),
        '        System.out.println("anchor same line");');
    assert.equal(extractCodeRegion(ANCHORS, 'dispatch/getUsers'),
        '        if ("getUsers".equals(methodName)) {\n'
        + '            System.out.println("users");\n'
        + '        }');
    assert.equal(extractCodeRegion(ANCHORS, 'getOrders'),
        '    public void other() {\n'
        + '        //getOrders\n'
        + '        System.out.println("anchor next line");\n'
        + '    }');

    // Anchor: same-line comment anchor on handler, next-line on other.
    assert.equal(extractCodeRegion(ANCHORS, 'handler/getUsers'),
        '    public void handler() { //getUsers\n'
        + '        System.out.println("anchor same line");\n'
        + '    }');
    assert.equal(extractCodeRegion(ANCHORS, 'handler/getUsers-'),
        '        System.out.println("anchor same line");');
    assert.equal(extractCodeRegion(ANCHORS, 'other/getOrders'),
        '    public void other() {\n'
        + '        //getOrders\n'
        + '        System.out.println("anchor next line");\n'
        + '    }');
    assert.equal(extractCodeRegion(ANCHORS, 'other/getOrders-'),
        '        System.out.println("anchor next line");');

    // Negative: string-literal mention is not a condition literal.
    assert.throws(
        () => extractCodeRegion(ANCHORS, 'commentFromString/getUsers'),
        /no section named "getUsers" in "commentFromString"/,
    );
    assert.throws(
        () => extractCodeRegion(ANCHORS, 'commentFromString/getUsers-'),
        /no section named "getUsers" in "commentFromString"/,
    );
});

// --- 2d: grammar errors throw the §9 shapes ---
test('section-matching: grammar errors throw the §9 shapes', () => {
    assert.throws(() => extractCodeRegion(EXAMPLE, ''), /names nothing/);
    assert.throws(() => extractCodeRegion(EXAMPLE, 'a/'),
        /"#a\/" has an empty path segment/);
    assert.throws(() => extractCodeRegion(EXAMPLE, '/a'),
        /"#\/a" has an empty path segment/);
    assert.throws(() => extractCodeRegion(EXAMPLE, 'a//b'),
        /"#a\/\/b" has an empty path segment/);
    assert.throws(() => extractCodeRegion(EXAMPLE, 'a/+b'),
        /"\+" may only modify the last path segment/);
    assert.throws(() => extractCodeRegion(EXAMPLE, 'a/-b/c'),
        /"\-" may only modify the last path segment/);
    assert.throws(() => extractCodeRegion(EXAMPLE, 'a+++'),
        /"#a\+\+\+" carries more than one modifier/);
    assert.throws(() => extractCodeRegion(EXAMPLE, 'a---'),
        /"#a---" carries more than one modifier/);
    assert.throws(
        () => extractCodeRegion(EXAMPLE, 'a/b/c/d/e/f/g/h/i'),
        /is deeper than 8 sections/,
    );
});

// --- 2e: contradictory modifiers resolve to the dominant reading ---
test('section-matching: contradictory modifiers resolve to the dominant reading', () => {
    const expected = '    public void handler() { //getUsers\n'
        + '        System.out.println("anchor same line");\n'
        + '    }';

    assert.equal(extractCodeRegion(ANCHORS, 'getUsers++-'), expected,
        '++ wins over trailing -');
    assert.equal(extractCodeRegion(ANCHORS, 'getUsers-++'), expected,
        '++ wins over leading -');
    assert.equal(extractCodeRegion(ANCHORS, 'getUsers+-'), expected,
        '+ wins over trailing -');
    assert.equal(extractCodeRegion(ANCHORS, 'getUsers-+'), expected,
        '+ wins over leading -');

    // TODO(step 4): assert the warning field once parseReference returns one.
    // The contradiction warning is reported once per document, not per
    // reference; the CLI prints it and exits 1. The parse layer returns a
    // `warning` string; the CLI consumes it. Pin the resolved text above;
    // the warning surface is pinned in the §11 unit tests in step 4.
});

// ---------------------------------------------------------------------------
// parseReference unit tests (step 4 of plan/section-matching)
// ---------------------------------------------------------------------------

import { parseReference, isSingleSegment, finalSegment, SectionReferenceError, masked, commentsIn, scanBlocks } from './lib/section.mjs';
import { resolveSection, planSection } from './lib/section.mjs';

// Group 1: canonicalisation of single-segment references
test('parseReference: single-segment canonicalisation', () => {
    const cases = [
        ['add', 'add', ['add'], 'declaration'],
        ['add-', 'add-', ['add'], 'body'],
        ['add+', 'add+', ['add'], 'annotated'],
        ['add++', 'add++', ['add'], 'documented'],
        ['-add', 'add-', ['add'], 'body'],
        ['+add', 'add+', ['add'], 'annotated'],
        ['++add', 'add++', ['add'], 'documented'],
    ];
    for (const [raw, canonical, segments, scope] of cases) {
        const r = parseReference(raw);
        assert.equal(r.raw, raw);
        assert.equal(r.canonical, canonical);
        assert.deepEqual(r.segments, segments);
        assert.equal(r.scope, scope);
        assert.equal(r.warning, null);
    }
});

// Group 2: multi-segment without modifiers
test('parseReference: multi-segment without modifiers', () => {
    const r = parseReference('Cart/Line/render');
    assert.equal(r.raw, 'Cart/Line/render');
    assert.equal(r.canonical, 'Cart/Line/render');
    assert.deepEqual(r.segments, ['Cart', 'Line', 'render']);
    assert.equal(r.scope, 'declaration');
    assert.equal(r.warning, null);
});

// Group 3: modifier variants across segment positions
test('parseReference: modifier variants produce same scope/segments', () => {
    // Equivalence class 1: Cart/Line- (2 segments, body scope)
    const class1 = ['Cart/Line-', 'Cart/-Line', '-Cart/Line'];
    for (const raw of class1) {
        const r = parseReference(raw);
        assert.equal(r.canonical, 'Cart/Line-');
        assert.deepEqual(r.segments, ['Cart', 'Line']);
        assert.equal(r.scope, 'body');
        assert.equal(r.warning, null);
    }
    // Equivalence class 2: Cart/Line/render- (3 segments, body scope)
    const class2 = ['Cart/Line/render-', 'Cart/Line/-render'];
    for (const raw of class2) {
        const r = parseReference(raw);
        assert.equal(r.canonical, 'Cart/Line/render-');
        assert.deepEqual(r.segments, ['Cart', 'Line', 'render']);
        assert.equal(r.scope, 'body');
        assert.equal(r.warning, null);
    }
});

// Group 4: grammar errors throw §9 shapes
test('parseReference: grammar errors throw §9 shapes', () => {
    assert.throws(() => parseReference(''), /names nothing/);
    assert.throws(() => parseReference('a/'), /has an empty path segment/);
    assert.throws(() => parseReference('/a'), /has an empty path segment/);
    assert.throws(() => parseReference('a//b'), /has an empty path segment/);
    assert.throws(() => parseReference('a/+b'), /"\+\" may only modify the last path segment/);
    assert.throws(() => parseReference('a/-b/c'), /"\-" may only modify the last path segment/);
    assert.throws(() => parseReference('a+++'), /carries more than one modifier/);
    assert.throws(() => parseReference('a---'), /carries more than one modifier/);
    assert.throws(() => parseReference('a/b/c/d/e/f/g/h/i'), /is deeper than 8 sections/);
    assert.throws(() => parseReference('-a-'), /carries more than one modifier/);
});

// Group 5: contradictory modifiers return warning
test('parseReference: contradictory modifiers return warning', () => {
    const cases = [
        ['a++-', '++', 'documented'],
        ['a-++', '++', 'documented'],
        ['a+-', '+', 'annotated'],
        ['a-+', '+', 'annotated'],
        ['a-/b++', '++', 'documented'],
    ];
    for (const [raw, kept, scope] of cases) {
        const r = parseReference(raw);
        assert.equal(r.scope, scope);
        assert.notEqual(r.warning, null);
        assert.equal(r.warning.kind, 'contradiction');
        assert.equal(r.warning.kept, kept);
        assert.equal(r.warning.dropped, '-');
        assert.equal(r.canonical, r.canonical.replace(/--/, '')); // canonical drops the '-'
    }
});

// Group 6: boundary - a+++ throws, a++- warns
test('parseReference: boundary between error and warning', () => {
    assert.throws(() => parseReference('a+++'), /carries more than one modifier/);
    assert.throws(() => parseReference('a---'), /carries more than one modifier/);

    const r1 = parseReference('a++-');
    assert.equal(r1.warning.kind, 'contradiction');
    assert.equal(r1.scope, 'documented');

    const r2 = parseReference('a+-');
    assert.equal(r2.warning.kind, 'contradiction');
    assert.equal(r2.scope, 'annotated');
});

// isSingleSegment / finalSegment accept Reference or string
test('parseReference: isSingleSegment and finalSegment accept Reference or string', () => {
    assert.equal(isSingleSegment('add'), true);
    assert.equal(isSingleSegment('Cart/Line'), false);
    assert.equal(isSingleSegment(parseReference('add')), true);
    assert.equal(isSingleSegment(parseReference('Cart/Line')), false);

    assert.equal(finalSegment('add'), 'add');
    assert.equal(finalSegment('Cart/Line/render'), 'render');
    assert.equal(finalSegment(parseReference('add')), 'add');
    assert.equal(finalSegment(parseReference('Cart/Line/render')), 'render');
});

// SectionReferenceError is an Error subclass
test('parseReference: SectionReferenceError is Error subclass', () => {
    try {
        parseReference('');
    } catch (e) {
        assert.ok(e instanceof SectionReferenceError);
        assert.ok(e instanceof Error);
    }
});

// error messages quote raw reference
test('parseReference: error messages quote raw reference', () => {
    assert.throws(
        () => parseReference('Cart/-Line/render'),
        /"#Cart\/-Line\/render"/
    );
});

// ---------------------------------------------------------------------------
// Scanner layer — mask pass and block scanner (step 5 of plan/section-matching)
// ---------------------------------------------------------------------------

// The mask blanks comments and string literals to spaces but preserves
// length and every newline offset.
test('masked preserves length and newline offsets', () => {
    const tricky = [
        'class X {',           // 0
        '    String s = "}";', // 1 — a brace in a string
        '    /* } */',         // 2 — a brace in a block comment
        '    // }',            // 3 — a brace in a line comment
        "    '#!/bin/sh',",    // 4 — '#' starts a comment (not before '[')
        '    let t = "a // b";', // 5 — '//' inside a string
        '    let u = "\\`x";',  // 6 — escaped backtick inside a string
        '    const v = `}',     // 7 — unterminated template literal
        '}',                    // 8
        '/* never closed',      // 9 — unterminated block comment runs to EOF
    ].join('\n');
    const m = masked(tricky);
    assert.equal(m.length, tricky.length);
    for (let i = 0; i < tricky.length; i++) {
        if (tricky[i] === '\n') assert.equal(m[i], '\n', `newline at offset ${i}`);
    }
});

// Braces, `region` words and `//` inside strings or comments must not survive
// the mask, so they cannot affect the bracket structure it produces.
test('masked blanks strings and comments, not structure', () => {
    assert.equal(masked('String s = "}";'),  'String s =    ;');   // quotes and brace blanked
    assert.equal(masked('/* } */'),          '       ');           // 7 chars
    assert.equal(masked('// }'),             '    ');              // 4 chars
    assert.equal(masked('"a // b"'),         '        ');          // 8 chars, // inside string
});

test('masked keeps Rust attributes but blanks # comments', () => {
    assert.equal(masked('#[derive(Foo)]'), '#[derive(Foo)]'); // `#` before `[` survives
    assert.equal(masked('# comment'), '         ');           // 9 chars, `#` comment blanked
});

test('masked handles triple-quoted strings', () => {
    assert.equal(masked('"""a}b"""'), '         ');           // 9 chars, all blanked
});

// The comment scanner reads the original text and does not report comment
// markers that sit inside string literals.
test('commentsIn finds real comments, not those in strings', () => {
    const c = commentsIn('x = "//not a comment"; // real');
    assert.equal(c.length, 1);
    assert.equal(c[0].text.trim(), 'real');
});

// The block scanner, on a fixture with a nested class and a constructor and
// a method: children are the blocks inside each body, in source order.
test('scanBlocks: nested class and its members', () => {
    const read = fileReader(dirname(fileURLToPath(import.meta.url)));
    const s = scanBlocks(read('test/fixtures/Example.java'));
    const cart = s.blocks.find((b) => b.kind === 'class' && b.name === 'Cart');
    assert.equal(cart.openLine, 6);
    assert.equal(cart.closeLine, 29);
    const line = s.blocks.find((b) => b.kind === 'class' && b.name === 'Line');
    assert.ok(line.parent === cart, 'Line is inside Cart');
    assert.equal(line.openLine, 16);
    assert.equal(line.closeLine, 28);
    const render = s.blocks.find((b) => b.kind === 'method' && b.name === 'render');
    assert.ok(render.parent === line, 'render is inside Line');
    assert.equal(render.openLine, 25);
    assert.equal(render.closeLine, 27);
});

// Body-less members (an interface method) are present as a name with no
// injectable span; a same-name method with a body has a span.
test('scanBlocks: body-less interface method has no span', () => {
    const s = scanBlocks('interface I {\n  void bar();\n  void baz() {\n    x();\n  }\n}');
    const bar = s.blocks.find((b) => b.name === 'bar');
    assert.ok(bar, 'bar is present as a name');
    assert.equal(bar.kind, 'method');
    assert.equal(bar.openLine, null, 'bar has no body');
    assert.equal(bar.closeLine, null);
    const baz = s.blocks.find((b) => b.name === 'baz');
    assert.equal(baz.openLine, 2);
    assert.equal(baz.closeLine, 4);
});

// Allman brace on the next line, and the two arrow forms.
test('scanBlocks: Allman brace, arrow body, expression arrow', () => {
    const allman = scanBlocks('class A {\n  void run()\n  {\n    go();\n  }\n}');
    const run = allman.blocks.find((b) => b.name === 'run');
    assert.equal(run.declLine, 1);
    assert.equal(run.openLine, 2);
    assert.equal(run.closeLine, 4);
    const arrow = scanBlocks('const sub = (a, b) => {\n  return a - b;\n};');
    const sub = arrow.blocks.find((b) => b.name === 'sub');
    assert.equal(sub.kind, 'method');
    assert.equal(sub.openLine, 0);
    assert.equal(sub.closeLine, 2);
    assert.equal(sub.expression, undefined, 'a braced arrow is not expression-bodied');
    const expr = scanBlocks('const add = (a, b) => a + b;');
    const add = expr.blocks.find((b) => b.name === 'add');
    assert.equal(add.kind, 'method');
    assert.notEqual(add.expression, undefined, 'an expression arrow records the body offset');
});

// Indented blocks (Python/Ruby): no brace, body delimited by indentation.
test('scanBlocks: indented (Python) method', () => {
    const s = scanBlocks('class Foo:\n    def bar(self):\n        return 1\n    def baz(self):\n        return 2');
    const foo = s.blocks.find((b) => b.name === 'Foo');
    assert.equal(foo.indented, true);
    const bar = s.blocks.find((b) => b.name === 'bar');
    assert.equal(bar.indented, true);
    assert.equal(bar.declLine, 1);
});

// Condition literals (matcher 5): a string literal on a statement header,
// read from the code not a comment; adjacent literals join (token paste).
test('scanBlocks: condition literals on statement headers', () => {
    const s = scanBlocks('class T {\n  void f(Object m) {\n    if ("getUsers".equals(m)) {\n      h();\n    }\n    while ("tick".equals(c)) {\n      t();\n    }\n    String unused = "getUsers";\n  }\n}');
    const ifStmt = s.blocks.find((b) => b.kind === 'statement' && b.declLine === 2);
    assert.deepEqual(ifStmt.conditions.pasted, ['getUsers']);
    const whileStmt = s.blocks.find((b) => b.kind === 'statement' && b.declLine === 5);
    assert.deepEqual(whileStmt.conditions.pasted, ['tick']);
    // A literal on a non-statement line yields nothing: no statement block
    // there, so `getUsers` on the `String unused` line is not reported.
    assert.equal(s.blocks.find((b) => b.kind === 'statement' && b.declLine === 8), undefined);
});

test('scanBlocks: token-pasted adjacent literals', () => {
    const s = scanBlocks('void f() {\n  if ("get" "Users".equals(m)) {\n    g();\n  }\n}');
    const stmt = s.blocks.find((b) => b.kind === 'statement');
    assert.deepEqual(stmt.conditions.exact, ['get', 'Users']);
    assert.deepEqual(stmt.conditions.pasted, ['getUsers']);
});

// A literal inside a comment is not a condition literal.
test('scanBlocks: comment string is not a condition literal', () => {
    const s = scanBlocks('void f() {\n  // if ("hidden".equals(m)) {\n  if ("shown".equals(m)) {\n    g();\n  }\n}');
    const stmts = s.blocks.filter((b) => b.kind === 'statement');
    assert.equal(stmts.length, 1, 'only the real if opens a block');
    assert.deepEqual(stmts[0].conditions.pasted, ['shown']);
});

// Comment anchors (matcher 6): same-line and next-line, `//` and `/* */`,
// `#region` never anchors, a non-first comment never anchors.
test('scanBlocks: comment anchors', () => {
    const s = scanBlocks('class A {\n  void one() { //getUsers\n    x();\n  }\n  void two() {\n    //getOrders\n    y();\n  }\n  void three() {\n    /*star*/\n    z();\n  }\n}');
    assert.equal(s.blocks.find((b) => b.name === 'one').anchor.name, 'getUsers');
    assert.equal(s.blocks.find((b) => b.name === 'one').anchor.line, 1);
    assert.equal(s.blocks.find((b) => b.name === 'two').anchor.name, 'getOrders');
    assert.equal(s.blocks.find((b) => b.name === 'two').anchor.line, 5);
    assert.equal(s.blocks.find((b) => b.name === 'three').anchor.name, 'star');
});

test('scanBlocks: #region line is not an anchor; non-first comment is not an anchor', () => {
    const s = scanBlocks('class A {\n  void region() {\n    // #region foo\n    x();\n  }\n  void late() {\n    code();\n    //notFirst\n    y();\n  }\n}');
    assert.equal(s.blocks.find((b) => b.name === 'region').anchor, null);
    assert.equal(s.blocks.find((b) => b.name === 'late').anchor, null);
});

test('scanBlocks: the anchor name is the whole trimmed comment body', () => {
    const s = scanBlocks('class A {\n  void one() {\n    // getUsers\n    x();\n  }\n  void two() {\n    // getUsers and more\n    x();\n  }\n}');
    assert.equal(s.blocks.find((b) => b.name === 'one').anchor.name, 'getUsers');
    assert.equal(s.blocks.find((b) => b.name === 'two').anchor, null, 'multi-word body is not an anchor');
});

// Region directives: example.ts has top-level `table` and `config` regions,
// the injected text being the lines strictly between the directives.
test('scanBlocks: region directives on example.ts', () => {
    const read = fileReader(dirname(fileURLToPath(import.meta.url)));
    const s = scanBlocks(read('test/fixtures/example.ts'));
    const byName = {};
    for (const r of s.regions) byName[r.name] = r;
    assert.equal(s.regions.length, 2);
    assert.deepEqual([byName.table.startLine, byName.table.endLine], [0, 4]);
    assert.deepEqual([byName.config.startLine, byName.config.endLine], [6, 8]);
    const tableText = read('test/fixtures/example.ts').replace(/\r\n/g, '\n').split('\n').slice(byName.table.startLine + 1, byName.table.endLine).join('\n');
    assert.match(tableText, /\| name \| qty \|/);
});

// ---------------------------------------------------------------------------
// Resolve layer — matcher precedence, scope walk, modifiers (step 6)
// ---------------------------------------------------------------------------
// These pin contract §12 acceptance bytes through `resolveSection` directly.
// `extractCodeRegion` still delegates to the old code path until step 7, so
// the step 3 tests (which call it) stay red until then.

// --- §12 Example.java: today's bytes are reproduced byte-for-byte ---
test('resolveSection: Example.java modifiers unchanged', () => {
    assert.equal(resolveSection(EXAMPLE, 'toString'),
        '    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(resolveSection(EXAMPLE, 'toString-'), '        return String.join(",", items);');
    assert.equal(resolveSection(EXAMPLE, '-toString'), '        return String.join(",", items);');
    assert.equal(resolveSection(EXAMPLE, 'toString+'),
        '    @Override\n    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(resolveSection(EXAMPLE, '+toString'),
        '    @Override\n    public String toString() {\n        return String.join(",", items);\n    }');
    assert.equal(resolveSection(EXAMPLE, 'toString++'),
        '    /** Add one item to this cart. */\n'
        + '    @Override\n'
        + '    public String toString() {\n'
        + '        return String.join(",", items);\n'
        + '    }');
    assert.equal(resolveSection(EXAMPLE, '++toString'), resolveSection(EXAMPLE, 'toString++'));
    assert.equal(resolveSection(EXAMPLE, 'Line'),
        '    public static class Line {\n'
        + '        private final String name;\n        private final int quantity;\n\n'
        + '        Line(String name, int quantity) {\n'
        + '            this.name = name;\n            this.quantity = quantity;\n        }\n\n'
        + '        String render() {\n            return name + " x" + quantity;\n        }\n    }');
});

// --- §12 Example.java: slashed paths and descent ---
test('resolveSection: nested references', () => {
    assert.equal(resolveSection(EXAMPLE, 'Cart/Line'), resolveSection(EXAMPLE, 'Line'));
    assert.equal(resolveSection(EXAMPLE, 'Cart/toString'), resolveSection(EXAMPLE, 'toString'));
    assert.equal(resolveSection(EXAMPLE, 'Cart/Line/render'),
        '        String render() {\n            return name + " x" + quantity;\n        }');
    assert.equal(resolveSection(EXAMPLE, 'Cart/Line/render-'), '            return name + " x" + quantity;');
    assert.equal(resolveSection(EXAMPLE, 'Cart/Line/-render'), '            return name + " x" + quantity;');
    assert.equal(resolveSection(EXAMPLE, 'Cart/Line-'),
        '        private final String name;\n'
        + '        private final int quantity;\n'
        + '\n'
        + '        Line(String name, int quantity) {\n'
        + '            this.name = name;\n'
        + '            this.quantity = quantity;\n'
        + '        }\n'
        + '\n'
        + '        String render() {\n'
        + '            return name + " x" + quantity;\n'
        + '        }');
});

// --- §12 Anchors.java: condition literals and comment anchors ---
test('resolveSection: anchors and condition literals', () => {
    // Sibling before deeper: the anchor on handler is a member of the class
    // scope, so it beats the condition literal nested inside dispatch.
    assert.equal(resolveSection(ANCHORS, 'getUsers'),
        '    public void handler() { //getUsers\n'
        + '        System.out.println("anchor same line");\n'
        + '    }');
    assert.equal(resolveSection(ANCHORS, 'getUsers-'), '        System.out.println("anchor same line");');
    assert.equal(resolveSection(ANCHORS, 'dispatch/getUsers'),
        '        if ("getUsers".equals(methodName)) {\n'
        + '            System.out.println("users");\n'
        + '        }');
    assert.equal(resolveSection(ANCHORS, 'getOrders'),
        '    public void other() {\n'
        + '        //getOrders\n'
        + '        System.out.println("anchor next line");\n'
        + '    }');
    assert.equal(resolveSection(ANCHORS, 'dispatch/getOrders'),
        '        } else if ("getOrders".equals(methodName)) {\n'
        + '            System.out.println("orders");\n'
        + '        }');
    assert.equal(resolveSection(ANCHORS, 'handler/getUsers'),
        '    public void handler() { //getUsers\n'
        + '        System.out.println("anchor same line");\n'
        + '    }');
    assert.equal(resolveSection(ANCHORS, 'handler/getUsers-'), '        System.out.println("anchor same line");');
    assert.equal(resolveSection(ANCHORS, 'other/getOrders'),
        '    public void other() {\n'
        + '        //getOrders\n'
        + '        System.out.println("anchor next line");\n'
        + '    }');
    assert.equal(resolveSection(ANCHORS, 'other/getOrders-'), '        System.out.println("anchor next line");');

    // Negative: a string-literal mention is not a condition literal (§12).
    assert.throws(() => resolveSection(ANCHORS, 'commentFromString/getUsers'),
        /no section named "getUsers" in "commentFromString"/);
    assert.throws(() => resolveSection(ANCHORS, 'commentFromString/getUsers-'),
        /no section named "getUsers" in "commentFromString"/);
});

// Walk order: a shallower sibling beats a deeper block, whatever the source
// order and whatever the matcher precedence would have said at equal depth. The
// anchor on `zzz` is a member of the class scope; the condition literal sits one
// level deeper, inside `aaa`.
test('resolveSection: walk order searches siblings before descending', () => {
    const text = [
        'class W {',                    // 0
        '    void zzz() { //getUsers',  // 1 — the shallower candidate
        '        a();',                 // 2
        '    }',                        // 3
        '    void aaa() {',             // 4
        '        if ("getUsers".equals(x)) {', // 5 — deeper, inside aaa
        '            b();',             // 6
        '        }',                    // 7
        '    }',                        // 8
        '}',                            // 9
    ].join('\n');
    assert.equal(resolveSection(text, 'getUsers'),
        '    void zzz() { //getUsers\n        a();\n    }');
    // The deeper block stays reachable through its explicit scope.
    assert.equal(resolveSection(text, 'aaa/getUsers'),
        '        if ("getUsers".equals(x)) {\n            b();\n        }');
});

// The motivating shape: a method and a same-named block inside an earlier
// method of the same class. The method is the shallower sibling, so a bare
// reference targets it; the block needs the explicit path.
test('resolveSection: a method beats a same-named block in an earlier sibling method', () => {
    const text = [
        'class Svc {',                              // 0
        '    void bar() {',                         // 1 — comes sooner
        '        if ("doSomeAction".equals(m)) {',  // 2
        '            legacy();',                    // 3
        '        }',                                // 4
        '    }',                                    // 5
        '    void doSomeAction() {',                // 6
        '        current();',                       // 7
        '    }',                                    // 8
        '}',                                        // 9
    ].join('\n');
    assert.equal(resolveSection(text, 'doSomeAction'),
        '    void doSomeAction() {\n        current();\n    }');
    assert.equal(resolveSection(text, 'bar/doSomeAction'),
        '        if ("doSomeAction".equals(m)) {\n            legacy();\n        }');
});

// --- §12 error shapes ---
test('resolveSection: error shapes', () => {
    assert.throws(() => resolveSection(EXAMPLE, 'Line/toString'),
        /no section named "toString" in "Line"/);
    assert.throws(() => resolveSection(EXAMPLE, 'Cart/Line/render/extra'),
        /no section named "extra" in "render"/);
    assert.throws(() => resolveSection(ANCHORS, 'getusers'),
        /no "#region getusers" found/);
    assert.throws(() => resolveSection(EXAMPLE, 'nope/deeper'),
        /no section named "nope"/);
});

// --- Regions beat declarations and ignore the modifier (§6/§8) ---
test('resolveSection: region directives', () => {
    const read = fileReader(dirname(fileURLToPath(import.meta.url)));
    const ts = read('test/fixtures/example.ts');
    assert.equal(resolveSection(ts, 'table'), '| name | qty |\n| ---- | --- |\n| bolt | 12  |');
    assert.equal(resolveSection(ts, 'table+'), resolveSection(ts, 'table'), 'region ignores modifier');
    assert.equal(resolveSection(ts, 'table++'), resolveSection(ts, 'table'));
    assert.equal(resolveSection(ts, 'config'), 'export const config = { retries: 3 };');
});

// A file-scope #region name beats a same-named declaration anywhere (§6 note).
test('resolveSection: region outranks a declaration', () => {
    const text = [
        '// #region thing',  // 0
        'region body',       // 1
        '// #endregion',     // 2
        'class C {',         // 3
        '    void thing() {',// 4
        '        x();',      // 5
        '    }',             // 6
        '}',                 // 7
    ].join('\n');
    assert.equal(resolveSection(text, 'thing'), 'region body');
});

// --- Ambiguity pin: two inner classes each have `render` ---
test('resolveSection: ambiguous name resolves to the first in the walk', () => {
    const text = [
        'class Outer {',            // 0
        '    class A {',            // 1
        '        void render() {',  // 2
        '            one();',       // 3
        '        }',                // 4
        '    }',                    // 5
        '    class B {',            // 6
        '        void render() {',  // 7
        '            two();',       // 8
        '        }',                // 9
        '    }',                    // 10
        '}',                        // 11
    ].join('\n');
    assert.equal(resolveSection(text, 'A/render'),
        '        void render() {\n            one();\n        }');
    assert.equal(resolveSection(text, 'B/render'),
        '        void render() {\n            two();\n        }');
    assert.equal(resolveSection(text, 'render'), resolveSection(text, 'A/render'),
        'a bare name resolves to whichever comes first');
});

// --- Contradiction warnings (§11): the `++` reading wins, warning is set ---
test('planSection: contradiction resolves to the dominant reading with a warning', () => {
    const expected = '    public void handler() { //getUsers\n'
        + '        System.out.println("anchor same line");\n'
        + '    }';
    for (const ref of ['getUsers++-', 'getUsers-++', 'getUsers+-', 'getUsers-+']) {
        const plan = planSection(ANCHORS, ref);
        assert.equal(plan.text, expected, `${ref} resolves to the ++/dominant reading`);
        assert.ok(plan.reference.warning !== null, `${ref} carries a contradiction warning`);
    }
    // A non-contradictory reference carries no warning.
    assert.equal(planSection(ANCHORS, 'getUsers').reference.warning, null);
});

// ---------------------------------------------------------------------------
// Lexer hook — per-type tokenizers, the default engine, and the visitor
// ---------------------------------------------------------------------------
// `lib/section.mjs` owns structure, precedence, the sibling-first walk and the
// modifier-on-last rule. A language lexer supplies only the lexical mask and
// comment spans; `index.mjs` selects one by file extension and falls back to the
// built-in default engine when the type is unknown. These pin that seam.

const lexRead = fileReader(dirname(fileURLToPath(import.meta.url)));
const NESTING_ZIG = lexRead('test/fixtures/Nesting.zig');

// Contract §10: the vendorable module imports nothing. Codified here so it cannot rot.
test('lexer hook: lib/section.mjs is dependency-free (vendorable boundary)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'section.mjs'), 'utf8');
    assert.doesNotMatch(src, /^\s*import\s/m, 'no ESM imports');
    assert.doesNotMatch(src, /\brequire\s*\(/, 'no require');
    assert.doesNotMatch(src, /node:/, 'no node builtins');
});

test('lexer hook: lexerFor maps known types and omits unknown ones', () => {
    assert.equal(lexerFor('a/b/C.java').name, 'java');
    assert.equal(lexerFor('x.y/Z.kt') === undefined, true, 'no Kotlin lexer -> default engine');
    for (const ext of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts']) {
        assert.equal(lexerFor(`src/mod.${ext}`).name, 'javascript', ext);
    }
    assert.equal(lexerFor('pkg/main.zig').name, 'zig');
    assert.equal(lexerFor('notes.md') === undefined, true, 'markdown is not code');
    assert.equal(lexerFor('Makefile') === undefined, true, 'no extension');
    assert.equal(lexerFor('.gitignore') === undefined, true, 'dotfile, not a suffix');
    assert.equal(new Set(Object.values(LEXERS)).size, 3, 'three distinct lexers');
});

test('lexer hook: a known-type lexer resolves byte-identical to the default engine', () => {
    for (const ref of ['getUsers', 'getUsers-', 'getOrders', 'dispatch/getUsers', 'handler/getUsers']) {
        assert.equal(resolveSection(ANCHORS, ref, lexerJava), resolveSection(ANCHORS, ref), `Anchors ${ref}`);
    }
    for (const ref of ['toString', 'toString++', 'Line', 'Cart/Line/render', 'Cart/Line/render-']) {
        assert.equal(resolveSection(EXAMPLE, ref, lexerJava), resolveSection(EXAMPLE, ref), `Example ${ref}`);
    }
    const ts = lexRead('test/fixtures/example.ts');
    for (const ref of ['table', 'config']) {
        assert.equal(resolveSection(ts, ref, lexerJS), resolveSection(ts, ref), `TS ${ref}`);
    }
});

test('lexer hook: the modifier still binds only to the last segment through a lexer', () => {
    assert.equal(resolveSection(EXAMPLE, 'Cart/Line/render-', lexerJava),
        '            return name + " x" + quantity;');
    assert.throws(() => resolveSection(EXAMPLE, 'Cart/-Line/render', lexerJava),
        /may only modify the last path segment/);
});

test('lexer hook: the Zig lexer hides a declaration a nested block comment wraps', () => {
    // The default mask is non-nesting, so it leaks `fn decoy` out of the comment.
    assert.match(resolveSection(NESTING_ZIG, 'decoy'), /fn decoy\(\) void/);
    // The Zig lexer blanks the whole nested comment, so `decoy` is not a section.
    assert.throws(() => resolveSection(NESTING_ZIG, 'decoy', lexerZig),
        /no section named "decoy"/);
    // Both engines find the real target, byte-identical.
    assert.equal(resolveSection(NESTING_ZIG, 'target', lexerZig), resolveSection(NESTING_ZIG, 'target'));
    assert.match(resolveSection(NESTING_ZIG, 'target', lexerZig), /fn target\(\) void/);
});

test('lexer hook: a lexer that breaks the mask invariant fails loudly, naming itself', () => {
    const short = { name: 'short', mask: (s) => s.slice(0, -1), comments: () => [] };
    assert.throws(() => resolveSection(EXAMPLE, 'toString', short),
        /lexer "short" mask must preserve length/);
    const eatsNewline = { name: 'flat', mask: (s) => s.replace(/\n/g, ' '), comments: () => [] };
    assert.throws(() => resolveSection(EXAMPLE, 'toString', eatsNewline),
        /lexer "flat" mask must preserve every newline offset/);
});

test('lexer hook: the shared tokenizer preserves length and every newline offset', () => {
    for (const [syntax, src] of [
        [JS_SYNTAX, 'const s = `a\nb`; // c\n{ d }'],
        [JAVA_SYNTAX, 'String s = """\nx\n"""; /* c */ class T {}'],
        [ZIG_SYNTAX, 'const p = "a"; /* o /* i */ sneaky { */ fn f() void {}'],
    ]) {
        const { masked } = tokenize(src, syntax);
        assert.equal(masked.length, src.length, syntax.name);
        for (let i = 0; i < src.length; i++) {
            if (src[i] === '\n') assert.equal(masked[i], '\n', `${syntax.name} @${i}`);
        }
    }
});

test('lexer hook: the visitor enumerates a file in one pass without resolving', () => {
    const seen = { comments: [], strings: 0, ifs: 0 };
    visitJava('class C { // anchor\n void f() { if ("go".equals(m)) {} } }', {
        comment: (c) => seen.comments.push(c.text.trim()),
        string: () => { seen.strings++; },
        ifClause: () => { seen.ifs++; },
    });
    assert.deepEqual(seen.comments, ['anchor'], 'the line comment is reported once, body only');
    assert.equal(seen.strings, 1, 'the string literal is enumerated');
    assert.equal(seen.ifs, 1, 'the if clause is enumerated from the mask');

    // Zig nested comment counts as ONE comment; `//!` and `///` are line comments.
    const zig = { comments: 0, strings: 0 };
    visitZig(NESTING_ZIG, { comment: () => { zig.comments++; }, string: () => { zig.strings++; } });
    assert.equal(zig.comments, 3, 'the two doc lines and the one nested block comment');
    assert.equal(zig.strings, 1, 'the @import("std") literal');
});

test('lexer hook: scanJS/scanJava/scanZig keep their original sample shape', () => {
    const java = scanJava('void f() { if ("getUsers".equals(m)) { g(); } }', 'getUsers');
    assert.deepEqual(java, [{ type: 'if_clause', line: 1, col: 12, snippet: 'if ("getUsers".equals(m))' }]);
    assert.equal(scanJava('void f() { if ("x".equals(m)) {} }', 'getUsers').length, 0, 'target filters');
    // `if` inside a string is never reported (detected on the mask).
    assert.equal(scanJS('const s = "if (a) {"; f();', 'if').length, 0);
    assert.equal(scanZig('fn f() void { if ("tick"==c) {} }', 'tick').length, 1);
});

test('lexer hook: index.mjs resolves a marker through the extension lexer end to end', () => {
    const read = (p) => (p === 'Nesting.zig' ? NESTING_ZIG : (() => { throw new Error('ENOENT ' + p); })());
    const ok = planMarker(parseMarker('[Nesting.zig](./Nesting.zig#target)'), read);
    assert.match(ok.text, /fn target\(\) void/, 'the wired path finds the real target');
    assert.throws(() => planMarker(parseMarker('[Nesting.zig](./Nesting.zig#decoy)'), read),
        /no section named "decoy"/, 'the Zig lexer hides the commented declaration');
    // extractCodeRegion threads the lexer for a known path and defaults otherwise.
    assert.equal(extractCodeRegion(NESTING_ZIG, 'target', 'x/main.zig'), resolveSection(NESTING_ZIG, 'target', lexerZig));
    assert.equal(extractCodeRegion(ANCHORS, 'getUsers', 'notes.txt'), resolveSection(ANCHORS, 'getUsers'), 'unknown type -> default engine');
});

// ---------------------------------------------------------------------------
// Step 7 — warning surfaces through the library (planMarker/updateDocument)
// and the CLI (exit code + stderr line), and the delegation is byte-identical
// ---------------------------------------------------------------------------

test('planMarker carries the section warning for a contradiction', () => {
    const read = fileReader(dirname(fileURLToPath(import.meta.url)));
    const plan = planMarker(parseMarker('[test/fixtures/Anchors.java](./test/fixtures/Anchors.java#getUsers++-)'), read);
    assert.equal(plan.text, resolveSection(ANCHORS, 'getUsers++-'));
    assert.ok(plan.warning !== null, 'warning surfaced through planMarker');
    assert.equal(plan.warning.kind, 'contradiction');
    assert.match(plan.warning.message, /"\+\+" contradicts "-"/);
    assert.match(plan.warning.message, /using "#getUsers\+\+"/);
    // resolveMarker stays a string and drops the warning.
    assert.equal(typeof resolveMarker(parseMarker('[test/fixtures/Anchors.java](./test/fixtures/Anchors.java#getUsers)'), read), 'string');
});

test('updateDocument reports a warning and stays idempotent', () => {
    const read = fileReader(dirname(fileURLToPath(import.meta.url)));
    const doc = [
        '[test/fixtures/Anchors.java](./test/fixtures/Anchors.java#getUsers++-)',
        '```java',
        'stale',
        '```',
    ].join('\n');
    const first = updateDocument(doc, { readFile: read });
    assert.equal(first.results.length, 1);
    assert.ok(first.results[0].warning !== null, 'the contradiction warning rides on the result');
    assert.equal(first.changed, true);
    assert.match(first.text, /public void handler\(\) \{ \/\/getUsers/);
    assert.doesNotMatch(first.text, /stale/);

    const second = updateDocument(first.text, { readFile: read });
    assert.equal(second.changed, false, 'a second pass is a no-op');
    assert.ok(second.results[0].warning !== null, 'the warning is reported again on the second pass');
});

test('updateDocument: an over-concrete reference is an error, not a warning', () => {
    const read = fileReader(dirname(fileURLToPath(import.meta.url)));
    const doc = [
        '[test/fixtures/Anchors.java](./test/fixtures/Anchors.java#getUsers+++)',
        '```java',
        'x',
        '```',
    ].join('\n');
    // `a+++`-shaped references throw (strict), the error is not a warning.
    assert.throws(() => updateDocument(doc, { readFile: read }), /more than one modifier/);
});

test('CLI: a contradiction warns and forces exit 1 even when the block is fresh', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.cli-warn-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const java = [
        'class C {',
        '    void f() {',
        '        if ("getUsers".equals(m)) {',
        '            go();',
        '        }',
        '    }',
        '}',
    ].join('\n');
    writeFileSync(join(dir, 'C.java'), java + '\n');
    const docPath = join(dir, 'doc.md');
    writeFileSync(docPath, [
        '[C.java](./C.java#getUsers++-)',
        '',
        '```java',
        'stale',
        '```',
    ].join('\n'));

    // Capture stderr to assert the warning line, mirroring the failure-warning shape.
    const captured = [];
    const original = console.error;
    console.error = (...a) => captured.push(a.join(' '));
    try {
        assert.equal(main([docPath]), 1, 'a warning exits 1');
        assert.equal(main([docPath, '--check']), 1, 'a warning exits 1 in --check even when nothing is stale');
    } finally {
        console.error = original;
    }

    const line = captured.find((s) => /warn:.*getUsers\+\+-.*contradicts/.test(s));
    assert.ok(line, `warning line printed, saw: ${JSON.stringify(captured)}`);
    assert.ok(line.startsWith('inject-examples: warn:'), 'same shape as a failure warning');
    assert.ok(line.includes(':1:'), 'reports the marker line (1-based)');
    assert.ok(line.includes('#getUsers++-'), 'quotes the raw marker');
    assert.ok(line.includes('"++" contradicts "-"'), 'the contradiction message');
    assert.ok(line.includes('using "#getUsers++"'), 'the canonical reference');
    assert.match(line, /"\+\+" contradicts "-"/);
    assert.match(line, /using "#getUsers\+\+"/);
    // --check with nothing stale but a warning still returns 1 (asserted above),
    // and the document was written by the first (non-check) run.
    assert.match(readFileSync(docPath, 'utf8'), /if \("getUsers"\.equals/);
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
        resolveMarker(parseMarker('[data.json](./data.json#name)'), read),
        '{\n  "name": "acme"\n}',
    );
    assert.equal(
        resolveMarker(parseMarker('[code.ts](./code.ts#add)'), read),
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
    const doc = ['[data.json](./data.json#scripts)', '```', 'stale', '```'].join('\n');
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
    const doc = ['[notes.txt](./notes.txt#eight)', '```', 'stale', '```'].join('\n');
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
        reference: null,
    });
    assert.deepEqual(parseMarker('[fixtures/a.md](fixtures/a.md)')?.path, 'fixtures/a.md');
    assert.deepEqual(parseMarker('  [a.md](./a.md)  ')?.raw, '[a.md](./a.md)', 'outer space is trimmed');
});

test('parseMarker reads a region marker', () => {
    assert.deepEqual(parseMarker('[src/app.ts](./src/app.ts#table)'), {
        raw: '[src/app.ts](./src/app.ts#table)',
        path: 'src/app.ts',
        reference: 'table',
    });
});

test('parseMarker leaves ordinary links alone', () => {
    assert.equal(parseMarker('[the docs](./docs/README.md)'), null, 'label must name the path');
    assert.deepEqual(parseMarker('[a.md](./a.md#install)'), { raw: '[a.md](./a.md#install)', path: 'a.md', reference: 'install' }, 'any fragment names a section');
    assert.equal(parseMarker('[install](#install)'), null, 'an in-page link (no path) is navigation, not a marker');
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
        resolveMarker(parseMarker('[big.md](./big.md#table)'), read),
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
    '[fixtures/big.md](./fixtures/big.md#table)',
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
    let doc = ['[big.md](./big.md#missing)', '```', 'old', '```'].join('\n');
    let result = updateDocument(doc, { readFile: read, lenient: true });
    assert.match(
        result.results[0].failure,
        /no "#region missing" found/,
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

    const parse = resolveMarker(parseMarker('[index.mjs](index.mjs#parseMarker)'), read);
    assert.match(parse, /^\/\*\*\n \* Read one line as an injection marker/);
    assert.match(parse, /export function parseMarker\(line\)/);

    const testCode = resolveMarker(parseMarker('[test.mjs](test.mjs#update-document-test)'), read);
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
    // Not a marker *count* (it rotted the first time a marker was added and
    // would rot again). The property the count approximated is that the
    // document is honest: every marker is backed by a fenced block, every one
    // resolves cleanly, and none of its content drifted.
    const lines = doc.replace(/\r\n/g, '\n').split('\n');
    const markers = findMarkers(lines);
    const fenceOpens = fenceRanges(lines).map(([open]) => open);
    for (const marker of markers) {
        let j = marker.index + 1;
        while (j < lines.length && lines[j].trim() === '') j++;   // a blank may separate marker and fence
        assert.ok(fenceOpens.includes(j), `doc/usage.md:${marker.index + 1}: marker has no fenced block below it`);
    }
    for (const entry of result.results) {
        assert.equal(entry.skipped, false);
        assert.equal(entry.failure, undefined);
        assert.ok(entry.warning === null, `doc/usage.md:${entry.marker.index + 1}: unexpected section warning`);
        assert.ok(existsSync(resolve(join(root, 'doc'), entry.marker.path)), `marker target exists: ${entry.marker.path}`);
    }
    assert.ok(markers.length >= 15, 'the document still shows its files, regions and declarations');
});

// ---------------------------------------------------------------------------
// The demo page — docs/index.html is generated from docs/demo.md
// ---------------------------------------------------------------------------
//
// `tools/build-demo.mjs` turns the Markdown document into the two-pane page:
// every section becomes a numbered paragraph, every marker a clickable target,
// and the lines a reference selects are the lines the page highlights. Both
// halves are the library's own answer — `planSection` for the text,
// `locateRange` for where it sits — so these tests check the page against the
// resolver, not against a copy of its logic.

import {
    buildDemo,
    locateRange,
    parseDemoDoc,
    renderMarkdown,
    run as runBuildDemo,
} from './tools/build-demo.mjs';

test('demo: the source document is read as numbered sections with targets', () => {
    const doc = parseDemoDoc([
        '# A title',
        '',
        'Intro prose.',
        '',
        '## First section',
        '',
        'Why it matters.',
        '',
        '[a/b.java](./a/b.java#one)',
        '',
        '```java',
        '[a/b.java](./a/b.java#inside-a-fence)',
        '```',
        '',
        '## Second section',
        '',
        '[a/b.java](./a/b.java)',
        '',
        '```java',
        '```',
    ].join('\n'));

    assert.equal(doc.title, 'A title');
    assert.deepEqual(doc.sections.map((section) => section.title), ['First section', 'Second section']);

    const markers = doc.sections.flatMap((section) => section.blocks.filter((block) => block.type === 'marker'));
    assert.deepEqual(markers.map((block) => [block.marker.path, block.marker.reference]),
        [['a/b.java', 'one'], ['a/b.java', null]],
        'a marker inside a fence is content, exactly as the tool reads it');

    const first = doc.sections[0].blocks.map((block) => block.type);
    assert.deepEqual(first, ['prose', 'marker'], 'prose and markers keep their document order');
});

test('demo: a marker outside any section is an error, not a silent drop', () => {
    const read = (path) => (path === 'demo.md'
        ? '# A title\n\n[a/b.java](./a/b.java#one)\n'
        : 'class B {}\n');
    assert.throws(() => buildDemo({ root: '.', docPath: 'demo.md', read }),
        /a marker outside any "##" section/);
});

test('demo: locateRange finds the lines a reference selects', () => {
    assert.deepEqual(locateRange('a\nb\nc\nd\n', 'b\nc', 'x'), { from: 2, to: 3 });
    assert.deepEqual(locateRange('a\nb\nc\nd\n', 'a\nb\nc\nd', null), { from: 1, to: 4 });
    assert.equal(locateRange('a\nb\n', 'zz', 'x'), null, 'text that is not in the file has no range');
    assert.equal(locateRange('a\nb\n', '', 'x'), null, 'an empty selection has no range');
    assert.equal(locateRange('', '', null), null, 'an empty file has no lines');

    // A whole-line occurrence beats a loose fragment earlier in the file.
    assert.deepEqual(locateRange('foo n;\nn;\n', 'n;', 'x'), { from: 2, to: 2 });
    // A reference that resolves to part of a line still names that line.
    assert.deepEqual(locateRange('int x = 41;\n', '41', 'x'), { from: 1, to: 1 });
});

test('demo: every target in docs/demo.md lands on the lines it injects', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const docText = readFileSync(join(root, 'docs', 'demo.md'), 'utf8');

    const synced = updateDocument(docText, { root: join(root, 'docs'), gitignore: false });
    assert.equal(synced.changed, false, 'docs/demo.md must match docs/samples/Inventory.java');
    for (const entry of synced.results) {
        assert.equal(entry.skipped, false, `${entry.marker.raw} must resolve`);
        assert.ok(entry.warning === null, `${entry.marker.raw}: unexpected section warning`);
    }

    const { html, model } = buildDemo({ root });
    assert.ok(model.exampleCount >= 9, 'the page shows a substantial set of targets');
    assert.equal(model.files.length, 1, 'one sample file backs the page');

    for (const section of model.sections) {
        for (const example of section.examples) {
            const file = model.files.find((candidate) => candidate.path === example.path);
            assert.ok(file, `${example.raw}: the target file is on the page`);
            assert.ok(example.from >= 1 && example.to <= file.lines.length,
                `${example.raw}: the range is inside ${file.path}`);
            const highlighted = file.lines.slice(example.from - 1, example.to).join('\n');
            assert.equal(example.to - example.from + 1, example.text.split('\n').length,
                `${example.raw}: the range spans the injected lines`);
            assert.ok(highlighted.startsWith(example.text),
                `${example.raw}: the highlighted lines are exactly the injected text`);
            assert.ok(html.includes(`id="${example.id}"`), `${example.raw}: the target is clickable`);
            assert.ok(html.includes(`data-from="${example.from}" data-to="${example.to}"`),
                `${example.raw}: the range travels to the page`);
            assert.ok(html.includes(`data-section="${example.section}"`),
                `${example.raw}: the target names the Markdown section it lives in`);
            assert.ok(html.includes(`data-marker="${example.id}"`),
                `${example.raw}: the marker line is addressable in the rendered Markdown`);
            assert.ok(html.includes(`data-inject="${example.id}"`),
                `${example.raw}: the injected block is addressable in the rendered Markdown`);
        }
    }

    assert.ok(html.includes('data-file="samples/Inventory.java"'), 'the file pane is wired to the target');
    assert.ok(html.includes('<span class="tok-k">public</span>'), 'the sample is highlighted by the tokenizer');
});

test('demo: the rendered Markdown keeps its shape and marks each injection', () => {
    const text = [
        '# A title',
        '',
        'Prose with **bold**, `code` and a [link](./a.md).',
        '',
        '## A section',
        '',
        '- one',
        '- two',
        '',
        '[a/b.java](./a/b.java#one)',
        '',
        '```java',
        'class A<T> { }',
        '```',
    ].join('\n');

    const html = renderMarkdown(text, { markerIds: new Map([[10, 't-2-1']]) });
    assert.match(html, /<h1 data-md-from="1" data-md-to="1">A title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<a href="\.\/a\.md">link<\/a>/);
    assert.match(html, /<h2 data-md-from="5" data-md-to="5">A section<\/h2>/);
    assert.match(html, /<ul data-md-from="7" data-md-to="8">/);
    assert.match(html, /<p class="md-marker" data-marker="t-2-1"><a href="\.\/a\/b\.java#one">a\/b\.java<\/a>/);
    assert.match(html, /<pre class="md-pre" data-inject="t-2-1" data-md-from="12" data-md-to="14">/);
    assert.match(html, /<code class="language-java">class A&lt;T&gt; \{ \}<\/code>/, 'code is escaped');
    assert.equal((html.match(/data-md-section="/g) ?? []).length, 2, 'a lead section plus one per "##"');
});

test('demo: the page is three titled columns', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const { html, model } = buildDemo({ root });

    for (const column of ['pane-left', 'pane-mid', 'pane-right']) {
        assert.ok(html.includes(`class="pane ${column}"`), `the ${column} column exists`);
    }
    for (const title of ['Targets', 'Source file', 'Markdown']) {
        assert.ok(html.includes(`<div class="col-head">${title}<`), `the ${title} column is titled`);
    }
    assert.ok(html.includes('<article class="md">'), 'the rendered document is the third column');
    assert.equal((html.match(/data-md-section="/g) ?? []).length, model.sections.length + 1);
});

test('demo: the committed docs/index.html is exactly what the generator writes', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const { html } = buildDemo({ root });
    assert.equal(readFileSync(join(root, 'docs', 'index.html'), 'utf8'), html,
        'run: bun tools/build-demo.mjs');
});

test('demo: --check reports a stale page and --out writes a fresh one', (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.demo-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const page = join(dir, 'index.html');

    const lines = [];
    const io = { out: (line) => lines.push(line), err: (line) => lines.push(line) };

    assert.equal(runBuildDemo(['--out', page], io), 0, 'writes the page');
    assert.ok(existsSync(page), 'the page is written');
    assert.equal(runBuildDemo(['--check', '--out', page], io), 0, 'a fresh page passes --check');

    writeFileSync(page, 'stale\n');
    assert.equal(runBuildDemo(['--check', '--out', page], io), 1, 'a stale page fails --check');
    assert.match(lines.join('\n'), /stale/);

    assert.equal(runBuildDemo(['--bogus'], io), 2, 'an unknown flag is a usage error');
    assert.equal(runBuildDemo(['--check'], io), 0, 'the default page is current');
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
        // Normalise endings first: a Windows checkout with `core.autocrlf` hands
        // back CRLF, and a trailing `\r` would hide every heading from the scan.
        const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');

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

// ---------------------------------------------------------------------------
// Golden vectors — assert the committed JSON against a live implementation
// call (step 8 of plan/section-matching). `--check` catches "the implementation
// changed, the file did not"; this catches "someone relaxed a case so --check
// would still pass".
// ---------------------------------------------------------------------------
test('section vectors match a live implementation call', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const vectors = JSON.parse(readFileSync(join(root, 'test/vectors/section-vectors.json'), 'utf8'));
    assert.ok(Array.isArray(vectors) && vectors.length >= 50, 'a substantial vector set');

    for (const c of vectors) {
        let ref = null;
        let parseErr = null;
        try { ref = parseReference(c.reference); } catch (e) { parseErr = e; }

        // Warnings are the parser's own; compare the projected fields.
        const liveWarning = ref && ref.warning
            ? { kind: ref.warning.kind, kept: ref.warning.kept, dropped: ref.warning.dropped }
            : null;
        assert.deepEqual(c.warning, liveWarning, `${c.name}: warning`);

        if (parseErr) {
            assert.equal(c.text, null, `${c.name}: a grammar error has no text`);
            assert.ok(c.error !== null, `${c.name}: a grammar error records its message`);
            assert.equal(c.error, parseErr.message, `${c.name}: grammar error message`);
            continue;
        }
        // Parse-success vectors carry a resolution result (text or error) or
        // are parse-only probes (both null) whose value is the parsed warning.
        if (c.text !== null) {
            assert.equal(c.error, null, `${c.name}: exactly one of text/error`);
            assert.equal(resolveSection(readFileSync(join(root, c.input), 'utf8'), c.reference, lexerFor(c.input)), c.text,
                `${c.name}: text`);
        } else if (c.error !== null) {
            assert.throws(() => resolveSection(readFileSync(join(root, c.input), 'utf8'), c.reference, lexerFor(c.input)),
                (e) => { assert.equal(e.message, c.error, `${c.name}: error message`); return true; });
        }
    }
});
