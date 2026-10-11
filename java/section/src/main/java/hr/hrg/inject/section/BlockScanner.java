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

    /**
     * A declaration's header as a slice of the mask: from its first character through the {@code {}
     * or {@code ;} that ends it, <b>including</b> that terminator — one line, or the several a
     * wrapped parameter list spans.
     */
    record Header(int start, int end) {
    }

    /**
     * Where a declaration's header ends: the offset just past the {@code {} or {@code ;} that ends
     * it, and the index of the line that terminator is on.
     */
    private record HeaderEnd(int end, int last) {
    }

    /**
     * A declaration the generic rules found on a masked line. {@code from} is where the body's search
     * starts — after the declaration's name, for the matchers that stop there — and {@code nameAt} is
     * where the name itself starts, which is where the header scan counts brackets from.
     */
    record Declaration(String kind, String name, int from, int nameAt) {
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
        Integer bodyFrom;
        Integer expression;
        Integer expressionEndLine;
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
        Integer bodyFrom;
        Integer expression;
        Integer expressionEndLine;
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
    /** How far a declaration's header may run past the line it starts on, and no further. */
    private static final int HEADER_LINES = 200;
    /** A line that opens a header the next line could continue: a bracket, a comma or a semicolon. */
    private static final Pattern CONTINUES_HEADER = Pattern.compile("[(,;]\\s*$");
    /** A `{` alone on its line: the Allman brace, which only the header rule reaches. */
    private static final Pattern ALLMAN_BRACE = Pattern.compile("^\\s*\\{\\s*$");
    /** What the character before an expression body's `=` must be: a type, a bracket or a `>`. */
    private static final Pattern EXPRESSION_BEFORE = Pattern.compile("[\\w$>)\\]}]");

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
                    Span span;
                    if ("end".equals(entry.body())) {
                        // A shape whose body a keyword line closes (Ruby `end`, VB `End`).
                        span = keywordBody(lex.lines, i,
                                entry.end() == null ? "end" : entry.end());
                    } else if (entry.line()) {
                        // A shape that spells itself complete on its own line (a Rust field, a
                        // one-line Haskell binding) is read from that line: its header is the
                        // declaration line itself.
                        Header header = new Header(start + entry.headerFrom(),
                                start + maskedLine.length());
                        span = shapeBodySpan(lex.mask, lex.maskLines, lex.starts, i, header);
                    } else {
                        span = shapeSpan(lex, i, start, maskedLine, entry);
                    }
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
                // The header scan starts at the name; the body's search starts just after it.
                int nameAt = start + keyword.start() + keyword.group().indexOf(name);
                int headerFrom = start + keyword.start() + keyword.group().length();
                Span span = bodySpan(lex, i, headerFrom, nameAt);
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
                // Read the candidate as a declaration, its own line first.
                Declaration found = declarationOn(maskedLine, start, name, List.of(), lex);
                if (found != null && "method".equals(found.kind())) {
                    methodDecl = found;
                    methodHasPrefix = !prefix.isEmpty();
                    break;
                }
            }
            if (methodDecl == null) {
                Matcher assigned = ARROW_ASSIGNED.matcher(maskedLine);
                while (assigned.find()) {
                    Declaration found = declarationOn(maskedLine, start, assigned.group(2),
                            List.of(), null);
                    if (found != null && "method".equals(found.kind())) {
                        methodDecl = found;
                        methodHasPrefix = true;
                        break;
                    }
                }
            }
            if (methodDecl != null) {
                Span span = bodySpan(lex, i, methodDecl.from(), methodDecl.nameAt());
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
     * A body span for a generic declaration, or null when the member has no body to inject (an
     * interface or {@code abstract} method). Read over the mask, so a brace in a string or comment
     * cannot end a body.
     *
     * <p>{@code from} is where the body's search starts in the mask — after the declaration's name,
     * for the matchers that stop there — and {@code nameAt} is where the name itself starts, so that
     * the header is followed to its {@code {} or {@code ;} wherever that is ({@link #headerEnd}, which
     * is what lets a wrapped parameter list resolve). The terminators are only looked for inside that
     * header.
     */
    private static Span bodySpan(Lex lex, int declLine, int from, int nameAt) {
        HeaderEnd header = headerEnd(lex, declLine, nameAt);
        return bodySpanEnd(lex.mask, lex.maskLines, lex.starts, declLine, from, header.end(),
                header.last(), true);
    }

    /**
     * A body span for a language shape, which is read from its own line: its header is the shape's
     * line, so the caller passes the {@code {} or {@code ;} that ends it. A shape does not look past
     * its line for the body's {@code {} (its own line says where the body is), so the deferred
     * terminator — the rule that lets a wrapped {@code throws} clause keep its brace — is not read.
     */
    private static Span shapeBodySpan(String mask, String[] lines, int[] starts, int declLine,
                                      Header header) {
        return bodySpanEnd(mask, lines, starts, declLine, header.start(), header.end(), declLine,
                false);
    }

    /**
     * The body span of a language shape that opens a body: a port of the shape branch of
     * {@code buildScope} ({@code lib/section.mjs:2165}).
     *
     * <p>A shape says where its body begins. An {@code =} is an expression body and is read as such.
     * A {@code {} — or an offset just past one, which is how a shape that opens a brace body states
     * it — is a brace body, scanned from the shape's own name so brackets before it cannot offset the
     * depth; that is what makes a Rust {@code impl Cart {}} a brace span rather than an indented one.
     * Anything else carries no body of its own: the body is its own line, and is empty when nothing
     * extends it.
     */
    private static Span shapeSpan(Lex lex, int line, int start, String maskedLine, Declared entry) {
        int nameAt = start + maskedLine.indexOf(entry.name());
        int at = start + entry.headerFrom();
        char here = at < lex.mask.length() ? lex.mask.charAt(at) : '\0';
        int opened;
        if (here == '{' || here == ' ' || here == '\t') {
            opened = at;
        } else if (at > 0 && lex.mask.charAt(at - 1) == '{') {
            opened = at - 1;
        } else {
            opened = -1;
        }
        if (here == '=') {
            return expressionBody(lex.lines, lex.starts, line, at + 1);
        }
        if (opened != -1) {
            return bodySpan(lex, line, opened, nameAt);
        }
        Span own = new Span();
        own.indented = true;
        own.bodyEndLine = line;
        own.bodyFrom = line;
        return own;
    }

    /** The body-span rules, once the header's own end offset and last line are known. */
    private static Span bodySpanEnd(String mask, String[] lines, int[] starts, int declLine, int from,
                                    int to, int headerLast, boolean deferredTerminator) {
        String rest = slice(mask, from, to);
        Terminator terminator = terminatorIn(rest);

        // A `;` with every bracket closed is a member with no body to inject.
        if (terminator != null && "none".equals(terminator.kind())) {
            return null;
        }

        if (terminator != null && "arrow".equals(terminator.kind())) {
            // The arrow that opens the body is read first: for `(n) => n + 1;` the `=>` is what
            // declares the member's body, and the `;` after it closes that body rather than declaring a
            // body-less member. A brace only opens the body when it is on the arrow's own line.
            int at = from + terminator.at() + 2;
            int brace = mask.indexOf('{', at);
            int lineEnd = Masker.endOfLine(mask, at);
            if (brace == -1 || brace > lineEnd) {
                return expressionBody(lines, starts, declLine, at);
            }
            return braceBody(mask, starts, brace);
        }
        if (terminator != null) {
            return braceBody(mask, starts, from + terminator.at());
        }

        // An `=` opens an expression body, and is checked before the indentation rule: an indented
        // line after a `=` is part of the *expression*, not a body. `expressionAt` wants a word
        // character before the `=`, which is how a Kotlin `): String = expr` and a `fun f(): T = expr`
        // both spell one; an `=` that only a space precedes is still the body's, because the caller has
        // already decided this is a declaration. The remainder may begin *at* the `=` (the header ended
        // on it), so the expression starts one past whichever `=` was found.
        int equals = expressionAt(rest);
        if (equals != -1) {
            return expressionBody(lines, starts, declLine, from + equals + 2);
        }
        int bare = rest.indexOf('=');
        if (bare != -1 && (bare + 1 >= rest.length() || rest.charAt(bare + 1) != '=')) {
            return expressionBody(lines, starts, declLine, from + bare + 2);
        }

        int next = Masker.nextNonBlank(lines, headerLast + 1);
        if (next == -1) {
            return null;
        }
        if (BRACE_LINE.matcher(lines[next]).find()) {
            return braceBody(mask, starts, starts[next] + lines[next].indexOf('{'));
        }

        // A line that still belongs to the declaration — a `throws` clause, a return type — puts the
        // `{` after it. A wrapped header's body starts after the last of its lines, so the search
        // begins there.
        if (deferredTerminator) {
            int searchFrom = Math.max(next, headerLast);
            String after = slice(mask, from, starts[searchFrom] + lines[searchFrom].length());
            Terminator deferred = terminatorIn(after);
            if (deferred != null && "none".equals(deferred.kind())) {
                return null;
            }
            if (deferred != null && "brace".equals(deferred.kind())) {
                return braceBody(mask, starts, from + deferred.at());
            }
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
            // A wrapped header's own lines are not part of its body: the body starts after the last of
            // them.
            indented.bodyFrom = Math.max(next, headerLast + 1);
            return indented;
        }
        return null;
    }

    /** The first of {@code {}}, {@code ;} and {@code =>} in a header, in the order they appear. */
    private record Terminator(int at, String kind) {
    }

    /**
     * The first of {@code {}, {@code ;} and {@code =>} in a header, in the order they appear — the
     * thing that ended it. A {@code ;} means no body, a {@code {} opens one, and {@code =>} is an
     * arrow; whichever comes first is what the header ended with.
     */
    private static Terminator terminatorIn(String text) {
        int braceAt = text.indexOf('{');
        int semiAt = text.indexOf(';');
        int arrowAt = text.indexOf("=>");
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
        return firstKind == null ? null : new Terminator(firstAt, firstKind);
    }

    /**
     * The offset of the {@code =} that introduces an expression body, or -1: a port of
     * {@code expressionAt} ({@code lib/section.mjs:904}).
     *
     * <p>{@code fun label(x: Int): String = if (x > 0) "yes" else "no"} is a function whose body is an
     * expression. A {@code =} that stands for {@code ==}, {@code <=}, {@code >=}, {@code !=} or
     * {@code +=} is not a body — which is why the character right after the {@code =} must not be
     * {@code =} — and neither is a type annotation's ({@code name: Type =}), which is why the last
     * character before it must close something: a type, a bracket or a {@code >}.
     */
    private static int expressionAt(String rest) {
        for (int at = rest.indexOf('='); at != -1; at = rest.indexOf('=', at + 1)) {
            if (at + 1 < rest.length() && rest.charAt(at + 1) == '=') {
                continue;
            }
            if (at > 0 && EXPRESSION_BEFORE.matcher(rest.substring(at - 1, at)).matches()) {
                return at;
            }
        }
        return -1;
    }

    /**
     * An expression body beginning at {@code at}: it runs to the end of its line, and on through the
     * indented lines that follow it — a {@code do} block, a {@code where} clause — which the
     * declaration's own indentation governs. Port of {@code expressionBody} ({@code lib/section.mjs:1119}).
     */
    private static Span expressionBody(String[] lines, int[] starts, int declLine, int at) {
        int first = Masker.lineOf(starts, at);
        int indent = Masker.indentWidth(lines[declLine]);
        // A body that starts on the declaration's own line is the rest of that line
        // (`const inc = (n) => n + 1;`); the lines below belong to it only when it starts on a later
        // one and they are indented under the declaration — a `do` block under a wrapped `main = do`.
        int last = first > declLine ? first : declLine;
        if (first > declLine) {
            for (int i = first + 1; i < lines.length; i++) {
                if (lines[i].trim().isEmpty()) {
                    break;
                }
                if (Masker.indentWidth(lines[i]) <= indent) {
                    break;
                }
                last = i;
            }
        }
        Span span = new Span();
        span.expression = at;
        span.expressionEndLine = last;
        return span;
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

    /** JavaScript's {@code text.slice(from, to)}: clamped at both ends. */
    private static String slice(String text, int from, int to) {
        int start = Math.max(0, Math.min(from, text.length()));
        int end = Math.max(start, Math.min(to, text.length()));
        return text.substring(start, end);
    }

    /**
     * Where a declaration's header ends, starting at {@code nameAt} on {@code line}: a faithful port
     * of {@code headerEnd} ({@code lib/section.mjs:931}).
     *
     * <p>Wrapping a parameter list is formatting, not a different declaration, so a header may span
     * lines — but only while it could still be a header. It ends at the first {@code {} or {@code ;}
     * met with every bracket closed, and stops at the blank line or the line that cannot continue it
     * (a body-less member, a declaration the mask cut short). Counting every bracket — {@code (},
     * {@code [}, {@code {}, {@code <} — is what makes a wrapped parameter list, a wrapped generic list
     * and a wrapped {@code throws} one rule; a {@code {} inside the header's own brackets (a lambda
     * default, an array initialiser) is not the body's brace, because a bracket is open. The scan is
     * bounded by {@link #HEADER_LINES}, so a header that is never closed is not followed through the
     * file.
     *
     * <p>The count starts at the declaration's own name and never at the line start: everything before
     * where the header starts is already the declaration's name, and its brackets are not the
     * header's. An arrow's {@code >} is not a closing angle bracket either — {@code =>} and {@code ->}
     * are punctuation, and counting one as a bracket ends a header that was still open (a Rust
     * {@code fn remove(&mut self) -> Option<String> {} header would end at its own arrow, and its body
     * would fall to the indentation rule, dropping the closing brace).
     *
     * @param lex    the scan's lexical facts
     * @param line   the line the declaration starts on
     * @param nameAt the offset in the mask the header starts at
     * @return the offset just past the {@code {}/{@code ;} that ends the header (or the end of its
     *     last line), and that line's index
     */
    private static HeaderEnd headerEnd(Lex lex, int line, int nameAt) {
        String[] maskLines = lex.maskLines;
        int[] starts = lex.starts;
        int stop = Math.min(maskLines.length - 1, line + HEADER_LINES - 1);
        int depth = 0;
        int start = nameAt;
        int i = line;
        for (; i <= stop; i++) {
            String text = maskLines[i];
            if (i > line && text.trim().isEmpty()) {
                break;
            }
            if (depth == 0) {
                depth = bracketDepth(text, 0, start - starts[i]);
            }
            for (int column = Math.max(0, start - starts[i]); column < text.length(); column++) {
                char character = text.charAt(column);
                // A `{` or `;` with every bracket closed ends the header, and is part of it: the body
                // starts after it.
                if (depth == 0 && (character == '{' || character == ';')) {
                    return new HeaderEnd(starts[i] + column + 1, i);
                }
                // An arrow's `>` is not a closing angle bracket: `=>` and `->` are punctuation, and
                // counting one as a bracket ends a header that was still open.
                char previous = column > 0 ? text.charAt(column - 1) : '\0';
                if (character == '(' || character == '[' || character == '{' || character == '<') {
                    depth++;
                } else if (character == ')' || character == ']' || character == '}') {
                    depth--;
                } else if (character == '>' && previous != '=' && previous != '-') {
                    depth--;
                }
                if (depth < 0) {
                    return new HeaderEnd(starts[i] + column + 1, i);
                }
            }
            depth = Math.max(0, depth);
            start = starts[i] + text.length();
            // A header continues while a bracket is open, while the line ends on a separator, and onto
            // a `{` alone on the next line — the Allman brace, which no other rule reaches. A `{` at
            // the end of the header's own line was already found above.
            int next = Masker.nextNonBlank(maskLines, i + 1);
            boolean continues = depth > 0 || CONTINUES_HEADER.matcher(text).find()
                    || (next != -1 && ALLMAN_BRACE.matcher(maskLines[next]).matches());
            if (!continues) {
                return new HeaderEnd(start, i);
            }
        }
        i = Math.min(i, maskLines.length - 1);
        return new HeaderEnd(starts[i] + maskLines[i].length(), i);
    }

    /** How much {@code text} opens across every bracket a header can hold, from {@code from} to {@code to}. */
    private static int bracketDepth(String text, int from, int to) {
        int depth = 0;
        for (int at = from; at < to; at++) {
            char character = text.charAt(at);
            if (character == '(' || character == '[' || character == '{' || character == '<') {
                depth++;
            } else if (character == ')' || character == ']' || character == '}' || character == '>') {
                depth--;
            }
        }
        return depth;
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
            // The body starts at `bodyFrom` when the header wrapped (its own lines are the
            // declaration's, not the body's) and runs to `bodyEndLine`. A one-line shape that was not
            // extended has its body before it starts, which is what makes that body empty.
            block.bodyFrom = span.bodyFrom != null ? span.bodyFrom : block.declLine + 1;
            block.closeLine = span.bodyEndLine;
            block.endLine = span.bodyEndLine;
            return;
        }
        if (span.expression != null) {
            block.expression = span.expression;
            if (span.expressionEndLine != null) {
                block.expressionEndLine = span.expressionEndLine;
            }
            // An expression body is rendered from its own offset, so no `endLine` may be left behind
            // for the resolver to prefer over it.
            block.endLine = null;
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
     * Whether a declaration on {@code line} names {@code name}, and where its name and its body
     * start: a port of {@code declarationOn} ({@code lib/section.mjs:1196}).
     *
     * <p>The declaration is read from its own line whenever that line says everything there is to
     * say, which is the only shape the matcher ever had to read. A header that wraps — a parameter
     * list, a generic list, a {@code throws} clause — is not readable that way, because the closing
     * bracket sits on a later line; for those, {@link #declarationAcross} follows the header
     * ({@link #headerEnd}) instead. The line's own reading is what decides <em>whether</em> there is a
     * declaration at all — a bare name that merely appears inside a wrapped construct must not become
     * one — and the whole-header reading is only asked where it ends.
     *
     * @param maskedLine the line as the mask has it
     * @param start      the offset of that line in the mask
     * @param name       the name being looked for
     * @param declared   the lexer's own shapes for this line
     * @param lex        the scan's lexical facts, for the wrapped reading; a caller without them
     *                   skips it, as the JavaScript's does
     */
    private static Declaration declarationOn(String maskedLine, int start, String name,
                                             List<Declared> declared, Lex lex) {
        if (name.isEmpty() || NOT_A_NAME.contains(name)) {
            return null;
        }

        for (Declared entry : declared) {
            if (name.equals(entry.name())) {
                int headerFrom = start + entry.headerFrom();
                return new Declaration(entry.kind() == null ? "method" : entry.kind(), name,
                        headerFrom, headerFrom);
            }
        }

        Matcher keyword = DECLARATION_KEYWORD.matcher(maskedLine);
        if (keyword.find() && name.equals(keyword.group(1))) {
            // `nameAt` is where the name itself is written, which is where the header scan counts
            // brackets from; `headerFrom` is just past it, where the body's search starts.
            int nameAt = start + keyword.start() + keyword.group().indexOf(name);
            int headerFrom = start + keyword.start() + keyword.group().length();
            return new Declaration("class", name, headerFrom, nameAt);
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
            int close = Masker.matchingBracket(maskedLine, call.end() - 1, ')');
            if (close == -1) {
                continue;
            }
            int nameAt = start + call.start() + call.group(1).length();
            return new Declaration("method", name, start + close + 1, nameAt);
        }

        if (lex != null) {
            // The parameter list may close on a later line, where only the whole header can see it.
            Declaration across = declarationAcross(lex, start, name);
            if (across != null) {
                return across;
            }
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
            int from;
            if (arrow != -1 && (!hasFunction || arrow < function.start())) {
                from = start + after + arrow;
            } else if (hasFunction) {
                from = start + after + function.group().length();
            } else {
                continue;
            }
            return new Declaration("method", name, from,
                    start + assigned.start() + assigned.group(1).length());
        }
        return null;
    }

    /**
     * The same matchers, run over the whole header instead of one line: a port of
     * {@code declarationAcross} ({@code lib/section.mjs:1273}).
     *
     * <p>The header is followed from the declaration's line to its {@code {} or {@code ;}
     * ({@link #headerEnd}), because that is the only slice in which the closing bracket of a wrapped
     * parameter list exists. The scan starts at the line's first non-blank character, not at the
     * name, and a header that does not leave its own line says nothing a one-line reading did not.
     * {@code name(} must still open the name, and the text before it — on the line it is written on
     * — must still read as a return type, a modifier list or nothing, so a name that merely appears
     * inside a wrapped argument list is not a declaration.
     *
     * <p>{@code matchingBracket} takes an index into the text handed to it — the header slice — and
     * not an index into the whole mask, which is why the {@code (} is located in {@code text}.
     */
    private static Declaration declarationAcross(Lex lex, int start, String name) {
        String[] maskLines = lex.maskLines;
        int[] starts = lex.starts;
        int line = Masker.lineOf(starts, start);
        int from = start + (maskLines[line].length() - maskLines[line].stripLeading().length());
        HeaderEnd header = headerEnd(lex, line, from);
        if (header.last() == line) {
            return null;
        }
        String text = slice(lex.mask, start, header.end());

        Matcher open = Pattern.compile("(^|[^\\w$.])" + Pattern.quote(name) + "\\s*\\(")
                .matcher(text);
        while (open.find()) {
            int column = open.start() + open.group(1).length();
            int on = Masker.lineOf(starts, start + column);
            String before = slice(maskLines[on], 0, start + column - starts[on]);
            String prefix = FUNC_PREFIX.matcher(before.trim()).replaceFirst("func ");
            if (!prefix.isEmpty() && (!PREFIX.matcher(prefix).matches()
                    || STATEMENT_BEFORE.matcher(prefix).find())) {
                continue;
            }
            int close = Masker.matchingBracket(text, open.end() - 1, ')');
            if (close == -1) {
                continue;
            }
            return new Declaration("method", name, start + close + 1, start + column);
        }

        Matcher assigned = Pattern.compile("(^|[^\\w$.])(?:const\\s+|let\\s+|var\\s+)?"
                        + Pattern.quote(name) + "\\b(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(?:async\\s+)?")
                .matcher(text);
        while (assigned.find()) {
            int column = assigned.start() + assigned.group(1).length();
            int on = Masker.lineOf(starts, start + column);
            String before = slice(maskLines[on], 0, start + column - starts[on]);
            String prefix = before.trim();
            if (!prefix.isEmpty() && (!PREFIX.matcher(prefix).matches()
                    || STATEMENT_BEFORE.matcher(prefix).find())) {
                continue;
            }
            String rest = text.substring(assigned.end());
            int arrow = rest.indexOf("=>");
            if (arrow == -1 && !FUNCTION_WORD.matcher(rest).find()) {
                continue;
            }
            return new Declaration("method", name,
                    start + assigned.end() + (arrow == -1 ? 0 : arrow), start + column);
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
