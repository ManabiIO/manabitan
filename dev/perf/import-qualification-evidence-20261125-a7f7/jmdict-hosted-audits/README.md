# Independent hosted JMdict audits

Three separate reviews cover the original fixed cohort in
<https://github.com/ManabiIO/manabitan/actions/runs/45646399468>.

- `independent-statistical-audit.json.txt` and `audit-statistics.py.txt` verify
  artifact/member hashes, chronology, every scheduled observation, raw timing
  boundaries, excluded instrumentation, complete-pair statistics and all
  10,000 seeded bootstrap resamples.
- `independent-semantic-audit.json.txt` and `audit_jmdict_semantics.py.txt`
  verify all 84 imports, Git source/harness/dependency bindings, actual packages,
  cross-host entry equality, unchanged WASM, the exact marker overlay, the
  existing production validator, worker policy and complete semantic receipts.
- `independent-memory-audit.json.txt` and `audit-jmdict-memory.py.txt` recompute
  all 571 raw scans, eight import windows, coverage, sampled maxima and fixed
  paired memory gates from the unchanged original observer.
- `artifacts.json.txt` binds original GitHub artifact IDs, sizes and SHA-256
  digests. `acquisition.json.txt` preserves the successful jobs and monitoring
  history. No acquisition was rerun, replaced, omitted or pooled.

Each report states its own scope. Correctness and sampled-memory qualification
pass; the timing evidence does not establish a latency gain. The actual browser
configuration has two workers and 15 native segments. The separate component
replay's temporary-copy reduction must not be relabeled as measured browser
allocation or peak-memory savings.

Raw observations are in the adjacent AB/BA archives. Actual package ZIPs remain
in the original Actions artifacts and were independently checked before
publication. Reproduction scripts retain original acquisition paths; restore
their `.py` names and provide the extracted evidence root and repository root
as documented by each script. No new imports are necessary to repeat an audit.
