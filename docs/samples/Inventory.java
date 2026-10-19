package demo;

import java.util.ArrayList;
import java.util.List;

/** A small stock inventory: the sample every target on this page reads. */
public class Inventory {

    // The catalog is a region directive: the directive lines are never injected.
    // #region catalog
    /** The catalog, kept as an explicit region directive. */
    static final String[] CATALOG = { "bolt", "nut", "washer" };
    // #endregion

    private final List<Item> items = new ArrayList<>();

    /** One stock line of this inventory. */
    public static class Item {
        private final String name;
        private final int quantity;

        Item(String name, int quantity) {
            this.name = name;
            this.quantity = quantity;
        }

        /** Render one line the way the receipt shows it. */
        String render() {
            return name + " x" + quantity;
        }
    }

    /** Summarise the inventory. */
    @Deprecated
    public String toString() {
        return items.size() + " item(s)";
    }

    /** Run one named method. */
    public void dispatch(String methodName) {
        if ("count".equals(methodName)) {
            System.out.println("items: " + items.size());
        } else if ("clear".equals(methodName)) {
            items.clear();
        }
    }

    public void legacy() {//count
        {//detail
            System.out.println("items: " + items.size());
        }
    }
}
