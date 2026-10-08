/** @typedef {'declaration' | 'body' | 'annotated' | 'documented'} Scope */

/**
 * @typedef {object} Reference
 * @property {string} raw
 * @property {string} canonical
 * @property {string[]} segments
 * @property {Scope} scope
 * @property {null | { kind: 'contradiction', kept: '++' | '+', dropped: '-' }} warning
 */

/**
 * Error for a malformed section reference.
 */
export class SectionReferenceError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SectionReferenceError';
    }
}

function scopeFromModifier(modifier) {
    if (modifier === '-') return 'body';
    if (modifier === '+') return 'annotated';
    if (modifier === '++') return 'documented';
    return 'declaration';
}

function tokenizeModifierRun(run) {
    const tokens = [];
    let i = 0;
    while (i < run.length) {
        if (i + 1 < run.length && run[i] === '+' && run[i + 1] === '+') {
            tokens.push('++');
            i += 2;
        } else if (run[i] === '+') {
            tokens.push('+');
            i += 1;
        } else if (run[i] === '-') {
            tokens.push('-');
            i += 1;
        } else {
            break;
        }
    }
    return tokens;
}

/**
 * Extract leading modifier from a segment.
 * Returns { modifier: '++'|'+'|'-'|null, name: string }
 * Leading '-' is allowed on last segment (legacy form).
 * Leading '+'/'++' anywhere is an error.
 * Leading '-' on non-last segment is an error (except 2-seg special case handled separately).
 */
function extractLeadingModifier(seg, isLastSegment, rawRef) {
    if (seg.length <= 1) return { modifier: null, name: seg };

    if (seg[0] === '-') {
        if (seg[1] === '-' || seg[1] === '+') {
            return { modifier: null, name: seg };
        }
        if (isLastSegment) {
            return { modifier: '-', name: seg.slice(1) };
        }
        throw new SectionReferenceError(
            `"-" may only modify the last path segment of "#region:${rawRef}"`
        );
    }

    if (seg.startsWith('++')) {
        if (seg[2] === '+' || seg[2] === '-') {
            return { modifier: null, name: seg };
        }
        throw new SectionReferenceError(
            `"++" may only modify the last path segment of "#region:${rawRef}"`
        );
    }

    if (seg[0] === '+') {
        if (seg[1] === '+' || seg[1] === '-') {
            return { modifier: null, name: seg };
        }
        throw new SectionReferenceError(
            `"+" may only modify the last path segment of "#region:${rawRef}"`
        );
    }

    return { modifier: null, name: seg };
}

/**
 * Extract trailing modifier run from a segment name.
 * Returns { name: string, tokens: Array<'++'|'+'|'-'> }
 */
function extractTrailingModifier(name) {
    let i = name.length - 1;
    while (i >= 0 && (name[i] === '+' || name[i] === '-')) {
        i--;
    }
    if (i < name.length - 1) {
        const run = name.slice(i + 1);
        return { name: name.slice(0, i + 1), tokens: tokenizeModifierRun(run) };
    }
    return { name, tokens: [] };
}

/**
 * @throws {SectionReferenceError}
 * @param {string} raw
 * @returns {Reference}
 */
export function parseReference(raw) {
    if (raw === '') {
        throw new SectionReferenceError('"#region:" names nothing');
    }

    // Step 1: detach leading modifier from whole reference
    let detached = null;
    let remainder = raw;

    if (raw.startsWith('++')) {
        detached = '++';
        remainder = raw.slice(2);
    } else if (raw.startsWith('+')) {
        detached = '+';
        remainder = raw.slice(1);
    } else if (raw.startsWith('-')) {
        detached = '-';
        remainder = raw.slice(1);
    }

    if (remainder === '') {
        throw new SectionReferenceError(`"#region:${raw}" names nothing`);
    }

    // Split on '/'
    const parts = remainder.split('/');

    // Check empty segments
    if (parts.some((p) => p === '')) {
        throw new SectionReferenceError(`"#region:${raw}" has an empty path segment`);
    }

    if (parts.length > 8) {
        throw new SectionReferenceError(`"#region:${raw}" is deeper than 8 sections`);
    }

    // Step 2: check for second segment leading '-' in 2-segment path with no leading detach
    let detachedSecond = null;
    if (detached === null && parts.length === 2) {
        const secondSeg = parts[1];
        if (secondSeg.length > 1 && secondSeg[0] === '-' && secondSeg[1] !== '-' && secondSeg[1] !== '+') {
            detachedSecond = '-';
            parts[1] = secondSeg.slice(1);
        }
    }

    // Extract modifiers from all segments
    const allModifiers = [];
    const cleanSegments = [];

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const seg = parts[i];

        // Extract leading modifier (only allowed: '-' on last segment)
        const { modifier: leadingMod, name: afterLeading } = extractLeadingModifier(
            seg,
            isLast,
            raw
        );

        if (leadingMod) {
            allModifiers.push(leadingMod);
        }

        // Extract trailing modifier from the (potentially stripped) name
        const { name, tokens: trailingTokens } = extractTrailingModifier(afterLeading);

        if (trailingTokens.length > 0) {
            allModifiers.push(...trailingTokens);
        }

        // Check for stray modifiers in the cleaned name
        if (name.includes('+') || name.includes('-')) {
            const ch = name.includes('+') ? '+' : '-';
            throw new SectionReferenceError(
                `"${ch}" may only modify the last path segment of "#region:${raw}"`
            );
        }

        cleanSegments.push(name);
    }

    // Check for empty segment names after stripping modifiers
    if (cleanSegments.some((s) => s === '')) {
        throw new SectionReferenceError(`"#region:${raw}" has an empty path segment`);
    }

    // Add detached modifiers
    if (detached) allModifiers.unshift(detached);
    if (detachedSecond) allModifiers.unshift(detachedSecond);

    // Resolve modifiers
    let modifier = null;
    let warning = null;

    if (allModifiers.length === 0) {
        modifier = null;
    } else if (allModifiers.length === 1) {
        modifier = allModifiers[0];
    } else {
        const posCount = allModifiers.filter((m) => m[0] === '+').length;
        const negCount = allModifiers.filter((m) => m[0] === '-').length;
        if (posCount > 1 || negCount > 1) {
            throw new SectionReferenceError(
                `"#region:${raw}" carries more than one modifier`
            );
        }
        // Mixed signs = contradiction
        if (allModifiers.includes('++')) {
            modifier = '++';
            warning = { kind: 'contradiction', kept: '++', dropped: '-' };
        } else if (allModifiers.includes('+')) {
            modifier = '+';
            warning = { kind: 'contradiction', kept: '+', dropped: '-' };
        } else {
            throw new SectionReferenceError(
                `"#region:${raw}" carries more than one modifier`
            );
        }
    }

    const scope = scopeFromModifier(modifier);
    const canonical = cleanSegments.join('/') + (modifier || '');

    return { raw, canonical, segments: cleanSegments, scope, warning };
}

/**
 * @param {Reference | string} reference
 * @returns {boolean}
 */
export function isSingleSegment(reference) {
    if (typeof reference === 'string') {
        return parseReference(reference).segments.length === 1;
    }
    return reference.segments.length === 1;
}

/**
 * @param {Reference | string} reference
 * @returns {string}
 */
export function finalSegment(reference) {
    if (typeof reference === 'string') {
        reference = parseReference(reference);
    }
    return reference.segments[reference.segments.length - 1];
}