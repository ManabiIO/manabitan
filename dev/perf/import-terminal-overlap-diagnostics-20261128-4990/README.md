# Terminal record/content overlap diagnostics

This source-bound diagnostic measures the scheduling opportunity between the last eligible record append and its existing content-completion callback. It does not start record finalization early, change an await or source-release dependency, or support a performance-candidate comparison.

Baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The diagnostic arm is the immutable study commit, additionally bound to the two runtime SHA-256 values in `protocol.json`. Native modules, fixtures, production settings, import harness, persistence format, lookup verification and media checks remain unchanged.

For each of JMdict and Jitendex, two independent GitHub runners each acquire six fresh-profile imports. Host 1 executes A,D,A,D,A,D; host 2 executes D,A,D,A,D,A. A provides ordinary context. D records bounded diagnostic state: total artifact calls/rows, the final artifact call, and the last call using the existing early-content route. Source file indices and native chunk counts come from the importer's actual callback. Record-id snapshots identify any later append. No chunks, parser arenas or source leases are retained by the observation.

The record-completion timestamp is placed immediately before the existing append promise fulfills; the existing content-completion reaction supplies the other timestamp. The original all-settled join, catch draining and content-owned lease release remain intact. Both signed content-minus-record time and its nonnegative bound are retained. A source-terminal call must also be the final artifact call and match the final record id before it is classified as a final append.

**A positive wait is only an upper bound on overlap opportunity.** It includes coordinator callback delivery and storage work. It does not establish that a compression worker is still using CPU, or that moving a synchronous flush into that interval would save the same amount of complete-import time. Absent, earlier or nonterminal eligible calls are valid negative observations. The next implementation decision must consider this evidence alongside cancellation, rollback, session ownership and read/repair admission.

There are no excluded warmups, trimmed tails, retries, replacement observations, timing ratios, confidence intervals or cross-host pooling. There is no tracing or memory observer. The standard benchmark's raw `authoritativeTiming` flag detects its own trace configuration, not source instrumentation; the study therefore separately classifies every observation and its analysis as nonauthoritative comparative timing.

Every import must pass the unchanged full semantic receipt validator, including source/package/fixture/browser identity, restart, all 72 public lookup observations, exact storage inventory, canonical content digest and complete media readback. The diagnostic parser independently recomputes terminal identities, record deltas, completion ordering and both wait fields. Failures stop the cell and retain all completed observations and the unattempted schedule. Full unit, main/test type, scoped lint and dry-build gates run separately.

```sh
python3 dev/perf/import-terminal-overlap-diagnostics-20261128-4990/run.py \
  --dictionary jmdict --host 1 --evidence /tmp/terminal-overlap-evidence
```
