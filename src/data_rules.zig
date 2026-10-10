//! The YAML, TOML and INI region rules — the Zig twin of the rule bodies in
//! `index.mjs`.
//!
//! Each of these formats has a key it can be addressed by and no comments to
//! hang a `#region` directive on, so each gets a rule of its own, like `.json`.
//! The reference is a dot-separated path (`server.port`); the selection is
//! *rendered* as valid source of the format, with the ancestors that hold the
//! key included, because a bare `port: 8080` is not a YAML document but
//! `server:\n  port: 8080` is.

const std = @import("std");
const Allocator = std.mem.Allocator;

const js = @import("js.zig");
const Str = js.Str;
const Failure = @import("section.zig").Failure;
const Error = @import("section.zig").Error;

/// `a.b, c.d` split into paths, each with its segments. An empty path is an
/// error, and so is an empty key.
pub const Path = struct { path: Str, segments: []Str };

pub fn keyPaths(alloc: Allocator, reference: Str, failure: *Failure) Error![]Path {
    var parts = std.ArrayList(Str).empty;
    var start: usize = 0;
    while (js.indexOfUnit(reference[start..], ',')) |offset| {
        const piece = js.trim(reference[start .. start + offset]);
        if (piece.len != 0) try parts.append(alloc, piece);
        start += offset + 1;
    }
    const tail = js.trim(reference[start..]);
    if (tail.len != 0) try parts.append(alloc, tail);

    if (parts.items.len == 0) {
        return failure.set(try js.format(alloc, "\"#{s}\" names no keys", .{reference}));
    }

    var paths = std.ArrayList(Path).empty;
    for (parts.items) |path| {
        var segments = std.ArrayList(Str).empty;
        var at: usize = 0;
        while (js.indexOfUnit(path[at..], '.')) |offset| {
            try segments.append(alloc, unquote(js.trim(path[at .. at + offset])));
            at += offset + 1;
        }
        try segments.append(alloc, unquote(js.trim(path[at..])));
        for (segments.items) |segment| {
            if (segment.len == 0) {
                return failure.set(try js.format(alloc, "\"{s}\" has an empty key", .{path}));
            }
        }
        try paths.append(alloc, .{ .path = path, .segments = try segments.toOwnedSlice(alloc) });
    }
    return paths.toOwnedSlice(alloc);
}

/// `"a"` / `'a'` / a bare key — the quotes are not part of the name.
pub fn unquote(segment: Str) Str {
    if (segment.len >= 2) {
        const quote = segment[0];
        if ((quote == '"' or quote == '\'') and segment[segment.len - 1] == quote) {
            return segment[1 .. segment.len - 1];
        }
    }
    return segment;
}

fn indentOf(line: Str) usize {
    return line.len - js.trimStart(line).len;
}

/// A blank line, or one that is nothing but a comment.
fn blankOrComment(line: Str, markers: []const Str) bool {
    const text = js.trim(line);
    if (text.len == 0) return true;
    for (markers) |marker| {
        if (js.startsWith(text, marker)) return true;
    }
    return false;
}

/// The line as code: quoted strings blanked, so a `[` in a value is not one.
/// `/(["'])(?:\\.|(?!\1)[^\\])*\1/g`.
fn withoutStrings(alloc: Allocator, line: Str) ![]u16 {
    var out = try alloc.dupe(u16, line);
    var i: usize = 0;
    while (i < line.len) {
        const quote = line[i];
        if (quote != '"' and quote != '\'') {
            i += 1;
            continue;
        }
        var j = i + 1;
        var closed = false;
        while (j < line.len) {
            if (line[j] == '\\' and j + 1 < line.len) {
                j += 2;
                continue;
            }
            if (line[j] == quote) {
                closed = true;
                j += 1;
                break;
            }
            j += 1;
        }
        if (!closed) break;
        for (i..@min(j, out.len)) |at| out[at] = ' ';
        i = j;
    }
    return out;
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/// The line of `key` at exactly `indent` in `from..to`, or null.
/// `^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#][^:]*?)\s*:(?:\s|$)`
fn yamlKeyAt(lines: []const Str, key: Str, from: usize, to: usize, indent: usize) ?usize {
    var i = from;
    while (i <= to and i < lines.len) : (i += 1) {
        const line = lines[i];
        if (blankOrComment(line, &.{&js.lit("#")})) continue;
        if (indentOf(line) != indent) continue;
        const found = yamlKeyOf(line) orelse continue;
        if (js.eql(unquote(js.trim(found)), key)) return i;
    }
    return null;
}

/// The key token a YAML mapping line opens with, or null when the line is not
/// `key:`.
fn yamlKeyOf(line: Str) ?Str {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len) return null;

    const start = at;
    if (line[at] == '"') {
        at += 1;
        while (at < line.len and line[at] != '"') {
            if (line[at] == '\\') at += 1;
            at += 1;
        }
        if (at >= line.len) return null;
        at += 1;
    } else if (line[at] == '\'') {
        at += 1;
        while (at < line.len) {
            if (line[at] == '\'' and at + 1 < line.len and line[at + 1] == '\'') {
                at += 2;
                continue;
            }
            if (line[at] == '\'') break;
            at += 1;
        }
        if (at >= line.len) return null;
        at += 1;
    } else {
        if (line[at] == '#' or js.isWhitespace(line[at])) return null;
        while (at < line.len and line[at] != ':') at += 1;
        if (at >= line.len) return null;
    }

    const key = line[start..at];
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len or line[at] != ':') return null;
    at += 1;
    if (at < line.len and !js.isWhitespace(line[at])) return null;
    return key;
}

/// The last line of the block `key` opens: blank lines and deeper indentation.
fn yamlBlockEnd(lines: []const Str, start: usize, indent: usize) usize {
    var end = start;
    var i = start + 1;
    while (i < lines.len) : (i += 1) {
        if (js.trim(lines[i]).len == 0) {
            end = i;
            continue;
        }
        if (indentOf(lines[i]) <= indent) break;
        end = i;
    }
    while (end > start and js.trim(lines[end]).len == 0) end -= 1;
    return end;
}

/// The indentation of the first real line: where a document's top level starts.
fn yamlRootIndent(lines: []const Str) usize {
    for (lines) |line| {
        if (blankOrComment(line, &.{&js.lit("#")})) continue;
        return indentOf(line);
    }
    return 0;
}

fn yamlSelection(
    alloc: Allocator,
    lines: []const Str,
    segments: []const Str,
    path: Str,
    from: usize,
    to: usize,
    indent: usize,
    level: usize,
    out: *std.ArrayList(Str),
    failure: *Failure,
) Error!void {
    const key = segments[0];
    const at = yamlKeyAt(lines, key, from, to, indent) orelse {
        return failure.set(try js.format(alloc, "\"{s}\": no key \"{s}\"", .{ path, key }));
    };
    const end = yamlBlockEnd(lines, at, indent);

    if (segments.len == 1) {
        var i = at;
        while (i <= end) : (i += 1) {
            var line = std.ArrayList(u16).empty;
            try appendPad(alloc, &line, level);
            try line.appendSlice(alloc, lines[i][indent..]);
            try out.append(alloc, try line.toOwnedSlice(alloc));
        }
        return;
    }

    var child_indent: ?usize = null;
    var i = at + 1;
    while (i <= end) : (i += 1) {
        if (js.trim(lines[i]).len == 0) continue;
        child_indent = indentOf(lines[i]);
        break;
    }
    const child = child_indent orelse {
        return failure.set(try js.format(alloc, "\"{s}\": \"{s}\" has no nested keys", .{ path, key }));
    };
    if (child <= indent) {
        return failure.set(try js.format(alloc, "\"{s}\": \"{s}\" has no nested keys", .{ path, key }));
    }

    var header = std.ArrayList(u16).empty;
    try appendPad(alloc, &header, level);
    try header.appendSlice(alloc, key);
    try header.append(alloc, ':');
    try out.append(alloc, try header.toOwnedSlice(alloc));

    try yamlSelection(alloc, lines, segments[1..], path, at + 1, end, child, level + 1, out, failure);
}

fn appendPad(alloc: Allocator, out: *std.ArrayList(u16), level: usize) !void {
    var i: usize = 0;
    while (i < level * 2) : (i += 1) try out.append(alloc, ' ');
}

/// The rule for `.yaml`/`.yml`: `#a.b` selects the `b` key of the `a` mapping,
/// rendered with `a:` above it and nested lines re-indented to two spaces per
/// level, so the block is a YAML document on its own.
pub fn extractYamlRegion(alloc: Allocator, text: Str, reference: Str, failure: *Failure) Error![]u16 {
    const normalized = try js.normalize(alloc, text);
    const lines = try js.splitLines(alloc, normalized);
    var out = std.ArrayList(Str).empty;
    const root = yamlRootIndent(lines);
    for (try keyPaths(alloc, reference, failure)) |entry| {
        try yamlSelection(alloc, lines, entry.segments, entry.path, 0, lines.len - 1, root, 0, &out, failure);
    }
    return js.joinLines(alloc, out.items);
}

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

/// `^\s*\[([^\]]+)\]\s*$`
fn tomlHeader(line: Str) ?Str {
    const trimmed = js.trim(line);
    if (trimmed.len < 2 or trimmed[0] != '[' or trimmed[trimmed.len - 1] != ']') return null;
    const body = trimmed[1 .. trimmed.len - 1];
    if (js.indexOfUnit(body, ']') != null) return null;
    return body;
}

/// The index of the `[name]` header line, or null.
fn tomlHeaderAt(lines: []const Str, name: Str) ?usize {
    for (lines, 0..) |line, index| {
        const header = tomlHeader(line) orelse continue;
        if (tomlHeaderMatches(header, name)) return index;
    }
    return null;
}

fn tomlHeaderMatches(header: Str, name: Str) bool {
    var at: usize = 0;
    var name_at: usize = 0;
    while (true) {
        const dot = js.indexOfUnit(header[at..], '.');
        const piece = unquote(js.trim(if (dot) |offset| header[at .. at + offset] else header[at..]));
        if (name_at + piece.len > name.len) return false;
        if (!js.eql(name[name_at .. name_at + piece.len], piece)) return false;
        name_at += piece.len;
        const offset = dot orelse break;
        if (name_at >= name.len or name[name_at] != '.') return false;
        name_at += 1;
        at += offset + 1;
    }
    return name_at == name.len;
}

/// The index of the first `[name]` header at all, or null.
fn firstTomlHeader(lines: []const Str) ?usize {
    for (lines, 0..) |line, index| {
        if (tomlHeader(line) != null) return index;
    }
    return null;
}

/// The end of the table that starts at `header`: the next header, or the end.
fn tomlTableEnd(lines: []const Str, header: usize) usize {
    var end = lines.len;
    var i = header + 1;
    while (i < lines.len) : (i += 1) {
        if (tomlHeader(lines[i]) != null) {
            end = i;
            break;
        }
    }
    while (end > header + 1 and js.trim(lines[end - 1]).len == 0) end -= 1;
    return end;
}

/// `^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9_-]+)\s*=`
fn tomlKey(line: Str) ?Str {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len) return null;

    const start = at;
    if (line[at] == '"') {
        at += 1;
        while (at < line.len and line[at] != '"') {
            if (line[at] == '\\') at += 1;
            at += 1;
        }
        if (at >= line.len) return null;
        at += 1;
    } else if (line[at] == '\'') {
        at += 1;
        while (at < line.len) {
            if (line[at] == '\'' and at + 1 < line.len and line[at + 1] == '\'') {
                at += 2;
                continue;
            }
            if (line[at] == '\'') break;
            at += 1;
        }
        if (at >= line.len) return null;
        at += 1;
    } else {
        if (!(js.isAsciiWord(line[at]) or line[at] == '-')) return null;
        while (at < line.len and (js.isAsciiWord(line[at]) or line[at] == '-')) at += 1;
    }

    const key = line[start..at];
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len or line[at] != '=') return null;
    return key;
}

/// The line of `key = …` in `from..to`, or null.
fn tomlKeyAt(lines: []const Str, key: Str, from: usize, to: usize) ?usize {
    var i = from;
    while (i <= to and i < lines.len) : (i += 1) {
        const line = lines[i];
        if (blankOrComment(line, &.{&js.lit("#")})) continue;
        const found = tomlKey(line) orelse continue;
        if (js.eql(unquote(found), key)) return i;
    }
    return null;
}

/// The key's line plus the continuation lines of a multi-line array or table.
fn tomlValueLines(
    alloc: Allocator,
    lines: []const Str,
    at: usize,
    out: *std.ArrayList(Str),
) !void {
    try out.append(alloc, lines[at]);
    var level: isize = 0;
    const eq = js.indexOfUnit(lines[at], '=') orelse lines[at].len;
    level += try depthOf(alloc, lines[at], eq + 1);
    var i = at + 1;
    while (level > 0 and i < lines.len) : (i += 1) {
        try out.append(alloc, lines[i]);
        level += try depthOf(alloc, lines[i], 0);
    }
}

fn depthOf(alloc: Allocator, text: Str, from: usize) !isize {
    const code = try withoutStrings(alloc, text);
    var level: isize = 0;
    for (code[@min(from, code.len)..]) |unit| {
        if (unit == '[' or unit == '{') level += 1 else if (unit == ']' or unit == '}') level -= 1;
    }
    return level;
}

/// The rule for `.toml`: `#a.b` selects the `b` key of `[a]`, rendered with its
/// table header above it, and `#a` selects the whole `[a]` table (or the
/// top-level key `a` when there is no such table).
pub fn extractTomlRegion(alloc: Allocator, text: Str, reference: Str, failure: *Failure) Error![]u16 {
    const normalized = try js.normalize(alloc, text);
    const lines = try js.splitLines(alloc, normalized);
    var out = std.ArrayList(Str).empty;

    for (try keyPaths(alloc, reference, failure)) |entry| {
        const segments = entry.segments;
        const key = segments[segments.len - 1];
        const table = segments[0 .. segments.len - 1];

        if (table.len == 0) {
            const first = firstTomlHeader(lines);
            // `(first === -1 ? lines.length : first) - 1`, and `to` is a line
            // index, so a `first` of 0 searches no line at all.
            const limit: ?usize = if (first) |index| (if (index == 0) null else index - 1) else lines.len - 1;
            if (limit) |to| {
                if (tomlKeyAt(lines, key, 0, to)) |at| {
                    try tomlValueLines(alloc, lines, at, &out);
                    continue;
                }
            }
            const header = tomlHeaderAt(lines, key) orelse {
                return failure.set(try js.format(alloc, "\"{s}\": no key or table \"{s}\"", .{ entry.path, key }));
            };
            var i = header;
            const end = tomlTableEnd(lines, header);
            while (i < end) : (i += 1) try out.append(alloc, lines[i]);
            continue;
        }

        const joined = try joinDots(alloc, table);
        const header = tomlHeaderAt(lines, joined) orelse {
            return failure.set(try js.format(alloc, "\"{s}\": no table \"[{s}]\"", .{ entry.path, joined }));
        };
        const end = tomlTableEnd(lines, header);
        const at = tomlKeyAt(lines, key, header + 1, if (end == 0) 0 else end - 1) orelse {
            return failure.set(try js.format(
                alloc,
                "\"{s}\": no key \"{s}\" in [{s}]",
                .{ entry.path, key, joined },
            ));
        };
        var header_text = std.ArrayList(u16).empty;
        try header_text.append(alloc, '[');
        try header_text.appendSlice(alloc, joined);
        try header_text.append(alloc, ']');
        try out.append(alloc, try header_text.toOwnedSlice(alloc));
        try tomlValueLines(alloc, lines, at, &out);
    }
    return js.joinLines(alloc, out.items);
}

fn joinDots(alloc: Allocator, segments: []const Str) ![]u16 {
    var out = std.ArrayList(u16).empty;
    for (segments, 0..) |segment, index| {
        if (index > 0) try out.append(alloc, '.');
        try out.appendSlice(alloc, segment);
    }
    return out.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// INI
// ---------------------------------------------------------------------------

/// `^\s*\[([^\]]+)\]\s*$`
fn iniHeader(line: Str) ?Str {
    const trimmed = js.trim(line);
    if (trimmed.len < 2 or trimmed[0] != '[' or trimmed[trimmed.len - 1] != ']') return null;
    const body = trimmed[1 .. trimmed.len - 1];
    if (js.indexOfUnit(body, ']') != null) return null;
    return body;
}

/// The index of the `[name]` line, or null.
fn iniSectionAt(lines: []const Str, name: Str) ?usize {
    for (lines, 0..) |line, index| {
        const header = iniHeader(line) orelse continue;
        if (js.eql(unquote(js.trim(header)), name)) return index;
    }
    return null;
}

/// The end of the section at `header`: the next section line, or the end.
fn iniSectionEnd(lines: []const Str, header: usize) usize {
    var end = lines.len;
    var i = header + 1;
    while (i < lines.len) : (i += 1) {
        if (iniHeader(lines[i]) != null) {
            end = i;
            break;
        }
    }
    while (end > header + 1 and js.trim(lines[end - 1]).len == 0) end -= 1;
    return end;
}

/// `^\s*([^=:#\s][^=:]*?)\s*[=:]` — the key is everything between the first
/// non-space and the separator, with trailing spaces trimmed away.
fn iniKey(line: Str) ?Str {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len) return null;
    const first = line[at];
    if (first == '=' or first == ':' or first == '#' or js.isWhitespace(first)) return null;

    const start = at;
    at += 1;
    while (at < line.len and line[at] != '=' and line[at] != ':') at += 1;
    if (at >= line.len) return null;
    return js.trimEnd(line[start..at]);
}

/// The line of `key = value` (or `key: value`) in `from..to`, or null.
fn iniKeyAt(lines: []const Str, key: Str, from: usize, to: usize) ?usize {
    var i = from;
    while (i <= to and i < lines.len) : (i += 1) {
        const line = lines[i];
        if (blankOrComment(line, &.{ &js.lit(";"), &js.lit("#") })) continue;
        const found = iniKey(line) orelse continue;
        if (js.eql(found, key)) return i;
    }
    return null;
}

/// The rule for `.ini`: `#section.key` selects the key inside that section,
/// rendered with its `[section]` header above it; `#section` selects the whole
/// section, and `#key` the key that sits before any section.
pub fn extractIniRegion(alloc: Allocator, text: Str, reference: Str, failure: *Failure) Error![]u16 {
    const normalized = try js.normalize(alloc, text);
    const lines = try js.splitLines(alloc, normalized);
    var out = std.ArrayList(Str).empty;

    for (try keyPaths(alloc, reference, failure)) |entry| {
        const segments = entry.segments;
        if (segments.len > 2) {
            return failure.set(try js.format(
                alloc,
                "\"{s}\": INI has sections and keys, not deeper paths",
                .{entry.path},
            ));
        }

        if (segments.len == 2) {
            const section_name = segments[0];
            const key = segments[1];
            const section = iniSectionAt(lines, section_name) orelse {
                return failure.set(try js.format(
                    alloc,
                    "\"{s}\": no section \"[{s}]\"",
                    .{ entry.path, section_name },
                ));
            };
            const end = iniSectionEnd(lines, section);
            const at = iniKeyAt(lines, key, section + 1, if (end == 0) 0 else end - 1) orelse {
                return failure.set(try js.format(
                    alloc,
                    "\"{s}\": no key \"{s}\" in [{s}]",
                    .{ entry.path, key, section_name },
                ));
            };
            try out.append(alloc, js.trim(lines[section]));
            try out.append(alloc, js.trim(lines[at]));
            continue;
        }

        if (iniSectionAt(lines, segments[0])) |section| {
            var i = section;
            const end = iniSectionEnd(lines, section);
            while (i < end) : (i += 1) try out.append(alloc, lines[i]);
            continue;
        }
        const at = iniKeyAt(lines, segments[0], 0, lines.len - 1) orelse {
            return failure.set(try js.format(
                alloc,
                "\"{s}\": no section \"[{s}]\" and no key \"{s}\"",
                .{ entry.path, segments[0], segments[0] },
            ));
        };
        try out.append(alloc, js.trim(lines[at]));
    }
    return js.joinLines(alloc, out.items);
}
