//! The section-matching conformance corpus, generated from the JavaScript
//! implementation's golden vectors.
//!
//! **Generated - do not edit.** `node tools/zig-vectors.mjs` writes this file
//! from `test/vectors/section-vectors.json` (see `tools/section-vectors.mjs`)
//! and the fixture files that corpus resolves against; `--check` fails when
//! the committed file is stale. Every case here is one assertion in
//! `section.zig`'s conformance test, so the port cannot drift from the
//! JavaScript it mirrors without the build failing.

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

/// `test/fixtures/Anchors.java`
pub const Anchors_java =
    "package example;\r\n\r\n/** A dispatch table keyed by method name. */\r\npublic class Anchors {\r\n    /** "
        ++ "Run one named method. */\r\n    public void dispatch(String methodName) {\r\n        if (\"getUsers\".equal"
        ++ "s(methodName)) {\r\n            System.out.println(\"users\");\r\n        } else if (\"getOrders\".equals(m"
        ++ "ethodName)) {\r\n            System.out.println(\"orders\");\r\n        }\r\n    }\r\n\r\n    public void h"
        ++ "andler() { //getUsers\r\n        System.out.println(\"anchor same line\");\r\n    }\r\n\r\n    public void "
        ++ "other() {\r\n        //getOrders\r\n        System.out.println(\"anchor next line\");\r\n    }\r\n\r\n    p"
        ++ "ublic void commentFromString() {\r\n        String s = \"getUsers\";\r\n        System.out.println(s);\r\n "
        ++ "   }\r\n}\r\n";

/// `test/fixtures/Cart.rb`
pub const Cart_rb =
    "class Cart\n  def add(item)\n    @items << item\n  end\n\n  def self.build\n    new\n  end\nend\n";

/// `test/fixtures/Cart.rs`
pub const Cart_rs =
    "struct Cart {\n    items: Vec<String>,\n}\n\nimpl Cart {\n    fn add(&mut self, x: String) {\n        self."
        ++ "items.push(x);\n    }\n}\n\nimpl Cart {\n    fn remove(&mut self) -> Option<String> {\n        self.items.p"
        ++ "op()\n    }\n}\n";

/// `test/fixtures/Example.java`
pub const Example_java =
    "package example;\n\nimport java.util.ArrayList;\nimport java.util.List;\n\n/** A cart of items, by name and"
        ++ " quantity. */\npublic class Cart {\n    private final List<String> items = new ArrayList<>();\n\n    /** Ad"
        ++ "d one item to this cart. */\n    @Override\n    public String toString() {\n        return String.join(\","
        ++ "\", items);\n    }\n\n    /** One line of a cart. */\n    public static class Line {\n        private final"
        ++ " String name;\n        private final int quantity;\n\n        Line(String name, int quantity) {\n          "
        ++ "  this.name = name;\n            this.quantity = quantity;\n        }\n\n        String render() {\n       "
        ++ "     return name + \" x\" + quantity;\n        }\n    }\n}";

/// `test/fixtures/Nesting.zig`
pub const Nesting_zig =
    "//! A Zig file whose nested block comment hides a declaration.\nconst std = @import(\"std\");\n\n/* outer /"
        ++ "* inner */ fn decoy() void { x(); } */\n\n/// The real target.\nfn target() void {\n    z();\n}\n";

/// `test/fixtures/Store.hs`
pub const Store_hs =
    "module Store where\n\nadd :: Int -> Int -> Int\nadd x y = x + y\n\ndata Cart = Cart { items :: [Int] }\n";

/// `test/fixtures/example.ts`
pub const example_ts =
    "// #region table\n| name | qty |\n| ---- | --- |\n| bolt | 12  |\n// #endregion\n\n// #region config\nexpor"
        ++ "t const config = { retries: 3 };\n// #endregion\n";

/// The fixture text for a vector's `input` path, or null when it names none.
pub fn sourceOf(input: ?[]const u8) ?[]const u8 {
    const path = input orelse return null;
    if (std.mem.eql(u8, path, "test/fixtures/Anchors.java")) return Anchors_java;
    if (std.mem.eql(u8, path, "test/fixtures/Cart.rb")) return Cart_rb;
    if (std.mem.eql(u8, path, "test/fixtures/Cart.rs")) return Cart_rs;
    if (std.mem.eql(u8, path, "test/fixtures/Example.java")) return Example_java;
    if (std.mem.eql(u8, path, "test/fixtures/Nesting.zig")) return Nesting_zig;
    if (std.mem.eql(u8, path, "test/fixtures/Store.hs")) return Store_hs;
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
        .text = "    /** Add one item to this cart. */\n    @Override\n    public String toString() {\n        return String"
        ++ ".join(\",\", items);\n    }",
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
        .text = "    public static class Line {\n        private final String name;\n        private final int quantity;\n\n"
        ++ "        Line(String name, int quantity) {\n            this.name = name;\n            this.quantity = quant"
        ++ "ity;\n        }\n\n        String render() {\n            return name + \" x\" + quantity;\n        }\n    "
        ++ "}",
        .error_message = null,
        .warning = null,
    },
    .{
        .name = "ex-cart-line",
        .input = "test/fixtures/Example.java",
        .reference = "Cart/Line",
        .text = "    public static class Line {\n        private final String name;\n        private final int quantity;\n\n"
        ++ "        Line(String name, int quantity) {\n            this.name = name;\n            this.quantity = quant"
        ++ "ity;\n        }\n\n        String render() {\n            return name + \" x\" + quantity;\n        }\n    "
        ++ "}",
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
        .text = "        private final String name;\n        private final int quantity;\n\n        Line(String name, int qu"
        ++ "antity) {\n            this.name = name;\n            this.quantity = quantity;\n        }\n\n        Strin"
        ++ "g render() {\n            return name + \" x\" + quantity;\n        }",
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
        .text = "        } else if (\"getOrders\".equals(methodName)) {\n            System.out.println(\"orders\");\n      "
        ++ "  }",
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
};
