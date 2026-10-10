package hr.hrg.inject.section;

/**
 * The share of a match a modifier asks for.
 *
 * <p>The names are the JavaScript implementation's ({@code declaration}, {@code body},
 * {@code annotated}, {@code documented}) so a reader can compare the two side by side.
 */
public enum Scope {

    /** The whole declaration (no modifier). */
    DECLARATION("declaration"),

    /** {@code -}: the body only. */
    BODY("body"),

    /** {@code +}: the declaration with its annotations. */
    ANNOTATED("annotated"),

    /** {@code ++}: the declaration with its annotations and doc comment. */
    DOCUMENTED("documented");

    private final String text;

    Scope(String text) {
        this.text = text;
    }

    /**
     * The name the JavaScript implementation prints.
     *
     * @return {@code declaration}, {@code body}, {@code annotated} or {@code documented}
     */
    public String text() {
        return text;
    }

    @Override
    public String toString() {
        return text;
    }

    /**
     * The scope a normalised modifier selects.
     *
     * @param modifier {@code null}, {@code -}, {@code +} or {@code ++}
     * @return the scope that modifier asks for, {@link #DECLARATION} when there is none
     */
    static Scope fromModifier(String modifier) {
        if ("-".equals(modifier)) {
            return BODY;
        }
        if ("+".equals(modifier)) {
            return ANNOTATED;
        }
        if ("++".equals(modifier)) {
            return DOCUMENTED;
        }
        return DECLARATION;
    }
}
