// ============================================================================
// LEXER REGISTRY
// Maps a file extension to the language lexer that masks it for
// `lib/section.mjs`. An extension with no entry returns `undefined`, and the
// resolver then uses its built-in default engine — so the sample tokenizers are
// an optimisation for the languages they cover, never a requirement.
//
// `lib/section.mjs` must stay a single vendorable file (contract §10) and so
// cannot import these; the wiring lives on the consumer side, in `index.mjs`.
// ============================================================================
import { lexerJS, scanJS, visitJS } from './scanJS.js';
import { lexerJava, scanJava, visitJava } from './scanJava.js';
import { lexerZig, scanZig, visitZig } from './scanZig.js';

/** Extension → lexer. The languages this repository ships a sample tokenizer for. */
export const LEXERS = {
  js: lexerJS, mjs: lexerJS, cjs: lexerJS, jsx: lexerJS,
  ts: lexerJS, tsx: lexerJS, mts: lexerJS, cts: lexerJS,
  java: lexerJava,
  zig: lexerZig,
};

/**
 * The lexer for `path`'s extension, or `undefined` when the type is unknown
 * (no extension, or one with no sample tokenizer) and the default engine applies.
 * @param {string} path
 * @returns {import('../../lib/section.mjs').Lexer | undefined}
 */
export function lexerFor(path) {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return LEXERS[path.slice(dot + 1).toLowerCase()];
}

export { lexerJS, scanJS, visitJS, lexerJava, scanJava, visitJava, lexerZig, scanZig, visitZig };
