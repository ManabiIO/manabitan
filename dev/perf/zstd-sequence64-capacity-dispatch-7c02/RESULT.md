# Design B: correctness passed; performance remains unqualified

The capacity-dispatched sequence64 candidate passed the complete correctness qualification and exact-product code inspection. Its one authorized component timing process was killed with exit 137 before any timing observation was recorded. The saved result contains **0 of 32 observations**. This study establishes neither a speed improvement nor a regression, and it supports no candidate memory-regression claim. No repeat, replacement observation, threshold change, integration, or PR followed this acquisition.

## Mechanism and census

For a nonempty sequence stream, the new path is admitted only when `capacity >= 8 && n <= (capacity - 8) / 12`. The bound permits unconditional 64-bit flush stores and direct pointer advances. Every nonadmitted call enters the verbatim original 32-bit implementation before any output write. The change is private to the sequence encoder; generic bit streams, FSE/HUF, decoding, and count64 are unchanged.

The separate baseline-only census covered all 103 reconstructed JMdict content blocks: all **772 calls and 2,574,603 sequences** satisfied the bound. This is eligibility evidence, not a timing result. The corpus preserves 12 append groups, 362,032 globally unique content entries, and 100,300,626 canonical bytes. It uses the frozen baseline's one-MiB whole-entry packing, group-local context assignment, and independently verified per-context output-capacity map.

## Completed correctness qualification

The exact production B1 artifact passed the following fresh checks alongside immutable P/A0/C0 controls:

- All 337 primitive and 340 sequence fixtures, including threshold capacities, eight alignments, physical memory-end placement, actual branch witnesses, and full initialized-destination equality on the original32 fallback.
- All 22 unsigned admission-predicate cases and two invalid-dispatch witness cases; the probe receipt records 818,274 checks.
- All 55 product API capacity cases, recording 163,772 checks, and all 79 synthetic/dictionary-switch frame cases.
- All 103 canonical frames per arm, exact successful bytes and envelopes, cross-decoding, and final source/input/artifact identities. Every arm produced 12,324,804 compressed bytes; all qualification failure arrays are empty.

The candidate was built with the exact production command, without a symbol-map or route-witness product flag. Only P/A0/C0 production files were reused from the independently qualified prior build. The rejected checked64 B0 artifact was never executed by this Design B study.

## Exact emitted-code result

The product B1 module is **435,074 bytes**, versus 433,631 bytes for P/A0/C0: **+1,443 bytes (+0.3328%)**. Direct binary comparison shows that the entire growth is within the existing sequence-emitter function 106, whose body grows from 1,705 to 3,148 bytes. The other 199 defined function bodies and every non-code section are byte-identical.

The admitted loop has four static `i64.store` sites, direct pointer additions, and no calls, destination-room checks, short-store selection, or pointer clamp. Bit-width scheduling and long-offset branches remain. The original32 fallback loop retains six static `i32.store` sites. These are static code properties, not executed instruction counts or a speed prediction.

## Incomplete timing acquisition and precise limit

The unchanged prospective protocol specified eight counterbalanced P/A/B/C blocks, two excluded warmups per arm, and 32 observations. Each B/P, B/A, and B/C comparison required at least 5% median CPU and wall improvement, at least seven wins in eight pairs for both metrics, negative equal-work aggregate changes, and at least 10 ms median CPU saving per corpus. Identical-code control drift had to remain within 5%.

The exact frozen command was launched once and returned exit 137. The partial JSON remains `status: started`, with no recorded observations, metrics, or gates; the log is empty. **The exact termination phase is unknown.** The initial report is saved before setup, while oracle and warmup state is not persisted before the first observation. Earlier shorthand describing a “setup-time” kill is therefore superseded by “killed before any timing observation was recorded.” The original partial files and termination receipt remain unchanged. Absence of saved oracle data does not prove that no oracle or warmup work occurred.

This was a sequential codec component using four contexts within one WASM instance per arm. It excludes browser worker concurrency and separate heaps, transport, gathering, allocation, storage, and the complete importer. Even a successful component screen would require separate whole-import qualification.

## Immutable evidence

Paths below are relative to the containing `zstd-sequence64` directory.

| Evidence | Path | SHA-256 |
|---|---|---|
| Passed correctness artifact | `design-b-result/manifest.json` | `60fe61a338106d9fbb529fc2cd5322887d19c5400f0db0b9e4cae9146750cd98` |
| Exact-product code review | `design-b-codegen/structural-review.json` | `dc393a1c6d64a8a93970f8b3a422e7504055a534b4b1c3a7aafcd6ab8b0afc18` |
| Independent timing sources | `design-b-timing-prototype/timing-source-files.json` | `37ea35dd153f1e281d1eb8932fb20fcc640df3deb63b0bbda7e35551cd9a4e2c` |
| Prospective execution freeze | `design-b-execution-freeze.json` | `61d55a8e1007d4ed67205c1db2b96322d89d485c2778596f3245538f737bd9dc` |
| Original partial result | `design-b-component-screen.json` | `dcfab744040a3f66619e20ef3757103aca96e1b9d819d97d6049042b2cd6dbf7` |
| Original empty log | `design-b-component-screen.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Original termination receipt | `design-b-component-termination.json` | `5b53396035ddc3f5b310407493be68689f4aca17432d0877c2d13042f9b6213c` |

The independent reviews under `production-workload-audit` separately bind the final timer/artifacts and verify the incomplete saved-result classification. The rejected Design A cohort, unexecuted old 31-block screen, census, successful correctness artifacts, and this incomplete Design B acquisition remain distinct.
