package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
 * <p>Every vector is asserted: the grammar and its exact error text <b>and</b> the stable failure
 * code beside it, and resolution against the fixture files the vectors name — each resolved through
 * the language the fixture's extension selects, exactly as a consumer picks one, with the default
 * engine for the types the table does not cover. A row that names a {@code parser} is read through
 * that entry point, and a row that resolves must carry no code at all.
 */
class SectionVectorsTest {

    /** Jackson 3 lives under {@code tools.jackson}, and its exceptions are unchecked. */
    private static final ObjectMapper JSON = new ObjectMapper();

    /** What a row's call did, so the accounting can place every row in exactly one bucket. */
    private enum Outcome {
        /** The row resolved, so there is no code to carry. */
        RESOLVED,
        /** The row failed as the corpus expects, so its code was compared with the vector's. */
        CODE_COMPARED,
        /**
         * The row did not fail as the corpus describes, so it is not counted as compared: it resolved
         * when an error was wanted, threw when it should have resolved, or raised a type that
         * contradicts its own {@code grammar/} code.
         */
        FAILED
    }

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

    /** The ranges a plan produced, in the vectors' own {@code [[from,to],…]} shape, for a message. */
    private static String describe(SectionResolver.Plan plan) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < plan.ranges().size(); i++) {
            if (i > 0) {
                out.append(',');
            }
            out.append('[').append(plan.ranges().get(i).from())
                    .append(',').append(plan.ranges().get(i).to()).append(']');
        }
        return out.append(']').toString();
    }

    @Test
    void everyVectorMatchesThisImplementation() throws IOException {
        JsonNode vectors = vectors();
        Path repository = vectorsFile().getParent().getParent().getParent();
        Map<String, String> fixtures = new HashMap<>();
        List<String> failures = new ArrayList<>();
        int asserted = 0;
        int codeCompared = 0;
        int noError = 0;
        int failed = 0;

        for (JsonNode vector : vectors) {
            String name = text(vector, "name");
            String reference = text(vector, "reference");
            String expectedError = text(vector, "error");
            String expectedCode = text(vector, "code");
            String parser = text(vector, "parser");
            String input = text(vector, "input");
            asserted++;

            // Each row states both halves of the band — a message and a code, or neither — and a row
            // that resolves carries `null`, because a row that produces no failure produces no code.
            // Asserting the pairing is what keeps "the code is asserted on every row" honest.
            if ((expectedError == null) != (expectedCode == null)) {
                failures.add(name + ": pairs error " + quote(expectedError) + " with code "
                        + quote(expectedCode));
            }

            if (input == null) {
                switch (checkReferenceGrammar(name, reference, expectedError, expectedCode, parser,
                        failures)) {
                    case CODE_COMPARED -> codeCompared++;
                    case RESOLVED -> noError++;
                    default -> failed++;
                }
                continue;
            }

            String source;
            try {
                source = fixtures.computeIfAbsent(input,
                        path -> read(repository.resolve(path)));
            } catch (RuntimeException unreadable) {
                failures.add(name + ": " + unreadable.getMessage());
                failed++;
                continue;
            }

            try {
                SectionResolver.Plan plan = SectionResolver.planSection(source, reference,
                        Syntaxes.lexerForPath(input));
                if (expectedError != null) {
                    failures.add(name + ": resolved to " + quote(plan.text()) + ", want error "
                            + quote(expectedError));
                    failed++;
                } else {
                    noError++;
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
                    // `ranges` is where each selector's contribution came from — one line range per
                    // selector, merged when they touch — and it is a newer field, so it is asserted
                    // whenever the vector carries it. A host that highlights two far-apart selectors
                    // reads this and not the gap between them.
                    JsonNode ranges = vector.get("ranges");
                    if (ranges != null && !ranges.isNull()) {
                        if (ranges.size() != plan.ranges().size()) {
                            failures.add(name + ": " + plan.ranges().size() + " range(s) "
                                    + describe(plan) + ", want " + ranges.size() + " " + ranges);
                        } else {
                            for (int i = 0; i < ranges.size(); i++) {
                                JsonNode want = ranges.get(i);
                                SectionResolver.Range got = plan.ranges().get(i);
                                if (want.get(0).asInt() != got.from()
                                        || want.get(1).asInt() != got.to()) {
                                    failures.add(name + ": range " + i + " ["
                                            + got.from() + "," + got.to() + "], want " + want);
                                }
                            }
                        }
                    }
                }
            } catch (SectionReferenceException error) {
                if (expectedError == null) {
                    reportThrown(name, expectedError, expectedCode, text(vector, "text"), error,
                            error.code(), "threw", failures);
                    failed++;
                } else {
                    reportThrown(name, expectedError, expectedCode, text(vector, "text"), error,
                            error.code(), "threw", failures);
                    codeCompared++;
                }
            } catch (SectionError error) {
                if (expectedError == null) {
                    reportThrown(name, expectedError, expectedCode, text(vector, "text"), error,
                            error.code(), "threw", failures);
                    failed++;
                } else {
                    reportThrown(name, expectedError, expectedCode, text(vector, "text"), error,
                            error.code(), "threw", failures);
                    codeCompared++;
                }
            }
        }

        // The counts print before the gate so a red run still shows the coverage: every row lands in
        // exactly one bucket — its code compared, resolved, or failed.
        System.out.println("vectors: " + asserted + " asserted, " + codeCompared
                + " with a code compared, " + noError + " resolving and " + failed + " failing");

        assertTrue(failures.isEmpty(),
                failures.size() + " of " + asserted + " vectors disagree with lib/section.mjs:"
                        + System.lineSeparator() + "  "
                        + String.join(System.lineSeparator() + "  ", failures));

        // Nothing may quietly leave the gate.
        assertEquals(vectors.size(), asserted, "every vector must be asserted");
        assertEquals(asserted, codeCompared + noError + failed,
                "every vector must land in exactly one bucket");
    }

    private static String read(Path file) {
        try {
            return Files.readString(file);
        } catch (IOException error) {
            throw new IllegalStateException("cannot read fixture " + file + ": " + error.getMessage(),
                    error);
        }
    }

    /**
     * The grammar-only vectors: success, or the exact error text <em>and</em> code.
     *
     * <p>{@code parser} names the entry point the row exercises: {@code parseSelectors} (the default
     * whole-reference reader) or {@code "path"}, the single-path-selector reader. The one row that
     * carries it is the discriminator between the two — {@code L40} is a legal selector and only the
     * path reader refuses it, because a line range is not a section path.
     */
    private static Outcome checkReferenceGrammar(String name, String reference, String expectedError,
                                                 String expectedCode, String parser,
                                                 List<String> failures) {
        boolean pathParser = "path".equals(parser);
        if (expectedError != null) {
            try {
                SectionReference parsed = pathParser
                        ? SectionReference.parseReference(reference)
                        : SectionReference.parse(reference);
                failures.add(name + ": parsed to " + quote(parsed.canonical()) + ", want error "
                        + quote(expectedError));
                return Outcome.FAILED;
            } catch (SectionReferenceException error) {
                reportThrown(name, expectedError, expectedCode, null, error, error.code(), "got",
                        failures);
                return Outcome.CODE_COMPARED;
            } catch (SectionError error) {
                // The bucket follows the row's own code namespace, not the exception type: only a
                // `grammar/` code implies the grammar type, and `reportThrown` has already turned a
                // violation of that into a failure. A `resolution/`-coded failure is compared on its
                // message and code wherever it was raised — the envelope-pair rows are exactly that
                // case, and they are legal rows this reader must be able to compare.
                reportThrown(name, expectedError, expectedCode, null, error, error.code(), "got",
                        failures);
                return expectedCode != null && expectedCode.startsWith("grammar/")
                        ? Outcome.FAILED : Outcome.CODE_COMPARED;
            }
        }

        try {
            if (pathParser) {
                SectionReference.parseReference(reference);
            } else {
                SectionReference.parse(reference);
            }
            return Outcome.RESOLVED;
        } catch (SectionReferenceException | SectionError error) {
            failures.add(name + ": failed with " + quote(error.getMessage()) + ", want success");
            return Outcome.FAILED;
        }
    }

    /**
     * One failure line for a thrown failure: the message it was shown with, the stable code a host
     * branches on, and the type the row's own code namespace implies — each part only when it
     * disagrees.
     *
     * <p>One line per row, because the report is a list of rows that disagree, not a list of facts:
     * a row that is wrong about its message <em>and</em> its code is still one row.
     *
     * <p>The type is asserted from the row's {@code code} namespace and never from the exception: a
     * {@code grammar/…} code requires a {@link SectionReferenceException}, while a {@code resolution/…}
     * code says which category the failure belongs to and not where it was raised — an envelope pair
     * is a {@code resolution/envelope-…} failure the reference reader raises without a file
     * (RFC 1 §3.6), so it asserts nothing about the type. So each catch hands its own failure to this
     * one report, and the namespace is what decides whether the type is part of the comparison.
     *
     * @param expectedError the vector's message, or {@code null} when the row resolves
     * @param expectedText  the vector's text, for the "want text" case of a resolving row
     * @param verb          how the mismatch reads: {@code threw} for a resolution row, {@code got} for
     *                      a parse-only one, whose existing wording is kept
     */
    private static void reportThrown(String name, String expectedError, String expectedCode,
                                     String expectedText, RuntimeException error, String code,
                                     String verb, List<String> failures) {
        List<String> notes = new ArrayList<>();
        if (expectedError == null) {
            notes.add("threw " + quote(error.getMessage()) + ", want text " + quote(expectedText));
        } else {
            if (!expectedError.equals(error.getMessage())) {
                notes.add(verb + " " + quote(error.getMessage()) + ", want " + quote(expectedError));
            }
            if (!Objects.equals(expectedCode, code)) {
                notes.add("code " + quote(code) + ", want " + quote(expectedCode));
            }
            // The type is asserted in one direction only, because only one namespace implies it: a
            // `grammar/…` code is raised while the reference is read and is always the grammar type,
            // while a `resolution/…` code says which category the failure belongs to and not where it
            // was raised — the envelope pair is a `resolution/envelope-…` failure the reference
            // reader raises without a file, so a resolution code asserts nothing about the type.
            if (expectedCode != null && expectedCode.startsWith("grammar/")
                    && !(error instanceof SectionReferenceException)) {
                notes.add("threw " + error.getClass().getSimpleName());
            }
        }
        if (!notes.isEmpty()) {
            failures.add(name + ": " + String.join("; ", notes));
        }
    }

    /**
     * The behaviours the vectors do not cover, pinned here so a port cannot quietly disagree with
     * {@code lib/section.mjs} about them: a modifier is a whole segment, it is legal only as the last
     * one, and a {@code -} that is not the whole segment is part of the name.
     */
    @Test
    void aModifierIsAWholeSegmentAndOnlyTheLastOne() {
        // `-` is a name character, so a trailing or leading hyphen is the name, not a modifier.
        assertEquals("add-", SectionReference.parse("add-").canonical());
        assertEquals(List.of("add-"), SectionReference.parse("add-").segments());
        assertEquals("--brand", SectionReference.parse("--brand").canonical());
        assertEquals(Scope.DECLARATION, SectionReference.parse("add-").scope());

        // As a whole segment it is the scope, and the names drop it.
        assertEquals("a/++", SectionReference.parse("a/++").canonical());
        assertEquals(List.of("a"), SectionReference.parse("a/++").segments());
        assertEquals(Scope.DOCUMENTED, SectionReference.parse("a/++").scope());
        assertEquals(Scope.BODY, SectionReference.parse("a/-").scope());

        // A modifier may not open a path, and may only modify the last segment.
        assertEquals("\"++\" may only modify the last path segment of \"#a/++/b\"",
                assertThrowsReferenceError("a/++/b", ErrorCodes.MODIFIER_NOT_LAST));
        assertEquals("\"-\" may only modify the last path segment of \"#a/-/b\"",
                assertThrowsReferenceError("a/-/b", ErrorCodes.MODIFIER_NOT_LAST));

        // `+` never occurs in a name, and the message names the spelling that works.
        assertEquals("\"++\" is a path segment now; write \"#add/++\"",
                assertThrowsReferenceError("add++", ErrorCodes.MODIFIER_OLD_SPELLING));
        assertEquals("\"+\" is a path segment now; write \"#b/+\"",
                assertThrowsReferenceError("a/b+", ErrorCodes.MODIFIER_OLD_SPELLING));
        assertEquals("\"+\" is a path segment now; it follows the path, as \"#<path>/+\"",
                assertThrowsReferenceError("+add", ErrorCodes.MODIFIER_OLD_SPELLING));

        // A run of modifier characters longer than a modifier is malformed, not a name.
        assertEquals("\"#a/+++\" carries more than one modifier",
                assertThrowsReferenceError("a/+++", ErrorCodes.TOO_MANY_MODIFIERS));
    }

    private static String assertThrowsReferenceError(String raw, String expectedCode) {
        try {
            SectionReference parsed = SectionReference.parse(raw);
            org.junit.jupiter.api.Assertions.fail("expected " + quote(raw) + " to be malformed, but it"
                    + " parsed to " + quote(parsed.canonical()));
            return null;
        } catch (SectionReferenceException error) {
            assertEquals(expectedCode, error.code(), quote(raw) + ": code");
            return error.getMessage();
        }
    }

    /**
     * The discriminator the {@code parser} field names, pinned here: {@code L40} is a legal
     * <em>selector</em> and not a legal <em>path</em>. That is the only reason a row says which entry
     * point reads it — {@code parseSelectors} accepts a line range, and {@code parseReference} is the
     * single-path reader that refuses it.
     */
    @Test
    void aLineRangeIsASelectorButNotAPath() {
        assertTrue(SectionReference.parse("L40").isLineRange());
        assertEquals("L40", SectionReference.parse("L40").canonical());

        try {
            SectionReference.parseReference("L40");
            org.junit.jupiter.api.Assertions.fail("expected the path reader to refuse a line range");
        } catch (SectionReferenceException error) {
            assertEquals("\"#L40\" is a line range, not a section path", error.getMessage());
            assertEquals(ErrorCodes.LINE_RANGE_AS_PATH, error.code());
        }
    }

    /** A guard the assertions above rely on: a parsed reference always has at least one segment. */
    @Test
    void everyParsedReferenceHasSegmentsAndAFinalSegment() {
        SectionReference parsed = SectionReference.parse("Cart/Line/render/-");
        assertNotNull(parsed.finalSegment());
        assertEquals("render", parsed.finalSegment());
        assertEquals(Scope.BODY, parsed.scope());
    }
}
