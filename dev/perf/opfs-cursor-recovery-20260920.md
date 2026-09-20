# OPFS append-cursor and recovery continuation

Base: `develop` after merged PR #70 (`4a3a7d65b2dcc6d1264aebdaee1817052bd897c9`).
Only `ext/js/dictionary/term-content-opfs-store.js` changes in production.
No storage schema, migrations, buffer limits, flags, or performance promotion.

New findings: read snapshot refresh could abandon a still-open writable and
replace the active append cursor with the last committed (shorter) file size;
snapshot publication could race the next append; missing/unreadable segments
could silently disappear from the global address map; direct writes, close,
and initial stream creation/seek failures could be forgotten by later calls.
Read refresh also must reject observed prefix shrink/change or missing tails.

The repair gives snapshot transitions the existing mutation owner, drains and
closes before observing persisted lengths, stages read snapshots before
publication, validates contiguous canonical segment inventories, and preserves
sticky errors until explicit checkpoint rollback. Rollback/reset can inventory
gapped interrupted-only files without publishing them as readable addresses.
Short contiguous legacy segments and legitimate external tail growth remain
supported. This cannot detect content changes of unchanged length or recover
bytes already lost; it is not a checksum, a transaction redesign, or a new
on-disk format.

Carries forward the earlier local content-store repairs for checkpoint
preflight, spanning snapshot reads, queued failure admission, and single-writer
rollover. Preserves PR #70's existing rejection observer and exact-slice cache
fence. Does not include the earlier record-store, raw-codec, or hash-reuse work.

## Deterministic qualification

`node test/fixtures/opfs-continuation/check.js . /tmp/opfs-result.json`

The identical 29-case runner reports 24 assertion failures / 5 passes against
the exact PR #70 content-store blob, and 29 passes / zero failures locally with
this source. Controlled File/stream boundaries use real temporary files with
commit-on-close snapshots, not native OPFS. Timeouts are harness failures and
must not be counted as behavioral RED. No assertions change between arms.
The Vitest wrapper enrolls the runner in normal unit CI. The exact-head browser and repository qualification is recorded in [GitHub Actions run 35496124115](https://github.com/ManabiIO/manabitan/actions/runs/35496124115).

## Merge gate and remaining context

Keep draft until exact-head full tests, all TypeScript projects, changed-source
lint, all-target build and real Chromium imports pass. Re-run the 29 cases
unchanged. Qualify native fault/cancellation/restart behavior and Firefox /
WebKit separately. Review lock ordering: public snapshot setup owns mutation
exclusion; calls already holding it use the private helper. Do not acquire the
same non-reentrant owner again from beginImportSession. Do not silently drop
file errors, reopen a writer from a stale snapshot, or relax rollback preflight.

The separate compaction candidate is not part of this correctness change.
Synthetic ABBA evidence alone does not establish whole-import benefit.

Failed rollback also retains its error inside the mutation owner; admission remains closed until a later explicit rollback succeeds.
