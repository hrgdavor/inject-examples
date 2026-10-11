//! Body spans: where a declaration's body opens, closes, or ends.
//!
//! This is the part the modifiers hinge on — `-` asks for "the body alone", so the span decides what
//! that means: a brace pair, an indented run, an arrow expression, or a keyword-delimited block
//! (Ruby's `end`, VB's `End`). It reads the **mask**, so a brace inside a string or comment cannot end a
//! body, and it works in **UTF-16 code units** throughout, as the JavaScript does.
//!
//! A member with no body to inject — an interface method, an `abstract` one — yields `None` rather than
//! half a method.

use crate::mask::{index_of, line_of, matching_bracket};

/// A declaration's header: the mask from the declaration's first character through the `{` or `;`
/// that ends it, **including** that terminator. `last` is the line the window ends on, which is the
/// line a wrapped parameter list, generic list or `throws` clause pushes the terminator down to.
///
/// The window is never clamped to the start of the declaration's own line: an `impl Cart {` header
/// ends at the `{`, after the offset the declaration starts at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub start: usize,
    pub end: usize,
    pub last: usize,
}

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

/// A body span, or `None` when the member has no body to inject (an interface or `abstract`
/// method).
///
/// `mask_lines` is the masked text split by line, which is what the next-line brace and the
/// indentation are read from; `starts` are the line-start offsets. `header` is the declaration's
/// header as a slice of the mask — one line, or the several a wrapped parameter list spans — ending
/// at the `{` or `;` that ends it; the first `{`, `;` or `=>` inside it is the body's terminator.
pub fn body_span(
    mask: &[u16],
    mask_lines: &[Vec<u16>],
    starts: &[usize],
    decl_line: usize,
    header: Header,
) -> Option<Span> {
    if decl_line >= starts.len() {
        return None;
    }
    let rest = slice_units(mask, header.start, header.end);

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

    // The earliest terminator wins, and when there is none the body is the next block: a `{` on the
    // next line, or an indented run.
    if let Some((at, kind)) = first {
        match kind {
            Terminator::Statement => return None,
            Terminator::Arrow => {
                // The `=>` opens a function; its body is a brace expression when there is one, and
                // otherwise an expression that runs to the end of its line.
                let after_arrow = at + 2;
                return match index_of(&rest[after_arrow..], &[b'{' as u16], 0) {
                    None => Some(Span {
                        expression: Some(header.start + after_arrow),
                        ..Span::default()
                    }),
                    Some(brace) => brace_body(mask, starts, header.start + after_arrow + brace),
                };
            }
            Terminator::Brace => return brace_body(mask, starts, header.start + at),
        }
    }

    // No terminator at all: the body may still open on the next line, or be an indented run. A
    // wrapped header moves the `{` or the indented block down with it — the header's **last** line
    // is what the next line is read from, not the declaration's.
    let next = next_non_blank_units(mask_lines, header.last + 1)?;
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
        let mut last = next;
        for i in next + 1..mask_lines.len() {
            if mask_lines[i].iter().all(|unit| is_blank_unit(*unit)) {
                continue;
            }
            if indent_width_units(&mask_lines[i]) <= indent {
                break;
            }
            last = i;
        }
        return Some(Span {
            indented: true,
            body_end_line: Some(last),
            ..Span::default()
        });
    }
    None
}

/// The JavaScript's `masked.slice(from, to)`, forgiving of an out-of-range end.
fn slice_units(text: &[u16], from: usize, to: usize) -> &[u16] {
    let start = from.min(text.len());
    let end = to.min(text.len()).max(start);
    &text[start..end]
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
pub(crate) fn is_blank_unit(unit: u16) -> bool {
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
        // The window the scanner hands a line-local method: from just past its `)` to the end of
        // the line that holds the body's `{`.
        let header = Header {
            start: source.find(')').unwrap() + 1,
            end: crate::mask::end_of_line(&mask, 0),
            last: 0,
        };
        let span = body_span(&mask, &lines, &starts, 0, header).unwrap();
        assert_eq!(Some(0), span.open_line);
        assert_eq!(Some(2), span.close_line);
        assert_eq!(2, span.end_line(0));
        assert!(!span.indented);
    }

    #[test]
    fn a_body_that_never_opens() {
        let source = "void add();\n";
        let (mask, lines, starts) = scan(source);
        let header = Header {
            start: source.find(')').unwrap() + 1,
            end: crate::mask::end_of_line(&mask, 0),
            last: 0,
        };
        assert!(
            body_span(&mask, &lines, &starts, 0, header).is_none(),
            "a `;` is no body"
        );
    }

    #[test]
    fn an_arrow_expression() {
        let source = "const add = (a, b) => a + b;\n";
        let (mask, lines, starts) = scan(source);
        let arrow = source.find("=>").unwrap();
        let header = Header {
            start: arrow,
            end: crate::mask::end_of_line(&mask, 0),
            last: 0,
        };
        let span = body_span(&mask, &lines, &starts, 0, header).unwrap();
        // Just past `=>`, the space included: the renderer trims, as the JavaScript's does.
        assert_eq!(Some(arrow + 2), span.expression);
        assert!(span.open.is_none());
    }

    #[test]
    fn a_wrapped_parameter_list_is_one_header() {
        // The `)` and the `{` sit two lines below the name; the window is what carries them.
        let source = "void add(\n        int a,\n        int b) {\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let brace = source.find('{').unwrap();
        let header = Header {
            start: 0,
            end: brace + 1,
            last: 2,
        };
        let span = body_span(&mask, &lines, &starts, 0, header).unwrap();
        assert_eq!(Some(2), span.open_line, "the brace opens on line 3");
        assert_eq!(Some(4), span.close_line);
    }

    #[test]
    fn a_brace_on_the_next_line() {
        let source = "void add()\n{\n    count++;\n}\n";
        let (mask, lines, starts) = scan(source);
        let header = Header {
            start: source.find(')').unwrap() + 1,
            end: crate::mask::end_of_line(&mask, 0),
            last: 0,
        };
        let span = body_span(&mask, &lines, &starts, 0, header).unwrap();
        assert_eq!(Some(1), span.open_line, "the brace opens on line 2");
        assert_eq!(Some(3), span.close_line);
    }

    #[test]
    fn an_indented_body() {
        let source = "def add(a)\n    a + 1\nend\n";
        let (mask, lines, starts) = scan(source);
        let header = Header {
            start: source.find(')').unwrap() + 1,
            end: crate::mask::end_of_line(&mask, 0),
            last: 0,
        };
        let span = body_span(&mask, &lines, &starts, 0, header).unwrap();
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
