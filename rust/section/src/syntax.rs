//! One language's lexical data — the Rust counterpart of an entry in `src/js/scanner/syntaxes.js`.
//!
//! This is **data, not code**: [`Tokenizer`](crate::tokenizer) walks it and the table in
//! [`syntaxes`](crate::syntaxes) is the entries, so adding a language is one object and one extension
//! line, never new matching logic. An entry earns its keep only where the language-agnostic union is
//! *wrong* for that language — a nested block comment, a raw string, a heredoc, or a `'` that is a
//! lifetime rather than a char literal.
//!
//! The JavaScript and Java tables express the declaration *shapes* as regular expressions; this port
//! has no regex crate and must not grow one, so the shapes are named variants ([`Shape`]) that the
//! tokenizer matches by hand. The behaviour is what has to agree across the ports, not the spelling.

/// A block comment pair. `nested` = Rust, Kotlin, Zig, Haskell; `line_start` = Ruby's `=begin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockComment {
    pub open: String,
    pub close: String,
    pub nested: bool,
    pub line_start: bool,
}

impl BlockComment {
    pub fn new(open: &str, close: &str) -> Self {
        Self {
            open: open.into(),
            close: close.into(),
            nested: false,
            line_start: false,
        }
    }

    pub fn nested(open: &str, close: &str) -> Self {
        Self {
            open: open.into(),
            close: close.into(),
            nested: true,
            line_start: false,
        }
    }

    pub fn at_line_start(open: &str, close: &str) -> Self {
        Self {
            open: open.into(),
            close: close.into(),
            nested: false,
            line_start: true,
        }
    }
}

/// How a string literal escapes its closer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Escape {
    /// `\` before it.
    Backslash,
    /// The closer doubled (SQL `''`, VB `""`, C# `@"…""…"`).
    Doubling,
    /// Not at all (Go's backticks, Python's raw strings, Rust's `r#"…"#`).
    None,
}

/// What the body of a string form must look like, beyond opening and closing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content {
    /// Anything.
    Any,
    /// One character or one escape — the check that keeps a Rust lifetime (`'a`) out of the mask while
    /// `'a'` is a char literal.
    SingleChar,
}

/// One string form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringKind {
    /// The literal opener, e.g. `"`, `"""`, `r'`, `@"`.
    pub open: String,
    /// The closer; `hashes` computes it from the opener's own hash count.
    pub close: String,
    pub escape: Escape,
    pub multiline: bool,
    /// Runs to the end of the line (Zig `\\`).
    pub line_scoped: bool,
    /// The opener may not follow an identifier character.
    pub boundary: bool,
    /// Rust raw string: `r#*"` … `"#*`.
    pub hashes: bool,
    /// The closer must be this close (the char-versus-lifetime rule).
    pub max_span: Option<usize>,
    pub content: Content,
}

impl StringKind {
    /// The common form: an opener, a closer, and the default backslash escaping.
    pub fn new(open: &str, close: &str) -> Self {
        Self {
            open: open.into(),
            close: close.into(),
            escape: Escape::Backslash,
            multiline: false,
            line_scoped: false,
            boundary: false,
            hashes: false,
            max_span: None,
            content: Content::Any,
        }
    }

    /// A form that takes no escapes at all.
    pub fn raw(open: &str, close: &str) -> Self {
        Self {
            escape: Escape::None,
            ..Self::new(open, close)
        }
    }

    /// A form that escapes its closer by doubling it.
    pub fn doubling(open: &str, close: &str) -> Self {
        Self {
            escape: Escape::Doubling,
            ..Self::new(open, close)
        }
    }

    /// A form that runs to the end of the line (Zig's `\\`).
    pub fn line_scoped(open: &str) -> Self {
        Self {
            line_scoped: true,
            multiline: true,
            close: String::new(),
            ..Self::new(open, "")
        }
    }

    /// A constrained char literal: at most a couple of units, closed within a few more.
    pub fn single_char(open: &str) -> Self {
        Self {
            max_span: Some(12),
            content: Content::SingleChar,
            ..Self::new(open, "'")
        }
    }

    pub fn multiline(mut self) -> Self {
        self.multiline = true;
        self
    }

    pub fn boundary(mut self) -> Self {
        self.boundary = true;
        self
    }

    pub fn hashes(mut self) -> Self {
        self.hashes = true;
        self
    }

    pub fn escaped(mut self, escape: Escape) -> Self {
        self.escape = escape;
        self
    }
}

/// Whether `<<TAG` heredoc bodies are blanked, and how strictly they are recognised.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Heredoc {
    /// Not a heredoc language.
    None,
    /// Shell and PHP: a bare `<<TAG` counts.
    Any,
    /// Ruby: only `<<~TAG`, `<<-TAG` or a quoted tag, so `array << x` is safe.
    Strict,
}

/// A declaration shape this language adds to the generic ones.
///
/// Each variant is a regular expression in the JavaScript table; here it is a matcher the tokenizer
/// implements, because this port has no regex engine and must not take one on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Ruby's paren-less `def name`, body closed by `end`.
    RubyMethod,
    /// Haskell's top-level binding, one line or an indented continuation.
    HaskellBinding,
    /// Haskell's `data`/`newtype`/`type`/`class` declaration.
    HaskellType,
    /// Rust's `impl … Type {`, named after the type the header ends with.
    RustImpl,
    /// Rust's `name: Type,` field — the generic property shape wants `name = …`.
    RustField,
    /// VB's `Class`/`Module`/`Structure name`, body closed by `End`.
    VbClass,
    /// VB's `Sub`/`Function name`, body closed by `End`.
    VbMethod,
}

/// What counts as the annotation directly above a declaration, for the `+` scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Annotation {
    /// `@Decorator` and `#[attribute]`.
    Default,
    /// Haskell's `name ::` type signature.
    NameSignature,
}

/// One language's lexical data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Syntax {
    pub name: String,
    pub line_comments: Vec<String>,
    pub block_comments: Vec<BlockComment>,
    pub strings: Vec<StringKind>,
    pub heredoc: Heredoc,
    pub shapes: Vec<Shape>,
    pub annotation: Annotation,
}

impl Syntax {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            line_comments: Vec::new(),
            block_comments: Vec::new(),
            strings: Vec::new(),
            heredoc: Heredoc::None,
            shapes: Vec::new(),
            annotation: Annotation::Default,
        }
    }

    pub fn line_comments(mut self, spellings: &[&str]) -> Self {
        self.line_comments = spellings.iter().map(|s| (*s).to_string()).collect();
        self
    }

    pub fn block(mut self, open: &str, close: &str) -> Self {
        self.block_comments.push(BlockComment::new(open, close));
        self
    }

    pub fn nested_block(mut self, open: &str, close: &str) -> Self {
        self.block_comments.push(BlockComment::nested(open, close));
        self
    }

    pub fn line_start_block(mut self, open: &str, close: &str) -> Self {
        self.block_comments
            .push(BlockComment::at_line_start(open, close));
        self
    }

    pub fn string(mut self, kind: StringKind) -> Self {
        self.strings.push(kind);
        self
    }

    pub fn heredoc(mut self, mode: Heredoc) -> Self {
        self.heredoc = mode;
        self
    }

    pub fn shape(mut self, shape: Shape) -> Self {
        self.shapes.push(shape);
        self
    }

    pub fn annotation(mut self, annotation: Annotation) -> Self {
        self.annotation = annotation;
        self
    }

    /// Normalise as `normalizeSyntax` does: the opener that appears first at a position wins, so
    /// longest first, and a string form with no opener — or with no closer and no way to end (no
    /// hashes, not line-scoped) — is dropped.
    pub fn normalised(mut self) -> Self {
        self.line_comments
            .sort_by_key(|value| std::cmp::Reverse(value.len()));
        self.block_comments
            .sort_by_key(|block| std::cmp::Reverse(block.open.len()));
        self.strings.retain(|kind| {
            !kind.open.is_empty() && (!kind.close.is_empty() || kind.hashes || kind.line_scoped)
        });
        self.strings
            .sort_by_key(|kind| std::cmp::Reverse(kind.open.len()));
        self
    }
}
