# Follow-up source screens for import optimization

This bundle contains two bounded source reviews. No product code, timing cohort, profiler acquisition, or observed browser-admission claim was added.

## Findings

**The normal browser import sink serializes registrations.** The parser awaits its ordered callback, the importer awaits the public database sink, and that sink awaits a content-completion promise whose finalizer removes the in-flight batch. Its failure path also drains and releases. Parallel parser work and concurrent content/record writes within one call therefore do not by themselves leave a previous batch active when the next ordered sink begins. An independent review confirmed the importer/parser await chain. This supports the empty-batch admission expectation for #830; complete fast-path browser admission and whole-import gain remain unmeasured.

**The existing CRC candidates do not justify another JMdict experiment now.** #910's final shipped runtime is byte-identical to its already measured product commit; the intervening change is a test annotation. Its broader final-source study remains HOLD on the historical 7d base. The separately unmeasured polynomial-power cache has zero dynamic coverage in the recorded current policy-3 JMdict groups: all 12 groups fail the deferred-route compression-ratio threshold, and every deferred scan/reuse counter is zero. This conclusion does not infer a new current-base timing result from the old screen or rule out every possible other corpus.

The original 70.306 ms CRC number is described only as a **descriptive preceding-delta sampled-stack weight**, following the immutable [sampling interpretation correction](https://github.com/ManabiIO/manabitan/blob/cf43df9f197b729085950dc9f2f7b3ee7a773e35/builds/perf/20261128-browser-jmdict-profile-83b3/SAMPLING-NOTE.md). It is not direct CPU time or removable import latency.

## Download and review

[Complete evidence archive](evidence.tar.gz) · [File manifest and source identities](MANIFEST.json.txt)

The archive extracts into these two directories:

- `crc-screen/`: the complete review, all twelve existing group counters and source hashes, original #664/#910 PR metadata and diffs, and the exact #910 measured-to-final comparison.
- `production-serialization/`: the await/release proof with immutable source links and the exact reviewed source hashes.

Relative links inside the CRC review resolve after extraction. Every archive member is listed by byte length, SHA-256, and Git blob identity in the manifest. The existing compressed diagnostic and additive sampling note remain in their prior durable evidence; they were not rerun or duplicated here. These notes do not change the existing runtime qualification or failure history.
