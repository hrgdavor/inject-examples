package example;

import java.util.ArrayList;
import java.util.List;

/** A cart of items, by name and quantity. */
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
        private final int quantity;

        Line(String name, int quantity) {
            this.name = name;
            this.quantity = quantity;
        }

        String render() {
            return name + " x" + quantity;
        }
    }
}