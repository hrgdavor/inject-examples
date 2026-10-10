//! The language table and the extension registry: `src/js/scanner/syntaxes.js` and `lexers.js` in Rust.
//!
//! An extension with no entry means the file type is unknown, and [`lexer_for_path`] then hands back the
//! default engine — the language-agnostic union — which is the same answer a reference gets for a type
//! with no entry at all. That is why the table is an optimisation for the types it covers, never a
//! requirement, and why an entry is only worth adding when the union is *wrong* for that language: a
//! nested comment, a raw string, a heredoc, or a `'` that is a lifetime rather than a char literal.
//!
//! Adding a language is one [`Syntax`] here and one extension line below, never new matching logic.

use crate::lexer::{DefaultLexer, Lexer};
use crate::syntax::{Annotation, Heredoc, Shape, StringKind, Syntax};
use crate::tokenizer::{lexer as syntax_lexer, SyntaxLexer};

/// Java: `//`, the C block pair, quotes and text blocks.
pub fn java() -> Syntax {
    Syntax::new("java")
        .line_comments(&["//"])
        .block("/*", "*/")
        .string(StringKind::new("\"\"\"", "\"\"\"").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::new("'", "'"))
}

/// JavaScript / TypeScript.
pub fn javascript() -> Syntax {
    Syntax::new("javascript")
        .line_comments(&["//"])
        .block("/*", "*/")
        .string(StringKind::new("`", "`").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::new("'", "'"))
}

/// Zig: nested block comments, and multiline `\\` strings.
pub fn zig() -> Syntax {
    Syntax::new("zig")
        .line_comments(&["//"])
        .nested_block("/*", "*/")
        .string(StringKind::line_scoped("\\\\"))
        .string(StringKind::new("\"", "\""))
}

/// Go: backtick raw strings take no escapes at all.
pub fn go() -> Syntax {
    Syntax::new("go")
        .line_comments(&["//"])
        .block("/*", "*/")
        .string(StringKind::raw("`", "`").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::single_char("'"))
}

/// Rust: nested block comments, raw strings, and `'a` (lifetime) versus `'a'`.
pub fn rust() -> Syntax {
    Syntax::new("rust")
        .line_comments(&["//"])
        .nested_block("/*", "*/")
        .string(
            StringKind::raw("br\"", "\"")
                .multiline()
                .boundary()
                .hashes(),
        )
        .string(StringKind::raw("r\"", "\"").multiline().boundary().hashes())
        .string(StringKind::new("b\"", "\"").boundary())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::single_char("b'").boundary())
        .string(StringKind::single_char("'"))
        .shape(Shape::RustImpl)
        .shape(Shape::RustField)
}

/// Python: triple quotes, raw strings, and the `#` comment.
pub fn python() -> Syntax {
    Syntax::new("python")
        .line_comments(&["#"])
        .string(StringKind::raw("r\"\"\"", "\"\"\"").multiline().boundary())
        .string(StringKind::raw("r'''", "'''").multiline().boundary())
        .string(StringKind::raw("rb\"", "\"").boundary())
        .string(StringKind::raw("rb'", "'").boundary())
        .string(StringKind::raw("br\"", "\"").boundary())
        .string(StringKind::raw("br'", "'").boundary())
        .string(StringKind::raw("r\"", "\"").boundary())
        .string(StringKind::raw("r'", "'").boundary())
        .string(StringKind::new("\"\"\"", "\"\"\"").multiline())
        .string(StringKind::new("'''", "'''").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::new("'", "'"))
}

/// C#: verbatim `@"…""…"` and raw `"""`.
pub fn csharp() -> Syntax {
    Syntax::new("csharp")
        .line_comments(&["//"])
        .block("/*", "*/")
        .string(StringKind::doubling("$@\"", "\"").multiline().boundary())
        .string(StringKind::doubling("@$\"", "\"").multiline().boundary())
        .string(StringKind::doubling("@\"", "\"").multiline().boundary())
        .string(StringKind::raw("\"\"\"", "\"\"\"").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::new("'", "'"))
}

/// Kotlin: nested block comments, like Rust's.
pub fn kotlin() -> Syntax {
    Syntax::new("kotlin")
        .line_comments(&["//"])
        .nested_block("/*", "*/")
        .string(StringKind::raw("\"\"\"", "\"\"\"").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::new("'", "'"))
}

/// PHP: `//` and `#` (but `#[Attribute]` stays readable), and heredocs.
pub fn php() -> Syntax {
    Syntax::new("php")
        .line_comments(&["//", "#"])
        .block("/*", "*/")
        .string(StringKind::new("\"", "\"").multiline())
        .string(StringKind::new("'", "'").multiline())
        .heredoc(Heredoc::Any)
}

/// Ruby: `=begin`/`=end` at column 0, heredocs, and the paren-less `def`.
pub fn ruby() -> Syntax {
    Syntax::new("ruby")
        .line_comments(&["#"])
        .line_start_block("=begin", "=end")
        .string(StringKind::new("\"", "\"").multiline())
        .string(StringKind::new("'", "'").multiline())
        .string(StringKind::new("`", "`").multiline())
        .heredoc(Heredoc::Strict)
        .shape(Shape::RubyMethod)
}

/// SQL: `--`, the C block pair, Postgres dollar quoting and doubled quotes.
pub fn sql() -> Syntax {
    Syntax::new("sql")
        .line_comments(&["--"])
        .block("/*", "*/")
        .string(StringKind::raw("$$", "$$").multiline())
        .string(StringKind::doubling("'", "'"))
        .string(StringKind::doubling("\"", "\""))
        .string(StringKind::doubling("`", "`"))
}

/// Shell: `#`, single quotes that take no escapes, and heredocs.
pub fn shell() -> Syntax {
    Syntax::new("shell")
        .line_comments(&["#"])
        .string(StringKind::raw("'", "'").multiline())
        .string(StringKind::new("\"", "\"").multiline())
        .string(StringKind::new("`", "`").multiline())
        .heredoc(Heredoc::Any)
}

/// VB: `'` comments, doubled-quote strings, and capitalised keyword blocks.
pub fn vb() -> Syntax {
    Syntax::new("vb")
        .line_comments(&["'"])
        .string(StringKind::doubling("\"", "\""))
        .shape(Shape::VbClass)
        .shape(Shape::VbMethod)
}

/// Haskell: nested `{- -}`, string gaps, and the binding/type shapes.
pub fn haskell() -> Syntax {
    Syntax::new("haskell")
        .line_comments(&["--"])
        .nested_block("{-", "-}")
        .string(StringKind::new("\"", "\"").multiline())
        .string(StringKind::new("'", "'"))
        .shape(Shape::HaskellBinding)
        .shape(Shape::HaskellType)
        .annotation(Annotation::NameSignature)
}

/// YAML: `#`, and both quoted forms folding across lines.
pub fn yaml() -> Syntax {
    Syntax::new("yaml")
        .line_comments(&["#"])
        .string(StringKind::new("\"", "\"").multiline())
        .string(StringKind::doubling("'", "'").multiline())
}

/// TOML: `#`, triple-quoted basic and literal strings.
pub fn toml() -> Syntax {
    Syntax::new("toml")
        .line_comments(&["#"])
        .string(StringKind::new("\"\"\"", "\"\"\"").multiline())
        .string(StringKind::raw("'''", "'''").multiline())
        .string(StringKind::new("\"", "\""))
        .string(StringKind::raw("'", "'"))
}

/// INI: `;` is the classic comment; `#` is common too.
pub fn ini() -> Syntax {
    Syntax::new("ini")
        .line_comments(&[";", "#"])
        .string(StringKind::raw("\"", "\""))
        .string(StringKind::raw("'", "'"))
}

/// The syntax registered under `name`, or `None` when the table has no such entry.
pub fn syntax_by_name(name: &str) -> Option<Syntax> {
    let syntax = match name {
        "javascript" => javascript(),
        "typescript" => javascript().rename("typescript"),
        "java" => java(),
        "zig" => zig(),
        "go" => go(),
        "rust" => rust(),
        "python" => python(),
        "csharp" => csharp(),
        "kotlin" => kotlin(),
        "php" => php(),
        "ruby" => ruby(),
        "sql" => sql(),
        "shell" => shell(),
        "vb" => vb(),
        "haskell" => haskell(),
        "yaml" => yaml(),
        "toml" => toml(),
        "ini" => ini(),
        _ => return None,
    };
    Some(syntax.normalised())
}

/// Extension to language name: one line per extension, exactly as `lexers.js` has it.
pub fn extensions() -> &'static [(&'static str, &'static str)] {
    &[
        ("js", "javascript"),
        ("mjs", "javascript"),
        ("cjs", "javascript"),
        ("jsx", "javascript"),
        ("ts", "typescript"),
        ("tsx", "typescript"),
        ("mts", "typescript"),
        ("cts", "typescript"),
        ("java", "java"),
        ("zig", "zig"),
        ("go", "go"),
        ("rs", "rust"),
        ("py", "python"),
        ("pyi", "python"),
        ("cs", "csharp"),
        ("kt", "kotlin"),
        ("kts", "kotlin"),
        ("php", "php"),
        ("phtml", "php"),
        ("rb", "ruby"),
        ("rake", "ruby"),
        ("gemspec", "ruby"),
        ("sql", "sql"),
        ("sh", "shell"),
        ("bash", "shell"),
        ("zsh", "shell"),
        ("vb", "vb"),
        ("bas", "vb"),
        ("vbs", "vb"),
        ("hs", "haskell"),
        ("lhs", "haskell"),
        ("yaml", "yaml"),
        ("yml", "yaml"),
        ("toml", "toml"),
        ("ini", "ini"),
        ("cfg", "ini"),
        ("properties", "ini"),
    ]
}

/// The syntax for `path`'s extension, or `None` when the type is unknown.
pub fn syntax_for_path(path: &str) -> Option<Syntax> {
    let dot = path.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let extension = path[dot + 1..].to_ascii_lowercase();
    let name = extensions()
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, name)| *name)?;
    syntax_by_name(name)
}

/// The lexer for `path`'s extension, or the default engine when the type is unknown — the same answer an
/// unknown type gets, so this can be handed straight to the scanner.
pub fn lexer_for_path(path: &str) -> Box<dyn Lexer> {
    match syntax_for_path(path) {
        Some(syntax) => Box::new(syntax_lexer(syntax)),
        None => Box::new(DefaultLexer),
    }
}

impl Syntax {
    /// The same syntax under another name (TypeScript is JavaScript's table entry).
    pub fn rename(mut self, name: &str) -> Self {
        self.name = name.to_string();
        self
    }
}

/// The lexer for a syntax, for a caller that already knows it.
pub fn lexer_for_syntax(syntax: Syntax) -> SyntaxLexer {
    syntax_lexer(syntax)
}
