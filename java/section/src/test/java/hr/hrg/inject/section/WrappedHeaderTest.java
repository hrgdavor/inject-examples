package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * A declaration whose header does not fit on one line — the Java mirror of the block {@code test.mjs}
 * calls "A declaration whose header does not fit on one line".
 *
 * <p>Wrapping a parameter list is ordinary formatting, not an exotic spelling: the signature line ends
 * with the opening {@code (}, the parameters follow on their own lines, and the {@code )} may share a
 * line with the body's {@code {} or have a line to itself. The matcher reads lines, so this is the
 * shape it has to follow past the end of the line the declaration starts on. The failure it guards
 * against is not a wrong slice but <em>no match at all</em>: the name is visible in the file, and a
 * reference to it must resolve.
 *
 * <p>The fixtures are read from the repository rather than kept here, so the bytes the test asserts are
 * the bytes the JavaScript suite asserts — {@code Wrapped.java} and {@code WrappedClass.java} are also
 * the fixtures {@code test/vectors/section-vectors.json} names.
 */
class WrappedHeaderTest {

    private static String fixture(String relative) {
        Path directory = Paths.get("").toAbsolutePath();
        for (int level = 0; level < 8 && directory != null; level++) {
            Path candidate = directory.resolve(relative);
            if (Files.isRegularFile(candidate)) {
                try {
                    // The resolver normalises `\r\n` itself; doing it here too keeps the byte-for-byte
                    // comparison below about the resolution and not about a checkout's line endings.
                    return Files.readString(candidate).replace("\r\n", "\n");
                } catch (IOException error) {
                    throw new IllegalStateException("cannot read " + candidate, error);
                }
            }
            directory = directory.getParent();
        }
        throw new AssertionError(relative + " not found above " + Paths.get("").toAbsolutePath());
    }

    /** A fixture resolved through the lexer its extension selects, exactly as a consumer picks one. */
    private static String section(String source, String relative, String reference) {
        return SectionResolver.resolveSection(source, reference, Syntaxes.lexerForPath(relative));
    }

    @Test
    void aWrappedParameterListIsStillADeclaration() {
        String source = fixture("test/fixtures/Wrapped.java");

        // The whole declaration: from the line the header starts on through its closing brace,
        // parameters and all — and it is the file's own bytes.
        String render = section(source, "Wrapped.java", "render");
        assertTrue(render.startsWith("    public String render(\n"),
                "the selection starts at the declaration, not at its first parameter: " + render);
        assertTrue(render.contains("\n            String name,\n"), "the wrapped parameters: " + render);
        assertTrue(render.contains("\n            int quantity) {\n"), render);
        assertTrue(render.contains("\n        return name + \" x\" + quantity;\n"), render);
        int from = source.indexOf("    public String render(");
        int to = source.indexOf("\n    }\n", from) + "\n    }".length();
        assertEquals(source.substring(from, to), render, "the declaration is the file's own bytes");

        // The body alone: the signature (wrapped across lines) is dropped whole, and the span still
        // starts after the `{` of the closing line.
        assertEquals("        return name + \" x\" + quantity;",
                section(source, "Wrapped.java", "render-"));
        SectionResolver.Plan plan =
                SectionResolver.planSection(source, "render-", Syntaxes.lexerForPath("Wrapped.java"));
        assertEquals(List.of(new SectionResolver.Range(9, 9)), plan.ranges());

        // A wrapped signature with a generic method's type parameters, and the same declaration reached
        // through its class scope.
        assertEquals(render, section(source, "Wrapped.java", "Wrapped/render"));
        String widest = section(source, "Wrapped.java", "widest");
        assertTrue(widest.startsWith("    public <T extends Comparable<T>> T widest(\n"), widest);
        assertTrue(widest.contains("\n            T right) {\n"), widest);
        assertTrue(widest.contains("left.compareTo(right)"), widest);
    }

    @Test
    void aWrappedThrowsClauseIsPartOfTheHeader() {
        String source = fixture("test/fixtures/Wrapped.java");

        // A `throws` clause on its own line is part of the header, and a parameter list that closes on
        // a line of its own still ends at the body's brace.
        String store = section(source, "Wrapped.java", "store");
        assertTrue(store.startsWith("    public void store(\n"), store);
        assertTrue(store.contains("\n            int quantity)\n"), "the `)` has a line to itself: " + store);
        assertTrue(store.contains("\n            throws IllegalStateException {\n"), store);
        assertTrue(store.contains("this.name = name;"), store);
        assertEquals("        this.name = name;", section(source, "Wrapped.java", "store-"));

        // The `+` scope reaches the annotation above a header that wraps.
        assertTrue(section(source, "Wrapped.java", "toString+")
                        .startsWith("    @Override\n    public String toString("),
                "the annotation is part of the `+` selection");
    }

    @Test
    void aWrappedClassHeaderIsADeclarationToo() {
        String source = fixture("test/fixtures/WrappedClass.java");

        // The class line is two lines longer than the rule of thumb allows: the type parameters, the
        // `extends` and the `implements` each get their own line, and the body only opens after them.
        String wrapped = section(source, "WrappedClass.java", "Wrapped");
        assertTrue(wrapped.startsWith("public class Wrapped<\n"), wrapped);
        assertTrue(wrapped.contains("\n        U extends CharSequence>\n"), wrapped);
        assertTrue(wrapped.contains("\n        implements Renderer<T> {\n"), wrapped);
        assertTrue(wrapped.contains("public T best("), wrapped);

        // The member whose parameters wrap is reachable through that class scope, and by its own name.
        String best = section(source, "WrappedClass.java", "best");
        assertEquals(best, section(source, "WrappedClass.java", "Wrapped/best"));
        assertTrue(best.startsWith("    public T best(\n"), best);
        assertTrue(best.contains("\n            T right) {\n"), best);
    }

    @Test
    void aWrappedHeaderIsAGapInMoreThanOneLanguage() {
        // Kotlin: the `)` carries the return type, and the body still opens on its own line.
        String kotlin = fixture("test/fixtures/Wrapped.kt");
        String render = section(kotlin, "Wrapped.kt", "render");
        assertTrue(render.startsWith("    fun render(\n"), render);
        assertTrue(render.contains("\n        quantity: Int\n"), render);
        assertTrue(render.contains("\n    ): String {\n"), render);
        assertTrue(render.contains("return \"$name x$quantity\""), render);
        assertEquals("        return \"$name x$quantity\"", section(kotlin, "Wrapped.kt", "render-"));

        // TypeScript: the class itself resolves, and so do the members whose parameters wrap.
        String typescript = fixture("test/fixtures/Wrapped.ts");
        assertTrue(section(typescript, "Wrapped.ts", "Wrapped").startsWith("export class Wrapped {"));
        String add = section(typescript, "Wrapped.ts", "add");
        assertTrue(add.startsWith("    add(\n"), add);
        assertTrue(add.contains("\n        item: string,\n"), add);
        assertTrue(add.contains("\n    ): void {\n"), add);
        assertTrue(add.contains("this.items.push(item);"), add);
    }

    @Test
    void aWrappedHeaderDoesNotInventDeclarations() {
        String source = String.join("\n", List.of(
                "class Svc {",
                "    void run() {",
                "        wrappedCall(",
                "            1,",
                "            2);",
                "    }",
                "",
                "    void wrappedCall(",
                "            int a,",
                "            int b) {",
                "        work();",
                "    }",
                "}"));

        assertEquals("    void wrappedCall(\n            int a,\n            int b) {\n"
                        + "        work();\n    }",
                SectionResolver.resolveSection(source, "wrappedCall"));

        // The call inside `run` is reached only by naming its scope, and it is a call, not a
        // declaration there: nothing is injected for it. A matcher that followed a header because it
        // *saw* a name would have found one.
        SectionError error = assertThrows(SectionError.class,
                () -> SectionResolver.resolveSection(source, "run/wrappedCall"));
        assertEquals("no section named \"wrappedCall\" in \"run\"", error.getMessage());

        // The same source with the wrapped call removed: the declaration is the only one there.
        String noCall = source.replace("        wrappedCall(\n            1,\n            2);\n", "");
        assertEquals("    void wrappedCall(\n            int a,\n            int b) {\n"
                        + "        work();\n    }",
                SectionResolver.resolveSection(noCall, "wrappedCall"));

        // A body-less member still has nothing to inject, however its header wraps: the name is
        // matched, and what it contributes is nothing at all.
        String iface = String.join("\n", List.of(
                "interface I {",
                "    void bar(",
                "            int x);",
                "    void baz() {",
                "        work();",
                "    }",
                "}"));
        assertEquals("    void baz() {\n        work();\n    }",
                SectionResolver.resolveSection(iface, "baz"));
        assertEquals("", SectionResolver.resolveSection(iface, "bar"),
                "a declaration with no body injects nothing");
    }
}
