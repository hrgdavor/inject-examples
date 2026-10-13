package hr.hrg.inject.section;

import java.util.List;

/**
 * A failure that is not a malformed reference: the mask invariant was broken, the file cannot be
 * scanned, or a well-formed reference matched nothing.
 *
 * <p>Mirrors the plain {@code Error} the JavaScript module throws for these, so a caller can tell
 * "you wrote the reference wrong" ({@link SectionReferenceException}) from "the file does not have
 * that" (this).
 *
 * <p>Beside the message — which is the contract text and is what a user is shown — the failure
 * carries the diagnosis RFC 1 §5.3 names: the stable {@link #code()} a host branches on, the
 * {@link #selector()} at fault, the {@link #scope()} it was searched in and the
 * {@link #candidates()} the name answered to. They are <b>additive and advisory</b>: a host reads
 * them to choose a fallback, and the resolver never reads them to decide an answer. Every one may be
 * {@code null} when it does not apply, exactly as the JavaScript object literal leaves them.
 */
public class SectionError extends RuntimeException {

    private static final long serialVersionUID = 1L;

    /**
     * What a name answered to, as a resolution failure reports it: enough for a host to offer a
     * picker or to fall back, and nothing that requires a second scan.
     *
     * @param name      the block's name
     * @param kind      the block's kind ({@code class}, {@code method}, {@code property}, …)
     * @param startLine the line the declaration is written on, 1-based
     * @param endLine   the line the block closes on, or its declaration line when it has no body
     */
    public record Candidate(String name, String kind, Integer startLine, Integer endLine) {
    }

    private final String code;
    private final String selector;
    private final String scope;
    private final List<Candidate> candidates;

    /** A failure with no diagnosis beyond its message — the mask invariant, mostly. */
    public SectionError(String message) {
        this(message, null, null, null, null);
    }

    /** A failure carrying its {@link ErrorCodes} string and nothing else. */
    public SectionError(String message, String code) {
        this(message, code, null, null, null);
    }

    public SectionError(String message, String code, String selector) {
        this(message, code, selector, null, null);
    }

    public SectionError(String message, String code, String selector, String scope) {
        this(message, code, selector, scope, null);
    }

    /**
     * @param message    the contract text
     * @param code       one of {@link ErrorCodes}, or {@code null} when the failure is uncoded
     * @param selector   the selector at fault, as written, when one is
     * @param scope      the block it was searched in, when one is
     * @param candidates what the name answered to, when several did
     */
    public SectionError(String message, String code, String selector, String scope,
                        List<Candidate> candidates) {
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

    /** The block the name was searched in, or {@code null}. */
    public String scope() {
        return scope;
    }

    /** What the name answered to, or {@code null} when the failure is not about several matches. */
    public List<Candidate> candidates() {
        return candidates;
    }
}
