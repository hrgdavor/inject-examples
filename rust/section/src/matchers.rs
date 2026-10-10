//! The regex equivalents the block scanner needs, written by hand.
//!
//! `src/js/scanner/tokenizer.js` and the Java port express these as regular expressions; this crate is
//! dependency-free and must not take a regex engine on, so each one is a small parser here. The
//! behaviour is what has to agree with the JavaScript — the shapes it accepts, and the offsets it
//! reports — and the unit tests below pin the cases the scanner relies on.
//!
//! Offsets are byte offsets into the line, as everywhere else in this port, and the scanner only ever
//! lifts ASCII identifiers out of these shapes.

/// Which of the two region directives a line is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DirectiveKind {
    Region,
    EndRegion,
}

/// A line read as a region directive.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Directive {
    pub kind: DirectiveKind,
    pub name: String,
}

/// The comment prefixes inject-examples accepts before a `#region` directive.
const COMMENT_OPENERS: [&str; 9] = ["//", "--", ";", "%", "'", "REM", "<!--", "/*", "*"];
const COMMENT_CLOSERS: [&str; 2] = ["-->", "*/"];

/// The declaration keywords the generic class-like shape knows.
const TYPE_KEYWORDS: [&str; 8] = [
    "class",
    "interface",
    "enum",
    "record",
    "struct",
    "trait",
    "object",
    "union",
];

/// The statement keywords matcher 5 opens a block on.
const STATEMENT_KEYWORDS: [&str; 10] = [
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "try",
    "catch",
    "finally",
    "synchronized",
];

/// A word that stands where a type or modifier would, but declares nothing.
const NOT_A_TYPE: [&str; 10] = [
    "return", "throw", "new", "else", "do", "case", "await", "yield", "delete", "typeof",
];

/// Words that turn a `name(` shape into a statement rather than a declaration.
const STATEMENT_BEFORE: [&str; 9] = [
    "return", "throw", "new", "await", "yield", "delete", "typeof", "case", "else",
];

/// A class-like declaration on a masked line, and where its header ends.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TypeDeclaration {
    pub keyword: String,
    pub name: String,
    pub header_from: usize,
}

/// A property declaration: `Type name = …`, `static final Type name = …`, `const name = …`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PropertyDeclaration {
    pub name: String,
    /// The first word of the type, when there was one (a `const`/`let`/`var` declaration has none).
    pub type_head: Option<String>,
    /// The offset just past the `=`, which is where the declaration ends for a body selection.
    pub value_from: usize,
}

fn is_word_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '$'
}

fn starts_with_ignore_case(text: &str, needle: &str) -> bool {
    text.len() >= needle.len() && text[..needle.len()].eq_ignore_ascii_case(needle)
}

/// A `\b` boundary before `at`, where `\w` is `[A-Za-z0-9_]`.
fn at_word_boundary(text: &str, at: usize) -> bool {
    match text[..at].chars().next_back() {
        None => true,
        Some(previous) => !is_word_char(previous),
    }
}

/// A `\b`-delimited word at `at`: the boundary before it *and* the one after it. A keyword test needs
/// both — `if (` is the keyword while `differ(` is not a declaration of anything.
fn word_at(text: &str, at: usize, word: &str) -> bool {
    text[at..].starts_with(word)
        && at_word_boundary(text, at)
        && text[at + word.len()..]
            .chars()
            .next()
            .is_none_or(|c| !is_word_char(c))
}

/// The same, for the spellings the grammar accepts in either case (`#region`, `#REGION`).
fn word_at_ignore_case(text: &str, at: usize, word: &str) -> bool {
    starts_with_ignore_case(&text[at..], word)
        && at_word_boundary(text, at)
        && text[at + word.len()..]
            .chars()
            .next()
            .is_none_or(|c| !is_word_char(c))
}

/// `[A-Za-z_$][\w$]*` at the start of `text`, and its length.
pub fn take_identifier(text: &str) -> Option<(&str, usize)> {
    let mut characters = text.char_indices();
    let (_, first) = characters.next()?;
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return None;
    }
    let mut end = first.len_utf8();
    for (index, character) in characters {
        if is_word_char(character) {
            end = index + character.len_utf8();
        } else {
            break;
        }
    }
    Some((&text[..end], end))
}

/// Read one line as a region directive, or `None` — the same spellings as `index.mjs`, and the same
/// "bare `region` is prose" rule.
pub fn region_directive(line: &str) -> Option<Directive> {
    let mut text = line.trim();

    for closer in COMMENT_CLOSERS {
        if let Some(head) = text.strip_suffix(closer) {
            text = head.trim_end();
            break;
        }
    }

    // One or more comment openers, each optionally followed by whitespace.
    let mut commented = false;
    loop {
        let mut matched: Option<usize> = None;
        for opener in COMMENT_OPENERS {
            if !starts_with_ignore_case(text, opener) {
                continue;
            }
            // `REM` needs a word boundary after it, or `REMOVE` would open a comment.
            if opener == "REM"
                && text[opener.len()..]
                    .chars()
                    .next()
                    .is_some_and(is_word_char)
            {
                continue;
            }
            matched = Some(opener.len());
            break;
        }
        match matched {
            Some(length) => {
                text = text[length..].trim_start();
                commented = true;
            }
            None => break,
        }
    }

    let (hashed, rest) = match text.strip_prefix('#') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (kind, rest) = if word_at_ignore_case(rest, 0, "region") {
        (DirectiveKind::Region, &rest["region".len()..])
    } else if word_at_ignore_case(rest, 0, "endregion") {
        (DirectiveKind::EndRegion, &rest["endregion".len()..])
    } else {
        return None;
    };
    if !commented && !hashed {
        return None;
    }
    Some(Directive {
        kind,
        name: rest.trim().to_string(),
    })
}

/// `^(#?)(region|endregion)\b` — a region line, which is never a comment anchor.
pub fn is_region_line(text: &str) -> bool {
    let trimmed = text.trim_start();
    let text = trimmed.strip_prefix('#').unwrap_or(trimmed);
    ["region", "endregion"]
        .iter()
        .any(|word| word_at_ignore_case(text, 0, word))
}

/// `^([A-Za-z_$][\w$]*)$` — a comment body that names a block and nothing else.
pub fn anchor_name(text: &str) -> Option<&str> {
    let (name, length) = take_identifier(text)?;
    if length == text.len() {
        Some(name)
    } else {
        None
    }
}

/// `\b(?:class|interface|…)\s+([A-Za-z_$][\w$]*)\b`, first match wins left to right.
pub fn declaration_keyword(line: &str) -> Option<TypeDeclaration> {
    for (at, _) in line.char_indices() {
        if !at_word_boundary(line, at) {
            continue;
        }
        for keyword in TYPE_KEYWORDS {
            let Some(rest) = line[at..].strip_prefix(keyword) else {
                continue;
            };
            if !rest.starts_with(char::is_whitespace) {
                continue;
            }
            let body = rest.trim_start();
            let Some((name, length)) = take_identifier(body) else {
                continue;
            };
            return Some(TypeDeclaration {
                keyword: keyword.to_string(),
                name: name.to_string(),
                header_from: line.len() - body.len() + length,
            });
        }
    }
    None
}

/// `(^|[^\w$.])name\s*\(` with the prefix gate, and the offset just past its matching `)`.
pub fn call_shape(masked_line: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = masked_line[from..].find(name) {
        let start = from + at;
        from = start + name.len().max(1);
        let previous = masked_line[..start].chars().next_back();
        let whole_word = previous.is_none_or(|c| !is_word_char(c) && c != '.' && c != '$');
        if !whole_word {
            continue;
        }
        let rest = masked_line[start + name.len()..].trim_start();
        if !rest.starts_with('(') {
            continue;
        }
        let open = masked_line.len() - rest.len();
        let before = &masked_line[..start];
        if !allowed_prefix(before) {
            continue;
        }
        let close = matching_paren(masked_line, open)?;
        return Some(close + 1);
    }
    None
}

/// `(^|[^\w$.])(?:const\s+|let\s+|var\s+)?name\b(?:\s*:\s*[^=\n]+)?\s*=\s*(?:async\s+)?(=>|function)`.
pub fn assigned_shape(masked_line: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = masked_line[from..].find(name) {
        let start = from + at;
        from = start + name.len().max(1);
        let previous = masked_line[..start].chars().next_back();
        if previous.is_some_and(|c| is_word_char(c) || c == '.' || c == '$') {
            continue;
        }
        let after_name = &masked_line[start + name.len()..];
        // An optional `: Type` annotation, then the `=`.
        let after_type = match after_name.find(':') {
            Some(colon) if after_name[colon + 1..].find('=').is_some() => &after_name[colon + 1..],
            _ => after_name,
        };
        let Some(equals) = after_type.find('=') else {
            continue;
        };
        let after_equals = after_type[equals + 1..].trim_start();
        let after_async = after_equals
            .strip_prefix("async")
            .map_or(after_equals, |rest| rest.trim_start());
        if let Some(rest) = after_async.strip_prefix("function") {
            let length = masked_line.len() - rest.len();
            return Some(length);
        }
        if let Some(arrow) = after_async.find("=>") {
            let length = masked_line.len() - (&after_async[arrow..]).len();
            return Some(length);
        }
    }
    None
}

/// `(?<!\.)\b(?:(const|let|var)\s+|type\s+)([A-Za-z_$][\w$]*)\b\s*=(?!=)`.
pub fn property_decl(masked_line: &str) -> Option<PropertyDeclaration> {
    let mut from = 0;
    while let Some(at) = masked_line[from..].find('=') {
        let equals = from + at;
        from = equals + 1;
        // `=`, `==`, `=>`, `!=`, `<=`, `>=` are not an assignment here.
        let before = masked_line[..equals].chars().next_back();
        let after = masked_line[equals + 1..].chars().next();
        if before.is_some_and(|c| c == '=' || c == '!' || c == '<' || c == '>' || c == '-')
            || after == Some('=')
            || after == Some('>')
        {
            continue;
        }
        let head = masked_line[..equals].trim_end();
        let Some((name, name_len)) = take_identifier_from_end(head) else {
            continue;
        };
        let before_name = &head[..head.len() - name_len];
        let previous = before_name.chars().next_back();
        if previous.is_some_and(|c| c == '.' || is_word_char(c)) {
            continue;
        }
        let modifiers = before_name.trim_end();
        let (type_head, declaration) = match take_identifier_from_end(modifiers) {
            Some((word, _)) if ["const", "let", "var"].contains(&word) => (None, true),
            Some((word, _)) => {
                let head = word.to_string();
                (Some(head), true)
            }
            None => (None, false),
        };
        if !declaration {
            continue;
        }
        if let Some(head) = &type_head {
            if NOT_A_TYPE.contains(&head.as_str()) || STATEMENT_BEFORE.contains(&head.as_str()) {
                continue;
            }
        }
        return Some(PropertyDeclaration {
            name: name.to_string(),
            type_head,
            value_from: equals + 1,
        });
    }
    None
}

/// The trailing identifier of `text`, with the length it occupies.
fn take_identifier_from_end(text: &str) -> Option<(&str, usize)> {
    let start = text
        .char_indices()
        .rev()
        .take_while(|(_, character)| is_word_char(*character))
        .last()
        .map(|(index, _)| index)?;
    let candidate = &text[start..];
    // It must be a name, not a type: `Type` is fine, `List<String>` is not a name.
    if candidate.is_empty()
        || take_identifier(candidate).map(|(_, length)| length) != Some(candidate.len())
    {
        return None;
    }
    let previous = text[..start].chars().next_back();
    if previous.is_some_and(|c| c == '.') {
        return None;
    }
    Some((candidate, candidate.len()))
}

/// `\b(if|else|for|while|do|switch|try|catch|finally|synchronized)\b`, with the offset of the keyword.
pub fn statement_keyword(line: &str) -> Option<(String, usize)> {
    let mut best: Option<(String, usize)> = None;
    for keyword in STATEMENT_KEYWORDS {
        let mut from = 0;
        while let Some(at) = line[from..].find(keyword) {
            let start = from + at;
            from = start + keyword.len();
            if word_at(line, start, keyword) {
                if best.as_ref().is_none_or(|(_, best_at)| start < *best_at) {
                    best = Some((keyword.to_string(), start));
                }
                break;
            }
        }
    }
    best
}

/// `^[\w$<>\[\],.?*&:@\s]*$` — the characters a declaration prefix may hold.
pub fn is_prefix(text: &str) -> bool {
    text.chars().all(|character| {
        is_word_char(character)
            || matches!(
                character,
                '<' | '>' | '[' | ']' | ',' | '.' | '?' | '*' | '&' | ':' | '@'
            )
            || character.is_whitespace()
    })
}

/// Whether a declaration prefix opens a statement instead (`return foo(`).
pub fn starts_with_statement_before(text: &str) -> bool {
    let text = text.trim_start();
    STATEMENT_BEFORE.iter().any(|word| {
        text.starts_with(word)
            && text[word.len()..]
                .chars()
                .next()
                .is_none_or(|c| !is_word_char(c))
    })
}

/// The prefix gate `declarationOn` applies to a call shape.
fn allowed_prefix(before: &str) -> bool {
    let trimmed = before.trim();
    // `func (r Type) name(…)` is a declaration; the `func (` head is normalised away first.
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
    normalised.trim().is_empty()
        || (is_prefix(&normalised) && !starts_with_statement_before(&normalised))
}

/// The byte offset of the bracket matching the one at byte offset `open`, or `None`.
///
/// The mask helpers count UTF-16 code units, as the JavaScript does, so this converts in and back: the
/// two only coincide for ASCII, and a declaration may be preceded by anything.
fn matching_paren(text: &str, open: usize) -> Option<usize> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let unit_open = text[..open].encode_utf16().count();
    let unit_close = crate::mask::matching_bracket(&units, unit_open, b')' as u16)?;
    let mut byte = 0;
    let mut counted = 0;
    for character in text.chars() {
        if counted >= unit_close {
            break;
        }
        counted += character.len_utf16();
        byte += character.len_utf8();
    }
    Some(byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_region_spellings_inject_examples_accepts() {
        for line in [
            "#region wiring",
            "// #region wiring",
            "//region wiring",
            "<!-- #region wiring -->",
            "/* #region wiring */",
            "-- #region wiring",
            "; #region wiring",
            "% #region wiring",
            "' #region wiring",
            "REM #region wiring",
            "    * #region wiring",
        ] {
            let directive =
                region_directive(line).unwrap_or_else(|| panic!("{line} is a directive"));
            assert_eq!(DirectiveKind::Region, directive.kind, "{line}");
            assert_eq!("wiring", directive.name, "{line}");
        }
        assert_eq!(
            DirectiveKind::EndRegion,
            region_directive("#endregion").unwrap().kind
        );
        assert_eq!(
            DirectiveKind::EndRegion,
            region_directive("// #endregion").unwrap().kind
        );
    }

    #[test]
    fn a_bare_region_is_prose() {
        assert!(
            region_directive("region wiring").is_none(),
            "no comment prefix, no `#`"
        );
        assert!(
            region_directive("# regional planning").is_none(),
            "`regional` is not `region`"
        );
        assert!(
            region_directive("REMOVE #region x").is_none(),
            "`REMOVE` is not `REM`"
        );
        assert!(region_directive("plain text").is_none());
    }

    #[test]
    fn the_class_like_shape() {
        let found = declaration_keyword("public static class Cart {").unwrap();
        assert_eq!("class", found.keyword);
        assert_eq!("Cart", found.name);
        assert_eq!(len("public static class Cart"), found.header_from);

        let record = declaration_keyword("public record Point(int x) {").unwrap();
        assert_eq!("Point", record.name);
        assert!(
            declaration_keyword("classy thing").is_none(),
            "a word boundary is required"
        );
        assert!(declaration_keyword("    return value;").is_none());
    }

    #[test]
    fn the_call_shape_needs_a_body_and_a_quiet_prefix() {
        assert_eq!(
            Some(len("    public boolean add()")),
            call_shape("    public boolean add() {", "add")
        );
        assert!(
            call_shape("        add(1, 2);", "add").is_some(),
            "the shape itself matches"
        );
        assert!(
            call_shape("        return add(1, 2);", "add").is_none(),
            "`return` opens a statement"
        );
        assert!(
            call_shape("        other.add(1, 2);", "add").is_none(),
            "a member call is not a declaration"
        );
        assert!(
            call_shape("    public boolean add(", "add").is_none(),
            "an unclosed paren is not a header"
        );
    }

    #[test]
    fn the_property_shape() {
        let found = property_decl("    private int getUsers = 0;").unwrap();
        assert_eq!("getUsers", found.name);
        assert_eq!(Some("int".to_string()), found.type_head);

        let constant = property_decl("    const total = 1;").unwrap();
        assert_eq!("total", constant.name);
        assert_eq!(None, constant.type_head);

        assert!(
            property_decl("        count = 0;").is_none(),
            "an assignment is not a declaration"
        );
        assert!(
            property_decl("    if (a == b) {").is_none(),
            "a comparison is not an assignment"
        );
        assert!(
            property_decl("    return value = 1;").is_none(),
            "a statement before it disqualifies it"
        );
    }

    #[test]
    fn the_statement_keyword() {
        assert_eq!(
            Some(("if".to_string(), 4)),
            statement_keyword("    if (x) {")
        );
        assert_eq!(Some(("else".to_string(), 0)), statement_keyword("else {"));
        assert!(
            statement_keyword("    // if (x) {").is_some(),
            "the scanner reads the masked line"
        );
        assert!(statement_keyword("    nothing here").is_none());
        assert!(
            statement_keyword("    differ(x)").is_none(),
            "a word boundary is required"
        );
    }

    #[test]
    fn the_anchor_and_prefix_helpers() {
        assert_eq!(Some("getUsers"), anchor_name("getUsers"));
        assert_eq!(None, anchor_name("getUsers twice"));
        assert_eq!(None, anchor_name("#region x"));

        assert!(is_prefix("public boolean "));
        assert!(is_prefix(""));
        // `PREFIX` is a character-class test, so `return ` passes it — the statement gate is what
        // rejects it, exactly as the JavaScript keeps the two apart.
        assert!(is_prefix("return "));

        assert!(starts_with_statement_before("return "));
        assert!(starts_with_statement_before("  throw"));
        assert!(!starts_with_statement_before("returning "));
        assert!(!starts_with_statement_before("public "));

        assert!(is_region_line("#region x"));
        assert!(is_region_line("endregion"));
        assert!(!is_region_line("regional"));
    }

    fn len(text: &str) -> usize {
        text.len()
    }
}
