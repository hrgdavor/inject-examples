package hr.hrg.inject.section;

/**
 * A failure that is not a malformed reference: the mask invariant was broken, the file cannot be
 * scanned, or a well-formed reference matched nothing.
 *
 * <p>Mirrors the plain {@code Error} the JavaScript module throws for these, so a caller can tell
 * "you wrote the reference wrong" ({@link SectionReferenceException}) from "the file does not have
 * that" (this).
 */
public class SectionError extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public SectionError(String message) {
        super(message);
    }
}
