// The brace anchor: a block is named by a comment at its opening brace, or on
// the first line inside it. The braces already mark the block's start and end,
// so no `#region` prefix and no `#endregion` are needed — only the name. The
// default selection includes the opening line; `/-` selects the body.
public class Shorthand {
    public void run(int n) {
        while (n > 0) {//countdown
            n -= 1;
        }
        if (n == 0) {// done
            reset();
        }
        while (n < 9) {
            //solo
            n += 1;
        }
    }

    public void handler() {//handled
        work();
    }

    public void box() {
        {//bare
            tick();
        }
    }
}
