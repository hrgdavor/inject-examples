// TEMPORARY (deleted before the task ends): dump the reference's own block tree for the cases the
// port disagrees on.
import { readFileSync } from 'node:fs';
import { planSection, scanBlocks } from '../../lib/section.mjs';
import { lexerFor } from '../../src/js/scanner/lexers.js';
import { masked } from '../../lib/section.mjs';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fixture = (name) => readFileSync(`${here}../../test/fixtures/${name}`, 'utf8');

const cases = [
    ['Example.java', fixture('Example.java'), ['items']],
    ['T.ts', 'const add = (a: number, b: number): number => a + b;\n', ['add']],
    ['Wrapped.kt', fixture('Wrapped.kt'), ['render', 'label']],
    ['Wrapped.py', fixture('Wrapped.py'), ['render', 'label']],
    ['WrappedClass.java', fixture('WrappedClass.java'), ['Wrapped', 'best']],
    ['Prime.hs', fixture('Prime.hs'), ['double', 'Store']],
    ['T.rs', 'impl Cart {\n    pub fn add(&self, item: String) {\n        self.items.push(item);\n    }\n}\n', ['Cart']],
    ['T.hs', 'add x y = do\n    print x\n    print y\n', ['add']],
    ['T.hs', 'store = Store { name = "x" }\n', ['store']],
    ['T.hs', 'class Monad m => Render m where\n    render :: m -> String\n', ['Monad', 'Render']],
];

for (const [path, source, names] of cases) {
    const lexer = lexerFor(path);
    console.error(`\n===== ${path}`);
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const declared = lexer?.declarations ? lexer.declarations(masked(lines[i])) : [];
        if (declared.length) {
            console.error(`  declared[${i + 1}] ${JSON.stringify(lines[i])} -> ${JSON.stringify(declared)}`);
        } else if (names.some((n) => lines[i].includes(n))) {
            console.error(`  (no shape) [${i + 1}] ${JSON.stringify(lines[i])}`);
        }
    }
    const scan = scanBlocks(source, path, lexer);
    for (const b of scan.blocks) {
        if (b.declLine === undefined) continue;
        const fields = Object.fromEntries(
            Object.entries(b).filter(([k]) =>
                ['kind', 'name', 'declLine', 'endLine', 'open', 'close', 'openLine', 'closeLine',
                    'expression', 'expressionEndLine', 'indented', 'bodyFrom', 'singleLine'].includes(k)),
        );
        if (fields.name !== undefined) console.error(`  block ${JSON.stringify(fields)}`);
    }
    for (const name of names) {
        for (const ref of [name, `${name}-`]) {
            let out;
            try {
                const plan = planSection(source, ref, lexer);
                out = { text: plan.text, startLine: plan.startLine, endLine: plan.endLine, kind: plan.kind };
            } catch (error) {
                out = { error: error.message };
            }
            console.error(`  -> ${ref}: ${JSON.stringify(out)}`);
        }
    }
}
