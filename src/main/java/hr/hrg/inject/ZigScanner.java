package main.java.hr.hrg.inject;

import java.util.ArrayList;
import java.util.List;

public class ZigScanner {

    public record Location(String type, int line, int col, String snippet) {}

    public static List<Location> scan(String source, String targetString) {
        List<Location> matches = new ArrayList<>();
        int line = 1, col = 0;

        boolean inLineComment = false;
        int commentDepth = 0;      // Counter for nested /* /* */ */ comments
        boolean inString = false;       // "
        boolean inMultilineStr = false; // \\

        for (int i = 0; i < source.length(); i++) {
            char ch = source.charAt(i);
            char next = (i + 1 < source.length()) ? source.charAt(i + 1) : '\0';
            col++;

            // 1. Line tracking
            if (ch == '\n') {
                line++;
                col = 0;
                inLineComment = false;
                inMultilineStr = false; // Zig multiline string terminates at newline
                continue;
            }

            // 2. Active line comment
            if (inLineComment) continue;

            // 3. Active nested block comment
            if (commentDepth > 0) {
                if (ch == '/' && next == '*') {
                    commentDepth++;
                    i++; col++;
                } else if (ch == '*' && next == '/') {
                    commentDepth--;
                    i++; col++;
                }
                continue;
            }

            // 4. Active string states
            if (inMultilineStr) continue;
            if (inString) {
                if (ch == '\\') { i++; col++; continue; }
                if (ch == '"') inString = false;
                continue;
            }

            // 5. Begin comments
            if (ch == '/' && next == '/') { inLineComment = true; i++; col++; continue; }
            if (ch == '/' && next == '*') { commentDepth++; i++; col++; continue; }

            // 6. Begin strings (\\ for multiline, " for standard)
            if (ch == '\\' && next == '\\') {
                inMultilineStr = true;
                i++; col++;
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
        boolean prev = (idx == 0) || !Character.isLetterOrDigit(src.charAt(idx - 1));
        boolean next = (idx + len >= src.length()) || !Character.isLetterOrDigit(src.charAt(idx + len));
        return prev && next;
    }
}