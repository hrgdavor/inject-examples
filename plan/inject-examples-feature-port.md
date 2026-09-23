# Port report: finishing the move from `update-doc-includes.js` to the `inject-examples` mechanism

**Audience:** an agent taking over the port of the old include mechanism's remaining
features into the new marker mechanism.

**Reference implementation.** The `inject-examples` package in this repo: `index.mjs`
(the pure library) and `cli.mjs` (the thin CLI), **as of this revision**. Where a
project keeps its own copy of the mechanism (`scripts/inject-examples.mjs` + root
`test-fixtures.js`), that copy is the porting target: bring it to parity with the
§1 contract first, then port the §4 features on top. Target-specific extensions the
reference does not have (directory/glob targets) are their own feature work, under F2.

**Mission:** port the old mechanism's remaining features — or consciously retire them —
so no document or workflow depends on anything the new mechanism cannot do, **without
degrading the improvements the reference already ships (§1–§2)**.

**Rule:** the old script (`scripts/update-doc-includes.js`, Bun-based) is *not* to be
copied; the appendix specifies its behaviour precisely enough to reimplement against
the new architecture. Each feature in §4 ends with a status, a recommendation and
acceptance criteria.

> **Supersession note.** Earlier revisions of this document described the mechanism
> "as shipped" before fence-aware marker discovery, the length-aware fence closer,
> CRLF robustness, region-interleaving errors and gitignore skipping landed. Where
> they conflict with §1, **§1 wins**.

---

## 1. Current state of the mechanism — the contract (as shipped; must not be degraded)

Everything below is implemented and tested in the reference (`node test.mjs`, 34
tests). The port must preserve each item exactly.

- **Architecture and dependencies.** Zero dependencies, Node 18+, ESM. `index.mjs` is
  pure: it reads files only through an injected `readFile` (default `fileReader(root)`),
  so it is unit-testable and embeddable; `cli.mjs` owns argument parsing, disk I/O,
  reporting and exit codes, and re-exports `main` so a thin wrapper can reuse it
  without duplicating behaviour. Keep this split.

- **Marker.** A line is a marker when its *trimmed form* is exactly `[label](target)`
  where:
  - the label names the same path as the target, with or without a leading `./` on
    either side;
  - the target carries no URL scheme (`http:`, `mailto:`, etc. are never markers);
  - any fragment is absent or exactly `#region:<name>`.

  Anything else — different label, plain anchor, inline link inside a sentence — is
  prose and stays untouched. Because label = path, every marker renders as a working
  link to its source; that property is a feature — preserve it.

- **Fence** (CommonMark-style; the exact rules in `FENCE_OPEN` / `FENCE_CLOSE`):
  - Opening fence: a run of three or more backticks, any indentation, optional info
    string (`` ```ts ``).
  - Closing fence: a run of three or more backticks, any indentation, **no info
    string**, and **at least as long as the opener**. A longer closer is valid; a
    shorter one is not; `` ```js `` as a closer does not close the block.
  - An opening fence must follow the marker directly: blank lines in between are
    fine, any other non-blank line is an error. No fence after the marker at all, or
    one never closed, is an error ("unclosed code block after <marker>").
  - For *discovery*, an unclosed fence swallows the rest of the document — a
    marker-looking line after an unclosed fence is therefore inert content.
  - Consequence: a block wrapped in a four-backtick fence may contain three-backtick
    fence lines as content.

- **Marker discovery.** `findMarkers` is **fence-aware**: a line that looks like a
  marker inside a fenced block is content (or a syntax example), not a marker — a
  document's own examples must not inject themselves. Every marker carries its line
  `index`; `updateDocument` processes markers **backwards using those original
  indices**, so a document whose content contains marker-looking lines still works.
  Duplicate marker lines within one document are an error.

- **Regions.** `regionDirective` accepts the spellings the major editors share, under
  any comment prefix — `//`, `--`, `;`, `%`, `'`, `REM`, `<!--`, `/*`, `*` —
  case-insensitive, with an optional `#` before the keyword and an optional closing
  `-->` / `*/`. The C# spelling `#region name` / `#endregion` is accepted *without* a
  comment prefix; a bare `region name` line with no comment prefix is prose, not a
  directive. `extractRegion` returns the lines strictly between start and end (the
  directive lines themselves are never content) and throws on: a missing region, a
  duplicated region name, a region never closed, and a region **interleaved with
  another `#region`**.

- **Content semantics.** Whole file = text with `\r\n` normalised to `\n` and exactly
  one trailing newline dropped (`normalize`). Region = the lines strictly between,
  joined with `\n`.

- **Path resolution.** A marker's path resolves against **one base only**: the
  directory holding the document (CLI default) or `--root <dir>` (library:
  `options.root`). There is no repo-root fallback and no `../`-stripping fallback
  (see F6). A missing file is an error that names the marker.

- **Gitignore.** A marker whose target file is gitignored is **skipped**: its block
  is left exactly as written and reported as `skipped`. Skipping is not a failure:
  - Default: search upward from the document's directory collecting `.gitignore`
    files (git's behaviour), shallowest first, so a rule in a closer file wins; the
    last matching rule decides and a `!` rule un-ignores.
  - Supported rule features: `#` comments, blank lines, `!` negation, leading `/`
    anchoring, trailing `/`, `**`, `*`, `?`, `[...]` / `[!...]`, backslash escapes.
    Quoted patterns and trailing-space escapes are **not** supported.
  - An unanchored rule matches any single path segment; an anchored rule matches a
    leading path prefix.
  - CLI: `-g, --gitignore <file>` uses exactly that one file; `--no-gitignore`
    disables all rules; the two are mutually exclusive (a usage error). An unreadable
    ignore file is an error (exit 1).
  - **`--check` never counts a skipped block as stale**: a document whose markers
    are all skipped exits 0.
  - Library: `updateDocument` takes `gitignore` (`true` = default walk-up, `false`,
    `{ file }`, or a ready-made `[{ dir, rules }]` array); `isIgnored(relativePath)`
    overrides everything. The machinery — `parseIgnoreFile`, `loadIgnoreRules`,
    `isIgnoredPath` — is exported and reusable.

- **Document update.** `updateDocument` never touches disk; it returns
  `{ text, changed, markers, results }`. A skipped result is
  `{ marker, content: null, changed: false, skipped: true }`; a processed one is
  `{ marker, content, changed, skipped: false }`. A document with no markers yields
  `markers: []` — refusing that is the CLI's job, not the library's.

- **CLI.** One positional file (default `README.md`); `--root <dir>`;
  `-g, --gitignore <file>`; `--no-gitignore`; `-c, --check` (write nothing, exit 1 if
  any *non-skipped* block is stale); `-n, --dry-run` (write nothing, report what
  would change); `-q, --quiet`; `--allow-empty` (succeed when the document has no
  markers); `-h, --help`; `-V, --version`. Exit codes: `0` = every block up to date
  or rewritten (or all skipped under `--check`, or no markers with `--allow-empty`);
  `1` = a block is stale in `--check` mode, the document is malformed, the file or
  ignore file is unreadable, or the document has no markers without `--allow-empty`;
  `2` = the command line was wrong. **Nothing is written when a failure occurs
  anywhere** — the file is written only after `updateDocument` succeeds.

- **EOL.** The document is split on `\n` and rejoined the same way: original lines
  keep their trailing `\r`, so the document's own endings (LF or CRLF) are preserved
  **outside** the block body; injected content is LF-only. Idempotency holds across
  CRLF documents: a second run over a CRLF document is a no-op.

## 2. What was just done in the reference (the port must not regress it)

These landed after the earlier revisions of this plan and are now shipped contract:

1. **Fence-aware marker discovery** (`fenceRanges` + `findMarkers`): marker-looking
   lines inside fences are inert; running the CLI on its own README is a clean "no
   markers" result instead of a crash on its own examples.
2. **Length-aware fence closer** (`FENCE_OPEN` / `FENCE_CLOSE`): indentation allowed,
   info string on the opener only, closer must be a pure backtick run at least as
   long as the opener, unclosed fence swallows to EOF. Four-backtick wrapping of
   files whose content contains fence lines works.
3. **Stable second pass**: `updateDocument` processes backwards by each marker's
   original line index; `injectInto` takes an optional `startIndex`. Documents whose
   content contains marker-looking lines are stable across repeated runs.
4. **CRLF robustness**: `FENCE_OPEN` tolerates a trailing `\r`; `injectInto` compares
   the body with per-line `\r` stripped. CRLF documents are neither reformatted nor
   falsely reported stale.
5. **Region-interleaving error**: `extractRegion` throws when another `#region`
   opens inside a referenced region.
6. **Gitignore skipping**: default walk-up, `-g` / `--no-gitignore`, the `skipped`
   result shape, `--check` ignoring skips, all-skipped exit 0; `parseIgnoreFile`,
   `loadIgnoreRules`, `isIgnoredPath` exported.
7. **CLI surface**: `--check`, `--dry-run`, `--root`, `-g`, `--no-gitignore`,
   `--quiet`, `--allow-empty`, `--help`, `--version`, `--`; exit codes 0/1/2; `main`
   re-exported for wrappers.
8. **Zero dependencies, Node 18+**, pure library with an injected `readFile`.

## 3. What was done in the source repository (the migration log)

This is the work the port completes; recorded so the receiving agent knows what
"migrated" looked like in practice and what it surfaced:

1. **Implemented `test-fixtures.js`** (it was referenced by the new script but
   missing) with `findMarkers` / `resolveMarker` / `ROOT` per the earlier contract.
2. **Generalised `inject-examples.mjs`** from a single hard-coded root `README.md`
   to positional file/directory targets, per-file duplicate-marker rejection,
   aggregate `--check`, fixed usage text. Default (no args → root README) preserved.
3. **Converted 82 include directives** in `merge-java/docs/resolvers/**/*.md`
   (11 documents) from the old form — an HTML-comment line
   `<!-- INCLUDE:repo/root/path#region -->` above the fence — to marker lines with
   *document-relative* paths, e.g. a marker whose label and target are both
   `../../../src/test/java/.../TypeChangeConflictResolverTest.java`, target carrying
   `#region:adopts-wider-type`. Conversion was a throwaway script: regex-match the
   directive line, split the ref at the **last** `#`, resolve the source against the
   repo root, rewrite as document-relative, assert no duplicate marker lines per
   file. Source-side region markers (`//#region name` / `//#endregion` comments in
   Java tests and fixtures) needed **no change** — both mechanisms read the same
   region syntax.
4. **Converted the last old-format document** (`doc-hipster-entity/architecture/
   materialization-levels.md`), which used the old `~suffix` short-path feature
   (see F1) — its two directives became explicit relative-path markers into
   `hipster-entity-example`.
5. **Verified byte-equality**: re-injection reported `0 updated` everywhere (84
   markers, all "ok") — proof the new content semantics reproduce the old ones
   exactly — and `--check` passes on all targets.
6. **Ported EOL preservation** into the new script (the old one rewrote with the
   document's own EOL; the reference now preserves the document's endings outside
   the block body and injects LF-only content, per §1).
7. **Key discovery — the old script's short paths were silently broken**:
   `~iface/Person.java` matched both the real file and a copy under
   `.kilo/worktrees/...` (the root `.gitignore` ignores only `.kilo/plans`, and the
   old gitignore matcher was a simple segment/prefix test). The old script responded
   by WARN-ing on stderr, keeping the block unchanged, printing **"All blocks are
   up-to-date"** and exiting **0**. Two documentation blocks were frozen and nothing
   failed. After migration to explicit paths they resolve and verify again.
8. **Kept the old script, deprecated**: it has zero consumers now; it survives only
   because an architecture decision record (DEC-027) cites it as historical
   evidence. It carries a header comment saying: superseded, do not add new INCLUDE
   directives.
9. **Enforcement**: in the source repo a JUnit test (`merge-java`'s
   `ResolverDocsTest`) mirrors the script's semantics in the Java build (marker
   parse rules, resolution order, region uniqueness, byte-equality of every rendered
   block, "every fenced block in a resolver README is an injection block", dead-link
   check). If the target project has any mirror test like this, **every semantic
   change below must land in the script and the mirror test together**.

## 4. Features to port

For each: the old behaviour (exact), the design question, a recommendation, and
acceptance criteria. Recommendations are opinions formed from the migration above —
the failure modes are facts. **Statuses reflect the reference implementation as of
this revision.**

### F1 — `~suffix` short-path lookup — **not ported; retired from marker syntax**

**Old behaviour.** A reference starting with `~` (e.g. `~record/Person.java`)
triggered a repo-wide suffix search: build (and cache) an index of every file by
walking the repo from the root, skipping `.git` always and gitignored paths per the
*root* `.gitignore` only — patterns trimmed, comments dropped, trailing `/`
stripped; a path was ignored when any of its segments equalled a pattern, or the
whole relative path equalled a pattern or started with `pattern/`. An index entry
matched when its repo-relative path equalled the suffix or ended with `/` + suffix
(backslashes normalised to `/`). Exactly one match → used. More than one → WARN
listing all matches, then treated as not found. Zero → not found. "Not found" fed
the old tolerant mode (F3): block kept, exit 0.

**Why it broke.** The segment/prefix gitignore approximation missed
`.kilo/worktrees` (only `.kilo/plans` is ignored), so worktree copies of the same
source made every short path ambiguous → permanently frozen blocks behind a green
run (§3.7).

**Design question for the new format.** A marker's label must equal its path, and
markers are meant to render as working links. A `~suffix` marker
(`[~record/Person.java](...)`) is not a link to anything — the format collides with
the feature.

**Recommendation: retire it.** Prefer explicit document-relative or root-relative
paths, as the migration did; they are unambiguous, they render as links, and the
resolution base already covers both. If the target project genuinely needs suffix
search, port it as a *separate lookup tool* (e.g. a `--resolve ~suffix` helper that
prints the explicit path to paste into a marker), never inside marker syntax — and
then: require a unique match, **error** (exit 1) on ambiguity listing every
candidate. Build the ignore-aware candidate list with the reference's existing
machinery — `loadIgnoreRules` + `isIgnoredPath` (real gitignore semantics, already
exported) — not a re-invented matcher and not `git ls-files` (keep zero external
tools). A plain recursive walk skipping `.git` and `node_modules` is an acceptable
fallback when no `.gitignore` is found.

**Acceptance.** No marker syntax change; documents that previously needed short
paths carry explicit paths; if the lookup helper is ported: unique suffix → prints
one path; ambiguous → non-zero exit naming all candidates; no silent fallback.

### F2 — Glob CLI patterns — **not ported**

**Old behaviour.** Any argument containing `*`, `?` or `{` was expanded with Bun's
`Glob.scanSync({ cwd: repoRoot, absolute: true })`; other arguments were plain file
paths. Zero matches overall → print "No files matched the given pattern(s).",
exit 0. The everyday invocation was
`bun scripts/update-doc-includes.js "docs/**/*.md"` from the repo root.

**Design question.** The reference CLI takes a **single positional file** (default
`README.md`) — it has no directory recursion at all. The target project's in-repo
script may have directory targets (§3.2); keep those if the project relies on them,
but they are target-specific extensions, not reference contract. Node ≥ 22 offers
`fs.globSync` — the reference targets Node 18+, so it is not available; the port
must stay dependency-free plain Node either way.

**Recommendation.** Add pattern arguments only if the project's docs use them.
Cheapest correct implementation: walk from the pattern's longest glob-free prefix
directory and filter with a translated regex — escape regex metacharacters, then
`**/` → `(?:.*/)?`, `*` → `[^/]*`, `?` → `[^/]`, `{a,b}` → `(?:a|b)` — matching
against the root-relative path with `/` separators; skip `.git` always and
gitignored paths via `isIgnoredPath` (the walk-up default), so globs and the
gitignore feature compose. If directory targets exist, keep skipping `node_modules`
and dot-directories in the walk. Decide and document the no-match policy: the old
exit-0 is another silent-success shape; recommend exit 1 with "no files matched:
<pattern>". Also document the multi-file interactions: `--check` exits 1 if any
file is stale; "no markers" in one file is an error per file unless `--allow-empty`;
a failure in any file aborts the whole run before writing anything (strict,
matching the reference).

**Acceptance.** A pattern selects exactly the same file set as the equivalent
explicit file list; a pattern matching nothing fails loudly (exit 1); file (and, if
present, directory) arguments behave unchanged; no new dependencies; glob-expanded
runs and single-file runs agree on every block.

### F3 — Tolerant failure mode (`WARN` + keep + continue) — **ported**

**As implemented.** The recommendation above is what shipped: opt-in `--lenient`
(library: `options.lenient` of `updateDocument`, so the CLI stays a thin
wrapper). Resolution and fence failures are reported on stderr as
`inject-examples: warn: <file>:<line>: <marker>: <cause>`, the block is kept,
the run continues, and the run ends `1` whenever any failure-skip occurred —
in normal, `--check` and `--dry-run` modes. Duplicate markers and stray text
where a block should be stay strict in every mode. `IncludeError` marks the
tolerable errors so the strict/lenient split is type-based, not message-based.
All acceptance criteria below hold (see `test.mjs`: the `lenient` library tests
and the `main --lenient` CLI tests).

**Old behaviour.** Missing markdown file → error + exit 1 (that one was strict).
Everything else — source not found, region not found, no endregion, no fence after
the directive, unterminated fence — → `WARN` on stderr, existing block kept
unchanged, `skipped` counter up, processing continued; final summary counted only
*updated* blocks and the process exited 0 even when skips occurred ("All blocks are
up-to-date." was printed with four WARNs pending — the masking bug behind §3.7).

**Design question.** The reference is strictly strict: any failure throws, nothing
is written, exit 1. That strictness surfaced the frozen blocks, so the default must
stay strict. But a batch run over a big tree aborting on the first dead include is
annoying when the goal is "refresh everything that *can* be refreshed".

**Recommendation.** Port as an opt-in `--lenient` flag: resolution/fence failures
WARN (naming document, line number — `marker.index` is available — marker and
cause), the block is kept, the run continues; the summary reports these skips next
to `updated`; **exit code is 1 whenever any failure-skip occurred**, in both normal
and `--check` mode — never reproduce "green run with warnings only on stderr".
**Keep the two skip categories strictly distinct:** gitignored `skipped` is a
*success* (block left by design, `--check` still exits 0, per §1) while a
`--lenient` skip is a *failure* (exit 1). A shared "skipped" counter or a shared
exit-code rule would degrade the gitignore feature. Keep duplicate markers and
malformed fences around markers strict even under `--lenient` (they indicate a
broken document, not a broken include).

**Acceptance.** One dead + three good markers in a file: default → aborts, writes
nothing, exit 1; `--lenient` → three blocks refreshed, dead one reported with its
line number, exit 1; `--lenient --check` → no writes, same reporting and exit code.
A fully healthy run exits 0 in all modes; a run whose only skips are gitignored
exits 0 under `--check` even with `--lenient` present.

### F4 — Fence flexibility (tildes, indentation, tick-run matching) — **partly done**

**Old behaviour.** Opening fence: first line after the directive (blanks skipped)
matching `^\s*(`{3,}|~{3,})` — leading whitespace allowed, three or more backticks
*or* tildes; the matched token (e.g. `` ``` `` or `~~~~`) was captured. Closing
fence: the first later line whose **trimmed form equals that exact token** — so a
bare fence closes, the token length must match, and an info string on the closing
line (`` ```java `` as a closer) did *not* close the block (it produced
"unterminated code fence" WARN). Fence content = lines strictly between.

**Shipped today (do not regress).** Indentation is allowed on both fences (any
`\s*`), an info string is allowed on the opener only, and the closer is a pure
backtick run **at least as long as the opener** (CommonMark). A closer with an info
string does not close — same as the old behaviour, now as a hard error rather than a
WARN. The old "exact token match" rule is *superseded* by the length rule: a
four-backtick opener closes on four *or more* ticks, which is what makes the
four-backtick wrapping idiom work.

**Still missing.** Tilde fences (`~~~`) are not supported.

**Recommendation.** Do **not** replace the shipped closer with the old exact-token
rule; it would break already-tested, documented behaviour. Port tildes only if a
document actually needs them, and then extend `FENCE_OPEN` / `FENCE_CLOSE`
consistently: opener `(?:`{3,}|~{3,})` with the same indentation/info-string
rules; closer a pure run of the **same** character as the opener, at least as long
as the opener (a tilde opener never closes on backticks and vice versa); keep the
"unclosed swallows to EOF" discovery rule and the hard error in `injectInto`. Add
tests for every new case before enabling it.

**Acceptance.** Existing `` ``` `` blocks behave byte-identically to today; an
indented opener with an info string injects correctly; a four-backtick block
containing a three-backtick line keeps that line as content; a closer carrying an
info string is reported as unterminated (error by default); if tildes are ported, a
`~~~`-fenced block injects correctly and never cross-closes with backtick fences.

### F5 — Fence-aware marker discovery — **done**

**Old plan.** `findMarkers` was fence-blind, so a document that shows an example
marker line inside a fenced block would have it treated as a real marker (and,
being strict, fail the whole run on a path that does not exist).

**Shipped today.** `fenceRanges` computes the fenced-block ranges; `findMarkers`
skips every line inside them, so marker-looking lines inside fences are inert. This
is exactly the F5 fix, and it is what lets the README document its own syntax.

**Recommendation.** Do not re-derive a second fence state machine; reuse
`fenceRanges` anywhere fence knowledge is needed (new features, mirror tests). Note
the one intended consequence: an unclosed fence swallows to EOF, so a
marker-looking line after an unclosed fence is inert — keep that.

**Acceptance.** A fenced block containing a self-labelled-link line pointing at a
nonexistent path is ignored (run succeeds, block untouched); the same line outside
any fence is a marker and fails resolution as before; all existing markers (which
live outside fences) are unaffected; if a mirror test exists, its marker scan gains
the same fence-awareness.

### F6 — Third path-resolution fallback (strip leading `../`) — **not ported**

**Old behaviour.** After document-relative and root-relative both missed, leading
`../` segments were stripped (`^(?:\.\.[\\/])+`) and the remainder retried from the
repo root — covering docs that referenced sibling modules with the wrong number of
`../`.

**Shipped today.** Resolution is a single `resolve(base, path)` against the document
directory (or `--root`); there is no fallback.

**Recommendation.** Port it only as an additional candidate *inside the reader*
(document-relative → stripped-from-root), never as a marker-syntax feature, and
make failures **name every tried location** in the error message, so the crutch
never hides a simply-wrong path. Optionally warn when only the stripped candidate
hits ("marker path depth is wrong; it resolved via the fallback"). If the target
project's docs all resolved fine during the migration, simply document the
fallback's absence and keep single-base resolution.

**Acceptance.** From a doc two levels deep, a marker with three `../` segments
resolves via the fallback; a truly missing file errors listing all attempted paths.

## 5. Invariants — the port must not degrade these

1. **Gitignore skipping semantics.** Skipped markers are left verbatim, reported as
   `skipped`, never counted as stale; `--check` exits 0 when only skipped blocks
   exist; default walk-up from the document's directory; `-g` / `--no-gitignore`
   exactly as in §1, mutually exclusive; unreadable ignore file → exit 1.
2. **Fence rules.** `FENCE_OPEN` / `FENCE_CLOSE` as in §1: indentation, info string
   on the opener only, closer a pure run at least as long as the opener, unclosed
   swallows to EOF for discovery and is a hard error in `injectInto`.
3. **Fence-aware discovery.** Marker-looking lines inside fences are inert; markers
   carry their `index`; duplicates are an error; backwards processing by original
   index.
4. **Region rules.** Comment-prefix spellings, C# `#region` without a comment
   prefix, bare `region name` is prose; missing / duplicate / unclosed /
   interleaved are all errors.
5. **Content semantics.** `normalize` = CRLF→LF, exactly one trailing newline
   dropped; region = strictly between.
6. **EOL behaviour.** The document's own endings are preserved outside the block
   body; injected content is LF-only; a second run over a CRLF document is a no-op.
7. **Strictness and exit codes.** Default mode fails loudly and writes nothing on
   any failure; exit codes 0/1/2 per §1; "no markers" is an error without
   `--allow-empty`. Any `--lenient` port keeps its failure-skips distinct from
   gitignored skips (§4 F3).
8. **Purity.** Zero dependencies, Node 18+, library reads only through the
   injected `readFile`; the CLI stays a thin wrapper over `updateDocument`.
9. **The link property.** Markers remain whole-line self-labelled links; label =
   path is never relaxed.

## 6. Verification checklist (run all, in order)

1. **Existing suite stays green** after every change: `node test.mjs` (34 tests in
   the reference). This is the regression gate for §1–§2.
2. **Idempotence**: run the injector twice over every target; second run reports
   all "ok", 0 updated, exit 0. Includes CRLF documents: after injection the file
   is still uniformly CRLF outside the injected body, and the second pass is a
   no-op on it.
3. **Round-trip fidelity**: for a sample of migrated blocks, content equals
   `resolveMarker(marker, docDir)` byte-for-byte (this is what `--check` asserts —
   run it).
4. **Gitignore matrix**: a `.gitignore` in the document's directory and one in an
   ancestor (closest wins); `-g <file>`; `--no-gitignore`; all-skipped `--check` →
   exit 0; mixed stale+skipped `--check` → exit 1; `--gitignore` + `--no-gitignore`
   → exit 2; missing `-g` file → exit 1; a `!` rule un-ignores; anchored rules only
   match at the root of their `.gitignore`.
5. **Fence matrix**: `` ``` `` block; four-tick wrapper containing a three-tick line
   as content; indented opener; closer longer than the opener; closer with an info
   string → unterminated error; unclosed fence → error (and inert marker discovery
   past it); tildes only if ported per F4.
6. **Fence-awareness**: an example marker line inside a fence is inert (F5); the
   same line outside any fence fails resolution.
7. **Region matrix**: unique names; duplicate → error; unclosed → error; interleaved
   `#region` → error; C# spelling without comment prefix works; bare `region name`
   prose is ignored.
8. **Strict/lenient matrix** (only if F3 is ported): dead marker × {default,
   `--lenient`, `--check`, both} → exit codes and write behaviour per F3, with
   gitignored skips staying exit-0 in every combination.
9. **Per-feature acceptance criteria** from §4 (F1–F6 as ported).
10. **Mirror tests**: if the project has a build-side mirror of the script
    semantics (like the source repo's `ResolverDocsTest`), it is updated in the
    same change and the full build is green; the mirror and the script must not be
    allowed to disagree — that disagreement is exactly the drift both mechanisms
    exist to prevent.

## 7. Appendix — the old script's exact rules (reference for reimplementation)

Recorded because the old file is not present in the target project. **Reference
only: where any of this conflicts with §1, §1 (the reference implementation) wins.**

- Directive: `/<!--\s*INCLUDE:(.+?)\s*-->/` via `line.match` (first match per line,
  anywhere in the line); the directive line itself was always kept in the output.
- Ref parsing: split at the **last** `#`; empty suffix → no region.
- Resolution order: document-dir-relative → repo-root-relative → strip leading
  `../` → repo-root-relative; `~` prefix short-circuited to the suffix index (F1);
  `existsSync` only (directories could "resolve" — the reference's regular-file
  check is an improvement, keep it).
- Whole-file snippet: `text.replace(/\r?\n$/, '')` — one trailing newline removed,
  interior CRLF *not* normalised (the reference normalises to LF; keep the new
  behaviour, it is what the migrated blocks were verified against).
- Region snippet: `text.split(/\r?\n/)`, start regex
  `^\s*(?:\/\/|/\*+|<!--)\s*#?region\s+<escaped NAME>\b` (first match), end regex
  `^\s*(?:\/\/|\/\*+|<!--)\s*#?endregion\b` (first match after start), content =
  lines strictly between, joined with `\n`. (The reference's `regionDirective` is
  a superset of this spelling set — see §1 — plus the C# `#region` spelling and the
  interleaving error.)
- Fences: see F4. Blank lines between directive and opening fence were copied
  through.
- Output: EOL detected from the document (`includes('\r\n')`), everything rejoined
  with it; file written only when changed. (The reference preserves the document's
  endings outside the block body and injects LF-only content — see §1.)
- Exit codes: 0 in all non-fatal cases (including skips — the bug); 1 only for
  missing markdown file or no arguments (usage text).
- Usage/help: no arguments → usage text + exit 1. The reference's no-argument
  behaviour (default to `README.md`) is intentional and stays.
