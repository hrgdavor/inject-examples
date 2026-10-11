import { resolveSection, scanBlocks } from './lib/section.mjs';
import { lexerFor } from './src/js/scanner/lexers.js';

const haskell = [
    'module Main where',
    '',
    'add :: Int -> Int -> Int',
    'add x y = x + y',
    '',
    'class Store s where',
    '  get :: s -> Int',
    '',
    'data Cart = Cart { items :: [Int] }',
    '',
    'main = do',
    '  print (add 1 2)',
].join('\n');
const s = scanBlocks(haskell, undefined, lexerFor('Main.hs'));
for (const b of s.blocks) {
    console.error('BLK ' + b.name + ' decl=' + b.declLine + ' indented=' + b.indented
        + ' bodyFrom=' + b.bodyFrom + ' closeLine=' + b.closeLine + ' endLine=' + b.endLine);
}
console.error('main => ' + JSON.stringify(resolveSection(haskell, 'main', lexerFor('Main.hs'))));
console.error('add- => ' + JSON.stringify(resolveSection(haskell, 'add-', lexerFor('Main.hs'))));
