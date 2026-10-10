//! Resolution (`planSection`/`resolveSection`/`extractDeclaration`): turning a parsed reference into
//! text, a line span and the matcher that found it.
//!
//! The walk is the interesting part. It is **sibling-first and level-order**: within one scope the
//! matchers are tried in precedence order (region, anchor-into-this-block, class, method, property,
//! condition, anchor), and only if a whole level yields nothing does the search descend. A same-named
//! candidate that cannot hold the rest of the path gives way to the next one at the same level — but the
//! **last** segment is not retried, because its first match in walk order is the selection.
//!
//! The span and the `kind` are not decoration: a host navigates to the span and explains itself with the
//! kind, and both come from the same slice the text was made from, so no second search can disagree with
//! the first answer.

use crate::block::{Block, BlockRef, Region, Scan};
use crate::lexer::Lexer;
use crate::mask::{bracket_balance, end_of_line, line_of};
use crate::scanner::{scan_blocks, Lex};
use crate::{Reference, Scope, SectionError, SectionReferenceError};

/// What a reference resolved to: the text, the parsed reference, the **1-based inclusive** line range
/// the text came from, and the matcher that found it.
#[derive(Clone, Debug)]
pub struct Plan {
    pub text: String,
    pub reference: Reference,
    pub start_line: usize,
    pub end_line: usize,
    pub kind: String,
}

/// Why a plan failed: the reference was malformed, or it was well formed and matched nothing.
#[derive(Clone, Debug)]
pub enum PlanError {
    Reference(SectionReferenceError),
    Section(SectionError),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Reference(error) => f.write_str(&error.to_string()),
            PlanError::Section(error) => f.write_str(error.message()),
        }
    }
}

impl std::error::Error for PlanError {}

impl From<SectionReferenceError> for PlanError {
    fn from(error: SectionReferenceError) -> Self {
        PlanError::Reference(error)
    }
}

impl From<SectionError> for PlanError {
    fn from(error: SectionError) -> Self {
        PlanError::Section(error)
    }
}

/// Rendered text with the line range it came from, before it becomes a [`Plan`].
struct Rendered {
    text: String,
    from: usize,
    to: usize,
}

/// One candidate: a region, or a block matched by one of the matchers.
struct Hit {
    kind: String,
    block: Option<BlockRef>,
    line: Option<usize>,
    region: Option<Region>,
}

impl Hit {
    fn of(kind: &str, block: &BlockRef, line: Option<usize>) -> Self {
        Hit { kind: kind.to_string(), block: Some(block.clone()), line, region: None }
    }

    fn of_region(region: &Region) -> Self {
        Hit { kind: "region".to_string(), block: None, line: None, region: Some(region.clone()) }
    }
}

/// The text a section reference stands for.
pub fn resolve_section(
    text: &str,
    reference: &str,
    lexer: &dyn Lexer,
) -> Result<String, PlanError> {
    Ok(plan_section(text, reference, lexer)?.text)
}

/// Resolve a section reference to text, the line span it came from, and the matcher that found it.
pub fn plan_section(text: &str, reference: &str, lexer: &dyn Lexer) -> Result<Plan, PlanError> {
    let parsed = crate::parse_reference(reference)?;
    let source = text.replace("\r\n", "\n");
    let scan = scan_blocks(&source, lexer)?;

    let found = resolve_path(&parsed.segments, 0, &scan.root, false, None, &scan, lexer)?;

    let (rendered, kind) = match &found.region {
        Some(region) => {
            let from = region.start_line + 1;
            let to = region.end_line;
            (span(&slice(&scan.lex.source_lines, from, to), from, to), "region".to_string())
        }
        None => {
            let block = found.block.clone().ok_or_else(|| {
                SectionError::new("a match without a block")
            })?;
            (render_block(&block, parsed.scope, &scan.lex, lexer, &found.kind), found.kind.clone())
        }
    };

    Ok(Plan {
        text: rendered.text,
        reference: parsed,
        start_line: rendered.from,
        end_line: rendered.to,
        kind,
    })
}

/// The text a single named declaration contributes, or `None` when the name declares nothing.
///
/// Searches the whole file at any depth, prefers a class-like over a same-named member, and refuses a
/// genuine overload pair. Never matches a `#region` directive — that is `extractDeclaration`'s
/// semantics, unchanged.
pub fn extract_declaration(
    text: &str,
    name: &str,
    scope: Scope,
    lexer: &dyn Lexer,
) -> Result<Option<String>, PlanError> {
    if name.is_empty() {
        return Ok(None);
    }
    let source = text.replace("\r\n", "\n");
    let scan = scan_blocks(&source, lexer)?;

    let mut found: Vec<BlockRef> = Vec::new();
    collect(&scan.root, name, &mut found);
    if found.is_empty() {
        return Ok(None);
    }
    let classes: Vec<BlockRef> = found
        .iter()
        .filter(|block| block.borrow().kind == "class")
        .cloned()
        .collect();
    let chosen = if classes.is_empty() { found } else { classes };
    if chosen.len() > 1 {
        return Err(SectionError::new(format!(
            "\"{name}\" is declared {} times; names must be unique",
            chosen.len()
        ))
        .into());
    }
    Ok(Some(render_declaration(&chosen[0], scope, &scan.lex, lexer).text))
}

fn collect(scope: &BlockRef, name: &str, found: &mut Vec<BlockRef>) {
    let children: Vec<BlockRef> = scope.borrow().children.clone();
    for block in children {
        let (kind, block_name, body) = {
            let block_ref = block.borrow();
            (block_ref.kind.clone(), block_ref.name.clone(), has_body(&block_ref))
        };
        let named = kind == "class" || kind == "method" || kind == "property";
        if named && block_name.as_deref() == Some(name) && body {
            found.push(block.clone());
        }
        collect(&block, name, found);
    }
}

fn has_body(block: &Block) -> bool {
    block.single_line || block.expression.is_some() || block.indented || block.open_line.is_some()
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/// Resolve `segments[index..]` starting at `scope`, retrying same-named candidates: a candidate that
/// cannot be a scope, or that does not hold the rest of the path, gives way to the next one at the same
/// level. The last segment is not retried.
fn resolve_path(
    segments: &[String],
    index: usize,
    scope: &BlockRef,
    descended: bool,
    prev_name: Option<&str>,
    scan: &Scan,
    lexer: &dyn Lexer,
) -> Result<Hit, PlanError> {
    let segment = segments.get(index).cloned().unwrap_or_default();
    let last = index + 1 == segments.len();
    let candidates = search_segments(&segment, scope, descended)?;

    if candidates.is_empty() {
        return Err(SectionError::new(if index == 0 && last {
            format!("no \"#region {segment}\" found, and no section named \"{segment}\"")
        } else {
            format!("no section named \"{segment}\" in \"{}\"", prev_name.unwrap_or(""))
        })
        .into());
    }

    let mut failure: Option<PlanError> = None;
    for candidate in &candidates {
        if last {
            return Ok(Hit {
                kind: candidate.kind.clone(),
                block: candidate.block.clone(),
                line: candidate.line,
                region: candidate.region.clone(),
            });
        }
        let container = candidate
            .block
            .as_ref()
            .map(|block| is_container(&block.borrow()))
            .unwrap_or(false);
        if candidate.region.is_some() || !container {
            failure.get_or_insert_with(|| {
                SectionError::new(format!("\"{segment}\" is not a container")).into()
            });
            continue;
        }
        let block = candidate.block.clone().expect("a container has a block");
        match resolve_path(segments, index + 1, &block, true, Some(&segment), scan, lexer) {
            Ok(hit) => return Ok(hit),
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    Err(failure.unwrap_or_else(|| SectionError::new("no match").into()))
}

/// Find every `segment` in the shallowest level of `scope` that has one, in walk order.
fn search_segments(
    segment: &str,
    scope: &BlockRef,
    descended: bool,
) -> Result<Vec<Hit>, PlanError> {
    let mut level: Vec<(BlockRef, bool)> = vec![(scope.clone(), descended)];
    while !level.is_empty() {
        let mut hits: Vec<Hit> = Vec::new();
        for (node, descended) in &level {
            hits.extend(match_segment(node, segment, *descended)?);
        }
        if !hits.is_empty() {
            return Ok(hits);
        }
        let mut deeper: Vec<(BlockRef, bool)> = Vec::new();
        for (node, _) in &level {
            for child in node.borrow().children.iter() {
                deeper.push((child.clone(), true));
            }
        }
        level = deeper;
    }
    Ok(Vec::new())
}

/// The matcher-precedence lookup of `segment` inside one scope: matchers 1–6, considering only this
/// scope's own members.
fn match_segment(scope: &BlockRef, segment: &str, descended: bool) -> Result<Vec<Hit>, PlanError> {
    // 1 — region directive (modifier ignored).
    let regions: Vec<Region> = scope
        .borrow()
        .regions
        .iter()
        .filter(|region| region.name == segment)
        .cloned()
        .collect();
    if regions.len() > 1 {
        return Err(SectionError::new(format!(
            "\"#region {segment}\" appears {} times; region names must be unique",
            regions.len()
        ))
        .into());
    }
    if let Some(region) = regions.first() {
        return Ok(vec![Hit::of_region(region)]);
    }

    // Having descended *into* this block puts its own comment anchor in scope for this segment, checked
    // early so `handler/getUsers` resolves to the handler block itself.
    let anchor = scope.borrow().anchor.clone();
    if descended {
        if let Some(anchor) = &anchor {
            if anchor.name == segment {
                return Ok(vec![Hit::of("anchor", scope, Some(anchor.line))]);
            }
        }
    }

    // 2 — class-like, 3 — method (body-carrying), 4 — property.
    for kind_name in ["class", "method"] {
        let named = named(scope, kind_name, segment);
        if !named.is_empty() {
            return Ok(named.iter().map(|block| Hit::of("declaration", block, None)).collect());
        }
    }
    let properties = named(scope, "property", segment);
    if !properties.is_empty() {
        return Ok(properties.iter().map(|block| Hit::of("property", block, None)).collect());
    }

    // 5 — condition literal: this scope's own condition, or a direct statement child.
    let own_conditions = {
        let scope_ref = scope.borrow();
        if scope_ref.kind == "statement" { scope_ref.conditions.clone() } else { None }
    };
    if own_conditions
        .as_ref()
        .is_some_and(|conditions| conditions.pasted.iter().any(|literal| literal == segment))
    {
        let decl_line = scope.borrow().decl_line;
        return Ok(vec![Hit::of("condition", scope, Some(decl_line))]);
    }
    let mut conditions: Vec<Hit> = Vec::new();
    for child in scope.borrow().children.iter() {
        let (child_kind, child_conditions, child_line) = {
            let child_ref = child.borrow();
            (child_ref.kind.clone(), child_ref.conditions.clone(), child_ref.decl_line)
        };
        if child_kind == "statement"
            && child_conditions
                .as_ref()
                .is_some_and(|conditions| conditions.pasted.iter().any(|literal| literal == segment))
        {
            conditions.push(Hit::of("condition", child, Some(child_line)));
        }
    }
    if !conditions.is_empty() {
        return Ok(conditions);
    }

    // 6 — comment anchor: a child block whose anchor names the segment.
    let mut anchored: Vec<Hit> = Vec::new();
    for child in scope.borrow().children.iter() {
        let anchor = child.borrow().anchor.clone();
        if let Some(anchor) = anchor {
            if anchor.name == segment {
                anchored.push(Hit::of("anchor", child, Some(anchor.line)));
            }
        }
    }
    Ok(anchored)
}

fn named(scope: &BlockRef, kind: &str, segment: &str) -> Vec<BlockRef> {
    scope
        .borrow()
        .children
        .iter()
        .filter(|block| {
            let block_ref = block.borrow();
            block_ref.kind == kind && block_ref.name.as_deref() == Some(segment)
        })
        .cloned()
        .collect()
}

/// Whether a matched block can hold nested sections.
fn is_container(block: &Block) -> bool {
    if block.kind == "property" {
        return false;
    }
    !block.children.is_empty()
        || block.indented
        || matches!((block.open_line, block.close_line), (Some(open), Some(close)) if open < close)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The text `block` contributes under `scope`.
fn render_block(
    block: &BlockRef,
    scope: Scope,
    lex: &Lex,
    lexer: &dyn Lexer,
    match_kind: &str,
) -> Rendered {
    let is_anchor = match_kind == "anchor" || match_kind == "condition";
    let block_kind = block.borrow().kind.clone();
    if !is_anchor && (block_kind == "class" || block_kind == "method") {
        return render_declaration(block, scope, lex, lexer);
    }
    if !is_anchor && block_kind == "property" {
        let decl_line = block.borrow().decl_line;
        if scope == Scope::Body {
            let line_start = lex.starts.get(decl_line).copied().unwrap_or(0);
            if let Some(offset) = lex.source.get(line_start..).and_then(|tail| tail.find('=')) {
                let equals = line_start + offset;
                let line_end = end_of_line(&crate::mask::units(&lex.source), line_start);
                let tail = slice_units(&lex.source, equals + 1, line_end);
                return single(trim_trailing_semicolon(tail.trim_end()).trim(), decl_line);
            }
        }
        let line = lex.source_line(decl_line).trim_end().to_string();
        return single(line, decl_line);
    }

    let (decl_line, open, close, open_line, close_line, anchor_line, shared_close) = {
        let block_ref = block.borrow();
        (
            block_ref.decl_line,
            block_ref.open,
            block_ref.close,
            block_ref.open_line,
            block_ref.close_line,
            block_ref.anchor.as_ref().map(|anchor| anchor.line),
            block_ref.shared_close,
        )
    };
    let first_line = decl_line;
    let last_line = close_line.unwrap_or(decl_line);

    if scope == Scope::Body {
        let body_from = match (open_line, anchor_line) {
            (Some(open_line), Some(anchor_line)) => open_line.max(anchor_line),
            (Some(open_line), None) => open_line,
            _ => return single(String::new(), decl_line),
        };
        if let Some(close_line) = close_line {
            if body_from >= close_line {
                let (Some(open), Some(close)) = (open, close) else {
                    return single(String::new(), decl_line);
                };
                let raw = slice_units(&lex.source, open + 1, close);
                let leading = raw.len() - raw.trim_start().len();
                let trailing = raw.len() - raw.trim_end().len();
                let from = line_of(&lex.starts, open + 1 + leading);
                let to = line_of(&lex.starts, close.saturating_sub(trailing).max(open + 1));
                return Rendered {
                    text: raw.trim().to_string(),
                    from: from + 1,
                    to: from.max(to) + 1,
                };
            }
            return span(&slice(&lex.source_lines, body_from + 1, close_line), body_from + 1, close_line);
        }
        return single(String::new(), decl_line);
    }

    if shared_close {
        if let (Some(close), Some(line_start)) = (close, lex.starts.get(first_line).copied()) {
            let raw = slice_units(&lex.source, line_start, close + 1);
            let trimmed: Vec<String> =
                raw.split('\n').map(|line| line.trim_end().to_string()).collect();
            return span(&trimmed, first_line, line_of(&lex.starts, close) + 1);
        }
    }
    span(&slice(&lex.source_lines, first_line, last_line + 1), first_line, last_line + 1)
}

/// The text one declaration contributes, under one scope.
fn render_declaration(block: &BlockRef, scope: Scope, lex: &Lex, lexer: &dyn Lexer) -> Rendered {
    let (decl_line, close_line, end_line, single_line, indented, expression, open_line, open, close) = {
        let block_ref = block.borrow();
        (
            block_ref.decl_line,
            block_ref.close_line,
            block_ref.end_line,
            block_ref.single_line,
            block_ref.indented,
            block_ref.expression,
            block_ref.open_line,
            block_ref.open,
            block_ref.close,
        )
    };
    let end_line = end_line.or(close_line).unwrap_or(decl_line);

    if scope == Scope::Body {
        if single_line {
            return span(&slice(&lex.source_lines, decl_line, end_line + 1), decl_line, end_line + 1);
        }
        if indented {
            return span(
                &slice(&lex.source_lines, decl_line + 1, end_line + 1),
                decl_line + 1,
                end_line + 1,
            );
        }
        if let Some(expression) = expression {
            let units = crate::mask::units(&lex.source);
            let line_end = end_of_line(&units, expression);
            let text = slice_units(&lex.source, expression, line_end);
            return single(text.trim(), line_of(&lex.starts, expression));
        }
        if open_line == Some(end_line) {
            if let (Some(open), Some(close)) = (open, close) {
                let text = slice_units(&lex.source, open + 1, close);
                return single(text.trim(), open_line.unwrap_or(decl_line));
            }
        }
        return span(&slice(&lex.source_lines, open_line.unwrap_or(decl_line) + 1, end_line), open_line.unwrap_or(decl_line) + 1, end_line);
    }

    let mut start = decl_line;
    if scope == Scope::Annotated || scope == Scope::Documented {
        let annotated = annotation_start(&lex.source_lines, decl_line, lexer);
        if annotated != usize::MAX {
            start = annotated;
        }
        if scope == Scope::Documented {
            let documented = doc_comment_start(&lex.source_lines, start);
            if documented != usize::MAX {
                start = documented;
            }
        }
    }
    span(&slice(&lex.source_lines, start, end_line + 1), start, end_line + 1)
}

/// A rendered section from already-sliced lines. An inverted range is empty, and the span then names the
/// line the section would start on rather than a range that runs backwards.
fn span(sliced: &[String], from: usize, to: usize) -> Rendered {
    Rendered {
        text: sliced.join("\n"),
        from: from + 1,
        to: from.max(to.saturating_sub(1)) + 1,
    }
}

/// A one-line section.
fn single(text: impl Into<String>, at: usize) -> Rendered {
    Rendered { text: text.into(), from: at + 1, to: at + 1 }
}

/// `lines.slice(from, to)`, half-open and forgiving of odd ranges.
fn slice(lines: &[String], from: usize, to: usize) -> Vec<String> {
    let start = from.min(lines.len());
    let end = to.min(lines.len());
    if start >= end {
        return Vec::new();
    }
    lines[start..end].to_vec()
}

/// The text between two **UTF-16 code-unit** offsets of a source, so an offset found by the mask
/// readers slices the same text the JavaScript would.
fn slice_units(source: &str, from: usize, to: usize) -> String {
    let units = crate::mask::units(source);
    let start = from.min(units.len());
    let end = to.min(units.len()).max(start);
    crate::mask::from_units(&units[start..end])
}

fn trim_trailing_semicolon(text: &str) -> &str {
    match text.strip_suffix(';') {
        Some(head) => head.trim_end(),
        None => text,
    }
}

/// The first line of the annotation block directly above `decl_line`, or `usize::MAX`.
fn annotation_start(lines: &[String], decl_line: usize, lexer: &dyn Lexer) -> usize {
    let mut found = usize::MAX;
    let mut i = decl_line;
    while i > 0 {
        i -= 1;
        let line = lines.get(i).map(String::as_str).unwrap_or("");
        if line.trim().is_empty() {
            break;
        }
        if lexer.is_annotation_line(line) {
            found = i;
            break;
        }
    }
    if found == usize::MAX {
        return usize::MAX;
    }

    let mut start = found;
    let mut i = found;
    while i > 0 {
        i -= 1;
        let line = lines.get(i).map(String::as_str).unwrap_or("");
        if line.trim().is_empty() || !lexer.is_annotation_line(line) {
            break;
        }
        start = i;
    }

    // The block must be annotations all the way: a statement between the declaration and the annotation
    // means there is no annotation block.
    let mut depth = 0;
    for i in start..decl_line {
        let line = lines.get(i).map(String::as_str).unwrap_or("");
        if depth == 0 && !lexer.is_annotation_line(line) {
            return usize::MAX;
        }
        depth += bracket_balance(line);
    }
    if depth == 0 { start } else { usize::MAX }
}

/// The first line of the doc comment directly above `top`, or `usize::MAX`.
fn doc_comment_start(lines: &[String], top: usize) -> usize {
    if top == 0 {
        return usize::MAX;
    }
    let previous = top - 1;
    let line = lines.get(previous).map(String::as_str).unwrap_or("");
    if line.trim().is_empty() {
        return usize::MAX;
    }
    if is_doc_run(line) {
        let mut start = previous;
        while start > 0 {
            let above = lines.get(start - 1).map(String::as_str).unwrap_or("");
            if !is_doc_run(above) {
                break;
            }
            start -= 1;
        }
        return start;
    }
    if !line.trim_end().ends_with("*/") {
        return usize::MAX;
    }
    let mut i = previous + 1;
    while i > 0 {
        i -= 1;
        let candidate = lines.get(i).map(String::as_str).unwrap_or("");
        if candidate.trim().is_empty() {
            return usize::MAX;
        }
        if is_doc_open(candidate) {
            return i;
        }
    }
    usize::MAX
}

/// A line inside a doc comment (`* …`, `/// …`, `## …`).
fn is_doc_run(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('*')
        || trimmed.starts_with("///")
        || trimmed.starts_with("//!")
        || trimmed.starts_with("##")
}

/// A line that opens a doc comment (`/**`, `///`, `//!`, `##`).
fn is_doc_open(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("/**")
        || trimmed.starts_with("///")
        || trimmed.starts_with("//!")
        || trimmed.starts_with("##")
}
