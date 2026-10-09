// ============================================================================
// LEXER REGISTRY
// Maps a file extension to the language lexer that masks it for
// `lib/section.mjs`. An extension with no entry returns `undefined`, and the
// resolver then uses its built-in default engine — so the language table is an
// optimisation for the types it covers, never a requirement.
//
// Every entry is built from the same one-pass tokenizer and the same data table
// (`syntaxes.js`), so adding a language is one object there plus one extension
// line here. `lib/section.mjs` must stay a single vendorable file (contract §10)
// and so cannot import these; the wiring lives on the consumer side, in
// `index.mjs`.
// ============================================================================
import { makeLexer } from './tokenizer.js';
import { SYNTAXES } from './syntaxes.js';
import { lexerJS, scanJS, visitJS } from './scanJS.js';
import { lexerJava, scanJava, visitJava } from './scanJava.js';
import { lexerZig, scanZig, visitZig } from './scanZig.js';

/** Extension → syntax name. One line per extension; the table itself is in `syntaxes.js`. */
export const EXTENSIONS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  java: 'java',
  zig: 'zig',
  go: 'go',
  rs: 'rust',
  py: 'python', pyi: 'python',
  cs: 'csharp',
  kt: 'kotlin', kts: 'kotlin',
  php: 'php', phtml: 'php',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  vb: 'vb', bas: 'vb', vbs: 'vb',
  hs: 'haskell', lhs: 'haskell',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', properties: 'ini',
};

/**
 * Extension → lexer, for every extension in `EXTENSIONS`. The three original
 * languages keep their named lexers (and their `scanX`/`visitX` sample APIs);
 * the rest are built from the table here.
 */
export const LEXERS = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([extension, name]) => [extension, makeLexer(SYNTAXES[name])]),
);
LEXERS.js = lexerJS;
LEXERS.mjs = lexerJS;
LEXERS.cjs = lexerJS;
LEXERS.jsx = lexerJS;
LEXERS.ts = lexerJS;
LEXERS.tsx = lexerJS;
LEXERS.mts = lexerJS;
LEXERS.cts = lexerJS;
LEXERS.java = lexerJava;
LEXERS.zig = lexerZig;

/**
 * The lexer for `path`'s extension, or `undefined` when the type is unknown
 * (no extension, or one with no entry) and the default engine applies.
 * @param {string} path
 * @returns {import('../../lib/section.mjs').Lexer | undefined}
 */
export function lexerFor(path) {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return LEXERS[path.slice(dot + 1).toLowerCase()];
}

export { lexerJS, scanJS, visitJS, lexerJava, scanJava, visitJava, lexerZig, scanZig, visitZig };
