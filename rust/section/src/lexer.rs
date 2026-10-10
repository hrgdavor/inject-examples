//! The lexer seam: the language engine the scanner reads through, and the shapes it reports.
//!
//! The default engine — the language-agnostic mask and comment reader — is [`DefaultLexer`], which is
//! what an unknown file type gets, and the reason a reference resolves to the same bytes whether the
//! type is recognised or not.

use crate::mask::{comments_in, masked, Comment};

/// The two literal forms a condition header may carry: the byte-exact literal, and the token-pasted
/// form where adjacent literals (separated only by whitespace or `+`) join.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Conditions {
    pub exact: Vec<String>,
    pub pasted: Vec<String>,
}

/// A declaration shape a lexer reports on a masked line.
///
/// `kind` is `method` or `class`; `header_from` is the offset in the line where the declaration's body
/// starts; `body` is `Some("end")` when the body is closed by a terminator keyword line; `line` says the
/// declaration line is itself a complete selection when no body follows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    pub kind: String,
    pub name: String,
    pub header_from: usize,
    pub body: Option<String>,
    pub end: Option<String>,
    pub line: bool,
}

impl Declared {
    pub fn new(kind: &str, name: impl Into<String>, header_from: usize) -> Self {
        Self {
            kind: kind.to_string(),
            name: name.into(),
            header_from,
            body: None,
            end: None,
            line: false,
        }
    }

    /// A declaration whose body is a keyword-delimited block (Ruby's `end`, VB's `End`).
    pub fn closed_by(mut self, end: &str) -> Self {
        self.body = Some("end".to_string());
        self.end = Some(end.to_string());
        self
    }

    /// A declaration whose line is itself the selection (a Haskell binding).
    pub fn single_line(mut self) -> Self {
        self.line = true;
        self
    }
}

/// The language engine the scanner reads through.
///
/// Every method but [`Lexer::name`], [`Lexer::mask`] and [`Lexer::comments`] has a default, so a
/// language that needs only masking implements three methods and gets the generic shapes for the rest.
pub trait Lexer {
    /// The language name, as the registry reports it.
    fn name(&self) -> &str;

    /// The mask: same length, every `\n` at the same offset, comments and strings blanked.
    fn mask(&self, text: &str) -> Result<String, crate::SectionError>;

    /// The comment spans, in source order.
    fn comments(&self, text: &str) -> Vec<Comment>;

    /// The condition literals matcher 5 reads from a header line.
    fn condition_literals(&self, line: &str, from: usize) -> Conditions {
        condition_literals(line, from)
    }

    /// Declaration shapes this language adds to the generic ones.
    fn declarations(&self, _masked_line: &str) -> Vec<Declared> {
        Vec::new()
    }

    /// What counts as the annotation directly above a declaration, for the `+` scope.
    fn is_annotation_line(&self, line: &str) -> bool {
        crate::lexer::annotation_line(line)
    }
}

/// The built-in engine: the language-agnostic union of the comment and string spellings seen.
pub struct DefaultLexer;

impl Lexer for DefaultLexer {
    fn name(&self) -> &str {
        "default"
    }

    fn mask(&self, text: &str) -> Result<String, crate::SectionError> {
        masked(text)
    }

    fn comments(&self, text: &str) -> Vec<Comment> {
        comments_in(text)
    }
}

/// The double-quoted literals a header line carries, read from the original text with comments skipped.
pub fn condition_literals(orig_line: &str, from: usize) -> Conditions {
    let units: Vec<u16> = orig_line.encode_utf16().collect();
    let length = units.len();
    let mut literals: Vec<(usize, usize)> = Vec::new();
    let mut i = from.min(length);

    while i < length {
        let character = units[i];
        let next = if i + 1 < length { units[i + 1] } else { 0 };
        if character == b'/' as u16 && next == b'/' as u16 {
            break;
        }
        if character == b'/' as u16 && next == b'*' as u16 {
            i = crate::mask::index_of(&units, &[b'*' as u16, b'/' as u16], i + 2)
                .map_or(length, |at| at + 2);
            continue;
        }
        if character == b'"' as u16 {
            let mut j = i + 1;
            while j < length && units[j] != b'"' as u16 {
                if units[j] == b'\\' as u16 {
                    j += 1;
                }
                j += 1;
            }
            literals.push((i, j.min(length)));
            i = j + 1;
            continue;
        }
        i += 1;
    }

    let slice = |from: usize, to: usize| {
        let to = to.min(length);
        if from >= to {
            String::new()
        } else {
            String::from_utf16_lossy(&units[from..to])
        }
    };

    let exact = literals.iter().map(|(start, end)| slice(start + 1, *end)).collect();

    let mut pasted = Vec::new();
    let mut k = 0;
    while k < literals.len() {
        let mut merged = slice(literals[k].0 + 1, literals[k].1);
        let mut m = k + 1;
        while m < literals.len() {
            let gap = slice(literals[m - 1].1 + 1, literals[m].0);
            if !gap.chars().all(|c| c.is_whitespace() || c == '+') {
                break;
            }
            merged.push_str(&slice(literals[m].0 + 1, literals[m].1));
            m += 1;
        }
        pasted.push(merged);
        k = m;
    }

    Conditions { exact, pasted }
}

/// The default annotation test: `@Decorator` and `#[attribute]`, which is what the `+` scope takes when
/// a language's lexer supplies nothing more specific.
pub fn annotation_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('@') {
        return rest
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.');
    }
    trimmed.starts_with("#[")
}
