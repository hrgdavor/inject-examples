package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The lexical parity gate: what each language masks, and what each language's declaration shapes
 * report.
 *
 * <p>{@code test/vectors/section-vectors.json} pins <em>resolution</em>, and can only do that through
 * the fixtures it names — six of the eighteen lexer entries. It therefore says nothing about the shape
 * layer on its own: a port whose field matcher read {@code publisher: String,} as the field
 * {@code lisher}, or which found no declaration in {@code impl<T: Clone> Display for Cart<T> {},}
 * would still pass every resolution vector, because no fixture contains those lines.
 *
 * <p>{@code test/vectors/lexical-vectors.json} is generated from the JavaScript by
 * {@code tools/lexical-vectors.mjs} and closes both holes: one mask row per lexer entry (plus the
 * built-in engine for an unknown type), and one shape row per discriminating spelling. Both are
 * asserted exhaustively here, and every row that exists must be asserted, so nothing leaves the gate
 * quietly.
 */
class LexicalVectorsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Path vectorsFile() {
        Path directory = Paths.get("").toAbsolutePath();
        for (int level = 0; level < 8 && directory != null; level++) {
            Path candidate = directory.resolve("test/vectors/lexical-vectors.json");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            directory = directory.getParent();
        }
        throw new AssertionError(
                "test/vectors/lexical-vectors.json not found above " + Paths.get("").toAbsolutePath());
    }

    private static JsonNode corpus() throws IOException {
        return JSON.readTree(Files.readString(vectorsFile()));
    }

    private static String text(JsonNode node, String key) {
        JsonNode value = node.get(key);
        return value == null || value.isNull() ? null : value.asString();
    }

    private static String quote(String value) {
        if (value == null) {
            return "null";
        }
        return "\"" + value.replace("\\", "\\\\").replace("\n", "\\n").replace("\t", "\\t") + "\"";
    }

    /** Everything a shape row asserts about one declaration, as text, for a readable diff. */
    private static String describe(BlockScanner.Declared declared) {
        return declared.kind() + "/" + declared.name() + " headerFrom=" + declared.headerFrom()
                + " body=" + declared.body() + " end=" + declared.end() + " line=" + declared.line();
    }

    private static String describe(JsonNode declared) {
        return text(declared, "kind") + "/" + text(declared, "name") + " headerFrom="
                + declared.get("headerFrom").asInt() + " body=" + text(declared, "body") + " end="
                + text(declared, "end") + " line=" + declared.get("line").asBoolean();
    }

    @Test
    void everyMaskMatchesThisImplementation() throws IOException {
        List<String> failures = new ArrayList<>();
        int asserted = 0;

        for (JsonNode vector : corpus().get("masks")) {
            String name = text(vector, "name");
            String path = text(vector, "path");
            String source = text(vector, "source");
            String expected = text(vector, "masked");
            asserted++;

            BlockScanner.Lexer lexer = Syntaxes.lexerForPath(path);
            String masked = lexer.mask(source);

            if (!masked.equals(expected)) {
                failures.add(name + ": mask " + quote(masked) + ", want " + quote(expected));
            }
            // A mask is only useful if it is a mask: same length, and every newline still at its own
            // offset, so a declaration's body can neither end early nor run past its line.
            if (masked.length() != source.length()) {
                failures.add(name + ": the mask changed the length, " + masked.length() + " for "
                        + source.length());
            }
            for (int i = 0; i < Math.min(masked.length(), source.length()); i++) {
                if (source.charAt(i) == '\n' && masked.charAt(i) != '\n') {
                    failures.add(name + ": the mask moved the newline at " + i);
                    break;
                }
            }
        }

        assertTrue(failures.isEmpty(),
                failures.size() + " of " + asserted + " masks disagree with lib/section.mjs:"
                        + System.lineSeparator() + "  "
                        + String.join(System.lineSeparator() + "  ", failures));

        assertEquals(corpus().get("masks").size(), asserted, "every mask vector must be asserted");
        System.out.println("masks: " + asserted + " asserted, all matching lib/section.mjs");
    }

    @Test
    void everyDeclarationShapeMatchesThisImplementation() throws IOException {
        List<String> failures = new ArrayList<>();
        int asserted = 0;

        for (JsonNode vector : corpus().get("shapes")) {
            String name = text(vector, "name");
            String path = text(vector, "path");
            String line = text(vector, "line");
            JsonNode expected = vector.get("declared");
            asserted++;

            List<BlockScanner.Declared> declared =
                    Syntaxes.lexerForPath(path).declarations(line);
            if (declared.size() != expected.size()) {
                failures.add(name + " (" + quote(line) + "): " + declared.size()
                        + " declaration(s), want " + expected.size());
                continue;
            }
            for (int i = 0; i < declared.size(); i++) {
                if (!describe(declared.get(i)).equals(describe(expected.get(i)))) {
                    failures.add(name + " (" + quote(line) + "): [" + i + "] got "
                            + describe(declared.get(i)) + ", want " + describe(expected.get(i)));
                }
            }
        }

        assertTrue(failures.isEmpty(),
                failures.size() + " of " + asserted + " shapes disagree with lib/section.mjs:"
                        + System.lineSeparator() + "  "
                        + String.join(System.lineSeparator() + "  ", failures));

        assertEquals(corpus().get("shapes").size(), asserted, "every shape vector must be asserted");
        System.out.println("shapes: " + asserted + " asserted, all matching lib/section.mjs");
    }

    /**
     * The corpus is only a gate if every entry is in it: a language added to the table without a mask
     * row would otherwise be free to disagree with the JavaScript. The languages are read from the
     * extension registry, so the two cannot drift.
     */
    @Test
    void theCorpusCoversEveryLexerEntry() throws IOException {
        Set<String> covered = new HashSet<>();
        boolean defaultEngine = false;
        for (JsonNode vector : corpus().get("masks")) {
            String path = text(vector, "path");
            if (path == null) {
                defaultEngine = true;
                continue;
            }
            int dot = path.lastIndexOf('.');
            if (dot <= 0) {
                continue;
            }
            String language = Syntaxes.extensions().get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (language != null) {
                covered.add(language);
            }
        }

        for (String language : new HashSet<>(Syntaxes.extensions().values())) {
            assertTrue(covered.contains(language), "no mask vector covers the " + language + " entry");
        }
        assertTrue(defaultEngine, "the corpus covers the unknown type that gets the default engine");
    }
}
