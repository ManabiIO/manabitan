# Saved import investigation evidence — 9d6

These archives preserve completed component studies, including every retained observation, source-identical control, negative result, failure record, correctness proof and source identity. They do not establish a complete-import speedup. Full-import qualification remains pending at packaging time.

Baseline: `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The six archives contain **955 files** and occupy **1,157,093 bytes** in total. `inventory.json` binds every member to its original source path, size and SHA256; `publication-receipt.json` records the verified package and original artifact identities.

| Archive | Bytes | SHA256 |
| --- | ---: | --- |
| `metadata.tar.gz` | 397,037 | `b98c79e927659f49dbe6216c485466d1ff247b70579b8aed64eac8b60f6a0aeb` |
| `codec-v1.tar.gz` | 180,016 | `71fe990c46d0645e212c499230ad57a1a282c4e1b45c5f041dc03888a7af4fd2` |
| `codec-v2-and-guarded-proof.tar.gz` | 247,023 | `19daffeaa033adef237c3a24d96998b3d0595510934137e0bfe2fb949470293d` |
| `direct-record-lengths.tar.gz` | 156,246 | `3a3491910191aaa6f136be73429cb0dd38d7fcb7520d93c3911b3468941a9d53` |
| `inflater-local.tar.gz` | 165,454 | `b7312cb75461cfa89afee5522e5074e93a82302b2be4e1efea34799db0a7522c` |
| `shared-identity-and-dispositions.tar.gz` | 11,317 | `8e2c89d852d87b19ce985a33493ad5663dbec738eba5d121a6d051c999b91749` |

## Interpretation

- **Metadata:** earlier scan fusion was rejected for a roughly 0.6 ms warmed saving and disproportionate complexity. The narrow helper shows cold component gains on two hosts, while warmed AB regresses and BA is mixed. Local cohorts and all original failures remain included.
- **Codec v1:** scalar counters were rejected for inconsistent cold gains and larger modules. Later source review also identified the missing reversed-limit guard; their old timings cannot qualify a production change.
- **Codec v2:** original count16 is invalid (768 direct-test traps and one wrong result). Its exploratory timings cannot qualify the corrected binary. CStream64 is rejected with 72 tight-destination status regressions. The guarded replacement passes correctness, but its performance requires separate qualification.
- **Direct record lengths:** all 108 fresh-child receipts are retained. No stable gain survives both controls for JMdict or VNDB; Jitendex warm savings are only about 0.24 ms. Runtime restored.
- **Inflater:** all 36 local children, cold losses, noisy controls, byte/CRC parity, reach and test-harness correction evidence are retained. No local gain is established.

Full-import runs pending at packaging: metadata **46107460816**, guarded codec **46109596112**. Inflater component replication **46106878218** is also pending. Later results should be added separately and must not replace these completed cohorts.

## Original hosted artifacts

| Artifact ID | Run / attempt | Head commit | ZIP bytes | Original ZIP SHA256 |
| ---: | --- | --- | ---: | --- |
| 15247978251 | 46104605338 / 1 | `8ce17bb15c5593889a528e91c753684b641a1afe` | 163,573 | `635aafba91b7f2a58584d606bc3e1450a44d3e5ace2567c08987a07d84a958b1` |
| 15247608252 | 46104605338 / 1 | `8ce17bb15c5593889a528e91c753684b641a1afe` | 162,684 | `d74891a62def38dcb8f7c9c63e167be1555bad387082c16169c34e0e115bf570` |
| 15247313223 | 46103338197 / 1 | `d4470d35a684a8c37628123d7740ec2fa3375f4b` | 484,951 | `a114993a0dd3f9cbc4e001a57168835ca8036e1a75597d8edad979eb7ebc62ea` |
| 15247901694 | 46103338197 / 1 | `d4470d35a684a8c37628123d7740ec2fa3375f4b` | 485,041 | `ef3dac09d8049e329fecf616f1a43cf4d5d93282b5fca4d8aeddf484c03474d3` |
| 15248416986 | 46104781415 / 1 | `03aaef1730788c59ecdb5d8bb45f3c87fe90cb40` | 486,970 | `5a927ef6115ba8cf5dcce90fdf43f46d185fcc0e5f5603fb0435f2790c7d9187` |
| 15248447120 | 46104781415 / 1 | `03aaef1730788c59ecdb5d8bb45f3c87fe90cb40` | 487,072 | `87411bd3734071d0857ec38ae5e3924921c65d4337f08a5fcfbe786818cbe9dc` |
| 15245899188 | 46103338197 / 1 | `d4470d35a684a8c37628123d7740ec2fa3375f4b` | 16,506,090 | `c3ab42f8714af1c21053e258c5caa7b8fa3c98a6f2eace8cf3c29f69da9f0ffe` |

All seven original ZIP identities and every extracted member were verified before packaging. Their complete member hash lists are in the unchanged inventory. The compact archives exclude original downloaded ZIPs, fixtures, compressed source/record columns, generated WASM/module duplicates, SDKs and checkout/dependency trees. They preserve observations and provenance without claiming to recreate those original ZIPs from the intentionally omitted binary files.

Archive entries use deterministic PAX tar metadata with gzip level 6 and mtime zero. Every input was rehashed before inclusion; every saved archive matches the frozen estimated byte count and digest; every saved member was reread and verified. Original receipts and the inventory were not modified.
