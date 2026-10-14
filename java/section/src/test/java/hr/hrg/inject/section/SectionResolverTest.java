package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
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

        // `-` asks for the body alone, and it is a whole segment after the path.
        assertEquals("count++;", SectionResolver.resolveSection(JAVA, "add/-").trim());

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
    void extractDeclarationReadsAPropertyAndAnEnumConstant() {
        // A property is a selection with no body of its own: the statement *is* what is injected. Extraction used
        // to skip every one of them, so the two entry points disagreed on exactly the declarations this rule names
        // (2026-10-13).
        String field = "public class A {\n    private final String plain = \"x\";\n}\n";
        assertEquals("    private final String plain = \"x\";",
                SectionResolver.extractDeclaration(field, "plain"));
        assertEquals(SectionResolver.resolveSection(field, "plain"),
                SectionResolver.extractDeclaration(field, "plain"));

        String enums = "public enum E {\n    CALL,\n    /** the paid tier */\n    @Deprecated\n    PAID(1);\n}\n";
        assertEquals("    CALL,", SectionResolver.extractDeclaration(enums, "CALL"));
        assertEquals("    PAID(1);", SectionResolver.extractDeclaration(enums, "PAID"));
        assertEquals("    @Deprecated\n    PAID(1);",
                SectionResolver.extractDeclaration(enums, "PAID", Scope.ANNOTATED));
        assertEquals("    /** the paid tier */\n    @Deprecated\n    PAID(1);",
                SectionResolver.extractDeclaration(enums, "PAID", Scope.DOCUMENTED));
        // A bare constant has no body to select, so its `-` is empty rather than missing.
        assertEquals("", SectionResolver.extractDeclaration(enums, "CALL", Scope.BODY));
    }

    @Test
    void everyBlockRecordsTheScopeThatDeclaredIt() {
        // The four facts every port records — the owning block, the same link named `scope`, that scope's own
        // name and its declaration line — set at the same four places: the root's children, a `descend`, an
        // enum's constants, and a declared variable. No rule reads them today (the walk carries the scope as it
        // descends), so this test is what keeps them from silently becoming null (2026-10-14).
        String source = "class Runner {\n    void run(String title) {\n        int count;\n    }\n"
                + "    enum Suit { HEARTS }\n}\n";
        BlockScanner.Scan scan = BlockScanner.scanBlocks(source);

        BlockScanner.Block klass = scan.root().children().get(0);
        assertEquals("Runner", klass.name());
        // A top-level block belongs to the root, which has no name or line of its own.
        assertSame(scan.root(), klass.parent);
        assertSame(scan.root(), klass.scope);
        assertNull(klass.scopeName);
        assertNull(klass.scopeLine);

        BlockScanner.Block method = klass.children().get(0);
        assertEquals("run", method.name());
        assertSame(klass, method.parent);
        assertEquals("Runner", method.scopeName);
        assertEquals(Integer.valueOf(0), method.scopeLine);

        // A parameter is registered by `declareVariable`, a local by the scope scan: both name the method.
        BlockScanner.Block parameter = method.children().get(0);
        BlockScanner.Block local = method.children().get(1);
        assertEquals("title", parameter.name());
        assertEquals("count", local.name());
        for (BlockScanner.Block member : List.of(parameter, local)) {
            assertSame(method, member.parent);
            assertEquals("run", member.scopeName);
            assertEquals(Integer.valueOf(1), member.scopeLine);
        }

        BlockScanner.Block suit = klass.children().get(1);
        assertEquals("Suit", suit.name());
        BlockScanner.Block constant = suit.children().get(0);
        assertEquals("HEARTS", constant.name());
        assertSame(suit, constant.parent);
        assertEquals("Suit", constant.scopeName);
        assertEquals(Integer.valueOf(4), constant.scopeLine);
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
                () -> SectionResolver.resolveSection(JAVA, "add++"));
    }

    /** The plan exposes the parsed reference, which is the whole of what a reference can say. */
    @Test
    void thePlanCarriesTheParsedReference() {
        SectionResolver.Plan plan = SectionResolver.planSection(JAVA, "add/++", BlockScanner.DEFAULT);
        assertEquals("add/++", plan.reference().canonical());
        assertEquals(Scope.DOCUMENTED, plan.reference().scope());
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
     * A modifier belongs to the selector whose path carries it, so {@code add/-,render/++} is two
     * selectors that each say what they mean — the difference between "one selector with two
     * modifiers" (which is an error) and "two selectors that each say what they mean".
     */
    @Test
    void aModifierBelongsToTheSelectorWhosePathCarriesIt() {
        SectionResolver.Plan plan = SectionResolver.planSection(JAVA, "add/-,add", BlockScanner.DEFAULT);

        assertEquals(2, plan.reference().selectors().size());
        assertEquals(Scope.BODY, plan.reference().selectors().get(0).scope());
        assertEquals(Scope.DECLARATION, plan.reference().selectors().get(1).scope());
        assertEquals("        count++;\n    void add() {\n        count++;\n    }", plan.text());

        // Each selector canonicalises on its own, and the pieces join with `,`.
        assertEquals("add/-,add", SectionReference.parse("add/-,add").canonical());
        assertEquals("add/-,render/++", SectionReference.parse("add/-,render/++").canonical());
    }

    /** Each selector keeps its own path and its own modifier, so none is respelled. */
    @Test
    void eachSelectorCanonicalisesOnItsOwn() {
        // `add/-`, `render/++` and `remove/+` are each selector's own spelling and survive verbatim.
        SectionReference parsed = SectionReference.parse("add/-,render/++,remove/+");
        assertEquals("add/-,render/++,remove/+", parsed.canonical());
        assertEquals(List.of(Scope.BODY, Scope.DOCUMENTED, Scope.ANNOTATED),
                List.of(parsed.selectors().get(0).scope(), parsed.selectors().get(1).scope(),
                        parsed.selectors().get(2).scope()));
        assertEquals(List.of("add", "render", "remove"), List.of(
                parsed.selectors().get(0).segments().get(0),
                parsed.selectors().get(1).segments().get(0),
                parsed.selectors().get(2).segments().get(0)));

        assertEquals("Cart/Line/render/-,Cart",
                SectionReference.parse("Cart/Line/render/-,Cart").canonical());
        assertEquals("add,Cart", SectionReference.parse(" add , Cart ").canonical());
    }

    /** A reference of one path selector keeps every field the single-reference grammar had. */
    @Test
    void aSinglePathSelectorStillReportsItsSegmentsAndScope() {
        SectionReference parsed = SectionReference.parse("Cart/Line/render/-");
        assertEquals(List.of("Cart", "Line", "render"), parsed.segments());
        assertEquals("render", parsed.finalSegment());
        assertEquals(Scope.BODY, parsed.scope());
        assertEquals(1, parsed.selectors().size());
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
        // A line range takes no modifier of its own, and a whole-segment modifier is not part of a
        // range either.
        assertEquals("\"#L2-L3+\" is not a line range; write L<line> or L<line>:<column>",
                referenceError("L2-L3+"));
        assertEquals("\"#L2/+\" is not a line range; write L<line> or L<line>:<column>",
                referenceError("L2/+"));
        assertEquals("\"#L2-L3/-\" is not a line range; write L<line> or L<line>:<column>",
                referenceError("L2-L3/-"));

        // There is no detached leading modifier any more: `+` opens no name, so it says what to write.
        assertEquals("\"+\" is a path segment now; it follows the path, as \"#<path>/+\"",
                referenceError("+L2-L3"));
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

    /** A segment of nothing but modifiers is two of them; a hyphen inside a name is a name. */
    @Test
    void aRunOfModifierCharactersIsAnErrorAsAWholeSegment() {
        assertEquals("\"#a/+++\" carries more than one modifier", referenceError("a/+++"));
        assertEquals("\"#a/---\" carries more than one modifier", referenceError("a/---"));

        // `+` never occurs in a name, so a run of them inside one says where the segment belongs.
        assertEquals("\"+++\" is a path segment now; write \"#a/+++\"", referenceError("a+++"));

        // `-` is a name character, so these are one name each — not two modifiers.
        assertEquals("a---", SectionReference.parse("a---").canonical());
        assertEquals("-a-", SectionReference.parse("-a-").canonical());
    }

    // ------------------------------------------------------------------
    // The best-effort prefix probe (`deepestResolvablePrefix`, RFC 2 §4.3)
    // ------------------------------------------------------------------

    /**
     * The probe a <em>navigating</em> host climbs first ({@code doc/rfc/code-jump.md} §4.3): a name
     * that is gone lands on the enclosing thing that is not.
     *
     * <p>The expected answer is {@code deepestResolvablePrefix} in {@code lib/section.mjs}, run over
     * the same fixtures — the port mirrors it, so the landing lines here are the ones the JavaScript
     * reports, not ones derived from the map. The rows that matter are the two <em>kinds</em> of
     * failure: a parent that exists is a landing line ({@code Cart/Line/renderr} → {@code Line}),
     * while a name that resolves nowhere has no prefix at all ({@code missing/deeper} → {@code null}),
     * which is what lets a host land on the file head only in the second case.
     */
    @Test
    void theDeepestResolvablePrefixIsTheParentThatStillExists() {
        String example = fixture("Example.java");

        // The child is gone, the holder is not: `Cart/Line` outlives `renderr`, and it is where a
        // reader who followed a stale link is best served.
        SectionResolver.Prefix rendered = SectionResolver.deepestResolvablePrefix(example,
                "Cart/Line/renderr", BlockScanner.DEFAULT);
        assertEquals("Cart/Line", rendered.reference());
        assertEquals(17, rendered.firstLine(), "`Line` is declared on line 17");
        assertEquals(List.of("Cart", "Line"), rendered.segments());

        // A member directly under a class: the parent is the class, and the answer is one segment.
        SectionResolver.Prefix member = SectionResolver.deepestResolvablePrefix(example,
                "Cart/toString/sub", BlockScanner.DEFAULT);
        assertEquals("Cart/toString", member.reference());
        assertEquals(12, member.firstLine(), "`toString` is declared on line 12");
        assertEquals(List.of("Cart", "toString"), member.segments());

        // A name the file has nowhere has no prefix either — that is the file-head case, and the
        // probe must not answer it with something shorter to be helpful.
        assertNull(SectionResolver.deepestResolvablePrefix(example, "missing/deeper", BlockScanner.DEFAULT));
        assertNull(SectionResolver.deepestResolvablePrefix(example, "missing", BlockScanner.DEFAULT));

        // A property is a match but not a container, which is the other failure the rung covers.
        SectionResolver.Prefix property = SectionResolver.deepestResolvablePrefix(example,
                "Cart/items/nope", BlockScanner.DEFAULT);
        assertEquals("Cart/items", property.reference());
        assertEquals(8, property.firstLine());
    }

    /**
     * The three facts the probe's contract fixes, asserted here because each one is a way a caller
     * could misuse it — and the JavaScript answers all three the same way.
     */
    @Test
    void thePrefixProbeIsStrictlyShorterAndNeverThrows() {
        String example = fixture("Example.java");

        // Strictly shorter: the walk starts below what was written, so a one-segment reference has no
        // prefix to try *even when it resolves*. A caller asks after a failed resolve.
        assertNull(SectionResolver.deepestResolvablePrefix(example, "toString", BlockScanner.DEFAULT));
        assertNull(SectionResolver.deepestResolvablePrefix(example, "Cart", BlockScanner.DEFAULT));

        // Only the first selector's path is walked, so a later selector's failure cannot make an
        // earlier one approximate.
        assertNull(SectionResolver.deepestResolvablePrefix(example, "missing,toString", BlockScanner.DEFAULT));
        assertEquals("Cart/Line", SectionResolver.deepestResolvablePrefix(example,
                "Cart/Line/renderr,toString", BlockScanner.DEFAULT).reference());

        // Nothing throws: a malformed reference, a line range, and a reference that names nothing all
        // have no prefix rather than an error.
        assertNull(SectionResolver.deepestResolvablePrefix(example, "L40-", BlockScanner.DEFAULT));
        assertNull(SectionResolver.deepestResolvablePrefix(example, "L40", BlockScanner.DEFAULT));
        assertNull(SectionResolver.deepestResolvablePrefix(example, "", BlockScanner.DEFAULT));
    }

    /**
     * The fixture, found from either the module directory (how Surefire runs) or the repository root
     * (how an IDE sometimes does) — the same walk {@code SectionVectorsTest} makes for the corpus.
     */
    private static String fixture(String name) {
        Path directory = Paths.get("").toAbsolutePath();
        for (int level = 0; level < 8 && directory != null; level++) {
            Path candidate = directory.resolve("test/fixtures").resolve(name);
            if (Files.isRegularFile(candidate)) {
                try {
                    return Files.readString(candidate);
                } catch (IOException unreadable) {
                    throw new AssertionError("cannot read " + candidate, unreadable);
                }
            }
            directory = directory.getParent();
        }
        throw new AssertionError("test/fixtures/" + name + " not found above "
                + Paths.get("").toAbsolutePath());
    }

        private static String referenceError(String raw) {
        return referenceError(() -> SectionReference.parse(raw));
    }

    private static String referenceError(Runnable call) {
        SectionReferenceException error = assertThrows(SectionReferenceException.class, call::run);
        return error.getMessage();
    }
}
