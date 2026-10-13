package hr.hrg.inject.section;

import java.util.List;

/**
 * A failure raised while the reference is read.
 *
 * <p>This is the grammar type: a malformed reference, and also the envelope pair that is validated
 * from the spelling alone. It is raised by {@code parse}/{@code parseSelectors} before any file is
 * consulted — which is what the type tells a caller, while {@link #code()}'s namespace tells it
 * <em>why</em>. Most codes here are {@code grammar/…}; the envelope pair is
 * {@code resolution/envelope-…} and is still this type, exactly as the JavaScript raises its
 * {@code SectionReferenceError} for it (RFC 1 §3.6).
 *
 * <p>The message is part of the contract: the vectors pin it byte for byte, because it is what a user
 * is shown. It quotes the reference <em>as the user wrote it</em> — before normalisation — so the
 * message points at the document rather than at the parser's internal form.
 *
 * <p>Unchecked, because a malformed reference in a document is not a condition a caller can be
 * expected to recover from at every call site, and because it mirrors the JavaScript
 * {@code SectionReferenceError}, which is thrown rather than returned.
 *
 * <p>Beside the message it carries the diagnosis RFC 1 §5.3 names — {@link #code()},
 * {@link #selector()}, {@link #scope()} and {@link #candidates()} — matching the fields the
 * JavaScript error object is given. They are additive and advisory, and each may be {@code null} when
 * it does not apply.
 */
public class SectionReferenceException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    private final String code;
    private final String selector;
    private final String scope;
    private final List<SectionError.Candidate> candidates;

    /** A malformed reference, with no diagnosis beyond its message. */
    public SectionReferenceException(String message) {
        this(message, null, null, null, null);
    }

    /** A malformed reference carrying its {@link ErrorCodes} string. */
    public SectionReferenceException(String message, String code) {
        this(message, code, null, null, null);
    }

    public SectionReferenceException(String message, String code, String selector) {
        this(message, code, selector, null, null);
    }

    /**
     * @param message    the contract text
     * @param code       one of {@link ErrorCodes}, or {@code null} when the failure is uncoded
     * @param selector   the selector at fault, as written, when one is
     * @param scope      the block it was searched in; a reference read before any file never has one
     * @param candidates what a name answered to; a reference read before any file never has any
     */
    public SectionReferenceException(String message, String code, String selector, String scope,
                                     List<SectionError.Candidate> candidates) {
        super(message);
        this.code = code;
        this.selector = selector;
        this.scope = scope;
        this.candidates = candidates == null ? null : List.copyOf(candidates);
    }

    /** The stable code, one of {@link ErrorCodes}, or {@code null} when the failure carries none. */
    public String code() {
        return code;
    }

    /** The selector at fault, as the caller wrote it, or {@code null}. */
    public String selector() {
        return selector;
    }

    /** The block it was searched in; {@code null} for a failure raised before any file is read. */
    public String scope() {
        return scope;
    }

    /** What a name answered to; {@code null} for a failure raised before any file is read. */
    public List<SectionError.Candidate> candidates() {
        return candidates;
    }
}
