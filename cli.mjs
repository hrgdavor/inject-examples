#!/usr/bin/env node

/**
 * inject-examples — command line interface.
 *
 *   inject-examples                 rewrite README.md in place
 *   inject-examples --check         exit 1 if any block is stale
 *   inject-examples docs/GUIDE.md   rewrite some other document
 *   inject-examples docs/           rewrite every *.md below docs/
 *   inject-examples --out dist/GUIDE.md docs/GUIDE.md
 *                                   process docs/GUIDE.md into dist/GUIDE.md,
 *                                   leaving the input untouched
 *
 * Any number of documents and directories may be given at once; a directory
 * expands to every `*.md` below it, recursively. Each document is processed
 * with the same options and the run exits with the worst code it saw.
 *
 * Run `inject-examples --help` for the full option list.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, parseIgnoreFile, updateDocument } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = 'README.md';
/** A directory target expands to files with this suffix. */
const MARKDOWN_SUFFIX = '.md';
const SELF = fileURLToPath(import.meta.url);

/** Exit codes, documented in the README. */
const OK = 0;
const FAILED = 1;   // stale blocks, unreadable file, malformed marker,
                    // or (with --lenient) an include that could not be resolved
const USAGE = 2;    // the command line itself was wrong

const HELP = `inject-examples — keep Markdown examples in sync with real files

Usage:
  inject-examples [options] [file|dir ...]

  Each marker in \`file\` is a line that is nothing but a link to a real path,
  labelled with that same path, followed by a fenced code block:

      [fixtures/before.md](./fixtures/before.md)

      \`\`\`markdown
      ...replaced, byte for byte, with that file...
      \`\`\`

  A fence without a language is given one from the file's extension, so the
  block highlights; a fence that already names a language is left as written.

  Name a region in the fragment to inject part of a larger file. How the
  reference is read depends on the file's type. A code file (or any type
  without a rule of its own) takes a #region directive, or the name of a
  method or inner class — optionally prefixed with - for its body alone, + to
  include the annotations above it, or ++ to include its doc comment too. A
  .json file, which has no comments, takes a comma-separated list of dotted
  key paths, rendered as valid JSON:

      [src/app.ts](./src/app.ts#region:table)
      [src/app.ts](./src/app.ts#region:++table)
      [package.json](./package.json#region:scripts.test,name)

Arguments:
  file|dir             Markdown document(s) to update. A directory expands to
                       every *.md below it, recursively; node_modules and
                       dot-directories are skipped. Default: ${DEFAULT_FILE}

Options:
  -c, --check          Write nothing; exit ${FAILED} if any block is stale
  -n, --dry-run        Write nothing; report what would change
  -o, --out <file>     Write the processed document to <file> instead of
                        updating the input in place: the input is never
                        modified, <file> may live in any folder (its missing
                        parent directories are created), and exactly one
                        input file is required
  -r, --root <dir>     Base directory for the paths the markers name
                       (default: the directory holding the document)
  -g, --gitignore <file> Skip markers whose target file is ignored by this
                       .gitignore file (default: search upward from the
                       document's directory, like git)
      --no-gitignore   Do not apply any .gitignore rules
  -q, --quiet          Print only the closing summary
      --allow-empty    Succeed when the document contains no markers
  -l, --lenient        Tolerate broken includes: a marker whose file, region
                       or block cannot be resolved is reported with its line
                       number and its block is left as written; the exit code
                       is still ${FAILED} when any such marker occurs
  -h, --help           Show this help
  -V, --version        Show the version

Exit codes:
  ${OK}  every block is up to date (or was rewritten)
  ${FAILED}  a block is stale in --check mode, a document is malformed,
             or (with --lenient) an include could not be resolved
  ${USAGE}  the command line was wrong

  With several documents the run processes all of them, including the ones
  after a failure, and exits with the worst code it saw.
`;

/** Parse argv (already free of `node script`). Throws UsageError on nonsense. */
export class UsageError extends Error {}

export function parseArgs(argv) {
    const options = {
        files: [],
        root: null,
        gitignoreFile: null,
        noGitignore: false,
        check: false,
        dryRun: false,
        out: null,
        quiet: false,
        allowEmpty: false,
        lenient: false,
        help: false,
        version: false,
    };
    const positionals = [];
    let onlyPositionals = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (onlyPositionals || !arg.startsWith('-') || arg === '-') {
            positionals.push(arg);
            continue;
        }
        if (arg === '--') { onlyPositionals = true; continue; }

        const takesValue = (name) => {
            if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
            return argv[++i];
        };

        switch (arg) {
            case '-c': case '--check': options.check = true; break;
            case '-n': case '--dry-run': options.dryRun = true; break;
            case '-o': case '--out': options.out = takesValue(arg); break;
            case '-q': case '--quiet': options.quiet = true; break;
            case '-l': case '--lenient': options.lenient = true; break;
            case '--allow-empty': options.allowEmpty = true; break;
            case '-h': case '--help': options.help = true; break;
            case '-V': case '--version': options.version = true; break;
            case '-r': case '--root': options.root = takesValue(arg); break;
            case '-g': case '--gitignore': options.gitignoreFile = takesValue(arg); break;
            case '--no-gitignore': options.noGitignore = true; break;
            default:
                if (arg.startsWith('--root=')) { options.root = arg.slice('--root='.length); break; }
                if (arg.startsWith('--out=')) { options.out = arg.slice('--out='.length); break; }
                if (arg.startsWith('--gitignore=')) { options.gitignoreFile = arg.slice('--gitignore='.length); break; }
                throw new UsageError(`unknown option: ${arg}`);
        }
    }

    if (options.gitignoreFile !== null && options.noGitignore) {
        throw new UsageError('--gitignore and --no-gitignore cannot be used together');
    }
    options.files = positionals.length > 0 ? positionals : [DEFAULT_FILE];
    return options;
}

function version() {
    const pkg = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8'));
    return pkg.version;
}

/** Path as the user typed it, when that is shorter and still unambiguous. */
function display(path) {
    const rel = relative(process.cwd(), path);
    return rel === '' || rel.startsWith('..') ? path : rel;
}

/** Read `path` as text, or `null` when the file does not exist. */
function readOrNull(path) {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Every Markdown document below `dir`, recursively, in a stable order.
 * `node_modules` and dot-directories are skipped: neither is documentation a
 * run should pull in by accident, and neither is ever the tree the user meant.
 *
 * @param {string} dir absolute directory to walk
 * @returns {string[]} the absolute paths of the `*.md` files found
 */
function collectMarkdown(dir) {
    const found = [];
    const walk = (current) => {
        const entries = readdirSync(current, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith(MARKDOWN_SUFFIX)) found.push(full);
        }
    };
    walk(dir);
    return found;
}

/**
 * Turn the positional targets into the documents to process: a file is taken
 * as it is, a directory expands to its Markdown documents, and a path that
 * cannot be read is kept so that the read reports it.
 *
 * @param {string[]} targets the paths as the user typed them
 * @returns {{documents: string[], code: number}} the documents to process,
 *     deduplicated and in order, plus the exit code the targets themselves
 *     earned (a directory with no Markdown is a failure, not a no-op)
 */
function resolveDocuments(targets) {
    const documents = [];
    let code = OK;

    for (const target of targets) {
        const full = resolve(target);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (stat === undefined || !stat.isDirectory()) {
            documents.push(full); // a file, or something the read will refuse
            continue;
        }
        const found = collectMarkdown(full);
        if (found.length === 0) {
            console.error(`inject-examples: no Markdown (*.md) documents below ${display(full)}.`);
            code = FAILED;
            continue;
        }
        documents.push(...found);
    }

    return { documents: [...new Set(documents)], code };
}

/**
 * Run the CLI. Exported so a caller (a repository's own script, say) can reuse
 * it without duplicating any behaviour.
 *
 * @param {string[]} argv arguments after `node script`
 * @returns {number} the process exit code
 */
export function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
        if (options.out !== null) {
            // --out processes one document into a separate file, so the target
            // must be exactly one file: a directory or several files is a wrong
            // command line, not a document to process.
            const targets = options.files;
            if (targets.length !== 1) {
                throw new UsageError('--out needs exactly one input file');
            }
            const stat = statSync(resolve(targets[0]), { throwIfNoEntry: false });
            if (stat !== undefined && stat.isDirectory()) {
                throw new UsageError(`--out needs a file, not a directory: ${display(targets[0])}`);
            }
        }
    } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        console.error(`inject-examples: ${err.message}`);
        console.error('Try: inject-examples --help');
        return USAGE;
    }

    if (options.help) { process.stdout.write(HELP); return OK; }
    if (options.version) { console.log(version()); return OK; }

    const gitignore = loadGitignore(options);
    if (gitignore === null) return FAILED;

    const { documents, code } = resolveDocuments(options.files);
    let exitCode = code;
    for (const document of documents) {
        // Every document is processed, including the ones after a failure: one
        // broken page must not hold the healthy ones hostage.
        exitCode = Math.max(exitCode, processDocument(document, options, gitignore));
    }
    return exitCode;
}

/**
 * The gitignore setting for a run: `false` for `--no-gitignore`, an explicit
 * rule set for `--gitignore <file>`, and `true` for the default walk-up.
 * Returns `null` (after reporting the problem) when the named file cannot be
 * read, because then no document could be processed correctly.
 *
 * @param {object} options parsed command line
 * @returns {false|true|Array|null} the setting, or `null` on a read failure
 */
function loadGitignore(options) {
    if (options.noGitignore) return false;
    if (options.gitignoreFile === null) return true;

    const ignoreFile = resolve(options.gitignoreFile);
    let ignoreText;
    try {
        ignoreText = readFileSync(ignoreFile, 'utf8');
    } catch (err) {
        const reason = err.code === 'ENOENT' ? 'no such file' : err.message;
        console.error(`inject-examples: cannot read gitignore file ${display(ignoreFile)}: ${reason}`);
        return null;
    }
    return [{ dir: dirname(ignoreFile), rules: parseIgnoreFile(ignoreText) }];
}

/**
 * Update, check or dry-run one document.
 *
 * @param {string} file absolute path of the document
 * @param {object} options parsed command line
 * @param {false|true|Array} gitignore the resolved gitignore setting
 * @returns {number} the exit code for this document
 */
function processDocument(file, options, gitignore) {
    const root = options.root === null ? dirname(file) : resolve(options.root);

    let original;
    try {
        original = readFileSync(file, 'utf8');
    } catch (err) {
        const reason = err.code === 'ENOENT' ? 'no such file' : err.message;
        console.error(`inject-examples: cannot read ${display(file)}: ${reason}`);
        return FAILED;
    }

    let result;
    try {
        result = updateDocument(original, { root, gitignore, lenient: options.lenient });
    } catch (err) {
        console.error(`inject-examples: ${display(file)}: ${err.message}`);
        return FAILED;
    }

    const total = result.markers.length;
    if (total === 0) {
        if (!options.allowEmpty) {
            console.error(`inject-examples: no injection markers found in ${display(file)}.`);
            console.error('A marker is a line that is nothing but a link to a file it names; see --help.');
            return FAILED;
        }
        console.log(`${display(file)}: no markers, nothing to do.`);
        return OK;
    }

    if (!options.quiet) {
        // In --check and --dry-run nothing is written, so a difference is a
        // finding ("stale"), not an action taken ("updated"). A failure-skip
        // is a failure ("failed"), distinct from a gitignored "skipped".
        const readOnly = options.check || options.dryRun;
        for (const { marker, changed, skipped, failure } of result.results) {
            const label = failure
                ? 'failed'
                : skipped ? 'skipped' : changed ? (readOnly ? 'stale' : 'updated') : 'ok';
            console.log(`${label.padEnd(7)}  ${marker.raw}`);
        }
        for (const { marker, failure } of result.results) {
            if (failure) {
                console.error(`inject-examples: warn: ${display(file)}:${marker.index + 1}: ${marker.raw}: ${failure}`);
            }
        }
    }

    const stale = result.results.filter((entry) => entry.changed);
    const failed = result.results.filter((entry) => entry.skipped && entry.failure);
    const skippedCount = result.results.filter((entry) => entry.skipped && !entry.failure).length;
    const checked = total - skippedCount - failed.length;
    const skipNote = skippedCount > 0 ? `, ${skippedCount} marker(s) skipped` : '';
    const failedNote = failed.length > 0 ? `, ${failed.length} failed` : '';

    if (options.out !== null) {
        const out = resolve(options.out);
        const current = readOrNull(out);
        const changed = current === null || normalize(current) !== normalize(result.text);

        if (options.check) {
            if (failed.length > 0) {
                console.error(`\n${display(file)}: ${failed.length} of ${total} marker(s) could not be resolved; ${display(options.out)} was not verified.`);
                return FAILED;
            }
            if (!changed) {
                console.log(`\n${display(options.out)} is up to date with respect to ${display(file)}.`);
                return OK;
            }
            console.error(`\n${display(options.out)} is stale with respect to ${display(file)}${current === null ? ' (the file does not exist)' : ''}.`);
            console.error(`Run: inject-examples --out ${display(options.out)} ${display(file)}`);
            return FAILED;
        }

        if (options.dryRun) {
            if (failed.length > 0) {
                console.log(`\n${display(file)}: ${failed.length} marker(s) could not be resolved and would be left as written${skipNote}.`);
                return FAILED;
            }
            console.log(!changed
                ? `\n${display(file)} is already in sync with ${display(options.out)}${skipNote}.`
                : stale.length > 0
                    ? `\n${display(file)} would write ${display(options.out)}: ${stale.length} of ${checked} block(s) updated${skipNote}.`
                    : `\n${display(file)} would write ${display(options.out)}${skipNote}.`);
            return OK;
        }

        mkdirSync(dirname(out), { recursive: true });
        if (changed) writeFileSync(out, result.text, 'utf8');
        if (failed.length > 0) {
            console.log(`\n${display(file)} -> ${display(options.out)} updated: ${failed.length} marker(s) could not be resolved and were left as written${skipNote}.`);
            return FAILED;
        }
        console.log(`\n${display(file)} -> ${display(options.out)} ${changed ? 'updated' : 'already up to date'}${skipNote}.`);
        return OK;
    }

    if (options.check) {
        if (stale.length > 0 || failed.length > 0) {
            if (stale.length > 0) {
                console.error(`\n${display(file)} is stale: ${stale.length} of ${checked} block(s) differ from their files.`);
            }
            if (failed.length > 0) {
                console.error(`${display(file)}: ${failed.length} of ${total} marker(s) could not be resolved and were left as written.`);
            }
            console.error(`Run: inject-examples ${display(file)}`);
            return FAILED;
        }
        console.log(skippedCount > 0
            ? `\n${display(file)} is up to date: ${checked} checked, ${skippedCount} skipped.`
            : `\n${display(file)} matches all ${total} marker(s).`);
        return OK;
    }

    if (options.dryRun) {
        console.log(stale.length > 0
            ? `\n${display(file)} would update ${stale.length} of ${checked} block(s)${skipNote}${failedNote}.`
            : `\n${display(file)} already up to date${skipNote}${failedNote}.`);
        return failed.length > 0 ? FAILED : OK;
    }

    if (result.changed) writeFileSync(file, result.text, 'utf8');
    if (failed.length > 0) {
        console.log(`\n${display(file)}: ${stale.length} updated, ${failed.length} failed${skipNote}.`);
        return FAILED;
    }
    console.log(`\n${display(file)} ${result.changed ? 'updated' : 'already up to date'}${skipNote}.`);
    return OK;
}

// Only run when this file *is* the program: importing it (as a wrapper does)
// must not hijack that process's argv or exit code.
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`inject-examples: ${err.message}`);
        process.exitCode = FAILED;
    }
}
