package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;

/**
 * A parsed section reference: the text after the {@code #} in a marker's fragment.
 *
 * <p>This is the Java counterpart of the object {@code parseSelectors} returns in
 * {@code lib/section.mjs}, and of the {@code Reference} type in {@code rust/section}. The three are
 * meant to be read side by side; the field names are the JavaScript ones.
 *
 * <p>A reference is <b>one or more selectors separated by {@code ,}</b>, each of which is either a
 * semantic path ({@code Cart/Line/render/++}) or a line range ({@code L40:12-L44:3}). The selectors
 * are kept in the order they were written, each with the scope its own spelling gives it and the
 * <em>text</em> it was written with, which is what the canonical spelling preserves. A reference of
 * one path selector is the degenerate case of that list, and every field the single-reference
 * grammar ever had still holds for it: {@link #segments()} and {@link #scope()}.
 *
 * <p>A modifier is a <b>whole segment</b>, written where the path ends and legal only there:
 * {@code toString/++} is the documented method, {@code add/-} its body, {@code getUsers/+} the method
 * with its annotations. It is never a prefix or a suffix. A name may contain {@code -}
 * ({@code item-list}, {@code update-document-test}, and even a leading or trailing one, since
 * {@code add-} and {@code -a-} are names) but never {@code +}: a {@code -} is a modifier only as the
 * whole segment, and a {@code +} is only ever one. So {@code add++} is an error that names the
 * spelling that works, and {@code --} is a name — a CSS custom property, one segment of
 * {@code Cart/--brand}.
 *
 * <p>A modifier belongs to the selector whose path carries it, so {@code add/-,render/++} is two
 * selectors that each say what they mean and nothing is ambiguous between them. A line range carries
 * no modifier at all: its own {@code -} is spoken for by the range, and there is nothing about a
 * verbatim slice of lines for a scope to widen. Nothing here warns: a reference is one spelling of
 * one thing, and what is not one is an error with the text that says why.
 *
 * @param raw       the text as it was given, without the {@code #}
 * @param canonical the normalised spelling, e.g. {@code Cart/Line/render/++} or {@code add,L40-L44}
 * @param selectors the selectors, in the order written
 * @param segments  the last path selector's segments, or an empty list when the reference is a line
 *                  range (or a list whose last selector is one)
 * @param scope     the last path selector's scope, {@link Scope#DECLARATION} when there is none
 */
public record SectionReference(String raw, String canonical, List<Selector> selectors,
                               List<String> segments, Scope scope) {

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
     * <p>{@code text} is the selector as it was written — the spelling the canonical form keeps, and
     * also the name a line-range error message quotes. A path selector carries its own
     * {@code segments} and the {@code scope} its own trailing modifier asks for; a line-range
     * selector carries its endpoints instead.
     *
     * @param kind     {@code path}, or {@code lines} for a line range
     * @param text     the selector as written, trimmed
     * @param segments the path's name segments, empty for a line range
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

    /** Whether the reference is a single line range, which consults no matcher at all. */
    public boolean isLineRange() {
        return selectors.size() == 1 && selectors.get(0).isLines();
    }

    /**
     * Parses a section reference — the text after the {@code #}.
     *
     * <p>This is {@code parseSelectors}: the reference may name several selectors, and a selector may
     * be a line range. Each selector canonicalises on its own, and the pieces join with {@code ,}. A
     * single path selector parses to the same canonical spelling, the same segments and the same
     * scope it always has.
     *
     * @param raw the reference, without the {@code #}
     * @return the parsed reference
     * @throws SectionReferenceException when the reference is malformed: nothing named, an empty
     *                                   selector, an empty path segment, more than eight segments,
     *                                   more than one modifier, a modifier where it may not go, a
     *                                   name carrying {@code +}, or a malformed line range. The
     *                                   message is part of the contract.
     */
    public static SectionReference parse(String raw) {
        if (raw == null || raw.isEmpty()) {
            throw new SectionReferenceException("\"#\" names nothing");
        }

        List<String> parts = split(raw, ',');
        for (String part : parts) {
            if (part.trim().isEmpty()) {
                throw new SectionReferenceException("\"#" + raw + "\" has an empty selector");
            }
        }

        List<Selector> selectors = new ArrayList<>();
        // The canonical spelling of every selector, in the order written.
        List<String> canonicalParts = new ArrayList<>();

        for (String part : parts) {
            String text = part.trim();
            // A selector that opens `L<digit>` is a line range or a typo, never a name — read as a
            // range before anything else, so `L40-` reports the range rather than a path about a name
            // nobody meant.
            LineRange range = lineRangeOf(text);
            if (range != null) {
                canonicalParts.add(text);
                selectors.add(Selector.lines(text, range.from(), range.to()));
                continue;
            }
            if (LINE_RANGE_PREFIX.matcher(text).find()) {
                throw new SectionReferenceException("\"#" + text
                        + "\" is not a line range; write L<line> or L<line>:<column>");
            }
            if (!OPENS_A_NAME.matcher(text).find()) {
                throw new SectionReferenceException("\"#" + text + "\" names nothing");
            }

            SectionReference parsed = parseReference(text);
            canonicalParts.add(parsed.canonical());
            selectors.add(Selector.path(text, parsed.segments(), parsed.scope()));
        }

        String canonical = String.join(",", canonicalParts);

        // A reference of one path selector carries a scope the resolver applies; a line range has none,
        // and a mixed reference resolves each selector with its own.
        Selector sole = selectors.size() == 1 ? selectors.get(0) : null;

        return new SectionReference(raw, canonical, selectors,
                sole != null && !sole.isLines() ? sole.segments() : List.of(),
                sole != null && !sole.isLines() ? sole.scope() : Scope.DECLARATION);
    }

    /**
     * Parses a <b>single path selector</b> — the grammar the reference had before it became a list.
     *
     * <p>This is {@code parseReference} in {@code lib/section.mjs}: everything it accepts parses with
     * {@link #parse(String)} to the same canonical spelling, the same segments and the same scope, but
     * it refuses what is not one path — a comma, or a line range — with the message the single
     * grammar uses.
     *
     * <p>The path is the whole of what a reference names, so the modifier is written where the path
     * ends. A modifier is legal only as the <b>last</b> segment, and only once — {@code a/++/b} and
     * {@code a/++/-} are both errors, because a modifier describes the selection, and nothing is
     * selected until the path ends. A name may contain {@code -} but never {@code +}; that is what
     * makes the two unmistakable.
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
        // A reference names a section of one file, and the file is the path the marker's link already
        // carries, so `#` never occurs inside a reference: a second one is a link written into the
        // fragment by mistake.
        if (raw.indexOf('#') >= 0) {
            throw new SectionReferenceException(
                    "\"#" + raw + "\" has a second \"#\"; a reference names one file");
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
        List<String> parts = split(raw, '/');
        for (String part : parts) {
            if (part.isEmpty()) {
                throw new SectionReferenceException("\"#" + raw + "\" has an empty path segment");
            }
        }
        if (parts.size() > MAX_SEGMENTS) {
            throw new SectionReferenceException("\"#" + raw + "\" is deeper than 8 sections");
        }

        List<String> modifiers = new ArrayList<>();
        List<String> names = new ArrayList<>();
        int lastPart = parts.size() - 1;
        for (int index = 0; index < parts.size(); index++) {
            String segment = parts.get(index);
            String modifier = segmentModifier(segment);
            if (modifier != null) {
                if (index != lastPart) {
                    throw new SectionReferenceException("\"" + modifier
                            + "\" may only modify the last path segment of \"#" + raw + "\"");
                }
                modifiers.add(modifier);
                continue;
            }
            // A segment of nothing but modifier characters (`+++`, `---`) is two of them on one
            // segment. `--` and `--brand` are names: a CSS custom property is one.
            if (MODIFIER_RUN.matcher(segment).matches() && !"--".equals(segment)) {
                throw new SectionReferenceException("\"#" + raw + "\" carries more than one modifier");
            }
            assertName(segment, raw);
            names.add(segment);
        }

        if (names.isEmpty()) {
            // A path of modifiers has no subject: `-` is the old body scope, and `++`/`+` name nothing
            // at all. Say that rather than "more than one modifier" about a single one.
            throw new SectionReferenceException(segmentModifier(raw) == null
                    ? "\"#" + raw + "\" carries more than one modifier"
                    : "\"#" + raw + "\" names nothing");
        }

        String merged = mergeModifiers(modifiers, raw);
        Scope scope = Scope.fromModifier(merged);
        String canonical = String.join("/", names) + (merged == null ? "" : "/" + merged);

        // `segments` and `scope` are the whole reference's, because a single path selector is the
        // degenerate case of the list: the last path selector's path is the only one there is.
        List<Selector> selectors = List.of(Selector.path(raw, names, scope));
        return new SectionReference(raw, canonical, selectors, names, scope);
    }

    /** The modifier a path <b>segment</b> is, or {@code null} when the segment is a name. */
    private static String segmentModifier(String segment) {
        if ("++".equals(segment)) {
            return "++";
        }
        if ("+".equals(segment)) {
            return "+";
        }
        if ("-".equals(segment)) {
            return "-";
        }
        return null;
    }

    /**
     * Reject a name this grammar cannot carry, with the message that says why.
     *
     * <p>{@code +} has no meaning inside a name at all, and the only thing a user means by it is a
     * modifier — so the message names the spelling that works rather than leaving them with "names
     * nothing". A {@code +} that <em>opens</em> a segment is the old prefix form ({@code +toString}),
     * whose replacement has the path before it.
     *
     * @param segment a segment already known not to be a whole modifier
     * @param raw     the reference as written, for the message
     */
    private static void assertName(String segment, String raw) {
        if (NAME.matcher(segment).matches()) {
            return;
        }
        int at = segment.indexOf('+');
        if (at >= 0) {
            int end = at;
            while (end < segment.length() && segment.charAt(end) == '+') {
                end++;
            }
            String run = segment.substring(at, end);
            String before = segment.substring(0, at);
            throw new SectionReferenceException(before.isEmpty()
                    ? "\"" + run + "\" is a path segment now; it follows the path, as \"#<path>/"
                            + run + "\""
                    : "\"" + run + "\" is a path segment now; write \"#" + before + "/" + run + "\"");
        }
        throw new SectionReferenceException("\"#" + raw + "\" names nothing");
    }

    /**
     * The scope name a modifier selects, or {@code null} for none.
     *
     * <p>Two modifiers on one path is malformed rather than contradictory: there is no section that is
     * two scopes at once, and the grammar has no warning to give.
     *
     * @param modifiers the modifiers in the order they were written
     * @param raw       the reference as the user wrote it, for the messages
     */
    private static String mergeModifiers(List<String> modifiers, String raw) {
        if (modifiers.isEmpty()) {
            return null;
        }
        if (modifiers.size() == 1) {
            return modifiers.get(0);
        }
        throw new SectionReferenceException("\"#" + raw + "\" carries more than one modifier");
    }

    // ------------------------------------------------------------------
    // The grammar's own patterns
    // ------------------------------------------------------------------

    /** A name character: a letter, a digit, {@code _}, {@code $}, {@code .} or {@code -}. */
    private static final java.util.regex.Pattern NAME =
            java.util.regex.Pattern.compile("^[A-Za-z0-9_$.\\-]+$");

    /** A segment that is nothing but modifier characters ({@code --}, {@code ---}, {@code +++}). */
    private static final java.util.regex.Pattern MODIFIER_RUN =
            java.util.regex.Pattern.compile("^[-+]{2,}$");

    /** Can this text even open a selector? {@code @x} cannot, and names nothing. */
    private static final java.util.regex.Pattern OPENS_A_NAME =
            java.util.regex.Pattern.compile("^[\\w$/+-]");

    // ------------------------------------------------------------------
    // The line-range grammar
    // ------------------------------------------------------------------

    /** Does this selector at least begin like a line range ({@code L40})? */
    private static final java.util.regex.Pattern LINE_RANGE_PREFIX =
            java.util.regex.Pattern.compile("^L\\d");

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
}
