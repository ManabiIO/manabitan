# Import optimization: second iteration

This index connects the production changes, immutable source identities, raw observations and independent verification from the second import-optimization iteration. The browser studies use locked JMdict, Jitendex and VNDB archives, Node 22.22.0 and Chromium 153.0.8010.12. They cover Linux Chromium; they do not establish results for every device or archive version.

## Production changes

| Pull request | Change | Evidence and scope |
|---|---|---|
| [#809](https://github.com/ManabiIO/manabitan/pull/809) | Validate one span per consecutive run of identical canonical content references | Exact record/lookup parity across 7,610,700 native rows. VNDB validation-only median change −87.89%; isolated whole-import effects are small. |
| [#810 — draft](https://github.com/ManabiIO/manabitan/pull/810) | Give compression workers independently owned shared content, avoiding another packing copy | Final Jitendex whole-import median paired change −14.56%, 16/16 pairs faster. Current runtime bytes equal the measured source. The final memory study found a material increase; this PR remains a draft for the time/memory tradeoff. |
| [#811](https://github.com/ManabiIO/manabitan/pull/811) | Pool diagnostic keys and decode them only when producing a media error | VNDB successful-path diagnostic decodes fall from 270,731 to zero; materialization-only median change −47.14%. Every real media payload and index entry matched. |

PRs #810 and #811 are stacked on [#801](https://github.com/ManabiIO/manabitan/pull/801), the earlier parser/deferred-media allocation improvement. PR #809 targets develop independently. [#803](https://github.com/ManabiIO/manabitan/pull/803) provides optional pinned VNDB benchmark support. These branches remain separate reviewable changes.

[production-provenance.json](production-provenance.json) records current PR heads, measured source revisions, exact runtime hashes, CI runs and the tested combined tree. Test-only follow-ups did not change measured runtime files. All three current heads passed their normal CI checks. The combined tree passed 782 focused tests in 21 files and the all-target build check.

## Combined whole-import results, including draft #810

The frozen combination of #809, #810 and #811 is commit `62891eb93d64877a404c9fc8025e0e051f6b5cfb`, tree `0fd0a2a237b66eb95061d3072d07d2c432abe1a5`. Its baseline is #801 at `1e235059a4c05c2509e8757fccba43a2d60222df`. Only the five expected packaged runtime files differ.

| Dictionary | Median paired import-time change | Faster pairs | Interpretation |
|---|---:|---:|---|
| JMdict | +0.87% | 6/16 | No demonstrated timing improvement; within observed control variation |
| Jitendex | −13.21% | 16/16 | Consistent improvement in both fixed replications |
| VNDB | −4.08% | 15/16 | Observed improvement; effect overlaps the A/A control range |

Negative means faster. Values are medians of 16 individual paired percentage changes, not percentages calculated from aggregate medians. Each corpus has two independent fresh-runner replications, each with two warmups, two A/A control pairs before, eight alternating AB/BA pairs and two A/A pairs after. No observation was removed for its timing. The A/A ranges were JMdict −15.39% to +3.70%, Jitendex −3.38% to +1.50%, and VNDB −6.91% to +4.71%. These small fixed studies do not establish universal speedups or exact confidence bounds.

The timed boundary runs from browser file-input change through post-UI import completion. Readback and restart occur afterward. All six combined jobs passed. Independent audit verified 156 observations, 312 before/after states, 3,744 derived physical counters and 5,928 physical rows. Complete public exact-lookup responses for 12 source-derived terms match across arms and restart, with no empty or degraded result. This is sampled semantic browser readback, not exhaustive lookup of every imported term.

## Why the readback guard changed

Owned shared content enables the existing initial reservation path for Jitendex, changing where physical references are stored. The original guard hashed those offsets and raw encoded previews. A corrective guard also rejected a count derived from the previews. Both failed campaigns remain failed in their original evidence.

The final guard independently recomputes every preview counter, permits only the explained physical-reference differences, requires stable physical results within each package across restart, and compares complete sampled public lookup responses across packages. The exact final differences are 12 offsets, 12 raw previews and one correctly derived preview count; all other physical fields match. Separate real-codec checks matched all 4,534 distinct spans from 5,448 rows in three pinned Jitendex banks (1, 110 and 218), plus their complete compressed blocks, after source overwrite and cache invalidation. No runtime changes were made to obtain the corrected qualification.

## Evidence packages

- [Components](components/README.md): original phase measurements, full native record/lookup equality, all-image parity, retained-memory snapshots, rejected candidates and combined-test receipts. This package was frozen before final browser qualification; its pending-status statements describe that earlier snapshot.
- [Original browser campaign](original-browser/README.md): all 24 cells, 624 timing observations, original failures, source/package identities and insufficient original memory coverage.
- [Corrective and final readback](corrective-readback/README.md): both separate campaigns, all 208 observations, complete semantic responses, physical-layout audit and independent arithmetic.
- [Combined browser campaign](combined/README.md): all six combined cells and their raw observations, complete readback and controls.
- [First process-tree memory campaign](memory-tree/README.md): every original result, including 13 unqualified observations caused by the conservative exited-process rule.
- [Final memory observer campaign](memory-zombies/README.md): separately frozen, narrowly defined treatment of confirmed exited single-thread zombies and all new fixed observations.

Every package includes byte identities and offline verification. Compact archives preserve original member bytes. Acquisition receipts retain original Actions ZIP digests, sizes and complete member inventories; the original ZIP containers are not duplicated. XZ transport variants retain the source package identity and identical uncompressed TAR hash. Verifiers run no imports and require no browser or fixture downloads.

## Memory result

The final, separately frozen observer campaign is run [45116158450](https://github.com/ManabiIO/manabitan/actions/runs/45116158450), harness `00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9`. It compares #810 against #801 without the other two changes. All 24 imports preserve complete sampled public lookup results across restart. Twenty-two memory observations qualify; two JMdict baseline observations remain unqualified because a zombie thread-group leader still had a live sibling thread. Those observations retain null maxima, and the failed job produces no comparative pairs.

The qualification rule was frozen before the new data: only same-identity, single-thread zombies confirmed at both inventory boundaries, with absent executable links in both snapshots and an intervening ESRCH smaps read, may be separated from live address spaces. A real single-thread zombie witness passes, while a real two-thread zombie-leader witness remains rejected. Every exclusion and every other failed read is retained. Earlier memory campaigns remain separate and are not reclassified.

**The shared-content candidate increases sampled memory.** All four qualified Jitendex pairs increase sampled maximum process-tree PSS by **8.16% to 11.11%** and private memory by **10.15% to 13.81%**. VNDB PSS changes range from **−0.54% to +5.67%**, with three of four pairs higher. The two qualified JMdict pairs are **+1.56% and +2.58%**; the other replication remains unqualified.

These are non-atomic maxima over a startup/import/readback/restart window, not exact import-only peaks. They cannot establish universal memory bounds or memory nonregression. The observed increase is material, so #810 remains a draft for review of the time/memory tradeoff. PRs #809 and #811 remain ready for review; #811 still depends on #801. The faster combined timings above include that draft candidate and should not be attributed to only the ready changes.

[The pinned ownership/lifetime source review](ownership-lifetime-review.md) found no explicit permanent source registry leak. It distinguishes actual group-count admission from diagnostic byte counters and records possible lifetime/concurrency explanations without claiming a measured cause. No additional runtime experiment was performed.

## Rejected experiment

The native CRC word-loop experiment at `930083af581bd4d8fe8dc42fe7e443e57666f8f9` remains a research branch. Its whole-import results were small, mixed and overlapped baseline controls across all three corpora. It was not promoted to a production PR. Both local screens and all hosted observations remain available; no performance-dependent observation filtering was used.
