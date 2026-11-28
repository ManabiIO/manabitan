# Independent canonical component review

Reviewer: `/root/prior_import_work`. Read-only source review; no acquisition or timing performed by this reviewer.

Reviewed initial harness SHA-256 `cff015a7a7ba9f9e9cdf3c8751ca35d76c8d13ffb88afe6a2ed145816b540322`, watchdog `b4a78bb0eac15cd97d2cbfd98431da4e54b2cd7ef26c985c43cc662d72635958`, and registration `1fadc5e99a01c4f83041bb8690da339a221c1363fffae0adf5e82a1897069062`. Status: **hold before acquisition/replay until the narrow findings below are resolved and the final files are frozen again**.

## Revised frozen review

Reviewed the exact diff to harness `860212a3021b8eaaf755cc54d176fccc6665d5f583bcdfa9f1a1ab11888963dd`, watchdog `729a7a205470752eb19887e3dbff8ceb8c93c19f5ba5e5400c2141db8383b458`, registration `37e8bdf5e7ab46f2d444c2a15875db4a2d368cae9d90217e881f74543a0c431a`. All requested findings below are addressed. Source witnesses now use request IDs tied to ordered progress, all 53 banks are checked exactly once, replay registration is exclusive, failed first-use timings are retained, source identities are rechecked before success, and the guard counts the whole temporary root with final accounting and exception cleanup. Initial files remain preserved under `revisions/pre-review-v1`.

**Review passes for the registered sequential stages 1 and 2 only**, contingent on both independent watchdog receipts passing and the predeclared resource preflights. The timing schedule and every numeric limit are unchanged. Stage 3, a full import claim and a PR remain outside this approval. No acquisition/timing has run as part of this review. At the final review update the executor reported only 1,462.7 MiB MemAvailable, below the fixed 1,792 MiB acquisition preflight, so execution remains held without raising the budget.

### Observed guard failure and corrected coverage

Acquisition 002 subsequently produced the exact source census but an invalid resource receipt: the old child traversal sampled only the watchdog (PID 2), omitting the explicitly launched Node PID 5 because this environment exposed an empty children listing. It is not resource-qualified, and no timing was run from it. The previous approval was conditional on a valid independent receipt and does not bless this acquisition.

Reviewed correction: registration `7ecb8f2f97f9cb43caff7b7e4293e17fd19d48e7e25993ebaa85d34aa95cbf00`, watchdog `c7dd6b2cc10fcfc6185d9cc2b26bbe639d0c8c48c5047bdf1e95d4f1391a1dd5`; native harness and schedule remain unchanged. The guard now starts from the explicit launched PID and checks its start time, private process group/session, namespace and positive RSS coverage. It includes verified group members and PPid descendants using atomic per-process stat records, retains per-PID RSS, and signals only the validated owned group. This removes the reliance on the empty children listing.

Independently read and recomputed the small negative control, receipt SHA-256 `eb67a48333ca5a2aa30c6950fe83e0716d67e5c90611f2253b8db06eb7a25ef3`: sampled PIDs were 2, 5 and 12; the 96 MiB test-only cap rejected a 109,576,192-byte tree, while the same samples without descendant 12 peaked at 67,768,320 bytes. There were six positive launched-process RSS samples and no cleanup exception. Thus descendant coverage was necessary for the observed rejection. The production cap remains 1 GiB and all other registered production limits remain unchanged. **Corrected guard review passes**, still contingent on a fresh qualified acquisition and replay receipt; the prior invalid acquisition must not be relabeled as qualified.

## Findings

1. Source witnesses are appended in asynchronous request-dispatch order but selected by ordered sink index. Production passes `groupIndex + 1` as the parse request ID, while source reads are awaited independently. Associate witnesses with that ID and the callback's `progress.chunkIndex`; reject duplicate/out-of-range IDs and verify the complete ordered bank set. Root independently found the same issue.
2. The temporary-file watchdog counts only the current output directory, while the registered cap covers combined retained bytes below the registered temporary root. Count the whole root and check final bytes after the child exits; otherwise previous retained captures or a last write burst can evade the limit.
3. First-use timings are computed before semantic verification, but verification failure prevents their observation from being retained. Save the failed first-use record with `verified: false` and its timing/error before propagating, retaining successes exactly once.
4. Watchdog teardown/reporting should remain reliable if a file disappears during scanning or the child exits between the resource sample and kill. Sampling/guard exceptions must terminate only owned processes and save a terminal guard receipt; they must not leave a child running unmonitored.
5. Agree with the parent's two further requirements: replay must refuse any prior first-use/registration/block/timing artifacts and create its registration exclusively; source/WASM/fixture/harness identity must be rechecked before a success receipt.

## Boundaries that look correct

The warm timer encloses the native `scan_canonical()` call only. Capture decompression/hash verification, memory reset, semantic checks and logging occur outside it. The schedule is fixed and balanced, all three warmup blocks are retained, and the A/C identical bytecode may share warmed compiled code; that sharing is disclosed rather than called independent cold execution. Fresh-process first-use measurements are separated from warm observations and explicitly leave OS-cache state uncontrolled.

The semantic oracle includes all seven native header words, all 22 config words, and every byte from `META` through the full memory endpoint, covering scratch, unused arena gaps and authoritative metadata. The omitted lower memory is compiler stack and the fixed header/config gaps. The baseline output is captured before the JS owner copies/adopts native output, so each replay compares the same native boundary. All final header words and the return code are separately asserted. The corpus rejects continuations, fallbacks, borrowed groups or any mismatch against the exact 12-group hosted count vector; this scope is deliberately narrower than arbitrary native-kernel correctness, for which the existing 150 focused tests remain relevant.

Raw content persistence changes offsets/storage identity but retains exact bytes and the existing metadata owner and byte-comparison path. Group-level matching against the hosted census supports a source-derived native component, not a claim that this is byte-identical browser memory or a real installed-extension import. No owner-boundary or whole-import timing is implied. Stage 3 remains unauthorized.

The independent watchdog process can sample while synchronous native/gzip work blocks Node. Worker threads are included in their process RSS; first-use Node children are separate descendants. The fixed memory/time/disk guards and runtime available-memory floor must not be raised to rescue a failed observation. The aggregate CPU preflight is an observed diagnostic and does not establish exclusive visibility into other users' work.
