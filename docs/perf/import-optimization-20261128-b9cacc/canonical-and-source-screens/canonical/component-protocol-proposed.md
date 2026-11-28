# Combined canonical scanner: proposed bounded component protocol

Status: source and focused correctness validation complete; no acquisition or timing has run. This plan is for root review before implementation or timing.

## Source identities

- Baseline A and identical control C: develop `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; canonical C SHA-256 `af0348063a64e4cf0f71e09ef5fd0acea7f548d7d872d24f867acf63412b412b`; WASM `40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af`, 1,624 bytes.
- Candidate B: exact #880 head `2dfa72962c9d9f1976011e41b9bbce2375f4dbb5` immutable snapshots combined with exact #864 head `d147a60fc4845e898d98d8924968d6094b417007` local non-journal counters, composed on 9e10.
- Candidate C source SHA-256 `dc50ff2e2597e3e869583582abeb877e1174c6539d32de1870774fdfe780f126`; WASM `5ce4a3ef2869fe101d92cd46d1364c4be273546d2a77b9d7fd38ec3b10f2644a`, 1,806 bytes.
- Pinned Clang/LLD 21.1.8 regeneration and reproduction succeeded; parser WASM is unchanged. All 150 focused native, owner, epoch, arena, and source-bound artifact tests passed. Exact commands and logs are recorded in validation.json.
- Node 22.22.0. No browser, full import, OPFS, SQLite, or memory-qualification claim is made by this component.

## Stage 1: acquire real source-derived native calls, without timing them

Use the locked JMdict ZIP (15,645,766 bytes; SHA-256 `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f`). Reuse the exact baseline raw ZIP planner, native parser module, three-worker production parser policy, and the repository's Node adapter for actual parser workers. Record every source group and validate all 53 banks and 528,299 rows.

Feed each emitted group through the existing baseline DictionaryDatabase bulk dedup/metadata owner. Supply the same dictionaryTotalRows, raw token dictionary name and resolved-reference flags as the production importer. Preserve the real canonical scanner, metadata reservation/publication, signature comparison and recent-source ownership/cache behavior. Replace only external persistence/record I/O: pending spans receive deterministic offsets into a temporary append-only raw source file; exact reads return those exact bytes; record append is an acknowledged no-op. This is a source-derived component driver, not an installed-extension import.

The baseline scanner's existing beforeNative hook captures the exact live memory after production input/config packing and before the native call. Gzip one capture immediately, then discard its raw copy. At the first beforeOutputView callback, record the header and a SHA-256 over all semantically owned memory: header/config, full fixed scratch region from META through the layout end, and the full authoritative arena. Exclude the compiler stack, whose byte contents can legitimately differ between compiled kernels. Preserve capture ordering, geometry, input hashes, expected output hashes and every count.

Qualification must match the fresh hosted baseline marks acquisition, group by group: 12 groups; 366,030 unique representatives; 362,032 pending rows; 3,998 persisted matches; 171,617,523 source bytes; 101,143,985 owned content bytes; no borrowed group or native fallback. Keep the full expected per-group vector in the registration. A mismatch stops the experiment with a retained failure record; it is not silently accepted as equivalent workload.

After acquisition, close all parser workers and raw content I/O before any timing. The raw content file is reproducible and can be removed after all capture receipts are validated. Native input snapshots remain until the experiment's decision.

## Stage 2: first use and warm native-kernel replay

Before the warm cohort, collect three small first-use blocks in orders ABC, BCA and CAB. Each arm invocation gets a separate fresh Node process, loads only that arm's WASM, restores the first capture outside the clock, and separately records WebAssembly.compile, instance construction and the first exported native call. Verify its semantic result against the capture oracle. These nine observations describe fresh-process first module use; OS cache and host scheduling remain uncontrolled. They are not pooled with warm observations or used alone for promotion. Creating another instance inside the warmed parent process is never called cold.

Compile A, B and C independently before observation. Instantiate them against the same fixed memory geometry for each captured call; no imported callbacks or shared memory. Reset every byte from the frozen baseline capture outside the kernel clock. Time only the exported scan_canonical() call with the same Node monotonic clock. Verify the return code and full semantic output digest after every invocation, outside the clock, against the baseline oracle. The actual baseline output from acquisition also anchors the oracle.

For each complete block, replay every captured call in acquisition order. For each call, reset memory before each arm and execute arms in that block's registered order; aggregate the individual call durations into per-arm corpus kernel totals. These are block-stratified warm component totals, not complete-import samples.

Three complete warmup blocks: ABC, BCA, CAB. Twelve measured blocks: ABC, BCA, CAB, ACB, CBA, BAC, then repeat that exact six-block sequence. Retain warmups, every individual call measurement, all block totals, all ratios and every failure. Do not trim outliers, extend a noisy run, replace failed samples or select a different schedule after observation. A and C are byte-identical controls. Analyze paired B/A, B/C and C/A separately, including absolute milliseconds, ratios, faster-block counts and observed control spread. No multiplication by a browser's aggregate canonical counter is valid.

The primary purpose is to determine the absolute editable-C budget. A gain of only a few milliseconds is a reason to stop even if its percentage is large. Proposed continuation screen for root to register: at least 10 ms median corpus kernel savings and 10% versus both controls, improvement in at least 10/12 blocks against each, with median control drift smaller than half the candidate effect. This screen only authorizes considering a second component boundary; it cannot justify a PR or a full-import gain claim.

## Stage 3: conditional existing owner-boundary comparison

Only if the kernel budget warrants it, propose a separate frozen protocol that replays private copies of the same actual parser chunks through the unmodified existing _resolveArtifactTermContentDedup boundary and production metadata publication/cache, with the same deterministic raw I/O substitute. The only arm difference is the compiled kernel. Include all input packing, pending-column adoption, canonical allocation/reservation, exact comparisons and continuation overhead in that owner clock. All corpus counts and publication digests must agree.

No Stage 3 timing is authorized by this document. If the capture can support it cheaply, retain the minimal actual parser columns during Stage 1; do not fabricate a synthetic owner workload. The baseline acquisition's wall time and the hosted 98.1 ms canonical counter are diagnostics only, never substitutes for paired owner observations.

## Resources and failure policy

Current workspace free space fell from 434 MiB to 129 MiB while other diagnostics arrived. Do not put large temporary inputs in that mount. Use only our explicitly named /home/agent/.cache/manabitan-b9cacc/canonical-combined temporary directory, which is tmpfs and counts against RAM.

Proposed acquisition preflight: at least 1.75 GiB MemAvailable and 256 MiB free in the temporary destination. Own process-tree RSS hard stop 1 GiB; native arena hard stop 64 MiB; combined retained temporary bytes hard stop 192 MiB; wall timeout 5 minutes. A separate parent process observes RSS even while synchronous parsing/gzip work blocks the Node event loop. Abort only owned child processes on limit. Retain compact failure evidence and completed capture receipts; no automatic higher-limit retry. Replay should use under 256 MiB after parser shutdown. Recheck available memory and acquire the exclusive local CPU slot before every timed phase.

Source staging uses 26 MiB plus tiny generated outputs and symlinked dependencies; no new install is required. Individual #880/#864 arms are excluded initially to minimize cost. Any later attribution arms require a new prospective registration.
