package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Part C of {@code lib/section.mjs}: resolution — matcher precedence, the sibling-first walk, the
 * selectors, the line ranges and the modifiers, which together turn a {@code #<reference>} into the
 * bytes it stands for.
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
 *
 * <p>A reference may name <b>several selectors</b> ({@code add,L40-L44}): each contributes its own
 * text, rendered with its <em>own</em> scope, and the texts are joined with a newline in the order the
 * selectors were written.
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
     * A 1-based inclusive line range: one selector's contribution, or the merged shape of several.
     *
     * @param from the first line, 1-based
     * @param to   the last line, 1-based and inclusive
     */
    public record Range(int from, int to) {
    }

    /**
     * What a reference resolved to: the section's text, the parsed reference (so a caller can report a
     * warning), the <b>1-based inclusive</b> line ranges the text came from, the outermost bounds of
     * the whole selection, and what the reference is.
     *
     * <p>The ranges are what a host that <em>navigates</em> needs — a click lands on a line, not on
     * bytes — and they are computed from the same slices the text was made from, so no second search
     * can disagree with the first answer. There is one range per selector, merged when two
     * contributions touch or overlap, which is why a reference that names two far-apart pieces
     * highlights the two pieces and not the gap between them.
     *
     * <p>{@link #kind()} is what a host that <em>explains</em> needs: {@code region}, {@code
     * declaration}, {@code property}, {@code condition} or {@code anchor} — the matcher that found the
     * selection — or the answer's own shape when it is not a matcher's: {@code lines} for a line range
     * and {@code multiple} when the reference named several selectors.
     *
     * @param text      the resolved text
     * @param reference the parsed reference
     * @param startLine the first line of the whole selection, 1-based
     * @param endLine   the last line of the whole selection, 1-based and inclusive
     * @param kind      {@code region}, {@code declaration}, {@code property}, {@code condition},
     *                  {@code anchor}, {@code lines} or {@code multiple}
     * @param ranges    one line range per selector, merged when they touch
     */
    public record Plan(String text, SectionReference reference, int startLine, int endLine,
                       String kind, List<Range> ranges) {

        public Plan {
            ranges = List.copyOf(ranges);
        }
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
     * Resolve a section reference to text, exposing the reference, its line ranges and any
     * contradiction warning.
     *
     * @param text      the target file's content
     * @param reference the {@code #} fragment content
     * @param lexer     the file type's lexer, or {@link BlockScanner#DEFAULT}
     * @throws SectionReferenceException the reference is malformed
     * @throws SectionError              the reference is well formed but matches nothing, or names a
     *                                   line the file does not have
     */
    public static Plan planSection(String text, String reference, BlockScanner.Lexer lexer) {
        SectionReference parsed = SectionReference.parse(reference);
        String source = text.replace("\r\n", "\n");
        BlockScanner.Scan scan = BlockScanner.scanBlocks(source, lexer);
        BlockScanner.Lex lex = scan.lex();
        Ctx ctx = new Ctx(lex.lines, lex.source, lex.starts, lex.lexer);

        List<Contribution> parts = new ArrayList<>();
        for (SectionReference.Selector selector : parsed.selectors()) {
            if (selector.isLines()) {
                // A line range is a raw slice of the file: no matcher is consulted, and anything the
                // file does not have is an error rather than a clamp.
                Slice picked = lineRangeSpan(lex, selector.from(), selector.to(), selector.text());
                parts.add(new Contribution(picked.text(), "lines", List.of(picked.range())));
                continue;
            }

            // Resolve every segment but the last to a container, retrying same-named candidates (a
            // Rust `struct Cart` beside its `impl Cart`), then take the final segment's first match in
            // walk order as the selection.
            Hit found = resolvePath(selector.segments(), 0, scan.root(), false, null, ctx);

            Rendered rendered;
            // `slice` is the area of the source the rendering was made from, which may be wider than
            // what the selector contributes: a region's rendering excludes the two directive lines, but
            // its `head` is read from the whole region. `range` is what the selector reports.
            Range slice;
            Range range;
            String kind;
            if (found.region() != null) {
                int from = found.region().startLine() + 1;
                slice = new Range(from, found.region().endLine() - 1);
                rendered = span(slice(lex.lines, from, found.region().endLine()), from,
                        found.region().endLine());
                range = new Range(rendered.from(), rendered.to());
                kind = "region";
            } else {
                rendered = renderBlock(found.block(), selector.scope(), ctx, found.kind());
                kind = found.kind();
                if ("condition".equals(found.kind())) {
                    // The header line the matcher cites is rendered ahead of the block's own first
                    // line; it is the first line of the slice.
                    slice = new Range(found.headerLine() + 1, lastDeclarationLine(found.block()) + 1);
                } else if ("anchor".equals(found.kind())) {
                    int anchorLine = found.block().anchor != null
                            ? found.block().anchor.line() : found.block().declLine;
                    slice = new Range(anchorLine + 1, lastDeclarationLine(found.block()) + 1);
                } else {
                    slice = new Range(rendered.from(), rendered.to());
                }
                range = slice;
            }

            // A rendering may prepend a line of its own invention — the `if` of a condition literal,
            // the brace line of a body that opens below its header — before the lines the span names,
            // so the span is only exact for the part of the text that matches the source; the lead is
            // the header line's own.
            String head = source.substring(lex.starts[slice.from() - 1],
                    offsetOf(lex, slice.to() + 1));
            int lead = rendered.text().startsWith(head) ? head.length() : 0;
            parts.add(new Contribution(rendered.text(), kind,
                    sliceRanges(range, rendered.text(), lead)));
        }

        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) {
                joined.append('\n');
            }
            joined.append(parts.get(i).text());
        }

        List<Range> ranges = new ArrayList<>();
        for (Contribution part : parts) {
            for (Range range : part.ranges()) {
                Range last = ranges.isEmpty() ? null : ranges.get(ranges.size() - 1);
                if (last != null && range.from() >= last.from() && range.from() <= last.to() + 1) {
                    ranges.set(ranges.size() - 1,
                            new Range(last.from(), Math.max(last.to(), range.to())));
                } else {
                    ranges.add(range);
                }
            }
        }
        int from = Integer.MAX_VALUE;
        int to = Integer.MIN_VALUE;
        for (Range range : ranges) {
            from = Math.min(from, range.from());
            to = Math.max(to, range.to());
        }

        return new Plan(joined.toString(), parsed,
                from == Integer.MAX_VALUE ? 1 : from,
                to == Integer.MIN_VALUE ? 1 : to,
                parts.size() == 1 ? parts.get(0).kind() : "multiple",
                ranges);
    }

    /** One selector's contribution to the plan: its text, its kind, and where it came from. */
    private record Contribution(String text, String kind, List<Range> ranges) {
    }

    /**
     * The offset line {@code line} (1-based) starts at. The Java {@code starts} array stops at the last
     * line, where the JavaScript one has one entry past the end, so a line past the last one is the end
     * of the file — which is exactly what a slice running to the last line wants.
     */
    private static int offsetOf(BlockScanner.Lex lex, int line) {
        if (line <= 0) {
            return 0;
        }
        if (line > lex.starts.length) {
            return lex.source.length();
        }
        return lex.starts[line - 1];
    }

    /** A line range's text and the line range it covers. */
    private record Slice(String text, Range range) {
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
    // Line ranges
    // ------------------------------------------------------------------

    /**
     * The lines a line-range selector names, as text and as a range.
     *
     * <p>Lines are counted from 1 and columns from 1, both inclusive. A column is a character offset
     * <em>within</em> its line: {@code L40:12} starts at the twelfth character of line 40, and the
     * range runs to the end of its last line unless the other endpoint names a column too. Anything
     * the file does not have is an error rather than a clamp — a range that silently became a
     * different range is exactly the drift a reference to a line number is for.
     *
     * <p>Lengths are counted in UTF-16 code units, as the JavaScript {@code .length} does.
     */
    private static Slice lineRangeSpan(BlockScanner.Lex lex, SectionReference.LinePoint from,
                                       SectionReference.LinePoint to,
                                       String raw) {
        String source = lex.source;
        String[] lines = lex.lines;
        int[] starts = lex.starts;
        int fromLine = from.line();
        SectionReference.LinePoint last = to != null ? to : from;
        int toLine = last.line();

        // `lines` is split on `\n`, so a file ending in a newline has a final empty entry: the file's
        // last line is the last entry that is not that emptiness.
        int total = source.isEmpty() ? 0 : lines.length;
        if (fromLine > total || toLine > total) {
            throw new SectionError("\"#" + raw + "\": the file has " + total + " line(s)");
        }
        if (from.column() != null && from.column() - 1 >= lines[fromLine - 1].length()) {
            throw new SectionError("\"#" + raw + "\": line " + fromLine + " has "
                    + lines[fromLine - 1].length() + " character(s)");
        }

        int start = starts[fromLine - 1] + (from.column() == null ? 0 : from.column() - 1);
        int end;
        if (to != null && to.column() != null) {
            if (to.column() - 1 >= lines[toLine - 1].length()) {
                throw new SectionError("\"#" + raw + "\": line " + toLine + " has "
                        + lines[toLine - 1].length() + " character(s)");
            }
            // Both columns are inclusive, so the slice runs one past the character the second column
            // names.
            end = starts[toLine - 1] + to.column();
        } else {
            end = Masker.endOfLine(source, starts[toLine - 1]);
        }

        return new Slice(source.substring(start, end), new Range(fromLine, toLine));
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
            return span(trimmed, firstLine, Masker.lineOf(ctx.starts, block.close));
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
        // A matched declaration may have no body at all — an interface method, a wrapped header whose
        // `;` ends it, a SQL `CREATE TABLE` the lexer declares. The JavaScript leaves `endLine` and
        // `closeLine` null there and slices an empty range around the declaration line, which is what
        // the two branches below reproduce.
        // An expression body carries the line its expression ends on; every other shape carries the
        // line its body closes on.
        Integer endLine = range.expressionEndLine != null ? range.expressionEndLine
                : range.endLine != null ? range.endLine : range.closeLine;
        if (scope == Scope.BODY) {
            if (endLine == null) {
                // `openLine === endLine` is `null === null` in the JavaScript, and the slice
                // `source.slice(open + 1, close)` is empty, so the body is the empty string.
                return single("", 0);
            }
            if (Boolean.TRUE.equals(range.singleLine)) {
                return span(slice(lines, range.declLine, endLine + 1), range.declLine, endLine + 1);
            }
            if (range.indented) {
                // A wrapped header's lines belong to the declaration, not the body, so the body starts
                // after the last of them.
                int first = range.bodyFrom == null ? range.declLine + 1 : range.bodyFrom;
                return span(slice(lines, first, endLine + 1), first, endLine + 1);
            }
            if (range.expression != null) {
                int at = Masker.lineOf(starts, range.expression);
                // The expression may be a block, whose lines the declaration's own indentation
                // governs (`main = do` then an indented body).
                int last = range.expressionEndLine == null ? at : range.expressionEndLine;
                if (last > at) {
                    return span(slice(lines, at, last + 1), at, last + 1);
                }
                return single(source.substring(range.expression,
                        Masker.endOfLine(source, range.expression)).trim(), at);
            }
            if (range.openLine == endLine) {
                return single(source.substring(range.open + 1, range.close).trim(), range.openLine);
            }
            return span(slice(lines, range.openLine + 1, endLine), range.openLine + 1,
                    endLine);
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
        if (endLine == null) {
            // The JavaScript slices `lines.slice(start, null + 1)` — an empty range — and reports the
            // span where the declaration would have started.
            return span(slice(lines, start, 1), start, start);
        }
        return span(slice(lines, start, endLine + 1), start, endLine + 1);
    }

    /** The last line of a block's declaration, for the spans a condition or an anchor reports. */
    private static int lastDeclarationLine(BlockScanner.Block block) {
        if (block.endLine != null) {
            return block.endLine;
        }
        if (block.closeLine != null) {
            return block.closeLine;
        }
        return block.declLine;
    }

    /**
     * Where one rendered slice came from: its line range, and how much of the slice's own text belongs
     * to it.
     *
     * <p>A slice is one line range in almost every case, and {@code lead} is what makes it more than
     * one: a rendering may <em>prepend</em> a line of its own invention (the {@code if} of a condition
     * literal, the header of a chain segment) before the lines the reference names, and then the lead
     * belongs to the header line and the rest to the lines that follow.
     *
     * @param range the slice's own bounds, 1-based inclusive
     * @param text  the rendered text
     * @param lead  how many of {@code text}'s characters precede {@code range}
     * @return the line ranges this slice covers
     */
    private static List<Range> sliceRanges(Range range, String text, int lead) {
        if (lead <= 0 || lead >= text.length()) {
            return List.of(range);
        }
        String rest = text.substring(lead);
        int linesTaken = splitCount(rest, '\n');
        return List.of(
                new Range(range.from(), range.from()),
                new Range(Math.max(range.from() + 1, range.to() - linesTaken + 1), range.to()));
    }

    /** JavaScript's {@code text.split('\n').length}: the number of pieces, at least one. */
    private static int splitCount(String text, char separator) {
        int count = 1;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == separator) {
                count++;
            }
        }
        return count;
    }

    /**
     * A rendered section from the already-sliced lines: the text (the JS {@code span} joins exactly what
     * it is handed) and the <b>1-based inclusive</b> line range it came from.
     *
     * <p>{@code from} and {@code to} are the slice's own bounds, exactly as they were handed to
     * {@link #slice(String[], int, int)} — 0-based, and {@code to} one past the last line. So the range
     * runs from {@code from + 1} to {@code to}, and an empty slice (an inverted range) names the line
     * the section would start on rather than a range that runs backwards.
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
}
