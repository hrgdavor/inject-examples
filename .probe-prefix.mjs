// Scratch: what deepestResolvablePrefix answers for the rows the Java port will assert.
// Deleted after use; not part of the suite.
import { readFileSync } from 'node:fs';
import { deepestResolvablePrefix, diagnose } from './lib/section.mjs';
import { lexerFor } from './src/js/scanner/lexers.js';

const read = (p) => readFileSync(new URL(`./test/fixtures/${p}`, import.meta.url), 'utf8');
const example = read('Example.java');
const nesting = read('Nesting.zig');
const dup = read('Duplicate.java');

const rows = [
    ['Example.java', example, 'Cart/Line/renderr'],
    ['Example.java', example, 'Cart/Line/render'],
    ['Example.java', example, 'Cart/toString/sub'],
    ['Example.java', example, 'Cart/toString'],
    ['Example.java', example, 'Cart/Cart'],
    ['Example.java', example, 'missing'],
    ['Example.java', example, 'missing/deeper'],
    ['Example.java', example, 'toString'],
    ['Example.java', example, 'L40'],
    ['Example.java', example, 'L40-'],
    ['Example.java', example, ''],
    ['Example.java', example, 'Cart/^,toString,$'],
    ['Example.java', example, 'Cart/Line/renderr,toString'],
    ['Example.java', example, 'items/nope'],
    ['Duplicate.java', dup, 'add/something'],
    ['Nesting.zig', nesting, 'nope/deeper'],
];

for (const [file, text, reference] of rows) {
    const lexer = lexerFor(file);
    let probe;
    try {
        probe = deepestResolvablePrefix(text, reference, lexer);
    } catch (e) {
        probe = `THREW ${e.message}`;
    }
    let d;
    try {
        const diag = diagnose(text, reference, lexer);
        d = `${diag.status}${diag.code ? ' ' + diag.code : ''}${diag.firstLine != null ? ' firstLine=' + diag.firstLine : ''}`;
    } catch (e) {
        d = `THREW ${e.message}`;
    }
    console.log(`${file} #${JSON.stringify(reference)}\n    probe=${JSON.stringify(probe)}\n    diagnose=${d}`);
}
