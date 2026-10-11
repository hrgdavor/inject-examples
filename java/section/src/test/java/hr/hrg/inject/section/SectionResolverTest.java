package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * The public API, on a small example, so a host can see what a call looks like.
 *
 * <p>Scope matters here: this is the <b>code-section</b> matcher, the Java counterpart of
 * {@code lib/section.mjs}. The data-format rules — a JSON key path, a YAML dotted path, a TOML or INI
 * section — are not part of that module: they are the consumer's, chosen by file type (the spec's
 * "vendorable module boundary" section says the module exports "the matching algorithm only", and the
 * plan set keeps the YAML, TOML and INI rules in {@code index.mjs} and {@code src/data_rules.zig}).
 */
class SectionResolverTest {

    private static final String JAVA = "class Cart {\n"
            + "    void add() {\n"
            + "        count++;\n"
            + "    }\n"
            + "}\n";

    @Test
    void aDeclarationItsBodyAndAPath() {
        String declaration = SectionResolver.resolveSection(JAVA, "add");
        assertTrue(declaration.startsWith("    void add() {"), declaration);
        assertTrue(declaration.endsWith("}"), declaration);

        // `-` asks for the body alone.
        assertEquals("count++;", SectionResolver.resolveSection(JAVA, "add-").trim());

        // A path descends: `Cart` narrows the scope, `add` selects inside it.
        assertEquals(declaration, SectionResolver.resolveSection(JAVA, "Cart/add"));

        // A class-like match is the whole declaration, and the file is scope 0 either way.
        assertTrue(SectionResolver.resolveSection(JAVA, "Cart").startsWith("class Cart {"));
    }

    @Test
    void extractDeclarationAgreesWithTheSameNamePath() {
        assertEquals(SectionResolver.resolveSection(JAVA, "add"),
                SectionResolver.extractDeclaration(JAVA, "add"));
        assertEquals(null, SectionResolver.extractDeclaration(JAVA, "missing"));
    }

    @Test
    void aWellFormedReferenceThatMatchesNothingSaysSo() {
        SectionError error = assertThrows(SectionError.class,
                () -> SectionResolver.resolveSection(JAVA, "missing"));
        assertEquals("no \"#region missing\" found, and no section named \"missing\"",
                error.getMessage());
    }

    /**
     * A malformed reference is a different failure from a missing one, which is why the two have
     * different types: the caller can tell "the document is wrong" from "the file does not have that".
     */
    @Test
    void aMalformedReferenceIsNotAMissingOne() {
        assertThrows(SectionReferenceException.class,
                () -> SectionResolver.resolveSection(JAVA, "a//b"));
        assertThrows(SectionReferenceException.class,
                () -> SectionResolver.resolveSection(JAVA, "a/+b"));
    }

    /** The plan exposes the parsed reference, so a host can surface the contradiction warning. */
    @Test
    void thePlanCarriesTheReferenceAndItsWarning() {
        SectionResolver.Plan plan = SectionResolver.planSection(JAVA, "add++-", BlockScanner.DEFAULT);
        assertEquals("add++", plan.reference().canonical());
        assertTrue(plan.reference().warningIfAny().isPresent());
        assertEquals(Warning.KIND_CONTRADICTION, plan.reference().warning().kind());
    }

    // ------------------------------------------------------------------
    // The selector list: `add,render`, and each selector's own scope
    // ------------------------------------------------------------------

    /** Two selectors are two sections, joined in the order they were written. */
    @Test
    void aCommaSeparatedReferenceSelectsEverySelector() {
        SectionResolver.Plan plan = SectionResolver.planSection(JAVA, "add,Cart", BlockScanner.DEFAULT);

        assertEquals("    void add() {\n        count++;\n    }\n"
                + "class Cart {\n    void add() {\n        count++;\n    }\n}", plan.text());
        assertEquals("multiple", plan.kind());
        assertEquals(List.of(new SectionResolver.Range(2, 4), new SectionResolver.Range(1, 5)),
                plan.ranges());
        // The whole selection's outermost bounds.
        assertEquals(1, plan.startLine());
        assertEquals(5, plan.endLine());

        // Two selectors, and neither reaches the whole file.
        assertEquals(2, plan.reference().selectors().size());
        assertEquals("Cart", plan.reference().selectors().get(1).text());
    }

    /**
     * The reference's own modifier reaches the <b>last</b> selector and nobody else, so
     * {@code add-,add} is a body and then a whole declaration — the difference between "one selector
     * with two modifiers" and "two selectors that each say what they mean".
     */
    @Test
    void theReferenceModifierReachesOnlyTheLastSelector() {
        SectionResolver.Plan plan = SectionResolver.planSection(JAVA, "add-,add", BlockScanner.DEFAULT);

        assertEquals(2, plan.reference().selectors().size());
        assertEquals(Scope.BODY, plan.reference().selectors().get(0).scope());
        assertEquals(Scope.DECLARATION, plan.reference().selectors().get(1).scope());
        assertEquals("        count++;\n    void add() {\n        count++;\n    }", plan.text());

        // A leading modifier of the whole reference is the reference's own too, and spells to the end,
        // exactly as {@code -add} is {@code add-}: it does not stay on the selector it was written in
        // front of. The vectors pin the same reading (`-toString,Line` renders as `toString,Line-`).
        assertEquals("add-,add-", SectionReference.parse("-add-,add").canonical());
        assertEquals("add-,add-", SectionReference.parse("add-,add-").canonical());
    }

    /** Each selector keeps the spelling it was written with, and only the last is respelled. */
    @Test
    void theCanonicalFormKeepsEverySelectorButTheLast() {
        // `add-` and `render++` are each selector's own spelling and survive verbatim; `remove+` is the
        // last selector, so it is respelled from its path with the reference's modifier left where it
        // is written.
        SectionReference parsed = SectionReference.parse("add-,render++,remove+");
        assertEquals("add-,render++,remove+", parsed.canonical());
        assertEquals(List.of(Scope.BODY, Scope.DOCUMENTED, Scope.ANNOTATED),
                List.of(parsed.selectors().get(0).scope(), parsed.selectors().get(1).scope(),
                        parsed.selectors().get(2).scope()));
        assertEquals(List.of("add", "render", "remove"), List.of(
                parsed.selectors().get(0).segments().get(0),
                parsed.selectors().get(1).segments().get(0),
                parsed.selectors().get(2).segments().get(0)));

        // A leading run is the reference's own even mid-list, so it moves to the last selector.
        assertEquals("add-,Cart,add", SectionReference.parse("add-,Cart,+add").canonical());
        assertEquals("Cart/Line/render-,Cart",
                SectionReference.parse("Cart/Line/render-,Cart").canonical());
        assertEquals("add,Cart", SectionReference.parse(" add , Cart ").canonical());
    }

    /** A reference of one path selector keeps every field the single-reference grammar had. */
    @Test
    void aSinglePathSelectorStillReportsItsSegmentsAndScope() {
        SectionReference parsed = SectionReference.parse("Cart/Line/render-");
        assertEquals(List.of("Cart", "Line", "render"), parsed.segments());
        assertEquals("render", parsed.finalSegment());
        assertEquals(Scope.BODY, parsed.scope());
        assertEquals(1, parsed.selectors().size());
        assertNull(parsed.warning());
    }

    // ------------------------------------------------------------------
    // Line ranges
    // ------------------------------------------------------------------

    /** A line range is a raw slice of the file, counted from 1 and inclusive at both ends. */
    @Test
    void aLineRangeSelectsVerbatimLines() {
        SectionResolver.Plan plan = SectionResolver.planSection(JAVA, "L2-L3", BlockScanner.DEFAULT);
        assertEquals("    void add() {\n        count++;", plan.text());
        assertEquals("lines", plan.kind());
        assertEquals(List.of(new SectionResolver.Range(2, 3)), plan.ranges());
        assertEquals(2, plan.startLine());
        assertEquals(3, plan.endLine());

        // One line, and a column within it: columns are 1-based and inclusive at both ends.
        assertEquals("    void add() {", SectionResolver.resolveSection(JAVA, "L2"));
        assertEquals("add", SectionResolver.resolveSection(JAVA, "L2:10-L2:12"));
        assertEquals("add() {", SectionResolver.resolveSection(JAVA, "L2:10"));
    }

    /**
     * A range the file does not have is an error, never a clamp: a reference to a line number that
     * silently became a different line is exactly the drift the line numbers exist to avoid. The
     * lengths are UTF-16 code units, as the JavaScript's {@code .length} counts them.
     */
    @Test
    void aLineRangePastTheFileIsAnErrorRatherThanAClamp() {
        SectionError pastTheEnd = assertThrows(SectionError.class,
                () -> SectionResolver.planSection(JAVA, "L9", BlockScanner.DEFAULT));
        assertEquals("\"#L9\": the file has 6 line(s)", pastTheEnd.getMessage());

        SectionError pastTheColumn = assertThrows(SectionError.class,
                () -> SectionResolver.planSection(JAVA, "L2:99", BlockScanner.DEFAULT));
        assertEquals("\"#L2:99\": line 2 has 16 character(s)", pastTheColumn.getMessage());
    }

    /** A malformed line range is a reference error, and its message is part of the contract. */
    @Test
    void aMalformedLineRangeSaysWhatToWriteInstead() {
        assertEquals("\"#L2-\" is not a line range; write L<line> or L<line>:<column>",
                referenceError("L2-"));
        assertEquals("\"#L2:0\" counts lines and columns from 1", referenceError("L2:0"));
        assertEquals("\"#L3-L2\" ends before it starts", referenceError("L3-L2"));
        // A line range takes no modifier of its own.
        assertEquals("\"#L2-L3+\" is not a line range; write L<line> or L<line>:<column>",
                referenceError("L2-L3+"));

        // A leading modifier of the whole reference is the reference's own, and a range ignores it.
        SectionReference parsed = SectionReference.parse("+L2-L3");
        assertEquals("L2-L3+", parsed.canonical());
        assertTrue(parsed.isLineRange());
        assertEquals("    void add() {\n        count++;",
                SectionResolver.resolveSection(JAVA, "+L2-L3"));
    }

    /** {@code Lx} opens no digit, so it is a name — and an ordinary one, which matches nothing here. */
    @Test
    void aNameThatOnlyLooksLikeALineRangeIsStillAName() {
        SectionReference parsed = SectionReference.parse("Lx");
        assertEquals(List.of("Lx"), parsed.segments());
        assertThrows(SectionError.class, () -> SectionResolver.resolveSection(JAVA, "Lx"));
    }

    // ------------------------------------------------------------------
    // The grammar entry points
    // ------------------------------------------------------------------

    /**
     * {@link SectionReference#parseReference(String)} is the single <em>path</em> grammar: it refuses a
     * comma and a line range with the message that grammar uses, which is what {@code parseReference}
     * does in {@code lib/section.mjs}.
     */
    @Test
    void parseReferenceRefusesWhatIsNotOnePath() {
        assertEquals("add", SectionReference.parseReference("add").canonical());
        assertEquals("\"#add,render\" has an empty selector",
                referenceError(() -> SectionReference.parseReference("add,render")));
        assertEquals("\"#L2-L3\" is a line range, not a section path",
                referenceError(() -> SectionReference.parseReference("L2-L3")));
    }

    /** The same modifier twice is malformed, wherever the two runs were written. */
    @Test
    void theSameModifierTwiceIsAnError() {
        assertEquals("\"#a+++\" carries more than one modifier", referenceError("a+++"));
        assertEquals("\"#a---\" carries more than one modifier", referenceError("a---"));
        assertEquals("\"#-a-\" carries more than one modifier", referenceError("-a-"));
    }

    private static String referenceError(String raw) {
        return referenceError(() -> SectionReference.parse(raw));
    }

    private static String referenceError(Runnable call) {
        SectionReferenceException error = assertThrows(SectionReferenceException.class, call::run);
        return error.getMessage();
    }
}
