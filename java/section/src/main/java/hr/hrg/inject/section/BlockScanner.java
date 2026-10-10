package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Part B of {@code lib/section.mjs}: the mask pass's consumer — a block tree over a file's text.
 *
 * <p>This is a heuristic, not a parser (contract §3.5): it counts brackets over text whose comments and
 * string literals are blanked, and it must not grow a real per-language grammar. A language is
 * <em>data plus a lexer</em> (see {@link Lexer}), so adding one is an entry and an extension line,
 * never new matching logic.
 *
 * <p>Everything here is pure data in and pure data out: no filesystem, no environment, no editor
 * types. The mask invariant is asserted for any supplied {@link Lexer}, so a substitute engine fails
 * loudly rather than silently mislocating a brace.
 */
public final class BlockScanner {

    private BlockScanner() {
    }

    // ------------------------------------------------------------------
    // The lexer seam
    // ------------------------------------------------------------------

    /**
     * The language engine the scanner reads through. The default engine — the language-agnostic mask
     * and comment reader — is {@link #DEFAULT}, which is what an unknown file type gets, and the reason
     * a reference resolves to the same bytes whether the type is recognised or not.
     */
    public interface Lexer {

        String name();

        /** The mask: same length, every {@code \n} at the same offset, comments and strings blanked. */
        String mask(String text);

        List<Masker.Comment> comments(String text);

        /**
         * The double-quoted literals a header line carries, in the two forms matcher 5 knows: the
         * byte-exact literal and the token-pasted form.
         */
        default Conditions conditionLiterals(String line, int from) {
            return BlockScanner.conditionLiterals(line, from);
        }

        /** Declaration shapes this language adds to the generic ones (Ruby {@code def add}). */
        default List<Declared> declarations(String maskedLine) {
            return List.of();
        }

        /** What counts as the annotation directly above a declaration, for the {@code +} scope. */
        default boolean isAnnotationLine(String line) {
            return ANNOTATION_LINE.matcher(line).find();
        }
    }

    /** The built-in engine: the language-agnostic union of the comment and string spellings seen. */
    public static final Lexer DEFAULT = new Lexer() {
        @Override
        public String name() {
            return "default";
        }

        @Override
        public String mask(String text) {
            return Masker.masked(text);
        }

        @Override
        public List<Masker.Comment> comments(String text) {
            return Masker.commentsIn(text);
        }
    };

    // ------------------------------------------------------------------
    // Data the scanner produces
    // ------------------------------------------------------------------

    /** The two literal forms a condition header may carry. */
    public record Conditions(List<String> exact, List<String> pasted) {
    }

    /** A declaration shape a lexer reports on a masked line. */
    public record Declared(String kind, String name, int headerFrom, String body, String end,
                           boolean line) {
    }

    /** A declaration the generic rules found on a masked line. */
    record Declaration(String kind, String name, int headerFrom) {
    }

    /** A comment anchor: the comment that is the first thing inside a block's braces. */
    public record Anchor(String name, int line) {
    }

    /** A paired {@code #region … #endregion}. */
    public static final class Region {
        final String name;
        final int startLine;
        final int endLine;
        int line;
        String kind = "region";

        Region(String name, int startLine, int endLine) {
            this.name = name;
            this.startLine = startLine;
            this.endLine = endLine;
        }

        public String name() {
            return name;
        }

        public int startLine() {
            return startLine;
        }

        public int endLine() {
            return endLine;
        }
    }

    /** A span of a body: brace-delimited, indented, an arrow expression, or keyword-delimited. */
    static final class Span {
        Integer open;
        Integer close;
        Integer openLine;
        Integer closeLine;
        Integer bodyEndLine;
        Integer expression;
        boolean indented;
    }

    /**
     * One block: a class-like body, a method body, a statement body, a property, or a region-carrying
     * container. Mutable and package-private on purpose — the scanner fills it in as it walks, exactly
     * as the JavaScript object literal is filled in, and the resolver reads it.
     */
    public static final class Block {
        final String kind;
        final String name;
        final int declLine;
        Integer open;
        Integer close;
        Integer openLine;
        Integer closeLine;
        Integer endLine;
        Integer expression;
        Integer lineEnd;
        Boolean singleLine;
        Boolean sharedClose;
        boolean indented;
        final List<Block> children = new ArrayList<>();
        final List<Block> blocks = new ArrayList<>();
        final List<Region> regions = new ArrayList<>();
        Anchor anchor;
        Conditions conditions;
        Block parent;
        Block scope;
        String scopeName;
        Integer scopeLine;

        Block(String kind, String name, int declLine) {
            this.kind = kind;
            this.name = name;
            this.declLine = declLine;
        }

        public String kind() {
            return kind;
        }

        public String name() {
            return name;
        }

        public int declLine() {
            return declLine;
        }

        public Integer endLine() {
            return endLine;
        }

        public Anchor anchor() {
            return anchor;
        }

        public Conditions conditions() {
            return conditions;
        }

        public List<Block> children() {
            return children;
        }

        public List<Region> regions() {
            return regions;
        }

        public Integer openLine() {
            return openLine;
        }

        public Integer closeLine() {
            return closeLine;
        }
    }

    /** The lexical facts one scan needs, built once and threaded through the scanner. */
    public static final class Lex {
        final String source;
        final String[] lines;
        final int[] starts;
        final String mask;
        final String[] maskLines;
        final List<Masker.Comment> comments;
        final Lexer lexer;

        Lex(String source, String[] lines, int[] starts, String mask, String[] maskLines,
            List<Masker.Comment> comments, Lexer lexer) {
            this.source = source;
            this.lines = lines;
            this.starts = starts;
            this.mask = mask;
            this.maskLines = maskLines;
            this.comments = comments;
            this.lexer = lexer;
        }
    }

    /** What {@link #scanBlocks} hands the resolver. */
    public record Scan(Block root, List<Block> blocks, List<Region> regions, List<Anchor> anchors,
                       Lex lex) {
    }

    // ------------------------------------------------------------------
    // Constants — kept in step with index.mjs so the two scanners agree
    // ------------------------------------------------------------------

    private static final Pattern COMMENT_OPENER =
            Pattern.compile("^(?:(?://|--|;|%|'|REM\\b|<!--|/\\*|\\*)\\s*)+", Pattern.CASE_INSENSITIVE);
    private static final Pattern COMMENT_CLOSER = Pattern.compile("\\s*(?:-->|\\*/)$");
    // Package-private: the resolver renders declarations with them, and `index.mjs` and this scanner
    // must agree on the spellings.
    static final Pattern DOC_OPEN = Pattern.compile("^\\s*/\\*[*!]");
    static final Pattern DOC_RUN = Pattern.compile("^\\s*///");
    private static final Pattern ANNOTATION_LINE = Pattern.compile("^\\s*(?:@[\\w.$]|#\\[)");
    private static final Pattern DECLARATION_KEYWORD = Pattern.compile(
            "\\b(?:class|interface|enum|record|struct|trait|object|union)\\s+([A-Za-z_$][\\w$]*)\\b");
    private static final Pattern STATEMENT_BEFORE =
            Pattern.compile("^(?:return|throw|new|await|yield|delete|typeof|case|else|do)\\b");
    private static final Pattern PREFIX = Pattern.compile("^[\\w$<>\\[\\],.?*&:@\\s]*$");
    private static final Pattern STATEMENT_KEYWORD =
            Pattern.compile("\\b(if|else|for|while|do|switch|try|catch|finally|synchronized)\\b");
    private static final Pattern PROPERTY_DECL = Pattern.compile(
            "(?<!\\.)\\b(?:(const|let|var)\\s+|((?:[\\w$]+(?:<[^<>]*>)?)(?:\\s+[\\w$]+(?:<[^<>]*>)?)*?)\\s+)"
                    + "([A-Za-z_$][\\w$]*)\\b\\s*=(?!=)");
    private static final Pattern REGION_DIRECTIVE =
            Pattern.compile("^(#?)(region|endregion)\\b\\s*(.*)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern GAP_IS_GLUE = Pattern.compile("^[\\s+]*$");
    private static final Pattern ARROW_ASSIGNED = Pattern.compile(
            "(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_$][\\w$]*)\\b[^=\\n]*=\\s*(?:async\\s+)?"
                    + "(?:function\\b|[^;]*=>)");
    private static final Pattern CALL = Pattern.compile("(^|[^\\w$.])([A-Za-z_$][\\w$]*)\\s*\\(");
    private static final Pattern FUNC_PREFIX = Pattern.compile("^func\\s*\\([^)]*\\)\\s*");
    private static final Pattern FUNCTION_WORD = Pattern.compile("^function\\b");
    private static final Pattern ANCHOR_NAME = Pattern.compile("^([A-Za-z_$][\\w$]*)$");
    private static final Pattern IS_REGION_LINE = Pattern.compile("^(#?)(region|endregion)\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern QUOTED_NAME = Pattern.compile("^\\s*([A-Za-z_]+)");
    private static final Pattern ELSE_IF = Pattern.compile("^\\s*else\\s+if\\b");
    private static final Pattern IF_WORD = Pattern.compile("\\bif\\b");
    private static final Pattern WHILE_HEAD = Pattern.compile("^\\s*while\\s*\\(");
    private static final Pattern BRACE_LINE = Pattern.compile("^\\s*\\{");
    private static final Pattern DOC_CLOSE_TAIL = Pattern.compile("\\*/\\s*$");
    private static final Pattern TRAILING_SEMICOLON = Pattern.compile(";\\s*$");

    private static final List<String> NOT_A_NAME = List.of(
            "if", "for", "while", "switch", "catch", "return", "new", "do", "else",
            "throw", "await", "yield", "typeof", "delete", "void", "in", "of",
            "instanceof", "super", "this", "with", "case", "when", "sizeof");

    private static final List<String> NOT_A_TYPE = List.of(
            "return", "throw", "new", "else", "do", "case", "await", "yield", "delete", "typeof");

    // ------------------------------------------------------------------
    // Scanning
    // ------------------------------------------------------------------

    /** Scan with the built-in engine — an unknown file type, which is the common case. */
    public static Scan scanBlocks(String text) {
        return scanBlocks(text, DEFAULT);
    }

    /**
     * Scan a source for blocks and the indexable things in each scope: the block tree plus region
     * pairs, condition literals and comment anchors, ready for resolution.
     */
    public static Scan scanBlocks(String text, Lexer lexer) {
        String source = text.replace("\r\n", "\n");
        Lex lex = makeLex(source, lexer == null ? DEFAULT : lexer);

        List<Block> blocks = new ArrayList<>();
        List<Anchor> anchors = new ArrayList<>();

        Block root = new Block("root", null, -1);
        List<Block> top = buildScope(0, lex.lines.length - 1, lex, blocks);
        root.children.addAll(top);
        for (Block child : top) {
            child.parent = root;
            child.scope = root;
        }

        List<Region> regions = pairRegions(lex.lines);
        for (Region region : regions) {
            region.line = region.startLine;
            region.kind = "region";
            root.regions.add(region);
        }
        for (Block block : blocks) {
            if (block.anchor != null) {
                anchors.add(block.anchor);
            }
        }

        return new Scan(root, blocks, regions, anchors, lex);
    }

    /** The lexical facts one scan needs. Asserts the mask invariant for a supplied lexer. */
    private static Lex makeLex(String source, Lexer lexer) {
        String[] lines = source.split("\n", -1);
        int[] starts = Masker.lineStarts(source);

        String who = "lexer \"" + (lexer.name() == null ? "anonymous" : lexer.name()) + "\"";
        String mask = lexer.mask(source);
        if (mask.length() != source.length()) {
            throw new SectionError(who + " mask must preserve length (" + mask.length() + " != "
                    + source.length() + ")");
        }
        for (int i = 0; i < source.length(); i++) {
            if (source.charAt(i) == '\n' && mask.charAt(i) != '\n') {
                throw new SectionError(who + " mask must preserve every newline offset (broken at " + i
                        + ")");
            }
        }

        return new Lex(source, lines, starts, mask, mask.split("\n", -1), lexer.comments(source),
                lexer);
    }

    /** Build the blocks directly inside one scope, in source order. */
    private static List<Block> buildScope(int fromLine, int toLine, Lex lex, List<Block> blocks) {
        List<Block> list = new ArrayList<>();
        int i = fromLine;
        while (i <= toLine) {
            String maskedLine = lex.maskLines[i];
            if (maskedLine.trim().isEmpty()) {
                i++;
                continue;
            }
            int start = lex.starts[i];

            // The language's own declaration shapes first: they are more specific than the generic ones.
            List<Declared> declared = lex.lexer.declarations(maskedLine);
            List<Declared> declaredHere = new ArrayList<>();
            for (Declared entry : declared) {
                if (entry.name() != null && !entry.name().isEmpty()
                        && !NOT_A_NAME.contains(entry.name())) {
                    declaredHere.add(entry);
                }
            }
            if (!declaredHere.isEmpty()) {
                int lastEnd = i;
                for (Declared entry : declaredHere) {
                    Span span = "end".equals(entry.body())
                            ? keywordBody(lex.lines, i, entry.end() == null ? "end" : entry.end())
                            : bodySpan(lex.mask, lex.maskLines, lex.starts, i,
                                    start + entry.headerFrom());
                    Block block = new Block(entry.kind() == null ? "method" : entry.kind(),
                            entry.name(), i);
                    if (span != null) {
                        applySpan(block, span);
                    } else if (entry.line()) {
                        block.endLine = i;
                        block.singleLine = true;
                    } else {
                        continue;                     // nothing to inject
                    }
                    applyAnchor(block, lex, span == null ? null : span.open);
                    register(list, block, blocks);
                    descend(block, i, span, lex, blocks);
                    lastEnd = Math.max(lastEnd, endLineOf(span, i));
                }
                i = lastEnd + 1;
                continue;
            }

            Matcher keyword = DECLARATION_KEYWORD.matcher(maskedLine);
            if (keyword.find() && !NOT_A_NAME.contains(keyword.group(1))) {
                String name = keyword.group(1);
                int headerFrom = start + keyword.start() + keyword.group().length();
                Span span = bodySpan(lex.mask, lex.maskLines, lex.starts, i, headerFrom);
                Block block = new Block("class", name, i);
                applySpan(block, span);
                applyAnchor(block, lex, span == null ? null : span.open);
                register(list, block, blocks);
                descend(block, i, span, lex, blocks);
                i = endLineOf(span, i) + 1;
                continue;
            }

            Declaration methodDecl = null;
            boolean methodHasPrefix = false;
            Matcher call = CALL.matcher(maskedLine);
            while (call.find()) {
                String name = call.group(2);
                if (NOT_A_NAME.contains(name)) {
                    continue;
                }
                String before = maskedLine.substring(0, call.start() + call.group(1).length());
                String prefix = FUNC_PREFIX.matcher(before.trim()).replaceFirst("func ");
                if (!prefix.isEmpty() && (!PREFIX.matcher(prefix).matches()
                        || STATEMENT_BEFORE.matcher(prefix).find())) {
                    continue;
                }
                Declaration found = declarationOn(maskedLine, start, name);
                if (found != null && "method".equals(found.kind())) {
                    methodDecl = found;
                    methodHasPrefix = !prefix.isEmpty();
                    break;
                }
            }
            if (methodDecl == null) {
                Matcher assigned = ARROW_ASSIGNED.matcher(maskedLine);
                while (assigned.find()) {
                    Declaration found = declarationOn(maskedLine, start, assigned.group(2));
                    if (found != null && "method".equals(found.kind())) {
                        methodDecl = found;
                        methodHasPrefix = true;
                        break;
                    }
                }
            }
            if (methodDecl != null) {
                Span span = bodySpan(lex.mask, lex.maskLines, lex.starts, i, methodDecl.headerFrom());
                if (span == null && !methodHasPrefix) {
                    i++;                              // a bare `foo();` call, not a declaration
                    continue;
                }
                Block block = new Block("method", methodDecl.name(), i);
                applySpan(block, span);
                applyAnchor(block, lex, span == null ? null : span.open);
                register(list, block, blocks);
                descend(block, i, span, lex, blocks);
                i = endLineOf(span, i) + 1;
                continue;
            }

            Matcher statement = STATEMENT_KEYWORD.matcher(maskedLine);
            if (statement.find()) {
                int bracePos = lex.mask.indexOf('{', start);
                if (bracePos != -1) {
                    List<Segment> segments =
                            chainSegments(lex.mask, lex.starts, i, statement.group(1), bracePos,
                                    statement.start());
                    int lastCloseLine = i;
                    for (Segment segment : segments) {
                        Block block = new Block("statement", null, segment.headerLine);
                        block.open = segment.open;
                        block.close = segment.close;
                        block.openLine = segment.openLine;
                        block.closeLine = segment.closeLine;
                        block.sharedClose = segment.sharedClose;
                        block.endLine = segment.closeLine;
                        int headerStart = lex.starts[segment.headerLine];
                        int headerEnd = Masker.endOfLine(lex.mask, headerStart);
                        String conditionLine = lex.source.substring(headerStart, headerEnd);
                        block.conditions =
                                lex.lexer.conditionLiterals(conditionLine, segment.condOffset);
                        applyAnchor(block, lex, segment.open);
                        register(list, block, blocks);
                        Span childSpan = new Span();
                        childSpan.openLine = segment.openLine;
                        childSpan.closeLine = segment.closeLine;
                        descend(block, segment.headerLine, childSpan, lex, blocks);
                        lastCloseLine = Math.max(lastCloseLine, segment.closeLine);
                    }
                    i = lastCloseLine + 1;
                    continue;
                }
            }

            Matcher property = PROPERTY_DECL.matcher(maskedLine);
            if (property.find() && !NOT_A_NAME.contains(property.group(3))
                    && !STATEMENT_BEFORE.matcher(property.group().trim()).find()
                    && !(property.group(2) != null
                            && NOT_A_TYPE.contains(property.group(2).trim().split("\\s+")[0]))) {
                Block block = new Block("property", property.group(3), i);
                block.lineEnd = i;
                register(list, block, blocks);
                i++;
                continue;
            }

            i++;
        }
        return list;
    }

    // ------------------------------------------------------------------
    // Spans
    // ------------------------------------------------------------------

    /**
     * A body span, or null when the member has no body to inject (an interface or {@code abstract}
     * method). Read over the mask, so a brace in a string or comment cannot end a body.
     */
    private static Span bodySpan(String mask, String[] lines, int[] starts, int declLine,
                                 int headerFrom) {
        int lineEnd = Masker.endOfLine(mask, starts[declLine]);
        String rest = mask.substring(headerFrom, Math.max(headerFrom, lineEnd));

        int braceAt = rest.indexOf('{');
        int semiAt = rest.indexOf(';');
        int arrowAt = rest.indexOf("=>");
        // The earliest terminator wins: a body ends at whichever comes first.
        int firstAt = Integer.MAX_VALUE;
        String firstKind = null;
        if (braceAt != -1 && braceAt < firstAt) {
            firstAt = braceAt;
            firstKind = "brace";
        }
        if (semiAt != -1 && semiAt < firstAt) {
            firstAt = semiAt;
            firstKind = "none";
        }
        if (arrowAt != -1 && arrowAt < firstAt) {
            firstAt = arrowAt;
            firstKind = "arrow";
        }
        if ("none".equals(firstKind)) {
            return null;
        }

        if ("arrow".equals(firstKind)) {
            int afterArrow = firstAt + 2;
            int braceInRest = rest.indexOf('{', afterArrow);
            if (braceInRest == -1) {
                Span expression = new Span();
                expression.expression = headerFrom + afterArrow;
                return expression;
            }
            return braceBody(mask, starts, headerFrom + braceInRest);
        }
        if ("brace".equals(firstKind)) {
            return braceBody(mask, starts, headerFrom + firstAt);
        }

        int next = Masker.nextNonBlank(lines, declLine + 1);
        if (next == -1) {
            return null;
        }
        if (BRACE_LINE.matcher(lines[next]).find()) {
            return braceBody(mask, starts, starts[next] + lines[next].indexOf('{'));
        }
        int indent = Masker.indentWidth(lines[declLine]);
        if (Masker.indentWidth(lines[next]) > indent) {
            int end = next;
            for (int i = next + 1; i < lines.length; i++) {
                if (lines[i].trim().isEmpty()) {
                    continue;
                }
                if (Masker.indentWidth(lines[i]) <= indent) {
                    break;
                }
                end = i;
            }
            Span indented = new Span();
            indented.indented = true;
            indented.bodyEndLine = end;
            return indented;
        }
        return null;
    }

    private static Span braceBody(String mask, int[] starts, int open) {
        int close = Masker.matchingBracket(mask, open, '}');
        if (close == -1) {
            return null;
        }
        Span span = new Span();
        span.open = open;
        span.close = close;
        span.openLine = Masker.lineOf(starts, open);
        span.closeLine = Masker.lineOf(starts, close);
        return span;
    }

    /**
     * A body closed by a terminator keyword line ({@code end} in Ruby), found by indentation: the first
     * line at or left of the declaration's indentation whose trimmed text is the terminator. When no
     * terminator is found that way the declaration gets no block at all, rather than half a method.
     */
    private static Span keywordBody(String[] lines, int declLine, String word) {
        int indent = Masker.indentWidth(lines[declLine]);
        for (int i = declLine + 1; i < lines.length; i++) {
            String text = lines[i].trim();
            if (text.isEmpty()) {
                continue;
            }
            if (Masker.indentWidth(lines[i]) > indent) {
                continue;
            }
            if (text.equals(word) || text.startsWith(word + " ")) {
                Span span = new Span();
                span.openLine = declLine;
                span.closeLine = i;
                return span;
            }
            return null;                              // a dedent that is not the terminator
        }
        return null;
    }

    private static void applySpan(Block block, Span span) {
        if (span == null) {
            return;
        }
        if (span.indented) {
            block.indented = true;
            block.closeLine = span.bodyEndLine;
            block.endLine = span.bodyEndLine;
            return;
        }
        if (span.expression != null) {
            block.expression = span.expression;
            block.endLine = block.declLine;
            return;
        }
        block.open = span.open;
        block.close = span.close;
        block.openLine = span.openLine;
        block.closeLine = span.closeLine;
        block.endLine = span.closeLine;
    }

    private static int endLineOf(Span span, int declLine) {
        if (span == null) {
            return declLine;
        }
        if (span.closeLine != null) {
            return span.closeLine;
        }
        if (span.bodyEndLine != null) {
            return span.bodyEndLine;
        }
        return declLine;
    }

    private static void register(List<Block> list, Block block, List<Block> blocks) {
        list.add(block);
        blocks.add(block);
    }

    /** Scan {@code block}'s own body and attach the blocks it directly contains. */
    private static void descend(Block block, int declLine, Span span, Lex lex, List<Block> blocks) {
        if (span == null || span.expression != null || "property".equals(block.kind)) {
            return;
        }
        int childFrom;
        int childTo;
        if (span.indented) {
            childFrom = declLine + 1;
            childTo = span.bodyEndLine;
        } else if (span.openLine != null) {
            childFrom = span.openLine + 1;
            childTo = span.closeLine - 1;
        } else {
            return;
        }
        if (childFrom > childTo) {
            return;
        }
        List<Block> children = buildScope(childFrom, childTo, lex, blocks);
        for (Block child : children) {
            child.parent = block;
            child.scope = block;
            child.scopeName = block.name;
            child.scopeLine = block.declLine;
        }
        block.children.addAll(children);
        block.blocks.addAll(children);
    }

    private static void applyAnchor(Block block, Lex lex, Integer open) {
        // No opening offset (an indented body, a keyword-delimited `end` block): there is no brace to
        // hang a comment anchor on, and a missing offset must not be searched as if it were line 0.
        if (open == null) {
            return;
        }
        Anchor anchor = leadingAnchor(lex.comments, lex.source, lex.lines, lex.starts, open);
        if (anchor != null) {
            block.anchor = anchor;
        }
    }

    // ------------------------------------------------------------------
    // Declarations, conditions, anchors, regions
    // ------------------------------------------------------------------

    /**
     * Whether a masked line declares {@code name}, and where its header ends. The generic shapes are
     * tried after the lexer's own (which is passed in as {@code declared}).
     */
    private static Declaration declarationOn(String maskedLine, int start, String name) {
        return declarationOn(maskedLine, start, name, List.of());
    }

    private static Declaration declarationOn(String maskedLine, int start, String name,
                                             List<Declared> declared) {
        if (name.isEmpty() || NOT_A_NAME.contains(name)) {
            return null;
        }

        for (Declared entry : declared) {
            if (name.equals(entry.name())) {
                return new Declaration(entry.kind() == null ? "method" : entry.kind(), name,
                        start + entry.headerFrom());
            }
        }

        Matcher keyword = DECLARATION_KEYWORD.matcher(maskedLine);
        if (keyword.find() && name.equals(keyword.group(1))) {
            return new Declaration("class", name, start + keyword.start() + keyword.group().length());
        }

        Matcher call = Pattern.compile("(^|[^\\w$.])" + Pattern.quote(name) + "\\s*\\(")
                .matcher(maskedLine);
        while (call.find()) {
            String before = maskedLine.substring(0, call.start() + call.group(1).length());
            String prefix = FUNC_PREFIX.matcher(before.trim()).replaceFirst("func ");
            if (!prefix.isEmpty() && (!PREFIX.matcher(prefix).matches()
                    || STATEMENT_BEFORE.matcher(prefix).find())) {
                continue;
            }
            int paren = call.start() + call.group().length() - 1;
            int close = Masker.matchingBracket(maskedLine, paren, ')');
            if (close == -1) {
                continue;
            }
            return new Declaration("method", name, start + close + 1);
        }

        Matcher assigned = Pattern.compile("(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?"
                        + Pattern.quote(name) + "\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?")
                .matcher(maskedLine);
        while (assigned.find()) {
            int after = assigned.end();
            String rest = maskedLine.substring(after);
            int arrow = rest.indexOf("=>");
            Matcher function = FUNCTION_WORD.matcher(rest);
            boolean hasFunction = function.find();
            if (arrow != -1 && (!hasFunction || arrow < function.start())) {
                return new Declaration("method", name, start + after + arrow);
            }
            if (hasFunction) {
                return new Declaration("method", name, start + after + function.group().length());
            }
        }
        return null;
    }

    /**
     * The double-quoted literals a header line carries, read from the original text with comments
     * skipped. Two forms: the byte-exact literal, and the token-pasted form where adjacent literals
     * (separated only by whitespace or {@code +}) join.
     */
    static Conditions conditionLiterals(String origLine, int from) {
        List<int[]> literals = new ArrayList<>();
        int length = origLine.length();
        // `from` is negative for a chain's first segment: `chainSegments` is handed the keyword's
        // offset *within the line* where every later segment gets an absolute one, and the JavaScript
        // simply reads on from there, so the scan effectively starts at the line's beginning. That is
        // the behaviour to mirror, not a bug to fix.
        int i = Math.max(0, from);
        while (i < length) {
            char character = origLine.charAt(i);
            char next = i + 1 < length ? origLine.charAt(i + 1) : '\0';
            if (character == '/' && next == '/') {
                break;
            }
            if (character == '/' && next == '*') {
                int close = origLine.indexOf("*/", i + 2);
                i = close == -1 ? length : close + 2;
                continue;
            }
            if (character == '"') {
                int j = i + 1;
                while (j < length && origLine.charAt(j) != '"') {
                    if (origLine.charAt(j) == '\\') {
                        j++;
                    }
                    j++;
                }
                literals.add(new int[] {i, j});
                i = j + 1;
                continue;
            }
            i++;
        }

        List<String> exact = new ArrayList<>();
        for (int[] literal : literals) {
            exact.add(origLine.substring(literal[0] + 1, Math.min(literal[1], length)));
        }

        List<String> pasted = new ArrayList<>();
        int k = 0;
        while (k < literals.size()) {
            StringBuilder merged = new StringBuilder(
                    origLine.substring(literals.get(k)[0] + 1, Math.min(literals.get(k)[1], length)));
            int m = k + 1;
            while (m < literals.size()) {
                int gapFrom = Math.min(literals.get(m - 1)[1] + 1, length);
                int gapTo = Math.min(literals.get(m)[0], length);
                String gap = gapFrom <= gapTo ? origLine.substring(gapFrom, gapTo) : "";
                if (!GAP_IS_GLUE.matcher(gap).matches()) {
                    break;
                }
                merged.append(origLine.substring(literals.get(m)[0] + 1,
                        Math.min(literals.get(m)[1], length)));
                m++;
            }
            pasted.add(merged.toString());
            k = m;
        }
        return new Conditions(exact, pasted);
    }

    /** One segment of an {@code if}/{@code else if} (or {@code try}/{@code catch}) chain. */
    static final class Segment {
        final String headerKeyword;
        final int headerLine;
        final int open;
        final int close;
        final int condOffset;
        final boolean sharedClose;
        final int openLine;
        final int closeLine;

        Segment(String headerKeyword, int headerLine, int open, int close, int condOffset,
                boolean sharedClose, int openLine, int closeLine) {
            this.headerKeyword = headerKeyword;
            this.headerLine = headerLine;
            this.open = open;
            this.close = close;
            this.condOffset = condOffset;
            this.sharedClose = sharedClose;
            this.openLine = openLine;
            this.closeLine = closeLine;
        }
    }

    /** The segments of an if/else-if (or try/catch) chain opened on this line. */
    private static List<Segment> chainSegments(String mask, int[] starts, int headerLine,
                                              String keyword, int bracePos, int keywordOffset) {
        List<Segment> segments = new ArrayList<>();
        String curKeyword = keyword;
        int curLine = headerLine;
        int open = bracePos;
        int condFrom = keywordOffset;
        int i = bracePos;
        int depth = 0;
        while (i < mask.length()) {
            char character = mask.charAt(i);
            if (character == '{') {
                depth++;
                i++;
                continue;
            }
            if (character == '}') {
                depth--;
                if (depth == 0) {
                    String rest = mask.substring(i + 1);
                    Matcher word = QUOTED_NAME.matcher(rest);
                    String cont = null;
                    if (word.find() && isContinuation(word.group(1))) {
                        cont = word.group(1);
                    }
                    if ("else".equals(cont) && ELSE_IF.matcher(rest).find()) {
                        int newOpen = mask.indexOf('{', i + 1);
                        segments.add(makeSegment(starts, curKeyword, curLine, open, i, condFrom, true));
                        Matcher ifWord = IF_WORD.matcher(rest);
                        int ifAt = ifWord.find() ? (i + 1) + ifWord.start() : i + 1;
                        curKeyword = "if";
                        curLine = Masker.lineOf(starts, i);
                        open = newOpen;
                        condFrom = ifAt;
                        i = newOpen + 1;
                        depth = 1;
                        continue;
                    }
                    if ("else".equals(cont)) {
                        int newOpen = mask.indexOf('{', i + 1);
                        segments.add(makeSegment(starts, curKeyword, curLine, open, i, condFrom, true));
                        curKeyword = cont;
                        curLine = Masker.lineOf(starts, i);
                        open = newOpen;
                        condFrom = (i + 1) + word.start();
                        i = newOpen + 1;
                        depth = 1;
                        continue;
                    }
                    if (cont != null) {
                        int newOpen = mask.indexOf('{', i + 1);
                        segments.add(makeSegment(starts, curKeyword, curLine, open, i, condFrom, true));
                        curKeyword = cont;
                        curLine = Masker.lineOf(starts, i);
                        open = newOpen;
                        condFrom = (i + 1) + word.start();
                        i = newOpen + 1;
                        depth = 1;
                        continue;
                    }
                    int end = i;
                    if ("do".equals(curKeyword) && WHILE_HEAD.matcher(rest).find()) {
                        int semi = mask.indexOf(';', i);
                        if (semi != -1) {
                            end = semi;
                        }
                    }
                    segments.add(makeSegment(starts, curKeyword, curLine, open, end, condFrom, false));
                    return segments;
                }
                i++;
                continue;
            }
            i++;
        }
        segments.add(makeSegment(starts, curKeyword, curLine, open, mask.length() - 1, condFrom,
                false));
        return segments;
    }

    private static boolean isContinuation(String word) {
        return "else".equals(word) || "catch".equals(word) || "finally".equals(word);
    }

    private static Segment makeSegment(int[] starts, String keyword, int headerLine, int open,
                                       int close, int condFrom, boolean sharedClose) {
        int lineStart = starts[headerLine];
        return new Segment(keyword, headerLine, open, close, condFrom - lineStart, sharedClose,
                Masker.lineOf(starts, open), Masker.lineOf(starts, close));
    }

    /**
     * The leading-comment anchor of a braced block (matcher 6), or null: the comment that is the first
     * thing inside the braces. A {@code #region}/{@code #endregion} line is never an anchor, and a body
     * whose first thing is code has no anchor.
     */
    private static Anchor leadingAnchor(List<Masker.Comment> comments, String source, String[] lines,
                                        int[] starts, int open) {
        Masker.Comment first = null;
        for (Masker.Comment comment : comments) {
            if (comment.from() <= open) {
                continue;
            }
            if (source.substring(open + 1, comment.from()).trim().isEmpty()) {
                first = comment;
            }
            break;
        }
        if (first == null) {
            return null;
        }
        int commentLine = Masker.lineOf(starts, first.from());
        int braceLine = Masker.lineOf(starts, open);
        if (commentLine != braceLine && commentLine != Masker.nextNonBlank(lines, braceLine + 1)) {
            return null;
        }
        String body = first.text().trim();
        if (IS_REGION_LINE.matcher(body).find()) {
            return null;
        }
        Matcher name = ANCHOR_NAME.matcher(body);
        if (!name.matches()) {
            return null;
        }
        return new Anchor(name.group(1), commentLine);
    }

    /**
     * Read one line as a region directive, or null. Same spellings as {@code index.mjs}, same "bare
     * {@code region} is prose" rule.
     */
    static Directive regionDirective(String line) {
        String text = line.trim();
        Matcher closer = COMMENT_CLOSER.matcher(text);
        if (closer.find()) {
            text = text.substring(0, closer.start()).trim();
        }
        boolean commented = COMMENT_OPENER.matcher(text).find();
        if (commented) {
            text = COMMENT_OPENER.matcher(text).replaceFirst("").trim();
        }
        Matcher match = REGION_DIRECTIVE.matcher(text);
        if (!match.find()) {
            return null;
        }
        if (!commented && !"#".equals(match.group(1))) {
            return null;
        }
        return new Directive(match.group(2).toLowerCase(), match.group(3).trim());
    }

    /** A line read as a region directive. */
    record Directive(String kind, String name) {
    }

    private static List<Region> pairRegions(String[] lines) {
        List<Region> out = new ArrayList<>();
        List<String> stackNames = new ArrayList<>();
        List<Integer> stackStarts = new ArrayList<>();
        for (int index = 0; index < lines.length; index++) {
            Directive directive = regionDirective(lines[index]);
            if (directive == null) {
                continue;
            }
            if ("region".equals(directive.kind())) {
                stackNames.add(directive.name());
                stackStarts.add(index);
            } else if (!stackNames.isEmpty()) {
                int last = stackNames.size() - 1;
                out.add(new Region(stackNames.remove(last), stackStarts.remove(last), index));
            }
        }
        return out;
    }
}
