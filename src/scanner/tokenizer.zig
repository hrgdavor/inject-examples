//! The shared tokenizer — the Zig twin of `src/js/scanner/tokenizer.js`.
//!
//! One lexical pass over a source, parameterised by a language's comment and
//! string syntax. It produces the two facts the section resolver's lexer seam
//! needs — a blanked mask and the comment spans — plus the `if` clauses matcher 5
//! reads.
//!
//! It owns NOTHING structural: no braces are matched here, no blocks are built,
//! no precedence or modifier is applied. `section.zig` drives this through a
//! lexer adapter and does all of that, so every engine agrees.
//!
//! The mask invariant is a property of the implementation, not a promise: every
//! write goes through `blank`, which replaces characters with spaces and never
//! touches `\n`, so the mask has the same length and every newline at the same
//! offset. `section.zig` asserts it again, naming the lexer.

const std = @import("std");
const Allocator = std.mem.Allocator;

const js = @import("../js.zig");
const Str = js.Str;

const syntaxes = @import("syntaxes.zig");
const Syntax = syntaxes.Syntax;
const StringKind = syntaxes.StringKind;

/// A comment body (the delimiters stripped) and where it sits.
pub const Comment = struct {
    text: Str,
    from: usize,
    to: usize,
};

/// A string literal's span.
pub const StringSpan = struct {
    from: usize,
    to: usize,
    quote: Str,
    multiline: bool,
};

/// An `if` header and the brace that opens its body.
pub const IfClause = struct {
    offset: usize,
    brace: usize,
    line: usize,
    col: usize,
    clause: Str,
    snippet: Str,
};

/// Everything one pass produces.
pub const Lexed = struct {
    masked: []u16,
    comments: []Comment,
    strings: []StringSpan,
    if_clauses: []IfClause,
};

/// A boundary-prefixed opener may not follow an identifier character.
fn isIdChar(unit: u16) bool {
    return (unit >= 'A' and unit <= 'Z') or (unit >= 'a' and unit <= 'z') or
        (unit >= '0' and unit <= '9') or unit == '_' or unit == '$';
}

// --- offset helpers ---------------------------------------------------------

fn lineStarts(alloc: Allocator, source: Str) ![]usize {
    var starts = std.ArrayList(usize).empty;
    try starts.append(alloc, 0);
    for (source, 0..) |unit, index| {
        if (unit == '\n') try starts.append(alloc, index + 1);
    }
    return starts.toOwnedSlice(alloc);
}

fn lineCol(starts: []const usize, offset: usize) struct { line: usize, col: usize } {
    var low: usize = 0;
    var high: usize = starts.len - 1;
    while (low < high) {
        const mid = (low + high + 1) / 2;
        if (starts[mid] <= offset) low = mid else high = mid - 1;
    }
    return .{ .line = low + 1, .col = offset - starts[low] + 1 };
}

fn endOfLine(text: Str, from: usize) usize {
    const newline = js.indexOfUnit(text[from..], '\n') orelse return text.len;
    return from + newline;
}

/// Overwrite `from..to` with spaces, newlines excepted.
fn blank(target: []u16, from: usize, to: usize) void {
    var i = from;
    while (i < to and i < target.len) : (i += 1) {
        if (target[i] != '\n') target[i] = ' ';
    }
}

// --- readers ----------------------------------------------------------------

/// The end offset and inner body of a block comment starting at `i`.
fn readBlockComment(source: Str, i: usize, bc: syntaxes.BlockComment) struct { to: usize, body: Str } {
    if (!bc.nested) {
        const found = js.indexOf(source[i + bc.open.len ..], bc.close);
        const end = if (found) |offset| i + bc.open.len + offset else source.len;
        const to = if (found == null) source.len else end + bc.close.len;
        return .{ .to = to, .body = source[i + bc.open.len .. end] };
    }
    var depth: usize = 0;
    var j = i;
    const body_start = i + bc.open.len;
    while (j < source.len) {
        if (js.startsWith(source[j..], bc.open)) {
            depth += 1;
            j += bc.open.len;
            continue;
        }
        if (js.startsWith(source[j..], bc.close)) {
            depth -= 1;
            j += bc.close.len;
            if (depth == 0) break;
            continue;
        }
        j += 1;
    }
    const to = j;
    const stop = if (to >= bc.close.len and to - bc.close.len > body_start) to - bc.close.len else body_start;
    return .{ .to = to, .body = source[body_start..@max(body_start, stop)] };
}

/// The string kind that opens at `i`, with the body offset and the closer it
/// implies — null when nothing opens there. A `hashes` kind (Rust raw string)
/// reads its own closer: `r#"` closes at `"#`, `r"` at `"`.
const Hit = struct {
    kind: *const StringKind,
    body_from: usize,
    /// Owned when `hashes` computed it, borrowed from the table otherwise.
    close: Str,
    close_owned: bool,
};

fn matchString(alloc: Allocator, source: Str, i: usize, kinds: []const StringKind) !?Hit {
    for (kinds) |*kind| {
        if (kind.boundary and i > 0 and isIdChar(source[i - 1])) continue;
        if (kind.hashes) {
            // `r#"` / `br##"`: the prefix is the opener without its final `"`,
            // then any number of `#`, then the `"` that opens the body.
            if (kind.open.len == 0) continue;
            const prefix = kind.open[0 .. kind.open.len - 1];
            if (!js.startsWith(source[i..], prefix)) continue;
            var j = i + prefix.len;
            var hashes: usize = 0;
            while (j < source.len and source[j] == '#') : (j += 1) hashes += 1;
            if (j >= source.len or source[j] != '"') continue;
            const close = try alloc.alloc(u16, hashes + 1);
            close[0] = '"';
            for (close[1..]) |*unit| unit.* = '#';
            return .{ .kind = kind, .body_from = j + 1, .close = close, .close_owned = true };
        }
        if (js.startsWith(source[i..], kind.open)) {
            return .{ .kind = kind, .body_from = i + kind.open.len, .close = kind.close, .close_owned = false };
        }
    }
    return null;
}

/// What a scan of the body found: where the closer sits and, for a constrained
/// kind (a char literal beside a Rust lifetime), the body a `content` test
/// would have to accept. `close = null` means the closer never came.
const Trace = struct {
    close: ?usize,
    offending: ?usize = null,
    body_len: usize = 0,
};

fn traceString(source: Str, hit: *const Hit) Trace {
    const kind = hit.kind;
    var j = hit.body_from;
    while (j < source.len) {
        const unit = source[j];
        if (unit == '\n' and !kind.multiline) return .{ .close = null, .offending = j, .body_len = 0 };
        if (kind.escape == .backslash and unit == '\\') {
            j += 2;
            continue;
        }
        if (kind.escape == .doubling and js.startsWith(source[j..], hit.close) and
            js.startsWith(source[j + hit.close.len ..], hit.close))
        {
            j += hit.close.len * 2;
            continue;
        }
        if (js.startsWith(source[j..], hit.close)) {
            return .{ .close = j, .body_len = j - hit.body_from };
        }
        j += 1;
    }
    return .{ .close = null, .offending = null, .body_len = source.len - hit.body_from };
}

/// The end offset of the string `hit` opens, or null when the candidate is not
/// a string after all (a Rust lifetime, a char literal that never closes).
///
/// `max_span` and `single_char` are the char-versus-lifetime rule: the closer
/// must sit that close, and the body must look like one character (or one
/// escape), so `'a'` is a char while `'a>(x: &'` never is.
fn readString(source: Str, hit: *const Hit, trace: *const Trace, close: usize) ?usize {
    const kind = hit.kind;
    if (kind.line_scoped) return endOfLine(source, hit.body_from);

    // A constrained kind must actually close; an unterminated candidate is not
    // a string at all, so the `'` of `&'static str` never swallows the line.
    if (kind.single_char and !looksLikeOneChar(source[hit.body_from..close])) return null;
    if (kind.max_span != 0 and trace.body_len > kind.max_span) return null;
    return close + hit.close.len;
}

/// The `content` pattern of a Rust char literal:
/// `/^(?:\\.{1,10}|[^\n\\]{1,2})$/` — one escape of up to ten characters, or
/// one or two characters neither of which is a newline or a backslash.
fn looksLikeOneChar(body: Str) bool {
    if (body.len == 0) return false;
    if (body[0] == '\\') {
        const rest = body.len - 1;
        return rest >= 1 and rest <= 10;
    }
    if (body[0] == '\n' or body[0] == '\\') return false;
    if (body.len > 2) return false;
    if (body.len == 2 and (body[1] == '\n' or body[1] == '\\')) return false;
    return true;
}

/// `<<TAG`, `<<-TAG`, `<<~TAG`, `<<"TAG"` and PHP's `<<<TAG`.
///
/// `strict` demands the unambiguous spellings (`<<~`, `<<-`, a quoted tag) so
/// Ruby's `array << x` is never read as one; shell and PHP take the bare
/// `<<TAG` form as well.
const HeredocHit = struct { tag: Str, length: usize };

fn matchHeredoc(source: Str, i: usize, mode: syntaxes.Heredoc) ?HeredocHit {
    var at = i;
    if (!js.startsWithBytes(source[at..], "<<")) return null;
    at += 2;

    // PHP's third angle.
    if (at < source.len and source[at] == '<') at += 1;

    var strip = false;
    if (at < source.len and (source[at] == '-' or source[at] == '~')) {
        strip = true;
        at += 1;
    }

    var quote: u16 = 0;
    if (at < source.len and (source[at] == '"' or source[at] == '\'' or source[at] == '`')) {
        quote = source[at];
        at += 1;
    }

    if (at >= source.len) return null;
    if (!((source[at] >= 'A' and source[at] <= 'Z') or (source[at] >= 'a' and source[at] <= 'z') or source[at] == '_')) return null;
    const tag_start = at;
    at += 1;
    while (at < source.len and js.isAsciiWord(source[at])) at += 1;
    const tag = source[tag_start..at];

    if (quote != 0) {
        if (at >= source.len or source[at] != quote) return null;
        at += 1;
    }
    if (mode == .strict and !strip and quote == 0) return null;
    return .{ .tag = tag, .length = at - i };
}

/// The offset that ends the heredoc body: the terminator line's end of line.
fn heredocEnd(source: Str, from: usize, tag: Str) usize {
    var i = from;
    while (i <= source.len) {
        const eol = endOfLine(source, i);
        const line = js.trim(source[i..eol]);
        if (js.eql(line, tag)) return eol;
        // PHP's terminator may carry the statement's `;` (`EOT;`).
        if (line.len == tag.len + 1 and line[line.len - 1] == ';' and js.eql(line[0..tag.len], tag)) return eol;
        if (eol >= source.len) return source.len;
        i = eol + 1;
    }
    return source.len;
}

/// The `if` clauses, read from the mask so a string/comment `if` never counts.
fn extractIfClauses(alloc: Allocator, source: Str, masked: Str, starts: []const usize) ![]IfClause {
    var out = std.ArrayList(IfClause).empty;
    const keyword = "if";
    var from: usize = 0;
    while (js.indexOfBytes(masked[from..], keyword)) |offset| {
        const at = from + offset;
        from = at + keyword.len;
        if (!js.isWordBoundary(masked, at)) continue;
        const brace = js.indexOfUnit(masked[at..], '{') orelse continue;
        const clause = source[at .. at + brace];
        const position = lineCol(starts, at);
        try out.append(alloc, .{
            .offset = at,
            .brace = at + brace,
            .line = position.line,
            .col = position.col,
            .clause = clause,
            .snippet = js.trim(clause),
        });
    }
    return out.toOwnedSlice(alloc);
}

/// One lexical pass. Blanks comments and strings to spaces (length and every
/// newline offset preserved — the invariant `section.zig` asserts), collects the
/// comment spans, and reports the `if` clauses.
pub fn tokenize(alloc: Allocator, source: Str, syntax: *const Syntax) !Lexed {
    const out = try alloc.dupe(u16, source);
    var comments = std.ArrayList(Comment).empty;
    var strings = std.ArrayList(StringSpan).empty;
    const starts = try lineStarts(alloc, source);

    var i: usize = 0;
    while (i < source.len) {
        const unit = source[i];
        if (unit == '\n') {
            i += 1;
            continue;
        }

        // Heredocs first: their body spans lines, and `<<` opens nothing else.
        if (syntax.heredoc != .none and js.startsWithBytes(source[i..], "<<")) {
            if (matchHeredoc(source, i, syntax.heredoc)) |heredoc| {
                const open_end = endOfLine(source, i);
                const end = heredocEnd(source, open_end + 1, heredoc.tag);
                blank(out, open_end + 1, end);
                i = end;
                continue;
            }
        }

        var matched = false;
        for (syntax.line_comments) |open| {
            // `#[attr]` is an attribute in Rust and PHP, never a `#` comment.
            if (open.len == 1 and open[0] == '#' and i + 1 < source.len and source[i + 1] == '[') continue;
            if (!js.startsWith(source[i..], open)) continue;
            const end = endOfLine(source, i);
            const body = source[i + open.len .. end];
            try comments.append(alloc, .{ .text = body, .from = i, .to = end });
            blank(out, i, end);
            i = end;
            matched = true;
            break;
        }
        if (matched) continue;

        var block: ?syntaxes.BlockComment = null;
        for (syntax.block_comments) |bc| {
            if (!js.startsWith(source[i..], bc.open)) continue;
            if (bc.line_start and i != 0 and source[i - 1] != '\n') continue;
            block = bc;
            break;
        }
        if (block) |bc| {
            const read = readBlockComment(source, i, bc);
            try comments.append(alloc, .{ .text = read.body, .from = i, .to = read.to });
            blank(out, i, read.to);
            i = read.to;
            continue;
        }

        if (try matchString(alloc, source, i, syntax.strings)) |hit| {
            const trace = traceString(source, &hit);
            if (trace.close) |close| {
                if (readString(source, &hit, &trace, close)) |to| {
                    try strings.append(alloc, .{
                        .from = i,
                        .to = to,
                        .quote = hit.kind.open,
                        .multiline = hit.kind.multiline,
                    });
                    blank(out, i, to);
                    i = to;
                    continue;
                }
            } else if (!(hit.kind.max_span != 0 or hit.kind.single_char)) {
                // An unterminated unconstrained literal runs to the end.
                const to = source.len;
                try strings.append(alloc, .{
                    .from = i,
                    .to = to,
                    .quote = hit.kind.open,
                    .multiline = hit.kind.multiline,
                });
                blank(out, i, to);
                i = to;
                continue;
            }
        }

        i += 1;
    }

    return .{
        .masked = out,
        .comments = try comments.toOwnedSlice(alloc),
        .strings = try strings.toOwnedSlice(alloc),
        .if_clauses = try extractIfClauses(alloc, source, out, starts),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn countNewlines(text: Str) usize {
    var count: usize = 0;
    for (text) |unit| {
        if (unit == '\n') count += 1;
    }
    return count;
}

test "the mask preserves length and every newline offset" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const sources = [_][]const u8{
        "// c\nlet x = \"a}b\";\n/* nested /* inner */ outer */\n",
        "def add(a)\n  \"#{a}\" # tail\nend\n",
        "const s = \"\"\"text\nblock\"\"\";\n",
        "let r = r#\"raw \"# here\"#;\n",
        "#!/bin/sh\ncat <<EOF\na } b\nEOF\necho ok\n",
    };
    for (sources) |text| {
        const source = try js.utf8Decode(alloc, text);
        const lexed = try tokenize(alloc, source, &syntaxes.JS_SYNTAX);
        try testing.expectEqual(source.len, lexed.masked.len);
        try testing.expectEqual(countNewlines(source), countNewlines(lexed.masked));
    }
}

test "Zig block comments nest, so a decoy inside one stays hidden" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const source = try js.utf8Decode(alloc,
        \\// a comment
        \\/* outer /* inner */ still outer
        \\   pub fn decoy() void {}
        \\*/
        \\pub fn target() void {}
        \\
    );
    const lexed = try tokenize(alloc, source, &syntaxes.ZIG_SYNTAX);
    const masked = try js.utf8Encode(alloc, lexed.masked);
    try testing.expect(std.mem.indexOf(u8, masked, "decoy") == null);
    try testing.expect(std.mem.indexOf(u8, masked, "target") != null);
}
