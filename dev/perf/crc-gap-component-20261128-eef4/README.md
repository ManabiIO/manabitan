# CRC gap component diagnostic

This experiment measures the current production parser worker with a single native change: batch the final 0–15 bytes in `crc32_update_gap` with guarded 8-byte and 4-byte slices, leaving at most three scalar byte recurrences. Existing CRC tables, 16-byte blocks, source admission and glossary witnesses remain unchanged.

The baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The candidate module must be exactly `b362d9b0106c28e9cb495d66c650463c771e165cb8ebadc4a66adda973466fd9`; the guarded test export does not ship. Only production function body 5 changes, and all non-code sections remain identical. The module grows by 284 bytes.

## Registration

Publish the four reviewed product files in a source-only commit. Set `PERF_CANDIDATE` in the workflow once to that immutable commit. Publish this diagnostic bundle and workflow in a separate follow-up commit. Admission rejects any product diff beyond the C source, its existing CRC test file, the checked module and its manifest.

Two independent hosted jobs run the same six balanced block permutations. The forward order is `ABC, BCA, CAB, CBA, ACB, BAC`. The reverse job reverses the entire 18-observation schedule, giving `CAB, BCA, ABC, BAC, ACB, CBA`. A and C are byte-identical baselines. B uses the candidate native module with the exact baseline JavaScript.

Each observation starts a fresh Node 22.22.0 child, performs two excluded full-corpus warmups, one measured full-corpus pass, and one later exhaustive verification. The child exits before the next one starts. Each job therefore retains 36 warmups, 18 measurements and 18 exhaustive verification passes. There are no GC or tiering flags, replacement observations or result-based stopping.

`preloaded-worker-server.mjs` is the byte-identical server used in the completed local sequential cohort, SHA-256 `c13f63b7069dd81cc78ea6fe0d58663473c5c5009e9dc12588be89908db3134b`. The portable controller changes paths, prospective host order and report aggregation; it does not change the worker transaction, source grouping, conditioning or timing boundary.

## Boundary and interpretation

The timed boundary is a sequential transaction through the actual production parser-worker module: resident compressed bank bytes, native inflate/CRC, parsing, canonical content and lookup generation, ownership copies, media-path projection and transfer-list construction. ZIP reads, process/module initialization, IPC, parallel scheduling, compression, storage, media payload import, browser UI and lookup readiness are outside it. This experiment cannot establish complete-import speed.

The locked VNDB archive, native sources, checked manifests, modules, production JavaScript, runner bytes and Node executable are bound by hashes. Each exhaustive pass hashes every deterministic output byte and column. It must match the established digest for all 6,648,310 rows. Source identities are checked again at each child's end. The workflow retains both baseline and candidate native sources/modules, the exact runners, every complete or partial child report, every log and the host context.

Report both hosted jobs separately. Compare B/A and B/C against the identical C/A controls using wall time, current-thread CPU and process CPU together. Report all internal per-phase timers as wall-clock diagnostics; they can overlap and must not be summed as independent phases. Broad movement outside source CRC is evidence of environmental drift, not extra CRC work removal.

The local sequential cohort had favorable B comparisons but unstable identical controls. Its preceding three-resident-arm acquisition was terminated by SIGKILL; memory pressure was suspected, not proved. Both acquisitions remain separate evidence. The hosted jobs are an independent diagnostic, not a replacement for unfavorable or failed local observations.

## Commands

After installing the exact baseline dependencies and generating its libraries, prepare the pinned VNDB archive with the baseline's `dev/perf/prepare-dictionaries.js vndb`. Then run:

```bash
python3 prepare.py --baseline-root BASELINE --candidate-root CANDIDATE \
  --candidate-ref COMMIT --cache-dir CACHE --node NODE \
  --order forward --out EVIDENCE
python3 EVIDENCE/runners/run.py --plan EVIDENCE/plan.json --check-only
python3 EVIDENCE/runners/run.py --plan EVIDENCE/plan.json
```

The output directory may contain setup logs but must have no existing plan or result. Any acquisition failure remains failed; the controller refuses to resume or overwrite it. `summarize.py` can audit an already completed report without changing it:

```bash
python3 summarize.py --result EVIDENCE/result.json --out phase-audit.json
```
