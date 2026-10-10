//! Part A of `lib/section.mjs`: the mask pass, and the string helpers the scanner and the resolver
//! share.
//!
//! The mask is the load-bearing idea of the whole matcher: the text with every comment and string
//! literal blanked to spaces, newlines kept, so a brace inside a string or a comment cannot be mistaken
//! for the end of a declaration's body. The **mask invariant** is the one hard contract a substituted
//! engine must keep — same length, every `\n` at the same offset — and it is asserted here, as the
//! JavaScript module asserts it, so a bad engine fails loudly instead of silently mislocating a brace.
//!
//! Indexing is by UTF-16 code unit, which is what the JavaScript does, so offsets and slicing agree
//! with it on any input. A Rust `char` is a scalar value, not a code unit, so the pass works over a
//! `Vec<u16>` and the entry points take and return `&str` only where that is lossless: `masked` returns
//! a `String` built from the blanked units, and the scanner works on that.

use crate::SectionError;

/// A comment-only span: its body (delimiters stripped) and where it sits in the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    pub text: String,
    pub from: usize,
    pub to: usize,
}

/// A string literal's span in the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringSpan {
    pub from: usize,
    pub to: usize,
    pub quote: String,
    pub multiline: bool,
}

/// The UTF-16 code units of `text`, which is what every offset in this port counts.
pub fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The text `units` spells, with any unpaired surrogate replaced — only reachable for input that was
/// never valid UTF-8, which a file read as a `String` cannot be.
pub fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `text` with every comment and string literal blanked to spaces, newlines kept.
///
/// `#` opens a line comment except before `[`, which keeps a Rust attribute (`#[derive(Debug)]`)
/// readable while hiding a Python or shell comment.
///
/// # Errors
///
/// Returns [`SectionError`] when the invariant is broken, which for this implementation cannot happen
/// and therefore means a bug here rather than in a caller.
pub fn masked(text: &str) -> Result<String, SectionError> {
    let source = units(text);
    let mut out = source.clone();
    let length = source.len();
    let mut i = 0;

    while i < length {
        let character = source[i];
        let next = if i + 1 < length { source[i + 1] } else { 0 };

        if character == b'/' as u16 && next == b'/' as u16 {
            let end = end_of_line(&source, i);
            blank(&mut out, i, end);
            i = end;
        } else if character == b'/' as u16 && next == b'*' as u16 {
            let end = match index_of(&source, &[b'*' as u16, b'/' as u16], i + 2) {
                Some(close) => close + 2,
                None => length,
            };
            blank(&mut out, i, end);
            i = end;
        } else if character == b'#' as u16 && next != b'[' as u16 {
            let end = end_of_line(&source, i);
            blank(&mut out, i, end);
            i = end;
        } else if character == b'"' as u16 || character == b'\'' as u16 || character == b'`' as u16
        {
            let triple = [character, character, character];
            let quote: Vec<u16> = if starts_with(&source, &triple, i) {
                triple.to_vec()
            } else {
                vec![character]
            };
            let mut j = i + quote.len();
            while j < length {
                if source[j] == b'\\' as u16 {
                    j += 2;
                    continue;
                }
                if starts_with(&source, &quote, j) {
                    j += quote.len();
                    break;
                }
                j += 1;
            }
            let end = j.min(length);
            blank(&mut out, i, end);
            i = end;
        } else {
            i += 1;
        }
    }

    if out.len() != source.len() {
        return Err(SectionError::new("masked length mismatch"));
    }
    for k in 0..length {
        if source[k] == b'\n' as u16 && out[k] != b'\n' as u16 {
            return Err(SectionError::new("newline offset mismatch"));
        }
    }
    Ok(from_units(&out))
}

/// Comment-only spans, in source order. Reads the original text — a comment cannot be recovered from
/// the mask — and does not report comment markers that sit inside string literals.
pub fn comments_in(text: &str) -> Vec<Comment> {
    let source = units(text);
    let mut result = Vec::new();
    let length = source.len();
    let mut i = 0;

    while i < length {
        let character = source[i];
        let next = if i + 1 < length { source[i + 1] } else { 0 };

        if character == b'/' as u16 && next == b'/' as u16 {
            let end = end_of_line(&source, i);
            result.push(Comment {
                text: from_units(&source[i + 2..end]),
                from: i,
                to: end,
            });
            i = end;
        } else if character == b'/' as u16 && next == b'*' as u16 {
            let close = index_of(&source, &[b'*' as u16, b'/' as u16], i + 2);
            let end = close.map_or(length, |at| at + 2);
            let body_end = close.unwrap_or(end);
            result.push(Comment {
                text: from_units(&source[i + 2..body_end]),
                from: i,
                to: end,
            });
            i = end;
        } else if character == b'"' as u16 || character == b'\'' as u16 || character == b'`' as u16
        {
            let triple = [character, character, character];
            let quote: Vec<u16> = if starts_with(&source, &triple, i) {
                triple.to_vec()
            } else {
                vec![character]
            };
            let mut j = i + quote.len();
            while j < length {
                if source[j] == b'\\' as u16 {
                    j += 2;
                    continue;
                }
                if starts_with(&source, &quote, j) {
                    j += quote.len();
                    break;
                }
                j += 1;
            }
            i = j.min(length);
        } else {
            i += 1;
        }
    }
    result
}

/// Blank `[from, to)` in place, never touching a newline.
pub(crate) fn blank(out: &mut [u16], from: usize, to: usize) {
    let end = to.min(out.len());
    for unit in out.iter_mut().take(end).skip(from) {
        if *unit != b'\n' as u16 {
            *unit = b' ' as u16;
        }
    }
}

/// Whether `needle` occurs in `haystack` at `at`.
pub(crate) fn starts_with(haystack: &[u16], needle: &[u16], at: usize) -> bool {
    at + needle.len() <= haystack.len() && haystack[at..at + needle.len()] == *needle
}

/// The offset of `needle` at or after `from`.
pub(crate) fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|at| starts_with(haystack, needle, *at))
}

/// The offset at which the line holding `offset` ends.
pub fn end_of_line(text: &[u16], offset: usize) -> usize {
    index_of(text, &[b'\n' as u16], offset).unwrap_or(text.len())
}

/// The line-start offsets of `text`, one per line.
pub fn line_starts(text: &[u16]) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, unit) in text.iter().enumerate() {
        if *unit == b'\n' as u16 {
            starts.push(i + 1);
        }
    }
    starts
}

/// The offset of the line `offset` falls on, given each line's start.
pub fn line_of(starts: &[usize], offset: usize) -> usize {
    let mut low = 0;
    let mut high = starts.len().saturating_sub(1);
    while low < high {
        let middle = (low + high + 1) >> 1;
        if starts[middle] <= offset {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    low
}

/// The index of the first non-blank line at or after `from`, or `None`.
pub fn next_non_blank(lines: &[String], from: usize) -> Option<usize> {
    (from..lines.len()).find(|at| !lines[*at].trim().is_empty())
}

/// The offset of the bracket that closes the one at `open`, or `None`.
pub fn matching_bracket(text: &[u16], open: usize, closer: u16) -> Option<usize> {
    let opener = text[open];
    let mut depth = 0i32;
    for i in open..text.len() {
        if text[i] == opener {
            depth += 1;
        } else if text[i] == closer {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// How far a line is indented.
pub fn indent_width(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// The balance of `()`, `[]` and `{}` on one line.
pub fn bracket_balance(line: &str) -> i32 {
    let mut depth = 0;
    for character in line.chars() {
        match character {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
    }
    depth
}
