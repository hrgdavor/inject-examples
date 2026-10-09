# Keep the code samples in your Markdown honest and target code sections semantically instead of line numbers that can drift much more easily.

DEMO of what a marker target can say. Click a target: it highlights the lines it selects in
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

## Go — a raw string is not code

`Add` is found through the braces, while the backtick raw string below it — which
contains a whole `Decoy` function — is blanked before anything is counted, so it
can never be mistaken for a member.

[samples/Cart.go](./samples/Cart.go#Add)

```go
func Add(items []string, item string) []string {
	return append(items, item)
}
```

## Rust — the members live in the impl

Rust keeps a type's methods in `impl` blocks, which are siblings of the `struct`
with the same name. The path retries them, so `Cart/add` reaches past the struct
to the method and `Cart/remove` reaches past the first impl to the second. The
nested comment at the bottom of the file hides a `decoy` the matcher never sees.

[samples/Cart.rs](./samples/Cart.rs#Cart/add)

```rust
    fn add(&mut self, x: String) {
        self.items.push(x);
    }
```

[samples/Cart.rs](./samples/Cart.rs#Cart/remove)

```rust
    fn remove(&mut self) -> Option<String> {
        self.items.pop()
    }
```

## Python — triple quotes and indentation

The docstring hides a whole `def decoy` from the matcher, and the body of `add`
is its indented block, so the selection ends where the indentation ends.

[samples/Cart.py](./samples/Cart.py#Cart/add)

```python
    def add(self, item):
        self.items.append(item)
```

## C# — a verbatim string keeps its quotes

A verbatim string escapes its quote by doubling it (`""`), so the brace inside
`@"cart ""}"" decoy"` is text, not structure.

[samples/Cart.cs](./samples/Cart.cs#Cart/Add)

```csharp
    public void Add(string item)
    {
        items.Add(item);
    }
```

## Kotlin — nested comments, raw strings

`/* /* */ */` nests in Kotlin, so the comment above `add` can swallow anything —
including a `decoy` — and a `"""` raw string is text with no escapes at all.

[samples/Cart.kt](./samples/Cart.kt#Cart/add)

```kotlin
    fun add(item: String) {
        items.add(item)
    }
```

## PHP — a heredoc is not code

The `<<<SQL` body below is data, the `}` in it is not PHP syntax, and
`#[Attribute]` — not used here — is an attribute rather than a `#` comment.

[samples/Cart.php](./samples/Cart.php#Cart/add)

```php
    public function add(string $item): string
    {
        // The heredoc body is data: the brace in it is not PHP syntax.
        $sql = <<<SQL
        insert into cart (item) values ('}') -- a decoy
        SQL;

        return $sql;
    }
```

## Ruby — def, end, and the shift operator

`def add` needs no parentheses, and its body is closed by `end`, which the
selection brings along. The `<<` in `@items << item` is an append, not a heredoc:
only `<<~TAG`, `<<-TAG` or a quoted tag opens one.

[samples/Cart.rb](./samples/Cart.rb#Cart/add)

```ruby
  def add(item)
    @items << item
  end
```

## SQL — a region, and doubled quotes

SQL has no members to search, so this example uses a region directive the way any
comment-bearing language can — and the string `'it''s a } decoy'` stays one
string, because SQL escapes a quote by doubling it.

[samples/report.sql](./samples/report.sql#monthly)

```sql
select
    date_trunc('month', placed_at) as month,
    count(*) as orders
from orders
where note <> 'it''s a } decoy'
group by 1;
```

## Shell — a heredoc is not code

The heredoc body is data: the `}` inside it is not shell syntax, and the
selection stops at the function's closing brace.

[samples/run.sh](./samples/run.sh#deploy)

```bash
deploy() {
	cat <<EOF
  } decoy
EOF
	echo "deployed"
}
```

## VB — a function and its End

VB declares with capitalised keywords and closes every block with a keyword line,
so `Add` is followed through `End Function`, and `""` doubling keeps the brace in
the string literal out of the structure.

[samples/Form.vb](./samples/Form.vb#Form/Add)

```vb
    Public Function Add(item As String) As String
        Dim note As String = "a ""}"" decoy"
        Return note
    End Function
```

## Haskell — a binding and its signature

A binding is `add x y = x + y`, and the `add ::` line above it is its annotation:
`+add` brings the signature along, and `Cart` is the record declared with `data`.

[samples/Main.hs](./samples/Main.hs#+add)

```haskell
add :: Int -> Int -> Int
add x y = x + y
```

[samples/Main.hs](./samples/Main.hs#Cart)

```haskell
data Cart = Cart { items :: [Int] }
```

## Zig — a nested comment hides a decoy

`/* outer /* inner */ still outer */` nests in Zig, so the commented-out
`fn decoy` is blanked whole; the non-nesting default mask would have leaked it.

[samples/Nesting.zig](./samples/Nesting.zig#target)

```zig
pub fn target() void {
    std.debug.print("}\n", .{});
}
```

## YAML — a key path

A `.yaml` reference is a dotted key path, rendered with the mappings that hold it
so the block is a YAML document on its own; a `#` inside a quoted value is not a
comment.

[samples/app.yaml](./samples/app.yaml#server.port)

```yaml
server:
  port: 8080
```

[samples/app.yaml](./samples/app.yaml#server.tls.enabled)

```yaml
server:
  tls:
    enabled: true
```

## TOML — a table and its key

`server.port` renders `[server]` above the key, and a value that spans lines — an
array here — comes with its continuation lines.

[samples/app.toml](./samples/app.toml#server.port)

```toml
[server]
port = 8080
```

[samples/app.toml](./samples/app.toml#server.hosts)

```toml
[server]
hosts = [
  "a.example",
  "b.example",
]
```

## INI — a section and its key

`section.key` renders the `[section]` header above the key, a bare section name
selects the whole section, and both `key = value` and `key: value` are read.

[samples/app.ini](./samples/app.ini#server.port)

```ini
[server]
port = 8080
```

[samples/app.ini](./samples/app.ini#logging)

```ini
[logging]
level = info
```

## JSON — keys

JSON renders a selection of keys as valid JSON, in the order they were named, with
nested keys and array elements addressable by dotted paths.

[samples/api.json](./samples/api.json#name,server.port)

```json
{
  "name": "cart-api",
  "server": {
    "port": 8080
  }
}
```

