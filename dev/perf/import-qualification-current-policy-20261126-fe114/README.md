# Current-policy qualification for four missing cells

This qualification-only change stacks on [#950](https://github.com/ManabiIO/manabitan/pull/950), exact source `439a1c9b6d40452061cda094b0727005553c1d1d`. That PR already corrects the benchmark receipt inference for the importer's one-GiB native image projection gate. No extension source, compression setting, parser setting, persisted format, or runtime PR workflow is changed here.

## Frozen acquisition plan

Baseline: `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`.

| Candidate                                                                      | Frozen source                              | New dictionary cells |
| ------------------------------------------------------------------------------ | ------------------------------------------ | -------------------- |
| [#938: Zstd startup overlap](https://github.com/ManabiIO/manabitan/pull/938)   | `c6835c1bc1ddcc07ac5c9bc10ac0558e1f3cc7de` | Jitendex, VNDB       |
| [#948: glossary type literals](https://github.com/ManabiIO/manabitan/pull/948) | `e197c714ac7738097b6cf005f178b075eaf2ab80` | Jitendex, VNDB       |

The separate branch-scoped workflow has exactly these four cells. Each uses the existing qualifier's six alternating adjacent A/B pairs, two identical-code control pairs, four warmups, separate exhaustive media verification, and four separate process-memory observations. It does not reacquire JMdict. Evidence-only and test-only follow-ups do not trigger another acquisition. Measurement-code changes do.

The original #948 screen is [run 45862352124](https://github.com/ManabiIO/manabitan/actions/runs/45862352124). Its jobs were still pending when this repair was prepared; no failure or completed JMdict result is inferred for that pending run.

## Two explicit measurement contracts

`--measurement-overlay native-image-policy-439a1c9b` permits only `dev/perf/benchmark-support.js` from exact #950 source. The reviewed original SHA-256 is `08463998f6e6b4590c65e5c36c9e162bd28d770fdd1e51e869a75ccbec1e8132`; the replacement SHA-256 is `eacc5eeee1aaeb13ea44867f0d2ff168f5e723392652ebfee6dfc717ba3865d0`. Arbitrary files, commits, or edited replacement bytes are rejected.

Both runtime revisions build clean product packages first. The same measurement-only file then replaces the verified original in both worktrees. The identity ledger records original and effective hashes. Before and after every timed, control, exhaustive-media, and memory observation, the qualifier checks exact Git status, deliberate dirty paths, their hashes, and the unchanged package digest. Memory observations additionally permit only the existing marker overlay. Marker cleanup restores the support-only state; final cleanup restores clean sources. Unexpected edits fail without being overwritten.

`--storage-policy baseline-0143e959-vndb-sah-37` is bound to the full baseline SHA above and requires VNDB's active SAH allocation to be **exactly 151,552 bytes, or 37 pages**. It still requires eight SAH files, seven empty 4,096-byte files, the complete recognized product inventory, and exact total/per-file equality between observations. The same policy identity participates in every A/B/control/media/memory semantic receipt. The default historical 129–131-page contract is unchanged. No storage tolerance or memory threshold is widened.

## Retained original attempts

`original-pr938-acquisitions.tar.gz` contains all 232 original report, log, identity, plan, timing, canonical-receipt, and memory files from [run 45861596123](https://github.com/ManabiIO/manabitan/actions/runs/45861596123), with unmodified file bytes. The deterministic archive is 1,571,241 bytes; SHA-256 is `8e848b91a689b4d8f895d5ddd15e80fd2e3049350ac07c7c76cb395a5a455a28`. The manifest gives every member hash and the original source/run/job/artifact identities. Downloaded product packages are excluded; their package/member hashes remain in the source identities, and hosted artifacts retain the binaries.

| Original cell | Artifact      | Retained interpretation                                                                                                                                                                                                                                       |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JMdict        | `15138564828` | Correctness, exhaustive media, and separate memory passed. Six pairs gave a −1.053% median paired change, with a descriptive interval of −1.790% to +2.042%; identical-code controls ranged from −4.806% to +4.682%. No demonstrated complete-import speedup. |
| Jitendex      | `15138149888` | Invalid first acquisition. The first baseline warmup imported successfully, then the old receipt helper incorrectly inferred native projection at 512 MiB. No candidate observations and no native summary were produced.                                     |
| VNDB          | `15139650925` | Invalid first acquisition. The first baseline warmup imported successfully, then the old storage contract rejected the baseline's 37-page active allocation. No candidate observations were produced.                                                         |

These failed attempts remain failed and are excluded from every timing cohort. Offline revalidation diagnoses their stale gates; it does not synthesize a replacement completed cohort, add a timing sample, or establish candidate performance.

## Validation

```sh
python -m unittest discover -s dev/perf/import-memory-20261125-a7f7 -p 'test_qualification*.py'
python dev/perf/import-qualification-current-policy-20261126-fe114/revalidate-original-baselines.py
```

The revalidator checks all archived bytes against the manifest, executes the exact #950 native extractor on both original raw baseline reports, validates the original VNDB summary/source/package binding, and applies the current exact semantic/storage contract. It rejects consistent 36-page and 38-page counterexamples and confirms the historical contract still rejects 37 pages. `baseline-revalidation.json` is a deterministic diagnostic receipt; the original inputs remain unchanged in the archive.

Local offline validation used Node 24.22.3, which is supported by the repository. Hosted browser acquisition remains pinned by the existing setup to Node 22.22.0 and the unchanged locked browser/fixture tooling. No new browser acquisition is represented by the offline receipt.
