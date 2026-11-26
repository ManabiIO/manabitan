# Superseded UTF-8 copy experiment

PR [#932](https://github.com/ManabiIO/manabitan/pull/932) is superseded by [#941](https://github.com/ManabiIO/manabitan/pull/941). This directory retains the completed correctness evidence for #932; it does not qualify #941.

Independent source review found that #941 preserves the same UTF-8 acceptance and fallback semantics while replacing the dynamic continuation loops with direct two-, three-, and four-byte cases. Its native and fused tests cover a broader malformed-byte matrix. The few extra fixture variants in #932 do not justify a second runtime change.

## Frozen sources

- Baseline develop commit: `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`.
- Tested candidate local commit: `62867edc10f26c4af5fa061677c4fcad5302d9d3`.
- Published candidate runtime commit: `6ddfacf26fd2d5069192ac279bcc61f81b7832ee`.
- Candidate runtime tree, identical locally and remotely: `012c871d3b428994050a681ec7835515a0e46095`.
- Baseline parser SHA-256: `b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa`.
- Candidate parser SHA-256: `ce7b3a4591f60fa168950df163bb70e9e2482dde7833dce62857baa052c0eefe`.
- Runner SHA-256: `3d1a1fabd0b7827f279ec7d39d88c96ab830bc214a40cdbdee35773892a4119a`.
- Locked JMdict archive SHA-256: `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`.

The parser was rebuilt with pinned Clang/LLD 21.1.8. Its size changed from 67,550 to 67,490 bytes. The canonical scanner was unchanged. The archive commit adds evidence only; the unpublished local test-style fix is excluded.

## Completed JMdict comparison

Both child processes exited successfully using Node v24.22.3 and the unchanged `dev/perf/import-lookup-screen.js`. Each processed the entire locked JMdict corpus with default feature flags, glossary validation enabled, seven banks per component group, two warmups, and one output-verification pass.

| Result                                  |   Baseline |  Candidate |
| --------------------------------------- | ---------: | ---------: |
| Rows                                    |    528,299 |    528,299 |
| Prepared lookup-index bytes             | 19,491,860 | 19,491,860 |
| Maximum reported parser WASM heap bytes | 61,603,840 | 61,603,840 |

Both complete output digests are `8f1001b400c6f34e67ae6981cf4532c0dbd7a7b8bc98a10086da224289dbfff1`. The digest covers prepared lookup bytes, interned strings and indexes, reading-equality flags, scores, sequences, per-row content, and content metadata. Archive, lockfile, and runner identities also match. The runner checks source hashes before and after execution.

**All recorded timing and process-memory observations are exploratory and unqualified because the host was heavily contended. No import-speed or memory improvement is claimed.** This component comparison does not independently exercise persisted OPFS data or browser restart behavior. No further Jitendex comparison was run after the duplicate was identified.

The exact commands below ran from `/workspace/scratch/4a0c621eaaa8/manabitan-jmdict`:

```sh
timeout 300 node --expose-gc dev/perf/import-lookup-screen.js jmdict --child --flags '{}' \
  --cache-dir /workspace/scratch/b4b304adc609/manabitan/builds/e2e-dictionary-cache \
  --source-root /workspace/scratch/4a0c621eaaa8/manabitan \
  > /workspace/scratch/4a0c621eaaa8/utf8-corpus-20261126/jmdict-baseline.json \
  2> /workspace/scratch/4a0c621eaaa8/utf8-corpus-20261126/jmdict-baseline.log

timeout 300 node --expose-gc dev/perf/import-lookup-screen.js jmdict --child --flags '{}' \
  --cache-dir /workspace/scratch/b4b304adc609/manabitan/builds/e2e-dictionary-cache \
  --source-root /workspace/scratch/4a0c621eaaa8/manabitan-jmdict \
  > /workspace/scratch/4a0c621eaaa8/utf8-corpus-20261126/jmdict-candidate.json \
  2> /workspace/scratch/4a0c621eaaa8/utf8-corpus-20261126/jmdict-candidate.log
```

## Validation status at the original runtime head

- Added 30 regressions passed. The last local focused run had 140 passes and two unchanged tests timing out under load; those local timeouts are retained as failures and were not tuned away.
- Hosted [main CI run](https://github.com/ManabiIO/manabitan/actions/runs/45861056454) passed full unit tests, options tests, the pinned WASM rebuild and extension build, all four TypeScript jobs, and Chromium and Firefox full-extension E2E.
- Hosted [restart and interruption recovery](https://github.com/ManabiIO/manabitan/actions/runs/45861056653) passed.
- The JavaScript job failed on 16 `@stylistic/array-element-newline` errors in the new test-case list. That style failure is preserved and is **not fixed or reported as passing** in this archived candidate.

These CI outcomes apply to runtime head `6ddfacf26fd2d5069192ac279bcc61f81b7832ee`, before the evidence-only commit. They do not establish the results of any later commit or #941.

## Archive contents

`jmdict-correctness.tar.gz` contains the two original JSON reports, their original empty stderr logs, the original JavaScript failure log, a compact CI job snapshot, source identities, and the local focused-test log. Reports preserve their original timing fields without interpreting them. Extract with `tar -xzf jmdict-correctness.tar.gz`.
