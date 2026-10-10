package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
}
