# Step 9 — Docs, exact-export lock, and the settle handoff

**Depends on:** [00-contract.md](00-contract.md), step 8. **Blocks:** nothing — this ends the
plan set. **Size:** medium. One or two commits.

## Goal

Ship the work: document the syntax for users, document the module for other projects,
publish the module, replace the brittle marker count, and hand a **frozen revision** to the
maintainer for sign-off. Porting is still frozen and no port is started here.

## Task 1 — `README.md`

Add a section (near "Region rules by file type") covering, in the README's existing voice:

- slash paths: an inner class, and a method inside it, with `Cart/Line/render`;
- code anchors: the condition literal and the comment anchor, with one example each;
- the trailing `-`/`+`/`++` modifiers, and that the old leading spelling still works;
- that a contradictory modifier warns and exits 1;
- a pointer to `doc/section-matching.md` for the full grammar;
- a pointer to `lib/section.mjs` for other projects that want the matcher.

Then, from step 1: confirm the "The Zig port" section still carries the pause sentence and
still does not overclaim parity. If step 1's wording has drifted, fix it here.

## Task 2 — `lib/README.md`

Written for someone in **another repository** who wants this matcher:

- what the module is: one file, zero dependencies, ES module, pure (no fs, no CLI);
- how to consume it: copy `lib/section.mjs` into the project, or
  `import { resolveSection } from '@hrg/inject-examples/lib/section.mjs'`;
- the exact public surface, listed as a table: `parseReference`, `resolveSection`,
  `planSection`, `scanBlocks`, `isSingleSegment`, `finalSegment`, `SectionReferenceError`
  (and anything else the module exports — list what actually exists, verified);
- the contract it implements, pointing at `doc/section-matching.md`;
- **"this revision is the reference"**: the JavaScript is authoritative; a port that
  disagrees is wrong by definition; do not fork the semantics per consumer;
- the status: **draft API until the maintainer signs off the settled revision** (task 5), and
  note that the API may still move while file-section matching is being settled.

## Task 3 — `doc/usage.md`, dogfooded

Add "Section paths" and "Code anchors" sections that **inject real fixture content** through
the new syntax — this document is the tool's own proof that the syntax works:

- a marker into `../test/fixtures/Example.java#region:Cart/Line/render` (or the nested form
  that best reads);
- a marker into `../test/fixtures/Anchors.java#region:dispatch/getUsers` and one into
  `#region:handler/getUsers`;
- update the Contents list at the top with the new section links;
- follow the existing conventions: paths relative to `doc/`, four-backtick wrappers when the
  injected content contains three-backtick fences.

Two hard rules for this document, both enforced by tests:

- Every new marker's `raw` line must be **unique** in the file — duplicate marker text is a
  hard error.
- Run the injector and commit the result: `npx inject-examples doc/usage.md`, then
  `--check` must exit 0.

## Task 4 — replace the brittle marker count, and publish the module

**`test.mjs`** — the test `the documentation stays in sync with the files it shows` asserts
`result.markers.length === 15`. Task 3 adds markers, so this breaks. Do **not** bump the
number: it has already rotted once and will rot again. Replace it with a structural
assertion that actually means "the docs are honest", for example:

- `result.changed === false` (keep this — it is the real check);
- every result entry is non-skipped and carries no `failure`;
- every entry's `marker.path` resolves to a file that exists;
- **every fenced block in `doc/usage.md` is preceded by a marker** (this is the property the
  count was approximating) — implement it by walking the document with the existing
  `fenceRanges`/`findMarkers` helpers rather than by counting.

State the reasoning in a comment, so the next person does not restore the count.

**`package.json`** — publish the module:

```json
"files": ["cli.mjs", "index.mjs", "README.md", "LICENSE", "lib", "doc/section-matching.md"],
"exports": {
  ".": "./index.mjs",
  "./cli.mjs": "./cli.mjs",
  "./lib/section.mjs": "./lib/section.mjs",
  "./package.json": "./package.json"
}
```

Keep `test` as step 8 left it. **Do not bump the version here** and do not publish from this
step; the release decision belongs to the maintainer.

**Do not tag a `v*` release.** A `v*` tag publishes Zig binaries built from a workflow whose
binaries no longer match the documented syntax. This is a real hazard, not a formality.

## Task 5 — the settle handoff

> **Discharged on 2026-10-10.** The maintainer reviewed the syntax, lifted the porting freeze,
> and the port is now active under [`plans/zig-port.md`](../zig-port.md). Two details differ
> from what this task asks for, and both are deliberate:
>
> - the settled commit sha was never written into `doc/section-matching.md`; the syntax has
>   since moved past any sha this step could have named (the `region:` keyword was dropped in
>   `10646fb`). The spec is normative **as it stands** — `node tools/section-vectors.mjs
>   --check` is what holds it to the implementation, not a commit pin;
> - `node tools/compare-zig.mjs` no longer prints a disabled message. It runs the full
>   comparison, and its green result is one of the gates the port plan requires.
>
> `lib/README.md` never carried the draft-API warning this task expected to remove, so there
> was nothing to replace.

This is the step that ends the plan set and hands the decision to a human.

1. In `doc/section-matching.md`, replace the placeholder revision line from step 2 with the
   **actual commit sha** of the settled revision, and say it is the frozen reference:
   `Written against the JavaScript implementation at commit <sha>.`
2. Add a short **"Status: settled"** note to `lib/README.md` (replacing the draft warning
   from task 2) **only if** the maintainer signs off; until then leave the draft warning and
   note the pending review.
3. Report to the maintainer, in the final message, all of:
   - the frozen commit sha;
   - the exact commands you ran and their results:
     `npm test`, `node tools/section-vectors.mjs --check`,
     `npx inject-examples --check README.md doc/usage.md`,
     `node tools/compare-zig.mjs` (expect the disabled message, non-zero);
   - the list of public exports, as shipped;
   - what is **not** done: any port, any `src/**` change, the differential harness still off,
     no version bump, no tag;
   - the one ask: use the syntax on a **real document** outside the fixtures, then decide
     whether the revision is settled. A green suite is not the trigger; the maintainer's
     review is (contract §3, plan set §9 of the superseded document).

## Out of scope

- No port, no `src/**` change, no `compare-zig.mjs` work beyond the step 1 switch.
- No version bump, no `npm publish`, no tag.
- Do not weaken or delete the doc-link test to make a new link pass; fix the link.
- Do not add new behaviour beyond the contract — this step documents and settles only.

## Done when

- [ ] `README.md`, `lib/README.md` and `doc/usage.md` describe the syntax, and every claim in
      them is true of the shipped code (no aspirational docs).
- [ ] `npx inject-examples --check README.md doc/usage.md` exits 0.
- [ ] `package.json` ships `lib/` and exports `./lib/section.mjs`; the version is unchanged.
- [ ] The brittle marker count is replaced by structural assertions, with a comment saying
      why; `test.mjs:1290` no longer exists as a count.
- [ ] `npm test` green (suite + vectors check).
- [ ] `doc/section-matching.md` carries the real commit sha.
- [ ] The final report lists the sha, the commands and their results, the exports, and what is
      deliberately not done.
- [ ] No file under `src/`, `build.zig`, `build.zig.zon` was modified anywhere in steps 1–9:
      check `git log --name-only` across the plan set's commits before declaring done.

## Verification

```bash
npm test
node tools/section-vectors.mjs --check; echo "exit=$?"
npx @hrg/inject-examples --check README.md doc/usage.md; echo "exit=$?"
node tools/compare-zig.mjs; echo "exit=$?"        # expect the disabled message, non-zero
git log --name-only --oneline -9 | grep -E '^\s*(src/|build\.zig)' || echo "no zig files touched"
```

## Commit

`docs: document file-section matching, ship lib/section.mjs, and settle the revision`
