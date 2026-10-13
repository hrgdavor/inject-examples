package jump;

import java.util.ArrayList;
import java.util.List;

/** A cart of items. */
public class Cart {
    private final List<String> items = new ArrayList<>();

    /** Add one item to this cart. */
    @Override
    public String toString() {
        return String.join(",", items);
    }

    /** One line of a cart. */
    public static class Line {
        private final String name;

        String render() {
            return name + " x";
        }
    }
}
