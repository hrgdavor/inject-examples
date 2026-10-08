// ============================================================================
// 1. JAVASCRIPT / TYPESCRIPT SCANNER
// - Supports: Single/Double quotes ('/"), Template literals (`...`),
//   Single-line comments (//), and Block comments (/* ... */).
// ============================================================================
export function scanJS(source, targetString) {
  let line = 1, col = 0;
  let inString = null;  // null | '"' | "'" | '`'
  let inComment = null; // null | '//' | '/*'
  const matches = [];

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] || '';
    col++;

    // Track line/col across newlines
    if (ch === '\n') {
      line++; col = 0;
      if (inComment === '//') inComment = null;
      continue;
    }

    // Active comments
    if (inComment === '//') continue;
    if (inComment === '/*') {
      if (ch === '*' && next === '/') {
        inComment = null;
        i++; col++;
      }
      continue;
    }

    // Active string literals (handles escaping for all types)
    if (inString) {
      if (ch === '\\') { i++; col++; continue; }
      if (ch === inString) inString = null;
      continue;
    }

    // Begin comments
    if (ch === '/' && next === '/') { inComment = '//'; i++; col++; continue; }
    if (ch === '/' && next === '*') { inComment = '/*'; i++; col++; continue; }

    // Begin strings (includes multiline template literals)
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    // Code Matching: Look for 'if' statements containing targetString
    if (ch === 'i' && next === 'f' && isBoundary(source, i, 2)) {
      const braceIdx = source.indexOf('{', i);
      if (braceIdx !== -1) {
        const clause = source.slice(i, braceIdx);
        if (clause.includes(targetString)) {
          matches.push({ type: 'if_clause', line, col, snippet: clause.trim() });
        }
      }
    }
  }
  return matches;
}