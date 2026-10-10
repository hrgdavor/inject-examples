package hr.hrg.inject.section;

/**
 * A reference that carries contradictory modifiers: the positive one is kept and the negative one is
 * dropped, with a warning rather than an error.
 *
 * <p>Exactly one pair contradicts: {@code ++}/{@code +} asks for the declaration <em>with</em> what
 * surrounds it, {@code -} asks for the body alone, and no single section is both. The reference is
 * meaningless, but it is what a human types while refactoring, so it must not hold a whole document
 * hostage — hence a warning.
 *
 * @param kind      always {@link #KIND_CONTRADICTION} today
 * @param kept      the modifier that won, {@code ++} or {@code +}
 * @param dropped   the modifier that was dropped, always {@code -}
 * @param canonical the reference as it should have been written
 * @param message   the warning, in the JavaScript implementation's wording
 */
public record Warning(String kind, String kept, String dropped, String canonical, String message) {

    /** The only warning kind the grammar has. */
    public static final String KIND_CONTRADICTION = "contradiction";
}
