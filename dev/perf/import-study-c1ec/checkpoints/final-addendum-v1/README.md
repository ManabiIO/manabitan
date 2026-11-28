# Final additive evidence checkpoint

Terminal Chrome run: `46126332612`; CI `success`; independent audit `verified-complete-component-diagnostic-only`.

**Neither native candidate earned advancement or a product PR.** The final Chrome component study completed and passed its correctness checks, but both variants decisively regressed against the baseline. The native-inflate line is stopped: no rerun, full-import advancement, current-develop transplant, or product PR follows from these results.

## Final JMdict Chrome result

The primary metric is the **source inflation/CRC component**, measured on the frozen 9e baseline under pinned Chrome 153.0.8010.12. It is not complete-import elapsed time. A is baseline 9e; B is the direct native writer (b00df9); C adds guarded group-sized input bursts (9e14b530); D is byte-identical to A.

| Comparison | Paired median change | Equal-work change | Faster pairs | Descriptive 95% interval |
| --- | ---: | ---: | ---: | ---: |
| B / A: direct writer versus baseline | +99.258% | +99.824% | 0/6 | +96.723% to +103.494% |
| C / A: group burst versus baseline | +85.475% | +84.438% | 0/6 | +79.556% to +88.280% |
| D / A: identical-code control | −0.113% | −0.113% | 2/2 | −0.149% to −0.076% |

All 22 scheduled fresh-browser observations completed; none was dropped, replaced, or retried. Each observation retained two excluded full warmups and one measured corpus: 12 production groups, 53 banks, and 528,299 rows. Exact source/browser identities, actual native admission, complete semantic projection, the general integrity canary, and the 12-case resource-policy canary all passed. The frozen reader audited every observation, and root independently checked all 12 metric comparisons from its recorded pairs.

C improved inflation relative to B by 7.663% paired median, but B was itself an unmerged, slower candidate. C still regressed by 85.475% against baseline. The separately measured inflation-plus-parse/lookup sums also regressed: B/A +29.315% and C/A +24.615% paired median. These are component sums, not contiguous import elapsed time or memory qualification.

[Completed Chrome run](https://github.com/ManabiIO/manabitan/actions/runs/46126332612) · [Frozen wrapper/source protocol](https://github.com/ManabiIO/manabitan/tree/18661492d92ba99d85a26363d562c996c0fff287)

## Native-export diagnostic also remains held

The separate paired-CJK diagnostic retained all 3 preflights and 36 timed children: 183 full passes and 2,196 captured original export calls. It measured the complete fused WASM export plus a common call/clock boundary, including memory growth; it did not isolate the UTF-8 helper or measure complete parser/import time. The identical control failed its frozen limit: C/A +4.904% paired median and +4.334% equal work. B/A was +9.447% median; B/C was −2.319%. No benefit was qualified, and this mechanism line was stopped without replacement observations or browser promotion.

## Earlier full-import evidence and immutable checkpoints

The earlier full JMdict, Jitendex, and VNDB screens, memory qualification failures and sampling-coverage limits, source variants, exact readers, failed attempts, and prospective decisions remain in the [published prior results](https://github.com/ManabiIO/manabitan/blob/0ab2ff5050dba9b528eefdeffcb4f0eb8c6357b0/dev/perf/import-study-c1ec/checkpoints/postutf8-v2/results.json) and [checkpoint guide](https://github.com/ManabiIO/manabitan/blob/0ab2ff5050dba9b528eefdeffcb4f0eb8c6357b0/dev/perf/import-study-c1ec/checkpoints/postutf8-v2/README.md). Those negative and inconclusive outcomes are unchanged; this component study does not replace them.

The [published progress checkpoint](https://github.com/ManabiIO/manabitan/tree/2079fca6f98a44858a650c69a8b87dfce1427a21/dev/perf/import-study-c1ec/checkpoints/progress-final-addendum-v1) preserved the completed native-export evidence and prospective Chrome inputs while this last run was pending. Its pending state remains accurate at its original cutoff. The final addendum adds the terminal artifact, frozen-reader audit, root review, and stop decision without altering that record.

The final Chrome component study and UTF-8 diagnostics used exact baseline 9e10d3b3. Earlier studies retain their explicitly recorded comparators, including the expanded VNDB comparison against `20c8`. Develop later advanced to dcfc02a0 through PR #972. The static integration assessment and unused conditional advancement map are retained as planning evidence only; no rebase or new performance qualification was performed, and no credit is claimed for #972.


No product PR or current-develop qualification is asserted. All prior negative and inconclusive decisions remain intact.

## Historical preparation snapshot

The longer preparation narrative is preserved at `workspace/profile-evidence/archive-final-addendum-c1ec/historical-preparation-README.md` inside the restored evidence. Its pending statements are historical and have not been rewritten.

The final archive contains the exact terminal reports, all raw observations, frozen source/reader/protocol identities, earlier held results, and separate publication receipts. Archive verification establishes preservation, not a performance or product qualification.

Restore with `python3 restore_addendum.py payload.tar.gz --expected-payload-sha256 HASH_FROM_RECEIPT --prior-payload PRIOR_PAYLOAD --output NEW_DIRECTORY`. The immutable prior payload SHA-256 is `cedf25a9fd678588195f2e28b158a5df9339deb37d6ea0a2bc22e2ce0e8c19c5`; it is required for byte-identical references and is not embedded. Restoration verifies hashes, writes regular files only, and executes no experiments.
