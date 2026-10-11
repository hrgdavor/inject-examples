package demo;

/**
 * A class whose own header wraps: type parameters, `extends` and `implements`
 * each on their own line, which is how a long declaration is usually formatted.
 */
public class Wrapped<
        T extends Comparable<T>,
        U extends CharSequence>
        extends AbstractBase
        implements Renderer<T> {

    public T best(
            T left,
            T right) {
        return left.compareTo(right) >= 0 ? left : right;
    }
}
