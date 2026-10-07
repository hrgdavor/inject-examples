## Shell & Tool Execution Rules

### PowerShell Syntax Constraints
When executing terminal/CLI commands in PowerShell environments:
1. **NEVER use `&&` to chain commands.**
   - ❌ **Forbidden:** `cd src && npm test`
   - ❌ **Forbidden:** `git add . && git commit -m "feat: add feature"`
2. **Use single commands or explicit PowerShell chaining:**
   - Either issue commands as separate tool calls sequentially.
   - Or use PowerShell's semicolon `;` or conditional pipeline `$?:` operator:
     - ✅ **Allowed (Semicolon):** `cd src; npm test`
     - ✅ **Allowed (Conditional):** `cd src; if ($?) { npm test }`
3. **Keep commands atomic:** Prefer executing one clean, standalone command per tool call whenever possible to avoid parser issues.