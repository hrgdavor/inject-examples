// ============================================================================
// 2. JAVA SCANNER
// Shell over the shared tokenizer (./tokenizer.js). Java adds text blocks
// (`"""`) to the lexical set; the block tree, precedence and modifiers stay in
// `lib/section.mjs`, which drives `lexerJava`.
//   - `scanJava(source, target)`   — original sample API.
//   - `lexerJava`                  — the `.java` lexer seam.
//   - `visitJava(source, visitor)` — one-pass enumeration.
// ============================================================================
import { tokenize, makeLexer, JAVA_SYNTAX } from './tokenizer.js';

export const lexerJava = makeLexer(JAVA_SYNTAX);

export function scanJava(source, targetString) {
  return tokenize(source, JAVA_SYNTAX).ifClauses
    .filter((c) => c.clause.includes(targetString))
    .map((c) => ({ type: 'if_clause', line: c.line, col: c.col, snippet: c.snippet }));
}

export function visitJava(source, visitor) {
  return tokenize(source, JAVA_SYNTAX, visitor);
}
