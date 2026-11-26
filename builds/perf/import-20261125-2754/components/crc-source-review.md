# Independent review: contiguous source CRC verification

Reviewed the production diff from baseline
`7d1643e6147a10cb2165e9744cf0e63b59e46632` to the candidate represented by
`c2cf7647c67b02474301ed48e54a53205be0f027`, tree
`074e622aec0c6537c7f0d8ac92725dd62c28b73b`. This is a read-only source review,
not an execution log or a performance qualification.

No production correctness blocker was found in the reviewed changes:

- A CRC witness still comes exclusively from complete equality of original raw glossary bytes. Canonical content equality cannot grant a witness.
- Witness IDs point strictly backward. The complete flattening pass finishes before any root is replaced with a CRC, so transitive chains and cross-bank reuse remain valid. A CRC value equal to either marker bit pattern is never reinterpreted as a witness during flattening.
- The independent `validated_end` preserves backward, overlapping, zero-length, and cross-bank span rejection even when an unreferenced glossary stays inside a larger scan. The scan cursor covers the untouched original wrappers, separators, row fields, and unique glossary bytes.
- The incremental braided CRC starts from the complement of the previous ordinary CRC, matching the serial update contract. Both braided callers retain the existing minimum-length precondition.
- The polynomial cache contains 32 input-independent powers and an initialization flag, totaling 132 source-level bytes. Every uint32 length bit is covered; the cache retains no source-dependent entries across heap resets.
- Failed parsing verifies the original banks without witnesses. The existing finally path, sticky verifier errors, and verification before result callbacks preserve integrity and fallback ordering for valid parser-produced metadata.

Review requested focused coverage for the newly admitted low-compression source
groups and exact incremental braid thresholds including surrounding separators.
The author added stored-bank CRC admission, ordinary output parity, rejection
before sink delivery, and exact scan-run boundary cases.

Memory qualification remains necessary. Removing the compression-ratio gate
also enables the existing four-bytes-per-metadata-capacity witness allocation
for more groups; the fixed polynomial cache is not the complete memory effect.
Component timings and bounded-worker RSS cannot establish browser import speed
or memory non-regression.
