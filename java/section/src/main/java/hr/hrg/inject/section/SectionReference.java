package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * A parsed section reference: the text after the {@code #} in a marker's fragment.
 *
 * <p>This is the Java counterpart of the object {@code parseSelectors} returns in
 * {@code lib/section.mjs}, and of the {@code Reference} type in {@code rust/section}. The three are
 * meant to be read side by side; the field names are the JavaScript ones.
 *
 * <p>A reference is <b>one or more selectors separated by {@code ,}</b>, each of which is either a
 * semantic path ({@code Cart/Line/render-}) or a line range ({@code L40:12-L44:3}). The selectors are
 * kept in the order they were written, each with the scope its own spelling gives it and the
 * <em>text</em> it was written with, which is what the canonical spelling preserves. A reference of
 * one path selector is the degenerate case of that list, and every field the single-reference
 * grammar ever had still holds for it: {@link #segments()} and {@link #scope()}.
 *
 * <p>Parsing normalises before it parses, because the canonical spelling is trailing: a prefix of the
 * whole reference ({@code +add}, {@code ++a/b}, {@code -a/b}) and a single {@code -} leading the last
 * segment ({@code a/-b}, or {@code Cart/-Line}) are moved to the end. Two things about that are easy
 * to get wrong, and the vectors pin both:
 *
 * <ul>
 *   <li>The two leading forms are <b>not symmetric</b>. {@code -} may lead a segment when that
 *       segment is the last one, or the second of two; {@code +} and {@code ++} may appear in front
 *       only as the detached prefix of the whole reference, so {@code a/-b} is legal and
 *       {@code a/+b} is an error even though that segment <em>is</em> last.</li>
 *   <li>A modifier written mid-path is <b>collected, not rejected</b>: {@code a++/b} parses and means
 *       {@code a/b++}, because every modifier run the parser finds is applied to the last segment.
 *       That is laxer than the canonical form and the vectors do not cover it — see
 *       {@code doc/section-matching.md}, "Where a modifier may appear".</li>
 * </ul>
 *
 * <p>The reference's own modifier — the leading run of the whole reference and the trailing run of
 * the last selector — applies to the <b>last</b> selector, exactly as it applied to the last path
 * segment before. A modifier written on an earlier selector's own path is that selector's and nobody
 * else's, so {@code add-,render++} is two selectors that each say what they mean but
 * {@code getUsers++-} is two readings on one selector: {@code +}/{@code ++} wins with a
 * contradiction warning (canonical {@code getUsers++}). The same modifier twice ({@code a+++},
 * {@code a---}, {@code -a-}) is an error, "carries more than one modifier".
 *
 * @param raw       the text as it was given, without the {@code #}
 * @param canonical the normalised spelling, e.g. {@code Cart/Line/render-} or {@code add,L40-L44}
 * @param selectors the selectors, in the order written
 * @param segments  the last path selector's segments, or an empty list when the reference is a line
 *                  range (or a list whose last selector is one)
 * @param scope     the last path selector's scope, {@link Scope#DECLARATION} when there is none
 * @param warning   the contradiction warning, or {@code null}
 */
public record SectionReference(String raw, String canonical, List<Selector> selectors,
                               List<String> segments, Scope scope, Warning warning) {

    /** The most segments a path selector may have. */
    public static final int MAX_SEGMENTS = 8;

    public SectionReference {
        selectors = List.copyOf(selectors);
        segments = List.copyOf(segments);
    }

    /**
     * One selector of a reference: a semantic path, resolved by the matcher precedence and the
     * sibling-first walk, or an explicit line range, which selects verbatim lines and consults no
     * matcher.
     *
     * <p>{@code text} is the selector as it was written — the spelling the canonical form keeps for
     * every selector but the last — and is also the name a line-range error message quotes. A path
     * selector carries its own {@code segments} and the {@code scope} its spelling asks for (which
     * includes the reference's own modifier when it is the last selector); a line-range selector
     * carries its endpoints instead.
     *
     * @param kind     {@code path}, or {@code lines} for a line range
     * @param text     the selector as written, trimmed
     * @param segments the path segments, empty for a line range
     * @param scope    how much of the match the selector asks for; meaningless for a line range
     * @param from     a line range's first endpoint, {@code null} for a path selector
     * @param to       a line range's last endpoint, {@code null} for a path selector or for a range
     *                 written as a single point
     */
    public record Selector(String kind, String text, List<String> segments, Scope scope,
                           LinePoint from, LinePoint to) {

        /** The kind of a semantic-path selector. */
        public static final String PATH = "path";

        /** The kind of a line-range selector. */
        public static final String LINES = "lines";

        public Selector {
            segments = List.copyOf(segments);
        }

        static Selector path(String text, List<String> segments, Scope scope) {
            return new Selector(PATH, text, segments, scope, null, null);
        }

        static Selector lines(String text, LinePoint from, LinePoint to) {
            return new Selector(LINES, text, List.of(), Scope.DECLARATION, from, to);
        }

        /** Whether this selector is a line range rather than a semantic path. */
        public boolean isLines() {
            return LINES.equals(kind);
        }
    }

    /**
     * One endpoint of a line range: a 1-based line, and a 1-based column within it, or {@code null}
     * for the whole line.
     *
     * @param line   the line number, counted from 1
     * @param column the column, counted from 1, inclusive; {@code null} means the whole line
     */
    public record LinePoint(int line, Integer column) {
    }

    /** Whether the reference is one path selector with exactly one segment. */
    public boolean isSingleSegment() {
        return segments.size() == 1;
    }

    /** The segment that selects content; the earlier ones only narrow the scope, and a line range has none. */
    public String finalSegment() {
        return segments.isEmpty() ? "" : segments.get(segments.size() - 1);
    }

    /** The contradiction warning, when the reference carried one. */
    public Optional<Warning> warningIfAny() {
        return Optional.ofNullable(warning);
    }

    /** Whether the reference is a single line range, which consults no matcher at all. */
    public boolean isLineRange() {
        return selectors.size() == 1 && selectors.get(0).isLines();
    }

    /**
     * Parses a section reference — the text after the {@code #}.
     *
     * <p>This is {@code parseSelectors}: the reference may name several selectors, and a selector may
     * be a line range. A single path selector parses to the same canonical spelling, the same
     * segments and the same scope it always has.
     *
     * @param raw the reference, without the {@code #}
     * @return the parsed reference
     * @throws SectionReferenceException when the reference is malformed: nothing named, an empty
     *                                   selector, an empty path segment, more than eight segments,
     *                                   more than one modifier, a modifier where it may not go, or a
     *                                   malformed line range. The message is part of the contract.
     */
    public static SectionReference parse(String raw) {
        if (raw == null || raw.isEmpty()) {
            throw new SectionReferenceException("\"#\" names nothing");
        }

        Leading leading = detachLeadingModifier(raw);
        if (leading.name().isEmpty()) {
            throw new SectionReferenceException("\"#" + raw + "\" names nothing");
        }

        List<String> parts = split(leading.name(), ',');
        for (String part : parts) {
            if (part.trim().isEmpty()) {
                throw new SectionReferenceException("\"#" + raw + "\" has an empty selector");
            }
        }
        int lastPart = parts.size() - 1;

        // The reference's own modifier: the leading one, the trailing one, or both. It is collected
        // separately from a selector's own run because only it can reach the last selector's path
        // (`-a/b` is `a/b-`), and a leading run belongs to the reference rather than to the selector it
        // was written in front of (`-a,b,c` is `a,b,c-`).
        List<String> referenceModifiers = new ArrayList<>();
        if (leading.modifier() != null) {
            referenceModifiers.add(leading.modifier());
        }

        // The trailing run of the last selector is the reference's own, because a modifier has always
        // been canonicalised to the very end of the reference. For a path the run is taken both from
        // the selector as written *and* from the path it parses to, so a run written further up the
        // path (`a-/b++`) is still part of the reference's modifier. A line range is read first and
        // on its own: `lineRangeOf` rejects the ranges that only look like one, and a range takes no
        // modifier at all.
        String lastText = parts.get(lastPart).trim();
        if (lineRangeOf(lastText) == null) {
            Trailing written = extractTrailingModifier(lastText);
            SectionReference parsedLast = startsLikeAName(written.name())
                    ? parsePath(written.name()) : null;
            String suffix = parsedLast != null && !parsedLast.segments().isEmpty()
                    ? parsedLast.canonical().substring(String.join("/", parsedLast.segments()).length())
                    : "";
            referenceModifiers.addAll(written.tokens());
            referenceModifiers.addAll(tokenizeModifierRun(suffix));
        }

        Merged modifier = mergeModifiers(referenceModifiers, raw);

        List<Selector> selectors = new ArrayList<>();
        for (int index = 0; index < parts.size(); index++) {
            String trimmed = parts.get(index).trim();

            // A selector that opens `L<digit>` is a line range, and is read as one before anything is
            // stripped from it: a range takes no modifier at all.
            if (index == lastPart || LINE_RANGE_PREFIX.matcher(trimmed).find()) {
                LineRange range = lineRangeOf(index == lastPart ? lastText : trimmed);
                if (range != null) {
                    selectors.add(Selector.lines(trimmed, range.from(), range.to()));
                    continue;
                }
            }

            // The last selector is read without the runs that are the reference's own, so the
            // reference's modifier and the selector's are compared rather than counted twice.
            String text = index == lastPart ? extractTrailingModifier(trimmed).name() : trimmed;

            // A path is a name. What cannot even open a name — `@x` — names nothing; anything else is
            // read by the single-selector grammar, whose own errors (`/a` has an empty path segment,
            // `a/+b` is a misplaced modifier) quote the selector and are the ones a user needs to see.
            if (!startsLikeANamePath(text)) {
                throw new SectionReferenceException("\"#" + text + "\" names nothing");
            }
            SectionReference parsed = parsePath(text);
            // The reference's own modifier applies to the last selector, as it has always applied to
            // the last path segment; every earlier selector keeps the scope its own spelling gave it.
            Scope scope = index == lastPart && modifier.modifier() != null
                    ? Scope.fromModifier(modifier.spelling())
                    : parsed.scope();
            selectors.add(Selector.path(text, parsed.segments(), scope));
        }

        // Every selector but the last keeps the spelling it was written with — its modifier included,
        // since that modifier belongs to that selector. The last one is spelled from its parsed path,
        // with the reference's own modifier appended, which is where a modifier has always been
        // canonicalised to.
        StringBuilder canonical = new StringBuilder();
        for (int index = 0; index < selectors.size(); index++) {
            if (index > 0) {
                canonical.append(',');
            }
            Selector selector = selectors.get(index);
            if (selector.isLines() || index < selectors.size() - 1) {
                canonical.append(selector.text());
            } else {
                canonical.append(String.join("/", selector.segments()));
            }
        }
        canonical.append(modifier.spelling());

        // A reference of one path selector carries a scope the resolver applies; in a mixed reference
        // the reference's modifier belongs to the last path selector, and a line range has no scope.
        Selector sole = selectors.size() == 1 ? selectors.get(0) : null;
        Scope scope = sole == null || sole.isLines()
                ? Scope.DECLARATION
                : modifier.modifier() != null ? Scope.fromModifier(modifier.spelling()) : sole.scope();

        Warning warning = modifier.warning() == null ? null
                : new Warning(Warning.KIND_CONTRADICTION, modifier.warning().kept(),
                        modifier.warning().dropped(), canonical.toString(),
                        "\"" + modifier.warning().kept() + "\" contradicts \""
                                + modifier.warning().dropped() + "\"; using \"#"
                                + canonical + "\"");

        return new SectionReference(raw, canonical.toString(), selectors,
                sole != null && !sole.isLines() ? sole.segments() : List.of(), scope, warning);
    }

    /**
     * Parses a <b>single path selector</b> — the grammar the reference had before it became a list.
     *
     * <p>This is {@code parseReference} in {@code lib/section.mjs}: everything it accepts parses with
     * {@link #parse(String)} to the same canonical spelling, the same segments and the same scope, but
     * it refuses what is not one path — a comma, or a line range — with the message the single
     * grammar uses.
     *
     * @param raw the selector, without the {@code #}
     * @return the parsed reference, whose {@link #selectors()} holds exactly one path selector
     * @throws SectionReferenceException when the text is malformed, or is not a single path selector
     */
    public static SectionReference parseReference(String raw) {
        if (raw == null || raw.isEmpty()) {
            throw new SectionReferenceException("\"#\" names nothing");
        }
        if (raw.indexOf(',') >= 0) {
            throw new SectionReferenceException("\"#" + raw + "\" has an empty selector");
        }
        if (LINE_RANGE_PREFIX.matcher(raw).find()) {
            lineRangeOf(raw);                   // throws when the spelling is malformed
            throw new SectionReferenceException("\"#" + raw + "\" is a line range, not a section path");
        }
        return parsePath(raw);
    }

    // ------------------------------------------------------------------
    // The single-path grammar
    // ------------------------------------------------------------------

    /** {@code parseReference}'s body: one path, no commas and no line ranges. */
    private static SectionReference parsePath(String raw) {
        String detached = null;
        String remainder = raw;
        if (raw.startsWith("++")) {
            detached = "++";
            remainder = raw.substring(2);
        } else if (raw.startsWith("+")) {
            detached = "+";
            remainder = raw.substring(1);
        } else if (raw.startsWith("-")) {
            detached = "-";
            remainder = raw.substring(1);
        }
        if (remainder.isEmpty()) {
            throw new SectionReferenceException("\"#" + raw + "\" names nothing");
        }

        List<String> parts = split(remainder, '/');
        for (String part : parts) {
            if (part.isEmpty()) {
                throw new SectionReferenceException("\"#" + raw + "\" has an empty path segment");
            }
        }
        if (parts.size() > MAX_SEGMENTS) {
            throw new SectionReferenceException("\"#" + raw + "\" is deeper than 8 sections");
        }

        // `Cart/-Line` is the two-segment spelling of `Cart/Line-`: the `-` belongs to the reference,
        // not to the name. It applies only to a two-segment path, and only when the first segment
        // carried no detached modifier of its own.
        String detachedSecond = null;
        if (detached == null && parts.size() == 2) {
            String second = parts.get(1);
            if (second.length() > 1 && second.charAt(0) == '-'
                    && second.charAt(1) != '-' && second.charAt(1) != '+') {
                detachedSecond = "-";
                parts.set(1, second.substring(1));
            }
        }

        List<String> modifiers = new ArrayList<>();
        List<String> cleanSegments = new ArrayList<>();

        for (int i = 0; i < parts.size(); i++) {
            boolean isLast = i == parts.size() - 1;

            Leading leading = extractLeadingModifier(parts.get(i), isLast, raw);
            if (leading.modifier() != null) {
                modifiers.add(leading.modifier());
            }
            Trailing trailing = extractTrailingModifier(leading.name());
            modifiers.addAll(trailing.tokens());
            String name = trailing.name();

            if (name.indexOf('+') >= 0 || name.indexOf('-') >= 0) {
                // A bare name keeps the legacy meaning: a single-segment name may contain a hyphen
                // (`update-document-test`), because declaration and anchor names do. Any `+`, or a
                // hyphen inside a multi-segment path, is structure rather than part of a name.
                boolean legacyBareName = parts.size() == 1
                        && detached == null
                        && detachedSecond == null
                        && name.indexOf('+') < 0;
                if (!legacyBareName) {
                    char character = name.indexOf('+') >= 0 ? '+' : '-';
                    throw new SectionReferenceException("\"" + character
                            + "\" may only modify the last path segment of \"#" + raw + "\"");
                }
            }

            cleanSegments.add(name);
        }

        for (String name : cleanSegments) {
            if (name.isEmpty()) {
                throw new SectionReferenceException("\"#" + raw + "\" has an empty path segment");
            }
        }

        if (detached != null) {
            modifiers.add(0, detached);
        }
        if (detachedSecond != null) {
            modifiers.add(0, detachedSecond);
        }

        Merged merged = mergeModifiers(modifiers, raw);
        String modifier = merged.modifier();
        String canonical = String.join("/", cleanSegments) + merged.spelling();

        Warning warning = null;
        if (merged.warning() != null) {
            warning = new Warning(Warning.KIND_CONTRADICTION, merged.warning().kept(),
                    merged.warning().dropped(), canonical,
                    "\"" + merged.warning().kept() + "\" contradicts \""
                            + merged.warning().dropped() + "\"; using \"#" + canonical + "\"");
        }

        // `segments` and `scope` are the whole reference's, because a single path selector is the
        // degenerate case of the list: the last path selector's path is the only one there is.
        List<Selector> selectors = List.of(
                Selector.path(String.join("/", cleanSegments) + merged.spelling(), cleanSegments,
                        Scope.fromModifier(modifier)));
        return new SectionReference(raw, canonical, selectors, cleanSegments,
                Scope.fromModifier(modifier), warning);
    }

    /**
     * Reads a modifier written <em>before</em> a segment's name.
     *
     * <p>The asymmetry is the contract's, not an oversight: {@code -} is allowed here only for the
     * last segment, while {@code +} and {@code ++} are rejected outright — they may appear in front
     * only as the whole reference's detached prefix. That is why {@code a/+b} is an error and
     * {@code a/-b} is not.
     */
    private static Leading extractLeadingModifier(String segment, boolean isLastSegment, String raw) {
        if (segment.length() <= 1) {
            return new Leading(null, segment);
        }

        char first = segment.charAt(0);
        if (first == '-') {
            char second = segment.charAt(1);
            if (second == '-' || second == '+') {
                return new Leading(null, segment);
            }
            if (isLastSegment) {
                return new Leading("-", segment.substring(1));
            }
            throw new SectionReferenceException(
                    "\"-\" may only modify the last path segment of \"#" + raw + "\"");
        }

        if (segment.startsWith("++")) {
            char third = segment.length() > 2 ? segment.charAt(2) : 0;
            if (third == '+' || third == '-') {
                return new Leading(null, segment);
            }
            throw new SectionReferenceException(
                    "\"++\" may only modify the last path segment of \"#" + raw + "\"");
        }

        if (first == '+') {
            char second = segment.charAt(1);
            if (second == '+' || second == '-') {
                return new Leading(null, segment);
            }
            throw new SectionReferenceException(
                    "\"+\" may only modify the last path segment of \"#" + raw + "\"");
        }

        return new Leading(null, segment);
    }

    /** Splits a segment into its name and the modifier run that trails it. */
    private static Trailing extractTrailingModifier(String name) {
        int i = name.length();
        while (i > 0 && (name.charAt(i - 1) == '+' || name.charAt(i - 1) == '-')) {
            i--;
        }
        if (i < name.length()) {
            return new Trailing(name.substring(0, i), tokenizeModifierRun(name.substring(i)));
        }
        return new Trailing(name, List.of());
    }

    /**
     * Splits a run of {@code +}/{@code -} into modifiers, longest match first, and stops at anything
     * else. {@code +++} is {@code ["++", "+"]}, which is two modifiers — and two positive ones is an
     * error, not a {@code ++} followed by an ignored {@code +}.
     */
    private static List<String> tokenizeModifierRun(String run) {
        List<String> tokens = new ArrayList<>();
        int i = 0;
        while (i < run.length()) {
            if (i + 1 < run.length() && run.charAt(i) == '+' && run.charAt(i + 1) == '+') {
                tokens.add("++");
                i += 2;
            } else if (run.charAt(i) == '+') {
                tokens.add("+");
                i += 1;
            } else if (run.charAt(i) == '-') {
                tokens.add("-");
                i += 1;
            } else {
                break;
            }
        }
        return tokens;
    }

    /** The longest prefix of {@code raw} that is a modifier run ({@code +}, {@code ++}, {@code -}). */
    private static Leading detachLeadingModifier(String raw) {
        if (raw.startsWith("++")) {
            return new Leading("++", raw.substring(2));
        }
        if (raw.startsWith("+")) {
            return new Leading("+", raw.substring(1));
        }
        if (raw.startsWith("-")) {
            return new Leading("-", raw.substring(1));
        }
        return new Leading(null, raw);
    }

    /**
     * Combines the modifier tokens one selector carries into the single modifier it has, or throws
     * when they cannot be combined.
     *
     * <p>{@code +} against {@code -} is the one contradiction: the reference asks for the declaration
     * <em>with</em> its annotations and for the <em>body</em> alone, and no section is both. That is
     * worth a warning rather than an error, because it is what a human types while refactoring — the
     * annotation reading wins, and the caller reports it once. The same modifier twice is malformed.
     *
     * @param modifiers the modifiers in the order they were written
     * @param raw       the reference as the user wrote it, for the messages
     */
    private static Merged mergeModifiers(List<String> modifiers, String raw) {
        if (modifiers.isEmpty()) {
            return new Merged(null, null);
        }
        if (modifiers.size() == 1) {
            return new Merged(modifiers.get(0), null);
        }

        long positive = modifiers.stream().filter(m -> m.startsWith("+")).count();
        long negative = modifiers.stream().filter(m -> m.startsWith("-")).count();
        if (positive > 1 || negative > 1) {
            throw new SectionReferenceException("\"#" + raw + "\" carries more than one modifier");
        }
        // One `+` and one `-`: the positive one wins, and the caller is told.
        String kept = modifiers.contains("++") ? "++" : "+";
        return new Merged(kept, new Warning(Warning.KIND_CONTRADICTION, kept, "-", null, null));
    }

    // ------------------------------------------------------------------
    // The line-range grammar
    // ------------------------------------------------------------------

    /** Does this selector at least begin like a line range ({@code L40})? */
    private static final java.util.regex.Pattern LINE_RANGE_PREFIX =
            java.util.regex.Pattern.compile("^L\\d");

    /** Does this selector at least begin like a name ({@code \w} or {@code $})? */
    private static boolean startsLikeAName(String text) {
        if (text.isEmpty()) {
            return false;
        }
        char first = text.charAt(0);
        return first == '$' || first == '_' || Character.isLetterOrDigit(first);
    }

    /** Can this text even open a name? {@code @x} cannot, and names nothing. */
    private static boolean startsLikeANamePath(String text) {
        if (text.isEmpty()) {
            return false;
        }
        char first = text.charAt(0);
        return first == '$' || first == '/' || first == '+' || first == '-'
                || first == '_' || Character.isLetterOrDigit(first);
    }

    /**
     * Read {@code raw} as a line-range selector, or return {@code null} when it is not one.
     *
     * <p>The accepted spellings are {@code L40} (one line), {@code L40:12} (from column 12 of that
     * line), {@code L40-L44} and {@code L40:12-L44:3}. An endpoint ending in {@code :} is deliberately
     * not accepted: it would mean "to the end of the line", which writing the point alone already
     * says.
     *
     * <p>Throws when the text claims to be a line range and is not one — {@code L40-}, {@code L40:x},
     * {@code L0}, {@code L5-L2}, and a range carrying a modifier ({@code L40-L44+}) — because a
     * reference that opens {@code L<digit>} is a line range or a typo, never a name. ({@code Lx} is
     * still a name: it does not open with a digit, so it parses as a path and fails to match, as any
     * other name would.)
     *
     * @param raw one selector, trimmed
     * @return the range, or {@code null} when the text is not a line range at all
     * @throws SectionReferenceException when it opens like one and is malformed
     */
    static LineRange lineRangeOf(String raw) {
        if (!LINE_RANGE_PREFIX.matcher(raw).find()) {
            return null;
        }
        if (!isWholeLineRange(raw)) {
            throw new SectionReferenceException("\"#" + raw
                    + "\" is not a line range; write L<line> or L<line>:<column>");
        }

        // A spelling that consumes the whole text is still one of four forms; re-read it to pull the
        // numbers out. The scan above is the grammar, so this cannot fail on a shape it accepted.
        java.util.regex.Matcher match = LINE_RANGE_FULL.matcher(raw);
        if (!match.matches()) {
            throw new SectionReferenceException("\"#" + raw
                    + "\" is not a line range; write L<line> or L<line>:<column>");
        }

        LinePoint from = point(match.group(1), match.group(2));
        LinePoint to = match.group(3) == null ? null : point(match.group(3), match.group(4));

        if (zero(from) || (to != null && zero(to))) {
            throw new SectionReferenceException("\"#" + raw + "\" counts lines and columns from 1");
        }
        if (to != null) {
            boolean backwards = to.line() < from.line()
                    || (to.line() == from.line() && to.column() != null && from.column() != null
                            && to.column() < from.column());
            if (backwards) {
                throw new SectionReferenceException("\"#" + raw + "\" ends before it starts");
            }
        }
        return new LineRange(from, to);
    }

    private static final java.util.regex.Pattern LINE_RANGE_FULL =
            java.util.regex.Pattern.compile("^L(\\d+)(?::(\\d+))?(?:-L(\\d+)(?::(\\d+))?)?$");

    /**
     * Read {@code L<point>} and {@code L<point>-L<point>}, and nothing else.
     *
     * <p>A line range takes no modifier: there is nothing about a verbatim slice of lines for
     * {@code +} to add, and the {@code -} of the range is already spoken for, so a selector that is
     * not exactly one of the two forms is not a range at all.
     */
    private static boolean isWholeLineRange(String raw) {
        int at = 0;
        for (int endpoint = 0; endpoint < 2; endpoint++) {
            if (endpoint == 1) {
                if (at >= raw.length() || raw.charAt(at) != '-') {
                    return false;
                }
                at++;
            }
            if (at + 1 >= raw.length() || raw.charAt(at) != 'L' || !isDigit(raw.charAt(at + 1))) {
                return false;
            }
            at += 2;
            while (at < raw.length() && isDigit(raw.charAt(at))) {
                at++;
            }
            if (at < raw.length() && raw.charAt(at) == ':') {
                if (at + 1 >= raw.length() || !isDigit(raw.charAt(at + 1))) {
                    return false;
                }
                at += 2;
                while (at < raw.length() && isDigit(raw.charAt(at))) {
                    at++;
                }
            }
            // An endpoint is complete here; a second `-` starts the range's other end.
            if (at < raw.length() && raw.charAt(at) == '-') {
                continue;
            }
            break;
        }
        return at == raw.length();
    }

    private static LinePoint point(String line, String column) {
        return new LinePoint(Integer.parseInt(line), column == null ? null : Integer.parseInt(column));
    }

    private static boolean zero(LinePoint at) {
        return at.line() < 1 || (at.column() != null && at.column() < 1);
    }

    /** A decimal digit, as {@code \d} reads it in the grammar's own patterns. */
    private static boolean isDigit(char character) {
        return character >= '0' && character <= '9';
    }

    /** JavaScript's {@code String.split(separator)}: no regex, and empty parts kept. */
    private static List<String> split(String text, char separator) {
        List<String> parts = new ArrayList<>();
        int from = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == separator) {
                parts.add(text.substring(from, i));
                from = i + 1;
            }
        }
        parts.add(text.substring(from));
        return parts;
    }

    /** A line range's endpoints. */
    record LineRange(LinePoint from, LinePoint to) {
    }

    /** A modifier, or the contradiction that stands where one should be. */
    private record Merged(String modifier, Warning warning) {

        /** The spelling the modifier takes at the end of a canonical reference. */
        String spelling() {
            if (modifier != null) {
                return modifier;
            }
            return warning == null ? "" : warning.kept();
        }
    }

    private record Leading(String modifier, String name) {
    }

    private record Trailing(String name, List<String> tokens) {
    }
}
