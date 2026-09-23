#!/usr/bin/env node

/**
 * inject-examples — command line interface.
 *
 *   inject-examples                 rewrite README.md in place
 *   inject-examples --check         exit 1 if any block is stale
 *   inject-examples docs/GUIDE.md   rewrite some other document
 *
 * Run `inject-examples --help` for the full option list.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIgnoreFile, updateDocument } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = 'README.md';
const SELF = fileURLToPath(import.meta.url);

/** Exit codes, documented in the README. */
const OK = 0;
const FAILED = 1;   // stale blocks, unreadable file, malformed marker,
                    // or (with --lenient) an include that could not be resolved
const USAGE = 2;    // the command line itself was wrong

const HELP = `inject-examples — keep Markdown examples in sync with real files

Usage:
  inject-examples [options] [file]

  Each marker in \`file\` is a line that is nothing but a link to a real path,
  labelled with that same path, followed by a fenced code block:

      [fixtures/before.md](./fixtures/before.md)

      \`\`\`markdown
      ...replaced, byte for byte, with that file...
      \`\`\`

  A fence without a language is given one from the file's extension, so the
  block highlights; a fence that already names a language is left as written.

  Name a region in the fragment to inject part of a larger file:

      [src/app.ts](./src/app.ts#region:table)

Arguments:
  file                 Markdown document to update (default: ${DEFAULT_FILE})

Options:
  -c, --check          Write nothing; exit ${FAILED} if any block is stale
  -n, --dry-run        Write nothing; report what would change
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
  ${FAILED}  a block is stale in --check mode, the document is malformed,
             or (with --lenient) an include could not be resolved
  ${USAGE}  the command line was wrong
`;

/** Parse argv (already free of `node script`). Throws UsageError on nonsense. */
export class UsageError extends Error {}

export function parseArgs(argv) {
    const options = {
        file: null,
        root: null,
        gitignoreFile: null,
        noGitignore: false,
        check: false,
        dryRun: false,
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
                if (arg.startsWith('--gitignore=')) { options.gitignoreFile = arg.slice('--gitignore='.length); break; }
                throw new UsageError(`unknown option: ${arg}`);
        }
    }

    if (positionals.length > 1) {
        throw new UsageError(`expected at most one file, got ${positionals.length}: ${positionals.join(', ')}`);
    }
    if (options.gitignoreFile !== null && options.noGitignore) {
        throw new UsageError('--gitignore and --no-gitignore cannot be used together');
    }
    options.file = positionals[0] ?? DEFAULT_FILE;
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

/**
 * Run the CLI. Exported so a thin wrapper (for example the repo this tool was
 * extracted from) can reuse it without duplicating any behaviour.
 *
 * @param {string[]} argv arguments after `node script`
 * @returns {number} the process exit code
 */
export function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        console.error(`inject-examples: ${err.message}`);
        console.error('Try: inject-examples --help');
        return USAGE;
    }

    if (options.help) { process.stdout.write(HELP); return OK; }
    if (options.version) { console.log(version()); return OK; }

    const file = resolve(options.file);
    const root = options.root === null ? dirname(file) : resolve(options.root);

    let gitignore;
    if (options.noGitignore) {
        gitignore = false;
    } else if (options.gitignoreFile !== null) {
        const ignoreFile = resolve(options.gitignoreFile);
        let ignoreText;
        try {
            ignoreText = readFileSync(ignoreFile, 'utf8');
        } catch (err) {
            const reason = err.code === 'ENOENT' ? 'no such file' : err.message;
            console.error(`inject-examples: cannot read gitignore file ${display(ignoreFile)}: ${reason}`);
            return FAILED;
        }
        gitignore = [{ dir: dirname(ignoreFile), rules: parseIgnoreFile(ignoreText) }];
    } else {
        gitignore = true;
    }

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

    if (options.check) {
        if (stale.length > 0 || failed.length > 0) {
            if (stale.length > 0) {
                console.error(`\n${display(file)} is stale: ${stale.length} of ${checked} block(s) differ from their files.`);
            }
            if (failed.length > 0) {
                console.error(`${display(file)}: ${failed.length} of ${total} marker(s) could not be resolved and were left as written.`);
            }
            console.error(`Run: inject-examples ${options.file}`);
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
