package hr.hrg.inject;

import java.util.ArrayList;
import java.util.List;

public class JavaCodeScanner {

    public record Location(String type, int line, int col, String snippet) {}

    public static List<Location> scan(String source, String targetString) {
        List<Location> matches = new ArrayList<>();
        int line = 1, col = 0;

        String inComment = null;   // null, "//", or "/*"
        boolean inTextBlock = false; // """
        boolean inString = false;    // "

        for (int i = 0; i < source.length(); i++) {
            char ch = source.charAt(i);
            char next = (i + 1 < source.length()) ? source.charAt(i + 1) : '\0';
            col++;

            // 1. Line tracking
            if (ch == '\n') {
                line++;
                col = 0;
                if ("//".equals(inComment)) inComment = null;
                continue;
            }

            // 2. Active comments
            if ("//".equals(inComment)) continue;
            if ("/*".equals(inComment)) {
                if (ch == '*' && next == '/') {
                    inComment = null;
                    i++; col++;
                }
                continue;
            }

            // 3. Active Java 15+ Text Blocks (""")
            if (inTextBlock) {
                if (ch == '\\') { i++; col++; continue; }
                if (source.startsWith("\"\"\"", i)) {
                    inTextBlock = false;
                    i += 2; col += 2;
                }
                continue;
            }

            // 4. Active standard strings (")
            if (inString) {
                if (ch == '\\') { i++; col++; continue; }
                if (ch == '"') inString = false;
                continue;
            }

            // 5. Begin comments
            if (ch == '/' && next == '/') { inComment = "//"; i++; col++; continue; }
            if (ch == '/' && next == '*') { inComment = "/*"; i++; col++; continue; }

            // 6. Begin strings (Check text blocks before standard double-quotes)
            if (source.startsWith("\"\"\"", i)) {
                inTextBlock = true;
                i += 2; col += 2;
                continue;
            }
            if (ch == '"') {
                inString = true;
                continue;
            }

            // 7. Match 'if' clause containing target string
            if (ch == 'i' && next == 'f' && isBoundary(source, i, 2)) {
                int braceIdx = source.indexOf('{', i);
                if (braceIdx != -1) {
                    String clause = source.substring(i, braceIdx);
                    if (clause.contains(targetString)) {
                        matches.add(new Location("if_clause", line, col, clause.trim()));
                    }
                }
            }
        }
        return matches;
    }

    private static boolean isBoundary(String src, int idx, int len) {
        boolean prev = (idx == 0) || !Character.isJavaIdentifierPart(src.charAt(idx - 1));
        boolean next = (idx + len >= src.length()) || !Character.isJavaIdentifierPart(src.charAt(idx + len));
        return prev && next;
    }
}
