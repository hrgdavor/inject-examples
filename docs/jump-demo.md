# Jumping to a code section

A reference is a **destination**. This page is about where a reader arrives — the line a jump selects — and what happens when the code it named has moved. Nothing is copied into this page: the samples stay in their own files, and every link below moves a cursor instead of embedding text.

Click a reference and the file beside it scrolls to the line that reference selects. That one line is highlighted; the rest of the file is there for context, exactly as an editor would show it.

The same reference syntax also keeps code samples honest. That is the other demo — this one is about navigation.

## A jump lands on one line

A jump is not a copy. Clicking a reference moves the cursor to the **first line** of what it selected, and that is all a reader needs: the code stays where it is, in the file that owns it.

So a reference that covers a whole method puts the cursor on the method — not on every line of its body. Compare `#toString` with `#toString/-`: the same method, but the second asks for its body, and a body starts one line later.

[samples/Inventory.java#toString](./samples/Inventory.java#toString)

the declaration

[samples/Inventory.java#toString/-](./samples/Inventory.java#toString/-)

its body

[samples/Inventory.java#toString/++](./samples/Inventory.java#toString/++)

and the annotation above it

## A region lands inside it

A `#region` directive marks a stretch of a file without naming a construct, which is what makes it useful for code that has no nameable member. The directive lines are not part of the selection, so the cursor goes to the first line **inside** the region.

[samples/Inventory.java#catalog](./samples/Inventory.java#catalog)

the first line the directives wrap

## An envelope lands on the declaration that holds the member

A member copied out of its type reads as a fragment. The marks `^` and `$` name the type itself, so the head of an envelope is the type's **declaration line** — which is where a reader lands when they jump to the envelope: at the declaration that gives the member its place.

[samples/Cart.rs#Cart/^,add,$](./samples/Cart.rs#Cart/^,add,$)

the impl that holds add

## When the exact block is gone

Code moves. A reference can outlive the name it mentions, and the mapper never guesses: it answers with the exact line or it fails, and the failure says what it looked for.

What makes that survivable is the **deepest prefix that still resolves**. If `render` is renamed, `#Inventory/Item/render` can still land a reader on `Item` — one keystroke from the new name — instead of dropping them at the top of the file.

[samples/Inventory.java#Inventory/Item/render](./samples/Inventory.java#Inventory/Item/render)

names the member inside the class

## When two blocks answer to one name

Some names are not unique. `Cart` answers to both a Rust type and its `impl` blocks, so a bare `#Cart` does not say which one a reader wants — and the mapper refuses to pick for them.

The refusal is the information: it names the candidates. A reference that does choose — `#Cart/add` — says which holder it means, and that is the one the cursor goes to.

[samples/Cart.rs#Cart/add](./samples/Cart.rs#Cart/add)

the member, in the impl that holds it

[samples/Cart.rs#Cart/remove](./samples/Cart.rs#Cart/remove)

and its sibling

## Java: a declaration and the member nested in it

A path descends, and only the last segment selects. `#Inventory/Item/render` therefore lands on `render`, not on the nested class that contains it.

[samples/Inventory.java#Inventory/Item](./samples/Inventory.java#Inventory/Item)

the nested class

[samples/Inventory.java#Inventory/Item/render](./samples/Inventory.java#Inventory/Item/render)

a method of that class

## Java: a modifier moves the landing line

A modifier decides how much of the declaration is selected, and so decides the line: `/++` includes the annotated header, the plain name starts at the declaration, `/-` starts at the body.

[samples/Inventory.java#toString/++](./samples/Inventory.java#toString/++)

the annotation and the declaration

[samples/Inventory.java#toString](./samples/Inventory.java#toString)

just the declaration

[samples/Inventory.java#toString/-](./samples/Inventory.java#toString/-)

just the body

## JavaScript: a member, its body and its annotation

The same three landings in a class whose braces a template literal could confuse: the lexer keeps a `{` inside a string from ending the block early, so the jump is still the method.

[samples/cart.js#render/+](./samples/cart.js#render/+)

the deprecated annotation

[samples/cart.js#render](./samples/cart.js#render)

the method

[samples/cart.js#render/-](./samples/cart.js#render/-)

and its body

## Go: a function and a switch literal

Go declares its members at the top level, so there is no nesting to descend and a function name is enough. A raw string is not code, so a name written inside one is never a landing place.

[samples/Cart.go#Add](./samples/Cart.go#Add)

a function

[samples/Cart.go#Dispatch](./samples/Cart.go#Dispatch)

and the one that tests a literal

## Rust: a member two impls answer to

A type and its `impl` blocks all answer to the type's name, which is exactly why a path is worth writing: `#Cart/add` says which holder is meant, and the cursor goes to `add` inside that impl.

[samples/Cart.rs#Cart/add](./samples/Cart.rs#Cart/add)

the member in its impl

[samples/Cart.rs#add/-](./samples/Cart.rs#add/-)

its body

## Rust: the envelope names the impl

The marks retry the candidates a name answers to, so `#Cart/^,add,$` is not ambiguous: the member between the marks decides, and the jump lands on that `impl`'s own first line.

[samples/Cart.rs#Cart/^,add,$](./samples/Cart.rs#Cart/^,add,$)

the impl that holds add

## Python: an indented method and its class

An indented block has no brace to end it, so the mapper reads indentation instead — and a jump into one still lands on the line the `def` is written on.

[samples/Cart.py#Cart](./samples/Cart.py#Cart)

the class

[samples/Cart.py#Cart/total](./samples/Cart.py#Cart/total)

a method inside it

[samples/Cart.py#Cart/total/-](./samples/Cart.py#Cart/total/-)

and its body

## C#: a method and its body

A method lands on its signature; a modifier on the same method lands inside it. A verbatim string with a brace in it does not end the block.

[samples/Cart.cs#Cart/Add](./samples/Cart.cs#Cart/Add)

the method

[samples/Cart.cs#Cart/Add/-](./samples/Cart.cs#Cart/Add/-)

its body

## Kotlin: a fun and its body

A `fun` is a declaration like any other, and a wrapped parameter list belongs to the signature — so the cursor stays on the first line of the declaration.

[samples/Cart.kt#Cart/add](./samples/Cart.kt#Cart/add)

the fun

[samples/Cart.kt#Cart/add/-](./samples/Cart.kt#Cart/add/-)

its body

## PHP: a method and its heredoc

A heredoc body is data, so a name inside one is invisible to the mapper. The method itself lands on its declaration, and a method is addressed through the class that holds it.

[samples/Cart.php#Cart/add](./samples/Cart.php#Cart/add)

the method

[samples/Cart.php#Cart/add/-](./samples/Cart.php#Cart/add/-)

its body

## Ruby: a def and the end that closes it

A `def` runs to the `end` that closes it, and the word `end` is what the matcher follows — so the selection is the whole method while the jump is its first line.

[samples/Cart.rb#Cart](./samples/Cart.rb#Cart)

the class

[samples/Cart.rb#Cart/add](./samples/Cart.rb#Cart/add)

a method

[samples/Cart.rb#Cart/add/-](./samples/Cart.rb#Cart/add/-)

its body

## Shell: a function and the region around it

A script has no classes, so a region is how settings stay addressable, and a function is addressed by its own name. A heredoc is data, and the brace inside it does not open a block.

[samples/run.sh#count](./samples/run.sh#count)

a region

[samples/run.sh#deploy](./samples/run.sh#deploy)

a function

[samples/run.sh#legacy](./samples/run.sh#legacy)

a function anchored by a trailing comment

## VB: a function and its End

A `Function` closes at `End Function`, and the member is addressed through the class. A function that tests a literal is named by the line that tests it.

[samples/Form.vb#Form/Add](./samples/Form.vb#Form/Add)

the function

[samples/Form.vb#Form/Add/-](./samples/Form.vb#Form/Add/-)

its body

[samples/Form.vb#Form/Dispatch](./samples/Form.vb#Form/Dispatch)

and the one that tests a literal

## Haskell: a binding and its signature

A binding lands on its own line, and `+` brings the `name ::` signature above it — which is where a reader wants to be when the type is the interesting part.

[samples/Main.hs#add](./samples/Main.hs#add)

the binding

[samples/Main.hs#add/+](./samples/Main.hs#add/+)

with its signature

[samples/Main.hs#dispatch](./samples/Main.hs#dispatch)

and one that tests a literal

## Zig: a function and a region

Zig nests block comments, so a declaration written inside one is invisible to the matcher — which is what keeps a decoy from becoming the landing place.

[samples/Nesting.zig#target](./samples/Nesting.zig#target)

a function

[samples/Nesting.zig#count](./samples/Nesting.zig#count)

one that switches on a literal

[samples/Nesting.zig#catalog](./samples/Nesting.zig#catalog)

and a region

## YAML: a key path

A config reference names a key path, and a jump lands on the line that key is written on — `#server/port` goes to `port`, not to the `server` block that holds it.

[samples/app.yaml#server/port](./samples/app.yaml#server/port)

a nested key

[samples/app.yaml#server](./samples/app.yaml#server)

and the block that holds it

## TOML: a table and a key

A dotted path reads the same way in TOML: the table is where it is written, the key is the line that reads it, and a nested table is a path of its own.

[samples/app.toml#server/port](./samples/app.toml#server/port)

a key in a table

[samples/app.toml#server/tls/enabled](./samples/app.toml#server/tls/enabled)

a key in a nested table

## INI: a section and a key

A `[section]` header is a landing place of its own, and a `section.key` lands on the key's line.

[samples/app.ini#server](./samples/app.ini#server)

the section

[samples/app.ini#server/port](./samples/app.ini#server/port)

a key inside it

## JSON: a nested key

A JSON key path lands on the line the selected key is written on — the outermost key the path names, since that is where a reader has to start reading.

[samples/api.json#name](./samples/api.json#name)

a top-level key

[samples/api.json#server/port](./samples/api.json#server/port)

and a nested one

## CSS: an at-rule and a rule inside it

A rule is named by its rightmost simple selector and an at-rule by its keyword. `/` descends the nesting CSS already has, so a rule inside an at-rule is a path.

[samples/site.css#@media](./samples/site.css#@media)

the at-rule

[samples/site.css#@media/.card/-](./samples/site.css#@media/.card/-)

the declarations of a rule inside it

[samples/site.css#@keyframes:pulse](./samples/site.css#@keyframes:pulse)

and another at-rule
