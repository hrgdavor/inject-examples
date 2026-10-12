/**
 * `lib/css.mjs` — the region rule for CSS.
 *
 * A `.css` reference names a **rule**, not a declaration: a style rule by the
 * rightmost simple selector of its selector list (`.card`, `li.item`), or an
 * at-rule by its keyword (`@media`, `@keyframes`), optionally narrowed by its
 * parameter. `/` descends exactly as it does everywhere else, and here the
 * containment is CSS's own — a rule inside `@media` is a child of that at-rule —
 * so the descendant relationship needs no combinator syntax.
 *
 * This is the "one reference grammar, four rules that read it" split of
 * RFC §9.4 with a fifth reader: the *path* is the same `/`-separated path, and
 * what a segment *names* is CSS's vocabulary, not a declaration name.
 *
 * Pure and dependency-free, like `lib/section.mjs`: text in, text out. The
 * masking is **not** done here — a caller hands in the file's own text, and the
 * rule reads it the way a stylesheet is read: structure from braces, and
 * `/* … *​/` comment spans skipped so a `}` inside a comment cannot close a block.
 *
 * ## The reference
 *
 * ```
 * .card                    the rule whose rightmost simple selector is `.card`
 * card                     the same rule, or the type selector `card`
 * .card-                   that rule's declarations alone
 * @media                   the whole at-rule block
 * @media:screen            the at-rule whose parameter contains `screen`
 * @keyframes:pulse         the named keyframes block
 * @media/.card             the `.card` rule inside the at-rule
 * .card[data-variant=compact]   the rule whose selector carries that attribute
 * [attr=--brand]           the rule that declares the custom property `--brand`
 * [sel=:hover]             the rule whose selector text contains `:hover`
 * .card,.item              two rules, in the order written
 * ```
 *
 * `-` is the body-only modifier; `+` and `++` are accepted and ignored, because
 * a stylesheet has no annotations or doc comment to bring along and a harmless
 * carry-over from a code reference must not fail the include.
 */

/** A name character of a CSS identifier, as this module reads one. */
const NAME_CHAR = /[\w-]/;

/** The modifier a reference's **last segment** is, or null when it is a name.
 *
 * The spelling is the same one every rule reads: `++`, `+` and `-` are segments
 * of their own, written after the `/` that delimits them — `.card/-`, `@media/++`
 * — and they mean a body, a block with its annotations, or a block with its doc.
 * A stylesheet has no annotations and no doc comment to bring along, so `+` and
 * `++` take the whole block; `-` takes the declarations alone.
 *
 * A name is therefore left alone: `.card-` is not the body of `.card` any more,
 * it is a class called `.card-`, and a hyphenated name (`.item-list`) is a name
 * in every segment.
 *
 * @param {string} segment
 * @returns {'-' | '+' | '++' | null}
 */
function segmentModifier(segment) {
    if (segment === '++') return '++';
    if (segment === '+') return '+';
    if (segment === '-') return '-';
    return null;
}

/**
 * Read one **path segment** of a reference: the name of one CSS block.
 *
 * The name is what the file itself spells — `.card`, `#cart`, `@media`,
 * `@media (min-width: 700px)` — because CSS's own vocabulary *is* the
 * vocabulary of this rule. What a segment cannot carry is `/` (the path
 * separator) or `,` (the selector separator); everything else is the file's.
 *
 * A `[key=value]` group at the end is a **predicate**, read off the end before
 * the name is: `.card[data-variant=compact]` is the class `.card` narrowed to
 * the rule that carries that attribute.
 *
 * @param {string} text one segment, trimmed
 * @returns {{ key: string, argument: string | null, predicate: string | null }}
 */
function parseSegment(text) {
    let name = text;
    let predicate = null;

    const bracket = /\[([^\]]*)\]\s*$/.exec(name);
    if (bracket) {
        predicate = bracket[1].trim();
        name = name.slice(0, bracket.index).trim();
    }

    // An at-rule keeps its parameter: `@media (min-width: 700px)` and
    // `@media print` are different blocks, and `@keyframes pulse` names one of
    // them. A colon inside the parentheses belongs to the parameter; one written
    // before any `(` is the one-token spelling of the same thing
    // (`@keyframes:pulse`), for a parameter that carries no space of its own.
    const at = /^@([\w-]+)\s*(.*)$/.exec(name);
    if (at) {
        const argument = at[2].trim();
        if (argument.startsWith('(')) {
            return { key: `@${at[1]}`, argument: argument.replace(/^\((.*)\)$/s, '$1').trim() || null, predicate };
        }
        if (argument.includes(':')) {
            const colon = argument.indexOf(':');
            return { key: `@${at[1]}`, argument: argument.slice(colon + 1).trim(), predicate };
        }
        return { key: `@${at[1]}`, argument: argument || null, predicate };
    }

    // A selector list is not a path: the rightmost simple selector of a `.`/`#`
    // segment is the name, and a bare word names both the type and its class.
    // A leading `*` is CSS's universal selector, which this rule does not read.
    const key = name.startsWith('*') ? name.slice(1) : name;
    // A predicate needs something to describe: `[--brand]` alone names no block.
    if (key === '') throw new Error(`"#${text}" names nothing`);
    return { key, argument: null, predicate };
}

/**
 * Every selector of a reference, in the order written, each as a **path** of
 * `/`-separated segments — exactly the containment path the code rule reads.
 *
 * The path is split first and the segments are read after, so a parameter with
 * a `/`-free space in it (`@media (min-width: 700px)/.card`) is one segment and
 * not three.
 *
 * @param {string} reference
 * @returns {Array<Array<{ key: string, argument: string | null, predicate: string | null,
 *             modifier: '-' | '+' | '++' | null }>>}
 */
function parseReference(reference) {
    const selectors = reference.split(',').map((part) => part.trim()).filter((part) => part !== '');
    if (selectors.length === 0) throw new Error(`"#${reference}" names nothing`);
    return selectors.map((selector) => selector.split('/').map(parseSegment));
}

/** Every `/* … *​/` span of `text`, as `[from, to)` offsets. */
function commentSpans(text) {
    const spans = [];
    for (let at = text.indexOf('/*'); at !== -1; at = text.indexOf('/*', at + 2)) {
        const close = text.indexOf('*/', at + 2);
        const end = close === -1 ? text.length : close + 2;
        spans.push([at, end]);
        at = end - 2;
    }
    return spans;
}

/** The 0-based line of `offset`, from the line starts. */
function lineAt(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

/** The 0-based line the offset falls on, for one line start list. */
function lineStartsOf(text) {
    const starts = [0];
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
    return starts;
}

/**
 * The rightmost simple selector of `selector`, e.g. `.item` of `ul > li.item`.
 *
 * The scan walks back over the **name** characters of the last simple selector
 * and then takes the sigil that opens that run (`.`, `#`), so a descendant
 * combinator, a pseudo-class, a pseudo-element and an attribute selector all
 * fall away on their own: `ul > li.item` is `.item`, `a:hover` is `a`,
 * `input[type="text"]` is `input`, and `.a.b` is `.b`.
 *
 * @returns {string | null} the simple selector as it is written, or null
 */
function simpleSelector(selector) {
    let text = selector.trim();
    if (text === '') return null;

    // Step over the balanced `[…]`/`(…)` groups at the end first, so a `:` or a
    // `-` inside an attribute (`[data-variant=compact]`, `[type="a:b"]`) is
    // never read as a pseudo-class or a combinator.
    for (;;) {
        const last = text[text.length - 1];
        const partner = last === ']' ? '[' : last === ')' ? '(' : null;
        if (partner === null) break;
        const open = text.lastIndexOf(partner);
        if (open === -1) return null;
        text = text.slice(0, open).trimEnd();
        if (text === '') return null;
    }

    // What is left may be a pseudo-class on the end. `:root` is the one that
    // names the document element, so it is a name of its own; every other
    // pseudo is decoration on the simple selector before it.
    const pseudo = /::?[\w-]+(?:\([^)]*\))?\s*$/.exec(text);
    if (pseudo) {
        const head = text.slice(0, pseudo.index).trim();
        if (head === '') return ':root';
        text = head;
    }

    let at = text.length - 1;
    while (at >= 0 && NAME_CHAR.test(text[at])) at--;

    const name = text.slice(at + 1);
    if (name === '') return null;
    const sigil = text[at] === '.' || text[at] === '#' ? text[at] : '';
    return sigil + name;
}

/**
 * The keys a block answers to, in the order they should be tried.
 *
 * A style rule answers to its rightmost simple selector for every selector of
 * its list (`.a, .b` is one block with two keys) and, when that simple selector
 * is a bare type, to the type too. An at-rule answers to its keyword, compared
 * with the same case-insensitivity the at-keyword has.
 *
 * @returns {Array<{ key: string, bare: boolean }>}
 */
function keysOf(block) {
    if (block.at !== null) return [{ key: `@${block.at.toLowerCase()}`, bare: false }];
    const keys = [];
    for (const selector of block.selector.split(',')) {
        const simple = simpleSelector(selector);
        if (simple === null || simple === '') continue;
        const sigil = simple[0] === '.' || simple[0] === '#';
        const name = sigil ? simple.slice(1) : simple;
        if (name === '') continue;
        // The explicit spelling (`.item`) is exact; a bare type (`li`) is the
        // looser reading and is tried after every exact one.
        keys.push({ key: simple, bare: false });
        if (!sigil) keys.push({ key: name, bare: true });
    }
    return keys;
}

/**
 * The blocks and declarations of a stylesheet.
 *
 * The scan is brace-counting over a comment-stripped copy of the file: a block
 * opens at the `{` that follows its prelude and closes at the matching `}`. A
 * declaration is a `name: value` statement at the top level of a block — a
 * `{`…`}` nested at that level is a child block instead, which is what makes
 * modern nested CSS read the same as an at-rule's contents.
 *
 * @param {string} text the stylesheet
 * @returns {{ blocks: object[], root: object }}
 */
function scanStylesheet(text) {
    const spans = commentSpans(text);
    const starts = lineStartsOf(text);
    const root = { at: null, argument: null, selector: '', prelude: '', parent: null, children: [], declarations: [] };

    /**
     * @param {object} parent
     * @param {number} from offset the scope's content starts at
     * @param {number} to offset it ends at
     */
    const scan = (parent, from, to) => {
        let at = from;

        while (at < to) {
            const inside = spanAt(spans, at);
            if (inside !== -1) { at = inside; continue; }
            const char = text[at];
            if (char === ';' || char === '}' || char === '\n' || char === ' ' || char === '\t' || char === '\r') {
                at++;
                continue;
            }

            // One statement, read forward from its first character. It ends at
            // the first `;` or `{` outside a string and outside its own
            // brackets; a `}` ends it too, which is the last declaration of a
            // block written without its final `;`.
            const start = at;
            let depth = 0;
            let colon = -1;
            while (at < to) {
                const inner = spanAt(spans, at);
                if (inner !== -1) { at = inner; continue; }
                const current = text[at];
                if (current === '"' || current === "'") { at = skipString(text, at); continue; }
                if (current === '(' || current === '[') { depth++; at++; continue; }
                if (current === ')' || current === ']') { depth--; at++; continue; }
                if (depth <= 0 && (current === ';' || current === '{' || current === '}')) break;
                if (depth <= 0 && current === ':' && colon === -1) colon = at;
                at++;
            }

            const terminator = at < to ? text[at] : '';
            if (terminator === '{') {
                const preludeFrom = start;
                const prelude = text.slice(preludeFrom, at).trim();
                const atRule = /^@([\w-]+)/.exec(prelude);
                const close = matchBrace(text, spans, at, to);
                const end = close === -1 ? to : close;
                const block = {
                    at: atRule ? atRule[1] : null,
                    argument: atRule ? prelude.slice(atRule[0].length).trim() : null,
                    selector: atRule ? '' : prelude,
                    prelude,
                    parent,
                    children: [],
                    declarations: [],
                    startLine: lineAt(starts, preludeFrom),
                    openLine: lineAt(starts, at),
                    closeLine: lineAt(starts, end),
                    open: at,
                    close: end,
                    complete: close !== -1,
                };
                parent.children.push(block);
                scan(block, at + 1, end);
                at = end + 1;
                continue;
            }

            // A declaration: `name: value`, with the `:` that separates them at
            // the statement's own bracket depth, so a `url(data:…)` value and a
            // pseudo-selector are not read as a property name.
            if (colon !== -1) {
                const name = text.slice(start, colon).trim();
                if (/^(?:--)?[\w-]+$/.test(name)) {
                    parent.declarations.push({
                        name,
                        value: text.slice(colon + 1, at).trim(),
                        start,
                        end: at,
                    });
                }
            }
            if (terminator === ';') at++;
        }
    };

    scan(root, 0, text.length);
    return { blocks: flatten(root), root };
}

/** The offset just past the string that opens at `open`. */
function skipString(text, open) {
    const quote = text[open];
    let at = open + 1;
    while (at < text.length) {
        if (text[at] === '\\') { at += 2; continue; }
        if (text[at] === quote) return at + 1;
        at++;
    }
    return text.length;
}

/** The end offset of the comment span covering `at`, or -1 when `at` is code. */
function spanAt(spans, at) {
    for (const [start, end] of spans) {
        if (at < start) return -1;
        if (at < end) return end;
    }
    return -1;
}

/** The matching `}` of the `{` at `open`, or -1. Comment text is skipped. */
function matchBrace(text, spans, open, limit) {
    let depth = 0;
    for (let at = open; at < limit; at++) {
        const inside = spanAt(spans, at);
        if (inside !== -1) { at = inside - 1; continue; }
        if (text[at] === '{') depth++;
        else if (text[at] === '}') {
            depth--;
            if (depth === 0) return at;
        }
    }
    return -1;
}

/** Every block of the tree, depth first, in source order. */
function flatten(root) {
    const out = [];
    const walk = (node) => {
        for (const child of node.children) {
            out.push(child);
            walk(child);
        }
    };
    walk(root);
    return out;
}

/** Whether `block` (or anything it contains) declares the custom property `name`. */
function declares(block, name) {
    if (block.declarations.some((declaration) => declaration.name === name)) return true;
    return block.children.some((child) => declares(child, name));
}

/** Every value a predicate can read off a block. */
function factsOf(block) {
    const facts = [];
    if (block.at !== null) {
        facts.push(block.at, block.argument ?? '');
    } else {
        facts.push(block.selector);
        for (const selector of block.selector.split(',')) {
            const simple = simpleSelector(selector);
            if (simple === null) continue;
            facts.push(simple);
            facts.push(simple.replace(/^[.#]/, ''));
            for (const name of selector.matchAll(/\.([\w-]+)/g)) facts.push(name[1]);
            const id = /#([\w-]+)/.exec(selector);
            if (id) facts.push(id[1]);
        }
        for (const attribute of block.selector.matchAll(/\[\s*([\w-]+)(?:\s*[~|^$*]?=\s*("([^"]*)"|'([^']*)'|[^\]]*))?\]/g)) {
            facts.push(attribute[1]);
            const value = attribute[3] ?? attribute[4] ?? attribute[2];
            if (value !== undefined) facts.push(value.trim());
        }
    }
    for (const declaration of block.declarations) {
        facts.push(declaration.name, declaration.value);
    }
    return facts;
}

/** Whether a block satisfies `[key=value]` / `[key]`. */
function matchesPredicate(block, predicate) {
    const equals = predicate.indexOf('=');
    const key = (equals === -1 ? predicate : predicate.slice(0, equals)).trim();
    const value = equals === -1 ? null : predicate.slice(equals + 1).trim();
    if (key === '') return true;

    // `[--brand]`, `[color]`, `[data-variant]`: the block declares it.
    if (value === null) {
        if (key === 'sel' || key === 'class' || key === 'id' || key === 'tag' || key === 'attr') return false;
        return declares(block, key);
    }

    const facts = factsOf(block);
    if (key === 'sel') return block.selector.includes(value) || (block.argument ?? '').includes(value);
    if (key === 'class') {
        return block.selector.split(',').some((selector) => [...selector.matchAll(/\.([\w-]+)/g)]
            .some((match) => match[1] === value));
    }
    if (key === 'id') return /#([\w-]+)/.exec(block.selector)?.[1] === value;
    if (key === 'tag') return keysOf(block).some((entry) => entry.bare && entry.key === value);
    if (key === 'attr') return declares(block, value);
    // Any other name is an attribute or custom property read from the selector
    // or from a declaration: `[data-variant=compact]` wants both the name and
    // the value, `[color=red]` a declaration whose value is `red`.
    return facts.includes(key) && facts.includes(value);
}

/**
 * The blocks one reference selector names, in walk order.
 *
 * A key is unique in its scope — two different blocks answering to one key at
 * one level is the duplicate-key error, exactly as two `#region`s of one name
 * are — but one *block* may answer to several keys (`.a, .b { }` is one rule),
 * and that is not an ambiguity.
 *
 * @param {object} scope
 * @param {{ key: string, argument: string | null, predicate: string | null }} wanted
 * @returns {object[]}
 */
function findBlocks(scope, wanted) {
    const prefix = wanted.key.startsWith('@') ? '@' : '';
    const name = prefix ? wanted.key.slice(1) : wanted.key;
    const keep = (block) => wanted.predicate === null || matchesPredicate(block, wanted.predicate);

    const exact = [];
    const bare = [];
    const loose = [];
    for (const block of scope.children) {
        if (prefix) {
            const keyword = block.at === null ? null : `@${block.at.toLowerCase()}`;
            if (keyword !== wanted.key.toLowerCase()) continue;
            if (wanted.argument !== null) {
                if ((block.argument ?? '') === wanted.argument) exact.push(block);
                else if ((block.argument ?? '').includes(wanted.argument)) loose.push(block);
                continue;
            }
            bare.push(block);
            continue;
        }
        for (const entry of keysOf(block)) {
            if (entry.bare) {
                if (entry.key === name) bare.push(block);
            } else if (entry.key === wanted.key) {
                exact.push(block);
            }
        }
    }

    const pick = (candidates) => {
        const blocks = [];
        for (const block of candidates) {
            if (!keep(block)) continue;
            if (!blocks.includes(block)) blocks.push(block);
        }
        return blocks;
    };

    for (const candidates of [exact, bare, loose]) {
        const blocks = pick(candidates);
        if (blocks.length > 1) {
            throw new Error(`"${wanted.key}" matches ${blocks.length} blocks; the name must be unique`);
        }
        if (blocks.length === 1) return blocks;
    }
    return [];
}

/**
 * The scope a resolved block offers, and the text `scope` takes from it.
 *
 * A block is `{ text, from, to }` with **1-based inclusive** lines, exactly the
 * answer the code rule gives, so a host that highlights one can highlight this.
 */
function renderBlock(source, lines, starts, block, scope) {
    const first = block.startLine;
    const last = block.closeLine;
    if (scope !== 'body') {
        return {
            text: lines.slice(first, last + 1).join('\n'),
            from: first + 1,
            to: last + 1,
        };
    }

    // The declarations alone: the text strictly between the braces, trimmed,
    // with `from`/`to` the first and last line that survives the trim.
    const raw = source.slice(block.open + 1, block.close);
    const trimmed = raw.trim();
    if (trimmed === '') {
        const at = lineAt(starts, block.open + 1);
        return { text: '', from: at + 1, to: at + 1 };
    }
    const skipped = raw.length - raw.trimStart().length;
    const dropped = raw.length - raw.trimEnd().length;
    const from = lineAt(starts, block.open + 1 + skipped);
    const to = lineAt(starts, block.close - dropped);
    return { text: trimmed, from: from + 1, to: to + 1 };
}

/**
 * The region a bare name is, or null when the file has no such directive.
 *
 * The name must be a plain identifier: CSS's own names carry a sigil
 * (`.card`, `@media`) or a parameter, and those are rules rather than
 * directives. A region is found the same way in a stylesheet as in any other
 * file — the lines strictly between its directives, which is what
 * `regionDirective` reads under a `/* … *​/` comment.
 *
 * @param {string} text the stylesheet
 * @param {string} name the directive's name
 * @returns {{ text: string, from: number, to: number } | null}
 */
function regionSelection(text, name) {
    const lines = text.split('\n');
    const opens = [];
    let close = -1;
    lines.forEach((line, index) => {
        const directive = regionDirective(line);
        if (!directive) return;
        if (directive.kind === 'region') {
            if (directive.name === name) opens.push(index);
        } else if (opens.length === 1 && index > opens[0] && close === -1) {
            close = index;
        }
    });
    if (opens.length === 0) return null;
    if (opens.length > 1) {
        throw new Error(`"#region ${name}" appears ${opens.length} times; region names must be unique`);
    }
    if (close === -1) throw new Error(`"#region ${name}" is never closed by an #endregion`);
    return {
        text: lines.slice(opens[0] + 1, close).join('\n'),
        from: opens[0] + 2,                       // 1-based, strictly between
        to: close,
    };
}

/**
 * Read one line as a region directive, or null. The same spellings
 * `index.mjs` reads (`/* #region name *​/`, `# #region`, `<!-- … -->`).
 *
 * @param {string} line
 * @returns {{ kind: 'region' | 'endregion', name: string } | null}
 */
function regionDirective(line) {
    let text = line.trim();
    const closer = /\s*(?:-->|\*\/)$/.exec(text);
    if (closer) text = text.slice(0, closer.index).trim();
    const commented = /^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i.test(text);
    if (commented) text = text.replace(/^(?:(?:\/\/|--|;|%|'|REM\b|<!--|\/\*|\*)\s*)+/i, '').trim();
    const match = /^(#?)(region|endregion)\b\s*(.*)$/i.exec(text);
    if (!match) return null;
    if (!commented && match[1] !== '#') return null;
    return { kind: match[2].toLowerCase(), name: match[3].trim() };
}

/**
 * Resolve a CSS reference to the blocks it names, in written order.
 *
 * The blocks are resolved, not rendered: a caller that only wants the text calls
 * {@link extractCssRegion}, and one that also wants the lines calls
 * {@link cssRanges}. Both go through this one function, so the two answers
 * cannot disagree.
 *
 * @param {string} text the stylesheet
 * @param {string} reference the `#` fragment content
 * @returns {{ selections: Array<{ block?: object, region?: object, scope: 'declaration' | 'body' }> }}
 */
export function planCssSelection(text, reference) {
    const source = text.replace(/\r\n/g, '\n');
    const { root } = scanStylesheet(source);
    const paths = parseReference(reference);

    const selections = [];
    for (const path of paths) {
        // The modifier is the path's last segment, as it is for every rule: it
        // is not a name, and it says how much of the block comes along.
        const modifier = segmentModifier(path[path.length - 1].key);
        const names = modifier === null ? path : path.slice(0, -1);
        if (names.length === 0) throw new Error(`"#${reference}" names nothing`);

        // A region directive is not a rule, so the block scanner cannot see it.
        // A **bare name** may be one — the CSS reading is tried first, so a
        // `.card` or an `@media` never reaches here and a class name cannot be
        // swallowed by a directive of the same name. The same order the code
        // rule uses for a name that is both a `#region` and a declaration.
        if (names.length === 1 && /^[\w-]+$/.test(names[0].key) && names[0].predicate === null) {
            const region = regionSelection(source, names[0].key);
            if (region !== null) {
                selections.push({ region, scope: 'declaration' });
                continue;
            }
        }

        let scope = root;
        let block = null;
        for (let index = 0; index < names.length; index++) {
            const last = index === names.length - 1;
            const segment = names[index];
            const found = findBlocks(scope, segment);
            if (found.length === 0) throw new Error(notFound(segment));
            if (last) {
                block = found[0];
                // The modifier is the *scope* the selection is rendered under,
                // the same four the code rule has. `+`/`++` have nothing to
                // bring along in a stylesheet, so they take the whole block.
                selections.push({ block, scope: modifier === '-' ? 'body' : 'declaration' });
                break;
            }
            scope = found[0];
        }
        if (block === null) throw new Error(`"#${reference}" names nothing`);
    }
    return { selections };
}

/** The message for a selector that resolved to nothing, in the catalogue's voice. */
function notFound(wanted) {
    if (wanted.key.startsWith('@')) {
        return wanted.argument === null
            ? `no "${wanted.key}" block`
            : `no "${wanted.key}" block whose parameter contains "${wanted.argument}"`;
    }
    return `no rule "${wanted.key}"`;
}

/** The text a CSS reference stands for, or a thrown error when it names nothing. */
export function extractCssRegion(text, reference) {
    const source = text.replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const starts = lineStartsOf(source);
    const { selections } = planCssSelection(text, reference);
    return selections
        .map((selection) => (selection.region ? selection.region.text
            : renderBlock(source, lines, starts, selection.block, selection.scope).text))
        .join('\n');
}

/**
 * The 1-based line ranges a CSS reference selects, one per selector, in the
 * order written — the `ranges` half of the answer, for a host that highlights
 * rather than injects.
 *
 * @returns {Array<{ from: number, to: number }>}
 */
export function cssRanges(text, reference) {
    const source = text.replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const starts = lineStartsOf(source);
    const { selections } = planCssSelection(text, reference);
    return selections.map((selection) => {
        if (selection.region) return { from: selection.region.from, to: selection.region.to };
        const { from, to } = renderBlock(source, lines, starts, selection.block, selection.scope);
        return { from, to };
    });
}
