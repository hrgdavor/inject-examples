package hr.hrg.inject.section;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * A parsed section reference: the text after the {@code #} in a marker's fragment.
 *
 * <p>This is the Java counterpart of the object {@code parseReference} returns in
 * {@code lib/section.mjs}, and of the {@code Reference} type in {@code rust/section}. The three are
 * meant to be read side by side; the field names are the JavaScript ones.
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
 * @param raw       the text as it was given, without the {@code #}
 * @param canonical the normalised spelling, e.g. {@code Cart/Line/render-}
 * @param segments  the path segments, with every modifier removed
 * @param scope     how much of the match the modifier asks for
 * @param warning   the contradiction warning, or {@code null}
 */
public record SectionReference(String raw, String canonical, List<String> segments, Scope scope,
                               Warning warning) {

    /** The most segments a reference may have. */
    public static final int MAX_SEGMENTS = 8;

    public SectionReference {
        segments = List.copyOf(segments);
    }

    public boolean isSingleSegment() {
        return segments.size() == 1;
    }

    /** The segment that selects content; the earlier ones only narrow the scope. */
    public String finalSegment() {
        return segments.isEmpty() ? "" : segments.get(segments.size() - 1);
    }

    /** The contradiction warning, when the reference carried one. */
    public Optional<Warning> warningIfAny() {
        return Optional.ofNullable(warning);
    }

    /**
     * Parses a section reference — the text after the {@code #}.
     *
     * @param raw the reference, without the {@code #}
     * @return the parsed reference
     * @throws SectionReferenceException when the reference is malformed: nothing named, an empty path
     *                                   segment, more than eight segments, more than one modifier, or
     *                                   a modifier where it may not go. The message is part of the
     *                                   contract.
     */
    public static SectionReference parse(String raw) {
        if (raw == null || raw.isEmpty()) {
            throw new SectionReferenceException("\"#\" names nothing");
        }

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

        String[] parts = remainder.split("/", -1);
        for (String part : parts) {
            if (part.isEmpty()) {
                throw new SectionReferenceException("\"#" + raw + "\" has an empty path segment");
            }
        }
        if (parts.length > MAX_SEGMENTS) {
            throw new SectionReferenceException("\"#" + raw + "\" is deeper than 8 sections");
        }

        // `Cart/-Line` is the two-segment spelling of `Cart/Line-`: the `-` belongs to the reference,
        // not to the name. It applies only to a two-segment path, and only when the first segment
        // carried no detached modifier of its own.
        String detachedSecond = null;
        if (detached == null && parts.length == 2) {
            String second = parts[1];
            if (second.length() > 1 && second.charAt(0) == '-'
                    && second.charAt(1) != '-' && second.charAt(1) != '+') {
                detachedSecond = "-";
                parts[1] = second.substring(1);
            }
        }

        List<String> modifiers = new ArrayList<>();
        List<String> cleanSegments = new ArrayList<>();

        for (int i = 0; i < parts.length; i++) {
            boolean isLast = i == parts.length - 1;

            Leading leading = extractLeadingModifier(parts[i], isLast, raw);
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
                boolean legacyBareName = parts.length == 1
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

        String modifier = null;
        String contradiction = null;
        if (modifiers.size() == 1) {
            modifier = modifiers.get(0);
        } else if (modifiers.size() > 1) {
            long positive = modifiers.stream().filter(m -> m.startsWith("+")).count();
            long negative = modifiers.stream().filter(m -> m.startsWith("-")).count();
            if (positive > 1 || negative > 1) {
                throw new SectionReferenceException(
                        "\"#" + raw + "\" carries more than one modifier");
            }
            // One `+` and one `-`: the positive one wins, and the caller is told.
            if (modifiers.contains("++")) {
                modifier = "++";
            } else if (modifiers.contains("+")) {
                modifier = "+";
            } else {
                throw new SectionReferenceException(
                        "\"#" + raw + "\" carries more than one modifier");
            }
            contradiction = modifier;
        }

        String canonical = String.join("/", cleanSegments) + (modifier == null ? "" : modifier);
        Warning warning = null;
        if (contradiction != null) {
            warning = new Warning(Warning.KIND_CONTRADICTION, contradiction, "-", canonical,
                    "\"" + contradiction + "\" contradicts \"-\"; using \"#" + canonical + "\"");
        }

        return new SectionReference(raw, canonical, cleanSegments, Scope.fromModifier(modifier),
                warning);
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

    private record Leading(String modifier, String name) {
    }

    private record Trailing(String name, List<String> tokens) {
    }
}
