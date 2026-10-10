package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The parity gate: the golden vectors, against this implementation.
 *
 * <p>{@code test/vectors/section-vectors.json} is the conformance set the JavaScript matcher is held
 * to, and the rule for a port is that it mirrors rather than leads ({@code plans/zig-port.md} §2). So
 * this test reads that file directly instead of keeping a generated copy: the Zig port needs
 * {@code tools/zig-vectors.mjs} because it has no JSON reader, while Java has one as a test-only
 * dependency, and a file that cannot drift is better than one that can.
 *
 * <p>Every vector is asserted: the grammar and its exact error text, the contradiction warning, and
 * resolution against the fixture files the vectors name — each resolved through the language the
 * fixture's extension selects, exactly as a consumer picks one, with the default engine for the types
 * the table does not cover.
 */
class SectionVectorsTest {

    /** Jackson 3 lives under {@code tools.jackson}, and its exceptions are unchecked. */
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Walks up from the working directory until it finds the vector file, as the plan set expects. */
    private static Path vectorsFile() {
        Path directory = Paths.get("").toAbsolutePath();
        for (int level = 0; level < 8 && directory != null; level++) {
            Path candidate = directory.resolve("test/vectors/section-vectors.json");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            directory = directory.getParent();
        }
        throw new AssertionError(
                "test/vectors/section-vectors.json not found above " + Paths.get("").toAbsolutePath());
    }

    private static JsonNode vectors() throws IOException {
        return JSON.readTree(Files.readString(vectorsFile()));
    }

    /** A vector's field: {@code null} in JSON and an absent field mean the same thing here. */
    private static String text(JsonNode vector, String key) {
        JsonNode value = vector.get(key);
        return value == null || value.isNull() ? null : value.asString();
    }

    /** A vector's integer field, or null when it is absent. */
    private static Integer number(JsonNode vector, String key) {
        JsonNode value = vector.get(key);
        return value == null || value.isNull() ? null : value.asInt();
    }

    private static String quote(String value) {
        if (value == null) {
            return "null";
        }
        return "\"" + value.replace("\\", "\\\\").replace("\n", "\\n").replace("\t", "\\t") + "\"";
    }

    @Test
    void everyVectorMatchesThisImplementation() throws IOException {
        JsonNode vectors = vectors();
        Path repository = vectorsFile().getParent().getParent().getParent();
        Map<String, String> fixtures = new HashMap<>();
        List<String> failures = new ArrayList<>();
        int asserted = 0;

        for (JsonNode vector : vectors) {
            String name = text(vector, "name");
            String reference = text(vector, "reference");
            String expectedError = text(vector, "error");
            String input = text(vector, "input");
            asserted++;

            if (input == null) {
                checkReferenceGrammar(vector, name, reference, expectedError, failures);
                continue;
            }

            String source;
            try {
                source = fixtures.computeIfAbsent(input,
                        path -> read(repository.resolve(path)));
            } catch (RuntimeException unreadable) {
                failures.add(name + ": " + unreadable.getMessage());
                continue;
            }

            try {
                SectionResolver.Plan plan = SectionResolver.planSection(source, reference,
                        Syntaxes.lexerForPath(input));
                if (expectedError != null) {
                    failures.add(name + ": resolved to " + quote(plan.text()) + ", want error "
                            + quote(expectedError));
                } else {
                    if (!Objects.equals(text(vector, "text"), plan.text())) {
                        failures.add(name + ": text " + quote(plan.text()) + ", want "
                                + quote(text(vector, "text")));
                    }
                    // The span and the matcher are part of the answer, not decoration: a host navigates
                    // to the span and explains itself with the kind, so both are asserted against the
                    // JavaScript's own answers — the bytes alone would let the two engines drift here.
                    Integer startLine = number(vector, "startLine");
                    if (startLine != null && startLine != plan.startLine()) {
                        failures.add(name + ": startLine " + plan.startLine() + ", want " + startLine);
                    }
                    Integer endLine = number(vector, "endLine");
                    if (endLine != null && endLine != plan.endLine()) {
                        failures.add(name + ": endLine " + plan.endLine() + ", want " + endLine);
                    }
                    String kind = text(vector, "kind");
                    if (kind != null && !kind.equals(plan.kind())) {
                        failures.add(name + ": kind " + quote(plan.kind()) + ", want " + quote(kind));
                    }
                }
            } catch (SectionReferenceException | SectionError error) {
                if (expectedError == null) {
                    failures.add(name + ": threw " + quote(error.getMessage()) + ", want text "
                            + quote(text(vector, "text")));
                } else if (!expectedError.equals(error.getMessage())) {
                    failures.add(name + ": threw " + quote(error.getMessage()) + ", want "
                            + quote(expectedError));
                }
            }
        }

        assertTrue(failures.isEmpty(),
                failures.size() + " of " + asserted + " vectors disagree with lib/section.mjs:"
                        + System.lineSeparator() + "  "
                        + String.join(System.lineSeparator() + "  ", failures));

        // Nothing may quietly leave the gate.
        assertEquals(vectors.size(), asserted, "every vector must be asserted");
        System.out.println("vectors: " + asserted + " asserted, all matching lib/section.mjs");
    }

    private static String read(Path file) {
        try {
            return Files.readString(file);
        } catch (IOException error) {
            throw new IllegalStateException("cannot read fixture " + file + ": " + error.getMessage(),
                    error);
        }
    }

    /** The grammar-only vectors: success, exact error text, or the contradiction warning. */
    private static void checkReferenceGrammar(JsonNode vector, String name, String reference,
                                              String expectedError, List<String> failures) {
        if (expectedError != null) {
            try {
                SectionReference parsed = SectionReference.parse(reference);
                failures.add(name + ": parsed to " + quote(parsed.canonical()) + ", want error "
                        + quote(expectedError));
            } catch (SectionReferenceException error) {
                if (!expectedError.equals(error.getMessage())) {
                    failures.add(name + ": got " + quote(error.getMessage()) + ", want "
                            + quote(expectedError));
                }
            }
            return;
        }

        SectionReference parsed;
        try {
            parsed = SectionReference.parse(reference);
        } catch (SectionReferenceException error) {
            failures.add(name + ": failed with " + quote(error.getMessage()) + ", want success");
            return;
        }

        JsonNode expectedWarning = vector.get("warning");
        if (expectedWarning == null || expectedWarning.isNull()) {
            if (parsed.warning() != null) {
                failures.add(name + ": warned " + parsed.warning() + ", want no warning");
            }
            return;
        }
        Warning warning = parsed.warning();
        if (warning == null) {
            failures.add(name + ": no warning, want " + expectedWarning);
            return;
        }
        assertEquals(text(expectedWarning, "kind"), warning.kind(), name + ": warning kind");
        assertEquals(text(expectedWarning, "kept"), warning.kept(),
                name + ": the modifier that should have won");
        assertEquals(text(expectedWarning, "dropped"), warning.dropped(),
                name + ": the modifier that should have been dropped");
        assertTrue(warning.message().contains("contradicts"),
                name + ": the warning must say what contradicts what: " + warning.message());
    }

    /**
     * The one behaviour the vectors do <em>not</em> cover, pinned here so a port cannot quietly
     * disagree with {@code lib/section.mjs} about it: a modifier written on a segment that is not the
     * last is collected and applied to the last segment, rather than rejected.
     */
    @Test
    void aModifierWrittenMidPathIsCollectedNotRejected() {
        assertEquals("a/b++", SectionReference.parse("a++/b").canonical());
        assertEquals("a/b-", SectionReference.parse("a-/b").canonical());

        // The other half of the asymmetry, which the vectors do cover: `-` may lead the last segment,
        // `+` and `++` may only be the whole reference's prefix.
        assertEquals("a/b-", SectionReference.parse("a/-b").canonical());
        assertEquals("a/b+", SectionReference.parse("+a/b").canonical());
        assertEquals("\"+\" may only modify the last path segment of \"#a/+b\"",
                assertThrowsReferenceError("a/+b"));
        assertEquals("\"++\" may only modify the last path segment of \"#a/++b\"",
                assertThrowsReferenceError("a/++b"));
    }

    private static String assertThrowsReferenceError(String raw) {
        try {
            SectionReference parsed = SectionReference.parse(raw);
            org.junit.jupiter.api.Assertions.fail("expected " + quote(raw) + " to be malformed, but it"
                    + " parsed to " + quote(parsed.canonical()));
            return null;
        } catch (SectionReferenceException error) {
            return error.getMessage();
        }
    }

    /** A guard the assertions above rely on: a parsed reference always has at least one segment. */
    @Test
    void everyParsedReferenceHasSegmentsAndAFinalSegment() {
        SectionReference parsed = SectionReference.parse("Cart/Line/render-");
        assertNotNull(parsed.finalSegment());
        assertEquals("render", parsed.finalSegment());
        assertEquals(Scope.BODY, parsed.scope());
        assertNull(parsed.warning());
    }
}
