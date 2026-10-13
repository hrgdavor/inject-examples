// A second `add` at the same level as the first: the ambiguity band, in the
// smallest shape a document can carry. A jump may pick visibly; the gate must
// refuse, because it cannot choose on the reader's behalf.
public class Duplicate {
    void add(String item) {
        items.add(item);
    }

    void add(String item, int count) {
        items.add(item);
    }
}
