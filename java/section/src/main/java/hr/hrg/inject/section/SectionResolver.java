package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
     * What a reference resolved to: the section's text, the parsed reference, the <b>1-based
     * inclusive</b> line ranges the text came from, the outermost bounds of
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
     * Resolve a section reference to text, exposing the reference and its line ranges.
     *
     * <p>A reference carrying envelope marks is resolved <b>as a unit</b> before any selector is
     * rendered: the marks name one block, the candidate that holds what sits between them is the one
     * meant, and the selectors between the marks are read inside it rather than from the file.
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

        // An envelope is resolved first, and as a unit: the parent it names may be a name several
        // blocks answer to (a Rust type with three `impl`s), and which one is meant is decided by what
        // the marks wrap — the candidate that holds the member. That is the same retry a path uses, one
        // level up, so it is done once for the whole reference rather than per selector.
        Envelope envelope = resolveEnvelope(parsed.selectors(), scan, ctx);

        List<Contribution> parts = new ArrayList<>();
        for (SectionReference.Selector selector : parsed.selectors()) {
            if (selector.isLines()) {
                // A line range is a raw slice of the file: no matcher is consulted, and anything the
                // file does not have is an error rather than a clamp.
                Slice picked = lineRangeSpan(lex, selector.from(), selector.to(), selector.text());
                parts.add(new Contribution(picked.text(), "lines", List.of(picked.range())));
                continue;
            }

            // A parent's own opening or closing lines, taken verbatim around whatever sits between
            // the marks.
            if (selector.envelope() != null) {
                parts.add(envelope.parts().get(selector));
                continue;
            }

            BlockScanner.Block scope = envelope == null ? null : envelope.scopes().get(selector);
            parts.add(selectorPart(selector, scope == null ? scan.root() : scope, scan, ctx));
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
     * A reference's envelope, resolved as a unit: the pieces the two marks contribute, and the block
     * every selector between them is read inside.
     *
     * <p>It is resolved before any selector is rendered because which block the marks open and close is
     * decided by what they wrap, not by the parent's name alone: a Rust type is a {@code struct} beside
     * one or more {@code impl}s, all answering to the same name, and the member between the marks
     * chooses. The maps are keyed by the selector the parsed reference holds, so a mark finds its own
     * piece and an interior selector finds the block it resolved in.
     *
     * @param parts  the {@code ^} and {@code $} pieces, per mark
     * @param scopes the block each selector between the marks is read inside
     */
    private record Envelope(Map<SectionReference.Selector, Contribution> parts,
                            Map<SectionReference.Selector, BlockScanner.Block> scopes) {
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
     * Resolve one path selector inside {@code scope} into its text and ranges.
     *
     * <p>Every segment but the last is a container to descend into, retrying same-named candidates (a
     * Rust {@code struct Cart} beside its {@code impl Cart}); the last segment's first match in walk
     * order is the selection. The scope is the whole file for an ordinary selector, and the block an
     * envelope names for a selector written between its marks.
     */
    private static Contribution selectorPart(SectionReference.Selector selector,
                                             BlockScanner.Block scope, BlockScanner.Scan scan,
                                             Ctx ctx) {
        BlockScanner.Lex lex = scan.lex();
        String source = lex.source;
        Hit found;
        try {
            found = scope == scan.root()
                    ? resolvePath(selector.segments(), 0, scope, false, null, ctx)
                    : resolveWithin(scope, selector.segments(), ctx);
        } catch (SectionError error) {
            // Inside an envelope the parent is already chosen, so a failure here is the reference's
            // own: keep the failure's own diagnosis (its code, its candidates) and add the selector it
            // happened in — a bare rethrow would lose the fields a host branches on.
            if (scope == scan.root()) {
                throw error;
            }
            throw new SectionError(error.getMessage(), error.code(), selector.text(), scope.name(),
                    error.candidates());
        }

        Rendered rendered;
        // `slice` is the area of the source the rendering was made from, which may be wider than what
        // the selector contributes: a region's rendering excludes the two directive lines, but its
        // `head` is read from the whole region. `range` is what the selector reports.
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
                // The header line the matcher cites is rendered ahead of the block's own first line;
                // it is the first line of the slice.
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

        // A rendering may prepend a line of its own invention — the `if` of a condition literal, the
        // brace line of a body that opens below its header — before the lines the span names, so the
        // span is only exact for the part of the text that matches the source; the lead is the header
        // line's own.
        String head = source.substring(lex.starts[slice.from() - 1], offsetOf(lex, slice.to() + 1));
        int lead = rendered.text().startsWith(head) ? head.length() : 0;
        return new Contribution(rendered.text(), kind, sliceRanges(range, rendered.text(), lead));
    }

    /**
     * Resolve a path whose <b>first</b> segment is a member of {@code block}, exactly as
     * {@code Cart/add} resolves inside {@code Cart}: the rest of the path is searched in that block and
     * nothing else is considered.
     */
    private static Hit resolveWithin(BlockScanner.Block block, List<String> segments, Ctx ctx) {
        if (segments.size() == 1) {
            List<Hit> candidates = matchSegment(block, segments.get(0), true);
            if (candidates.isEmpty()) {
                throw new SectionError("no section named \"" + segments.get(0) + "\" in \""
                        + block.name + "\"", ErrorCodes.NOT_FOUND, segments.get(0), block.name);
            }
            if (candidates.size() > 1) {
                throw ambiguous(segments.get(0), candidates.size(), block, candidates);
            }
            return candidates.get(0);
        }
        return resolvePath(segments, 1, block, true, block.name, ctx);
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
                    "\"" + name + "\" is declared " + chosen.size() + " times; names must be unique",
                    ErrorCodes.AMBIGUOUS, name, null, blockCandidates(chosen));
        }
        // The same renderer the resolver uses, so the two entry points cannot disagree about what a
        // declaration's text is — a property reads its own statement here rather than going through the
        // body-less declaration path.
        return renderBlock(chosen.get(0), scope, new Ctx(lex.lines, lex.source, lex.starts, lex.lexer), "text")
                .text();
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
                || block.openLine != null
                // A property — a field, and an enum's constant — is a selection even with no body at all: the
                // statement (or the constant) *is* what is injected, which is why `planSection` has always
                // resolved one. Extraction used to skip them, which made the two entry points disagree
                // (2026-10-13).
                || "property".equals(block.kind);
    }

    /**
     * The deepest prefix of a path that still resolves, with the line it starts on — the first rung of
     * the best-effort ladder a <em>navigating</em> host climbs
     * ({@code doc/rfc/code-jump.md} §4.3). This is {@code deepestResolvablePrefix} in
     * {@code lib/section.mjs}, and the two answer identically.
     *
     * <p>A host asks for it when the whole reference failed and the reader would rather land on the
     * enclosing thing they can see: for {@code Cart/Line/render}, try {@code Cart/Line}, then
     * {@code Cart}, and take the first that answers. It <b>probes, it does not guess</b>: every
     * candidate is a prefix of the reference the user wrote, longest first, and the answer is the line
     * that prefix actually resolves to. The policy — whether to use the answer, and what to call it —
     * belongs to the host, which is why this is a probe and not a fallback.
     *
     * <p>Three facts a caller has to know, because they are the function's contract rather than
     * accidents of it:
     *
     * <ul>
     *   <li><b>Strictly shorter.</b> The walk starts one segment below what was written, so a
     *       one-segment path has no prefix to try and the answer is {@code null} — even when that
     *       path <em>does</em> resolve. A caller asks after a failed resolve
     *       ({@code doc/rfc/code-jump.md} §4.3, rung 1), where the deepest prefix cannot be the
     *       reference itself.</li>
     *   <li><b>Only the first selector.</b> The path walked is the first selector's, and a reference
     *       whose first selector is a line range, or is not a path at all, has no prefix to offer. A
     *       later selector's failure does not make an earlier one approximate.</li>
     *   <li><b>Nothing throws.</b> A malformed reference has no prefix, rather than an error: the
     *       probe exists to be asked about references that do not resolve, and a prefix that fails is
     *       simply not the answer.</li>
     * </ul>
     *
     * @param text      the target file's content
     * @param reference the {@code #} fragment content
     * @return the longest prefix of the first path selector that resolves, or {@code null} when none
     *         does
     */
    public static Prefix deepestResolvablePrefix(String text, String reference) {
        return deepestResolvablePrefix(text, reference, BlockScanner.DEFAULT);
    }

    /**
     * The deepest prefix that resolves, with the file type's lexer.
     *
     * @param text      the target file's content
     * @param reference the {@code #} fragment content
     * @param lexer     the file type's lexer, or {@link BlockScanner#DEFAULT}
     * @return the longest prefix of the first path selector that resolves, or {@code null} when none
     *         does
     */
    public static Prefix deepestResolvablePrefix(String text, String reference,
                                                 BlockScanner.Lexer lexer) {
        SectionReference parsed;
        try {
            parsed = SectionReference.parse(reference);
        } catch (SectionReferenceException malformed) {
            return null;
        }
        if (parsed.selectors().isEmpty()) {
            return null;
        }
        SectionReference.Selector first = parsed.selectors().get(0);
        if (!SectionReference.Selector.PATH.equals(first.kind())) {
            return null;
        }

        // Longest first, and never the whole path: the rung this serves is the one *below* a resolve.
        List<String> segments = first.segments();
        for (int depth = segments.size() - 1; depth >= 1; depth--) {
            String prefix = String.join("/", segments.subList(0, depth));
            Plan plan;
            try {
                plan = planSection(text, prefix, lexer);
            } catch (SectionError | SectionReferenceException notThisPrefix) {
                // A prefix that does not resolve is not the answer, and neither is one that is itself
                // malformed: the walk simply tries a shorter prefix. Nothing here throws.
                continue;
            }
            return new Prefix(prefix, plan.startLine(), List.copyOf(segments.subList(0, depth)));
        }
        return null;
    }

    /**
     * What {@link #deepestResolvablePrefix} found: the prefix that resolves, the line it starts on,
     * and its segments.
     *
     * <p>It is the Java counterpart of the object {@code deepestResolvablePrefix} returns in
     * {@code lib/section.mjs}, field for field, and it carries the <b>segments</b> as well as the
     * reference because the two are not the same text: a prefix is spelled by joining the segments,
     * which is how a host that wants to descend one more level builds the reference it writes next.
     *
     * @param reference the prefix as a reference — the segments joined with {@code /}
     * @param firstLine the prefix's first line, 1-based, exactly as a {@link Plan}'s
     *                  {@link Plan#startLine()} reports it
     * @param segments  the prefix's path segments, in order
     */
    public record Prefix(String reference, int firstLine, List<String> segments) {

        public Prefix {
            segments = List.copyOf(segments);
        }
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
            throw new SectionError("\"#" + raw + "\": the file has " + total + " line(s)",
                    ErrorCodes.LINE_RANGE_PAST_END, raw);
        }
        if (from.column() != null && from.column() - 1 >= lines[fromLine - 1].length()) {
            throw new SectionError("\"#" + raw + "\": line " + fromLine + " has "
                    + lines[fromLine - 1].length() + " character(s)",
                    ErrorCodes.LINE_RANGE_COLUMN_PAST_END, raw);
        }

        int start = starts[fromLine - 1] + (from.column() == null ? 0 : from.column() - 1);
        int end;
        if (to != null && to.column() != null) {
            if (to.column() - 1 >= lines[toLine - 1].length()) {
                throw new SectionError("\"#" + raw + "\": line " + toLine + " has "
                        + lines[toLine - 1].length() + " character(s)",
                        ErrorCodes.LINE_RANGE_COLUMN_PAST_END, raw);
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
     * Resolve {@code segments[index..]} starting at {@code scope}.
     *
     * <p>A name declared more than once at one level is <b>ambiguous</b>, and ambiguity is an error,
     * never a guess: {@code #add} must not inject the first of two {@code add}s, and {@code #Cart}
     * must not inject the {@code struct} when an {@code impl Cart} sits beside it.
     *
     * <p>What is <i>not</i> ambiguity is a name that several blocks share where the rest of the path
     * decides: a Rust {@code struct Cart} beside its {@code impl Cart} blocks all answer to
     * {@code Cart}, and {@code Cart/add} is resolved by retrying them in walk order — the one that
     * holds {@code add} wins. Only a last segment, or a set of candidates whose descents <i>all</i>
     * succeed, is ambiguous.
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
                        + segment + "\"", ErrorCodes.NOT_FOUND, segment, "<file>");
            }
            throw new SectionError("no section named \"" + segment + "\" in \""
                    + (prevName == null ? "" : prevName) + "\"", ErrorCodes.NOT_FOUND, segment,
                    prevName == null ? "<file>" : prevName);
        }

        // The selection itself: nothing follows, so a second candidate is a second answer and the
        // reference does not say which one it wants.
        if (last && candidates.size() > 1) {
            throw ambiguous(segment, candidates.size(), scope, candidates);
        }

        SectionError failure = null;
        Hit matched = null;
        for (Hit candidate : candidates) {
            if (last) {
                return candidate;
            }
            if (candidate.region() != null || !isContainer(candidate.block())) {
                if (failure == null) {
                    failure = new SectionError("\"" + segment + "\" is not a container",
                            ErrorCodes.NOT_A_CONTAINER, segment, scope.name());
                }
                continue;
            }
            Hit resolved;
            try {
                resolved = resolvePath(segments, index + 1, candidate.block(), true, segment, ctx);
            } catch (SectionError error) {
                if (failure == null) {
                    failure = error;
                }
                continue;
            }
            // Two candidates both holding the rest of the path is the same ambiguity one level down:
            // the path does not choose between them. Decided after the catch, because the error
            // belongs to this frame, not that one.
            if (matched != null) {
                throw ambiguous(segment, candidates.size(), scope, candidates);
            }
            matched = resolved;
        }
        if (matched != null) {
            return matched;
        }
        throw failure;
    }

    /** The error for a name that two blocks at one level answer to. */
    private static SectionError ambiguous(String segment, int count, BlockScanner.Block scope,
                                          List<Hit> candidates) {
        return new SectionError("\"" + segment + "\" is declared " + count
                + " times; names must be unique", ErrorCodes.AMBIGUOUS, segment, scope.name(),
                candidateInfo(candidates));
    }

    /** What a name answered to, as a resolution failure reports it: `candidateInfo` in the JavaScript. */
    private static List<SectionError.Candidate> candidateInfo(List<Hit> hits) {
        List<SectionError.Candidate> out = new ArrayList<>(hits.size());
        for (Hit hit : hits) {
            out.add(candidateOf(hit.block()));
        }
        return List.copyOf(out);
    }

    /** The same, for the blocks {@link #extractDeclaration} chose among. */
    private static List<SectionError.Candidate> blockCandidates(List<BlockScanner.Block> blocks) {
        List<SectionError.Candidate> out = new ArrayList<>(blocks.size());
        for (BlockScanner.Block block : blocks) {
            out.add(candidateOf(block));
        }
        return List.copyOf(out);
    }

    /** One block as the diagnosis reports it: its name, its kind and the lines it spans. */
    private static SectionError.Candidate candidateOf(BlockScanner.Block block) {
        return new SectionError.Candidate(block.name(), block.kind(), block.declLine(),
                block.closeLine() != null ? block.closeLine() : block.declLine());
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
                    + " times; region names must be unique", ErrorCodes.REGION_DUPLICATED, segment,
                    scope.name());
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
    // Envelopes
    // ------------------------------------------------------------------

    /**
     * Read a reference's envelope as a unit: which block the marks open and close, and the opening and
     * closing pieces for it.
     *
     * <p>Which block is meant is decided by what the marks <b>wrap</b>, not by the name — the same
     * retry a path uses one level up. A Rust type has a {@code struct} and one or more {@code impl}
     * blocks, all of them answering to the type's name, so {@code Cart/^,add,$} is the {@code impl}
     * that holds {@code add}; a type with a single declaration has one candidate and no retry at all.
     *
     * @param selectors every parsed selector, in written order
     * @param scan      the scan of the target file
     * @param ctx       the rendering context, for the probe that decides the candidate
     * @return the envelope, or {@code null} when the reference has none
     */
    private static Envelope resolveEnvelope(List<SectionReference.Selector> selectors,
                                            BlockScanner.Scan scan, Ctx ctx) {
        boolean any = false;
        for (SectionReference.Selector selector : selectors) {
            if (selector.envelope() != null) {
                any = true;
                break;
            }
        }
        if (!any) {
            return null;
        }

        SectionReference.Selector open = selectors.get(0);
        SectionReference.Selector close = selectors.get(selectors.size() - 1);
        List<String> parent = open.envelope().parent();

        // A one-segment parent is asked for *every* block it names, because the marks choose among
        // them: a Rust type is a `struct` beside one or more `impl`s, and the envelope is whichever one
        // holds the member. A path of several segments already decided, so there is one candidate.
        //
        // The region is kept beside the candidates rather than filtered out of them: a region is a
        // *match* that cannot be an envelope — it has no declaration to open or close — and reporting
        // it as "found nothing" would be a lie about what the file wrote.
        List<Hit> matched = null;
        List<BlockScanner.Block> blocks;
        if (parent.size() == 1) {
            matched = matchSegment(scan.root(), parent.get(0), false);
            blocks = new ArrayList<>();
            for (Hit hit : matched) {
                if (hit.region() == null) {
                    blocks.add(hit.block());
                }
            }
        } else {
            Hit found = resolvePath(parent, 0, scan.root(), false, null, ctx);
            if (found.region() != null) {
                throw new SectionError("\"#" + open.text()
                        + "\": a region has no declaration to open or close",
                        ErrorCodes.ENVELOPE_REGION, open.text());
            }
            blocks = List.of(found.block());
        }
        if (blocks.isEmpty()) {
            if (matched != null && matched.stream().anyMatch(hit -> hit.region() != null)) {
                throw new SectionError("\"#" + open.text()
                        + "\": a region has no declaration to open or close",
                        ErrorCodes.ENVELOPE_REGION, open.text());
            }
            throw new SectionError("no \"#region " + parent.get(0) + "\" found, and no section named \""
                    + parent.get(0) + "\"", ErrorCodes.REGION_NOT_FOUND, parent.get(0), null);
        }

        List<SectionReference.Selector> interior = selectors.subList(1, selectors.size() - 1);
        Map<SectionReference.Selector, Contribution> parts = new LinkedHashMap<>();
        Map<SectionReference.Selector, BlockScanner.Block> scopes = new LinkedHashMap<>();

        SectionError failure = null;
        for (BlockScanner.Block block : blocks) {
            if (!isContainer(block)) {
                continue;
            }
            SectionReference.Selector tried = null;
            try {
                // Every interior selector has to resolve inside this candidate, or this is not the
                // block the envelope is about.
                for (SectionReference.Selector selector : interior) {
                    if (selector.isLines()) {
                        continue;
                    }
                    tried = selector;
                    selectorPart(selector, block, scan, ctx);
                }
            } catch (SectionError error) {
                // One message, naming the selector as the *user* wrote it rather than the
                // parent-qualified spelling the envelope reads it as — with the diagnosis the failure
                // carried, since a host still branches on it.
                if (failure == null) {
                    failure = new SectionError(error.getMessage(), error.code(),
                            tried == null ? null : tried.text(), String.join("/", parent),
                            error.candidates());
                }
                continue;
            }
            for (SectionReference.Selector selector : List.of(open, close)) {
                parts.put(selector, envelopePart(selector, scan, block));
                scopes.put(selector, block);
            }
            for (SectionReference.Selector selector : interior) {
                scopes.put(selector, block);
            }
            return new Envelope(parts, scopes);
        }
        if (failure != null) {
            throw failure;
        }
        throw new SectionError("\"" + String.join(",", parent) + "\" is not a container",
                ErrorCodes.NOT_A_CONTAINER, String.join("/", parent), null);
    }

    /**
     * Resolve one envelope selector: the first lines of the block its path names, or the last one.
     *
     * <p>The lines are taken verbatim, because that is what the envelope is <em>for</em>: a method
     * copied out of a class reads as a fragment, and the declaration that holds it is what makes it
     * read as code. The head is the declaration's <b>opening lines</b> — where the name is written,
     * through the line its body opens on, so a wrapped signature comes whole — and the tail is the
     * block's <b>closing line</b>. Each is a piece of its own, so a member selected between them is a
     * third: the three are disjoint, which is what lets a host point at the declaration, the member and
     * the end of the block separately instead of at everything between them.
     */
    private static Contribution envelopePart(SectionReference.Selector selector,
                                             BlockScanner.Scan scan, BlockScanner.Block block) {
        String[] lines = scan.lex().lines;
        boolean isHead = selector.envelope().isHead();
        int to = isHead
                ? Math.min(block.openLine != null ? block.openLine : block.declLine,
                        lastDeclarationLine(block))
                : lastDeclarationLine(block);
        int from = isHead ? block.declLine : to;
        // The text is exactly the range: a tail is the closing line and not the block it closes, and
        // the caller rebuilds nothing for an envelope.
        return new Contribution(String.join("\n", slice(lines, from, to + 1)), "envelope",
                List.of(new Range(from + 1, to + 1)));
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
            // The whole statement, from the line its name is written on through the line its `;` is on
            // — which is a later line for a lambda or an array initialiser, and the same line for a
            // plain field.
            int last = block.lineEnd == null || block.lineEnd < block.declLine
                    ? block.declLine : block.lineEnd;
            if (scope == Scope.BODY) {
                // An enum constant's "body" is what follows its name — the arguments it is built with, and the
                // body it declares — because that is the part of a constant that is not its name (2026-10-13).
                if (Boolean.TRUE.equals(block.enumConstant)) {
                    Integer from = block.nameEnd;
                    if (from == null || block.statementTo == null || from >= block.statementTo) {
                        return single("", block.declLine);
                    }
                    return trimmedSlice(ctx.source, ctx.starts, from, block.statementTo);
                }
                // `-` selects the initialiser expression: the bytes between the `=` that opens it and
                // the `;` that ends the statement. A member with no initialiser has an empty body,
                // reported on its own line.
                Integer equalsAt = block.equalsAt;
                Integer statementTo = block.statementTo;
                if (equalsAt == null || statementTo == null || equalsAt >= statementTo) {
                    return single("", block.declLine);
                }
                return trimmedSlice(ctx.source, ctx.starts, equalsAt + 1, statementTo);
            }
            // The statement's own last line is what the `+`/`++` scopes extend from, so a field takes
            // its `@Annotation` and its doc comment exactly as a method does — a field is a
            // declaration too, and the annotation above it belongs to it.
            block.endLine = last;
            return renderDeclaration(ctx.lines, ctx.source, ctx.starts, block, scope,
                    line -> ctx.lexer.isAnnotationLine(line));
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

    /**
     * The bytes strictly between two offsets of {@code source}, trimmed, with the line range the
     * trimmed text still covers — the JavaScript's {@code trimmedSlice}.
     *
     * <p>A slice that is trimmed has to answer for the lines the trim removed: a click on a body
     * belongs to its first real line, not to the blank line above it, and a slice that trims to
     * nothing still reports the line it would have started on rather than a range that runs backwards.
     */
    private static Rendered trimmedSlice(String source, int[] starts, int from, int to) {
        String raw = source.substring(Math.min(from, source.length()), Math.min(Math.max(from, to), source.length()));
        String text = raw.trim();
        int at = Masker.lineOf(starts, Math.min(from, source.length()));
        if (text.isEmpty()) {
            return new Rendered(text, at + 1, at + 1);
        }
        int skipped = raw.length() - raw.stripLeading().length();
        int dropped = raw.length() - raw.stripTrailing().length();
        int first = from + skipped;
        int last = Math.max(first, from + raw.length() - dropped - 1);
        return new Rendered(text, Masker.lineOf(starts, first) + 1, Masker.lineOf(starts, last) + 1);
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
