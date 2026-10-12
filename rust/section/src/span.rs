//! Body spans: where a declaration's body opens, closes, or ends.
//!
//! This is the part the modifiers hinge on — `-` asks for "the body alone", so the span decides what
//! that means: a brace pair, an indented run, an arrow expression, or a keyword-delimited block
//! (Ruby's `end`, VB's `End`). It reads the **mask**, so a brace inside a string or comment cannot end a
//! body, and it works in **UTF-16 code units** throughout, as the JavaScript does.
//!
//! A member with no body to inject — an interface method, an `abstract` one — yields `None` rather than
//! half a method.
//!
//! This is a port of `headerEnd`/`bodySpan`/`expressionBody`/`braceBody` in `lib/section.mjs`, and it
//! mirrors them rather than inventing: the header is followed across lines from the declaration's own
//! name, and the first `{`, `;` or `=>` met with every bracket closed is what ended it.

use crate::mask::{end_of_line, index_of, line_of, matching_bracket};

/// How far a declaration's header may run past the line it starts on. A header that is not closed
/// within this many lines is not followed, rather than scanned to the end of the file.
pub const HEADER_LINES: usize = 200;

/// A declaration's header: the mask from the declaration's line through the `{` or `;` that ends the
/// header, **including** that terminator. `last` is the line the window ends on, which is the line a
/// wrapped parameter list, generic list or `throws` clause pushes the terminator down to.
///
/// The window is never clamped to the start of the declaration's own line: an `impl Cart {` header
/// ends at the `{`, after the offset the declaration starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub end: usize,
    pub last: usize,
}

/// A body span. Every offset is a UTF-16 code-unit offset into the masked text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Span {
    /// The `{` and the matching `}`.
    pub open: Option<usize>,
    pub close: Option<usize>,
    pub open_line: Option<usize>,
    pub close_line: Option<usize>,
    /// The last line of an indented body, which has no braces.
    pub body_end_line: Option<usize>,
    /// The line an indented body starts on, when it is not the line after the declaration (a wrapped
    /// header's own lines are the declaration's, not the body's).
    pub body_from: Option<usize>,
    /// The offset an arrow or `=` expression body starts at.
    pub expression: Option<usize>,
    /// The last line an expression body runs to — the line the expression starts on, or the last
    /// indented line of the `do`/`where` block under it.
    pub expression_end_line: Option<usize>,
    pub indented: bool,
}

impl Span {
    /// The last line the declaration covers, for a caller walking the tree. The JavaScript's
    /// `endLineOf` reads `closeLine` then `bodyEndLine`; an expression span contributes neither, so
    /// the declaration's own line is what a walker gets.
    pub fn end_line(&self, decl_line: usize) -> usize {
        self.close_line.or(self.body_end_line).unwrap_or(decl_line)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Terminator {
    Brace,
    Statement,
    Arrow,
}

/// Where a declaration's header ends, starting at `from` on `line`.
///
/// Wrapping a parameter list is formatting, not a different declaration, so a header may span lines —
/// but only while it could still be a header. It ends at the first `{` or `;` met with every bracket
/// closed, and stops at the blank line or the line that cannot continue it. Counting every bracket —
/// `(`, `[`, `{`, `<` — is what makes a wrapped parameter list, a wrapped generic list and a wrapped
/// `throws` one rule.
pub fn header_end(mask_lines: &[Vec<u16>], starts: &[usize], line: usize, from: usize) -> Header {
    let stop = mask_lines
        .len()
        .saturating_sub(1)
        .min(line + HEADER_LINES - 1);
    // Everything before where the header starts is already the declaration's name; its brackets are
    // not the header's, so the count begins after them.
    let mut depth = 0i32;
    let mut start = from;
    let mut i = line;
    while i <= stop {
        let text = &mask_lines[i];
        if i > line && trim_units(text).is_empty() {
            break;
        }
        let line_start = starts.get(i).copied().unwrap_or(start);
        if depth == 0 {
            depth = bracket_depth(text, 0, start.saturating_sub(line_start));
        }
        let mut column = start.saturating_sub(line_start);
        while column < text.len() {
            let unit = text[column];
            // A `{` or `;` with every bracket closed ends the header, and is part of it: the body
            // starts after it.
            if depth == 0 && (unit == b'{' as u16 || unit == b';' as u16) {
                return Header {
                    end: line_start + column + 1,
                    last: i,
                };
            }
            let previous = if column > 0 { text[column - 1] } else { 0 };
            if unit == b'(' as u16
                || unit == b'[' as u16
                || unit == b'{' as u16
                || unit == b'<' as u16
            {
                depth += 1;
            } else if unit == b')' as u16 || unit == b']' as u16 || unit == b'}' as u16 {
                depth -= 1;
            } else if unit == b'>' as u16 {
                // An arrow's `>` is not a closing angle bracket: `=>` and `->` are punctuation, and
                // counting one as a bracket ends a header that was still open. The JavaScript reads
                // the character before it, which is `undefined` in the first column.
                if column == 0 || (previous != b'=' as u16 && previous != b'-' as u16) {
                    depth -= 1;
                }
            }
            column += 1;
        }
        // A closer with nothing open is not an error and does not end the header. A `<` that a
        // generic list should have balanced may have been a less-than
        // (`class Wrapped<\n        T extends Comparable<T>,`), and the first `>` then reads as one
        // closer too many; ending the header there would leave the whole declaration bodyless. The
        // count is therefore taken from the top of the next line, so a line never ends in debt.
        depth = depth.max(0);
        start = line_start + text.len();
        // A header continues while a bracket is open, while the line ends on a separator, and onto a
        // `{` alone on the next line — the Allman brace, which no other rule reaches.
        //
        // A *name* may end a header line that is still mid-declaration, which no separator reveals: a
        // wrapped class header writes its supertype on a line of its own
        // (`implements Renderer<T>`), and the `{` follows on the next one. Only the heads that can
        // open such a tail are followed — a `throws`, or an `extends`/`implements` clause with an
        // identifier still after the keyword — so a bodyless member that happens to end on a word
        // (`abstract String label(\n  int width)`) keeps its indented body.
        let continues = depth > 0
            || line_ends_on_separator(text)
            || ends_on_a_word(text)
                && (mentions_throws(text) || mentions_extends_or_implements(text))
            || next_non_blank_units(mask_lines, i + 1)
                .is_some_and(|next| reads_as_alone_brace(&mask_lines[next]));
        if !continues {
            return Header {
                end: start,
                last: i,
            };
        }
        i += 1;
    }
    let i = i.min(mask_lines.len().saturating_sub(1));
    let line_start = starts.get(i).copied().unwrap_or(0);
    Header {
        end: line_start + mask_lines.get(i).map_or(0, Vec::len),
        last: i,
    }
}

/// How much `text` opens across every bracket a header can hold, from `from` to `to`.
fn bracket_depth(text: &[u16], from: usize, to: usize) -> i32 {
    let mut depth = 0i32;
    for unit in text.iter().take(to.min(text.len())).skip(from) {
        if *unit == b'(' as u16
            || *unit == b'[' as u16
            || *unit == b'{' as u16
            || *unit == b'<' as u16
        {
            depth += 1;
        } else if *unit == b')' as u16
            || *unit == b']' as u16
            || *unit == b'}' as u16
            || *unit == b'>' as u16
        {
            depth -= 1;
        }
    }
    depth
}
/// Whether a line ends on `(`, `,` or `;` — the JavaScript's `/[(,;]\s*$/`.
fn line_ends_on_separator(text: &[u16]) -> bool {
    let mut at = text.len();
    while at > 0 && is_blank_unit(text[at - 1]) {
        at -= 1;
    }
    at > 0
        && matches!(
            text[at - 1],
            unit if unit == b'(' as u16 || unit == b',' as u16 || unit == b';' as u16
        )
}

/// Whether a line is a `{` alone — the JavaScript's `/^\s*\{\s*$/`, the Allman brace.
fn reads_as_alone_brace(text: &[u16]) -> bool {
    let trimmed = trim_units(text);
    trimmed.len() == 1 && trimmed[0] == b'{' as u16
}

/// Whether a line ends on a name — the JavaScript's `/\w[\w$]*[>)\]}\s]*$/`.
///
/// The trailing closers may be there: a wrapped supertype ends on `Renderer<T>`, and the `>` is not
/// what decides that the declaration is unfinished.
fn ends_on_a_word(text: &[u16]) -> bool {
    let mut at = text.len();
    while at > 0 && (is_blank_unit(text[at - 1]) || closes_a_trailing_name(text[at - 1])) {
        at -= 1;
    }
    at > 0 && is_name_unit(text[at - 1])
}

/// A unit the JavaScript's `[>)\]}\s]` accepts after a name.
fn closes_a_trailing_name(unit: u16) -> bool {
    matches!(
        unit as u8 as char,
        '>' | ')' | ']' | '}'
    ) || is_blank_unit(unit)
}

/// Whether the masked line carries `throws` followed by a name — the JavaScript's `/\bthrows\s+\w/`.
fn mentions_throws(text: &[u16]) -> bool {
    contains_word_then_name(text, b"throws")
}

/// Whether the masked line carries an `extends`/`implements` clause with a name after the keyword —
/// the JavaScript's `/\b(?:extends|implements)\s+[\w$][\w$.,<>?\[\]\s]*\w/`.
fn mentions_extends_or_implements(text: &[u16]) -> bool {
    contains_word_then_name(text, b"extends") || contains_word_then_name(text, b"implements")
}

/// `word`, whitespace, then a name at the end of the line's non-blank text.
fn contains_word_then_name(text: &[u16], word: &[u8]) -> bool {
    let end = text.len();
    let mut at = 0;
    while at + word.len() <= end {
        let hit = word
            .iter()
            .enumerate()
            .all(|(offset, byte)| text[at + offset] == *byte as u16);
        let boundary_before = at == 0 || !is_name_unit(text[at - 1]);
        if hit && boundary_before && at + word.len() < end {
            // `\s+` between the keyword and the name.
            let after_word = at + word.len();
            let mut named = after_word;
            while named < end && is_blank_unit(text[named]) {
                named += 1;
            }
            if named > after_word && named < end && is_name_unit(text[named]) {
                let tail = trim_units(&text[named..end]);
                // The clause must *end* on a name, which the JavaScript tests over the raw tail with
                // `\w` last: `Renderer<T>` ends on a generic list and still does, while `Renderer<`
                // does not.
                let ends_on_name = ends_on_a_word(tail);
                // Only a name, a dotted or generic type, and separators may sit between the two, so a
                // Only a name, a dotted or generic type, and separators may sit between the two, so a
                // word that merely occurs inside a longer expression does not read as a clause.
                let only_a_type = tail
                    .iter()
                    .all(|unit| is_name_unit(*unit) || is_type_punctuation(*unit) || is_blank_unit(*unit));
                if ends_on_name && only_a_type {
                    return true;
                }
            }
        }
        at += 1;
    }
    false
}

fn is_name_unit(unit: u16) -> bool {
    unit == b'_' as u16 || unit == b'$' as u16 || (unit as u8 as char).is_ascii_alphanumeric()
}

/// The punctuation a supertype clause may carry — the JavaScript's `[\w$.,<>?\[\]\s]`.
fn is_type_punctuation(unit: u16) -> bool {
    matches!(
        unit as u8 as char,
        '.' | ',' | '<' | '>' | '?' | '[' | ']'
    )
}

/// A body span, or `None` when the member has no body to inject (an interface or `abstract` method).
///
/// `from` is where the declaration's header starts in the mask — after its name, for the matchers that
/// stop there — and the header is followed to its `{` or `;` wherever that is, starting the bracket
/// count at `name_at`. `shape_at_body` says the caller is a language shape whose own offset is the
/// `=`, so the token is the body rather than an assignment.
pub fn body_span(
    mask: &[u16],
    mask_lines: &[Vec<u16>],
    starts: &[usize],
    decl_line: usize,
    from: usize,
    name_at: usize,
    shape_at_body: bool,
) -> Option<Span> {
    // A shape whose own `headerFrom` is the `=` itself (a Haskell binding, a Rust `const`) states its
    // expression body directly; the expression is what follows.
    if shape_at_body && mask.get(from) == Some(&(b'=' as u16)) {
        return Some(expression_body(mask_lines, starts, decl_line, from + 1));
    }

    let header = header_end(mask_lines, starts, decl_line, name_at);
    let rest = slice_units(mask, from, header.end);

    // The arrow that opens the body, read first: for `(n) => n + 1;` the `=>` is what declares the
    // member's body, and the `;` after it closes that body rather than declaring a body-less member.
    // A caller's `from` may also sit on the `=` or the `>` of the arrow itself.
    let arrow = index_of(rest, &units("=>"), 0);
    let arrow_at = match arrow {
        Some(at) => Some(from + at),
        None => {
            if mask.get(from) == Some(&(b'=' as u16)) || mask.get(from) == Some(&(b'>' as u16)) {
                Some(from)
            } else {
                None
            }
        }
    };
    let arrow_here = arrow_at.map(|at| at.saturating_sub(from));

    // The header's own scan ended on the `{` that opens the body (a shape like `impl Cart {`, or any
    // caller whose `from` sits just after it), so the body is cut from that column and never from a
    // later brace in the body.
    if arrow_here.is_none() && from > 0 && mask.get(from - 1) == Some(&(b'{' as u16)) {
        return brace_body(mask, starts, from - 1);
    }

    if let Some(arrow_here) = arrow_here {
        let at = from + arrow_here + 2;
        let brace = index_of(mask, &[b'{' as u16], at);
        let line_end = end_of_line(mask, at);
        return match brace {
            Some(brace) if brace <= line_end => brace_body(mask, starts, brace),
            _ => Some(expression_body(mask_lines, starts, decl_line, at)),
        };
    }

    let terminator = terminator_in(rest);

    // A `;` with every bracket closed is a member with no body to inject.
    if let Some((at, kind)) = terminator {
        if kind == Terminator::Statement {
            return None;
        }
        // `from` may already be the terminator's own column (a shape whose offset is the `{`) or a
        // character or two before it.
        let brace = index_of(mask, &[b'{' as u16], from);
        let at = brace.map_or(from + at, |brace| brace.max(from + at));
        return brace_body(mask, starts, at);
    }

    // The header itself ended on the `{` that opens the body (a shape like `impl Cart {`), so the
    // body is cut from that column.
    if header.end > 0 {
        if let Some(opened_at) = last_index_of(mask, b'{' as u16, header.end - 1) {
            if opened_at >= from {
                return brace_body(mask, starts, opened_at);
            }
        }
    }

    // An `=` opens an expression body, and is checked before the indentation rule: an indented line
    // after a `=` is part of the *expression*, not a body. `expression_at` wants a word character
    // before the `=`, which is how a Kotlin `): String = expr` spells one; an `=` that only a space
    // precedes is still the body's, because the caller has already decided this is a declaration. The
    // remainder may begin *at* the `=` (the header ended on it), so the expression starts one past
    // whichever `=` was found — the JavaScript's `+ 2`, which also skips the space it assumes follows.
    if let Some(equals) = expression_at(rest) {
        return Some(expression_body(
            mask_lines,
            starts,
            decl_line,
            from + equals + 2,
        ));
    }
    if let Some(bare) = index_of(rest, &[b'=' as u16], 0) {
        if rest.get(bare + 1) != Some(&(b'=' as u16)) {
            return Some(expression_body(
                mask_lines,
                starts,
                decl_line,
                from + bare + 2,
            ));
        }
    }

    // No terminator on the header's own lines. The body is then the next block: a `{` on a later line
    // (a wrapped `) throws X` line, an Allman brace) or the indented block the declaration's own
    // indentation governs.
    let next = next_non_blank_units(mask_lines, header.last + 1)?;
    let indent = mask_lines
        .get(decl_line)
        .map_or(0, |line| indent_width_units(line));

    // The next line, if it opens the body itself.
    let first = &mask_lines[next];
    if trim_units(first).starts_with(&[b'{' as u16]) {
        let brace = index_of(first, &[b'{' as u16], 0).unwrap_or(0);
        return brace_body(mask, starts, starts.get(next).copied().unwrap_or(0) + brace);
    }

    // A line that still belongs to the declaration — a `throws` clause, a return type — puts the `{`
    // after it. A wrapped header's body starts after the last of its lines, so the search begins
    // there.
    let search_from = next.max(header.last);
    let after = slice_units(
        mask,
        from,
        starts.get(search_from).copied().unwrap_or(0)
            + mask_lines.get(search_from).map_or(0, Vec::len),
    );
    if let Some((at, kind)) = terminator_in(after) {
        if kind == Terminator::Statement {
            return None;
        }
        if kind == Terminator::Brace {
            return brace_body(mask, starts, from + at);
        }
    }

    if indent_width_units(first) > indent {
        let mut last = next;
        for i in next + 1..mask_lines.len() {
            if trim_units(&mask_lines[i]).is_empty() {
                continue;
            }
            if indent_width_units(&mask_lines[i]) <= indent {
                break;
            }
            last = i;
        }
        // A wrapped header's own lines are not part of its body.
        return Some(Span {
            indented: true,
            body_end_line: Some(last),
            body_from: Some(next.max(header.last + 1)),
            ..Span::default()
        });
    }
    None
}

/// The offset of `unit` at or before `from`, or `None`: the JavaScript's `lastIndexOf`.
fn last_index_of(text: &[u16], unit: u16, from: usize) -> Option<usize> {
    let end = from.min(text.len().saturating_sub(1));
    (0..=end).rev().find(|at| text[*at] == unit)
}

/// Where a *property's* statement ends.
///
/// A field is a statement, and the statement is the selection — so the span has to be the whole of it
/// and not the line its name is written on. For a language that terminates its statements the `;`
/// decides, and it is the first one met with every bracket closed: a `{` with every bracket closed is
/// ordinarily the body and would end a declaration header, but inside a field's *expression* a `{`
/// opens one — the lambda of `Runnable arrow = () -> { … };`, an array or an anonymous-class
/// initialiser — so the scan tracks the brackets themselves and the `;` closes the statement wherever
/// the initialiser left it.
///
/// A language with no `;` (Kotlin, Go, C#, Python) needs the other half of the rule: the statement also
/// ends at the end of a line that closes every bracket it opened, when nothing about the next line
/// continues it — a line that ends on an operator, a comma or an opening bracket, or a next line
/// indented **deeper** than the declaration. A next line at the declaration's own indentation starts a
/// sibling instead, and reading on would take that sibling's text into the property.
///
/// `equals` is the offset of the `=` that opened the initialiser, or `None`.
pub fn statement_end(
    mask: &[u16],
    starts: &[usize],
    source_lines: &[Vec<u16>],
    source_starts: &[usize],
    from: usize,
    to: usize,
    equals: Option<usize>,
) -> (usize, usize, Option<usize>) {
    let decl_line = line_of(starts, from);
    let indent = indent_width_units(&source_lines[decl_line.min(source_lines.len().saturating_sub(1))]);
    // The first source line at or after `line` that has text on it, or `None`. The mask is the wrong
    // test: a line inside a multi-line string or a raw string is all spaces in the mask, and treating it
    // as a blank line would end a statement in the middle of its own literal.
    let next_text_line = |line: usize| -> Option<usize> {
        (line..source_lines.len()).find(|at| !trim_units(&source_lines[*at]).is_empty())
    };
    let mut depth = 0i32;
    let mut last = from;
    let mut content_end = from;
    let mut line = decl_line;
    while line < source_starts.len() && source_starts[line] < to {
        // Every level is read from the **source**, never the mask: the mask blanks a literal's
        // delimiters, so a line of it is shorter than the line of source it stands for.
        let line_start = source_starts[line].max(from);
        let text_line = &source_lines[line.min(source_lines.len() - 1)];
        let line_end = (line_start + text_line.len()).min(to);
        // The line's text without its trailing blanks, so its end is the offset just past the last real
        // character the line has — the mask cannot give one, because it blanks a literal's delimiters.
        let text = trim_end_units(text_line);
        let in_literal = line > decl_line
            && trim_units(&mask[line_start.min(mask.len())..line_end.min(mask.len())]).is_empty()
            && !text.is_empty();
        if line > decl_line && text.is_empty() {
            break;
        }
        if in_literal {
            // A line the mask blanked but the source did not is part of a string literal that spans
            // lines. It is not a statement boundary — neither its indentation nor its own braces mean
            // anything, since both are the literal's own text — so the statement simply reaches through
            // it, and the literal's closing line comes with it.
            last = last.max(line_end);
            content_end = line_start + text.len();
            line += 1;
            continue;
        }
        let mut stop = false;
        let mut at = line_start;
        while at < line_end && at < mask.len() {
            let unit = mask[at];
            if unit == b'(' as u16 || unit == b'[' as u16 || unit == b'{' as u16 {
                depth += 1;
            } else if unit == b')' as u16 || unit == b']' as u16 || unit == b'}' as u16 {
                if depth == 0 {
                    stop = true;
                    break;
                }
                depth -= 1;
            } else if unit == b';' as u16 && depth == 0 {
                return (at, line_of(starts, at), equals);
            }
            at += 1;
        }
        // The statement so far reaches the end of this line, `;` or not, and its text ends there —
        // before the newline, and before any trailing blank.
        last = last.max(line_end);
        if !text.is_empty() {
            content_end = line_start + text.len();
        }
        if stop {
            break;
        }
        if line > decl_line && depth == 0 {
            // Nothing continues this line: it closes what it opened and does not end on an operator or
            // an opening bracket. An `=` that ends a line is not punctuation here — the initialiser may
            // be an expression the next line carries, which the indentation decides.
            if !ends_on_an_operator(mask, line_start, line_end) {
                let Some(next) = next_text_line(line + 1) else { break };
                if indent_width_units(&source_lines[next]) <= indent {
                    break;
                }
            }
        }
        line += 1;
    }
    // The scan stopped on a line that ends the statement. Its declaration reaches the end of that line,
    // and its initialiser's own text stops at the last real character the statement has — never at the
    // newline, and never at the end of the file.
    let block_end = last.max(content_end);
    let initializer_end = if content_end == from { block_end } else { content_end };
    (initializer_end, line_of(starts, block_end), equals)
}

/// A line without its trailing blanks — the unit slice the JavaScript's `trimEnd` returns.
fn trim_end_units(line: &[u16]) -> &[u16] {
    let mut end = line.len();
    while end > 0 && is_blank_unit(line[end - 1]) {
        end -= 1;
    }
    &line[..end]
}

/// Whether a line ends on an operator or an opening bracket — the JavaScript's
/// `/[,+\-*/%&|?<(\[{!~^]\s*$/`.
fn ends_on_an_operator(mask: &[u16], from: usize, to: usize) -> bool {
    let mut at = to.min(mask.len());
    while at > from && is_blank_unit(mask[at - 1]) {
        at -= 1;
    }
    if at == from {
        return false;
    }
    matches!(
        mask[at - 1] as u8 as char,
        ',' | '+' | '-' | '*' | '/' | '%' | '&' | '|' | '?' | '<' | '(' | '[' | '{' | '!' | '~' | '^'
    )
}

/// The first of `{`, `;` and `=>` in a header, in the order they appear — the thing that ended it.
fn terminator_in(rest: &[u16]) -> Option<(usize, Terminator)> {
    let mut found: Option<(usize, Terminator)> = None;
    for (at, kind) in [
        (index_of(rest, &[b'{' as u16], 0), Terminator::Brace),
        (index_of(rest, &[b';' as u16], 0), Terminator::Statement),
        (index_of(rest, &units("=>"), 0), Terminator::Arrow),
    ] {
        if let Some(at) = at {
            if found.is_none_or(|(best, _)| at < best) {
                found = Some((at, kind));
            }
        }
    }
    found
}

/// The offset of the `=` that opens an expression body, or `None`.
///
/// A `=` that stands for `==`, `<=`, `>=`, `!=` or `+=` is not a body — and neither is a type
/// annotation's (`name: Type =`), which is why the character right after the `=` must not be `=`, and
/// the last character before it must close something: a type, a bracket or a `>`.
fn expression_at(rest: &[u16]) -> Option<usize> {
    for at in 0..rest.len() {
        if rest[at] != b'=' as u16 {
            continue;
        }
        if rest.get(at + 1) == Some(&(b'=' as u16)) {
            continue;
        }
        if at > 0 && closes_something(rest[at - 1]) {
            return Some(at);
        }
    }
    None
}

/// Whether a unit can close a type, a bracket or a generic list: the JavaScript's `[\w$>)\]}]`.
fn closes_something(unit: u16) -> bool {
    (unit < 0x80 && (unit as u8).is_ascii_alphanumeric())
        || unit == b'_' as u16
        || unit == b'$' as u16
        || unit == b'>' as u16
        || unit == b')' as u16
        || unit == b']' as u16
        || unit == b'}' as u16
}

/// An expression body beginning at `at`: it runs to the end of its line, and on through the indented
/// lines that follow it — a `do` block, a `where` clause — which the declaration's own indentation
/// governs. A body that starts on the declaration's own line is the rest of that line; the lines below
/// belong to it only when it starts on a later one and they are indented under the declaration.
fn expression_body(mask_lines: &[Vec<u16>], starts: &[usize], decl_line: usize, at: usize) -> Span {
    let first = line_of(starts, at);
    let indent = mask_lines
        .get(decl_line)
        .map_or(0, |line| indent_width_units(line));
    let mut last = if first > decl_line { first } else { decl_line };
    if first > decl_line {
        for i in first + 1..mask_lines.len() {
            if trim_units(&mask_lines[i]).is_empty() {
                break;
            }
            if indent_width_units(&mask_lines[i]) <= indent {
                break;
            }
            last = i;
        }
    }
    Span {
        expression: Some(at),
        expression_end_line: Some(last),
        ..Span::default()
    }
}

/// The JavaScript's `masked.slice(from, to)`, forgiving of an out-of-range end.
fn slice_units(text: &[u16], from: usize, to: usize) -> &[u16] {
    let start = from.min(text.len());
    let end = to.min(text.len()).max(start);
    &text[start..end]
}

/// The UTF-16 units of a string.
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// A brace-delimited body, when the braces actually pair.
pub fn brace_body(mask: &[u16], starts: &[usize], open: usize) -> Option<Span> {
    let close = matching_bracket(mask, open, b'}' as u16)?;
    Some(Span {
        open: Some(open),
        close: Some(close),
        open_line: Some(line_of(starts, open)),
        close_line: Some(line_of(starts, close)),
        ..Span::default()
    })
}

/// A body closed by a terminator keyword line (`end` in Ruby, `End` in VB), found by indentation: the
/// first line at or left of the declaration's indentation whose trimmed text is the terminator. When no
/// terminator is found that way the declaration gets no block at all, rather than half a method.
pub fn keyword_body(lines: &[Vec<u16>], decl_line: usize, word: &str) -> Option<Span> {
    if decl_line >= lines.len() {
        return None;
    }
    let indent = indent_width_units(&lines[decl_line]);
    for i in decl_line + 1..lines.len() {
        let text = trim_units(&lines[i]);
        if text.is_empty() {
            continue;
        }
        if indent_width_units(&lines[i]) > indent {
            continue;
        }
        let word = units(word);
        if text == word.as_slice()
            || (text.starts_with(&word) && text.get(word.len()) == Some(&(b' ' as u16)))
        {
            return Some(Span {
                open_line: Some(decl_line),
                close_line: Some(i),
                ..Span::default()
            });
        }
        return None;
    }
    None
}

/// Whether a unit is blank for trimming. `\n` counts: the readers that ask "is there nothing but
/// whitespace before this comment" look at a slice that spans lines, and both Java's `trim()` and the
/// JavaScript's `.trim()` remove it — without this, a comment on the line after a brace is not an anchor.
pub(crate) fn is_blank_unit(unit: u16) -> bool {
    unit == b' ' as u16
        || unit == b'\t' as u16
        || unit == b'\n' as u16
        || unit == b'\r' as u16
        || unit == 0x0b
        || unit == 0x0c
}

/// How far a unit line is indented.
pub fn indent_width_units(line: &[u16]) -> usize {
    line.iter().take_while(|unit| is_blank_unit(**unit)).count()
}

pub(crate) fn trim_units(line: &[u16]) -> &[u16] {
    let start = line.iter().take_while(|unit| is_blank_unit(**unit)).count();
    let end = line
        .iter()
        .rev()
        .take_while(|unit| is_blank_unit(**unit))
        .count();
    &line[start..line.len().saturating_sub(end).max(start)]
}

pub(crate) fn next_non_blank_units(lines: &[Vec<u16>], from: usize) -> Option<usize> {
    (from..lines.len()).find(|at| !trim_units(&lines[*at]).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::{line_starts, units};

    fn scan(source: &str) -> (Vec<u16>, Vec<Vec<u16>>, Vec<usize>) {
        let mask = units(source);
        let lines = source.split('\n').map(units).collect();
        let starts = line_starts(&mask);
        (mask, lines, starts)
    }

    /// The offset just past a declaration's own name, which is where its header is followed from.
    fn after_name(source: &str, name: &str) -> usize {
        source.find(name).unwrap() + name.len()
    }

    #[test]
    fn a_brace_body_on_the_header_line() {
        let source = "void add() {\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "add");
        let span = body_span(&mask, &lines, &starts, 0, from, from, false).unwrap();
        assert_eq!(Some(0), span.open_line);
        assert_eq!(Some(2), span.close_line);
        assert_eq!(2, span.end_line(0));
        assert!(!span.indented);
    }

    #[test]
    fn a_wrapped_class_header_reaches_a_brace_on_a_later_line() {
        // A wrapped class header writes its supertype on a line of its own and its `{` on the next:
        // `implements Renderer<T>` ends on a name, so it is the tail rule and not a separator that
        // follows the header to its body. The generic list is unbalanced on the line the name is on
        // (`class Wrapped<`), which is what the debt rule keeps from ending the header there.
        let source = "public class Wrapped<\n        T extends Comparable<T>,\n        U extends CharSequence>\n        extends AbstractBase\n        implements Renderer<T>\n{\n    public T best(T left, T right) {\n        return left;\n    }\n}\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "Wrapped");
        let header = header_end(&lines, &starts, 0, from);
        assert_eq!(5, header.last, "the header reaches the brace line");
        let span = body_span(&mask, &lines, &starts, 0, header.end, from, false)
            .expect("the class has a body");
        assert_eq!(Some(5), span.open_line);
        assert_eq!(Some(9), span.close_line);
    }

    #[test]
    fn a_body_that_never_opens() {
        let source = "void add();\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "add");
        assert!(
            body_span(&mask, &lines, &starts, 0, from, from, false).is_none(),
            "a `;` is no body"
        );
    }

    #[test]
    fn an_arrow_expression() {
        let source = "const add = (a, b) => a + b;\n";
        let (mask, lines, starts) = scan(source);
        let arrow = source.find("=>").unwrap();
        let span = body_span(&mask, &lines, &starts, 0, arrow, arrow, false).unwrap();
        // Just past `=>`, the space included: the renderer trims, as the JavaScript's does.
        assert_eq!(Some(arrow + 2), span.expression);
        assert!(span.open.is_none());
    }

    #[test]
    fn an_arrow_after_a_rust_return_type_still_reaches_its_brace() {
        // The `>` of `->` is not a closing angle bracket: counting it ends the header at the arrow.
        let source =
            "    fn remove(&mut self) -> Option<String> {\n        self.items.pop()\n    }\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "remove");
        let span = body_span(&mask, &lines, &starts, 0, from, from, false).unwrap();
        assert_eq!(Some(0), span.open_line);
        assert_eq!(Some(2), span.close_line);
    }

    #[test]
    fn a_wrapped_parameter_list_is_one_header() {
        // The `)` and the `{` sit two lines below the name; only the header scan carries them.
        let source = "void add(\n        int a,\n        int b) {\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "add");
        let span = body_span(&mask, &lines, &starts, 0, from, from, false).unwrap();
        assert_eq!(Some(2), span.open_line, "the brace opens on line 3");
        assert_eq!(Some(4), span.close_line);
    }

    #[test]
    fn a_brace_on_the_next_line() {
        let source = "void add()\n{\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "add");
        let span = body_span(&mask, &lines, &starts, 0, from, from, false).unwrap();
        assert_eq!(Some(1), span.open_line, "the brace opens on line 2");
        assert_eq!(Some(3), span.close_line);
    }

    #[test]
    fn an_indented_body() {
        let source = "def add(a)\n    a + 1\nend\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "add");
        let span = body_span(&mask, &lines, &starts, 0, from, from, false).unwrap();
        assert!(span.indented);
        assert_eq!(Some(1), span.body_end_line);
        assert_eq!(Some(1), span.body_from, "the body starts after the header");
    }

    #[test]
    fn a_wrapped_headers_own_lines_are_not_its_body() {
        // The header's last line is line 3, so the indented body starts there — not on the line
        // after the declaration, which is still the header.
        let source = "void add(\n        int a,\n        int b)\n    work()\n";
        let (mask, lines, starts) = scan(source);
        let from = after_name(source, "add");
        let span = body_span(&mask, &lines, &starts, 0, from, from, false).unwrap();
        assert!(span.indented, "a body with no braces is an indented run");
        assert_eq!(Some(3), span.body_from);
        assert_eq!(Some(3), span.body_end_line);
    }

    #[test]
    fn an_expression_body_a_wrapped_header_pushed_down() {
        // The `=` only exists on the line the wrapped parameter list drove the `)` to, and the
        // expression's own end line — not a walker's `endLineOf` — carries it.
        let source = "    fun label(\n        upper: Boolean\n    ): String = if (upper) name.uppercase() else name\n";
        let (mask, lines, starts) = scan(source);
        let from = source.find("): String").unwrap() + 1;
        let span = body_span(&mask, &lines, &starts, 0, from, 0, false).unwrap();
        assert_eq!(
            Some(source.find("if (upper)").unwrap()),
            span.expression,
            "the expression starts after the `=`"
        );
        assert_eq!(Some(2), span.expression_end_line);
        assert_eq!(
            0,
            span.end_line(0),
            "endLineOf reads closeLine then bodyEndLine, so an expression contributes the \
             declaration's own line"
        );
    }

    #[test]
    fn a_keyword_delimited_body() {
        let source = "class Cart\n  def add(x)\n    @items << x\n  end\nend\n";
        let (_, lines, _) = scan(source);
        let span = keyword_body(&lines, 1, "end").unwrap();
        assert_eq!(Some(1), span.open_line);
        assert_eq!(
            Some(3),
            span.close_line,
            "the first `end` at or left of the indent"
        );

        assert!(
            keyword_body(&lines, 1, "stop").is_none(),
            "no terminator, no block"
        );
    }
}
