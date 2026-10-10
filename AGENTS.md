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
  its clickable targets. The markers inject `docs/samples/*` — one small sample
  per language and config format (Java, Go, Rust, Python, C#, Kotlin, PHP, Ruby,
  SQL, Shell, VB, Haskell, Zig, YAML, TOML, INI, JSON) — and the middle column
  gets a tab per file, the active one scrolled into view.
- Generator: `tools/build-demo.mjs`, run with Bun:
  `bun tools/build-demo.mjs` (or `npm run demo`) writes the page,
  `bun tools/build-demo.mjs --check` (or `npm run demo:check`) exits 1 when it
  is stale.
- Adding an example: put the sample in `docs/samples/`, write the `##` section
  with its prose and a marker in `docs/demo.md`, run `node cli.mjs docs/demo.md`
  to fill the block, then run the generator (a new file adds a tab to the middle
  column). Highlighting for every sample comes from the `HIGHLIGHTERS` table in
  `tools/build-demo.mjs`, whose comment/string spans are the resolver's own
  syntaxes; a new language needs a keyword set there too.
- `test.mjs` holds the page to the docs' standard: `docs/demo.md` must be in
  sync with the sample, every target's line range must be the text it injects,
  and `docs/index.html` must be byte-identical to the generator's output.

## Languages and the mask oracle

- `src/js/scanner/syntaxes.js` is the language table: **one object per
  language, all data** — comment spellings, string forms (`escape`, `hashes`,
  `maxSpan`/`content`, …), `heredoc`, plus the two optional extras the resolver
  consumes: `declarations` (the shapes the generic `name(` heuristics miss —
  Ruby `def`, Haskell bindings) and `annotations` (what `+` brings along, e.g. a
  Haskell `name ::` signature). `src/js/scanner/tokenizer.js` walks the table;
  `src/js/scanner/lexers.js` maps extensions to it. `lib/section.mjs` must stay
  dependency-free and untouched by language detail.
- Adding a language: one object in `syntaxes.js`, one line in `EXTENSIONS` in
  `lexers.js`, and probe entries in the corpus (below).
- The corpus is `PROBES` in `tools/mask-oracle.mjs`; `test.mjs` runs it, so one
  entry is one test. `npm run oracle` cross-checks the same corpus against
  highlight.js (devDependency, never shipped): every region the highlighter
  calls a comment or string must be blank in our mask. `--emit` shows what it
  saw, `--self-test` proves the check can fail, `--no-oracle` needs no
  dependency.

## The Zig port

- **Porting is allowed and the JavaScript implementation is the source of truth.**
  The goals, the gates and the rules for changing something after the port are in
  [`plans/zig-port.md`](./plans/zig-port.md) — read it before touching `src/`.
  The old freeze lives in `plans/section-matching/` and is history.
- `src/` mirrors the JavaScript file for file, and the port must produce the same
  bytes: `src/js.zig` (the UTF-16 code-unit runtime), `src/section.zig`
  (`lib/section.mjs`), `src/scanner/{syntaxes,tokenizer,lexers}.zig`
  (`src/js/scanner/`), `src/data_rules.zig` (the YAML/TOML/INI rules),
  `src/root.zig` (`index.mjs`), `src/main.zig` (`cli.mjs`).
- Three gates, all of which must be green:
  `node --test test.mjs` (and `node tools/section-vectors.mjs --check`),
  `zig build test` (which includes `src/section_vectors.zig`), and
  `node tools/compare-zig.mjs` (JS vs Zig, byte for byte).
- `src/section_vectors.zig` is **generated** — never edit it by hand.
  `node tools/zig-vectors.mjs` writes it from
  `test/vectors/section-vectors.json` plus the fixture text; `--check` fails
  when it is stale. Regenerate it whenever the vectors change (which
  `node tools/section-vectors.mjs` does) or a fixture changes.
- `zig build` and `zig build test` need a writable Zig cache; in a sandbox
  that blocks the global cache, pass
  `--global-cache-dir .zig-cache/global --cache-dir .zig-cache/local`.
- `.github/workflows/ci.yml` runs the three gates on every push and pull
  request; `.github/workflows/release.yml` builds the tagged binaries.

