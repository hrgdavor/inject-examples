package demo;

/**
 * An enum whose constants each take a line of their own — the body is a list,
 * not a brace block, and the declaration is only complete once the last constant
 * (and its optional constructor arguments) has been read.
 */
public enum OrgFeature {
    CALL,
    CHAT,
    CHAT_AUDIO;

    private final String label;

    OrgFeature() {
        this.label = name().toLowerCase();
    }

    public String label() {
        return label;
    }

    /** A constant that carries arguments, so its line does not end on a comma. */
    enum Tier {
        /** The free tier, and the doc comment a `++` selection adds. */
        FREE(0),
        @Deprecated
        PAID(1);

        private final int rank;

        Tier(int rank) {
            this.rank = rank;
        }

        int rank() {
            return rank;
        }
    }
}
