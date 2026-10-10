//! The one-pass tokenizer: `src/js/scanner/tokenizer.js` in Rust.
//!
//! It produces the two facts the resolver's lexer seam needs — a blanked mask and the comment spans —
//! from a language's comment and string syntax, and it is adapted into a [`Lexer`] by [`lexer`]. It owns
//! **nothing structural**: no braces are matched here, no blocks are built, no precedence applied.
//!
//! Everything is expressed over UTF-16 code units, as the JavaScript does, so offsets agree with it on
//! any input.
//!
//! The JavaScript and Java tables describe a language's extra declaration shapes with regular
//! expressions. This port has no regex engine by design (the library is dependency-free), so those
//! shapes are hand-written matchers below, one per [`Shape`] variant. The behaviour is what must agree
//! across the ports.

use std::cell::RefCell;

use crate::lexer::{annotation_line, Declared, Lexer};
use crate::mask::{blank, end_of_line, from_units, index_of, starts_with, units, Comment, StringSpan};
use crate::syntax::{Annotation, Content, Escape, Heredoc, Shape, StringKind, Syntax};
use crate::SectionError;

/// What one pass produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    pub masked: String,
    pub comments: Vec<Comment>,
    pub strings: Vec<StringSpan>,
}

/// A boundary-prefixed opener may not follow an identifier character.
fn is_identifier_unit(unit: u16) -> bool {
    let character = unit as u8 as char;
    character.is_ascii_alphanumeric() || character == '_' || character == '$'
}
/// One lexical pass: blanks comments and strings to spaces, collects the comment spans, and reports the
/// string spans. Length and every newline offset are preserved.
pub fn tokenize(source: &str, syntax: &Syntax) -> Result<Facts, SectionError> {
    let text = units(source);
    let mut out = text.clone();
    let mut comments: Vec<Comment> = Vec::new();
    let mut strings: Vec<StringSpan> = Vec::new();
    let length = text.len();

    let mut i = 0;
    while i < length {
        let character = text[i];
        if character == b'\n' as u16 {
            i += 1;
            continue;
        }

        // Heredocs first: their body spans lines, and `<<` opens nothing else.
        if syntax.heredoc != Heredoc::None && starts_with(&text, &[b'<' as u16, b'<' as u16], i) {
            if let Some(hit) = match_heredoc(&text, i, syntax.heredoc) {
                let open_end = end_of_line(&text, i);
                let end = heredoc_end(&text, open_end + 1, &hit.tag);
                blank(&mut out, open_end + 1, end);
                i = end;
                continue;
            }
        }

        let mut matched = false;
        for open in &syntax.line_comments {
            let needle = units(open);
            // `#[attr]` is an attribute in Rust and PHP, never a `#` comment.
            if open == "#" && i + 1 < length && text[i + 1] == b'[' as u16 {
                continue;
            }
            if !starts_with(&text, &needle, i) {
                continue;
            }
            let end = end_of_line(&text, i);
            comments.push(Comment { text: from_units(&text[i + needle.len()..end]), from: i, to: end });
            blank(&mut out, i, end);
            i = end;
            matched = true;
            break;
        }
        if matched {
            continue;
        }

        let mut block: Option<&crate::syntax::BlockComment> = None;
        for candidate in &syntax.block_comments {
            let needle = units(&candidate.open);
            if !starts_with(&text, &needle, i) {
                continue;
            }
            if candidate.line_start && i != 0 && text[i - 1] != b'\n' as u16 {
                continue;
            }
            block = Some(candidate);
            break;
        }
        if let Some(block) = block {
            let read = read_block_comment(&text, i, block);
            comments.push(Comment { text: read.body, from: i, to: read.to });
            blank(&mut out, i, read.to);
            i = read.to;
            continue;
        }

        if let Some(hit) = match_string(&text, i, &syntax.strings) {
            if let Some(to) = read_string(&text, &hit) {
                strings.push(StringSpan {
                    from: i,
                    to,
                    quote: hit.kind.open.clone(),
                    multiline: hit.kind.multiline,
                });
                blank(&mut out, i, to);
                i = to;
                continue;
            }
        }

        i += 1;
    }

    Ok(Facts { masked: from_units(&out), comments, strings })
}

/// A lexer adapter for the resolver: the [`Lexer`] shape the scanner wants, memoised on the last source
/// so one scan pays for `mask` and `comments` together. The language's own declaration shapes and
/// annotation test ride along.
pub struct SyntaxLexer {
    syntax: Syntax,
    cache: RefCell<Option<(String, Facts)>>,
}

/// The lexer for `syntax`, ready to hand to the scanner.
pub fn lexer(syntax: Syntax) -> SyntaxLexer {
    SyntaxLexer { syntax: syntax.normalised(), cache: RefCell::new(None) }
}

impl SyntaxLexer {
    /// The syntax this lexer walks, normalised.
    pub fn syntax(&self) -> &Syntax {
        &self.syntax
    }

    fn with_facts<T>(&self, text: &str, use_facts: impl FnOnce(&Facts) -> T) -> Result<T, SectionError> {
        if let Some((cached_source, facts)) = self.cache.borrow().as_ref() {
            if cached_source == text {
                return Ok(use_facts(facts));
            }
        }
        let facts = tokenize(text, &self.syntax)?;
        let result = use_facts(&facts);
        *self.cache.borrow_mut() = Some((text.to_string(), facts));
        Ok(result)
    }
}

impl Lexer for SyntaxLexer {
    fn name(&self) -> &str {
        &self.syntax.name
    }

    fn mask(&self, text: &str) -> Result<String, SectionError> {
        self.with_facts(text, |facts| facts.masked.clone())
    }

    fn comments(&self, text: &str) -> Vec<Comment> {
        self.with_facts(text, |facts| facts.comments.clone()).unwrap_or_else(|_| Vec::new())
    }

    fn declarations(&self, masked_line: &str) -> Vec<Declared> {
        let mut out = Vec::new();
        for shape in &self.syntax.shapes {
            if let Some(declared) = match_shape(*shape, masked_line) {
                out.push(declared);
            }
        }
        out
    }

    fn is_annotation_line(&self, line: &str) -> bool {
        match self.syntax.annotation {
            Annotation::Default => annotation_line(line),
            Annotation::NameSignature => is_name_signature(line),
        }
    }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

struct BlockRead {
    to: usize,
    body: String,
}

fn read_block_comment(text: &[u16], i: usize, block: &crate::syntax::BlockComment) -> BlockRead {
    let open = units(&block.open);
    let close = units(&block.close);
    if !block.nested {
        let (to, body_end) = match index_of(text, &close, i + open.len()) {
            Some(at) => (at + close.len(), at),
            None => (text.len(), text.len()),
        };
        return BlockRead { to, body: from_units(&text[i + open.len()..body_end]) };
    }

    let mut depth = 0i32;
    let mut j = i;
    let body_start = i + open.len();
    while j < text.len() {
        if starts_with(text, &open, j) {
            depth += 1;
            j += open.len();
            continue;
        }
        if starts_with(text, &close, j) {
            depth -= 1;
            j += close.len();
            if depth == 0 {
                break;
            }
            continue;
        }
        j += 1;
    }
    let body_end = j.saturating_sub(close.len()).max(body_start);
    BlockRead { to: j, body: from_units(&text[body_start..body_end]) }
}

struct HeredocHit {
    tag: String,
    #[allow(dead_code)]
    length: usize,
}

fn is_tag_start(unit: Option<u16>) -> bool {
    unit.is_some_and(|u| {
        let c = u as u8 as char;
        c.is_ascii_alphabetic() || c == '_'
    })
}

fn is_tag_char(unit: Option<u16>) -> bool {
    unit.is_some_and(|u| {
        let c = u as u8 as char;
        c.is_ascii_alphanumeric() || c == '_'
    })
}

/// `<<TAG`, `<<-TAG`, `<<~TAG`, `<<"TAG"` and PHP's `<<<TAG`, matched by hand.
fn match_heredoc(text: &[u16], at: usize, mode: Heredoc) -> Option<HeredocHit> {
    let end = (at + 64).min(text.len());
    let window = &text[at..end];
    if !starts_with(window, &[b'<' as u16, b'<' as u16], 0) {
        return None;
    }
    let mut i = 2;
    if window.get(i) == Some(&(b'<' as u16)) {
        i += 1;
    }
    let mut strip = false;
    if let Some(unit) = window.get(i) {
        if *unit == b'-' as u16 || *unit == b'~' as u16 {
            strip = true;
            i += 1;
        }
    }
    let mut quote = 0u16;
    if let Some(unit) = window.get(i) {
        if *unit == b'"' as u16 || *unit == b'\'' as u16 || *unit == b'`' as u16 {
            quote = *unit;
            i += 1;
        }
    }
    if !is_tag_start(window.get(i).copied()) {
        return None;
    }
    let tag_start = i;
    while is_tag_char(window.get(i).copied()) {
        i += 1;
    }
    let tag = from_units(&window[tag_start..i]);
    if quote != 0 {
        if window.get(i) != Some(&quote) {
            return None;
        }
        i += 1;
    }
    if mode == Heredoc::Strict && !strip && quote == 0 {
        return None;
    }
    Some(HeredocHit { tag, length: i })
}

/// The offset that ends the heredoc body: the terminator line's end of line.
fn heredoc_end(text: &[u16], from: usize, tag: &str) -> usize {
    let bracket = format!("{tag};");
    let mut i = from;
    while i <= text.len() {
        let eol = end_of_line(text, i);
        let line = from_units(&text[i..eol]);
        let trimmed = line.trim();
        if trimmed == tag || trimmed == bracket {
            return eol;
        }
        if eol >= text.len() {
            return text.len();
        }
        i = eol + 1;
    }
    text.len()
}

struct StringHit<'a> {
    kind: &'a StringKind,
    body_from: usize,
    close: Vec<u16>,
}

/// The string kind that opens at `i`, with the opener length and the closer it implies, or `None`. A
/// `hashes` kind (Rust raw string) reads its own closer: `r#"` closes at `"#`.
fn match_string<'a>(text: &[u16], i: usize, kinds: &'a [StringKind]) -> Option<StringHit<'a>> {
    for kind in kinds {
        if kind.boundary && i > 0 && is_identifier_unit(text[i - 1]) {
            continue;
        }
        if kind.hashes {
            let opener = units(&kind.open);
            let prefix = &opener[..opener.len() - 1];
            if !starts_with(text, prefix, i) {
                continue;
            }
            let mut j = i + prefix.len();
            let mut hashes = 0;
            while j < text.len() && text[j] == b'#' as u16 {
                hashes += 1;
                j += 1;
            }
            if j >= text.len() || text[j] != b'"' as u16 {
                continue;
            }
            let mut close = vec![b'"' as u16];
            close.extend(std::iter::repeat(b'#' as u16).take(hashes));
            return Some(StringHit { kind, body_from: j + 1, close });
        }
        let opener = units(&kind.open);
        if starts_with(text, &opener, i) {
            return Some(StringHit { kind, body_from: i + opener.len(), close: units(&kind.close) });
        }
    }
    None
}

/// The end offset of the string `hit` opens, or `None` when the candidate is not a string after all (a
/// Rust lifetime, a char literal that never closes).
fn read_string(text: &[u16], hit: &StringHit<'_>) -> Option<usize> {
    let kind = hit.kind;
    if kind.line_scoped {
        return Some(end_of_line(text, hit.body_from));
    }

    // A constrained kind must actually close; an unterminated candidate is not a string at all, so the
    // `'` of `&'static str` never swallows the rest of the line.
    let must_close = kind.max_span.is_some() || kind.content == Content::SingleChar;
    let close = &hit.close;
    let mut j = hit.body_from;
    while j < text.len() {
        let character = text[j];
        if character == b'\n' as u16 && !kind.multiline {
            return if must_close { None } else { Some(j) };
        }
        if kind.escape == Escape::Backslash && character == b'\\' as u16 {
            j += 2;
            continue;
        }
        if kind.escape == Escape::Doubling
            && starts_with(text, close, j)
            && starts_with(text, close, j + close.len())
        {
            j += close.len() * 2;
            continue;
        }
        if starts_with(text, close, j) {
            if let Some(max_span) = kind.max_span {
                if j - hit.body_from > max_span {
                    return None;
                }
            }
            if kind.content == Content::SingleChar
                && !is_single_char_body(&text[hit.body_from..j])
            {
                return None;
            }
            return Some(j + close.len());
        }
        j += 1;
    }
    if must_close { None } else { Some(text.len()) }
}

/// The body of a Rust char literal: one escape (a backslash and up to ten more units), or one or two
/// units that are neither a newline nor a backslash. Everything else is a lifetime, not a string.
fn is_single_char_body(body: &[u16]) -> bool {
    if body.is_empty() {
        return false;
    }
    if body[0] == b'\\' as u16 {
        return body.len() <= 11;
    }
    body.len() <= 2 && !body.iter().any(|unit| *unit == b'\n' as u16 || *unit == b'\\' as u16)
}

// ---------------------------------------------------------------------------
// Declaration shapes
// ---------------------------------------------------------------------------

/// `@Decorator`-style is the default; Haskell supplies `name ::` instead.
fn is_name_signature(line: &str) -> bool {
    let trimmed = line.trim_start();
    let name_len: usize = trimmed
        .chars()
        .take_while(|character| character.is_alphanumeric() || *character == '_' || *character == '\'')
        .map(char::len_utf8)
        .sum();
    name_len > 0 && trimmed[name_len..].trim_start().starts_with("::")
}

/// The declaration shape `shape` finds on a masked line, if any.
fn match_shape(shape: Shape, line: &str) -> Option<Declared> {
    match shape {
        Shape::RubyMethod => ruby_method(line),
        Shape::HaskellBinding => haskell_binding(line),
        Shape::HaskellType => haskell_type(line),
        Shape::RustImpl => rust_impl(line),
        Shape::RustField => rust_field(line),
        Shape::VbClass => vb_class(line),
        Shape::VbMethod => vb_method(line),
    }
}

/// `^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)`, body closed by `end`.
fn ruby_method(line: &str) -> Option<Declared> {
    let text = line.trim_start();
    let rest = text.strip_prefix("def")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let mut rest = rest.trim_start();
    if let Some(after) = rest.strip_prefix("self.") {
        rest = after;
    }
    let name = take_name(rest, true)?;
    let header_from = line.len() - rest.len() + name.len();
    Some(Declared::new("method", name, header_from).closed_by("end"))
}

/// A name: `[A-Za-z_]\w*` with Ruby's optional trailing `?`, `!` or `=`.
fn take_name(text: &str, ruby_suffix: bool) -> Option<String> {
    let mut characters = text.char_indices();
    let (_, first) = characters.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut end = first.len_utf8();
    for (index, character) in characters {
        if character.is_ascii_alphanumeric() || character == '_' {
            end = index + character.len_utf8();
        } else {
            if ruby_suffix && (character == '?' || character == '!' || character == '=') {
                end = index + character.len_utf8();
            }
            break;
        }
    }
    Some(text[..end].to_string())
}

const HASKELL_KEYWORDS: [&str; 10] = [
    "data", "newtype", "type", "class", "instance", "module", "import", "infix", "foreign", "deriving",
];

/// `^(?!(?:data|newtype|…)\b)([a-z_][\w']*)\b[^=\n]*=`, a one-line binding.
fn haskell_binding(line: &str) -> Option<Declared> {
    let text = line.trim_start();
    // The lookahead is a *word* boundary, so `datax` is a binding while `data` is the keyword: compare
    // the whole identifier, not a prefix of it.
    let head: String = text
        .chars()
        .take_while(|character| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '\''
        })
        .collect();
    let is_keyword = HASKELL_KEYWORDS.contains(&head.as_str())
        || head == "default"
        || head == "infix"
        || head == "infixl"
        || head == "infixr";
    if is_keyword {
        return None;
    }
    let mut characters = text.char_indices();
    let (_, first) = characters.next()?;
    if !(first.is_ascii_lowercase() || first == '_') {
        return None;
    }
    let mut end = first.len_utf8();
    for (index, character) in characters {
        if character.is_ascii_alphanumeric() || character == '_' || character == '\'' {
            end = index + character.len_utf8();
        } else {
            break;
        }
    }
    let name = &text[..end];
    let rest = &text[end..];
    // `[^=\n]*=` — the binding's `=` must follow before the line ends, and no `=` may come first.
    let equals = rest.find('=')?;
    if rest[..equals].contains('=') {
        return None;
    }
    Some(Declared::new("method", name, end + equals + 1).single_line())
}

/// `^(?:data|newtype|type|class)\s+(?:\([^)]*\)\s*=>\s*)?([A-Z][\w']*)`.
fn haskell_type(line: &str) -> Option<Declared> {
    let text = line.trim_start();
    let keyword = ["newtype", "class", "data", "type"].iter().find(|word| {
        text.strip_prefix(**word).is_some_and(|rest| rest.starts_with(char::is_whitespace))
    })?;
    let mut rest = text[keyword.len()..].trim_start();
    if rest.starts_with('(') {
        let close = rest.find(')')?;
        let after = rest[close + 1..].trim_start();
        rest = after.strip_prefix("=>")?.trim_start();
    }
    let name = take_name(rest, false)?;
    if !name.starts_with(|c: char| c.is_ascii_uppercase()) {
        return None;
    }
    let header_from = line.len() - rest.len() + name.len();
    Some(Declared::new("class", name, header_from))
}

/// `^\s*impl\b[^{]*?\b([A-Za-z_][\w:]*)\s*(?:<[^>]*>)?\s*(?:where\b[^{]*)?\{` — the identifier that
/// ends the header, so `impl Display for Cart<T> where T: Clone` is a scope called `Cart`.
fn rust_impl(line: &str) -> Option<Declared> {
    let text = line.trim_start();
    let rest = text.strip_prefix("impl")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let header = &rest[..rest.find('{')?];
    let mut header = header.trim_end();
    // Drop a trailing `where …` clause, then a trailing generic parameter list.
    if let Some(at) = header.rfind("where") {
        if at > 0 && header[..at].ends_with(char::is_whitespace) {
            header = header[..at].trim_end();
        }
    }
    if header.ends_with('>') {
        let open = header.rfind('<')?;
        header = header[..open].trim_end();
    }
    let start = header
        .char_indices()
        .rev()
        .take_while(|(_, character)| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == ':'
        })
        .last()
        .map(|(index, _)| index)?;
    let name = header[start..].trim_matches(':');
    if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    let header_from = line.len() - rest.len() + rest.find('{')?;
    Some(Declared::new("class", name, header_from))
}

/// `^\s*(?:pub\s+)?([A-Za-z_]\w*)\s*:` — a field, which Rust never writes as `name = …`.
fn rust_field(line: &str) -> Option<Declared> {
    let text = line.trim_start();
    let text = text.strip_prefix("pub").map_or(text, |rest| rest.trim_start());
    let name = take_name(text, false)?;
    let rest = &text[name.len()..];
    if !rest.trim_start().starts_with(':') {
        return None;
    }
    let header_from = line.len() - rest.len() + name.len();
    Some(Declared::new("property", name, header_from).single_line())
}

/// `^\s*(?:Public|Private|Friend|Protected)?\s*(?:NotInheritable\s+|MustInherit\s+)?(?:Class|Module|Structure)\s+(\w+)`.
fn vb_class(line: &str) -> Option<Declared> {
    let mut text = line.trim_start();
    for modifier in ["Public", "Private", "Friend", "Protected"] {
        if let Some(rest) = text.strip_prefix(modifier) {
            if rest.starts_with(char::is_whitespace) {
                text = rest.trim_start();
                break;
            }
        }
    }
    for modifier in ["NotInheritable", "MustInherit"] {
        if let Some(rest) = text.strip_prefix(modifier) {
            if rest.starts_with(char::is_whitespace) {
                text = rest.trim_start();
                break;
            }
        }
    }
    let keyword = ["Class", "Module", "Structure"]
        .iter()
        .find(|word| text.strip_prefix(**word).is_some_and(|r| r.starts_with(char::is_whitespace)))?;
    let rest = text[keyword.len()..].trim_start();
    let name = take_name(rest, false)?;
    let header_from = line.len() - rest.len() + name.len();
    Some(Declared::new("class", name, header_from).closed_by("End"))
}

/// `^\s*[\w\s]*?\b(?:Sub|Function)\s+(\w+)`.
fn vb_method(line: &str) -> Option<Declared> {
    let text = line.trim_start();
    let at = ["Sub", "Function"]
        .iter()
        .filter_map(|word| text.find(*word).map(|index| (index, *word)))
        .min_by_key(|(index, _)| *index)?;
    let (index, word) = at;
    if text[..index].chars().any(|character| {
        !character.is_whitespace() && !character.is_alphanumeric() && character != '_'
    }) {
        return None;
    }
    let rest = text[index + word.len()..].trim_start();
    let name = take_name(rest, false)?;
    let header_from = line.len() - rest.len() + name.len();
    Some(Declared::new("method", name, header_from).closed_by("End"))
}
