# Temporary hosted JMdict study

This diagnostic is restricted to pushes on `perf/jmdict-hosted-study-20261119`. It runs on one Ubuntu 24.04 job with read-only repository permissions and a 40-minute timeout. It does not publish packages, create a PR, or merge changes.

## Frozen inputs

The product baseline is the full commit `d829f5b6e6a75ee8859d38d537d224ec33c4930e`. `catalog.json` binds the baseline, package/fixture locks, frozen v1/v3 runner bytes, analysis helpers and three native files for each independent candidate:

1. Numeric span reuse.
2. Int32 decimal cutoff.
3. Key escape hints from parsing.
4. Previous-key reuse bounded to 32 raw body bytes.

Each overlay contains only `term-bank-parser.c`, the native artifact manifest, and the pinned `term-bank-parser.wasm`. All other product files come from the baseline. Native modules are validated against the complete native source identity and their manifest hashes. No compiler from the hosted runner is used.

The two baseline control worktrees and four candidate worktrees share the same installed dependencies and locked archive cache. All receive identical frozen measurement harness copies. Generated libraries are copied first, followed by `copyDictionaryWasm` for the arm's validated native modules. This order prevents a copied baseline module from replacing a candidate accidentally.

The existing setup action pins Node 22.22.0 for browser qualification and installs the repository's exact lockfile. Matching Playwright Chromium is installed once. The existing fixture helper prepares its full locked cache because the existing browser harness verifies that cache, but **only JMdict is parsed/imported for measurements**.

All six Chromium packages are built before any component or browser observation. Package hashes and per-entry hashes are retained. The two baseline packages must have identical entry bytes; candidate package differences are restricted to the parser WASM and its C source if that source is packaged.

## Fixed plan on one host

| Phase | Control | Each of four candidates |
| --- | --- | --- |
| v1 resident parser + complete lookup | 6 A/A pairs, separate unchanged roots | 8 alternating A/B pairs |
| v3 adjacent corresponding groups | 6 A/A pairs; 6 warmup pairs; 5 measured passes | 8 pairs; 6 warmup pairs; 5 measured passes |
| Chromium JMdict import | Baseline observations within every candidate crossover | `A1 B1 B2 A2 B3 A3 A4 B4`, one fresh import per observation |

V1 runs from the selected B worktree because its script root defines that arm; `--baseline-root` selects A. V3 explicitly selects both roots. Both use `--flags '{}'` and the same pinned JMdict archive. The unmodified frozen runners retain their respective timing/oracle boundaries. V3 results also pass through the independent group/order/count/identity validator. All raw samples remain, with no exclusions or GC subtraction.

Browser observations invoke the existing `import-benchmark.js jmdict --runs 1 --no-build --build-target chrome`. They use production defaults, the locked fixture, strict runtime checks and a new browser process/profile for each invocation. They do not request traces, screenshots, phase profiling or process sampling. The existing benchmark harness sanitizes inherited experiment controls. Package and fixture identity are verified for every successful report; source/native/package identities are checked around every observation.

## Retention and failures

Preparation records a baseline source archive, exact diagnostic sources, native snapshots, package files/hashes, commands, build logs and host metadata. Component output is uploaded immediately after that phase so it can be reviewed while browser work continues. A final artifact retains the complete workspace evidence, including all HTML/JSON browser reports and failures.

Each command writes its identity before launch and records its exit status, timeout and host metadata. Phase-driver stdout/stderr are also retained, covering startup/import failures before the structured status writer can run. Failed observations stay in the indexes and do not get silently replaced or excluded. A component failure does not suppress the remaining comparisons or browser observations. Commands run in their own process groups; timeout/error cleanup stops their descendants before later timing starts.

An internal deadline 37 minutes after evidence initialization leaves time for final upload under the 40-minute job timeout. If the fixed plan exceeds that deadline, later commands are explicitly recorded as not started; partial output is preserved and the job fails. Upload steps use `always()`.

## Review and invocation

The staged branch is intended for diagnostic review before its first push. No local build or timing is needed to review it. On the hosted branch, the workflow invokes these sequential phases:

```sh
node dev/perf/hosted-jmdict-study/run.mjs prepare
node dev/perf/hosted-jmdict-study/run.mjs components
node dev/perf/hosted-jmdict-study/run.mjs browser
```

Artifacts are named `jmdict-hosted-components-<run>-<attempt>` and `jmdict-hosted-full-<run>-<attempt>`, with 14-day retention. The complete plan is diagnostic evidence; candidate selection still requires assessing the controls, correctness and browser results together.
