## Shell Rules
- Platform: Windows PowerShell.
- Do NOT use `&&` in shell commands. Use separate tool calls or `;` instead.

## Demo page (`docs/index.html`)

- `docs/index.html` is **generated** — never edit it by hand.
- Three columns: the targets (prose + clickable markers), the source file with
  the selected line range highlighted, and the document rendered GitHub-style
  (code fences highlighted) with the marker and its injected block highlighted
  in place. The lead — title and intro before the first `##` — is shown once, as
  the page banner, and is skipped in both the targets and the rendered column.
- Source: `docs/demo.md`. It is an ordinary Markdown document whose `##`
  sections become the numbered paragraphs of the page and whose markers become
  its clickable targets. The markers inject `docs/samples/*` (currently
  `Inventory.java`).
- Generator: `tools/build-demo.mjs`, run with Bun:
  `bun tools/build-demo.mjs` (or `npm run demo`) writes the page,
  `bun tools/build-demo.mjs --check` (or `npm run demo:check`) exits 1 when it
  is stale.
- Adding an example: write the `##` section with its prose and a marker in
  `docs/demo.md`, run `node cli.mjs docs/demo.md` to fill the block, then run
  the generator.
- `test.mjs` holds the page to the docs' standard: `docs/demo.md` must be in
  sync with the sample, every target's line range must be the text it injects,
  and `docs/index.html` must be byte-identical to the generator's output.
