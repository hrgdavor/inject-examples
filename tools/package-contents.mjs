#!/usr/bin/env node
// @ts-check

/**
 * What `npm publish` would ship, checked before it ships.
 *
 *   node tools/package-contents.mjs --check   (npm test; exit 1 on any problem)
 *
 * Three facts make a package *look* complete and fail on a consumer's machine,
 * and this checks all three statically, without packing:
 *
 * 1. every `exports` subpath points at a file that exists;
 * 2. every file the package points at is also listed in `files`, so it really
 *    ships — `exports` and `files` are independent in `package.json`, and a
 *    subpath naming an unshipped file is a broken import for every consumer;
 * 3. every relative import reachable from an entry point ships too, transitively.
 *    This is the one that bit: `src/js/scanner/` shipped while the `exports` map
 *    did not expose `lexers.js`, so `import '@hrg/inject-examples/src/js/scanner/lexers.js'`
 *    failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` — and if the map had exposed it
 *    without the directory shipping, the same import would have failed with
 *    `ERR_MODULE_NOT_FOUND`. Both halves are asserted here.
 *
 * A packed tarball installed into a scratch project is the end-to-end proof; it
 * needs npm and a network-free install, so it stays a manual step and this gate
 * is what runs on every `npm test`. The import walk is textual (a static `from
 * './x'` scan, not a parse), so a relative specifier written inside a string is
 * read as an import: that direction is the safe one, because it fails loudly
 * rather than letting an unshipped module through.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** @type {string[]} */
const problems = [];
let checked = 0;

/** Root-relative, forward-slashed, which is how `package.json` spells every path. */
const rootRelative = (absolute) => absolute.slice(ROOT.length + 1).split(sep).join('/');

/** npm's own rule: a `files` entry is a file, or a directory whose whole subtree ships. */
const ships = (relativePath) =>
    pkg.files.some((entry) => relativePath === entry || relativePath.startsWith(entry + '/'));

/**
 * npm always adds a few files whatever `files` says — `package.json`, the
 * readme and the licence — so those ship even though no `files` entry names
 * them. They are listed here rather than special-cased at each call site,
 * because the point of this check is to model npm, not to silence it.
 */
function alwaysShips(relativePath) {
    if (relativePath === 'package.json') {
        return true;
    }
    const name = relativePath.split('/').pop() ?? '';
    return /^(?:readme|licen[cs]e)(?:\..*)?$/i.test(name);
}

/** True when `relativePath` exists on disk and would be published. */
function shipped(relativePath, why) {
    checked++;
    if (!existsSync(join(ROOT, relativePath))) {
        problems.push(`${why}: ${relativePath} does not exist`);
        return false;
    }
    if (!ships(relativePath) && !alwaysShips(relativePath)) {
        problems.push(`${why}: ${relativePath} is not covered by "files", so it would not publish`);
        return false;
    }
    return true;
}

// 1 + 2 — `files` entries exist, and every `exports` subpath ships.
for (const entry of pkg.files) {
    checked++;
    if (!existsSync(join(ROOT, entry))) {
        problems.push(`"files" names ${entry}, which does not exist`);
    }
}

/** The entry points whose imports are walked below. */
const entryPoints = [];
for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (typeof target !== 'string') {
        problems.push(`exports["${subpath}"] is not a plain string, which this check does not model`);
        continue;
    }
    const relativePath = target.replace(/^\.\//, '');
    if (shipped(relativePath, `exports["${subpath}"]`)) {
        if (/\.(?:mjs|js)$/.test(relativePath)) {
            entryPoints.push(relativePath);
        }
    }
}

for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    shipped(String(target).replace(/^\.\//, ''), `bin["${name}"]`);
}

// 3 — the import graph of every entry point, transitively.
const seen = new Set(entryPoints);
const queue = [...entryPoints];
/** `from './x.js'`, `import './x.js'` and `await import('./x.js')`, on one line or wrapped. */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g;

while (queue.length > 0) {
    const importer = queue.shift();
    const text = readFileSync(join(ROOT, importer), 'utf8');
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1];
        const target = resolve(dirname(join(ROOT, importer)), specifier);
        const relativePath = rootRelative(target);
        if (!shipped(relativePath, `${importer} imports ${specifier}`)) {
            continue;
        }
        if (!seen.has(relativePath)) {
            seen.add(relativePath);
            queue.push(relativePath);
        }
    }
}

if (problems.length > 0) {
    for (const problem of problems) {
        console.error(`FAIL ${problem}`);
    }
    console.error(`\npackage contents: ${problems.length} problem(s) across ${checked} path(s)`);
    process.exit(1);
}

const exports = Object.keys(pkg.exports).length;
console.log(
    `package contents: ${checked} path(s) checked, ${exports} export(s), ` +
    `${seen.size} module(s) reachable from them — every one exists and ships`,
);
