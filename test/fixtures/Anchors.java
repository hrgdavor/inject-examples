package example;

/** A dispatch table keyed by method name. */
public class Anchors {
    /** Run one named method. */
    public void dispatch(String methodName) {
        if ("getUsers".equals(methodName)) {
            System.out.println("users");
        } else if ("getOrders".equals(methodName)) {
            System.out.println("orders");
        }
    }

    public void handler() { //getUsers
        System.out.println("anchor same line");
    }

    public void other() {
        //getOrders
        System.out.println("anchor next line");
    }

    public void commentFromString() {
        String s = "getUsers";
        System.out.println(s);
    }
}
