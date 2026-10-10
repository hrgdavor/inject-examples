//! The mask pass and the lexer seam, checked as properties.
//!
//! The mask invariant is the one hard contract a substituted engine must keep, so it is asserted over a
//! source that carries every construct the union has to survive. The construct-specific cases that need
//! a language's own table — Zig's nested comments, a Rust lifetime beside a char literal, Ruby's strict
//! heredoc — arrive with the tokenizer and the table; what is here is what the default engine owns.

use inject_sections::lexer::{annotation_line, condition_literals, DefaultLexer, Lexer};
use inject_sections::mask::{comments_in, masked};

/// A source carrying the constructs the default union has to get right, and the ones it deliberately
/// does not: a `//` inside a string, a block comment inside a string, a `#` attribute, a backtick, a
/// triple quote, and a nested block comment (which the union is non-nesting about, which is why Zig
/// needs its own entry).
const SAMPLE: &str = "line // comment\n\
                      block /* one /* two */ still open */ end\n\
                      string \"/* not a comment */\" and 'x' and `t`\n\
                      attribute #[derive(Debug)] stays\n\
                      java \"\"\"text block\"\"\" done\n\
                      hash # a shell comment\n";

#[test]
fn the_mask_invariant_holds() {
    let mask = masked(SAMPLE).expect("the default engine keeps the invariant");

    assert_eq!(
        SAMPLE.encode_utf16().count(),
        mask.encode_utf16().count(),
        "length is preserved"
    );
    for (i, unit) in SAMPLE.encode_utf16().enumerate() {
        if unit == b'\n' as u16 {
            assert_eq!(
                b'\n' as u16,
                mask.encode_utf16().nth(i).unwrap(),
                "every newline stays at its own offset (broken at {i})"
            );
        }
    }
}

#[test]
fn a_nested_comment_is_where_the_default_engine_stops() {
    // The default union is non-nesting: it blanks up to the first `*/`, so the rest of the nested
    // comment survives as if it were code. That is exactly why a language with nested block comments
    // needs its own table entry — the mask alone cannot recover it.
    let zig = "/* outer /* inner */ fn decoy() void { x(); } */\n";
    let mask = masked(zig).unwrap();
    assert!(
        mask.contains("decoy"),
        "the default engine leaks the inner tail: {mask:?}"
    );
    assert!(
        !mask.contains("outer"),
        "the outer comment is blanked: {mask:?}"
    );
}

#[test]
fn a_hash_attribute_survives_but_a_hash_comment_does_not() {
    let mask = masked(SAMPLE).unwrap();
    assert!(
        mask.contains("#[derive(Debug)]"),
        "an attribute is code, not a comment: {mask:?}"
    );
    assert!(
        !mask.contains("shell comment"),
        "a `#` comment is blanked: {mask:?}"
    );
    assert!(
        mask.contains("attribute"),
        "the line before the attribute is untouched: {mask:?}"
    );
}

#[test]
fn strings_are_blanked_from_the_outside_in() {
    let mask = masked(SAMPLE).unwrap();
    // The assertions name the literal *spellings*: a bare letter would match the code that survives
    // around the blanked literals, which says nothing about the mask.
    for blanked in ["not a comment", "\"x\"", "'x'", "`t`", "text block"] {
        assert!(
            !mask.contains(blanked),
            "{blanked:?} is inside a literal, so it is blanked: {mask:?}"
        );
    }
}

#[test]
fn comments_are_recovered_from_the_original_text() {
    let comments = comments_in(SAMPLE);
    let bodies: Vec<&str> = comments.iter().map(|c| c.text.as_str()).collect();
    assert!(
        bodies.contains(&" comment"),
        "a line comment's body, delimiter stripped: {bodies:?}"
    );
    assert!(
        bodies.iter().any(|body| body.starts_with(" one /* two ")),
        "a block comment's body, delimiters stripped: {bodies:?}"
    );
    assert_eq!(
        1,
        bodies
            .iter()
            .filter(|body| body.contains(" comment"))
            .count(),
        "the `//` inside a \
        string is not a comment: {bodies:?}"
    );
}

#[test]
fn condition_literals_read_both_forms() {
    let header = "if (\"getUsers\".equals(methodName)) {";
    let conditions = condition_literals(header, 0);
    assert_eq!(vec!["getUsers".to_string()], conditions.exact);
    assert_eq!(vec!["getUsers".to_string()], conditions.pasted);

    // Adjacent literals joined by whitespace or `+` are the pasted form's reason to exist.
    let pasted = condition_literals("if (\"get\" + \"Users\" == name) {", 0);
    assert_eq!(vec!["get".to_string(), "Users".to_string()], pasted.exact);
    assert_eq!(vec!["getUsers".to_string()], pasted.pasted);

    // A literal inside a comment on the same line is not reported.
    let commented = condition_literals("if (x) { // \"getUsers\"", 0);
    assert!(
        commented.pasted.is_empty(),
        "a commented literal is not a condition: {commented:?}"
    );
}

#[test]
fn the_default_annotation_test() {
    assert!(annotation_line("    @Override"));
    assert!(annotation_line("#[derive(Debug)]"));
    assert!(!annotation_line("    public String toString() {"));
    assert!(!annotation_line(""));
}

#[test]
fn the_default_lexer_reports_its_name_and_facts() {
    let lexer = DefaultLexer;
    assert_eq!("default", lexer.name());
    assert_eq!(masked(SAMPLE).unwrap(), lexer.mask(SAMPLE).unwrap());
    assert_eq!(comments_in(SAMPLE).len(), lexer.comments(SAMPLE).len());
    assert_eq!(1, lexer.condition_literals("if (\"a\") {", 0).exact.len());
    assert!(
        lexer.declarations("def add").is_empty(),
        "the default engine adds no shapes"
    );
}
