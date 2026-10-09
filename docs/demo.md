# What a marker target can say

Click a target: it highlights the lines it selects in
[samples/Inventory.java](./samples/Inventory.java), and the same injection in
the rendered Markdown ([source](https://github.com/hrgdavor/inject-examples/blob/main/docs/demo.md)) beside it. 
/ [GIT source](https://github.com/hrgdavor/inject-examples) / [section-matching SPEC](https://github.com/hrgdavor/inject-examples/blob/main/doc/section-matching.md)

## A named region

Wrap part of a file in `#region <name>` / `#endregion` comments and name that
region in the fragment. The directive lines themselves are never injected, and
this works with any of the comment prefixes a language uses.

[samples/Inventory.java](./samples/Inventory.java#catalog)

```java
    /** The catalog, kept as an explicit region directive. */
    static final String[] CATALOG = { "bolt", "nut", "washer" };
```

## A declaration, and how much of it comes along

When the file carries no region directive, the name is looked for as a
declaration — a method, constructor or class-like block. The declaration *is*
the region, so the file needs nothing added to it. A leading `-`, `+` or `++`
selects how far up the text starts:

- `#toString` — the declaration: signature through closing brace.
- `#-toString` — the body only, without the signature.
- `#+toString` — the declaration and the annotations above it.
- `#++toString` — those and the doc comment above them.

The same method, four ways:

[samples/Inventory.java](./samples/Inventory.java#toString)

```java
    public String toString() {
        return items.size() + " item(s)";
    }
```

[samples/Inventory.java](./samples/Inventory.java#-toString)

```java
        return items.size() + " item(s)";
```

[samples/Inventory.java](./samples/Inventory.java#+toString)

```java
    @Override
    public String toString() {
        return items.size() + " item(s)";
    }
```

[samples/Inventory.java](./samples/Inventory.java#++toString)

```java
    /** Summarise the inventory. */
    @Override
    public String toString() {
        return items.size() + " item(s)";
    }
```

## A nested declaration

A name can be a path: slash-separated segments, each naming a block inside the
one before it. `Inventory/Item/render` is the `render` method of the `Item`
class of `Inventory`; only the last segment selects the injected text, the
segments before it are scopes to descend into.

[samples/Inventory.java](./samples/Inventory.java#Inventory/Item/render)

```java
        String render() {
            return name + " x" + quantity;
        }
```

## A condition literal

Inside a scope a segment may also match what a block *contains*: a statement
whose header carries the name as a double-quoted string. `dispatch/count`
selects the `if ("count".equals(methodName))` block, braces and all.

[samples/Inventory.java](./samples/Inventory.java#dispatch/count)

```java
        if ("count".equals(methodName)) {
            System.out.println("items: " + items.size());
        }
```

## A comment anchor

A block whose opening line carries a trailing comment is named by that comment.
`legacy()` opens `public void legacy() { //count`, so `legacy/count` names the
whole method.

[samples/Inventory.java](./samples/Inventory.java#legacy/count)

```java
    public void legacy() { //count
        System.out.println("items: " + items.size());
    }
```

## The whole file

A marker with no `#fragment` stands for the whole file, normalised to LF and
without a trailing newline. It is the plainest thing a marker can say.

[samples/Inventory.java](./samples/Inventory.java)

```java
package demo;

import java.util.ArrayList;
import java.util.List;

/** A small stock inventory: the sample every target on this page reads. */
public class Inventory {

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
    @Override
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

    public void legacy() { //count
        System.out.println("items: " + items.size());
    }
}
```
