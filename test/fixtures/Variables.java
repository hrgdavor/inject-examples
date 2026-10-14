package demo;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The variables a method or a block declares: a local with no initialiser, a list of declarators, a nested
 * generic type, a loop's own variable (classic and enhanced), a resource, a `catch` parameter — and the
 * parameters the signature itself names.
 */
class Variables {

    void run() {
        try { while (!Thread.interrupted()) {
            Map<Long, List<Session>> perOrg = new HashMap<>();
            int count;
            int first = 1, second = 2;
        } }
    }

    void loops() {
        for (String item : items) {
            use(item);
        }
        for (int index = 0; index < 3; index++) {
            use(index);
        }
        try (InputStream input = open()) {
            use(input);
        }
    }

    void fails() {
        try {
            go();
        } catch (IOException failure) {
            use(failure);
        }
    }

    void render(String title, final int size) {
    }
}
