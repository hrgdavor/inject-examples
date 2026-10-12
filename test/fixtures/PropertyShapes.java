class PropertyShapes {
    Runnable plain = () -> {
        work();
    };

    Runnable wrapped = () ->
    {
        work();
    };

    Supplier<String> value = () -> {
        return "value";
    };

    Comparator<String> byLength = new Comparator<String>() {
        public int compare(String left, String right) {
            return left.length() - right.length();
        }
    };

    void only() { work(); }

    void handler() { //tick
    }
}
