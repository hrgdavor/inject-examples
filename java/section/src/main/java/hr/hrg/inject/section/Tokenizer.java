package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The one-pass tokenizer: {@code src/js/scanner/tokenizer.js} in Java.
 *
 * <p>It produces the two facts the resolver's lexer seam needs — a blanked mask and the comment spans —
 * from a language's comment and string syntax, and it is adapted into a {@link BlockScanner.Lexer} by
 * {@link #lexer(Syntax)}. It owns <b>nothing structural</b>: no braces are matched here, no blocks are
 * built, no precedence applied; {@link BlockScanner} and {@link SectionResolver} do all of that, which
 * is what keeps every engine agreeing.
 *
 * <p>The mask invariant is a property of the pass rather than a promise: every write goes through
 * {@link #blank}, which replaces characters with spaces and never touches {@code \n}. The scanner
 * asserts it again, naming the lexer.
 */
public final class Tokenizer {

    private Tokenizer() {
    }

    /** A string literal's span in the source. */
    public record StringSpan(int from, int to, String quote, boolean multiline) {
    }

    /** What one pass produced. */
    public record Facts(String masked, List<Masker.Comment> comments, List<StringSpan> strings) {
    }

    /** A boundary-prefixed opener may not follow an identifier character. */
    private static final Pattern ID_CHAR = Pattern.compile("[A-Za-z0-9_$]");

    /** {@code <<TAG}, {@code <<-TAG}, {@code <<~TAG}, {@code <<"TAG"} and PHP's {@code <<<TAG}. */
    private static final Pattern HEREDOC_OPEN = Pattern.compile(
            "^<<(?<angle><)?(?<strip>[-~]?)(?<quote>[\"'`]?)(?<tag>[A-Za-z_][A-Za-z0-9_]*)\\k<quote>");

    /**
     * One lexical pass: blanks comments and strings to spaces, collects the comment spans, and reports
     * the string spans. Length and every newline offset are preserved.
     */
    public static Facts tokenize(String source, Syntax syntax) {
        char[] out = source.toCharArray();
        List<Masker.Comment> comments = new ArrayList<>();
        List<StringSpan> strings = new ArrayList<>();
        int length = source.length();

        int i = 0;
        while (i < length) {
            char character = source.charAt(i);
            if (character == '\n') {
                i++;
                continue;
            }

            // Heredocs first: their body spans lines, and `<<` opens nothing else.
            if (syntax.heredoc() != Syntax.Heredoc.NONE && source.startsWith("<<", i)) {
                Heredoc heredoc = matchHeredoc(source, i, syntax.heredoc());
                if (heredoc != null) {
                    int openEnd = Masker.endOfLine(source, i);
                    int end = heredocEnd(source, openEnd + 1, heredoc.tag());
                    blank(out, openEnd + 1, end);
                    i = end;
                    continue;
                }
            }

            boolean matched = false;
            for (String open : syntax.lineComments()) {
                // `#[attr]` is an attribute in Rust and PHP, never a `#` comment.
                if (open.equals("#") && i + 1 < length && source.charAt(i + 1) == '[') {
                    continue;
                }
                if (!source.startsWith(open, i)) {
                    continue;
                }
                int end = Masker.endOfLine(source, i);
                comments.add(new Masker.Comment(source.substring(i + open.length(), end), i, end));
                blank(out, i, end);
                i = end;
                matched = true;
                break;
            }
            if (matched) {
                continue;
            }

            Syntax.BlockComment block = null;
            for (Syntax.BlockComment candidate : syntax.blockComments()) {
                if (source.startsWith(candidate.open(), i)
                        && (!candidate.lineStart() || i == 0 || source.charAt(i - 1) == '\n')) {
                    block = candidate;
                    break;
                }
            }
            if (block != null) {
                BlockRead read = readBlockComment(source, i, block);
                comments.add(new Masker.Comment(read.body(), i, read.to()));
                blank(out, i, read.to());
                i = read.to();
                continue;
            }

            StringHit hit = matchString(source, i, syntax.strings());
            if (hit != null) {
                Integer to = readString(source, hit);
                if (to != null) {
                    strings.add(new StringSpan(i, to, hit.kind().open(), hit.kind().multiline()));
                    blank(out, i, to);
                    i = to;
                    continue;
                }
            }

            i++;
        }

        return new Facts(new String(out), comments, strings);
    }

    /**
     * A lexer adapter for the resolver: the {@link BlockScanner.Lexer} shape it wants, memoised on the
     * last source so one scan pays for {@code mask} and {@code comments} together. The language's own
     * declaration descriptors and annotation test ride along; neither is built when the language has
     * none, so the resolver's generic shapes stay exactly in charge.
     */
    public static BlockScanner.Lexer lexer(Syntax syntax) {
        Map<String, Facts> cache = new HashMap<>(2);
        return new BlockScanner.Lexer() {

            private Facts facts(String text) {
                Facts cached = cache.get(text);
                if (cached != null) {
                    return cached;
                }
                Facts computed = tokenize(text, syntax);
                cache.clear();
                cache.put(text, computed);
                return computed;
            }

            @Override
            public String name() {
                return syntax.name();
            }

            @Override
            public String mask(String text) {
                return facts(text).masked();
            }

            @Override
            public List<Masker.Comment> comments(String text) {
                return facts(text).comments();
            }

            @Override
            public List<BlockScanner.Declared> declarations(String maskedLine) {
                if (syntax.declarations().isEmpty()) {
                    return List.of();
                }
                List<BlockScanner.Declared> out = new ArrayList<>();
                for (Syntax.Declaration descriptor : syntax.declarations()) {
                    Matcher match = descriptor.re().matcher(maskedLine);
                    if (!match.find() || match.groupCount() < 1 || match.group(1) == null) {
                        continue;
                    }
                    out.add(new BlockScanner.Declared(descriptor.kind(), match.group(1),
                            match.start() + match.group().length(), descriptor.body(),
                            descriptor.end(), descriptor.line()));
                }
                return out;
            }

            @Override
            public boolean isAnnotationLine(String line) {
                if (syntax.annotations().isEmpty()) {
                    return BlockScanner.Lexer.super.isAnnotationLine(line);
                }
                for (Pattern annotation : syntax.annotations()) {
                    if (annotation.matcher(line).find()) {
                        return true;
                    }
                }
                return false;
            }
        };
    }

    // ------------------------------------------------------------------
    // Readers
    // ------------------------------------------------------------------

    private record BlockRead(int to, String body) {
    }

    /** The end offset and inner body of a block comment starting at {@code i}. */
    private static BlockRead readBlockComment(String source, int i, Syntax.BlockComment block) {
        String open = block.open();
        String close = block.close();
        if (!block.nested()) {
            int end = source.indexOf(close, i + open.length());
            int to = end == -1 ? source.length() : end + close.length();
            return new BlockRead(to,
                    source.substring(i + open.length(), end == -1 ? source.length() : end));
        }
        int depth = 0;
        int j = i;
        int bodyStart = i + open.length();
        while (j < source.length()) {
            if (source.startsWith(open, j)) {
                depth++;
                j += open.length();
                continue;
            }
            if (source.startsWith(close, j)) {
                depth--;
                j += close.length();
                if (depth == 0) {
                    break;
                }
                continue;
            }
            j++;
        }
        int to = j;
        return new BlockRead(to, source.substring(bodyStart, Math.max(bodyStart, to - close.length())));
    }

    private record Heredoc(String tag, int length) {
    }

    /**
     * The heredoc that opens at {@code i}, or null. {@code STRICT} demands the unambiguous spellings
     * ({@code <<~}, {@code <<-}, a quoted tag) so Ruby's {@code array << x} is never read as one.
     */
    private static Heredoc matchHeredoc(String source, int i, Syntax.Heredoc mode) {
        String window = source.substring(i, Math.min(source.length(), i + 64));
        Matcher match = HEREDOC_OPEN.matcher(window);
        if (!match.find()) {
            return null;
        }
        boolean strict = mode == Syntax.Heredoc.STRICT;
        if (strict && match.group("strip").isEmpty() && match.group("quote").isEmpty()) {
            return null;
        }
        return new Heredoc(match.group("tag"), match.group().length());
    }

    /** The offset that ends the heredoc body: the terminator line's end of line. */
    private static int heredocEnd(String source, int from, String tag) {
        int i = from;
        while (i <= source.length()) {
            int endOfLine = Masker.endOfLine(source, i);
            String line = source.substring(i, endOfLine).trim();
            // PHP's terminator may carry the statement's `;` (`EOT;`).
            if (line.equals(tag) || line.equals(tag + ";")) {
                return endOfLine;
            }
            if (endOfLine >= source.length()) {
                return source.length();
            }
            i = endOfLine + 1;
        }
        return source.length();
    }

    private record StringHit(Syntax.StringKind kind, int bodyFrom, String close) {
    }

    /**
     * The string kind that opens at {@code i}, with the opener length and the closer it implies, or
     * null. A {@code hashes} kind (Rust raw string) reads its own closer: {@code r#"} closes at {@code "#}.
     */
    private static StringHit matchString(String source, int i, List<Syntax.StringKind> kinds) {
        for (Syntax.StringKind kind : kinds) {
            if (kind.boundary() && i > 0 && ID_CHAR.matcher(source.substring(i - 1, i)).find()) {
                continue;
            }
            if (kind.hashes()) {
                String prefix = kind.open().substring(0, kind.open().length() - 1);
                if (!source.startsWith(prefix, i)) {
                    continue;
                }
                int j = i + prefix.length();
                int hashes = 0;
                while (j < source.length() && source.charAt(j) == '#') {
                    hashes++;
                    j++;
                }
                if (j >= source.length() || source.charAt(j) != '"') {
                    continue;
                }
                return new StringHit(kind, j + 1, "\"" + "#".repeat(hashes));
            }
            if (source.startsWith(kind.open(), i)) {
                return new StringHit(kind, i + kind.open().length(), kind.close());
            }
        }
        return null;
    }

    /**
     * The end offset of the string {@code hit} opens, or null when the candidate is not a string after
     * all (a Rust lifetime, a char literal that never closes).
     *
     * <p>{@code maxSpan} and {@code content} are the char-versus-lifetime rule: the closer must sit that
     * close and the body must look like one character (or one escape), so {@code 'a'} is a char while
     * {@code 'a>(x: &'} never is.
     */
    private static Integer readString(String source, StringHit hit) {
        Syntax.StringKind kind = hit.kind();
        if (kind.lineScoped()) {
            return Masker.endOfLine(source, hit.bodyFrom());
        }

        // A constrained kind must actually close; an unterminated candidate is not a string at all, so
        // the `'` of `&'static str` never swallows the rest of the line.
        boolean mustClose = kind.maxSpan() != null || kind.content() != null;
        String close = hit.close();
        Syntax.Escape escape = kind.escape();
        int j = hit.bodyFrom();
        while (j < source.length()) {
            char character = source.charAt(j);
            if (character == '\n' && !kind.multiline()) {
                return mustClose ? null : j;
            }
            if (escape == Syntax.Escape.BACKSLASH && character == '\\') {
                j += 2;
                continue;
            }
            if (escape == Syntax.Escape.DOUBLING && source.startsWith(close, j)
                    && source.startsWith(close, j + close.length())) {
                j += close.length() * 2;
                continue;
            }
            if (source.startsWith(close, j)) {
                if (kind.maxSpan() != null && j - hit.bodyFrom() > kind.maxSpan()) {
                    return null;
                }
                if (kind.content() != null
                        && !kind.content().matcher(source.substring(hit.bodyFrom(), j)).matches()) {
                    return null;
                }
                return j + close.length();
            }
            j++;
        }
        return mustClose ? null : source.length();
    }

    private static void blank(char[] out, int from, int to) {
        for (int i = from; i < to && i < out.length; i++) {
            if (out[i] != '\n') {
                out[i] = ' ';
            }
        }
    }
}
