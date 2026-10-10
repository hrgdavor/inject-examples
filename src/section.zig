//! File-section matching — the Zig twin of `lib/section.mjs`.
//!
//! A reference (`#<name>`) is a slash-separated path of segments. Each segment
//! names something inside the scope the previous one selected: a `#region`
//! directive, a class-like or method declaration, a property, a statement's
//! condition literal, or a block marked by a leading comment. What comes back is
//! decided by the *scope modifier* on the last segment — the declaration, its
//! body alone (`-`), the declaration with its annotations (`+`), or those with
//! the doc comment above them (`++`).
//!
//! The language-specific half of a scan is injected as a lexer: what a lexer
//! owns is *lexical* — blanking comments and string literals, locating the
//! comments — plus the two places where a language spells a member differently
//! from the common shape (`declarations`, `annotations`). Structure, precedence
//! and rendering stay here so every engine agrees. When no lexer is supplied the
//! built-in mask and comment reader are used, and the language-neutral
//! declaration shapes apply.

const std = @import("std");
const Allocator = std.mem.Allocator;

const js = @import("js.zig");
const Str = js.Str;

const lexers = @import("scanner/lexers.zig");
const tokenizer = @import("scanner/tokenizer.zig");
const syntaxes = @import("scanner/syntaxes.zig");
const vectors = @import("section_vectors.zig");

/// The four readings a scope modifier asks for.
pub const Scope = enum { declaration, body, annotated, documented };

/// The scope modifiers, as slices that outlive any reference they are stored
/// in — the JS `-`, `+` and `++` spellings.
pub const MOD_NONE: Str = &js.lit("-");
pub const MOD_SINGLE: Str = &js.lit("+");
pub const MOD_DOUBLE: Str = &js.lit("++");

/// A JS `throw` carried out as a value, exactly as `Failure` does for
/// `index.mjs`: `message` is what the CLI prints. `grammar` marks a
/// `SectionReferenceError` — a malformed reference — so a caller can tell the
/// two apart without reading the message.
pub const Failure = struct {
    message: Str = &.{},
    include: bool = false,
    grammar: bool = false,

    pub fn set(self: *Failure, message: Str) error{Failed} {
        self.message = message;
        return error.Failed;
    }

    fn grammarMessage(self: *Failure, message: Str) error{Failed} {
        self.message = message;
        self.grammar = true;
        return error.Failed;
    }
};

pub const Error = error{ Failed, Grammar } || Allocator.Error;

// ===========================================================================
// Part A — the reference grammar
// ===========================================================================

/// A parsed reference, plus the contradiction warning a `+` against a `-`
/// raises (§11: it resolves to the wider reading, and the CLI reports it).
pub const Reference = struct {
    raw: Str,
    canonical: Str,
    segments: []Str,
    scope: Scope,
    warning: ?Warning = null,

    pub const Warning = struct {
        kind: WarningKind = .contradiction,
        kept: Str,
        dropped: Str,
        canonical: Str,
        message: Str,
    };
};

pub const WarningKind = enum { contradiction };

fn scopeFromModifier(modifier: ?Str) Scope {
    const text = modifier orelse return .declaration;
    if (js.eql(text, MOD_NONE)) return .body;
    if (js.eql(text, MOD_SINGLE)) return .annotated;
    return .documented;
}

const LeadingModifier = struct { modifier: ?Str, name: Str };

/// `extractLeadingModifier`: a leading `-`, `+` or `++` only modifies the last
/// segment; anywhere else it is an error.
fn extractLeadingModifier(
    alloc: Allocator,
    seg: Str,
    is_last: bool,
    raw: Str,
    failure: *Failure,
) Error!LeadingModifier {
    if (seg.len <= 1) return .{ .modifier = null, .name = seg };

    if (seg[0] == '-') {
        if (seg[1] == '-' or seg[1] == '+') return .{ .modifier = null, .name = seg };
        if (is_last) return .{ .modifier = seg[0..1], .name = seg[1..] };
        return failure.grammarMessage(try js.format(
            alloc,
            "\"-\" may only modify the last path segment of \"#{s}\"",
            .{@as(Str, raw)},
        ));
    }

    if (js.startsWith(seg, MOD_DOUBLE)) {
        if (seg.len > 2 and (seg[2] == '+' or seg[2] == '-')) return .{ .modifier = null, .name = seg };
        return failure.grammarMessage(try js.format(
            alloc,
            "\"++\" may only modify the last path segment of \"#{s}\"",
            .{@as(Str, raw)},
        ));
    }

    if (seg[0] == '+') {
        if (seg.len > 1 and (seg[1] == '+' or seg[1] == '-')) return .{ .modifier = null, .name = seg };
        return failure.grammarMessage(try js.format(
            alloc,
            "\"+\" may only modify the last path segment of \"#{s}\"",
            .{@as(Str, raw)},
        ));
    }

    return .{ .modifier = null, .name = seg };
}

const Trailing = struct { name: Str, tokens: []Str };

/// `extractTrailingModifier`: a run of `+`/`-` at the end of a name, tokenised
/// so `++` counts as one modifier and `-` as another.
fn extractTrailingModifier(alloc: Allocator, name: Str) !Trailing {
    var i = name.len;
    while (i > 0 and (name[i - 1] == '+' or name[i - 1] == '-')) i -= 1;
    if (i == name.len) return .{ .name = name, .tokens = &.{} };

    const run = name[i..];
    var tokens = std.ArrayList(Str).empty;
    var at: usize = 0;
    while (at < run.len) {
        if (at + 1 < run.len and run[at] == '+' and run[at + 1] == '+') {
            try tokens.append(alloc, run[at .. at + 2]);
            at += 2;
        } else if (run[at] == '+' or run[at] == '-') {
            try tokens.append(alloc, run[at .. at + 1]);
            at += 1;
        } else break;
    }
    return .{ .name = name[0..i], .tokens = try tokens.toOwnedSlice(alloc) };
}

/// `parseReference`: the grammar of `#<reference>`, its canonical spelling and
/// the contradiction warning.
pub fn parseReference(alloc: Allocator, raw: Str, failure: *Failure) Error!Reference {
    if (raw.len == 0) return failure.grammarMessage(try js.format(alloc, "\"#\" names nothing", .{}));

    var detached: ?Str = null;
    var remainder = raw;
    if (js.startsWith(raw, MOD_DOUBLE)) {
        detached = MOD_DOUBLE;
        remainder = raw[2..];
    } else if (js.startsWith(raw, MOD_SINGLE)) {
        detached = MOD_SINGLE;
        remainder = raw[1..];
    } else if (js.startsWith(raw, MOD_NONE)) {
        detached = MOD_NONE;
        remainder = raw[1..];
    }

    if (remainder.len == 0) {
        return failure.grammarMessage(try js.format(alloc, "\"#{s}\" names nothing", .{raw}));
    }

    const parts = try splitSlash(alloc, remainder);
    for (parts) |part| {
        if (part.len == 0) {
            return failure.grammarMessage(try js.format(alloc, "\"#{s}\" has an empty path segment", .{raw}));
        }
    }
    if (parts.len > 8) {
        return failure.grammarMessage(try js.format(alloc, "\"#{s}\" is deeper than 8 sections", .{raw}));
    }

    var detached_second: ?Str = null;
    if (detached == null and parts.len == 2) {
        const second = parts[1];
        if (second.len > 1 and second[0] == '-' and second[1] != '-' and second[1] != '+') {
            detached_second = MOD_NONE;
            parts[1] = second[1..];
        }
    }

    var all_modifiers = std.ArrayList(Str).empty;
    var clean = std.ArrayList(Str).empty;

    for (parts, 0..) |seg, index| {
        const is_last = index == parts.len - 1;
        const leading = try extractLeadingModifier(alloc, seg, is_last, raw, failure);
        if (leading.modifier) |modifier| try all_modifiers.append(alloc, modifier);

        const trailing = try extractTrailingModifier(alloc, leading.name);
        for (trailing.tokens) |token| try all_modifiers.append(alloc, token);

        const name = trailing.name;
        if (js.indexOfUnit(name, '+') != null or js.indexOfUnit(name, '-') != null) {
            // A bare name (one segment, nothing detached) keeps the legacy
            // meaning: a `#region` name may contain `-`. Any `+`, or a hyphen
            // inside a multi-segment path, is structure, never part of a name.
            const legacy = parts.len == 1 and detached == null and detached_second == null and
                js.indexOfUnit(name, '+') == null;
            if (!legacy) {
                const ch = if (js.indexOfUnit(name, '+') != null) MOD_SINGLE else MOD_NONE;
                return failure.grammarMessage(try js.format(
                    alloc,
                    "\"{s}\" may only modify the last path segment of \"#{s}\"",
                    .{ @as(Str, ch), @as(Str, raw) },
                ));
            }
        }
        try clean.append(alloc, name);
    }

    for (clean.items) |name| {
        if (name.len == 0) {
            return failure.grammarMessage(try js.format(alloc, "\"#{s}\" has an empty path segment", .{raw}));
        }
    }

    // The detached modifiers lead; the trailing run follows.
    var ordered = std.ArrayList(Str).empty;
    if (detached_second) |modifier| try ordered.append(alloc, modifier);
    if (detached) |modifier| try ordered.append(alloc, modifier);
    for (all_modifiers.items) |modifier| try ordered.append(alloc, modifier);

    var modifier: ?Str = null;
    var warning: ?Reference.Warning = null;

    if (ordered.items.len == 1) {
        modifier = ordered.items[0];
    } else if (ordered.items.len > 1) {
        var positives: usize = 0;
        var negatives: usize = 0;
        for (ordered.items) |entry| {
            if (entry[0] == '+') positives += 1 else negatives += 1;
        }
        if (positives > 1 or negatives > 1) {
            return failure.grammarMessage(try js.format(alloc, "\"#{s}\" carries more than one modifier", .{@as(Str, raw)}));
        }
        var has_double = false;
        var has_single = false;
        for (ordered.items) |entry| {
            if (js.eql(entry, MOD_DOUBLE)) has_double = true;
            if (js.eql(entry, MOD_SINGLE)) has_single = true;
        }
        // The modifiers are named constants, not `&lit(…)` pointers, so they
        // live as long as the reference they are stored in.
        if (has_double) {
            modifier = MOD_DOUBLE;
            warning = .{ .kept = MOD_DOUBLE, .dropped = MOD_NONE, .canonical = &.{}, .message = &.{} };
        } else if (has_single) {
            modifier = MOD_SINGLE;
            warning = .{ .kept = MOD_SINGLE, .dropped = MOD_NONE, .canonical = &.{}, .message = &.{} };
        } else {
            return failure.grammarMessage(try js.format(alloc, "\"#{s}\" carries more than one modifier", .{@as(Str, raw)}));
        }
    }

    var canonical = std.ArrayList(u16).empty;
    for (clean.items, 0..) |name, index| {
        if (index > 0) try canonical.append(alloc, '/');
        try canonical.appendSlice(alloc, name);
    }
    if (modifier) |text| try canonical.appendSlice(alloc, text);
    const canonical_owned = try canonical.toOwnedSlice(alloc);

    if (warning) |*w| {
        w.canonical = canonical_owned;
        w.message = try js.format(
            alloc,
            "\"{s}\" contradicts \"{s}\"; using \"#{s}\"",
            .{ w.kept, w.dropped, canonical_owned },
        );
    }

    return .{
        .raw = raw,
        .canonical = canonical_owned,
        .segments = try clean.toOwnedSlice(alloc),
        .scope = scopeFromModifier(modifier),
        .warning = warning,
    };
}

/// `remainder.split('/')` — never empty; the parts are the caller's to mutate.
fn splitSlash(alloc: Allocator, text: Str) ![]Str {
    var parts = std.ArrayList(Str).empty;
    var start: usize = 0;
    while (js.indexOfUnit(text[start..], '/')) |offset| {
        try parts.append(alloc, text[start .. start + offset]);
        start += offset + 1;
    }
    try parts.append(alloc, text[start..]);
    return parts.toOwnedSlice(alloc);
}

// ===========================================================================
// Part A2 — the built-in engine (the language-agnostic union)
// ===========================================================================

fn endOfLine(text: Str, offset: usize) usize {
    const newline = js.indexOfUnit(text[offset..], '\n') orelse return text.len;
    return offset + newline;
}

fn blankSlice(target: []u16, from: usize, to: usize) void {
    var i = from;
    while (i < to and i < target.len) : (i += 1) {
        if (target[i] != '\n') target[i] = ' ';
    }
}

fn matchesAt(text: Str, at: usize, unit: u16, count: usize) bool {
    var index: usize = 0;
    while (index < count) : (index += 1) {
        if (at + index >= text.len or text[at + index] != unit) return false;
    }
    return true;
}

/// `masked`: every comment and string literal blanked to spaces, newlines kept,
/// so a brace inside one cannot be mistaken for the end of a body.
///
/// `#` opens a line comment except before `[`, which keeps a Rust attribute
/// (`#[derive(Debug)]`) readable while hiding a Python or shell comment.
pub fn masked(alloc: Allocator, text: Str) ![]u16 {
    const out = try alloc.dupe(u16, text);

    var i: usize = 0;
    while (i < text.len) {
        const unit = text[i];
        const next: u16 = if (i + 1 < text.len) text[i + 1] else 0;
        if (unit == '/' and next == '/') {
            const end = endOfLine(text, i);
            blankSlice(out, i, end);
            i = end;
        } else if (unit == '/' and next == '*') {
            const close = js.indexOf(text[i + 2 ..], &js.lit("*/"));
            const end = if (close) |offset| i + 2 + offset + 2 else text.len;
            blankSlice(out, i, end);
            i = end;
        } else if (unit == '#' and next != '[') {
            const end = endOfLine(text, i);
            blankSlice(out, i, end);
            i = end;
        } else if (unit == '"' or unit == '\'' or unit == '`') {
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
            blankSlice(out, i, end);
            i = end;
        } else {
            i += 1;
        }
    }
    return out;
}

/// `commentsIn`: comment-only spans, with the `//` or `/*` delimiters stripped.
/// Does not report comment markers that sit inside string literals.
pub fn commentsIn(alloc: Allocator, text: Str) ![]Comment {
    var result = std.ArrayList(Comment).empty;

    var i: usize = 0;
    while (i < text.len) {
        const unit = text[i];
        const next: u16 = if (i + 1 < text.len) text[i + 1] else 0;

        if (unit == '/' and next == '/') {
            const end = endOfLine(text, i);
            try result.append(alloc, .{ .text = text[i + 2 .. end], .from = i, .to = end });
            i = end;
        } else if (unit == '/' and next == '*') {
            const close = js.indexOf(text[i + 2 ..], &js.lit("*/"));
            const end = if (close) |offset| i + 2 + offset + 2 else text.len;
            const body_end = if (close) |offset| i + 2 + offset else end;
            try result.append(alloc, .{ .text = text[i + 2 .. body_end], .from = i, .to = end });
            i = end;
        } else if (unit == '"' or unit == '\'' or unit == '`') {
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
            i = @min(j, text.len);
        } else {
            i += 1;
        }
    }
    return result.toOwnedSlice(alloc);
}

/// One comment, its body and its extent in the source.
pub const Comment = struct {
    text: Str,
    from: usize,
    to: usize,
};

// ===========================================================================
// Part B — the block scanner
// ===========================================================================

/// A body span, or null when the member has no body to inject (an interface or
/// `abstract` method).
pub const Span = struct {
    open: ?usize = null,
    close: ?usize = null,
    open_line: ?usize = null,
    close_line: ?usize = null,
    body_end_line: ?usize = null,
    indented: bool = false,
    expression: ?usize = null,
};

pub const Kind = enum { root, class, method, property, statement, anchor };

/// The name a leading comment gives a block, and the line it sits on.
pub const Anchor = struct { name: Str, line: usize };

/// One entry of a scan's anchor index: the block a comment names, and where.
pub const AnchorEntry = struct { name: Str, line: usize, block: *Block };

pub const Conditions = struct { exact: []Str, pasted: []Str };

pub const Block = struct {
    kind: Kind,
    name: ?Str,
    decl_line: usize,
    open: ?usize = null,
    close: ?usize = null,
    open_line: ?usize = null,
    close_line: ?usize = null,
    indented: bool = false,
    expression: ?usize = null,
    end_line: ?usize = null,
    single_line: bool = false,
    shared_close: bool = false,
    children: std.ArrayList(*Block) = .empty,
    regions: std.ArrayList(Region) = .empty,
    anchor: ?Anchor = null,
    conditions: ?Conditions = null,
};

pub const Region = struct {
    name: Str,
    start_line: usize,
    end_line: usize,
};

/// A line read as a region directive.
pub const DirectiveKind = enum { region, endregion };
pub const Directive = struct { kind: DirectiveKind, name: Str };

/// The lexical facts one scan needs, built once.
pub const Facts = struct {
    alloc: Allocator,
    source: Str,
    lines: []const Str,
    starts: []const usize,
    mask: []const u16,
    mask_lines: []const Str,
    comments: []const Comment,
    /// The language's own declaration shapes, checked before the generic ones.
    declarations: []const syntaxes.Declaration = &.{},
    annotations: []const syntaxes.Annotation = &.{},
};

pub const Scan = struct {
    root: *Block,
    blocks: []*Block,
    regions: []Region,
    anchors: []AnchorEntry,
    facts: Facts,
};

/// Build the mask, the comment spans and the per-line views in one pass.
pub fn makeFacts(alloc: Allocator, source: Str, lexer: ?lexers.Lexer) !Facts {
    const lines = try js.splitLines(alloc, source);
    const starts = try alloc.alloc(usize, lines.len);
    var offset: usize = 0;
    for (lines, 0..) |line, index| {
        starts[index] = offset;
        offset += line.len + 1;
    }

    var mask: []u16 = undefined;
    var comments: []Comment = undefined;
    var declarations: []const syntaxes.Declaration = &.{};
    var annotations: []const syntaxes.Annotation = &.{};
    if (lexer) |lex| {
        const lexed = try tokenizer.tokenize(alloc, source, lex.syntax);
        mask = lexed.masked;
        comments = try alloc.alloc(Comment, lexed.comments.len);
        for (lexed.comments, 0..) |comment, index| {
            comments[index] = .{ .text = comment.text, .from = comment.from, .to = comment.to };
        }
        declarations = lex.syntax.declarations;
        annotations = lex.syntax.annotations;
    } else {
        mask = try masked(alloc, source);
        comments = try commentsIn(alloc, source);
    }

    // The mask invariant: same length, every newline at the same offset. The
    // JS side throws when a lexer breaks it; here it would silently mis-resolve,
    // so it is asserted too.
    std.debug.assert(mask.len == source.len);
    for (source, 0..) |unit, index| {
        if (unit == '\n') std.debug.assert(mask[index] == '\n');
    }

    return .{
        .alloc = alloc,
        .source = source,
        .lines = lines,
        .starts = starts,
        .mask = mask,
        .mask_lines = try js.splitLines(alloc, mask),
        .comments = comments,
        .declarations = declarations,
        .annotations = annotations,
    };
}

/// Scan a source for blocks and the indexable things in each scope.
pub fn scanBlocks(alloc: Allocator, text: Str, lexer: ?lexers.Lexer) Error!Scan {
    const source = try js.crlfToLf(alloc, text);
    const facts = try makeFacts(alloc, source, lexer);
    return scanFacts(facts);
}

pub fn scanFacts(facts: Facts) Error!Scan {
    const alloc = facts.alloc;
    var build = Build{ .facts = facts };
    var anchors = std.ArrayList(AnchorEntry).empty;

    const root = try alloc.create(Block);
    root.* = makeBlock(.root, null, 0);
    const top = try build.buildScope(0, facts.lines.len - 1);
    for (top) |child| try root.children.append(alloc, child);

    const pairs = try pairRegions(alloc, facts.lines);
    for (pairs) |region| try root.regions.append(alloc, region);
    for (build.blocks.items) |block| {
        if (block.anchor) |anchor| {
            try anchors.append(alloc, .{ .line = anchor.line, .name = anchor.name, .block = block });
        }
    }

    const region_list = root.regions.items;
    return .{
        .root = root,
        .blocks = try build.blocks.toOwnedSlice(alloc),
        // `root.regions` stays the live list: `toOwnedSlice` would empty it,
        // and `root` is the one block the resolver reads regions from.
        .regions = region_list,
        .anchors = try anchors.toOwnedSlice(alloc),
        .facts = facts,
    };
}

fn makeBlock(kind: Kind, name: ?Str, decl_line: usize) Block {
    return .{ .kind = kind, .name = name, .decl_line = decl_line };
}

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
    return line.len - js.trimStart(line).len;
}

fn nextNonBlank(lines: []const Str, from: usize) ?usize {
    var index = from;
    while (index < lines.len) : (index += 1) {
        if (js.trim(lines[index]).len != 0) return index;
    }
    return null;
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

fn braceBody(mask: Str, starts: []const usize, open: usize) ?Span {
    const close = matchingBracket(mask, open, '}') orelse return null;
    return .{
        .open = open,
        .close = close,
        .open_line = lineOf(starts, open),
        .close_line = lineOf(starts, close),
    };
}

fn bodySpan(
    mask: Str,
    lines: []const Str,
    starts: []const usize,
    decl_line: usize,
    header_from: usize,
) ?Span {
    const line_end = endOfLine(mask, starts[decl_line]);
    const rest = mask[header_from..@max(header_from, line_end)];

    // The earliest of `{`, `;` and `=>`.
    const Terminator = struct { at: usize, kind: enum { brace, none, arrow } };
    var candidates: [3]Terminator = undefined;
    var count: usize = 0;
    if (js.indexOf(rest, &js.lit("{"))) |at| {
        candidates[count] = .{ .at = at, .kind = .brace };
        count += 1;
    }
    if (js.indexOf(rest, &js.lit(";"))) |at| {
        candidates[count] = .{ .at = at, .kind = .none };
        count += 1;
    }
    if (js.indexOf(rest, &js.lit("=>"))) |at| {
        candidates[count] = .{ .at = at, .kind = .arrow };
        count += 1;
    }
    const terminators = candidates[0..count];
    std.mem.sort(Terminator, terminators, {}, struct {
        fn lessThan(_: void, left: Terminator, right: Terminator) bool {
            return left.at < right.at;
        }
    }.lessThan);

    if (terminators.len == 0) {
        const next = nextNonBlank(lines, decl_line + 1) orelse return null;
        if (js.startsWith(js.trimStart(lines[next]), &js.lit("{"))) {
            const brace = js.indexOfUnit(lines[next], '{').?;
            return braceBody(mask, starts, starts[next] + brace);
        }
        const indent = indentWidth(lines[decl_line]);
        if (indentWidth(lines[next]) > indent) {
            var end = next;
            var index = next + 1;
            while (index < lines.len) : (index += 1) {
                if (js.trim(lines[index]).len == 0) continue;
                if (indentWidth(lines[index]) <= indent) break;
                end = index;
            }
            return .{ .indented = true, .body_end_line = end };
        }
        return null;
    }

    const first = terminators[0];
    if (first.kind == .none) return null;
    if (first.kind == .arrow) {
        const after = rest[first.at + 2 ..];
        if (js.indexOfUnit(after, '{')) |offset| {
            return braceBody(mask, starts, header_from + first.at + 2 + offset);
        }
        return .{ .expression = header_from + first.at + 2 };
    }
    return braceBody(mask, starts, header_from + first.at);
}

/// A body closed by a terminator keyword line (`end` in Ruby, `End` in VB),
/// found by indentation: the first line at or left of the declaration's
/// indentation whose trimmed text is the terminator closes the block.
fn keywordBody(lines: []const Str, decl_line: usize, word: Str) ?struct { open_line: usize, close_line: usize } {
    const indent = indentWidth(lines[decl_line]);
    var index = decl_line + 1;
    while (index < lines.len) : (index += 1) {
        const text = js.trim(lines[index]);
        if (text.len == 0) continue;
        if (indentWidth(lines[index]) > indent) continue;
        if (js.eql(text, word)) return .{ .open_line = decl_line, .close_line = index };
        if (text.len > word.len and js.startsWith(text, word) and js.isWhitespace(text[word.len])) {
            return .{ .open_line = decl_line, .close_line = index };
        }
        return null; // a dedent that is not the terminator
    }
    return null;
}

// --- the generic name shapes ------------------------------------------------

const NOT_A_NAME = [_][]const u8{
    "if",   "for",  "while",  "switch",     "catch", "return", "new",
    "do",   "else", "throw",  "await",      "yield", "typeof", "delete",
    "void", "in",   "of",     "instanceof", "super", "this",   "with",
    "case", "when", "sizeof",
};

fn isNotAName(name: Str) bool {
    for (NOT_A_NAME) |word| {
        if (js.eqlBytes(name, word)) return true;
    }
    return false;
}

const NOT_A_TYPE = [_][]const u8{
    "return", "throw", "new", "else", "do", "case", "await", "yield", "delete", "typeof",
};

const STATEMENT_BEFORE = [_][]const u8{
    "return", "throw", "new", "await", "yield", "delete", "typeof", "case", "else", "do",
};

fn startsWithStatementBefore(text: Str) bool {
    const trimmed = js.trimStart(text);
    for (STATEMENT_BEFORE) |word| {
        if (js.startsWithBytes(trimmed, word) and js.isWordBoundary(trimmed, word.len)) return true;
    }
    return false;
}

/// `/^[\w$<>\[\],.?*&:@\s]*$/` — what a declaration's prefix may look like.
fn isDeclarationPrefix(text: Str) bool {
    for (text) |unit| {
        const ok = js.isAsciiWord(unit) or unit == '$' or unit == '<' or unit == '>' or
            unit == '[' or unit == ']' or unit == ',' or unit == '.' or unit == '?' or
            unit == '*' or unit == '&' or unit == ':' or unit == '@' or js.isWhitespace(unit);
        if (!ok) return false;
    }
    return true;
}

const DECLARATION_KEYWORDS = [_][]const u8{
    "class", "interface", "enum", "record", "struct", "trait", "object", "union",
};

const KeywordMatch = struct { name: Str, index: usize, length: usize };

/// `\b(?:class|interface|…)\s+([A-Za-z_$][\w$]*)\b`.
fn matchDeclarationKeyword(line: Str) ?KeywordMatch {
    var at: usize = 0;
    while (at < line.len) : (at += 1) {
        if (!js.isWordBoundary(line, at)) continue;
        for (DECLARATION_KEYWORDS) |word| {
            if (!js.startsWithBytes(line[at..], word)) continue;
            if (!js.isWordBoundary(line, at + word.len)) continue;
            var scan = at + word.len;
            if (scan >= line.len or !js.isWhitespace(line[scan])) continue;
            while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
            if (scan >= line.len or !js.isIdentStart(line[scan])) continue;
            const start = scan;
            scan += 1;
            while (scan < line.len and js.isIdentPart(line[scan])) scan += 1;
            return .{ .name = line[start..scan], .index = at, .length = scan - at };
        }
    }
    return null;
}

const CallMatch = struct { name_at: usize, paren: usize };

/// `(^|[^\w$.])name\s*\(` — the next call-shaped mention of `name`, from `from`.
fn nextCallMatch(line: Str, name: Str, from: usize) ?CallMatch {
    if (name.len == 0) return null;
    var at = from;
    while (js.indexOf(line[at..], name)) |offset| {
        const start = at + offset;
        at = start + 1;
        if (start > 0 and (js.isAsciiWord(line[start - 1]) or line[start - 1] == '$' or line[start - 1] == '.')) continue;
        const after = start + name.len;
        if (after < line.len and (js.isAsciiWord(line[after]) or line[after] == '$')) continue;
        var scan = after;
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        if (scan < line.len and line[scan] == '(') return .{ .name_at = start, .paren = scan };
    }
    return null;
}

const AssignedMatch = struct { end: usize };

/// `(^|[^\w$.])(?:const\s+|let\s+|var\s+)?name\b(?:\s*:\s*[^=\n]+)?\s*=\s*(?:async\s+)?`.
fn nextAssignedMatch(line: Str, name: Str, from: usize) ?AssignedMatch {
    if (name.len == 0) return null;
    var at = from;
    while (js.indexOf(line[at..], name)) |offset| {
        const start = at + offset;
        at = start + 1;
        if (start > 0 and (js.isAsciiWord(line[start - 1]) or line[start - 1] == '$' or line[start - 1] == '.')) continue;
        const after = start + name.len;
        if (after < line.len and js.isAsciiWord(line[after])) continue;

        var scan = after;
        // An optional type annotation, `: Type`, and never a newline.
        if (scan < line.len and line[scan] == ':') {
            scan += 1;
            while (scan < line.len and line[scan] != '=' and line[scan] != '\n') scan += 1;
        }
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        if (scan >= line.len or line[scan] != '=') continue;
        if (scan + 1 < line.len and line[scan + 1] == '=') continue;
        scan += 1;
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        const async_kw = &js.lit("async");
        if (js.startsWith(line[scan..], async_kw) and js.isWordBoundary(line, scan + async_kw.len)) {
            scan += async_kw.len;
            while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        }
        return .{ .end = scan };
    }
    return null;
}

const Declaration = struct {
    kind: Kind,
    name: Str,
    header_from: usize,
};

/// Whether a masked line declares `name`, and where its header ends.
fn declarationOn(
    alloc: Allocator,
    masked_line: Str,
    start: usize,
    name: Str,
    declarations: []const syntaxes.Declaration,
) !?Declaration {
    if (name.len == 0 or isNotAName(name)) return null;

    for (declarations) |entry| {
        const hit = entry.match(masked_line) orelse continue;
        if (!js.eql(hit.name, name)) continue;
        return .{
            .kind = switch (entry.kind) {
                .class => .class,
                .method => .method,
                .property => .property,
            },
            .name = name,
            .header_from = start + hit.header_from,
        };
    }

    if (matchDeclarationKeyword(masked_line)) |keyword| {
        if (js.eql(keyword.name, name)) {
            return .{ .kind = .class, .name = name, .header_from = start + keyword.index + keyword.length };
        }
    }

    var from: usize = 0;
    while (nextCallMatch(masked_line, name, from)) |hit| {
        from = hit.name_at + 1;
        const before = masked_line[0..hit.name_at];
        // A Go receiver, `func (c *Cart) Add(...)`, belongs to the declaration
        // but not to the name.
        const prefix = try withFuncReceiver(alloc, before);
        if (prefix.len != 0 and (!isDeclarationPrefix(prefix) or startsWithStatementBefore(prefix))) continue;
        const close = matchingBracket(masked_line, hit.paren, ')') orelse continue;
        return .{ .kind = .method, .name = name, .header_from = start + close + 1 };
    }

    from = 0;
    while (nextAssignedMatch(masked_line, name, from)) |hit| {
        from = hit.end;
        const rest = masked_line[hit.end..];
        const arrow = js.indexOf(rest, &js.lit("=>"));
        const keyword = functionKeywordEnd(rest);
        if (arrow != null and (keyword == null or arrow.? < keyword.?)) {
            return .{ .kind = .method, .name = name, .header_from = start + hit.end + arrow.? };
        }
        if (keyword) |end| return .{ .kind = .method, .name = name, .header_from = start + hit.end + end };
    }
    return null;
}

/// `before.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ')`.
fn withFuncReceiver(alloc: Allocator, before: Str) !Str {
    const trimmed = js.trim(before);
    const func = &js.lit("func");
    if (!js.startsWith(trimmed, func)) return trimmed;
    var at = func.len;
    while (at < trimmed.len and js.isWhitespace(trimmed[at])) at += 1;
    if (at >= trimmed.len or trimmed[at] != '(') return trimmed;
    const close = matchingBracket(trimmed, at, ')') orelse return trimmed;
    var after = close + 1;
    while (after < trimmed.len and js.isWhitespace(trimmed[after])) after += 1;
    return js.concat(alloc, &.{ trimmed[0..func.len], trimmed[after..] });
}

/// `/^function\b/`'s end offset.
fn functionKeywordEnd(text: Str) ?usize {
    const keyword = &js.lit("function");
    if (!js.startsWith(text, keyword)) return null;
    if (!js.isWordBoundary(text, keyword.len)) return null;
    return keyword.len;
}

const STATEMENT_KEYWORDS = [_][]const u8{
    "if", "else", "for", "while", "do", "switch", "try", "catch", "finally", "synchronized",
};

const StatementHit = struct { keyword: []const u8, index: usize };

fn matchStatementKeyword(line: Str) ?StatementHit {
    var at: usize = 0;
    while (at < line.len) : (at += 1) {
        if (!js.isWordBoundary(line, at)) continue;
        for (STATEMENT_KEYWORDS) |word| {
            if (!js.startsWithBytes(line[at..], word)) continue;
            if (!js.isWordBoundary(line, at + word.len)) continue;
            return .{ .keyword = word, .index = at };
        }
    }
    return null;
}

/// `PROPERTY_DECL`: `Type name = …`, `static final Type name = …`,
/// `const name = …`. A `const`/`let`/`var` needs no type; otherwise at least
/// one type token must precede the name, which keeps body assignments out.
const Property = struct { name: Str, match_end: usize, typed_head: bool, type_word: Str };

fn matchProperty(line: Str) ?Property {
    var at: usize = 0;
    while (at < line.len) : (at += 1) {
        if (at > 0 and line[at - 1] == '.') continue;
        if (!js.isIdentStart(line[at])) continue;
        const name_start = at;
        at += 1;
        while (at < line.len and js.isIdentPart(line[at])) at += 1;
        const name = line[name_start..at];

        var scan = at;
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        if (scan >= line.len or line[scan] != '=') continue;
        // `=(?!=)`: a `==` comparison is not a declaration.
        if (scan + 1 < line.len and line[scan + 1] == '=') continue;

        const head = js.trim(line[0..name_start]);
        var typed = false;
        var type_word: Str = &.{};
        if (head.len != 0) {
            // A `const`/`let`/`var` head needs no type; anything else must be
            // a run of type tokens.
            if (headKeyword(head) != null) {
                type_word = head;
            } else {
                if (!isTypeRun(head)) continue;
                typed = true;
                type_word = firstWord(head);
            }
        }
        return .{ .name = name, .match_end = scan, .typed_head = typed, .type_word = type_word };
    }
    return null;
}

/// `const `/`let `/`var ` at the head, when the head is exactly that.
fn headKeyword(head: Str) ?[]const u8 {
    const keywords = [_][]const u8{ "const", "let", "var" };
    for (keywords) |word| {
        if (!js.startsWithBytes(head, word)) continue;
        if (head.len == word.len) return word;
        if (js.isWhitespace(head[word.len]) and js.trim(head[word.len..]).len == 0) return word;
    }
    return null;
}

fn firstWord(text: Str) Str {
    var at: usize = 0;
    while (at < text.len and !js.isWhitespace(text[at])) at += 1;
    return text[0..at];
}

/// Whether the head is `Type`, `Type Type`, `Type<T>`, `Type<T> Type<U>` — the
/// shape `((?:[\w$]+(?:<[^<>]*>)?)(?:\s+[\w$]+(?:<[^<>]*>)?)*?)` accepts.
fn isTypeRun(head: Str) bool {
    var at: usize = 0;
    var tokens: usize = 0;
    while (at < head.len) {
        if (!js.isAsciiWord(head[at]) and head[at] != '$') return false;
        at += 1;
        while (at < head.len and (js.isAsciiWord(head[at]) or head[at] == '$')) at += 1;
        tokens += 1;
        if (at < head.len and head[at] == '<') {
            const close = js.indexOfUnit(head[at..], '>') orelse return false;
            for (head[at + 1 .. at + close]) |unit| {
                if (unit == '<' or unit == '>') return false;
            }
            at += close + 1;
        }
        if (at >= head.len) break;
        if (!js.isWhitespace(head[at])) return false;
        while (at < head.len and js.isWhitespace(head[at])) at += 1;
        if (at >= head.len) return false;
    }
    return tokens > 0;
}

// --- buildScope -------------------------------------------------------------

const Build = struct {
    // The scala of one scan: the lexical facts, the flat block list every
    // built block is registered in, and the recursive walk that builds them.
    facts: Facts,
    blocks: std.ArrayList(*Block) = .empty,

    fn buildScope(self: *Build, from_line: usize, to_line: usize) Error![]*Block {
        const alloc = self.facts.alloc;
        var list = std.ArrayList(*Block).empty;

        var i = from_line;
        while (i <= to_line) {
            const mask_line = self.facts.mask_lines[i];
            if (js.trim(mask_line).len == 0) {
                i += 1;
                continue;
            }
            const start = self.facts.starts[i];

            // The language's own declaration shapes first: they are more specific
            // than the generic ones (Ruby `def name`, a Haskell binding).
            if (try declaredHere(self, mask_line, i, start, &list)) |last_end| {
                i = last_end + 1;
                continue;
            }

            if (matchDeclarationKeyword(mask_line)) |keyword| {
                if (!isNotAName(keyword.name)) {
                    const header_from = start + keyword.index + keyword.length;
                    const span = bodySpan(self.facts.mask, self.facts.lines, self.facts.starts, i, header_from);
                    const block = try alloc.create(Block);
                    block.* = makeBlock(.class, keyword.name, i);
                    applySpan(block, span);
                    applyAnchor(self, block, if (span) |found| found.open else null);
                    try register(self, &list, block);
                    try descend(self, block, i, span);
                    i = endLineOf(span, i) + 1;
                    continue;
                }
            }

            if (try methodDeclOn(self, mask_line, i, start)) |found| {
                const span = bodySpan(self.facts.mask, self.facts.lines, self.facts.starts, i, found.header_from);
                const block = try alloc.create(Block);
                block.* = makeBlock(.method, found.name, i);
                applySpan(block, span);
                applyAnchor(self, block, if (span) |found_span| found_span.open else null);
                try register(self, &list, block);
                try descend(self, block, i, span);
                i = endLineOf(span, i) + 1;
                continue;
            }

            if (matchStatementKeyword(mask_line)) |stmt| {
                if (js.indexOfUnit(self.facts.mask[start..], '{')) |brace_offset| {
                    const brace_pos = start + brace_offset;
                    const segments = try chainSegments(
                        alloc,
                        self.facts.mask,
                        self.facts.starts,
                        i,
                        stmt.keyword,
                        brace_pos,
                        stmt.index,
                    );
                    var last_close_line = i;
                    for (segments) |seg| {
                        const block = try alloc.create(Block);
                        block.* = makeBlock(.statement, null, seg.header_line);
                        block.open = seg.open;
                        block.close = seg.close;
                        block.open_line = seg.open_line;
                        block.close_line = seg.close_line;
                        block.shared_close = seg.shared_close;
                        block.end_line = seg.close_line;

                        const hdr_start = self.facts.starts[seg.header_line];
                        const hdr_end = endOfLine(self.facts.mask, hdr_start);
                        block.conditions = try conditionLiterals(alloc, self.facts.source[hdr_start..hdr_end], seg.cond_offset);

                        applyAnchor(self, block, seg.open);
                        try register(self, &list, block);
                        try descend(self, block, seg.header_line, .{
                            .open_line = seg.open_line,
                            .close_line = seg.close_line,
                        });
                        if (seg.close_line > last_close_line) last_close_line = seg.close_line;
                    }
                    i = last_close_line + 1;
                    continue;
                }
            }

            if (matchProperty(mask_line)) |prop| {
                if (!isNotAName(prop.name) and !startsWithStatementBefore(mask_line[0..prop.match_end])) {
                    const skip = prop.typed_head and prop.type_word.len > 0 and isNotAType(prop.type_word);
                    if (!skip) {
                        const block = try alloc.create(Block);
                        block.* = makeBlock(.property, prop.name, i);
                        try register(self, &list, block);
                        i += 1;
                        continue;
                    }
                }
            }

            i += 1;
        }
        return list.toOwnedSlice(alloc);
    }
};

/// The language's own declaration shapes on one line, when it has any.
/// Returns the last line the declarations occupied, so the caller can resume
/// after them, or null when the line carries none.
fn declaredHere(
    self: *Build,
    mask_line: Str,
    line: usize,
    start: usize,
    list: *std.ArrayList(*Block),
) Error!?usize {
    const alloc = self.facts.alloc;
    if (self.facts.declarations.len == 0) return null;

    // `declarations(maskedLine)` reports every descriptor that matches, in
    // table order; the descriptor is carried alongside the hit so the body rule
    // (`end`, `line`) travels with it.
    const Hit = struct { entry: syntaxes.Declaration, hit: syntaxes.Declaration.DeclMatch };
    var hits = std.ArrayList(Hit).empty;
    for (self.facts.declarations) |entry| {
        const hit = entry.match(mask_line) orelse continue;
        if (hit.name.len == 0 or isNotAName(hit.name)) continue;
        try hits.append(alloc, .{ .entry = entry, .hit = hit });
    }
    if (hits.items.len == 0) return null;

    var last_end = line;
    for (hits.items) |found| {
        const entry = found.entry;
        const span: ?Span = if (entry.end_kw) |word| blk: {
            const body = keywordBody(self.facts.lines, line, word) orelse break :blk null;
            break :blk Span{ .open_line = body.open_line, .close_line = body.close_line };
        } else bodySpan(self.facts.mask, self.facts.lines, self.facts.starts, line, start + found.hit.header_from);

        const block = try alloc.create(Block);
        block.* = makeBlock(switch (entry.kind) {
            .class => .class,
            .method => .method,
            .property => .property,
        }, found.hit.name, line);

        if (span) |value| {
            applySpan(block, value);
        } else if (entry.line) {
            block.end_line = line;
            block.single_line = true;
        } else {
            continue; // nothing to inject
        }
        applyAnchor(self, block, if (span) |value| value.open else null);
        try register(self, list, block);
        try descend(self, block, line, span);
        const end = endLineOf(span, line);
        if (end > last_end) last_end = end;
    }
    return last_end;
}

fn isNotAType(word: Str) bool {
    for (NOT_A_TYPE) |entry| {
        if (js.eqlBytes(word, entry)) return true;
    }
    return false;
}

/// The method/function reader of `buildScope`: a `name(` declaration, or an
/// assignment that defines a function.
fn methodDeclOn(self: *Build, mask_line: Str, line: usize, start: usize) Error!?Declaration {
    const alloc = self.facts.alloc;

    // A bare `name(` mention: the generic scan picks the name, `declarationOn`
    // confirms it and the body decides whether it is a call or a declaration.
    var at: usize = 0;
    while (at < mask_line.len) : (at += 1) {
        if (at > 0 and (js.isAsciiWord(mask_line[at - 1]) or mask_line[at - 1] == '$' or mask_line[at - 1] == '.')) continue;
        if (!js.isIdentStart(mask_line[at])) continue;
        const name_start = at;
        var scan = at + 1;
        while (scan < mask_line.len and js.isIdentPart(mask_line[scan])) scan += 1;
        const name = mask_line[name_start..scan];
        at = scan - 1;
        if (isNotAName(name)) continue;

        const prefix = try withFuncReceiver(alloc, mask_line[0..name_start]);
        if (prefix.len != 0 and (!isDeclarationPrefix(prefix) or startsWithStatementBefore(prefix))) continue;

        const found = (try declarationOn(alloc, mask_line, start, name, self.facts.declarations)) orelse continue;
        if (found.kind != .method) continue;

        const is_call = if (nextCallMatch(mask_line, name, name_start)) |hit| hit.name_at == name_start else false;
        // A bare `foo();` call is not a declaration; an assigned function
        // carries a prefix (the `=`), so it always counts.
        if (is_call and prefix.len == 0) {
            if (bodySpan(self.facts.mask, self.facts.lines, self.facts.starts, line, found.header_from) == null) continue;
        }
        return found;
    }

    // The assigned form: `const name = (…) => …`, `name = function …`.
    var assigned_from: usize = 0;
    while (assignedCandidate(mask_line, assigned_from)) |candidate| {
        assigned_from = candidate.name_end;
        const found = (try declarationOn(alloc, mask_line, start, candidate.name, self.facts.declarations)) orelse continue;
        if (found.kind != .method) continue;
        return found;
    }
    return null;
}

fn register(self: *Build, list: *std.ArrayList(*Block), block: *Block) Error!void {
    const alloc = self.facts.alloc;
    try list.append(alloc, block);
    try self.blocks.append(alloc, block);
}

fn descend(self: *Build, block: *Block, decl_line: usize, span: ?Span) Error!void {
    const found = span orelse return;
    if (found.expression != null or block.kind == .property) return;
    var child_from: usize = undefined;
    var child_to: usize = undefined;
    if (found.indented) {
        child_from = decl_line + 1;
        child_to = found.body_end_line.?;
    } else if (found.open_line) |open_line| {
        // `buildScope(openLine + 1, closeLine - 1)`: a body that opens and
        // closes on its own line has no inside, and `closeLine - 1` would run
        // below its own line there (JS `slice(from, to)` just comes back empty).
        const close_line = found.close_line.?;
        if (close_line == 0) return;
        child_from = open_line + 1;
        child_to = close_line - 1;
    } else return;
    if (child_from > child_to) return;

    const children = try self.buildScope(child_from, child_to);
    for (children) |child| try block.children.append(self.facts.alloc, child);
}

fn applyAnchor(self: *Build, block: *Block, open: ?usize) void {
    const offset = open orelse return;
    if (leadingAnchor(self.facts.comments, self.facts.source, self.facts.lines, self.facts.starts, offset)) |anchor| {
        block.anchor = anchor;
    }
}

fn applySpan(block: *Block, span: ?Span) void {
    const found = span orelse return;
    if (found.indented) {
        block.indented = true;
        block.close_line = found.body_end_line;
        block.end_line = found.body_end_line;
        return;
    }
    if (found.expression) |expression| {
        block.expression = expression;
        block.end_line = block.decl_line;
        return;
    }
    block.open = found.open;
    block.close = found.close;
    block.open_line = found.open_line;
    block.close_line = found.close_line;
    block.end_line = found.close_line;
}

fn endLineOf(span: ?Span, decl_line: usize) usize {
    const found = span orelse return decl_line;
    if (found.close_line) |line| return line;
    if (found.body_end_line) |line| return line;
    return decl_line;
}

const Candidate = struct { name: Str, name_end: usize };

/// `(^|[^\w$.])(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(?:async\s+)?(?:function\b|[^;]*=>)`.
fn assignedCandidate(line: Str, from: usize) ?Candidate {
    var at = from;
    while (at < line.len) : (at += 1) {
        if (at > 0 and (js.isAsciiWord(line[at - 1]) or line[at - 1] == '$' or line[at - 1] == '.')) continue;
        if (!js.isIdentStart(line[at])) continue;
        const name_start = at;
        var scan = at + 1;
        while (scan < line.len and js.isIdentPart(line[scan])) scan += 1;
        const name = line[name_start..scan];
        const name_end = scan;
        while (scan < line.len and line[scan] != '=' and line[scan] != '\n') scan += 1;
        if (scan >= line.len or line[scan] != '=') continue;
        if (scan + 1 < line.len and line[scan + 1] == '=') continue;
        scan += 1;
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        const async_kw = &js.lit("async");
        if (js.startsWith(line[scan..], async_kw) and js.isWordBoundary(line, scan + async_kw.len)) {
            scan += async_kw.len;
            while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        }
        if (functionKeywordEnd(line[scan..]) != null) return .{ .name = name, .name_end = name_end };
        const rest = line[scan..];
        const arrow = js.indexOf(rest, &js.lit("=>"));
        const semi = js.indexOfUnit(rest, ';');
        if (arrow != null and (semi == null or arrow.? < semi.?)) return .{ .name = name, .name_end = name_end };
    }
    return null;
}

// --- statements -------------------------------------------------------------

const ChainSegment = struct {
    header_keyword: []const u8,
    header_line: usize,
    open: usize,
    close: usize,
    cond_offset: usize,
    shared_close: bool,
    open_line: usize,
    close_line: usize,
};

fn isContinuation(word: []const u8) bool {
    return std.mem.eql(u8, word, "else") or std.mem.eql(u8, word, "catch") or std.mem.eql(u8, word, "finally");
}

fn makeSegment(
    mask: Str,
    starts: []const usize,
    keyword: []const u8,
    header_line: usize,
    open: usize,
    close: usize,
    cond_from: usize,
    shared_close: bool,
) ChainSegment {
    _ = mask;
    return .{
        .header_keyword = keyword,
        .header_line = header_line,
        .open = open,
        .close = close,
        // `condFrom - lineStart` in JS: a `condFrom` that lands before its
        // line's start (the `} else if` shape, where the JS version reads the
        // closing brace's line) yields a negative offset there, and
        // `String.slice` clamps it to the line's start.
        .cond_offset = if (cond_from > starts[header_line]) cond_from - starts[header_line] else 0,
        .shared_close = shared_close,
        .open_line = lineOf(starts, open),
        .close_line = lineOf(starts, close),
    };
}

/// The segments of an if/else-if (or try/catch) chain opened on this line.
/// Bare-`else` and `do … while` terminators are respected.
fn chainSegments(
    alloc: Allocator,
    mask: Str,
    starts: []const usize,
    header_line: usize,
    keyword: []const u8,
    brace_pos: usize,
    keyword_offset: usize,
) ![]ChainSegment {
    var segments = std.ArrayList(ChainSegment).empty;
    var cur_keyword = keyword;
    var cur_line = header_line;
    var open = brace_pos;
    var cond_from = keyword_offset;
    var i = brace_pos;
    var depth: isize = 0;
    while (i < mask.len) {
        const unit = mask[i];
        if (unit == '{') {
            depth += 1;
            i += 1;
            continue;
        }
        if (unit == '}') {
            depth -= 1;
            if (depth == 0) {
                const rest = mask[i + 1 ..];
                if (leadingWord(rest)) |word| {
                    if (isContinuation(word.text)) {
                        const new_open = js.indexOfUnit(mask[i + 1 ..], '{');
                        try segments.append(alloc, makeSegment(mask, starts, cur_keyword, cur_line, open, i, cond_from, true));
                        const at = if (new_open) |offset| i + 1 + offset else mask.len - 1;
                        if (std.mem.eql(u8, word.text, "else") and isElseIf(rest)) {
                            const if_at = i + 1 + (js.indexOf(rest, &js.lit("if")) orelse 0);
                            cur_keyword = "if";
                            // The continuation's own line, so the condition
                            // literal reader starts at its keyword. The JS
                            // version takes the brace's line here, which is
                            // the same line whenever `} else if (…) {` is
                            // written the way it always is.
                            cur_line = lineOf(starts, if_at);
                            open = at;
                            cond_from = if_at;
                        } else {
                            cur_keyword = word.text;
                            cur_line = lineOf(starts, i + 1 + word.offset);
                            open = at;
                            cond_from = i + 1 + word.offset;
                        }
                        i = at + 1;
                        depth = 1;
                        continue;
                    }
                }
                var end = i;
                if (std.mem.eql(u8, cur_keyword, "do") and isWhileHeader(rest)) {
                    if (js.indexOfUnit(mask[i..], ';')) |semi| end = semi;
                }
                try segments.append(alloc, makeSegment(mask, starts, cur_keyword, cur_line, open, end, cond_from, false));
                return segments.toOwnedSlice(alloc);
            }
            i += 1;
            continue;
        }
        i += 1;
    }
    try segments.append(alloc, makeSegment(mask, starts, cur_keyword, cur_line, open, mask.len - 1, cond_from, false));
    return segments.toOwnedSlice(alloc);
}

const LeadingWord = struct { text: []const u8, offset: usize };

/// `/^\s*([A-Za-z_]+)/` over the text after the closing brace. The word is
/// ASCII, so it comes back as bytes for the keyword compares.
fn leadingWord(rest: Str) ?LeadingWord {
    const buffer = struct {
        var storage: [16]u8 = undefined;
    };
    var at: usize = 0;
    while (at < rest.len and js.isWhitespace(rest[at])) at += 1;
    const start = at;
    while (at < rest.len) : (at += 1) {
        const unit = rest[at];
        if (!((unit >= 'A' and unit <= 'Z') or (unit >= 'a' and unit <= 'z') or unit == '_')) break;
    }
    if (at == start) return null;
    const length = at - start;
    if (length > buffer.storage.len) return null;
    for (rest[start..at], 0..) |unit, index| buffer.storage[index] = @intCast(unit);
    return .{ .text = buffer.storage[0..length], .offset = start };
}

fn isElseIf(rest: Str) bool {
    var at: usize = 0;
    while (at < rest.len and js.isWhitespace(rest[at])) at += 1;
    const else_kw = &js.lit("else");
    if (!js.startsWith(rest[at..], else_kw)) return false;
    if (!js.isWordBoundary(rest, at + else_kw.len)) return false;
    at += else_kw.len;
    if (at >= rest.len or !js.isWhitespace(rest[at])) return false;
    while (at < rest.len and js.isWhitespace(rest[at])) at += 1;
    const if_kw = &js.lit("if");
    return js.startsWith(rest[at..], if_kw) and js.isWordBoundary(rest, at + if_kw.len);
}

fn isWhileHeader(rest: Str) bool {
    var at: usize = 0;
    while (at < rest.len and js.isWhitespace(rest[at])) at += 1;
    const while_kw = &js.lit("while");
    if (!js.startsWith(rest[at..], while_kw)) return false;
    if (!js.isWordBoundary(rest, at + while_kw.len)) return false;
    at += while_kw.len;
    while (at < rest.len and js.isWhitespace(rest[at])) at += 1;
    return at < rest.len and rest[at] == '(';
}

/// `conditionLiterals`: the double-quoted literals a header line carries, read
/// from the original text but with comments skipped. Two forms: the byte-exact
/// literal, and the token-pasted form where adjacent literals (separated only
/// by whitespace or `+`) join.
fn conditionLiterals(alloc: Allocator, orig_line: Str, from: usize) !Conditions {
    const Literal = struct { start: usize, end: usize };
    var literals = std.ArrayList(Literal).empty;

    var i = from;
    while (i < orig_line.len) {
        const unit = orig_line[i];
        const next: u16 = if (i + 1 < orig_line.len) orig_line[i + 1] else 0;
        if (unit == '/' and next == '/') break;
        if (unit == '/' and next == '*') {
            const close = js.indexOf(orig_line[i + 2 ..], &js.lit("*/"));
            i = if (close) |offset| i + 2 + offset + 2 else orig_line.len;
            continue;
        }
        if (unit == '"') {
            var j = i + 1;
            while (j < orig_line.len and orig_line[j] != '"') {
                if (orig_line[j] == '\\') j += 1;
                j += 1;
            }
            try literals.append(alloc, .{ .start = i, .end = @min(j, orig_line.len) });
            i = j + 1;
            continue;
        }
        i += 1;
    }

    var exact = std.ArrayList(Str).empty;
    for (literals.items) |literal| {
        try exact.append(alloc, orig_line[literal.start + 1 .. literal.end]);
    }

    var pasted = std.ArrayList(Str).empty;
    var k: usize = 0;
    while (k < literals.items.len) {
        var merged = std.ArrayList(u16).empty;
        try merged.appendSlice(alloc, orig_line[literals.items[k].start + 1 .. literals.items[k].end]);
        var m = k + 1;
        while (m < literals.items.len) {
            const previous_end = literals.items[m - 1].end;
            const next_start = literals.items[m].start;
            // A missing closer makes the gap run backwards; JavaScript reads
            // that as an empty string.
            const gap = if (next_start > previous_end + 1)
                orig_line[previous_end + 1 .. next_start]
            else
                &.{};
            if (!isPasteGap(gap)) break;
            try merged.appendSlice(alloc, orig_line[literals.items[m].start + 1 .. literals.items[m].end]);
            m += 1;
        }
        try pasted.append(alloc, try merged.toOwnedSlice(alloc));
        k = m;
    }

    return .{ .exact = try exact.toOwnedSlice(alloc), .pasted = try pasted.toOwnedSlice(alloc) };
}

/// `/^[\s+]*$/` over the gap between two literals.
fn isPasteGap(gap: Str) bool {
    for (gap) |unit| {
        if (!js.isWhitespace(unit) and unit != '+') return false;
    }
    return true;
}

/// The leading-comment anchor of a braced block, or null: the comment that is
/// the first thing inside the braces — same line after `{`, or the next
/// non-blank line. A `#region`/`#endregion` line is never an anchor, and a body
/// whose first thing is code has no anchor.
fn leadingAnchor(
    comments: []const Comment,
    source: Str,
    lines: []const Str,
    starts: []const usize,
    open: usize,
) ?Anchor {
    var first: ?Comment = null;
    for (comments) |comment| {
        if (comment.from <= open) continue;
        if (js.trim(source[open + 1 .. comment.from]).len == 0) first = comment;
        break;
    }
    const found = first orelse return null;
    const comment_line = lineOf(starts, found.from);
    const brace_line = lineOf(starts, open);
    if (comment_line != brace_line) {
        const next = nextNonBlank(lines, brace_line + 1) orelse return null;
        if (comment_line != next) return null;
    }
    const body = js.trim(found.text);
    if (isRegionWord(body)) return null;
    if (body.len == 0 or !js.isIdentStart(body[0])) return null;
    var at: usize = 1;
    while (at < body.len and js.isIdentPart(body[at])) at += 1;
    if (at != body.len) return null;
    return .{ .name = body, .line = comment_line };
}

/// `^(#?)(region|endregion)\b` over an anchor's comment body.
fn isRegionWord(body: Str) bool {
    var text = body;
    if (text.len > 0 and text[0] == '#') text = text[1..];
    if (startsWithIgnoreCase(text, &js.lit("endregion"))) {
        const token = &js.lit("endregion");
        return text.len == token.len or js.isWordBoundary(text, token.len);
    }
    const token = &js.lit("region");
    if (!startsWithIgnoreCase(text, token)) return false;
    return text.len == token.len or js.isWordBoundary(text, token.len);
}

fn startsWithIgnoreCase(text: Str, prefix: Str) bool {
    if (text.len < prefix.len) return false;
    for (prefix, 0..) |unit, index| {
        if (js.asciiLower(text[index]) != js.asciiLower(unit)) return false;
    }
    return true;
}

// --- region directives ------------------------------------------------------

const COMMENT_OPENERS = [_][]const u8{ "//", "--", ";", "%", "'", "REM", "<!--", "/*", "*" };
const COMMENT_CLOSERS = [_][]const u8{ "-->", "*/" };

fn commentOpenerAt(text: Str) ?usize {
    for (COMMENT_OPENERS) |opener| {
        if (!js.startsWithBytes(text, opener)) continue;
        if (std.mem.eql(u8, opener, "REM")) {
            if (text.len > opener.len and js.isAsciiWord(text[opener.len])) continue;
        }
        return opener.len;
    }
    return null;
}

/// `/^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i`.
fn stripCommentOpener(text: Str) Str {
    var rest = text;
    while (commentOpenerAt(rest)) |length| {
        var after = length;
        while (after < rest.len and js.isWhitespace(rest[after])) after += 1;
        rest = rest[after..];
    }
    return rest;
}

/// `regionDirective`: the spellings the major editors share, under any comment
/// prefix, plus the C# `#region` spelling with no prefix. A bare `region name`
/// line is prose, not a directive.
pub fn regionDirective(line: Str) ?Directive {
    var text = js.trim(line);

    // `COMMENT_CLOSER`: `\s*(?:-->|\*\/)$`.
    for (COMMENT_CLOSERS) |closer| {
        if (!js.endsWithBytes(text, closer)) continue;
        text = js.trimEnd(text[0 .. text.len - closer.len]);
        break;
    }

    const commented = commentOpenerAt(text) != null;
    if (commented) text = stripCommentOpener(text);

    var hashed = false;
    if (text.len > 0 and text[0] == '#') {
        hashed = true;
        text = text[1..];
    }

    const endregion = &js.lit("endregion");
    const region = &js.lit("region");
    var kind: DirectiveKind = undefined;
    var length: usize = 0;
    if (startsWithIgnoreCase(text, endregion)) {
        kind = .endregion;
        length = endregion.len;
    } else if (startsWithIgnoreCase(text, region)) {
        kind = .region;
        length = region.len;
    } else return null;

    if (length < text.len and js.isAsciiWord(text[length])) return null;
    // A bare `region foo` line is prose: without a comment prefix the C#
    // spelling (`#region`) is required.
    if (!commented and !hashed) return null;

    var name = text[length..];
    while (name.len > 0 and js.isWhitespace(name[0])) name = name[1..];
    return .{ .kind = kind, .name = js.trimEnd(name) };
}

/// The `#region` pairs of a document, in the order they close.
fn pairRegions(alloc: Allocator, lines: []const Str) ![]Region {
    var out = std.ArrayList(Region).empty;
    var stack = std.ArrayList(Region).empty;
    for (lines, 0..) |line, index| {
        const directive = regionDirective(line) orelse continue;
        switch (directive.kind) {
            .region => try stack.append(alloc, .{ .name = directive.name, .start_line = index, .end_line = index }),
            .endregion => {
                if (stack.items.len == 0) continue;
                const open = stack.pop().?;
                try out.append(alloc, .{ .name = open.name, .start_line = open.start_line, .end_line = index });
            },
        }
    }
    return out.toOwnedSlice(alloc);
}

// ===========================================================================
// Part C — the resolve layer
// ===========================================================================

const HitKind = enum { declaration, property, condition, anchor, region };

const SegmentHit = struct {
    kind: HitKind,
    block: ?*Block = null,
    region: ?Region = null,
    header_line: ?usize = null,
};

/// The matcher-precedence lookup of `segment` inside one scope, matchers 1-6,
/// considering only this scope's own members (no descent). Returns the matches
/// of the **first matcher that has any**, in walk order.
fn matchSegment(
    alloc: Allocator,
    scope: *Block,
    segment: Str,
    descended: bool,
    out: *std.ArrayList(SegmentHit),
    failure: *Failure,
) Error!void {
    // 1 — region directive (modifier ignored).
    var regions: usize = 0;
    for (scope.regions.items) |region| {
        if (js.eql(region.name, segment)) regions += 1;
    }
    if (regions > 1) {
        return failure.set(try js.format(
            alloc,
            "\"#region {s}\" appears {d} times; region names must be unique",
            .{ segment, regions },
        ));
    }
    if (regions == 1) {
        for (scope.regions.items) |region| {
            if (js.eql(region.name, segment)) {
                try out.append(alloc, .{ .kind = .region, .region = region });
                return;
            }
        }
    }

    // When we have descended *into* this block, its own comment anchor is in
    // scope for this segment, checked early so `handler/getUsers` resolves to
    // the handler block itself.
    if (descended) {
        if (scope.anchor) |anchor| {
            if (js.eql(anchor.name, segment)) {
                try out.append(alloc, .{
                    .kind = .anchor,
                    .block = scope,
                    .header_line = anchor.line,
                });
                return;
            }
        }
    }

    // 2 — class-like, 3 — method/function, 4 — property.
    const kinds = [_]Kind{ .class, .method, .property };
    for (kinds) |kind| {
        var found: usize = 0;
        for (scope.children.items) |child| {
            if (child.kind != kind) continue;
            const name = child.name orelse continue;
            if (js.eql(name, segment)) found += 1;
        }
        if (found == 0) continue;
        for (scope.children.items) |child| {
            if (child.kind != kind) continue;
            const name = child.name orelse continue;
            if (!js.eql(name, segment)) continue;
            try out.append(alloc, .{
                .kind = if (kind == .property) .property else .declaration,
                .block = child,
            });
        }
        return;
    }

    // 5 — condition literal: this scope's own condition, or a direct child's.
    if (scope.kind == .statement) {
        if (scope.conditions) |conditions| {
            if (contains(conditions.pasted, segment)) {
                try out.append(alloc, .{
                    .kind = .condition,
                    .block = scope,
                    .header_line = scope.decl_line,
                });
                return;
            }
        }
    }
    var conditions_found: usize = 0;
    for (scope.children.items) |child| {
        if (child.kind != .statement) continue;
        const conditions = child.conditions orelse continue;
        if (contains(conditions.pasted, segment)) conditions_found += 1;
    }
    if (conditions_found > 0) {
        for (scope.children.items) |child| {
            if (child.kind != .statement) continue;
            const conditions = child.conditions orelse continue;
            if (!contains(conditions.pasted, segment)) continue;
            try out.append(alloc, .{
                .kind = .condition,
                .block = child,
                .header_line = child.decl_line,
            });
        }
        return;
    }

    // 6 — comment anchor.
    var anchors_found: usize = 0;
    for (scope.children.items) |child| {
        const anchor = child.anchor orelse continue;
        if (js.eql(anchor.name, segment)) anchors_found += 1;
    }
    if (anchors_found > 0) {
        for (scope.children.items) |child| {
            const anchor = child.anchor orelse continue;
            if (!js.eql(anchor.name, segment)) continue;
            try out.append(alloc, .{
                .kind = .anchor,
                .block = child,
                .header_line = anchor.line,
            });
        }
    }
}

fn contains(list: []const Str, needle: Str) bool {
    for (list) |entry| {
        if (js.eql(entry, needle)) return true;
    }
    return false;
}

/// Whether a matched block can hold nested sections (a scope for the walk).
fn isContainer(block: *Block) bool {
    if (block.kind == .property) return false;
    if (block.children.items.len > 0) return true;
    if (block.indented) return true;
    if (block.open_line) |open_line| {
        if (block.close_line) |close_line| return open_line < close_line;
    }
    return false;
}

const Level = struct { scope: *Block, descended: bool };

/// Find every `segment` in the shallowest level of `scope` that has one, in
/// walk order, applying matcher precedence per scope. Scopes are visited level
/// by level — every sibling at the current depth is tried with the full matcher
/// table, left to right, before the walk descends into any block they contain.
fn searchSegments(
    alloc: Allocator,
    segment: Str,
    scope: *Block,
    descended: bool,
    failure: *Failure,
) Error![]SegmentHit {
    var level = std.ArrayList(Level).empty;
    try level.append(alloc, .{ .scope = scope, .descended = descended });

    while (level.items.len > 0) {
        var hits = std.ArrayList(SegmentHit).empty;
        for (level.items) |node| {
            try matchSegment(alloc, node.scope, segment, node.descended, &hits, failure);
        }
        if (hits.items.len > 0) return hits.toOwnedSlice(alloc);

        var deeper = std.ArrayList(Level).empty;
        for (level.items) |node| {
            for (node.scope.children.items) |child| {
                try deeper.append(alloc, .{ .scope = child, .descended = true });
            }
        }
        level = deeper;
    }
    return &.{};
}

/// Resolve `segments[index..]` starting at `scope`, retrying same-named
/// candidates: a candidate that cannot be a scope, or that does not hold the
/// rest of the path, gives way to the next one at the same level. The **last**
/// segment is not retried — its first match in walk order is the selection — so
/// a path is only ambiguous when the *scopes* disagree.
fn resolvePath(
    alloc: Allocator,
    segments: []const Str,
    index: usize,
    scope: *Block,
    descended: bool,
    prev_name: ?Str,
    failure: *Failure,
) Error!SegmentHit {
    const segment = segments[index];
    const last = index == segments.len - 1;
    const candidates = try searchSegments(alloc, segment, scope, descended, failure);

    if (candidates.len == 0) {
        if (index == 0 and last) {
            return failure.set(try js.format(
                alloc,
                "no \"#region {s}\" found, and no section named \"{s}\"",
                .{ segment, segment },
            ));
        }
        return failure.set(try js.format(
            alloc,
            "no section named \"{s}\" in \"{s}\"",
            .{ segment, prev_name orelse &.{} },
        ));
    }

    for (candidates) |found| {
        if (last) return found;
        if (found.region != null or !isContainer(found.block.?)) {
            if (failure.message.len == 0) {
                failure.message = try js.format(alloc, "\"{s}\" is not a container", .{segment});
            }
            continue;
        }
        return resolvePath(alloc, segments, index + 1, found.block.?, true, segment, failure) catch |err| {
            if (err != error.Failed) return err;
            continue;
        };
    }
    return error.Failed;
}

// --- rendering --------------------------------------------------------------

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

fn isAnnotationLine(line: Str, annotations: []const syntaxes.Annotation) bool {
    if (annotations.len > 0) {
        for (annotations) |entry| {
            if (entry(line)) return true;
        }
        return false;
    }
    // `^\s*(?:@[\w.$]|#\[)`
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    if (at >= line.len) return false;
    if (line[at] == '@') {
        return at + 1 < line.len and (js.isAsciiWord(line[at + 1]) or line[at + 1] == '.' or line[at + 1] == '$');
    }
    return line[at] == '#' and at + 1 < line.len and line[at + 1] == '[';
}

/// The first line of the annotation block directly above `decl_line`, or null.
fn annotationStart(lines: []const Str, decl_line: usize, annotations: []const syntaxes.Annotation) ?usize {
    var found: ?usize = null;
    var index = decl_line;
    while (index > 0) {
        index -= 1;
        if (js.trim(lines[index]).len == 0) break;
        if (isAnnotationLine(lines[index], annotations)) {
            found = index;
            break;
        }
    }
    const first = found orelse return null;

    var start = first;
    while (start > 0) {
        const previous = start - 1;
        if (js.trim(lines[previous]).len == 0 or !isAnnotationLine(lines[previous], annotations)) break;
        start = previous;
    }

    // The block must be annotations all the way: a statement between the
    // declaration and the annotation means there is no annotation block.
    var depth: isize = 0;
    var i = start;
    while (i < decl_line) : (i += 1) {
        if (depth == 0 and !isAnnotationLine(lines[i], annotations)) return null;
        depth += bracketBalance(lines[i]);
    }
    return if (depth == 0) start else null;
}

fn isDocCommentOpen(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    const token = &js.lit("/*");
    if (!js.startsWith(line[at..], token)) return false;
    return at + token.len < line.len and (line[at + token.len] == '*' or line[at + token.len] == '!');
}

fn isDocCommentRun(line: Str) bool {
    var at: usize = 0;
    while (at < line.len and js.isWhitespace(line[at])) at += 1;
    return js.startsWith(line[at..], &js.lit("///"));
}

fn endsWithBlockCommentEnd(line: Str) bool {
    return js.endsWith(js.trimEnd(line), &js.lit("*/"));
}

/// The first line of the doc comment directly above `top`, or null.
fn docCommentStart(lines: []const Str, top: usize) ?usize {
    if (top == 0) return null;
    const previous = top - 1;
    if (js.trim(lines[previous]).len == 0) return null;

    if (isDocCommentRun(lines[previous])) {
        var start = previous;
        while (start > 0 and isDocCommentRun(lines[start - 1])) start -= 1;
        return start;
    }
    if (!endsWithBlockCommentEnd(lines[previous])) return null;
    var index = previous + 1;
    while (index > 0) {
        index -= 1;
        if (js.trim(lines[index]).len == 0) return null;
        if (isDocCommentOpen(lines[index])) return index;
    }
    return null;
}

/// The text one declaration contributes, under one scope.
fn renderDeclaration(
    alloc: Allocator,
    lines: []const Str,
    source: Str,
    block: *Block,
    end_line: usize,
    scope: Scope,
    annotations: []const syntaxes.Annotation,
) ![]u16 {
    if (scope == .body) {
        if (block.single_line) return js.joinLines(alloc, lines[block.decl_line .. end_line + 1]);
        if (block.indented) return js.joinLines(alloc, lines[block.decl_line + 1 .. end_line + 1]);
        if (block.expression) |expression| {
            return alloc.dupe(u16, js.trim(source[expression..endOfLine(source, expression)]));
        }
        if (block.open_line.? == end_line) {
            return alloc.dupe(u16, js.trim(source[block.open.? + 1 .. block.close.?]));
        }
        return js.joinLines(alloc, lines[block.open_line.? + 1 .. end_line]);
    }

    var first = block.decl_line;
    if (scope == .annotated or scope == .documented) {
        if (annotationStart(lines, block.decl_line, annotations)) |annotated| first = annotated;
        if (scope == .documented) {
            if (docCommentStart(lines, first)) |documented| first = documented;
        }
    }
    return js.joinLines(alloc, lines[first .. end_line + 1]);
}

/// `/;\s*$/` — a trailing semicolon and the spaces before it.
fn stripSemicolon(text: Str) Str {
    var end = text.len;
    while (end > 0 and js.isWhitespace(text[end - 1])) end -= 1;
    if (end > 0 and text[end - 1] == ';') {
        end -= 1;
        while (end > 0 and js.isWhitespace(text[end - 1])) end -= 1;
    }
    return text[0..end];
}

/// The text `block` contributes under `scope`.
fn renderBlock(
    alloc: Allocator,
    block: *Block,
    scope: Scope,
    match_kind: HitKind,
    facts: Facts,
) ![]u16 {
    const is_anchor = match_kind == .anchor or match_kind == .condition;
    const end_line = block.end_line orelse block.close_line orelse block.decl_line;

    if (!is_anchor and (block.kind == .class or block.kind == .method)) {
        return renderDeclaration(alloc, facts.lines, facts.source, block, end_line, scope, facts.annotations);
    }
    if (!is_anchor and block.kind == .property) {
        if (scope == .body) {
            const line_start = facts.starts[block.decl_line];
            if (js.indexOfUnit(facts.source[line_start..], '=')) |offset| {
                const eq = line_start + offset;
                const line_end = endOfLine(facts.source, line_start);
                return alloc.dupe(u16, js.trim(stripSemicolon(facts.source[eq + 1 .. line_end])));
            }
        }
        return alloc.dupe(u16, js.trimEnd(facts.lines[block.decl_line]));
    }

    const anchor_line: ?usize = if (block.anchor) |anchor| anchor.line else null;
    const first_line = block.decl_line;
    const last_line = block.close_line orelse end_line;
    if (scope == .body) {
        const base = block.open_line orelse 0;
        const body_from = if (anchor_line) |line| @max(base, line) else base;
        if (body_from >= last_line) {
            return alloc.dupe(u16, js.trim(facts.source[block.open.? + 1 .. block.close.?]));
        }
        return js.joinLines(alloc, facts.lines[body_from + 1 .. last_line]);
    }

    // A non-final chain segment (`if … } else if …`) shares its closing `}`
    // with the continuation on the same line: end at the brace, not the line.
    if (block.shared_close) {
        const text = facts.source[facts.starts[first_line] .. block.close.? + 1];
        const split = try js.splitLines(alloc, text);
        for (split) |*line| line.* = js.trimEnd(line.*);
        return js.joinLines(alloc, split);
    }
    return js.joinLines(alloc, facts.lines[first_line .. last_line + 1]);
}

// --- declarations and the plan ---------------------------------------------

/// `extractDeclaration`: the text a named declaration contributes, or null when
/// the name declares nothing. Searches the whole file at any depth, prefers a
/// class-like over a same-named member, and fails on a genuine overload pair.
pub fn extractDeclaration(
    alloc: Allocator,
    text: Str,
    name: Str,
    scope: Scope,
    failure: *Failure,
) Error!?[]u16 {
    if (name.len == 0) return null;
    const scan = try scanBlocks(alloc, text, null);
    return extractDeclarationFromScan(scan, name, scope, failure);
}

pub fn extractDeclarationWithLexer(
    alloc: Allocator,
    text: Str,
    name: Str,
    scope: Scope,
    lexer: ?lexers.Lexer,
    failure: *Failure,
) Error!?[]u16 {
    if (name.len == 0) return null;
    const scan = try scanBlocks(alloc, text, lexer);
    return extractDeclarationFromScan(scan, name, scope, failure);
}

fn extractDeclarationFromScan(
    scan: Scan,
    name: Str,
    scope: Scope,
    failure: *Failure,
) Error!?[]u16 {
    const alloc = scan.facts.alloc;
    var found = std.ArrayList(*Block).empty;
    try walkNamed(alloc, scan.root, name, &found);
    if (found.items.len == 0) return null;

    var classes = std.ArrayList(*Block).empty;
    for (found.items) |block| {
        if (block.kind == .class) try classes.append(alloc, block);
    }
    const chosen = if (classes.items.len > 0) classes.items else found.items;
    if (chosen.len > 1) {
        return failure.set(try js.format(
            alloc,
            "\"{s}\" is declared {d} times; names must be unique",
            .{ name, chosen.len },
        ));
    }
    const block = chosen[0];
    const end_line = block.end_line orelse block.close_line orelse block.decl_line;
    return try renderDeclaration(alloc, scan.facts.lines, scan.facts.source, block, end_line, scope, scan.facts.annotations);
}

fn hasBody(block: *Block) bool {
    if (block.single_line or block.expression != null or block.indented) return true;
    return block.open_line != null;
}

fn walkNamed(alloc: Allocator, scope: *Block, name: Str, found: *std.ArrayList(*Block)) !void {
    for (scope.children.items) |block| {
        if (block.kind == .class or block.kind == .method or block.kind == .property) {
            if (block.name) |declared| {
                if (js.eql(declared, name) and hasBody(block)) try found.append(alloc, block);
            }
        }
        try walkNamed(alloc, block, name, found);
    }
}

pub const Plan = struct { text: []u16, reference: Reference };

/// Resolve a section reference to text, exposing the reference and any
/// contradiction warning. `resolveSection` is `planSection(...).text`.
pub fn planSection(
    alloc: Allocator,
    text: Str,
    reference: Str,
    lexer: ?lexers.Lexer,
    failure: *Failure,
) Error!Plan {
    const ref = try parseReference(alloc, reference, failure);
    const scan = try scanBlocks(alloc, text, lexer);
    const final = try resolvePath(alloc, ref.segments, 0, scan.root, false, null, failure);

    const out_text: []u16 = if (final.region) |region| blk: {
        break :blk try js.joinLines(alloc, scan.facts.lines[region.start_line + 1 .. region.end_line]);
    } else blk: {
        break :blk try renderBlock(alloc, final.block.?, ref.scope, final.kind, scan.facts);
    };

    return .{ .text = out_text, .reference = ref };
}

/// The text a section reference stands for.
pub fn resolveSection(
    alloc: Allocator,
    text: Str,
    reference: Str,
    lexer: ?lexers.Lexer,
    failure: *Failure,
) Error![]u16 {
    return (try planSection(alloc, text, reference, lexer, failure)).text;
}

// ===========================================================================
// Tests
// ===========================================================================

const testing = std.testing;

fn expectUnits(alloc: Allocator, expected: []const u8, actual: Str) !void {
    const want = try js.utf8Decode(alloc, expected);
    try testing.expectEqualSlices(u16, want, actual);
}

test "parseReference reads the modifiers and canonicalises them" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { raw: []const u8, canonical: []const u8, scope: Scope }{
        .{ .raw = "add", .canonical = "add", .scope = .declaration },
        .{ .raw = "add-", .canonical = "add-", .scope = .body },
        .{ .raw = "add+", .canonical = "add+", .scope = .annotated },
        .{ .raw = "add++", .canonical = "add++", .scope = .documented },
        .{ .raw = "-add", .canonical = "add-", .scope = .body },
        .{ .raw = "+add", .canonical = "add+", .scope = .annotated },
        .{ .raw = "++add", .canonical = "add++", .scope = .documented },
        .{ .raw = "Cart/Line/render", .canonical = "Cart/Line/render", .scope = .declaration },
        .{ .raw = "Cart/Line-", .canonical = "Cart/Line-", .scope = .body },
        .{ .raw = "Cart/-Line", .canonical = "Cart/Line-", .scope = .body },
        .{ .raw = "Cart/Line/-render", .canonical = "Cart/Line/render-", .scope = .body },
        .{ .raw = "a/b/c/d/e/f/g/h", .canonical = "a/b/c/d/e/f/g/h", .scope = .declaration },
    };
    for (cases) |case| {
        const raw = try js.utf8Decode(alloc, case.raw);
        var failure = Failure{};
        const reference = try parseReference(alloc, raw, &failure);
        try expectUnits(alloc, case.canonical, reference.canonical);
        try testing.expectEqual(case.scope, reference.scope);
    }
}

test "parseReference rejects the malformed shapes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { raw: []const u8, message: []const u8 }{
        .{ .raw = "", .message = "\"#\" names nothing" },
        .{ .raw = "a/", .message = "\"#a/\" has an empty path segment" },
        .{ .raw = "/a", .message = "\"#/a\" has an empty path segment" },
        .{ .raw = "a//b", .message = "\"#a//b\" has an empty path segment" },
        .{ .raw = "a/+b", .message = "\"+\" may only modify the last path segment of \"#a/+b\"" },
        .{ .raw = "Cart/-Line/render", .message = "\"-\" may only modify the last path segment of \"#Cart/-Line/render\"" },
        .{ .raw = "a+++", .message = "\"#a+++\" carries more than one modifier" },
        .{ .raw = "a---", .message = "\"#a---\" carries more than one modifier" },
        .{ .raw = "a--", .message = "\"#a--\" carries more than one modifier" },
        .{ .raw = "a/b/c/d/e/f/g/h/i", .message = "\"#a/b/c/d/e/f/g/h/i\" is deeper than 8 sections" },
    };
    for (cases) |case| {
        const raw = try js.utf8Decode(alloc, case.raw);
        var failure = Failure{};
        try testing.expectError(error.Failed, parseReference(alloc, raw, &failure));
        try testing.expect(failure.grammar);
        try expectUnits(alloc, case.message, failure.message);
    }
}

test "parseReference warns when a + contradicts a -" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { raw: []const u8, canonical: []const u8, message: []const u8 }{
        .{ .raw = "a++-", .canonical = "a++", .message = "\"++\" contradicts \"-\"; using \"#a++\"" },
        .{ .raw = "a-++", .canonical = "a++", .message = "\"++\" contradicts \"-\"; using \"#a++\"" },
        .{ .raw = "a+-", .canonical = "a+", .message = "\"+\" contradicts \"-\"; using \"#a+\"" },
        .{ .raw = "a-+", .canonical = "a+", .message = "\"+\" contradicts \"-\"; using \"#a+\"" },
    };
    for (cases) |case| {
        const raw = try js.utf8Decode(alloc, case.raw);
        var failure = Failure{};
        const reference = try parseReference(alloc, raw, &failure);
        try expectUnits(alloc, case.canonical, reference.canonical);
        const warning = reference.warning orelse return error.ExpectedAWarning;
        try expectUnits(alloc, case.message, warning.message);
    }
}

test "regionDirective accepts the common comment spellings" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { line: []const u8, kind: DirectiveKind, name: []const u8 }{
        .{ .line = "#region table", .kind = .region, .name = "table" },
        .{ .line = "#endregion", .kind = .endregion, .name = "" },
        .{ .line = "// #region table", .kind = .region, .name = "table" },
        .{ .line = "//region table", .kind = .region, .name = "table" },
        .{ .line = "<!-- #region table -->", .kind = .region, .name = "table" },
        .{ .line = "/* #region table */", .kind = .region, .name = "table" },
        .{ .line = "-- #region table", .kind = .region, .name = "table" },
        .{ .line = "; #region table", .kind = .region, .name = "table" },
        .{ .line = "REM #region table", .kind = .region, .name = "table" },
        .{ .line = "    #region  spaced   name  ", .kind = .region, .name = "spaced   name" },
        .{ .line = "#region", .kind = .region, .name = "" },
    };
    for (cases) |case| {
        const line = try js.utf8Decode(alloc, case.line);
        const directive = regionDirective(line) orelse return error.ExpectedADirective;
        try testing.expectEqual(case.kind, directive.kind);
        try expectUnits(alloc, case.name, directive.name);
    }

    const prose = [_][]const u8{
        "region table",
        "endregion",
        "The #region directive is nice.",
        "",
        "# regional planning",
    };
    for (prose) |line| {
        try testing.expect(regionDirective(try js.utf8Decode(alloc, line)) == null);
    }
}

// The corpus `tools/zig-vectors.mjs` generates from the JavaScript
// implementation's golden vectors: every case is checked here, so a drift
// between the two engines fails `zig build test`.
test "the golden section vectors" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var checked: usize = 0;
    for (vectors.cases) |case| {
        var failure = Failure{};
        const reference = try js.utf8Decode(alloc, case.reference);

        if (case.input == null) {
            // A parse-only probe: the grammar, and the warning it carries.
            if (parseReference(alloc, reference, &failure)) |parsed| {
                if (case.warning) |expected| {
                    const warning = parsed.warning orelse {
                        std.debug.print("{s}: expected a warning\n", .{case.name});
                        return error.MissingWarning;
                    };
                    try expectUnits(alloc, expected.kept, warning.kept);
                    try expectUnits(alloc, expected.dropped, warning.dropped);
                } else if (parsed.warning != null) {
                    std.debug.print("{s}: unexpected warning\n", .{case.name});
                    return error.UnexpectedWarning;
                }
            } else |_| {
                const expected = case.error_message orelse {
                    std.debug.print("{s}: unexpected grammar error: {any}\n", .{ case.name, failure.message });
                    return error.UnexpectedGrammarError;
                };
                try expectUnits(alloc, expected, failure.message);
            }
            checked += 1;
            continue;
        }

        const source_text = vectors.sourceOf(case.input) orelse {
            std.debug.print("{s}: no fixture for {s}\n", .{ case.name, case.input.? });
            return error.MissingFixture;
        };
        const source = try js.utf8Decode(alloc, source_text);
        const path = try js.utf8Decode(alloc, case.input.?);

        if (planSection(alloc, source, reference, lexers.lexerFor(path), &failure)) |plan| {
            const expected = case.text orelse {
                std.debug.print("{s}: expected an error, got {any}\n", .{ case.name, plan.text });
                return error.UnexpectedResolution;
            };
            if (!js.eql(try js.utf8Decode(alloc, expected), plan.text)) {
                std.debug.print("{s}: text differs\nexpected: {any}\nactual:   {any}\n", .{
                    case.name,
                    try js.utf8Decode(alloc, expected),
                    plan.text,
                });
                return error.TextMismatch;
            }
            if (case.warning) |expected_warning| {
                const warning = plan.reference.warning orelse {
                    std.debug.print("{s}: expected a warning\n", .{case.name});
                    return error.MissingWarning;
                };
                try expectUnits(alloc, expected_warning.kept, warning.kept);
                try expectUnits(alloc, expected_warning.dropped, warning.dropped);
            }
        } else |err| {
            if (err != error.Failed) return err;
            const expected = case.error_message orelse {
                std.debug.print("{s}: unexpected failure: {any}\n", .{ case.name, failure.message });
                return error.UnexpectedFailure;
            };
            if (!js.eqlBytes(failure.message, expected)) {
                std.debug.print("{s}: error differs\nexpected: {s}\nactual:   {any}\n", .{
                    case.name,
                    expected,
                    failure.message,
                });
                return error.ErrorMismatch;
            }
        }
        checked += 1;
    }

    try testing.expectEqual(vectors.cases.len, checked);
    try testing.expect(checked >= 50);
}

// The lexical corpus, mask half: what each language blanks, and that the mask is still a mask.
//
// `test/vectors/section-vectors.json` can only exercise the lexer entries its fixtures name — six of
// the eighteen — so this is what holds the other twelve, and the built-in engine, to the JavaScript.
// Every row is reported, not just the first, so one run shows the whole divergence.
test "the lexical mask vectors" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var failures = std.ArrayList([]const u8).empty;
    var checked: usize = 0;
    for (vectors.mask_cases) |case| {
        const source = try js.utf8Decode(alloc, case.source);
        const expected = try js.utf8Decode(alloc, case.masked);

        const actual = if (case.path) |path_bytes| blk: {
            const path = try js.utf8Decode(alloc, path_bytes);
            // No entry for the type: the built-in default engine applies, exactly as a null lexer does
            // in JavaScript — the language table is an optimisation, never a requirement.
            const lexer = lexers.lexerFor(path) orelse break :blk try masked(alloc, source);
            break :blk try lexer.mask(alloc, source);
        } else try masked(alloc, source);

        if (!js.eql(actual, expected)) {
            try failures.append(alloc, try std.fmt.allocPrint(alloc, "{s}: mask {any}, want {any}", .{
                case.name,
                actual,
                expected,
            }));
        }
        // A mask is only useful if it *is* a mask: same length, and every newline still at its own
        // offset, so a declaration's body can neither end early nor run past its line.
        if (actual.len != source.len) {
            try failures.append(alloc, try std.fmt.allocPrint(
                alloc,
                "{s}: the mask changed the length, {d} for {d}",
                .{ case.name, actual.len, source.len },
            ));
        } else {
            for (source, 0..) |unit, at| {
                if (unit == '\n' and actual[at] != '\n') {
                    try failures.append(alloc, try std.fmt.allocPrint(
                        alloc,
                        "{s}: the mask moved the newline at {d}",
                        .{ case.name, at },
                    ));
                    break;
                }
            }
        }
        checked += 1;
    }

    if (failures.items.len > 0) {
        std.debug.print("{d} of {d} masks disagree with lib/section.mjs:\n", .{
            failures.items.len,
            checked,
        });
        for (failures.items) |failure| std.debug.print("  {s}\n", .{failure});
        return error.MaskMismatch;
    }
    try testing.expectEqual(vectors.mask_cases.len, checked);
    try testing.expect(checked >= 40);
}

// The lexical corpus, shape half: the declaration shapes a language adds to the generic `name(`
// heuristics, asserted field by field — kind, name, the offset the body starts at, and the body rule.
//
// These are the rows a mistranslated matcher fails: `impl<T>` against `impl`, `pub name` against
// `publisher`, an indented Haskell binding against a column-0 one. Every row is reported.
test "the lexical shape vectors" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    var failures = std.ArrayList([]const u8).empty;
    var checked: usize = 0;
    for (vectors.shape_cases) |case| {
        const path = try js.utf8Decode(alloc, case.path);
        const line = try js.utf8Decode(alloc, case.line);
        const lexer = lexers.lexerFor(path) orelse {
            std.debug.print("{s}: no lexer for {s}\n", .{ case.name, case.path });
            return error.MissingLexer;
        };

        const declared = try lexer.declarations(alloc, line);
        if (declared.len != case.declared.len) {
            try failures.append(alloc, try std.fmt.allocPrint(
                alloc,
                "{s} ({s}): {d} declaration(s), want {d}",
                .{ case.name, case.line, declared.len, case.declared.len },
            ));
        } else for (declared, case.declared) |got, want| {
            if (@intFromEnum(got.kind) != @intFromEnum(want.kind)) {
                try failures.append(alloc, try std.fmt.allocPrint(
                    alloc,
                    "{s} ({s}): kind {any}, want {any}",
                    .{ case.name, case.line, got.kind, want.kind },
                ));
            }
            if (!js.eql(got.name, try js.utf8Decode(alloc, want.name))) {
                try failures.append(alloc, try std.fmt.allocPrint(
                    alloc,
                    "{s} ({s}): name {any}, want {s}",
                    .{ case.name, case.line, got.name, want.name },
                ));
            }
            if (got.header_from != @as(usize, @intCast(want.header_from))) {
                try failures.append(alloc, try std.fmt.allocPrint(
                    alloc,
                    "{s} ({s}): header_from {d}, want {d}",
                    .{ case.name, case.line, got.header_from, want.header_from },
                ));
            }
            // `body = 'end'` and the terminator travel together, so comparing the terminator compares
            // both; the corpus never carries one without the other.
            if ((want.body == null) != (want.end == null)) {
                try failures.append(alloc, try std.fmt.allocPrint(
                    alloc,
                    "{s}: the corpus carries body without end",
                    .{case.name},
                ));
            } else if ((got.end_kw == null) != (want.end == null)) {
                try failures.append(alloc, try std.fmt.allocPrint(
                    alloc,
                    "{s} ({s}): end {any}, want {any}",
                    .{ case.name, case.line, got.end_kw, want.end },
                ));
            } else if (got.end_kw) |end_kw| {
                if (!js.eql(end_kw, try js.utf8Decode(alloc, want.end.?))) {
                    try failures.append(alloc, try std.fmt.allocPrint(
                        alloc,
                        "{s} ({s}): end {any}, want {s}",
                        .{ case.name, case.line, end_kw, want.end.? },
                    ));
                }
            }
            if (got.line != want.line) {
                try failures.append(alloc, try std.fmt.allocPrint(
                    alloc,
                    "{s} ({s}): line {any}, want {any}",
                    .{ case.name, case.line, got.line, want.line },
                ));
            }
        }
        checked += 1;
    }

    if (failures.items.len > 0) {
        std.debug.print("{d} of {d} shapes disagree with lib/section.mjs:\n", .{
            failures.items.len,
            checked,
        });
        for (failures.items) |failure| std.debug.print("  {s}\n", .{failure});
        return error.ShapeMismatch;
    }
    try testing.expectEqual(vectors.shape_cases.len, checked);
    try testing.expect(checked >= 40);
}
