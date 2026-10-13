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
    @Deprecated
    public String toString() {
        return items.size() + " item(s)";
    }
```

`#toString/++` goes on up to the doc comment above them.

[samples/Inventory.java#toString/++](./samples/Inventory.java#toString/++)

```java
    /** Summarise the inventory. */
    @Deprecated
    public String toString() {
        return items.size() + " item(s)";
    }
```

## A nested declaration

A name can be a path: the segments before the last are scopes to search inside, and only the last one selects. `Inventory/Item/render` is the `render` method of `Item`, the class nested in `Inventory`.

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

A block is also named by a string it tests — a statement whose header carries the name as a double-quoted literal. `dispatch/count` is the `if ("count".equals(methodName))` block.

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

And a block may be named by the trailing comment it opens with: `legacy()` opens `public void legacy() { //count`, so `legacy/count` names the whole method.

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

    // The catalog is a region directive: the directive lines are never injected.
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
    @Deprecated
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

## One page per language

The examples are split by language, so you can go straight to the one you came for: the hamburger
menu at the top of every page carries this same list, and each page has its language's examples
beside the sample it reads.

- [Java](./languages/java.html) — paths, condition literals, anchors and line numbers
- [JavaScript / TypeScript](./languages/javascript.html) — a template that hides its braces
- [Go](./languages/go.html) — a raw string is not code
- [Rust](./languages/rust.html) — the members live in the impl
- [Python](./languages/python.html) — triple quotes, indentation, and decorators
- [C#](./languages/csharp.html) — a verbatim string keeps its quotes
- [Kotlin](./languages/kotlin.html) — nested comments, raw strings, and annotations
- [PHP](./languages/php.html) — a heredoc is not code
- [Ruby](./languages/ruby.html) — def, end, the shift operator, and `!` names
- [Shell](./languages/shell.html) — a heredoc is not code either, and regions are how a script is addressed
- [VB](./languages/vb.html) — a function and its End
- [Haskell](./languages/haskell.html) — a binding and its signature
- [Zig](./languages/zig.html) — a nested comment hides a decoy
- [YAML](./languages/yaml.html) — a key path
- [JSON](./languages/json.html) — keys and nested keys
- [TOML](./languages/toml.html) — a table and its key
- [INI](./languages/ini.html) — a section and its key
- [CSS](./languages/css.html) — a rule, an at-rule, and the nesting between

Every page reads the same [samples/](./samples) directory and works the same way: click an example
link, and the description below it opens while the middle and right columns show the lines the
reference selects and where the injection lands in the rendered Markdown.

## Java: a path into the file

A path is how a reference descends: `#Inventory/Item` is the `Item` class nested in `Inventory`, and the segments before the last are scopes to search while only the last one selects. The overview shows the longer form, `Inventory/Item/render`, which is a method of that nested class.

[samples/Inventory.java#Inventory/Item](./samples/Inventory.java#Inventory/Item)

```java
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
```

## Java: line numbers, and several pieces at once

A reference may name lines instead of a block: `#L8-L14` is a range, and `#L7,toString/++,L50` mixes a line, a declaration and a line — injected in the order they were written.

[samples/Inventory.java#L8-L14](./samples/Inventory.java#L8-L14)

```java

    // The catalog is a region directive: the directive lines are never injected.
    // #region catalog
    /** The catalog, kept as an explicit region directive. */
    static final String[] CATALOG = { "bolt", "nut", "washer" };
    // #endregion

```

[samples/Inventory.java#L7,toString/++,L50](./samples/Inventory.java#L7,toString/++,L50)

```java
public class Inventory {
    /** Summarise the inventory. */
    @Deprecated
    public String toString() {
        return items.size() + " item(s)";
    }
    }
```


## Java: an envelope around a member

A method copied out of a class reads as a fragment — indented under nothing, with no sign of the type it belongs to. An **envelope** is that type's own first and last lines, taken verbatim around the member: `^` is the head (the declaration line through the line its body opens on) and `$` is the tail (the line the block ends on). The parent is named once, on either mark, and everything between them is read inside it — so `#Inventory/^,toString,$` is the class's opening line, the whole `toString` method, and the class's closing brace.

The long form says the same thing with the parent on every selector, and takes byte for byte the same text.

[samples/Inventory.java#Inventory/^,toString,$](./samples/Inventory.java#Inventory/^,toString,$)

```java
public class Inventory {
    public String toString() {
        return items.size() + " item(s)";
    }
}
```

[samples/Inventory.java#Inventory/^,Inventory/toString,Inventory/$](./samples/Inventory.java#Inventory/^,Inventory/toString,Inventory/$)

```java
public class Inventory {
    public String toString() {
        return items.size() + " item(s)";
    }
}
```

The marks compose with the rest of the grammar: a modifier selects less of the member, and a line range may take its place.

[samples/Inventory.java#Inventory/^,toString/-,Inventory/$](./samples/Inventory.java#Inventory/^,toString/-,Inventory/$)

```java
public class Inventory {
        return items.size() + " item(s)";
}
```

## JavaScript: regions, declarations and modifiers

A class member is named directly: `#render/-` is the body without the signature, and `#render/+` brings the `@deprecated` annotation along. A static field is addressed by the region directive around it, because a field is a statement rather than a block.

[samples/cart.js#catalog](./samples/cart.js#catalog)

```javascript
    static catalog = ['bolt', 'nut', 'washer'];
```

[samples/cart.js#render](./samples/cart.js#render)

```javascript
    render() {
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
    }
```

[samples/cart.js#render/-](./samples/cart.js#render/-)

```javascript
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
```

[samples/cart.js#render/+](./samples/cart.js#render/+)

```javascript
    @deprecated
    render() {
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
    }
```

[samples/cart.js#add](./samples/cart.js#add)

```javascript
    add(item) {
        this.items.push(item);
    }
```

[samples/cart.js#add/-](./samples/cart.js#add/-)

```javascript
        this.items.push(item);
```

## JavaScript: a template, a condition and an anchor

A path descends into the class, and a template literal that spans lines hides its braces from the matcher — the body of `render` is found *through* it. A condition literal names the `if` whose header tests it, and a trailing comment names the block it opens: `count/count` is the `count()` method that opens with `//count`.

[samples/cart.js#Cart/render](./samples/cart.js#Cart/render)

```javascript
    render() {
        return `cart (${this.items.length}): ${this.items.map((item) => `{${item}}`).join(', ')}`;
    }
```

[samples/cart.js#dispatch/count](./samples/cart.js#dispatch/count)

```javascript
        if (methodName == "count") {
            return this.items.length;
        }
```

[samples/cart.js#count/count](./samples/cart.js#count/count)

```javascript
    count() { //count
        return this.items.length;
    }
```

## Go: regions and declarations

A package-level variable is named by the region directive around it — a region is how a value that is not a declaration stays addressable. `#Add` names a function by name, and the raw string below it is data: the decoy inside it is invisible to the matcher.

[samples/Cart.go#catalog](./samples/Cart.go#catalog)

```go
var Catalog = []string{"bolt", "nut", "washer"}
```

[samples/Cart.go#Add](./samples/Cart.go#Add)

```go
func Add(items []string, item string) []string {
	return append(items, item)
}
```

[samples/Cart.go#Add/-](./samples/Cart.go#Add/-)

```go
	return append(items, item)
```

## Go: a switch literal and a trailing comment

A function body is a scope, so a `case` arm is named from inside it — by the literal the switch tests, because an arm is not a block of its own. A trailing comment names the function it opens.

[samples/Cart.go#Dispatch/count](./samples/Cart.go#Dispatch/count)

```go
	switch "count" {
	case methodName:
		return len(Catalog)
	}
```

[samples/Cart.go#Legacy/count](./samples/Cart.go#Legacy/count)

```go
func Legacy() { //count
	println(len(Catalog))
}
```

## Rust: regions and the impls

A constant is named by the region directive around it, and `#Cart/add` reaches a method where Rust keeps it — inside an `impl` block, which the path treats as a scope named after the type. `#dispatch/+` brings the attribute above the method along.

[samples/Cart.rs#catalog](./samples/Cart.rs#catalog)

```rust
/// The catalog the shop stocks.
pub const CATALOG: [&str; 3] = ["bolt", "nut", "washer"];
```

[samples/Cart.rs#add](./samples/Cart.rs#add)

```rust
    fn add(&mut self, x: String) {
        self.items.push(x);
    }
```

[samples/Cart.rs#add/-](./samples/Cart.rs#add/-)

```rust
        self.items.push(x);
```

[samples/Cart.rs#dispatch/+](./samples/Cart.rs#dispatch/+)

```rust
    #[allow(dead_code)]
    pub fn dispatch(&mut self, method_name: &str) -> Option<usize> {
        if method_name == "count" {
            return Some(self.items.len());
        }
        None
    }
```

## Rust: two impls, a literal and an anchor

A type may be `impl`-ed several times, and the path retries each of them: `Cart/remove` is in the second one. Inside a method, a condition literal names the arm it compares against, and a trailing comment anchors the block.

[samples/Cart.rs#remove](./samples/Cart.rs#remove)

```rust
    fn remove(&mut self) -> Option<String> {
        self.items.pop()
    }
```

[samples/Cart.rs#dispatch/count](./samples/Cart.rs#dispatch/count)

```rust
        if method_name == "count" {
            return Some(self.items.len());
        }
```

[samples/Cart.rs#legacy/count](./samples/Cart.rs#legacy/count)

```rust
    fn legacy(&mut self) -> usize { //count
        self.items.len()
    }
```

## Python: regions, defs and decorators

A method body is the indented block under its `def`, so the selection ends where the indentation ends, and the `@property` decorator above `catalog` is what the `+` modifier brings along. A class attribute is named by the region directive around it.

[samples/Cart.py#catalog](./samples/Cart.py#catalog)

```python
    CATALOG = ["bolt", "nut", "washer"]
```

[samples/Cart.py#add](./samples/Cart.py#add)

```python
    def add(self, item):
        self.items.append(item)
```

[samples/Cart.py#add/-](./samples/Cart.py#add/-)

```python
        self.items.append(item)
```

[samples/Cart.py#add/+](./samples/Cart.py#add/+)

```python
    def add(self, item):
        self.items.append(item)
```

## Python: an indented condition and an anchor

The triple-quoted docstring hides a whole `def decoy` from the matcher. Inside a method, a condition literal names the indented `if` it tests, and a trailing comment names the block it opens.

[samples/Cart.py#dispatch/count](./samples/Cart.py#dispatch/count)

```python
        if method_name == "count":
            return len(self.items)
```

[samples/Cart.py#legacy/count](./samples/Cart.py#legacy/count)

```python
    def legacy(self):  #count
        return len(self.items)
```

## C#: regions and declarations

A static array is named by its region directive, and a method by its name: `Add/-` is the body without the signature, `Add/+` the method with its attribute, `Add/++` those and the doc comment above them. A verbatim string keeps its quotes, so the brace inside it is text.

[samples/Cart.cs#catalog](./samples/Cart.cs#catalog)

```csharp
    private static readonly string[] Catalog = { "bolt", "nut", "washer" };
```

[samples/Cart.cs#Add](./samples/Cart.cs#Add)

```csharp
    public void Add(string item)
    {
        items.Add(item);
    }
```

[samples/Cart.cs#Add/-](./samples/Cart.cs#Add/-)

```csharp
        items.Add(item);
```

[samples/Cart.cs#Add/+](./samples/Cart.cs#Add/+)

```csharp
    public void Add(string item)
    {
        items.Add(item);
    }
```

[samples/Cart.cs#Add/++](./samples/Cart.cs#Add/++)

```csharp
    /// <summary>Add one item to the cart.</summary>
    public void Add(string item)
    {
        items.Add(item);
    }
```

## C#: a condition and an anchor

A condition literal names the block whose header line carries the string it tests, and a trailing comment on the declaration line names the block below it.

[samples/Cart.cs#Dispatch/count](./samples/Cart.cs#Dispatch/count)

```csharp
        if (methodName == "count")
        {
            return items.Count;
        }
```

[samples/Cart.cs#Legacy/count](./samples/Cart.cs#Legacy/count)

```csharp
    public void Legacy() //count
    {
        System.Console.WriteLine(items.Count);
    }
```

## Kotlin: regions and declarations

A nested block comment swallows the decoy beside it and a raw string is text with no escapes at all, so neither can be mistaken for structure. `#add/+` brings the `@Deprecated` annotation along, and `#catalog` names the list by its region directive.

[samples/Cart.kt#catalog](./samples/Cart.kt#catalog)

```kotlin
    val catalog = listOf("bolt", "nut", "washer")
```

[samples/Cart.kt#add](./samples/Cart.kt#add)

```kotlin
    fun add(item: String) {
        items.add(item)
    }
```

[samples/Cart.kt#add/-](./samples/Cart.kt#add/-)

```kotlin
        items.add(item)
```

[samples/Cart.kt#add/+](./samples/Cart.kt#add/+)

```kotlin
    @Deprecated("use add")
    fun add(item: String) {
        items.add(item)
    }
```

## Kotlin: a condition and an anchor

A condition literal names the `if` that tests it, and a trailing comment names the function it opens.

[samples/Cart.kt#dispatch/count](./samples/Cart.kt#dispatch/count)

```kotlin
        if (methodName == "count") {
            println(catalog.size)
        }
```

[samples/Cart.kt#legacy/count](./samples/Cart.kt#legacy/count)

```kotlin
    fun legacy() { //count
        println(catalog.size)
    }
```

## PHP: regions and declarations

A class constant is named by its region directive. The heredoc body inside `add` is data — the `}` in it is not PHP syntax — so the method is still found whole, and `#add/-` is that body without the signature.

[samples/Cart.php#catalog](./samples/Cart.php#catalog)

```php
    public const CATALOG = ['bolt', 'nut', 'washer'];
```

[samples/Cart.php#add](./samples/Cart.php#add)

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

[samples/Cart.php#add/-](./samples/Cart.php#add/-)

```php
        // The heredoc body is data: the brace in it is not PHP syntax.
        $sql = <<<SQL
        insert into cart (item) values ('}') -- a decoy
        SQL;

        return $sql;
```

## PHP: a condition and an anchor

A condition literal names the `if` whose header carries the string, and a trailing comment on the signature names the method below it.

[samples/Cart.php#dispatch/count](./samples/Cart.php#dispatch/count)

```php
        if ($methodName == "count") {
            return count(self::CATALOG);
        }
```

[samples/Cart.php#legacy/count](./samples/Cart.php#legacy/count)

```php
    public function legacy() //count
    {
        return count(self::CATALOG);
    }
```

## Ruby: regions, defs and end

`def add` needs no parentheses, and its body is closed by `end`, which the selection brings along. The `<<` in `@items << item` is an append and not a heredoc; only `<<~TAG`, `<<-TAG` or a quoted tag opens one. A name may end in `!` or `?`, and that is part of the name, not a modifier.

[samples/Cart.rb#catalog](./samples/Cart.rb#catalog)

```ruby
  CATALOG = %w[bolt nut washer].freeze
```

[samples/Cart.rb#add!](./samples/Cart.rb#add!)

```ruby
  def add!(item)
    @items << item
  end
```

[samples/Cart.rb#add](./samples/Cart.rb#add)

```ruby
  def add(item)
    @items << item
  end
```

[samples/Cart.rb#add/-](./samples/Cart.rb#add/-)

```ruby
    @items << item
```

## Ruby: a condition and an anchor

A condition literal names the `if` or `elsif` whose header carries the string, and a trailing comment names the method it opens. A `case` is not a block here, so `when` arms are named by the region or the method around them.

[samples/Cart.rb#dispatch/count](./samples/Cart.rb#dispatch/count)

```ruby
    if method_name == "count"
      @items.size
```

[samples/Cart.rb#legacy/count](./samples/Cart.rb#legacy/count)

```ruby
  def legacy # count
    @items.size
  end
```

## Shell: regions and functions

A shell script has no members to name, so regions are how its settings and its helpers stay addressable: `#config` is the settings and `#count` is the helper. A `case` arm is an arm rather than a block, so `count` is named by the region around it and not by the literal it matches.

[samples/run.sh#config](./samples/run.sh#config)

```bash
# A shell script has no members to name, so a region is how its settings stay
# addressable — and the directive lines are never injected.
CATALOG="bolt nut washer"
HOST="localhost"
```

[samples/run.sh#count](./samples/run.sh#count)

```bash
count() {
	echo "$CATALOG" | wc -w
}
```

[samples/run.sh#deploy](./samples/run.sh#deploy)

```bash
deploy() {
	cat <<EOF
  } decoy
EOF
	echo "deployed"
}
```

[samples/run.sh#deploy/-](./samples/run.sh#deploy/-)

```bash
	cat <<EOF
  } decoy
EOF
	echo "deployed"
```

## Shell: a heredoc and an anchor

The heredoc body is data: the brace in it is not shell syntax, and the selection stops at the function’s closing brace. A trailing comment names the function it opens.

[samples/run.sh#legacy/count](./samples/run.sh#legacy/count)

```bash
legacy() { # count
	echo "$CATALOG" | wc -w
}
```

## VB: regions and declarations

VB declares with capitalised keywords and closes every block with a keyword line, so `Add` is followed through `End Function`. The `+` modifier takes the declaration with the annotation above it, and `""` doubling keeps the brace in the string literal out of the structure. A shared array is named by its region directive.

[samples/Form.vb#catalog](./samples/Form.vb#catalog)

```vb
    Private Shared ReadOnly CatalogList As String() = {"bolt", "nut", "washer"}
```

[samples/Form.vb#Add](./samples/Form.vb#Add)

```vb
    Public Function Add(item As String) As String
        Dim note As String = "a ""}"" decoy"
        Return note
    End Function
```

[samples/Form.vb#Add/-](./samples/Form.vb#Add/-)

```vb
        Dim note As String = "a ""}"" decoy"
        Return note
```

[samples/Form.vb#Dispatch/+](./samples/Form.vb#Dispatch/+)

```vb
    Public Function Dispatch(methodName As String) As Boolean
        If methodName = "count" Then
            Return CatalogList.Length > 0
        End If
        Return False
    End Function
```

## VB: an anchor

VB writes an equality test with the same `=` an assignment uses, so an `If methodName = "count" Then` header is not addressable as a condition literal here; a trailing comment on the declaration line names the function below it.

[samples/Form.vb#Legacy/count](./samples/Form.vb#Legacy/count)

```vb
    Public Function Legacy() As Boolean 'count
        Return CatalogList.Length > 0
    End Function
```

## Haskell: bindings and signatures

A binding is `add x y = x + y`, and the `add ::` line above it is its annotation: `+add` brings the signature along. `#catalog` is a binding named by its region directive, and `Cart` is the record declared with `data`.

[samples/Main.hs#catalog](./samples/Main.hs#catalog)

```haskell
catalog :: [String]
catalog = ["bolt", "nut", "washer"]

```

[samples/Main.hs#add](./samples/Main.hs#add)

```haskell
add x y = x + y
```

[samples/Main.hs#add/+](./samples/Main.hs#add/+)

```haskell
add :: Int -> Int -> Int
add x y = x + y
```

[samples/Main.hs#Cart](./samples/Main.hs#Cart)

```haskell
data Cart = Cart { items :: [Int] }
```

## Haskell: a condition in a binding

A binding’s body may be an `if`, and the literal it tests names the binding: `dispatch` is that binding and `+dispatch` brings the signature above it along. A comment before a binding is prose rather than an anchor, and its `case` is an expression rather than a block whose arms could be named.

[samples/Main.hs#dispatch](./samples/Main.hs#dispatch)

```haskell
dispatch methodName items = if methodName == "count" then items else []
```

[samples/Main.hs#dispatch/+](./samples/Main.hs#dispatch/+)

```haskell
dispatch :: String -> [Int] -> [Int]
dispatch methodName items = if methodName == "count" then items else []
```

## Zig: regions and declarations

A `const` array is named by its region directive, and `#target` names a function whose body prints a brace — which the matcher reads as text inside a string, not as structure.

[samples/Nesting.zig#catalog](./samples/Nesting.zig#catalog)

```zig
const catalog = [_][]const u8{ "bolt", "nut", "washer" };
```

[samples/Nesting.zig#target](./samples/Nesting.zig#target)

```zig
pub fn target() void {
    std.debug.print("}\n", .{});
}
```

[samples/Nesting.zig#target/-](./samples/Nesting.zig#target/-)

```zig
    std.debug.print("}\n", .{});
```

## Zig: a nested comment, a switch and an anchor

A nested block comment hides the decoy below it, so the commented-out `fn decoy` is blanked whole. A `switch` arm is not a block of its own, so the literal a `case` compares against is not addressable here — `count/-` takes the body of that function instead — and a trailing comment names the function it opens.

[samples/Nesting.zig#count/-](./samples/Nesting.zig#count/-)

```zig
    switch (methodName.len) {
        "count".len => return catalog.len,
        else => return 0,
    }
```

[samples/Nesting.zig#legacy/old](./samples/Nesting.zig#legacy/old)

```zig
pub fn legacy() usize { //old
    return catalog.len;
}
```

## YAML: a key path

A `.yaml` reference is a key path, spelled with the same `/` separator a code reference uses, rendered with the mappings that hold it so the block is a YAML document on its own; a `#` inside a quoted value is not a comment.

[samples/app.yaml#server/port](./samples/app.yaml#server/port)

```yaml
server:
  port: 8080
```

[samples/app.yaml#server/tls/enabled](./samples/app.yaml#server/tls/enabled)

```yaml
server:
  tls:
    enabled: true
```

## YAML: several keys at once

A comma puts several keys in one reference, and they are rendered in the order they were named — here a key from one mapping and one from another.

[samples/app.yaml#service,logging/level](./samples/app.yaml#service,logging/level)

```yaml
service: cart
logging:
  level: info
```

## JSON: keys

JSON renders a selection of keys as valid JSON, in the order they were named, with nested keys addressable by `/` — the same separator a code reference uses.

[samples/api.json#name,server/port](./samples/api.json#name,server/port)

```json
{
  "name": "cart-api",
  "server": {
    "port": 8080
  }
}
```

[samples/api.json#server/cors](./samples/api.json#server/cors)

```json
{
  "server": {
    "cors": [
      "https://a.example"
    ]
  }
}
```

## JSON: a nested key

A key nested one level down is more segments, and the rendered block keeps the braces that make it valid JSON.

[samples/api.json#server/enabled](./samples/api.json#server/enabled)

```json
{
  "server": {
    "enabled": true
  }
}
```

## TOML: tables and keys

`server/port` renders `[server]` above the key, so the selection is valid TOML on its own. `#server` takes the whole table, and a value that spans lines — an array here — comes with its continuation lines.

[samples/app.toml#server/port](./samples/app.toml#server/port)

```toml
[server]
port = 8080
```

[samples/app.toml#server](./samples/app.toml#server)

```toml
[server]
host = "localhost"
port = 8080
hosts = [
  "a.example",
  "b.example",
]
```

[samples/app.toml#server/hosts](./samples/app.toml#server/hosts)

```toml
[server]
hosts = [
  "a.example",
  "b.example",
]
```

## TOML: nested tables

A table may hold another table, and the path descends into it: `server/tls/enabled` renders both headers above the key.

[samples/app.toml#server/tls/enabled](./samples/app.toml#server/tls/enabled)

```toml
[server.tls]
enabled = true
```

## INI: sections and keys

`section/key` renders the `[section]` header above the key, a bare section name selects the whole section, and both `key = value` and `key: value` are read.

[samples/app.ini#server/port](./samples/app.ini#server/port)

```ini
[server]
port = 8080
```

[samples/app.ini#logging](./samples/app.ini#logging)

```ini
[logging]
level = info
```

## INI: a leading key

A key written before any header belongs to no section, and naming it renders that key alone.

[samples/app.ini#global](./samples/app.ini#global)

```ini
global = 1
```

## CSS: rules and at-rules

A `.css` reference names a **rule**, in CSS’s own vocabulary. A style rule is named by the rightmost simple selector of its selector list, an at-rule by its keyword (`@media`, `@keyframes`), and `/` descends the nesting CSS already has — a rule inside a media query is a child of it. The `-` a code reference uses for "the declarations alone" works through a path too, so `@media/.card/-` is that inner rule’s declarations without its selector.

[samples/site.css#:root](./samples/site.css#:root)

```css
:root {
  --brand: #1f6feb;
  --radius: 6px;
}
```

[samples/site.css#@media](./samples/site.css#@media)

```css
@media (min-width: 700px) {
  .card {
    grid-template-columns: 1fr 1fr;
  }
}
```

[samples/site.css#@media/.card/-](./samples/site.css#@media/.card/-)

```css
grid-template-columns: 1fr 1fr;
```

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

## CSS: a predicate, and a region

Two rules share the name `.card` — the base rule and its compact variant — so a reference that would match both is an error rather than a guess, and `#.card` names nothing. A predicate read from the selector picks one, and a region directive still works in CSS, where a class name cannot be a region name.

[samples/site.css#.card[data-variant=compact]](./samples/site.css#.card[data-variant=compact])

```
```

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
