//! File-section matching — the Rust implementation of `doc/section-matching.md`.
//!
//! A `#<section-reference>` names a span of text inside a file: a declaration, a
//! body, an anchor, an `if` clause, or one nested inside another, written as a
//! `/`-separated path with an optional trailing modifier. `doc/section-matching.md`
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
//! - [`parse_reference`] — the reference grammar: path segments, the trailing
//!   modifier, the leading spellings, canonicalisation, and the contradiction
//!   warning. Complete, and pinned by every grammar and warning vector.
//! - [`mask`] and [`lexer`] — the mask pass (part A) and the language-engine
//!   seam, with the mask invariant asserted.
//!
//! Still to port, in the order the plan set lists them: the block scanner
//! (`scanBlocks`, part B), the per-language tokenizer and table, and resolution
//! (`resolveSection`/`extractDeclaration`, part C) with the line span and the
//! matcher kind the Java port reports. Until then the resolution vectors are
//! counted but not asserted — see `tests/vectors.rs`.

use std::fmt;

pub mod block;
pub mod lexer;
pub mod mask;
pub mod matchers;
pub mod span;
pub mod syntax;
pub mod syntaxes;
pub mod tokenizer;

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
        Self { message: message.into() }
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

/// A reference that carries contradictory modifiers: the positive one is kept and
/// the negative one is dropped, with a warning rather than an error.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Warning {
    pub kind: &'static str,
    pub kept: &'static str,
    pub dropped: &'static str,
    /// The reference as it should have been written.
    pub canonical: String,
    pub message: String,
}

/// A parsed section reference.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Reference {
    /// The text as it was given, without the `#`.
    pub raw: String,
    /// The normalised spelling, e.g. `Cart/Line/render-`.
    pub canonical: String,
    /// The path segments, with every modifier removed.
    pub segments: Vec<String>,
    pub scope: Scope,
    pub warning: Option<Warning>,
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

fn scope_from_modifier(modifier: Option<&str>) -> Scope {
    match modifier {
        Some("-") => Scope::Body,
        Some("+") => Scope::Annotated,
        Some("++") => Scope::Documented,
        _ => Scope::Declaration,
    }
}

/// Splits a run of `+`/`-` into modifiers, longest match first, and stops at
/// anything else. `+++` is `["++", "+"]`, which is two modifiers — and two
/// positive ones is an error, not a `++` followed by an ignored `+`.
fn tokenize_modifier_run(run: &str) -> Vec<&'static str> {
    let chars: Vec<char> = run.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '+' && chars[i + 1] == '+' {
            tokens.push("++");
            i += 2;
        } else if chars[i] == '+' {
            tokens.push("+");
            i += 1;
        } else if chars[i] == '-' {
            tokens.push("-");
            i += 1;
        } else {
            break;
        }
    }
    tokens
}

/// Reads a modifier written *before* a segment's name.
///
/// The asymmetry is the contract's, not an oversight: `-add` is a legal leading
/// spelling on the last segment of a path, while `+add`/`++add` are only legal as
/// the whole reference's detached prefix. `a/+b` is therefore an error where
/// `a/-b` is not.
fn extract_leading_modifier(
    segment: &str,
    is_last_segment: bool,
    raw: &str,
) -> Result<(Option<&'static str>, String)> {
    let chars: Vec<char> = segment.chars().collect();
    if chars.len() <= 1 {
        return Ok((None, segment.to_string()));
    }

    if chars[0] == '-' {
        if chars[1] == '-' || chars[1] == '+' {
            return Ok((None, segment.to_string()));
        }
        if is_last_segment {
            return Ok((Some("-"), chars[1..].iter().collect()));
        }
        return Err(SectionReferenceError::new(format!(
            "\"-\" may only modify the last path segment of \"#{raw}\""
        )));
    }

    if segment.starts_with("++") {
        let third = chars.get(2).copied();
        if third == Some('+') || third == Some('-') {
            return Ok((None, segment.to_string()));
        }
        return Err(SectionReferenceError::new(format!(
            "\"++\" may only modify the last path segment of \"#{raw}\""
        )));
    }

    if chars[0] == '+' {
        let second = chars.get(1).copied();
        if second == Some('+') || second == Some('-') {
            return Ok((None, segment.to_string()));
        }
        return Err(SectionReferenceError::new(format!(
            "\"+\" may only modify the last path segment of \"#{raw}\""
        )));
    }

    Ok((None, segment.to_string()))
}

/// Splits a segment into its name and the modifier run that trails it.
fn extract_trailing_modifier(name: &str) -> (String, Vec<&'static str>) {
    let chars: Vec<char> = name.chars().collect();
    let mut i = chars.len();
    while i > 0 && (chars[i - 1] == '+' || chars[i - 1] == '-') {
        i -= 1;
    }
    if i < chars.len() {
        let head: String = chars[..i].iter().collect();
        let run: String = chars[i..].iter().collect();
        (head, tokenize_modifier_run(&run))
    } else {
        (name.to_string(), Vec::new())
    }
}

/// Parses a section reference — the text after the `#`.
///
/// # Errors
///
/// Returns a [`SectionReferenceError`] whose message is part of the contract when
/// the reference is malformed: nothing named, an empty path segment, more than
/// eight segments, more than one modifier, or a modifier where it may not go.
pub fn parse_reference(raw: &str) -> Result<Reference> {
    if raw.is_empty() {
        return Err(SectionReferenceError::new("\"#\" names nothing"));
    }

    let mut detached: Option<&'static str> = None;
    let mut remainder = raw;

    if let Some(rest) = raw.strip_prefix("++") {
        detached = Some("++");
        remainder = rest;
    } else if let Some(rest) = raw.strip_prefix('+') {
        detached = Some("+");
        remainder = rest;
    } else if let Some(rest) = raw.strip_prefix('-') {
        detached = Some("-");
        remainder = rest;
    }

    if remainder.is_empty() {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" names nothing"
        )));
    }

    let mut parts: Vec<String> = remainder.split('/').map(str::to_string).collect();

    if parts.iter().any(String::is_empty) {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" has an empty path segment"
        )));
    }

    if parts.len() > 8 {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" is deeper than 8 sections"
        )));
    }

    // `Cart/-Line` is the two-segment spelling of `Cart/Line-`: the `-` belongs to
    // the reference, not to the name. It only applies to a two-segment path, and
    // only when the first segment carried no detached modifier of its own.
    let mut detached_second: Option<&'static str> = None;
    if detached.is_none() && parts.len() == 2 {
        let chars: Vec<char> = parts[1].chars().collect();
        if chars.len() > 1 && chars[0] == '-' && chars[1] != '-' && chars[1] != '+' {
            detached_second = Some("-");
            parts[1] = chars[1..].iter().collect();
        }
    }

    let mut all_modifiers: Vec<&'static str> = Vec::new();
    let mut clean_segments: Vec<String> = Vec::new();

    for (i, segment) in parts.iter().enumerate() {
        let is_last = i == parts.len() - 1;

        let (leading, after_leading) = extract_leading_modifier(segment, is_last, raw)?;
        if let Some(modifier) = leading {
            all_modifiers.push(modifier);
        }

        let (name, trailing) = extract_trailing_modifier(&after_leading);
        all_modifiers.extend(trailing);

        if name.contains('+') || name.contains('-') {
            // A bare name keeps the legacy meaning: a single-segment name may
            // contain a hyphen (`update-document-test`), because declaration and
            // anchor names do. Any `+`, or a hyphen inside a multi-segment path,
            // is structure rather than part of a name.
            let is_legacy_bare_name = parts.len() == 1
                && detached.is_none()
                && detached_second.is_none()
                && !name.contains('+');
            if !is_legacy_bare_name {
                let character = if name.contains('+') { '+' } else { '-' };
                return Err(SectionReferenceError::new(format!(
                    "\"{character}\" may only modify the last path segment of \"#{raw}\""
                )));
            }
        }

        clean_segments.push(name);
    }

    if clean_segments.iter().any(String::is_empty) {
        return Err(SectionReferenceError::new(format!(
            "\"#{raw}\" has an empty path segment"
        )));
    }

    if let Some(modifier) = detached {
        all_modifiers.insert(0, modifier);
    }
    if let Some(modifier) = detached_second {
        all_modifiers.insert(0, modifier);
    }

    let (modifier, warning) = match all_modifiers.len() {
        0 => (None, None),
        1 => (Some(all_modifiers[0]), None),
        _ => {
            let positive = all_modifiers.iter().filter(|m| m.starts_with('+')).count();
            let negative = all_modifiers.iter().filter(|m| m.starts_with('-')).count();
            if positive > 1 || negative > 1 {
                return Err(SectionReferenceError::new(format!(
                    "\"#{raw}\" carries more than one modifier"
                )));
            }
            // One `+` and one `-`: the positive one wins, and the user is told.
            let kept = if all_modifiers.contains(&"++") {
                "++"
            } else if all_modifiers.contains(&"+") {
                "+"
            } else {
                return Err(SectionReferenceError::new(format!(
                    "\"#{raw}\" carries more than one modifier"
                )));
            };
            (Some(kept), Some(kept))
        }
    };

    let scope = scope_from_modifier(modifier);
    let canonical = format!(
        "{}{}",
        clean_segments.join("/"),
        modifier.unwrap_or_default()
    );

    let warning = warning.map(|kept| Warning {
        kind: "contradiction",
        kept,
        dropped: "-",
        canonical: canonical.clone(),
        message: format!("\"{kept}\" contradicts \"-\"; using \"#{canonical}\""),
    });

    Ok(Reference {
        raw: raw.to_string(),
        canonical,
        segments: clean_segments,
        scope,
        warning,
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
