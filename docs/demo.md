# Keep the code samples in your Markdown honest and target code sections semantically instead of line numbers that can drift much more easily.

DEMO of what a marker target can say. Click an example link: the description below it opens, the
lines it selects are highlighted in [samples/Inventory.java](./samples/Inventory.java), and the same
injection is marked in the rendered Markdown
([source](https://github.com/hrgdavor/inject-examples/blob/main/docs/demo.md)) beside it. 
/ [GIT source](https://github.com/hrgdavor/inject-examples) / [section-matching SPEC](https://github.com/hrgdavor/inject-examples/blob/main/doc/section-matching.md)

## A named region

Wrap part of a file in `#region <name>` / `#endregion` comments and name that
region in the fragment. The directive lines themselves are never injected, and
this works with any of the comment prefixes a language uses.

[samples/Inventory.java#catalog](./samples/Inventory.java#catalog)

```java
    /** The catalog, kept as an explicit region directive. */
    static final String[] CATALOG = { "bolt", "nut", "washer" };
```

## A declaration, and how much of it comes along

When the file carries no region directive, the name is looked for as a
declaration — a method, constructor or class-like block. The declaration *is*
the region, so the file needs nothing added to it. A `-`, `+` or `++` **segment**
after the path selects how far up the text starts:

- `#toString` — the declaration: signature through closing brace.
- `#toString/-` — the body only, without the signature.
- `#toString/+` — the declaration and the annotations above it.
- `#toString/++` — those and the doc comment above them.

The modifier is the last segment of the path and nothing else, so `#toString-` is
the name `toString-` and resolves to nothing, and the old spelling says so:
`"++" is a path segment now; write "#toString/++"`.

The same method, four ways. `#toString` is the declaration alone — the signature
through its closing brace.

[samples/Inventory.java#toString](./samples/Inventory.java#toString)

```java
    public String toString() {
        return items.size() + " item(s)";
    }
```

`#toString/-` is the body without the signature.

[samples/Inventory.java#toString/-](./samples/Inventory.java#toString/-)

```java
        return items.size() + " item(s)";
```

`#toString/+` keeps the annotations the declaration carries.

[samples/Inventory.java#toString/+](./samples/Inventory.java#toString/+)

```java
    @Override
    public String toString() {
        return items.size() + " item(s)";
    }
```

`#toString/++` goes on up to the doc comment above them.

[samples/Inventory.java#toString/++](./samples/Inventory.java#toString/++)

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

[samples/Inventory.java#Inventory/Item/render](./samples/Inventory.java#Inventory/Item/render)

```java
        String render() {
            return name + " x" + quantity;
        }
```

## A condition literal

Inside a scope a segment may also match what a block *contains*: a statement
whose header carries the name as a double-quoted string. `dispatch/count`
selects the `if ("count".equals(methodName))` block, braces and all.

[samples/Inventory.java#dispatch/count](./samples/Inventory.java#dispatch/count)

```java
        if ("count".equals(methodName)) {
            System.out.println("items: " + items.size());
        }
```

## A comment anchor

A block whose opening line carries a trailing comment is named by that comment.
`legacy()` opens `public void legacy() { //count`, so `legacy/count` names the
whole method.

[samples/Inventory.java#legacy/count](./samples/Inventory.java#legacy/count)

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

## JavaScript and TypeScript — a template hides its braces

A backtick template spans lines and hides braces, so the `}` inside one is text.
The whole template is blanked before anything is counted, which is why
`Cart/render` is found *through* it rather than ending inside it, and why the
`{` of the nested `` `{${item}}` `` never opens a body. TypeScript uses the same
entry, so a `.ts` file masks exactly as a `.js` one does.

[samples/cart.js#Cart/render](./samples/cart.js#Cart/render)

```js
    render() {
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
    }
```

`Cart/add` is an ordinary method with braces of its own — the same path syntax,
and nothing about the template above it changes the answer.

[samples/cart.js#Cart/add](./samples/cart.js#Cart/add)

```js
    add(item) {
        this.items.push(item);
    }
```

## Go — a raw string is not code

`Add` is found through the braces, while the backtick raw string below it — which
contains a whole `Decoy` function — is blanked before anything is counted, so it
can never be mistaken for a member.

[samples/Cart.go#Add](./samples/Cart.go#Add)

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

[samples/Cart.rs#Cart/add](./samples/Cart.rs#Cart/add)

```rust
    fn add(&mut self, x: String) {
        self.items.push(x);
    }
```

`Cart/remove` is in the *second* impl block, and the path still reaches it: the
segments before the last are scopes, and a scope may be spelled more than once.

[samples/Cart.rs#Cart/remove](./samples/Cart.rs#Cart/remove)

```rust
    fn remove(&mut self) -> Option<String> {
        self.items.pop()
    }
```

## Python — triple quotes and indentation

The docstring hides a whole `def decoy` from the matcher, and the body of `add`
is its indented block, so the selection ends where the indentation ends.

[samples/Cart.py#Cart/add](./samples/Cart.py#Cart/add)

```python
    def add(self, item):
        self.items.append(item)
```

## C# — a verbatim string keeps its quotes

A verbatim string escapes its quote by doubling it (`""`), so the brace inside
`@"cart ""}"" decoy"` is text, not structure.

[samples/Cart.cs#Cart/Add](./samples/Cart.cs#Cart/Add)

```csharp
    public void Add(string item)
    {
        items.Add(item);
    }
```

## Kotlin — nested comments, raw strings

`/* /* */ */` nests in Kotlin, so the comment above `add` can swallow anything —
including a `decoy` — and a `"""` raw string is text with no escapes at all.

[samples/Cart.kt#Cart/add](./samples/Cart.kt#Cart/add)

```kotlin
    fun add(item: String) {
        items.add(item)
    }
```

## PHP — a heredoc is not code

The `<<<SQL` body below is data, the `}` in it is not PHP syntax, and
`#[Attribute]` — not used here — is an attribute rather than a `#` comment.

[samples/Cart.php#Cart/add](./samples/Cart.php#Cart/add)

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

[samples/Cart.rb#Cart/add](./samples/Cart.rb#Cart/add)

```ruby
  def add(item)
    @items << item
  end
```

## SQL — a region, and doubled quotes

SQL has no members to search, so this example uses a region directive the way any
comment-bearing language can — and the string `'it''s a } decoy'` stays one
string, because SQL escapes a quote by doubling it.

[samples/report.sql#monthly](./samples/report.sql#monthly)

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

[samples/run.sh#deploy](./samples/run.sh#deploy)

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

[samples/Form.vb#Form/Add](./samples/Form.vb#Form/Add)

```vb
    Public Function Add(item As String) As String
        Dim note As String = "a ""}"" decoy"
        Return note
    End Function
```

## Haskell — a binding and its signature

A binding is `add x y = x + y`, and the `add ::` line above it is its annotation:
`+add` brings the signature along, and `Cart` is the record declared with `data`.

[samples/Main.hs#add/+](./samples/Main.hs#add/+)

```haskell
add :: Int -> Int -> Int
add x y = x + y
```

A record declared with `data` is named by the type it declares, so `Cart` is the
whole declaration:

[samples/Main.hs#Cart](./samples/Main.hs#Cart)

```haskell
data Cart = Cart { items :: [Int] }
```

## Zig — a nested comment hides a decoy

`/* outer /* inner */ still outer */` nests in Zig, so the commented-out
`fn decoy` is blanked whole; the non-nesting default mask would have leaked it.

[samples/Nesting.zig#target](./samples/Nesting.zig#target)

```zig
pub fn target() void {
    std.debug.print("}\n", .{});
}
```

## YAML — a key path

A `.yaml` reference is a key path, spelled with the same `/` separator a code
reference uses, rendered with the mappings that hold it so the block is a YAML
document on its own; a `#` inside a quoted value is not a comment.

[samples/app.yaml#server/port](./samples/app.yaml#server/port)

```yaml
server:
  port: 8080
```

A nested key is more segments, and the rendered block carries every mapping above
it — `server` and `tls` — so the YAML stays valid on its own:

[samples/app.yaml#server/tls/enabled](./samples/app.yaml#server/tls/enabled)

```yaml
server:
  tls:
    enabled: true
```

## TOML — a table and its key

`server/port` renders `[server]` above the key, and a value that spans lines — an
array here — comes with its continuation lines.

[samples/app.toml#server/port](./samples/app.toml#server/port)

```toml
[server]
port = 8080
```

A value that spans lines — an array here — comes with its continuation lines, so
the selection is still valid TOML:

[samples/app.toml#server/hosts](./samples/app.toml#server/hosts)

```toml
[server]
hosts = [
  "a.example",
  "b.example",
]
```

## INI — a section and its key

`section/key` renders the `[section]` header above the key, a bare section name
selects the whole section, and both `key = value` and `key: value` are read.

[samples/app.ini#server/port](./samples/app.ini#server/port)

```ini
[server]
port = 8080
```

A bare section name selects the whole section, `[logging]` and its keys:

[samples/app.ini#logging](./samples/app.ini#logging)

```ini
[logging]
level = info
```

## CSS — a rule, an at-rule, and the nesting between

A `.css` reference names a **rule**, in CSS's own vocabulary. A style rule is
named by the rightmost simple selector of its selector list (`.card`), and an
at-rule by its keyword (`@media`, `@keyframes`). The `-` a code reference uses
for "the body only" works here too, so `.card-` is a rule's declarations
without its selector.

The design tokens, addressed by the pseudo-class that holds them:

[samples/site.css#:root](./samples/site.css#:root)

```css
:root {
  --brand: #1f6feb;
  --radius: 6px;
}
```

A class, and a variant of that same class — the compact one is reached by a
predicate read from the selector, because two rules may share a name:

[samples/site.css#.card[data-variant=compact]](./samples/site.css#.card[data-variant=compact])

```css
.card[data-variant="compact"] {
  gap: 2px;
  padding: 4px;
}
```

The media query, whole — an at-rule is named by its keyword:

[samples/site.css#@media](./samples/site.css#@media)

```css
@media (min-width: 700px) {
  .card {
    grid-template-columns: 1fr 1fr;
  }
}
```

Its nesting is the path, so the rule inside the media query is reached as a child
of the at-rule:

[samples/site.css#@media/.card/-](./samples/site.css#@media/.card/-)

```css
grid-template-columns: 1fr 1fr;
```

An at-rule with a name of its own — `@keyframes:pulse` names one animation,
`@keyframes` alone would be an error here because the file has two:

[samples/site.css#@keyframes:pulse](./samples/site.css#@keyframes:pulse)

```css
@keyframes pulse {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
```

A region directive still works in CSS, and a class name cannot be a region
name, so the two never collide:

[samples/site.css#pulse](./samples/site.css#pulse)

```css
@keyframes pulse {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
```

## Line numbers, and several pieces at once

A reference may name lines directly instead of a block, which is the tool for a
file whose structure the matchers cannot see — a config fragment, a log, a table
in a comment. `#L<line>` is one line, `#L<line>:<column>` starts at a column, and
`#L40-L44` / `#L40:12-L44:3` are ranges; lines and columns are counted from 1 and
the two ends are inclusive, exactly as an editor shows them.

`Inventory.java` lines 8-14 are the blank line under the class header and the
field below the `catalog` region:

[samples/Inventory.java#L8-L14](./samples/Inventory.java#L8-L14)

```java

    // #region catalog
    /** The catalog, kept as an explicit region directive. */
    static final String[] CATALOG = { "bolt", "nut", "washer" };
    // #endregion

    private final List<Item> items = new ArrayList<>();
```

A comma puts several selectors in one reference, and the pieces are injected in
the order they were written — a semantic name and a line range mix freely. The
class opening, then the documented `toString` and its body, then the last line of
the file. The middle column highlights each piece on its own, so the lines
between them stay unlit — a click lands on the two places the reference names,
not on everything between:

[samples/Inventory.java#L7,toString/++,L50](./samples/Inventory.java#L7,toString/++,L50)

```java
public class Inventory {
    /** Summarise the inventory. */
    @Override
    public String toString() {
        return items.size() + " item(s)";
    }
}
```

## JSON — keys

JSON renders a selection of keys as valid JSON, in the order they were named, with
nested keys and array elements addressable by `/` — the same separator a code
reference uses.

[samples/api.json#name,server/port](./samples/api.json#name,server/port)

```json
{
  "name": "cart-api",
  "server": {
    "port": 8080
  }
}
```

