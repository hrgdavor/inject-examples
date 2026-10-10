//! Body spans: where a declaration's body opens, closes, or ends.
//!
//! This is the part the modifiers hinge on — `-` asks for "the body alone", so the span decides what
//! that means: a brace pair, an indented run, an arrow expression, or a keyword-delimited block
//! (Ruby's `end`, VB's `End`). It reads the **mask**, so a brace inside a string or comment cannot end a
//! body, and it works in **UTF-16 code units** throughout, as the JavaScript does.
//!
//! A member with no body to inject — an interface method, an `abstract` one — yields `None` rather than
//! half a method.

use crate::mask::{end_of_line, index_of, line_of, matching_bracket};

/// A body span. Every offset is a UTF-16 code-unit offset into the masked text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Span {
    /// The `{` and the matching `}`.
    pub open: Option<usize>,
    pub close: Option<usize>,
    pub open_line: Option<usize>,
    pub close_line: Option<usize>,
    /// The last line of an indented body, which has no braces.
    pub body_end_line: Option<usize>,
    /// The offset of an arrow expression's body (`=> expr`).
    pub expression: Option<usize>,
    pub indented: bool,
}

impl Span {
    /// The last line the declaration covers, for a caller walking the tree.
    pub fn end_line(&self, decl_line: usize) -> usize {
        self.close_line.or(self.body_end_line).unwrap_or(decl_line)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Terminator {
    Brace,
    Statement,
    Arrow,
}

/// A body span, or `None` when the member has no body to inject.
///
/// `mask_lines` is the masked text split by line, which is what indentation and the next-line brace are
/// read from; `starts` are the line-start offsets, and `header_from` is where the header's own text
/// begins (just past the name and its parameter list).
pub fn body_span(
    mask: &[u16],
    mask_lines: &[Vec<u16>],
    starts: &[usize],
    decl_line: usize,
    header_from: usize,
) -> Option<Span> {
    if decl_line >= starts.len() {
        return None;
    }
    let line_end = end_of_line(mask, starts[decl_line]);
    let from = header_from.min(line_end);
    let rest = &mask[from..line_end];

    // The earliest terminator wins: a body ends at whichever of `{`, `;` or `=>` comes first.
    let mut first: Option<(usize, Terminator)> = None;
    for (at, kind) in [
        (index_of(rest, &[b'{' as u16], 0), Terminator::Brace),
        (index_of(rest, &[b';' as u16], 0), Terminator::Statement),
        (
            index_of(rest, &[b'=' as u16, b'>' as u16], 0),
            Terminator::Arrow,
        ),
    ] {
        if let Some(at) = at {
            if first.is_none_or(|(best, _)| at < best) {
                first = Some((at, kind));
            }
        }
    }

    match first {
        Some((_, Terminator::Statement)) => return None,
        Some((at, Terminator::Arrow)) => {
            let after_arrow = at + 2;
            return match index_of(&rest[after_arrow..], &[b'{' as u16], 0) {
                // A one-expression body: the span is that expression, on the header's own line.
                None => Some(Span {
                    expression: Some(from + after_arrow),
                    ..Span::default()
                }),
                Some(brace) => brace_body(mask, starts, from + after_arrow + brace),
            };
        }
        Some((at, Terminator::Brace)) => return brace_body(mask, starts, from + at),
        None => {}
    }

    // No terminator on the header line: the body may still open on the next line, or be an indented run.
    let next = next_non_blank_units(mask_lines, decl_line + 1)?;
    if let Some(brace) = index_of(&mask_lines[next], &[b'{' as u16], 0) {
        if mask_lines[next][..brace]
            .iter()
            .all(|unit| is_blank_unit(*unit))
        {
            return brace_body(mask, starts, starts[next] + brace);
        }
    }
    let indent = indent_width_units(&mask_lines[decl_line]);
    if indent_width_units(&mask_lines[next]) > indent {
        let mut end = next;
        for i in next + 1..mask_lines.len() {
            if mask_lines[i].iter().all(|unit| is_blank_unit(*unit)) {
                continue;
            }
            if indent_width_units(&mask_lines[i]) <= indent {
                break;
            }
            end = i;
        }
        return Some(Span {
            indented: true,
            body_end_line: Some(end),
            ..Span::default()
        });
    }
    None
}

/// A brace-delimited body, when the braces actually pair.
pub fn brace_body(mask: &[u16], starts: &[usize], open: usize) -> Option<Span> {
    let close = matching_bracket(mask, open, b'}' as u16)?;
    Some(Span {
        open: Some(open),
        close: Some(close),
        open_line: Some(line_of(starts, open)),
        close_line: Some(line_of(starts, close)),
        ..Span::default()
    })
}

/// A body closed by a terminator keyword line (`end` in Ruby, `End` in VB), found by indentation: the
/// first line at or left of the declaration's indentation whose trimmed text is the terminator. When no
/// terminator is found that way the declaration gets no block at all, rather than half a method.
pub fn keyword_body(lines: &[Vec<u16>], decl_line: usize, word: &str) -> Option<Span> {
    if decl_line >= lines.len() {
        return None;
    }
    let indent = indent_width_units(&lines[decl_line]);
    for i in decl_line + 1..lines.len() {
        let text = trim_units(&lines[i]);
        if text.is_empty() {
            continue;
        }
        if indent_width_units(&lines[i]) > indent {
            continue;
        }
        let word = crate::mask::units(word);
        if text == word.as_slice()
            || (text.starts_with(&word) && text.get(word.len()) == Some(&(b' ' as u16)))
        {
            return Some(Span {
                open_line: Some(decl_line),
                close_line: Some(i),
                ..Span::default()
            });
        }
        return None;
    }
    None
}

/// Whether a unit is blank for trimming. `\n` counts: the readers that ask "is there nothing but
/// whitespace before this comment" look at a slice that spans lines, and both Java's `trim()` and the
/// JavaScript's `.trim()` remove it — without this, a comment on the line after a brace is not an anchor.
fn is_blank_unit(unit: u16) -> bool {
    unit == b' ' as u16
        || unit == b'\t' as u16
        || unit == b'\n' as u16
        || unit == b'\r' as u16
        || unit == 0x0b
        || unit == 0x0c
}

/// How far a unit line is indented.
pub fn indent_width_units(line: &[u16]) -> usize {
    line.iter().take_while(|unit| is_blank_unit(**unit)).count()
}

pub(crate) fn trim_units(line: &[u16]) -> &[u16] {
    let start = line.iter().take_while(|unit| is_blank_unit(**unit)).count();
    let end = line
        .iter()
        .rev()
        .take_while(|unit| is_blank_unit(**unit))
        .count();
    &line[start..line.len().saturating_sub(end).max(start)]
}

pub(crate) fn next_non_blank_units(lines: &[Vec<u16>], from: usize) -> Option<usize> {
    (from..lines.len()).find(|at| !trim_units(&lines[*at]).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::{line_starts, units};

    fn scan(source: &str) -> (Vec<u16>, Vec<Vec<u16>>, Vec<usize>) {
        let mask = units(source);
        let lines = source.split('\n').map(units).collect();
        let starts = line_starts(&mask);
        (mask, lines, starts)
    }

    #[test]
    fn a_brace_body_on_the_header_line() {
        let source = "void add() {\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let header_from = mask.len() - units("() {\n    count++;\n}\n").len();
        let span = body_span(&mask, &lines, &starts, 0, header_from).unwrap();
        assert_eq!(Some(0), span.open_line);
        assert_eq!(Some(2), span.close_line);
        assert_eq!(2, span.end_line(0));
        assert!(!span.indented);
    }

    #[test]
    fn a_body_that_never_opens() {
        let source = "void add();\n";
        let (mask, lines, starts) = scan(source);
        let header_from = mask.len() - units("();\n").len();
        assert!(
            body_span(&mask, &lines, &starts, 0, header_from).is_none(),
            "a `;` is no body"
        );
    }

    #[test]
    fn an_arrow_expression() {
        let source = "const add = (a, b) => a + b;\n";
        let (mask, lines, starts) = scan(source);
        let arrow = source.find("=> ").unwrap();
        let span = body_span(&mask, &lines, &starts, 0, arrow).unwrap();
        // Just past `=>`, the space included: the renderer trims, as the JavaScript's does.
        assert_eq!(Some(arrow + 2), span.expression);
        assert!(span.open.is_none());
    }

    #[test]
    fn a_brace_on_the_next_line() {
        let source = "void add()\n{\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let header_from = mask.len() - units("()\n{\n    count++;\n}\n").len();
        let span = body_span(&mask, &lines, &starts, 0, header_from).unwrap();
        assert_eq!(Some(1), span.open_line, "the brace opens on line 2");
        assert_eq!(Some(3), span.close_line);
    }

    #[test]
    fn an_indented_body() {
        let source = "def add(a)\n    a + 1\nend\n";
        let (mask, lines, starts) = scan(source);
        let header_from = mask.len() - units("(a)\n    a + 1\nend\n").len();
        let span = body_span(&mask, &lines, &starts, 0, header_from).unwrap();
        assert!(span.indented);
        assert_eq!(Some(1), span.body_end_line);
    }

    #[test]
    fn a_keyword_delimited_body() {
        let source = "class Cart\n  def add(x)\n    @items << x\n  end\nend\n";
        let (_, lines, _) = scan(source);
        let span = keyword_body(&lines, 1, "end").unwrap();
        assert_eq!(Some(1), span.open_line);
        assert_eq!(
            Some(3),
            span.close_line,
            "the first `end` at or left of the indent"
        );

        assert!(
            keyword_body(&lines, 1, "stop").is_none(),
            "no terminator, no block"
        );
    }
}
