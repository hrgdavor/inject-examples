//! The language table, checked as data.
//!
//! The conformance vectors pin the four languages whose constructs the language-agnostic union gets
//! *wrong* — Ruby, Haskell, Rust, Zig — because those are the ones a reference resolves differently
//! through. The rest of the entries exist for the same kind of reason and are checked here instead: the
//! mask invariant over every entry, and one assertion per construct an entry exists for. Unlike the Java
//! port, this port's declaration shapes are hand-written matchers rather than regular expressions, so
//! these tests are also what stands in for "the regex was translated correctly".

use inject_sections::syntaxes::{extensions, lexer_for_path, syntax_by_name};
use inject_sections::tokenizer::tokenize;

/// A source carrying every construct the table models, so each entry's reader runs over it.
const SAMPLE: &str = "line // comment\n\
                      block /* one /* two */ still open */ end\n\
                      string \"/* not a comment */\" and 'x' and `t`\n\
                      raw r#\"no \\\" escape\"# and @\"verbatim \"\" quote\"\n\
                      heredoc <<~TAG\nbody /* in the body */\nTAG\n\
                      sql 'it''s' and $$ dollar $$\n\
                      vb \"doubled \"\" quote\"\n\
                      char 'a' lifetime 'b\n";

#[test]
fn every_entry_keeps_the_mask_invariant() {
    for (extension, name) in extensions() {
        let syntax = syntax_by_name(name)
            .unwrap_or_else(|| panic!("{extension} maps to a missing entry"));
        assert_eq!(*name, syntax.name, "{extension} maps to a differently named entry");

        let facts = tokenize(SAMPLE, &syntax).expect("every entry keeps the invariant");
        let source: Vec<u16> = SAMPLE.encode_utf16().collect();
        let masked: Vec<u16> = facts.masked.encode_utf16().collect();
        assert_eq!(source.len(), masked.len(), "{} must preserve length", syntax.name);
        for (i, unit) in source.iter().enumerate() {
            if *unit == b'\n' as u16 {
                assert_eq!(
                    b'\n' as u16,
                    masked[i],
                    "{} must preserve every newline offset (broken at {i})",
                    syntax.name
                );
            }
        }
    }
}

#[test]
fn zig_blanks_a_whole_nested_comment() {
    // The construct the Zig entry exists for: the default mask is non-nesting, so it would stop at the
    // inner `*/` and leak `fn decoy` out as a real declaration.
    let zig = "/* outer /* inner */ fn decoy() void { x(); } */\n";
    let masked = tokenize(zig, &syntax_by_name("zig").unwrap()).unwrap().masked;
    assert!(!masked.contains("decoy"), "a nested comment is blanked whole: {masked:?}");
}

#[test]
fn rust_tells_a_char_literal_from_a_lifetime() {
    let rust = "fn f<'a>(x: &'static str) -> char { 'x' }\n";
    let masked = tokenize(rust, &syntax_by_name("rust").unwrap()).unwrap().masked;
    assert!(masked.contains("'a>"), "a lifetime is code, not a string: {masked:?}");
    assert!(masked.contains("'static"), "so is 'static: {masked:?}");
    assert!(!masked.contains("'x'"), "a char literal is blanked: {masked:?}");
}

#[test]
fn ruby_takes_a_strict_heredoc_but_not_a_shift() {
    let ruby = "items = array << x\nbody = <<~TAG\ncontent\nTAG\n";
    let masked = tokenize(ruby, &syntax_by_name("ruby").unwrap()).unwrap().masked;
    assert!(masked.contains("array << x"), "a shift is not a heredoc: {masked:?}");
    assert!(!masked.contains("content"), "a heredoc body is blanked: {masked:?}");
}

#[test]
fn csharp_doubles_its_verbatim_quote() {
    let csharp = "var s = @\"a \"\" b\";\n";
    let masked = tokenize(csharp, &syntax_by_name("csharp").unwrap()).unwrap().masked;
    let masked = masked.trim();
    assert!(masked.starts_with("var s ="), "the code before the string is untouched: {masked:?}");
    assert!(masked.ends_with(';'), "the doubled quote must not end the string: {masked:?}");
    assert!(!masked.contains('"'), "the quotes are blanked: {masked:?}");
    assert!(!masked.contains('b'), "the verbatim body is blanked: {masked:?}");
}

#[test]
fn the_unknown_type_gets_the_default_engine() {
    assert_eq!("default", lexer_for_path("notes.txt").name());
    assert_eq!("default", lexer_for_path("Makefile").name());
    assert_eq!("ruby", lexer_for_path("a/b/Cart.RB").name());
    assert_eq!("ruby", lexer_for_path("Rakefile.rake").name());
    assert_eq!("zig", lexer_for_path("src/nesting.zig").name());
}
