package hr.hrg.inject.section;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The language table and the extension registry: {@code src/js/scanner/syntaxes.js} and
 * {@code src/js/scanner/lexers.js} in Java.
 *
 * <p>An extension with no entry means the file type is unknown, and {@link #lexerForPath} then hands
 * back {@link BlockScanner#DEFAULT} — the language-agnostic union — which is the same answer a
 * reference gets for a type with no entry at all. That is why the table is an optimisation for the
 * types it covers, never a requirement, and why an entry is only worth adding when the union is
 * <em>wrong</em> for that language: a nested comment, a raw string, a heredoc, or a {@code '} that is a
 * lifetime rather than a char literal.
 *
 * <p>Adding a language is one {@link Syntax} here and one extension line below, never new matching
 * logic — the design boundary the plan set keeps.
 */
public final class Syntaxes {

    private Syntaxes() {
    }

    // --- shared spellings ---------------------------------------------------

    private static final List<String> C_LINE = List.of("//");
    private static final List<Syntax.BlockComment> C_BLOCK =
            List.of(Syntax.BlockComment.of("/*", "*/"));

    /**
     * A Rust char literal: {@code 'a'}, {@code '\n'}, {@code ' '} — one character or one escape, closed
     * within a few characters. Rejecting everything else is what keeps a lifetime ({@code 'a},
     * {@code 'static}) out of the mask.
     */
    private static final Syntax.StringKind SINGLE_CHAR = new Syntax.StringKind("'", "'",
            Syntax.Escape.BACKSLASH, false, false, false, false, 12,
            Pattern.compile("^(?:\\\\.{1,10}|[^\\n\\\\]{1,2})$"));

    private static Syntax.StringKind backslash(String open, String close, boolean multiline) {
        return new Syntax.StringKind(open, close, Syntax.Escape.BACKSLASH, multiline, false, false,
                false, null, null);
    }

    private static Syntax.StringKind noEscape(String open, String close, boolean multiline) {
        return new Syntax.StringKind(open, close, Syntax.Escape.NONE, multiline, false, false, false,
                null, null);
    }

    private static Syntax.StringKind doubling(String open, String close, boolean multiline,
                                              boolean boundary) {
        return new Syntax.StringKind(open, close, Syntax.Escape.DOUBLING, multiline, false, boundary,
                false, null, null);
    }

    private static Syntax.StringKind boundary(Syntax.StringKind kind) {
        return kind.withBoundary();
    }

    // --- the three originals ------------------------------------------------

    /** JavaScript / TypeScript: {@code //}, the C block pair, quotes and backtick templates. */
    public static final Syntax JAVASCRIPT = new Syntax("javascript", C_LINE, C_BLOCK, List.of(
            backslash("`", "`", true),
            backslash("\"", "\"", false),
            backslash("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** Java: {@code //}, the C block pair, quotes and text blocks. */
    public static final Syntax JAVA = new Syntax("java", C_LINE, C_BLOCK, List.of(
            backslash("\"\"\"", "\"\"\"", true),
            backslash("\"", "\"", false),
            backslash("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** Zig: {@code //}, <b>nested</b> block comments, quotes and multiline {@code \\} strings. */
    public static final Syntax ZIG = new Syntax("zig", C_LINE,
            List.of(Syntax.BlockComment.nested("/*", "*/")), List.of(
                    new Syntax.StringKind("\\\\", "", Syntax.Escape.BACKSLASH, false, true, false,
                            false, null, null),
                    backslash("\"", "\"", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    // --- the rest of the table ---------------------------------------------

    /** Go: backtick raw strings take no escapes at all. */
    public static final Syntax GO = new Syntax("go", C_LINE, C_BLOCK, List.of(
            noEscape("`", "`", true),
            backslash("\"", "\"", false),
            SINGLE_CHAR), Syntax.Heredoc.NONE, List.of(), List.of());

    /** Rust's members live in {@code impl} blocks, not in the type. */
    private static final List<Syntax.Declaration> RUST_DECLARATIONS = List.of(
            Syntax.Declaration.bodyless("class",
                    Pattern.compile("^\\s*impl\\b[^{]*?\\b([A-Za-z_][\\w:]*)\\s*(?:<[^>]*>)?\\s*"
                            + "(?:where\\b[^{]*)?\\{")),
            // A field is `name: Type,` — the generic property shape wants `name = …`, which Rust never
            // writes.
            Syntax.Declaration.singleLine("property",
                    Pattern.compile("^\\s*(?:pub\\s+)?([A-Za-z_]\\w*)\\s*:")));

    /** Rust: nested block comments, {@code r#"…"#}, and {@code 'a} (lifetime) versus {@code 'a'}. */
    public static final Syntax RUST = new Syntax("rust", C_LINE,
            List.of(Syntax.BlockComment.nested("/*", "*/")), List.of(
                    new Syntax.StringKind("br\"", "\"", Syntax.Escape.NONE, true, false, true, true,
                            null, null),
                    new Syntax.StringKind("r\"", "\"", Syntax.Escape.NONE, true, false, true, true,
                            null, null),
                    new Syntax.StringKind("b\"", "\"", Syntax.Escape.BACKSLASH, false, false, true,
                            false, null, null),
                    backslash("\"", "\"", false),
                    new Syntax.StringKind("b'", "'", Syntax.Escape.BACKSLASH, false, false, true,
                            false, 12, SINGLE_CHAR.content()),
                    SINGLE_CHAR),
            Syntax.Heredoc.NONE, RUST_DECLARATIONS, List.of());

    /** Python: {@code """}/{@code '''}, raw {@code r"…"}, and the {@code #} comment. */
    public static final Syntax PYTHON = new Syntax("python", List.of("#"), List.of(), List.of(
            noEscape("r\"\"\"", "\"\"\"", true).withBoundary(),
            noEscape("r'''", "'''", true).withBoundary(),
            noEscape("rb\"", "\"", false).withBoundary(),
            noEscape("rb'", "'", false).withBoundary(),
            noEscape("br\"", "\"", false).withBoundary(),
            noEscape("br'", "'", false).withBoundary(),
            noEscape("r\"", "\"", false).withBoundary(),
            noEscape("r'", "'", false).withBoundary(),
            backslash("\"\"\"", "\"\"\"", true),
            backslash("'''", "'''", true),
            backslash("\"", "\"", false),
            backslash("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** C#: verbatim {@code @"…""…"} and raw {@code """}. */
    public static final Syntax CSHARP = new Syntax("csharp", C_LINE, C_BLOCK, List.of(
            doubling("$@\"", "\"", true, true),
            doubling("@$\"", "\"", true, true),
            doubling("@\"", "\"", true, true),
            noEscape("\"\"\"", "\"\"\"", true),
            backslash("\"", "\"", false),
            backslash("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** Kotlin: nested block comments, like Rust's. */
    public static final Syntax KOTLIN = new Syntax("kotlin", C_LINE,
            List.of(Syntax.BlockComment.nested("/*", "*/")), List.of(
                    noEscape("\"\"\"", "\"\"\"", true),
                    backslash("\"", "\"", false),
                    backslash("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** PHP: {@code //} and {@code #} (but {@code #[Attribute]} stays readable), and heredocs. */
    public static final Syntax PHP = new Syntax("php", List.of("//", "#"), C_BLOCK, List.of(
            backslash("\"", "\"", true),
            backslash("'", "'", true)), Syntax.Heredoc.ANY, List.of(), List.of());

    /** Ruby: {@code =begin}/{@code =end} at column 0, heredocs, and the paren-less {@code def}. */
    public static final Syntax RUBY = new Syntax("ruby", List.of("#"),
            List.of(new Syntax.BlockComment("=begin", "=end", false, true)), List.of(
                    backslash("\"", "\"", true),
                    backslash("'", "'", true),
                    backslash("`", "`", true)),
            Syntax.Heredoc.STRICT, List.of(
                    Syntax.Declaration.closedBy("method",
                            Pattern.compile("^\\s*def\\s+(?:self\\.)?([A-Za-z_]\\w*[?!=]?)"), "end")),
            List.of());

    /** SQL: {@code --}, the C block pair, Postgres dollar quoting and doubled quotes. */
    public static final Syntax SQL = new Syntax("sql", List.of("--"),
            List.of(Syntax.BlockComment.of("/*", "*/")), List.of(
                    noEscape("$$", "$$", true),
                    doubling("'", "'", false, false),
                    doubling("\"", "\"", false, false),
                    doubling("`", "`", false, false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** Shell: {@code #}, single quotes that take no escapes, and heredocs. */
    public static final Syntax SHELL = new Syntax("shell", List.of("#"), List.of(), List.of(
            noEscape("'", "'", true),
            backslash("\"", "\"", true),
            backslash("`", "`", true)), Syntax.Heredoc.ANY, List.of(), List.of());

    /** VB: {@code '} comments, doubled-quote strings, and capitalised keyword blocks. */
    public static final Syntax VB = new Syntax("vb", List.of("'"), List.of(), List.of(
            doubling("\"", "\"", false, false)), Syntax.Heredoc.NONE, List.of(
            Syntax.Declaration.closedBy("class", Pattern.compile(
                    "^\\s*(?:Public|Private|Friend|Protected)?\\s*(?:NotInheritable\\s+|MustInherit\\s+)?"
                            + "(?:Class|Module|Structure)\\s+(\\w+)"), "End"),
            Syntax.Declaration.closedBy("method", Pattern.compile(
                    "^\\s*[\\w\\s]*?\\b(?:Sub|Function)\\s+(\\w+)"), "End")), List.of());

    /** Haskell: nested {@code {- -}}, string gaps, and the binding/type shapes. */
    public static final Syntax HASKELL = new Syntax("haskell", List.of("--"),
            List.of(Syntax.BlockComment.nested("{-", "-}")), List.of(
                    backslash("\"", "\"", true),
                    backslash("'", "'", false)), Syntax.Heredoc.NONE, List.of(
                    // The lookahead keeps the words that *open* a declaration (`data Cart = …`) from
                    // being read as a binding named `data`.
                    Syntax.Declaration.singleLine("method", Pattern.compile(
                            "^(?!(?:data|newtype|type|class|instance|module|import|infix[lr]?|foreign|"
                                    + "deriving|default)\\b)([a-z_][\\w']*)\\b[^=\\n]*=")),
                    Syntax.Declaration.bodyless("class", Pattern.compile(
                            "^(?:data|newtype|type|class)\\s+(?:\\([^)]*\\)\\s*=>\\s*)?([A-Z][\\w']*)"))),
            List.of(Pattern.compile("^\\s*[\\w']+\\s*::")));

    // --- data formats -------------------------------------------------------
    //
    // These have no members to search, but their comments and strings still have to be masked so a
    // `#`/`;` inside a quoted value is never read as one.

    /** YAML: {@code #}, and both quoted forms folding across lines. */
    public static final Syntax YAML = new Syntax("yaml", List.of("#"), List.of(), List.of(
            backslash("\"", "\"", true),
            doubling("'", "'", true, false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** TOML: {@code #}, triple-quoted basic and literal strings. */
    public static final Syntax TOML = new Syntax("toml", List.of("#"), List.of(), List.of(
            backslash("\"\"\"", "\"\"\"", true),
            noEscape("'''", "'''", true),
            backslash("\"", "\"", false),
            noEscape("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** INI: {@code ;} is the classic comment; {@code #} is common too. */
    public static final Syntax INI = new Syntax("ini", List.of(";", "#"), List.of(), List.of(
            noEscape("\"", "\"", false),
            noEscape("'", "'", false)), Syntax.Heredoc.NONE, List.of(), List.of());

    /** TypeScript is JavaScript's syntax under its own name. */
    public static final Syntax TYPESCRIPT = new Syntax("typescript", JAVASCRIPT.lineComments(),
            JAVASCRIPT.blockComments(), JAVASCRIPT.strings(), Syntax.Heredoc.NONE, List.of(),
            List.of());

    private static final Map<String, Syntax> BY_NAME = Map.ofEntries(
            Map.entry("javascript", JAVASCRIPT),
            Map.entry("typescript", TYPESCRIPT),
            Map.entry("java", JAVA),
            Map.entry("zig", ZIG),
            Map.entry("go", GO),
            Map.entry("rust", RUST),
            Map.entry("python", PYTHON),
            Map.entry("csharp", CSHARP),
            Map.entry("kotlin", KOTLIN),
            Map.entry("php", PHP),
            Map.entry("ruby", RUBY),
            Map.entry("sql", SQL),
            Map.entry("shell", SHELL),
            Map.entry("vb", VB),
            Map.entry("haskell", HASKELL),
            Map.entry("yaml", YAML),
            Map.entry("toml", TOML),
            Map.entry("ini", INI));

    /** Extension to language name: one line per extension, exactly as {@code lexers.js} has it. */
    private static final Map<String, String> EXTENSIONS = Map.ofEntries(
            Map.entry("js", "javascript"), Map.entry("mjs", "javascript"),
            Map.entry("cjs", "javascript"), Map.entry("jsx", "javascript"),
            Map.entry("ts", "typescript"), Map.entry("tsx", "typescript"),
            Map.entry("mts", "typescript"), Map.entry("cts", "typescript"),
            Map.entry("java", "java"),
            Map.entry("zig", "zig"),
            Map.entry("go", "go"),
            Map.entry("rs", "rust"),
            Map.entry("py", "python"), Map.entry("pyi", "python"),
            Map.entry("cs", "csharp"),
            Map.entry("kt", "kotlin"), Map.entry("kts", "kotlin"),
            Map.entry("php", "php"), Map.entry("phtml", "php"),
            Map.entry("rb", "ruby"), Map.entry("rake", "ruby"), Map.entry("gemspec", "ruby"),
            Map.entry("sql", "sql"),
            Map.entry("sh", "shell"), Map.entry("bash", "shell"), Map.entry("zsh", "shell"),
            Map.entry("vb", "vb"), Map.entry("bas", "vb"), Map.entry("vbs", "vb"),
            Map.entry("hs", "haskell"), Map.entry("lhs", "haskell"),
            Map.entry("yaml", "yaml"), Map.entry("yml", "yaml"),
            Map.entry("toml", "toml"),
            Map.entry("ini", "ini"), Map.entry("cfg", "ini"), Map.entry("properties", "ini"));

    private static final Map<String, BlockScanner.Lexer> LEXERS = new HashMap<>();

    /** The language syntax by name, or null when the table has no such entry. */
    public static Syntax forName(String name) {
        return name == null ? null : BY_NAME.get(name);
    }

    /** Every extension the table knows, for a caller that wants to enumerate them. */
    public static Map<String, String> extensions() {
        return EXTENSIONS;
    }

    /**
     * The lexer for {@code path}'s extension, or {@link BlockScanner#DEFAULT} when the type is unknown
     * (no extension, or one with no entry) — the same answer an unknown type gets, so this can be
     * passed straight to the resolver.
     */
    public static BlockScanner.Lexer lexerForPath(String path) {
        Syntax syntax = syntaxForPath(path);
        if (syntax == null) {
            return BlockScanner.DEFAULT;
        }
        return LEXERS.computeIfAbsent(syntax.name(), name -> Tokenizer.lexer(syntax));
    }

    /** The syntax for {@code path}'s extension, or null when the type is unknown. */
    public static Syntax syntaxForPath(String path) {
        if (path == null) {
            return null;
        }
        int dot = path.lastIndexOf('.');
        if (dot <= 0) {
            return null;
        }
        String extension = path.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        String name = EXTENSIONS.get(extension);
        return name == null ? null : BY_NAME.get(name);
    }
}
