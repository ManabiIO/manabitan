# Frozen JMdict batching storage-byte check

This separate correctness study compares baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` and batching candidate `83b0bafd51fff334a2f2e94beaf67cfa68e85eea`, both with production defaults and no requested flags. The compression protocol now groups multiple logical jobs into messages, so complete persisted-output comparison checks result-to-block correspondence beyond the ordinary sampled readbacks.

Run exactly four independent fresh-profile imports in A1, B1, A2, B2 order, including restart, then hash every byte of every custom OPFS file in consecutive 4 MiB chunks. The existing observer, comparator and their tests are byte-identical to the completed lookahead audit. Only the already-validated paired 16-byte generation IDs are normalized: MBTRD16X offset8 and MBTIDX11 offset24. Raw hashes remain retained; framing, cross-file generation pairing, record counts, lookup results, content probes and all other bytes must agree. Opaque SQLite SAH files remain outside this byte comparison. JMdict has no media.

The exact source, shared harness/dependencies, fixture lock, browser executable and all package member identities are checked. No package additions or removals are allowed; exactly the two registered Zstd JavaScript members must differ. The equal harness overlay only adds the post-restart storage observer. Release packages remain unchanged and are rechecked after all observations.

The driver adaptation changes the candidate identity, its two-entry package allowlist, requires equal package inventory, and supplies no lookahead flag or lookahead-claim requirement. The workflow uses a separate branch/output identity and never cancels an in-progress run. All observations and failures are retained.

These four imports are excluded from all timing and memory evidence, even if an inherited raw harness field labels its UI timer authoritative. The independently frozen performance/memory qualification is run46121177207; this byte study does not alter its plan or criteria. Chunk-hash equality is evidence from the reviewed observer, not a downloadable copy of every custom-file payload. No additional speed claim is made.
