// ============================================================================
// 3. ZIG SCANNER
// Shell over the shared tokenizer (./tokenizer.js). Zig is where a per-language
// lexer earns its keep: NESTED block comments and `\\` multiline strings, which
// the built-in default mask (non-nesting `/* *\/`, no `\\`) gets wrong.
//   - `scanZig(source, target)`  — original sample API.
//   - `lexerZig`                 — the `.zig` lexer seam.
//   - `visitZig(source, visitor)`— one-pass enumeration.
// ============================================================================
import { tokenize, makeLexer, ZIG_SYNTAX } from './tokenizer.js';

export const lexerZig = makeLexer(ZIG_SYNTAX);

export function scanZig(source, targetString) {
  return tokenize(source, ZIG_SYNTAX).ifClauses
    .filter((c) => c.clause.includes(targetString))
    .map((c) => ({ type: 'if_clause', line: c.line, col: c.col, snippet: c.snippet }));
}

export function visitZig(source, visitor) {
  return tokenize(source, ZIG_SYNTAX, visitor);
}
