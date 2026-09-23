//! `inject-examples` - library (the Zig twin of `index.mjs`).
//!
//! Keeps a Markdown document honest: a *marker* line that is nothing but a link
//! to a real file is followed by a fenced code block, and that block is replaced
//! verbatim with the file's text (or with one region of it).
//!
//! **The JavaScript implementation is the source of truth.** This port exists to
//! produce the same bytes the JavaScript one produces, in every mode, on every
//! input; where the two disagree, `index.mjs` is right and this file is the bug.
//! See the "The Zig port" section of `README.md`.
//!
//! Everything here is pure: text is handled as UTF-16 code units (what a
//! JavaScript string is), and nothing touches the filesystem.
//!
//! Zig 0.16.0. No `std.Io` is used in this module.

const std = @import("std");
const Allocator = std.mem.Allocator;

/// A JavaScript string, as UTF-16 code units. Indexing, `.length`, `slice` and
/// the regular expressions all count in code units, so the port works in them
/// and only transcodes at the edges (files in, files out).
pub const Str = []const u16;

/// A fence is a line starting with this; three backticks, per CommonMark.
pub const FENCE = "```";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Where an `Error` would be thrown in JavaScript, the message is carried out
/// through this.
///
/// `include` marks the JS `IncludeError`: the `no code block` and `unclosed
/// code block` cases, which `lenient` mode turns into a skip. Errors the
/// *document* itself carries (`marker not found`, `expected a fenced code block
/// right after …`, a duplicate marker) are plain `Error`s and stay strict in
/// every mode; a failure from resolving the marker's file or region is
/// tolerated by `lenient` on its own path (see `updateDocument`).
pub const Failure = struct {
    message: Str = &.{},
    include: bool = false,

    pub fn set(self: *Failure, message: Str) error{Failed} {
        self.message = message;
        return error.Failed;
    }
};

/// The Zig spelling of a JS `throw`, plus allocation failure.
pub const JsError = error{Failed} || Allocator.Error;

// ---------------------------------------------------------------------------
// ASCII literals as code units
// ---------------------------------------------------------------------------

/// A compile-time ASCII literal as UTF-16 code units.
pub fn lit(comptime text: []const u8) [text.len]u16 {
    var out: [text.len]u16 = undefined;
    for (text, 0..) |c, i| out[i] = c;
    return out;
}

pub fn dupAscii(alloc: Allocator, text: []const u8) ![]u16 {
    const out = try alloc.alloc(u16, text.len);
    for (text, 0..) |c, i| out[i] = c;
    return out;
}

// ---------------------------------------------------------------------------
// Growable code-unit buffer
// ---------------------------------------------------------------------------

pub const Buf = struct {
    list: std.ArrayList(u16) = .empty,

    pub fn init() Buf {
        return .{};
    }

    pub fn appendUnit(self: *Buf, alloc: Allocator, unit: u16) !void {
        try self.list.append(alloc, unit);
    }

    pub fn appendUnits(self: *Buf, alloc: Allocator, units: Str) !void {
        try self.list.appendSlice(alloc, units);
    }

    pub fn appendAscii(self: *Buf, alloc: Allocator, text: []const u8) !void {
        for (text) |c| try self.list.append(alloc, c);
    }

    pub fn toOwned(self: *Buf, alloc: Allocator) ![]u16 {
        return self.list.toOwnedSlice(alloc);
    }

    /// `String(n)` / `${n}` for a non-negative integer.
    pub fn appendInt(self: *Buf, alloc: Allocator, value: usize) !void {
        var digits: [24]u8 = undefined;
        const text = std.fmt.bufPrint(&digits, "{d}", .{value}) catch unreachable;
        try self.appendAscii(alloc, text);
    }
};

/// `"..." + parts + "..."`: `{s}` takes a `Str`, `{d}` an integer. The template is
/// ASCII and so is every number, so this is `std.fmt` restricted to what the
/// messages need.
pub fn format(alloc: Allocator, comptime template: []const u8, args: anytype) ![]u16 {
    const specs = comptime blk: {
        var found: [args.len][]const u8 = undefined;
        var count: usize = 0;
        var i: usize = 0;
        while (i < template.len) : (i += 1) {
            if (template[i] != '{') continue;
            const close = std.mem.indexOfScalarPos(u8, template, i, '}') orelse
                @compileError("unterminated format specifier");
            found[count] = template[i + 1 .. close];
            count += 1;
            i = close;
        }
        if (count != args.len) @compileError("format argument count mismatch");
        break :blk found;
    };

    var buf = Buf.init();
    var next: usize = 0;
    var i: usize = 0;
    while (i < template.len) {
        if (template[i] != '{') {
            try buf.appendUnit(alloc, template[i]);
            i += 1;
            continue;
        }
        const close = std.mem.indexOfScalarPos(u8, template, i, '}') orelse unreachable;
        inline for (args, 0..) |arg, index| {
            if (next == index) {
                const spec = comptime specs[index];
                if (comptime std.mem.eql(u8, spec, "s")) {
                    try buf.appendUnits(alloc, arg);
                } else if (comptime std.mem.eql(u8, spec, "d")) {
                    try buf.appendInt(alloc, arg);
                } else {
                    @compileError("unsupported format specifier: " ++ spec);
                }
            }
        }
        next += 1;
        i = close + 1;
    }
    return buf.toOwned(alloc);
}

// ---------------------------------------------------------------------------
// Code-unit helpers
// ---------------------------------------------------------------------------

pub fn eql(a: Str, b: Str) bool {
    return std.mem.eql(u16, a, b);
}

pub fn startsWith(text: Str, prefix: Str) bool {
    return std.mem.startsWith(u16, text, prefix);
}

pub fn endsWith(text: Str, suffix: Str) bool {
    return std.mem.endsWith(u16, text, suffix);
}

pub fn indexOf(text: Str, needle: Str) ?usize {
    return std.mem.indexOf(u16, text, needle);
}

pub fn indexOfUnit(text: Str, unit: u16) ?usize {
    return std.mem.indexOfScalar(u16, text, unit);
}

pub fn lastIndexOfUnit(text: Str, unit: u16) ?usize {
    return std.mem.lastIndexOfScalar(u16, text, unit);
}

pub fn slice(text: Str, from: usize, to: usize) Str {
    return text[from..to];
}

/// `str.slice(from)` with `slice`'s clamping.
pub fn sliceFrom(text: Str, from: usize) Str {
    return text[@min(from, text.len)..];
}

/// True for the `/i` flag's folding: JavaScript folds ASCII only without the
/// `u` flag, and the patterns here are ASCII either side.
pub fn asciiLower(unit: u16) u16 {
    return if (unit >= 'A' and unit <= 'Z') unit + 32 else unit;
}

pub fn isAsciiDigit(unit: u16) bool {
    return unit >= '0' and unit <= '9';
}

pub fn isAsciiWord(unit: u16) bool {
    return (unit >= 'a' and unit <= 'z') or (unit >= 'A' and unit <= 'Z') or
        (unit >= '0' and unit <= '9') or unit == '_';
}

/// `\b` at code-unit offset `at`: one side a `\w`, the other not.
pub fn isWordBoundary(text: Str, at: usize) bool {
    const before = at > 0 and isAsciiWord(text[at - 1]);
    const after = at < text.len and isAsciiWord(text[at]);
    return before != after;
}

/// `Number(segment)` for a run of ASCII digits, saturated: JavaScript compares
/// it against `source.length`, so any value past `usize` is "too large" either
/// way, while a wrapping parse could land back inside the array.
pub fn parseDigitRun(text: Str) usize {
    var value: usize = 0;
    for (text) |unit| {
        if (!isAsciiDigit(unit)) break;
        if (value > (std.math.maxInt(usize) - 9) / 10) return std.math.maxInt(usize);
        value = value * 10 + (unit - '0');
    }
    return value;
}

/// The whitespace `String.prototype.trim` and `/\s/` share, dumped from V8:
/// tab, LF, VT, FF, CR, space, NBSP, ogham space, U+2000-U+200A, LS, PS,
/// narrow NBSP, medium mathematical space, ideographic space and U+FEFF.
pub fn isWhitespace(unit: u16) bool {
    return switch (unit) {
        0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF => true,
        else => false,
    };
}

/// The four line terminators, which `.` in a regular expression will not match.
pub fn isLineTerminator(unit: u16) bool {
    return unit == 0x000A or unit == 0x000D or unit == 0x2028 or unit == 0x2029;
}

/// What `JSON.parse` skips: the JSON grammar's whitespace, which is narrower
/// than JavaScript's - U+FEFF, U+00A0 and U+2028 are *not* JSON whitespace, and
/// V8 reports them as unexpected tokens.
pub fn isJsonWhitespace(unit: u16) bool {
    return unit == 0x0009 or unit == 0x000A or unit == 0x000D or unit == 0x0020;
}

pub fn trim(text: Str) Str {
    return trimEnd(trimStart(text));
}

pub fn trimStart(text: Str) Str {
    var start: usize = 0;
    while (start < text.len and isWhitespace(text[start])) start += 1;
    return text[start..];
}

pub fn trimEnd(text: Str) Str {
    var end: usize = text.len;
    while (end > 0 and isWhitespace(text[end - 1])) end -= 1;
    return text[0..end];
}

/// `text.split('\n')` - never empty, and a trailing `\n` yields a final `""`.
pub fn splitLines(alloc: Allocator, text: Str) ![]Str {
    var lines = std.ArrayList(Str).empty;
    var start: usize = 0;
    while (indexOfUnit(text[start..], '\n')) |offset| {
        try lines.append(alloc, text[start .. start + offset]);
        start += offset + 1;
    }
    try lines.append(alloc, text[start..]);
    return lines.toOwnedSlice(alloc);
}

/// `lines.join('\n')`.
pub fn joinLines(alloc: Allocator, lines: []const Str) ![]u16 {
    var buf = Buf.init();
    for (lines, 0..) |line, index| {
        if (index > 0) try buf.appendUnit(alloc, '\n');
        try buf.appendUnits(alloc, line);
    }
    return buf.toOwned(alloc);
}

pub fn concat(alloc: Allocator, parts: []const Str) ![]u16 {
    var buf = Buf.init();
    for (parts) |part| try buf.appendUnits(alloc, part);
    return buf.toOwned(alloc);
}

/// `text.replace(/\r\n/g, '\n')`.
pub fn crlfToLf(alloc: Allocator, text: Str) ![]u16 {
    var buf = Buf.init();
    var i: usize = 0;
    while (i < text.len) {
        if (text[i] == '\r' and i + 1 < text.len and text[i + 1] == '\n') {
            try buf.appendUnit(alloc, '\n');
            i += 2;
        } else {
            try buf.appendUnit(alloc, text[i]);
            i += 1;
        }
    }
    return buf.toOwned(alloc);
}

/// `normalize`: LF endings and no trailing newline.
pub fn normalize(alloc: Allocator, text: Str) ![]u16 {
    const lf = try crlfToLf(alloc, text);
    if (lf.len > 0 and lf[lf.len - 1] == '\n') return lf[0 .. lf.len - 1];
    return lf;
}

/// `text.replace(/\r$/, '')`.
pub fn stripTrailingCr(text: Str) Str {
    if (text.len > 0 and text[text.len - 1] == '\r') return text[0 .. text.len - 1];
    return text;
}

// ---------------------------------------------------------------------------
// UTF-8, exactly as Node decodes and encodes it
// ---------------------------------------------------------------------------

/// `readFileSync(path, 'utf8')` / `Buffer.from(text, 'utf8')`: the WHATWG
/// decoder, where every maximal invalid subsequence becomes one U+FFFD.
pub fn utf8Decode(alloc: Allocator, bytes: []const u8) ![]u16 {
    var out = std.ArrayList(u16).empty;
    var i: usize = 0;
    while (i < bytes.len) {
        const lead = bytes[i];
        if (lead < 0x80) {
            try out.append(alloc, lead);
            i += 1;
            continue;
        }
        var extra: usize = 0;
        var code: u32 = 0;
        var lower: u8 = 0x80;
        var upper: u8 = 0xBF;
        if (lead >= 0xC2 and lead <= 0xDF) {
            extra = 1;
            code = lead & 0x1F;
        } else if (lead >= 0xE0 and lead <= 0xEF) {
            extra = 2;
            code = lead & 0x0F;
            if (lead == 0xE0) lower = 0xA0 else if (lead == 0xED) upper = 0x9F;
        } else if (lead >= 0xF0 and lead <= 0xF4) {
            extra = 3;
            code = lead & 0x07;
            if (lead == 0xF0) lower = 0x90 else if (lead == 0xF4) upper = 0x8F;
        } else {
            try out.append(alloc, 0xFFFD);
            i += 1;
            continue;
        }

        var taken: usize = 0;
        while (taken < extra) : (taken += 1) {
            const at = i + 1 + taken;
            if (at >= bytes.len) break;
            const byte = bytes[at];
            const lo: u8 = if (taken == 0) lower else 0x80;
            const hi: u8 = if (taken == 0) upper else 0xBF;
            if (byte < lo or byte > hi) break;
            code = (code << 6) | (byte & 0x3F);
        }

        if (taken == extra) {
            if (code < 0x10000) {
                try out.append(alloc, @intCast(code));
            } else {
                const rest = code - 0x10000;
                try out.append(alloc, @intCast(0xD800 + (rest >> 10)));
                try out.append(alloc, @intCast(0xDC00 + (rest & 0x3FF)));
            }
            i += 1 + extra;
        } else {
            try out.append(alloc, 0xFFFD);
            i += 1 + taken;
        }
    }
    return out.toOwnedSlice(alloc);
}

/// `Buffer.from(text, 'utf8')`: an unpaired surrogate is written as U+FFFD.
pub fn utf8Encode(alloc: Allocator, text: Str) ![]u8 {
    var out = std.ArrayList(u8).empty;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        var code: u32 = text[i];
        if (code >= 0xD800 and code <= 0xDBFF) {
            if (i + 1 < text.len and text[i + 1] >= 0xDC00 and text[i + 1] <= 0xDFFF) {
                code = 0x10000 + ((code - 0xD800) << 10) + (text[i + 1] - 0xDC00);
                i += 1;
            } else {
                code = 0xFFFD;
            }
        } else if (code >= 0xDC00 and code <= 0xDFFF) {
            code = 0xFFFD;
        }

        if (code < 0x80) {
            try out.append(alloc, @intCast(code));
        } else if (code < 0x800) {
            try out.append(alloc, @intCast(0xC0 | (code >> 6)));
            try out.append(alloc, @intCast(0x80 | (code & 0x3F)));
        } else if (code < 0x10000) {
            try out.append(alloc, @intCast(0xE0 | (code >> 12)));
            try out.append(alloc, @intCast(0x80 | ((code >> 6) & 0x3F)));
            try out.append(alloc, @intCast(0x80 | (code & 0x3F)));
        } else {
            try out.append(alloc, @intCast(0xF0 | (code >> 18)));
            try out.append(alloc, @intCast(0x80 | ((code >> 12) & 0x3F)));
            try out.append(alloc, @intCast(0x80 | ((code >> 6) & 0x3F)));
            try out.append(alloc, @intCast(0x80 | (code & 0x3F)));
        }
    }
    return out.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// Numbers, exactly as `JSON.stringify` prints them
// ---------------------------------------------------------------------------

/// `String(value)` for a finite double, which is what `JSON.stringify` uses.
///
/// Zig's shortest round-trip rendering (`std.fmt.float.render`, the same
/// algorithm V8 uses) comes back as `d.dddde+/-E`; this rearranges it into
/// JavaScript's fixed/scientific choice: fixed when the decimal exponent is in
/// `[-6, 20]`, scientific outside it, with a single mantissa digit and a signed
/// exponent.
pub fn formatNumber(alloc: Allocator, value: f64) ![]u16 {
    if (std.math.isNan(value) or std.math.isInf(value)) return dupAscii(alloc, "null");
    if (value == 0) return dupAscii(alloc, "0"); // also -0

    var buffer: [512]u8 = undefined;
    const rendered = std.fmt.float.render(&buffer, value, .{}) catch return dupAscii(alloc, "0");

    var negative = false;
    var i: usize = 0;
    if (i < rendered.len and rendered[i] == '-') {
        negative = true;
        i += 1;
    }

    var digits: [512]u8 = undefined;
    var digit_count: usize = 0;
    var integer_digits: usize = 0;
    while (i < rendered.len and rendered[i] != '.' and rendered[i] != 'e') : (i += 1) {
        digits[digit_count] = rendered[i];
        digit_count += 1;
        integer_digits += 1;
    }
    if (i < rendered.len and rendered[i] == '.') {
        i += 1;
        while (i < rendered.len and rendered[i] != 'e') : (i += 1) {
            digits[digit_count] = rendered[i];
            digit_count += 1;
        }
    }
    // `e` and the exponent; Zig writes `e` with no `+`.
    var exponent: i32 = 0;
    var exponent_negative = false;
    if (i < rendered.len and rendered[i] == 'e') {
        i += 1;
        if (i < rendered.len and (rendered[i] == '-' or rendered[i] == '+')) {
            exponent_negative = rendered[i] == '-';
            i += 1;
        }
        while (i < rendered.len) : (i += 1) exponent = exponent * 10 + @as(i32, rendered[i] - '0');
        if (exponent_negative) exponent = -exponent;
    }

    // Drop trailing zeros: JavaScript never prints them.
    while (digit_count > 1 and digits[digit_count - 1] == '0') digit_count -= 1;

    // The decimal exponent of the leading digit: value = d[0].d[1..]e`point`.
    const point: i32 = @as(i32, @intCast(integer_digits)) - 1 + exponent;

    var buf = Buf.init();
    if (negative) try buf.appendUnit(alloc, '-');

    if (point < -6 or point >= 21) {
        try buf.appendUnit(alloc, digits[0]);
        if (digit_count > 1) {
            try buf.appendUnit(alloc, '.');
            for (digits[1..digit_count]) |digit| try buf.appendUnit(alloc, digit);
        }
        try buf.appendUnit(alloc, 'e');
        try buf.appendUnit(alloc, if (point >= 0) '+' else '-');
        const magnitude: usize = @intCast(if (point < 0) -point else point);
        var exponent_digits: [24]u8 = undefined;
        const text = std.fmt.bufPrint(&exponent_digits, "{d}", .{magnitude}) catch unreachable;
        try buf.appendAscii(alloc, text);
    } else if (point >= 0) {
        const whole: usize = @intCast(point + 1);
        var index: usize = 0;
        while (index < whole) : (index += 1) {
            try buf.appendUnit(alloc, if (index < digit_count) digits[index] else '0');
        }
        if (digit_count > whole) {
            try buf.appendUnit(alloc, '.');
            for (digits[whole..digit_count]) |digit| try buf.appendUnit(alloc, digit);
        }
    } else {
        const zeros: usize = @intCast(-point - 1);
        try buf.appendAscii(alloc, "0.");
        var index: usize = 0;
        while (index < zeros) : (index += 1) try buf.appendUnit(alloc, '0');
        for (digits[0..digit_count]) |digit| try buf.appendUnit(alloc, digit);
    }
    return buf.toOwned(alloc);
}

// ---------------------------------------------------------------------------
// JSON values
// ---------------------------------------------------------------------------

pub const JsonEntry = struct {
    key: Str,
    value: *const JsonValue,
};

pub const JsonValue = union(enum) {
    null,
    boolean: bool,
    number: f64,
    string: Str,
    array: []const *const JsonValue,
    object: []const JsonEntry,
};

/// `JSON.stringify(value, null, 2)`.
pub fn stringify(alloc: Allocator, value: *const JsonValue) ![]u16 {
    var buf = Buf.init();
    try stringifyInto(alloc, &buf, value, 0);
    return buf.toOwned(alloc);
}

fn appendIndent(alloc: Allocator, buf: *Buf, depth: usize) !void {
    var i: usize = 0;
    while (i < depth) : (i += 1) try buf.appendAscii(alloc, "  ");
}

fn stringifyInto(alloc: Allocator, buf: *Buf, value: *const JsonValue, depth: usize) !void {
    switch (value.*) {
        .null => try buf.appendAscii(alloc, "null"),
        .boolean => |flag| try buf.appendAscii(alloc, if (flag) "true" else "false"),
        .number => |number| try buf.appendUnits(alloc, try formatNumber(alloc, number)),
        .string => |text| try stringifyString(alloc, buf, text),
        .array => |items| {
            if (items.len == 0) {
                try buf.appendAscii(alloc, "[]");
                return;
            }
            try buf.appendAscii(alloc, "[\n");
            for (items, 0..) |item, index| {
                try appendIndent(alloc, buf, depth + 1);
                try stringifyInto(alloc, buf, item, depth + 1);
                if (index + 1 < items.len) try buf.appendUnit(alloc, ',');
                try buf.appendUnit(alloc, '\n');
            }
            try appendIndent(alloc, buf, depth);
            try buf.appendUnit(alloc, ']');
        },
        .object => |entries| {
            if (entries.len == 0) {
                try buf.appendAscii(alloc, "{}");
                return;
            }
            const ordered = try orderedEntries(alloc, entries);
            try buf.appendAscii(alloc, "{\n");
            for (ordered, 0..) |entry, index| {
                try appendIndent(alloc, buf, depth + 1);
                try stringifyString(alloc, buf, entry.key);
                try buf.appendAscii(alloc, ": ");
                try stringifyInto(alloc, buf, entry.value, depth + 1);
                if (index + 1 < ordered.len) try buf.appendUnit(alloc, ',');
                try buf.appendUnit(alloc, '\n');
            }
            try appendIndent(alloc, buf, depth);
            try buf.appendUnit(alloc, '}');
        },
    }
}

fn appendHex4(alloc: Allocator, buf: *Buf, unit: u16) !void {
    const hex = "0123456789abcdef";
    try buf.appendAscii(alloc, "\\u");
    try buf.appendUnit(alloc, hex[(unit >> 12) & 0xF]);
    try buf.appendUnit(alloc, hex[(unit >> 8) & 0xF]);
    try buf.appendUnit(alloc, hex[(unit >> 4) & 0xF]);
    try buf.appendUnit(alloc, hex[unit & 0xF]);
}

fn stringifyString(alloc: Allocator, buf: *Buf, text: Str) !void {
    try buf.appendUnit(alloc, '"');
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        const unit = text[i];
        switch (unit) {
            '"' => try buf.appendAscii(alloc, "\\\""),
            '\\' => try buf.appendAscii(alloc, "\\\\"),
            0x08 => try buf.appendAscii(alloc, "\\b"),
            0x09 => try buf.appendAscii(alloc, "\\t"),
            0x0A => try buf.appendAscii(alloc, "\\n"),
            0x0C => try buf.appendAscii(alloc, "\\f"),
            0x0D => try buf.appendAscii(alloc, "\\r"),
            else => {
                if (unit < 0x20) {
                    const hex = "0123456789abcdef";
                    try buf.appendAscii(alloc, "\\u00");
                    try buf.appendUnit(alloc, hex[(unit >> 4) & 0xF]);
                    try buf.appendUnit(alloc, hex[unit & 0xF]);
                } else if (unit >= 0xD800 and unit <= 0xDBFF) {
                    if (i + 1 < text.len and text[i + 1] >= 0xDC00 and text[i + 1] <= 0xDFFF) {
                        try buf.appendUnit(alloc, unit);
                        try buf.appendUnit(alloc, text[i + 1]);
                        i += 1;
                    } else {
                        try appendHex4(alloc, buf, unit);
                    }
                } else if (unit >= 0xDC00 and unit <= 0xDFFF) {
                    try appendHex4(alloc, buf, unit);
                } else {
                    try buf.appendUnit(alloc, unit);
                }
            },
        }
    }
    try buf.appendUnit(alloc, '"');
}

// ---------------------------------------------------------------------------
// `JSON.parse`, with V8's messages
// ---------------------------------------------------------------------------

/// V8 enumerates array-index-like keys first, ascending, then the rest in
/// insertion order - and `JSON.stringify` follows enumeration order, so this
/// is what an object's keys are printed in. A key is an index when it is
/// canonical decimal with no leading zero and fits `2^32 - 2`.
pub fn isArrayIndexKey(key: Str) bool {
    if (key.len == 0 or key.len > 10) return false;
    if (key.len > 1 and key[0] == '0') return false;
    var value: u64 = 0;
    for (key) |unit| {
        if (!isAsciiDigit(unit)) return false;
        value = value * 10 + (unit - '0');
    }
    return value <= 4294967294;
}

/// The entries in the order V8 would enumerate them (see `isArrayIndexKey`).
pub fn orderedEntries(alloc: Allocator, entries: []const JsonEntry) ![]JsonEntry {
    const out = try alloc.alloc(JsonEntry, entries.len);
    var count: usize = 0;
    // Insertion sort over the index-like keys, which come first.
    for (entries) |entry| {
        if (!isArrayIndexKey(entry.key)) continue;
        var at = count;
        while (at > 0 and indexKeyLess(entry.key, out[at - 1].key)) : (at -= 1) {
            out[at] = out[at - 1];
        }
        out[at] = entry;
        count += 1;
    }
    for (entries) |entry| {
        if (isArrayIndexKey(entry.key)) continue;
        out[count] = entry;
        count += 1;
    }
    return out;
}

fn indexKeyLess(a: Str, b: Str) bool {
    // Both are canonical index keys: shorter is smaller, else compare digits.
    if (a.len != b.len) return a.len < b.len;
    for (a, b) |left, right| {
        if (left != right) return left < right;
    }
    return false;
}

pub const JsonParser = struct {
    alloc: Allocator,
    text: Str,
    at: usize = 0,
    failure: *Failure,

    fn failEnd(self: *JsonParser) JsError {
        self.failure.message = try dupAscii(self.alloc, "Unexpected end of JSON input");
        return error.Failed;
    }

    fn failAt(self: *JsonParser, comptime template: []const u8, position: usize) JsError {
        const place = self.lineColumn(position);
        self.failure.message = try format(self.alloc, template, .{ position, place.line, place.column });
        return error.Failed;
    }

    /// V8 renders the offending token, then the input around it: the whole
    /// input up to 20 code units, otherwise a 20-unit window centred on the
    /// token with `...` marking each clipped side.
    fn failToken(self: *JsonParser, position: usize) JsError {
        var buf = Buf.init();
        try buf.appendAscii(self.alloc, "Unexpected token '");
        try buf.appendUnit(self.alloc, self.text[position]);
        try buf.appendAscii(self.alloc, "', ");
        if (self.text.len <= 20) {
            try buf.appendUnit(self.alloc, '"');
            try buf.appendUnits(self.alloc, self.text);
            try buf.appendUnit(self.alloc, '"');
        } else {
            // V8 prints `...` from token position 10 onwards even though that
            // window still reaches index 0, and when the far end is clipped.
            const start = if (position > 10) position - 10 else 0;
            const end = @min(self.text.len, position + 10);
            if (position >= 10) try buf.appendAscii(self.alloc, "...");
            try buf.appendUnit(self.alloc, '"');
            try buf.appendUnits(self.alloc, self.text[start..end]);
            try buf.appendUnit(self.alloc, '"');
            if (position + 10 < self.text.len) try buf.appendAscii(self.alloc, "...");
        }
        try buf.appendAscii(self.alloc, " is not valid JSON");
        self.failure.message = try buf.toOwned(self.alloc);
        return error.Failed;
    }

    /// `line` is 1-based and `column` is the distance from the last line break
    /// before the position, so a break at `position - 1` is column 1. Only CR
    /// and LF count, and CRLF counts once - with the LF as the break.
    fn lineColumn(self: *JsonParser, position: usize) struct { line: usize, column: usize } {
        var line: usize = 1;
        var last_break: ?usize = null;
        const limit = @min(position, self.text.len);
        var index: usize = 0;
        while (index < limit) : (index += 1) {
            const unit = self.text[index];
            if (unit == '\n') {
                line += 1;
                last_break = index;
            } else if (unit == '\r') {
                line += 1;
                last_break = index;
                if (index + 1 < limit and self.text[index + 1] == '\n') {
                    index += 1;
                    last_break = index;
                }
            }
        }
        const column = if (last_break) |at| position - at else position + 1;
        return .{ .line = line, .column = column };
    }

    fn skipWhitespace(self: *JsonParser) void {
        while (self.at < self.text.len and isJsonWhitespace(self.text[self.at])) self.at += 1;
    }

    fn make(self: *JsonParser, value: JsonValue) !*const JsonValue {
        const pointer = try self.alloc.create(JsonValue);
        pointer.* = value;
        return pointer;
    }

    fn parseDocument(self: *JsonParser) JsError!*const JsonValue {
        self.skipWhitespace();
        if (self.at >= self.text.len) return self.failEnd();
        const value = try self.parseValue();
        self.skipWhitespace();
        if (self.at < self.text.len) {
            return self.failAt(
                "Unexpected non-whitespace character after JSON at position {d} (line {d} column {d})",
                self.at,
            );
        }
        return value;
    }

    fn parseValue(self: *JsonParser) JsError!*const JsonValue {
        if (self.at >= self.text.len) return self.failEnd();
        const unit = self.text[self.at];
        switch (unit) {
            '{' => return self.parseObject(),
            '[' => return self.parseArray(),
            '"' => return self.make(.{ .string = try self.parseString() }),
            't' => {
                try self.parseLiteral("true");
                return self.make(.{ .boolean = true });
            },
            'f' => {
                try self.parseLiteral("false");
                return self.make(.{ .boolean = false });
            },
            'n' => {
                try self.parseLiteral("null");
                return self.make(.null);
            },
            '-', '0'...'9' => return self.make(.{ .number = try self.parseNumber() }),
            else => return self.failToken(self.at),
        }
    }

    fn parseLiteral(self: *JsonParser, comptime word: []const u8) JsError!void {
        const expected = comptime lit(word);
        var index: usize = 0;
        while (index < expected.len) : (index += 1) {
            const at = self.at + index;
            if (at >= self.text.len) return self.failEnd();
            if (self.text[at] != expected[index]) {
                // V8 re-scans the token it tripped over: something that would
                // have started a number or a string is named as such.
                const unit = self.text[at];
                if (unit == '-' or isAsciiDigit(unit)) {
                    return self.failAt(
                        "Unexpected number in JSON at position {d} (line {d} column {d})",
                        at,
                    );
                }
                if (unit == '"') {
                    return self.failAt(
                        "Unexpected string in JSON at position {d} (line {d} column {d})",
                        at,
                    );
                }
                return self.failToken(at);
            }
        }
        self.at += expected.len;
    }

    fn parseNumber(self: *JsonParser) JsError!f64 {
        const start = self.at;
        if (self.text[self.at] == '-') {
            self.at += 1;
            if (self.at >= self.text.len or !isAsciiDigit(self.text[self.at])) {
                return self.failAt(
                    "No number after minus sign in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
        }
        if (self.text[self.at] == '0') {
            self.at += 1;
            if (self.at < self.text.len and isAsciiDigit(self.text[self.at])) {
                return self.failAt(
                    "Unexpected number in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
        } else {
            while (self.at < self.text.len and isAsciiDigit(self.text[self.at])) self.at += 1;
        }
        if (self.at < self.text.len and self.text[self.at] == '.') {
            self.at += 1;
            if (self.at >= self.text.len or !isAsciiDigit(self.text[self.at])) {
                return self.failAt(
                    "Unterminated fractional number in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
            while (self.at < self.text.len and isAsciiDigit(self.text[self.at])) self.at += 1;
        }
        if (self.at < self.text.len and (self.text[self.at] == 'e' or self.text[self.at] == 'E')) {
            self.at += 1;
            if (self.at < self.text.len and (self.text[self.at] == '+' or self.text[self.at] == '-')) self.at += 1;
            if (self.at >= self.text.len or !isAsciiDigit(self.text[self.at])) {
                return self.failAt(
                    "Exponent part is missing a number in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
            while (self.at < self.text.len and isAsciiDigit(self.text[self.at])) self.at += 1;
        }

        // The literal is ASCII by construction; Zig's parser rounds to nearest
        // even exactly as V8 does, and overflows to infinity the same way. The
        // whole literal is handed over, however long it is.
        const bytes = try self.alloc.alloc(u8, self.at - start);
        for (self.text[start..self.at], 0..) |unit, index| bytes[index] = @intCast(unit);
        return std.fmt.parseFloat(f64, bytes) catch 0;
    }

    fn parseString(self: *JsonParser) JsError!Str {
        self.at += 1; // the opening quote
        var buf = Buf.init();
        while (true) {
            if (self.at >= self.text.len) {
                return self.failAt(
                    "Unterminated string in JSON at position {d} (line {d} column {d})",
                    self.text.len,
                );
            }
            const unit = self.text[self.at];
            if (unit == '"') {
                self.at += 1;
                break;
            }
            if (unit == '\\') {
                const escape = self.at + 1;
                // A backslash as the very last code unit is an end of input,
                // not an unterminated string: V8 has nothing to escape.
                if (escape >= self.text.len) return self.failEnd();
                const code = self.text[escape];
                switch (code) {
                    '"' => {
                        try buf.appendUnit(self.alloc, '"');
                        self.at = escape + 1;
                    },
                    '\\' => {
                        try buf.appendUnit(self.alloc, '\\');
                        self.at = escape + 1;
                    },
                    '/' => {
                        try buf.appendUnit(self.alloc, '/');
                        self.at = escape + 1;
                    },
                    'b' => {
                        try buf.appendUnit(self.alloc, 0x08);
                        self.at = escape + 1;
                    },
                    'f' => {
                        try buf.appendUnit(self.alloc, 0x0C);
                        self.at = escape + 1;
                    },
                    'n' => {
                        try buf.appendUnit(self.alloc, 0x0A);
                        self.at = escape + 1;
                    },
                    'r' => {
                        try buf.appendUnit(self.alloc, 0x0D);
                        self.at = escape + 1;
                    },
                    't' => {
                        try buf.appendUnit(self.alloc, 0x09);
                        self.at = escape + 1;
                    },
                    'u' => {
                        var value: u32 = 0;
                        var index: usize = 0;
                        while (index < 4) : (index += 1) {
                            const at = escape + 1 + index;
                            if (at >= self.text.len or hexValue(self.text[at]) == null) {
                                return self.failAt(
                                    "Bad Unicode escape in JSON at position {d} (line {d} column {d})",
                                    at,
                                );
                            }
                            value = value * 16 + hexValue(self.text[at]).?;
                        }
                        try buf.appendUnit(self.alloc, @intCast(value));
                        self.at = escape + 5;
                    },
                    else => return self.failAt(
                        "Bad escaped character in JSON at position {d} (line {d} column {d})",
                        escape,
                    ),
                }
                continue;
            }
            if (unit < 0x20) {
                return self.failAt(
                    "Bad control character in string literal in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
            try buf.appendUnit(self.alloc, unit);
            self.at += 1;
        }
        return buf.toOwned(self.alloc);
    }

    fn parseObject(self: *JsonParser) JsError!*const JsonValue {
        self.at += 1; // `{`
        var entries = std.ArrayList(JsonEntry).empty;
        self.skipWhitespace();
        if (self.at >= self.text.len or self.text[self.at] != '"') {
            if (self.at < self.text.len and self.text[self.at] == '}') {
                self.at += 1;
                return self.make(.{ .object = &.{} });
            }
            return self.failAt(
                "Expected property name or '}' in JSON at position {d} (line {d} column {d})",
                self.at,
            );
        }

        while (true) {
            const key = try self.parseString();
            self.skipWhitespace();
            if (self.at >= self.text.len or self.text[self.at] != ':') {
                return self.failAt(
                    "Expected ':' after property name in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
            self.at += 1;
            self.skipWhitespace();
            const value = try self.parseValue();

            // A repeated key keeps its first slot and takes the last value,
            // exactly as redefining a property does in JavaScript.
            var replaced = false;
            for (entries.items) |*entry| {
                if (eql(entry.key, key)) {
                    entry.value = value;
                    replaced = true;
                    break;
                }
            }
            if (!replaced) try entries.append(self.alloc, .{ .key = key, .value = value });

            self.skipWhitespace();
            if (self.at >= self.text.len or (self.text[self.at] != ',' and self.text[self.at] != '}')) {
                return self.failAt(
                    "Expected ',' or '}' after property value in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
            if (self.text[self.at] == '}') {
                self.at += 1;
                break;
            }
            self.at += 1; // `,`
            self.skipWhitespace();
            if (self.at >= self.text.len or self.text[self.at] != '"') {
                return self.failAt(
                    "Expected double-quoted property name in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
        }
        return self.make(.{ .object = try entries.toOwnedSlice(self.alloc) });
    }

    fn parseArray(self: *JsonParser) JsError!*const JsonValue {
        self.at += 1; // `[`
        var items = std.ArrayList(*const JsonValue).empty;
        self.skipWhitespace();
        if (self.at >= self.text.len) return self.failEnd();
        if (self.text[self.at] == ']') {
            self.at += 1;
            return self.make(.{ .array = &.{} });
        }

        while (true) {
            const value = try self.parseValue();
            try items.append(self.alloc, value);
            self.skipWhitespace();
            if (self.at >= self.text.len or (self.text[self.at] != ',' and self.text[self.at] != ']')) {
                return self.failAt(
                    "Expected ',' or ']' after array element in JSON at position {d} (line {d} column {d})",
                    self.at,
                );
            }
            if (self.text[self.at] == ']') {
                self.at += 1;
                break;
            }
            self.at += 1; // `,`
            self.skipWhitespace();
            if (self.at >= self.text.len) return self.failEnd();
        }
        return self.make(.{ .array = try items.toOwnedSlice(self.alloc) });
    }
};

fn hexValue(unit: u16) ?u32 {
    return switch (unit) {
        '0'...'9' => unit - '0',
        'a'...'f' => unit - 'a' + 10,
        'A'...'F' => unit - 'A' + 10,
        else => null,
    };
}

/// `JSON.parse(text)`: the value, or the exact V8 message in `failure`.
pub fn parseJson(alloc: Allocator, text: Str, failure: *Failure) JsError!*const JsonValue {
    var parser = JsonParser{ .alloc = alloc, .text = text, .failure = failure };
    return parser.parseDocument();
}

// ---------------------------------------------------------------------------
// The JavaScript regular expressions, written out by hand
// ---------------------------------------------------------------------------
//
// `index.mjs` names ten or so patterns. Rather than build a regular expression
// engine, each one is transcribed here as the function that decides the same
// thing - same anchoring, same greediness, same leftmost-first search order -
// so a mismatch shows up as a failing test rather than as a silent difference.

/// `COMMENT_OPENER = /^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i`:
/// how much of `text` the opener covers, or null when it does not match at all.
pub fn commentOpenerLength(text: Str) usize {
    var at: usize = 0;
    var matched = false;
    while (true) {
        const opener = commentOpenerAt(text, at) orelse break;
        at += opener;
        matched = true;
        while (at < text.len and isWhitespace(text[at])) at += 1;
    }
    return if (matched) at else 0;
}

/// One alternative of `COMMENT_OPENER`, in the order the pattern lists them.
fn commentOpenerAt(text: Str, at: usize) ?usize {
    const alternatives = .{ "//", "--", ";", "%", "'", "<!--", "/*", "*" };
    inline for (alternatives) |alternative| {
        const word = comptime lit(alternative);
        if (std.mem.startsWith(u16, text[at..], &word)) return word.len;
    }
    // `REM\b`, case-insensitive, with a word boundary after it.
    const rem = comptime lit("REM");
    if (text.len - at >= rem.len) {
        var same = true;
        for (rem, 0..) |unit, index| {
            if (asciiLower(text[at + index]) != asciiLower(unit)) same = false;
        }
        if (same and isWordBoundary(text, at + rem.len)) return rem.len;
    }
    return null;
}

/// `COMMENT_CLOSER = /\s*(?:-->|\*\/)$/`, as the index of `.exec(...).index`:
/// the start of the whitespace run in front of a closer that ends the text.
pub fn commentCloserStart(text: Str) ?usize {
    const arrow = comptime lit("-->");
    const star = comptime lit("*/");
    var target: usize = 0;
    if (text.len >= arrow.len and std.mem.endsWith(u16, text, &arrow)) {
        target = text.len - arrow.len;
    } else if (text.len >= star.len and std.mem.endsWith(u16, text, &star)) {
        target = text.len - star.len;
    } else return null;

    var start = target;
    while (start > 0 and isWhitespace(text[start - 1])) start -= 1;
    return start;
}

pub const DirectiveKind = enum { region, endregion };

pub const Directive = struct {
    kind: DirectiveKind,
    name: Str,
};

/// `regionDirective`: one line read as `#region <name>` / `#endregion`.
pub fn regionDirective(line: Str) ?Directive {
    var text = trim(line);

    if (commentCloserStart(text)) |start| text = trim(text[0..start]);

    const commented = commentOpenerLength(text) > 0;
    if (commented) text = trim(text[commentOpenerLength(text)..]);

    // `/^(#?)(region|endregion)\b\s*(.*)$/i`
    var at: usize = 0;
    var hash = false;
    if (at < text.len and text[at] == '#') {
        hash = true;
        at += 1;
    }
    const region = comptime lit("region");
    const endregion = comptime lit("endregion");
    var kind: DirectiveKind = undefined;
    if (std.mem.startsWith(u16, text[at..], &region)) {
        kind = .region;
        at += region.len;
    } else if (std.mem.startsWith(u16, text[at..], &endregion)) {
        kind = .endregion;
        at += endregion.len;
    } else return null;
    if (!isWordBoundary(text, at)) return null;

    // `\s*(.*)$` - `.` stops at a line terminator, and `$` is the end.
    while (at < text.len and isWhitespace(text[at])) at += 1;
    var end = at;
    while (end < text.len and !isLineTerminator(text[end])) end += 1;
    if (end != text.len) return null;

    // A bare `region foo` line is prose: without a comment prefix the C#
    // spelling (`#region`) is required.
    if (!commented and !hash) return null;

    return .{ .kind = kind, .name = trim(text[at..end]) };
}

/// `PREFIX = /^[\w$<>\[\],.?*&:@\s]*$/`.
pub fn isDeclarationPrefix(text: Str) bool {
    for (text) |unit| {
        const allowed = isAsciiWord(unit) or unit == '$' or unit == '<' or unit == '>' or
            unit == '[' or unit == ']' or unit == ',' or unit == '.' or unit == '?' or
            unit == '*' or unit == '&' or unit == ':' or unit == '@' or isWhitespace(unit);
        if (!allowed) return false;
    }
    return true;
}

/// `STATEMENT_BEFORE = /^(?:return|throw|new|await|yield|delete|typeof|case|else|do)\b/`.
pub fn isStatementBefore(text: Str) bool {
    const words = .{ "return", "throw", "new", "await", "yield", "delete", "typeof", "case", "else", "do" };
    inline for (words) |word_text| {
        const word = comptime lit(word_text);
        if (std.mem.startsWith(u16, text, &word) and isWordBoundary(text, word.len)) return true;
    }
    return false;
}

/// `DOC_OPEN = /^\s*\/\*[*!]/`.
pub fn isDocCommentOpen(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    if (at + 3 > line.len) return false;
    return line[at] == '/' and line[at + 1] == '*' and (line[at + 2] == '*' or line[at + 2] == '!');
}

/// `DOC_RUN = /^\s*\/\/\//`.
pub fn isDocCommentRun(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    if (at + 3 > line.len) return false;
    return line[at] == '/' and line[at + 1] == '/' and line[at + 2] == '/';
}

/// `ANNOTATION_LINE = /^\s*(?:@[\w.$]|#\[)/`.
pub fn isAnnotationLine(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    if (at < line.len and line[at] == '@') {
        if (at + 1 >= line.len) return false;
        const next = line[at + 1];
        return isAsciiWord(next) or next == '.' or next == '$';
    }
    return at + 1 < line.len and line[at] == '#' and line[at + 1] == '[';
}

/// `/^\s*\{/` - the Allman brace that opens a body on its own line.
pub fn startsWithBrace(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    return at < line.len and line[at] == '{';
}

/// `/\*\/\s*$/` - a block comment that ends the line.
pub fn endsWithBlockCommentEnd(line: Str) bool {
    const star = comptime lit("*/");
    var at: usize = 0;
    while (at + star.len <= line.len) : (at += 1) {
        if (std.mem.startsWith(u16, line[at..], &star)) {
            var end = at + star.len;
            while (end < line.len and isWhitespace(line[end])) end += 1;
            if (end == line.len) return true;
        }
    }
    return false;
}

/// `/^function\b/` - where the `function` keyword ends, or null.
pub fn functionKeywordEnd(text: Str) ?usize {
    const word = comptime lit("function");
    if (!std.mem.startsWith(u16, text, &word)) return null;
    if (!isWordBoundary(text, word.len)) return null;
    return word.len;
}

/// `/^\d+$/` - one or more ASCII digits and nothing else.
pub fn isAllDigits(text: Str) bool {
    if (text.len == 0) return false;
    for (text) |unit| {
        if (!isAsciiDigit(unit)) return false;
    }
    return true;
}

/// `/^region:(.+)$/` - the name in a `#region:<name>` fragment, or null.
pub fn regionFragment(fragment: Str) ?Str {
    const prefix = comptime lit("region:");
    if (!std.mem.startsWith(u16, fragment, &prefix)) return null;
    const rest = fragment[prefix.len..];
    if (rest.len == 0) return null;
    for (rest) |unit| {
        if (isLineTerminator(unit)) return null;
    }
    return rest;
}

/// `HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i`.
pub fn hasScheme(text: Str) bool {
    if (text.len == 0) return false;
    const first = asciiLower(text[0]);
    if (first < 'a' or first > 'z') return false;
    var at: usize = 1;
    while (at < text.len) : (at += 1) {
        const unit = asciiLower(text[at]);
        const allowed = (unit >= 'a' and unit <= 'z') or isAsciiDigit(unit) or
            unit == '+' or unit == '.' or unit == '-';
        if (!allowed) break;
    }
    return at < text.len and text[at] == ':';
}

/// `escapeRegExp(name)` - the literal name, as the call and assignment
/// patterns match it after escaping.
pub fn nameLengthAt(text: Str, at: usize, name: Str) bool {
    return std.mem.startsWith(u16, text[at..], name);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

pub const Marker = struct {
    raw: Str,
    path: Str,
    region: ?Str,
    index: usize = 0,
};

/// `LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/` as the two capture groups.
pub const Link = struct {
    label: Str,
    destination: Str,
};

/// The `LINK` match. `[^\]]+` cannot cross a `]`, so the label ends at the
/// first `]`; the destination then has to run to the final `)`.
pub fn matchLink(text: Str) ?Link {
    if (text.len < 4 or text[0] != '[' or text[text.len - 1] != ')') return null;
    const bracket = indexOfUnit(text[1..], ']') orelse return null;
    const close = 1 + bracket; // the `]`
    if (close < 2) return null; // the label needs at least one unit
    if (close + 1 >= text.len or text[close + 1] != '(') return null;
    const from = close + 2;
    const to = text.len - 1; // the closing `)`
    if (from >= to) return null; // the destination needs at least one unit
    for (text[from..to]) |unit| {
        if (unit == ')' or isWhitespace(unit)) return null;
    }
    return .{ .label = text[1..close], .destination = text[from..to] };
}

/// `parseMarker`: one line read as an injection marker, or null.
pub fn parseMarker(line: Str) ?Marker {
    const link = matchLink(trim(line)) orelse return null;
    if (hasScheme(link.destination)) return null;

    const hash = indexOfUnit(link.destination, '#');
    const path = if (hash) |at| link.destination[0..at] else link.destination;
    const fragment = if (hash) |at| link.destination[at + 1 ..] else link.destination[0..0];

    if (!eql(dropDotSlash(link.label), dropDotSlash(path))) return null;
    const relative_path = dropDotSlash(path);
    if (relative_path.len == 0) return null;

    if (fragment.len == 0) return .{ .raw = trim(line), .path = relative_path, .region = null };
    const region = regionFragment(fragment) orelse return null;
    return .{ .raw = trim(line), .path = relative_path, .region = region };
}

fn dropDotSlash(text: Str) Str {
    const prefix = comptime lit("./");
    if (std.mem.startsWith(u16, text, &prefix)) return text[prefix.len..];
    return text;
}

/// `FENCE_OPEN = /^\s*(`{3,})([^\r\n]*\r?)$/`.
pub const FenceOpen = struct {
    ticks: usize,
    info: Str,
};

pub fn matchFenceOpen(line: Str) ?FenceOpen {
    var at: usize = 0;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    var ticks: usize = 0;
    while (at + ticks < line.len and line[at + ticks] == '`') ticks += 1;
    if (ticks < 3) return null;
    var end = at + ticks;
    while (end < line.len and line[end] != '\r' and line[end] != '\n') end += 1;
    var after = end;
    if (after < line.len and line[after] == '\r') after += 1;
    if (after != line.len) return null;
    return .{ .ticks = ticks, .info = line[at + ticks .. after] };
}

/// `FENCE_CLOSE = /^\s*(`{3,})\s*$/` - the backtick run, or null.
pub fn matchFenceClose(line: Str) ?usize {
    var at: usize = 0;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    var ticks: usize = 0;
    while (at + ticks < line.len and line[at + ticks] == '`') ticks += 1;
    if (ticks < 3) return null;
    var end = at + ticks;
    while (end < line.len and isWhitespace(line[end])) end += 1;
    if (end != line.len) return null;
    return ticks;
}

/// The `[start, end]` line ranges of every fenced block in `lines`.
pub fn fenceRanges(alloc: Allocator, lines: []const Str) ![]const [2]usize {
    var ranges = std.ArrayList([2]usize).empty;
    var open: ?usize = null;
    var open_len: usize = 0;
    for (lines, 0..) |line, index| {
        if (open) |start| {
            if (matchFenceClose(line)) |ticks| {
                if (ticks >= open_len) {
                    try ranges.append(alloc, .{ start, index });
                    open = null;
                }
            }
        } else if (matchFenceOpen(line)) |fence| {
            open = index;
            open_len = fence.ticks;
        }
    }
    if (open) |start| try ranges.append(alloc, .{ start, lines.len - 1 });
    return ranges.toOwnedSlice(alloc);
}

/// Every marker line in a document, in order, with its line `index`.
pub fn findMarkers(alloc: Allocator, lines: []const Str) ![]Marker {
    var markers = std.ArrayList(Marker).empty;
    const ranges = try fenceRanges(alloc, lines);
    for (lines, 0..) |line, index| {
        var inside = false;
        for (ranges) |range| {
            if (index >= range[0] and index <= range[1]) inside = true;
        }
        if (inside) continue;
        if (parseMarker(line)) |marker| {
            var with_index = marker;
            with_index.index = index;
            try markers.append(alloc, with_index);
        }
    }
    return markers.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// The declaration matcher's scans
// ---------------------------------------------------------------------------

const KEYWORDS = .{ "class", "interface", "enum", "record", "struct", "trait", "object", "union" };

/// Keywords that can stand where a name would, but never declare one.
pub const NOT_A_NAME = .{
    "if",   "for",        "while", "switch", "catch",  "return", "new",  "do",
    "else", "throw",      "await", "yield",  "typeof", "delete", "void", "in",
    "of",   "instanceof", "super", "this",   "with",   "case",   "when", "sizeof",
};

pub fn isNotAName(name: Str) bool {
    inline for (NOT_A_NAME) |word_text| {
        const word = comptime lit(word_text);
        if (eql(name, &word)) return true;
    }
    return false;
}

/// `DECLARATION_KEYWORD` - the keyword, the name after it, and the span from
/// the keyword through the name (its `\b` is zero-width).
pub const KeywordMatch = struct {
    index: usize,
    length: usize,
    name: Str,
};

pub fn matchDeclarationKeyword(line: Str) ?KeywordMatch {
    var at: usize = 0;
    while (at < line.len) : (at += 1) {
        if (!isWordBoundary(line, at)) continue;
        inline for (KEYWORDS) |word_text| {
            const word = comptime lit(word_text);
            if (declarationNameAfter(line, &word, at)) |found| {
                return .{ .index = at, .length = found.end - at, .name = line[found.name_at..found.end] };
            }
        }
    }
    return null;
}

const NameAfter = struct {
    name_at: usize,
    end: usize,
};

/// `KEYWORD\s+([A-Za-z_$][\w$]*)\b` at `at`, with the greedy name backtracked
/// to the longest run that ends on a word boundary.
fn declarationNameAfter(line: Str, word: Str, at: usize) ?NameAfter {
    if (!std.mem.startsWith(u16, line[at..], word)) return null;
    var name_at = at + word.len;
    const spaces_from = name_at;
    while (name_at < line.len and isWhitespace(line[name_at])) name_at += 1;
    if (name_at == spaces_from) return null; // `\s+` needs one
    if (name_at >= line.len) return null;
    if (!isAsciiWord(line[name_at]) and line[name_at] != '$') return null;
    var end = name_at;
    while (end < line.len and (isAsciiWord(line[end]) or line[end] == '$')) end += 1;
    var candidate = end;
    while (candidate > name_at) : (candidate -= 1) {
        if (isWordBoundary(line, candidate)) return .{ .name_at = name_at, .end = candidate };
    }
    return null;
}

/// The global `name\s*\(` scan: `match.index`, the name's offset and the `(`.
pub const CallMatch = struct {
    index: usize,
    name_at: usize,
    paren: usize,
};

/// The leftmost `(^|[^\w$.])NAME\s*\(` at or after `from`, as `exec` with `g`.
pub fn nextCallMatch(line: Str, name: Str, from: usize) ?CallMatch {
    var at: usize = 0;
    while (at < line.len) : (at += 1) {
        var index: usize = undefined;
        if (at == 0) {
            index = 0;
        } else {
            const previous = line[at - 1];
            if (isAsciiWord(previous) or previous == '$' or previous == '.') continue;
            index = at - 1;
        }
        if (index < from) continue;
        if (!nameLengthAt(line, at, name)) continue;
        var paren = at + name.len;
        while (paren < line.len and isWhitespace(line[paren])) paren += 1;
        if (paren >= line.len or line[paren] != '(') continue;
        return .{ .index = index, .name_at = at, .paren = paren };
    }
    return null;
}

/// The global assignment scan: `match.index` and the end of `match[0]`.
pub const AssignedMatch = struct {
    index: usize,
    end: usize,
};

/// The leftmost assignment-shaped match at or after `from`, as `exec` with `g`.
pub fn nextAssignedMatch(line: Str, name: Str, from: usize) ?AssignedMatch {
    var at: usize = 0;
    while (at < line.len) : (at += 1) {
        var index: usize = undefined;
        if (at == 0) {
            index = 0;
        } else {
            const previous = line[at - 1];
            if (isAsciiWord(previous) or previous == '$' or previous == '.') continue;
            index = at - 1;
        }
        if (index < from) continue;
        const end = assignedAt(line, at, name) orelse continue;
        return .{ .index = index, .end = end };
    }
    return null;
}

/// `(?:const\s+|let\s+|var\s+)?NAME\b(?:\s*:\s*[^=\n]+)?\s*=\s*(?:async\s+)?`
/// anchored at `name_at`, with the optional parts tried greedy-first.
fn assignedAt(line: Str, name_at: usize, name: Str) ?usize {
    const modifiers = .{ "const", "let", "var" };
    inline for (modifiers) |modifier_text| {
        const modifier = comptime lit(modifier_text);
        if (modifierNameAfter(line, &modifier, name_at, name)) |after| {
            if (assignedWithAnnotation(line, after)) |end| return end;
        }
    }
    if (!nameLengthAt(line, name_at, name)) return null;
    if (!isWordBoundary(line, name_at + name.len)) return null;
    if (assignedWithAnnotation(line, name_at + name.len)) |end| return end;
    return assignedTail(line, name_at + name.len);
}

/// `MODIFIER\s+NAME` at `at`: the offset just past the name, or null.
fn modifierNameAfter(line: Str, modifier: Str, at: usize, name: Str) ?usize {
    if (!std.mem.startsWith(u16, line[at..], modifier)) return null;
    var after = at + modifier.len;
    const spaces_from = after;
    while (after < line.len and isWhitespace(line[after])) after += 1;
    if (after == spaces_from) return null;
    if (!nameLengthAt(line, after, name)) return null;
    if (!isWordBoundary(line, after + name.len)) return null;
    return after + name.len;
}

/// The type annotation is optional: try it, then try without it.
fn assignedWithAnnotation(line: Str, from: usize) ?usize {
    var at = from;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    if (at >= line.len or line[at] != ':') return null;
    at += 1;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    const run_from = at;
    while (at < line.len and line[at] != '=' and line[at] != '\n') at += 1;
    if (at == run_from) return null;
    return assignedTail(line, at) orelse assignedTail(line, from);
}

/// `\s*=\s*(?:async\s+)?`, greedy; null when there is no `=`.
fn assignedTail(line: Str, from: usize) ?usize {
    var at = from;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    if (at >= line.len or line[at] != '=') return null;
    at += 1;
    while (at < line.len and isWhitespace(line[at])) at += 1;
    const async_word = comptime lit("async");
    if (std.mem.startsWith(u16, line[at..], &async_word)) {
        var after = at + async_word.len;
        const spaces_from = after;
        while (after < line.len and isWhitespace(line[after])) after += 1;
        if (after > spaces_from) return after;
    }
    return at;
}

/// `before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ')`.
pub fn withFuncReceiver(alloc: Allocator, before: Str) ![]u16 {
    const trimmed = trim(before);
    const func = comptime lit("func");
    if (!std.mem.startsWith(u16, trimmed, &func)) return alloc.dupe(u16, trimmed);
    var at: usize = func.len;
    while (at < trimmed.len and isWhitespace(trimmed[at])) at += 1;
    if (at >= trimmed.len or trimmed[at] != '(') return alloc.dupe(u16, trimmed);
    const close = indexOfUnit(trimmed[at..], ')') orelse return alloc.dupe(u16, trimmed);
    var end = at + close + 1;
    while (end < trimmed.len and isWhitespace(trimmed[end])) end += 1;
    var buf = Buf.init();
    try buf.appendAscii(alloc, "func ");
    try buf.appendUnits(alloc, trimmed[end..]);
    return buf.toOwned(alloc);
}

// ---------------------------------------------------------------------------
// .gitignore globs
// ---------------------------------------------------------------------------

/// `globToRegex`, matched directly: `**` crosses a separator, `*` and `?` do
/// not, `[...]` / `[!...]` are character classes and `\c` is a literal `c`.
/// The generated pattern is anchored at both ends, so this is a full match.
///
/// This is the one place where the port is deliberately not byte-identical: a
/// glob whose generated pattern is not a legal regular expression (`[?-!*]`,
/// whose `?-!` is a reversed range, or `[a\]x`, whose class never closes) makes
/// JavaScript's `new RegExp` throw out of `parseIgnoreFile` and kill the tool
/// with a stack trace, while this matches it as written and carries on. A
/// `.gitignore` rule like that is broken either way.
pub fn globMatch(pattern: Str, subject: Str) bool {
    return globMatchFrom(pattern, 0, subject, 0);
}

fn globMatchFrom(pattern: Str, from: usize, subject: Str, subject_from: usize) bool {
    var pi = from;
    var si = subject_from;
    while (pi < pattern.len) {
        const unit = pattern[pi];
        if (unit == '*') {
            if (pi + 1 < pattern.len and pattern[pi + 1] == '*') {
                var k = si;
                while (true) {
                    if (globMatchFrom(pattern, pi + 2, subject, k)) return true;
                    if (k >= subject.len) return false;
                    k += 1;
                }
            }
            var k = si;
            while (true) {
                if (globMatchFrom(pattern, pi + 1, subject, k)) return true;
                if (k >= subject.len or subject[k] == '/') return false;
                k += 1;
            }
        }
        if (unit == '?') {
            if (si >= subject.len or subject[si] == '/') return false;
            pi += 1;
            si += 1;
            continue;
        }
        if (unit == '[') {
            var j = pi + 1;
            var inverted = false;
            if (j < pattern.len and (pattern[j] == '!' or pattern[j] == '^')) {
                inverted = true;
                j += 1;
            }
            if (j < pattern.len and pattern[j] == ']') j += 1;
            const offset = indexOfUnit(pattern[j..], ']');
            if (offset == null) {
                if (si >= subject.len or subject[si] != '[') return false;
                pi += 1;
                si += 1;
                continue;
            }
            const close = j + offset.?;
            if (si >= subject.len) return false;
            if (classMatches(pattern[j..close], subject[si]) == inverted) return false;
            pi = close + 1;
            si += 1;
            continue;
        }
        if (unit == '\\') {
            const literal: u16 = if (pi + 1 < pattern.len) pattern[pi + 1] else '\\';
            if (si >= subject.len or subject[si] != literal) return false;
            pi += 2;
            si += 1;
            continue;
        }
        if (si >= subject.len or subject[si] != unit) return false;
        pi += 1;
        si += 1;
    }
    return si == subject.len;
}

/// The body of a `[...]` class: characters, `a-z` ranges and `\c` literals.
fn classMatches(interior: Str, unit: u16) bool {
    var i: usize = 0;
    while (i < interior.len) {
        var low = interior[i];
        if (low == '\\' and i + 1 < interior.len) {
            i += 1;
            low = interior[i];
        }
        i += 1;
        if (i + 1 < interior.len and interior[i] == '-') {
            const high = interior[i + 1];
            i += 2;
            if (unit >= low and unit <= high) return true;
        } else if (unit == low) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/// `extractRegion`: the lines strictly between `#region <name>` and the next
/// `#endregion`, or the exact error message.
pub fn extractRegion(alloc: Allocator, text: Str, name: Str, failure: *Failure) JsError![]u16 {
    const lf = try crlfToLf(alloc, text);
    const lines = try splitLines(alloc, lf);

    var starts = std.ArrayList(usize).empty;
    var ends = std.ArrayList(usize).empty;
    for (lines, 0..) |line, index| {
        const directive = regionDirective(line) orelse continue;
        switch (directive.kind) {
            .region => if (eql(directive.name, name)) try starts.append(alloc, index),
            .endregion => try ends.append(alloc, index),
        }
    }

    if (starts.items.len == 0) {
        return failure.set(try format(alloc, "no \"#region {s}\" found", .{name}));
    }
    if (starts.items.len > 1) {
        return failure.set(try format(
            alloc,
            "\"#region {s}\" appears {d} times; region names must be unique",
            .{ name, starts.items.len },
        ));
    }

    var end: ?usize = null;
    for (ends.items) |candidate| {
        if (candidate > starts.items[0]) {
            end = candidate;
            break;
        }
    }
    const close = end orelse return failure.set(try format(
        alloc,
        "\"#region {s}\" is never closed by an #endregion",
        .{name},
    ));

    for (lines[starts.items[0] + 1 .. close]) |line| {
        const directive = regionDirective(line) orelse continue;
        if (directive.kind == .region) {
            return failure.set(try format(
                alloc,
                "\"#region {s}\" is interleaved with \"#region {s}\"",
                .{ name, directive.name },
            ));
        }
    }

    return joinLines(alloc, lines[starts.items[0] + 1 .. close]);
}

/// `hasRegionDirective`: does the file carry an explicit `#region <name>`?
pub fn hasRegionDirective(alloc: Allocator, text: Str, name: Str) !bool {
    const lf = try crlfToLf(alloc, text);
    const lines = try splitLines(alloc, lf);
    for (lines) |line| {
        const directive = regionDirective(line) orelse continue;
        if (directive.kind == .region and eql(directive.name, name)) return true;
    }
    return false;
}

pub const Scope = enum { declaration, body, annotated, documented };

pub const Reference = struct {
    scope: Scope,
    name: Str,
};

/// `codeReference`: split `-`, `+` or `++` off the front of a reference. Only
/// the single-character modifiers name a scope of their own; `++` is the
/// documented form.
pub fn codeReference(reference: Str) Reference {
    if (std.mem.startsWith(u16, reference, &lit("++"))) {
        return .{ .scope = .documented, .name = reference[2..] };
    }
    if (reference.len > 0 and reference[0] == '-') {
        return .{ .scope = .body, .name = reference[1..] };
    }
    if (reference.len > 0 and reference[0] == '+') {
        return .{ .scope = .annotated, .name = reference[1..] };
    }
    return .{ .scope = .declaration, .name = reference };
}

// ---------------------------------------------------------------------------
// Reading code declarations
// ---------------------------------------------------------------------------

/// The offset of the line `offset` falls on, given each line's start.
fn lineOf(starts: []const usize, offset: usize) usize {
    var low: usize = 0;
    var high: usize = starts.len - 1;
    while (low < high) {
        const middle = (low + high + 1) / 2;
        if (starts[middle] <= offset) low = middle else high = middle - 1;
    }
    return low;
}

/// How far a line is indented.
fn indentWidth(line: Str) usize {
    return line.len - trimStart(line).len;
}

/// The balance of `()`, `[]` and `{}` on one line.
fn bracketBalance(line: Str) isize {
    var depth: isize = 0;
    for (line) |unit| {
        switch (unit) {
            '(', '[', '{' => depth += 1,
            ')', ']', '}' => depth -= 1,
            else => {},
        }
    }
    return depth;
}

/// The index of the first non-blank line at or after `from`, or null.
fn nextNonBlank(lines: []const Str, from: usize) ?usize {
    var index = from;
    while (index < lines.len) : (index += 1) {
        if (trim(lines[index]).len != 0) return index;
    }
    return null;
}

/// The offset at which the line holding `offset` ends.
fn endOfLine(text: Str, offset: usize) usize {
    const newline = indexOfUnit(text[offset..], '\n') orelse return text.len;
    return offset + newline;
}

/// The offset of the bracket that closes the one at `open`, or null.
fn matchingBracket(text: Str, open: usize, closer: u16) ?usize {
    var depth: isize = 0;
    var index = open;
    while (index < text.len) : (index += 1) {
        if (text[index] == text[open]) depth += 1 else if (text[index] == closer) {
            depth -= 1;
            if (depth == 0) return index;
        }
    }
    return null;
}

/// `text` with every comment and string literal blanked to spaces, newlines
/// kept, so offsets and line structure are untouched.
fn strippedCode(alloc: Allocator, text: Str) ![]u16 {
    const out = try alloc.dupe(u16, text);

    const blank = struct {
        fn run(target: []u16, from: usize, to: usize) void {
            var i = from;
            while (i < to and i < target.len) : (i += 1) {
                if (target[i] != '\n') target[i] = ' ';
            }
        }
    }.run;

    var i: usize = 0;
    while (i < text.len) {
        const unit = text[i];
        const next: u16 = if (i + 1 < text.len) text[i + 1] else 0;
        if (unit == '/' and next == '/') {
            const end = endOfLine(text, i);
            blank(out, i, end);
            i = end;
        } else if (unit == '/' and next == '*') {
            const close = indexOf(text[i + 2 ..], &lit("*/"));
            const end = if (close) |offset| i + 2 + offset + 2 else text.len;
            blank(out, i, end);
            i = end;
        } else if (unit == '#' and next != '[') {
            const end = endOfLine(text, i);
            blank(out, i, end);
            i = end;
        } else if (unit == '"' or unit == '\'' or unit == '`') {
            // A triple quote is a Python or Markdown style fence.
            const triple = i + 3 <= text.len and text[i + 1] == unit and text[i + 2] == unit;
            const quote_len: usize = if (triple) 3 else 1;
            var j = i + quote_len;
            while (j < text.len) {
                if (text[j] == '\\') {
                    j += 2;
                    continue;
                }
                if (j + quote_len <= text.len and matchesAt(text, j, unit, quote_len)) {
                    j += quote_len;
                    break;
                }
                j += 1;
            }
            const end = @min(j, text.len);
            blank(out, i, end);
            i = end;
        } else {
            i += 1;
        }
    }
    return out;
}

fn matchesAt(text: Str, at: usize, unit: u16, count: usize) bool {
    var index: usize = 0;
    while (index < count) : (index += 1) {
        if (at + index >= text.len or text[at + index] != unit) return false;
    }
    return true;
}

pub const DeclarationKind = enum { class, method };

pub const Declaration = struct {
    kind: DeclarationKind,
    header_from: usize,
};

/// Whether one stripped line declares something named `name`, and where the
/// declaration's header ends.
fn declarationOn(alloc: Allocator, source: Str, start: usize, length: usize, name: Str) !?Declaration {
    if (name.len == 0 or isNotAName(name)) return null;
    const line = source[start .. start + length];

    if (matchDeclarationKeyword(line)) |keyword| {
        if (eql(keyword.name, name)) {
            return .{ .kind = .class, .header_from = start + keyword.index + keyword.length };
        }
    }

    // `name(...)` - a method, function, constructor or object-literal method.
    var from: usize = 0;
    while (nextCallMatch(line, name, from)) |match| {
        const at = start + match.name_at;
        const before = source[start..at];
        // A Go receiver, `func (c *Cart) Add(...)`, belongs to the declaration
        // but not to the name.
        const prefix = try withFuncReceiver(alloc, before);
        if (prefix.len != 0 and (!isDeclarationPrefix(prefix) or isStatementBefore(prefix))) {
            from = match.paren + 1;
            continue;
        }
        const close = matchingBracket(source, start + match.paren, ')') orelse {
            from = match.paren + 1;
            continue;
        };
        return .{ .kind = .method, .header_from = close + 1 };
    }

    // `const name = (...) =>`, a class field `name = (...) =>`, `name = function ...`
    // - an assignment that defines a function.
    while (nextAssignedMatch(line, name, from)) |match| {
        const after = start + match.end;
        const rest = source[after .. start + length];
        const arrow = indexOf(rest, &lit("=>"));
        const keyword = functionKeywordEnd(rest);
        if (arrow != null and (keyword == null or arrow.? < keyword.?)) {
            return .{ .kind = .method, .header_from = after + arrow.? };
        }
        if (keyword) |end| return .{ .kind = .method, .header_from = after + end };
    }
    return null;
}

/// The range a declaration found on `declLine` occupies.
pub const Range = struct {
    kind: DeclarationKind,
    decl_line: usize,
    end_line: usize,
    open: ?usize = null,
    close: ?usize = null,
    open_line: ?usize = null,
    expression: ?usize = null,
    indented: bool = false,
};

/// The range of a declaration whose body is the braces opened at `open`.
fn braced(source: Str, starts: []const usize, kind: DeclarationKind, decl_line: usize, open: usize) ?Range {
    const close = matchingBracket(source, open, '}') orelse return null;
    return .{
        .kind = kind,
        .decl_line = decl_line,
        .open_line = lineOf(starts, open),
        .open = open,
        .close = close,
        .end_line = lineOf(starts, close),
    };
}

fn declarationRange(
    lines: []const Str,
    source: Str,
    starts: []const usize,
    decl_line: usize,
    declaration: Declaration,
) ?Range {
    const from = declaration.header_from;
    const line_end = endOfLine(source, starts[decl_line]);
    const rest = source[from..@max(from, line_end)];

    // The earliest of `{`, `;` and `=>`, in the pattern's own order on a tie.
    const brace_at = indexOf(rest, &lit("{"));
    const semi_at = indexOf(rest, &lit(";"));
    const arrow_at = indexOf(rest, &lit("=>"));

    var kind: enum { brace, none, arrow } = undefined;
    var at: usize = std.math.maxInt(usize);
    if (arrow_at) |offset| {
        if (offset < at) {
            at = offset;
            kind = .arrow;
        }
    }
    if (semi_at) |offset| {
        if (offset < at) {
            at = offset;
            kind = .none;
        }
    }
    if (brace_at) |offset| {
        if (offset < at) {
            at = offset;
            kind = .brace;
        }
    }
    if (at == std.math.maxInt(usize)) {
        // Nothing on the declaration's own line: an Allman brace, or an
        // indented block on the next non-blank line (Python, Ruby, ...).
        const next = nextNonBlank(lines, decl_line + 1) orelse return null;
        if (startsWithBrace(lines[next])) {
            const brace = indexOfUnit(lines[next], '{').?;
            return braced(source, starts, declaration.kind, decl_line, starts[next] + brace);
        }
        const indent = indentWidth(lines[decl_line]);
        if (indentWidth(lines[next]) > indent) {
            var end = next;
            var index = next + 1;
            while (index < lines.len) : (index += 1) {
                if (trim(lines[index]).len == 0) continue; // a blank line inside
                if (indentWidth(lines[index]) <= indent) break;
                end = index;
            }
            return .{
                .kind = declaration.kind,
                .decl_line = decl_line,
                .end_line = end,
                .indented = true,
            };
        }
        return null;
    }

    switch (kind) {
        .none => return null, // a declaration with no body
        .arrow => {
            const body = indexOf(rest[at + 2 ..], &lit("{"));
            if (body == null) {
                // An expression-bodied arrow function: the body is the
                // expression.
                return .{
                    .kind = declaration.kind,
                    .decl_line = decl_line,
                    .end_line = decl_line,
                    .expression = from + at + 2,
                };
            }
            return braced(source, starts, declaration.kind, decl_line, from + at + 2 + body.?);
        },
        .brace => return braced(source, starts, declaration.kind, decl_line, from + at),
    }
}

/// The first line of the annotation block directly above `declLine`, or null.
fn annotationStart(lines: []const Str, decl_line: usize) ?usize {
    var found: ?usize = null;
    var index = decl_line;
    while (index > 0) {
        index -= 1;
        if (trim(lines[index]).len == 0) break;
        if (isAnnotationLine(lines[index])) {
            found = index;
            break;
        }
    }
    const first = found orelse return null;

    var start = first;
    while (start > 0) {
        const previous = start - 1;
        if (trim(lines[previous]).len == 0 or !isAnnotationLine(lines[previous])) break;
        start = previous;
    }

    // The block must be annotations all the way: a statement between the
    // declaration and the annotation means there is no annotation block.
    var depth: isize = 0;
    var i = start;
    while (i < decl_line) : (i += 1) {
        if (depth == 0 and !isAnnotationLine(lines[i])) return null;
        depth += bracketBalance(lines[i]);
    }
    return if (depth == 0) start else null;
}

/// The first line of the doc comment directly above `top`, or null.
fn docCommentStart(lines: []const Str, top: usize) ?usize {
    if (top == 0) return null;
    const previous = top - 1;
    if (trim(lines[previous]).len == 0) return null;

    if (isDocCommentRun(lines[previous])) {
        var start = previous;
        while (start > 0 and isDocCommentRun(lines[start - 1])) start -= 1;
        return start;
    }
    if (!endsWithBlockCommentEnd(lines[previous])) return null;
    var index = previous + 1;
    while (index > 0) {
        index -= 1;
        if (trim(lines[index]).len == 0) return null;
        if (isDocCommentOpen(lines[index])) return index;
    }
    return null;
}

/// The text one declaration contributes, under one scope.
fn renderDeclaration(
    alloc: Allocator,
    lines: []const Str,
    source: Str,
    range: Range,
    scope: Scope,
) ![]u16 {
    if (scope == .body) {
        if (range.indented) return joinLines(alloc, lines[range.decl_line + 1 .. range.end_line + 1]);
        if (range.expression) |expression| {
            return alloc.dupe(u16, trim(source[expression..endOfLine(source, expression)]));
        }
        if (range.open_line.? == range.end_line) {
            return alloc.dupe(u16, trim(source[range.open.? + 1 .. range.close.?]));
        }
        return joinLines(alloc, lines[range.open_line.? + 1 .. range.end_line]);
    }

    var start = range.decl_line;
    if (scope == .annotated or scope == .documented) {
        if (annotationStart(lines, range.decl_line)) |annotated| start = annotated;
        if (scope == .documented) {
            if (docCommentStart(lines, start)) |documented| start = documented;
        }
    }
    return joinLines(alloc, lines[start .. range.end_line + 1]);
}

/// `extractDeclaration`: the text a named declaration occupies, or null.
pub fn extractDeclaration(
    alloc: Allocator,
    text: Str,
    name: Str,
    scope: Scope,
    failure: *Failure,
) JsError!?[]u16 {
    const source = try crlfToLf(alloc, text);
    const lines = try splitLines(alloc, source);
    const starts = try alloc.alloc(usize, lines.len);
    var offset: usize = 0;
    for (lines, 0..) |line, index| {
        starts[index] = offset;
        offset += line.len + 1;
    }
    const stripped = try strippedCode(alloc, source);

    var found = std.ArrayList(Range).empty;
    for (lines, 0..) |line, index| {
        const declaration = (try declarationOn(alloc, stripped, starts[index], line.len, name)) orelse continue;
        if (declarationRange(lines, stripped, starts, index, declaration)) |range| {
            try found.append(alloc, range);
        }
    }
    if (found.items.len == 0) return null;

    var classes = std.ArrayList(Range).empty;
    for (found.items) |range| {
        if (range.kind == .class) try classes.append(alloc, range);
    }
    const chosen = if (classes.items.len > 0) classes.items else found.items;
    if (chosen.len > 1) {
        return failure.set(try format(
            alloc,
            "\"{s}\" is declared {d} times; names must be unique",
            .{ name, chosen.len },
        ));
    }
    return try renderDeclaration(alloc, lines, stripped, chosen[0], scope);
}

/// `extractCodeRegion`: a region directive first, then a named declaration.
pub fn extractCodeRegion(alloc: Allocator, text: Str, region: Str, failure: *Failure) JsError![]u16 {
    const reference = codeReference(region);
    if (reference.name.len == 0) {
        return failure.set(try format(alloc, "\"#region:{s}\" names nothing", .{region}));
    }

    if (try hasRegionDirective(alloc, text, region)) return extractRegion(alloc, text, region, failure);
    if (!eql(reference.name, region) and try hasRegionDirective(alloc, text, reference.name)) {
        return extractRegion(alloc, text, reference.name, failure);
    }

    if (try extractDeclaration(alloc, text, reference.name, reference.scope, failure)) |declaration| {
        return declaration;
    }
    return failure.set(try format(
        alloc,
        "no \"#region {s}\" found, and no method or inner class named \"{s}\"",
        .{ reference.name, reference.name },
    ));
}

// ---------------------------------------------------------------------------
// The JSON rule
// ---------------------------------------------------------------------------

fn makeJsonValue(alloc: Allocator, value: JsonValue) JsError!*const JsonValue {
    const pointer = try alloc.create(JsonValue);
    pointer.* = value;
    return pointer;
}

/// Whether `value` is a JSON object rather than an array or a scalar.
fn isJsonObject(value: *const JsonValue) bool {
    return value.* == .object;
}

/// One dotted path of `source`, wrapped in the containers that hold it.
fn selectKeys(
    alloc: Allocator,
    source: *const JsonValue,
    segments: []const Str,
    path: Str,
    failure: *Failure,
) JsError!*const JsonValue {
    if (segments.len == 0) return source;
    const segment = segments[0];
    const rest = segments[1..];

    switch (source.*) {
        .array => |items| {
            if (!isAllDigits(segment)) {
                return failure.set(try format(
                    alloc,
                    "\"{s}\": \"{s}\" is not an array index",
                    .{ path, segment },
                ));
            }
            const index = parseDigitRun(segment);
            if (index >= items.len) {
                return failure.set(try format(alloc, "\"{s}\": no element {s}", .{ path, segment }));
            }
            const inner = try selectKeys(alloc, items[index], rest, path, failure);
            const list = try alloc.alloc(*const JsonValue, 1);
            list[0] = inner;
            return makeJsonValue(alloc, .{ .array = list });
        },
        .object => |entries| {
            for (entries) |entry| {
                if (!eql(entry.key, segment)) continue;
                const inner = try selectKeys(alloc, entry.value, rest, path, failure);
                const list = try alloc.alloc(JsonEntry, 1);
                list[0] = .{ .key = segment, .value = inner };
                return makeJsonValue(alloc, .{ .object = list });
            }
            return failure.set(try format(alloc, "\"{s}\": no key \"{s}\"", .{ path, segment }));
        },
        else => return failure.set(try format(alloc, "\"{s}\": cannot read \"{s}\"", .{ path, segment })),
    }
}

/// Merge two selections: sibling keys together, selected elements in order.
fn mergeSelections(alloc: Allocator, left: *const JsonValue, right: *const JsonValue) JsError!*const JsonValue {
    if (left.* == .array and right.* == .array) {
        const items = try alloc.alloc(*const JsonValue, left.array.len + right.array.len);
        @memcpy(items[0..left.array.len], left.array);
        @memcpy(items[left.array.len..], right.array);
        return makeJsonValue(alloc, .{ .array = items });
    }
    if (isJsonObject(left) and isJsonObject(right)) {
        var merged = std.ArrayList(JsonEntry).empty;
        try merged.appendSlice(alloc, left.object);
        for (try orderedEntries(alloc, right.object)) |entry| {
            // `{...left}` copies own properties, but `merged[key] = value` goes
            // through the prototype: for `__proto__` that runs the inherited
            // setter, which either does nothing (a non-object value) or sets
            // the prototype, so no own key is ever created.
            if (eql(entry.key, &lit("__proto__"))) continue;
            var replaced = false;
            for (merged.items) |*existing| {
                if (!eql(existing.key, entry.key)) continue;
                existing.value = try mergeSelections(alloc, existing.value, entry.value);
                replaced = true;
                break;
            }
            if (!replaced) try merged.append(alloc, entry);
        }
        return makeJsonValue(alloc, .{ .object = try merged.toOwnedSlice(alloc) });
    }
    return right;
}

/// `extractJsonRegion`: a `#region:a,b.c` reference is a list of dotted paths.
pub fn extractJsonRegion(alloc: Allocator, text: Str, region: Str, failure: *Failure) JsError![]u16 {
    var paths = std.ArrayList(Str).empty;
    var from: usize = 0;
    while (true) {
        const comma = indexOfUnit(region[from..], ',');
        const piece = if (comma) |at| region[from .. from + at] else region[from..];
        const trimmed = trim(piece);
        if (trimmed.len != 0) try paths.append(alloc, trimmed);
        if (comma == null) break;
        from += comma.? + 1;
    }
    if (paths.items.len == 0) {
        return failure.set(try format(alloc, "\"#region:{s}\" names no keys", .{region}));
    }

    const root = parseJson(alloc, text, failure) catch |err| switch (err) {
        error.Failed => {
            const message = try format(alloc, "not valid JSON: {s}", .{failure.message});
            return failure.set(message);
        },
        else => return err,
    };
    if (!isJsonObject(root)) {
        return failure.set(try dupAscii(alloc, "the top-level JSON value is not an object"));
    }

    var selected = std.ArrayList(*const JsonValue).empty;
    for (paths.items) |path| {
        var segments = std.ArrayList(Str).empty;
        var segment_from: usize = 0;
        while (true) {
            const dot = indexOfUnit(path[segment_from..], '.');
            const segment = if (dot) |at| path[segment_from .. segment_from + at] else path[segment_from..];
            try segments.append(alloc, segment);
            if (dot == null) break;
            segment_from += dot.? + 1;
        }
        try selected.append(alloc, try selectKeys(alloc, root, segments.items, path, failure));
    }

    var merged = selected.items[0];
    for (selected.items[1..]) |value| {
        merged = try mergeSelections(alloc, merged, value);
    }
    return stringify(alloc, merged);
}

// ---------------------------------------------------------------------------
// The rule registry
// ---------------------------------------------------------------------------

/// A rule's `resolve`: the text a `#region:<reference>` stands for, or the
/// exact message of the `Error` JavaScript would throw.
pub const Resolve = *const fn (Allocator, Str, Str, *Failure) JsError![]u16;

pub const Rule = struct {
    name: []const u8,
    extensions: []const []const u8,
    resolve: Resolve,
};

/// The default rule, for source code and for every file type no other rule
/// claims: region directives and named declarations both resolve here.
pub const CODE_RULE = Rule{ .name = "code", .extensions = &.{}, .resolve = extractCodeRegion };

/// The rule for `.json`: a region is a dotted list of keys.
pub const JSON_RULE = Rule{ .name = "json", .extensions = &.{"json"}, .resolve = extractJsonRegion };

/// The built-in rules, most specific first; `code` is the fallback.
pub const REGION_RULES = [_]Rule{ JSON_RULE, CODE_RULE };

/// The rule that resolves a reference in `path`.
pub fn ruleFor(path: Str, rules: []const Rule) Rule {
    const dot = lastIndexOfUnit(path, '.');
    const extension = if (dot == null or dot.? == 0) path[path.len..] else path[dot.? + 1 ..];
    for (rules) |rule| {
        for (rule.extensions) |candidate| {
            if (eqlIgnoreCase(extension, candidate)) return rule;
        }
    }
    return CODE_RULE;
}

fn eqlIgnoreCase(a: Str, b_ascii: []const u8) bool {
    if (a.len != b_ascii.len) return false;
    for (a, b_ascii) |left, right| {
        if (asciiLower(left) != asciiLower(right)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Fence language
// ---------------------------------------------------------------------------

const Language = struct {
    extension: []const u8,
    language: Str,
};

/// GitHub's list of extensions to fence languages, where `typescript` is not
/// `ts` and `.mjs` is `javascript`.
const LANGUAGES = [_]Language{
    .{ .extension = "c", .language = &lit("c") },
    .{ .extension = "h", .language = &lit("c") },
    .{ .extension = "cpp", .language = &lit("cpp") },
    .{ .extension = "hpp", .language = &lit("cpp") },
    .{ .extension = "cs", .language = &lit("csharp") },
    .{ .extension = "css", .language = &lit("css") },
    .{ .extension = "go", .language = &lit("go") },
    .{ .extension = "htm", .language = &lit("html") },
    .{ .extension = "html", .language = &lit("html") },
    .{ .extension = "ini", .language = &lit("ini") },
    .{ .extension = "java", .language = &lit("java") },
    .{ .extension = "cjs", .language = &lit("javascript") },
    .{ .extension = "js", .language = &lit("javascript") },
    .{ .extension = "mjs", .language = &lit("javascript") },
    .{ .extension = "jsx", .language = &lit("jsx") },
    .{ .extension = "json", .language = &lit("json") },
    .{ .extension = "md", .language = &lit("markdown") },
    .{ .extension = "markdown", .language = &lit("markdown") },
    .{ .extension = "php", .language = &lit("php") },
    .{ .extension = "pl", .language = &lit("perl") },
    .{ .extension = "py", .language = &lit("python") },
    .{ .extension = "rb", .language = &lit("ruby") },
    .{ .extension = "rs", .language = &lit("rust") },
    .{ .extension = "bash", .language = &lit("bash") },
    .{ .extension = "sh", .language = &lit("bash") },
    .{ .extension = "sql", .language = &lit("sql") },
    .{ .extension = "toml", .language = &lit("toml") },
    .{ .extension = "ts", .language = &lit("typescript") },
    .{ .extension = "tsx", .language = &lit("tsx") },
    .{ .extension = "xml", .language = &lit("xml") },
    .{ .extension = "yaml", .language = &lit("yaml") },
    .{ .extension = "yml", .language = &lit("yaml") },
};

/// The two inherited members of the language table, as the strings they
/// stringify to. They live at file scope so the slices returned for them
/// outlive the call.
const INHERITED_CONSTRUCTOR = lit("function Object() { [native code] }");
const INHERITED_PROTOTYPE = lit("[object Object]");

/// The language a file's extension implies for a fence's info string, or null
/// when the extension is unknown - a bare fence then stays bare.
///
/// The table is a plain object in JavaScript, so two of its inherited members
/// are reachable as "extensions" and are reproduced here: `constructor` is
/// `Object`, whose string form is what lands in the fence, and `__proto__` is
/// `Object.prototype`. (`toString` and friends are not reachable: the
/// extension is lower-cased first, and their names are camel-cased.)
pub fn fileLanguage(path: Str) ?Str {
    const dot = lastIndexOfUnit(path, '.');
    if (dot == null or dot.? == 0) return null;
    const extension = path[dot.? + 1 ..];
    if (eqlIgnoreCase(extension, "constructor")) return &INHERITED_CONSTRUCTOR;
    if (eqlIgnoreCase(extension, "__proto__")) return &INHERITED_PROTOTYPE;
    for (LANGUAGES) |entry| {
        if (eqlIgnoreCase(extension, entry.extension)) return entry.language;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Injecting into a document
// ---------------------------------------------------------------------------

pub const Injected = struct {
    lines: []const Str,
    changed: bool,
};

/// `injectInto`: replace the body of the fenced block that follows `marker`.
///
/// The fence must come immediately after the marker; blank lines in between are
/// allowed, anything else is an error. When `language` is given and the opening
/// fence has no info string, the fence is given one.
pub fn injectInto(
    alloc: Allocator,
    lines: []const Str,
    marker: Str,
    content: Str,
    start_index: ?usize,
    language: ?Str,
    failure: *Failure,
) JsError!Injected {
    var marker_index: usize = 0;
    if (start_index) |index| {
        if (index >= lines.len or !eql(trim(lines[index]), marker)) {
            return failure.set(try format(alloc, "marker not found: {s}", .{marker}));
        }
        marker_index = index;
    } else {
        var found: ?usize = null;
        for (lines, 0..) |line, index| {
            if (eql(trim(line), marker)) {
                found = index;
                break;
            }
        }
        marker_index = found orelse return failure.set(try format(alloc, "marker not found: {s}", .{marker}));
    }

    var open: ?usize = null;
    var open_ticks: usize = 0;
    var open_info: Str = &.{};
    var index = marker_index + 1;
    while (index < lines.len) : (index += 1) {
        if (matchFenceOpen(lines[index])) |fence| {
            open = index;
            open_ticks = fence.ticks;
            open_info = fence.info;
            break;
        }
        if (trim(lines[index]).len != 0) {
            return failure.set(try format(
                alloc,
                "expected a fenced code block right after {s}",
                .{marker},
            ));
        }
    }
    const open_at = open orelse {
        failure.include = true;
        return failure.set(try format(alloc, "no code block after {s}", .{marker}));
    };

    var close: ?usize = null;
    index = open_at + 1;
    while (index < lines.len) : (index += 1) {
        if (matchFenceClose(lines[index])) |ticks| {
            if (ticks >= open_ticks) {
                close = index;
                break;
            }
        }
    }
    const close_at = close orelse {
        failure.include = true;
        return failure.set(try format(alloc, "unclosed code block after {s}", .{marker}));
    };

    // A fence without a language cannot highlight: give it the file's, keeping
    // the document's own indentation and line endings intact.
    var current_lines = lines;
    var fence_changed = false;
    if (language) |text| {
        const info = trim(stripTrailingCr(open_info));
        if (info.len == 0) {
            const open_line = lines[open_at];
            const ticks_at = indexOfUnit(open_line, '`').?;
            const indent = open_line[0..ticks_at];
            var buf = Buf.init();
            try buf.appendUnits(alloc, indent);
            var tick: usize = 0;
            while (tick < open_ticks) : (tick += 1) try buf.appendUnit(alloc, '`');
            try buf.appendUnits(alloc, text);
            if (open_line.len > 0 and open_line[open_line.len - 1] == '\r') try buf.appendUnit(alloc, '\r');
            const replacement = try buf.toOwned(alloc);

            const copy = try alloc.dupe(Str, lines);
            copy[open_at] = replacement;
            current_lines = copy;
            fence_changed = true;
        }
    }

    var current = std.ArrayList([]const u16).empty;
    for (current_lines[open_at + 1 .. close_at]) |line| {
        try current.append(alloc, stripTrailingCr(line));
    }
    const current_text = try joinLines(alloc, current.items);

    var next = std.ArrayList(Str).empty;
    try next.appendSlice(alloc, current_lines[0 .. open_at + 1]);
    const content_lines = try splitLines(alloc, content);
    try next.appendSlice(alloc, content_lines);
    try next.appendSlice(alloc, current_lines[close_at..]);

    return .{
        .lines = try next.toOwnedSlice(alloc),
        .changed = !eql(current_text, content) or fence_changed,
    };
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

pub const IgnoreRule = struct {
    negated: bool,
    anchored: bool,
    glob: Str,
};

pub const RuleFile = struct {
    dir: []const u8,
    rules: []const IgnoreRule,
};

/// `parseIgnoreFile`: one .gitignore file into rules, in line order.
pub fn parseIgnoreFile(alloc: Allocator, text: Str) ![]IgnoreRule {
    var rules = std.ArrayList(IgnoreRule).empty;
    const lf = try crlfToLf(alloc, text);
    const lines = try splitLines(alloc, lf);
    for (lines) |raw| {
        var line = trim(raw);
        if (line.len == 0 or line[0] == '#') continue;

        var negated = false;
        if (line[0] == '!') {
            negated = true;
            line = line[1..];
        }
        if (line.len == 0) continue;

        var anchored = false;
        if (line[0] == '/') {
            anchored = true;
            line = line[1..];
        }
        if (line.len > 0 and line[line.len - 1] == '/') line = line[0 .. line.len - 1];
        if (line.len == 0) continue;
        if (indexOfUnit(line, '/') != null) anchored = true;

        try rules.append(alloc, .{ .negated = negated, .anchored = anchored, .glob = line });
    }
    return rules.toOwnedSlice(alloc);
}

/// `loadIgnoreRules`: the rules from `root` upward, shallowest first, so that
/// the .gitignore closest to the file wins.
pub fn loadIgnoreRules(
    alloc: Allocator,
    root: []const u8,
    read: Reader,
) JsError![]RuleFile {
    const base = std.fs.path.resolve(alloc, &.{root}) catch try alloc.dupe(u8, root);
    var files = std.ArrayList(RuleFile).empty;
    var dir: []const u8 = base;
    while (true) {
        const joined = std.fs.path.join(alloc, &.{ dir, ".gitignore" }) catch dir;
        var relative_path: []const u8 = relativePath(alloc, base, joined) catch try alloc.dupe(u8, ".gitignore");
        if (relative_path.len == 0) relative_path = ".gitignore";

        var local = Failure{};
        if (read.read(alloc, relative_path, &local)) |bytes| {
            const units = try utf8Decode(alloc, bytes);
            const rules = try parseIgnoreFile(alloc, units);
            if (rules.len > 0) try files.append(alloc, .{ .dir = dir, .rules = rules });
        } else |err| switch (err) {
            error.Failed => {}, // a missing .gitignore is not an error
            else => return err,
        }

        const parent = std.fs.path.dirname(dir) orelse break;
        if (std.mem.eql(u8, parent, dir)) break;
        dir = parent;
    }
    std.mem.reverse(RuleFile, files.items);
    return files.toOwnedSlice(alloc);
}

/// `isIgnoredPath`: whether `relativePath` (resolved against `root`) is ignored.
/// Rules run shallowest file first; the last matching rule decides, and a `!`
/// rule un-ignores.
pub fn isIgnoredPath(
    alloc: Allocator,
    root: []const u8,
    relative_path: []const u8,
    rule_files: []const RuleFile,
) !bool {
    if (rule_files.len == 0) return false;
    const absolute = std.fs.path.resolve(alloc, &.{ root, relative_path }) catch
        try alloc.dupe(u8, relative_path);
    var ignored = false;
    for (rule_files) |rule_file| {
        const relative = relativePath(alloc, rule_file.dir, absolute) catch continue;
        if (relative.len == 0 or std.mem.startsWith(u8, relative, "..")) continue;
        const units = try utf8Decode(alloc, relative);
        const parts = try splitPathParts(alloc, units);
        for (rule_file.rules) |rule| {
            if (rule.anchored) {
                var acc = Buf.init();
                for (parts, 0..) |part, index| {
                    if (index > 0) try acc.appendUnit(alloc, '/');
                    try acc.appendUnits(alloc, part);
                    if (globMatch(rule.glob, acc.list.items)) ignored = !rule.negated;
                }
            } else {
                for (parts) |part| {
                    if (globMatch(rule.glob, part)) {
                        ignored = !rule.negated;
                        break;
                    }
                }
            }
        }
    }
    return ignored;
}

/// `rel.split(/[/\\]/)`.
fn splitPathParts(alloc: Allocator, text: Str) ![]Str {
    var parts = std.ArrayList(Str).empty;
    var start: usize = 0;
    var index: usize = 0;
    while (index < text.len) : (index += 1) {
        if (text[index] == '/' or text[index] == '\\') {
            try parts.append(alloc, text[start..index]);
            start = index + 1;
        }
    }
    try parts.append(alloc, text[start..]);
    return parts.toOwnedSlice(alloc);
}

/// How the document's markers may be skipped: `false`, one explicit file, a
/// ready-made rule list, or the default walk up from the root.
pub const Gitignore = union(enum) {
    off,
    walk_up,
    file: []const u8,
    rules: []const RuleFile,
};

/// A `readFile(relativePath)` that resolves against a root and returns the
/// file's bytes, which the library then decodes as WHATWG UTF-8.
pub const Reader = struct {
    context: ?*anyopaque = null,
    read_fn: *const fn (?*anyopaque, Allocator, []const u8, *Failure) JsError![]u8,

    pub fn read(self: Reader, alloc: Allocator, path: []const u8, failure: *Failure) JsError![]u8 {
        return self.read_fn(self.context, alloc, path, failure);
    }
};

pub const Options = struct {
    /// `options.root ?? process.cwd()`, and it must be an absolute path: the
    /// JavaScript `resolve` anchors a relative one to its working directory,
    /// and this module has no working directory of its own. The CLI resolves
    /// the root before calling in, which is what `fileReader(root)` does in
    /// JavaScript too.
    root: []const u8,
    /// `options.readFile ?? fileReader(root)` - the CLI's reader resolves
    /// relative paths against `root` and reads through `std.Io`.
    read_file: Reader,
    gitignore: Gitignore = .walk_up,
    region_rules: []const Rule = &REGION_RULES,
    lenient: bool = false,
};

/// `node:path`'s `relative(from, to)`.
///
/// Every path that reaches this is already absolute - roots are resolved by the
/// CLI - so the working directory the Zig signature also wants, and the
/// per-drive environment it takes for drive-relative paths, cannot matter here.
fn relativePath(alloc: Allocator, from: []const u8, to: []const u8) ![]u8 {
    return std.fs.path.relative(alloc, "", null, from, to);
}

/// `resolveMarker`: the text a marker stands for - a whole file, or one region.
pub fn resolveMarker(
    alloc: Allocator,
    marker: Marker,
    read: Reader,
    rule: Rule,
    failure: *Failure,
) JsError![]u16 {
    const bytes = try read.read(alloc, try utf8Encode(alloc, marker.path), failure);
    const text = try utf8Decode(alloc, bytes);
    if (marker.region) |region| return rule.resolve(alloc, text, region, failure);
    return normalize(alloc, text);
}

/// What `updateDocument` reports for one marker.
pub const Entry = struct {
    marker: Marker,
    content: ?[]u16,
    changed: bool,
    skipped: bool,
    /// The cause when `lenient` turned a broken include into a skip.
    failure: ?Str = null,
};

pub const DocumentResult = struct {
    text: []u16,
    changed: bool,
    markers: []Marker,
    results: []Entry,
};

const Ignore = struct {
    root: []const u8,
    files: []const RuleFile,
};

/// `makeIgnorer`: the rule list the markers are checked against, or null when
/// ignoring is off.
fn makeIgnorer(
    alloc: Allocator,
    options: Options,
    read: Reader,
    failure: *Failure,
) JsError!?Ignore {
    switch (options.gitignore) {
        .off => return null,
        .rules => |files| return .{ .root = options.root, .files = files },
        .file => |file| {
            const relative_path = if (std.fs.path.isAbsolute(file))
                relativePath(alloc, options.root, file) catch try alloc.dupe(u8, file)
            else
                file;
            var local = Failure{};
            const bytes = read.read(alloc, relative_path, &local) catch |err| switch (err) {
                error.Failed => return failure.set(try format(
                    alloc,
                    "cannot read gitignore file {s}: {s}",
                    .{ try utf8Decode(alloc, file), local.message },
                )),
                else => return err,
            };
            const units = try utf8Decode(alloc, bytes);
            const rules = try parseIgnoreFile(alloc, units);
            const files = try alloc.alloc(RuleFile, 1);
            files[0] = .{
                .dir = if (std.fs.path.isAbsolute(file)) std.fs.path.dirname(file) orelse options.root else options.root,
                .rules = rules,
            };
            return .{ .root = options.root, .files = files };
        },
        .walk_up => {
            const files = try loadIgnoreRules(alloc, options.root, read);
            return .{ .root = options.root, .files = files };
        },
    }
}

/// `updateDocument`: rewrite every injected block in `text`. Nothing is written
/// to disk; the caller decides what to do with the result.
pub fn updateDocument(
    alloc: Allocator,
    text: Str,
    options: Options,
    failure: *Failure,
) JsError!DocumentResult {
    const read = options.read_file;
    const ignore = try makeIgnorer(alloc, options, read, failure);

    var lines: []const Str = try splitLines(alloc, text);
    const markers = try findMarkers(alloc, lines);
    var seen = std.ArrayList(Str).empty;
    var results = std.ArrayList(Entry).empty;

    // Backwards, so each marker's original line index stays valid after the
    // blocks behind it have been rewritten.
    var index = markers.len;
    while (index > 0) {
        index -= 1;
        const marker = markers[index];
        for (seen.items) |raw| {
            if (eql(raw, marker.raw)) {
                return failure.set(try format(alloc, "duplicate marker: {s}", .{marker.raw}));
            }
        }
        try seen.append(alloc, marker.raw);

        if (ignore) |ignorer| {
            if (try isIgnoredPath(alloc, ignorer.root, try utf8Encode(alloc, marker.path), ignorer.files)) {
                try results.append(alloc, .{
                    .marker = marker,
                    .content = null,
                    .changed = false,
                    .skipped = true,
                });
                continue;
            }
        }

        var include_failure = Failure{};
        const content = resolveMarker(
            alloc,
            marker,
            read,
            ruleFor(marker.path, options.region_rules),
            &include_failure,
        ) catch |err| switch (err) {
            error.Failed => {
                if (!options.lenient) {
                    return failure.set(try format(alloc, "{s}: {s}", .{ marker.raw, include_failure.message }));
                }
                try results.append(alloc, .{
                    .marker = marker,
                    .content = null,
                    .changed = false,
                    .skipped = true,
                    .failure = include_failure.message,
                });
                continue;
            },
            else => return err,
        };

        var inject_failure = Failure{};
        const injected = injectInto(
            alloc,
            lines,
            marker.raw,
            content,
            marker.index,
            fileLanguage(marker.path),
            &inject_failure,
        ) catch |err| switch (err) {
            error.Failed => {
                // A broken include is tolerated by `lenient`; errors the
                // document itself carries stay strict in every mode.
                if (!options.lenient or !inject_failure.include) {
                    failure.* = inject_failure;
                    return error.Failed;
                }
                try results.append(alloc, .{
                    .marker = marker,
                    .content = null,
                    .changed = false,
                    .skipped = true,
                    .failure = inject_failure.message,
                });
                continue;
            },
            else => return err,
        };

        lines = injected.lines;
        try results.append(alloc, .{
            .marker = marker,
            .content = content,
            .changed = injected.changed,
            .skipped = false,
        });
    }

    std.mem.reverse(Entry, results.items);
    const updated = try joinLines(alloc, lines);
    return .{
        .text = updated,
        .changed = !eql(updated, text),
        .markers = markers,
        .results = results.items,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// These mirror `test.mjs`, which is the specification: every expectation here
// was read out of the JavaScript suite, so a drift shows up as a failing test.
// Like that suite, they run entirely in memory through a stub reader.

/// `reader(files)` from `test.mjs`: a `readFile` over a table of paths.
const Stub = struct {
    files: []const struct { path: []const u8, content: []const u8 },

    fn read(context: ?*anyopaque, alloc: Allocator, path: []const u8, failure: *Failure) JsError![]u8 {
        const self: *const Stub = @ptrCast(@alignCast(context.?));
        for (self.files) |file| {
            if (std.mem.eql(u8, file.path, path)) return alloc.dupe(u8, file.content);
        }
        const message = try std.fmt.allocPrint(alloc, "ENOENT: no such file or directory, open '{s}'", .{path});
        return failure.set(try utf8Decode(alloc, message));
    }

    fn reader(self: *const Stub) Reader {
        return .{ .context = @ptrCast(@constCast(self)), .read_fn = read };
    }
};

const TestContext = struct {
    arena: std.heap.ArenaAllocator = undefined,
    alloc: Allocator = undefined,

    /// Initialize in place: an `Allocator` holds a pointer to the arena it came
    /// from, so returning this struct by value would leave it dangling.
    fn init(self: *TestContext) void {
        self.arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        self.alloc = self.arena.allocator();
    }

    fn deinit(self: *TestContext) void {
        self.arena.deinit();
    }

    fn units(self: *TestContext, text: []const u8) !Str {
        return utf8Decode(self.alloc, text);
    }
};

/// Compare a result to an ASCII expectation.
fn expectText(expected: []const u8, actual: Str) !void {
    var buffer: [8192]u8 = undefined;
    if (actual.len > buffer.len) return error.ResultTooLong;
    for (actual, 0..) |unit, index| {
        if (unit > 0x7f) return error.ExpectedAscii;
        buffer[index] = @intCast(unit);
    }
    try std.testing.expectEqualStrings(expected, buffer[0..actual.len]);
}

fn expectName(expected: []const u8, actual: ?Str) !void {
    const units = actual orelse return error.ExpectedAMatch;
    try expectText(expected, units);
}

fn expectFailure(expected: []const u8, failure: Failure) !void {
    try expectText(expected, failure.message);
}

test "regionDirective accepts the common comment spellings" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const cases = [_]struct { line: []const u8, kind: DirectiveKind, name: []const u8 }{
        .{ .line = "#region table", .kind = .region, .name = "table" },
        .{ .line = "#endregion", .kind = .endregion, .name = "" },
        .{ .line = "// #region table", .kind = .region, .name = "table" },
        .{ .line = "//region table", .kind = .region, .name = "table" },
        .{ .line = "// #endregion", .kind = .endregion, .name = "" },
        .{ .line = "<!-- #region table -->", .kind = .region, .name = "table" },
        .{ .line = "/* #region table */", .kind = .region, .name = "table" },
        .{ .line = "-- #region table", .kind = .region, .name = "table" },
        .{ .line = "; #region table", .kind = .region, .name = "table" },
        .{ .line = "REM #region table", .kind = .region, .name = "table" },
        .{ .line = "    #region  spaced   name  ", .kind = .region, .name = "spaced   name" },
        .{ .line = "#region", .kind = .region, .name = "" },
    };
    for (cases) |case| {
        const directive = regionDirective(try context.units(case.line)) orelse {
            std.debug.print("no directive for {s}\n", .{case.line});
            return error.ExpectedAMatch;
        };
        try std.testing.expectEqual(case.kind, directive.kind);
        try expectText(case.name, directive.name);
    }

    // Prose and unknown words are not directives.
    const prose = [_][]const u8{
        "region table",
        "endregion",
        "The #region directive is nice.",
        "",
        "# regional planning",
    };
    for (prose) |line| {
        try std.testing.expect(regionDirective(try context.units(line)) == null);
    }
    _ = alloc;
}

test "extractRegion returns the lines between the directives, exclusive" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();

    const text = try context.units("before\n#region table\na\nb\n#endregion\nafter");
    var failure = Failure{};
    try expectText("a\nb", try extractRegion(context.alloc, text, try context.units("table"), &failure));
}

test "extractRegion handles CRLF and empty regions" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();

    var failure = Failure{};
    const crlf = try context.units("#region t\r\na\r\n#endregion");
    try expectText("a", try extractRegion(context.alloc, crlf, try context.units("t"), &failure));

    const empty = try context.units("#region t\n#endregion");
    try expectText("", try extractRegion(context.alloc, empty, try context.units("t"), &failure));
}

test "extractRegion fails loudly on missing, ambiguous and unclosed regions" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    var failure = Failure{};
    const other = try context.units("#region other\nx\n#endregion");
    try std.testing.expectError(error.Failed, extractRegion(alloc, other, try context.units("table"), &failure));
    try expectFailure("no \"#region table\" found", failure);

    const twice = try context.units("#region t\n#endregion\n#region t\n#endregion");
    failure = Failure{};
    try std.testing.expectError(error.Failed, extractRegion(alloc, twice, try context.units("t"), &failure));
    try expectFailure("\"#region t\" appears 2 times; region names must be unique", failure);

    const unclosed = try context.units("#region t\nx");
    failure = Failure{};
    try std.testing.expectError(error.Failed, extractRegion(alloc, unclosed, try context.units("t"), &failure));
    try expectFailure("\"#region t\" is never closed by an #endregion", failure);

    const interleaved = try context.units("#region a\n#region b\nx\n#endregion\n#endregion");
    failure = Failure{};
    try std.testing.expectError(error.Failed, extractRegion(alloc, interleaved, try context.units("a"), &failure));
    try expectFailure("\"#region a\" is interleaved with \"#region b\"", failure);
}

const JAVA = "package example;\n" ++
    "\n" ++
    "/** A cart of items. */\n" ++
    "public class Cart {\n" ++
    "    /** Add one item to this cart. */\n" ++
    "    @Override\n" ++
    "    public String toString() {\n" ++
    "        return String.join(\",\", items);\n" ++
    "    }\n" ++
    "\n" ++
    "    /** One line of a cart. */\n" ++
    "    public static class Line {\n" ++
    "        Line(String name) {\n" ++
    "            this.name = name;\n" ++
    "        }\n" ++
    "    }\n" ++
    "}";

const JSON_DOC = "{\n" ++
    "  \"name\": \"acme\",\n" ++
    "  \"version\": \"1.0.0\",\n" ++
    "  \"scripts\": {\n" ++
    "    \"build\": \"make\",\n" ++
    "    \"test\": \"make test\"\n" ++
    "  },\n" ++
    "  \"keywords\": [\"docs\", \"examples\", \"sync\"]\n" ++
    "}";

test "codeReference reads the scope modifiers" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const cases = [_]struct { reference: []const u8, scope: Scope, name: []const u8 }{
        .{ .reference = "add", .scope = .declaration, .name = "add" },
        .{ .reference = "-add", .scope = .body, .name = "add" },
        .{ .reference = "+add", .scope = .annotated, .name = "add" },
        .{ .reference = "++add", .scope = .documented, .name = "add" },
        .{ .reference = "++", .scope = .documented, .name = "" },
        .{ .reference = "-", .scope = .body, .name = "" },
        .{ .reference = "+", .scope = .annotated, .name = "" },
    };
    for (cases) |case| {
        const reference = codeReference(try context.units(case.reference));
        try std.testing.expectEqual(case.scope, reference.scope);
        try expectText(case.name, reference.name);
    }
    _ = alloc;
}

test "extractDeclaration matches a method and a class-like declaration" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const java = try context.units(JAVA);
    try expectText(
        "    public String toString() {\n        return String.join(\",\", items);\n    }",
        (try extractDeclaration(alloc, java, try context.units("toString"), .declaration, &failure)).?,
    );
    try expectText(
        "    public static class Line {\n        Line(String name) {\n            this.name = name;\n        }\n    }",
        (try extractDeclaration(alloc, java, try context.units("Line"), .declaration, &failure)).?,
    );
    try std.testing.expect((try extractDeclaration(alloc, java, try context.units("missing"), .declaration, &failure)) == null);
    try std.testing.expect((try extractDeclaration(alloc, java, try context.units(""), .declaration, &failure)) == null);
}

test "extractDeclaration prefers a class over its same-named constructor" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const java = try context.units("public class Cart {\n    Cart() {\n        init();\n    }\n}");
    try expectText(
        "public class Cart {\n    Cart() {\n        init();\n    }\n}",
        (try extractDeclaration(alloc, java, try context.units("Cart"), .declaration, &failure)).?,
    );
}

test "extractDeclaration scopes: -, + and ++" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    const java = try context.units(JAVA);
    var failure = Failure{};

    try expectText(
        "        return String.join(\",\", items);",
        (try extractDeclaration(alloc, java, try context.units("toString"), .body, &failure)).?,
    );
    try expectText(
        "    @Override\n    public String toString() {\n        return String.join(\",\", items);\n    }",
        (try extractDeclaration(alloc, java, try context.units("toString"), .annotated, &failure)).?,
    );
    try expectText(
        "    /** Add one item to this cart. */\n    @Override\n    public String toString() {\n        return String.join(\",\", items);\n    }",
        (try extractDeclaration(alloc, java, try context.units("toString"), .documented, &failure)).?,
    );
    // `++` without a doc comment above is `+`; `+` without an annotation is the
    // declaration.
    try expectText(
        "    /** One line of a cart. */\n    public static class Line {\n        Line(String name) {\n            this.name = name;\n        }\n    }",
        (try extractDeclaration(alloc, java, try context.units("Line"), .documented, &failure)).?,
    );
    try expectText(
        "    public static class Line {\n        Line(String name) {\n            this.name = name;\n        }\n    }",
        (try extractDeclaration(alloc, java, try context.units("Line"), .annotated, &failure)).?,
    );
}

test "extractDeclaration follows indented and Allman bodies" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const python = try context.units(
        "class Cart:\n    def add(self, item):\n        self.items.append(item)\n        return self\n\ndef helper():\n    pass",
    );
    try expectText(
        "    def add(self, item):\n        self.items.append(item)\n        return self",
        (try extractDeclaration(alloc, python, try context.units("add"), .declaration, &failure)).?,
    );
    try expectText(
        "        self.items.append(item)\n        return self",
        (try extractDeclaration(alloc, python, try context.units("add"), .body, &failure)).?,
    );

    const allman = try context.units("public class A\n{\n    void run()\n    {\n        go();\n    }\n}");
    try expectText(
        "    void run()\n    {\n        go();\n    }",
        (try extractDeclaration(alloc, allman, try context.units("run"), .declaration, &failure)).?,
    );
    try expectText(
        "    void run()\n    {\n        go();\n    }",
        (try extractDeclaration(alloc, allman, try context.units("A"), .body, &failure)).?,
    );
}

test "extractDeclaration is not fooled by braces in strings or comments" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const tricky = try context.units(
        "class T {\n    void go() {\n        String s = \"}\";\n        /* } */ // }\n    }\n}",
    );
    try expectText(
        "    void go() {\n        String s = \"}\";\n        /* } */ // }\n    }",
        (try extractDeclaration(alloc, tricky, try context.units("go"), .declaration, &failure)).?,
    );
}

test "extractDeclaration reads assigned and arrow functions" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const pick = try context.units("const pick = (a) => {\n    return a;\n};");
    try expectText(
        "const pick = (a) => {\n    return a;\n};",
        (try extractDeclaration(alloc, pick, try context.units("pick"), .declaration, &failure)).?,
    );

    const inc = try context.units("const inc = (n) => n + 1;");
    try expectText("n + 1;", (try extractDeclaration(alloc, inc, try context.units("inc"), .body, &failure)).?);

    const handler = try context.units("  handler = async (event) => {\n    go(event);\n  };");
    try expectText(
        "  handler = async (event) => {\n    go(event);\n  };",
        (try extractDeclaration(alloc, handler, try context.units("handler"), .declaration, &failure)).?,
    );

    const run = try context.units("const run = function () { go(); };");
    try expectText(
        "const run = function () { go(); };",
        (try extractDeclaration(alloc, run, try context.units("run"), .declaration, &failure)).?,
    );

    const typed = try context.units("const type: Fn = (a) => a;");
    try expectText("a;", (try extractDeclaration(alloc, typed, try context.units("type"), .body, &failure)).?);
}

test "extractDeclaration rejects ambiguous names and ignores calls" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const overloaded = try context.units("class A {\n    void run() {}\n    void run(int x) {}\n}");
    try std.testing.expectError(
        error.Failed,
        extractDeclaration(alloc, overloaded, try context.units("run"), .declaration, &failure),
    );
    try expectFailure("\"run\" is declared 2 times; names must be unique", failure);

    const calls = try context.units("add(x);\nrun();");
    try std.testing.expect((try extractDeclaration(alloc, calls, try context.units("add"), .declaration, &failure)) == null);

    const bodiless = try context.units("interface Opts {\n    void add(int x);\n}");
    try std.testing.expect((try extractDeclaration(alloc, bodiless, try context.units("add"), .declaration, &failure)) == null);
}

test "extractCodeRegion prefers an explicit region directive" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const text = try context.units("// #region add\nthe region body\n// #endregion\n\nvoid add() { body(); }");
    try expectText("the region body", try extractCodeRegion(alloc, text, try context.units("add"), &failure));
    try expectText("the region body", try extractCodeRegion(alloc, text, try context.units("-add"), &failure));
}

test "extractCodeRegion reads declarations and fails loudly on nothing" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    const java = try context.units(JAVA);
    var failure = Failure{};

    try expectText(
        "    @Override\n    public String toString() {\n        return String.join(\",\", items);\n    }",
        try extractCodeRegion(alloc, java, try context.units("+toString"), &failure),
    );

    failure = Failure{};
    try std.testing.expectError(error.Failed, extractCodeRegion(alloc, java, try context.units("missing"), &failure));
    try expectFailure(
        "no \"#region missing\" found, and no method or inner class named \"missing\"",
        failure,
    );

    failure = Failure{};
    try std.testing.expectError(error.Failed, extractCodeRegion(alloc, java, try context.units("+"), &failure));
    try expectFailure("\"#region:+\" names nothing", failure);
}

test "extractJsonRegion selects top-level keys and forms valid JSON" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const selected = try extractJsonRegion(alloc, try context.units(JSON_DOC), try context.units("name,version"), &failure);
    try expectText("{\n  \"name\": \"acme\",\n  \"version\": \"1.0.0\"\n}", selected);
}

test "extractJsonRegion follows dotted paths and array elements" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    const doc = try context.units(JSON_DOC);
    var failure = Failure{};

    try expectText(
        "{\n  \"scripts\": {\n    \"test\": \"make test\"\n  },\n  \"name\": \"acme\"\n}",
        try extractJsonRegion(alloc, doc, try context.units("scripts.test,name"), &failure),
    );
    try expectText(
        "{\n  \"keywords\": [\n    \"docs\",\n    \"sync\"\n  ]\n}",
        try extractJsonRegion(alloc, doc, try context.units("keywords.0,keywords.2"), &failure),
    );
}

test "extractJsonRegion fails loudly on missing keys and bad documents" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    const doc = try context.units(JSON_DOC);

    const cases = [_]struct { region: []const u8, message: []const u8 }{
        .{ .region = "scripts.nope", .message = "\"scripts.nope\": no key \"nope\"" },
        .{ .region = "keywords.x", .message = "\"keywords.x\": \"x\" is not an array index" },
        .{ .region = "keywords.9", .message = "\"keywords.9\": no element 9" },
        .{ .region = ",", .message = "\"#region:,\" names no keys" },
        .{ .region = "name.deeper", .message = "\"name.deeper\": cannot read \"deeper\"" },
    };
    for (cases) |case| {
        var failure = Failure{};
        try std.testing.expectError(
            error.Failed,
            extractJsonRegion(alloc, doc, try context.units(case.region), &failure),
        );
        try expectFailure(case.message, failure);
    }

    var failure = Failure{};
    try std.testing.expectError(
        error.Failed,
        extractJsonRegion(alloc, try context.units("not json"), try context.units("a"), &failure),
    );
    try expectText("not valid JSON: Unexpected token 'o', \"not json\" is not valid JSON", failure.message);

    failure = Failure{};
    try std.testing.expectError(
        error.Failed,
        extractJsonRegion(alloc, try context.units("[1, 2]"), try context.units("a"), &failure),
    );
    try expectFailure("the top-level JSON value is not an object", failure);

    failure = Failure{};
    try std.testing.expectError(
        error.Failed,
        extractJsonRegion(alloc, try context.units("null"), try context.units("a"), &failure),
    );
    try expectFailure("the top-level JSON value is not an object", failure);
}

test "ruleFor sends .json to the JSON rule and everything else to code" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();

    try std.testing.expectEqualStrings("json", ruleFor(try context.units("package.json"), &REGION_RULES).name);
    try std.testing.expectEqualStrings("json", ruleFor(try context.units("./a/b.JSON"), &REGION_RULES).name);
    try std.testing.expectEqualStrings("code", ruleFor(try context.units("index.mjs"), &REGION_RULES).name);
    try std.testing.expectEqualStrings("code", ruleFor(try context.units("README.md"), &REGION_RULES).name);
    try std.testing.expectEqualStrings("code", ruleFor(try context.units(".gitignore"), &REGION_RULES).name);
    try std.testing.expectEqualStrings("code", ruleFor(try context.units("noext"), &REGION_RULES).name);
    try std.testing.expectEqualStrings("code", ruleFor(try context.units("a.json"), &.{}).name);
    try std.testing.expectEqualStrings("json", REGION_RULES[0].name);
    try std.testing.expectEqualStrings("code", REGION_RULES[1].name);
}

test "resolveMarker resolves a region by the file type" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const stub = Stub{ .files = &.{
        .{ .path = "data.json", .content = JSON_DOC },
        .{ .path = "code.ts", .content = "const add = (a) => a;\n" },
    } };
    const read = stub.reader();
    var failure = Failure{};

    const json_marker = parseMarker(try context.units("[data.json](./data.json#region:name)")).?;
    try expectText(
        "{\n  \"name\": \"acme\"\n}",
        try resolveMarker(alloc, json_marker, read, ruleFor(json_marker.path, &REGION_RULES), &failure),
    );

    const code_marker = parseMarker(try context.units("[code.ts](./code.ts#region:add)")).?;
    try expectText(
        "const add = (a) => a;",
        try resolveMarker(alloc, code_marker, read, ruleFor(code_marker.path, &REGION_RULES), &failure),
    );

    const whole = parseMarker(try context.units("[data.json](./data.json)")).?;
    try expectText(
        JSON_DOC,
        try resolveMarker(alloc, whole, read, ruleFor(whole.path, &REGION_RULES), &failure),
    );
}

test "parseMarker reads whole-file and region markers" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();

    const whole = parseMarker(try context.units("[fixtures/a.md](./fixtures/a.md)")).?;
    try expectText("[fixtures/a.md](./fixtures/a.md)", whole.raw);
    try expectText("fixtures/a.md", whole.path);
    try std.testing.expect(whole.region == null);

    try expectText("fixtures/a.md", parseMarker(try context.units("[fixtures/a.md](fixtures/a.md)")).?.path);
    try expectText("[a.md](./a.md)", parseMarker(try context.units("  [a.md](./a.md)  ")).?.raw);

    const region = parseMarker(try context.units("[src/app.ts](./src/app.ts#region:table)")).?;
    try expectText("src/app.ts", region.path);
    try expectName("table", region.region);
}

test "parseMarker leaves ordinary links alone" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();

    const rejected = [_][]const u8{
        "[the docs](./docs/README.md)",
        "[a.md](./a.md#install)",
        "[https://x.dev](https://x.dev)",
        "[a.md](./a.md) and more",
        "plain text",
        "",
        "[a.md](a.md#region:)",
    };
    for (rejected) |line| {
        try std.testing.expect(parseMarker(try context.units(line)) == null);
    }
}

test "findMarkers keeps document order and skips fences" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const lines = try splitLines(alloc, try context.units(
        "# doc\n```markdown\n[a.md](./a.md)\n```\n[b.md](./b.md)\n```\nold\n```",
    ));
    const markers = try findMarkers(alloc, lines);
    try std.testing.expectEqual(@as(usize, 1), markers.len);
    try expectText("b.md", markers[0].path);
    try std.testing.expectEqual(@as(usize, 4), markers[0].index);
}

test "fenceRanges finds balanced, nested and unclosed fences" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const cases = [_]struct { text: []const u8, ranges: []const [2]usize }{
        .{ .text = "text\n```\nx\n```\nend", .ranges = &.{.{ 1, 3 }} },
        .{ .text = "````\n```\nx\n```\n````", .ranges = &.{.{ 0, 4 }} },
        .{ .text = "```\nx\ny", .ranges = &.{.{ 0, 2 }} },
        .{ .text = "intro\n   ```js\n   x\n   ```\nout", .ranges = &.{.{ 1, 3 }} },
        .{ .text = "no fences here", .ranges = &.{} },
    };
    for (cases) |case| {
        const lines = try splitLines(alloc, try context.units(case.text));
        const ranges = try fenceRanges(alloc, lines);
        try std.testing.expectEqual(case.ranges.len, ranges.len);
        for (case.ranges, ranges) |expected, actual| {
            try std.testing.expectEqual(expected[0], actual[0]);
            try std.testing.expectEqual(expected[1], actual[1]);
        }
    }
}

test "fileLanguage maps extensions to fence languages" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();

    const cases = [_]struct { path: []const u8, language: ?[]const u8 }{
        .{ .path = "src/app.ts", .language = "typescript" },
        .{ .path = "src/app.tsx", .language = "tsx" },
        .{ .path = "app.js", .language = "javascript" },
        .{ .path = "app.mjs", .language = "javascript" },
        .{ .path = "app.cjs", .language = "javascript" },
        .{ .path = "config.json", .language = "json" },
        .{ .path = "doc.md", .language = "markdown" },
        .{ .path = "doc.markdown", .language = "markdown" },
        .{ .path = "script.py", .language = "python" },
        .{ .path = "run.sh", .language = "bash" },
        .{ .path = "style.css", .language = "css" },
        .{ .path = "page.html", .language = "html" },
        .{ .path = "data.yml", .language = "yaml" },
        .{ .path = "APP.TS", .language = "typescript" },
        .{ .path = "noext", .language = null },
        .{ .path = ".gitignore", .language = null },
        .{ .path = "notes.txt", .language = null },
        // Inherited `Object.prototype` members are reachable as extensions.
        .{ .path = "a.constructor", .language = "function Object() { [native code] }" },
        .{ .path = "a.__proto__", .language = "[object Object]" },
        .{ .path = "a.toString", .language = null },
    };
    for (cases) |case| {
        const language = fileLanguage(try context.units(case.path));
        if (case.language) |expected| {
            try expectName(expected, language);
        } else {
            try std.testing.expect(language == null);
        }
    }
}

test "normalize strips CRLF and one trailing newline" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    try expectText("a\nb", try normalize(alloc, try context.units("a\r\nb\r\n")));
    try expectText("a\n", try normalize(alloc, try context.units("a\n\n")));
    try expectText("", try normalize(alloc, try context.units("\r\n")));
}

const DOC = "# Title\n" ++
    "\n" ++
    "[fixtures/one.md](./fixtures/one.md)\n" ++
    "\n" ++
    "```markdown\n" ++
    "stale content\n" ++
    "```\n" ++
    "\n" ++
    "Some prose.\n" ++
    "\n" ++
    "[fixtures/big.md](./fixtures/big.md#region:table)\n" ++
    "\n" ++
    "```markdown\n" ++
    "stale region\n" ++
    "```\n" ++
    "";

const FILES = Stub{ .files = &.{
    .{ .path = "fixtures/one.md", .content = "first line\nsecond line\n" },
    .{ .path = "fixtures/big.md", .content = "noise\n#region table\n| a | b |\n#endregion\nnoise\n" },
} };

test "updateDocument rewrites every marker and is idempotent" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const options = Options{ .root = "C:\\root", .read_file = FILES.reader(), .gitignore = .off };
    const first = try updateDocument(alloc, try context.units(DOC), options, &failure);
    try std.testing.expectEqual(@as(usize, 2), first.markers.len);
    try std.testing.expect(first.changed);
    try std.testing.expect(first.results[0].changed);
    try std.testing.expect(first.results[1].changed);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("first line\nsecond line")) != null);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("| a | b |")) != null);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("stale")) == null);
    try std.testing.expect(std.mem.startsWith(u16, first.text, &lit("# Title\n")));
    try std.testing.expect(std.mem.endsWith(u16, first.text, &lit("```\n")));

    const second = try updateDocument(alloc, first.text, options, &failure);
    try std.testing.expect(!second.changed);
    try std.testing.expect(!second.results[0].changed);
    try std.testing.expect(!second.results[1].changed);
    try std.testing.expect(eql(second.text, first.text));
}

test "updateDocument reports an empty document rather than throwing" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const empty = Stub{ .files = &.{} };
    const options = Options{ .root = "C:\\root", .read_file = empty.reader(), .gitignore = .off };
    const result = try updateDocument(alloc, try context.units("# No markers here\n"), options, &failure);
    try std.testing.expectEqual(@as(usize, 0), result.markers.len);
    try std.testing.expect(!result.changed);
}

test "updateDocument surfaces a bad marker path with its marker" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const empty = Stub{ .files = &.{} };
    const options = Options{ .root = "C:\\root", .read_file = empty.reader(), .gitignore = .off };
    const doc = try context.units("[missing.md](./missing.md)\n```\nx\n```");
    try std.testing.expectError(error.Failed, updateDocument(alloc, doc, options, &failure));
    try expectText(
        "[missing.md](./missing.md): ENOENT: no such file or directory, open 'missing.md'",
        failure.message,
    );
}

test "updateDocument rejects a duplicated marker" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{.{ .path = "a.md", .content = "z" }} };
    const options = Options{ .root = "C:\\root", .read_file = stub.reader(), .gitignore = .off };
    const doc = try context.units("[a.md](./a.md)\n```\nx\n```\n[a.md](./a.md)\n```\ny\n```");
    try std.testing.expectError(error.Failed, updateDocument(alloc, doc, options, &failure));
    try expectFailure("duplicate marker: [a.md](./a.md)", failure);
}

test "updateDocument gives a bare fence the language of the marker file" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{
        .{ .path = "fixtures/one.ts", .content = "code\n" },
        .{ .path = "fixtures/notes.txt", .content = "notes\n" },
    } };
    const options = Options{ .root = "C:\\root", .read_file = stub.reader(), .gitignore = .off };

    const doc = try context.units("[fixtures/one.ts](./fixtures/one.ts)\n```\nstale\n```");
    const first = try updateDocument(alloc, doc, options, &failure);
    try std.testing.expect(first.changed);
    try expectText("[fixtures/one.ts](./fixtures/one.ts)\n```typescript\ncode\n```", first.text);

    const second = try updateDocument(alloc, first.text, options, &failure);
    try std.testing.expect(!second.changed);

    const unknown = try context.units("[fixtures/notes.txt](./fixtures/notes.txt)\n```\nstale\n```");
    const bare = try updateDocument(alloc, unknown, options, &failure);
    try std.testing.expect(bare.changed);
    try expectText("[fixtures/notes.txt](./fixtures/notes.txt)\n```\nnotes\n```", bare.text);
}

test "injectInto closes only on a fence at least as long as the opener" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const inner = try splitLines(alloc, try context.units("[a.md](./a.md)\n````\n```\ninner\n```\n````"));
    const by_index = try injectInto(alloc, inner, try context.units("[a.md](./a.md)"), try context.units("x"), 0, null, &failure);
    try expectText("[a.md](./a.md)\n````\nx\n````", try joinLines(alloc, by_index.lines));

    const equal = try splitLines(alloc, try context.units("[a.md](./a.md)\n````\n```\n````"));
    const by_text = try injectInto(alloc, equal, try context.units("[a.md](./a.md)"), try context.units("y"), null, null, &failure);
    try expectText("[a.md](./a.md)\n````\ny\n````", try joinLines(alloc, by_text.lines));
}

test "injectInto keeps the fence, the indentation and the line endings" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const tagged = try splitLines(alloc, try context.units("[a.ts](./a.ts)\n```cpp\nsame\n```"));
    const kept = try injectInto(alloc, tagged, try context.units("[a.ts](./a.ts)"), try context.units("same"), 0, try context.units("typescript"), &failure);
    try std.testing.expect(!kept.changed);
    try expectText("[a.ts](./a.ts)\n```cpp\nsame\n```", try joinLines(alloc, kept.lines));

    const bare = try splitLines(alloc, try context.units("[a.ts](./a.ts)\n```\nold\n```"));
    const no_language = try injectInto(alloc, bare, try context.units("[a.ts](./a.ts)"), try context.units("new"), 0, null, &failure);
    try expectText("[a.ts](./a.ts)\n```\nnew\n```", try joinLines(alloc, no_language.lines));

    const crlf = try splitLines(alloc, try context.units("[a.ts](./a.ts)\n  ```\r\nold\n  ```\r"));
    const kept_crlf = try injectInto(alloc, crlf, try context.units("[a.ts](./a.ts)"), try context.units("new"), 0, try context.units("typescript"), &failure);
    try expectText("[a.ts](./a.ts)\n  ```typescript\r\nnew\n  ```\r", try joinLines(alloc, kept_crlf.lines));
}

test "injectInto reports a missing marker, stray text and unclosed fences" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const cases = [_]struct { text: []const u8, message: []const u8, include: bool }{
        .{ .text = "[a.md](./a.md)\nprose\n```\nx\n```", .message = "expected a fenced code block right after [a.md](./a.md)", .include = false },
        .{ .text = "[a.md](./a.md)\n\n", .message = "no code block after [a.md](./a.md)", .include = true },
        .{ .text = "[a.md](./a.md)\n```\nx", .message = "unclosed code block after [a.md](./a.md)", .include = true },
        .{ .text = "[b.md](./b.md)\n```\nx\n```", .message = "marker not found: [a.md](./a.md)", .include = false },
    };
    for (cases) |case| {
        const lines = try splitLines(alloc, try context.units(case.text));
        var failure = Failure{};
        const start: ?usize = if (case.include or !std.mem.startsWith(u8, case.message, "expected")) 0 else null;
        try std.testing.expectError(
            error.Failed,
            injectInto(alloc, lines, try context.units("[a.md](./a.md)"), try context.units("x"), start, null, &failure),
        );
        try expectFailure(case.message, failure);
        try std.testing.expectEqual(case.include, failure.include);
    }
}

test "updateDocument handles CRLF documents without reformatting them" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{.{ .path = "a.md", .content = "real\r\n" }} };
    const options = Options{ .root = "C:\\root", .read_file = stub.reader(), .gitignore = .off };
    const doc = try context.units("[a.md](./a.md)\r\n\r\n```markdown\r\nstale\r\n```");

    const first = try updateDocument(alloc, doc, options, &failure);
    try std.testing.expect(first.changed);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("\r\n")) != null);

    const second = try updateDocument(alloc, first.text, options, &failure);
    try std.testing.expect(!second.changed);
}

test "updateDocument stays stable when file content contains marker-like lines" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{
        .{ .path = "a.md", .content = "[probe.md](./probe.md)\nreal content\n" },
        .{ .path = "probe.md", .content = "probe\n" },
    } };
    const options = Options{ .root = "C:\\root", .read_file = stub.reader(), .gitignore = .off };
    const doc = try context.units("[a.md](./a.md)\n```\nstale\n```");

    const first = try updateDocument(alloc, doc, options, &failure);
    try std.testing.expect(first.changed);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("real content")) != null);

    const second = try updateDocument(alloc, first.text, options, &failure);
    try std.testing.expect(!second.changed);
    try std.testing.expect(eql(second.text, first.text));
}

test "updateDocument takes a custom rule set" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{.{ .path = "notes.txt", .content = "one\n-- eight --\ntwo\n" }} };
    const options = Options{ .root = "C:\\root", .read_file = stub.reader(), .gitignore = .off };

    const doc = try context.units("[notes.txt](./notes.txt#region:eight)\n```\nstale\n```");
    // `regionRules` replaces the built-in set.
    const custom = Rule{ .name = "dashes", .extensions = &.{"txt"}, .resolve = dashRule };
    const result = try updateDocument(alloc, doc, .{
        .root = options.root,
        .read_file = options.read_file,
        .gitignore = .off,
        .region_rules = &.{custom},
    }, &failure);
    try expectText("[notes.txt](./notes.txt#region:eight)\n```\ntwo\n```", result.text);
}

fn dashRule(alloc: Allocator, text: Str, region: Str, failure: *Failure) JsError![]u16 {
    const lines = try splitLines(alloc, text);
    for (lines, 0..) |line, index| {
        var buf = Buf.init();
        try buf.appendAscii(alloc, "-- ");
        try buf.appendUnits(alloc, region);
        try buf.appendAscii(alloc, " --");
        if (eql(line, buf.list.items)) {
            if (index + 1 < lines.len) return alloc.dupe(u16, lines[index + 1]);
            break;
        }
    }
    return failure.set(try format(alloc, "no \"-- {s} --\"", .{region}));
}

test "parseIgnoreFile parses comments, negation, anchors and globs" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const rules = try parseIgnoreFile(alloc, try context.units(" # comment\n\n!lib\n/dist/\n*.min.js\n**/cache\n"));
    try std.testing.expectEqual(@as(usize, 4), rules.len);
    const expected = [_]struct { negated: bool, anchored: bool, glob: []const u8 }{
        .{ .negated = true, .anchored = false, .glob = "lib" },
        .{ .negated = false, .anchored = true, .glob = "dist" },
        .{ .negated = false, .anchored = false, .glob = "*.min.js" },
        .{ .negated = false, .anchored = true, .glob = "**/cache" },
    };
    for (expected, rules) |want, rule| {
        try std.testing.expectEqual(want.negated, rule.negated);
        try std.testing.expectEqual(want.anchored, rule.anchored);
        try expectText(want.glob, rule.glob);
    }
}

test "isIgnoredPath applies gitignore semantics" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;

    const rules = try parseIgnoreFile(alloc, try context.units("node_modules\n/build/\n*.map\n!keep.map\n"));
    const files = [_]RuleFile{.{ .dir = "C:\\root", .rules = rules }};

    try std.testing.expect(try isIgnoredPath(alloc, "C:\\root", "node_modules/react/index.js", &files));
    try std.testing.expect(try isIgnoredPath(alloc, "C:\\root", "packages/node_modules/x.js", &files));
    try std.testing.expect(!try isIgnoredPath(alloc, "C:\\root", "src/index.js", &files));
    try std.testing.expect(try isIgnoredPath(alloc, "C:\\root", "build/out.js", &files));
    try std.testing.expect(!try isIgnoredPath(alloc, "C:\\root", "src/build/out.js", &files));
    try std.testing.expect(try isIgnoredPath(alloc, "C:\\root", "out.map", &files));
    try std.testing.expect(!try isIgnoredPath(alloc, "C:\\root", "keep.map", &files));

    // The closest .gitignore wins.
    const outer = RuleFile{ .dir = "C:\\root", .rules = try parseIgnoreFile(alloc, try context.units("!build\n")) };
    const inner = RuleFile{ .dir = "C:\\root\\sub", .rules = try parseIgnoreFile(alloc, try context.units("build\n")) };
    const both = [_]RuleFile{ outer, inner };
    try std.testing.expect(try isIgnoredPath(alloc, "C:\\root", "sub/build/x.js", &both));
    try std.testing.expect(!try isIgnoredPath(alloc, "C:\\root", "build/x.js", &both));
}

test "updateDocument skips gitignored markers and leaves their block" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{
        .{ .path = "a.md", .content = "kept\n" },
        .{ .path = "node_modules/dep.js", .content = "ignored\n" },
    } };
    const rules = try parseIgnoreFile(alloc, try context.units("node_modules\n"));
    const ignore_files = [_]RuleFile{.{ .dir = "C:\\root", .rules = rules }};
    const options = Options{
        .root = "C:\\root",
        .read_file = stub.reader(),
        .gitignore = .{ .rules = &ignore_files },
    };

    const doc = try context.units(
        "[a.md](./a.md)\n```\nstale\n```\n[node_modules/dep.js](./node_modules/dep.js)\n```\nuntouched\n```",
    );
    const first = try updateDocument(alloc, doc, options, &failure);
    try std.testing.expect(first.changed);
    try std.testing.expect(!first.results[0].skipped);
    try std.testing.expect(first.results[0].changed);
    try std.testing.expect(first.results[1].skipped);
    try std.testing.expect(!first.results[1].changed);
    try std.testing.expect(first.results[1].content == null);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("untouched")) != null);
    try std.testing.expect(std.mem.indexOf(u16, first.text, &lit("kept")) != null);

    const second = try updateDocument(alloc, first.text, options, &failure);
    try std.testing.expect(!second.changed);
}

test "updateDocument honours gitignore off and an explicit ignore file" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const doc = try context.units("[node_modules/dep.js](./node_modules/dep.js)\n```\nold\n```");

    const off_stub = Stub{ .files = &.{.{ .path = "node_modules/dep.js", .content = "live\n" }} };
    const off = try updateDocument(alloc, doc, .{
        .root = "C:\\root",
        .read_file = off_stub.reader(),
        .gitignore = .off,
    }, &failure);
    try std.testing.expect(!off.results[0].skipped);
    try std.testing.expect(std.mem.indexOf(u16, off.text, &lit("live")) != null);

    const on_stub = Stub{ .files = &.{
        .{ .path = "node_modules/dep.js", .content = "live\n" },
        .{ .path = "ci.txt", .content = "node_modules\n" },
    } };
    const on = try updateDocument(alloc, doc, .{
        .root = "C:\\root",
        .read_file = on_stub.reader(),
        .gitignore = .{ .file = "ci.txt" },
    }, &failure);
    try std.testing.expect(on.results[0].skipped);
    try std.testing.expect(std.mem.indexOf(u16, on.text, &lit("old")) != null);

    // The default walk-up finds no .gitignore files through this stub.
    const walk_stub = Stub{ .files = &.{.{ .path = "node_modules/dep.js", .content = "live\n" }} };
    const walk = try updateDocument(alloc, doc, .{
        .root = "C:\\root",
        .read_file = walk_stub.reader(),
        .gitignore = .walk_up,
    }, &failure);
    try std.testing.expect(!walk.results[0].skipped);
}

test "lenient mode reports a failure-skip separately from a gitignored skip" {
    var context: TestContext = undefined;
    context.init();
    defer context.deinit();
    const alloc = context.alloc;
    var failure = Failure{};

    const stub = Stub{ .files = &.{.{ .path = "node_modules/dep.js", .content = "ignored\n" }} };
    const rules = try parseIgnoreFile(alloc, try context.units("node_modules\n"));
    const ignore_files = [_]RuleFile{.{ .dir = "C:\\root", .rules = rules }};

    const doc = try context.units(
        "[missing.md](./missing.md)\n```\ndead\n```\n[node_modules/dep.js](./node_modules/dep.js)\n```\nignored\n```",
    );
    const result = try updateDocument(alloc, doc, .{
        .root = "C:\\root",
        .read_file = stub.reader(),
        .gitignore = .{ .rules = &ignore_files },
        .lenient = true,
    }, &failure);

    try std.testing.expect(result.results[0].skipped);
    try std.testing.expect(result.results[0].failure != null);
    try std.testing.expect(result.results[1].skipped);
    try std.testing.expect(result.results[1].failure == null);
    try std.testing.expect(!result.changed);
    try std.testing.expect(std.mem.indexOf(u16, result.text, &lit("dead")) != null);
}
