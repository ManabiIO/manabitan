# Import qualification — 25 September 2026

## Decision

Promote the existing generic shared-span compression default in PR #291. Do not enable the other screened switches or introduce an unmeasured combination.

Measured product baseline: `a3925549826671bc1026035f43f0fde2e407077c`.
Default-on candidate: `ba0a8bbd14f93f3b3c1ef7485117dc5d73435684`.
Product PR: https://github.com/ManabiIO/manabitan/pull/291

The product diff is four files: one default switch and its documentation, plus three test files preserving legacy-codec comparisons, explicit opt-out, frozen snapshots and reset behavior. No new codec, storage format, dependency, cache, worker count, compression level or dictionary-specific heuristic is added. Research workflows are not part of the product PR.

## Independent complete-import confirmation

Twelve pairs per candidate per dictionary, alternating AB/BA. Fixed excluded warmups, bracketing A/A controls, fresh Chromium profiles, pinned archives, OPFS storage, complete row counts and twelve persisted-content probes per successful observation. Timings include the complete import through UI completion, not merely encoding. Download, build and content probes are outside the clock. No tracing, process sampling, screenshots or expensive bulk-add byte metrics during timing. No measured observations are trimmed or retried to replace an unfavorable outcome; no cross-host pooling.

Negative is faster. The primary statistic is the median of per-pair percentage changes, not the ratio of arm medians.

| Dictionary | Off median ms | On median ms | Median paired change | Faster pairs | Equal-work change |
| --- | ---: | ---: | ---: | ---: | ---: |
| WTY English | 7671.65 | 6478.85 | -15.66% | 12/12 | -15.80% |
| JMnedict | 930.95 | 896.55 | -4.81% | 10/12 | -4.08% |
| JMdict | 1346.85 | 1370.35 | +1.65% | 3/12 | +1.51% |
| Jitendex | 2127.60 | 2150.70 | +1.21% | 4/12 | +1.02% |

WTY's A/A medians before/between/after the two candidate schedules were -1.22%, +0.05%, +0.25%. All six generic-compression ABBA block totals improved: -16.18%, -17.86%, -14.69%, -14.98%, -13.44%, -17.55%.

JMdict and Jitendex already use their trained native compression route; generic admission does not replace it. Their small observed slowdowns are retained as negative controls, not omitted. Other runner controls were noisier: JMdict +0.21%/+0.16%/+3.12%; Jitendex -9.65%/-6.16%/-0.61%; JMnedict +50.47%/+2.75%/+4.89%. The first JMnedict control includes a +100.50% observation, retained rather than trimmed. These results are not an all-dictionary speedup or a formal significance claim.

WTY contains 1,643,040 rows and 1,107,979,196 uncompressed source bytes. Its reported content packing median falls from 1451.75 ms to 22.20 ms; the JavaScript envelope stage falls from 216.90 ms to zero. Native compression includes some moved work, and overlapping phase times must not be added as wall-clock costs.

## Correctness, storage and memory

Baseline and exact default-on candidate each pass 7,317 unit tests with the same 46 existing skips, 27 options tests, all four TypeScript projects, changed-file ESLint and build-plan checks. Real-codec tests compare legacy packing and native spans, frame/checksum bytes, persisted content, non-zero source views, source consumption, invalid spans and operation lifetime.

The default-on candidate passes all 83 phases of the Chromium extension lifecycle, including staged-update crash recovery, concurrent lookup, restart persistence, multi-file import, hover stress and deletion. The report records OPFS mode and the promoted flag as true.

A separate Playwright Anki save-button-enabled test fails on both candidate and unchanged baseline, with the same 8/9 outcome including setup and teardown. Both failures are retained; assertions were not weakened. This is distinct from the passing import lifecycle.

Across every generic-compression confirmation pair, source/encoded bytes, deduplication counts, content-write bytes, lookup-index-write bytes and parser Wasm heap highwater match. WTY content writes remain 133,821,475 bytes; its parser heap highwater remains 173,735,936 bytes. Parser heap is not whole-browser peak memory or the compression worker's full live allocation. Twelve content probes are sampled, not exhaustive equality of every corpus entry. No whole-browser memory improvement or Safari/Firefox performance gain is claimed.

Develop advanced separately to `76362775484661b3cd8b9d2c84b228802c023a76` through auxiliary-bank validation #283. PR #291 applies cleanly; its combined test merge is `2e39b669dfee906bc7608bc546ec76ef863451c0`. Normal PR CI and static-web acceptance are green. Those integration checks do not turn the earlier pinned timings into measurements of the newer merge result. No merge was performed for this work.

## Rejected or held candidates

Libdeflate is a no-op switch in this source: both branches call the same inflater. Fast glossary normalization receives the flag but processes zero qualifying rows in these fixtures. Their apparent timing changes are not optimization proof. Bank spans execute but have no compelling full-import win.

Validated glossary reuse improves Jitendex in the six-pair screen (-5.19%, 6/6) and independent confirmation (-5.95%, 12/12), but confirmation regresses JMnedict (+2.67%, 4/12 faster), and WTY is flat (-0.10%, 6/12). It stays opt-in. Local JS hash variants are rejected because large-payload wins come with substantial small-payload regressions. Native controls include all-unique, long-common-prefix, adjacent-repeat and structured inputs with matching output digests; component timings are not presented as full-import gains.

## Retained source and runs

- Initial flag screen: https://github.com/ManabiIO/manabitan/actions/runs/36156681269
- Active-path screen: https://github.com/ManabiIO/manabitan/actions/runs/36158006868
- Three-dictionary confirmation and retained WTY warmup failure: https://github.com/ManabiIO/manabitan/actions/runs/36158942267
- Complete WTY confirmation: https://github.com/ManabiIO/manabitan/actions/runs/36159551692
- Baseline/default-on full checks: https://github.com/ManabiIO/manabitan/actions/runs/36159458951
- Default-on lifecycle and separate integration result: https://github.com/ManabiIO/manabitan/actions/runs/36160416117
- Unchanged-baseline Anki control: https://github.com/ManabiIO/manabitan/actions/runs/36160792743
- Normal PR CI: https://github.com/ManabiIO/manabitan/actions/runs/36160704475
- Static-web acceptance: https://github.com/ManabiIO/manabitan/actions/runs/36160704316

There are 492 successful complete timing observations including excluded warmups, plus one separately retained failed WTY warmup. The first WTY import completed but its off-clock probe exceeded 32 MiB stdout; no candidate or measured pair existed. The replacement run raises only the two probe caps to 256 MiB and preserves the fixed schedule and product source. The first Playwright setup also failed because the manifest had not been built; the corrected run adds the standard build prerequisite. Neither failure is hidden.

WTY archive pin: release `21b1b22cd655d7936d62b127e6404fbb8a88c7c3`, revision `2026.08.29`, 106,918,350 bytes, SHA-256 `b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5`. Other fixtures use the committed dictionary lock. The research workflows retain complete schedules and benchmark-only WTY harness patches.

WTY result artifact: ID `10876500107`, SHA-256 `05fd147191d2c922e58ca23ecfae0b50cea6cda48a394bedc024a58af5c67b27`.
Evidence bundle supplied with this session: `manabitan-import-benchmark-evidence.zip`, SHA-256 `0e03ead0b5b31836ba696e3e46670612be29bbcdb585c8dcae1053a5555941c7`; it contains raw reports, summaries, validation logs, source patch, component evidence and a checked summarizer. No source exports or fonts are bundled. Historical September 18 observations are not pooled into these results.

After default promotion, `{}` versus `{"experimentalGenericSpanCompression":true}` is deliberately A/A. Reproduce the original timing on the pinned baseline, or use explicit `false` on the promoted source and label the reversed comparison correctly.
