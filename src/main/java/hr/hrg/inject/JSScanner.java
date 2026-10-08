package hr.hrg.inject;

import java.util.ArrayList;
import java.util.List;

public class JSScanner {

    public record Location(String type, int line, int col, String snippet) {}

    public static List<Location> scan(String source, String targetString) {
        List<Location> matches = new ArrayList<>();
        int line = 1, col = 0;
        
        Character inString = null; // null, '"', '\'', or '`'
        String inComment = null;    // null, "//", or "/*"

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

            // 3. Active string literals (handles single, double, and multi-line template literals)
            if (inString != null) {
                if (ch == '\\') { i++; col++; continue; } // Skip escaped char
                if (ch == inString) inString = null;
                continue;
            }

            // 4. Begin comments
            if (ch == '/' && next == '/') { inComment = "//"; i++; col++; continue; }
            if (ch == '/' && next == '*') { inComment = "/*"; i++; col++; continue; }

            // 5. Begin strings
            if (ch == '"' || ch == '\'' || ch == '`') {
                inString = ch;
                continue;
            }

            // 6. Match 'if' clause containing target string
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