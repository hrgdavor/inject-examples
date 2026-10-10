package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;

import org.junit.jupiter.api.Test;

/**
 * The language table, checked as data.
 *
 * <p>The vectors pin the four languages whose constructs the language-agnostic union gets <em>wrong</em>
 * (Ruby, Haskell, Rust, Zig) because those are the ones a reference resolves differently through. The
 * other entries exist for the same kind of reason and are checked here instead: the mask invariant over
 * every entry, and one assertion per construct a table entry exists for. That is the honest split — a
 * table entry only changes <em>what is blanked</em>, never how the blanked text is walked, so it cannot
 * change an answer the vectors already cover.
 */
class SyntaxesTest {

    /** A source carrying every construct the table models, so each entry's reader runs over it. */
    private static final String SAMPLE = "line // comment\n"
            + "block /* one /* two */ still open */ end\n"
            + "string \"/* not a comment */\" and 'x' and `t`\n"
            + "raw r#\"no \\\" escape\"# and @\"verbatim \"\" quote\"\n"
            + "heredoc <<~TAG\nbody /* in the body */\nTAG\n"
            + "sql 'it''s' and $$ dollar $$\n"
            + "vb \"doubled \"\" quote\"\n"
            + "char 'a' lifetime 'b\n";

    @Test
    void everyEntryKeepsTheMaskInvariant() {
        for (Map.Entry<String, String> extension : Syntaxes.extensions().entrySet()) {
            Syntax syntax = Syntaxes.forName(extension.getValue());
            assertNotNull(syntax, extension.getKey() + " maps to a missing entry");
            assertEquals(extension.getValue(), syntax.name(),
                    extension.getKey() + " maps to a differently named entry");

            Tokenizer.Facts facts = Tokenizer.tokenize(SAMPLE, syntax);
            assertEquals(SAMPLE.length(), facts.masked().length(),
                    syntax.name() + " must preserve length");
            for (int i = 0; i < SAMPLE.length(); i++) {
                if (SAMPLE.charAt(i) == '\n') {
                    assertEquals('\n', facts.masked().charAt(i),
                            syntax.name() + " must preserve every newline offset (broken at " + i + ")");
                }
            }
        }
    }

    @Test
    void zigBlanksAWholeNestedComment() {
        // The construct the Zig entry exists for: the default mask is non-nesting, so it would stop at
        // the inner `*/` and leak `fn decoy` out as a real declaration.
        String zig = "/* outer /* inner */ fn decoy() void { x(); } */\n";
        assertFalse(Tokenizer.tokenize(zig, Syntaxes.ZIG).masked().contains("decoy"),
                "a nested comment must be blanked whole");
        assertTrue(Masker.masked(zig).contains("decoy"),
                "the default engine is non-nesting, which is why the entry exists");
    }

    @Test
    void rustTellsACharLiteralFromALifetime() {
        String rust = "fn f<'a>(x: &'static str) -> char { 'x' }\n";
        String masked = Tokenizer.tokenize(rust, Syntaxes.RUST).masked();
        assertTrue(masked.contains("'a>"), "a lifetime is code, not a string: " + masked);
        assertTrue(masked.contains("'static"), "so is 'static: " + masked);
        assertFalse(masked.contains("'x'"), "a char literal is blanked: " + masked);
    }

    @Test
    void rubyTakesAStrictHeredocButNotAShift() {
        String ruby = "items = array << x\nbody = <<~TAG\ncontent\nTAG\n";
        String masked = Tokenizer.tokenize(ruby, Syntaxes.RUBY).masked();
        assertTrue(masked.contains("array << x"), "a shift is not a heredoc: " + masked);
        assertFalse(masked.contains("content"), "a heredoc body is blanked: " + masked);
    }

    @Test
    void csharpDoublesItsVerbatimQuote() {
        String csharp = "var s = @\"a \"\" b\";\n";
        String masked = Tokenizer.tokenize(csharp, Syntaxes.CSHARP).masked().trim();
        assertTrue(masked.startsWith("var s ="), "the code before the string is untouched: " + masked);
        assertTrue(masked.endsWith(";"), "the doubled quote must not end the string: " + masked);
        assertFalse(masked.contains("\""), "the quotes are blanked: " + masked);
        assertFalse(masked.contains("b"), "the verbatim body is blanked: " + masked);
    }

    @Test
    void theUnknownTypeGetsTheDefaultEngine() {
        assertEquals(BlockScanner.DEFAULT, Syntaxes.lexerForPath("notes.txt"));
        assertEquals(BlockScanner.DEFAULT, Syntaxes.lexerForPath("Makefile"));
        assertEquals(BlockScanner.DEFAULT, Syntaxes.lexerForPath(null));
        assertEquals("ruby", Syntaxes.lexerForPath("a/b/Cart.RB").name());
        assertEquals("ruby", Syntaxes.lexerForPath("Rakefile.rake").name());
    }
}
