import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

class PropertyTypes {
    java.util.List<String> dotted = new java.util.ArrayList<>();

    Supplier<String> supplier = () -> {
        return "value";
    };

    int[] numbers = { 1, 2, 3 };

    String[] names = new String[] { "a", "b" };

    int[][] grid = { { 1, 2 }, { 3, 4 } };

    static final Map<String, Integer> counts = new java.util.HashMap<>();

    @Deprecated
    int annotated = 7;
}
