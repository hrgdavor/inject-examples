package hr.hrg.inject.section;

/**
 * The stable failure codes of {@code lib/section.mjs}'s {@code ERROR_CODES}, character for character.
 *
 * <p>A code says <em>why</em> a reference failed in a form a host can branch on, because the message
 * is written for a user and may be reworded while the code may not: it is a contract, and the corpus
 * pins it beside the message. The namespace is the category RFC 1 §3.6 fixes:
 *
 * <ul>
 *   <li>{@code grammar/…} — the reference is malformed as written; thrown as
 *       {@link SectionReferenceException};</li>
 *   <li>{@code resolution/…} — the reference is well formed and the failure is about what it names;
 *       thrown as {@link SectionError} when it takes a file to know, and, like the JavaScript's own
 *       grammar error type, as {@link SectionReferenceException} when it needs none — the
 *       {@code resolution/envelope-…} pair is read from the spelling alone, before any file
 *       (RFC 1 §3.6).</li>
 * </ul>
 *
 * <p>Two codes have no corpus row and cannot have one through this library, exactly as the
 * JavaScript notes: {@link #LEXER_MASK} is an engine defect rather than a reference's fault, and
 * {@link #KEY_DUPLICATED} belongs to the data-format rules above the matcher.
 */
public final class ErrorCodes {

    private ErrorCodes() {
    }

    // ------------------------------------------------------------------
    // grammar — malformed as written, before any file is consulted
    // ------------------------------------------------------------------

    /** The reference is empty: {@code "#"} names nothing. */
    public static final String EMPTY_REFERENCE = "grammar/empty-reference";

    /** One of the comma-separated selectors is empty. */
    public static final String EMPTY_SELECTOR = "grammar/empty-selector";

    /** A path segment is empty, or names nothing the grammar can carry. */
    public static final String EMPTY_SEGMENT = "grammar/empty-segment";

    /** A path is deeper than the eight segments the grammar allows. */
    public static final String TOO_DEEP = "grammar/too-deep";

    /** A reference carries a second {@code #}; a reference names one file. */
    public static final String SECOND_HASH = "grammar/second-hash";

    /** A line range was written where a section path belongs. */
    public static final String LINE_RANGE_AS_PATH = "grammar/line-range-as-path";

    /** A selector opens {@code L<digit>} and is not a line range. */
    public static final String LINE_RANGE_NOT_A_RANGE = "grammar/line-range-not-a-range";

    /** A line range counts lines or columns from zero. */
    public static final String LINE_RANGE_FROM_1 = "grammar/line-range-from-1";

    /** A line range ends before it starts. */
    public static final String LINE_RANGE_BACKWARDS = "grammar/line-range-backwards";

    /** A modifier is written anywhere but the last path segment. */
    public static final String MODIFIER_NOT_LAST = "grammar/modifier-not-last";

    /** A {@code +} was written inside a name, in the old prefix spelling. */
    public static final String MODIFIER_OLD_SPELLING = "grammar/modifier-old-spelling";

    /** A path carries more than one modifier. */
    public static final String TOO_MANY_MODIFIERS = "grammar/too-many-modifiers";

    // ------------------------------------------------------------------
    // resolution — well formed, and what the reference names cannot be answered
    // ------------------------------------------------------------------

    /** A line range names a line the file does not have. */
    public static final String LINE_RANGE_PAST_END = "resolution/line-range-past-end";

    /** A line range names a column its line does not have. */
    public static final String LINE_RANGE_COLUMN_PAST_END = "resolution/line-range-column-past-end";

    /** No section, declaration or region answers to the name. */
    public static final String NOT_FOUND = "resolution/not-found";

    /** Two or more blocks at one level answer to the name, and the path does not choose. */
    public static final String AMBIGUOUS = "resolution/ambiguous";

    /** A name that has to hold the rest of the path is a property or a region. */
    public static final String NOT_A_CONTAINER = "resolution/not-a-container";

    /** No {@code #region} directive carries the name. */
    public static final String REGION_NOT_FOUND = "resolution/region-not-found";

    /** Two {@code #region} directives carry the same name. */
    public static final String REGION_DUPLICATED = "resolution/region-duplicated";

    /** The data-format rules found a duplicated key; not reachable through the matcher. */
    public static final String KEY_DUPLICATED = "resolution/key-duplicated";

    // The envelope pair is validated while the reference is read, so these five are a
    // `SectionReferenceException` however their code is namespaced. `ENVELOPE_REGION` below is
    // resolved against the file and keeps the resolution type.

    /** An envelope's {@code ^} has no {@code $}. */
    public static final String ENVELOPE_ALONE = "resolution/envelope-alone";

    /** An envelope's marks are not {@code ^} first and {@code $} last. */
    public static final String ENVELOPE_ORDER = "resolution/envelope-order";

    /** An envelope does not carry exactly one {@code ^} and one {@code $}. */
    public static final String ENVELOPE_MARKS = "resolution/envelope-marks";

    /** An envelope's marks name different parents. */
    public static final String ENVELOPE_MISMATCH = "resolution/envelope-mismatch";

    /** No candidate block of an envelope's parent can hold what the marks wrap. */
    public static final String ENVELOPE_NO_BLOCK = "resolution/envelope-no-block";

    /** An envelope mark names a region, which has no declaration to open or close. */
    public static final String ENVELOPE_REGION = "resolution/envelope-region";

    /** A supplied lexer broke the mask invariant; an engine defect, not a reference's fault. */
    public static final String LEXER_MASK = "resolution/lexer-mask";
}
