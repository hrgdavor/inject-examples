/**
 * mask-oracle.mjs — the tokenizer corpus, and a cross-check against a real
 * highlighter.
 *
 * Two jobs, one file:
 *
 * 1. **The corpus.** `PROBES` is the growing set of constructs the tokenizer
 *    table must handle — one entry per language per construct, each with the
 *    words that must be hidden (`hidden`) and the words that must survive
 *    (`kept`). `test.mjs` imports it and runs `runProbes`, so every case here is
 *    a test in CI and the corpus needs no dependency.
 * 2. **The oracle.** `node tools/mask-oracle.mjs` additionally highlights each
 *    probe with `highlight.js` (a devDependency, never shipped) and checks the
 *    direction that matters: every offset the highlighter calls a comment or a
 *    string literal must be blank in our mask. Our mask may blank *more* — that
 *    is the conservative direction — but leaking one means our table does not
 *    know a construct that language has.
 *
 * The oracle is a second opinion, not an authority: it runs in `tools/`, it
 * cannot fail a build (`--strict` in CI would be a deliberate choice), and its
 * own grammar can be wrong. `--emit` prints what it saw per probe, which is how
 * a curator decides what to add next.
 *
 *   node tools/mask-oracle.mjs            check the corpus, then the oracle
 *   node tools/mask-oracle.mjs --emit     also print what the highlighter saw
 *   node tools/mask-oracle.mjs --no-oracle  the corpus only (no dependency)
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { SYNTAXES } from '../src/js/scanner/syntaxes.js';
import { tokenize } from '../src/js/scanner/tokenizer.js';

/**
 * The corpus. One entry per language per construct:
 *
 *   language  a name in `syntaxes.js`
 *   name      what this case is about (it appears in the failure message)
 *   code      the sample
 *   hidden    text the mask must not contain (the construct swallowed it)
 *   kept      text the mask must still contain (over-blanking is a failure too)
 */
export const PROBES = [
    // Rust — nesting comments, raw strings, and the char/lifetime trap.
    {
        language: 'rust',
        name: 'nested block comment',
        code: 'fn a() { /* outer /* inner */ fn decoy() {} */ }',
        hidden: ['decoy'],
    },
    {
        language: 'rust',
        name: 'raw string with hashes',
        code: 'const S: &str = r#"fn decoy() { }"#;',
        hidden: ['decoy'],
    },
    {
        language: 'rust',
        name: 'byte raw string',
        code: 'const S: &[u8] = br#"fn decoy() { }"#;',
        hidden: ['decoy'],
    },
    {
        language: 'rust',
        name: 'a lifetime is not a char literal',
        code: "fn f<'a>(x: &'a str) -> &'a str { fn decoy() {} decoy(x) }",
        kept: ['fn decoy', '{', '}'],
    },
    {
        language: 'rust',
        name: 'char literals are blanked',
        code: "fn g() { let c = '{'; let d = '}'; }",
        hidden: ["'{'", "'}'"],
    },
    // Python — triple quotes and raw strings.
    {
        language: 'python',
        name: 'triple-quoted string',
        code: 'def a():\n    """\n    def decoy():\n        pass\n    """\n    return 1\n',
        hidden: ['decoy'],
    },
    {
        language: 'python',
        name: "triple-single-quoted string",
        code: "def a():\n    '''\n    def decoy():\n        pass\n    '''\n",
        hidden: ['decoy'],
    },
    {
        language: 'python',
        name: 'raw string does not escape',
        code: 'x = r"\\" + "def decoy(): pass"',
        hidden: ['def decoy'],
    },
    // C# — verbatim doubling, interpolated verbatim, raw literals.
    {
        language: 'csharp',
        name: 'verbatim string doubles its quotes',
        code: 'var s = @"a "" } decoy "" b"; void Add() {}',
        hidden: ['decoy'],
    },
    {
        language: 'csharp',
        name: 'interpolated verbatim string',
        code: 'var s = $@"a "" } decoy"; void Add() {}',
        hidden: ['decoy'],
    },
    {
        language: 'csharp',
        name: 'raw string literal',
        code: 'var s = """a " } decoy """; void Add() {}',
        hidden: ['decoy'],
    },
    // Kotlin — nesting comments and raw strings.
    {
        language: 'kotlin',
        name: 'nested block comment',
        code: 'fun a() { /* outer /* inner */ fun decoy() {} */ }',
        hidden: ['decoy'],
    },
    {
        language: 'kotlin',
        name: 'raw string',
        code: 'val s = """ fun decoy() {} """',
        hidden: ['decoy'],
    },
    // PHP — heredoc, nowdoc, and an attribute that is not a comment.
    {
        language: 'php',
        name: 'heredoc body',
        code: '<?php\n$x = <<<EOT\nfunction decoy() {}\nEOT;\nfunction real() {}\n',
        hidden: ['decoy'],
        kept: ['function real'],
    },
    {
        language: 'php',
        name: 'nowdoc body',
        code: "<?php\n$x = <<<'EOT'\nfunction decoy() {}\nEOT;\nfunction real() {}\n",
        hidden: ['decoy'],
        kept: ['function real'],
    },
    {
        language: 'php',
        name: 'an attribute is not a # comment',
        code: '#[Attribute]\nfunction real() {}\n# a } comment\n',
        kept: ['#[Attribute]'],
        hidden: ['a } comment'],
    },
    // Ruby — =begin blocks, strict heredocs, and `<<` as an operator.
    {
        language: 'ruby',
        name: '=begin block comment',
        code: '=begin\ndef decoy\nend\n=end\ndef real\nend\n',
        hidden: ['decoy'],
        kept: ['def real'],
    },
    {
        language: 'ruby',
        name: 'strict heredoc',
        code: 'sql = <<~SQL\n  def decoy\nSQL\ndef real\nend\n',
        hidden: ['decoy'],
        kept: ['def real'],
    },
    {
        language: 'ruby',
        name: 'a shift is not a heredoc',
        code: 'list << item\ndef real\nend\n',
        kept: ['def real'],
    },
    // SQL — doubled quotes and dollar quoting.
    {
        language: 'sql',
        name: 'doubled quote',
        code: "SELECT 'it''s a } decoy' AS x; -- } comment\n",
        hidden: ['decoy'],
    },
    {
        language: 'sql',
        name: 'dollar quoting',
        code: 'SELECT $$ } decoy $$, 1;',
        hidden: ['decoy'],
    },
    // Shell — heredocs, and quotes that take no escapes.
    {
        language: 'shell',
        name: 'heredoc body',
        code: 'cat <<EOF\n{ decoy }\nEOF\necho done\n',
        hidden: ['decoy'],
        kept: ['echo done'],
    },
    {
        language: 'shell',
        name: 'single quotes take no escapes',
        code: "echo 'a } decoy' && echo done\n",
        hidden: ['decoy'],
    },
    // VB — doubling.
    {
        language: 'vb',
        name: 'doubled quote',
        code: 'Dim s As String = "a "" } decoy" \' comment\nSub Add()\nEnd Sub\n',
        hidden: ['decoy'],
        kept: ['Sub Add'],
    },
    // Haskell — nesting comments and a multi-line string gap.
    {
        language: 'haskell',
        name: 'nested comment',
        code: '{- outer {- inner -} decoy = 1 -}\nreal = 2\n',
        hidden: ['decoy'],
        kept: ['real = 2'],
    },
    {
        language: 'haskell',
        name: 'string gap spans lines',
        code: 'msg = "a \\\n  \\ } decoy"\nreal = 2\n',
        hidden: ['decoy'],
        kept: ['real = 2'],
    },
    // Go — raw strings and rune literals.
    {
        language: 'go',
        name: 'backtick raw string',
        code: 'var s = `func decoy() {}`\nfunc Real() {}\n',
        hidden: ['decoy'],
        kept: ['func Real'],
    },
    {
        language: 'go',
        name: 'rune literal',
        code: "func g() { c := '}'; other() }\n",
        hidden: ["'}'"],
        kept: ['other()'],
    },
    // Java / JavaScript — the two that shipped first, pinned here too.
    {
        language: 'java',
        name: 'text block',
        code: 'class T {\n    String s = """\n        } decoy\n        """;\n}\n',
        hidden: ['decoy'],
    },
    {
        language: 'java',
        name: 'char literal',
        code: "class T { char c = '}'; }\n",
        hidden: ["'}'"],
    },
    {
        language: 'javascript',
        name: 'template literal with a brace',
        code: 'const s = `a ${ {x: 1} } b } decoy`;\n',
        hidden: ['decoy'],
    },
    {
        language: 'javascript',
        name: 'comment hides a brace',
        code: 'function f() { /* } decoy */ return 1; }\n',
        hidden: ['decoy'],
    },
    {
        language: 'typescript',
        name: 'template literal beside a type',
        code: 'type T = { a: string };\nconst s = `a ${ {b: 1} } } decoy`;\n',
        hidden: ['decoy'],
    },
    // Zig — the original nested-comment case.
    {
        language: 'zig',
        name: 'nested block comment',
        code: '/* outer /* inner */ fn decoy() void { x(); } */',
        hidden: ['decoy'],
    },
    {
        language: 'zig',
        name: 'multiline string to end of line',
        code: 'const s = \\\\ } decoy\nfn real() void {}\n',
        hidden: ['decoy'],
        kept: ['fn real'],
    },
    // The data formats — a comment marker inside a quoted value is not one.
    {
        language: 'yaml',
        name: 'quoted hash is not a comment',
        code: 'key: "# not a comment { }"\n# a real comment\nother: 1\n',
        hidden: ['not a comment'],
        kept: ['other: 1'],
    },
    {
        language: 'yaml',
        name: 'single-quoted doubling',
        code: "key: 'it''s a } decoy'\nother: 1\n",
        hidden: ['decoy'],
        kept: ['other: 1'],
    },
    {
        language: 'toml',
        name: 'triple-quoted string',
        code: 'a = """\n# not a comment\n"""\nb = 1',
        hidden: ['not a comment'],
        kept: ['b = 1'],
    },
    {
        language: 'toml',
        name: 'literal string',
        code: "a = '''\n# not a comment\n'''\nb = 1",
        hidden: ['not a comment'],
        kept: ['b = 1'],
    },
    {
        language: 'ini',
        name: 'quoted semicolon is not a comment',
        code: '[s]\nkey = "a ; b"\n; comment with } a decoy\nother = 1\n',
        hidden: ['a decoy'],
        kept: ['other = 1'],
    },
];

/**
 * Run one probe through the tokenizer: the mask invariant, then what must be
 * hidden and what must survive.
 *
 * @returns {{ probe: object, failures: string[], masked: string }}
 */
export function checkProbe(probe) {
    const failures = [];
    const syntax = SYNTAXES[probe.language];
    if (!syntax) return { probe, failures: [`${probe.language} is not in the syntax table`], masked: '' };

    const { masked } = tokenize(probe.code, syntax);
    if (masked.length !== probe.code.length) failures.push('the mask changed the length');
    for (let i = 0; i < probe.code.length; i++) {
        if (probe.code[i] === '\n' && masked[i] !== '\n') {
            failures.push(`the newline at ${i} moved`);
            break;
        }
    }
    for (const word of probe.hidden ?? []) {
        if (masked.includes(word)) failures.push(`the mask still shows ${JSON.stringify(word)}`);
    }
    for (const word of probe.kept ?? []) {
        if (!masked.includes(word)) failures.push(`the mask lost ${JSON.stringify(word)}`);
    }
    return { probe, failures, masked };
}

/** Run the whole corpus. */
export function runProbes(probes = PROBES) {
    return probes.map(checkProbe);
}

// ---------------------------------------------------------------------------
// The oracle: what highlight.js calls a comment or a string must be blank here
// ---------------------------------------------------------------------------

/** Our language name → the highlighter's, where they differ. */
const HIGHLIGHTER_NAMES = { shell: 'bash', vb: 'vbnet' };

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);

/** Classes the highlighter puts on a comment or a string literal. */
const LITERAL_CLASS = /hljs-(?:comment|string|char|regexp|doctag|template-tag|meta-string|heredoc)/;

/**
 * The `[from, to)` offsets the highlighter calls a comment or a string, read
 * from its HTML: a stack of open spans tracks nesting (hljs nests comments), and
 * a run of text inside any literal scope counts.
 *
 * @param {object} hljs the highlight.js module
 * @param {string} code
 * @param {string} language our language name
 * @returns {{ regions: Array<{from: number, to: number, kind: string}>, classes: Set<string> } | null}
 */
export function highlighterRegions(hljs, code, language) {
    const name = HIGHLIGHTER_NAMES[language] ?? language;
    if (!hljs.getLanguage(name)) return null;

    const { value } = hljs.highlight(code, { language: name, ignoreIllegals: true });
    const regions = [];
    const classes = new Set();
    const stack = [];
    let offset = 0;
    const tag = /<span class="([^"]*)">|<\/span>|([^<]+)/g;

    for (const match of value.matchAll(tag)) {
        if (match[1] !== undefined) {
            stack.push(match[1]);
            for (const cls of match[1].split(/\s+/)) if (cls) classes.add(cls);
            continue;
        }
        if (match[2] === undefined) { stack.pop(); continue; }
        const text = decode(match[2]);
        const literal = stack.some((cls) => LITERAL_CLASS.test(cls));
        if (literal) regions.push({ from: offset, to: offset + text.length, kind: stack[stack.length - 1] });
        offset += text.length;
    }

    if (offset !== code.length) {
        throw new Error(`the highlighter's text does not round-trip (${offset} != ${code.length})`);
    }
    return { regions, classes };
}

/**
 * The literal regions a highlighter knows and our mask does not.
 *
 * A region counts as a leak only when our mask blanks **nothing** in it. That is
 * deliberate: a highlighter's region may include text that is rightly readable —
 * Python's `r` prefix, PHP's `<<<EOT` marker, the heredoc tag line — and we blank
 * from the body inwards, so those regions are partly blank and clearly known.
 * A construct we do not know at all leaves its whole region readable, which is
 * exactly the failure this checks for.
 *
 * @returns {Array<{ from: number, to: number, text: string, kind: string }>}
 */
export function findLeaks(hljs, probe, masked) {
    const seen = highlighterRegions(hljs, probe.code, probe.language);
    if (seen === null) return [];
    const leaks = [];
    for (const region of seen.regions) {
        let blanked = 0;
        for (let i = region.from; i < region.to; i++) {
            if (masked[i] === ' ' && probe.code[i] !== '\n') blanked++;
        }
        if (blanked === 0) {
            leaks.push({ from: region.from, to: region.to, text: probe.code.slice(region.from, region.to), kind: region.kind });
        }
    }
    return leaks;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const HELP = `usage: node tools/mask-oracle.mjs [options]

  --no-oracle   check the corpus only (no devDependency needed)
  --emit        print what the highlighter saw for each probe
  --self-test   check that the oracle can fail at all (a plain mask must leak)
  --strict      exit 1 when the oracle is unavailable
  -h, --help    show this help`;

async function main(argv) {
    const emit = argv.includes('--emit');
    const strict = argv.includes('--strict');
    const skipOracle = argv.includes('--no-oracle');
    if (argv.includes('-h') || argv.includes('--help')) { console.log(HELP); return 0; }

    let failed = 0;
    const results = runProbes();
    for (const { probe, failures } of results) {
        if (failures.length === 0) continue;
        failed++;
        console.log(`FAIL  ${probe.language}: ${probe.name}`);
        for (const failure of failures) console.log(`      ${failure}`);
    }

    console.log(`corpus: ${results.length - failed}/${results.length} probe(s) hold`);
    if (failed > 0) return 1;
    if (skipOracle) return 0;

    let hljs = null;
    try {
        hljs = (await import('highlight.js')).default;
    } catch {
        console.log('oracle: highlight.js is not installed (npm install --save-dev highlight.js)');
        return strict ? 1 : 0;
    }

    if (argv.includes('--self-test')) return selfTest(hljs, results);

    let leaks = 0;
    let regions = 0;
    for (const { probe, masked } of results) {
        const seen = highlighterRegions(hljs, probe.code, probe.language);
        if (seen === null) {
            if (emit) console.log(`--    ${probe.language}: ${probe.name} (the highlighter has no ${probe.language})`);
            continue;
        }
        regions += seen.regions.length;
        const found = findLeaks(hljs, probe, masked);
        leaks += found.length;
        if (emit) {
            console.log(`${found.length === 0 ? 'ok  ' : 'LEAK'}  ${probe.language}: ${probe.name}`
                + ` (${seen.regions.length} literal region(s))`);
        }
        for (const leak of found) {
            console.log(`LEAK  ${probe.language}: ${probe.name}: offset ${leak.from} (${leak.kind})`
                + ` ${JSON.stringify(leak.text.slice(0, 40))}`);
        }
    }

    console.log(`oracle: ${leaks} of ${regions} literal region(s) are unknown to our mask`);
    return leaks === 0 ? 0 : 1;
}

/**
 * The oracle is only worth running if it can fail: this feeds it a mask that
 * blanks nothing and expects the leaks to appear.
 */
function selfTest(hljs, results) {
    let caught = 0;
    let checked = 0;
    for (const { probe } of results) {
        const seen = highlighterRegions(hljs, probe.code, probe.language);
        // Only where the highlighter itself sees a literal: a construct it does
        // not know (a shell heredoc, say) is no oracle at all.
        if (seen === null || seen.regions.length === 0) continue;
        checked++;
        // A mask that blanks nothing, with the newlines where they were: every
        // literal region must then be reported.
        const nothingBlanked = probe.code.replace(/[^\n]/g, 'x');
        if (findLeaks(hljs, probe, nothingBlanked).length === seen.regions.length) caught++;
    }
    console.log(`self-test: the oracle caught ${caught}/${checked} unmasked probe(s)`);
    return caught === checked && checked > 0 ? 0 : 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
    process.exitCode = await main(process.argv.slice(2));
}
