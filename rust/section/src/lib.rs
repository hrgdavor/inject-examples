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
//!   scopes. Complete, and pinned by every grammar vector.
//! - [`mask`] and [`lexer`] — the mask pass (part A) and the language-engine
//!   seam, with the mask invariant asserted.
//! - [`tokenizer`], [`syntax`] and [`syntaxes`] — the one-pass tokenizer and the
//!   eighteen-entry language table, pinned by the lexical corpus.
//! - [`matchers`], [`span`] and [`block`] — the shape matchers, the body-span
//!   readers and the block tree, each unit-tested on its own.
//! - [`scanner`] — `scanBlocks`: the layer that composes them into a [`block::Scan`].
//! - [`resolver`] — resolution (`planSection`/`resolveSection`/`extractDeclaration`):
//!   the matcher walk, the per-selector scopes, the line ranges and the matcher
//!   kind the plan reports. Pinned by every resolution vector.

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

/// A failure that is not a malformed reference: the mask invariant was broken, the file cannot be
/// scanned, or a well-formed reference matched nothing.
///
/// Mirrors the plain `Error` the JavaScript module throws for these, so a caller can tell "you wrote the
/// reference wrong" ([`SectionReferenceError`]) from "the file does not have that" (this).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SectionError {
    message: String,
}

impl SectionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
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
/// vectors pin it byte for byte, because it is what a user is shown.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SectionReferenceError {
    message: String,
}

impl SectionReferenceError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
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
fn assert_name(segment: &str, raw: &str) -> Result<()> {
    if is_name(segment) {
        return Ok(());
    }
    if let Some(at) = segment.find('+') {
        let end = segment[at..]
            .find(|character| character != '+')
            .map_or(segment.len(), |offset| at + offset);
        let run = &segment[at..end];
        let before = &segment[..at];
        return Err(SectionReferenceError::new(if before.is_empty() {
            format!("\"{run}\" is a path segment now; it follows the path, as \"#<path>/{run}\"")
        } else {
            format!("\"{run}\" is a path segment now; write \"#{before}/{run}\"")
        }));
    }
    Err(SectionReferenceError::new(format!(
        "\"#{raw}\" names nothing"
    )))
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
        return Err(SectionReferenceError::new("\"#\" names nothing"));
    }
    if raw.contains(',') {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" has an empty selector"
        )));
    }
    // A reference names a section of one file, and the file is the path the
    // marker's link already carries. A second `#` is therefore never a nested
    // reference — it is a link written into the fragment by mistake, and reading
    // it as a name would send the reader to a section that cannot exist.
    if raw.contains('#') {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" has a second \"#\"; a reference names one file"
        )));
    }
    if resolver::is_line_range_prefix(raw) {
        resolver::line_range_of(raw)?; // fails when the spelling is malformed
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" is a line range, not a section path"
        )));
    }

    let parts: Vec<&str> = raw.split('/').collect();

    if parts.iter().any(|part| part.is_empty()) {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" has an empty path segment"
        )));
    }

    if parts.len() > 8 {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" is deeper than 8 sections"
        )));
    }

    let mut modifiers: Vec<&'static str> = Vec::new();
    let mut names: Vec<String> = Vec::new();

    for (index, segment) in parts.iter().enumerate() {
        if let Some(modifier) = segment_modifier(segment) {
            if index + 1 != parts.len() {
                return Err(SectionReferenceError::new(format!(
                    "\"{modifier}\" may only modify the last path segment of \"#{raw}\""
                )));
            }
            modifiers.push(modifier);
            continue;
        }
        // A segment of nothing but modifiers (`+++`, `---`) is two of them on one
        // segment. `--` and `--brand` are names: a CSS custom property is one.
        if is_modifier_run(segment) && *segment != "--" {
            return Err(SectionReferenceError::new(format!(
                "\"#{raw}\" carries more than one modifier"
            )));
        }
        assert_name(segment, raw)?;
        names.push(segment.to_string());
    }

    if names.is_empty() {
        // A path of modifiers has no subject: `-` is the old body scope, and
        // `++`/`+` name nothing at all. Say that rather than "more than one
        // modifier" about a single one.
        let why = if segment_modifier(raw).is_none() {
            format!("\"#{raw}\" carries more than one modifier")
        } else {
            format!("\"#{raw}\" names nothing")
        };
        return Err(SectionReferenceError::new(why));
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
