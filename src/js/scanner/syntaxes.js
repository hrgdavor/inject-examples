// ============================================================================
// LANGUAGE TABLE
// One entry per language. `tokenizer.js` walks them; nothing here executes, so
// adding a language is adding an object, and every entry is portable to another
// implementation (the Zig port mirrors the same table).
//
// A language that is not here falls back to `lib/section.mjs`'s built-in mask,
// the language-agnostic union — the same answer a reference gets when the type
// is unknown, which is why an entry is only worth adding when the union is
// WRONG for that language (a nested comment, a raw string, a heredoc, or a `'`
// that is a lifetime rather than a char literal).
//
// Comments on most entries say which construct the entry exists for.
// ============================================================================

/** `//` and the C block pair (`/* … *\/`) — the C family's two spellings. */
const C_LINE = ['//'];
const C_BLOCK = [{ open: '/*', close: '*/', nested: false }];

/**
 * A Rust char literal: `'a'`, `'\n'`, `' '` — one character or one escape,
 * closed within a few characters. Rejecting everything else is what keeps a
 * lifetime (`'a`, `'static`) out of the mask.
 */
const SINGLE_CHAR = {
    open: "'", close: "'", escape: 'backslash', maxSpan: 12,
    content: /^(?:\\.{1,10}|[^\n\\]{1,2})$/,
};

/**
 * Ruby's `def` needs no parentheses, so the generic `name(` shape misses
 * `def add`. `self.` is stripped; `?`, `!` and `=` are part of the name. The
 * body is the `end`-delimited block (see `keywordBody` in lib/section.mjs).
 */
const RUBY_DECLARATIONS = [
    { kind: 'method', re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, body: 'end', end: 'end' },
];

/**
 * Haskell's two shapes the generic matcher cannot see: a top-level binding
 * (`add x y = x + y`, one line or an indented `where` continuation) and a
 * type/class declaration (`data Cart = …`, `class Store s where`). A binding's
 * `name ::` signature line is its annotation, so `#+add` brings it along.
 */
const HASKELL_DECLARATIONS = [
    // The lookahead keeps the words that *open* a declaration (`data Cart = …`)
    // from being read as a binding named `data`.
    {
        kind: 'method',
        re: /^(?!(?:data|newtype|type|class|instance|module|import|infix[lr]?|foreign|deriving|default)\b)([a-z_][\w']*)\b[^=\n]*=/,
        line: true,
    },
    { kind: 'class', re: /^(?:data|newtype|type|class)\s+(?:\([^)]*\)\s*=>\s*)?([A-Z][\w']*)/ },
];

const HASKELL_ANNOTATIONS = [/^\s*[\w']+\s*::/];

/**
 * Rust's members live in `impl` blocks, not in the type: `impl Cart { fn add }`
 * is where `add` is, while `Cart` itself is a `struct`. The impl is declared as
 * a class-like scope named after the **type** — the identifier that ends the
 * header, so `impl Display for Cart<T> where T: Clone` is a scope called `Cart`
 * — which makes it a sibling of the `struct Cart`; the resolver retries
 * same-named scopes, so `Cart/add` reaches the method and `Cart/items` the
 * field. A trait's body-less methods have nothing to inject and stay invisible.
 */
const RUST_DECLARATIONS = [
    { kind: 'class', re: /^\s*impl\b[^{]*?\b([A-Za-z_][\w:]*)\s*(?:<[^>]*>)?\s*(?:where\b[^{]*)?\{/ },
    // A field is `name: Type,` — the generic property shape wants `name = …`,
    // which Rust never writes.
    { kind: 'property', re: /^\s*(?:pub\s+)?([A-Za-z_]\w*)\s*:/, line: true },
];

/**
 * VB declares with capitalised keywords (`Public Class Form`, `Public Function
 * Add`) and closes every block with a keyword line (`End Function`, `End Class`),
 * so both the generic lowercase `class` shape and the brace/indent body rules
 * miss it. The terminator is matched as VB writes it, `End` capitalised.
 */
const VB_DECLARATIONS = [
    {
        kind: 'class',
        re: /^\s*(?:Public|Private|Friend|Protected)?\s*(?:NotInheritable\s+|MustInherit\s+)?(?:Class|Module|Structure)\s+(\w+)/,
        body: 'end',
        end: 'End',
    },
    {
        kind: 'method',
        re: /^\s*[\w\s]*?\b(?:Sub|Function)\s+(\w+)/,
        body: 'end',
        end: 'End',
    },
];

// --- the three originals, unchanged in behaviour ---------------------------

/** JavaScript / TypeScript: `//`, `/* *\/`, `'` `"` and backtick templates. */
export const JS_SYNTAX = {
    name: 'javascript',
    lineComments: C_LINE,
    blockComments: C_BLOCK,
    strings: [
        { open: '`', close: '`', escape: 'backslash', multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        { open: "'", close: "'", escape: 'backslash' },
    ],
};

/** Java: `//`, `/* *\/`, `'` `"` and text blocks `"""`. */
export const JAVA_SYNTAX = {
    name: 'java',
    lineComments: C_LINE,
    blockComments: C_BLOCK,
    strings: [
        { open: '"""', close: '"""', escape: 'backslash', multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        { open: "'", close: "'", escape: 'backslash' },
    ],
};

/** Zig: `//`, NESTED `/* *\/`, `"` and multiline strings `\\` (to end of line). */
export const ZIG_SYNTAX = {
    name: 'zig',
    lineComments: C_LINE,
    blockComments: [{ open: '/*', close: '*/', nested: true }],
    strings: [
        { open: '\\\\', close: '', lineScoped: true },
        { open: '"', close: '"', escape: 'backslash' },
    ],
};

// --- the rest of the table -------------------------------------------------

export const GO_SYNTAX = {
    name: 'go',
    lineComments: C_LINE,
    blockComments: C_BLOCK,
    strings: [
        // Backtick raw strings take no escapes at all.
        { open: '`', close: '`', escape: null, multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        SINGLE_CHAR,
    ],
};

export const RUST_SYNTAX = {
    name: 'rust',
    lineComments: C_LINE,
    // Rust block comments nest: `/* outer /* inner */ still outer */`.
    blockComments: [{ open: '/*', close: '*/', nested: true }],
    strings: [
        // `r#"…"#`: the closer is the opener's own hash count.
        { open: 'br"', close: '"', escape: null, multiline: true, boundary: true, hashes: true },
        { open: 'r"', close: '"', escape: null, multiline: true, boundary: true, hashes: true },
        { open: 'b"', close: '"', escape: 'backslash', boundary: true },
        { open: '"', close: '"', escape: 'backslash' },
        { ...SINGLE_CHAR, open: "b'", boundary: true },
        SINGLE_CHAR,
    ],
    declarations: RUST_DECLARATIONS,
};

export const PYTHON_SYNTAX = {
    name: 'python',
    lineComments: ['#'],
    blockComments: [],
    strings: [
        // Raw strings do not escape, so `r"\""` ends at the second quote.
        { open: 'r"""', close: '"""', escape: null, multiline: true, boundary: true },
        { open: "r'''", close: "'''", escape: null, multiline: true, boundary: true },
        { open: 'rb"', close: '"', escape: null, boundary: true },
        { open: "rb'", close: "'", escape: null, boundary: true },
        { open: 'br"', close: '"', escape: null, boundary: true },
        { open: "br'", close: "'", escape: null, boundary: true },
        { open: 'r"', close: '"', escape: null, boundary: true },
        { open: "r'", close: "'", escape: null, boundary: true },
        { open: '"""', close: '"""', escape: 'backslash', multiline: true },
        { open: "'''", close: "'''", escape: 'backslash', multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        { open: "'", close: "'", escape: 'backslash' },
    ],
};

export const CSHARP_SYNTAX = {
    name: 'csharp',
    lineComments: C_LINE,
    blockComments: C_BLOCK,
    strings: [
        // Verbatim (`@"…""…"`) and interpolated-verbatim spellings.
        { open: '$@"', close: '"', escape: 'doubling', multiline: true, boundary: true },
        { open: '@$"', close: '"', escape: 'doubling', multiline: true, boundary: true },
        { open: '@"', close: '"', escape: 'doubling', multiline: true, boundary: true },
        // C# 11 raw string literals: no escapes, any number of quotes.
        { open: '"""', close: '"""', escape: null, multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        { open: "'", close: "'", escape: 'backslash' },
    ],
};

export const KOTLIN_SYNTAX = {
    name: 'kotlin',
    lineComments: C_LINE,
    // Kotlin block comments nest, like Rust's.
    blockComments: [{ open: '/*', close: '*/', nested: true }],
    strings: [
        { open: '"""', close: '"""', escape: null, multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        { open: "'", close: "'", escape: 'backslash' },
    ],
};

export const PHP_SYNTAX = {
    name: 'php',
    // Both spellings; `#[Attribute]` stays readable (see tokenizer.js).
    lineComments: ['//', '#'],
    blockComments: C_BLOCK,
    strings: [
        { open: '"', close: '"', escape: 'backslash', multiline: true },
        { open: "'", close: "'", escape: 'backslash', multiline: true },
    ],
    // `<<<EOT` and `<<<'EOT'` bodies are not code.
    heredoc: true,
};

export const RUBY_SYNTAX = {
    name: 'ruby',
    lineComments: ['#'],
    // `=begin` / `=end` only count at column 0.
    blockComments: [{ open: '=begin', close: '=end', lineStart: true }],
    strings: [
        { open: '"', close: '"', escape: 'backslash', multiline: true },
        { open: "'", close: "'", escape: 'backslash', multiline: true },
        { open: '`', close: '`', escape: 'backslash', multiline: true },
    ],
    // Strict: only `<<~TAG`, `<<-TAG` or a quoted tag; `array << x` is safe.
    heredoc: 'strict',
    declarations: RUBY_DECLARATIONS,
};

export const SQL_SYNTAX = {
    name: 'sql',
    lineComments: ['--'],
    blockComments: [{ open: '/*', close: '*/', nested: false }],
    strings: [
        // Postgres dollar quoting.
        { open: '$$', close: '$$', escape: null, multiline: true },
        // Standard SQL doubles the quote to escape it.
        { open: "'", close: "'", escape: 'doubling' },
        { open: '"', close: '"', escape: 'doubling' },
        { open: '`', close: '`', escape: 'doubling' },
    ],
};

export const SHELL_SYNTAX = {
    name: 'shell',
    lineComments: ['#'],
    blockComments: [],
    strings: [
        // Single quotes take no escapes at all in shell.
        { open: "'", close: "'", escape: null, multiline: true },
        { open: '"', close: '"', escape: 'backslash', multiline: true },
        { open: '`', close: '`', escape: 'backslash', multiline: true },
    ],
    heredoc: true,
};

export const VB_SYNTAX = {
    name: 'vb',
    lineComments: ["'"],
    blockComments: [],
    strings: [{ open: '"', close: '"', escape: 'doubling' }],
    declarations: VB_DECLARATIONS,
};

export const HASKELL_SYNTAX = {
    name: 'haskell',
    lineComments: ['--'],
    // `{- -}` nests, and Haskell string gaps let a `"…"` span lines.
    blockComments: [{ open: '{-', close: '-}', nested: true }],
    strings: [
        { open: '"', close: '"', escape: 'backslash', multiline: true },
        { open: "'", close: "'", escape: 'backslash' },
    ],
    declarations: HASKELL_DECLARATIONS,
    annotations: HASKELL_ANNOTATIONS,
};

// --- data formats ----------------------------------------------------------
//
// These have no members to search, but their comments and strings still have to
// be masked so a `#`/`;` inside a quoted value is never read as one (and so the
// key-based region rules read the right lines).

export const YAML_SYNTAX = {
    name: 'yaml',
    lineComments: ['#'],
    blockComments: [],
    strings: [
        // YAML doubles a single quote, and both forms may fold across lines.
        { open: '"', close: '"', escape: 'backslash', multiline: true },
        { open: "'", close: "'", escape: 'doubling', multiline: true },
    ],
};

export const TOML_SYNTAX = {
    name: 'toml',
    lineComments: ['#'],
    blockComments: [],
    strings: [
        // Multi-line basic and literal strings are three quotes.
        { open: '"""', close: '"""', escape: 'backslash', multiline: true },
        { open: "'''", close: "'''", escape: null, multiline: true },
        { open: '"', close: '"', escape: 'backslash' },
        { open: "'", close: "'", escape: null },
    ],
};

export const INI_SYNTAX = {
    name: 'ini',
    // `;` is the classic form; `#` is common too.
    lineComments: [';', '#'],
    blockComments: [],
    strings: [
        { open: '"', close: '"', escape: null },
        { open: "'", close: "'", escape: null },
    ],
};

/** Every language, by the name `lexerFor` reports. */
export const SYNTAXES = {
    javascript: JS_SYNTAX,
    typescript: { ...JS_SYNTAX, name: 'typescript' },
    java: JAVA_SYNTAX,
    zig: ZIG_SYNTAX,
    go: GO_SYNTAX,
    rust: RUST_SYNTAX,
    python: PYTHON_SYNTAX,
    csharp: CSHARP_SYNTAX,
    kotlin: KOTLIN_SYNTAX,
    php: PHP_SYNTAX,
    ruby: RUBY_SYNTAX,
    sql: SQL_SYNTAX,
    shell: SHELL_SYNTAX,
    vb: VB_SYNTAX,
    haskell: HASKELL_SYNTAX,
    yaml: YAML_SYNTAX,
    toml: TOML_SYNTAX,
    ini: INI_SYNTAX,
};
