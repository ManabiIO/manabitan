# Independent VNDB integration audit

This evidence reviews existing PR #875. No competing projector or duplicate published implementation was created. Browser timing and memory acquisition are separate from the local correctness and package checks below.

## Source identity and integration

- Baseline: `7d1643e6147a10cb2165e9744cf0e63b59e46632`.
- Independently reviewed merge: `98731a11d81161c929f7822516610e3018aa9dab`, with the baseline and original #875 head `fb71a03f4611bcfa71e135693bebd1fe778153bf` as parents.
- Reviewed tree: `093a0be94fcf336ab5a0113b80fae7481855935a`.
- Hosted memory candidate: `7a8b25a44a3fe165107ed816377cc72bb0fac67d`, with that same reviewed tree.

An independent merge resolution and LLVM 21.1.8 rebuild matched every runtime/native-artifact file in the existing integration. The fourth `copyWasmBackedColumnChunk` argument still controls lookup routes; the fifth supplies the bounded live source. Current borrowed-content ownership remains intact. The original projector has no new escaping source reference or allocation arena. See [runtime comparison](runtime-comparison.json.txt) and [review](review.json.txt).

The 67,550-byte parser WASM is SHA-256 `b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa`.

## Complete corpus correctness

[The independent replay](corpus.json.txt) processed all 6,648,310 locked VNDB rows in the production three-worker partition of 170 groups. Every output field, content column, key plan, prepared lookup index and projected media row deeply matched the existing JavaScript collector. Owned prior output remained unchanged after subsequent native memory reuse; source hashes were rechecked after completion.

- Projected rows: 146,725; unique image paths: 146,570.
- Full glossary parses: 146,725 to zero.
- Full glossary decode input: 84,398,732 bytes to 2,391,178 path-token bytes.

These are work counts and correctness results, not complete-import timing or peak-memory measurements. The fixture is 291,705,969 bytes, SHA-256 `da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792`. Node was 22.22.0. The original replay script is retained under `reproduction/` as text; restore its `.mjs` suffix and pass repository root, locked ZIP path and output JSON path.

## Exact Chrome package boundary

[The package comparison](package-comparison.json.txt) finds exactly four changed entries, no additions or removals, and 612 unchanged entries. Both archives contain 551 files and 616 total entries.

```text
js/dictionary/term-bank-wasm-parser-worker.js
js/dictionary/term-bank-wasm-parser.js
js/dictionary/wasm/term-bank-parser.c
lib/term-bank-parser.wasm
```

Baseline: 17,272,721 bytes, SHA-256 `241358ad80c263a0f130f7ce1e4d645389607c54146d400f720bfa0ec2c054f3`. Candidate: 17,275,473 bytes, SHA-256 `61896cfe3d0bc0f664c530195d4d544435a30c865354d62056f6531323424217`. The local increase is 2,752 bytes (0.01593%). Each changed entry matches its corresponding source or pinned native artifact.

An [initial comparison](package-comparison-initial-context.json.txt) retained extra esbuild dependency-path differences caused by the local dependency symlink. Rebuilding with a temporary local hardlink dependency tree removed those differences. No product source or generated output was manually normalized. Archive hashes include build metadata; all 551 file contents of every hosted memory package also match the independently built corresponding arm.

## Current-source memory qualification remains blocked

[The independent memory audit](independent-memory-audit.json.txt) recomputes all 1,504 raw scans and 16 fixed observations from [run 45642179064](https://github.com/ManabiIO/manabitan/actions/runs/45642179064), using the unchanged observer and auditor. Frozen receipt verification also passes for every observation, including source/package identities, marker overlay, fixture, lookup, restart, sampled media and bounded storage receipts. Raw cohort directories are archived separately; they are not duplicated here.

| Dictionary and order | Median PSS change | Median private change | Result                                               |
| -------------------- | ----------------: | --------------------: | ---------------------------------------------------- |
| Jitendex ABBA        |          -2.5578% |              -3.1031% | Pass                                                 |
| Jitendex BAAB        |          +1.8317% |              +2.5668% | Pass                                                 |
| VNDB ABBA            |              null |                  null | A2 covered-scan gap 350.425804 ms                    |
| VNDB BAAB            |              null |                  null | B1 324.494085 ms, A1 258.866332 ms, B2 275.215655 ms |

The fixed maximum covered-scan gap is 250 ms. Both VNDB replications therefore remain unqualified. Only VNDB ABBA pair 1 qualifies: PSS -0.6559%, private -0.8213%. Other VNDB pairs and replication aggregates remain null. No qualified current-source pair exceeds the fixed memory-increase limits. No observation was replaced, no cohort rerun, no threshold changed, and no hosts or stages were pooled. Sampled memory maxima are not exact peaks; memory-instrumented timing is not authoritative.

The [original frozen-base memory study](https://github.com/ManabiIO/manabitan/actions/runs/45471351138) is separate. It includes a valid Jitendex private-memory pair increase of 11.5409% and other coverage failures. Those historical observations remain failed and are not replaced by this current-source study.

## Rejected duplicate-reference filter

[The retained rejected experiment](rejected-media-filter.json.txt) covered every source row using bank-by-bank groups, a different partition from the 170-group production replay. Native parsing already removes most duplicate media work. The proposed extra Set-based filter removed only 616 projected rows and 33,265 cumulative diagnostic/span bytes: 6,579,855 to 6,546,590 bytes, while requiring 146,570 new-path Set insertions (maximum 370 entries per group). Raw-source first-reference diagnostics and term-column parity passed.

The filter was rejected, its tracked changes restored, and no PR was created for it. Its patch and original harness are retained under `reproduction/`; the harness expects `test/perf/projected-media-references-20261125/verify.mjs` in a checkout with that rejected patch. No import speedup is claimed.

## Saved remote status snapshot

[The read-only status receipt](pr875-final-readonly-status.json.txt) records the 2026-11-25 15:40 UTC check. Head `5afd2e97ec2707b150acfde61115aee688547a78` changes only two test files from the frozen candidate. The existing three-dictionary timing run had completed successfully and its VNDB artifact was available; several head CI jobs were still pending. This is a timestamped status snapshot, not an independent audit of timing statistics.

## Local validation limits

The review records 256 passing focused tests, main TypeScript, changed-file typed ESLint, pinned native rebuild/check, generated libraries and all-target dry build. Local test TypeScript did not complete: default and 1,200 MiB attempts exited 137; the 700 MiB attempt reached the V8 heap limit and exited 134. No type diagnostic was emitted. These attempts remain in `logs/`; hosted exact-head type validation is a separate gate.

JSON reports retain their original acquisition paths and hashes. `files.sha256.json.txt` binds the curated files. Reproduction scripts are stored as text to avoid treating historical audit inputs as active repository tooling.
