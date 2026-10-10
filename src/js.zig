//! The JavaScript runtime facts the port depends on, shared by every module.
//!
//! A JavaScript string is a sequence of UTF-16 code units, and `.length`,
//! indexing, `slice` and every regular expression count in code units — so the
//! whole port works in code units (`Str`) and only transcodes at the edges.
//! The other facts here are the ones a "clean" implementation would smooth
//! over: `String.prototype.trim`'s exact whitespace set (which is *not* what
//! `/\s/` matches in every engine), `JSON.parse`'s narrower one, and Node's
//! UTF-8 decoder/encoder, including the U+FFFD substitutions.
//!
//! **The JavaScript implementation is the source of truth.** See
//! `README.md` § "The Zig port".

const std = @import("std");
const Allocator = std.mem.Allocator;

/// A JavaScript string, as UTF-16 code units.
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

/// A compile-time ASCII literal as UTF-16 code units. Take its address
/// (`&lit("//")`) where a `Str` is wanted.
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

// --- comparing a code-unit `Str` against an ASCII byte string ----------------
//
// `lit` only takes a comptime-known literal; these helpers cover the runtime
// case — a word from a table of `[]const u8` — without materialising a slice.

/// `Str` equals the ASCII byte string `text`.
pub fn eqlBytes(units: Str, text: []const u8) bool {
    if (units.len != text.len) return false;
    for (units, text) |unit, byte| {
        if (unit != byte) return false;
    }
    return true;
}

/// `Str` starts with the ASCII byte string `text`.
pub fn startsWithBytes(units: Str, text: []const u8) bool {
    if (units.len < text.len) return false;
    for (text, 0..) |byte, index| {
        if (units[index] != byte) return false;
    }
    return true;
}

/// `Str` ends with the ASCII byte string `text`.
pub fn endsWithBytes(units: Str, text: []const u8) bool {
    if (units.len < text.len) return false;
    return startsWithBytes(units[units.len - text.len ..], text);
}

/// The first offset of the ASCII byte string `text` inside `units`.
pub fn indexOfBytes(units: Str, text: []const u8) ?usize {
    if (text.len == 0) return 0;
    if (units.len < text.len) return null;
    var at: usize = 0;
    while (at + text.len <= units.len) : (at += 1) {
        if (startsWithBytes(units[at..], text)) return at;
    }
    return null;
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

/// `[A-Za-z0-9_]`, the `\w` the patterns here use.
pub fn isAsciiWord(unit: u16) bool {
    return (unit >= 'a' and unit <= 'z') or (unit >= 'A' and unit <= 'Z') or
        (unit >= '0' and unit <= '9') or unit == '_';
}

/// `[A-Za-z_$]`, the identifier start the name patterns use.
pub fn isIdentStart(unit: u16) bool {
    return (unit >= 'a' and unit <= 'z') or (unit >= 'A' and unit <= 'Z') or
        unit == '_' or unit == '$';
}

/// `[A-Za-z0-9_$]`, the identifier continuation the name patterns use.
pub fn isIdentPart(unit: u16) bool {
    return isAsciiWord(unit) or unit == '$';
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

/// `text.slice(from, to)` for offsets that may run past the end, `str.slice`'s
/// clamping included; `from` is floored at 0 and `to` at `from`.
pub fn clampSlice(text: Str, from: usize, to: usize) Str {
    const start = @min(from, text.len);
    const end = @max(start, @min(to, text.len));
    return text[start..end];
}

// ---------------------------------------------------------------------------
// UTF-8, exactly as Node decodes and encodes it
// ---------------------------------------------------------------------------

/// `readFileSync(path, 'utf8')` / `Buffer.from(text, 'utf8')`: the WHATWG
/// decoder, where every maximal invalid subsequence becomes one U+FFFD.
///
/// The first continuation byte's range is narrowed for the leads that would
/// otherwise encode an overlong form (0xE0, 0xF0) or a surrogate (0xED) or a
/// value past U+10FFFF (0xF4), and a bad byte ends the subsequence where it
/// stands: the bytes accepted so far are consumed along with the lead, so the
/// decoder resynchronises on the byte that broke it.
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
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "utf8Decode replaces a maximal invalid subsequence with one U+FFFD" {
    const context = struct {
        fn run(alloc: Allocator, bytes: []const u8, expected: []const u16) !void {
            const decoded = try utf8Decode(alloc, bytes);
            try testing.expectEqualSlices(u16, expected, decoded);
        }
    }.run;

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    try context(alloc, "a", &lit("a"));
    try context(alloc, "\xE2\x82\xAC", &[_]u16{0x20AC});
    // A surrogate: the narrowed first-continuation range rejects 0xA0, so the
    // byte that broke the sequence starts a subsequence of its own, and 0x80
    // cannot lead one.
    try context(alloc, "\xED\xA0\x80", &[_]u16{ 0xFFFD, 0xFFFD, 0xFFFD });
    try context(alloc, "\xC0\x80", &[_]u16{ 0xFFFD, 0xFFFD });
    try context(alloc, "\xF0\x9F\x98\x80", &[_]u16{ 0xD83D, 0xDE00 });
}

test "utf8Encode writes an unpaired surrogate as U+FFFD" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const text = [_]u16{ 0xD83D, 0xDE00, 0xD800, 'a' };
    const encoded = try utf8Encode(alloc, &text);
    try testing.expectEqualSlices(u8, "\xF0\x9F\x98\x80\xEF\xBF\xBDa", encoded);
}
