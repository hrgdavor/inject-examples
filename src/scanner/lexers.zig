//! The lexer registry — the Zig twin of `src/js/scanner/lexers.js`.
//!
//! Maps a file extension to the language lexer that masks it for the section
//! resolver. An extension with no entry returns null, and the resolver then
//! uses its built-in default engine — so the language table is an optimisation
//! for the types it covers, never a requirement.
//!
//! Every entry is built from the same one-pass tokenizer and the same data table
//! (`syntaxes.zig`), so adding a language is one object there plus one extension
//! line here.

const std = @import("std");
const Allocator = std.mem.Allocator;

const js = @import("../js.zig");
const Str = js.Str;
const tokenizer = @import("tokenizer.zig");
const syntaxes = @import("syntaxes.zig");

const Syntax = syntaxes.Syntax;

/// One lexical fact set, in the shape the resolver's lexer seam wants.
///
/// The JavaScript adapter memoises `mask` and `comments` on the last source so
/// one scan pays for both; here the resolver builds both in a single call, so
/// the seam is one method: mask and comments together, in one pass.
/// One declaration shape a language reports for a masked line: the `declarations(maskedLine)` seam
/// the JavaScript adapter exposes, in the same order and with the same answers.
pub const Declared = struct {
    kind: syntaxes.Declaration.Kind,
    name: Str,
    /// The offset in the line the declaration's body starts at, as `match[0].length` is in JavaScript.
    header_from: usize,
    /// `end_kw` rides along so the body rule travels with the hit, as the resolver's does.
    end_kw: ?Str,
    /// The declaration line is itself a complete selection when no body follows.
    line: bool,
};

pub const Lexer = struct {
    name: []const u8,
    syntax: *const Syntax,

    pub fn mask(self: Lexer, alloc: Allocator, source: Str) ![]u16 {
        return (try tokenizer.tokenize(alloc, source, self.syntax)).masked;
    }

    pub fn comments(self: Lexer, alloc: Allocator, source: Str) ![]tokenizer.Comment {
        return (try tokenizer.tokenize(alloc, source, self.syntax)).comments;
    }

    /// The language's own declaration shapes for one *masked* line, in table order — the answers
    /// `lib/section.mjs` gets from its lexer. The generic `name(` heuristics are not here: they live in
    /// the scanner, and this is only what a language adds to them.
    pub fn declarations(self: Lexer, alloc: Allocator, line: Str) ![]Declared {
        var out = std.ArrayList(Declared).empty;
        errdefer out.deinit(alloc);
        for (self.syntax.declarations) |entry| {
            const hit = entry.match(line) orelse continue;
            try out.append(alloc, .{
                .kind = entry.kind,
                .name = hit.name,
                .header_from = hit.header_from,
                .end_kw = entry.end_kw,
                .line = entry.line,
            });
        }
        return out.toOwnedSlice(alloc);
    }
};

/// Extension → syntax name. One line per extension; the table itself is in
/// `syntaxes.zig`.
pub const Extension = struct { extension: []const u8, syntax: *const Syntax };

pub const EXTENSIONS = [_]Extension{
    .{ .extension = "js", .syntax = &syntaxes.JS_SYNTAX },
    .{ .extension = "mjs", .syntax = &syntaxes.JS_SYNTAX },
    .{ .extension = "cjs", .syntax = &syntaxes.JS_SYNTAX },
    .{ .extension = "jsx", .syntax = &syntaxes.JS_SYNTAX },
    .{ .extension = "ts", .syntax = &syntaxes.TYPESCRIPT_SYNTAX },
    .{ .extension = "tsx", .syntax = &syntaxes.TYPESCRIPT_SYNTAX },
    .{ .extension = "mts", .syntax = &syntaxes.TYPESCRIPT_SYNTAX },
    .{ .extension = "cts", .syntax = &syntaxes.TYPESCRIPT_SYNTAX },
    .{ .extension = "java", .syntax = &syntaxes.JAVA_SYNTAX },
    .{ .extension = "zig", .syntax = &syntaxes.ZIG_SYNTAX },
    .{ .extension = "go", .syntax = &syntaxes.GO_SYNTAX },
    .{ .extension = "rs", .syntax = &syntaxes.RUST_SYNTAX },
    .{ .extension = "py", .syntax = &syntaxes.PYTHON_SYNTAX },
    .{ .extension = "pyi", .syntax = &syntaxes.PYTHON_SYNTAX },
    .{ .extension = "cs", .syntax = &syntaxes.CSHARP_SYNTAX },
    .{ .extension = "kt", .syntax = &syntaxes.KOTLIN_SYNTAX },
    .{ .extension = "kts", .syntax = &syntaxes.KOTLIN_SYNTAX },
    .{ .extension = "php", .syntax = &syntaxes.PHP_SYNTAX },
    .{ .extension = "phtml", .syntax = &syntaxes.PHP_SYNTAX },
    .{ .extension = "rb", .syntax = &syntaxes.RUBY_SYNTAX },
    .{ .extension = "rake", .syntax = &syntaxes.RUBY_SYNTAX },
    .{ .extension = "gemspec", .syntax = &syntaxes.RUBY_SYNTAX },
    .{ .extension = "sql", .syntax = &syntaxes.SQL_SYNTAX },
    .{ .extension = "sh", .syntax = &syntaxes.SHELL_SYNTAX },
    .{ .extension = "bash", .syntax = &syntaxes.SHELL_SYNTAX },
    .{ .extension = "zsh", .syntax = &syntaxes.SHELL_SYNTAX },
    .{ .extension = "vb", .syntax = &syntaxes.VB_SYNTAX },
    .{ .extension = "bas", .syntax = &syntaxes.VB_SYNTAX },
    .{ .extension = "vbs", .syntax = &syntaxes.VB_SYNTAX },
    .{ .extension = "hs", .syntax = &syntaxes.HASKELL_SYNTAX },
    .{ .extension = "lhs", .syntax = &syntaxes.HASKELL_SYNTAX },
    .{ .extension = "yaml", .syntax = &syntaxes.YAML_SYNTAX },
    .{ .extension = "yml", .syntax = &syntaxes.YAML_SYNTAX },
    .{ .extension = "toml", .syntax = &syntaxes.TOML_SYNTAX },
    .{ .extension = "ini", .syntax = &syntaxes.INI_SYNTAX },
    .{ .extension = "cfg", .syntax = &syntaxes.INI_SYNTAX },
    .{ .extension = "properties", .syntax = &syntaxes.INI_SYNTAX },
};

/// The lexer for `path`'s extension, or null when the type is unknown (no
/// extension, or one with no entry) and the default engine applies.
///
/// `path` is UTF-16 code units here; the extension compare is ASCII.
pub fn lexerFor(path: Str) ?Lexer {
    const dot = js.lastIndexOfUnit(path, '.') orelse return null;
    if (dot == 0) return null;
    const extension = path[dot + 1 ..];
    for (EXTENSIONS) |entry| {
        if (extension.len != entry.extension.len) continue;
        var same = true;
        for (extension, entry.extension) |unit, byte| {
            if (js.asciiLower(unit) != byte) {
                same = false;
                break;
            }
        }
        if (same) return .{ .name = entry.syntax.name, .syntax = entry.syntax };
    }
    return null;
}

test "every extension in the table resolves to its syntax" {
    const cases = [_]struct { path: []const u8, name: []const u8 }{
        .{ .path = "pkg/main.zig", .name = "zig" },
        .{ .path = "Cart.RS", .name = "rust" },
        .{ .path = "a.b.c.ts", .name = "typescript" },
        .{ .path = "x/y.INI", .name = "ini" },
    };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    for (cases) |case| {
        const path = try js.utf8Decode(alloc, case.path);
        const lexer = lexerFor(path) orelse return error.ExpectedALexer;
        try std.testing.expectEqualStrings(case.name, lexer.name);
    }

    try std.testing.expect(lexerFor(try js.utf8Decode(alloc, "notes.txt")) == null);
    try std.testing.expect(lexerFor(try js.utf8Decode(alloc, ".gitignore")) == null);
    try std.testing.expect(lexerFor(try js.utf8Decode(alloc, "noext")) == null);
}
