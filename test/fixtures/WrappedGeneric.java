public class WrappedGeneric<
        T extends Comparable<T>,
        U extends CharSequence>
        extends AbstractBase
        implements Renderer<T>
{
    public T best(T left, T right) {
        return left.compareTo(right) >= 0 ? left : right;
    }
}
