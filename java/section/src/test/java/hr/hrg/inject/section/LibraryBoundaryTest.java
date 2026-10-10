package hr.hrg.inject.section;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.jupiter.api.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * The boundary the specification requires, asserted rather than trusted.
 *
 * <p>{@code doc/section-matching.md} requires the matcher to be vendorable as one dependency-free
 * unit, the way {@code lib/section.mjs} is — and the JavaScript suite asserts that boundary "so it
 * cannot rot". This is the Java half: every dependency this module declares must be <b>test-scoped</b>,
 * because a compile-scoped one would reach every consumer of {@code hr.hrg.inject:inject-examples}
 * transitively and end the no-dependency promise.
 *
 * <p>The POM is read with the JDK's own XML support, not with the JSON library the vectors test uses:
 * this test is about dependencies, so it must not depend on one.
 */
class LibraryBoundaryTest {

    /**
     * The module's POM, found from either the module directory (how Surefire runs) or the repository
     * root (how an IDE sometimes does).
     */
    private static Path modulePom() {
        Path directory = Paths.get("").toAbsolutePath();
        for (int level = 0; level < 8 && directory != null; level++) {
            Path candidate = directory.resolve("pom.xml");
            if (Files.isRegularFile(candidate) && isThisModule(candidate)) {
                return candidate;
            }
            Path nested = directory.resolve("java/section/pom.xml");
            if (Files.isRegularFile(nested) && isThisModule(nested)) {
                return nested;
            }
            directory = directory.getParent();
        }
        throw new AssertionError("java/section/pom.xml not found above " + Paths.get("").toAbsolutePath());
    }

    private static boolean isThisModule(Path pom) {
        try {
            return Files.readString(pom).contains("<artifactId>inject-examples</artifactId>");
        } catch (Exception unreadable) {
            return false;
        }
    }

    @Test
    void everyDeclaredDependencyIsTestScoped() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        Document document = factory.newDocumentBuilder().parse(modulePom().toFile());

        Element dependencies = childElement(document.getDocumentElement(), "dependencies");
        assertNotNull(dependencies,
                "the POM must declare its dependencies explicitly, so this test can read them");

        List<Element> declared = childElements(dependencies, "dependency");
        assertTrue(!declared.isEmpty(),
                "the suite needs JUnit (and the vectors test needs Jackson); if this list is empty the "
                        + "POM changed shape and this test is no longer checking anything");

        List<String> offenders = new ArrayList<>();
        for (Element dependency : declared) {
            String scope = textOf(childElement(dependency, "scope"));
            if (!"test".equals(scope)) {
                offenders.add(textOf(childElement(dependency, "groupId")) + ":"
                        + textOf(childElement(dependency, "artifactId"))
                        + " (scope " + (scope == null ? "compile, the default" : scope) + ")");
            }
        }

        assertTrue(offenders.isEmpty(),
                "doc/section-matching.md requires the matcher to be vendorable as one dependency-free "
                        + "unit, so every dependency must be test-scoped. These are not: " + offenders);
    }

    private static Element childElement(Element parent, String name) {
        List<Element> matches = childElements(parent, name);
        return matches.isEmpty() ? null : matches.get(0);
    }

    /** Direct children only: {@code <dependency>} also occurs under {@code <build><plugins>}. */
    private static List<Element> childElements(Element parent, String name) {
        List<Element> matches = new ArrayList<>();
        if (parent == null) {
            return matches;
        }
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            if (child.getNodeType() == Node.ELEMENT_NODE && name.equals(child.getNodeName())) {
                matches.add((Element) child);
            }
        }
        return matches;
    }

    private static String textOf(Element element) {
        return element == null ? null : element.getTextContent().trim();
    }
}
