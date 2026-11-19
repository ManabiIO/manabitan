# Manabitan JMdict investigation evidence

Staged 2026-11-19T20:28:24.821529+00:00. **Status: final.**

Read `REPORT.md` for the current outcome and `evidence-index.json` for the updated
evidence index. The original investigation report and index remain verbatim historical
snapshots at `repo/builds/perf/investigation-draft.md` and `repo/builds/perf/evidence-index.json`.
`archive-status.json` records every included CI cohort, terminal gate status and omission.

All raw measurement JSON, receipts, observation results, package-entry identities,
driver files, provenance and validation logs are retained without CSV reduction.
The only separated data are large `*.trace.json` files; the optional trace archive
overlays their original relative paths. Downloaded CI ZIP wrappers are omitted
after every extracted member matches their contents; wrapper hashes are recorded.
Dictionary fixtures, dependencies, browser profiles and extension packages are absent.
The reconstructible Zstd probe content and native executable are excluded; their
provenance, source, rebuild commands and non-timing results are included.

The gzip and xz versions contain identical tar streams. Choose one format for each
of the main and optional trace archives; do not extract both compression variants.

## Integrity and reconstruction

From this extracted directory:

```sh
sha256sum -c SHA256SUMS_MAIN
# After extracting the optional trace archive into this same directory:
sha256sum -c SHA256SUMS_TRACES
```

In an existing Manabitan clone containing baseline `d829f5b6e6a75ee8859d38d537d224ec33c4930e`:

```sh
git cat-file -e d829f5b6e6a75ee8859d38d537d224ec33c4930e^{commit}
git bundle verify /absolute/path/to/git/local-candidates.bundle
git fetch /absolute/path/to/git/local-candidates.bundle 'refs/heads/*:refs/remotes/jmdict-evidence/*'
```

`git/bundle-heads.json` advertises the exact candidate, harness and qualification
commits. The bundle deliberately requires the public baseline; it is not a full
repository mirror. Candidate tests and build inputs are retained in those commits.
The frozen WASMs, C files and manifests remain under their recorded evidence paths.

Use `restore-map.json` for exact per-file destinations and hashes. Restore `repo/`
under the clone, and `external/publication-screen.mjs` one level above it. Restore
drivers to their original relative paths before replay because several derive
the checkout root from their location. Do not overwrite source snapshots into a
different commit. Read the recorded workload limitations before interpreting results.

Current parser decision: HOLD: repeated JMdict whole-import point estimates and parser-phase reductions are promising, but both independent cohort 95% intervals include zero and whole-browser memory, lookup and reliability gates remain incomplete. No runtime PR or promotion.

Corrected storage failed whole-import qualification and remains unpromoted.
Fused storage failed its reversed-order direct comparison and remains parked.
The CI controls are unchanged-code controls, not product speedup evidence.
The full storage unit run lost its terminal verdict and is not recorded as a pass.
