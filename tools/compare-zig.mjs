// @ts-check
// Differential test: run `cli.mjs` and the Zig twin on the same corpus and
// compare everything a user can see — stdout, stderr, exit code, and every byte
// of every file the run touched — and report any difference.
//
//     node tools/compare-zig.mjs
//     node tools/compare-zig.mjs --seed 0x1234 --rounds 500
//
// The corpus is the repository's own documents plus a list of edge cases plus a
// seeded fuzzer. A scenario is a small tree of files and a command line; the
// scenario is copied twice, once per tool, each tool runs in its own copy, and
// the two copies are then compared file by file. Nothing here is a near-miss
// check: every comparison is exact.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JS_TOOL = join(ROOT, 'cli.mjs');
const ZIG_TOOL = process.platform === 'win32'
    ? join(ROOT, 'zig-out', 'inject-examples.exe')
    : join(ROOT, 'zig-out', 'inject-examples');
const TMP = join(ROOT, '.compare-tmp');

if (!existsSync(ZIG_TOOL)) {
    console.error(`Zig binary not found: ${ZIG_TOOL}`);
    console.error('Build it first:  zig build');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let checks = 0;
let failures = 0;

const show = (buffer) => {
    const text = buffer.toString('utf8');
    return text.length > 160 ? `${JSON.stringify(text.slice(0, 160))}...` : JSON.stringify(text);
};

const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL ${name}: ${detail}`);
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const flag = (name, fallback) => {
    const at = process.argv.indexOf(name);
    if (at === -1 || at + 1 >= process.argv.length) return fallback;
    return Number(process.argv[at + 1]);
};

const SEED = flag('--seed', 0x5eed1234);
const ROUNDS = flag('--rounds', 300);

/** Run one tool in `cwd` with `args`; returns status, stdout, stderr. */
function run(kind, cwd, args) {
    const command = kind === 'js' ? process.execPath : ZIG_TOOL;
    const argv = kind === 'js' ? [JS_TOOL, ...args] : args;
    const result = spawnSync(command, argv, {
        cwd,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every file below `dir`, as relative path -> bytes, sorted by path. */
function snapshot(dir) {
    const files = new Map();
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.set(relative(dir, full).replace(/\\/g, '/'), readFileSync(full));
        }
    };
    walk(dir);
    return files;
}

function materialize(dir, files) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        const full = join(dir, name);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
    }
}

/**
 * Replace the tool's own copy directory with a placeholder: each tool runs in
 * its own copy of the scenario, and absolute paths that reach stderr are the
 * only thing that may legitimately differ.
 */
function normalizeOutput(buffer, dir) {
    return Buffer.from(buffer.toString('utf8').split(dir).join('<DIR>'), 'utf8');
}

/** Run one scenario through both tools and compare everything. */
function compare(name, files, args) {
    checks += 1;
    const jsDir = join(TMP, 'js', name);
    const zigDir = join(TMP, 'zig', name);
    materialize(jsDir, files);
    materialize(zigDir, files);

    const js = run('js', jsDir, args);
    const zig = run('zig', zigDir, args);
    js.stdout = normalizeOutput(js.stdout, jsDir);
    zig.stdout = normalizeOutput(zig.stdout, zigDir);
    js.stderr = normalizeOutput(js.stderr, jsDir);
    zig.stderr = normalizeOutput(zig.stderr, zigDir);

    if (js.status !== zig.status) {
        fail(name, `exit code: js ${js.status}, zig ${zig.status} (args: ${args.join(' ')})`);
    }
    if (!js.stdout.equals(zig.stdout)) {
        fail(name, `stdout:\n  js  ${show(js.stdout)}\n  zig ${show(zig.stdout)}`);
    }
    if (!js.stderr.equals(zig.stderr)) {
        fail(name, `stderr:\n  js  ${show(js.stderr)}\n  zig ${show(zig.stderr)}`);
    }

    const jsFiles = snapshot(jsDir);
    const zigFiles = snapshot(zigDir);
    const names = [...new Set([...jsFiles.keys(), ...zigFiles.keys()])].sort();
    for (const file of names) {
        const left = jsFiles.get(file);
        const right = zigFiles.get(file);
        if (left === undefined || right === undefined) {
            fail(name, `file ${file}: ${left === undefined ? 'missing in js' : 'missing in zig'}`);
            continue;
        }
        if (!left.equals(right)) {
            fail(name, `file ${file}:\n  js  ${show(left)}\n  zig ${show(right)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// The fixed corpus
// ---------------------------------------------------------------------------

const MARKER = '[fixtures/one.md](./fixtures/one.md)';

/** A document whose single marker is followed by a fenced block. */
const simpleDoc = (body = 'stale', fence = '```') => [
    '# Title',
    '',
    MARKER,
    '',
    fence,
    body,
    fence,
    '',
].join('\n');

const regionDoc = (reference, body = 'stale', target = 'fixtures/big.md') => [
    `[${target}](./${target}#${reference})`,
    '',
    '```',
    body,
    '```',
    '',
].join('\n');

const BIG_MD = ['noise', '#region table', '| a | b |', '#endregion', 'noise', ''].join('\n');

const JSON_DOC = ['{', '  "name": "acme",', '  "scripts": {', '    "test": "make test"', '  },', '  "keywords": ["docs", "examples"]', '}'].join('\n');

const CODE_TS = [
    '/** Adds two numbers. */',
    'export function add(a: number, b: number) {',
    '    return a + b;',
    '}',
    '',
    'export const double = (n: number) => n * 2;',
    '',
    'export class Cart {',
    '    /** One line of a cart. */',
    '    @Override',
    '    public toString() {',
    '        return "cart";',
    '    }',
    '}',
    '',
].join('\n');

// --- the languages the per-type lexers exist for -------------------------

/** A nested block comment hides a declaration the default mask would leak. */
const NESTING_ZIG = [
    '// a line comment',
    '/* outer /* inner */ still outer',
    '   pub fn decoy() void {}',
    '*/',
    'pub fn target() void {',
    '    const s = \\\\a multiline string with a } brace',
    '    _ = s;',
    '}',
    '',
].join('\n');

/** `impl Cart` is a scope named after the type, beside the `struct Cart`. */
const CART_RS = [
    'struct Cart {',
    '    items: Vec<String>,',
    '}',
    '',
    'impl Cart {',
    '    fn add(&mut self, x: String) {',
    '        self.items.push(x);',
    '    }',
    '}',
    '',
    'impl Cart {',
    '    fn remove(&mut self) -> Option<String> {',
    "        // a 'lifetime is not a char literal, and r#\"raw\"# is a string",
    '        self.items.pop()',
    '    }',
    '}',
    '',
].join('\n');

/** `def name` with no parentheses, closed by its `end` line. */
const CART_RB = [
    'class Cart',
    '  def add(item)',
    '    @items << item',
    '  end',
    '',
    '  def self.build',
    '    new',
    '  end',
    'end',
    '',
].join('\n');

/** A one-line binding plus its `name ::` signature, and a `data` declaration. */
const STORE_HS = [
    'module Store where',
    '',
    '{- a {- nested -} comment -}',
    '',
    'add :: Int -> Int -> Int',
    'add x y = x + y',
    '',
    'data Cart = Cart { items :: [String] }',
    '',
].join('\n');

/** `Class`/`Function` closed by `End …`, and `""` doubling. */
const FORM_VB = [
    'Public Class Form',
    '    Public Function Add(ByVal x As Integer) As Integer',
    '        Dim s As String = "a ""quoted"" } brace"',
    '        Return x + 1',
    '    End Function',
    'End Class',
    '',
].join('\n');

/** A heredoc whose body contains a `}` — shell takes no escape in `'…'`. */
const RUN_SH = [
    '#!/bin/sh',
    "echo 'no escapes here }'",
    'cat <<EOF',
    'a } brace and "a quote"',
    'EOF',
    'run() {',
    '  echo done',
    '}',
    '',
].join('\n');

/** `<<<EOT` heredocs and `#[Attribute]`, which is not a `#` comment. */
const CART_PHP = [
    '<?php',
    '#[Attribute]',
    'class Cart {',
    '    public function add($item) {',
    '        $sql = <<<EOT',
    '        a } brace',
    'EOT;',
    '        return $item;',
    '    }',
    '}',
    '',
].join('\n');

/** A `}` inside a Python triple-quoted string, and an indented body. */
const CART_PY = [
    'class Cart:',
    '    def add(self, item):',
    '        text = """a } brace"""',
    '        return item',
    '',
    'def build():',
    '    return Cart()',
    '',
].join('\n');

const DATA_YAML = [
    '# a comment',
    'server:',
    '  host: localhost',
    '  port: 8080',
    '  options:',
    '    tls: true',
    '',
    'other: value',
    '',
].join('\n');

const DATA_TOML = [
    '# a comment',
    'title = "acme"',
    '',
    '[server]',
    'host = "localhost"',
    'port = 8080',
    'tags = [',
    '  "a",',
    '  "b",',
    ']',
    '',
    '[server.tls]',
    'enabled = true',
    '',
].join('\n');

const DATA_INI = [
    '; a comment',
    'root = /srv',
    '',
    '[server]',
    'host = localhost',
    'port: 8080',
    '',
    '[other]',
    'key = value',
    '',
].join('\n');

const CODE_GO = [
    'package cart',
    '',
    'type Cart struct {',
    '\tItems []string',
    '}',
    '',
    '// Add appends an item; `}` in a raw string is not a brace.',
    'func (c *Cart) Add(x string) {',
    '\traw := `a } brace`',
    '\tc.Items = append(c.Items, raw)',
    '}',
    '',
].join('\n');

const CODE_JAVA_TEXT_BLOCK = [
    'public class Report {',
    '    /** Render the report. */',
    '    String render() {',
    '        return """',
    '            a } brace',
    '            """;',
    '    }',
    '}',
    '',
].join('\n');

// --- the hard spellings, which the plain fixtures above cannot catch --------
//
// Every construct below is one a port only gets right if it mirrors the
// JavaScript matcher character for character: a generic `impl`, a field whose
// name begins with `pub`, a Haskell binding whose source name carries a prime,
// an indented `where` binding, a VB modifier without a space, and a region in
// `--` comments. The plain corpus passes with any of those wrong.

const GENERICS_RS = [
    'use std::fmt::Display;',
    '',
    'pub struct Cart<T> {',
    '    publisher: String,',
    '    pub_key: String,',
    '    items: Vec<T>,',
    '}',
    '',
    'impl<T: Clone> Display for Cart<T> {',
    '    fn render(&self) -> String {',
    '        String::new()',
    '    }',
    '}',
    '',
    'impl Cart<String> {',
    '    fn add(&mut self, x: String) {',
    '        self.items.push(x);',
    '    }',
    '}',
    '',
].join('\n');

const PRIME_HS = [
    'module Prime where',
    '',
    "add' :: Int -> Int",
    "add' x = x + 1",
    '',
    "data Foo' = Foo' Int",
    '',
    'double :: Int -> Int',
    'double x = go x',
    '  where',
    '    go y = y * 2',
    '',
    'class Store s where',
    '  get :: s -> Int',
    '',
].join('\n');

const WIDGET_CS = [
    'namespace Demo;',
    '',
    'public class Widget',
    '{',
    '    public string Name { get; set; }',
    '',
    '    public int Add(int a, int b)',
    '    {',
    '        return a + b;',
    '    }',
    '}',
    '',
].join('\n');

const REPO_KT = [
    'class Repo {',
    '    fun find(id: Int): String {',
    '        return "item " + id',
    '    }',
    '',
    '    fun save(item: String) {',
    '        println(item)',
    '    }',
    '}',
    '',
].join('\n');

const ORDERS_SQL = [
    '-- #region totals',
    'SELECT count(*) AS orders, sum(total) AS revenue FROM orders;',
    '-- #endregion',
    '',
    'CREATE TABLE orders (',
    '    id INT,',
    '    total INT',
    ');',
    '',
].join('\n');

const BASE_FILES = {
    'README.md': simpleDoc(),
    'fixtures/one.md': 'real content\nsecond line\n',
    'fixtures/big.md': BIG_MD,
    'fixtures/data.json': JSON_DOC,
    'fixtures/code.ts': CODE_TS,
    'fixtures/notes.txt': 'notes\n',
    'docs/GUIDE.md': simpleDoc('old guide'),
    'docs/notes.txt': 'not markdown\n',
    'docs/nested/DEEP.md': simpleDoc('deep'),
    // Reference corpus: one file per construct the port must mask and index.
    'fixtures/Nesting.zig': NESTING_ZIG,
    'fixtures/Cart.rs': CART_RS,
    'fixtures/Cart.rb': CART_RB,
    'fixtures/Store.hs': STORE_HS,
    'fixtures/Form.vb': FORM_VB,
    'fixtures/run.sh': RUN_SH,
    'fixtures/Cart.php': CART_PHP,
    'fixtures/Cart.py': CART_PY,
    'fixtures/Cart.go': CODE_GO,
    'fixtures/Report.java': CODE_JAVA_TEXT_BLOCK,
    'fixtures/app.yaml': DATA_YAML,
    'fixtures/app.toml': DATA_TOML,
    'fixtures/app.ini': DATA_INI,
    // The hard spellings.
    'fixtures/Generics.rs': GENERICS_RS,
    'fixtures/Prime.hs': PRIME_HS,
    'fixtures/Widget.cs': WIDGET_CS,
    'fixtures/Repo.kt': REPO_KT,
    'fixtures/Orders.sql': ORDERS_SQL,
};

/** Every `#<reference>` the reference corpus can be asked for. */
const REFERENCE_CASES = [
    // The per-type lexers: what they hide and what they still see.
    ['fixtures/Nesting.zig', 'target'],
    ['fixtures/Nesting.zig', 'decoy'],
    ['fixtures/Cart.rs', 'Cart'],
    ['fixtures/Cart.rs', 'Cart/add'],
    ['fixtures/Cart.rs', 'Cart/items'],
    ['fixtures/Cart.rs', 'Cart/remove'],
    ['fixtures/Cart.rs', 'Cart/nope'],
    ['fixtures/Cart.rs', 'add-'],
    ['fixtures/Cart.rb', 'add'],
    ['fixtures/Cart.rb', 'Cart/add'],
    ['fixtures/Cart.rb', 'Cart/add-'],
    ['fixtures/Cart.rb', 'build'],
    ['fixtures/Cart.rb', 'missing'],
    ['fixtures/Store.hs', 'add'],
    ['fixtures/Store.hs', 'add+'],
    ['fixtures/Store.hs', 'add-'],
    ['fixtures/Store.hs', 'Cart'],
    ['fixtures/Store.hs', 'data'],
    ['fixtures/Form.vb', 'Form'],
    ['fixtures/Form.vb', 'Form/Add'],
    ['fixtures/Form.vb', 'Form/Add-'],
    ['fixtures/run.sh', 'run'],
    ['fixtures/run.sh', 'run-'],
    ['fixtures/Cart.php', 'add'],
    ['fixtures/Cart.php', 'Cart/add'],
    ['fixtures/Cart.py', 'add'],
    ['fixtures/Cart.py', 'add-'],
    ['fixtures/Cart.py', 'build'],
    ['fixtures/Cart.go', 'Cart/Add'],
    ['fixtures/Cart.go', 'Cart/Add-'],
    ['fixtures/Report.java', 'render'],
    ['fixtures/Report.java', 'render-'],
    // The data-format rules.
    ['fixtures/app.yaml', 'server'],
    ['fixtures/app.yaml', 'server.port'],
    ['fixtures/app.yaml', 'server.options.tls'],
    ['fixtures/app.yaml', 'missing'],
    ['fixtures/app.yaml', 'server.missing'],
    ['fixtures/app.toml', 'title'],
    ['fixtures/app.toml', 'server'],
    ['fixtures/app.toml', 'server.port'],
    ['fixtures/app.toml', 'server.tags'],
    ['fixtures/app.toml', 'server.tls'],
    ['fixtures/app.toml', 'nope'],
    ['fixtures/app.toml', 'server.nope'],
    ['fixtures/app.ini', 'root'],
    ['fixtures/app.ini', 'server'],
    ['fixtures/app.ini', 'server.host'],
    ['fixtures/app.ini', 'server.port'],
    ['fixtures/app.ini', 'nope'],
    ['fixtures/app.ini', 'server.nope'],
    ['fixtures/app.ini', 'a.b.c'],
    // Multi-key and modifier shapes, and the grammar errors.
    ['fixtures/data.json', 'name,scripts.test'],
    ['fixtures/data.json', 'keywords.1,keywords.0'],
    ['fixtures/code.ts', 'Cart/toString++'],
    ['fixtures/code.ts', 'add++'],
    ['fixtures/big.md', 'table+'],
    ['fixtures/one.md', 'a/b/c/d/e/f/g/h/i'],
    ['fixtures/one.md', 'a//b'],
    ['fixtures/one.md', 'add--'],

    // The hard spellings, one reference per misspelling a matcher can make: a
    // generic impl, a `pub`-prefixed field name, a primed or indented Haskell
    // binding, a VB modifier, and a region in SQL line comments.
    ['fixtures/Generics.rs', 'Cart'],
    ['fixtures/Generics.rs', 'Cart/items'],
    ['fixtures/Generics.rs', 'items'],
    ['fixtures/Generics.rs', 'publisher'],
    ['fixtures/Generics.rs', 'pub_key'],
    ['fixtures/Generics.rs', 'render'],
    ['fixtures/Generics.rs', 'Cart/render'],
    ['fixtures/Generics.rs', 'Cart/add'],
    ['fixtures/Generics.rs', 'Display'],
    ['fixtures/Prime.hs', 'add'],
    ['fixtures/Prime.hs', 'double'],
    ['fixtures/Prime.hs', 'go'],
    ['fixtures/Prime.hs', 'Store'],
    ['fixtures/Prime.hs', 'get'],
    ['fixtures/Prime.hs', 'data'],
    ['fixtures/Widget.cs', 'Widget'],
    ['fixtures/Widget.cs', 'Widget/Add'],
    ['fixtures/Widget.cs', 'Add'],
    ['fixtures/Widget.cs', 'Name'],
    ['fixtures/Repo.kt', 'Repo'],
    ['fixtures/Repo.kt', 'Repo/find'],
    ['fixtures/Repo.kt', 'find'],
    ['fixtures/Repo.kt', 'Repo/save'],
    ['fixtures/Orders.sql', 'totals'],
    ['fixtures/Orders.sql', 'orders'],
    ['fixtures/Form.vb', 'Form/Add-'],
    ['fixtures/Form.vb', 'Form/Run'],
];


function fixedScenarios() {
    const cases = [];
    const scenario = (name, args, files = BASE_FILES) => cases.push([name, files, args]);

    // The repository's own documents, read-only.
    scenario('repo-check-readme', ['--check', 'README.md']);
    scenario('repo-dry-run-readme', ['--dry-run', 'README.md']);
    scenario('repo-quiet-check', ['--check', '--quiet', 'README.md']);
    scenario('repo-empty-doc', ['--check', 'docs/notes.txt']);
    scenario('repo-empty-doc-allowed', ['--check', '--allow-empty', 'docs/notes.txt']);
    scenario('repo-missing-file', ['--check', 'nope.md']);
    scenario('repo-directory', ['--check', 'docs']);
    scenario('repo-directory-update', ['docs']);
    scenario('repo-directory-no-markdown', ['--check', 'fixtures']);
    scenario('repo-two-targets', ['--check', 'README.md', 'docs/GUIDE.md']);
    scenario('repo-worst-code', ['README.md', 'nope.md', 'docs/GUIDE.md']);

    // Usage errors.
    scenario('usage-unknown', ['--bogus']);
    scenario('usage-missing-value', ['--out']);
    scenario('usage-gitignore-conflict', ['-g', 'ci.txt', '--no-gitignore']);
    scenario('usage-out-two-files', ['--out', 'out.md', 'README.md', 'docs/GUIDE.md']);
    scenario('usage-out-directory', ['--out', 'out.md', 'docs']);
    scenario('help', ['--help']);
    scenario('version', ['--version']);
    scenario('help-wins-over-work', ['--help', 'nope.md']);

    // In-place updates and idempotence.
    scenario('update-in-place', ['README.md']);
    scenario('update-in-place-twice', ['README.md', 'README.md']);
    scenario('update-crlf', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['# T', '', MARKER, '', '```markdown', 'stale', '```', ''].join('\r\n'),
    });
    scenario('update-no-trailing-newline', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['# T', '', MARKER, '', '```', 'stale', '```'].join('\n'),
    });
    scenario('update-bare-fence-language', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/code.ts](./fixtures/code.ts)', '```', 'stale', '```', ''].join('\n'),
    });
    scenario('update-tagged-fence', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/code.ts](./fixtures/code.ts)', '```cpp', 'stale', '```', ''].join('\n'),
    });
    scenario('update-indented-fence', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/code.ts](./fixtures/code.ts)', '   ```', 'stale', '   ```', ''].join('\n'),
    });
    scenario('update-long-fence', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '````', '```', 'inner', '```', '````', ''].join('\n'),
    });
    scenario('update-unknown-extension', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/notes.txt](./fixtures/notes.txt)', '```', 'stale', '```', ''].join('\n'),
    });

    // Regions.
    scenario('region-directive', ['README.md'], {
        ...BASE_FILES,
        'README.md': regionDoc('table'),
    });
    scenario('region-missing', ['--check', 'README.md'], { ...BASE_FILES, 'README.md': regionDoc('nope') });
    scenario('region-missing-lenient', ['--lenient', 'README.md'], { ...BASE_FILES, 'README.md': regionDoc('nope') });
    scenario('region-code-declaration', ['README.md'], {
        ...BASE_FILES,
        'README.md': regionDoc('add'),
    });
    scenario('region-code-body', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('-add') });
    scenario('region-code-annotated', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('+toString') });
    scenario('region-code-documented', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('++toString') });
    scenario('region-code-expression', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('-double') });
    scenario('region-code-none', ['--lenient', 'README.md'], { ...BASE_FILES, 'README.md': regionDoc('+') });
    scenario('region-json-keys', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('name,scripts.test') });
    scenario('region-json-array', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('keywords.1,keywords.0') });
    scenario('region-json-nested', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('scripts.test') });
    scenario('region-json-missing-key', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('scripts.nope') });
    scenario('region-json-not-index', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('keywords.x') });
    scenario('region-json-no-element', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc('keywords.9') });
    scenario('region-json-no-keys', ['README.md'], { ...BASE_FILES, 'README.md': regionDoc(',') });
    scenario('region-json-bad-document', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': 'not json',
        'README.md': regionDoc('name'),
    });
    scenario('region-json-top-level-array', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '[1, 2]',
        'README.md': regionDoc('name'),
    });
    scenario('region-json-number-forms', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"a": 1e21, "b": 1e-7, "c": -0, "d": 0.1, "e": 123456789012345678901234567890, "f": 1.5e100, "g": 5e-324}',
        'README.md': regionDoc('a,b,c,d,e,f,g'),
    });
    scenario('region-json-escapes', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"a": "\\ud800", "b": "tab\\there", "c": "\\u0000", "d": "caf\\u00e9 \\ud83d\\ude00"}',
        'README.md': regionDoc('a,b,c,d'),
    });
    scenario('region-json-key-order', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"2": 1, "1": 2, "0": 3, "a": 4, "b": 5}',
        'README.md': regionDoc('0,1,2,a,b'),
    });
    scenario('region-json-duplicate-keys', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"a": 1, "b": 2, "a": 3}',
        'README.md': regionDoc('a,b'),
    });
    scenario('region-json-error-messages', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"a": 01}',
        'README.md': regionDoc('a'),
    });
    scenario('region-json-error-long', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': `[${'1,'.repeat(30)},]`,
        'README.md': regionDoc('a'),
    });
    scenario('region-json-long-number', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': `{"a": ${'9'.repeat(600)}, "b": 1}`,
        'README.md': regionDoc('a,b'),
    });
    scenario('region-json-tiny-number', ['README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"a": 5e-324, "b": 1e-7, "c": 1e21}',
        'README.md': regionDoc('a,b,c'),
    });
    scenario('region-json-huge-index', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"list": [1, 2]}',
        'README.md': regionDoc('list.99999999999999999999'),
    });
    scenario('region-json-deep-path', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'fixtures/data.json': '{"a": {"b": {"c": [1, {"d": "x"}]}}}',
        'README.md': regionDoc('a.b.c.1.d,a.b.c.0'),
    });

    // Broken includes and lenient mode.
    scenario('missing-target-strict', ['--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': simpleDoc(),
        'fixtures/one.md': undefined,
    });
    scenario('missing-target-lenient', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'README.md': simpleDoc(),
        'fixtures/one.md': undefined,
    });
    scenario('stray-text-after-marker', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '', 'prose', '', '```', 'x', '```', ''].join('\n'),
    });
    scenario('no-code-block', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '', ''].join('\n'),
    });
    scenario('unclosed-code-block', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'x'].join('\n'),
    });
    scenario('duplicate-marker', ['--lenient', 'README.md'], {
        ...BASE_FILES,
        'README.md': [MARKER, '```', 'a', '```', MARKER, '```', 'b', '```', ''].join('\n'),
    });
    scenario('marker-inside-fence', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['```markdown', MARKER, '```', '', MARKER, '```', 'stale', '```', ''].join('\n'),
    });
    scenario('not-a-marker-links', ['--check', '--allow-empty', 'README.md'], {
        ...BASE_FILES,
        'README.md': [
            '[the docs](./docs/README.md)',
            '[a.md](./a.md#install)',
            '[https://x.dev](https://x.dev)',
            '[a.md](./a.md) and more',
            'plain text',
            '',
        ].join('\n'),
    });
    scenario('foreign-marker-target', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[constructor](constructor)', '```', 'stale', '```', ''].join('\n'),
        constructor: 'function Object() { [native code] }\n',
    });
    scenario('constructor-extension', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[x.constructor](./x.constructor)', '```', 'stale', '```', ''].join('\n'),
        'x.constructor': 'body\n',
    });
    scenario('proto-extension', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[x.__proto__](./x.__proto__)', '```', 'stale', '```', ''].join('\n'),
        'x.__proto__': 'body\n',
    });
    scenario('tostring-extension', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[x.toString](./x.toString)', '```', 'stale', '```', ''].join('\n'),
        'x.toString': 'body\n',
    });
    scenario('proto-marker-target', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[__proto__](__proto__)', '```', 'stale', '```', ''].join('\n'),
        ['__proto__']: 'stale\n',
    });

    // gitignore.
    scenario('gitignore-default', ['--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
        'fixtures/.gitignore': 'one.md\n',
    });
    scenario('gitignore-flag', ['--check', '-g', 'ci.txt', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
        'ci.txt': 'fixtures\n',
    });
    scenario('gitignore-flag-missing', ['--check', '-g', 'missing.txt', 'README.md']);
    scenario('gitignore-off', ['--check', '--no-gitignore', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
        'fixtures/.gitignore': 'one.md\n',
    });
    scenario('gitignore-negation', ['--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
        'fixtures/.gitignore': '*.md\n!one.md\n',
    });
    scenario('gitignore-update', ['README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
        'fixtures/.gitignore': 'one.md\n',
    });
    scenario('gitignore-globs', ['--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/deep/one.md](./fixtures/deep/one.md)', '```', 'stale', '```', ''].join('\n'),
        'fixtures/deep/one.md': 'real\n',
        '.gitignore': '**/deep/\n',
    });
    scenario('gitignore-absolute-flag', ['--check', '--gitignore', 'ci.txt', 'README.md'], {
        ...BASE_FILES,
        'ci.txt': 'one.md\n',
    });

    // --out.
    scenario('out-writes', ['--out', 'out/GUIDE.md', 'README.md']);
    scenario('out-unchanged', ['--out', 'out.md', 'README.md'], {
        ...BASE_FILES,
        'README.md': simpleDoc('real content\nsecond line'),
        'out.md': 'real content\nsecond line\n',
    });
    scenario('out-check-missing', ['--out', 'out.md', '--check', 'README.md']);
    scenario('out-check-stale', ['--out', 'out.md', '--check', 'README.md'], {
        ...BASE_FILES,
        'out.md': 'old\n',
    });
    scenario('out-check-fresh', ['--out', 'out.md', '--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': simpleDoc('real content\nsecond line'),
        'out.md': 'real content\nsecond line\n',
    });
    scenario('out-dry-run', ['--out', 'out.md', '--dry-run', 'README.md']);
    scenario('out-broken-strict', ['--out', 'out.md', 'README.md'], {
        ...BASE_FILES,
        'README.md': simpleDoc(),
        'fixtures/one.md': undefined,
    });
    scenario('out-broken-lenient', ['--out', 'out.md', '--lenient', 'README.md'], {
        ...BASE_FILES,
        'README.md': simpleDoc(),
        'fixtures/one.md': undefined,
    });
    scenario('out-crlf-comparison', ['--out', 'out.md', '--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['# T', '', MARKER, '', '```', 'real content', 'second line', '```', ''].join('\r\n'),
        'out.md': '# T\n\n' + MARKER + '\n\n```\nreal content\nsecond line\n```\n',
    });

    // --root.
    scenario('root-flag', ['--check', '--root', 'fixtures', 'docs/GUIDE.md'], {
        ...BASE_FILES,
        'docs/GUIDE.md': ['[one.md](./one.md)', '```', 'stale', '```', ''].join('\n'),
    });
    scenario('root-is-relative-doc', ['--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
    });

    // A directory expands to every *.md below it, and the noise stays out: a
    // dead marker in node_modules or a dot-directory must never be reached.
    scenario('directory-skips-noise', ['--check', 'docs'], {
        ...BASE_FILES,
        'docs/node_modules/dep/README.md': ['[missing.md](./missing.md)', '```', 'stale', '```', ''].join('\n'),
        'docs/.hidden/README.md': ['[missing.md](./missing.md)', '```', 'stale', '```', ''].join('\n'),
        'docs/deep/notes.md': ['[missing.md](./missing.md)', '```', 'stale', '```', ''].join('\n'),
    });
    scenario('directory-skips-noise-update', ['docs'], {
        ...BASE_FILES,
        'docs/node_modules/dep/README.md': ['[missing.md](./missing.md)', '```', 'stale', '```', ''].join('\n'),
        'docs/.hidden/README.md': ['[missing.md](./missing.md)', '```', 'stale', '```', ''].join('\n'),
    });
    scenario('directory-with-symlink-names', ['--check', 'docs'], {
        ...BASE_FILES,
        'docs/node_modules.md': ['[missing.md](./missing.md)', '```', 'stale', '```', ''].join('\n'),
        'docs/a.md': ['[../fixtures/one.md](../fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
    });

    // Every short spelling of every flag.
    scenario('short-check', ['-c', 'README.md']);
    scenario('short-dry-run', ['-n', 'README.md']);
    scenario('short-quiet', ['-q', 'README.md']);
    scenario('short-lenient', ['-l', 'README.md']);
    scenario('short-help', ['-h']);
    scenario('short-version', ['-V']);
    scenario('short-out', ['-o', 'out/COPY.md', 'README.md']);
    scenario('short-root', ['-r', 'fixtures', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[one.md](./one.md)', '```', 'stale', '```', ''].join('\n'),
    });
    scenario('short-gitignore', ['-g', 'ci.txt', '--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[fixtures/one.md](./fixtures/one.md)', '```', 'stale', '```', ''].join('\n'),
        'ci.txt': 'fixtures\n',
    });
    scenario('equals-spellings', ['--out=out/COPY.md', '--root=fixtures', '--check', 'README.md'], {
        ...BASE_FILES,
        'README.md': ['[one.md](./one.md)', '```', 'real content\nsecond line\n', '```', ''].join('\n'),
    });
    scenario('dash-dash-targets', ['--check', '--', 'README.md', 'docs/GUIDE.md']);

    // Every `#<reference>` in the reference corpus: the per-type lexers, the
    // path and modifier grammar, and the four data-format rules. One scenario
    // per case, run in `--lenient` (report the failures), update and check
    // modes (write what resolves, verify it).
    for (const [target, reference] of REFERENCE_CASES) {
        const label = `${target.replace(/[^A-Za-z0-9]+/g, '_')}-${reference.replace(/[^A-Za-z0-9]+/g, '_')}`;
        scenario(`ref-${label}-lenient`, ['--lenient', 'README.md'], {
            ...BASE_FILES,
            'README.md': regionDoc(reference, 'stale', `./${target}`),
        });
        scenario(`ref-${label}-update`, ['README.md'], {
            ...BASE_FILES,
            'README.md': regionDoc(reference, 'stale', `./${target}`),
        });
        scenario(`ref-${label}-check`, ['--check', 'README.md'], {
            ...BASE_FILES,
            'README.md': regionDoc(reference, 'stale', `./${target}`),
        });
    }

    // The contradiction warning: it resolves to the wider reading, is printed
    // in every mode, and the run ends 1.
    for (const reference of ['getUsers++-', 'a-+', 'a+-', 'a++-']) {
        for (const mode of [['README.md'], ['--check', 'README.md'], ['--quiet', 'README.md'], ['--dry-run', 'README.md'], ['--out', 'out.md', 'README.md']]) {
            const slug = mode[0].replace(/[^A-Za-z0-9]+/g, '_');
            scenario(`warn-${reference.replace(/[^A-Za-z0-9]+/g, '_')}-${slug}`, mode, {
                ...BASE_FILES,
                'README.md': regionDoc(reference),
            });
        }
    }

    return cases;
}

// ---------------------------------------------------------------------------
// The fuzzer
// ---------------------------------------------------------------------------

/** A tiny deterministic PRNG, so a seed reproduces a corpus exactly. */
function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

function fuzzScenarios(seed, rounds) {
    const random = rng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const some = (list, max) => Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(list));

    const targets = ['fixtures/one.md', 'fixtures/two.md', 'fixtures/three.md', 'fixtures/data.json', 'fixtures/code.ts', 'missing.md', 'fixtures/notes.txt'];
    const references = ['', '#table', '#name', '#missing', '#add', '#-add', '#+add', '#++add', '#a,b', '#list.0', '#deep.key', '#', '#1e5'];
    const fences = ['```', '````', '```markdown', '   ```', '```js'];
    const bodies = ['stale', 'old body', '', 'real content', 'multi\nline', '  indented'];
    const prose = ['# Title', 'Some prose.', '', 'Text with `code` in it.', '- a list item', '> a quote'];

    const cases = [];
    for (let round = 0; round < rounds; round++) {
        const files = { ...BASE_FILES };
        files['fixtures/one.md'] = pick(['real content\nsecond line\n', 'one\n', '', '#region table\n| a | b |\n#endregion\n']);
        files['fixtures/two.md'] = pick(['two\n', '', '#region name\ninside\n#endregion\n']);
        files['fixtures/three.md'] = pick(['three\n', 'noise\n#region table\nx\n#endregion\nnoise\n']);
        files['fixtures/code.ts'] = pick([CODE_TS, 'void add() {}\n', 'const add = (x) => x;\n', 'class add {\n}\n']);
        files['fixtures/data.json'] = pick([
            JSON_DOC,
            '{"a": 1}',
            '{"list": [1, 2, 3], "deep": {"key": true}}',
            'not json',
            '{"a": 01}',
            '[]',
            'null',
            '{"1": 1, "0": 2, "a": 3}',
        ]);

        // A document built out of markers, fences and prose.
        const lines = [];
        for (const part of some(prose, 3)) lines.push(part);
        for (const target of some(targets, 3)) {
            const reference = random() < 0.5 ? '' : pick(references);
            lines.push(`[${target}](./${target}${reference})`);
            if (random() < 0.15) lines.push('');
            const fence = pick(fences);
            lines.push(fence);
            lines.push(pick(bodies));
            lines.push(fence);
            if (random() < 0.3) lines.push('');
        }
        for (const part of some(prose, 2)) lines.push(part);
        files['README.md'] = lines.join(random() < 0.2 ? '\r\n' : '\n') + (random() < 0.15 ? '' : '\n');

        const mode = pick([
            ['README.md'],
            ['--check', 'README.md'],
            ['--dry-run', 'README.md'],
            ['--lenient', 'README.md'],
            ['--lenient', '--check', 'README.md'],
            ['--quiet', 'README.md'],
            ['--allow-empty', '--check', 'README.md'],
            ['--out', 'out/COPY.md', 'README.md'],
            ['--out', 'out/COPY.md', '--check', 'README.md'],
            ['--out', 'out/COPY.md', '--dry-run', 'README.md'],
            ['--no-gitignore', 'README.md'],
            ['--check', 'docs'],
            ['docs'],
        ]);
        if (random() < 0.25) files['.gitignore'] = pick(['*.md\n', 'fixtures\n', '!one.md\n', '**/two.md\n', 'fixtures/one.md\n']);
        cases.push([`fuzz-${round}`, files, mode]);
    }
    return cases;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const scenarios = [...fixedScenarios(), ...fuzzScenarios(SEED, ROUNDS)];
for (const [name, files, args] of scenarios) {
    const cleaned = {};
    for (const [file, content] of Object.entries(files)) {
        if (content !== undefined) cleaned[file] = content;
    }
    compare(name, cleaned, args);
}

rmSync(TMP, { recursive: true, force: true });

console.log(`${checks} comparisons, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
