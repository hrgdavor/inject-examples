# File-section matching — plan set (JavaScript)

The work of formalising `#region:<reference>` into a specified **file-section matching**
syntax, split so that each part is small enough for one agent to complete and verify in one
sitting. **Read this index first, then exactly two documents: the contract, and your step.**

| Order | Document | One-line scope | Depends on |
| --- | --- | --- | --- |
| — | [00-contract.md](00-contract.md) | The frozen syntax + house rules. **Binding on every step; implement it, never change it.** | — |
| 1 | [01-freeze-porting.md](01-freeze-porting.md) | Stop all porting; switch the Zig differential harness off; delete the stale hard-coded reference counts | — |
| 2 | [02-spec-document.md](02-spec-document.md) | Write the normative spec `doc/section-matching.md` from the contract | 00 |
| 3 | [03-fixtures-and-failing-tests.md](03-fixtures-and-failing-tests.md) | Add the anchor fixture; pin every expected byte as failing tests | 00, 01 | ✓ done (test/fixtures/Anchors.java created, failing tests added to test.mjs) |
| 4 | [04-parse-layer.md](04-parse-layer.md) | `lib/section.mjs`: reference parsing, canonicalisation, errors, the contradiction warning | 00, 03 |
| 5 | [05-scanner-layer.md](05-scanner-layer.md) | `lib/section.mjs`: the mask pass and the block scanner | 00, 04 |
| 6 | [06-resolve-layer.md](06-resolve-layer.md) | `lib/section.mjs`: matcher precedence, scope descent, modifiers | 00, 05 |
| 7 | [07-wire-into-index.md](07-wire-into-index.md) | Delegate `index.mjs` to the new module; prove existing behaviour unchanged | 00, 06 |
| 8 | [08-vectors.md](08-vectors.md) | Golden vectors with a `--check` drift gate, wired into `npm test` | 00, 07 |
| 9 | [09-docs-and-settle.md](09-docs-and-settle.md) | Dogfooded docs, the vendoring README, and the settle/sign-off handoff | 00, 08 |

The superseded single-document plan is kept for history at
[inject-examples-section-matching.md](inject-examples-section-matching.md). **Where it and
these documents disagree, these documents win**; it will not be updated.

## How the split works

- **The contract is frozen and shared.** Syntax, matcher precedence, worked examples and
  error messages live in [00-contract.md](00-contract.md) and nowhere else. A step document
  never restates them; it cites them. If a step needs a contract change, it **stops** and
  reports back — it does not edit the contract.
- **Each step owns one commit.** A step is done when its own acceptance checklist passes and
  `node test.mjs` (or `node --test test.mjs` once steps 3+ add tests) is green. Steps land in
  order; do not start a step before its dependencies are committed.
- **Every step is a pure JavaScript step.** Porting is frozen — see §3 of the contract.
  No step may touch `src/**`, `build.zig`, `build.zig.zon`, or write a Java/Zig file.
- **Test counts drift, so nothing depends on them.** Prefer "assert this exact string",
  "assert this throws", "the whole suite is green" over "there are exactly N tests".

## Status

| Step | Status |
| --- | --- |
| 1 freeze porting | ✓ done (tools/compare-zig.mjs has disabled-banner header + `--force` flag; package.json has `"compare:zig"` script; plan\README.md status updated) |
| 2 spec document | ✓ done (doc/section-matching.md created with all 11 items; links resolve correctly, no injected blocks from fixtures, marker-shaped lines go inside fenced code blocks) |
| 3 fixtures + failing tests | ✓ done (test/fixtures/Anchors.java created, failing tests added to test.mjs) |
| 4 parse layer | ⛔ not started |
| 5 scanner layer | ⛔ not started |
| 6 resolve layer | ⛔ not started |
| 7 wire into index | ⛔ not started |
| 8 vectors | ⛔ not started |
| 9 docs + settle | ⛔ not started |

Working tree is clean at `bc03bfe`. Step 1 (freeze porting) is done; step 2 (spec document) is done;
step 3 (fixtures + failing tests) is done — `test/fixtures/Anchors.java` created and failing tests added to
`test.mjs`. The plan set itself is complete: every step is written, each cites the contract rather than
restating it, and each carries its own acceptance checklist and verification commands.
