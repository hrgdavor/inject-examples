class Shapes {
    private int getUsers = 0;
    private String label = "not a // comment";

    /** The anchor is the first thing inside the braces. */
    void anchored() { //anchor
        work();
    }

    void notAnchored() {
        work(); //anchor
    }

    void calls() {
        add(1, 2);
        other.add(1, 2);
        return add(1, 2);
    }

    void add(int a, int b) {
        total = a + b;
    }

    void nextLineBrace()
    {
        work();
    }

    Runnable arrow = () -> {
        work();
    };

    void chains(int n) {
        if (n > 0) {
            work();
        } else if (n < 0) {
            other();
        } else {
            none();
        }
    }

    // #region wiring
    void regioned() {
        work();
    }
    // #endregion
}
