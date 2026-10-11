//! The block scanner: `scanBlocks`/`buildScope` — the layer that *composes* the matchers, the span
//! readers and the block tree into the structure the resolver walks.
//!
//! Everything structural lives here and nowhere else: which line opens a scope, what a scope's body is,
//! how a chain of `else if` becomes several statement blocks, and which scope a block belongs to. The
//! pieces it composes are all separately tested; this module is the order they are tried in, which is
//! the part the vectors actually judge.
//!
//! Offsets are UTF-16 code units, as everywhere in this port, and the masks keep the invariant, so a
//! brace in a string or a comment cannot end a body.

use std::rc::Rc;

use crate::block::{apply_span, leading_anchor, pair_regions, Anchor, Block, BlockRef, Scan};
use crate::lexer::Lexer;
use crate::mask::{from_units, index_of, line_of, line_starts, matching_bracket, units, Comment};
use crate::matchers::{
    assigned_shape, call_shape, declaration_keyword, is_not_a_name, is_not_a_type, is_prefix,
    property_decl, starts_with_statement_before, statement_keyword, take_identifier,
};
use crate::span::{body_span, is_blank_unit, keyword_body, Header, Span};
use crate::SectionError;

/// The lexical facts one scan needs, kept so the resolver does not have to re-read the file.
#[derive(Clone, Debug)]
pub struct Lex {
    pub source: String,
    /// The source split by line, for the few readers that take text rather than units.
    pub source_lines: Vec<String>,
    pub lines: Vec<Vec<u16>>,
    pub starts: Vec<usize>,
    pub mask: Vec<u16>,
    pub mask_lines: Vec<Vec<u16>>,
    pub comments: Vec<Comment>,
    /// Per line: whether the `+` scope would take the line above as an annotation.
    pub annotation_lines: Vec<bool>,
}

impl Lex {
    /// The source line holding `line`, or `""`.
    pub fn source_line(&self, line: usize) -> &str {
        self.source_lines
            .get(line)
            .map(String::as_str)
            .unwrap_or("")
    }
}

/// One clause of an if/else-if (or try/catch) chain.
struct Segment {
    header_line: usize,
    open: usize,
    close: usize,
    cond_offset: usize,
    shared_close: bool,
    open_line: usize,
    close_line: usize,
}

/// How far a declaration's header may run past the line it starts on.
///
/// Wrapping a parameter list is formatting, not a different declaration, so the header of a member
/// may span lines — but only until the `{` or `;` that ends it, and only while the text still looks
/// like a header: brackets may be open, a line may end on an operator, and an annotation may start
/// one. A header that is not closed within this many lines is not followed, rather than scanned to
/// the end of the file.
const HEADER_LINES: usize = 200;

/// A declaration read from a line: the shape the matchers found, its name, and the header window it
/// was read through (see [`header_window`]).
struct Declaration {
    kind: &'static str,
    name: String,
    header: Header,
}

/// The header of a declaration that starts on `line`: the mask from the line's first character
/// through the `{` or `;` that ends the header, **including** it.
///
/// A wrapped parameter list is formatting, so the header of a member may span lines — but only while
/// the text could still be a header. It ends at the first `{` or `;` met with every bracket closed,
/// and stops at the blank line or the code line that proves it ended without one (a body-less
/// interface method, a declaration the mask cut short). Counting every bracket — `(`, `[`, `{`, `<`
/// — is what makes a wrapped parameter list, a wrapped generic list and a wrapped `throws` clause one
/// rule; a `{` inside the header's own brackets (a lambda default, an array initialiser) is not the
/// body's brace, because a bracket is open.
fn header_window(lex: &Lex, line: usize) -> Header {
    let start = lex.starts.get(line).copied().unwrap_or(0);
    let Some(first_line) = lex.mask_lines.get(line) else {
        return Header {
            start,
            end: start,
            last: line,
        };
    };
    let last = lex
        .mask_lines
        .len()
        .saturating_sub(1)
        .min(line.saturating_add(HEADER_LINES - 1));

    let mut depth = 0i32;
    for i in line..=last {
        let text = &lex.mask_lines[i];
        let from = lex.starts.get(i).copied().unwrap_or(start);
        let continues = depth > 0 || line_continues(text);

        for (column, unit) in text.iter().enumerate() {
            let unit = *unit;
            if depth == 0 && (unit == b'{' as u16 || unit == b';' as u16) {
                return Header {
                    start,
                    end: from + column + 1,
                    last: i,
                };
            }
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
                // counting one as a bracket ends a header that was still open — a Rust
                // `fn remove(&mut self) -> Option<String> {` would end at the `>` and never reach
                // its `{`, dropping the body's closing brace.
                if !is_arrow_head(text, column) {
                    depth -= 1;
                }
            }
            if depth < 0 {
                return Header {
                    start,
                    end: from + column + 1,
                    last: i,
                };
            }
        }
        depth = depth.max(0);
        // A line that is blank, or that opened nothing the next line could continue, ends a header
        // that never found its brace — and the caller then finds no body to inject, which is the
        // honest answer for a body-less declaration.
        if !continues {
            return Header {
                start,
                end: from + text.len(),
                last: i,
            };
        }
    }
    Header {
        start,
        end: start + first_line.len(),
        last,
    }
}

/// Whether the `>` at `column` is the head of an arrow rather than a closing angle bracket. The
/// JavaScript reads the character before it (`text[column - 1]`, `undefined` in the first column);
/// only `=>` and `->` make it punctuation.
fn is_arrow_head(text: &[u16], column: usize) -> bool {
    column > 0 && (text[column - 1] == b'=' as u16 || text[column - 1] == b'-' as u16)
}

/// Whether a line ends on `(`, `,` or `;` — the JavaScript's `/[(,;]\s*$/`, so a wrapped parameter
/// list or a declaration whose body is on a following line continues past it.
fn line_continues(text: &[u16]) -> bool {
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

/// Whether a declaration on `masked_line` names `name`, and the header it was read through.
///
/// The declaration is read from its own line whenever that line says everything there is to say,
/// which is the only shape the matcher ever had to read. A header that wraps — a parameter list, a
/// generic list, a `throws` clause — is not readable that way, because the closing bracket sits on a
/// later line; for those, [`declaration_across`] reads the header window instead. The line's own
/// reading is what decides *whether* there is a declaration at all — a bare name that merely appears
/// inside a wrapped construct must not become one — and the window is only asked where it ends.
fn declaration_on(
    masked_line: &str,
    start: usize,
    name: &str,
    header: Header,
    lex: &Lex,
    line: usize,
) -> Option<Declaration> {
    if name.is_empty() || is_not_a_name(name) {
        return None;
    }

    if let Some(keyword) = declaration_keyword(masked_line) {
        if keyword.name == name {
            let header_from = start + keyword.header_from;
            return Some(Declaration {
                kind: "class",
                name: name.to_string(),
                header: Header {
                    start: header_from,
                    ..header
                },
            });
        }
    }

    if let Some(header_from) = call_shape(masked_line, name) {
        let header_from = start + header_from;
        return Some(Declaration {
            kind: "method",
            name: name.to_string(),
            header: Header {
                start: header_from,
                ..header
            },
        });
    }

    if header.last > line {
        // The header continues past this line, so the closing bracket a wrapped parameter list put
        // there is only visible to the whole-window reading.
        return declaration_across(&header, name, lex);
    }

    if let Some(header_from) = assigned_shape(masked_line, name) {
        let header_from = start + header_from;
        return Some(Declaration {
            kind: "method",
            name: name.to_string(),
            header: Header {
                start: header_from,
                ..header
            },
        });
    }

    None
}

/// The same matchers, run over the whole header window instead of one line.
///
/// The window exists because a wrapped parameter list closes its bracket on a later line, and the
/// matchers compare the text before a name to a return type / modifier list — so the name is looked
/// for where it is written, and the brackets are matched across the lines that hold them. `name(`
/// must still open the name, and the window still ends at the `{` or `;` that ends the header, so a
/// name appearing inside a wrapped argument list is not a declaration.
fn declaration_across(header: &Header, name: &str, lex: &Lex) -> Option<Declaration> {
    let text = window_units(lex, header);
    let needle = units(name);

    // The `name(` form, with the text before the name **on its own line** validated by the same
    // prefix rules the line-local matcher uses.
    let mut from = 0usize;
    while from <= text.len() {
        let Some(at) = index_of(&text[from..], &needle, 0) else {
            break;
        };
        let start = from + at;
        from = start + needle.len().max(1);
        if !window_boundary(&text, start) {
            continue;
        }
        let mut open = start + needle.len();
        while open < text.len() && is_blank_unit(text[open]) {
            open += 1;
        }
        if text.get(open) != Some(&(b'(' as u16)) {
            continue;
        }
        if !window_prefix(lex, header, start, true) {
            continue;
        }
        if matching_bracket(&text, open, b')' as u16).is_none() {
            continue;
        }
        return Some(Declaration {
            kind: "method",
            name: name.to_string(),
            header: *header,
        });
    }

    // The assigned form: `name = … =>` / `= function`.
    let mut from = 0usize;
    while from <= text.len() {
        let Some(at) = index_of(&text[from..], &needle, 0) else {
            break;
        };
        let start = from + at;
        from = start + needle.len().max(1);
        if !window_boundary(&text, start) {
            continue;
        }
        if text
            .get(start + needle.len())
            .is_some_and(|unit| is_word_unit(*unit))
        {
            continue;
        }
        if !window_prefix(lex, header, start, false) {
            continue;
        }
        let Some(after_head) = assigned_head(&text[start + needle.len()..]) else {
            continue;
        };
        let rest = &text[start + needle.len() + after_head..];
        if index_of(rest, &units("=>"), 0).is_some() || starts_with_word_units(rest, "function") {
            return Some(Declaration {
                kind: "method",
                name: name.to_string(),
                header: *header,
            });
        }
    }

    None
}

/// The window's text as units, clamped to the mask.
fn window_units<'a>(lex: &'a Lex, header: &Header) -> &'a [u16] {
    let start = header.start.min(lex.mask.len());
    let end = header.end.min(lex.mask.len()).max(start);
    &lex.mask[start..end]
}

/// Whether the unit before `at` may open a name — the JavaScript's `(^|[^\w$.])`.
fn window_boundary(text: &[u16], at: usize) -> bool {
    at == 0 || !(is_word_unit(text[at - 1]) || text[at - 1] == b'.' as u16)
}

/// Whether a unit is part of a name: the JavaScript's `\w` plus `$`.
fn is_word_unit(unit: u16) -> bool {
    (unit < 0x80 && (unit as u8).is_ascii_alphanumeric())
        || unit == b'_' as u16
        || unit == b'$' as u16
}

/// The prefix gate over the name's own line inside the window, or `false` when the text before the
/// name disqualifies it. `normalise_func` is the call form's `func (r T) name` rewrite.
fn window_prefix(lex: &Lex, header: &Header, column: usize, normalise_func: bool) -> bool {
    let line = line_of(&lex.starts, header.start + column);
    let line_start = lex.starts.get(line).copied().unwrap_or(0);
    let end = (header.start + column)
        .saturating_sub(line_start)
        .min(lex.mask_lines.get(line).map_or(0, Vec::len));
    let before = lex
        .mask_lines
        .get(line)
        .map(|units| from_units(&units[..end]))
        .unwrap_or_default();
    let prefix = if normalise_func {
        match allowed_prefix(&before) {
            Some(prefix) => prefix,
            None => return false,
        }
    } else {
        before.trim().to_string()
    };
    prefix.is_empty() || (is_prefix(&prefix) && !starts_with_statement_before(&prefix))
}

/// `(?:const\s+|let\s+|var\s+)?name\b(?:\s*:\s*[^=\n]+)?\s*=\s*(?:async\s+)?` from just past a name:
/// the offset just past the assignment head, or `None` when what follows is not one.
fn assigned_head(tail: &[u16]) -> Option<usize> {
    let mut at = 0usize;
    let mut probe = 0usize;
    while probe < tail.len() && is_blank_unit(tail[probe]) {
        probe += 1;
    }
    if tail.get(probe) == Some(&(b':' as u16)) {
        // A type annotation, up to the first `=`.
        let mut after = probe + 1;
        while after < tail.len() && is_blank_unit(tail[after]) {
            after += 1;
        }
        while after < tail.len() && tail[after] != b'=' as u16 {
            after += 1;
        }
        at = after;
    }
    while at < tail.len() && is_blank_unit(tail[at]) {
        at += 1;
    }
    if tail.get(at) != Some(&(b'=' as u16)) {
        return None;
    }
    at += 1;
    while at < tail.len() && is_blank_unit(tail[at]) {
        at += 1;
    }
    if starts_with_word_units(&tail[at..], "async") {
        at += "async".len();
        while at < tail.len() && is_blank_unit(tail[at]) {
            at += 1;
        }
    }
    Some(at)
}

/// Whether `text` opens with `word` followed by a non-word unit, as `\b` reads it.
fn starts_with_word_units(text: &[u16], word: &str) -> bool {
    let word = units(word);
    text.len() >= word.len()
        && text[..word.len()] == word[..]
        && text.get(word.len()).is_none_or(|unit| !is_word_unit(*unit))
}

/// Scan a source for blocks and the indexable things in each scope: the block tree plus region pairs,
/// condition literals and comment anchors, ready for resolution.
pub fn scan_blocks(text: &str, lexer: &dyn Lexer) -> Result<Scan, SectionError> {
    // The mask invariant is asserted inside `make_lex`, so a substituted engine fails loudly here.
    let source = text.replace("\r\n", "\n");
    let lex = make_lex(&source, lexer)?;

    let mut blocks: Vec<BlockRef> = Vec::new();
    let root = Block::root();
    let top = build_scope(
        &lex,
        lexer,
        0,
        lex.lines.len().saturating_sub(1),
        &mut blocks,
    );
    {
        let mut root_block = root.borrow_mut();
        root_block.children.extend(top.iter().cloned());
    }
    for child in &top {
        let mut child = child.borrow_mut();
        child.parent = Rc::downgrade(&root);
        child.scope = Rc::downgrade(&root);
    }

    // Regions are read from the **source** lines: a `#region` directive is itself a comment, so the
    // mask has already blanked it.
    let mut regions = pair_regions(&lex.lines);
    {
        let mut root_block = root.borrow_mut();
        for region in &mut regions {
            region.line = region.start_line;
            region.kind = "region".to_string();
            root_block.regions.push(region.clone());
        }
    }
    let anchors: Vec<Anchor> = blocks
        .iter()
        .filter_map(|block| block.borrow().anchor.clone())
        .collect();

    Ok(Scan {
        root,
        blocks,
        regions,
        anchors,
        lex,
    })
}

/// The lexical facts, with the mask invariant asserted for the supplied engine.
fn make_lex(source: &str, lexer: &dyn Lexer) -> Result<Lex, SectionError> {
    let source_lines: Vec<String> = source.split('\n').map(str::to_string).collect();
    let lines: Vec<Vec<u16>> = source_lines.iter().map(|line| units(line)).collect();
    let starts = line_starts(&units(source));
    let mask_string = lexer.mask(source)?;
    let mask = units(&mask_string);
    let source_units = units(source);

    let who = format!("lexer \"{}\"", lexer.name());
    if mask.len() != source_units.len() {
        return Err(SectionError::new(format!(
            "{who} mask must preserve length ({} != {})",
            mask.len(),
            source_units.len()
        )));
    }
    for (i, unit) in source_units.iter().enumerate() {
        if *unit == b'\n' as u16 && mask.get(i) != Some(&(b'\n' as u16)) {
            return Err(SectionError::new(format!(
                "{who} mask must preserve every newline offset (broken at {i})"
            )));
        }
    }

    let mask_lines: Vec<Vec<u16>> = from_units(&mask).split('\n').map(units).collect();
    let comments = lexer.comments(source);
    let annotation_lines = source_lines
        .iter()
        .map(|line| lexer.is_annotation_line(line))
        .collect();

    Ok(Lex {
        source: source.to_string(),
        source_lines,
        lines,
        starts,
        mask,
        mask_lines,
        comments,
        annotation_lines,
    })
}

/// Build the blocks directly inside one scope, in source order.
fn build_scope(
    lex: &Lex,
    lexer: &dyn Lexer,
    from_line: usize,
    to_line: usize,
    blocks: &mut Vec<BlockRef>,
) -> Vec<BlockRef> {
    let mut list: Vec<BlockRef> = Vec::new();
    let mut i = from_line;

    while i <= to_line && i < lex.mask_lines.len() {
        let masked_line = from_units(&lex.mask_lines[i]);
        if masked_line.trim().is_empty() {
            i += 1;
            continue;
        }
        let start = lex.starts.get(i).copied().unwrap_or(0);

        // The language's own declaration shapes first: they are more specific than the generic ones.
        let declared_here: Vec<crate::lexer::Declared> = lexer
            .declarations(&masked_line)
            .into_iter()
            .filter(|entry| !entry.name.is_empty() && !is_not_a_name(&entry.name))
            .collect();
        if !declared_here.is_empty() {
            let mut last_end = i;
            for entry in declared_here {
                // A shape may close its body with a keyword line (`end` in Ruby, `End` in VB) rather
                // than a brace, in which case the header is the declaration line itself; otherwise
                // the header is the shape's own `headerFrom` through the end of its line.
                let span = if entry.body.as_deref() == Some("end") {
                    keyword_body(&lex.lines, i, entry.end.as_deref().unwrap_or("end"))
                } else {
                    body_span(
                        &lex.mask,
                        &lex.mask_lines,
                        &lex.starts,
                        i,
                        Header {
                            start: start + entry.header_from,
                            end: start + lex.mask_lines[i].len(),
                            last: i,
                        },
                    )
                };
                let kind = if entry.kind.is_empty() {
                    "method"
                } else {
                    entry.kind.as_str()
                };
                let block = Block::new(kind, Some(&entry.name), i);
                match &span {
                    Some(span) => apply_span(&block, span),
                    None if entry.line => {
                        let mut block_ref = block.borrow_mut();
                        block_ref.end_line = Some(i);
                        block_ref.single_line = true;
                    }
                    None => continue,
                }
                apply_anchor(&block, lex, span.as_ref().and_then(|span| span.open));
                register(&mut list, block.clone(), blocks);
                descend(&block, i, span.as_ref(), lex, lexer, blocks);
                last_end = last_end.max(end_line_of(span.as_ref(), i));
            }
            i = last_end + 1;
            continue;
        }

        if let Some(keyword) = declaration_keyword(&masked_line) {
            if !is_not_a_name(&keyword.name) {
                let header_from = start + keyword.header_from;
                let window = header_window(lex, i);
                let span = body_span(
                    &lex.mask,
                    &lex.mask_lines,
                    &lex.starts,
                    i,
                    Header {
                        start: header_from,
                        end: window.end,
                        last: window.last,
                    },
                );
                let block = Block::new("class", Some(&keyword.name), i);
                if let Some(span) = &span {
                    apply_span(&block, span);
                }
                apply_anchor(&block, lex, span.as_ref().and_then(|span| span.open));
                register(&mut list, block.clone(), blocks);
                descend(&block, i, span.as_ref(), lex, lexer, blocks);
                i = end_line_of(span.as_ref(), i) + 1;
                continue;
            }
        }

        let window = header_window(lex, i);
        if let Some((declaration, has_prefix)) =
            method_declaration(&masked_line, start, window, lex, i)
        {
            let span = body_span(
                &lex.mask,
                &lex.mask_lines,
                &lex.starts,
                i,
                declaration.header,
            );
            if span.is_none() && !has_prefix {
                i += 1; // a bare `foo();` call, not a declaration
                continue;
            }
            let block = Block::new("method", Some(&declaration.name), i);
            if let Some(span) = &span {
                apply_span(&block, span);
            }
            apply_anchor(&block, lex, span.as_ref().and_then(|span| span.open));
            register(&mut list, block.clone(), blocks);
            descend(&block, i, span.as_ref(), lex, lexer, blocks);
            i = end_line_of(span.as_ref(), i) + 1;
            continue;
        }

        if let Some((keyword, keyword_offset)) = statement_keyword(&masked_line) {
            if let Some(brace_pos) = index_of(&lex.mask, &[b'{' as u16], start) {
                let segments = chain_segments(
                    &lex.mask,
                    &lex.starts,
                    i,
                    &keyword,
                    brace_pos,
                    keyword_offset,
                );
                let mut last_close_line = i;
                for segment in segments {
                    let block = Block::new("statement", None, segment.header_line);
                    {
                        let mut block_ref = block.borrow_mut();
                        block_ref.open = Some(segment.open);
                        block_ref.close = Some(segment.close);
                        block_ref.open_line = Some(segment.open_line);
                        block_ref.close_line = Some(segment.close_line);
                        block_ref.shared_close = segment.shared_close;
                        block_ref.end_line = Some(segment.close_line);
                        block_ref.conditions = Some(lexer.condition_literals(
                            lex.source_line(segment.header_line),
                            segment.cond_offset,
                        ));
                    }
                    apply_anchor(&block, lex, Some(segment.open));
                    register(&mut list, block.clone(), blocks);
                    let child_span = Span {
                        open_line: Some(segment.open_line),
                        close_line: Some(segment.close_line),
                        ..Span::default()
                    };
                    descend(
                        &block,
                        segment.header_line,
                        Some(&child_span),
                        lex,
                        lexer,
                        blocks,
                    );
                    last_close_line = last_close_line.max(segment.close_line);
                }
                i = last_close_line + 1;
                continue;
            }
        }

        if let Some(property) = property_decl(&masked_line) {
            let first_type = property
                .type_head
                .as_deref()
                .and_then(|head| head.split_whitespace().next())
                .unwrap_or("");
            if !is_not_a_name(&property.name)
                && !starts_with_statement_before(masked_line.trim())
                && !is_not_a_type(first_type)
            {
                let block = Block::new("property", Some(&property.name), i);
                block.borrow_mut().line_end = Some(i);
                register(&mut list, block.clone(), blocks);
                i += 1;
                continue;
            }
        }

        i += 1;
    }
    list
}

/// The method this line declares, and whether its call carried a prefix.
///
/// The call shape is tried at every `name(` the line spells, in order, and the declaration its name
/// reads to is what decides — a wrapped parameter list closes its bracket on a later line, where only
/// the header window can see it. A call with no prefix and no body is a statement, not a declaration;
/// one that carries a prefix may still be a declaration whose body is on a later line, so the flag is
/// what tells the caller "a bare `foo();`" from "a member with nothing to inject".
fn method_declaration(
    masked_line: &str,
    start: usize,
    window: Header,
    lex: &Lex,
    line: usize,
) -> Option<(Declaration, bool)> {
    for (at, _) in masked_line.char_indices() {
        let Some((name, length)) = take_identifier(&masked_line[at..]) else {
            continue;
        };
        if is_not_a_name(name) {
            continue;
        }
        let before = &masked_line[..at];
        if !quiet_prefix(before) {
            continue;
        }
        let after = &masked_line[at + length..];
        if !after.trim_start().starts_with('(') {
            continue;
        }
        let Some(prefix) = allowed_prefix(before) else {
            continue;
        };
        if let Some(found) = declaration_on(masked_line, start, name, window, lex, line) {
            if found.kind == "method" {
                return Some((found, !prefix.is_empty()));
            }
        }
    }

    // The assigned shape, read from its own line: `name = … =>` / `= function`.
    for (at, _) in masked_line.char_indices() {
        let Some((name, length)) = take_identifier(&masked_line[at..]) else {
            continue;
        };
        if is_not_a_name(name) {
            continue;
        }
        let before = &masked_line[..at];
        if !quiet_prefix(before) {
            continue;
        }
        let after = &masked_line[at + length..];
        if !(after.trim_start().starts_with(':') || after.trim_start().starts_with('=')) {
            continue;
        }
        let line_window = Header {
            start,
            end: start + masked_line.len(),
            last: line,
        };
        if let Some(found) = declaration_on(masked_line, start, name, line_window, lex, line) {
            if found.kind == "method" {
                return Some((found, true));
            }
        }
    }
    None
}

/// Whether the text before a name can open one at all: the JavaScript's `(^|[^\w$.])`.
fn quiet_prefix(before: &str) -> bool {
    before
        .chars()
        .next_back()
        .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '$' || c == '.'))
}

/// The declaration prefix a call shape may carry, normalised: `None` when it may not precede a
/// declaration at all, `Some("")` when there is none, and the text otherwise.
fn allowed_prefix(before: &str) -> Option<String> {
    let trimmed = before.trim();
    let normalised = match trimmed.strip_prefix("func") {
        Some(rest) if rest.trim_start().starts_with('(') => {
            let rest = rest.trim_start();
            match rest.find(')') {
                Some(close) => format!("func {}", &rest[close + 1..]),
                None => trimmed.to_string(),
            }
        }
        _ => trimmed.to_string(),
    };
    let normalised = normalised.trim().to_string();
    if normalised.is_empty()
        || (is_prefix(&normalised) && !starts_with_statement_before(&normalised))
    {
        Some(normalised)
    } else {
        None
    }
}

/// The segments of an if/else-if (or try/catch) chain opened on this line.
fn chain_segments(
    mask: &[u16],
    starts: &[usize],
    header_line: usize,
    keyword: &str,
    brace_pos: usize,
    keyword_offset: usize,
) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut current_keyword = keyword.to_string();
    let mut current_line = header_line;
    let mut open = brace_pos;
    let mut cond_from = keyword_offset;
    let mut i = brace_pos;
    let mut depth = 0i32;

    while i < mask.len() {
        match mask[i] {
            unit if unit == b'{' as u16 => {
                depth += 1;
                i += 1;
            }
            unit if unit == b'}' as u16 => {
                depth -= 1;
                if depth == 0 {
                    let rest = &mask[i + 1..];
                    let word = next_word(rest);
                    let continuation = word
                        .as_ref()
                        .map(|(word, _)| word.as_str())
                        .filter(|word| is_continuation(word));
                    // A continuation only exists if a brace actually follows; without that guard the
                    // walk would jump backwards and never terminate.
                    let next_open =
                        continuation.and_then(|_| index_of(mask, &[b'{' as u16], i + 1));
                    if let (Some(word), Some(new_open)) = (continuation, next_open) {
                        segments.push(make_segment(
                            starts,
                            &current_keyword,
                            current_line,
                            open,
                            i,
                            cond_from,
                            true,
                        ));
                        let word_at = word_offset(rest, word).unwrap_or(0);
                        if word == "else" {
                            match word_offset_after(rest, word_at + word.len(), "if") {
                                Some(if_at) => {
                                    current_keyword = "if".to_string();
                                    cond_from = (i + 1) + if_at;
                                }
                                None => {
                                    current_keyword = word.to_string();
                                    cond_from = (i + 1) + word_at;
                                }
                            }
                        } else {
                            current_keyword = word.to_string();
                            cond_from = (i + 1) + word_at;
                        }
                        current_line = line_of(starts, i);
                        open = new_open;
                        i = new_open + 1;
                        depth = 1;
                        continue;
                    }

                    let mut end = i;
                    if current_keyword == "do" && has_word(rest, "while") {
                        if let Some(semi) = index_of(mask, &[b';' as u16], i) {
                            end = semi;
                        }
                    }
                    segments.push(make_segment(
                        starts,
                        &current_keyword,
                        current_line,
                        open,
                        end,
                        cond_from,
                        false,
                    ));
                    return segments;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }

    segments.push(make_segment(
        starts,
        &current_keyword,
        current_line,
        open,
        mask.len().saturating_sub(1),
        cond_from,
        false,
    ));
    segments
}

fn is_continuation(word: &str) -> bool {
    word == "else" || word == "catch" || word == "finally"
}

fn make_segment(
    starts: &[usize],
    _keyword: &str,
    header_line: usize,
    open: usize,
    close: usize,
    cond_from: usize,
    shared_close: bool,
) -> Segment {
    let line_start = starts.get(header_line).copied().unwrap_or(0);
    Segment {
        header_line,
        open,
        close,
        cond_offset: cond_from.saturating_sub(line_start),
        shared_close,
        open_line: line_of(starts, open),
        close_line: line_of(starts, close),
    }
}

/// The first identifier in `rest`, with its offset — `QUOTED_NAME` in the JavaScript.
fn next_word(rest: &[u16]) -> Option<(String, usize)> {
    let text = from_units(rest);
    for (at, _) in text.char_indices() {
        if let Some((word, _)) = take_identifier(&text[at..]) {
            return Some((word.to_string(), at));
        }
        if !text[at..].starts_with(char::is_whitespace) {
            // Anything that is not whitespace and not an identifier ends the search.
            let character = text[at..].chars().next()?;
            if !character.is_whitespace() {
                return None;
            }
        }
    }
    None
}

fn word_offset(rest: &[u16], word: &str) -> Option<usize> {
    let text = from_units(rest);
    text.find(word)
}

fn word_offset_after(rest: &[u16], from: usize, word: &str) -> Option<usize> {
    let text = from_units(rest);
    let tail = text.get(from..)?;
    tail.find(word).map(|at| at + from)
}

fn has_word(rest: &[u16], word: &str) -> bool {
    word_offset(rest, word).is_some()
}

fn end_line_of(span: Option<&Span>, decl_line: usize) -> usize {
    match span {
        Some(span) => span.end_line(decl_line),
        None => decl_line,
    }
}

fn register(list: &mut Vec<BlockRef>, block: BlockRef, blocks: &mut Vec<BlockRef>) {
    list.push(block.clone());
    blocks.push(block);
}

/// Scan `block`'s own body and attach the blocks it directly contains.
fn descend(
    block: &BlockRef,
    decl_line: usize,
    span: Option<&Span>,
    lex: &Lex,
    lexer: &dyn Lexer,
    blocks: &mut Vec<BlockRef>,
) {
    let kind = block.borrow().kind.clone();
    let Some(span) = span else {
        return;
    };
    if span.expression.is_some() || kind == "property" {
        return;
    }
    let (child_from, child_to) = if span.indented {
        match span.body_end_line {
            Some(end) => (decl_line + 1, end),
            None => return,
        }
    } else {
        match (span.open_line, span.close_line) {
            (Some(open_line), Some(close_line)) => (open_line + 1, close_line.saturating_sub(1)),
            _ => return,
        }
    };
    if child_from > child_to {
        return;
    }

    let children = build_scope(lex, lexer, child_from, child_to, blocks);
    for child in &children {
        let mut child_block = child.borrow_mut();
        child_block.parent = Rc::downgrade(block);
        child_block.scope = Rc::downgrade(block);
        child_block.scope_name = block.borrow().name.clone();
        child_block.scope_line = Some(decl_line);
    }
    let mut block_ref = block.borrow_mut();
    block_ref.children.extend(children.iter().cloned());
    block_ref.blocks.extend(children);
}

fn apply_anchor(block: &BlockRef, lex: &Lex, open: Option<usize>) {
    // No opening offset (an indented body, a keyword-delimited block): there is no brace to hang a
    // comment anchor on, and a missing offset must not be searched as if it were line 0.
    let Some(open) = open else {
        return;
    };
    if let Some(anchor) = leading_anchor(&lex.comments, &lex.mask, &lex.lines, &lex.starts, open) {
        block.borrow_mut().anchor = Some(anchor);
    }
}

/// The end offset of the line holding `offset`.
pub fn line_end(mask: &[u16], offset: usize) -> usize {
    crate::mask::end_of_line(mask, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::DefaultLexer;
    use crate::syntaxes::lexer_for_path;

    const JAVA: &str = "class Cart {\n\
                        \x20   private int total = 0;\n\
                        \n\
                        \x20   /** The anchor. */\n\
                        \x20   void add(int a) { //anchor\n\
                        \x20       total = a;\n\
                        \x20   }\n\
                        \n\
                        \x20   void other() {\n\
                        \x20       add(1);\n\
                        \x20   }\n\
                        }\n";

    #[test]
    fn a_scan_builds_the_tree_and_the_indexes() {
        let lexer = lexer_for_path("Cart.java");
        let scan = scan_blocks(JAVA, &*lexer).expect("a scan");

        let names: Vec<Option<String>> = scan
            .blocks
            .iter()
            .map(|block| block.borrow().name.clone())
            .collect();
        assert!(names.contains(&Some("Cart".to_string())), "{names:?}");
        assert!(
            names.contains(&Some("add".to_string())),
            "a method: {names:?}"
        );
        assert!(
            names.contains(&Some("total".to_string())),
            "a property: {names:?}"
        );

        // The method is in the class's scope, not the file's.
        let add = scan
            .blocks
            .iter()
            .find(|block| block.borrow().name.as_deref() == Some("add"))
            .cloned()
            .expect("the method");
        let scope = add.borrow().scope.upgrade().expect("a scope");
        assert_eq!(Some("Cart"), scope.borrow().name.as_deref());

        // `add(1);` inside `other` is a call, not a second declaration.
        let adds = scan
            .blocks
            .iter()
            .filter(|block| block.borrow().name.as_deref() == Some("add"))
            .count();
        assert_eq!(1, adds, "a call is not a declaration");

        // The anchor is the first thing in the braces, and the body span is the method's.
        let anchor = add.borrow().anchor.clone().expect("an anchor");
        assert_eq!("anchor", anchor.name);
        assert_eq!(Some(5), add.borrow().open_line.map(|line| line + 1));
        assert_eq!(Some(7), add.borrow().close_line.map(|line| line + 1));
    }

    #[test]
    fn regions_and_statements_are_indexed() {
        let source = "#region wiring\nif (a == \"getUsers\") {\n    work();\n} else {\n    other();\n}\n#endregion\n";
        let scan = scan_blocks(source, &DefaultLexer).expect("a scan");

        assert_eq!(1, scan.regions.len());
        assert_eq!(
            ("wiring".to_string(), 0, 6),
            (
                scan.regions[0].name.clone(),
                scan.regions[0].start_line,
                scan.regions[0].end_line
            ),
            "the region covers `#region` through `#endregion` inclusive"
        );

        let statements: Vec<BlockRef> = scan
            .blocks
            .iter()
            .filter(|block| block.borrow().kind == "statement")
            .cloned()
            .collect();
        assert_eq!(
            2,
            statements.len(),
            "the `if` and its `else` are two segments"
        );
        assert!(
            statements[0].borrow().shared_close,
            "the first segment shares the close"
        );
        let conditions = statements[0]
            .borrow()
            .conditions
            .clone()
            .expect("conditions");
        assert_eq!(vec!["getUsers".to_string()], conditions.exact);
    }

    #[test]
    fn probe_anchors() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/Anchors.java"
        ))
        .expect("the fixture");
        let lexer = lexer_for_path("Anchors.java");
        let scan = scan_blocks(&source, &*lexer).expect("a scan");
        for block in &scan.blocks {
            let block_ref = block.borrow();
            println!(
                "{:>9} {:?} open {:?} close {:?} anchor {:?}",
                block_ref.kind,
                block_ref.name,
                block_ref.open_line,
                block_ref.close_line,
                block_ref
                    .anchor
                    .as_ref()
                    .map(|anchor| (anchor.name.clone(), anchor.line))
            );
        }
        println!("comments: {}", scan.lex.comments.len());
        for (index, comment) in scan.lex.comments.iter().enumerate() {
            println!(
                "comment {index} line {} from {} text {:?}",
                line_of(&scan.lex.starts, comment.from),
                comment.from,
                comment.text
            );
        }
        let lines = scan.lex.lines.clone();
        let non_blank = crate::span::next_non_blank_units(&lines, 18);
        println!("next non blank from 18: {non_blank:?}");
    }

    #[test]
    fn probe_leading_anchor() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/Anchors.java"
        ))
        .expect("the fixture");
        let lexer = lexer_for_path("Anchors.java");
        let scan = scan_blocks(&source, &*lexer).expect("a scan");
        let other = scan
            .blocks
            .iter()
            .find(|block| block.borrow().name.as_deref() == Some("other"))
            .cloned()
            .expect("the method");
        let open = other.borrow().open.expect("a brace");
        let brace_line = line_of(&scan.lex.starts, open);
        println!("other open {open} brace_line {brace_line}");
        for comment in &scan.lex.comments {
            let gap = if comment.from > open {
                crate::mask::from_units(&scan.lex.mask[open + 1..comment.from])
            } else {
                String::from("<before>")
            };
            println!(
                "  comment line {} from {} gap {:?}",
                line_of(&scan.lex.starts, comment.from),
                comment.from,
                gap
            );
        }
        println!(
            "  next non blank after brace: {:?}",
            crate::span::next_non_blank_units(&scan.lex.lines, brace_line + 1)
        );
        println!(
            "  leading_anchor -> {:?}",
            crate::block::leading_anchor(
                &scan.lex.comments,
                &scan.lex.mask,
                &scan.lex.lines,
                &scan.lex.starts,
                open
            )
        );
    }

    #[test]
    fn a_broken_mask_is_refused() {
        struct ShortMask;
        impl Lexer for ShortMask {
            fn name(&self) -> &str {
                "short"
            }
            fn mask(&self, _text: &str) -> Result<String, SectionError> {
                Ok("too short".to_string())
            }
            fn comments(&self, _text: &str) -> Vec<Comment> {
                Vec::new()
            }
        }
        let error =
            scan_blocks("class Cart {}\n", &ShortMask).expect_err("the invariant is enforced");
        assert!(
            error.message().contains("preserve length"),
            "{}",
            error.message()
        );
    }

    #[test]
    fn the_default_engine_scans_an_unknown_type() {
        let scan = scan_blocks(JAVA, &DefaultLexer).expect("a scan");
        assert!(scan
            .blocks
            .iter()
            .any(|block| block.borrow().name.as_deref() == Some("Cart")));
    }
}
