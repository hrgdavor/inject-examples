// ============================================================================
// 3. ZIG SCANNER
// - Supports: Regular Strings ("), Multiline Strings (\\),
//   Line comments (//), and NESTED Block Comments (/* /* ... */ */).
// ============================================================================
export function scanZig(source, targetString) {
  let line = 1, col = 0;
  let inLineComment = false;
  let commentDepth = 0;      // Counter for nested /* */ comments
  let inString = false;       // "
  let inMultilineStr = false; // \\
  const matches = [];

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] || '';
    col++;

    if (ch === '\n') {
      line++; col = 0;
      inLineComment = false;
      inMultilineStr = false; // Zig multiline string terminates at newline
      continue;
    }

    // Active Line Comment
    if (inLineComment) continue;

    // Active Nested Block Comment
    if (commentDepth > 0) {
      if (ch === '/' && next === '*') {
        commentDepth++;
        i++; col++;
      } else if (ch === '*' && next === '/') {
        commentDepth--;
        i++; col++;
      }
      continue;
    }

    // Active String states
    if (inMultilineStr) continue;
    if (inString) {
      if (ch === '\\') { i++; col++; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    // Begin comments
    if (ch === '/' && next === '/') { inLineComment = true; i++; col++; continue; }
    if (ch === '/' && next === '*') { commentDepth++; i++; col++; continue; }

    // Begin strings (\ \ for multiline, " for standard)
    if (ch === '\\' && next === '\\') {
      inMultilineStr = true;
      i++; col++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }

    // Code Matching: Look for 'if' statements
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