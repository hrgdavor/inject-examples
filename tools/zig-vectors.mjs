#!/usr/bin/env node
// @ts-check

/**
 * Turn the golden vectors into a Zig test's data.
 *
 * `test/vectors/section-vectors.json` is generated from the JavaScript
 * implementation by `tools/section-vectors.mjs`, and `test.mjs` already holds
 * *that* implementation to it. The Zig port needs the same set as its own
 * conformance gate, and a Zig test cannot read a file at run time without a
 * filesystem, so this tool bakes the vectors — and the fixture text they
 * resolve against — into `src/section_vectors.zig`, which `zig build test`
 * compiles and runs.
 *
 * The lexical corpus (`test/vectors/lexical-vectors.json`, written by
 * `tools/lexical-vectors.mjs`) rides along in the same file: the mask and
 * declaration-shape rows the other ports assert.
 *
 *   node tools/zig-vectors.mjs           write src/section_vectors.zig
 *   node tools/zig-vectors.mjs --check   exit 1 when the file is stale
 *
 * `--check` is a build gate: it fails when the committed file and the current
 * vectors disagree, so the Zig conformance set cannot silently fall behind the
 * JavaScript one. The output is `zig fmt`-clean — `zig fmt` joins a `"…" ++ "…"`
 * chain, so every literal is written on one line — which is why this file can be
 * held to the same formatting gate as the hand-written sources.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = join(ROOT, 'test', 'vectors', 'section-vectors.json');
const LEXICAL = join(ROOT, 'test', 'vectors', 'lexical-vectors.json');
const OUT = join(ROOT, 'src', 'section_vectors.zig');

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8'));
const lexical = JSON.parse(readFileSync(LEXICAL, 'utf8'));

/** The fixture files the vectors resolve against, as UTF-8 text. */
const inputs = [...new Set(vectors.map((c) => c.input).filter((p) => p !== null))].sort();
// Normalize CRLF to LF so the embedded literal is identical on every platform:
// a fixture checked out with Windows autocrlf carries CRLF, the same file is LF
// on Linux, and the committed file must match the generator on both.
const sources = new Map(
    inputs.map((path) => [path, readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n')]),
);

/** `test/fixtures/Example.java` -> `Example_java` */
function fixtureName(path) {
    return path.replace(/^test\/fixtures\//, '').replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * A Zig string literal holding `text` byte for byte, on one line.
 *
 * Everything above ASCII is written as a `\xNN` escape, because a Zig source
 * line may not carry a raw non-ASCII byte. One line, however long, because
 * `zig fmt` collapses a `"…" ++ "…"` chain back into one line and would
 * otherwise make this generated file its own formatting failure.
 */
function zigLiteral(text) {
    let out = '"';
    for (const byte of Buffer.from(text, 'utf8')) {
        if (byte === 0x22) out += '\\"';
        else if (byte === 0x5c) out += '\\\\';
        else if (byte === 0x0a) out += '\\n';
        else if (byte === 0x0d) out += '\\r';
        else if (byte === 0x09) out += '\\t';
        else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
        else out += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
    return `${out}"`;
}

function zigString(value) {
    if (value === null || value === undefined) return 'null';
    return zigLiteral(value);
}

const fixtures = inputs.map((path) => {
    return `/// \`${path}\`\npub const ${fixtureName(path)} =\n    ${zigLiteral(sources.get(path))};\n`;
});

/**
 * The `ranges` field of a resolution vector: one line span per selector.
 *
 * Written inline, and empty (`&.{}`) for a parse-only probe and for a row whose
 * expected answer is an error — there is nothing to point at.
 */
function zigRanges(ranges) {
    if (!Array.isArray(ranges)) return '&.{}';
    const spans = ranges.map(([from, to]) => `.{ .from = ${from}, .to = ${to} }`);
    // `zig fmt` puts the spaces in for two or more elements and leaves a single
    // one tight, so the generated file is written the way it would be formatted.
    return spans.length === 1 ? `&.{${spans[0]}}` : `&.{ ${spans.join(', ')} }`;
}

/** The `kind` field of a resolution vector: a `PlanKind` tag, or null. */
function zigKind(kind) {
    return kind === null || kind === undefined ? 'null' : `.${kind}`;
}

const cases = vectors.map((c) => {
    const parts = [
        `        .name = ${zigString(c.name)},`,
        `        .input = ${zigString(c.input)},`,
        `        .reference = ${zigString(c.reference)},`,
        `        .text = ${zigString(c.text)},`,
        `        .start_line = ${c.startLine ?? 'null'},`,
        `        .end_line = ${c.endLine ?? 'null'},`,
        `        .ranges = ${zigRanges(c.ranges)},`,
        `        .kind = ${zigKind(c.kind)},`,
        `        .error_message = ${zigString(c.error)},`,
        `        .code = ${zigString(c.code)},`,
    ];
    return `    .{\n${parts.join('\n')}\n    },`;
});

/** One `ExpectedDeclared`, as a struct literal `zig fmt` leaves alone. */
function declaredLiteral(entry) {
    const body = entry.body === null ? 'null' : zigLiteral(entry.body);
    const end = entry.end === null ? 'null' : zigLiteral(entry.end);
    return `.{ .kind = .${entry.kind}, .name = ${zigLiteral(entry.name)}, `
        + `.header_from = ${entry.headerFrom}, .body = ${body}, .end = ${end}, `
        + `.line = ${entry.line} }`;
}

const maskCases = lexical.masks.map((c) => {
    const parts = [
        `        .name = ${zigString(c.name)},`,
        `        .path = ${zigString(c.path)},`,
        `        .source = ${zigLiteral(c.source)},`,
        `        .masked = ${zigLiteral(c.masked)},`,
    ];
    return `    .{\n${parts.join('\n')}\n    },`;
});

const shapeCases = lexical.shapes.map((c) => {
    const declared = c.declared.length === 0
        ? '&.{}'
        : `&.{\n${c.declared.map((d) => `            ${declaredLiteral(d)},`).join('\n')}\n        }`;
    const parts = [
        `        .name = ${zigString(c.name)},`,
        `        .path = ${zigString(c.path)},`,
        `        .line = ${zigLiteral(c.line)},`,
        `        .declared = ${declared},`,
    ];
    return `    .{\n${parts.join('\n')}\n    },`;
});

const rendered = `//! The conformance corpora, generated from the JavaScript implementation.
//!
//! **Generated - do not edit.** \`node tools/zig-vectors.mjs\` writes this file
//! from \`test/vectors/section-vectors.json\` and \`test/vectors/lexical-vectors.json\`
//! (see \`tools/section-vectors.mjs\` and \`tools/lexical-vectors.mjs\`) and the
//! fixture files the first of those resolves against; \`--check\` fails when the
//! committed file is stale. Every case here is one assertion in \`section.zig\`'s
//! conformance tests, so the port cannot drift from the JavaScript it mirrors
//! without the build failing.

const std = @import("std");

/// The matcher that found a single selector, or \`multiple\` for several.
pub const PlanKind = enum { region, declaration, property, condition, anchor, lines, multiple };

pub const Case = struct {
    name: []const u8,
    input: ?[]const u8,
    reference: []const u8,
    /// The expected selection, or null when the case expects an error.
    text: ?[]const u8,
    /// The one-line span the selection came from, or null when there is none.
    start_line: ?i64,
    end_line: ?i64,
    /// One line range per selector: the same answer, piece by piece.
    ranges: []const LineSpan,
    /// The matcher that found it, or null for a parse-only probe.
    kind: ?PlanKind,
    error_message: ?[]const u8,
    /// The stable failure code (RFC 1 §3.6): a \`grammar/...\` or
    /// \`resolution/...\` string, or null on a case that resolves. A host
    /// branches on this instead of reading the message, so the port reproduces
    /// it beside the message.
    code: ?[]const u8,
};

/// A 1-based inclusive line range.
pub const LineSpan = struct { from: i64, to: i64 };

/// One mask row: a source unit and the mask the JavaScript produces for it.
pub const MaskCase = struct {
    name: []const u8,
    /// null when the type has no entry, so the built-in default engine applies.
    path: ?[]const u8,
    source: []const u8,
    masked: []const u8,
};

pub const DeclaredKind = enum { class, method, property };

/// One declaration a language reports for a masked line, as \`declarations(maskedLine)\` does.
pub const ExpectedDeclared = struct {
    kind: DeclaredKind,
    name: []const u8,
    header_from: i64,
    body: ?[]const u8,
    end: ?[]const u8,
    line: bool,
};

/// One shape row: a masked line, and every declaration the language reports for it.
pub const ShapeCase = struct {
    name: []const u8,
    path: []const u8,
    line: []const u8,
    declared: []const ExpectedDeclared,
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

pub const mask_cases = [_]MaskCase{
${maskCases.join('\n')}
};

pub const shape_cases = [_]ShapeCase{
${shapeCases.join('\n')}
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
console.log(`wrote ${vectors.length} section, ${lexical.masks.length} mask and ${lexical.shapes.length} shape vectors to src/section_vectors.zig`);
