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
use crate::mask::{from_units, index_of, line_of, line_starts, units, Comment};
use crate::matchers::{
    assigned_shape, call_shape, declaration_keyword, is_not_a_name, is_not_a_type, is_prefix,
    property_decl, statement_keyword, starts_with_statement_before, take_identifier,
};
use crate::span::{body_span, keyword_body, Span};
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
        self.source_lines.get(line).map(String::as_str).unwrap_or("")
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

/// Scan a source for blocks and the indexable things in each scope: the block tree plus region pairs,
/// condition literals and comment anchors, ready for resolution.
pub fn scan_blocks(text: &str, lexer: &dyn Lexer) -> Result<Scan, SectionError> {
    // The mask invariant is asserted inside `make_lex`, so a substituted engine fails loudly here.
    let source = text.replace("\r\n", "\n");
    let lex = make_lex(&source, lexer)?;

    let mut blocks: Vec<BlockRef> = Vec::new();
    let root = Block::root();
    let top = build_scope(&lex, lexer, 0, lex.lines.len().saturating_sub(1), &mut blocks);
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

    Ok(Scan { root, blocks, regions, anchors, lex })
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
    let annotation_lines = source_lines.iter().map(|line| lexer.is_annotation_line(line)).collect();

    Ok(Lex { source: source.to_string(), source_lines, lines, starts, mask, mask_lines, comments, annotation_lines })
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
                let span = if entry.body.as_deref() == Some("end") {
                    keyword_body(&lex.lines, i, entry.end.as_deref().unwrap_or("end"))
                } else {
                    body_span(&lex.mask, &lex.mask_lines, &lex.starts, i, start + entry.header_from)
                };
                let kind = if entry.kind.is_empty() { "method" } else { entry.kind.as_str() };
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
                let span = body_span(&lex.mask, &lex.mask_lines, &lex.starts, i, header_from);
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

        if let Some((kind, name, header_from)) = method_declaration(&masked_line, start) {
            let span = body_span(&lex.mask, &lex.mask_lines, &lex.starts, i, header_from);
            if span.is_none() && kind == "bare" {
                i += 1; // a bare `foo();` call, not a declaration
                continue;
            }
            let block = Block::new("method", Some(&name), i);
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
                let segments =
                    chain_segments(&lex.mask, &lex.starts, i, &keyword, brace_pos, keyword_offset);
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
                    descend(&block, segment.header_line, Some(&child_span), lex, lexer, blocks);
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

/// A method-shaped declaration on this line, or the `"bare"` marker that says "a call with no body".
fn method_declaration(masked_line: &str, start: usize) -> Option<(String, String, usize)> {
    for (at, _) in masked_line.char_indices() {
        let Some((name, length)) = take_identifier(&masked_line[at..]) else {
            continue;
        };
        if is_not_a_name(name) {
            continue;
        }
        let after = &masked_line[at + length..];
        // Only a call position or an assignment can name a declaration.
        let before = &masked_line[..at];
        let previous = before.chars().next_back();
        if previous.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.') {
            continue;
        }
        if let Some(header_from) = call_shape(masked_line, name) {
            let Some(prefix) = allowed_prefix(before) else {
                continue;
            };
            // A call with no prefix and no body is a statement, not a declaration; one that does carry a
            // prefix may still be a declaration whose body is on a later line.
            let marker = if prefix.is_empty() { "bare" } else { "method" };
            return Some((marker.to_string(), name.to_string(), start + header_from));
        }
        if after.trim_start().starts_with(':') || after.trim_start().starts_with('=') {
            if let Some(header_from) = assigned_shape(masked_line, name) {
                return Some(("method".to_string(), name.to_string(), start + header_from));
            }
        }
    }
    None
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
    if normalised.is_empty() || (is_prefix(&normalised) && !starts_with_statement_before(&normalised)) {
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
                    let next_open = continuation
                        .and_then(|_| index_of(mask, &[b'{' as u16], i + 1));
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

        let names: Vec<Option<String>> =
            scan.blocks.iter().map(|block| block.borrow().name.clone()).collect();
        assert!(names.contains(&Some("Cart".to_string())), "{names:?}");
        assert!(names.contains(&Some("add".to_string())), "a method: {names:?}");
        assert!(names.contains(&Some("total".to_string())), "a property: {names:?}");

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
            (scan.regions[0].name.clone(), scan.regions[0].start_line, scan.regions[0].end_line),
            "the region covers `#region` through `#endregion` inclusive"
        );

        let statements: Vec<BlockRef> = scan
            .blocks
            .iter()
            .filter(|block| block.borrow().kind == "statement")
            .cloned()
            .collect();
        assert_eq!(2, statements.len(), "the `if` and its `else` are two segments");
        assert!(statements[0].borrow().shared_close, "the first segment shares the close");
        let conditions = statements[0].borrow().conditions.clone().expect("conditions");
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
                block_ref.anchor.as_ref().map(|anchor| (anchor.name.clone(), anchor.line))
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
        let error = scan_blocks("class Cart {}\n", &ShortMask).expect_err("the invariant is enforced");
        assert!(error.message().contains("preserve length"), "{}", error.message());
    }

    #[test]
    fn the_default_engine_scans_an_unknown_type() {
        let scan = scan_blocks(JAVA, &DefaultLexer).expect("a scan");
        assert!(scan.blocks.iter().any(|block| block.borrow().name.as_deref() == Some("Cart")));
    }
}
