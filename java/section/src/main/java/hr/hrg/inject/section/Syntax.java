package hr.hrg.inject.section;

import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;

/**
 * One language's lexical data — the Java counterpart of an entry in
 * {@code src/js/scanner/syntaxes.js}.
 *
 * <p>This is <b>data, not code</b>: {@link Tokenizer} walks it and {@link Syntaxes} is the table, so
 * adding a language is one object here and one extension line there, never new matching logic. An
 * entry earns its keep only where the language-agnostic union is wrong for that language — a nested
 * block comment, a raw string, a heredoc, or a {@code '} that is a lifetime rather than a char literal.
 *
 * <p>The canonical constructor normalises, as {@code normalizeSyntax} does: several comment spellings
 * are sorted longest-first so the opener that appears first at a position wins, and a string form with
 * no opener, or with no closer and no way to end (no hashes, not line-scoped), is dropped.
 *
 * @param name         the language name, as {@link Syntaxes#lexerForPath(String)} reports it
 * @param lineComments the line-comment spellings, longest first
 * @param blockComments the block pairs, longest opener first
 * @param strings      the string forms, longest opener first
 * @param heredoc      whether {@code <<TAG} bodies are blanked, and how strictly they are recognised
 * @param declarations declaration shapes this language adds to the generic ones
 * @param annotations  what counts as the annotation directly above a declaration, for the {@code +} scope
 */
public record Syntax(String name, List<String> lineComments, List<BlockComment> blockComments,
                     List<StringKind> strings, Heredoc heredoc, List<Declaration> declarations,
                     List<Pattern> annotations) {

    public Syntax {
        lineComments = longestFirst(lineComments);
        blockComments = blockComments == null ? List.of()
                : blockComments.stream()
                        .sorted(Comparator.comparingInt((BlockComment block) -> block.open().length())
                                .reversed())
                        .toList();
        strings = strings == null ? List.of()
                : strings.stream()
                        .filter(kind -> !kind.open().isEmpty()
                                && (!kind.close().isEmpty() || kind.hashes() || kind.lineScoped()))
                        .sorted(Comparator.comparingInt((StringKind kind) -> kind.open().length())
                                .reversed())
                        .toList();
        heredoc = heredoc == null ? Heredoc.NONE : heredoc;
        declarations = declarations == null ? List.of() : List.copyOf(declarations);
        annotations = annotations == null ? List.of() : List.copyOf(annotations);
    }

    /** A block comment pair. {@code nested} = Rust, Kotlin, Zig, Haskell; {@code lineStart} = Ruby. */
    public record BlockComment(String open, String close, boolean nested, boolean lineStart) {

        public static BlockComment of(String open, String close) {
            return new BlockComment(open, close, false, false);
        }

        public static BlockComment nested(String open, String close) {
            return new BlockComment(open, close, true, false);
        }
    }

    /** How a string literal escapes its closer. */
    public enum Escape {
        /** {@code \} before it. */
        BACKSLASH,
        /** The closer doubled (SQL {@code ''}, VB {@code ""}, C# {@code @"…""…"}). */
        DOUBLING,
        /** Not at all (Go's backticks, Python's raw strings, Rust's {@code r#"…"#}). */
        NONE
    }

    /**
     * One string form.
     *
     * @param open      the literal opener, e.g. {@code "}, {@code """}, {@code r'}, {@code @"}
     * @param close     the closer; {@code hashes} computes it from the opener's own hash count
     * @param escape    how the closer is escaped inside
     * @param multiline may span lines
     * @param lineScoped runs to the end of the line (Zig {@code \\})
     * @param boundary  the opener may not follow an identifier character
     * @param hashes    Rust raw string: {@code r#*"} … "{#*}
     * @param maxSpan   the closer must be this close (Rust char literal versus a lifetime)
     * @param content   and the body must match this (again: char versus lifetime)
     */
    public record StringKind(String open, String close, Escape escape, boolean multiline,
                             boolean lineScoped, boolean boundary, boolean hashes, Integer maxSpan,
                             Pattern content) {

        /** The common form: an opener, a closer, and the default backslash escaping. */
        public static StringKind of(String open, String close) {
            return new StringKind(open, close, Escape.BACKSLASH, false, false, false, false, null,
                    null);
        }

        /** A form that takes no escapes at all. */
        public static StringKind raw(String open, String close, boolean multiline) {
            return new StringKind(open, close, Escape.NONE, multiline, false, false, false, null, null);
        }

        public StringKind escaped(Escape how) {
            return new StringKind(open, close, how, multiline, lineScoped, boundary, hashes, maxSpan,
                    content);
        }

        public StringKind asMultiline() {
            return new StringKind(open, close, escape, true, lineScoped, boundary, hashes, maxSpan,
                    content);
        }

        public StringKind withBoundary() {
            return new StringKind(open, close, escape, multiline, lineScoped, true, hashes, maxSpan,
                    content);
        }

        public StringKind withHashes() {
            return new StringKind(open, close, escape, multiline, lineScoped, boundary, true, maxSpan,
                    content);
        }
    }

    /** Whether {@code <<TAG} heredoc bodies are blanked, and how strictly they are recognised. */
    public enum Heredoc {
        /** Not a heredoc language. */
        NONE,
        /** Shell and PHP: a bare {@code <<TAG} counts. */
        ANY,
        /** Ruby: only {@code <<~TAG}, {@code <<-TAG} or a quoted tag, so {@code array << x} is safe. */
        STRICT;

        public static Heredoc of(boolean enabled, boolean strict) {
            if (!enabled) {
                return NONE;
            }
            return strict ? STRICT : ANY;
        }
    }

    /**
     * A declaration shape the language adds to the generic ones.
     *
     * @param kind the block kind it produces, usually {@code method} or {@code class}
     * @param re   matched against the masked line; group 1 is the name
     * @param body {@code end} when the body is closed by a terminator keyword line (Ruby, VB)
     * @param end  that terminator word ({@code end}, {@code End})
     * @param line the declaration line is itself a complete selection when no body follows
     */
    public record Declaration(String kind, Pattern re, String body, String end, boolean line) {

        public static Declaration bodyless(String kind, Pattern re) {
            return new Declaration(kind, re, null, null, false);
        }

        public static Declaration closedBy(String kind, Pattern re, String end) {
            return new Declaration(kind, re, "end", end, false);
        }

        public static Declaration singleLine(String kind, Pattern re) {
            return new Declaration(kind, re, null, null, true);
        }
    }

    private static List<String> longestFirst(List<String> values) {
        if (values == null || values.isEmpty()) {
            return List.of();
        }
        return values.stream()
                .sorted(Comparator.comparingInt(String::length).reversed())
                .toList();
    }
}
