//! File-section matching — the Rust implementation of `doc/section-matching.md`.
//!
//! A `#<section-reference>` names a span of text inside a file: a declaration, a
//! body, an anchor, an `if` clause, or one nested inside another, written as a
//! `/`-separated path whose last segment may be a modifier. `doc/section-matching.md`
//! is the normative specification and `lib/section.mjs` is the authoritative
//! implementation; a port that disagrees with it is wrong by definition, so the
//! conformance vectors in `test/vectors/section-vectors.json` are the gate:
//!
//! ```text
//! cargo test
//! ```
//!
//! Like its JavaScript counterpart this crate is **pure**: text in, text out,
//! no filesystem, no environment, no editor types. Every entry point takes a
//! `&str` and returns a value or an error; the caller owns all I/O. That is what
//! lets it be vendored — or, here, be one implementation example among several.
//!
//! # What is ported so far
//!
//! - [`parse_reference`] and [`parse_selectors`] — the reference grammar: one
//!   path selector with its path segments and its whole-segment modifier (`++`,
//!   `+`, `-`), or a comma-separated list of selectors where a selector is a path
//!   or a line range (`L40:12-L44:3`), with canonicalisation and per-selector
//!   scopes. Complete, and pinned by every grammar vector — including the one the
//!   corpus marks `"parser": "path"`, which only [`parse_reference`] rejects.
//! - [`ErrorCode`] — the stable failure codes a host branches on, mirroring
//!   `ERROR_CODES` in `lib/section.mjs`: `grammar/…` on
//!   [`SectionReferenceError`], `resolution/…` on [`SectionError`], readable
//!   through `code()` on either (and on [`resolver::PlanError`]).
//! - [`mask`] and [`lexer`] — the mask pass (part A) and the language-engine
//!   seam, with the mask invariant asserted.
//! - [`tokenizer`], [`syntax`] and [`syntaxes`] — the one-pass tokenizer and the
//!   eighteen-entry language table, pinned by the lexical corpus.
//! - [`matchers`], [`span`] and [`block`] — the shape matchers, the body-span
//!   readers and the block tree, each unit-tested on its own.
//! - [`scanner`] — `scanBlocks`: the layer that composes them into a [`block::Scan`].
//! - [`resolver`] — resolution (`planSection`/`resolveSection`/`extractDeclaration`):
//!   the matcher walk, the per-selector scopes, the line ranges and the matcher
//!   kind the plan reports. Pinned by every resolution vector except the envelope
//!   (`^`/`$`) rows and the `Hash.py` region/condition/anchor rows — the two gaps
//!   the README's status table names.

use std::fmt;

pub mod block;
pub mod lexer;
pub mod mask;
pub mod matchers;
pub mod resolver;
pub mod scanner;
pub mod span;
pub mod syntax;
pub mod syntaxes;
pub mod tokenizer;

pub use resolver::{parse_selectors, LinePoint, Selector};

/// The stable failure codes of RFC 1 §3.6 and §5.3, mirroring `ERROR_CODES` in `lib/section.mjs`.
///
/// A code is part of the contract because both profiles branch on it — a jump gate fails what an editor
/// tolerates, and neither may decide that by matching message text. The prefix says where the failure was
/// found, which is the same distinction the RFC draws between its two error categories:
///
/// - `grammar/` — the reference is malformed as written and **no file was read**
///   ([`SectionReferenceError`]);
/// - `resolution/` — the reference is well formed, and the target (or the scan) is what cannot answer it
///   ([`SectionError`]).
///
/// The strings are the JavaScript ones byte for byte, and [`ErrorCode::as_str`] is the whole registry.
/// Like the JavaScript's, codes are added and never renamed: a message may be reworded without breaking a
/// caller, and only a code change is a breaking change for one that branches. Two of them —
/// [`ErrorCode::KeyDuplicated`] and [`ErrorCode::LexerMask`] — have no row any corpus can produce, so the
/// unit test beside this type is what pins their spelling.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ErrorCode {
    // grammar — malformed as written, before any file is consulted
    EmptyReference,
    EmptySelector,
    EmptySegment,
    TooDeep,
    SecondHash,
    LineRangeAsPath,
    LineRangeNotARange,
    LineRangeFrom1,
    LineRangeBackwards,
    ModifierNotLast,
    ModifierOldSpelling,
    TooManyModifiers,

    // resolution — well formed, and the file cannot answer it
    LineRangePastEnd,
    LineRangeColumnPastEnd,
    NotFound,
    Ambiguous,
    NotAContainer,
    RegionNotFound,
    RegionDuplicated,
    KeyDuplicated,
    EnvelopeAlone,
    EnvelopeOrder,
    EnvelopeMarks,
    EnvelopeMismatch,
    EnvelopeNoBlock,
    EnvelopeRegion,
    LexerMask,
}

impl ErrorCode {
    /// The namespaced code, exactly as `ERROR_CODES` spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::EmptyReference => "grammar/empty-reference",
            ErrorCode::EmptySelector => "grammar/empty-selector",
            ErrorCode::EmptySegment => "grammar/empty-segment",
            ErrorCode::TooDeep => "grammar/too-deep",
            ErrorCode::SecondHash => "grammar/second-hash",
            ErrorCode::LineRangeAsPath => "grammar/line-range-as-path",
            ErrorCode::LineRangeNotARange => "grammar/line-range-not-a-range",
            ErrorCode::LineRangeFrom1 => "grammar/line-range-from-1",
            ErrorCode::LineRangeBackwards => "grammar/line-range-backwards",
            ErrorCode::ModifierNotLast => "grammar/modifier-not-last",
            ErrorCode::ModifierOldSpelling => "grammar/modifier-old-spelling",
            ErrorCode::TooManyModifiers => "grammar/too-many-modifiers",

            ErrorCode::LineRangePastEnd => "resolution/line-range-past-end",
            ErrorCode::LineRangeColumnPastEnd => "resolution/line-range-column-past-end",
            ErrorCode::NotFound => "resolution/not-found",
            ErrorCode::Ambiguous => "resolution/ambiguous",
            ErrorCode::NotAContainer => "resolution/not-a-container",
            ErrorCode::RegionNotFound => "resolution/region-not-found",
            ErrorCode::RegionDuplicated => "resolution/region-duplicated",
            ErrorCode::KeyDuplicated => "resolution/key-duplicated",
            ErrorCode::EnvelopeAlone => "resolution/envelope-alone",
            ErrorCode::EnvelopeOrder => "resolution/envelope-order",
            ErrorCode::EnvelopeMarks => "resolution/envelope-marks",
            ErrorCode::EnvelopeMismatch => "resolution/envelope-mismatch",
            ErrorCode::EnvelopeNoBlock => "resolution/envelope-no-block",
            ErrorCode::EnvelopeRegion => "resolution/envelope-region",
            ErrorCode::LexerMask => "resolution/lexer-mask",
        }
    }

    /// Is this a `grammar/` code — a malformed reference, found before any file was read?
    pub fn is_grammar(self) -> bool {
        matches!(self.namespace(), "grammar")
    }

    /// The prefix before the `/`: `grammar` or `resolution`.
    fn namespace(self) -> &'static str {
        // Every code is namespaced, and the split is the RFC's error categories.
        self.as_str()
            .split_once('/')
            .map(|(namespace, _)| namespace)
            .unwrap_or("")
    }
}

/// A failure that is not a malformed reference: the mask invariant was broken, the file cannot be
/// scanned, or a well-formed reference matched nothing.
///
/// Mirrors the plain `Error` the JavaScript module throws for these, so a caller can tell "you wrote the
/// reference wrong" ([`SectionReferenceError`]) from "the file does not have that" (this). The
/// JavaScript carries a `code` on both kinds of failure; [`SectionError::code`] is that code, and
/// [`SectionError::new`] is the constructor for the two internal invariants that have no JavaScript
/// counterpart and therefore no code.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SectionError {
    message: String,
    code: Option<ErrorCode>,
}

impl SectionError {
    /// An error with no stable code: an internal invariant with no JavaScript counterpart. Every
    /// failure a reference can cause goes through [`SectionError::coded`].
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    /// An error carrying the stable code a host branches on.
    pub fn coded(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// The stable code, or `None` for an internal invariant (the JavaScript's `code === null`).
    pub fn code(&self) -> Option<ErrorCode> {
        self.code
    }
}

impl fmt::Display for SectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SectionError {}

/// The share of a match a modifier asks for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    /// The whole declaration (no modifier).
    Declaration,
    /// `-`: the body only.
    Body,
    /// `+`: the declaration with its annotations.
    Annotated,
    /// `++`: the declaration with its annotations and doc comment.
    Documented,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Declaration => "declaration",
            Scope::Body => "body",
            Scope::Annotated => "annotated",
            Scope::Documented => "documented",
        }
    }
}

/// A parsed section reference.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Reference {
    /// The text as it was given, without the `#`.
    pub raw: String,
    /// The normalised spelling, e.g. `Cart/Line/render/-` or `add/-,render/++`.
    pub canonical: String,
    /// The selectors, in the order written: one for a single path or a single line
    /// range, several when the reference is comma-separated. [`parse_reference`]
    /// reads one path selector and leaves this empty.
    pub selectors: Vec<Selector>,
    /// The path segments, with every modifier removed: the last path selector's
    /// segments, or none for a line range and for a mixed reference.
    pub segments: Vec<String>,
    pub scope: Scope,
}

impl Reference {
    pub fn is_single_segment(&self) -> bool {
        self.segments.len() == 1
    }

    pub fn final_segment(&self) -> &str {
        self.segments.last().map(String::as_str).unwrap_or("")
    }
}

/// A malformed section reference. The message is part of the contract: the
/// vectors pin it byte for byte, because it is what a user is shown. The code beside it is the other
/// half of the contract — the one a host branches on — and [`SectionReferenceError::code`] is it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SectionReferenceError {
    message: String,
    code: Option<ErrorCode>,
}

impl SectionReferenceError {
    /// An error with no stable code, for the one grammar site the JavaScript leaves uncoded (a
    /// multi-modifier path, which its own path reader rejects before it could be reached).
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    /// A grammar failure carrying the code `ERROR_CODES` gives it.
    pub fn coded(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// The stable code, or `None` for the site the JavaScript leaves uncoded.
    pub fn code(&self) -> Option<ErrorCode> {
        self.code
    }
}

impl fmt::Display for SectionReferenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SectionReferenceError {}

pub type Result<T> = std::result::Result<T, SectionReferenceError>;

pub(crate) fn scope_from_modifier(modifier: Option<&str>) -> Scope {
    match modifier {
        Some("-") => Scope::Body,
        Some("+") => Scope::Annotated,
        Some("++") => Scope::Documented,
        _ => Scope::Declaration,
    }
}

/// The modifier a path **segment** is, or `None` when the segment is a name.
///
/// A modifier is a segment of its own, written after the `/` that delimits it,
/// and it is legal only as the **last** segment of a path. Writing it as part of
/// a name is not a spelling of the same thing any more: the name is matched as
/// the file spells it, so a `toString++` is the name `toString++`, which no file
/// declares.
///
/// `-` is a modifier only as the whole segment. `--` and `--brand` are names,
/// which is what keeps a CSS custom property and a hyphenated identifier
/// addressable; a run of three or more `+` is neither, and is rejected.
fn segment_modifier(segment: &str) -> Option<&'static str> {
    match segment {
        "++" => Some("++"),
        "+" => Some("+"),
        "-" => Some("-"),
        _ => None,
    }
}

/// A name character: a `-` is one, a `+` never is.
fn is_name(segment: &str) -> bool {
    !segment.is_empty()
        && segment.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '$' | '.' | '-')
        })
}

/// A segment that is nothing but modifier characters (`--`, `---`, `+++`).
fn is_modifier_run(segment: &str) -> bool {
    segment.chars().count() >= 2
        && segment
            .chars()
            .all(|character| character == '+' || character == '-')
}

/// Reject a name this grammar cannot carry, with the message that says why.
///
/// `+` has no meaning inside a name at all, and the only thing a user means by it
/// is a modifier — so the message names the spelling that works rather than
/// leaving them with "names nothing". A `+` that *opens* a segment is the old
/// prefix form (`+toString`), whose replacement has the path before it.
///
/// A whole envelope mark (`^`, `$`) is not a name but is a legal last segment,
/// which `carries_mark` allows; `^` anywhere earlier is the "names nothing" error,
/// because there is no parent for it to open.
fn assert_name(segment: &str, raw: &str, carries_mark: bool) -> Result<()> {
    if is_name(segment) {
        return Ok(());
    }
    if carries_mark && resolver::envelope_mark(segment).is_some() {
        return Ok(());
    }
    if let Some(at) = segment.find('+') {
        let end = segment[at..]
            .find(|character| character != '+')
            .map_or(segment.len(), |offset| at + offset);
        let run = &segment[at..end];
        let before = &segment[..at];
        return Err(SectionReferenceError::coded(
            ErrorCode::ModifierOldSpelling,
            if before.is_empty() {
                format!(
                    "\"{run}\" is a path segment now; it follows the path, as \"#<path>/{run}\""
                )
            } else {
                format!("\"{run}\" is a path segment now; write \"#{before}/{run}\"")
            },
        ));
    }
    Err(SectionReferenceError::coded(
        ErrorCode::EmptySegment,
        format!("\"#{raw}\" names nothing"),
    ))
}

/// Combine the modifier tokens one path carries into the single modifier it has,
/// or fail when they cannot be combined.
///
/// Two modifiers on one path is malformed rather than contradictory: there is no
/// section that is two scopes at once.
fn merge_modifiers(modifiers: &[&'static str], raw: &str) -> Result<Option<&'static str>> {
    match modifiers {
        [] => Ok(None),
        [modifier] => Ok(Some(*modifier)),
        // Unreachable through the path reader, which rejects a modifier before the last segment first,
        // and uncoded in the JavaScript for the same reason.
        _ => Err(SectionReferenceError::new(format!(
            "\"#{raw}\" carries more than one modifier"
        ))),
    }
}

/// Parses a section reference — the text after the `#` — as **one path selector**.
///
/// The whole-reference grammar is [`parse_selectors`], which reads a comma-separated
/// list of selectors and is the entry point the corpus is held to. This reader stays
/// because a port that wants one path, and not a list, still needs it: it refuses a
/// comma and a line range as the different things they are.
///
/// A modifier is a whole segment and is legal only as the **last** one:
/// `toString/++` is the documented method, `toString/-` its body, `getUsers/+` the
/// method with its annotations. A name may contain `-` (`item-list`) but never `+`.
///
/// # Errors
///
/// Returns a [`SectionReferenceError`] whose message is part of the contract when
/// the reference is malformed: nothing named, an empty path segment, more than
/// eight segments, more than one modifier, a modifier where it may not go, a comma
/// (a list belongs to [`parse_selectors`]), or a line range (`L40` is not a path).
pub fn parse_reference(raw: &str) -> Result<Reference> {
    if raw.is_empty() {
        return Err(SectionReferenceError::coded(
            ErrorCode::EmptyReference,
            "\"#\" names nothing",
        ));
    }
    if raw.contains(',') {
        return Err(SectionReferenceError::coded(
            ErrorCode::EmptySelector,
            format!("\"#{raw}\" has an empty selector"),
        ));
    }
    // A reference names a section of one file, and the file is the path the
    // marker's link already carries. A second `#` is therefore never a nested
    // reference — it is a link written into the fragment by mistake, and reading
    // it as a name would send the reader to a section that cannot exist.
    if raw.contains('#') {
        return Err(SectionReferenceError::coded(
            ErrorCode::SecondHash,
            format!("\"#{raw}\" has a second \"#\"; a reference names one file"),
        ));
    }
    if resolver::is_line_range_prefix(raw) {
        resolver::line_range_of(raw)?; // fails when the spelling is malformed
        return Err(SectionReferenceError::coded(
            ErrorCode::LineRangeAsPath,
            format!("\"#{raw}\" is a line range, not a section path"),
        ));
    }

    let parts: Vec<&str> = raw.split('/').collect();

    if parts.iter().any(|part| part.is_empty()) {
        return Err(SectionReferenceError::coded(
            ErrorCode::EmptySegment,
            format!("\"#{raw}\" has an empty path segment"),
        ));
    }

    if parts.len() > 8 {
        return Err(SectionReferenceError::coded(
            ErrorCode::TooDeep,
            format!("\"#{raw}\" is deeper than 8 sections"),
        ));
    }

    let mut modifiers: Vec<&'static str> = Vec::new();
    let mut names: Vec<String> = Vec::new();

    for (index, segment) in parts.iter().enumerate() {
        if let Some(modifier) = segment_modifier(segment) {
            if index + 1 != parts.len() {
                return Err(SectionReferenceError::coded(
                    ErrorCode::ModifierNotLast,
                    format!("\"{modifier}\" may only modify the last path segment of \"#{raw}\""),
                ));
            }
            modifiers.push(modifier);
            continue;
        }
        // A segment of nothing but modifiers (`+++`, `---`) is two of them on one
        // segment. `--` and `--brand` are names: a CSS custom property is one.
        if is_modifier_run(segment) && *segment != "--" {
            return Err(SectionReferenceError::coded(
                ErrorCode::TooManyModifiers,
                format!("\"#{raw}\" carries more than one modifier"),
            ));
        }
        assert_name(segment, raw, index + 1 == parts.len())?;
        names.push(segment.to_string());
    }

    if names.is_empty() {
        // A path of modifiers has no subject: `-` is the old body scope, and
        // `++`/`+` name nothing at all. Say that rather than "more than one
        // modifier" about a single one.
        let more_than_one = segment_modifier(raw).is_none();
        let why = if more_than_one {
            format!("\"#{raw}\" carries more than one modifier")
        } else {
            format!("\"#{raw}\" names nothing")
        };
        return Err(SectionReferenceError::coded(
            if more_than_one {
                ErrorCode::TooManyModifiers
            } else {
                ErrorCode::EmptySegment
            },
            why,
        ));
    }

    let merged = merge_modifiers(&modifiers, raw)?;
    let scope = scope_from_modifier(merged);
    let canonical = match merged {
        Some(modifier) => format!("{}/{modifier}", names.join("/")),
        None => names.join("/"),
    };

    Ok(Reference {
        raw: raw.to_string(),
        canonical,
        selectors: Vec::new(),
        segments: names,
        scope,
    })
}

/// The convenience the JavaScript module exports as `isSingleSegment`.
pub fn is_single_segment(reference: &Reference) -> bool {
    reference.is_single_segment()
}

/// The convenience the JavaScript module exports as `finalSegment`.
pub fn final_segment(reference: &Reference) -> &str {
    reference.final_segment()
}

#[cfg(test)]
mod codes {
    use super::ErrorCode;

    /// The registry, spelled out: the corpus pins the codes its rows reach, and this pins the whole
    /// table — including `resolution/key-duplicated` (the data-format rules' own code) and
    /// `resolution/lexer-mask` (an engine defect), neither of which any corpus row can produce. Without
    /// this, a rename in `ErrorCode::as_str` could go unnoticed exactly where no vector looks.
    #[test]
    fn every_code_spells_what_error_codes_spells() {
        let registry: &[(ErrorCode, &str)] = &[
            (ErrorCode::EmptyReference, "grammar/empty-reference"),
            (ErrorCode::EmptySelector, "grammar/empty-selector"),
            (ErrorCode::EmptySegment, "grammar/empty-segment"),
            (ErrorCode::TooDeep, "grammar/too-deep"),
            (ErrorCode::SecondHash, "grammar/second-hash"),
            (ErrorCode::LineRangeAsPath, "grammar/line-range-as-path"),
            (
                ErrorCode::LineRangeNotARange,
                "grammar/line-range-not-a-range",
            ),
            (ErrorCode::LineRangeFrom1, "grammar/line-range-from-1"),
            (
                ErrorCode::LineRangeBackwards,
                "grammar/line-range-backwards",
            ),
            (ErrorCode::ModifierNotLast, "grammar/modifier-not-last"),
            (
                ErrorCode::ModifierOldSpelling,
                "grammar/modifier-old-spelling",
            ),
            (ErrorCode::TooManyModifiers, "grammar/too-many-modifiers"),
            (
                ErrorCode::LineRangePastEnd,
                "resolution/line-range-past-end",
            ),
            (
                ErrorCode::LineRangeColumnPastEnd,
                "resolution/line-range-column-past-end",
            ),
            (ErrorCode::NotFound, "resolution/not-found"),
            (ErrorCode::Ambiguous, "resolution/ambiguous"),
            (ErrorCode::NotAContainer, "resolution/not-a-container"),
            (ErrorCode::RegionNotFound, "resolution/region-not-found"),
            (ErrorCode::RegionDuplicated, "resolution/region-duplicated"),
            (ErrorCode::KeyDuplicated, "resolution/key-duplicated"),
            (ErrorCode::EnvelopeAlone, "resolution/envelope-alone"),
            (ErrorCode::EnvelopeOrder, "resolution/envelope-order"),
            (ErrorCode::EnvelopeMarks, "resolution/envelope-marks"),
            (ErrorCode::EnvelopeMismatch, "resolution/envelope-mismatch"),
            (ErrorCode::EnvelopeNoBlock, "resolution/envelope-no-block"),
            (ErrorCode::EnvelopeRegion, "resolution/envelope-region"),
            (ErrorCode::LexerMask, "resolution/lexer-mask"),
        ];

        for (code, spelling) in registry {
            assert_eq!(code.as_str(), *spelling, "{code:?}");
        }

        // The namespaced prefix is the RFC's own split: a grammar failure was found before any file
        // was read, a resolution failure by the file itself.
        for (code, spelling) in registry {
            let grammar = spelling.starts_with("grammar/");
            assert_eq!(code.is_grammar(), grammar, "{spelling}");
        }
    }
}
