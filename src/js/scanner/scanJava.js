// ============================================================================
// 2. JAVA SCANNER
// - Supports: Standard Strings ("), Text Blocks ("""),
//   Single-line comments (//), and Block comments (/* ... */).
// ============================================================================
export function scanJava(source, targetString) {
  let line = 1, col = 0;
  let inComment = null;   // null | '//' | '/*'
  let inTextBlock = false; // """
  let inString = false;    // "
  const matches = [];

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] || '';
    col++;

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

    // Active Text Blocks (""")
    if (inTextBlock) {
      if (ch === '\\') { i++; col++; continue; }
      if (source.startsWith('"""', i)) {
        inTextBlock = false;
        i += 2; col += 2;
      }
      continue;
    }

    // Active Regular Strings (")
    if (inString) {
      if (ch === '\\') { i++; col++; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    // Begin comments
    if (ch === '/' && next === '/') { inComment = '//'; i++; col++; continue; }
    if (ch === '/' && next === '*') { inComment = '/*'; i++; col++; continue; }

    // Begin strings (Check Text Block """ prior to single ")
    if (source.startsWith('"""', i)) {
      inTextBlock = true;
      i += 2; col += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }

    // Code Matching: Look for 'if' clauses
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