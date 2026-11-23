# Hosted import evidence, November 23, 2026

This immutable bundle retains the first five candidates' complete browser studies, the separate owned-buffer memory campaign, and three baseline discovery profiles. Interpretation and exact sources are in the [round report](../20261123-r2-qualification/README.md). Record-validation browser results are in a separate bundle because that final campaign completed later.

The archive contains all expanded bytes from 39 provider artifacts: 30 complete timing cells, six memory cells (including two unqualified cells), and three baseline profiles. Every original ZIP byte length and provider SHA-256 was checked before freezing; every ZIP member was compared with the retained expanded file. ZIP containers are represented by their original hashes and member inventories without duplicating their contents inside the tar archive.

The timing campaigns contain 1,260 successful imports, including 180 excluded warmups and 1,080 measured imports. The 24 memory imports all pass functional checks; 22 memory observations and four complete cells qualify. Discovery profiles and observer-run durations are not timing evidence. All failures and partial memory receipts remain retained.

- Archive: `raw-evidence.tar.xz`
- Bytes: 11,979,924
- SHA-256: `c57ba517630eda731ade2e83a6927417df26c0bfd737ad9d294f06a173812095`
- Retained members: 8,936

The [manifest](manifest.json), [member index](raw-members.json) and [original ZIP inventory](original-zips.json) bind every byte. Verify before extraction:

```sh
python3 dev/perf/import-r2-evidence-20261123.py verify builds/perf/20261123-r2-hosted
```
