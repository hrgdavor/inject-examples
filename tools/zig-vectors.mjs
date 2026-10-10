#!/usr/bin/env node

/**
 * Turn the section-matching golden vectors into a Zig test's data.
 *
 * `test/vectors/section-vectors.json` is generated from the JavaScript
 * implementation by `tools/section-vectors.mjs`, and `test.mjs` already holds
 * *that* implementation to it. The Zig port needs the same set as its own
 * conformance gate, and a Zig test cannot read a file at run time without a
 * filesystem, so this tool bakes the vectors — and the fixture text they
 * resolve against — into `src/section_vectors.zig`, which `zig build test`
 * compiles and runs.
 *
 *   node tools/zig-vectors.mjs           write src/section_vectors.zig
 *   node tools/zig-vectors.mjs --check   exit 1 when the file is stale
 *
 * `--check` is a build gate: it fails when the committed file and the current
 * vectors disagree, so the Zig conformance set cannot silently fall behind the
 * JavaScript one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = join(ROOT, 'test', 'vectors', 'section-vectors.json');
const OUT = join(ROOT, 'src', 'section_vectors.zig');

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8'));

/** The fixture files the vectors resolve against, as UTF-8 text. */
const inputs = [...new Set(vectors.map((c) => c.input).filter((p) => p !== null))].sort();
const sources = new Map(inputs.map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]));

/** `test/fixtures/Example.java` -> `Example_java` */
function fixtureName(path) {
    return path.replace(/^test\/fixtures\//, '').replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * A Zig string literal holding `text` byte for byte.
 *
 * Everything above ASCII is written as a `\xNN` escape onto the following
 * line, because a Zig source line may not carry a raw non-ASCII byte; the
 * escapes join, so the literal is still one unbroken string.
 */
function zigLiteral(text) {
    let out = '"';
    let column = 1;
    for (const byte of Buffer.from(text, 'utf8')) {
        let piece;
        if (byte === 0x22) piece = '\\"';
        else if (byte === 0x5c) piece = '\\\\';
        else if (byte === 0x0a) piece = '\\n';
        else if (byte === 0x0d) piece = '\\r';
        else if (byte === 0x09) piece = '\\t';
        else if (byte >= 0x20 && byte < 0x7f) piece = String.fromCharCode(byte);
        else piece = `\\x${byte.toString(16).padStart(2, '0')}`;

        if (column + piece.length > 108) {
            out += '"\n        ++ "';
            column = 1;
        }
        out += piece;
        column += piece.length;
    }
    return `${out}"`;
}

function zigString(value) {
    if (value === null || value === undefined) return 'null';
    return zigLiteral(value);
}

function zigWarning(warning) {
    if (!warning) return 'null';
    return `.{ .kind = .contradiction, .kept = ${zigString(warning.kept)}, .dropped = ${zigString(warning.dropped)} }`;
}

const fixtures = inputs.map((path) => {
    return `/// \`${path}\`\npub const ${fixtureName(path)} =\n    ${zigLiteral(sources.get(path))};\n`;
});

const cases = vectors.map((c) => {
    const parts = [
        `        .name = ${zigString(c.name)},`,
        `        .input = ${zigString(c.input)},`,
        `        .reference = ${zigString(c.reference)},`,
        `        .text = ${zigString(c.text)},`,
        `        .error_message = ${zigString(c.error)},`,
        `        .warning = ${zigWarning(c.warning)},`,
    ];
    return `    .{\n${parts.join('\n')}\n    },`;
});

const rendered = `//! The section-matching conformance corpus, generated from the JavaScript
//! implementation's golden vectors.
//!
//! **Generated - do not edit.** \`node tools/zig-vectors.mjs\` writes this file
//! from \`test/vectors/section-vectors.json\` (see \`tools/section-vectors.mjs\`)
//! and the fixture files that corpus resolves against; \`--check\` fails when
//! the committed file is stale. Every case here is one assertion in
//! \`section.zig\`'s conformance test, so the port cannot drift from the
//! JavaScript it mirrors without the build failing.

const std = @import("std");

pub const Warning = struct {
    kind: enum { contradiction },
    kept: []const u8,
    dropped: []const u8,
};

pub const Case = struct {
    name: []const u8,
    input: ?[]const u8,
    reference: []const u8,
    /// The expected selection, or null when the case expects an error.
    text: ?[]const u8,
    error_message: ?[]const u8,
    warning: ?Warning,
};

${fixtures.join('\n')}
/// The fixture text for a vector's \`input\` path, or null when it names none.
pub fn sourceOf(input: ?[]const u8) ?[]const u8 {
    const path = input orelse return null;
${inputs.map((path) => `    if (std.mem.eql(u8, path, ${zigString(path)})) return ${fixtureName(path)};`).join('\n')}
    return null;
}

pub const cases = [_]Case{
${cases.join('\n')}
};
`;

if (process.argv.includes('--check')) {
    let committed;
    try {
        committed = readFileSync(OUT, 'utf8');
    } catch {
        console.error('src/section_vectors.zig is missing; run: node tools/zig-vectors.mjs');
        process.exit(1);
    }
    if (committed === rendered) {
        console.log('zig-vectors: ok');
        process.exit(0);
    }
    const want = committed.replace(/\r\n/g, '\n').split('\n');
    const have = rendered.replace(/\r\n/g, '\n').split('\n');
    console.error('zig-vectors drift: the committed file does not match the vectors.');
    const n = Math.max(want.length, have.length);
    for (let i = 0; i < n; i++) {
        if (want[i] !== have[i]) {
            console.error(`  line ${i + 1}:`);
            console.error(`    committed: ${JSON.stringify(want[i] ?? '')}`);
            console.error(`    expected:  ${JSON.stringify(have[i] ?? '')}`);
        }
    }
    process.exit(1);
}

writeFileSync(OUT, rendered, 'utf8');
console.log(`wrote ${vectors.length} zig vectors to src/section_vectors.zig`);
