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
 * <p>A path's last segment may also be an envelope mark, {@code ^} or {@code $}
 * ({@code Inventory/^,toString,$}). The pair says that one block's own first and last lines are taken
 * around whatever sits between them, so the marks are validated here — one {@code ^} first, one
 * {@code $} last, around one block — while the block they name is chosen during resolution, by what
 * they wrap.
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
     * <p>A path selector may also carry an <b>envelope</b>: {@code Cart/^} and {@code Cart/$} say
     * which block the marks around the member open and close, and the marks are whole segments of the
     * path, kept beside the names as {@code segments}' own last entry.
     *
     * @param kind     {@code path}, or {@code lines} for a line range
     * @param text     the selector as written, trimmed — or, for a selector between an envelope's
     *                 marks, the parent-qualified spelling the envelope reads it as
     * @param segments the path's name segments (a trailing envelope mark included), empty for a line
     *                 range
     * @param scope    how much of the match the selector asks for; meaningless for a line range
     * @param from     a line range's first endpoint, {@code null} for a path selector
     * @param to       a line range's last endpoint, {@code null} for a path selector or for a range
     *                 written as a single point
     * @param envelope the envelope mark this selector carries, or {@code null} when it carries none
     */
    public record Selector(String kind, String text, List<String> segments, Scope scope,
                           LinePoint from, LinePoint to, Envelope envelope) {

        /** The kind of a semantic-path selector. */
        public static final String PATH = "path";

        /** The kind of a line-range selector. */
        public static final String LINES = "lines";

        public Selector {
            segments = List.copyOf(segments);
        }

        /** A selector that carries no envelope — the ordinary case. */
        public Selector(String kind, String text, List<String> segments, Scope scope,
                        LinePoint from, LinePoint to) {
            this(kind, text, segments, scope, from, to, null);
        }

        static Selector path(String text, List<String> segments, Scope scope) {
            return new Selector(PATH, text, segments, scope, null, null, null);
        }

        static Selector path(String text, List<String> segments, Scope scope, Envelope envelope) {
            return new Selector(PATH, text, segments, scope, null, null, envelope);
        }

        /** A mark written bare — {@code Inventory/^,toString,$} — which inherits the other's parent. */
        static Selector bareMark(String text, String mark) {
            return new Selector(PATH, text, List.of(text), Scope.DECLARATION, null, null,
                    new Envelope(mark, null));
        }

        static Selector lines(String text, LinePoint from, LinePoint to) {
            return new Selector(LINES, text, List.of(), Scope.DECLARATION, from, to, null);
        }

        /** Whether this selector is a line range rather than a semantic path. */
        public boolean isLines() {
            return LINES.equals(kind);
        }
    }

    /**
     * The envelope mark a path selector carries: {@code ^} is the parent block's head, {@code $} its
     * tail, and {@code parent} is the path before the mark.
     *
     * <p>The mark is a whole segment and only ever the last one, which is what keeps it out of every
     * name: a sentinel is never the only segment of its path (there would be no parent to open or
     * close), and a {@code $} that is part of a name is not a sentinel because the segment is longer
     * than it. So {@code foo$} is the name {@code foo$} while {@code foo/$} is the last line of
     * {@code foo}.
     *
     * <p>{@code parent} is {@code null} for a mark written bare ({@code ^} or {@code $} as a whole
     * selector): its parent is the one the <em>other</em> mark names, and
     * {@link SectionReference#parse(String)} fills it in once both ends are known.
     *
     * @param mark   {@code ^} or {@code $}
     * @param parent the path before the mark, or {@code null} when the mark was written bare
     */
    public record Envelope(String mark, List<String> parent) {

        /** The head mark: the parent's declaration line through the line its body opens on. */
        public static final String OPEN = "^";

        /** The tail mark: the line the parent block ends on. */
        public static final String CLOSE = "$";

        public Envelope {
            parent = parent == null ? null : List.copyOf(parent);
        }

        /** Whether this is the head mark, {@code ^}, rather than the tail. */
        public boolean isHead() {
            return OPEN.equals(mark);
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
     * <p>A reference carrying envelope marks is validated here, because the pair is a property of the
     * spelling rather than of the file: {@code Cart/^,toString,$} parses, a lone {@code Cart/^} and a
     * pair whose ends disagree do not. Those failures are the {@code resolution/envelope-…} family —
     * the reference is well formed and the pair is what cannot be read — but they need no file, and
     * the JavaScript raises its grammar error type for them, so they are a
     * {@link SectionReferenceException} thrown before any file is consulted. {@link SectionResolver}
     * is what resolves the block the marks name.
     *
     * @param raw the reference, without the {@code #}
     * @return the parsed reference
     * @throws SectionReferenceException when the reference is malformed: nothing named, an empty
     *                                   selector, an empty path segment, more than eight segments,
     *                                   more than one modifier, a modifier where it may not go, a
     *                                   name carrying {@code +}, or a malformed line range; and when
     *                                   the reference carries envelope marks that are not one
     *                                   {@code ^} first and one {@code $} last around a single block,
     *                                   whose code is then {@code resolution/envelope-…}. The message
     *                                   is part of the contract.
     */
    public static SectionReference parse(String raw) {
        if (raw == null || raw.isEmpty()) {
            throw grammarError(ErrorCodes.EMPTY_REFERENCE, "\"#\" names nothing", null);
        }

        List<String> parts = split(raw, ',');
        for (String part : parts) {
            if (part.trim().isEmpty()) {
                throw grammarError(ErrorCodes.EMPTY_SELECTOR,
                        "\"#" + raw + "\" has an empty selector", raw);
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
                throw grammarError(ErrorCodes.LINE_RANGE_NOT_A_RANGE, "\"#" + text
                        + "\" is not a line range; write L<line> or L<line>:<column>", text);
            }
            // A mark may be written bare — `Inventory/^,toString,$` — and then it is the *other*
            // mark's parent it refers to, so the path is named once. The bare spelling is a whole
            // selector of one segment, which no path reaches because a mark needs a parent.
            String bare = envelopeMark(text);
            if (bare != null) {
                canonicalParts.add(text);
                selectors.add(Selector.bareMark(text, bare));
                continue;
            }
            if (!OPENS_A_NAME.matcher(text).find()) {
                throw grammarError(ErrorCodes.EMPTY_SEGMENT, "\"#" + text + "\" names nothing", text);
            }

            SectionReference parsed = parseReference(text);
            canonicalParts.add(parsed.canonical());
            selectors.add(Selector.path(text, parsed.segments(), parsed.scope(),
                    envelopeOf(parsed.segments())));
        }

        // A reference that carries marks is read as one envelope: which block they open and close is
        // settled here, and what sits between them is qualified by that parent, before any resolution.
        selectors = applyEnvelope(selectors, raw);

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
            throw grammarError(ErrorCodes.EMPTY_REFERENCE, "\"#\" names nothing", null);
        }
        if (raw.indexOf(',') >= 0) {
            throw grammarError(ErrorCodes.EMPTY_SELECTOR,
                    "\"#" + raw + "\" has an empty selector", raw);
        }
        // A reference names a section of one file, and the file is the path the marker's link already
        // carries, so `#` never occurs inside a reference: a second one is a link written into the
        // fragment by mistake.
        if (raw.indexOf('#') >= 0) {
            throw grammarError(ErrorCodes.SECOND_HASH,
                    "\"#" + raw + "\" has a second \"#\"; a reference names one file", raw);
        }
        if (LINE_RANGE_PREFIX.matcher(raw).find()) {
            lineRangeOf(raw);                   // throws when the spelling is malformed
            throw grammarError(ErrorCodes.LINE_RANGE_AS_PATH,
                    "\"#" + raw + "\" is a line range, not a section path", raw);
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
                throw grammarError(ErrorCodes.EMPTY_SEGMENT,
                        "\"#" + raw + "\" has an empty path segment", raw);
            }
        }
        if (parts.size() > MAX_SEGMENTS) {
            throw grammarError(ErrorCodes.TOO_DEEP, "\"#" + raw + "\" is deeper than 8 sections", raw);
        }

        List<String> modifiers = new ArrayList<>();
        List<String> names = new ArrayList<>();
        int lastPart = parts.size() - 1;
        for (int index = 0; index < parts.size(); index++) {
            String segment = parts.get(index);
            String modifier = segmentModifier(segment);
            if (modifier != null) {
                if (index != lastPart) {
                    throw grammarError(ErrorCodes.MODIFIER_NOT_LAST, "\"" + modifier
                            + "\" may only modify the last path segment of \"#" + raw + "\"", segment);
                }
                modifiers.add(modifier);
                continue;
            }
            // A segment of nothing but modifier characters (`+++`, `---`) is two of them on one
            // segment. `--` and `--brand` are names: a CSS custom property is one.
            if (MODIFIER_RUN.matcher(segment).matches() && !"--".equals(segment)) {
                throw grammarError(ErrorCodes.TOO_MANY_MODIFIERS,
                        "\"#" + raw + "\" carries more than one modifier", segment);
            }
            assertName(segment, raw, index == lastPart);
            names.add(segment);
        }

        if (names.isEmpty()) {
            // A path of modifiers has no subject: `-` is the old body scope, and `++`/`+` name nothing
            // at all. Say that rather than "more than one modifier" about a single one.
            throw segmentModifier(raw) == null
                    ? grammarError(ErrorCodes.TOO_MANY_MODIFIERS,
                            "\"#" + raw + "\" carries more than one modifier", raw)
                    : grammarError(ErrorCodes.EMPTY_SEGMENT,
                            "\"#" + raw + "\" names nothing", raw);
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
     * <p>A whole envelope mark ({@code ^}, {@code $}) is not a name but is a legal last segment, which
     * {@code carriesMark} allows; {@code ^} anywhere earlier is the "names nothing" error, because
     * there is no parent for it to open.
     *
     * @param segment     a segment already known not to be a whole modifier
     * @param raw         the reference as written, for the message
     * @param carriesMark whether this segment may be an envelope mark
     */
    private static void assertName(String segment, String raw, boolean carriesMark) {
        if (NAME.matcher(segment).matches()) {
            return;
        }
        if (carriesMark && envelopeMark(segment) != null) {
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
            throw grammarError(ErrorCodes.MODIFIER_OLD_SPELLING, before.isEmpty()
                    ? "\"" + run + "\" is a path segment now; it follows the path, as \"#<path>/"
                            + run + "\""
                    : "\"" + run + "\" is a path segment now; write \"#" + before + "/" + run + "\"",
                    segment);
        }
        throw grammarError(ErrorCodes.EMPTY_SEGMENT, "\"#" + raw + "\" names nothing", segment);
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
        // Unreachable from the path reader — only the last segment may be a modifier, so at most one is
        // ever collected — and `lib/section.mjs` attaches no code here, so neither does this.
        throw new SectionReferenceException("\"#" + raw + "\" carries more than one modifier");
    }

    // ------------------------------------------------------------------
    // Envelope marks
    // ------------------------------------------------------------------

    /** The whole segments that are marks: {@code ^} is a parent's head, {@code $} its tail. */
    private static final List<String> ENVELOPE_MARKS = List.of(Envelope.OPEN, Envelope.CLOSE);

    /** Is this segment a whole envelope mark? */
    private static String envelopeMark(String segment) {
        return ENVELOPE_MARKS.contains(segment) ? segment : null;
    }

    /**
     * The path before an envelope mark, or {@code null} when the segment does not carry one.
     *
     * <p>{@code Inventory/^} opens {@code Inventory} and {@code Inventory/Item/$} closes the
     * {@code Item} inside it; a bare {@code ^} has no parent and is not a mark of its own.
     */
    private static Envelope envelopeOf(List<String> segments) {
        if (segments.size() < 2) {
            return null;
        }
        String mark = envelopeMark(segments.get(segments.size() - 1));
        if (mark == null) {
            return null;
        }
        return new Envelope(mark, segments.subList(0, segments.size() - 1));
    }

    /**
     * Read a reference that carries envelope marks: a parent declaration's own first and last lines,
     * wrapped around the members selected from inside it.
     *
     * <p>{@code Inventory/^,toString,$} is the class's opening line, the {@code toString} method, and
     * the class's closing line. The marks say which block is being opened and closed, and the path may
     * be written on <b>either</b> of them: a bare mark refers to the parent the other one names, so the
     * path is written once rather than on every selector. What sits <b>between</b> the marks is read
     * inside that block, and a selector that already names the parent is left alone, so the long form
     * ({@code Inventory/^,Inventory/toString,Inventory/$}) means the same thing.
     *
     * <p>A mark is a whole segment of a path, so it cannot be confused with a name. What has to be
     * checked is that the pair makes sense: both ends present, one parent between them, and in the
     * {@code ^} then {@code $} order. Anything else is an error rather than a silent reading of
     * something the user did not write.
     *
     * <p>These failures carry {@code resolution/} codes — the reference is well formed and the pair is
     * what cannot be read — but they are raised while the reference is read and no file is consulted,
     * so they are a {@link SectionReferenceException}, the type the JavaScript raises for them. The
     * namespace and the type are two different facts: the code says which category the failure belongs
     * to, while the type says when it can be raised.
     *
     * @param selectors the parsed selectors, in the order written
     * @param raw       the reference as written, for the messages
     * @return the selectors with both ends' parents filled in and the interior ones qualified
     */
    private static List<Selector> applyEnvelope(List<Selector> selectors, String raw) {
        boolean any = false;
        for (Selector selector : selectors) {
            if (selector.envelope() != null) {
                any = true;
                break;
            }
        }
        if (!any) {
            return selectors;
        }

        Selector first = selectors.get(0);
        Selector last = selectors.get(selectors.size() - 1);
        if (selectors.size() == 1) {
            throw grammarError(ErrorCodes.ENVELOPE_ALONE, "\"#" + raw + "\": a lone \""
                    + first.envelope().mark()
                    + "\" has nothing to " + (first.envelope().isHead() ? "close" : "open"), raw);
        }
        if (first.envelope() == null || last.envelope() == null
                || !first.envelope().isHead() || last.envelope().isHead()) {
            throw grammarError(ErrorCodes.ENVELOPE_ORDER,
                    "\"#" + raw + "\": an envelope is \"^\" first and \"$\" last, "
                            + "around what they open and close", raw);
        }
        for (int index = 1; index < selectors.size() - 1; index++) {
            if (selectors.get(index).envelope() != null) {
                throw grammarError(ErrorCodes.ENVELOPE_MARKS,
                        "\"#" + raw + "\": an envelope has one \"^\" and one \"$\"", raw);
            }
        }

        // The path may be on either end; where both are written they must agree.
        List<List<String>> named = new ArrayList<>();
        if (first.envelope().parent() != null) {
            named.add(first.envelope().parent());
        }
        if (last.envelope().parent() != null) {
            named.add(last.envelope().parent());
        }
        if (named.isEmpty()) {
            throw grammarError(ErrorCodes.ENVELOPE_NO_BLOCK,
                    "\"#" + raw + "\": neither \"^\" nor \"$\" names a block, so there "
                            + "is nothing to open or close", raw);
        }
        List<String> parent = named.get(0);
        for (List<String> other : named.subList(1, named.size())) {
            if (!String.join("/", other).equals(String.join("/", parent))) {
                throw grammarError(ErrorCodes.ENVELOPE_MISMATCH,
                        "\"#" + raw + "\": \"^\" opens \"" + String.join("/", parent)
                                + "\" and \"$\" closes \"" + String.join("/", other)
                                + "\"; they must be the same block", raw);
            }
        }

        List<Selector> applied = new ArrayList<>(selectors.size());
        applied.add(withParent(first, parent));
        // What sits between the marks is read inside the block they name. A selector that already
        // starts with the parent's own path is left as written: it says the same thing, and prepending
        // the prefix twice would name nothing.
        for (int index = 1; index < selectors.size() - 1; index++) {
            Selector selector = selectors.get(index);
            applied.add(selector.isLines() || startsWith(selector.segments(), parent)
                    ? selector : qualified(selector, parent));
        }
        applied.add(withParent(last, parent));
        return applied;
    }

    /** The same mark, with its parent filled in — the one the other end named. */
    private static Selector withParent(Selector selector, List<String> parent) {
        return new Selector(selector.kind(), selector.text(), selector.segments(), selector.scope(),
                selector.from(), selector.to(), new Envelope(selector.envelope().mark(), parent));
    }

    /** Does this path already open with the parent's own path? */
    private static boolean startsWith(List<String> segments, List<String> parent) {
        if (segments.size() < parent.size()) {
            return false;
        }
        for (int index = 0; index < parent.size(); index++) {
            if (!parent.get(index).equals(segments.get(index))) {
                return false;
            }
        }
        return true;
    }

    /**
     * An interior selector, qualified by the parent the marks name: the parent's path is prepended,
     * and the selector's own text follows, because that is the spelling the resolver reads.
     */
    private static Selector qualified(Selector selector, List<String> parent) {
        List<String> segments = new ArrayList<>(parent);
        segments.addAll(selector.segments());
        return new Selector(Selector.PATH, String.join("/", segments), segments, selector.scope(),
                null, null, null);
    }

    /**
     * A failure raised while the reference is read, with the code and the selector at fault.
     *
     * <p>The Java counterpart of {@code grammarError} in {@code lib/section.mjs}: thrown as a
     * {@link SectionReferenceException} because no file has been read yet, whatever the code's own
     * namespace says. Most callers pass a {@code grammar/} code; the envelope pair is validated here
     * too and carries {@code resolution/envelope-…}, exactly as the JavaScript raises its grammar
     * error type for it.
     *
     * @param code     one of {@link ErrorCodes}' codes
     * @param message  the contract text
     * @param selector the selector at fault as written, or {@code null} when the whole reference is
     */
    private static SectionReferenceException grammarError(String code, String message,
                                                          String selector) {
        return new SectionReferenceException(message, code, selector);
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
            throw grammarError(ErrorCodes.LINE_RANGE_NOT_A_RANGE, "\"#" + raw
                    + "\" is not a line range; write L<line> or L<line>:<column>", raw);
        }

        // A spelling that consumes the whole text is still one of four forms; re-read it to pull the
        // numbers out. The scan above is the grammar, so this cannot fail on a shape it accepted.
        java.util.regex.Matcher match = LINE_RANGE_FULL.matcher(raw);
        if (!match.matches()) {
            throw grammarError(ErrorCodes.LINE_RANGE_NOT_A_RANGE, "\"#" + raw
                    + "\" is not a line range; write L<line> or L<line>:<column>", raw);
        }

        LinePoint from = point(match.group(1), match.group(2));
        LinePoint to = match.group(3) == null ? null : point(match.group(3), match.group(4));

        if (zero(from) || (to != null && zero(to))) {
            throw grammarError(ErrorCodes.LINE_RANGE_FROM_1,
                    "\"#" + raw + "\" counts lines and columns from 1", raw);
        }
        if (to != null) {
            boolean backwards = to.line() < from.line()
                    || (to.line() == from.line() && to.column() != null && from.column() != null
                            && to.column() < from.column());
            if (backwards) {
                throw grammarError(ErrorCodes.LINE_RANGE_BACKWARDS,
                        "\"#" + raw + "\" ends before it starts", raw);
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
