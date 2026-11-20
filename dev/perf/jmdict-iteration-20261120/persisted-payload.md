# Combined product: full persisted JMdict payload

Run: https://github.com/ManabiIO/manabitan/actions/runs/44826746012

PASS: two fresh Firefox imports, 526,942 rows in each, all three persisted term files totaling 43,176,166 bytes. Every raw file digest is identical before/after extension reload within its arm. Complete normalized file manifests match across baseline and combined product. Only paired 16-byte generation fields in descriptor/index headers are normalized across fresh imports (32 bytes total); all term-content bytes are compared unchanged.

- Baseline: `d733d0efe53398bfc2b45985aa709ade54f5710a`
- Combined product: `a0f8e8e00d30823b8451248b3e6bab20b4640eb8`
- Product tree: `b0d18a0f0bbd096ebe9a18d09bf284d2684d4a65`
- Helper: `caf308f10233b176c22f59dcd8999ef20f4ad6f0`
- Helper tree: `86c9f05da98ceda6eb45fdad98e791ec110980f7`
- Runtime: Firefox release 161.0b5 / application 161.0
- Common normalized manifest SHA256: `a96c7590672d8e6260b225e336112b9da92fcc07b3352aa57a089793159ac3ef`
- Artifact ID: 14674366586; 410,898 ZIP bytes
- Artifact SHA256: `5a6112b49cd0a058d5f2c448e19f8bb0d0b1ffa0ca45771e2469ce729e5d69b7`

The original artifact matched GitHub metadata by SHA256 and exact size. Safe extraction retained 75 files / 1,429,336 bytes. The archived coordinator matches the published immutable source exactly. Its analyzer was executed against the relocated archive and reproduced the original result exactly. Explicit checks bound the helper, direct product parent/tree, baseline, two-observation plan, 12 source paths and six packaged source paths. All archived bytes remain unchanged after analysis.

`artifact.zip` preserves the original archive. `extracted/` contains both observations, full raw/normalized file digests, logs, source/package manifests, source patches, pinned runtime metadata and all executed helper inputs. `archive-file-manifest.json` hashes every extracted file; `reanalyzed.json` and `reanalysis-receipt.json` contain the independent result and full validation receipt.

Scope: all persisted term-content, term-record and term-index bytes, after finalization and extension reload. SQLite metadata and media are excluded. No claim of browser restart, timing, peak memory, or exhaustive scheduling coverage. No observations were excluded, and no repeats were launched.
