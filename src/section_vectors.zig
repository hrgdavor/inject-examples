//! The conformance corpora, generated from the JavaScript implementation.
//!
//! **Generated - do not edit.** `node tools/zig-vectors.mjs` writes this file
//! from `test/vectors/section-vectors.json` and `test/vectors/lexical-vectors.json`
//! (see `tools/section-vectors.mjs` and `tools/lexical-vectors.mjs`) and the
//! fixture files the first of those resolves against; `--check` fails when the
//! committed file is stale. Every case here is one assertion in `section.zig`'s
//! conformance tests, so the port cannot drift from the JavaScript it mirrors
//! without the build failing.

const std = @import("std");

pub const Warning = struct {
    kind: enum { contradiction },
    kept: []const u8,
    dropped: []const u8,
};

pub const Case = struct {
    name: []const u8,
    input: ?[]const u8,
    reference: []const u8,
    /// The expected selection, or null when the case expects an error.
    text: ?[]const u8,
    error_message: ?[]const u8,
    warning: ?Warning,
};

/// One mask row: a source unit and the mask the JavaScript produces for it.
pub const MaskCase = struct {
    name: []const u8,
    /// null when the type has no entry, so the built-in default engine applies.
    path: ?[]const u8,
    source: []const u8,
    masked: []const u8,
};

pub const DeclaredKind = enum { class, method, property };

/// One declaration a language reports for a masked line, as `declarations(maskedLine)` does.
pub const ExpectedDeclared = struct {
    kind: DeclaredKind,
    name: []const u8,
    header_from: i64,
    body: ?[]const u8,
    end: ?[]const u8,
    line: bool,
};

/// One shape row: a masked line, and every declaration the language reports for it.
pub const ShapeCase = struct {
    name: []const u8,
    path: []const u8,
    line: []const u8,
    declared: []const ExpectedDeclared,
};

/// `test/fixtures/Anchors.java`
pub const Anchors_java =
    "package example;\r\n\r\n/** A dispatch table keyed by method name. */\r\npublic class Anchors {\r\n    /** Run one named method. */\r\n    public void dispatch(String methodName) {\r\n        if (\"getUsers\".equals(methodName)) {\r\n            System.out.println(\"users\");\r\n        } else if (\"getOrders\".equals(methodName)) {\r\n            System.out.println(\"orders\");\r\n        }\r\n    }\r\n\r\n    public void handler() { //getUsers\r\n        System.out.println(\"anchor same line\");\r\n    }\r\n\r\n    public void other() {\r\n        //getOrders\r\n        System.out.println(\"anchor next line\");\r\n    }\r\n\r\n    public void commentFromString() {\r\n        String s = \"getUsers\";\r\n        System.out.println(s);\r\n    }\r\n}\r\n";

/// `test/fixtures/Cart.rb`
pub const Cart_rb =
    "class Cart\n  def add(item)\n    @items << item\n  end\n\n  def self.build\n    new\n  end\nend\n";

/// `test/fixtures/Cart.rs`
pub const Cart_rs =
    "struct Cart {\n    items: Vec<String>,\n}\n\nimpl Cart {\n    fn add(&mut self, x: String) {\n        self.items.push(x);\n    }\n}\n\nimpl Cart {\n    fn remove(&mut self) -> Option<String> {\n        self.items.pop()\n    }\n}\n";

/// `test/fixtures/Example.java`
pub const Example_java =
    "package example;\n\nimport java.util.ArrayList;\nimport java.util.List;\n\n/** A cart of items, by name and quantity. */\npublic class Cart {\n    private final List<String> items = new ArrayList<>();\n\n    /** Add one item to this cart. */\n    @Override\n    public String toString() {\n        return String.join(\",\", items);\n    }\n\n    /** One line of a cart. */\n    public static class Line {\n        private final String name;\n        private final int quantity;\n\n        Line(String name, int quantity) {\n            this.name = name;\n            this.quantity = quantity;\n        }\n\n        String render() {\n            return name + \" x\" + quantity;\n        }\n    }\n}";

/// `test/fixtures/Form.vb`
pub const Form_vb =
    "Public Class Form\n    Public Function Add(ByVal x As Integer) As Integer\n        Return x + 1\n    End Function\n\n    Private Sub Run()\n        Console.WriteLine(\"run\")\n    End Sub\nEnd Class\n";

/// `test/fixtures/Generics.rs`
pub const Generics_rs =
    "use std::fmt::Display;\n\npub struct Cart<T> {\n    publisher: String,\n    pub_key: String,\n    items: Vec<T>,\n}\n\nimpl<T: Clone> Display for Cart<T> {\n    fn render(&self) -> String {\n        String::new()\n    }\n}\n\nimpl Cart<String> {\n    fn add(&mut self, x: String) {\n        self.items.push(x);\n    }\n}\n";

/// `test/fixtures/Nesting.zig`
pub const Nesting_zig =
    "//! A Zig file whose nested block comment hides a declaration.\nconst std = @import(\"std\");\n\n/* outer /* inner */ fn decoy() void { x(); } */\n\n/// The real target.\nfn target() void {\n    z();\n}\n";

/// `test/fixtures/Orders.sql`
pub const Orders_sql =
    "-- #region totals\nSELECT count(*) AS orders, sum(total) AS revenue FROM orders;\n-- #endregion\n\nCREATE TABLE orders (\n    id INT,\n    total INT\n);\n";

/// `test/fixtures/Prime.hs`
pub const Prime_hs =
    "module Prime where\n\nadd' :: Int -> Int\nadd' x = x + 1\n\ndata Foo' = Foo' Int\n\ndouble :: Int -> Int\ndouble x = go x\n  where\n    go y = y * 2\n\nclass Store s where\n  get :: s -> Int\n";

/// `test/fixtures/Repo.kt`
pub const Repo_kt =
    "class Repo {\n    fun find(id: Int): String {\n        return \"item \" + id\n    }\n\n    fun save(item: String) {\n        println(item)\n    }\n}\n";

/// `test/fixtures/Shapes.java`
pub const Shapes_java =
    "class Shapes {\n    private int getUsers = 0;\n    private String label = \"not a // comment\";\n\n    /** The anchor is the first thing inside the braces. */\n    void anchored() { //anchor\n        work();\n    }\n\n    void notAnchored() {\n        work(); //anchor\n    }\n\n    void calls() {\n        add(1, 2);\n        other.add(1, 2);\n        return add(1, 2);\n    }\n\n    void add(int a, int b) {\n        total = a + b;\n    }\n\n    void nextLineBrace()\n    {\n        work();\n    }\n\n    Runnable arrow = () -> {\n        work();\n    };\n\n    void chains(int n) {\n        if (n > 0) {\n            work();\n        } else if (n < 0) {\n            other();\n        } else {\n            none();\n        }\n    }\n\n    // #region wiring\n    void regioned() {\n        work();\n    }\n    // #endregion\n}\n";

/// `test/fixtures/Store.hs`
pub const Store_hs =
    "module Store where\n\nadd :: Int -> Int -> Int\nadd x y = x + y\n\ndata Cart = Cart { items :: [Int] }\n";

/// `test/fixtures/Widget.cs`
pub const Widget_cs =
    "namespace Demo;\n\npublic class Widget\n{\n    public string Name { get; set; }\n\n    public int Add(int a, int b)\n    {\n        return a + b;\n    }\n}\n";

/// `test/fixtures/example.ts`
pub const example_ts =
    "// #region table\n| name | qty |\n| ---- | --- |\n| bolt | 12  |\n// #endregion\n\n// #region config\nexport const config = { retries: 3 };\n// #endregion\n";

/// The fixture text for a vector's `input` path, or null when it names none.
pub fn sourceOf(input: ?[]const u8) ?[]const u8 {
    const path = input orelse return null;
    if (std.mem.eql(u8, path, "test/fixtures/Anchors.java")) return Anchors_java;
    if (std.mem.eql(u8, path, "test/fixtures/Cart.rb")) return Cart_rb;
    if (std.mem.eql(u8, path, "test/fixtures/Cart.rs")) return Cart_rs;
    if (std.mem.eql(u8, path, "test/fixtures/Example.java")) return Example_java;
    if (std.mem.eql(u8, path, "test/fixtures/Form.vb")) return Form_vb;
    if (std.mem.eql(u8, path, "test/fixtures/Generics.rs")) return Generics_rs;
    if (std.mem.eql(u8, path, "test/fixtures/Nesting.zig")) return Nesting_zig;
    if (std.mem.eql(u8, path, "test/fixtures/Orders.sql")) return Orders_sql;
    if (std.mem.eql(u8, path, "test/fixtures/Prime.hs")) return Prime_hs;
    if (std.mem.eql(u8, path, "test/fixtures/Repo.kt")) return Repo_kt;
    if (std.mem.eql(u8, path, "test/fixtures/Shapes.java")) return Shapes_java;
    if (std.mem.eql(u8, path, "test/fixtures/Store.hs")) return Store_hs;
    if (std.mem.eql(u8, path, "test/fixtures/Widget.cs")) return Widget_cs;
    if (std.mem.eql(u8, path, "test/fixtures/example.ts")) return example_ts;
    return null;
}

pub const cases = [_]Case{
    .{
        .name = "grammar:add",
        .input = null,
        .reference = "add",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:add-",
        .input = null,
        .reference = "add-",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:add+",
        .input = null,
        .reference = "add+",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:add++",
        .input = null,
        .reference = "add++",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:-add",
        .input = null,
        .reference = "-add",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:+add",
        .input = null,
        .reference = "+add",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:++add",
        .input = null,
        .reference = "++add",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:Cart/Line/render",
        .input = null,
        .reference = "Cart/Line/render",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:Cart/Line-",
        .input = null,
        .reference = "Cart/Line-",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:Cart/-Line",
        .input = null,
        .reference = "Cart/-Line",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar:Cart/Line/-render",
        .input = null,
        .reference = "Cart/Line/-render",
        .text = null,
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "grammar-error:empty",
        .input = null,
        .reference = "",
        .text = null,
        .error_message = "\"#\" names nothing",
        .warning = null,
    },
    .{
        .name = "grammar-error:trailing-slash",
        .input = null,
        .reference = "a/",
        .text = null,
        .error_message = "\"#a/\" has an empty path segment",
        .warning = null,
    },
    .{
        .name = "grammar-error:leading-slash",
        .input = null,
        .reference = "/a",
        .text = null,
        .error_message = "\"#/a\" has an empty path segment",
        .warning = null,
    },
    .{
        .name = "grammar-error:double-slash",
        .input = null,
        .reference = "a//b",
        .text = null,
        .error_message = "\"#a//b\" has an empty path segment",
        .warning = null,
    },
    .{
        .name = "grammar-error:plus-mid",
        .input = null,
        .reference = "a/+b",
        .text = null,
        .error_message = "\"+\" may only modify the last path segment of \"#a/+b\"",
        .warning = null,
    },
    .{
        .name = "grammar-error:dash-mid",
        .input = null,
        .reference = "a/-b/c",
        .text = null,
        .error_message = "\"-\" may only modify the last path segment of \"#a/-b/c\"",
        .warning = null,
    },
    .{
        .name = "grammar-error:dash-second-of-three",
        .input = null,
        .reference = "Cart/-Line/render",
        .text = null,
        .error_message = "\"-\" may only modify the last path segment of \"#Cart/-Line/render\"",
        .warning = null,
    },
    .{
        .name = "grammar-error:three-plus",
        .input = null,
        .reference = "a+++",
        .text = null,
        .error_message = "\"#a+++\" carries more than one modifier",
        .warning = null,
    },
    .{
        .name = "grammar-error:three-dash",
        .input = null,
        .reference = "a---",
        .text = null,
        .error_message = "\"#a---\" carries more than one modifier",
        .warning = null,
    },
    .{
        .name = "grammar-error:two-dash",
        .input = null,
        .reference = "a--",
        .text = null,
        .error_message = "\"#a--\" carries more than one modifier",
        .warning = null,
    },
    .{
        .name = "grammar-error:nine-segments",
        .input = null,
        .reference = "a/b/c/d/e/f/g/h/i",
        .text = null,
        .error_message = "\"#a/b/c/d/e/f/g/h/i\" is deeper than 8 sections",
        .warning = null,
    },
    .{
        .name = "warning:a++-",
        .input = null,
        .reference = "a++-",
        .text = null,
        .error_message = null,
        .warning = .{ .kind = .contradiction, .kept = "++", .dropped = "-" },
    },
    .{
        .name = "warning:a-++",
        .input = null,
        .reference = "a-++",
        .text = null,
        .error_message = null,
        .warning = .{ .kind = .contradiction, .kept = "++", .dropped = "-" },
    },
    .{
        .name = "warning:a+-",
        .input = null,
        .reference = "a+-",
        .text = null,
        .error_message = null,
        .warning = .{ .kind = .contradiction, .kept = "+", .dropped = "-" },
    },
    .{
        .name = "warning:a-+",
        .input = null,
        .reference = "a-+",
        .text = null,
        .error_message = null,
        .warning = .{ .kind = .contradiction, .kept = "+", .dropped = "-" },
    },
    .{
        .name = "ex-tostring",
        .input = "test/fixtures/Example.java",
        .reference = "toString",
        .text = "    public String toString() {\n        return String.join(\",\", items);\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-tostring-body",
        .input = "test/fixtures/Example.java",
        .reference = "toString-",
        .text = "        return String.join(\",\", items);",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-tostring-annotated",
        .input = "test/fixtures/Example.java",
        .reference = "toString+",
        .text = "    @Override\n    public String toString() {\n        return String.join(\",\", items);\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-tostring-documented",
        .input = "test/fixtures/Example.java",
        .reference = "toString++",
        .text = "    /** Add one item to this cart. */\n    @Override\n    public String toString() {\n        return String.join(\",\", items);\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-dash-tostring",
        .input = "test/fixtures/Example.java",
        .reference = "-toString",
        .text = "        return String.join(\",\", items);",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-line",
        .input = "test/fixtures/Example.java",
        .reference = "Line",
        .text = "    public static class Line {\n        private final String name;\n        private final int quantity;\n\n        Line(String name, int quantity) {\n            this.name = name;\n            this.quantity = quantity;\n        }\n\n        String render() {\n            return name + \" x\" + quantity;\n        }\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-line",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line",
        .text = "    public static class Line {\n        private final String name;\n        private final int quantity;\n\n        Line(String name, int quantity) {\n            this.name = name;\n            this.quantity = quantity;\n        }\n\n        String render() {\n            return name + \" x\" + quantity;\n        }\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-tostring",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/toString",
        .text = "    public String toString() {\n        return String.join(\",\", items);\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-line-render",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line/render",
        .text = "        String render() {\n            return name + \" x\" + quantity;\n        }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-line-render-body",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line/render-",
        .text = "            return name + \" x\" + quantity;",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-line-dash-render",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line/-render",
        .text = "            return name + \" x\" + quantity;",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-line-body",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line-",
        .text = "        private final String name;\n        private final int quantity;\n\n        Line(String name, int quantity) {\n            this.name = name;\n            this.quantity = quantity;\n        }\n\n        String render() {\n            return name + \" x\" + quantity;\n        }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-line-tostring-error",
        .input = "test/fixtures/Example.java",
        .reference = "Line/toString",
        .text = null,
        .error_message = "no section named \"toString\" in \"Line\"",
        .warning = null,
    },
    .{
        .name = "ex-render-extra-error",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line/render/extra",
        .text = null,
        .error_message = "no section named \"extra\" in \"render\"",
        .warning = null,
    },
    .{
        .name = "shapes-property",
        .input = "test/fixtures/Shapes.java",
        .reference = "getUsers",
        .text = "    private int getUsers = 0;",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-property-body",
        .input = "test/fixtures/Shapes.java",
        .reference = "getUsers-",
        .text = "0",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-label",
        .input = "test/fixtures/Shapes.java",
        .reference = "label",
        .text = "    private String label = \"not a // comment\";",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-calls-add-miss",
        .input = "test/fixtures/Shapes.java",
        .reference = "calls/add",
        .text = null,
        .error_message = "no section named \"add\" in \"calls\"",
        .warning = null,
    },
    .{
        .name = "shapes-add",
        .input = "test/fixtures/Shapes.java",
        .reference = "add",
        .text = "    void add(int a, int b) {\n        total = a + b;\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-add-body",
        .input = "test/fixtures/Shapes.java",
        .reference = "add-",
        .text = "        total = a + b;",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-anchored",
        .input = "test/fixtures/Shapes.java",
        .reference = "anchored/anchor",
        .text = "    void anchored() { //anchor\n        work();\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-not-anchored-miss",
        .input = "test/fixtures/Shapes.java",
        .reference = "notAnchored/anchor",
        .text = null,
        .error_message = "no section named \"anchor\" in \"notAnchored\"",
        .warning = null,
    },
    .{
        .name = "shapes-anchored-body",
        .input = "test/fixtures/Shapes.java",
        .reference = "anchored-",
        .text = "        work();",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-next-line-brace",
        .input = "test/fixtures/Shapes.java",
        .reference = "nextLineBrace",
        .text = "    void nextLineBrace()\n    {\n        work();\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-next-line-brace-body",
        .input = "test/fixtures/Shapes.java",
        .reference = "nextLineBrace-",
        .text = "        work();",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-arrow",
        .input = "test/fixtures/Shapes.java",
        .reference = "arrow",
        .text = "    Runnable arrow = () -> {",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-arrow-body",
        .input = "test/fixtures/Shapes.java",
        .reference = "arrow-",
        .text = "() -> {",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-chains-if-miss",
        .input = "test/fixtures/Shapes.java",
        .reference = "chains/chain",
        .text = null,
        .error_message = "no section named \"chain\" in \"chains\"",
        .warning = null,
    },
    .{
        .name = "shapes-chains",
        .input = "test/fixtures/Shapes.java",
        .reference = "chains",
        .text = "    void chains(int n) {\n        if (n > 0) {\n            work();\n        } else if (n < 0) {\n            other();\n        } else {\n            none();\n        }\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-region",
        .input = "test/fixtures/Shapes.java",
        .reference = "wiring",
        .text = "    void regioned() {\n        work();\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "shapes-region-miss",
        .input = "test/fixtures/Shapes.java",
        .reference = "anchored/wiring",
        .text = null,
        .error_message = "no section named \"wiring\" in \"anchored\"",
        .warning = null,
    },
    .{
        .name = "shapes-regioned",
        .input = "test/fixtures/Shapes.java",
        .reference = "regioned",
        .text = "    void regioned() {\n        work();\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-getusers-anchor",
        .input = "test/fixtures/Anchors.java",
        .reference = "getUsers",
        .text = "    public void handler() { //getUsers\n        System.out.println(\"anchor same line\");\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-getusers-anchor-body",
        .input = "test/fixtures/Anchors.java",
        .reference = "getUsers-",
        .text = "        System.out.println(\"anchor same line\");",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-dispatch-getusers",
        .input = "test/fixtures/Anchors.java",
        .reference = "dispatch/getUsers",
        .text = "        if (\"getUsers\".equals(methodName)) {\n            System.out.println(\"users\");\n        }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-getorders-anchor",
        .input = "test/fixtures/Anchors.java",
        .reference = "getOrders",
        .text = "    public void other() {\n        //getOrders\n        System.out.println(\"anchor next line\");\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-dispatch-getorders",
        .input = "test/fixtures/Anchors.java",
        .reference = "dispatch/getOrders",
        .text = "        } else if (\"getOrders\".equals(methodName)) {\n            System.out.println(\"orders\");\n        }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-handler-anchor",
        .input = "test/fixtures/Anchors.java",
        .reference = "handler/getUsers",
        .text = "    public void handler() { //getUsers\n        System.out.println(\"anchor same line\");\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-handler-anchor-body",
        .input = "test/fixtures/Anchors.java",
        .reference = "handler/getUsers-",
        .text = "        System.out.println(\"anchor same line\");",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-other-anchor",
        .input = "test/fixtures/Anchors.java",
        .reference = "other/getOrders",
        .text = "    public void other() {\n        //getOrders\n        System.out.println(\"anchor next line\");\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-other-anchor-body",
        .input = "test/fixtures/Anchors.java",
        .reference = "other/getOrders-",
        .text = "        System.out.println(\"anchor next line\");",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "a-string-not-condition",
        .input = "test/fixtures/Anchors.java",
        .reference = "commentFromString/getUsers",
        .text = null,
        .error_message = "no section named \"getUsers\" in \"commentFromString\"",
        .warning = null,
    },
    .{
        .name = "a-case-sensitive-miss",
        .input = "test/fixtures/Anchors.java",
        .reference = "getusers",
        .text = null,
        .error_message = "no \"#region getusers\" found, and no section named \"getusers\"",
        .warning = null,
    },
    .{
        .name = "ts-table-region",
        .input = "test/fixtures/example.ts",
        .reference = "table",
        .text = "| name | qty |\n| ---- | --- |\n| bolt | 12  |",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ts-table-ignores-modifier",
        .input = "test/fixtures/example.ts",
        .reference = "table+",
        .text = "| name | qty |\n| ---- | --- |\n| bolt | 12  |",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ts-config-region",
        .input = "test/fixtures/example.ts",
        .reference = "config",
        .text = "export const config = { retries: 3 };",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "z-target-method",
        .input = "test/fixtures/Nesting.zig",
        .reference = "target",
        .text = "fn target() void {\n    z();\n}",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "z-decoy-hidden-by-nested-comment",
        .input = "test/fixtures/Nesting.zig",
        .reference = "decoy",
        .text = null,
        .error_message = "no \"#region decoy\" found, and no section named \"decoy\"",
        .warning = null,
    },
    .{
        .name = "walkorder-siblings-before-deeper",
        .input = "test/fixtures/Anchors.java",
        .reference = "getUsers",
        .text = "    public void handler() { //getUsers\n        System.out.println(\"anchor same line\");\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rb-add",
        .input = "test/fixtures/Cart.rb",
        .reference = "add",
        .text = "  def add(item)\n    @items << item\n  end",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rb-cart-add",
        .input = "test/fixtures/Cart.rb",
        .reference = "Cart/add",
        .text = "  def add(item)\n    @items << item\n  end",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rb-cart-add-body",
        .input = "test/fixtures/Cart.rb",
        .reference = "Cart/add-",
        .text = "    @items << item",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rb-build",
        .input = "test/fixtures/Cart.rb",
        .reference = "build",
        .text = "  def self.build\n    new\n  end",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rb-missing",
        .input = "test/fixtures/Cart.rb",
        .reference = "missing",
        .text = null,
        .error_message = "no \"#region missing\" found, and no section named \"missing\"",
        .warning = null,
    },
    .{
        .name = "hs-add",
        .input = "test/fixtures/Store.hs",
        .reference = "add",
        .text = "add x y = x + y",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "hs-add-annotated",
        .input = "test/fixtures/Store.hs",
        .reference = "add+",
        .text = "add :: Int -> Int -> Int\nadd x y = x + y",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "hs-add-body",
        .input = "test/fixtures/Store.hs",
        .reference = "add-",
        .text = "add x y = x + y",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "hs-cart",
        .input = "test/fixtures/Store.hs",
        .reference = "Cart",
        .text = "data Cart = Cart { items :: [Int] }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "hs-keyword-is-not-a-member",
        .input = "test/fixtures/Store.hs",
        .reference = "data",
        .text = null,
        .error_message = "no \"#region data\" found, and no section named \"data\"",
        .warning = null,
    },
    .{
        .name = "rs-struct-is-the-first-cart",
        .input = "test/fixtures/Cart.rs",
        .reference = "Cart",
        .text = "struct Cart {\n    items: Vec<String>,\n}",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rs-impl-method",
        .input = "test/fixtures/Cart.rs",
        .reference = "Cart/add",
        .text = "    fn add(&mut self, x: String) {\n        self.items.push(x);\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rs-field-of-the-struct",
        .input = "test/fixtures/Cart.rs",
        .reference = "Cart/items",
        .text = "    items: Vec<String>,",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rs-retry-past-the-first-impl",
        .input = "test/fixtures/Cart.rs",
        .reference = "Cart/remove",
        .text = "    fn remove(&mut self) -> Option<String> {\n        self.items.pop()\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "rs-missing-in-every-cart",
        .input = "test/fixtures/Cart.rs",
        .reference = "Cart/nope",
        .text = null,
        .error_message = "no section named \"nope\" in \"Cart\"",
        .warning = null,
    },
    .{
        .name = "gneric-struct-is-the-first-cart",
        .input = "test/fixtures/Generics.rs",
        .reference = "Cart",
        .text = "pub struct Cart<T> {\n    publisher: String,\n    pub_key: String,\n    items: Vec<T>,\n}",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-field-plain",
        .input = "test/fixtures/Generics.rs",
        .reference = "items",
        .text = "    items: Vec<T>,",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-field-in-scope",
        .input = "test/fixtures/Generics.rs",
        .reference = "Cart/items",
        .text = "    items: Vec<T>,",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-field-name-begins-with-pub",
        .input = "test/fixtures/Generics.rs",
        .reference = "publisher",
        .text = "    publisher: String,",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-field-name-is-pub-underscore",
        .input = "test/fixtures/Generics.rs",
        .reference = "pub_key",
        .text = "    pub_key: String,",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-impl-method",
        .input = "test/fixtures/Generics.rs",
        .reference = "render",
        .text = "    fn render(&self) -> String {\n        String::new()\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-impl-method-in-scope",
        .input = "test/fixtures/Generics.rs",
        .reference = "Cart/render",
        .text = "    fn render(&self) -> String {\n        String::new()\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-plain-impl-method",
        .input = "test/fixtures/Generics.rs",
        .reference = "Cart/add",
        .text = "    fn add(&mut self, x: String) {\n        self.items.push(x);\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "generic-trait-is-not-the-scope",
        .input = "test/fixtures/Generics.rs",
        .reference = "Display",
        .text = null,
        .error_message = "no \"#region Display\" found, and no section named \"Display\"",
        .warning = null,
    },
    .{
        .name = "hs-primed-name-is-masked-away",
        .input = "test/fixtures/Prime.hs",
        .reference = "add",
        .text = null,
        .error_message = "no \"#region add\" found, and no section named \"add\"",
        .warning = null,
    },
    .{
        .name = "hs-primed-name-is-not-a-section",
        .input = "test/fixtures/Prime.hs",
        .reference = "add'",
        .text = null,
        .error_message = "no \"#region add'\" found, and no section named \"add'\"",
        .warning = null,
    },
    .{
        .name = "hs-binding-with-where-clause",
        .input = "test/fixtures/Prime.hs",
        .reference = "double",
        .text = "double x = go x\n  where\n    go y = y * 2",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "hs-indented-where-binding-is-invisible",
        .input = "test/fixtures/Prime.hs",
        .reference = "go",
        .text = null,
        .error_message = "no \"#region go\" found, and no section named \"go\"",
        .warning = null,
    },
    .{
        .name = "hs-primed-type-name-is-not-a-section",
        .input = "test/fixtures/Prime.hs",
        .reference = "Foo",
        .text = null,
        .error_message = "no \"#region Foo\" found, and no section named \"Foo\"",
        .warning = null,
    },
    .{
        .name = "hs-class-with-a-primed-neighbour",
        .input = "test/fixtures/Prime.hs",
        .reference = "Store",
        .text = "class Store s where\n  get :: s -> Int",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "hs-indented-class-method-is-invisible",
        .input = "test/fixtures/Prime.hs",
        .reference = "get",
        .text = null,
        .error_message = "no \"#region get\" found, and no section named \"get\"",
        .warning = null,
    },
    .{
        .name = "hs-keyword-is-not-a-binding",
        .input = "test/fixtures/Prime.hs",
        .reference = "data",
        .text = null,
        .error_message = "no \"#region data\" found, and no section named \"data\"",
        .warning = null,
    },
    .{
        .name = "cs-class",
        .input = "test/fixtures/Widget.cs",
        .reference = "Widget",
        .text = "public class Widget\n{\n    public string Name { get; set; }\n\n    public int Add(int a, int b)\n    {\n        return a + b;\n    }\n}",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "cs-method-in-scope",
        .input = "test/fixtures/Widget.cs",
        .reference = "Widget/Add",
        .text = "    public int Add(int a, int b)\n    {\n        return a + b;\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "cs-method",
        .input = "test/fixtures/Widget.cs",
        .reference = "Add",
        .text = "    public int Add(int a, int b)\n    {\n        return a + b;\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "cs-auto-property-is-not-a-section",
        .input = "test/fixtures/Widget.cs",
        .reference = "Name",
        .text = null,
        .error_message = "no \"#region Name\" found, and no section named \"Name\"",
        .warning = null,
    },
    .{
        .name = "kt-class",
        .input = "test/fixtures/Repo.kt",
        .reference = "Repo",
        .text = "class Repo {\n    fun find(id: Int): String {\n        return \"item \" + id\n    }\n\n    fun save(item: String) {\n        println(item)\n    }\n}",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "kt-method-in-scope",
        .input = "test/fixtures/Repo.kt",
        .reference = "Repo/find",
        .text = "    fun find(id: Int): String {\n        return \"item \" + id\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "kt-method",
        .input = "test/fixtures/Repo.kt",
        .reference = "find",
        .text = "    fun find(id: Int): String {\n        return \"item \" + id\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "kt-second-method-in-scope",
        .input = "test/fixtures/Repo.kt",
        .reference = "Repo/save",
        .text = "    fun save(item: String) {\n        println(item)\n    }",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "kt-report-is-not-a-section",
        .input = "test/fixtures/Repo.kt",
        .reference = "report",
        .text = null,
        .error_message = "no \"#region report\" found, and no section named \"report\"",
        .warning = null,
    },
    .{
        .name = "sql-region-in-line-comments",
        .input = "test/fixtures/Orders.sql",
        .reference = "totals",
        .text = "SELECT count(*) AS orders, sum(total) AS revenue FROM orders;",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "sql-table-is-not-a-section",
        .input = "test/fixtures/Orders.sql",
        .reference = "orders",
        .text = null,
        .error_message = "no \"#region orders\" found, and no section named \"orders\"",
        .warning = null,
    },
    .{
        .name = "vb-class",
        .input = "test/fixtures/Form.vb",
        .reference = "Form",
        .text = "Public Class Form\n    Public Function Add(ByVal x As Integer) As Integer\n        Return x + 1\n    End Function\n\n    Private Sub Run()\n        Console.WriteLine(\"run\")\n    End Sub\nEnd Class",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "vb-function-in-scope",
        .input = "test/fixtures/Form.vb",
        .reference = "Form/Add",
        .text = "    Public Function Add(ByVal x As Integer) As Integer\n        Return x + 1\n    End Function",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "vb-function",
        .input = "test/fixtures/Form.vb",
        .reference = "Add",
        .text = "    Public Function Add(ByVal x As Integer) As Integer\n        Return x + 1\n    End Function",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "vb-function-body",
        .input = "test/fixtures/Form.vb",
        .reference = "Form/Add-",
        .text = "        Return x + 1",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "vb-sub-in-scope",
        .input = "test/fixtures/Form.vb",
        .reference = "Form/Run",
        .text = "    Private Sub Run()\n        Console.WriteLine(\"run\")\n    End Sub",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "vb-missing-member",
        .input = "test/fixtures/Form.vb",
        .reference = "Form/nope",
        .text = null,
        .error_message = "no section named \"nope\" in \"Form\"",
        .warning = null,
    },
};

pub const mask_cases = [_]MaskCase{
    .{
        .name = "js-template-literal",
        .path = "a.js",
        .source = "const a = `x } ${y} z`;\n// c\n/* d */\n",
        .masked = "const a =             ;\n    \n       \n",
    },
    .{
        .name = "js-comment-and-regex",
        .path = "a.mjs",
        .source = "// } brace\nconst r = /[}]/;\n",
        .masked = "          \nconst r = /[}]/;\n",
    },
    .{
        .name = "ts-annotated",
        .path = "a.ts",
        .source = "const a: string = `} ${x}`;\n",
        .masked = "const a: string =         ;\n",
    },
    .{
        .name = "tsx-annotated",
        .path = "a.tsx",
        .source = "export const A = ({ x }: P) => <div>{x}</div>;\n",
        .masked = "export const A = ({ x }: P) => <div>{x}</div>;\n",
    },
    .{
        .name = "java-text-block",
        .path = "a.java",
        .source = "String s = \"\"\"\n  } brace\n  \"\"\";\nchar c = '}';\n// }\n",
        .masked = "String s =    \n         \n     ;\nchar c =    ;\n    \n",
    },
    .{
        .name = "java-char-and-comment",
        .path = "a.java",
        .source = "char q = '\\'';\n/* } */\n",
        .masked = "char q =     ;\n       \n",
    },
    .{
        .name = "zig-nested-comment",
        .path = "a.zig",
        .source = "/* outer /* inner */ still */\npub fn f() void {}\n",
        .masked = "                             \npub fn f() void {}\n",
    },
    .{
        .name = "zig-multiline-string",
        .path = "a.zig",
        .source = "const s =\n    \\\\a } brace\n;\n\"q }\"\n",
        .masked = "const s =\n               \n;\n     \n",
    },
    .{
        .name = "go-raw-string",
        .path = "a.go",
        .source = "s := `a } brace`\nt := \"b } brace\"\n",
        .masked = "s :=            \nt :=            \n",
    },
    .{
        .name = "go-char-literal",
        .path = "a.go",
        .source = "c := '}'\nd := '\\\\'\n",
        .masked = "c :=    \nd :=     \n",
    },
    .{
        .name = "go-char-with-line-break",
        .path = "a.go",
        .source = "c := '\\\n'\n",
        .masked = "c := '\\\n'\n",
    },
    .{
        .name = "go-escaped-quote",
        .path = "a.go",
        .source = "s := \"a \\\" } b\"\n",
        .masked = "s :=           \n",
    },
    .{
        .name = "rust-raw-string",
        .path = "a.rs",
        .source = "let s = r#\"a } brace\"#;\nlet t = \"b }\";\n",
        .masked = "let s =               ;\nlet t =      ;\n",
    },
    .{
        .name = "rust-lifetime-versus-char",
        .path = "a.rs",
        .source = "fn f<'a>(x: &'static str) -> char { 'x' }\n",
        .masked = "fn f<'a>(x: &'static str) -> char {     }\n",
    },
    .{
        .name = "rust-nested-comment",
        .path = "a.rs",
        .source = "/* outer /* inner */ fn decoy() {} */\nfn target() {}\n",
        .masked = "                                     \nfn target() {}\n",
    },
    .{
        .name = "rust-byte-char-with-line-break",
        .path = "a.rs",
        .source = "let c = b'\\\n';\n",
        .masked = "let c = b'\\\n';\n",
    },
    .{
        .name = "python-triple-quoted",
        .path = "a.py",
        .source = "x = \"\"\"a } brace\"\"\"\ny = '''b }'''\n",
        .masked = "x =                \ny =          \n",
    },
    .{
        .name = "python-raw-string",
        .path = "a.py",
        .source = "x = r\"a \\\" } b\"\ny = r'c }'\n",
        .masked = "x =        } b \ny =       \n",
    },
    .{
        .name = "python-raw-prefix-after-word",
        .path = "a.py",
        .source = "\xc5\x81r\"x\"\n",
        .masked = "\xc5\x81    \n",
    },
    .{
        .name = "python-fstring",
        .path = "a.py",
        .source = "x = f\"{a} } {b}\"\n",
        .masked = "x = f           \n",
    },
    .{
        .name = "csharp-verbatim",
        .path = "a.cs",
        .source = "var s = @\"a \"\" } b\";\n",
        .masked = "var s =            ;\n",
    },
    .{
        .name = "csharp-interpolated-verbatim",
        .path = "a.cs",
        .source = "var s = $@\"a {b} \"\" } c\";\n",
        .masked = "var s =                 ;\n",
    },
    .{
        .name = "csharp-raw-string",
        .path = "a.cs",
        .source = "var s = \"\"\"a } b\"\"\";\n",
        .masked = "var s =            ;\n",
    },
    .{
        .name = "kotlin-nested-comment",
        .path = "a.kt",
        .source = "/* a /* b */ } */\nval s = \"\"\"c } d\"\"\"\n",
        .masked = "                 \nval s =            \n",
    },
    .{
        .name = "kotlin-char",
        .path = "a.kt",
        .source = "val c = '}'\n// }\n",
        .masked = "val c =    \n    \n",
    },
    .{
        .name = "php-heredoc",
        .path = "a.php",
        .source = "<?php\n$sql = <<<EOT\n  } brace\nEOT;\n# a comment }\n",
        .masked = "<?php\n$sql = <<<EOT\n         \n    \n             \n",
    },
    .{
        .name = "php-attribute-is-not-a-comment",
        .path = "a.php",
        .source = "#[Attribute]\nclass Cart {}\n",
        .masked = "#[Attribute]\nclass Cart {}\n",
    },
    .{
        .name = "ruby-end-block-comment",
        .path = "a.rb",
        .source = "=begin\na } brace\n=end\n# c\ndef add(x)\n  x\nend\n",
        .masked = "      \n         \n    \n   \ndef add(x)\n  x\nend\n",
    },
    .{
        .name = "ruby-heredoc-versus-shift",
        .path = "a.rb",
        .source = "items = array << x\nbody = <<~TAG\n  } brace\nTAG\n",
        .masked = "items = array << x\nbody = <<~TAG\n         \n   \n",
    },
    .{
        .name = "sql-dollar-quoting",
        .path = "a.sql",
        .source = "SELECT $$a } b$$;\n-- } c\n",
        .masked = "SELECT          ;\n      \n",
    },
    .{
        .name = "sql-doubled-quote",
        .path = "a.sql",
        .source = "SELECT 'it''s a } brace';\n",
        .masked = "SELECT                  ;\n",
    },
    .{
        .name = "shell-heredoc",
        .path = "a.sh",
        .source = "cat <<EOF\n  } brace\nEOF\necho 'no } escape'\n",
        .masked = "cat <<EOF\n         \n   \necho              \n",
    },
    .{
        .name = "shell-heredoc-non-ascii-tag",
        .path = "a.sh",
        .source = "cat <<\xc5\x81x\n  body\n",
        .masked = "cat <<\xc5\x81x\n  body\n",
    },
    .{
        .name = "vb-doubling",
        .path = "a.vb",
        .source = "Dim s As String = \"a \"\"; } b\"\n' c }\n",
        .masked = "Dim s As String =            \n     \n",
    },
    .{
        .name = "haskell-nested-comment",
        .path = "a.hs",
        .source = "{- a {- b -} } -}\nx = \"a } b\"\n-- }\n",
        .masked = "                 \nx =        \n    \n",
    },
    .{
        .name = "haskell-string-gap",
        .path = "a.hs",
        .source = "x = \"a \\\n  \\ b } c\"\n",
        .masked = "x =     \n          \n",
    },
    .{
        .name = "haskell-prime-after-identifier",
        .path = "a.hs",
        .source = "add' x = 1\n",
        .masked = "add       \n",
    },
    .{
        .name = "haskell-char-literal",
        .path = "a.hs",
        .source = "c = 'a'\n",
        .masked = "c =    \n",
    },
    .{
        .name = "yaml-quoted-hash",
        .path = "a.yaml",
        .source = "# a comment\nkey: 'a # not a comment'\nother: \"b } c\"\n",
        .masked = "           \nkey:                    \nother:        \n",
    },
    .{
        .name = "toml-triple-quoted",
        .path = "a.toml",
        .source = "a = \"\"\"x } y\"\"\"\nb = '''z }'''\n# c\n",
        .masked = "a =            \nb =          \n   \n",
    },
    .{
        .name = "ini-comments",
        .path = "a.ini",
        .source = "; a comment\n# another } comment\nkey = value\n",
        .masked = "           \n                   \nkey = value\n",
    },
    .{
        .name = "default-unknown-type",
        .path = null,
        .source = "// a } brace\n/* b */\n\"c } d\"\n'e }'\n",
        .masked = "            \n       \n       \n     \n",
    },
    .{
        .name = "default-no-extension",
        .path = "Makefile",
        .source = "# comment }\n\"a } b\"\n",
        .masked = "           \n       \n",
    },
    .{
        .name = "astral-plane-in-string",
        .path = "a.py",
        .source = "x = \"\xf0\x9f\x98\x80 } \xf0\x9f\x98\x80\"\n\xf0\x9f\x98\x80 = 1\n",
        .masked = "x =          \n\xf0\x9f\x98\x80 = 1\n",
    },
    .{
        .name = "length-and-newlines-survive",
        .path = "a.java",
        .source = "int a;\r\n// c\r\nint b;\r\n",
        .masked = "int a;\r\n     \nint b;\r\n",
    },
};

pub const shape_cases = [_]ShapeCase{
    .{
        .name = "rust-impl-plain",
        .path = "a.rs",
        .line = "impl Cart {",
        .declared = &.{
            .{ .kind = .class, .name = "Cart", .header_from = 11, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "rust-impl-generic",
        .path = "a.rs",
        .line = "impl<T: Clone> Display for Cart<T> {",
        .declared = &.{
            .{ .kind = .class, .name = "Cart", .header_from = 36, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "rust-impl-nested-generic",
        .path = "a.rs",
        .line = "impl Foo<Bar<Baz>> {",
        .declared = &.{},
    },
    .{
        .name = "rust-impl-where",
        .path = "a.rs",
        .line = "impl<T> Cart<T> where T: Clone {",
        .declared = &.{
            .{ .kind = .class, .name = "Cart", .header_from = 32, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "rust-impl-word-containing-where",
        .path = "a.rs",
        .line = "impl where_clause for Cart {",
        .declared = &.{
            .{ .kind = .class, .name = "Cart", .header_from = 28, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "rust-impl-body-on-next-line",
        .path = "a.rs",
        .line = "impl Cart",
        .declared = &.{},
    },
    .{
        .name = "rust-field-plain",
        .path = "a.rs",
        .line = "    field: u32,",
        .declared = &.{
            .{ .kind = .property, .name = "field", .header_from = 10, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "rust-field-pub",
        .path = "a.rs",
        .line = "    pub name: String,",
        .declared = &.{
            .{ .kind = .property, .name = "name", .header_from = 13, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "rust-field-name-begins-with-pub",
        .path = "a.rs",
        .line = "    publisher: String,",
        .declared = &.{
            .{ .kind = .property, .name = "publisher", .header_from = 14, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "rust-field-name-is-pub-underscore",
        .path = "a.rs",
        .line = "    pub_key: String,",
        .declared = &.{
            .{ .kind = .property, .name = "pub_key", .header_from = 12, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "rust-field-tuple-is-not-a-field",
        .path = "a.rs",
        .line = "    (u32, u32),",
        .declared = &.{},
    },
    .{
        .name = "rust-keyword-is-not-an-impl",
        .path = "a.rs",
        .line = "structure Cart {",
        .declared = &.{},
    },
    .{
        .name = "ruby-def-plain",
        .path = "a.rb",
        .line = "def add",
        .declared = &.{
            .{ .kind = .method, .name = "add", .header_from = 7, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-def-parens",
        .path = "a.rb",
        .line = "def add(x)",
        .declared = &.{
            .{ .kind = .method, .name = "add", .header_from = 7, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-def-self",
        .path = "a.rb",
        .line = "def self.build",
        .declared = &.{
            .{ .kind = .method, .name = "build", .header_from = 14, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-def-question",
        .path = "a.rb",
        .line = "def add?",
        .declared = &.{
            .{ .kind = .method, .name = "add?", .header_from = 8, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-def-bang",
        .path = "a.rb",
        .line = "def add!",
        .declared = &.{
            .{ .kind = .method, .name = "add!", .header_from = 8, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-def-setter",
        .path = "a.rb",
        .line = "def add=",
        .declared = &.{
            .{ .kind = .method, .name = "add=", .header_from = 8, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-def-indented",
        .path = "a.rb",
        .line = "    def add",
        .declared = &.{
            .{ .kind = .method, .name = "add", .header_from = 11, .body = "end", .end = "end", .line = false },
        },
    },
    .{
        .name = "ruby-word-ending-in-def-is-not-a-def",
        .path = "a.rb",
        .line = "define add",
        .declared = &.{},
    },
    .{
        .name = "haskell-binding-column-zero",
        .path = "a.hs",
        .line = "add x y = x + y",
        .declared = &.{
            .{ .kind = .method, .name = "add", .header_from = 9, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "haskell-binding-indented",
        .path = "a.hs",
        .line = "    add x y = x + y",
        .declared = &.{},
    },
    .{
        .name = "haskell-binding-primed",
        .path = "a.hs",
        .line = "add' x = 1",
        .declared = &.{
            .{ .kind = .method, .name = "add", .header_from = 8, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "haskell-binding-named-fold",
        .path = "a.hs",
        .line = "foldl' f z xs = z",
        .declared = &.{
            .{ .kind = .method, .name = "foldl", .header_from = 15, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "haskell-binding-underscore",
        .path = "a.hs",
        .line = "_ignore x = 1",
        .declared = &.{
            .{ .kind = .method, .name = "_ignore", .header_from = 11, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "haskell-equality-is-not-a-binding",
        .path = "a.hs",
        .line = "x == y",
        .declared = &.{
            .{ .kind = .method, .name = "x", .header_from = 3, .body = null, .end = null, .line = true },
        },
    },
    .{
        .name = "haskell-data",
        .path = "a.hs",
        .line = "data Cart = Cart { items :: [Int] }",
        .declared = &.{
            .{ .kind = .class, .name = "Cart", .header_from = 9, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "haskell-newtype",
        .path = "a.hs",
        .line = "newtype Wrap a = Wrap a",
        .declared = &.{
            .{ .kind = .class, .name = "Wrap", .header_from = 12, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "haskell-type-primed",
        .path = "a.hs",
        .line = "data Foo' = Foo",
        .declared = &.{
            .{ .kind = .class, .name = "Foo'", .header_from = 9, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "haskell-class-keyword",
        .path = "a.hs",
        .line = "class Store s where",
        .declared = &.{
            .{ .kind = .class, .name = "Store", .header_from = 11, .body = null, .end = null, .line = false },
        },
    },
    .{
        .name = "haskell-indented-data",
        .path = "a.hs",
        .line = "    data Bar = Bar",
        .declared = &.{},
    },
    .{
        .name = "haskell-keyword-is-not-a-binding",
        .path = "a.hs",
        .line = "module Store where",
        .declared = &.{},
    },
    .{
        .name = "vb-class",
        .path = "a.vb",
        .line = "Public Class Form",
        .declared = &.{
            .{ .kind = .class, .name = "Form", .header_from = 17, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-class-modifier-tight",
        .path = "a.vb",
        .line = "PublicClass Form",
        .declared = &.{
            .{ .kind = .class, .name = "Form", .header_from = 16, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-class-not-inheritable",
        .path = "a.vb",
        .line = "Public NotInheritable Class Form",
        .declared = &.{
            .{ .kind = .class, .name = "Form", .header_from = 32, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-module",
        .path = "a.vb",
        .line = "Friend Module Helpers",
        .declared = &.{
            .{ .kind = .class, .name = "Helpers", .header_from = 21, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-structure",
        .path = "a.vb",
        .line = "Structure Point",
        .declared = &.{
            .{ .kind = .class, .name = "Point", .header_from = 15, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-class-name-starts-with-digit",
        .path = "a.vb",
        .line = "Class 2Thing",
        .declared = &.{
            .{ .kind = .class, .name = "2Thing", .header_from = 12, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-function",
        .path = "a.vb",
        .line = "    Public Function Add(ByVal x As Integer) As Integer",
        .declared = &.{
            .{ .kind = .method, .name = "Add", .header_from = 23, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-sub",
        .path = "a.vb",
        .line = "    Private Sub Run()",
        .declared = &.{
            .{ .kind = .method, .name = "Run", .header_from = 19, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-keyword-inside-a-longer-word",
        .path = "a.vb",
        .line = "Submarine Function Add(x)",
        .declared = &.{
            .{ .kind = .method, .name = "Add", .header_from = 22, .body = "end", .end = "End", .line = false },
        },
    },
    .{
        .name = "vb-prefix-word-is-not-a-boundary",
        .path = "a.vb",
        .line = "MySub Foo",
        .declared = &.{},
    },
    .{
        .name = "vb-end-is-not-a-declaration",
        .path = "a.vb",
        .line = "End Function",
        .declared = &.{},
    },
};
