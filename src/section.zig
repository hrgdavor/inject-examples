//! File-section matching — the Zig twin of `lib/section.mjs`.
//!
//! A reference (`#<name>`) is one or more selectors separated by `,`. A selector
//! is either a slash-separated path of segments — each naming something inside
//! the scope the previous one selected: a `#region` directive, a class-like or
//! method declaration, a property, a statement's condition literal, or a block
//! marked by a leading comment — or an explicit line range (`L40:12-L44:3`),
//! which selects verbatim lines and consults no matcher. What a path selection
//! comes back as is decided by its *scope modifier*: the declaration, its body
//! alone (`-`), the declaration with its annotations (`+`), or those with the doc
//! comment above them (`++`). The reference's own leading or trailing modifier
//! belongs to its last selector.
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
const error_codes = @import("error_codes.zig");
const vectors = @import("section_vectors.zig");

/// The four readings a scope modifier asks for.
pub const Scope = enum { declaration, body, annotated, documented };

/// The scope modifiers, as slices that outlive any reference they are stored
/// in — the JS `-`, `+` and `++` spellings.
pub const MOD_NONE: Str = &js.lit("-");
pub const MOD_SINGLE: Str = &js.lit("+");
pub const MOD_DOUBLE: Str = &js.lit("++");

/// One endpoint of a line range; `column` is 1-based, or null for the whole
/// line.
pub const LinePoint = struct { line: usize, column: ?usize = null };

/// A line range as a selector writes it: `L40`, `L40:12`, `L40-L44`,
/// `L40:12-L44:3`. Both endpoints are inclusive.
pub const SelectorRange = struct { from: LinePoint, to: ?LinePoint = null };

/// One selector of a reference: a semantic path, resolved by the matcher
/// precedence and the sibling-first walk, or explicit lines, which select
/// verbatim lines and consult no matcher.
pub const PathSelector = struct {
    raw: Str,
    segments: []Str,
    scope: Scope,
    /// A path whose last segment is an envelope mark carries it here: the mark is
    /// a segment of its own, and the parent is the path written before it.
    envelope: ?Envelope = null,
};
pub const LineSelector = struct { raw: Str, from: LinePoint, to: ?LinePoint = null };
pub const Selector = union(enum) { path: PathSelector, lines: LineSelector };

/// A JS `throw` carried out as a value, exactly as `Failure` does for
/// `index.mjs`: `message` is what the CLI prints. `grammar` marks a
/// `SectionReferenceError` — a malformed reference — so a caller can tell the
/// two apart without reading the message. `code` is the stable failure code of
/// RFC 1 §3.6, which a host branches on instead of parsing the message; it is the
/// same string `lib/section.mjs` reports.
pub const Failure = struct {
    message: Str = &.{},
    include: bool = false,
    grammar: bool = false,
    code: Str = &.{},

    /// A grammar failure: malformed as written, no file consulted.
    pub fn grammarMessage(self: *Failure, code: Str, message: Str) error{Failed} {
        self.message = message;
        self.grammar = true;
        self.code = code;
        return error.Failed;
    }

    /// A resolution failure: well formed, and the file cannot answer it.
    pub fn set(self: *Failure, code: Str, message: Str) error{Failed} {
        self.message = message;
        self.code = code;
        return error.Failed;
    }
};

pub const Error = error{ Failed, Grammar } || Allocator.Error;

// ===========================================================================
// Part A — the reference grammar
// ===========================================================================

/// A parsed reference.
///
/// A reference is one or more selectors. A reference of one `path` selector
/// keeps every field the single-reference grammar ever had — `segments` and
/// `scope` describe it. A reference of one `lines` selector reports no path
/// (`segments` is empty) and a `declaration` scope, because a line range has no
/// name and no modifier of its own; the selectors carry the ranges.
pub const Reference = struct {
    raw: Str,
    canonical: Str,
    /// The selectors in the order written. Null from `parseReference`, which is
    /// the single-path-selector reader, exactly as the JS leaves it null.
    selectors: ?[]const Selector = null,
    segments: []Str,
    scope: Scope,
};

fn scopeFromModifier(modifier: ?Str) Scope {
    const text = modifier orelse return .declaration;
    if (js.eql(text, MOD_NONE)) return .body;
    if (js.eql(text, MOD_SINGLE)) return .annotated;
    return .documented;
}

/// `segmentModifier`: the modifier a path **segment** is, or null when the
/// segment is a name.
///
/// A modifier is a segment of its own, written after the `/` that delimits it —
/// `toString/++`, `getUsers/-` — and it is legal only as the last segment of a
/// path. `-` is a modifier only as the whole segment, which is what keeps a CSS
/// custom property (`--brand`) and a hyphenated identifier addressable.
fn segmentModifier(segment: Str) ?Str {
    if (js.eql(segment, MOD_DOUBLE)) return MOD_DOUBLE;
    if (js.eql(segment, MOD_SINGLE)) return MOD_SINGLE;
    if (js.eql(segment, MOD_NONE)) return MOD_NONE;
    return null;
}

/// `NAME`: a name character — a `-` is one, a `+` never is, and a `.` may be.
fn isNameSegment(segment: Str) bool {
    if (segment.len == 0) return false;
    for (segment) |unit| {
        if (!js.isAsciiWord(unit) and unit != '.' and unit != '$' and unit != '-') return false;
    }
    return true;
}

/// `/^[-+]{2,}$/` — a segment that is nothing but modifier characters.
fn isModifierRun(segment: Str) bool {
    if (segment.len < 2) return false;
    for (segment) |unit| {
        if (unit != '-' and unit != '+') return false;
    }
    return true;
}

/// A path's **envelope marks**, as the last segment of its path: `^` is the
/// parent block's own first lines and `$` its last, written on the parent's path.
///
/// They are whole segments and nothing else, which is what keeps them out of
/// every name: `foo$` is the name `foo$` while `foo/$` is the last line of `foo`.
pub const EnvelopeMark = enum {
    open,
    close,

    pub fn text(self: EnvelopeMark) Str {
        return switch (self) {
            .open => &js.lit("^"),
            .close => &js.lit("$"),
        };
    }
};

fn envelopeMark(segment: Str) ?EnvelopeMark {
    if (segment.len != 1) return null;
    if (segment[0] == '^') return .open;
    if (segment[0] == '$') return .close;
    return null;
}

/// The envelope a path selector carries: which mark it ends in, and the parent
/// path written before it. The parent is owned by the selector's arena and never
/// emptied, so the list is read as `items[0..len]`.
pub const Envelope = struct {
    mark: EnvelopeMark,
    parent: std.ArrayList(Str),
};

/// `envelopeOf`: the mark this path ends in, with the parent written before it,
/// or null when the path does not carry one. A sentinel is never the *only*
/// segment — there would be no parent to open or close.
fn envelopeOf(alloc: Allocator, segments: []const Str) !?Envelope {
    if (segments.len < 2) return null;
    const mark = envelopeMark(segments[segments.len - 1]) orelse return null;
    var parent = std.ArrayList(Str).empty;
    try parent.appendSlice(alloc, segments[0 .. segments.len - 1]);
    return .{ .mark = mark, .parent = parent };
}

fn isEnvelopeMark(segment: Str) bool {
    return envelopeMark(segment) != null;
}

/// `assertName`: reject a name this grammar cannot carry, with the message that
/// says why. `+` has no meaning inside a name at all, and the only thing a user
/// means by it is a modifier — so the message names the spelling that works.
fn assertName(
    alloc: Allocator,
    segment: Str,
    raw: Str,
    carries_mark: bool,
    failure: *Failure,
) Error!void {
    if (isNameSegment(segment)) return;
    // A whole envelope mark is not a name but is a legal **last** segment.
    if (carries_mark and isEnvelopeMark(segment)) return;

    if (js.indexOfUnit(segment, '+')) |plus_at| {
        const run_len = plusRunLen(segment[plus_at..]);
        const plus = segment[plus_at .. plus_at + run_len];
        const before = segment[0..plus_at];
        if (before.len == 0) {
            return failure.grammarMessage(error_codes.modifier_old_spelling, try js.format(
                alloc,
                "\"{s}\" is a path segment now; it follows the path, as \"#<path>/{s}\"",
                .{ @as(Str, plus), @as(Str, plus) },
            ));
        }
        return failure.grammarMessage(error_codes.modifier_old_spelling, try js.format(
            alloc,
            "\"{s}\" is a path segment now; write \"#{s}/{s}\"",
            .{ @as(Str, plus), @as(Str, before), @as(Str, plus) },
        ));
    }

    return failure.grammarMessage(error_codes.empty_segment, try js.format(alloc, "\"#{s}\" names nothing", .{raw}));
}

/// The length of the `+` run at the start of `text`.
fn plusRunLen(text: Str) usize {
    var len: usize = 0;
    while (len < text.len and text[len] == '+') len += 1;
    return len;
}

/// `mergeModifiers`: a path has one modifier. Two is malformed rather than
/// contradictory — there is no section that is two scopes at once.
fn mergeModifiers(
    alloc: Allocator,
    modifiers: []const Str,
    raw: Str,
    failure: *Failure,
) Error!?Str {
    if (modifiers.len == 0) return null;
    if (modifiers.len == 1) return modifiers[0];
    return failure.grammarMessage(error_codes.too_many_modifiers, try js.format(
        alloc,
        "\"#{s}\" carries more than one modifier",
        .{@as(Str, raw)},
    ));
}

fn isDigitUnit(unit: ?u16) bool {
    const digit = unit orelse return false;
    return digit >= '0' and digit <= '9';
}

/// `LINE_RANGE_PREFIX`: does this selector at least begin like a line range?
fn isLineRangePrefix(raw: Str) bool {
    return raw.len >= 2 and raw[0] == 'L' and isDigitUnit(raw[1]);
}

/// `LINE_RANGE_FULL`, read by hand: `L<point>` and `L<point>-L<point>`, and
/// nothing else. Null when the text is not one of those two forms.
fn parseLineRange(raw: Str) ?SelectorRange {
    var at: usize = 0;
    const first = parseLinePoint(raw, &at) orelse return null;
    if (at < raw.len and raw[at] == '-') {
        at += 1;
        const second = parseLinePoint(raw, &at) orelse return null;
        // A second `-` is neither an endpoint nor the range's other end.
        if (at != raw.len) return null;
        return .{ .from = first, .to = second };
    }
    if (at != raw.len) return null;
    return .{ .from = first, .to = null };
}

/// One `L<line>` or `L<line>:<column>` endpoint; `at` advances past it.
fn parseLinePoint(raw: Str, at: *usize) ?LinePoint {
    var index = at.*;
    if (index >= raw.len or raw[index] != 'L') return null;
    index += 1;
    if (!isDigitUnit(if (index < raw.len) raw[index] else null)) return null;

    const line_start = index;
    while (index < raw.len and isDigitUnit(raw[index])) index += 1;
    const line = js.parseDigitRun(raw[line_start..index]);

    var column: ?usize = null;
    if (index < raw.len and raw[index] == ':') {
        index += 1;
        if (!isDigitUnit(if (index < raw.len) raw[index] else null)) return null;
        const column_start = index;
        while (index < raw.len and isDigitUnit(raw[index])) index += 1;
        column = js.parseDigitRun(raw[column_start..index]);
    }

    at.* = index;
    return .{ .line = line, .column = column };
}

/// `lineRangeOf`: read `raw` as a line-range selector, or null when it is not
/// one. Fails when the text claims to be a line range and is not one — `L40-`,
/// `L40:x`, `L0`, `L5-L2`, and a range carrying a modifier — because a
/// reference that opens `L<digit>` is a line range or a typo, never a name.
fn lineRangeOf(alloc: Allocator, raw: Str, failure: *Failure) Error!?SelectorRange {
    if (!isLineRangePrefix(raw)) return null;

    const malformed = js.format(
        alloc,
        "\"#{s}\" is not a line range; write L<line> or L<line>:<column>",
        .{@as(Str, raw)},
    );
    const range = parseLineRange(raw) orelse return failure.grammarMessage(error_codes.line_range_not_a_range, try malformed);

    const from_zero = range.from.line < 1 or
        (range.from.column != null and range.from.column.? < 1);
    const to_zero = if (range.to) |to|
        to.line < 1 or (to.column != null and to.column.? < 1)
    else
        false;
    if (from_zero or to_zero) {
        return failure.grammarMessage(error_codes.line_range_from_1, try js.format(
            alloc,
            "\"#{s}\" counts lines and columns from 1",
            .{@as(Str, raw)},
        ));
    }
    if (range.to) |to| {
        const backwards = to.line < range.from.line or
            (to.line == range.from.line and to.column != null and range.from.column != null and
                to.column.? < range.from.column.?);
        if (backwards) {
            return failure.grammarMessage(error_codes.line_range_backwards, try js.format(
                alloc,
                "\"#{s}\" ends before it starts",
                .{@as(Str, raw)},
            ));
        }
    }

    return range;
}

/// `parseReference`: the grammar of one **path** selector. A comma (that is
/// `parseSelectors`) and a line range are not a path, and are reported as such.
pub fn parseReference(alloc: Allocator, raw: Str, failure: *Failure) Error!Reference {
    if (raw.len == 0) return failure.grammarMessage(error_codes.empty_reference, try js.format(alloc, "\"#\" names nothing", .{}));
    if (js.indexOfUnit(raw, ',') != null) {
        return failure.grammarMessage(error_codes.empty_selector, try js.format(alloc, "\"#{s}\" has an empty selector", .{raw}));
    }
    // A reference names a section of **one** file, and the file is the path the
    // marker's link already carries: a second `#` is a link written into the
    // fragment by mistake, never a nested reference (RFC 1 §9.8).
    if (js.indexOfUnit(raw, '#') != null) {
        return failure.grammarMessage(error_codes.second_hash, try js.format(
            alloc,
            "\"#{s}\" has a second \"#\"; a reference names one file",
            .{raw},
        ));
    }
    if (isLineRangePrefix(raw)) {
        _ = try lineRangeOf(alloc, raw, failure); // fails when the range is malformed
        return failure.grammarMessage(error_codes.line_range_as_path, try js.format(
            alloc,
            "\"#{s}\" is a line range, not a section path",
            .{raw},
        ));
    }

    const parts = try splitSlash(alloc, raw);
    for (parts) |part| {
        if (part.len == 0) {
            return failure.grammarMessage(error_codes.empty_segment, try js.format(alloc, "\"#{s}\" has an empty path segment", .{raw}));
        }
    }
    if (parts.len > 8) {
        return failure.grammarMessage(error_codes.too_deep, try js.format(alloc, "\"#{s}\" is deeper than 8 sections", .{raw}));
    }

    var modifiers = std.ArrayList(Str).empty;
    var names = std.ArrayList(Str).empty;

    for (parts, 0..) |segment, index| {
        if (segmentModifier(segment)) |modifier| {
            if (index != parts.len - 1) {
                return failure.grammarMessage(error_codes.modifier_not_last, try js.format(
                    alloc,
                    "\"{s}\" may only modify the last path segment of \"#{s}\"",
                    .{ modifier, raw },
                ));
            }
            try modifiers.append(alloc, modifier);
            continue;
        }
        // A segment of nothing but modifiers (`+++`, `---`) is two of them on one
        // segment. `--` and `--brand` are names: a CSS custom property is one.
        if (isModifierRun(segment) and !(segment.len == 2 and segment[0] == '-' and segment[1] == '-')) {
            return failure.grammarMessage(error_codes.too_many_modifiers, try js.format(alloc, "\"#{s}\" carries more than one modifier", .{raw}));
        }
        try assertName(alloc, segment, raw, index == parts.len - 1, failure);
        try names.append(alloc, segment);
    }

    if (names.items.len == 0) {
        // A path of modifiers has no subject: `-` is the old body scope, and
        // `++`/`+` name nothing at all.
        if (segmentModifier(raw) == null) {
            return failure.grammarMessage(error_codes.too_many_modifiers, try js.format(alloc, "\"#{s}\" carries more than one modifier", .{raw}));
        }
        return failure.grammarMessage(error_codes.empty_segment, try js.format(alloc, "\"#{s}\" names nothing", .{raw}));
    }

    const modifier = try mergeModifiers(alloc, modifiers.items, raw, failure);

    var canonical = std.ArrayList(u16).empty;
    for (names.items, 0..) |name, index| {
        if (index > 0) try canonical.append(alloc, '/');
        try canonical.appendSlice(alloc, name);
    }
    if (modifier) |text| {
        try canonical.append(alloc, '/');
        try canonical.appendSlice(alloc, text);
    }

    return .{
        .raw = raw,
        .canonical = try canonical.toOwnedSlice(alloc),
        .segments = try names.toOwnedSlice(alloc),
        .scope = scopeFromModifier(modifier),
    };
}

/// `applyEnvelope`: check an envelope's shape, then read its interior selectors
/// inside the parent the marks name.
///
/// A mark is a whole segment of a path, so it cannot be confused with a name.
/// What has to be checked is that the pair makes sense: both ends present, one
/// parent between them, and in the `^` then `$` order. Anything else is an error
/// rather than a silent reading of something the user did not write.
fn applyEnvelope(
    alloc: Allocator,
    selectors: []Selector,
    raw: Str,
    failure: *Failure,
) Error!void {
    var any_mark = false;
    for (selectors) |selector| {
        if (selector == .path and selector.path.envelope != null) any_mark = true;
    }
    if (!any_mark) return;

    const first = selectors[0];
    const last = selectors[selectors.len - 1];
    if (selectors.len == 1) {
        const mark = first.path.envelope.?.mark;
        // `js.format` takes its format string as a compile-time value, so the two
        // spellings are written out rather than selected into a variable.
        if (mark == .open) {
            return failure.grammarMessage(error_codes.envelope_alone, try js.format(
                alloc,
                "\"#{s}\": a lone \"^\" has nothing to close",
                .{raw},
            ));
        }
        return failure.grammarMessage(error_codes.envelope_alone, try js.format(
            alloc,
            "\"#{s}\": a lone \"$\" has nothing to open",
            .{raw},
        ));
    }
    const first_mark = if (first == .path) first.path.envelope else null;
    const last_mark = if (last == .path) last.path.envelope else null;
    if (first_mark == null or last_mark == null or
        first_mark.?.mark != .open or last_mark.?.mark != .close)
    {
        return failure.grammarMessage(error_codes.envelope_order, try js.format(
            alloc,
            "\"#{s}\": an envelope is \"^\" first and \"$\" last, around what they open and close",
            .{raw},
        ));
    }
    for (selectors[1 .. selectors.len - 1]) |selector| {
        if (selector == .path and selector.path.envelope != null) {
            return failure.grammarMessage(error_codes.envelope_marks, try js.format(
                alloc,
                "\"#{s}\": an envelope has one \"^\" and one \"$\"",
                .{raw},
            ));
        }
    }

    // The path may be on either end; where both are written they must agree.
    var parent: ?[]Str = null;
    if (first_mark.?.parent.items.len > 0) parent = first_mark.?.parent.items;
    if (last_mark.?.parent.items.len > 0) {
        if (parent) |written| {
            if (!segmentsEqual(written, last_mark.?.parent.items)) {
                return failure.grammarMessage(error_codes.envelope_mismatch, try js.format(
                    alloc,
                    "\"#{s}\": \"^\" opens \"{s}\" and \"$\" closes \"{s}\"; they must be the same block",
                    .{ raw, try joinSlash(alloc, written), try joinSlash(alloc, last_mark.?.parent.items) },
                ));
            }
        } else parent = last_mark.?.parent.items;
    }
    if (parent == null) {
        return failure.grammarMessage(error_codes.envelope_no_block, try js.format(
            alloc,
            "\"#{s}\": neither \"^\" nor \"$\" names a block, so there is nothing to open or close",
            .{raw},
        ));
    }

    // What sits between the marks is read inside the block they name. A selector
    // that already starts with the parent's own path is left as written: it says
    // the same thing, and prepending the prefix twice would name nothing.
    const written = parent.?;
    for (selectors[1 .. selectors.len - 1]) |*selector| {
        if (selector.* != .path) continue;
        const own = selector.path.segments;
        if (own.len >= written.len and segmentsEqual(own[0..written.len], written)) continue;
        var merged = std.ArrayList(Str).empty;
        try merged.appendSlice(alloc, written);
        try merged.appendSlice(alloc, own);
        selector.path.segments = try merged.toOwnedSlice(alloc);
        selector.path.raw = try joinSlash(alloc, selector.path.segments);
    }

    // Both ends remember the parent, whichever end wrote it.
    selectors[0].path.envelope.?.parent = try copySegments(alloc, written);
    selectors[selectors.len - 1].path.envelope.?.parent = try copySegments(alloc, written);
}

fn segmentsEqual(one: []const Str, other: []const Str) bool {
    if (one.len != other.len) return false;
    for (one, other) |left, right| {
        if (!js.eql(left, right)) return false;
    }
    return true;
}

fn copySegments(alloc: Allocator, segments: []const Str) !std.ArrayList(Str) {
    var out = std.ArrayList(Str).empty;
    try out.appendSlice(alloc, segments);
    return out;
}

fn joinSlash(alloc: Allocator, segments: []const Str) !Str {
    var out = std.ArrayList(u16).empty;
    for (segments, 0..) |segment, index| {
        if (index > 0) try out.append(alloc, '/');
        try out.appendSlice(alloc, segment);
    }
    return out.toOwnedSlice(alloc);
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

/// `remainder.split(',')` — the selector separator.
fn splitComma(alloc: Allocator, text: Str) ![]Str {
    var parts = std.ArrayList(Str).empty;
    var start: usize = 0;
    while (js.indexOfUnit(text[start..], ',')) |offset| {
        try parts.append(alloc, text[start .. start + offset]);
        start += offset + 1;
    }
    try parts.append(alloc, text[start..]);
    return parts.toOwnedSlice(alloc);
}

/// `/^[\w$]/` — does this text at least open a name?
fn canOpenName(text: Str) bool {
    if (text.len == 0) return false;
    const unit = text[0];
    return js.isAsciiWord(unit) or unit == '$';
}

/// `/^[\w$/+-]/` — what a selector may open with. What cannot even open a name
/// (`@x`) names nothing; anything else is read by the single-selector grammar.
fn canOpenSelector(text: Str) bool {
    if (text.len == 0) return false;
    const unit = text[0];
    return js.isAsciiWord(unit) or unit == '$' or unit == '/' or unit == '+' or unit == '-';
}

/// `parseSelectors`: read a whole reference as its selectors, or fail.
///
/// A reference is one or more selectors separated by `,`: each is either a
/// semantic path (`Cart/Line/render/++`) or a line range (`L40:12-L44:3`). A
/// single path selector is the degenerate case and keeps the canonical spelling,
/// the segments and the scope `parseReference` always gave it.
///
/// A modifier belongs to the selector whose path carries it, so
/// `add/-,render/++` is two selectors that each say what they mean and nothing
/// is ambiguous between them. A line range carries no modifier at all.
pub fn parseSelectors(alloc: Allocator, raw: Str, failure: *Failure) Error!Reference {
    if (raw.len == 0) return failure.grammarMessage(error_codes.empty_reference, try js.format(alloc, "\"#\" names nothing", .{}));

    const parts = try splitComma(alloc, raw);
    for (parts) |part| {
        if (js.trim(part).len == 0) {
            return failure.grammarMessage(error_codes.empty_selector, try js.format(alloc, "\"#{s}\" has an empty selector", .{raw}));
        }
    }

    var selectors = std.ArrayList(Selector).empty;
    var canonical = std.ArrayList(u16).empty;

    for (parts, 0..) |part, index| {
        const trimmed = js.trim(part);

        // A selector that opens `L<digit>` is a line range or a typo, never a
        // name — read as a range before anything else, so `L40-` reports the
        // range rather than a path about a name nobody meant.
        if (isLineRangePrefix(trimmed)) {
            if (try lineRangeOf(alloc, trimmed, failure)) |range| {
                if (index > 0) try canonical.append(alloc, ',');
                try canonical.appendSlice(alloc, trimmed);
                try selectors.append(alloc, .{ .lines = .{
                    .raw = trimmed,
                    .from = range.from,
                    .to = range.to,
                } });
                continue;
            }
        }

        // A mark may be written **bare** — `Inventory/^,toString,$` — and then it
        // is the *other* mark's parent it refers to, so the path is named once.
        // The bare spelling is a whole selector of one segment, which no path
        // reaches because a mark needs a parent.
        if (envelopeMark(trimmed)) |mark| {
            if (index > 0) try canonical.append(alloc, ',');
            try canonical.appendSlice(alloc, trimmed);
            try selectors.append(alloc, .{ .path = .{
                .raw = trimmed,
                .segments = try alloc.dupe(Str, &.{trimmed}),
                .scope = .declaration,
                .envelope = .{ .mark = mark, .parent = std.ArrayList(Str).empty },
            } });
            continue;
        }

        // A path is a name. What cannot even open a name — `@x` — names nothing;
        // anything else is read by the single-selector grammar, whose own errors
        // are the ones a user needs to see.
        if (!canOpenSelector(trimmed)) {
            return failure.grammarMessage(error_codes.empty_segment, try js.format(alloc, "\"#{s}\" names nothing", .{trimmed}));
        }
        const parsed = try parseReference(alloc, trimmed, failure);
        if (index > 0) try canonical.append(alloc, ',');
        try canonical.appendSlice(alloc, parsed.canonical);
        try selectors.append(alloc, .{ .path = .{
            .raw = trimmed,
            .segments = parsed.segments,
            .scope = parsed.scope,
            .envelope = try envelopeOf(alloc, parsed.segments),
        } });
    }

    // The envelope's own validation, and the rewriting that reads the interior
    // selectors inside the parent the marks name.
    try applyEnvelope(alloc, selectors.items, raw, failure);

    // A reference of one path selector carries a scope the resolver applies; a
    // line range has none, and a mixed reference resolves each selector with its
    // own.
    var segments: []Str = &.{};
    var scope: Scope = .declaration;
    if (selectors.items.len == 1) switch (selectors.items[0]) {
        .path => |path| {
            segments = path.segments;
            scope = path.scope;
        },
        .lines => {},
    };

    return .{
        .raw = raw,
        .canonical = try canonical.toOwnedSlice(alloc),
        .selectors = try selectors.toOwnedSlice(alloc),
        .segments = segments,
        .scope = scope,
    };
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
    /// The line the body starts on, when the header wrapped and its own lines
    /// are the declaration's rather than the body's.
    body_from: ?usize = null,
    indented: bool = false,
    expression: ?usize = null,
    /// The last line an expression body extends onto (a `do` block). The
    /// JavaScript only copies this onto a block for a language's own shape.
    expression_end_line: ?usize = null,
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
    /// The block this one was declared in, and the same link named `scope`. The walker carries the scope as it
    /// descends, so no rule reads these today — but every port records them, so a member can answer "which
    /// scope declared me?" without the walk, exactly as the JavaScript, Java and Rust ports do (2026-10-14).
    parent: ?*Block = null,
    scope: ?*Block = null,
    /// The owning scope's own name and declaration line, when it has them: the root has neither.
    scope_name: ?Str = null,
    scope_line: ?usize = null,
    open: ?usize = null,
    close: ?usize = null,
    open_line: ?usize = null,
    close_line: ?usize = null,
    indented: bool = false,
    expression: ?usize = null,
    expression_end_line: ?usize = null,
    body_from: ?usize = null,
    end_line: ?usize = null,
    /// The last line a property's *statement* covers: for a lambda or an array
    /// initialiser that is several lines below the line the name is written on,
    /// and for a plain field it is that line.
    line_end: ?usize = null,
    /// The offset of the `=` that opened a property's initialiser, or null when
    /// it has none.
    equals_at: ?usize = null,
    /// One past the `;` that ended a property's statement, which is where its
    /// initialiser stops.
    statement_to: ?usize = null,
    /// For an enum constant: one past its name, where its arguments and its body
    /// begin.
    name_end: ?usize = null,
    /// True when this property is an enum constant, whose `-` scope is what
    /// follows its name.
    enum_constant: bool = false,
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
    for (top) |child| {
        // A top-level block belongs to the file's root, which has no name of its own — the same two facts the
        // other ports set on the root's children (2026-10-14).
        child.parent = root;
        child.scope = root;
        try root.children.append(alloc, child);
    }

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

/// A declaration's header, as the scanner followed it: the offset just past the
/// `{` or `;` that ended it — or the end of its last line — and that line.
const HeaderEnd = struct { end: usize, last: usize };

fn braceBody(mask: Str, starts: []const usize, open: usize) ?Span {
    const close = matchingBracket(mask, open, '}') orelse return null;
    return .{
        .open = open,
        .close = close,
        .open_line = lineOf(starts, open),
        .close_line = lineOf(starts, close),
    };
}

/// `text.slice(from, to)` with JavaScript's clamping: a `from` past the end is
/// the empty tail, and a `to` before `from` is empty.
fn maskSlice(text: Str, from: usize, to: usize) Str {
    const low = @min(from, text.len);
    const high = @min(@max(to, low), text.len);
    return text[low..high];
}

/// `text.indexOf(unit, from)` — null when it is not there, `from` past the end
/// included.
fn indexOfFrom(text: Str, unit: u16, from: usize) ?usize {
    if (from > text.len) return null;
    const offset = js.indexOfUnit(text[from..], unit) orelse return null;
    return from + offset;
}

/// `text.lastIndexOf(unit, position)`: the search covers `0 ..= position`, and a
/// negative position is clamped to 0 — which still reads index 0 — as
/// JavaScript's does.
fn lastIndexOfAt(text: Str, unit: u16, position: isize) ?usize {
    if (text.len == 0) return null;
    const stop: usize = if (position < 0) 0 else @min(@as(usize, @intCast(position)), text.len - 1);
    return js.lastIndexOfUnit(text[0 .. stop + 1], unit);
}

/// The offset of the `=` that introduces an expression body, or null.
///
/// A `=` that stands for `==`, `<=`, `>=`, `!=` or `+=` is not a body — and
/// neither is a type annotation's (`name: Type =`), which is why the character
/// right after the `=` must not be `=`, and the last character before it must
/// close something: a type, a bracket or a `>`.
fn expressionAt(rest: Str) ?usize {
    var at: usize = 0;
    while (js.indexOfUnit(rest[at..], '=')) |offset| {
        const index = at + offset;
        at = index + 1;
        if (index + 1 < rest.len and rest[index + 1] == '=') continue;
        if (index == 0) continue;
        const previous = rest[index - 1];
        const closes = js.isAsciiWord(previous) or previous == '$' or previous == '>' or
            previous == ')' or previous == ']' or previous == '}';
        if (closes) return index;
    }
    return null;
}

/// The first of `{`, `;` and `=>` in a header, in the order they appear — the
/// thing that ended it. A `;` means no body, a `{` opens one, and `=>` is an
/// arrow; whichever comes first is what the header ended with.
const Terminator = struct { at: usize, kind: enum { brace, none, arrow } };

fn terminatorIn(rest: Str) ?Terminator {
    var found: ?Terminator = null;
    if (js.indexOfUnit(rest, '{')) |at| found = .{ .at = at, .kind = .brace };
    if (js.indexOfUnit(rest, ';')) |at| {
        if (found == null or at < found.?.at) found = .{ .at = at, .kind = .none };
    }
    if (js.indexOf(rest, &js.lit("=>"))) |at| {
        if (found == null or at < found.?.at) found = .{ .at = at, .kind = .arrow };
    }
    return found;
}

/// `/^\s*\{\s*$/` — a line that is nothing but an Allman brace.
fn isBraceOnly(text: Str) bool {
    var at: usize = 0;
    while (at < text.len and js.isWhitespace(text[at])) at += 1;
    if (at >= text.len or text[at] != '{') return false;
    at += 1;
    while (at < text.len and js.isWhitespace(text[at])) at += 1;
    return at == text.len;
}

/// `/^\s*\{/` — a line that opens with a brace.
fn isBraceStart(text: Str) bool {
    var at: usize = 0;
    while (at < text.len and js.isWhitespace(text[at])) at += 1;
    return at < text.len and text[at] == '{';
}

/// How much `text` opens across every bracket a header can hold, from `from`.
///
/// This is JavaScript's separate `bracketDepth` helper: it seeds a header's
/// count from the text **before** the header starts, where a `>` is counted
/// plainly — only the header's own scan knows an arrow's `>` from a closing
/// angle bracket.
fn bracketDepth(text: Str, from: usize, to: usize) isize {
    var depth: isize = 0;
    const stop = @min(to, text.len);
    var at = from;
    while (at < stop) : (at += 1) {
        const char = text[at];
        if (char == '(' or char == '[' or char == '{' or char == '<') {
            depth += 1;
        } else if (char == ')' or char == ']' or char == '}' or char == '>') {
            depth -= 1;
        }
    }
    return depth;
}

/// How far a declaration's header may run past the line it starts on.
const HEADER_LINES = 200;

/// Where a declaration's header ends, starting at `from` on `line`.
///
/// Wrapping a parameter list is formatting, not a different declaration, so a
/// header may span lines — but only while it could still be a header. It ends at
/// the first `{` or `;` met with every bracket closed, and stops at the blank
/// line or the line that cannot continue it (a body-less member, a declaration
/// the mask cut short). The window starts at the offset the caller passes — the
/// declaration's own name, or a shape's offset — and its end is never clamped
/// back to the line start.
fn headerEnd(mask_lines: []const Str, starts: []const usize, line: usize, from: usize) HeaderEnd {
    const stop = @min(mask_lines.len - 1, line + HEADER_LINES - 1);
    // Everything before where the header starts is already the declaration's
    // name; its brackets are not the header's, so the count begins after them.
    var depth: isize = 0;
    var start = from;
    var index = line;
    while (index <= stop) : (index += 1) {
        const text = mask_lines[index];
        if (index > line and js.trim(text).len == 0) break;
        if (depth == 0) {
            const before = if (start > starts[index]) start - starts[index] else 0;
            depth = bracketDepth(text, 0, before);
        }
        var column: usize = if (start > starts[index]) start - starts[index] else 0;
        while (column < text.len) : (column += 1) {
            const char = text[column];
            // A `{` or `;` with every bracket closed ends the header, and is
            // part of it: the body starts after it.
            if (depth == 0 and (char == '{' or char == ';')) {
                return .{ .end = starts[index] + column + 1, .last = index };
            }
            // An arrow's `>` is not a closing angle bracket: `=>` and `->` are
            // punctuation, and counting one as a bracket ends a header that was
            // still open.
            const previous: ?u16 = if (column == 0) null else text[column - 1];
            if (char == '(' or char == '[' or char == '{' or char == '<') {
                depth += 1;
            } else if (char == ')' or char == ']' or char == '}') {
                depth -= 1;
            } else if (char == '>') {
                const arrow = previous != null and (previous.? == '=' or previous.? == '-');
                if (!arrow) depth -= 1;
            }
        }
        // A closer with nothing open is not an error and does not end the header.
        // A `<` that a generic list should have balanced may have been a
        // less-than (`class Wrapped<` then `T extends Comparable<T>,`), and the
        // first `>` then reads as one closer too many; ending the header there
        // would leave the whole declaration bodyless. The count is therefore taken
        // from the top of the next line, so a line never ends in debt.
        depth = @max(0, depth);
        start = starts[index] + text.len;
        // A header continues while a bracket is open, while the line ends on a
        // separator, and onto a `{` alone on the next line — the Allman brace,
        // which no other rule reaches. A `{` at the end of the header's own line
        // was already found above.
        //
        // A *name* may end a header line that is still mid-declaration, which no
        // separator reveals: a wrapped class header writes its supertype on a line
        // of its own (`implements Renderer<T>`), and the `{` follows on the next
        // one. Only the heads that can open such a tail are followed — a `throws`,
        // or an `extends`/`implements` clause with an identifier still after the
        // keyword — so a bodyless member that happens to end on a word
        // (`abstract String label(` then `  int width)`) keeps its indented body.
        const next = nextNonBlank(mask_lines, index + 1);
        const continues = depth > 0 or headerContinues(text) or headerTail(text) or
            (next != null and isBraceOnly(mask_lines[next.?]));
        if (!continues) return .{ .end = start, .last = index };
    }
    index = @min(index, mask_lines.len - 1);
    return .{ .end = starts[index] + mask_lines[index].len, .last = index };
}

/// `/[(,;]\s*$/` — whether the next line could continue a header this one ends.
fn headerContinues(text: Str) bool {
    var at = text.len;
    while (at > 0 and js.isWhitespace(text[at - 1])) at -= 1;
    if (at == 0) return false;
    const unit = text[at - 1];
    return unit == '(' or unit == ',' or unit == ';';
}

/// The end of a property's *statement*.
///
/// A field is a statement, and the statement is the selection — so the span has
/// to be the whole of it and not the line its name is written on. For a language
/// that terminates its statements the `;` decides, and it is the first one met
/// with every bracket closed: a `{` with every bracket closed is ordinarily the
/// body and would end a declaration header, but inside a field's *expression* a
/// `{` opens one — the lambda of `Runnable arrow = () -> { … };`, an array or an
/// anonymous-class initialiser — so the scan tracks the brackets themselves and
/// the `;` closes the statement wherever the initialiser left it.
///
/// A language with no `;` (Kotlin, Go, C#, Python) needs the other half of the
/// rule: the statement also ends at the end of a line that closes every bracket
/// it opened, when nothing about the next line continues it — a line that ends on
/// an operator, a comma or an opening bracket, or a next line indented *deeper*
/// than the declaration. A next line at the declaration's own indentation starts
/// a sibling instead, and reading on would take that sibling's text into the
/// property.
///
/// `source_lines` are the **source** lines and `source_starts` their own offsets:
/// every level is read from the source, never the mask, because the mask blanks
/// a literal's delimiters — a line of it is shorter than the line of source it
/// stands for, and a closing delimiter reads as blank.
fn statementEnd(
    mask: Str,
    source_lines: []const Str,
    source_starts: []const usize,
    from: usize,
    to: usize,
) struct { end: usize, last: usize } {
    const decl_line = lineOf(source_starts, from);
    const indent = if (decl_line < source_lines.len) indentWidth(source_lines[decl_line]) else 0;
    const limit = @min(to, mask.len);
    var depth: isize = 0;
    var last = from;
    var content_end = from;
    var line = decl_line;
    while (line < source_starts.len and source_starts[line] < to) : (line += 1) {
        const line_start = @max(source_starts[line], from);
        const text_line = source_lines[@min(line, source_lines.len - 1)];
        const line_end = @min(line_start + text_line.len, limit);
        // The line without its trailing blanks, so its end is the offset just
        // past the last real character the line has.
        const text = js.trimEnd(text_line);
        const in_literal = line > decl_line and
            js.trim(mask[@min(line_start, mask.len)..@min(line_end, mask.len)]).len == 0 and
            text.len != 0;
        if (line > decl_line and text.len == 0) break;
        if (in_literal) {
            // A line the mask blanked but the source did not is part of a string
            // literal that spans lines. It is not a statement boundary — neither
            // its indentation nor its own braces mean anything, since both are the
            // literal's own text — so the statement simply reaches through it, and
            // the literal's closing line comes with it.
            if (line_end > last) last = line_end;
            content_end = line_start + text.len;
            continue;
        }
        var stop = false;
        var at = line_start;
        while (at < line_end) : (at += 1) {
            const char = mask[at];
            if (char == '(' or char == '[' or char == '{') {
                depth += 1;
            } else if (char == ')' or char == ']' or char == '}') {
                if (depth == 0) {
                    stop = true;
                    break;
                }
                depth -= 1;
            } else if (char == ';' and depth == 0) {
                return .{ .end = at, .last = lineOf(source_starts, at) };
            }
        }
        // The statement so far reaches the end of this line, `;` or not, and its
        // text ends there — before the newline, and before any trailing blank.
        if (line_end > last) last = line_end;
        if (text.len != 0) content_end = line_start + text.len;
        if (stop) break;
        if (line > decl_line and depth == 0) {
            // Nothing continues this line: it closes what it opened and does not
            // end on an operator or an opening bracket. An `=` that ends a line is
            // not punctuation here — the initialiser may be an expression the next
            // line carries, which the indentation decides.
            if (!endsOnAnOperator(mask, line_start, line_end)) {
                const next = nextSourceLine(source_lines, line + 1) orelse break;
                if (indentWidth(source_lines[next]) <= indent) break;
            }
        }
    }
    // The scan stopped on a line that ends the statement. Its declaration reaches
    // the end of that line, and its initialiser's own text stops at the last real
    // character the statement has — never at the newline, and never at the end of
    // the file.
    const block_end = @max(last, content_end);
    const initializer_end = if (content_end == from) block_end else content_end;
    return .{ .end = initializer_end, .last = lineOf(source_starts, block_end) };
}

/// The offset of each line's first unit, for a scan that has to measure lines in the source.
fn lineStarts(alloc: Allocator, text: Str) ![]usize {
    var starts = std.ArrayList(usize).empty;
    try starts.append(alloc, 0);
    for (text, 0..) |unit, at| {
        if (unit == '\n') try starts.append(alloc, at + 1);
    }
    return starts.toOwnedSlice(alloc);
}

/// The first line at or after `line` the source has text on, or null.
fn nextSourceLine(source_lines: []const Str, line: usize) ?usize {
    var at = line;
    while (at < source_lines.len) : (at += 1) {
        if (js.trim(source_lines[at]).len != 0) return at;
    }
    return null;
}

/// `[,+\-*/%&|?<(\[{!~^]\s*$` — whether a line ends on an operator or an opening
/// bracket.
fn endsOnAnOperator(mask: Str, from: usize, to: usize) bool {
    var at = @min(to, mask.len);
    while (at > from and js.isWhitespace(mask[at - 1])) at -= 1;
    if (at == from) return false;
    const unit = mask[at - 1];
    return switch (unit) {
        ',', '+', '-', '*', '/', '%', '&', '|', '?', '<', '(', '[', '{', '!', '~', '^' => true,
        else => false,
    };
}

/// `/\w[\w$]*[>)\]}\s]*$/` — whether the line's last non-blank character is a
/// name. The trailing closers may be there: a wrapped supertype ends on
/// `Renderer<T>`, and the `>` is not what decides that the declaration is
/// unfinished.
fn endsOnAWord(text: Str) bool {
    var at = text.len;
    while (at > 0) {
        const unit = text[at - 1];
        if (js.isWhitespace(unit) or unit == '>' or unit == ')' or unit == ']' or unit == '}') {
            at -= 1;
            continue;
        }
        break;
    }
    return at > 0 and js.isAsciiWord(text[at - 1]);
}

/// `/\b(?:extends|implements)\s+[\w$][\w$.,<>?\[\]\s]*\w/` and `/\bthrows\s+\w/`
/// together — the heads that can open a tail ending on a name.
fn headerTail(text: Str) bool {
    return wordThenName(text, "throws") or wordThenName(text, "extends") or
        wordThenName(text, "implements");
}

/// `word`, whitespace, then a type that ends the line: the clause's own spelling.
fn wordThenName(text: Str, word: []const u8) bool {
    var at: usize = 0;
    while (at + word.len <= text.len) : (at += 1) {
        if (!js.eqlBytes(text[at .. at + word.len], word)) continue;
        if (!js.isWordBoundary(text, at)) continue;
        if (at + word.len >= text.len) continue;
        // `\s+` between the keyword and the name.
        var named = at + word.len;
        while (named < text.len and js.isWhitespace(text[named])) named += 1;
        if (named == at + word.len or named >= text.len) continue;
        if (!js.isIdentPart(text[named])) continue;
        const tail = text[named..];
        if (!endsOnAWord(tail)) continue;
        // Only a name, a dotted or generic type, and separators may sit between
        // the two, so a word that merely occurs inside a longer expression does
        // not read as a clause.
        var only_a_type = true;
        for (tail) |unit| {
            if (js.isIdentPart(unit) or isTypePunctuation(unit) or js.isWhitespace(unit)) continue;
            only_a_type = false;
            break;
        }
        if (only_a_type) return true;
    }
    return false;
}

/// `[\w$.,<>?\[\]\s]` — the punctuation a supertype clause may carry.
fn isTypePunctuation(unit: u16) bool {
    return unit == '.' or unit == ',' or unit == '<' or unit == '>' or unit == '?' or
        unit == '[' or unit == ']';
}

/// An expression body beginning at `at`: it runs to the end of its line, and on
/// through the indented lines that follow it — a `do` block, a `where` clause —
/// which the declaration's own indentation governs.
fn expressionBody(lines: []const Str, starts: []const usize, decl_line: usize, at: usize) Span {
    const first = lineOf(starts, at);
    const indent = indentWidth(lines[decl_line]);
    // A body that starts on the declaration's own line is the rest of that line
    // (`const inc = (n) => n + 1;`); the lines below belong to it only when it
    // starts on a later one and they are indented under the declaration — a `do`
    // block under a wrapped `main = do`.
    var last = if (first > decl_line) first else decl_line;
    if (first > decl_line) {
        var index = first + 1;
        while (index < lines.len) : (index += 1) {
            if (js.trim(lines[index]).len == 0) break;
            if (indentWidth(lines[index]) <= indent) break;
            last = index;
        }
    }
    return .{ .expression = at, .expression_end_line = last };
}

/// A body span, or null when the member has no body to inject (an interface or
/// `abstract` method).
///
/// `from` is where the declaration's header starts in the mask — after its name,
/// for the matchers that stop there — and the header is followed to its `{` or
/// `;` wherever that is, which is what lets a wrapped parameter list resolve.
fn bodySpan(
    mask: Str,
    lines: []const Str,
    starts: []const usize,
    decl_line: usize,
    from: usize,
    name_at: usize,
    shape_at_body: bool,
) ?Span {
    // A shape whose own `headerFrom` is the `=` itself (a Haskell binding, a
    // Rust `const`) states its expression body directly; the expression is what
    // follows, and its own lines are indented under the declaration. Only a shape
    // says this.
    if (shape_at_body and from < mask.len and mask[from] == '=') {
        return expressionBody(lines, starts, decl_line, from + 1);
    }

    const header = headerEnd(lines, starts, decl_line, name_at);
    const rest = maskSlice(mask, from, header.end);

    // The arrow that opens the body, read first: for `(n) => n + 1;` the `=>` is
    // what declares the member's body, and the `;` after it closes that body
    // rather than declaring a body-less member. A caller's `from` may also sit on
    // the `=` or the `>` of the arrow itself.
    const arrow = js.indexOf(rest, &js.lit("=>"));
    var arrow_at: ?usize = null;
    if (arrow) |offset| {
        arrow_at = from + offset;
    } else if (from < mask.len and (mask[from] == '=' or mask[from] == '>')) {
        arrow_at = from;
    }
    const arrow_here: ?usize = if (arrow_at) |at| at - from else null;

    // The header's own scan ended on the `{` that opens the body (a shape like
    // `impl Cart {`, or any caller whose `from` sits just after it), so the body
    // is cut from that column and never from a later brace in the body.
    if (arrow_here == null and from > 0 and mask[from - 1] == '{') {
        return braceBody(mask, starts, from - 1);
    }

    if (arrow_here) |here| {
        const at = from + here + 2;
        const brace = indexOfFrom(mask, '{', at);
        const line_end = endOfLine(mask, @min(at, mask.len));
        if (brace == null or brace.? > line_end) {
            return expressionBody(lines, starts, decl_line, at);
        }
        return braceBody(mask, starts, brace.?);
    }

    const terminator = terminatorIn(rest);

    // A `;` with every bracket closed is a member with no body to inject.
    if (terminator != null and terminator.?.kind == .none) return null;

    if (terminator) |term| {
        // `from` may already be the terminator's own column (a shape whose offset
        // is the `{`) or a character or two before it.
        const brace = indexOfFrom(mask, '{', from);
        const at = @max(
            if (brace) |value| @as(isize, @intCast(value)) else -1,
            @as(isize, @intCast(from + term.at)),
        );
        return braceBody(mask, starts, @intCast(at));
    }

    // The header itself ended on the `{` that opens the body (a shape like
    // `impl Cart {`), so the body is cut from that column.
    const opened_at = lastIndexOfAt(mask, '{', @as(isize, @intCast(header.end)) - 1);
    if (opened_at) |at| {
        if (at >= from) return braceBody(mask, starts, at);
    }

    // An `=` opens an expression body, and is checked before the indentation
    // rule: an indented line after a `=` is part of the *expression*, not a body.
    // `expressionAt` wants a word character before the `=`, which is how a Kotlin
    // `): String = expr` and a `fun f(): T = expr` both spell one; an `=` that only
    // a space precedes is still the body's, because the caller has already decided
    // this is a declaration. The remainder may begin *at* the `=` (the header ended
    // on it), so the expression starts one past whichever `=` was found.
    if (expressionAt(rest)) |equals| {
        return expressionBody(lines, starts, decl_line, from + equals + 2);
    }
    if (js.indexOfUnit(rest, '=')) |bare| {
        if (!(bare + 1 < rest.len and rest[bare + 1] == '=')) {
            return expressionBody(lines, starts, decl_line, from + bare + 2);
        }
    }

    // No terminator on the header's own lines. The body is then the next block:
    // a `{` on a later line (a wrapped `) throws X` line, an Allman brace) or the
    // indented block the declaration's own indentation governs.
    const next = nextNonBlank(lines, header.last + 1) orelse return null;
    const indent = indentWidth(lines[decl_line]);

    // The next line, if it opens the body itself.
    const first = lines[next];
    if (isBraceStart(first)) {
        const brace = js.indexOfUnit(first, '{').?;
        return braceBody(mask, starts, starts[next] + brace);
    }

    // A line that still belongs to the declaration — a `throws` clause, a return
    // type — puts the `{` after it. A wrapped header's body starts after the last
    // of its lines, so the search begins there.
    const search_from = @max(next, header.last);
    const after = maskSlice(mask, from, starts[search_from] + lines[search_from].len);
    const deferred = terminatorIn(after);
    if (deferred != null and deferred.?.kind == .none) return null;
    if (deferred != null and deferred.?.kind == .brace) {
        return braceBody(mask, starts, from + deferred.?.at);
    }

    if (indentWidth(first) > indent) {
        var last = next;
        var index = next + 1;
        while (index < lines.len) : (index += 1) {
            if (js.trim(lines[index]).len == 0) continue;
            if (indentWidth(lines[index]) <= indent) break;
            last = index;
        }
        // A wrapped header's own lines are not part of its body.
        return .{
            .indented = true,
            .body_end_line = last,
            .body_from = @max(next, header.last + 1),
        };
    }
    return null;
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
        if (text.len > word.len and js.startsWith(text, word) and text[word.len] == ' ') {
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

/// `[^\w$.]` — the one separator character `(^|[^\w$.])` may consume before a
/// name. (Not `\b`: the name patterns also accept a leading `$`.)
fn isSeparatorUnit(unit: u16) bool {
    return !(js.isAsciiWord(unit) or unit == '$' or unit == '.');
}

const CallMatch = struct { name_at: usize, paren: usize };

/// `(^|[^\w$.])name\s*\(` — the next call-shaped mention of `name`, from `from`.
fn nextCallMatch(line: Str, name: Str, from: usize) ?CallMatch {
    if (name.len == 0) return null;
    var at = from;
    while (js.indexOf(line[at..], name)) |offset| {
        const start = at + offset;
        at = start + 1;
        if (start > 0 and !isSeparatorUnit(line[start - 1])) continue;
        const after = start + name.len;
        if (after < line.len and (js.isAsciiWord(line[after]) or line[after] == '$')) continue;
        var scan = after;
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        if (scan < line.len and line[scan] == '(') return .{ .name_at = start, .paren = scan };
    }
    return null;
}

/// A hit of the assigned pattern: the whole `const name = …` match's start and
/// end, and how much its leading `(^|[^\w$.])` group consumed — 0 when the match
/// opened at `^`, 1 when it ate a separator character. `start + lead` is the
/// payload's offset (`match.index + match[1].length`), which is where the
/// JavaScript puts a `nameAt` and where it starts comparing the prefix.
const AssignedMatch = struct { start: usize, lead: usize, end: usize };

/// `(^|[^\w$.])(?:const\s+|let\s+|var\s+)?name\b(?:\s*:\s*[^=\n]+)?\s*=\s*(?:async\s+)?`.
fn nextAssignedMatch(line: Str, name: Str, from: usize) ?AssignedMatch {
    if (name.len == 0) return null;
    var at = from;
    while (js.indexOf(line[at..], name)) |offset| {
        const start = at + offset;
        at = start + 1;
        if (start > 0 and !isSeparatorUnit(line[start - 1])) continue;
        const after = start + name.len;
        if (after < line.len and js.isAsciiWord(line[after])) continue;

        var scan = after;
        // An optional type annotation, `\s*:\s*[^=\n]+`, and never a newline.
        var colon = scan;
        while (colon < line.len and js.isWhitespace(line[colon])) colon += 1;
        if (colon < line.len and line[colon] == ':') {
            var typed = colon + 1;
            while (typed < line.len and js.isWhitespace(line[typed])) typed += 1;
            const first = typed;
            while (typed < line.len and line[typed] != '=') typed += 1;
            if (typed > first) scan = typed;
        }
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        if (scan >= line.len or line[scan] != '=') continue;
        scan += 1;
        while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        const async_kw = &js.lit("async");
        if (js.startsWith(line[scan..], async_kw) and js.isWordBoundary(line, scan + async_kw.len)) {
            scan += async_kw.len;
            while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
        }
        const head = assignedMatchLead(line, start);
        return .{ .start = head.start, .lead = head.lead, .end = scan };
    }
    return null;
}

/// Where the assigned pattern's whole match begins for a name found at `name_at`,
/// and how much its leading group consumed. The pattern is
/// `(^|[^\w$.])(?:const\s+|let\s+|var\s+)?name…`, so the match begins at the
/// `const`/`let`/`var` head's own separator — or at offset 0 when the head, or
/// the name itself, opens the text — and otherwise at the one separator
/// character just before the name.
const AssignedLead = struct { start: usize, lead: usize };

fn assignedMatchLead(text: Str, name_at: usize) AssignedLead {
    const heads = [_][]const u8{ "const ", "let ", "var " };
    for (heads) |head| {
        if (name_at < head.len) continue;
        if (!js.eqlBytes(text[name_at - head.len .. name_at], head)) continue;
        const head_start = name_at - head.len;
        if (head_start == 0) return .{ .start = 0, .lead = 0 };
        if (isSeparatorUnit(text[head_start - 1])) return .{ .start = head_start - 1, .lead = 1 };
    }
    return if (name_at == 0) .{ .start = 0, .lead = 0 } else .{ .start = name_at - 1, .lead = 1 };
}

const Declaration = struct {
    kind: Kind,
    name: Str,
    /// Where the declared name starts, for a header scan that counts brackets
    /// from it.
    name_at: usize,
    /// Where the body's search starts in the mask.
    header_from: usize,
};

/// Whether a masked line declares `name`, and where its header starts.
///
/// The declaration is read from its own line whenever that line says everything
/// there is to say, which is the only shape the matcher ever had to read. A
/// header that wraps — a parameter list, a generic list, a `throws` clause — is
/// not readable that way, because the closing bracket sits on a later line; for
/// those, {@link declarationAcross} reads the header the scanner followed. The
/// line's own reading is what decides *whether* there is a declaration at all —
/// a bare name that merely appears inside a wrapped construct must not become
/// one.
///
/// `across` is the JavaScript's `lex !== null`: the assigned-name scan passes no
/// lexer, so its candidates are never read across lines.
fn declarationOn(
    alloc: Allocator,
    facts: Facts,
    masked_line: Str,
    start: usize,
    name: Str,
    across: bool,
) !?Declaration {
    if (name.len == 0 or isNotAName(name)) return null;

    if (matchDeclarationKeyword(masked_line)) |keyword| {
        if (js.eql(keyword.name, name)) {
            const within = js.indexOf(masked_line[keyword.index..], keyword.name) orelse 0;
            return .{
                .kind = .class,
                .name = name,
                .name_at = start + keyword.index + within,
                .header_from = start + keyword.index + keyword.length,
            };
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
        return .{
            .kind = .method,
            .name = name,
            .name_at = start + hit.name_at,
            .header_from = start + close + 1,
        };
    }

    // The parameter list may close on a later line, where only the whole
    // header can see it.
    if (across) {
        if (try declarationAcross(alloc, facts, start, name)) |found| return found;
    }

    from = 0;
    while (nextAssignedMatch(masked_line, name, from)) |hit| {
        from = hit.end;
        const rest = masked_line[hit.end..];
        const arrow = js.indexOf(rest, &js.lit("=>"));
        const keyword = functionKeywordEnd(rest);
        const body_at: ?usize = if (arrow != null and (keyword == null or arrow.? < keyword.?))
            start + hit.end + arrow.?
        else if (keyword) |end|
            start + hit.end + end
        else
            null;
        const header_from = body_at orelse continue;
        return .{
            .kind = .method,
            .name = name,
            .name_at = start + hit.start + hit.lead,
            .header_from = header_from,
        };
    }
    return null;
}

/// The same matchers, run over the whole header instead of one line.
///
/// The header is followed from the declaration's line to its `{` or `;`
/// ({@link headerEnd}), because that is the only slice in which the closing
/// bracket of a wrapped parameter list exists. `name(` must still open the name,
/// and the text before it — on the line it is written on — must still read as a
/// return type, a modifier list or nothing, so a name that merely appears inside
/// a wrapped argument list is not a declaration.
fn declarationAcross(alloc: Allocator, facts: Facts, start: usize, name: Str) !?Declaration {
    const mask = facts.mask;
    const starts = facts.starts;
    const mask_lines = facts.mask_lines;
    const line = lineOf(starts, start);
    const from = start + (mask_lines[line].len - js.trimStart(mask_lines[line]).len);
    const header = headerEnd(mask_lines, starts, line, from);
    if (header.last == line) return null;
    const text = maskSlice(mask, start, header.end);

    var at: usize = 0;
    while (nextCallMatch(text, name, at)) |hit| {
        at = hit.name_at + 1;
        // The prefix is the name's **own line** before the name, so a wrapped
        // receiver or return type on an earlier line is not part of it.
        const column = hit.name_at;
        const on = lineOf(starts, start + column);
        const before = mask_lines[on][0 .. start + column - starts[on]];
        const prefix = try withFuncReceiver(alloc, before);
        if (prefix.len != 0 and (!isDeclarationPrefix(prefix) or startsWithStatementBefore(prefix))) continue;
        // The bracket is matched inside the header's own text: `matchingBracket`
        // counts from the index it is given, so an absolute offset would read
        // the wrong bracket.
        const close = matchingBracket(text, hit.paren, ')') orelse continue;
        return .{
            .kind = .method,
            .name = name,
            .name_at = start + column,
            .header_from = start + close + 1,
        };
    }

    var assigned_from: usize = 0;
    while (nextAssignedMatch(text, name, assigned_from)) |hit| {
        assigned_from = hit.end;
        const column = hit.start + hit.lead;
        const on = lineOf(starts, start + column);
        const before = mask_lines[on][0 .. start + column - starts[on]];
        const prefix = js.trim(before);
        if (prefix.len != 0 and (!isDeclarationPrefix(prefix) or startsWithStatementBefore(prefix))) continue;
        const rest = text[hit.end..];
        const arrow = js.indexOf(rest, &js.lit("=>"));
        if (arrow == null and functionKeywordEnd(rest) == null) continue;
        return .{
            .kind = .method,
            .name = name,
            .name_at = start + column,
            .header_from = start + hit.end + (arrow orelse 0),
        };
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
const Property = struct {
    name: Str,
    match_end: usize,
    typed_head: bool,
    type_word: Str,
    /// The line-relative offset of the `=` that opens the initialiser, which is
    /// where a `-` body selection starts.
    equals_at: usize,
};

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
        return .{
            .name = name,
            .match_end = scan,
            .typed_head = typed,
            .type_word = type_word,
            .equals_at = scan,
        };
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

/// Whether the head is `Type`, `Type Type`, `Type<T> Type<U>` — the shape
/// `((?:TOKEN)(?:\s+(?:TOKEN))*?)` accepts, where a TOKEN is a whole type.
fn isTypeRun(head: Str) bool {
    var at: usize = 0;
    var tokens: usize = 0;
    while (at < head.len) {
        at = typeTokenEnd(head, at) orelse return false;
        tokens += 1;
        if (at >= head.len) break;
        if (!js.isWhitespace(head[at])) return false;
        while (at < head.len and js.isWhitespace(head[at])) at += 1;
        if (at >= head.len) return false;
    }
    return tokens > 0;
}

/// One type token starting at `at`, or null: a qualified name
/// (`java.util.List`), a generic list of names (`Map<String, Integer>`), an
/// array (`int[]`, `String[][]`), or any nesting of the three — the reference's
/// `[\w$]+(?:\.[\w$]+)*(?:\s*<[^<>]*>)?(?:\s*\[\s*\])*`. Returns the offset just
/// past the token, and never sits still (a caller that loops on it must make
/// progress).
fn typeTokenEnd(text: Str, start: usize) ?usize {
    var at = start;
    if (at >= text.len or (!js.isAsciiWord(text[at]) and text[at] != '$')) return null;
    // The name, and every qualification of it: `a.b.c`.
    while (true) {
        while (at < text.len and (js.isAsciiWord(text[at]) or text[at] == '$')) at += 1;
        if (at < text.len and text[at] == '.' and at + 1 < text.len and js.isIdentStart(text[at + 1])) {
            at += 1;
            continue;
        }
        break;
    }
    // `(?:\s*<[^<>]*>)?` — one generic group, with no angle bracket inside it.
    {
        var probe = at;
        while (probe < text.len and js.isWhitespace(text[probe])) probe += 1;
        if (probe < text.len and text[probe] == '<') {
            const close = js.indexOfUnit(text[probe..], '>') orelse return null;
            for (text[probe + 1 .. probe + close]) |unit| {
                if (unit == '<' or unit == '>') return null;
            }
            at = probe + close + 1;
        }
    }
    // `(?:\s*\[\s*\])*` — the array suffix, one bracket pair at a time.
    while (true) {
        var probe = at;
        while (probe < text.len and js.isWhitespace(text[probe])) probe += 1;
        if (probe >= text.len or text[probe] != '[') break;
        probe += 1;
        while (probe < text.len and js.isWhitespace(text[probe])) probe += 1;
        if (probe >= text.len or text[probe] != ']') break;
        at = probe + 1;
    }
    return at;
}

// --- buildScope -------------------------------------------------------------

/// A word a declaration may put before its type, or instead of it (`var`/`const`/`let`).
const DECLARATION_MODIFIERS = [_][]const u8{
    "public",   "protected", "private",  "static",  "final",    "abstract", "transient",
    "volatile", "native",    "strictfp", "default", "const",    "let",      "var",
    "readonly", "internal",  "open",     "sealed",  "lateinit", "override", "suspend",
    "inline",   "external",  "partial",  "ref",
};

/// The words that stand where a type would but declare nothing.
const NOT_A_TYPE_WORDS = [_][]const u8{
    "return", "throw", "new",   "else",   "do",
    "case",   "await", "yield", "delete", "typeof",
};

/// One variable declaration: its name, where the name starts, its `=` (or null), and where it ends.
const Variable = struct {
    name: Str,
    name_at: usize,
    equals_at: ?usize,
    end: usize,
};

/// Whether a `Str` spells exactly `spelling`.
fn isWord(word: Str, spelling: []const u8) bool {
    if (word.len != spelling.len) return false;
    for (spelling, 0..) |ch, at| {
        if (word[at] != @as(u16, ch)) return false;
    }
    return true;
}

fn isDeclarationModifier(word: Str) bool {
    for (DECLARATION_MODIFIERS) |modifier| {
        if (isWord(word, modifier)) return true;
    }
    return false;
}

fn isNotATypeWord(word: Str) bool {
    for (NOT_A_TYPE_WORDS) |spelling| {
        if (isWord(word, spelling)) return true;
    }
    return false;
}

fn isVariableSpace(unit: u16) bool {
    return unit == ' ' or unit == '\t' or unit == '\r' or unit == '\n';
}

/// The identifier at `at` and where it ends, or null when there is none.
fn variableWord(mask: Str, at: usize, to: usize) ?struct { name: Str, end: usize } {
    if (at >= to or !js.isIdentStart(mask[at])) return null;
    var end = at + 1;
    while (end < to and js.isIdentPart(mask[end])) end += 1;
    return .{ .name = mask[at..end], .end = end };
}

/// Where the type at `at` ends, or null: a dotted name, a **counted** generic list, array brackets.
///
/// Types nest, so the generic list is counted rather than matched by a pattern that cannot see past the first
/// `>`: `Map<Long, List<Session>> perOrg` is a declaration, and a type pattern that stops at the first `>`
/// makes it no declaration at all — which is what it used to do (2026-10-13).
fn balancedTypeEnd(mask: Str, at: usize, to: usize) ?usize {
    const first = variableWord(mask, at, to) orelse return null;
    var scan = first.end;
    while (scan + 1 < to and mask[scan] == '.' and js.isIdentStart(mask[scan + 1])) {
        const part = variableWord(mask, scan + 1, to) orelse break;
        scan = part.end;
    }
    if (scan < to and mask[scan] == '<') {
        var depth: isize = 0;
        var cursor = scan;
        while (cursor < to) : (cursor += 1) {
            const unit = mask[cursor];
            if (unit == '<') {
                depth += 1;
            } else if (unit == '>') {
                depth -= 1;
                if (depth == 0) {
                    cursor += 1;
                    break;
                }
            } else if (unit == ';' or unit == '{' or unit == '}' or unit == '\n' or unit == '=') {
                return null;
            }
        }
        if (depth != 0) return null;
        scan = cursor;
    }
    while (true) {
        var cursor = scan;
        while (cursor < to and isVariableSpace(mask[cursor])) cursor += 1;
        if (cursor + 1 < to and mask[cursor] == '[') {
            var after = cursor + 1;
            while (after < to and isVariableSpace(mask[after])) after += 1;
            if (after < to and mask[after] == ']') {
                scan = after + 1;
                continue;
            }
        }
        break;
    }
    return scan;
}

/// The annotation at `at` (`@NotNull`, `@Foo(1)`), or null: what follows the `@` is not one.
fn skipAnnotation(mask: Str, at: usize, to: usize) ?usize {
    const first = variableWord(mask, at + 1, to) orelse return null;
    var scan = first.end;
    while (scan + 1 < to and mask[scan] == '.' and js.isIdentStart(mask[scan + 1])) {
        const part = variableWord(mask, scan + 1, to) orelse break;
        scan = part.end;
    }
    if (scan < to and mask[scan] == '(') {
        const close = matchingBracket(mask, scan, ')') orelse return null;
        if (close >= to or close <= scan) return null;
        scan = close + 1;
    }
    return scan;
}

/// The declarator whose name runs `name_at`..: its `=` and where its own text ends.
fn finishVariable(mask: Str, name: Str, name_at: usize, after_name: usize, to: usize) Variable {
    var end = to;
    while (end > name_at and isVariableSpace(mask[end - 1])) end -= 1;
    var equals_at: ?usize = null;
    var depth: isize = 0;
    var scan = after_name;
    while (scan < end) : (scan += 1) {
        const unit = mask[scan];
        if (unit == '(' or unit == '[' or unit == '{' or unit == '<') {
            depth += 1;
        } else if (unit == ')' or unit == ']' or unit == '}' or unit == '>') {
            if (depth > 0) depth -= 1;
        } else if (unit == '=' and depth == 0 and (scan + 1 >= mask.len or mask[scan + 1] != '=') and (scan == 0 or mask[scan - 1] != '=')) {
            equals_at = scan;
            break;
        } else if (unit == ':' and depth == 0) {
            // An enhanced `for`'s `:` — what follows names the thing iterated, not the variable.
            end = name_at + name.len;
            break;
        }
    }
    return .{
        .name = name,
        .name_at = name_at,
        .equals_at = equals_at,
        .end = @max(end, name_at + name.len),
    };
}

/// One declarator out of `mask[from, to)`, or null.
///
/// A leading annotation or modifier carries no name and is skipped, and the type must come before the name —
/// that guard is what keeps `count = 1;` an assignment rather than a variable named `count`. `type_optional`
/// is for the later declarators of a list (`b` in `int a = 1, b = 2;`), which inherit the type written before
/// the first one.
fn parseVariable(mask: Str, from: usize, to: usize, type_optional: bool) ?Variable {
    var at = from;
    var typed: usize = 0;
    var untyped = type_optional;
    while (true) {
        while (at < to and isVariableSpace(mask[at])) at += 1;
        if (at >= to) return null;
        if (mask[at] == '@') {
            at = skipAnnotation(mask, at, to) orelse return null;
            continue;
        }
        const spelled = variableWord(mask, at, to) orelse return null;
        const type_end = balancedTypeEnd(mask, at, to);
        const after = type_end orelse spelled.end;
        var next_at = after;
        while (next_at < to and isVariableSpace(mask[next_at])) next_at += 1;
        const next: u16 = if (next_at >= to) 0 else mask[next_at];
        const ends_here = next == 0 or next == '=' or next == ':' or next == ',' or next == ';' or next == ')';
        if (ends_here and (typed > 0 or untyped)) {
            return finishVariable(mask, spelled.name, at, after, to);
        }
        if (isDeclarationModifier(spelled.name)) {
            if (isWord(spelled.name, "const") or isWord(spelled.name, "let") or isWord(spelled.name, "var")) {
                untyped = true;
            }
            at = after;
            continue;
        }
        if (type_end == null) return null;
        typed += 1;
        if (next_at >= to) return null;
        at = next_at;
    }
}

/// The offset of `wanted` in `mask[from, to)` with every bracket closed, or null.
fn topLevelIndexOf(mask: Str, from: usize, to: usize, wanted: u16) ?usize {
    var depth: isize = 0;
    var at = from;
    while (at < to) : (at += 1) {
        const unit = mask[at];
        if (unit == '(' or unit == '[' or unit == '{' or unit == '<') {
            depth += 1;
        } else if (unit == ')' or unit == ']' or unit == '}' or unit == '>') {
            if (depth > 0) depth -= 1;
        } else if (unit == wanted and depth == 0) {
            return at;
        }
    }
    return null;
}

/// The variables a region declares: every declarator of a statement, a parameter, a loop's own variable, a
/// resource, a `catch` parameter. `inherited` is for a statement's own list, where the type is written once.
fn variableDeclarators(
    alloc: Allocator,
    mask: Str,
    from: usize,
    to: usize,
    inherited: bool,
) Error![]Variable {
    var out = std.ArrayList(Variable).empty;
    var depth: isize = 0;
    var piece_start = from;
    var index: usize = 0;
    // The sentinel `,` at `to` closes the last declarator: the region's own end is not a separator, and a
    // piece that ends on the closing bracket of its initialiser (`listOf(\n 1,\n)`) reaches it without one.
    var at = from;
    while (at <= to) : (at += 1) {
        const unit: u16 = if (at == to) ',' else mask[at];
        if (unit == '(' or unit == '[' or unit == '{' or unit == '<') {
            depth += 1;
            continue;
        }
        if (unit == ')' or unit == ']' or unit == '}' or unit == '>') {
            if (depth > 0) depth -= 1;
            continue;
        }
        if ((unit != ',' and unit != ';') or depth != 0) continue;
        if (parseVariable(mask, piece_start, at, index > 0 and inherited)) |variable| {
            try out.append(alloc, variable);
        }
        piece_start = at + 1;
        index += 1;
    }
    return out.toOwnedSlice(alloc);
}

/// The variables a statement's header declares: a `for`'s own variable (classic or enhanced), a `catch`
/// parameter, and the resources a `try (…)` names.
fn headerVariables(
    alloc: Allocator,
    mask: Str,
    from: usize,
    to: usize,
    keyword: []const u8,
) Error![]Variable {
    const open = js.indexOfUnit(mask[from..to], '(') orelse return &.{};
    const list_open = from + open;
    const list_close = matchingBracket(mask, list_open, ')') orelse return &.{};
    if (list_close >= to or list_close <= list_open) return &.{};
    if (std.mem.eql(u8, keyword, "for")) {
        // A classic `for` declares in its first part; an enhanced one ends the variable at its `:`.
        const colon = topLevelIndexOf(mask, list_open + 1, list_close, ':');
        const semicolon = topLevelIndexOf(mask, list_open + 1, list_close, ';');
        const end = colon orelse semicolon orelse list_close;
        return variableDeclarators(alloc, mask, list_open + 1, end, false);
    }
    return variableDeclarators(alloc, mask, list_open + 1, list_close, false);
}

const Build = struct {
    // The scala of one scan: the lexical facts, the flat block list every
    // built block is registered in, and the recursive walk that builds them.
    facts: Facts,
    blocks: std.ArrayList(*Block) = .empty,

    /// Register one variable as a member of `parent`, the way `descend` registers the scanned ones.
    fn declareVariable(self: *Build, parent: *Block, variable: Variable) Error!*Block {
        const alloc = self.facts.alloc;
        const block = try alloc.create(Block);
        block.* = makeBlock(.property, variable.name, lineOf(self.facts.starts, variable.name_at));
        block.line_end = lineOf(self.facts.starts, @max(variable.name_at, variable.end - 1));
        block.equals_at = variable.equals_at;
        block.statement_to = variable.end;
        // A parameter, a loop's variable, a resource and a `catch` parameter are members of the block their
        // header opens, and say so on their own block (2026-10-14).
        block.parent = parent;
        block.scope = parent;
        block.scope_name = parent.name;
        block.scope_line = parent.decl_line;
        try parent.children.append(alloc, block);
        try self.blocks.append(alloc, block);
        return block;
    }

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
                var lead_end = keyword.index;
                while (lead_end < mask_line.len and !js.isWhitespace(mask_line[lead_end])) lead_end += 1;
                const leading = mask_line[keyword.index..lead_end];
                var name = keyword.name;
                const within = js.indexOf(mask_line[keyword.index..], keyword.name) orelse 0;
                var name_at = start + keyword.index + within;
                // Kotlin spells its enum `enum class Suit`: the word the class-like shape captures is the
                // language's own `class`, and the name follows it.
                if (isEnumWord(leading)) {
                    if (kotlinEnumName(mask_line, keyword)) |declared| {
                        name = declared.name;
                        name_at = start + declared.at;
                    }
                }
                // A word that stands where a name would and declares nothing is not a declaration: it is how
                // a language spells a second keyword (`enum` + `class` above).
                if (!isNotAName(name) and !isDeclaredNameWord(name)) {
                    const header_from = name_at + name.len;
                    const span = bodySpan(
                        self.facts.mask,
                        self.facts.mask_lines,
                        self.facts.starts,
                        i,
                        header_from,
                        name_at,
                        false,
                    );
                    const block = try alloc.create(Block);
                    block.* = makeBlock(.class, name, i);
                    applySpan(block, span);
                    // An enum's body opens with its constant list, and every constant is a member of its own —
                    // matcher 4 reads "a field **or constant**" (2026-10-13). The constants are read first, and
                    // only what follows their `;` is scanned as an ordinary class body.
                    const enum_body = try enumConstants(self, block, leading, span);
                    applyAnchor(self, block, if (span) |found| found.open else null);
                    try register(self, &list, block);
                    switch (enum_body) {
                        .not_an_enum => try descend(self, block, i, span),
                        .constants_only => {},
                        .members => |from| {
                            var shifted = span;
                            if (shifted) |*found| found.open_line = from - 1;
                            try descend(self, block, i, shifted);
                        },
                    }
                    i = endLineOf(span, i) + 1;
                    continue;
                }
            }

            switch (try methodDeclOn(self, mask_line, start)) {
                .none => {},
                .found => |read| {
                    const span = bodySpan(
                        self.facts.mask,
                        self.facts.mask_lines,
                        self.facts.starts,
                        i,
                        read.declaration.header_from,
                        read.declaration.name_at,
                        false,
                    );
                    // A bare `foo();` call is not a declaration; an assigned
                    // function carries a prefix (the `=`), so it always counts.
                    if (span == null and !read.has_prefix) {
                        i += 1;
                        continue;
                    }
                    const block = try alloc.create(Block);
                    block.* = makeBlock(.method, read.declaration.name, i);
                    applySpan(block, span);
                    // The variables a signature declares are members of it: `void render(String title)` names
                    // `title`, and a parameter is what a reader follows a name to as often as a local is
                    // (2026-10-13).
                    if (js.indexOfUnit(self.facts.mask[read.declaration.name_at..], '(')) |list_offset| {
                        const list_open = read.declaration.name_at + list_offset;
                        if (matchingBracket(self.facts.mask, list_open, ')')) |list_close| {
                            const declared = try variableDeclarators(
                                alloc,
                                self.facts.mask,
                                list_open + 1,
                                list_close,
                                false,
                            );
                            for (declared) |variable| {
                                _ = try self.declareVariable(block, variable);
                            }
                        }
                    }
                    applyAnchor(self, block, if (span) |found_span| found_span.open else null);
                    try register(self, &list, block);
                    try descend(self, block, i, span);
                    i = endLineOf(span, i) + 1;
                    continue;
                },
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
                        // A `for`, a `catch` and a `try`-with-resources introduce their own variables, and
                        // they are members of the block the header opens (2026-10-13).
                        const header_vars = try headerVariables(
                            alloc,
                            self.facts.mask,
                            hdr_start,
                            hdr_end,
                            stmt.keyword,
                        );
                        for (header_vars) |variable| {
                            _ = try self.declareVariable(block, variable);
                        }

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

                // The same statement, closed by **indentation** rather than a
                // brace — Python's `if`, Ruby's `if`/`elsif`, VB's `If`/`ElseIf`.
                // Only a statement block carries its header's literals, so without
                // this a condition literal in a language that does not brace its
                // blocks is unreachable at any depth.
                const indent = indentWidth(mask_line);
                const body_from = i + 1;
                var body_end_line = i;
                var k = body_from;
                while (k < self.facts.lines.len) : (k += 1) {
                    if (js.trim(self.facts.lines[k]).len == 0) continue;
                    if (indentWidth(self.facts.lines[k]) <= indent) break;
                    body_end_line = k;
                }
                if (body_end_line > i) {
                    const block = try alloc.create(Block);
                    block.* = makeBlock(.statement, null, i);
                    const span = Span{ .indented = true, .body_from = body_from, .body_end_line = body_end_line };
                    applySpan(block, span);
                    const hdr_end = endOfLine(self.facts.mask, start);
                    // The condition's offset is the keyword's own offset in the
                    // line, as `chainSegments` reports it for a braced statement.
                    block.conditions = try conditionLiterals(
                        alloc,
                        self.facts.source[start..hdr_end],
                        stmt.index,
                    );
                    applyAnchor(self, block, null);
                    try register(self, &list, block);
                    try descend(self, block, i, span);
                    i = endLineOf(span, i) + 1;
                    continue;
                }
            }

            // A variable declaration: `Type name = …;` — and every other spelling of one. Matcher 4 reads a
            // *variable*, so a declaration with no initialiser (`int count;`), a list of declarators
            // (`int a = 1, b = 2;`), an enum's constant and a local whose type nests
            // (`Map<Long, List<Session>> perOrg = …;`) are all members (2026-10-13).
            if (parseVariable(self.facts.mask, start, start + mask_line.len, false)) |declared_variable| {
                // A declaration's type and modifiers are words, so a statement keyword in that position means
                // this is not one: VB writes `If name = "count" Then` with the same `=` an assignment uses, and
                // reading it as a property named `name` hides the condition literal that names the block.
                const prefix = self.facts.mask[start..declared_variable.name_at];
                if (!isNotAName(declared_variable.name) and !startsWithStatementBefore(
                    self.facts.mask[start .. declared_variable.name_at + declared_variable.name.len],
                ) and !isNotATypeWord(firstWord(prefix))) {
                    // The whole statement is followed so its `;` is found — a lambda, an array or an
                    // anonymous-class initialiser inside it is the statement's own brace and not its end. Every
                    // level the statement-end rule reads comes from the **source**: the mask blanks a literal's
                    // delimiters, so its lines are neither the right lengths nor the right content for deciding
                    // where a statement ends.
                    const source_lines = try js.splitLines(alloc, self.facts.source);
                    const source_starts = try lineStarts(alloc, self.facts.source);
                    const statement = statementEnd(
                        self.facts.mask,
                        source_lines,
                        source_starts,
                        start,
                        self.facts.mask.len,
                    );
                    const declared_vars = try variableDeclarators(
                        alloc,
                        self.facts.mask,
                        start,
                        statement.end,
                        true,
                    );
                    for (declared_vars, 0..) |variable, index| {
                        const block = try alloc.create(Block);
                        block.* = makeBlock(.property, variable.name, lineOf(self.facts.starts, variable.name_at));
                        block.line_end = lineOf(self.facts.starts, @max(variable.name_at, variable.end - 1));
                        block.equals_at = variable.equals_at;
                        block.statement_to = variable.end;
                        if (index + 1 == declared_vars.len) {
                            // The last declarator reaches the statement's own end, and where that is is a fact
                            // about the **source**: the mask blanks a raw string it carries, so the mask's own
                            // last character would cut the declaration short.
                            block.line_end = statement.last;
                            block.statement_to = statement.end;
                        }
                        try register(self, &list, block);
                    }
                    i = @max(i, statement.last) + 1;
                    continue;
                }
            }

            // A bare braced block that carries a name is a section: its braces
            // are the block's own start and end markers, so `{//name` (or a
            // `//name` line just inside it) names it. A bare block with no
            // anchor is left to the existing line scan.
            if (js.eql(js.trim(mask_line), &js.lit("{"))) {
                const brace_at = start + (js.indexOf(mask_line, &js.lit("{")) orelse 0);
                if (braceBody(self.facts.mask, self.facts.starts, brace_at)) |body| {
                    const block = try alloc.create(Block);
                    block.* = makeBlock(.statement, null, i);
                    applySpan(block, body);
                    applyAnchor(self, block, body.open);
                    if (block.anchor != null) {
                        try register(self, &list, block);
                        try descend(self, block, i, body);
                        i = body.close_line.? + 1;
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
        // A shape that declares itself complete on its own line (a Rust field, a
        // one-line Haskell binding) is a selection of that line; only a shape
        // that opens a body is followed for one.
        const is_line_shape = entry.line;

        // A one-line shape (`add x y = x + y`) is a selection of its own line.
        // Its *body* is what an expression it states extends into — an indented
        // `do` block — and is empty when it states none, so the body starts where
        // it ends and the slice comes out empty.
        var span: ?Span = null;
        if (is_line_shape) {
            const eq = js.indexOfUnit(mask_line, '=');
            var first = line;
            var last = line;
            if (eq) |at| {
                first = lineOf(self.facts.starts, start + at + 1);
                last = first;
                const indent = indentWidth(self.facts.lines[line]);
                var index = first + 1;
                while (index < self.facts.lines.len) : (index += 1) {
                    if (js.trim(self.facts.lines[index]).len == 0) break;
                    if (indentWidth(self.facts.lines[index]) <= indent) break;
                    last = index;
                }
            }
            span = .{ .indented = true, .body_end_line = last, .body_from = first };
        }

        if (entry.end_kw) |word| {
            // A shape whose body a keyword line closes (Ruby `end`, VB `End`)
            // keeps the declaration line as its header.
            span = if (keywordBody(self.facts.lines, line, word)) |body|
                Span{ .open_line = body.open_line, .close_line = body.close_line }
            else
                null;
        } else if (!is_line_shape) {
            // A shape says where its body begins. An `=` is an expression body
            // and is read as such. A `{` — or an offset just past one, which is
            // how a shape that opens a brace body states it — is a brace body,
            // scanned from the shape's own name so brackets before it cannot
            // offset the depth. Anything else is followed normally: a class whose
            // members are indented, a wrapped shape, or a shape that carries no
            // body of its own.
            const within = js.indexOf(mask_line, found.hit.name) orelse 0;
            const name_at = start + within;
            const at = start + found.hit.header_from;
            const opened: ?usize = if (at < self.facts.mask.len and
                (self.facts.mask[at] == '{' or self.facts.mask[at] == ' ' or self.facts.mask[at] == '\t'))
                at
            else if (at > 0 and self.facts.mask[at - 1] == '{')
                at - 1
            else
                null;
            if (at < self.facts.mask.len and self.facts.mask[at] == '=') {
                span = expressionBody(self.facts.lines, self.facts.starts, line, at + 1);
            } else if (opened) |open| {
                span = bodySpan(
                    self.facts.mask,
                    self.facts.mask_lines,
                    self.facts.starts,
                    line,
                    open,
                    name_at,
                    false,
                );
            } else {
                // A shape whose `headerFrom` is neither the body's `{` nor its `=`
                // has not stated where its body begins (a Kotlin `fun name(`), so
                // the header is followed from there exactly as the generic `name(`
                // shape's is: the scan spans a wrapped parameter list and finds the
                // `{`, `;` or `=` after it. A member with no body to inject comes
                // back null, and is then no block at all.
                span = bodySpan(
                    self.facts.mask,
                    self.facts.mask_lines,
                    self.facts.starts,
                    line,
                    at,
                    name_at,
                    false,
                );
            }
        }

        const block = try alloc.create(Block);
        block.* = makeBlock(switch (entry.kind) {
            .class => .class,
            .method => .method,
            .property => .property,
        }, found.hit.name, line);

        if (span) |value| {
            applySpan(block, value);
            if (value.expression_end_line) |expression_end| {
                block.expression_end_line = expression_end;
            }
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

/// The method reader's verdict for one line.
const MethodRead = union(enum) {
    /// No method/function declaration on the line: the statement and property
    /// matchers get their turn.
    none,
    found: struct {
        declaration: Declaration,
        /// Whether the declaration carries a prefix (a modifier list, a return
        /// type, an `=`). A bare `foo();` call does not, and is then only a
        /// declaration when its body is non-empty.
        has_prefix: bool,
    },
};

/// A `name(` mention of any name on a line, as `buildScope`'s own call scan sees
/// it: a `(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(` match.
const AnyCall = struct { name: Str, name_at: usize, paren: usize };

fn nextAnyCallMatch(line: Str, from: usize) ?AnyCall {
    var at = from;
    while (at < line.len) : (at += 1) {
        if (at > 0 and !isSeparatorUnit(line[at - 1])) continue;
        if (!js.isIdentStart(line[at])) continue;
        const name_start = at;
        var scan = at + 1;
        while (scan < line.len and js.isIdentPart(line[scan])) scan += 1;
        var after = scan;
        while (after < line.len and js.isWhitespace(line[after])) after += 1;
        if (after >= line.len or line[after] != '(') continue;
        return .{ .name = line[name_start..scan], .name_at = name_start, .paren = after };
    }
    return null;
}

/// The method/function reader of `buildScope`: a `name(` declaration, or an
/// assignment that defines a function.
fn methodDeclOn(self: *Build, mask_line: Str, start: usize) Error!MethodRead {
    const alloc = self.facts.alloc;

    // The call-shaped scan comes first and in line order, exactly as the
    // JavaScript's global `name(` regex reads it: the first candidate
    // `declarationOn` accepts wins.
    var from: usize = 0;
    while (nextAnyCallMatch(mask_line, from)) |hit| {
        from = hit.paren + 1;
        if (isNotAName(hit.name)) continue;
        const prefix = try withFuncReceiver(alloc, mask_line[0..hit.name_at]);
        if (prefix.len != 0 and (!isDeclarationPrefix(prefix) or startsWithStatementBefore(prefix))) continue;
        const found = (try declarationOn(alloc, self.facts, mask_line, start, hit.name, true)) orelse continue;
        if (found.kind != .method) continue;
        return .{ .found = .{ .declaration = found, .has_prefix = prefix.len != 0 } };
    }

    // The assigned form: `const name = (…) => …`, `name = function …`. The
    // line's own spelling is complete or it is nothing, and the scan resumes
    // past each whole match, as the JavaScript's global `exec` does.
    var assigned_from: usize = 0;
    while (nextAssignedName(mask_line, assigned_from)) |candidate| {
        assigned_from = candidate.match_end;
        const found = (try declarationOn(alloc, self.facts, mask_line, start, candidate.name, false)) orelse continue;
        if (found.kind != .method) continue;
        return .{ .found = .{ .declaration = found, .has_prefix = true } };
    }
    return .none;
}

fn register(self: *Build, list: *std.ArrayList(*Block), block: *Block) Error!void {
    const alloc = self.facts.alloc;
    try list.append(alloc, block);
    try self.blocks.append(alloc, block);
}

/// Whether `word` is the class-like keyword `enum`.
fn isEnumWord(word: Str) bool {
    return js.startsWithBytes(word, "enum") and word.len == "enum".len;
}

/// The words the class-like shape itself uses. A language that spells a declaration with two of them
/// (`enum class Suit` in Kotlin) leaves the second one where the shape wants the *name*, so a captured name
/// that is one of these declares nothing — it is the rest of the keyword, and the real name follows.
fn isDeclaredNameWord(name: Str) bool {
    const words = [_][]const u8{
        "class", "interface", "enum", "record", "struct", "trait", "object", "union",
    };
    for (words) |word| {
        if (js.startsWithBytes(name, word) and name.len == word.len) return true;
    }
    return false;
}

/// `enum class Suit` — the name Kotlin writes after the language's own `class`.
fn kotlinEnumName(line: Str, keyword: KeywordMatch) ?struct { name: Str, at: usize } {
    if (!js.startsWithBytes(line[keyword.index..], "enum")) return null;
    var scan = keyword.index + "enum".len;
    while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
    if (!js.startsWithBytes(line[scan..], "class")) return null;
    scan += "class".len;
    while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;
    if (scan >= line.len or !js.isIdentStart(line[scan])) return null;
    const name_start = scan;
    scan += 1;
    while (scan < line.len and js.isIdentPart(line[scan])) scan += 1;
    return .{ .name = line[name_start..scan], .at = name_start };
}

/// What an enum's body contributes besides its declaration (2026-10-13).
const EnumBody = union(enum) {
    /// Not an enum at all: the caller descends into the block as a class-like body.
    not_an_enum,
    /// The constant list is the whole body, so there is no class body to scan.
    constants_only,
    /// The class body starts on this line, after the constant list's `;`.
    members: usize,
};

/// One enum constant: its name, where the name starts, and where the constant ends.
const Constant = struct { name: Str, name_at: usize, end: usize };

/// The members an enum's constant list contributes (2026-10-13) — this port of the reference's rule.
///
/// A Java-family enum opens its body with a `,`-separated list of constants — each a bare name, a name with
/// constructor arguments, or a name with a body of its own — and only after the list's `;` comes an ordinary
/// class body. Matcher 4 reads "a field **or constant**", so every constant is a member named by its
/// identifier, selected as the whole constant; the list is read here, before the body's own members, and the
/// constants become the block's children, which is also what makes an enum written on one line a container.
fn enumConstants(self: *Build, block: *Block, leading: Str, span: ?Span) Error!EnumBody {
    const found = span orelse return .not_an_enum;
    if (!isEnumWord(leading)) return .not_an_enum;
    const open = found.open orelse return .not_an_enum;
    const close = found.close orelse return .not_an_enum;
    if (close <= open) return .not_an_enum;
    const alloc = self.facts.alloc;
    const mask = self.facts.mask;
    const starts = self.facts.starts;
    // The list ends at the first `;` outside every bracket — a constant's arguments or body may carry
    // brackets of their own — and a body that writes no `;` is nothing but its constants.
    var depth: isize = 0;
    var list_end = close;
    var semicolon_line: ?usize = null;
    var at = open + 1;
    while (at < close) : (at += 1) {
        const unit = mask[at];
        if (unit == '(' or unit == '[' or unit == '{') {
            depth += 1;
        } else if (unit == ')' or unit == ']' or unit == '}') {
            depth -= 1;
        } else if (unit == ';' and depth == 0) {
            list_end = at;
            semicolon_line = lineOf(starts, at);
            break;
        }
    }
    // One constant per top-level `,` of the list; the comma that closes the last one is the loop's sentinel.
    depth = 0;
    var from = open + 1;
    at = open + 1;
    while (at <= list_end) : (at += 1) {
        const unit: u16 = if (at == list_end) ',' else mask[at];
        if (unit == '(' or unit == '[' or unit == '{') {
            depth += 1;
        } else if (unit == ')' or unit == ']' or unit == '}') {
            depth -= 1;
        }
        if (unit != ',' or depth != 0) continue;
        const piece = constantBetween(mask, from, at);
        from = at + 1;
        const constant = piece orelse continue;
        const member = try alloc.create(Block);
        member.* = makeBlock(.property, constant.name, lineOf(starts, constant.name_at));
        member.line_end = lineOf(starts, @max(constant.name_at, constant.end - 1));
        // A constant's "body" — the part a `-` selection means — is everything after its name: the arguments
        // it is built with and the body it declares, when it has one. A bare constant has none, exactly as a
        // field with no initialiser has none.
        member.enum_constant = true;
        member.name_end = constant.name_at + constant.name.len;
        member.statement_to = constant.end;
        // A constant is a member of the enum that holds it, and says so on its own block (2026-10-14).
        member.parent = block;
        member.scope = block;
        member.scope_name = block.name;
        member.scope_line = block.decl_line;
        try block.children.append(alloc, member);
        try self.blocks.append(alloc, member);
    }
    const line = semicolon_line orelse return .constants_only;
    return .{ .members = line + 1 };
}

/// One enum constant out of `mask[from, to)`.
///
/// The name is looked for on the first line of the piece that carries one, because a constant may be
/// introduced by a doc comment (blank in the mask) or by annotations (`@Deprecated`), and because the widening
/// scopes walk *up* from the line the name is written on. A piece that names nothing — the empty space a
/// trailing comma leaves — answers null, and so does a `case`-spelled constant (PHP writes `case Hearts;`),
/// which this rule does not read yet.
fn constantBetween(mask: []const u16, from: usize, to: usize) ?Constant {
    var line_from = from;
    var at = from;
    while (at <= to) : (at += 1) {
        if (at != to and mask[at] != '\n') continue;
        const raw = mask[line_from..at];
        const trimmed = js.trimStart(raw);
        if (trimmed.len != 0) {
            if (js.isIdentStart(trimmed[0])) {
                var length: usize = 1;
                while (length < trimmed.len and js.isIdentPart(trimmed[length])) length += 1;
                const name_at = line_from + (raw.len - trimmed.len);
                // The constant runs to the last non-blank byte of its own piece, so a wrapped argument list
                // or a body still belongs to it and trailing space does not.
                var last = to;
                while (last > name_at and js.isWhitespace(mask[last - 1])) last -= 1;
                return .{
                    .name = trimmed[0..length],
                    .name_at = name_at,
                    .end = @max(name_at + length, last),
                };
            }
            if (js.startsWithBytes(trimmed, "case")) return null;
        }
        line_from = at + 1;
    }
    return null;
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
    for (children) |child| {
        // Where the child was declared, recorded on the child itself — the same four facts the other ports set
        // on the children a `descend` produces (2026-10-14).
        child.parent = block;
        child.scope = block;
        child.scope_name = block.name;
        child.scope_line = block.decl_line;
        try block.children.append(self.facts.alloc, child);
    }
}

fn applyAnchor(self: *Build, block: *Block, open: ?usize) void {
    if (open) |offset| {
        if (leadingAnchor(self.facts.comments, self.facts.source, self.facts.lines, self.facts.starts, offset)) |anchor| {
            block.anchor = anchor;
        }
        return;
    }
    // An indented body (a Python `def`, a Ruby `def`) has no brace to open, so
    // the anchor is looked for on the declaration's own header line — the trailing
    // comment `def legacy(self):  #count` — and in the first line of its body.
    const from = block.body_from orelse (block.decl_line + 1);
    const to = block.close_line orelse block.decl_line;
    if (indentAnchor(
        self.facts.comments,
        self.facts.source,
        self.facts.lines,
        self.facts.starts,
        block.decl_line,
        from,
        to,
    )) |anchor| {
        block.anchor = anchor;
    }
}

fn applySpan(block: *Block, span: ?Span) void {
    const found = span orelse return;
    if (found.indented) {
        block.indented = true;
        // The body starts at `bodyFrom` when the header wrapped (its own lines
        // are the declaration's, not the body's) and runs to `bodyEndLine`. A
        // one-line shape that was not extended has its body before it starts,
        // which is what makes that body empty.
        block.body_from = found.body_from orelse (block.decl_line + 1);
        block.close_line = found.body_end_line;
        block.end_line = found.body_end_line;
        return;
    }
    if (found.expression) |expression| {
        block.expression = expression;
        if (found.expression_end_line) |expression_end| {
            block.expression_end_line = expression_end;
        }
        // An expression body is rendered from its own offset, so no `endLine` may
        // be left behind for `renderDeclaration` to prefer over it.
        block.end_line = null;
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

const AssignedName = struct { name: Str, match_end: usize };

/// `(?:const\s+|let\s+|var\s+)` at `q`, when it is there: the offset the name
/// would start at. The head is tried before the identifier at `q` itself, which
/// is what the JavaScript's greedy optional group does.
fn assignedHead(line: Str, q: usize) ?usize {
    const heads = [_][]const u8{ "const", "let", "var" };
    for (heads) |word| {
        if (!js.startsWithBytes(line[q..], word)) continue;
        var at = q + word.len;
        const spaces = at;
        while (at < line.len and js.isWhitespace(line[at])) at += 1;
        if (at == spaces) continue; // `\s+` needs one
        return at;
    }
    return null;
}

/// `(?:function\b|[^;]*=>)` at `at`: the offset just past what it matched.
fn assignedTail(line: Str, at: usize) ?usize {
    const keyword = &js.lit("function");
    if (js.startsWith(line[at..], keyword) and js.isWordBoundary(line, at + keyword.len)) {
        return at + keyword.len;
    }
    // `[^;]*=>` is greedy, so it is the **last** `=>` before the first `;`.
    const limit = js.indexOfUnit(line[at..], ';') orelse (line.len - at);
    const window = line[at .. at + limit];
    var index = window.len;
    while (index >= 2) {
        index -= 1;
        if (window[index] == '>' and window[index - 1] == '=') return at + index + 1;
    }
    return null;
}

/// `([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(?:async\s+)?(?:function\b|[^;]*=>)` from
/// `pos` (the assigned pattern after its leading group).
fn assignedRest(line: Str, pos: usize) ?AssignedName {
    if (pos >= line.len or !js.isIdentStart(line[pos])) return null;
    var end = pos + 1;
    while (end < line.len and js.isIdentPart(line[end])) end += 1;
    // `\b` after the name: a trailing `$` is not a word character, so the
    // JavaScript gives trailing `$`s back until a boundary exists.
    var name_end = end;
    while (name_end > pos and !js.isAsciiWord(line[name_end - 1])) name_end -= 1;
    if (name_end == pos) return null;

    var scan = name_end;
    while (scan < line.len and line[scan] != '=') scan += 1;
    if (scan >= line.len) return null;
    scan += 1; // the `=`
    while (scan < line.len and js.isWhitespace(line[scan])) scan += 1;

    const async_kw = &js.lit("async");
    var tail_at = scan;
    if (js.startsWith(line[scan..], async_kw)) {
        var spaces = scan + async_kw.len;
        const before = spaces;
        while (spaces < line.len and js.isWhitespace(line[spaces])) spaces += 1;
        if (spaces > before) tail_at = spaces; // `async\s+`, greedily
    }
    if (assignedTail(line, tail_at)) |tail_end| {
        return .{ .name = line[pos..name_end], .match_end = tail_end };
    }
    // The optional `async\s+` may be given back, and `[^;]*=>` still ends on the
    // same arrow.
    if (tail_at != scan) {
        if (assignedTail(line, scan)) |tail_end| {
            return .{ .name = line[pos..name_end], .match_end = tail_end };
        }
    }
    return null;
}

/// `(^|[^\w$.])(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(?:async\s+)?(?:function\b|[^;]*=>)`,
/// read as the JavaScript's global `exec` reads it: the next match at or after
/// `from`, with the offset just past the match — `exec` leaves `lastIndex` there,
/// so a name that only appears inside the match it just took is never tried.
fn nextAssignedName(line: Str, from: usize) ?AssignedName {
    var q = from;
    while (q < line.len) : (q += 1) {
        // `(^|[^\w$.])`: the empty first group at `^`, one separator otherwise.
        if (q > 0 and !isSeparatorUnit(line[q - 1])) continue;
        if (assignedHead(line, q)) |head_end| {
            if (assignedRest(line, head_end)) |hit| return hit;
        }
        if (assignedRest(line, q)) |hit| return hit;
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

/// The anchor of an **indented** block (a Python `def`, a Ruby `def`): the
/// trailing comment on its header line, or a comment that is the first thing in
/// its body. There is no brace to open, so the body starts at `body_from` and the
/// candidate must be that line or the declaration's own.
fn indentAnchor(
    comments: []const Comment,
    source: Str,
    lines: []const Str,
    starts: []const usize,
    decl_line: usize,
    body_from: usize,
    body_to: usize,
) ?Anchor {
    // The body's own first **non-blank** line is the other candidate, which is
    // what the JavaScript reads through `nextNonBlank`; `body_from` is the start
    // it is searched from.
    _ = body_from;
    const first_of_line_next = nextNonBlank(lines, decl_line + 1);
    var first: ?Comment = null;
    for (comments) |comment| {
        const line = lineOf(starts, comment.from);
        if (line < decl_line) continue;
        if (line > body_to) break;
        // On the declaration's own line the comment *is* the trailing comment —
        // `def legacy(self):  #count` — so nothing needs to precede it. In the
        // body the candidate is the first non-blank line after the declaration.
        const candidate_line = line == decl_line or (first_of_line_next != null and line == first_of_line_next.?);
        if (!candidate_line) break;
        // `firstOfLine`: on the declaration's own line the comment is the trailing
        // one; on the body's line it must be the first thing written there.
        if (line == decl_line or js.trim(source[starts[line]..comment.from]).len == 0) first = comment;
        break;
    }
    const found = first orelse return null;
    const body = js.trim(found.text);
    if (isRegionWord(body)) return null;
    if (body.len == 0 or !js.isIdentStart(body[0])) return null;
    var at: usize = 1;
    while (at < body.len and js.isIdentPart(body[at])) at += 1;
    if (at != body.len) return null;
    return .{ .name = body, .line = lineOf(starts, found.from) };
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

const COMMENT_OPENERS = [_][]const u8{ "//", "--", ";", "%", "'", "#", "REM", "<!--", "/*", "*" };
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
        return failure.set(error_codes.region_duplicated, try js.format(
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

/// Resolve `segments[index..]` starting at `scope`.
///
/// A name declared more than once at one level is **ambiguous**, and ambiguity is
/// an error, never a guess: `#add` must not inject the first of two `add`s, and
/// `#Cart` must not inject the `struct` when an `impl Cart` sits beside it.
///
/// What is *not* ambiguity is a name that several blocks share where the rest of
/// the path decides: a Rust `struct Cart` beside its `impl Cart` blocks all answer
/// to `Cart`, and `Cart/add` is resolved by retrying them in walk order — the one
/// that holds `add` wins. Only a last segment, or a set of candidates whose
/// descents *all* succeed, is ambiguous.
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
            // The message names both engines, but the band is the ordinary "not-found":
            // the JavaScript reports "resolution/not-found" here, and a port that
            // reported the region band would disagree with the corpus on a reference
            // that never mentioned a region.
            return failure.set(error_codes.not_found, try js.format(
                alloc,
                "no \"#region {s}\" found, and no section named \"{s}\"",
                .{ segment, segment },
            ));
        }
        return failure.set(error_codes.not_found, try js.format(
            alloc,
            "no section named \"{s}\" in \"{s}\"",
            .{ segment, prev_name orelse &.{} },
        ));
    }

    // The selection itself: nothing follows, so a second candidate is a second
    // answer and the reference does not say which one it wants.
    if (last and candidates.len > 1) {
        return failure.set(error_codes.ambiguous, try js.format(
            alloc,
            "\"{s}\" is declared {d} times; names must be unique",
            .{ segment, candidates.len },
        ));
    }

    // The failure to report when no candidate answers is kept whole, not as a
    // message alone: the JavaScript keeps the thrown error and a host branches on
    // its code, so a nested failure's code travels up beside its prose.
    var saved: ?Failure = null;
    var matched: ?SegmentHit = null;
    for (candidates) |found| {
        if (last) return found;
        if (found.region != null or !isContainer(found.block.?)) {
            if (saved == null) {
                saved = .{
                    .code = error_codes.not_a_container,
                    .message = try js.format(alloc, "\"{s}\" is not a container", .{segment}),
                };
            }
            continue;
        }
        const resolved = resolvePath(alloc, segments, index + 1, found.block.?, true, segment, failure) catch |err| {
            if (err != error.Failed) return err;
            if (saved == null) saved = failure.*;
            continue;
        };
        // Two candidates both holding the rest of the path is the same ambiguity
        // one level down: the path does not choose between them. Decided after
        // the catch, because the error belongs to this frame, not that one.
        if (matched != null) {
            return failure.set(error_codes.ambiguous, try js.format(
                alloc,
                "\"{s}\" is declared {d} times; names must be unique",
                .{ segment, candidates.len },
            ));
        }
        matched = resolved;
    }
    if (matched) |found| return found;
    if (saved) |value| failure.* = value;
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

/// A rendered section: the text, and the **1-based inclusive line range** it
/// came from (`from`/`to`), which is what a host navigates to.
const Render = struct { text: []u16, from: usize, to: usize };

/// A 1-based inclusive line range of the source, as `planSection` reports it.
pub const LineSpan = struct { from: usize, to: usize };

/// `lines.slice(fromLine, toLine + 1)`, an empty slice when the bounds are
/// inverted, as JavaScript's `slice` is.
fn sliceLines(alloc: Allocator, lines: []const Str, from_line: usize, to_line: usize) ![]u16 {
    if (to_line < from_line or from_line >= lines.len) return alloc.dupe(u16, &.{});
    const end = @min(to_line + 1, lines.len);
    return js.joinLines(alloc, lines[from_line..end]);
}

/// `span`: the slice's own lines, with the 1-based bounds of the slice.
fn renderSpan(alloc: Allocator, lines: []const Str, from_line: usize, to_line: usize) !Render {
    return .{
        .text = try sliceLines(alloc, lines, from_line, to_line),
        .from = from_line + 1,
        .to = @max(from_line, to_line) + 1,
    };
}

/// `single`: a one-line section, both bounds on that line (0-based).
fn single(text: []u16, at: usize) Render {
    return .{ .text = text, .from = at + 1, .to = at + 1 };
}

/// The bytes strictly between two offsets of `source`, trimmed, with the line
/// range the trimmed text still covers — the JavaScript's `trimmedSlice`.
///
/// A slice that is trimmed has to answer for the lines the trim removed: a click
/// on a body belongs to its first real line, not to the blank line above it, and
/// a slice that trims to nothing still reports the line it would have started on
/// rather than a range that runs backwards.
fn trimmedSlice(
    alloc: Allocator,
    source: Str,
    starts: []const usize,
    from: usize,
    to: usize,
) !Render {
    const start = @min(from, source.len);
    const end = @max(start, @min(to, source.len));
    const raw = source[start..end];
    const text = js.trim(raw);
    const at = lineOf(starts, @min(from, source.len));
    if (text.len == 0) {
        return .{ .text = try alloc.dupe(u16, &.{}), .from = at + 1, .to = at + 1 };
    }
    const skipped = raw.len - js.trimStart(raw).len;
    const dropped = raw.len - js.trimEnd(raw).len;
    const first = @min(start + skipped, source.len);
    // The offset of the last surviving character, and never before `first`.
    const last = @max(first, start + raw.len - dropped - 1);
    return .{
        .text = try alloc.dupe(u16, text),
        .from = lineOf(starts, first) + 1,
        .to = lineOf(starts, last) + 1,
    };
}

/// The text one declaration contributes, under one scope, and where it is.
///
/// `end_line` is the declaration's last line, and null when it has none to
/// name — a member a language writes without a body, whose header may still
/// wrap. The JavaScript reads that as `endLine + 1` and `Math.max(fromLine,
/// endLine)`, where `null + 1` is 1 and `null` is 0, so the slice is empty
/// unless the declaration opens the file; `end_line orelse 0` is the same
/// coercion.
fn renderDeclaration(
    alloc: Allocator,
    lines: []const Str,
    source: Str,
    starts: []const usize,
    block: *Block,
    end_line: ?usize,
    scope: Scope,
    annotations: []const syntaxes.Annotation,
) !Render {
    const last = end_line orelse 0;
    if (scope == .body) {
        if (block.single_line) return renderSpan(alloc, lines, block.decl_line, last);
        if (block.indented) {
            // A wrapped header's lines belong to the declaration, not the body,
            // so the body starts after the last of them.
            const first = block.body_from orelse (block.decl_line + 1);
            return renderSpan(alloc, lines, first, last);
        }
        if (block.expression) |expression| {
            const at = lineOf(starts, expression);
            // The expression may be a block, whose lines the declaration's own
            // indentation governs (`main = do` then an indented body). The
            // scanner only carries `expressionEndLine` for a language's own
            // shape, as the JavaScript does.
            const expression_end = block.expression_end_line orelse at;
            if (expression_end > at) return renderSpan(alloc, lines, at, expression_end);
            return single(
                try alloc.dupe(u16, js.trim(source[expression..endOfLine(source, expression)])),
                at,
            );
        }
        if (block.open_line == end_line) {
            // A block with no braces at all (`void add(int x);`) reaches this
            // with both offsets unset: `null + 1` and `null` make an empty
            // single-line span on line 1.
            const open = block.open orelse 0;
            const close = block.close orelse 0;
            return single(
                try alloc.dupe(u16, js.trim(source[@min(open + 1, close)..close])),
                block.open_line orelse 0,
            );
        }
        return renderSpan(alloc, lines, block.open_line.? + 1, last - 1);
    }

    var first = block.decl_line;
    if (scope == .annotated or scope == .documented) {
        if (annotationStart(lines, block.decl_line, annotations)) |annotated| first = annotated;
        if (scope == .documented) {
            if (docCommentStart(lines, first)) |documented| first = documented;
        }
    }
    return renderSpan(alloc, lines, first, last);
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

/// The text `block` contributes under `scope`, and the lines it came from.
fn renderBlock(
    alloc: Allocator,
    block: *Block,
    scope: Scope,
    match_kind: HitKind,
    facts: Facts,
) !Render {
    const is_anchor = match_kind == .anchor or match_kind == .condition;
    const end_line = block.end_line orelse block.close_line orelse block.decl_line;

    if (!is_anchor and (block.kind == .class or block.kind == .method)) {
        // An expression body carries the line its expression ends on; every other
        // shape carries the line its body closes on.
        return renderDeclaration(
            alloc,
            facts.lines,
            facts.source,
            facts.starts,
            block,
            block.expression_end_line orelse block.end_line orelse block.close_line,
            scope,
            facts.annotations,
        );
    }
    if (!is_anchor and block.kind == .property) {
        // The whole statement, from the line its name is written on through the
        // line its `;` is on — which is a later line for a lambda or an array
        // initialiser, and the same line for a plain field.
        const last = if (block.line_end) |line_end| @max(block.decl_line, line_end) else block.decl_line;
        if (scope == .body) {
            // An enum constant's "body" is what follows its name — the arguments it is built with, and the body
            // it declares — because that is the part of a constant that is not its name (2026-10-13).
            if (block.enum_constant) {
                const name_end = block.name_end;
                const statement_to = block.statement_to;
                if (name_end == null or statement_to == null or name_end.? >= statement_to.?) {
                    return single(try alloc.dupe(u16, &.{}), block.decl_line);
                }
                return trimmedSlice(
                    alloc,
                    facts.source,
                    facts.starts,
                    name_end.?,
                    statement_to.?,
                );
            }
            // `-` selects the initialiser expression: the bytes between the `=`
            // that opens it and the `;` that ends the statement. A member with no
            // initialiser has an empty body, reported on its own line.
            const equals_at = block.equals_at;
            const statement_to = block.statement_to;
            if (equals_at == null or statement_to == null or equals_at.? >= statement_to.?) {
                return single(try alloc.dupe(u16, &.{}), block.decl_line);
            }
            return trimmedSlice(
                alloc,
                facts.source,
                facts.starts,
                equals_at.? + 1,
                statement_to.?,
            );
        }
        // The statement's own last line is what the `+`/`++` scopes extend from,
        // so a field takes its `@Annotation` and its doc comment exactly as a
        // method does — a field is a declaration too, and the annotation above it
        // belongs to it.
        block.end_line = last;
        return renderDeclaration(
            alloc,
            facts.lines,
            facts.source,
            facts.starts,
            block,
            last,
            scope,
            facts.annotations,
        );
    }

    const anchor_line: ?usize = if (block.anchor) |anchor| anchor.line else null;
    const first_line = block.decl_line;
    const last_line = block.close_line orelse end_line;
    if (scope == .body) {
        const base = block.open_line orelse 0;
        const body_from = if (anchor_line) |line| @max(base, line) else base;
        if (body_from >= last_line) {
            // The slice is trimmed, so the span has to account for the blank
            // lines the trim removed at either end.
            const raw = facts.source[block.open.? + 1 .. block.close.?];
            const skipped = raw.len - js.trimStart(raw).len;
            const dropped = raw.len - js.trimEnd(raw).len;
            const from = lineOf(facts.starts, block.open.? + 1 + skipped);
            const to = lineOf(facts.starts, block.close.? - dropped);
            return .{
                .text = try alloc.dupe(u16, js.trim(raw)),
                .from = from + 1,
                .to = @max(from, to) + 1,
            };
        }
        return renderSpan(alloc, facts.lines, body_from + 1, last_line - 1);
    }

    // A non-final chain segment (`if … } else if …`) shares its closing `}`
    // with the continuation on the same line: end at the brace, not the line.
    if (block.shared_close) {
        const text = facts.source[facts.starts[first_line] .. block.close.? + 1];
        const split = try js.splitLines(alloc, text);
        for (split) |*line| line.* = js.trimEnd(line.*);
        return .{
            .text = try js.joinLines(alloc, split),
            .from = first_line + 1,
            .to = lineOf(facts.starts, block.close.?) + 1,
        };
    }
    return renderSpan(alloc, facts.lines, first_line, last_line);
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
        return failure.set(error_codes.ambiguous, try js.format(
            alloc,
            "\"{s}\" is declared {d} times; names must be unique",
            .{ name, chosen.len },
        ));
    }
    const block = chosen[0];
    // The same renderer the resolver uses, so the two entry points cannot disagree about what a declaration's
    // text is — a property reads its own statement here rather than going through the body-less declaration path.
    const rendered = try renderBlock(alloc, block, scope, .declaration, scan.facts);
    return rendered.text;
}

fn hasBody(block: *Block) bool {
    if (block.single_line or block.expression != null or block.indented) return true;
    // A property — a field, and an enum's constant — is a selection even with no body at all: the statement
    // (or the constant) *is* what is injected, which is why `planSection` has always resolved one. Extraction
    // used to skip them, which made the two entry points disagree (2026-10-13).
    return block.open_line != null or block.kind == .property;
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

/// What one selector contributed: its text, its kind, and where it came from.
const Part = struct { text: []u16, kind: PlanKind, ranges: []const LineSpan };

/// The kind of a plan: a single selector's kind, or `multiple` for several.
pub const PlanKind = enum { region, declaration, property, condition, anchor, lines, multiple };

pub const Plan = struct {
    text: []u16,
    reference: Reference,
    start_line: usize,
    end_line: usize,
    ranges: []const LineSpan,
    kind: PlanKind,
};

/// The last line of a block's declaration, for the spans the plan reports.
fn lastDeclarationLine(block: *Block) usize {
    if (block.end_line) |line| return line;
    if (block.close_line) |line| return line;
    return block.decl_line;
}

/// `sliceRanges`: where one rendered slice came from.
///
/// A slice is one line range in almost every case, and `lead` is what makes it
/// more than one: a rendering may *prepend* a line of its own invention (the
/// `if` of a condition literal, the header of a chain segment) before the lines
/// the reference names, and then the lead belongs to the header line and the
/// rest to the lines that follow.
fn sliceRanges(
    alloc: Allocator,
    range: LineSpan,
    text: Str,
    lead: usize,
) ![]const LineSpan {
    if (lead == 0 or lead >= text.len) return alloc.dupe(LineSpan, &.{range});

    const rest = text[lead..];
    var lines_taken: usize = 1;
    for (rest) |unit| {
        if (unit == '\n') lines_taken += 1;
    }
    const tail_from = if (range.to + 1 >= lines_taken) range.to + 1 - lines_taken else 0;
    const out = try alloc.alloc(LineSpan, 2);
    out[0] = .{ .from = range.from, .to = range.from };
    out[1] = .{ .from = @max(range.from + 1, tail_from), .to = range.to };
    return out;
}

/// The source text of a slice's own lines, the `head` a rendered text may lead
/// with; `str.slice`'s clamping included — an offset past the last line's start
/// behaves as `undefined` does in JavaScript.
fn headOf(source: Str, starts: []const usize, slice: LineSpan) Str {
    const start = if (slice.from >= 1 and slice.from - 1 < starts.len) starts[slice.from - 1] else 0;
    const end = if (slice.to < starts.len) starts[slice.to] else source.len;
    return js.clampSlice(source, start, end);
}

/// `lineRangeSpan`: the lines a line-range selector names, as text and as a span.
///
/// Lines are counted from 1 and columns from 1, both inclusive. Anything the
/// file does not have is an error rather than a clamp — a range that silently
/// became a different range is exactly the drift a reference to a line number
/// is for.
fn lineRangeSpan(
    alloc: Allocator,
    facts: Facts,
    from: LinePoint,
    to: ?LinePoint,
    raw: Str,
    failure: *Failure,
) Error!struct { text: []u16, range: LineSpan } {
    const source = facts.source;
    const lines = facts.lines;
    const starts = facts.starts;
    const from_line = from.line;
    const to_point = to orelse from;
    const to_line = to_point.line;

    // `lines` is split on `\n`, so a file ending in a newline has a final empty
    // entry: the file's last line is the last entry that is not that emptiness.
    const total: usize = if (source.len == 0) 0 else lines.len;
    if (from_line > total or to_line > total) {
        return failure.set(error_codes.line_range_past_end, try js.format(
            alloc,
            "\"#{s}\": the file has {d} line(s)",
            .{ raw, total },
        ));
    }
    if (from.column) |column| {
        if (column - 1 >= lines[from_line - 1].len) {
            return failure.set(error_codes.line_range_column_past_end, try js.format(
                alloc,
                "\"#{s}\": line {d} has {d} character(s)",
                .{ raw, from_line, lines[from_line - 1].len },
            ));
        }
    }

    const start = starts[from_line - 1] + (if (from.column) |column| column - 1 else 0);
    const end: usize = if (to != null and to.?.column != null) blk: {
        const column = to.?.column.?;
        if (column - 1 >= lines[to_line - 1].len) {
            return failure.set(error_codes.line_range_column_past_end, try js.format(
                alloc,
                "\"#{s}\": line {d} has {d} character(s)",
                .{ raw, to_line, lines[to_line - 1].len },
            ));
        }
        // Both columns are inclusive, so the slice runs one past the character
        // the second column names.
        break :blk starts[to_line - 1] + column;
    } else endOfLine(source, starts[to_line - 1]);

    return .{
        .text = try alloc.dupe(u16, source[start..end]),
        .range = .{ .from = from_line, .to = to_line },
    };
}

/// Resolve a section reference to text, exposing the reference.
/// `resolveSection` is `planSection(...).text`.
///
/// A reference is one or more selectors (`add,L40-L44`): each contributes its
/// own text, and the texts are joined with a newline in the order the selectors
/// were written. `ranges` says where each contribution came from — one line
/// range per selector, so a reference that names two far-apart pieces highlights
/// the two pieces and not the gap between them — and `start_line`/`end_line` are
/// the outermost bounds of the whole selection.
pub fn planSection(
    alloc: Allocator,
    text: Str,
    reference: Str,
    lexer: ?lexers.Lexer,
    failure: *Failure,
) Error!Plan {
    const ref = try parseSelectors(alloc, reference, failure);
    const scan = try scanBlocks(alloc, text, lexer);
    const facts = scan.facts;

    var parts = std.ArrayList(Part).empty;
    // An envelope is resolved **first, and as a unit**: the parent its marks name
    // may be a name several blocks answer to, and which one is meant is decided by
    // what the marks wrap — the candidate that holds the member.
    const envelope = try resolveEnvelope(alloc, ref.selectors.?, scan, failure);

    for (ref.selectors.?, 0..) |selector, index| {
        switch (selector) {
            .lines => |line| {
                const picked = try lineRangeSpan(alloc, facts, line.from, line.to, line.raw, failure);
                const ranges = try alloc.alloc(LineSpan, 1);
                ranges[0] = picked.range;
                try parts.append(alloc, .{ .text = picked.text, .kind = .lines, .ranges = ranges });
            },
            .path => |path| {
                // A parent's own opening or closing lines, taken verbatim around
                // whatever sits between the marks.
                if (envelope) |found| {
                    if (found.parts.get(index)) |part| {
                        try parts.append(alloc, part);
                        continue;
                    }
                }
                const scope: ?*Block = if (envelope) |found| found.scopes.get(index) else null;
                try parts.append(alloc, try selectorPart(alloc, path, scope orelse scan.root, scan, failure));
            },
        }
    }

    const joined = try joinPartTexts(alloc, parts.items);

    // Merge the adjacent pieces, so a reference that names two lines side by
    // side reports one range rather than two.
    var ranges = std.ArrayList(LineSpan).empty;
    for (parts.items) |part| {
        for (part.ranges) |range| {
            if (ranges.items.len > 0) {
                const last = &ranges.items[ranges.items.len - 1];
                if (range.from >= last.from and range.from <= last.to + 1) {
                    last.to = @max(last.to, range.to);
                    continue;
                }
            }
            try ranges.append(alloc, range);
        }
    }

    var low: usize = std.math.maxInt(usize);
    var high: usize = 0;
    for (ranges.items) |range| {
        low = @min(low, range.from);
        high = @max(high, range.to);
    }

    return .{
        .text = joined,
        .reference = ref,
        .start_line = if (ranges.items.len > 0) low else 1,
        .end_line = if (ranges.items.len > 0) high else 1,
        .ranges = try ranges.toOwnedSlice(alloc),
        .kind = if (parts.items.len == 1) parts.items[0].kind else .multiple,
    };
}

/// `selectorPart`: resolve one path selector inside `scope` into its text and
/// ranges.
///
/// Every segment but the last is a container to descend into, retrying same-named
/// candidates (a Rust `struct Cart` beside its `impl Cart`); the last segment's
/// first match in walk order is the selection. The scope is the whole file for an
/// ordinary selector, and the block an envelope names for a selector written
/// between its marks.
fn selectorPart(
    alloc: Allocator,
    path: PathSelector,
    scope: *Block,
    scan: Scan,
    failure: *Failure,
) Error!Part {
    const facts = scan.facts;

    const final = if (scope == scan.root)
        try resolvePath(alloc, path.segments, 0, scan.root, false, null, failure)
    else
        try resolveWithin(alloc, scope, path.segments, failure);

    var rendered: Render = undefined;
    var slice: LineSpan = undefined;
    var kind: PlanKind = undefined;
    if (final.region) |region| {
        rendered = try renderSpan(alloc, facts.lines, region.start_line + 1, region.end_line - 1);
        // The region's own span is the rendered slice's: the directive lines are
        // not part of it, and the slice is exactly the lines between them.
        slice = .{ .from = rendered.from, .to = rendered.to };
        kind = .region;
    } else {
        const block = final.block.?;
        rendered = try renderBlock(alloc, block, path.scope, final.kind, facts);
        kind = switch (final.kind) {
            .declaration => .declaration,
            .property => .property,
            .condition => .condition,
            .anchor => .anchor,
            .region => .region,
        };
        if (final.kind == .condition) {
            // The header line the matcher cites is rendered ahead of the block's
            // own first line; it is the slice's first.
            slice = .{ .from = final.header_line.? + 1, .to = lastDeclarationLine(block) + 1 };
        } else if (final.kind == .anchor) {
            const anchor_line = if (block.anchor) |anchor| anchor.line else block.decl_line;
            slice = .{ .from = anchor_line + 1, .to = lastDeclarationLine(block) + 1 };
        } else {
            slice = .{ .from = rendered.from, .to = rendered.to };
        }
    }

    // A rendering may prepend a line of its own invention — the `if` of a
    // condition literal, the brace line of a body that opens below its header —
    // before the lines the span names, so the span is only exact for the part of
    // the text that matches the source; the lead is the header line's own.
    const head = headOf(facts.source, facts.starts, slice);
    const lead: usize = if (js.startsWith(rendered.text, head)) head.len else 0;
    return .{
        .text = rendered.text,
        .kind = kind,
        .ranges = try sliceRanges(alloc, slice, rendered.text, lead),
    };
}

/// `resolveWithin`: resolve a path whose **first** segment is a member of
/// `block`, exactly as `Cart/add` resolves inside `Cart` — the rest of the path
/// is searched in that block and nothing else is considered.
fn resolveWithin(
    alloc: Allocator,
    block: *Block,
    segments: []const Str,
    failure: *Failure,
) Error!SegmentHit {
    if (segments.len == 1) {
        var candidates = std.ArrayList(SegmentHit).empty;
        try matchSegment(alloc, block, segments[0], true, &candidates, failure);
        if (candidates.items.len == 0) {
            return failure.set(error_codes.not_found, try js.format(
                alloc,
                "no section named \"{s}\" in \"{s}\"",
                .{ segments[0], block.name orelse &js.lit("null") },
            ));
        }
        if (candidates.items.len > 1) {
            return failure.set(error_codes.ambiguous, try js.format(
                alloc,
                "\"{s}\" is declared {d} times; names must be unique",
                .{ segments[0], candidates.items.len },
            ));
        }
        return candidates.items[0];
    }
    return resolvePath(alloc, segments, 1, block, true, block.name, failure);
}

/// The block an envelope mark names, as an envelope is resolved.
pub const EnvelopeResolution = struct {
    /// The head and tail pieces, keyed by the selector's index in the reference.
    parts: std.AutoHashMap(usize, Part),
    /// The block every interior selector is read inside, by index.
    scopes: std.AutoHashMap(usize, *Block),
};

/// `envelopePart`: the parent declaration's own first lines (the head) or last
/// line (the tail), taken verbatim.
fn envelopePart(alloc: Allocator, selector: PathSelector, scan: Scan, block: *Block) !Part {
    const lines = scan.facts.lines;
    const is_head = selector.envelope.?.mark == .open;
    const last = lastDeclarationLine(block);
    const to = if (is_head) @min(block.open_line orelse block.decl_line, last) else last;
    const from = if (is_head) block.decl_line else to;

    var selected = std.ArrayList(Str).empty;
    var at = from;
    while (at <= to and at < lines.len) : (at += 1) try selected.append(alloc, lines[at]);
    const ranges = try alloc.alloc(LineSpan, 1);
    ranges[0] = .{ .from = from + 1, .to = to + 1 };
    return .{
        .text = try js.joinLines(alloc, selected.items),
        .kind = .declaration,
        .ranges = ranges,
    };
}

/// `resolveEnvelope`: read a reference's envelope as a unit — which block the
/// marks open and close, and the opening and closing pieces for it.
///
/// Returns null when the reference carries no envelope marks.
fn resolveEnvelope(
    alloc: Allocator,
    selectors: []const Selector,
    scan: Scan,
    failure: *Failure,
) Error!?EnvelopeResolution {
    var any = false;
    for (selectors) |selector| {
        if (selector == .path and selector.path.envelope != null) any = true;
    }
    if (!any) return null;

    const open = selectors[0];
    const close = selectors[selectors.len - 1];
    const parent = open.path.envelope.?.parent.items;

    // A one-segment parent is asked for *every* block it names, because the marks
    // choose among them; a path of several segments already decided, so there is
    // one candidate. The region is kept beside the candidates rather than filtered
    // out of them: a region is a *match* that cannot be an envelope, and reporting
    // it as "found nothing" would be a lie about what the file wrote.
    var candidates = std.ArrayList(*Block).empty;
    var matched_region = false;
    if (parent.len == 1) {
        var matched = std.ArrayList(SegmentHit).empty;
        try matchSegment(alloc, scan.root, parent[0], false, &matched, failure);
        for (matched.items) |match| {
            if (match.region != null) {
                matched_region = true;
                continue;
            }
            try candidates.append(alloc, match.block.?);
        }
    } else {
        const found = try resolvePath(alloc, parent, 0, scan.root, false, null, failure);
        if (found.region) |_| return envelopeRegion(alloc, open.path.raw, failure);
        try candidates.append(alloc, found.block.?);
    }
    if (candidates.items.len == 0) {
        if (matched_region) return envelopeRegion(alloc, open.path.raw, failure);
        return failure.set(error_codes.region_not_found, try js.format(
            alloc,
            "no \"#region {s}\" found, and no section named \"{s}\"",
            .{ parent[0], parent[0] },
        ));
    }

    const interior = selectors[1 .. selectors.len - 1];
    var parts = std.AutoHashMap(usize, Part).init(alloc);
    var scopes = std.AutoHashMap(usize, *Block).init(alloc);

    var first_failure: ?Failure = null;
    for (candidates.items) |block| {
        if (!isContainer(block)) continue;
        // Every interior selector has to resolve inside this candidate, or this is
        // not the block the envelope is about.
        var ok = true;
        for (interior, 1..) |selector, index| {
            if (selector != .path) continue;
            _ = selectorPart(alloc, selector.path, block, scan, failure) catch {
                // The first failure is what is reported: the message and the code
                // the resolver produced, unchanged. The JS also rewrites the
                // advisory `selector`/`scope` fields to name what the *user*
                // wrote rather than the parent-qualified spelling; this port's
                // `Failure` carries message and code only, so there is nothing to
                // rewrite and the corpus asserts exactly those two.
                if (first_failure == null) first_failure = failure.*;
                ok = false;
                break;
            };
            try scopes.put(index, block);
        }
        if (!ok) continue;

        // The head and the tail, plus the scope every interior selector is read in.
        parts.put(0, try envelopePart(alloc, open.path, scan, block)) catch return error.OutOfMemory;
        parts.put(selectors.len - 1, try envelopePart(alloc, close.path, scan, block)) catch return error.OutOfMemory;
        scopes.put(0, block) catch return error.OutOfMemory;
        scopes.put(selectors.len - 1, block) catch return error.OutOfMemory;
        return .{ .parts = parts, .scopes = scopes };
    }

    if (first_failure) |failure_value| {
        failure.* = failure_value;
        return error.Failed;
    }
    return failure.set(error_codes.not_a_container, try js.format(
        alloc,
        "\"{s}\" is not a container",
        .{try joinComma(alloc, parent)},
    ));
}

fn envelopeRegion(alloc: Allocator, raw: Str, failure: *Failure) Error!?EnvelopeResolution {
    return failure.grammarMessage(error_codes.envelope_region, try js.format(
        alloc,
        "\"#{s}\": a region has no declaration to open or close",
        .{raw},
    ));
}

fn joinComma(alloc: Allocator, segments: []const Str) !Str {
    var out = std.ArrayList(u16).empty;
    for (segments, 0..) |segment, index| {
        if (index > 0) try out.append(alloc, ',');
        try out.appendSlice(alloc, segment);
    }
    return out.toOwnedSlice(alloc);
}

/// `parts.map((part) => part.text).join('\n')`.
fn joinPartTexts(alloc: Allocator, parts: []const Part) ![]u16 {
    var out = std.ArrayList(u16).empty;
    for (parts, 0..) |part, index| {
        if (index > 0) try out.append(alloc, '\n');
        try out.appendSlice(alloc, part.text);
    }
    return out.toOwnedSlice(alloc);
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

/// A `*Failure` for a parse that is expected to succeed; only a failing call
/// ever writes to it.
var scratch_failure = Failure{};

fn expectUnits(alloc: Allocator, expected: []const u8, actual: Str) !void {
    const want = try js.utf8Decode(alloc, expected);
    try testing.expectEqualSlices(u16, want, actual);
}

/// Assert a failure's stable code against the row's.
///
/// This is the assertion the *message* cannot make: two failures with different
/// bands can read alike, and a host chooses a fallback from the code, so a port
/// that reports the right prose out of the wrong category fails here.
///
/// The category is read from the row's own code — `grammar/` for a malformed
/// reference, `resolution/` for a file that cannot answer one — and then checked
/// against how the port failed. That is deliberately not "a parse row must be a
/// grammar code": an **envelope** whose marks contradict each other is rejected by
/// the parser, and its band is a `resolution/` one, because it is the pair of
/// marks and not the spelling that is wrong.
fn expectCode(
    alloc: Allocator,
    case: vectors.Case,
    failure: Failure,
) !void {
    const expected = case.code orelse {
        std.debug.print("{s}: no code in the row, but the port failed\n", .{case.name});
        return error.MissingCode;
    };

    if (!std.mem.startsWith(u8, expected, "grammar/") and !std.mem.startsWith(u8, expected, "resolution/")) {
        std.debug.print("{s}: code {s} is namespaced by neither category\n", .{ case.name, expected });
        return error.CodeCategoryMismatch;
    }
    try expectUnits(alloc, expected, failure.code);
}

test "parseReference reads the modifiers and canonicalises them" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { raw: []const u8, canonical: []const u8, scope: Scope }{
        .{ .raw = "add", .canonical = "add", .scope = .declaration },
        .{ .raw = "add/-", .canonical = "add/-", .scope = .body },
        .{ .raw = "add/+", .canonical = "add/+", .scope = .annotated },
        .{ .raw = "add/++", .canonical = "add/++", .scope = .documented },
        // A name may contain a hyphen: only a whole segment is a modifier.
        .{ .raw = "add-", .canonical = "add-", .scope = .declaration },
        .{ .raw = "-add", .canonical = "-add", .scope = .declaration },
        .{ .raw = "--brand", .canonical = "--brand", .scope = .declaration },
        .{ .raw = "Cart/Line/render", .canonical = "Cart/Line/render", .scope = .declaration },
        .{ .raw = "Cart/Line/-", .canonical = "Cart/Line/-", .scope = .body },
        .{ .raw = "Cart/Line/++", .canonical = "Cart/Line/++", .scope = .documented },
        .{ .raw = "Cart/Line/render/-", .canonical = "Cart/Line/render/-", .scope = .body },
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
        // A modifier is the last segment of a path, and nothing may follow it.
        .{ .raw = "a/+/b", .message = "\"+\" may only modify the last path segment of \"#a/+/b\"" },
        .{ .raw = "a/-/b", .message = "\"-\" may only modify the last path segment of \"#a/-/b\"" },
        .{ .raw = "Cart/Line/-/render", .message = "\"-\" may only modify the last path segment of \"#Cart/Line/-/render\"" },
        .{ .raw = "a/+++", .message = "\"#a/+++\" carries more than one modifier" },
        .{ .raw = "a/---", .message = "\"#a/---\" carries more than one modifier" },
        .{ .raw = "+++", .message = "\"#+++\" carries more than one modifier" },
        // The old spellings: `+` never occurs inside a name, so it can only
        // have meant a modifier, and the message names the spelling that works.
        .{ .raw = "add++", .message = "\"++\" is a path segment now; write \"#add/++\"" },
        .{ .raw = "add+", .message = "\"+\" is a path segment now; write \"#add/+\"" },
        .{ .raw = "a/b++", .message = "\"++\" is a path segment now; write \"#b/++\"" },
        .{ .raw = "++add", .message = "\"++\" is a path segment now; it follows the path, as \"#<path>/++\"" },
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

test "parseSelectors reads a reference as a comma-separated list of selectors" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { raw: []const u8, canonical: []const u8, scope: Scope }{
        .{ .raw = "L40", .canonical = "L40", .scope = .declaration },
        .{ .raw = "L40:12", .canonical = "L40:12", .scope = .declaration },
        .{ .raw = "L40-L44", .canonical = "L40-L44", .scope = .declaration },
        .{ .raw = "L40:12-L44:3", .canonical = "L40:12-L44:3", .scope = .declaration },
        .{ .raw = "add,render", .canonical = "add,render", .scope = .declaration },
        // Each selector's own modifier is that selector's, and a `-` inside a
        // name is a name.
        .{ .raw = "add/-,render/++", .canonical = "add/-,render/++", .scope = .declaration },
        .{ .raw = "add,L40-L44", .canonical = "add,L40-L44", .scope = .declaration },
        .{ .raw = "L40-L44,add/-", .canonical = "L40-L44,add/-", .scope = .declaration },
        .{ .raw = "L40,L50-L52", .canonical = "L40,L50-L52", .scope = .declaration },
        // A comma between selectors is structure, not part of a name.
        .{ .raw = "L40, L50", .canonical = "L40,L50", .scope = .declaration },
    };
    for (cases) |case| {
        const raw = try js.utf8Decode(alloc, case.raw);
        var local = Failure{};
        const reference = parseSelectors(alloc, raw, &local) catch |err| {
            std.debug.print("parseSelectors({s}): {any}\n", .{ case.raw, local.message });
            return err;
        };
        try expectUnits(alloc, case.canonical, reference.canonical);
        try testing.expectEqual(case.scope, reference.scope);
    }

    // A modifier belongs to the selector whose path carries it, and to no other.
    {
        const reference = try parseSelectors(alloc, try js.utf8Decode(alloc, "add/-,render"), &scratch_failure);
        try expectUnits(alloc, "add/-,render", reference.canonical);
        try testing.expectEqual(Scope.declaration, reference.scope);
        try testing.expectEqual(Scope.body, reference.selectors.?[0].path.scope);
        try testing.expectEqual(Scope.declaration, reference.selectors.?[1].path.scope);
    }
    {
        const reference = try parseSelectors(alloc, try js.utf8Decode(alloc, "add,render/++"), &scratch_failure);
        try testing.expectEqual(Scope.documented, reference.selectors.?[1].path.scope);
        try testing.expectEqual(Scope.declaration, reference.scope);
    }
    try testing.expectEqual(
        Scope.documented,
        (try parseSelectors(alloc, try js.utf8Decode(alloc, "add/++"), &scratch_failure)).scope,
    );

    // A single path selector keeps every field the single-reference grammar had.
    {
        const reference = try parseSelectors(alloc, try js.utf8Decode(alloc, "Cart/Line/render/-"), &scratch_failure);
        try testing.expectEqual(@as(usize, 3), reference.segments.len);
        try expectUnits(alloc, "Cart", reference.segments[0]);
        try expectUnits(alloc, "render", reference.segments[2]);
        try testing.expectEqual(Scope.body, reference.scope);
        try testing.expectEqual(@as(usize, 1), reference.selectors.?.len);
    }
    // A list of selectors is not one path.
    try testing.expectEqual(
        @as(usize, 0),
        (try parseSelectors(alloc, try js.utf8Decode(alloc, "add,render"), &scratch_failure)).segments.len,
    );

    // A line-range selector carries the range it names, and no path.
    {
        const reference = try parseSelectors(alloc, try js.utf8Decode(alloc, "L40:12-L44:3"), &scratch_failure);
        try testing.expectEqual(@as(usize, 0), reference.segments.len);
        const line = reference.selectors.?[0].lines;
        try testing.expectEqual(@as(usize, 40), line.from.line);
        try testing.expectEqual(@as(?usize, 12), line.from.column);
        try testing.expectEqual(@as(usize, 44), line.to.?.line);
        try testing.expectEqual(@as(?usize, 3), line.to.?.column);
    }
    try testing.expect(
        (try parseSelectors(alloc, try js.utf8Decode(alloc, "L40"), &scratch_failure)).selectors.?[0].lines.to == null,
    );

    // A modifier after a range is not a range at all.
    {
        var failure = Failure{};
        try testing.expectError(
            error.Failed,
            parseSelectors(alloc, try js.utf8Decode(alloc, "L40/+"), &failure),
        );
        try expectUnits(alloc, "\"#L40/+\" is not a line range; write L<line> or L<line>:<column>", failure.message);
    }

    // `Lx` never claimed to be a range (no digit), so it stays a name.
    {
        const reference = try parseSelectors(alloc, try js.utf8Decode(alloc, "Lx"), &scratch_failure);
        try testing.expectEqual(@as(usize, 1), reference.segments.len);
        try expectUnits(alloc, "Lx", reference.segments[0]);
    }
}

test "parseSelectors rejects the malformed ranges and empty selectors" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const cases = [_]struct { raw: []const u8, message: []const u8 }{
        .{ .raw = "L40-", .message = "\"#L40-\" is not a line range; write L<line> or L<line>:<column>" },
        .{ .raw = "L40:x", .message = "\"#L40:x\" is not a line range; write L<line> or L<line>:<column>" },
        .{ .raw = "L40:x-L44", .message = "\"#L40:x-L44\" is not a line range; write L<line> or L<line>:<column>" },
        .{ .raw = "L40-L44:", .message = "\"#L40-L44:\" is not a line range; write L<line> or L<line>:<column>" },
        // A range has nothing for a modifier to select, and `/` is the path
        // separator rather than part of a range.
        .{ .raw = "L40-L44/+", .message = "\"#L40-L44/+\" is not a line range; write L<line> or L<line>:<column>" },
        .{ .raw = "L40-L44/-", .message = "\"#L40-L44/-\" is not a line range; write L<line> or L<line>:<column>" },
        .{ .raw = "L40/+", .message = "\"#L40/+\" is not a line range; write L<line> or L<line>:<column>" },
        .{ .raw = "L0", .message = "\"#L0\" counts lines and columns from 1" },
        .{ .raw = "L40:0", .message = "\"#L40:0\" counts lines and columns from 1" },
        .{ .raw = "L1:0", .message = "\"#L1:0\" counts lines and columns from 1" },
        .{ .raw = "L44-L40", .message = "\"#L44-L40\" ends before it starts" },
        .{ .raw = "L40:5-L40:2", .message = "\"#L40:5-L40:2\" ends before it starts" },
        .{ .raw = "L40-L44:0", .message = "\"#L40-L44:0\" counts lines and columns from 1" },
        // A comma joins selectors, so an empty one is an error, not a name.
        .{ .raw = "add,", .message = "\"#add,\" has an empty selector" },
        .{ .raw = ",add", .message = "\"#,add\" has an empty selector" },
        .{ .raw = "add,,render", .message = "\"#add,,render\" has an empty selector" },
    };
    for (cases) |case| {
        const raw = try js.utf8Decode(alloc, case.raw);
        var failure = Failure{};
        try testing.expectError(error.Failed, parseSelectors(alloc, raw, &failure));
        try testing.expect(failure.grammar);
        try expectUnits(alloc, case.message, failure.message);
    }

    // `parseReference` is the single path selector reader: a comma and a range
    // are not a path, and are reported as such.
    {
        var failure = Failure{};
        try testing.expectError(
            error.Failed,
            parseReference(alloc, try js.utf8Decode(alloc, "a,b"), &failure),
        );
        try expectUnits(alloc, "\"#a,b\" has an empty selector", failure.message);
    }
    {
        var failure = Failure{};
        try testing.expectError(
            error.Failed,
            parseReference(alloc, try js.utf8Decode(alloc, "L40-L44"), &failure),
        );
        try expectUnits(alloc, "\"#L40-L44\" is a line range, not a section path", failure.message);
    }
    {
        var failure = Failure{};
        try testing.expectError(
            error.Failed,
            parseReference(alloc, try js.utf8Decode(alloc, "L40-"), &failure),
        );
        try expectUnits(alloc, "\"#L40-\" is not a line range; write L<line> or L<line>:<column>", failure.message);
    }
}

/// The plan for one reference over one fixture, with the fixture's lexer.
fn planFor(alloc: Allocator, source: Str, reference: []const u8, path: []const u8) Error!Plan {
    var failure = Failure{};
    const plan = try planSection(
        alloc,
        source,
        try js.utf8Decode(alloc, reference),
        lexers.lexerFor(try js.utf8Decode(alloc, path)),
        &failure,
    );
    return plan;
}

/// The failure message one reference produces over one fixture.
fn planFailure(alloc: Allocator, source: Str, reference: []const u8, path: []const u8) !Str {
    var failure = Failure{};
    _ = planSection(
        alloc,
        source,
        try js.utf8Decode(alloc, reference),
        lexers.lexerFor(try js.utf8Decode(alloc, path)),
        &failure,
    ) catch |err| switch (err) {
        error.Failed, error.Grammar => return failure.message,
        else => |other| return other,
    };
    return error.ExpectedAFailure;
}

fn expectPlanText(alloc: Allocator, expected: []const u8, plan: Plan) !void {
    try expectUnits(alloc, expected, plan.text);
}

test "line ranges select the lines they name, byte for byte" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const example_text = vectors.sourceOf("test/fixtures/Example.java") orelse return error.MissingFixture;
    const example = try js.utf8Decode(alloc, example_text);

    // The two readings of the same three lines must agree exactly — that is the
    // whole point of being allowed to write a line number at all.
    try expectPlanText(
        alloc,
        "    public String toString() {\n        return String.join(\",\", items);\n    }",
        try planFor(alloc, example, "L12-L14", "x.java"),
    );
    try expectUnits(
        alloc,
        "    public String toString() {\n        return String.join(\",\", items);\n    }",
        (try planFor(alloc, example, "L12-L14", "x.java")).text,
    );
    try testing.expectEqualSlices(
        u16,
        (try planFor(alloc, example, "toString", "x.java")).text,
        (try planFor(alloc, example, "L12-L14", "x.java")).text,
    );
    try testing.expectEqualSlices(
        u16,
        (try planFor(alloc, example, "toString/-", "x.java")).text,
        (try planFor(alloc, example, "L13", "x.java")).text,
    );
    try expectPlanText(
        alloc,
        "package example;\n\nimport java.util.ArrayList;",
        try planFor(alloc, example, "L1-L3", "x.java"),
    );

    // A column is an offset within its line, counted from 1, and the range runs
    // to the end of its last line when that end names no column. Columns are
    // inclusive at both ends, so `L13:9-L13:14` is exactly `return`.
    try expectPlanText(alloc, "java.util.List", try planFor(alloc, example, "L4:8-L4:21", "x.java"));
    try expectPlanText(
        alloc,
        "return String.join(\",\", items);",
        try planFor(alloc, example, "L13:9", "x.java"),
    );
    try expectPlanText(alloc, "return", try planFor(alloc, example, "L13:9-L13:14", "x.java"));
    try expectPlanText(alloc, "package", try planFor(alloc, example, "L1:1-L1:7", "x.java"));

    // The plan says where the text came from, which is what a host navigates to.
    {
        const plan = try planFor(alloc, example, "L12-L14", "x.java");
        try testing.expectEqual(PlanKind.lines, plan.kind);
        try testing.expectEqual(@as(usize, 12), plan.start_line);
        try testing.expectEqual(@as(usize, 14), plan.end_line);
        try testing.expectEqual(@as(usize, 1), plan.ranges.len);
        try testing.expectEqual(@as(usize, 12), plan.ranges[0].from);
        try testing.expectEqual(@as(usize, 14), plan.ranges[0].to);
    }

    // Anything the file does not have is an error, never a clamp.
    try expectUnits(
        alloc,
        "\"#L31\": the file has 30 line(s)",
        try planFailure(alloc, example, "L31", "x.java"),
    );
    try expectUnits(
        alloc,
        "\"#L29-L31\": the file has 30 line(s)",
        try planFailure(alloc, example, "L29-L31", "x.java"),
    );
    try expectUnits(
        alloc,
        "\"#L13:100\": line 13 has 39 character(s)",
        try planFailure(alloc, example, "L13:100", "x.java"),
    );
    try expectUnits(
        alloc,
        "\"#L2:1\": line 2 has 0 character(s)",
        try planFailure(alloc, example, "L2:1", "x.java"),
    );
}

test "several selectors inject in order, each from its own lines" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const example_text = vectors.sourceOf("test/fixtures/Example.java") orelse return error.MissingFixture;
    const example = try js.utf8Decode(alloc, example_text);

    const method = (try planFor(alloc, example, "toString", "x.java")).text;
    const package_lines = (try planFor(alloc, example, "L1-L3", "x.java")).text;

    {
        const plan = try planFor(alloc, example, "toString,L1-L3", "x.java");
        try testing.expectEqual(PlanKind.multiple, plan.kind);
        try testing.expectEqualSlices(u16, method, plan.text[0..method.len]);
        try testing.expectEqual(@as(usize, 2), plan.ranges.len);
        try testing.expectEqual(@as(usize, 12), plan.ranges[0].from);
        try testing.expectEqual(@as(usize, 14), plan.ranges[0].to);
        try testing.expectEqual(@as(usize, 1), plan.ranges[1].from);
        try testing.expectEqual(@as(usize, 3), plan.ranges[1].to);
        try testing.expectEqual(@as(usize, 1), plan.start_line);
        try testing.expectEqual(@as(usize, 14), plan.end_line);
    }

    // The pieces are independent: two of them may overlap or sit in any order.
    {
        const plan = try planFor(alloc, example, "L1-L3,L12-L14", "x.java");
        try testing.expectEqualSlices(
            u16,
            try js.concat(alloc, &.{ package_lines, try js.utf8Decode(alloc, "\n"), method }),
            plan.text,
        );
    }

    // A broken piece is an error, and names the piece that broke.
    try expectUnits(
        alloc,
        "no \"#region missing\" found, and no section named \"missing\"",
        try planFailure(alloc, example, "toString,missing", "x.java"),
    );

    // A modifier belongs to the selector whose path carries it, and to no other.
    const line_body = (try planFor(alloc, example, "Line/-", "x.java")).text;
    const line_plain = (try planFor(alloc, example, "Line", "x.java")).text;
    const line_annotated = (try planFor(alloc, example, "Line/+", "x.java")).text;
    const to_string_annotated = (try planFor(alloc, example, "toString/+", "x.java")).text;

    try testing.expectEqualSlices(
        u16,
        try js.concat(alloc, &.{ to_string_annotated, try js.utf8Decode(alloc, "\n"), line_plain }),
        (try planFor(alloc, example, "toString/+,Line", "x.java")).text,
    );
    try testing.expectEqualSlices(
        u16,
        try js.concat(alloc, &.{ method, try js.utf8Decode(alloc, "\n"), line_body }),
        (try planFor(alloc, example, "toString,Line/-", "x.java")).text,
    );
    try testing.expectEqualSlices(
        u16,
        try js.concat(alloc, &.{ method, try js.utf8Decode(alloc, "\n"), line_annotated }),
        (try planFor(alloc, example, "toString,Line/+", "x.java")).text,
    );

    // The scope of a mixed reference is only meaningful per selector.
    {
        const plan = try planFor(alloc, example, "toString/+,Line", "x.java");
        try testing.expectEqual(Scope.declaration, plan.reference.scope);
        try testing.expectEqual(@as(usize, 0), plan.reference.segments.len);
    }
}

test "every selection reports the lines it came from, regions included" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // The span is not an extra search for the text: it is the slice the text was
    // made from, so a region reports the lines *between* its directives — the
    // directive lines are not part of the selection — and a line range reports
    // exactly what was asked for.
    const source = try js.utf8Decode(alloc, "line1\n// #region r\naaa\nbbb\n// #endregion\nline6");

    const region = try planFor(alloc, source, "r", "x.java");
    try expectPlanText(alloc, "aaa\nbbb", region);
    try testing.expectEqual(PlanKind.region, region.kind);
    try testing.expectEqual(@as(usize, 1), region.ranges.len);
    try testing.expectEqual(@as(usize, 3), region.ranges[0].from);
    try testing.expectEqual(@as(usize, 4), region.ranges[0].to);
    try testing.expectEqual(@as(usize, 3), region.start_line);
    try testing.expectEqual(@as(usize, 4), region.end_line);

    {
        const plan = try planFor(alloc, source, "L3-L4", "x.java");
        try testing.expectEqual(@as(usize, 1), plan.ranges.len);
        try testing.expectEqual(@as(usize, 3), plan.ranges[0].from);
        try testing.expectEqual(@as(usize, 4), plan.ranges[0].to);
    }
    {
        const plan = try planFor(alloc, source, "L2-L3", "x.java");
        try testing.expectEqual(@as(usize, 1), plan.ranges.len);
        try testing.expectEqual(@as(usize, 2), plan.ranges[0].from);
        try testing.expectEqual(@as(usize, 3), plan.ranges[0].to);
    }
}

test "every block records the scope that declared it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // The file's root is the scope of a top-level block, and every other block names the scope that declared
    // it — the block itself, its name, and the line it is declared on. Those four facts are what the
    // JavaScript, Java and Rust ports record, and this port records them at the same four places: the root's
    // children, a `descend`, an enum's constants, and a declared variable (2026-10-14).
    //
    // No rule reads them today (the walker carries the scope as it descends), so this test is what keeps them
    // from silently becoming null when one of those four places is touched again.
    const source = try js.utf8Decode(
        alloc,
        "class Runner {\n    void run(String title) {\n        int count;\n    }\n    enum Suit { HEARTS }\n}\n",
    );
    const scan = try scanBlocks(alloc, source, null);

    const class_block = scan.root.children.items[0];
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "Runner"), class_block.name.?);
    // A top-level block belongs to the root, which has no name or line of its own.
    try testing.expect(class_block.parent == scan.root);
    try testing.expect(class_block.scope == scan.root);
    try testing.expect(class_block.scope_name == null);
    try testing.expect(class_block.scope_line == null);

    const method = class_block.children.items[0];
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "run"), method.name.?);
    try testing.expect(method.parent == class_block);
    try testing.expect(method.scope == class_block);
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "Runner"), method.scope_name.?);
    try testing.expectEqual(@as(usize, 0), method.scope_line.?);

    // A parameter is registered by `declareVariable`, a local by the scope scan: both name the method.
    const parameter = method.children.items[0];
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "title"), parameter.name.?);
    const local = method.children.items[1];
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "count"), local.name.?);
    for ([_]*Block{ parameter, local }) |member| {
        try testing.expect(member.parent == method);
        try testing.expect(member.scope == method);
        try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "run"), member.scope_name.?);
        try testing.expectEqual(@as(usize, 1), member.scope_line.?);
    }

    const suit = class_block.children.items[1];
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "Suit"), suit.name.?);
    const constant = suit.children.items[0];
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "HEARTS"), constant.name.?);
    try testing.expect(constant.parent == suit);
    try testing.expect(constant.scope == suit);
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "Suit"), constant.scope_name.?);
    try testing.expectEqual(@as(usize, 4), constant.scope_line.?);
}

test "extractDeclaration reads a property and an enum constant" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // A property — a field, and an enum's constant — is a selection with no body of its own: the statement *is*
    // what is injected. Extraction used to skip every one of them, so the two entry points disagreed on exactly
    // the declarations this rule names (2026-10-13).
    const field = try js.utf8Decode(alloc, "public class A {\n    private final String plain = \"x\";\n}\n");
    var failure = Failure{};
    const plain = (try extractDeclaration(alloc, field, try js.utf8Decode(alloc, "plain"), .declaration, &failure)) orelse
        return error.TestUnexpectedResult;
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "    private final String plain = \"x\";"), plain);
    const planned = try planSection(alloc, field, try js.utf8Decode(alloc, "plain"), null, &failure);
    try expectPlanText(alloc, "    private final String plain = \"x\";", planned);

    const enums = try js.utf8Decode(alloc, "public enum E {\n    CALL,\n    /** the paid tier */\n    @Deprecated\n    PAID(1);\n}\n");
    const call = (try extractDeclaration(alloc, enums, try js.utf8Decode(alloc, "CALL"), .declaration, &failure)) orelse
        return error.TestUnexpectedResult;
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "    CALL,"), call);

    const annotated = (try extractDeclaration(alloc, enums, try js.utf8Decode(alloc, "PAID"), .annotated, &failure)) orelse
        return error.TestUnexpectedResult;
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, "    @Deprecated\n    PAID(1);"), annotated);

    // A bare constant has no body to select, so its `-` is empty rather than missing.
    const body = (try extractDeclaration(alloc, enums, try js.utf8Decode(alloc, "CALL"), .body, &failure)) orelse
        return error.TestUnexpectedResult;
    try testing.expectEqualSlices(u16, try js.utf8Decode(alloc, ""), body);
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
            // A parse-only probe: the grammar. The reference grammar is
            // `parseSelectors` — one path selector, several, or a line range;
            // `parseReference` reads one path only. A case that is *about* that
            // difference names the parser it exercises in its own name.
            const read_one_path = std.mem.startsWith(u8, case.name, "path-parse:");
            const parsed = if (read_one_path)
                parseReference(alloc, reference, &failure)
            else
                parseSelectors(alloc, reference, &failure);
            if (parsed) |_| {
                // The answer is the canonical spelling, and the corpus asserts the
                // message on the error branch; a row that *expects* an error and
                // parsed instead is a divergence, and saying so is the whole point
                // of asserting the corpus row by row.
                //
                // This branch was silent while envelopes were unported, because
                // the six envelope rows that must parse were the only ones it
                // caught. They are ported now, so the assertion is restored: a
                // future regression that makes a malformed reference parse fails
                // here instead of passing quietly.
                if (case.error_message != null) {
                    std.debug.print("{s}: parsed, but the corpus expects an error\n", .{case.name});
                    return error.UnexpectedGrammarSuccess;
                }
            } else |_| {
                const expected = case.error_message orelse {
                    std.debug.print("{s}: unexpected grammar error: {any}\n", .{ case.name, failure.message });
                    return error.UnexpectedGrammarError;
                };
                try expectUnits(alloc, expected, failure.message);
                // The band, beside the message: a host branches on the code, so a
                // port that gets the right message out of the wrong category fails
                // here rather than passing on the prose.
                try expectCode(alloc, case, failure);
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

            // The span, the pieces and the kind are part of the answer, not
            // decoration: a host navigates to the spans and explains itself with
            // the kind, so the corpus pins them beside the bytes. `ranges` is
            // one entry per selector — the whole point of a reference that names
            // several pieces — and a host that only wants the outer bounds reads
            // `start_line`/`end_line`.
            if (case.start_line) |want| {
                if (plan.start_line != @as(usize, @intCast(want))) {
                    std.debug.print("{s}: start_line {d}, want {d}\n", .{ case.name, plan.start_line, want });
                    return error.SpanMismatch;
                }
            }
            if (case.end_line) |want| {
                if (plan.end_line != @as(usize, @intCast(want))) {
                    std.debug.print("{s}: end_line {d}, want {d}\n", .{ case.name, plan.end_line, want });
                    return error.SpanMismatch;
                }
            }
            if (plan.ranges.len != case.ranges.len) {
                std.debug.print("{s}: {d} range(s), want {d}\n", .{
                    case.name, plan.ranges.len, case.ranges.len,
                });
                return error.RangesMismatch;
            }
            for (plan.ranges, case.ranges) |actual, want| {
                if (actual.from != @as(usize, @intCast(want.from)) or actual.to != @as(usize, @intCast(want.to))) {
                    std.debug.print("{s}: range {d}-{d}, want {d}-{d}\n", .{
                        case.name, actual.from, actual.to, want.from, want.to,
                    });
                    return error.RangesMismatch;
                }
            }
            if (case.kind) |expected_kind| {
                const actual_kind: []const u8 = @tagName(plan.kind);
                if (!std.mem.eql(u8, actual_kind, @tagName(expected_kind))) {
                    std.debug.print("{s}: kind {s}, want {s}\n", .{
                        case.name, actual_kind, @tagName(expected_kind),
                    });
                    return error.KindMismatch;
                }
            }
        } else |err| {
            if (err != error.Failed) return err;
            const expected = case.error_message orelse {
                std.debug.print("{s}: unexpected failure: {any}\n", .{ case.name, failure.message });
                return error.UnexpectedFailure;
            };
            if (std.mem.startsWith(u8, case.name, "envelope") or std.mem.startsWith(u8, case.name, "grammar:Cart") or std.mem.startsWith(u8, case.name, "grammar-error:envelope") or std.mem.startsWith(u8, case.name, "region-as") or std.mem.startsWith(u8, case.name, "grammar:a/b")) {}
            if (!js.eqlBytes(failure.message, expected)) {
                std.debug.print("{s}: error differs\nexpected: {s}\nactual:   {any}\n", .{
                    case.name,
                    expected,
                    failure.message,
                });
                return error.ErrorMismatch;
            }
            try expectCode(alloc, case, failure);
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
