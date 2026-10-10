package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Part C of {@code lib/section.mjs}: resolution — matcher precedence, the sibling-first walk, and the
 * modifiers, which together turn a {@code #<reference>} into the bytes it stands for.
 *
 * <p>Two entry points matter to a host:
 *
 * <ul>
 *   <li>{@link #resolveSection(String, String)} — the text a reference stands for, for a link's
 *       fragment;</li>
 *   <li>{@link #extractDeclaration(String, String)} — the text one named declaration contributes,
 *       which never matches a {@code #region} directive.</li>
 * </ul>
 *
 * <p>The walk is the part a port gets wrong: within one scope the six matchers are tried in order and
 * the first that matches ends the lookup <em>for that scope</em>; scopes are searched level by level,
 * so every sibling at one depth is tried before the walk descends into any block they contain. That
 * is why a declaration is never shadowed by a same-named block nested inside an earlier sibling.
 */
public final class SectionResolver {

    private SectionResolver() {
    }

    /** One matcher hit: a block with the kind that found it, or a region directive. */
    public record Hit(String kind, BlockScanner.Block block, Integer headerLine,
                      BlockScanner.Region region) {

        static Hit of(String kind, BlockScanner.Block block, Integer headerLine) {
            return new Hit(kind, block, headerLine, null);
        }

        static Hit ofRegion(BlockScanner.Region region) {
            return new Hit("region", null, null, region);
        }
    }

    /**
     * What a reference resolved to: the section's text, the parsed reference (so a caller can report a
     * warning), the <b>1-based inclusive line range</b> the text came from, and the matcher that found it
     * ({@code region}, {@code declaration}, {@code property}, {@code condition} or {@code anchor}).
     *
     * <p>The span is what a host that <em>navigates</em> needs — a click lands on a line, not on bytes —
     * and it is computed from the same slice the text was made from, so no second search can disagree
     * with the first answer. The kind is what a host that <em>explains</em> needs: it is the difference
     * between "a region directive says so" and "a declaration was found", which is worth saying out loud.
     */
    public record Plan(String text, SectionReference reference, int startLine, int endLine,
                       String kind) {
    }

    /** Rendered text with the line range it came from, before it becomes a {@link Plan}. */
    private record Rendered(String text, int from, int to) {
    }

    /** The text a section reference stands for, with the built-in engine. */
    public static String resolveSection(String text, String reference) {
        return planSection(text, reference, BlockScanner.DEFAULT).text();
    }

    /** The text a section reference stands for, with a file type's lexer. */
    public static String resolveSection(String text, String reference, BlockScanner.Lexer lexer) {
        return planSection(text, reference, lexer).text();
    }

    /**
     * Resolve a section reference to text, exposing the reference and any contradiction warning.
     *
     * @param text      the target file's content
     * @param reference the {@code #} fragment content
     * @param lexer     the file type's lexer, or {@link BlockScanner#DEFAULT}
     * @throws SectionReferenceException the reference is malformed
     * @throws SectionError              the reference is well formed but matches nothing
     */
    public static Plan planSection(String text, String reference, BlockScanner.Lexer lexer) {
        SectionReference parsed = SectionReference.parse(reference);
        String source = text.replace("\r\n", "\n");
        BlockScanner.Scan scan = BlockScanner.scanBlocks(source, lexer);
        BlockScanner.Lex lex = scan.lex();
        Ctx ctx = new Ctx(lex.lines, lex.source, lex.starts, lex.lexer);

        Hit found = resolvePath(parsed.segments(), 0, scan.root(), false, null, ctx);

        Rendered rendered;
        String kind;
        if (found.region() != null) {
            int from = found.region().startLine() + 1;
            int to = found.region().endLine();
            rendered = span(slice(lex.lines, from, to), from, to);
            kind = "region";
        } else {
            rendered = renderBlock(found.block(), parsed.scope(), ctx, found.kind());
            kind = found.kind();
        }
        return new Plan(rendered.text(), parsed, rendered.from(), rendered.to(), kind);
    }

    /**
     * The text a single named declaration contributes, or null when the name declares nothing.
     *
     * <p>Searches the whole file at any depth, prefers a class-like over a same-named member, and
     * throws on a genuine overload pair. Never matches a {@code #region} directive, only declarations —
     * that is {@code extractDeclaration}'s semantics, unchanged.
     */
    public static String extractDeclaration(String text, String name) {
        return extractDeclaration(text, name, Scope.DECLARATION);
    }

    public static String extractDeclaration(String text, String name, Scope scope) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        String source = text.replace("\r\n", "\n");
        BlockScanner.Scan scan = BlockScanner.scanBlocks(source);
        BlockScanner.Lex lex = scan.lex();

        List<BlockScanner.Block> found = new ArrayList<>();
        collect(scan.root(), name, found);
        if (found.isEmpty()) {
            return null;
        }

        List<BlockScanner.Block> classes = new ArrayList<>();
        for (BlockScanner.Block block : found) {
            if ("class".equals(block.kind)) {
                classes.add(block);
            }
        }
        List<BlockScanner.Block> chosen = classes.isEmpty() ? found : classes;
        if (chosen.size() > 1) {
            throw new SectionError(
                    "\"" + name + "\" is declared " + chosen.size() + " times; names must be unique");
        }
        return renderDeclaration(lex.lines, lex.source, lex.starts, chosen.get(0), scope,
                line -> lex.lexer.isAnnotationLine(line)).text();
    }

    private static void collect(BlockScanner.Block scope, String name,
                                List<BlockScanner.Block> found) {
        for (BlockScanner.Block block : scope.children()) {
            boolean named = "class".equals(block.kind) || "method".equals(block.kind)
                    || "property".equals(block.kind);
            if (named && name.equals(block.name) && hasBody(block)) {
                found.add(block);
            }
            collect(block, name, found);
        }
    }

    private static boolean hasBody(BlockScanner.Block block) {
        return Boolean.TRUE.equals(block.singleLine) || block.expression != null || block.indented
                || block.openLine != null;
    }

    // ------------------------------------------------------------------
    // The walk
    // ------------------------------------------------------------------

    /**
     * Resolve {@code segments[index..]} starting at {@code scope}, retrying same-named candidates: a
     * candidate that cannot be a scope, or that does not hold the rest of the path, gives way to the
     * next one at the same level. The <b>last</b> segment is not retried — its first match in walk
     * order is the selection — so a path is only ambiguous when the scopes disagree.
     */
    private static Hit resolvePath(List<String> segments, int index, BlockScanner.Block scope,
                                   boolean descended, String prevName, Ctx ctx) {
        String segment = segments.get(index);
        boolean last = index == segments.size() - 1;
        List<Hit> candidates = searchSegments(segment, scope, descended);

        if (candidates.isEmpty()) {
            // The whole reference is one name that matched nothing: the message the contract has always
            // used names both engines it could have come from.
            if (index == 0 && last) {
                throw new SectionError("no \"#region " + segment + "\" found, and no section named \""
                        + segment + "\"");
            }
            throw new SectionError("no section named \"" + segment + "\" in \""
                    + (prevName == null ? "" : prevName) + "\"");
        }

        SectionError failure = null;
        for (Hit candidate : candidates) {
            if (last) {
                return candidate;
            }
            if (candidate.region() != null || !isContainer(candidate.block())) {
                if (failure == null) {
                    failure = new SectionError("\"" + segment + "\" is not a container");
                }
                continue;
            }
            try {
                return resolvePath(segments, index + 1, candidate.block(), true, segment, ctx);
            } catch (SectionError error) {
                if (failure == null) {
                    failure = error;
                }
            }
        }
        throw failure;
    }

    /**
     * Find every {@code segment} in the shallowest level of {@code scope} that has one, in walk order,
     * applying matcher precedence per scope: siblings before deeper blocks.
     */
    private static List<Hit> searchSegments(String segment, BlockScanner.Block scope,
                                            boolean descended) {
        List<Node> level = new ArrayList<>();
        level.add(new Node(scope, descended));
        while (!level.isEmpty()) {
            List<Hit> hits = new ArrayList<>();
            for (Node node : level) {
                hits.addAll(matchSegment(node.scope, segment, node.descended));
            }
            if (!hits.isEmpty()) {
                return hits;
            }
            List<Node> deeper = new ArrayList<>();
            for (Node node : level) {
                for (BlockScanner.Block child : node.scope.children()) {
                    deeper.add(new Node(child, true));
                }
            }
            level = deeper;
        }
        return List.of();
    }

    private record Node(BlockScanner.Block scope, boolean descended) {
    }

    /**
     * The matcher-precedence lookup of {@code segment} inside one scope, matchers 1–6, considering only
     * this scope's own members. Returns the matches of the first matcher that has any, in walk order.
     */
    private static List<Hit> matchSegment(BlockScanner.Block scope, String segment,
                                          boolean descended) {
        // 1 — region directive (modifier ignored).
        List<BlockScanner.Region> regions = new ArrayList<>();
        for (BlockScanner.Region region : scope.regions()) {
            if (segment.equals(region.name())) {
                regions.add(region);
            }
        }
        if (regions.size() > 1) {
            throw new SectionError("\"#region " + segment + "\" appears " + regions.size()
                    + " times; region names must be unique");
        }
        if (regions.size() == 1) {
            return List.of(Hit.ofRegion(regions.get(0)));
        }

        // When we have descended *into* this block, its own comment anchor is in scope for this
        // segment. Checked early so `handler/getUsers` resolves to the handler block itself.
        if (descended && scope.anchor != null && segment.equals(scope.anchor.name())) {
            return List.of(Hit.of("anchor", scope, scope.anchor.line()));
        }

        // 2 — class-like, 3 — method/function (body-carrying), 4 — property. Every same-named
        // declaration of the winning kind is a candidate, in source order.
        List<BlockScanner.Block> classes = named(scope, "class", segment);
        if (!classes.isEmpty()) {
            return declarations(classes);
        }
        List<BlockScanner.Block> methods = named(scope, "method", segment);
        if (!methods.isEmpty()) {
            return declarations(methods);
        }
        List<BlockScanner.Block> properties = named(scope, "property", segment);
        if (!properties.isEmpty()) {
            List<Hit> hits = new ArrayList<>();
            for (BlockScanner.Block block : properties) {
                hits.add(Hit.of("property", block, null));
            }
            return hits;
        }

        // 5 — condition literal: this scope's own condition when the scope is a statement block, or a
        // direct statement child. Deeper statements are reached only by the level-order descent above.
        if ("statement".equals(scope.kind) && scope.conditions() != null
                && scope.conditions().pasted().contains(segment)) {
            return List.of(Hit.of("condition", scope, scope.declLine));
        }
        List<Hit> conditions = new ArrayList<>();
        for (BlockScanner.Block child : scope.children()) {
            if ("statement".equals(child.kind) && child.conditions() != null
                    && child.conditions().pasted().contains(segment)) {
                conditions.add(Hit.of("condition", child, child.declLine));
            }
        }
        if (!conditions.isEmpty()) {
            return conditions;
        }

        // 6 — comment anchor: a child block in this scope whose anchor names the segment.
        List<Hit> anchored = new ArrayList<>();
        for (BlockScanner.Block child : scope.children()) {
            if (child.anchor != null && segment.equals(child.anchor.name())) {
                anchored.add(Hit.of("anchor", child, child.anchor.line()));
            }
        }
        return anchored;
    }

    private static List<BlockScanner.Block> named(BlockScanner.Block scope, String kind,
                                                  String segment) {
        List<BlockScanner.Block> matches = new ArrayList<>();
        for (BlockScanner.Block child : scope.children()) {
            if (kind.equals(child.kind) && segment.equals(child.name)) {
                matches.add(child);
            }
        }
        return matches;
    }

    private static List<Hit> declarations(List<BlockScanner.Block> blocks) {
        List<Hit> hits = new ArrayList<>();
        for (BlockScanner.Block block : blocks) {
            hits.add(Hit.of("declaration", block, null));
        }
        return hits;
    }

    /** Whether a matched block can hold nested sections (a scope for the walk). */
    private static boolean isContainer(BlockScanner.Block block) {
        if ("property".equals(block.kind)) {
            return false;
        }
        return !block.children().isEmpty() || block.indented
                || (block.openLine() != null && block.closeLine() != null
                        && block.openLine() < block.closeLine());
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    private record Ctx(String[] lines, String source, int[] starts, BlockScanner.Lexer lexer) {
    }

    /** The text {@code block} contributes under {@code scope}, per contract §8. */
    private static Rendered renderBlock(BlockScanner.Block block, Scope scope, Ctx ctx,
                                        String matchKind) {
        boolean isAnchor = "anchor".equals(matchKind) || "condition".equals(matchKind);
        if (!isAnchor && ("class".equals(block.kind) || "method".equals(block.kind))) {
            return renderDeclaration(ctx.lines, ctx.source, ctx.starts, block, scope,
                    line -> ctx.lexer.isAnnotationLine(line));
        }
        if (!isAnchor && "property".equals(block.kind)) {
            if (scope == Scope.BODY) {
                int equals = ctx.source.indexOf('=', ctx.starts[block.declLine]);
                if (equals != -1) {
                    int lineEnd = Masker.endOfLine(ctx.source, ctx.starts[block.declLine]);
                    return single(TRAILING_SEMICOLON.matcher(ctx.source.substring(equals + 1, lineEnd))
                            .replaceFirst("").trim(), block.declLine);
                }
            }
            return single(ctx.lines[block.declLine].stripTrailing(), block.declLine);
        }

        // A condition literal or comment anchor: the block is the unit. Its first line is the
        // declaration/header line (for an anchor on the open line the anchor comment rides along).
        Integer anchorLine = block.anchor == null ? null : block.anchor.line();
        int firstLine = block.declLine;
        int lastLine = block.closeLine;
        if (scope == Scope.BODY) {
            // Body is strictly inside the braces, and for an anchor the anchor comment line is excluded.
            int bodyFrom = Math.max(block.openLine, anchorLine == null ? block.openLine : anchorLine);
            if (bodyFrom >= block.closeLine) {
                // The slice is trimmed, so the span has to account for the blank lines the trim removed
                // at either end — a click lands on the section's first real line, not on the brace.
                String raw = ctx.source.substring(block.open + 1, block.close);
                int skipped = raw.length() - raw.stripLeading().length();
                int dropped = raw.length() - raw.stripTrailing().length();
                int from = Masker.lineOf(ctx.starts, block.open + 1 + skipped);
                int to = Masker.lineOf(ctx.starts, block.close - dropped);
                return new Rendered(raw.trim(), from + 1, Math.max(from, to) + 1);
            }
            return span(slice(ctx.lines, bodyFrom + 1, block.closeLine), bodyFrom + 1,
                    block.closeLine);
        }
        // A non-final chain segment shares its closing `}` with the continuation on the same line: end
        // the declaration at the brace, not at the whole line.
        if (Boolean.TRUE.equals(block.sharedClose)) {
            String[] parts = ctx.source.substring(ctx.starts[firstLine], block.close + 1).split("\n", -1);
            String[] trimmed = new String[parts.length];
            for (int i = 0; i < parts.length; i++) {
                trimmed[i] = parts[i].stripTrailing();
            }
            return span(trimmed, firstLine, Masker.lineOf(ctx.starts, block.close) + 1);
        }
        return span(slice(ctx.lines, firstLine, lastLine + 1), firstLine, lastLine + 1);
    }

    /**
     * The text one declaration contributes, under one scope — the port of {@code renderDeclaration},
     * unchanged apart from carrying the span.
     */
    private static Rendered renderDeclaration(String[] lines, String source, int[] starts,
                                              BlockScanner.Block range, Scope scope,
                                              Predicate<String> isAnnotation) {
        int endLine = range.endLine != null ? range.endLine : range.closeLine;
        if (scope == Scope.BODY) {
            if (Boolean.TRUE.equals(range.singleLine)) {
                return span(slice(lines, range.declLine, endLine + 1), range.declLine, endLine + 1);
            }
            if (range.indented) {
                return span(slice(lines, range.declLine + 1, endLine + 1), range.declLine + 1,
                        endLine + 1);
            }
            if (range.expression != null) {
                return single(source.substring(range.expression,
                        Masker.endOfLine(source, range.expression)).trim(),
                        Masker.lineOf(starts, range.expression));
            }
            if (range.openLine == endLine) {
                return single(source.substring(range.open + 1, range.close).trim(), range.openLine);
            }
            return span(slice(lines, range.openLine + 1, endLine), range.openLine + 1, endLine);
        }

        int start = range.declLine;
        if (scope == Scope.ANNOTATED || scope == Scope.DOCUMENTED) {
            int annotated = annotationStart(lines, range.declLine, isAnnotation);
            if (annotated != -1) {
                start = annotated;
            }
            if (scope == Scope.DOCUMENTED) {
                int documented = docCommentStart(lines, start);
                if (documented != -1) {
                    start = documented;
                }
            }
        }
        return span(slice(lines, start, endLine + 1), start, endLine + 1);
    }

    /**
     * A rendered section from the already-sliced lines: the text (the JS {@code span} joins exactly what
     * it is handed) and the 1-based inclusive line range {@code [from, to)} came from. An inverted range
     * is empty, and the span then names the line the section would start on — {@code from} — rather than
     * a range that runs backwards.
     */
    private static Rendered span(String[] slicedLines, int from, int to) {
        return new Rendered(String.join("\n", slicedLines), from + 1, Math.max(from, to - 1) + 1);
    }

    /** JavaScript's {@code lines.slice(from, to)}: half-open, and forgiving of odd ranges. */
    private static String[] slice(String[] lines, int from, int to) {
        int start = Math.max(0, from);
        int end = Math.min(lines.length, to);
        if (start >= end) {
            return new String[0];
        }
        String[] out = new String[end - start];
        System.arraycopy(lines, start, out, 0, end - start);
        return out;
    }

    /** A one-line section: the same as {@link #span} with both bounds on that 0-based line. */
    private static Rendered single(String text, int at) {
        return new Rendered(text, at + 1, at + 1);
    }

    private static final Pattern TRAILING_SEMICOLON = Pattern.compile(";\\s*$");

    /**
     * The first line of the annotation block directly above {@code declLine}, or -1. {@code isAnnotation}
     * is the language's own test when its lexer supplies one — the {@code +} scope is "the declaration
     * and what labels it above".
     */
    private static int annotationStart(String[] lines, int declLine,
                                       Predicate<String> isAnnotation) {
        int found = -1;
        for (int i = declLine - 1; i >= 0; i--) {
            if (lines[i].trim().isEmpty()) {
                break;
            }
            if (isAnnotation.test(lines[i])) {
                found = i;
                break;
            }
        }
        if (found == -1) {
            return -1;
        }

        int start = found;
        for (int i = found - 1; i >= 0; i--) {
            if (lines[i].trim().isEmpty() || !isAnnotation.test(lines[i])) {
                break;
            }
            start = i;
        }

        // The block must be annotations all the way: a statement between the declaration and the
        // annotation means there is no annotation block.
        int depth = 0;
        for (int i = start; i < declLine; i++) {
            if (depth == 0 && !isAnnotation.test(lines[i])) {
                return -1;
            }
            depth += Masker.bracketBalance(lines[i]);
        }
        return depth == 0 ? start : -1;
    }

    /** The first line of the doc comment directly above {@code top}, or -1. */
    private static int docCommentStart(String[] lines, int top) {
        int previous = top - 1;
        if (previous < 0 || lines[previous].trim().isEmpty()) {
            return -1;
        }
        if (BlockScanner.DOC_RUN.matcher(lines[previous]).find()) {
            int start = previous;
            while (start - 1 >= 0 && BlockScanner.DOC_RUN.matcher(lines[start - 1]).find()) {
                start--;
            }
            return start;
        }
        if (!Pattern.compile("\\*/\\s*$").matcher(lines[previous]).find()) {
            return -1;
        }
        for (int i = previous; i >= 0; i--) {
            if (lines[i].trim().isEmpty()) {
                return -1;
            }
            if (BlockScanner.DOC_OPEN.matcher(lines[i]).find()) {
                return i;
            }
        }
        return -1;
    }

    /** JavaScript's {@code lines.slice(from, to).join('\n')}: half-open, and forgiving of odd ranges. */
    private static String join(String[] lines, int from, int to) {
        int start = Math.max(0, from);
        int end = Math.min(lines.length, to);
        if (start >= end) {
            return "";
        }
        StringBuilder out = new StringBuilder();
        for (int i = start; i < end; i++) {
            if (i > start) {
                out.append('\n');
            }
            out.append(lines[i]);
        }
        return out.toString();
    }
}
