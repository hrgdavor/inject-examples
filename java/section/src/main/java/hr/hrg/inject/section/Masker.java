package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;

/**
 * Part A of {@code lib/section.mjs}: {@code masked} and {@code commentsIn}, plus the string helpers
 * the scanner and the resolver share.
 *
 * <p>The mask is the load-bearing idea of the whole matcher: the text with every comment and string
 * literal blanked to spaces, newlines kept, so a brace inside a string or a comment cannot be mistaken
 * for the end of a declaration's body. The <b>mask invariant</b> is the one hard contract a substituted
 * engine must keep — same length, every {@code \n} at the same offset — and it is asserted here, as the
 * JavaScript module asserts it, so a bad engine fails loudly instead of silently mislocating a brace.
 *
 * <p>Indexing is by UTF-16 code unit ({@link String#charAt}), which is exactly what the JavaScript
 * does, so offsets and slicing agree with it byte for byte on any input.
 */
public final class Masker {

    private Masker() {
    }

    /** A comment-only span: its body (delimiters stripped) and where it sits in the text. */
    public record Comment(String text, int from, int to) {
    }

    /**
     * {@code text} with every comment and string literal blanked to spaces, newlines kept.
     *
     * <p>{@code #} opens a line comment except before {@code [}, which keeps a Rust attribute
     * ({@code #[derive(Debug)]}) readable while hiding a Python or shell comment.
     *
     * @throws SectionError when the invariant is broken, which for this implementation cannot happen
     *                      and therefore means a bug here rather than in a caller
     */
    public static String masked(String text) {
        char[] out = text.toCharArray();
        int length = text.length();
        int i = 0;
        while (i < length) {
            char character = text.charAt(i);
            char next = i + 1 < length ? text.charAt(i + 1) : '\0';

            if (character == '/' && next == '/') {
                int end = endOfLine(text, i);
                blank(out, i, end);
                i = end;
            } else if (character == '/' && next == '*') {
                int close = text.indexOf("*/", i + 2);
                int end = close == -1 ? length : close + 2;
                blank(out, i, end);
                i = end;
            } else if (character == '#' && next != '[') {
                int end = endOfLine(text, i);
                blank(out, i, end);
                i = end;
            } else if (character == '"' || character == '\'' || character == '`') {
                String quote = text.startsWith(repeat(character, 3), i)
                        ? repeat(character, 3)
                        : String.valueOf(character);
                int j = i + quote.length();
                while (j < length) {
                    if (text.charAt(j) == '\\') {
                        j += 2;
                        continue;
                    }
                    if (text.startsWith(quote, j)) {
                        j += quote.length();
                        break;
                    }
                    j++;
                }
                int end = Math.min(j, length);
                blank(out, i, end);
                i = end;
            } else {
                i++;
            }
        }

        String result = new String(out);
        if (result.length() != text.length()) {
            throw new SectionError("masked length mismatch");
        }
        for (int k = 0; k < length; k++) {
            if (text.charAt(k) == '\n' && result.charAt(k) != '\n') {
                throw new SectionError("newline offset mismatch");
            }
        }
        return result;
    }

    /**
     * Comment-only spans, in source order. Reads the original text — a comment cannot be recovered
     * from the mask — and does not report comment markers that sit inside string literals.
     */
    public static List<Comment> commentsIn(String text) {
        List<Comment> result = new ArrayList<>();
        int length = text.length();
        int i = 0;
        while (i < length) {
            char character = text.charAt(i);
            char next = i + 1 < length ? text.charAt(i + 1) : '\0';

            if (character == '/' && next == '/') {
                int end = endOfLine(text, i);
                result.add(new Comment(text.substring(i + 2, end), i, end));
                i = end;
            } else if (character == '/' && next == '*') {
                int close = text.indexOf("*/", i + 2);
                int end = close == -1 ? length : close + 2;
                result.add(new Comment(text.substring(i + 2, close == -1 ? end : close), i, end));
                i = end;
            } else if (character == '"' || character == '\'' || character == '`') {
                String quote = text.startsWith(repeat(character, 3), i)
                        ? repeat(character, 3)
                        : String.valueOf(character);
                int j = i + quote.length();
                while (j < length) {
                    if (text.charAt(j) == '\\') {
                        j += 2;
                        continue;
                    }
                    if (text.startsWith(quote, j)) {
                        j += quote.length();
                        break;
                    }
                    j++;
                }
                i = Math.min(j, length);
            } else {
                i++;
            }
        }
        return result;
    }

    private static void blank(char[] out, int from, int to) {
        for (int i = from; i < to && i < out.length; i++) {
            if (out[i] != '\n') {
                out[i] = ' ';
            }
        }
    }

    private static String repeat(char character, int times) {
        return String.valueOf(character).repeat(times);
    }

    /** The offset at which the line holding {@code offset} ends. */
    public static int endOfLine(String text, int offset) {
        int newline = text.indexOf('\n', offset);
        return newline == -1 ? text.length() : newline;
    }

    /** The line-start offsets of {@code text}, one per line. */
    public static int[] lineStarts(String text) {
        List<Integer> starts = new ArrayList<>();
        int offset = 0;
        for (String line : text.split("\n", -1)) {
            starts.add(offset);
            offset += line.length() + 1;
        }
        int[] result = new int[starts.size()];
        for (int i = 0; i < result.length; i++) {
            result[i] = starts.get(i);
        }
        return result;
    }

    /** The offset of the line {@code offset} falls on, given each line's start. */
    public static int lineOf(int[] starts, int offset) {
        int low = 0;
        int high = starts.length - 1;
        while (low < high) {
            int middle = (low + high + 1) >> 1;
            if (starts[middle] <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return low;
    }

    /** The index of the first non-blank line at or after {@code from}, or -1. */
    public static int nextNonBlank(String[] lines, int from) {
        for (int i = from; i < lines.length; i++) {
            if (!lines[i].trim().isEmpty()) {
                return i;
            }
        }
        return -1;
    }

    /** The offset of the bracket that closes the one at {@code open}, or -1. */
    public static int matchingBracket(String text, int open, char closer) {
        int depth = 0;
        char opener = text.charAt(open);
        for (int i = open; i < text.length(); i++) {
            if (text.charAt(i) == opener) {
                depth++;
            } else if (text.charAt(i) == closer) {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        return -1;
    }

    /** How far a line is indented. */
    public static int indentWidth(String line) {
        return line.length() - line.stripLeading().length();
    }

    /** The balance of {@code ()}, {@code []} and {@code {}} on one line. */
    public static int bracketBalance(String line) {
        int depth = 0;
        for (int i = 0; i < line.length(); i++) {
            char character = line.charAt(i);
            if (character == '(' || character == '[' || character == '{') {
                depth++;
            } else if (character == ')' || character == ']' || character == '}') {
                depth--;
            }
        }
        return depth;
    }
}
