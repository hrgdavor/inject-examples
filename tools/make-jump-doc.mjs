// Write `docs/jump-demo.md`, the source of the **navigation** demo.
//
// It is not `docs/demo.md` with different prose. An injection document answers
// "what text does this reference put here?", so a reference is a marker and the
// block under it is the answer. A navigation document answers "where does this
// reference send me?", so a reference is just a link: there is nothing to put in
// the document, and nothing to keep in sync. That is why this file has no fenced
// blocks at all, and why every reference in it is a plain Markdown link.
//
// Every reference is resolved while this runs, so the document cannot contain a
// link the tool would refuse to follow.
import { readFileSync, writeFileSync } from "node:fs";
import { planMarker, ruleFor } from "../index.mjs";

const OUT = "docs/jump-demo.md";
const SAMPLES = "docs/";

/**
 * The document, in order. `slug` is the page the section is published on and
 * must match `JUMP_PAGES` in `tools/build-demo.mjs`.
 *
 * A section's `prose` is short on purpose — a navigation page is scanned, not
 * read — and each `example` is a reference plus, when it helps, the line a
 * reader lands on.
 */
const SECTIONS = [
    // --- The overview: what a jump is --------------------------------------
    {
        title: 'A jump lands on one line',
        slug: 'overview',
        prose: [
            'A jump is not a copy. Clicking a reference moves the cursor to the **first line** of what it '
            + 'selected, and that is all a reader needs: the code stays where it is, in the file that owns it.',
            'So a reference that covers a whole method puts the cursor on the method — not on every line of its '
            + 'body. Compare `#toString` with `#toString/-`: the same method, but the second asks for its body, '
            + 'and a body starts one line later.',
        ],
        examples: [
            { sample: 'Inventory.java', reference: 'toString', note: 'the declaration' },
            { sample: 'Inventory.java', reference: 'toString/-', note: 'its body' },
            { sample: 'Inventory.java', reference: 'toString/++', note: 'and the annotation above it' },
        ],
    },
    {
        title: 'A region lands inside it',
        slug: 'overview',
        prose: [
            'A `#region` directive marks a stretch of a file without naming a construct, which is what makes it '
            + 'useful for code that has no nameable member. The directive lines are not part of the selection, so '
            + 'the cursor goes to the first line **inside** the region.',
        ],
        examples: [
            { sample: 'Inventory.java', reference: 'catalog', note: 'the first line the directives wrap' },
        ],
    },
    {
        title: 'An envelope lands on the declaration that holds the member',
        slug: 'overview',
        prose: [
            'A member copied out of its type reads as a fragment. The marks `^` and `$` name the type itself, so '
            + 'the head of an envelope is the type\'s **declaration line** — which is where a reader lands when they '
            + 'jump to the envelope: at the declaration that gives the member its place.',
        ],
        examples: [
            { sample: 'Cart.rs', reference: 'Cart/^,add,$', note: 'the impl that holds add' },
        ],
    },
    {
        title: 'When the exact block is gone',
        slug: 'overview',
        prose: [
            'Code moves. A reference can outlive the name it mentions, and the mapper never guesses: it answers '
            + 'with the exact line or it fails, and the failure says what it looked for.',
            'What makes that survivable is the **deepest prefix that still resolves**. If `render` is renamed, '
            + '`#Inventory/Item/render` can still land a reader on `Item` — one keystroke from the new name — '
            + 'instead of dropping them at the top of the file.',
        ],
        examples: [
            { sample: 'Inventory.java', reference: 'Inventory/Item/render', note: 'names the member inside the class' },
        ],
    },
    {
        title: 'When two blocks answer to one name',
        slug: 'overview',
        prose: [
            'Some names are not unique. `Cart` answers to both a Rust type and its `impl` blocks, so a bare '
            + '`#Cart` does not say which one a reader wants — and the mapper refuses to pick for them.',
            'The refusal is the information: it names the candidates. A reference that does choose — '
            + '`#Cart/add` — says which holder it means, and that is the one the cursor goes to.',
        ],
        examples: [
            { sample: 'Cart.rs', reference: 'Cart/add', note: 'the member, in the impl that holds it' },
            { sample: 'Cart.rs', reference: 'Cart/remove', note: 'and its sibling' },
        ],
    },

    // --- Languages ---------------------------------------------------------
    {
        title: 'Java: a declaration and the member nested in it',
        slug: 'java',
        prose: [
            'A path descends, and only the last segment selects. `#Inventory/Item/render` therefore lands on '
            + '`render`, not on the nested class that contains it.',
        ],
        examples: [
            { sample: 'Inventory.java', reference: 'Inventory/Item', note: 'the nested class' },
            { sample: 'Inventory.java', reference: 'Inventory/Item/render', note: 'a method of that class' },
        ],
    },
    {
        title: 'Java: a modifier moves the landing line',
        slug: 'java',
        prose: [
            'A modifier decides how much of the declaration is selected, and so decides the line: `/++` includes '
            + 'the annotated header, the plain name starts at the declaration, `/-` starts at the body.',
        ],
        examples: [
            { sample: 'Inventory.java', reference: 'toString/++', note: 'the annotation and the declaration' },
            { sample: 'Inventory.java', reference: 'toString', note: 'just the declaration' },
            { sample: 'Inventory.java', reference: 'toString/-', note: 'just the body' },
        ],
    },
    {
        title: 'JavaScript: a member, its body and its annotation',
        slug: 'javascript',
        prose: [
            'The same three landings in a class whose braces a template literal could confuse: the lexer keeps a '
            + '`{` inside a string from ending the block early, so the jump is still the method.',
        ],
        examples: [
            { sample: 'cart.js', reference: 'render/+', note: 'the deprecated annotation' },
            { sample: 'cart.js', reference: 'render', note: 'the method' },
            { sample: 'cart.js', reference: 'render/-', note: 'and its body' },
        ],
    },
    {
        title: 'Go: a function and a switch literal',
        slug: 'go',
        prose: [
            'Go declares its members at the top level, so there is no nesting to descend and a function name is '
            + 'enough. A raw string is not code, so a name written inside one is never a landing place.',
        ],
        examples: [
            { sample: 'Cart.go', reference: 'Add', note: 'a function' },
            { sample: 'Cart.go', reference: 'Dispatch', note: 'and the one that tests a literal' },
        ],
    },
    {
        title: 'Rust: a member two impls answer to',
        slug: 'rust',
        prose: [
            'A type and its `impl` blocks all answer to the type\'s name, which is exactly why a path is worth '
            + 'writing: `#Cart/add` says which holder is meant, and the cursor goes to `add` inside that impl.',
        ],
        examples: [
            { sample: 'Cart.rs', reference: 'Cart/add', note: 'the member in its impl' },
            { sample: 'Cart.rs', reference: 'add/-', note: 'its body' },
        ],
    },
    {
        title: 'Rust: the envelope names the impl',
        slug: 'rust',
        prose: [
            'The marks retry the candidates a name answers to, so `#Cart/^,add,$` is not ambiguous: the member '
            + 'between the marks decides, and the jump lands on that `impl`\'s own first line.',
        ],
        examples: [
            { sample: 'Cart.rs', reference: 'Cart/^,add,$', note: 'the impl that holds add' },
        ],
    },
    {
        title: 'Python: an indented method and its class',
        slug: 'python',
        prose: [
            'An indented block has no brace to end it, so the mapper reads indentation instead — and a jump into '
            + 'one still lands on the line the `def` is written on.',
        ],
        examples: [
            { sample: 'Cart.py', reference: 'Cart', note: 'the class' },
            { sample: 'Cart.py', reference: 'Cart/total', note: 'a method inside it' },
            { sample: 'Cart.py', reference: 'Cart/total/-', note: 'and its body' },
        ],
    },
    {
        title: 'C#: a method and its body',
        slug: 'csharp',
        prose: [
            'A method lands on its signature; a modifier on the same method lands inside it. A verbatim string '
            + 'with a brace in it does not end the block.',
        ],
        examples: [
            { sample: 'Cart.cs', reference: 'Cart/Add', note: 'the method' },
            { sample: 'Cart.cs', reference: 'Cart/Add/-', note: 'its body' },
        ],
    },
    {
        title: 'Kotlin: a fun and its body',
        slug: 'kotlin',
        prose: [
            'A `fun` is a declaration like any other, and a wrapped parameter list belongs to the signature — so '
            + 'the cursor stays on the first line of the declaration.',
        ],
        examples: [
            { sample: 'Cart.kt', reference: 'Cart/add', note: 'the fun' },
            { sample: 'Cart.kt', reference: 'Cart/add/-', note: 'its body' },
        ],
    },
    {
        title: 'PHP: a method and its heredoc',
        slug: 'php',
        prose: [
            'A heredoc body is data, so a name inside one is invisible to the mapper. The method itself lands on '
            + 'its declaration, and a method is addressed through the class that holds it.',
        ],
        examples: [
            { sample: 'Cart.php', reference: 'Cart/add', note: 'the method' },
            { sample: 'Cart.php', reference: 'Cart/add/-', note: 'its body' },
        ],
    },
    {
        title: 'Ruby: a def and the end that closes it',
        slug: 'ruby',
        prose: [
            'A `def` runs to the `end` that closes it, and the word `end` is what the matcher follows — so the '
            + 'selection is the whole method while the jump is its first line.',
        ],
        examples: [
            { sample: 'Cart.rb', reference: 'Cart', note: 'the class' },
            { sample: 'Cart.rb', reference: 'Cart/add', note: 'a method' },
            { sample: 'Cart.rb', reference: 'Cart/add/-', note: 'its body' },
        ],
    },
    {
        title: 'Shell: a function and the region around it',
        slug: 'shell',
        prose: [
            'A script has no classes, so a region is how settings stay addressable, and a function is addressed by '
            + 'its own name. A heredoc is data, and the brace inside it does not open a block.',
        ],
        examples: [
            { sample: 'run.sh', reference: 'count', note: 'a region' },
            { sample: 'run.sh', reference: 'deploy', note: 'a function' },
            { sample: 'run.sh', reference: 'legacy', note: 'a function anchored by a trailing comment' },
        ],
    },
    {
        title: 'VB: a function and its End',
        slug: 'vb',
        prose: [
            'A `Function` closes at `End Function`, and the member is addressed through the class. A function that '
            + 'tests a literal is named by the line that tests it.',
        ],
        examples: [
            { sample: 'Form.vb', reference: 'Form/Add', note: 'the function' },
            { sample: 'Form.vb', reference: 'Form/Add/-', note: 'its body' },
            { sample: 'Form.vb', reference: 'Form/Dispatch', note: 'and the one that tests a literal' },
        ],
    },
    {
        title: 'Haskell: a binding and its signature',
        slug: 'haskell',
        prose: [
            'A binding lands on its own line, and `+` brings the `name ::` signature above it — which is where a '
            + 'reader wants to be when the type is the interesting part.',
        ],
        examples: [
            { sample: 'Main.hs', reference: 'add', note: 'the binding' },
            { sample: 'Main.hs', reference: 'add/+', note: 'with its signature' },
            { sample: 'Main.hs', reference: 'dispatch', note: 'and one that tests a literal' },
        ],
    },
    {
        title: 'Zig: a function and a region',
        slug: 'zig',
        prose: [
            'Zig nests block comments, so a declaration written inside one is invisible to the matcher — which is '
            + 'what keeps a decoy from becoming the landing place.',
        ],
        examples: [
            { sample: 'Nesting.zig', reference: 'target', note: 'a function' },
            { sample: 'Nesting.zig', reference: 'count', note: 'one that switches on a literal' },
            { sample: 'Nesting.zig', reference: 'catalog', note: 'and a region' },
        ],
    },
    {
        title: 'YAML: a key path',
        slug: 'yaml',
        prose: [
            'A config reference names a key path, and a jump lands on the line that key is written on — '
            + '`#server/port` goes to `port`, not to the `server` block that holds it.',
        ],
        examples: [
            { sample: 'app.yaml', reference: 'server/port', note: 'a nested key' },
            { sample: 'app.yaml', reference: 'server', note: 'and the block that holds it' },
        ],
    },
    {
        title: 'TOML: a table and a key',
        slug: 'toml',
        prose: [
            'A dotted path reads the same way in TOML: the table is where it is written, the key is the line that '
            + 'reads it, and a nested table is a path of its own.',
        ],
        examples: [
            { sample: 'app.toml', reference: 'server/port', note: 'a key in a table' },
            { sample: 'app.toml', reference: 'server/tls/enabled', note: 'a key in a nested table' },
        ],
    },
    {
        title: 'INI: a section and a key',
        slug: 'ini',
        prose: [
            'A `[section]` header is a landing place of its own, and a `section.key` lands on the key\'s line.',
        ],
        examples: [
            { sample: 'app.ini', reference: 'server', note: 'the section' },
            { sample: 'app.ini', reference: 'server/port', note: 'a key inside it' },
        ],
    },
    {
        title: 'JSON: a nested key',
        slug: 'json',
        prose: [
            'A JSON key path lands on the line the selected key is written on — the outermost key the path names, '
            + 'since that is where a reader has to start reading.',
        ],
        examples: [
            { sample: 'api.json', reference: 'name', note: 'a top-level key' },
            { sample: 'api.json', reference: 'server/port', note: 'and a nested one' },
        ],
    },
    {
        title: 'CSS: an at-rule and a rule inside it',
        slug: 'css',
        prose: [
            'A rule is named by its rightmost simple selector and an at-rule by its keyword. `/` descends the '
            + 'nesting CSS already has, so a rule inside an at-rule is a path.',
        ],
        examples: [
            { sample: 'site.css', reference: '@media', note: 'the at-rule' },
            { sample: 'site.css', reference: '@media/.card/-', note: 'the declarations of a rule inside it' },
            { sample: 'site.css', reference: '@keyframes:pulse', note: 'and another at-rule' },
        ],
    },
];

// Resolve every reference first, so the document cannot contain a link the tool
// would refuse to follow. A failure here is a bug in this table.
let checked = 0;
for (const section of SECTIONS) {
    for (const example of section.examples) {
        const path = `samples/${example.sample}`;
        const read = () => readFileSync(SAMPLES + path, "utf8");
        try {
            planMarker({ path, reference: example.reference }, read, ruleFor(example.sample));
        } catch (cause) {
            throw new Error(`"#${example.reference}" in ${example.sample}: ${cause.message}`);
        }
        checked += 1;
    }
}

const lines = [];
const push = (...rows) => lines.push(...rows);

push('# Jumping to a code section', '');
push('A reference is a **destination**. This page is about where a reader arrives — the line a jump '
    + 'selects — and what happens when the code it named has moved. Nothing is copied into this page: the '
    + 'samples stay in their own files, and every link below moves a cursor instead of embedding text.', '');
push('Click a reference and the file beside it scrolls to the line that reference selects. That one line '
    + 'is highlighted; the rest of the file is there for context, exactly as an editor would show it.', '');
push('The same reference syntax also keeps code samples honest. That is the other demo — this one is '
    + 'about navigation.', '');

for (const section of SECTIONS) {
    push(`## ${section.title}`, '');
    for (const paragraph of section.prose) push(paragraph, '');
    for (const example of section.examples) {
        const label = `samples/${example.sample}#${example.reference}`;
        push(`[${label}](./${label})`, '');
        // No emphasis: the renderer handles "**" and backticks but not "_"/"*"
        // around a whole line, and a note that rendered as literal asterisks
        // would be worse than a plain sentence.
        if (example.note) push(example.note, '');
    }
}

writeFileSync(OUT, `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, "utf8");
console.log(`wrote ${OUT}: ${SECTIONS.length} sections, ${checked} references, all resolved`);
