# Import optimization research

This research branch preserves the Manabitan import experiments based on
`develop` at `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. It is an evidence branch;
none of the completed candidates in this checkpoint qualified for a product PR.

The [post-UTF-8 checkpoint](checkpoints/postutf8-v2/README.md) contains the complete
observations, source patches, correctness gates, prospective plans, independent
audits, and interrupted or failed attempts. Its [results](checkpoints/postutf8-v2/results.json)
retain exact values and scope limitations. The archive includes the earlier
checkpoint unchanged, and the verifier reconstructs all 32 retained source commits.

## Interpretation

The two expanded-native VNDB comparisons are independent experiments: one uses
the conservative native candidate as its baseline, and the other uses the original
WASM baseline. Both are slower in all six pairs. Their memory gates failed because
sampling coverage was incomplete; those are **not measured memory regressions**.
The separate conservative JMdict and Jitendex screens did have qualified memory
measurements that exceeded their prospective limits.

Both complete UTF-8 Node studies passed the full semantic projections but failed
their identical-code control criteria. They provide no supported speedup, and
their results do not measure whole imports.

The [direct-writer Chromium diagnostic](https://github.com/ManabiIO/manabitan/actions/runs/46118417081)
was still queued at this checkpoint. The later guarded group-burst candidate and
native-export diagnostic were unfinished and are excluded from this snapshot.
Any later result will be added under a new checkpoint name.

## Verification

From the checkpoint directory, run:

```sh
python3 assemble_archive.py
python3 verify_archive.py payload.tar.gz --repo /path/to/manabitan
```

The archive is stored as two binary parts because its base64 representation
exceeds the connector's 16 MiB request limit. `assemble_archive.py` verifies each
part and the complete archive against `transport-manifest.json` before use.
The original checkpoint and its logical publication manifest remain unchanged.

The archive SHA-256 is
`cedf25a9fd678588195f2e28b158a5df9339deb37d6ea0a2bc22e2ce0e8c19c5`.
The verifier checks all current and nested members and reconstructs each source
tree using a separate temporary Git index. It leaves the real index and worktrees
unchanged.
