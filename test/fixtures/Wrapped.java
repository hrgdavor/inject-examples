package demo;

/** A declaration whose header does not fit on one line. */
public class Wrapped {

    public String render(
            String name,
            int quantity) {
        return name + " x" + quantity;
    }

    public <T extends Comparable<T>> T widest(
            T left,
            T right) {
        return left.compareTo(right) >= 0 ? left : right;
    }

    /** The header wraps, and so does the class line below it. */
    @Override
    public String toString(
    ) {
        return name;
    }

    public void store(
            String name,
            int quantity)
            throws IllegalStateException {
        this.name = name;
    }

    private String name;

    /** A body-less member whose header wraps, beside the members that have one. */
    abstract String label(
            int width);
}
