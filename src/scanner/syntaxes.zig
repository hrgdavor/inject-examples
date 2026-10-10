//! The language table — the Zig twin of `src/js/scanner/syntaxes.js`.
//!
//! One entry per language. `tokenizer.zig` walks them; nothing here executes,
//! so adding a language is adding an object. A language that is not here falls
//! back to `section.zig`'s built-in mask, the language-agnostic union — the
//! same answer a reference gets when the type is unknown, which is why an entry
//! is only worth adding when the union is WRONG for that language (a nested
//! comment, a raw string, a heredoc, or a `'` that is a lifetime rather than a
//! char literal).
//!
//! Comments on most entries say which construct the entry exists for.

const js = @import("../js.zig");
const Str = js.Str;

/// How a string literal escapes its closer: `\` before it, or the closer
/// doubled (SQL `''`, VB `""`, C# `@"…"`), or not at all.
pub const Escape = enum { backslash, doubling, none };

/// One string form.
pub const StringKind = struct {
    /// the literal opener, e.g. `"`, `"""`, `r'`, `@"`
    open: Str,
    /// the literal closer (defaults to `open`); `hashes` computes it
    close: Str,
    escape: Escape = .backslash,
    /// may span lines
    multiline: bool = false,
    /// runs to the end of the line (Zig `\\`)
    line_scoped: bool = false,
    /// the opener may not follow an identifier character
    boundary: bool = false,
    /// Rust raw string: `r#*"` … `"#*`
    hashes: bool = false,
    /// the closer must be this close (Rust char versus lifetime); 0 = no limit
    max_span: usize = 0,
    /// and the body must look like one character (again: char versus lifetime)
    single_char: bool = false,
};

/// One block-comment pair.
pub const BlockComment = struct {
    open: Str,
    close: Str,
    /// Rust, Kotlin, Zig and Haskell nest their block comments
    nested: bool = false,
    /// `=begin` in Ruby only counts at column 0
    line_start: bool = false,
};

/// A declaration shape the generic `name(` heuristics miss.
///
/// The JavaScript table spells these as regular expressions; the tokenizer
/// evaluates them with the small hand-written matchers in `syntax.zig`, because
/// the shapes are few and fixed and a general engine would be a liability at
/// this size. `header_from` is an offset in the *matched text*, exactly as
/// `match[0].length` is in JavaScript.
pub const Declaration = struct {
    kind: Kind,
    match: *const fn (line: Str) ?DeclMatch,
    /// `body: 'end'` — the block is closed by a keyword line (Ruby, VB)
    end_kw: ?Str = null,
    /// `line: true` — the declaration line is itself a complete selection
    line: bool = false,

    pub const Kind = enum { class, method, property };

    /// What a `Declaration`'s matcher returns: the name (a slice of the line)
    /// and where the declaration's body starts, as `match[0].length` would be.
    pub const DeclMatch = struct {
        name: Str,
        header_from: usize,
    };
};

pub const Heredoc = enum { none, plain, strict };
pub const Annotation = *const fn (line: Str) bool;

pub const Syntax = struct {
    name: []const u8,
    line_comments: []const Str = &.{},
    block_comments: []const BlockComment = &.{},
    strings: []const StringKind = &.{},
    heredoc: Heredoc = .none,
    declarations: []const Declaration = &.{},
    annotations: []const Annotation = &.{},
};

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

fn u(comptime text: []const u8) Str {
    return &js.lit(text);
}

/// `//` and the C block pair (`/* … *\/`) — the C family's two spellings.
pub const C_LINE = [_]Str{u("//")};
pub const C_BLOCK = [_]BlockComment{.{ .open = u("/*"), .close = u("*/") }};

/// A Rust char literal: `'a'`, `'\n'`, `' '` — one character or one escape,
/// closed within a few characters. Rejecting everything else is what keeps a
/// lifetime (`'a`, `'static`) out of the mask.
pub fn singleChar(comptime open: []const u8) StringKind {
    return .{
        .open = u(open),
        .close = u("'"),
        .escape = .backslash,
        .max_span = 12,
        .single_char = true,
    };
}

// ---------------------------------------------------------------------------
// Declaration shapes
// ---------------------------------------------------------------------------

/// `^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)` — Ruby's `def add` needs no
/// parentheses, so the generic `name(` shape misses it. `self.` is stripped;
/// `?`, `!` and `=` are part of the name.
pub fn matchRubyDef(line: Str) ?Declaration.DeclMatch {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (!js.startsWithBytes(line[at..], "def")) return null;
    at += 3;
    if (at >= line.len or !js.isWhitespace(line[at])) return null;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (js.startsWithBytes(line[at..], "self.")) at += 5;
    if (at >= line.len) return null;
    if (!(line[at] >= 'A' and line[at] <= 'Z') and !(line[at] >= 'a' and line[at] <= 'z') and line[at] != '_') return null;
    const start = at;
    at += 1;
    while (at < line.len and js.isAsciiWord(line[at])) at += 1;
    if (at < line.len and (line[at] == '?' or line[at] == '!' or line[at] == '=')) at += 1;
    return .{ .name = line[start..at], .header_from = at };
}

/// The second shape in `matchRubyDef`'s group — kept separate so the table can
/// list exactly one declaration per entry.
pub const RUBY_DECLARATIONS = [_]Declaration{
    .{ .kind = .method, .match = matchRubyDef, .end_kw = u("end") },
};

/// `^(?!(?:data|newtype|…)\b)([a-z_][\w']*)\b[^=\n]*=` — a top-level Haskell
/// binding. The lookahead keeps the words that *open* a declaration
/// (`data Cart = …`) from being read as a binding named `data`.
pub fn matchHaskellBinding(line: Str) ?Declaration.DeclMatch {
    const keywords = [_][]const u8{
        "data",    "newtype", "type",    "class",  "instance", "module",
        "import",  "infix",   "infixl",  "infixr", "foreign",  "deriving",
        "default",
    };
    for (keywords) |keyword| {
        const word = keyword;
        if (!js.startsWithBytes(line, word)) continue;
        const after = word.len;
        if (after >= line.len or !js.isAsciiWord(line[after])) return null;
    }

    if (line.len == 0) return null;
    const first = line[0];
    if (!((first >= 'a' and first <= 'z') or first == '_')) return null;

    var at: usize = 1;
    while (at < line.len and (js.isAsciiWord(line[at]) or line[at] == '\'')) at += 1;
    const name = line[0..at];

    // `[^=\n]*=`: everything that is not `=` and not a newline, then an `=`
    // that is not the start of `==`.
    var scan = at;
    while (scan < line.len and line[scan] != '=' and line[scan] != '\n') scan += 1;
    if (scan >= line.len or line[scan] != '=') return null;
    return .{ .name = name, .header_from = scan + 1 };
}

/// `^(?:data|newtype|type|class)\s+(?:\([^)]*\)\s*=>\s*)?([A-Z][\w']*)`.
pub fn matchHaskellType(line: Str) ?Declaration.DeclMatch {
    const leaders = [_][]const u8{ "data", "newtype", "type", "class" };
    var at: usize = 0;
    var matched = false;
    for (leaders) |leader| {
        const word = leader;
        if (!js.startsWithBytes(line[at..], word)) continue;
        at += word.len;
        matched = true;
        break;
    }
    if (!matched) return null;
    if (at >= line.len or !js.isWhitespace(line[at])) return null;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;

    // An optional constraint context, `(Eq a) =>`.
    if (at < line.len and line[at] == '(') {
        const close = js.indexOfUnit(line[at..], ')') orelse return null;
        var after = at + close + 1;
        while (after < line.len and js.isWhitespace(line[after])) after += 1;
        if (!js.startsWithBytes(line[after..], "=>")) return null;
        at = after + 2;
        while (at < line.len and js.isWhitespace(line[at])) at += 1;
    }

    if (at >= line.len or !(line[at] >= 'A' and line[at] <= 'Z')) return null;
    const start = at;
    at += 1;
    while (at < line.len and (js.isAsciiWord(line[at]) or line[at] == '\'')) at += 1;
    return .{ .name = line[start..at], .header_from = at };
}

pub const HASKELL_DECLARATIONS = [_]Declaration{
    .{ .kind = .method, .match = matchHaskellBinding, .line = true },
    .{ .kind = .class, .match = matchHaskellType },
};

pub fn isHaskellAnnotation(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    const start = at;
    while (at < line.len and (js.isAsciiWord(line[at]) or line[at] == '\'')) at += 1;
    if (at == start) return false;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    return js.startsWithBytes(line[at..], "::");
}

pub const HASKELL_ANNOTATIONS = [_]Annotation{isHaskellAnnotation};

/// `^\s*impl\b[^{]*?\b([A-Za-z_][\w:]*)\s*(?:<[^>]*>)?\s*(?:where\b[^{]*)?\{`.
///
/// The impl is declared as a class-like scope named after the **type** — the
/// identifier that ends the header, so `impl Display for Cart<T> where T: Clone`
/// is a scope called `Cart` — which makes it a sibling of the `struct Cart`; the
/// resolver retries same-named scopes, so `Cart/add` reaches the method and
/// `Cart/items` the field.
pub fn matchRustImpl(line: Str) ?Declaration.DeclMatch {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (!js.startsWithBytes(line[at..], "impl")) return null;
    at += 4;
    if (at < line.len and js.isAsciiWord(line[at])) return null;

    // `\b([A-Za-z_][\w:]*)\s*(?:<[^>]*>)?\s*(?:where\b[^{]*)?\{`: the header is
    // anchored at the `{`, then walked back over an optional generic list, an
    // optional `where` clause and the identifier's own `[\w:]*` tail — which is
    // why the identifier that *ends* the header is the one that names the scope.
    const brace = js.indexOfUnit(line[at..], '{') orelse return null;
    var header = js.trimEnd(line[at .. at + brace]);
    if (js.indexOfBytes(header, "where")) |found| header = js.trimEnd(header[0..found]);

    if (header.len > 0 and header[header.len - 1] == '>') {
        const open = js.lastIndexOfUnit(header, '<') orelse return null;
        header = js.trimEnd(header[0..open]);
    }
    var end = header.len;
    while (end > 0 and (js.isAsciiWord(header[end - 1]) or header[end - 1] == ':')) end -= 1;
    if (end == header.len) return null;
    if (!js.isIdentStart(header[end])) return null;
    return .{ .name = header[end..], .header_from = at + brace + 1 };
}

/// `^\s*(?:pub\s+)?([A-Za-z_]\w*)\s*:` — a Rust field is `name: Type,`, where
/// the generic property shape wants `name = …`, which Rust never writes.
pub fn matchRustField(line: Str) ?Declaration.DeclMatch {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (js.startsWithBytes(line[at..], "pub ")) at += 4;
    const start = at;
    if (at >= line.len or !js.isIdentStart(line[at])) return null;
    at += 1;
    while (at < line.len and js.isAsciiWord(line[at])) at += 1;
    if (at == start) return null;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len or line[at] != ':') return null;
    return .{ .name = line[start..][0 .. at - start - countTrailingSpace(line[start..at])], .header_from = start };
}

fn countTrailingSpace(text: Str) usize {
    var count: usize = 0;
    var end = text.len;
    while (end > 0 and js.isWhitespace(text[end - 1])) : (end -= 1) count += 1;
    return count;
}

pub const RUST_DECLARATIONS = [_]Declaration{
    .{ .kind = .class, .match = matchRustImpl },
    .{ .kind = .property, .match = matchRustField, .line = true },
};

/// `^\s*(?:Public|Private|Friend|Protected)?\s*(?:NotInheritable\s+|MustInherit\s+)?(?:Class|Module|Structure)\s+(\w+)`.
pub fn matchVbClass(line: Str) ?Declaration.DeclMatch {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    const access = [_][]const u8{ "Public", "Private", "Friend", "Protected" };
    for (access) |word| {
        if (!js.startsWithBytes(line[at..], word)) continue;
        at += word.len;
        break;
    }
    for ([_][]const u8{ "NotInheritable ", "MustInherit " }) |word| {
        if (js.startsWithBytes(line[at..], word)) at += word.len;
    }
    var matched = false;
    for ([_][]const u8{ "Class", "Module", "Structure" }) |word| {
        if (!js.startsWithBytes(line[at..], word)) continue;
        at += word.len;
        matched = true;
        break;
    }
    if (!matched) return null;
    if (at >= line.len or !js.isWhitespace(line[at])) return null;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    const start = at;
    while (at < line.len and js.isAsciiWord(line[at])) at += 1;
    if (at == start) return null;
    return .{ .name = line[start..at], .header_from = at };
}

/// `^\s*[\w\s]*?\b(?:Sub|Function)\s+(\w+)`.
pub fn matchVbMember(line: Str) ?Declaration.DeclMatch {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    var matched: ?usize = null;
    var scan = at;
    while (scan < line.len) : (scan += 1) {
        if (!js.isAsciiWord(line[scan]) and !js.isWhitespace(line[scan])) break;
        for ([_][]const u8{ "Sub", "Function" }) |word| {
            if (!js.startsWithBytes(line[scan..], word)) continue;
            if (!js.isWordBoundary(line, scan)) continue;
            if (matched == null or scan < matched.?) matched = scan;
        }
    }
    const keyword_at = matched orelse return null;
    // The matched word itself, so the name starts after it.
    var after = keyword_at;
    if (js.startsWithBytes(line[after..], "Function")) {
        after += "Function".len;
    } else {
        after += "Sub".len;
    }
    if (after >= line.len or !js.isWhitespace(line[after])) return null;
    while (after < line.len and js.isWhitespace(line[after])) after += 1;
    const start = after;
    while (after < line.len and js.isAsciiWord(line[after])) after += 1;
    if (after == start) return null;
    return .{ .name = line[start..after], .header_from = after };
}

pub const VB_DECLARATIONS = [_]Declaration{
    .{ .kind = .class, .match = matchVbClass, .end_kw = u("End") },
    .{ .kind = .method, .match = matchVbMember, .end_kw = u("End") },
};

// ---------------------------------------------------------------------------
// The three originals, unchanged in behaviour
// ---------------------------------------------------------------------------

/// JavaScript / TypeScript: `//`, `/* *\/`, `'` `"` and backtick templates.
pub const JS_SYNTAX = Syntax{
    .name = "javascript",
    .line_comments = &C_LINE,
    .block_comments = &C_BLOCK,
    .strings = &.{
        .{ .open = u("`"), .close = u("`"), .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        .{ .open = u("'"), .close = u("'") },
    },
};

/// Java: `//`, `/* *\/`, `'` `"` and text blocks `"""`.
pub const JAVA_SYNTAX = Syntax{
    .name = "java",
    .line_comments = &C_LINE,
    .block_comments = &C_BLOCK,
    .strings = &.{
        .{ .open = u("\"\"\""), .close = u("\"\"\""), .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        .{ .open = u("'"), .close = u("'") },
    },
};

/// Zig: `//`, NESTED `/* *\/`, `"` and multiline strings `\\` (to end of line).
pub const ZIG_SYNTAX = Syntax{
    .name = "zig",
    .line_comments = &C_LINE,
    .block_comments = &.{.{ .open = u("/*"), .close = u("*/"), .nested = true }},
    .strings = &.{
        .{ .open = u("\\\\"), .close = u(""), .line_scoped = true },
        .{ .open = u("\""), .close = u("\"") },
    },
};

// ---------------------------------------------------------------------------
// The rest of the table
// ---------------------------------------------------------------------------

pub const GO_SYNTAX = Syntax{
    .name = "go",
    .line_comments = &C_LINE,
    .block_comments = &C_BLOCK,
    .strings = &.{
        // Backtick raw strings take no escapes at all.
        .{ .open = u("`"), .close = u("`"), .escape = .none, .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        singleChar("'"),
    },
};

pub const RUST_SYNTAX = Syntax{
    .name = "rust",
    .line_comments = &C_LINE,
    // Rust block comments nest: `/* outer /* inner */ still outer */`.
    .block_comments = &.{.{ .open = u("/*"), .close = u("*/"), .nested = true }},
    .strings = &.{
        // `r#"…"#`: the closer is the opener's own hash count.
        .{ .open = u("br\""), .close = u("\""), .escape = .none, .multiline = true, .boundary = true, .hashes = true },
        .{ .open = u("r\""), .close = u("\""), .escape = .none, .multiline = true, .boundary = true, .hashes = true },
        .{ .open = u("b\""), .close = u("\""), .boundary = true },
        .{ .open = u("\""), .close = u("\"") },
        blk: {
            var kind = singleChar("b'");
            kind.boundary = true;
            break :blk kind;
        },
        singleChar("'"),
    },
    .declarations = &RUST_DECLARATIONS,
};

pub const PYTHON_SYNTAX = Syntax{
    .name = "python",
    .line_comments = &.{u("#")},
    .strings = &.{
        // Raw strings do not escape, so `r"\""` ends at the second quote.
        .{ .open = u("r\"\"\""), .close = u("\"\"\""), .escape = .none, .multiline = true, .boundary = true },
        .{ .open = u("r'''"), .close = u("'''"), .escape = .none, .multiline = true, .boundary = true },
        .{ .open = u("rb\""), .close = u("\""), .escape = .none, .boundary = true },
        .{ .open = u("rb'"), .close = u("'"), .escape = .none, .boundary = true },
        .{ .open = u("br\""), .close = u("\""), .escape = .none, .boundary = true },
        .{ .open = u("br'"), .close = u("'"), .escape = .none, .boundary = true },
        .{ .open = u("r\""), .close = u("\""), .escape = .none, .boundary = true },
        .{ .open = u("r'"), .close = u("'"), .escape = .none, .boundary = true },
        .{ .open = u("\"\"\""), .close = u("\"\"\""), .multiline = true },
        .{ .open = u("'''"), .close = u("'''"), .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        .{ .open = u("'"), .close = u("'") },
    },
};

pub const CSHARP_SYNTAX = Syntax{
    .name = "csharp",
    .line_comments = &C_LINE,
    .block_comments = &C_BLOCK,
    .strings = &.{
        // Verbatim (`@"…""…"`) and interpolated-verbatim spellings.
        .{ .open = u("$@\""), .close = u("\""), .escape = .doubling, .multiline = true, .boundary = true },
        .{ .open = u("@$\""), .close = u("\""), .escape = .doubling, .multiline = true, .boundary = true },
        .{ .open = u("@\""), .close = u("\""), .escape = .doubling, .multiline = true, .boundary = true },
        // C# 11 raw string literals: no escapes, any number of quotes.
        .{ .open = u("\"\"\""), .close = u("\"\"\""), .escape = .none, .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        .{ .open = u("'"), .close = u("'") },
    },
};

pub const KOTLIN_SYNTAX = Syntax{
    .name = "kotlin",
    .line_comments = &C_LINE,
    // Kotlin block comments nest, like Rust's.
    .block_comments = &.{.{ .open = u("/*"), .close = u("*/"), .nested = true }},
    .strings = &.{
        .{ .open = u("\"\"\""), .close = u("\"\"\""), .escape = .none, .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        .{ .open = u("'"), .close = u("'") },
    },
};

pub const PHP_SYNTAX = Syntax{
    .name = "php",
    // Both spellings; `#[Attribute]` stays readable (see tokenizer.zig).
    .line_comments = &.{ u("//"), u("#") },
    .block_comments = &C_BLOCK,
    .strings = &.{
        .{ .open = u("\""), .close = u("\""), .multiline = true },
        .{ .open = u("'"), .close = u("'"), .multiline = true },
    },
    // `<<<EOT` and `<<<'EOT'` bodies are not code.
    .heredoc = .plain,
};

pub const RUBY_SYNTAX = Syntax{
    .name = "ruby",
    .line_comments = &.{u("#")},
    // `=begin` / `=end` only count at column 0.
    .block_comments = &.{.{ .open = u("=begin"), .close = u("=end"), .line_start = true }},
    .strings = &.{
        .{ .open = u("\""), .close = u("\""), .multiline = true },
        .{ .open = u("'"), .close = u("'"), .multiline = true },
        .{ .open = u("`"), .close = u("`"), .multiline = true },
    },
    // Strict: only `<<~TAG`, `<<-TAG` or a quoted tag; `array << x` is safe.
    .heredoc = .strict,
    .declarations = &RUBY_DECLARATIONS,
};

pub const SQL_SYNTAX = Syntax{
    .name = "sql",
    .line_comments = &.{u("--")},
    .block_comments = &C_BLOCK,
    .strings = &.{
        // Postgres dollar quoting.
        .{ .open = u("$$"), .close = u("$$"), .escape = .none, .multiline = true },
        // Standard SQL doubles the quote to escape it.
        .{ .open = u("'"), .close = u("'"), .escape = .doubling },
        .{ .open = u("\""), .close = u("\""), .escape = .doubling },
        .{ .open = u("`"), .close = u("`"), .escape = .doubling },
    },
};

pub const SHELL_SYNTAX = Syntax{
    .name = "shell",
    .line_comments = &.{u("#")},
    .strings = &.{
        // Single quotes take no escapes at all in shell.
        .{ .open = u("'"), .close = u("'"), .escape = .none, .multiline = true },
        .{ .open = u("\""), .close = u("\""), .multiline = true },
        .{ .open = u("`"), .close = u("`"), .multiline = true },
    },
    .heredoc = .plain,
};

pub const VB_SYNTAX = Syntax{
    .name = "vb",
    .line_comments = &.{u("'")},
    .strings = &.{.{ .open = u("\""), .close = u("\""), .escape = .doubling }},
    .declarations = &VB_DECLARATIONS,
};

pub const HASKELL_SYNTAX = Syntax{
    .name = "haskell",
    .line_comments = &.{u("--")},
    // `{- -}` nests, and Haskell string gaps let a `"…"` span lines.
    .block_comments = &.{.{ .open = u("{-"), .close = u("-}"), .nested = true }},
    .strings = &.{
        .{ .open = u("\""), .close = u("\""), .multiline = true },
        .{ .open = u("'"), .close = u("'") },
    },
    .declarations = &HASKELL_DECLARATIONS,
    .annotations = &HASKELL_ANNOTATIONS,
};

// ---------------------------------------------------------------------------
// Data formats
// ---------------------------------------------------------------------------
//
// These have no members to search, but their comments and strings still have to
// be masked so a `#`/`;` inside a quoted value is never read as one (and so the
// key-based region rules read the right lines).

pub const YAML_SYNTAX = Syntax{
    .name = "yaml",
    .line_comments = &.{u("#")},
    .strings = &.{
        // YAML doubles a single quote, and both forms may fold across lines.
        .{ .open = u("\""), .close = u("\""), .multiline = true },
        .{ .open = u("'"), .close = u("'"), .escape = .doubling, .multiline = true },
    },
};

pub const TOML_SYNTAX = Syntax{
    .name = "toml",
    .line_comments = &.{u("#")},
    .strings = &.{
        // Multi-line basic and literal strings are three quotes.
        .{ .open = u("\"\"\""), .close = u("\"\"\""), .multiline = true },
        .{ .open = u("'''"), .close = u("'''"), .escape = .none, .multiline = true },
        .{ .open = u("\""), .close = u("\"") },
        .{ .open = u("'"), .close = u("'"), .escape = .none },
    },
};

pub const INI_SYNTAX = Syntax{
    .name = "ini",
    // `;` is the classic form; `#` is common too.
    .line_comments = &.{ u(";"), u("#") },
    .strings = &.{
        .{ .open = u("\""), .close = u("\""), .escape = .none },
        .{ .open = u("'"), .close = u("'"), .escape = .none },
    },
};

/// Every language, by the name `lexerFor` reports.
pub const TYPESCRIPT_SYNTAX = Syntax{
    .name = "typescript",
    .line_comments = &C_LINE,
    .block_comments = &C_BLOCK,
    .strings = JS_SYNTAX.strings,
};
