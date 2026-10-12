//! Resolution (`planSection`/`resolveSection`/`extractDeclaration`) and the reference grammar it
//! consumes: turning a reference into text, the line ranges that text came from, and the matcher that
//! found it.
//!
//! The walk is the interesting part. It is **sibling-first and level-order**: within one scope the
//! matchers are tried in precedence order (region, anchor-into-this-block, class, method, property,
//! condition, anchor), and only if a whole level yields nothing does the search descend. A same-named
//! candidate that cannot hold the rest of the path gives way to the next one at the same level — but the
//! **last** segment is not retried, because its first match in walk order is the selection.
//!
//! A reference is one or more **selectors** separated by `,`, each a semantic path or a line range
//! (`L40:12-L44:3`). Each selector contributes its own text, rendered under its own scope, and the texts
//! are joined with a newline; the line ranges and the `kind` are the same slice the text was made from,
//! so no second search can disagree with the first answer.

use crate::block::{Block, BlockRef, Region, Scan};
use crate::lexer::Lexer;
use crate::mask::{bracket_balance, end_of_line, line_of, units};
use crate::scanner::{scan_blocks, Lex};
use crate::{Reference, Scope, SectionError, SectionReferenceError};

// ---------------------------------------------------------------------------
// The reference grammar: one path selector, or a comma-separated selector list
// ---------------------------------------------------------------------------

/// One endpoint of a line range: a 1-based line, and a 1-based column or `None` for the whole line.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LinePoint {
    pub line: usize,
    pub column: Option<usize>,
}

/// A line range as the grammar read it, before it is resolved against a file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct ParsedRange {
    pub from: LinePoint,
    pub to: Option<LinePoint>,
}

/// One selector of a reference: a semantic path, resolved by the matcher precedence and the
/// sibling-first walk, or an explicit line range, which selects verbatim lines and consults no matcher.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Selector {
    /// A semantic path. `raw` is the selector as written — trimmed, and with the whole-segment
    /// modifier that is that selector's own — and `scope` is the share *this* selector asks for.
    Path {
        raw: String,
        segments: Vec<String>,
        scope: Scope,
    },
    /// Verbatim lines: no name, no matcher, no scope and no modifier of its own.
    Lines {
        raw: String,
        from: LinePoint,
        to: Option<LinePoint>,
    },
}

impl Selector {
    /// The selector as written.
    pub fn raw(&self) -> &str {
        match self {
            Selector::Path { raw, .. } | Selector::Lines { raw, .. } => raw,
        }
    }
}

/// Whether `text` can open a path selector at all (`[\w$/+-]`).
fn starts_with_path(text: &str) -> bool {
    text.chars().next().is_some_and(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '$' | '/' | '+' | '-')
    })
}

/// A decimal digit, as `\d` reads it in the grammar's own patterns.
fn is_digit(character: char) -> bool {
    character.is_ascii_digit()
}

/// Does this selector at least begin like a line range (`L40`)?
pub(crate) fn is_line_range_prefix(raw: &str) -> bool {
    let mut characters = raw.chars();
    characters.next() == Some('L') && characters.next().is_some_and(is_digit)
}

/// Read `L<point>` and `L<point>-L<point>`, and nothing else.
///
/// A line range takes no modifier: there is nothing about a verbatim slice of lines for `+` to add, and
/// the `-` of the range is already spoken for, so a selector that is not exactly one of the two forms
/// is not a range at all.
fn split_range_modifier(raw: &str) -> Option<()> {
    let characters: Vec<char> = raw.chars().collect();
    let mut at = 0usize;
    for endpoint in 0..2 {
        if endpoint == 1 {
            if characters.get(at) != Some(&'-') {
                return None;
            }
            at += 1;
        }
        if characters.get(at) != Some(&'L')
            || !characters.get(at + 1).copied().is_some_and(is_digit)
        {
            return None;
        }
        at += 2;
        while characters.get(at).copied().is_some_and(is_digit) {
            at += 1;
        }
        if characters.get(at) == Some(&':') {
            if !characters.get(at + 1).copied().is_some_and(is_digit) {
                return None;
            }
            at += 2;
            while characters.get(at).copied().is_some_and(is_digit) {
                at += 1;
            }
        }
        // An endpoint is complete here; a second `-` starts the range's other end.
        if characters.get(at) == Some(&'-') {
            continue;
        }
        break;
    }
    if at == characters.len() {
        Some(())
    } else {
        None
    }
}

/// The digits at the front of `raw`, and what follows them.
fn take_digits(raw: &str) -> Option<(&str, &str)> {
    let end = raw
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(raw.len());
    if end == 0 {
        return None;
    }
    Some((&raw[..end], &raw[end..]))
}

/// `:digits` at the front of `raw`, or no column at all.
fn take_column(raw: &str) -> Option<(Option<usize>, &str)> {
    let Some(rest) = raw.strip_prefix(':') else {
        return Some((None, raw));
    };
    let (digits, rest) = take_digits(rest)?;
    Some((Some(number(digits)), rest))
}

/// A line or column number. A spelling too long for a `usize` is still "far past the file", which is
/// all the reader does with it.
fn number(digits: &str) -> usize {
    digits.parse::<usize>().unwrap_or(usize::MAX)
}

/// The two endpoints of a core `split_range_modifier` accepted.
fn range_endpoints(core: &str) -> Option<(LinePoint, Option<LinePoint>)> {
    let rest = core.strip_prefix('L')?;
    let (line_text, rest) = take_digits(rest)?;
    let (column, rest) = take_column(rest)?;
    let from = LinePoint {
        line: number(line_text),
        column,
    };
    if rest.is_empty() {
        return Some((from, None));
    }
    let rest = rest.strip_prefix("-L")?;
    let (line_text, rest) = take_digits(rest)?;
    let (column, rest) = take_column(rest)?;
    if !rest.is_empty() {
        return None;
    }
    Some((
        from,
        Some(LinePoint {
            line: number(line_text),
            column,
        }),
    ))
}

/// Read `raw` as a line-range selector, or return `None` when it is not one.
///
/// The accepted spellings are `L40` (one line), `L40:12` (from column 12 of that line), `L40-L44` and
/// `L40:12-L44:3`. An endpoint ending in `:` is deliberately not accepted: it would mean "to the end of
/// the line", which writing the point alone already says.
///
/// Fails when the text claims to be a line range and is not one — `L40-`, `L40:x`, `L0`, `L5-L2`, and a
/// range carrying a modifier (`L40-L44+`) — because a reference that opens `L<digit>` is a line range or
/// a typo, never a name. (`Lx` is still a name: it does not open with a digit, so it parses as a path.)
pub(crate) fn line_range_of(raw: &str) -> Result<Option<ParsedRange>, SectionReferenceError> {
    if !is_line_range_prefix(raw) {
        return Ok(None);
    }

    let malformed = || {
        SectionReferenceError::new(format!(
            "\"#{raw}\" is not a line range; write L<line> or L<line>:<column>"
        ))
    };
    if split_range_modifier(raw).is_none() {
        return Err(malformed());
    }
    let Some((from, to)) = range_endpoints(raw) else {
        return Err(malformed());
    };

    let zero = |at: LinePoint| at.line < 1 || at.column.is_some_and(|column| column < 1);
    if zero(from) || to.is_some_and(zero) {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" counts lines and columns from 1"
        )));
    }
    if let Some(to) = to {
        let backwards = to.line < from.line
            || (to.line == from.line
                && to.column.is_some()
                && from.column.is_some()
                && to.column < from.column);
        if backwards {
            return Err(SectionReferenceError::new(format!(
                "\"#{raw}\" ends before it starts"
            )));
        }
    }

    Ok(Some(ParsedRange { from, to }))
}

/// Read a whole reference as its selectors, or fail.
///
/// A reference is one or more selectors separated by `,`: each is either a semantic path
/// (`Cart/Line/render/++`) or a line range (`L40:12-L44:3`). A single path selector is the degenerate
/// case of it: everything [`parse_reference`](crate::parse_reference) accepts parses here to the same
/// canonical spelling, the same segments and the same scope.
///
/// A modifier belongs to the selector whose path carries it, so `add/-,render/++` is two selectors that
/// each say what they mean and nothing is ambiguous between them. A line range takes no modifier: its
/// own `-` is spoken for by the range, and there is nothing about a verbatim slice of lines for a scope
/// to widen.
///
/// # Errors
///
/// Returns a [`SectionReferenceError`] whose message is part of the contract when the reference is
/// malformed: nothing named, an empty selector, a malformed line range, or more than one modifier on
/// one selector.
pub fn parse_selectors(raw: &str) -> Result<Reference, SectionReferenceError> {
    if raw.is_empty() {
        return Err(SectionReferenceError::new("\"#\" names nothing"));
    }

    let parts: Vec<&str> = raw.split(',').collect();
    if parts.iter().any(|part| part.trim().is_empty()) {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" has an empty selector"
        )));
    }

    let mut selectors: Vec<Selector> = Vec::new();
    // The canonical spelling of every selector, in the order written.
    let mut canonical_parts: Vec<String> = Vec::new();

    for part in &parts {
        let text = part.trim();

        // A selector that opens `L<digit>` is a line range or a typo, never a name — read as a range
        // before anything else, so `L40-` reports the range rather than a path about a name nobody
        // meant.
        if let Some(range) = line_range_of(text)? {
            canonical_parts.push(text.to_string());
            selectors.push(Selector::Lines {
                raw: text.to_string(),
                from: range.from,
                to: range.to,
            });
            continue;
        }

        // A path is a name. What cannot even open a name — `@x` — names nothing; anything else is read
        // by the single-selector grammar, whose own errors quote the selector and are the ones a user
        // needs to see.
        if !starts_with_path(text) {
            return Err(SectionReferenceError::new(format!(
                "\"#{text}\" names nothing"
            )));
        }
        let parsed = crate::parse_reference(text)?;
        canonical_parts.push(parsed.canonical);
        selectors.push(Selector::Path {
            raw: text.to_string(),
            segments: parsed.segments,
            scope: parsed.scope,
        });
    }

    let canonical = canonical_parts.join(",");

    // A reference of one path selector carries a scope the resolver applies; a line range has none, and
    // a mixed reference resolves each selector with its own.
    let sole = if selectors.len() == 1 {
        selectors.first()
    } else {
        None
    };
    let scope = match sole {
        Some(Selector::Path { scope, .. }) => *scope,
        _ => Scope::Declaration,
    };
    let segments = match sole {
        Some(Selector::Path { segments, .. }) => segments.clone(),
        _ => Vec::new(),
    };

    Ok(Reference {
        raw: raw.to_string(),
        canonical,
        selectors,
        segments,
        scope,
    })
}

/// A **1-based inclusive** line range: where a slice of text came from, or one selector's own bounds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LineRange {
    pub from: usize,
    pub to: usize,
}

/// What a reference resolved to: the text, the parsed reference, the **1-based inclusive** line ranges
/// each contribution came from, and the matcher that found it.
#[derive(Clone, Debug)]
pub struct Plan {
    pub text: String,
    pub reference: Reference,
    /// The outermost bound of [`Plan::ranges`], so a host that only navigates once has one number.
    pub start_line: usize,
    pub end_line: usize,
    /// One range per contribution, in the order the selectors were written, with adjacent ones merged —
    /// so a reference that names two far-apart pieces highlights the two pieces and not the gap.
    pub ranges: Vec<LineRange>,
    /// The matcher that found the text: `region`, `declaration`, `property`, `condition`, `anchor`,
    /// `lines` for a line range, or `multiple` when the reference had several selectors.
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
        Hit {
            kind: kind.to_string(),
            block: Some(block.clone()),
            line,
            region: None,
        }
    }

    fn of_region(region: &Region) -> Self {
        Hit {
            kind: "region".to_string(),
            block: None,
            line: None,
            region: Some(region.clone()),
        }
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

/// Resolve a section reference to text, the line ranges it came from, and the matcher that found it.
///
/// A reference is one or more selectors (`add,L40-L44`): each contributes its own text, rendered under
/// its **own** scope, and the texts are joined with a newline in the order the selectors were written.
/// [`Plan::ranges`] says where each contribution came from and [`Plan::start_line`]/[`Plan::end_line`]
/// are the outermost bounds of the whole selection.
pub fn plan_section(text: &str, reference: &str, lexer: &dyn Lexer) -> Result<Plan, PlanError> {
    let parsed = parse_selectors(reference)?;
    let source = text.replace("\r\n", "\n");
    let scan = scan_blocks(&source, lexer)?;
    let source_units = units(&scan.lex.source);

    let mut parts: Vec<Part> = Vec::new();
    for selector in &parsed.selectors {
        match selector {
            Selector::Lines { raw, from, to } => {
                let picked = line_range_span(&scan.lex, *from, *to, raw)?;
                parts.push(Part {
                    text: picked.text,
                    kind: "lines".to_string(),
                    ranges: vec![picked.range],
                });
            }
            Selector::Path {
                segments, scope, ..
            } => {
                let found = resolve_path(segments, 0, &scan.root, false, None, &scan, lexer)?;
                parts.push(resolve_part(&found, *scope, &scan, lexer, &source_units)?);
            }
        }
    }

    let text = parts
        .iter()
        .map(|part| part.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let ranges = merge_ranges(&parts);
    let kind = if parts.len() == 1 {
        parts[0].kind.clone()
    } else {
        "multiple".to_string()
    };
    let start_line = ranges.iter().map(|range| range.from).min().unwrap_or(1);
    let end_line = ranges.iter().map(|range| range.to).max().unwrap_or(1);

    Ok(Plan {
        text,
        reference: parsed,
        start_line,
        end_line,
        ranges,
        kind,
    })
}

/// One selector's contribution: its text, the matcher that found it, and the lines it came from.
struct Part {
    text: String,
    kind: String,
    ranges: Vec<LineRange>,
}

/// One path selector's contribution: render the hit under the selector's own scope, then say which
/// lines the text came from.
///
/// The slice is not always the rendered text's own span: for a condition literal it is the header line
/// the matcher cites, and for a comment anchor it is the anchor line — the text and the place it came
/// from are two answers to two different questions.
fn resolve_part(
    found: &Hit,
    scope: Scope,
    scan: &Scan,
    lexer: &dyn Lexer,
    source_units: &[u16],
) -> Result<Part, PlanError> {
    let (rendered, kind, slice) = match &found.region {
        Some(region) => {
            let from = region.start_line + 1;
            let rendered = span(
                &slice(&scan.lex.source_lines, from, region.end_line),
                from,
                region.end_line,
            );
            // The region's own span is the rendered slice's: the directive lines are not part of it,
            // and the slice is exactly the lines between them.
            let slice = LineRange {
                from: rendered.from,
                to: rendered.to,
            };
            (rendered, "region".to_string(), slice)
        }
        None => {
            let block = found
                .block
                .clone()
                .ok_or_else(|| SectionError::new("a match without a block"))?;
            let rendered = render_block(&block, scope, &scan.lex, lexer, &found.kind);
            let kind = found.kind.clone();
            let slice = if kind == "condition" {
                // The header line the matcher cites leads the block's own first line.
                LineRange {
                    from: found.line.unwrap_or(0) + 1,
                    to: last_declaration_line(&block) + 1,
                }
            } else if kind == "anchor" {
                let anchor_line = {
                    let block_ref = block.borrow();
                    block_ref
                        .anchor
                        .as_ref()
                        .map(|anchor| anchor.line)
                        .unwrap_or(block_ref.decl_line)
                };
                LineRange {
                    from: anchor_line + 1,
                    to: last_declaration_line(&block) + 1,
                }
            } else {
                LineRange {
                    from: rendered.from,
                    to: rendered.to,
                }
            };
            (rendered, kind, slice)
        }
    };

    // A rendering may prepend a line of its own invention — the `if` of a condition literal, the header
    // of a chain segment — before the lines the reference names; the lead is the header line's own, and
    // only the rest of the text belongs to the lines that follow.
    let lead = head_lead(source_units, &scan.lex.starts, slice, &rendered.text);
    let ranges = slice_ranges(slice, &units(&rendered.text), lead);
    Ok(Part {
        text: rendered.text,
        kind,
        ranges,
    })
}

/// How many UTF-16 code units of `rendered` are the source's own lines for `slice`, or 0 when the
/// rendering prepends (or shortens) something of its own invention.
fn head_lead(source: &[u16], starts: &[usize], slice: LineRange, rendered: &str) -> usize {
    let head = source_slice(source, starts, slice);
    if units(rendered).starts_with(head) {
        head.len()
    } else {
        0
    }
}

/// `source.slice(starts[slice.from - 1], starts[slice.to])`, in UTF-16 code units. The last line of the
/// file has no start after it, and the slice then runs to the end.
fn source_slice<'a>(source: &'a [u16], starts: &[usize], slice: LineRange) -> &'a [u16] {
    let start = starts
        .get(slice.from.saturating_sub(1))
        .copied()
        .unwrap_or(0)
        .min(source.len());
    let end = starts
        .get(slice.to)
        .copied()
        .unwrap_or(source.len())
        .min(source.len());
    if start >= end {
        &source[start..start]
    } else {
        &source[start..end]
    }
}

/// Where one rendered slice came from: its line range, split in two when the rendering prepends a line
/// of its own invention before the lines the reference names.
fn slice_ranges(range: LineRange, text: &[u16], lead: usize) -> Vec<LineRange> {
    if lead == 0 || lead >= text.len() {
        return vec![range];
    }
    let lines_taken = text[lead..]
        .iter()
        .filter(|unit| **unit == b'\n' as u16)
        .count()
        + 1;
    vec![
        LineRange {
            from: range.from,
            to: range.from,
        },
        LineRange {
            from: (range.from + 1).max(range.to.saturating_sub(lines_taken).saturating_add(1)),
            to: range.to,
        },
    ]
}

/// The parts' ranges in order, merging the ones that touch or overlap.
fn merge_ranges(parts: &[Part]) -> Vec<LineRange> {
    let mut ranges: Vec<LineRange> = Vec::new();
    for part in parts {
        for range in &part.ranges {
            match ranges.last_mut() {
                Some(last) if range.from >= last.from && range.from <= last.to + 1 => {
                    last.to = last.to.max(range.to);
                }
                _ => ranges.push(*range),
            }
        }
    }
    ranges
}

/// The last line of a block's declaration, for the slices above.
fn last_declaration_line(block: &BlockRef) -> usize {
    let block = block.borrow();
    block
        .end_line
        .or(block.close_line)
        .unwrap_or(block.decl_line)
}

/// A line-range slice: its text, and the range it names.
struct PickedRange {
    text: String,
    range: LineRange,
}

/// The lines a line-range selector names, as text and as a span.
///
/// Lines are counted from 1 and columns from 1, both inclusive. A column is a character offset *within*
/// its line, in UTF-16 code units, as every offset in this port is. Anything the file does not have is an
/// error rather than a clamp — a range that silently became a different range is exactly the drift a
/// reference to a line number is for.
fn line_range_span(
    lex: &Lex,
    from: LinePoint,
    to: Option<LinePoint>,
    raw: &str,
) -> Result<PickedRange, SectionError> {
    let source_units = units(&lex.source);
    let from_line = from.line;
    let to_point = to.unwrap_or(from);
    let to_line = to_point.line;

    // `lines` is split on `\n`, so a file ending in a newline has a final empty entry: the file's last
    // line is the last entry that is not that emptiness.
    let total = if lex.source.is_empty() {
        0
    } else {
        lex.lines.len()
    };
    if from_line > total || to_line > total {
        return Err(SectionError::new(format!(
            "\"#{raw}\": the file has {total} line(s)"
        )));
    }

    let from_length = line_length(lex, from_line);
    if let Some(column) = from.column {
        if column - 1 >= from_length {
            return Err(SectionError::new(format!(
                "\"#{raw}\": line {from_line} has {from_length} character(s)"
            )));
        }
    }

    let start = lex.starts.get(from_line - 1).copied().unwrap_or(0)
        + from.column.map_or(0, |column| column - 1);
    let end = match to.and_then(|point| point.column) {
        Some(column) => {
            let to_length = line_length(lex, to_line);
            if column - 1 >= to_length {
                return Err(SectionError::new(format!(
                    "\"#{raw}\": line {to_line} has {to_length} character(s)"
                )));
            }
            // Both columns are inclusive, so the slice runs one past the character the second column
            // names.
            lex.starts.get(to_line - 1).copied().unwrap_or(0) + column
        }
        None => end_of_line(
            &source_units,
            lex.starts.get(to_line - 1).copied().unwrap_or(0),
        ),
    };

    Ok(PickedRange {
        text: slice_units(&lex.source, start, end),
        range: LineRange {
            from: from_line,
            to: to_line,
        },
    })
}

/// The length of one 1-based line, in UTF-16 code units.
fn line_length(lex: &Lex, line: usize) -> usize {
    lex.lines
        .get(line.saturating_sub(1))
        .map(Vec::len)
        .unwrap_or(0)
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
    Ok(Some(
        render_declaration(&chosen[0], scope, &scan.lex, lexer).text,
    ))
}

fn collect(scope: &BlockRef, name: &str, found: &mut Vec<BlockRef>) {
    let children: Vec<BlockRef> = scope.borrow().children.clone();
    for block in children {
        let (kind, block_name, body) = {
            let block_ref = block.borrow();
            (
                block_ref.kind.clone(),
                block_ref.name.clone(),
                has_body(&block_ref),
            )
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

/// Resolve `segments[index..]` starting at `scope`.
///
/// A name declared more than once at one level is **ambiguous**, and ambiguity is an error, never a
/// guess: `#add` must not inject the first of two `add`s, and `#Cart` must not inject the `struct`
/// when an `impl Cart` sits beside it.
///
/// What is *not* ambiguity is a name that several blocks share where the rest of the path decides: a
/// Rust `struct Cart` beside its `impl Cart` blocks all answer to `Cart`, and `Cart/add` is resolved
/// by retrying them in walk order — the one that holds `add` wins. Only a last segment, or a set of
/// candidates whose descents *all* succeed, is ambiguous.
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
            format!(
                "no section named \"{segment}\" in \"{}\"",
                prev_name.unwrap_or("")
            )
        })
        .into());
    }

    // The selection itself: nothing follows, so a second candidate is a second
    // answer and the reference does not say which one it wants.
    if last && candidates.len() > 1 {
        return Err(SectionError::new(format!(
            "\"{segment}\" is declared {} times; names must be unique",
            candidates.len()
        ))
        .into());
    }

    let mut failure: Option<PlanError> = None;
    let mut matched: Option<Hit> = None;
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
        let resolved = match resolve_path(
            segments,
            index + 1,
            &block,
            true,
            Some(&segment),
            scan,
            lexer,
        ) {
            Ok(hit) => hit,
            Err(error) => {
                failure.get_or_insert(error);
                continue;
            }
        };
        // Two candidates both holding the rest of the path is the same ambiguity
        // one level down: the path does not choose between them. Decided after
        // the match, because the error belongs to this frame, not that one.
        if matched.is_some() {
            return Err(SectionError::new(format!(
                "\"{segment}\" is declared {} times; names must be unique",
                candidates.len()
            ))
            .into());
        }
        matched = Some(resolved);
    }
    if let Some(hit) = matched {
        return Ok(hit);
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
            return Ok(named
                .iter()
                .map(|block| Hit::of("declaration", block, None))
                .collect());
        }
    }
    let properties = named(scope, "property", segment);
    if !properties.is_empty() {
        return Ok(properties
            .iter()
            .map(|block| Hit::of("property", block, None))
            .collect());
    }

    // 5 — condition literal: this scope's own condition, or a direct statement child.
    let own_conditions = {
        let scope_ref = scope.borrow();
        if scope_ref.kind == "statement" {
            scope_ref.conditions.clone()
        } else {
            None
        }
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
            (
                child_ref.kind.clone(),
                child_ref.conditions.clone(),
                child_ref.decl_line,
            )
        };
        if child_kind == "statement"
            && child_conditions.as_ref().is_some_and(|conditions| {
                conditions.pasted.iter().any(|literal| literal == segment)
            })
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
        let (decl_line, line_end, equals_at, statement_to) = {
            let block_ref = block.borrow();
            (
                block_ref.decl_line,
                block_ref.line_end.unwrap_or(block_ref.decl_line).max(block_ref.decl_line),
                block_ref.equals_at,
                block_ref.statement_to,
            )
        };
        if scope == Scope::Body {
            // `-` selects the initialiser expression: the bytes between the `=` that opens it and the
            // `;` that ends the statement. A member with no initialiser has an empty body, reported on
            // its own line.
            let (Some(equals), Some(statement_to)) = (equals_at, statement_to) else {
                return single(String::new(), decl_line);
            };
            if equals >= statement_to {
                return single(String::new(), decl_line);
            }
            return trimmed_slice(&lex.source, &lex.starts, equals + 1, statement_to);
        }
        // The statement's own last line is what the `+`/`++` scopes extend from, so a field takes its
        // `@Annotation` and its doc comment exactly as a method does — a field is a declaration too.
        block.borrow_mut().end_line = Some(line_end);
        return render_declaration(block, scope, lex, lexer);
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
            return span(
                &slice(&lex.source_lines, body_from + 1, close_line),
                body_from + 1,
                close_line,
            );
        }
        return single(String::new(), decl_line);
    }

    if shared_close {
        if let (Some(close), Some(line_start)) = (close, lex.starts.get(first_line).copied()) {
            let raw = slice_units(&lex.source, line_start, close + 1);
            let trimmed: Vec<String> = raw
                .split('\n')
                .map(|line| line.trim_end().to_string())
                .collect();
            return span(&trimmed, first_line, line_of(&lex.starts, close) + 1);
        }
    }
    span(
        &slice(&lex.source_lines, first_line, last_line + 1),
        first_line,
        last_line + 1,
    )
}

/// The text one declaration contributes, under one scope.
fn render_declaration(block: &BlockRef, scope: Scope, lex: &Lex, lexer: &dyn Lexer) -> Rendered {
    let (
        decl_line,
        close_line,
        end_line,
        single_line,
        indented,
        body_from,
        expression,
        expression_end_line,
        open_line,
        open,
        close,
    ) = {
        let block_ref = block.borrow();
        (
            block_ref.decl_line,
            block_ref.close_line,
            block_ref.end_line,
            block_ref.single_line,
            block_ref.indented,
            block_ref.body_from,
            block_ref.expression,
            block_ref.expression_end_line,
            block_ref.open_line,
            block_ref.open,
            block_ref.close,
        )
    };
    // An expression body carries the line its expression ends on; every other shape carries the line
    // its body closes on. A block with none of the three is a declaration with nothing to inject (a
    // body-less member), and its slice is **empty** rather than the declaration's own line.
    let end_line = expression_end_line.or(end_line).or(close_line);
    let to = end_line.map_or(1, |line| line + 1);

    if scope == Scope::Body {
        if single_line {
            return span(&slice(&lex.source_lines, decl_line, to), decl_line, to);
        }
        if indented {
            // A wrapped header's lines belong to the declaration, not the body, so the body starts
            // after the last of them.
            let first = body_from.unwrap_or(decl_line + 1);
            return span(&slice(&lex.source_lines, first, to), first, to);
        }
        if let Some(expression) = expression {
            let at = line_of(&lex.starts, expression);
            // The expression may be a block, whose lines the declaration's own indentation governs
            // (`main = do` then an indented body).
            let last = expression_end_line.unwrap_or(at);
            if last > at {
                return span(&slice(&lex.source_lines, at, last + 1), at, last);
            }
            let units = crate::mask::units(&lex.source);
            let line_end = end_of_line(&units, expression);
            let text = slice_units(&lex.source, expression, line_end);
            return single(text.trim(), at);
        }
        if open_line == end_line {
            let Some(open_line) = open_line else {
                // Neither an opening line nor an end line: nothing to inject, and the anchor is
                // the JavaScript's `null + 1` — the first line.
                return single(String::new(), 0);
            };
            if let (Some(open), Some(close)) = (open, close) {
                let text = slice_units(&lex.source, open + 1, close);
                return single(text.trim(), open_line);
            }
            return single(String::new(), open_line);
        }
        // `lines.slice(openLine + 1, endLine)`: the closing brace's line is not part of the body.
        let from = open_line.map_or(1, |line| line + 1);
        let to = end_line.unwrap_or(0);
        return span(&slice(&lex.source_lines, from, to), from, to);
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
    span(&slice(&lex.source_lines, start, to), start, to)
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
    Rendered {
        text: text.into(),
        from: at + 1,
        to: at + 1,
    }
}

/// The bytes strictly between two UTF-16 offsets of `source`, trimmed, with the line range the
/// trimmed text still covers — the JavaScript's `trimmedSlice`.
///
/// A slice that is trimmed has to answer for the lines the trim removed: a click on a body belongs to
/// its first real line, not to the blank line above it, and a slice that trims to nothing still
/// reports the line it would have started on rather than a range that runs backwards.
fn trimmed_slice(source: &str, starts: &[usize], from: usize, to: usize) -> Rendered {
    let raw = slice_units(source, from, to.max(from));
    let text = raw.trim().to_string();
    let at = crate::mask::line_of(starts, from.min(source.encode_utf16().count()));
    if text.is_empty() {
        return Rendered {
            text,
            from: at + 1,
            to: at + 1,
        };
    }
    let skipped = raw.len() - raw.trim_start().len();
    let dropped = raw.len() - raw.trim_end().len();
    let first = from + raw[..skipped].encode_utf16().count();
    let last = (from + raw[..raw.len() - dropped].encode_utf16().count()).saturating_sub(1);
    Rendered {
        text,
        from: crate::mask::line_of(starts, first) + 1,
        to: crate::mask::line_of(starts, last.max(first)) + 1,
    }
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
    if depth == 0 {
        start
    } else {
        usize::MAX
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::DefaultLexer;

    fn canonical(raw: &str) -> String {
        parse_selectors(raw)
            .expect("a well-formed reference")
            .canonical
    }

    /// The spelling the vectors do not carry: `canonical` is an answer the grammar owes, but the
    /// corpus pins errors only, so it is asserted here.
    #[test]
    fn a_selector_list_keeps_each_selectors_own_spelling() {
        assert_eq!("add/-,render/++", canonical("add/-,render/++"));
        assert_eq!("a,b,c", canonical("a,b,c"));
        assert_eq!(
            "add,L40:2-L40:8,remove",
            canonical("add,L40:2-L40:8,remove")
        );
        // A modifier is canonicalised to the end of the path it belongs to, and nowhere else.
        assert_eq!("a/b/-", canonical("a/b/-"));
        assert_eq!("Cart/Line/render/-", canonical("Cart/Line/render/-"));
        // A `-` is a name character: a hyphenated name and a CSS custom property keep their spelling.
        assert_eq!("item-list", canonical("item-list"));
        assert_eq!("--brand", canonical("--brand"));
    }

    #[test]
    fn the_old_trailing_and_leading_spellings_are_grammar_errors() {
        for (raw, message) in [
            (
                "getUsers++",
                "\"++\" is a path segment now; write \"#getUsers/++\"",
            ),
            (
                "getUsers+",
                "\"+\" is a path segment now; write \"#getUsers/+\"",
            ),
            (
                "+getUsers",
                "\"+\" is a path segment now; it follows the path, as \"#<path>/+\"",
            ),
        ] {
            assert_eq!(
                message,
                parse_selectors(raw)
                    .expect_err("the old spelling is gone")
                    .message()
            );
        }
    }

    #[test]
    fn every_selector_keeps_its_own_scope() {
        // Two selectors that each say what they mean: the earlier one's `-` is its own, so there is
        // nothing to merge and the last one keeps its `++`.
        let parsed = parse_selectors("add/-,render/++").expect("two selectors");
        assert_eq!("add/-,render/++", parsed.canonical);
        let scopes: Vec<&str> = parsed
            .selectors
            .iter()
            .map(|selector| match selector {
                Selector::Path { scope, .. } => scope.as_str(),
                Selector::Lines { .. } => "lines",
            })
            .collect();
        assert_eq!(vec!["body", "documented"], scopes);
        assert_eq!(
            Scope::Declaration,
            parsed.scope,
            "a mixed reference has no single scope"
        );
        assert!(
            parsed.segments.is_empty(),
            "only a sole path selector reports segments"
        );
    }

    #[test]
    fn a_range_takes_no_modifier() {
        let parsed = parse_selectors("L40-L44").expect("a range");
        assert_eq!("L40-L44", parsed.canonical);
        assert_eq!(Scope::Declaration, parsed.scope);
        assert!(matches!(parsed.selectors[0], Selector::Lines { .. }));

        // A line range takes no modifier anywhere: `L40/+` is not a range, and the range's own `-` is
        // spoken for, so neither is `L40-L44/-`.
        for raw in [
            "L40/+",
            "L40-L44/-",
            "L40-L44+",
            "L40-",
            "L40:x",
            "L0",
            "L44-L40",
        ] {
            assert!(
                parse_selectors(raw).is_err(),
                "{raw} is not a well-formed range"
            );
        }
        assert_eq!(None, line_range_of("Lx").expect("`Lx` is an ordinary name"));
        assert_eq!(None, line_range_of("add").expect("not a range prefix"));
    }

    #[test]
    fn the_same_modifier_twice_is_an_error() {
        for raw in ["a/+++", "a/---"] {
            let error = parse_selectors(raw).expect_err("two readings of one modifier");
            assert_eq!(
                format!("\"#{raw}\" carries more than one modifier"),
                error.message()
            );
        }
        // A modifier anywhere but the last segment is an error.
        for (raw, message) in [
            (
                "a/++/-",
                "\"++\" may only modify the last path segment of \"#a/++/-\"",
            ),
            (
                "a/-/b",
                "\"-\" may only modify the last path segment of \"#a/-/b\"",
            ),
            (
                "a/-/++",
                "\"-\" may only modify the last path segment of \"#a/-/++\"",
            ),
        ] {
            assert_eq!(
                message,
                parse_selectors(raw).expect_err("not last").message()
            );
        }
    }

    #[test]
    fn one_path_selector_reads_neither_a_list_nor_a_range() {
        assert_eq!(
            "\"#add,render\" has an empty selector",
            crate::parse_reference("add,render")
                .expect_err("a list is not one path")
                .message()
        );
        assert_eq!(
            "\"#L40\" is a line range, not a section path",
            crate::parse_reference("L40")
                .expect_err("a range is not a path")
                .message()
        );
    }

    /// The hard rule of this port: every offset counts UTF-16 code units, never `char`s. An astral
    /// character is where the two disagree — the emoji is one `char` and two code units.
    #[test]
    fn a_line_column_counts_utf16_code_units() {
        let source = "a\u{1F600}b\nsecond\n";
        let plan =
            plan_section(source, "L1:4", &DefaultLexer).expect("the last character of line 1");
        assert_eq!("b", plan.text);
        assert_eq!(LineRange { from: 1, to: 1 }, plan.ranges[0]);

        // Four code units, not three: a `char` count would accept column 4 and this column 5.
        let error = plan_section(source, "L1:5", &DefaultLexer).expect_err("past the line");
        assert_eq!("\"#L1:5\": line 1 has 4 character(s)", error.to_string());
    }

    #[test]
    fn a_line_range_is_verbatim_and_out_of_file_is_an_error() {
        let source = "one\ntwo\nthree\n";
        let plan = plan_section(source, "L2-L3", &DefaultLexer).expect("a range");
        assert_eq!("two\nthree", plan.text);
        assert_eq!(LineRange { from: 2, to: 3 }, plan.ranges[0]);
        assert_eq!((2, 3), (plan.start_line, plan.end_line));
        assert_eq!("lines", plan.kind);
        // A column is inclusive, and no column on the second endpoint means the end of that line.
        assert_eq!(
            "wo",
            plan_section(source, "L2:2-L2:3", &DefaultLexer)
                .expect("columns")
                .text
        );
        assert_eq!(
            "wo\nthree",
            plan_section(source, "L2:2-L3", &DefaultLexer)
                .expect("to line end")
                .text
        );

        // The file's lines are `["one","two","three",""]`: the trailing newline leaves an empty last
        // line, so line 5 is the first one past the file.
        let error = plan_section(source, "L5", &DefaultLexer).expect_err("past the end");
        assert_eq!("\"#L5\": the file has 4 line(s)", error.to_string());
        let error = plan_section(source, "L2:20", &DefaultLexer).expect_err("past the line");
        assert_eq!("\"#L2:20\": line 2 has 3 character(s)", error.to_string());
    }

    #[test]
    fn several_selectors_join_with_a_newline_and_keep_their_own_ranges() {
        let source = "one\ntwo\nthree\nfours\n";
        let plan = plan_section(source, "L1,L3", &DefaultLexer).expect("two ranges");
        assert_eq!("one\nthree", plan.text);
        assert_eq!("multiple", plan.kind);
        assert_eq!(
            vec![LineRange { from: 1, to: 1 }, LineRange { from: 3, to: 3 }],
            plan.ranges
        );
        assert_eq!((1, 3), (plan.start_line, plan.end_line));

        // Touching ranges are merged; a gap is not.
        let touching = plan_section(source, "L1,L2", &DefaultLexer).expect("touching");
        assert_eq!(vec![LineRange { from: 1, to: 2 }], touching.ranges);
        assert_eq!("one\ntwo", touching.text);
    }
}
