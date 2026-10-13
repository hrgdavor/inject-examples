/**
 * `lib/jump.mjs` — the **code-jump profile**: [RFC 2](../doc/rfc/code-jump.md).
 *
 * A jump turns a reference into a cursor. It is not a second resolver: every
 * answer here comes from `diagnose` in `lib/section.mjs`, which is `planSection`
 * with the throw turned into a value. What this module adds is the *policy* the
 * resolver deliberately does not have — what a failure means to a reader sitting
 * in front of an editor, and what it means to a gate over a repository.
 *
 * The one sentence it implements:
 *
 * > Find the first line, or say honestly that you could not — and make the best
 * > answer available without ever pretending it is the exact one.
 *
 * That is why every target carries a `cause`: `resolved` is the only cause that
 * means "the reference named exactly this". Every other cause is a landing line
 * chosen by policy, and a host that hides the difference is not implementing the
 * spec ([RFC 2 §3.2](../doc/rfc/code-jump.md)).
 *
 * This module is the *profile* half only, so it is not vendorable like
 * `lib/section.mjs`: the gate reads a whole document, which means the document
 * layer in `index.mjs`. The resolver keeps its dependency-free boundary; this
 * file is what a host imports when it wants the policy too.
 */

import { diagnose, deepestResolvablePrefix } from './section.mjs';
import { updateDocument } from '../index.mjs';

/**
 * The two readings of one failure. Which one a host asks for is the whole of
 * RFC 2 §1.1: the same failed resolve is a warning in an editor and an error in a
 * gate, and neither is a lenient version of the other.
 *
 * - `jump/editor` — never fails a keystroke. Every band lands somewhere useful
 *   and the target says how it got there.
 * - `jump/gate` — CI over a repository. Anything that is not an exact resolve
 *   fails, and **every** failing reference is reported in one run.
 */
export const PROFILES = Object.freeze(['jump/editor', 'jump/gate']);

/** Is this one of the two profiles? A host that passes a typo gets an error, not a guess. */
export function isProfile(name) {
    return PROFILES.includes(name);
}

/**
 * A jump target: where the cursor goes, and how it got there.
 *
 * `cause` is the honesty field. `plan` is present **only** when the resolve was
 * exact — a host that wants the text of an approximation must not get one from a
 * jump, or an approximation would quietly become an injection
 * ([RFC 2 §3.2](../doc/rfc/code-jump.md)).
 *
 * @typedef {object} JumpTarget
 * @property {string} path the reference's file, as the caller gave it
 * @property {number} firstLine 1-based inclusive — the landing line
 * @property {number} lineCount how many lines the selection spans
 * @property {'resolved'|'ambiguous'|'nearest'|'file-start'|'uncertain'} cause
 * @property {object|null} plan the exact plan, when `cause` is `resolved`
 * @property {Array<object>|null} candidates what the name answered to, when it answered twice
 * @property {string|null} code the failure's stable code, when the cause is not `resolved`
 * @property {object|null} diagnosis the failure this landing line came from
 */

/**
 * A resolver failure, as `diagnose` reports it: the message, and the diagnosis
 * beside it. Named here so a caller reads one shape rather than an `object`.
 *
 * @typedef {object} JumpFailure
 * @property {string} message the contract text, unchanged
 * @property {'ok'|'failed'|'invalid'} status how `diagnose` classified it
 * @property {string|null} code one of `ERROR_CODES`
 * @property {string|null} selector the selector at fault, as written
 * @property {string|null} scope the block it was searched in
 * @property {Array<object>|null} candidates what the name answered to
 * @property {string|null} advice a repair hint, for a malformed reference
 * @property {Error} error the thrown failure itself
 */

/**
 * What a jump answers: a target when it landed, or the failure when the profile
 * refuses. `ok` is the discriminator, so a caller narrows on it.
 *
 * @typedef {{ ok: true, target: JumpTarget, profile: string }
 *         | { ok: false, failure: JumpFailure, profile: string }} JumpOutcome
 */

/**
 * A line range the file does not reach, as an editor reads it.
 *
 * A verbatim range is exact or nothing ([RFC 1 §3.4](../doc/rfc/section-mapping.md)),
 * so there is no "nearer" block to find — but there is a *place*: the end of the
 * file the reader asked about. Clamping to the last line is the editor's answer
 * and is never a gate's ([RFC 2 §4.4](../doc/rfc/code-jump.md)).
 */
function lastLineTarget(path, text, diagnosis) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    return {
        path,
        firstLine: Math.max(1, lines.length),
        lineCount: 1,
        cause: 'nearest',
        plan: null,
        candidates: null,
        code: diagnosis?.code ?? null,
        diagnosis: diagnosis ?? null,
    };
}

/** The number of lines a spread of ranges covers, from its first range to its last. */
function lineCountOf(ranges, fallback = 1) {
    if (!Array.isArray(ranges) || ranges.length === 0) return fallback;
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    return Math.max(1, last.to - first.from + 1);
}

/**
 * The line a host lands on when it has no better answer: the file's first line.
 *
 * It is *always* available, which is what makes the editor's ladder total: a
 * reader who is in the right file is better off than one who is nowhere
 * ([RFC 2 §4.6](../doc/rfc/code-jump.md)).
 */
function fileStartTarget(path, diagnosis) {
    return {
        path,
        firstLine: 1,
        lineCount: 1,
        cause: 'file-start',
        plan: null,
        candidates: null,
        code: diagnosis?.code ?? null,
        diagnosis: diagnosis ?? null,
    };
}

/**
 * The deepest prefix of the path that still resolves — the ladder's first rung,
 * and the one that makes a rename survivable: when `render` becomes `paint`, the
 * reference `Cart/Line/render` lands on `Line` instead of at the file head.
 */
function nearestTarget(path, text, reference, lexer, diagnosis) {
    const prefix = deepestResolvablePrefix(text, reference, lexer);
    if (prefix === null) return null;
    return {
        path,
        firstLine: prefix.firstLine,
        lineCount: 1,
        cause: 'nearest',
        plan: null,
        candidates: null,
        code: diagnosis?.code ?? null,
        diagnosis: diagnosis ?? null,
    };
}

/**
 * A name several blocks answer to, as an editor reads it.
 *
 * The gate refuses this band outright. An editor picks, but visibly: the deepest
 * unique prefix first (the holder the rest of the path already named), then the
 * candidates in the order the resolver found them, and never a silent coin flip
 * ([RFC 2 §4.2](../doc/rfc/code-jump.md)).
 */
function ambiguousTarget(path, text, reference, lexer, diagnosis) {
    const candidates = Array.isArray(diagnosis?.candidates) ? diagnosis.candidates : [];
    const prefix = deepestResolvablePrefix(text, reference, lexer);
    if (prefix !== null) {
        return {
            path,
            firstLine: prefix.firstLine,
            lineCount: 1,
            cause: 'ambiguous',
            plan: null,
            candidates,
            code: diagnosis?.code ?? null,
            diagnosis,
        };
    }
    const first = candidates[0];
    if (first !== undefined && Number.isInteger(first.startLine)) {
        return {
            path,
            firstLine: first.startLine,
            lineCount: Math.max(1, (first.endLine ?? first.startLine) - first.startLine + 1),
            cause: 'ambiguous',
            plan: null,
            candidates,
            code: diagnosis?.code ?? null,
            diagnosis,
        };
    }
    return null;
}

/**
 * A landed answer, built in one place so the outcome type stays discriminated:
 * an object literal returned from two branches widens `ok` to `boolean`, and a
 * caller then cannot narrow on it.
 *
 * @param {JumpTarget} target
 * @param {string} profile
 * @returns {JumpOutcome}
 */
function landed(target, profile) {
    return { ok: true, target, profile };
}

/**
 * Tell a caller — and the type checker — that a gate refused.
 *
 * @param {JumpOutcome} outcome
 * @returns {boolean} true when the gate refused, and only then
 */
export function isRefused(outcome) {
    return outcome.ok === false;
}

/**
 * The failure a refused gate carries. Throws when called on a landed answer,
 * because reading a failure from a target is a bug rather than a policy choice.
 *
 * @param {JumpOutcome} outcome
 * @returns {JumpFailure}
 */
export function refusal(outcome) {
    if (outcome.ok) throw new Error('this outcome landed; there is no failure to read');
    return outcome.failure;
}

/**
 * **Resolve a reference into a cursor.**
 *
 * `profile` is `jump/editor` by default: a reader is assumed to be present, so
 * every band lands somewhere and the answer says how. `jump/gate` refuses
 * anything that is not exact, and is the reading a `--check` run wants.
 *
 * The function never throws for a reference that fails to resolve — that is the
 * point of a best-effort reader. It throws only for a *programming* error: an
 * unknown profile.
 *
 * @param {string} text the target file's content
 * @param {string} reference the `#` fragment content
 * @param {{ lexer?: object, path?: string, profile?: string }} [options]
 * @returns {JumpOutcome}
 */
export function jump(text, reference, options = {}) {
    const profile = options.profile ?? 'jump/editor';
    if (!isProfile(profile)) {
        throw new Error(`"${profile}" is not a jump profile; write jump/editor or jump/gate`);
    }
    const path = options.path ?? '';    const d = diagnose(text, reference, options.lexer);

    if (d.status === 'ok') {
        return landed({
            path,
            firstLine: d.firstLine,
            lineCount: lineCountOf(d.plan.ranges),
            cause: 'resolved',
            plan: d.plan,
            candidates: null,
            code: null,
            diagnosis: null,
        }, profile);
    }

    // The gate stops here: no approximation is ever a gate's answer.
    if (profile === 'jump/gate') {
        return { ok: false, failure: d, profile };
    }

    // The editor's ladder, in order. A range past the end of the file has a
    // landing line of its own — the end of the file — so it is answered before
    // the prefix walk, which would have nothing to find. `status === 'invalid'`
    // is a malformed reference, so there is nothing to be nearest *to*: the file
    // is still the right place, and the repair advice rides in the diagnosis.
    let ladder;
    if (d.code === 'resolution/ambiguous') {
        ladder = ambiguousTarget(path, text, reference, options.lexer, d);
    } else if (d.code === 'resolution/line-range-past-end') {
        ladder = lastLineTarget(path, text, d);
    } else {
        ladder = nearestTarget(path, text, reference, options.lexer, d);
    }

    return landed(ladder ?? fileStartTarget(path, d), profile);
}

/**
 * **The gate.** Resolve every marker in a document and report **every** failure
 * in one run, so one pass is one fix list ([RFC 2 §5.1](../doc/rfc/code-jump.md)).
 *
 * It is deliberately the same strictness as `inject/gate`: a CI job that jumps
 * through a document and a CI job that injects into it must not disagree about
 * whether the document is broken. The difference is what it does with the
 * answers — this one reports line numbers and failures, and writes nothing.
 *
 * @param {string} documentText the Markdown document
 * @param {{ readFile: (relativePath: string) => string,
 *           lexerFor?: (path: string) => object|undefined,
 *           gitignore?: false|true|Array }} options
 * @returns {{ passed: boolean, checked: number,
 *             failures: Array<{ marker: string, path: string, reference: string|null,
 *                                message: string, code: string|null,
 *                                selector: string|null, scope: string|null }> }}
 */
export function jumpGate(documentText, options = {}) {
    const read = options.readFile;
    if (typeof read !== 'function') {
        throw new Error('jumpGate needs a readFile: it resolves markers against the files they name');
    }
    // Which markers a document carries, which of them the document's own policy
    // excludes, and which of them resolve — all three are the *document layer's*
    // answers, so the gate asks for them rather than counting markers a second
    // way. `lenient` is what turns a dead include into a record instead of a
    // throw, and a gate reports every one of them instead of the first.
    const cache = new Map();
    const cached = (path) => {
        if (!cache.has(path)) cache.set(path, read(path));
        return cache.get(path);
    };
    const result = updateDocument(documentText, {
        root: options.root,
        readFile: cached,
        gitignore: options.gitignore,
        lenient: true,
    });

    const failures = [];
    for (const row of result.results) {
        if (!row.failure) continue;
        const marker = row.marker;
        // The band, the selector and the scope come from the same diagnosis an
        // editor reads, so a report names them without parsing prose. A failure
        // that is not a reference at all (a file that cannot be read, a malformed
        // document) has no band to report, and the layer's own message stands.
        let code = null;
        let selector = null;
        let scope = null;
        let message = row.failure;
        try {
            const source = cached(marker.path);
            if (marker.reference !== null) {
                const d = diagnose(source, marker.reference, options.lexerFor?.(marker.path));
                if (d.status !== 'ok') {
                    code = d.code;
                    selector = d.selector;
                    scope = d.scope;
                    message = d.error.message;
                }
            }
        } catch {
            // Being unable to read the file *is* the failure; nothing to add.
        }
        failures.push({
            marker: marker.raw,
            path: marker.path,
            reference: marker.reference,
            message,
            code,
            selector,
            scope,
        });
    }

    return {
        passed: failures.length === 0,
        checked: result.markers.length,
        failures,
    };
}
