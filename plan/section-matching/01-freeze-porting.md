# Step 1 — Freeze porting

**Depends on:** nothing. **Blocks:** every later step (they all assume the harness is off).
**Size:** small. One commit.

## Why this is first

The Zig port (`src/main.zig`, `src/root.zig`) exists to be *provably* the same tool as the
JavaScript, and `tools/compare-zig.mjs` proves it by comparing the two CLIs byte for byte.
The moment `lib/section.mjs` changes what a reference means, the Zig side is stale by
design, and the harness can only produce false failures. So the harness is switched off
**before** any semantics move, in a commit of its own, so the freeze is visible in history.

The Zig port and the differential harness are **paused** while file-section matching is formalised in JavaScript; they resume with their own plan, linking `doc/section-matching.md` (the shipped spec, written in step 2) rather than the plan directory. The port tracks an earlier revision of the syntax and is not currently verified against the current one.

## Current state (verified — do not assume otherwise)

- `package.json` has **no** `compare:zig` script; `scripts` is only
  `"test": "node --test test.mjs"`.
- `test.mjs` contains **no** reference to Zig, and nothing reads `src/**`. So the JS suite
  cannot detect a Zig regression, and the freeze is on you, not on a test.
- `.github/workflows/` contains only `release.yml`, which cross-builds Zig binaries on a
  `v*` tag. It does **not** run the differential harness.
- `tools/compare-zig.mjs` runs both CLIs over a fixed corpus plus a seeded fuzzer and
  compares stdout, stderr, exit code and rewritten files.

## Tasks

1. **`tools/compare-zig.mjs` — refuse to run by default.** Add a header banner saying it is
   **disabled until the JS file-section-matching syntax is settled**, naming this plan set
   (`plan/section-matching/`). In `main`, before doing any work, print a clear one-line
   reason to stderr and exit non-zero **unless** `--force` is present in the arguments.
   A default `node tools/compare-zig.mjs` must not look like a passing test, and must not
   write files.

   Keep its corpus and logic intact — this is a switch, not a deletion. Step 8 of the
   plan set adds a *different* gate (section vectors); do not conflate them.

2. **`package.json` — give the harness a named entry point, off the default path.**
   - add `"compare:zig": "node tools/compare-zig.mjs"`;
   - leave `"test"` as `node --test test.mjs` **for now** (step 8 appends the vector check);
   - do not add either script to `prepublishOnly`, CI, or any hook.

3. **`README.md` — record the pause.** In the "The Zig port" section, add one sentence
   stating that the Zig port and the differential harness are **paused** while file-section
   matching is formalised in JavaScript, and resume with their own plan, linking
   `doc/section-matching.md` (the shipped spec, written in step 2) rather than the plan
   directory.

   Honesty requirement: the sentence must not promise parity that no longer holds. Say the
   port tracks an **earlier revision** of the syntax and is not currently verified against
   the current one.

4. **CI — verify and preserve.** Confirm no workflow step runs `compare-zig.mjs`, and leave
   `release.yml` alone otherwise. If you find a workflow that does run it (there is none at
   `bc03bfe`), remove or guard that step. Do not add a Zig build step.

5. **Confirm the freeze is visible.** `git status` must show no change under `src/`,
   `build.zig` or `build.zig.zon`.

## Out of scope

- Do **not** delete or rewrite `tools/compare-zig.mjs`.
- Do **not** touch `src/**`, `build.zig`, `build.zig.zon`, `zig-out/`, `.zig-cache/`.
- Do **not** create `doc/section-matching.md` (that is step 2).
- Do **not** change `test.mjs`.
- Do **not** tag a release. A `v*` tag publishes Zig binaries on a committed workflow; the
  release notes would be wrong by construction, because the tree no longer contains the
  matching Zig implementation. This is a real hazard, not a formality.

## Done when

- [ ] `node tools/compare-zig.mjs` prints the disabled reason and exits non-zero.
- [ ] `node tools/compare-zig.mjs --force` still runs the old comparison (it will fail
      against the new syntax later — that is expected and is why it is off).
- [ ] `npm test` is unaffected and green.
- [ ] `npm run compare:zig` exists and is not part of `test`.
- [ ] `git diff --name-only` lists only `tools/compare-zig.mjs`, `package.json`,
      `README.md` (and `package-lock.json` only if the script addition changed it).
- [ ] No file under `src/`, `build.zig` or `build.zig.zon` is modified.
- [ ] The README states the pause and does not overclaim parity.

## Verification commands

```bash
node tools/compare-zig.mjs; echo "exit=$?"     # expect the disabled reason, exit != 0
npm test                                       # expect green
git diff --name-only                           # expect only the three files above
```

## Commit

One commit. Suggested message: `plan: freeze porting; disable the zig differential harness`
with a body naming `plan/section-matching/01-freeze-porting.md`.
