// ============================================================================
// 1. JAVASCRIPT / TYPESCRIPT SCANNER
// Thin language-specific shell over the shared tokenizer (./tokenizer.js).
//   - `scanJS(source, target)`  — the original sample API: `if` clauses whose
//     header (up to the opening brace) carries `target`.
//   - `lexerJS`                 — the `lib/section.mjs` lexer seam, so a `.js`
//     / `.ts` file is masked by this engine instead of the built-in default.
//   - `visitJS(source, visitor)`— one-pass enumeration for other uses or tests.
// ============================================================================
import { tokenize, makeLexer, JS_SYNTAX } from './tokenizer.js';

export const lexerJS = makeLexer(JS_SYNTAX);

export function scanJS(source, targetString) {
  return tokenize(source, JS_SYNTAX).ifClauses
    .filter((c) => c.clause.includes(targetString))
    .map((c) => ({ type: 'if_clause', line: c.line, col: c.col, snippet: c.snippet }));
}

export function visitJS(source, visitor) {
  return tokenize(source, JS_SYNTAX, visitor);
}
