package hr.hrg.inject.section;

/**
 * A malformed section reference.
 *
 * <p>The message is part of the contract: the vectors pin it byte for byte, because it is what a user
 * is shown. It quotes the reference <em>as the user wrote it</em> — before normalisation — so the
 * message points at the document rather than at the parser's internal form.
 *
 * <p>Unchecked, because a malformed reference in a document is not a condition a caller can be
 * expected to recover from at every call site, and because it mirrors the JavaScript
 * {@code SectionReferenceError}, which is thrown rather than returned.
 */
public class SectionReferenceException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    public SectionReferenceException(String message) {
        super(message);
    }
}
