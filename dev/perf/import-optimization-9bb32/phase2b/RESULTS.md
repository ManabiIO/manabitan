# Manabitan import experiment results

Evidence projection as of `2026-11-28T05:56:10.183339+00:00`.

Each row is a separate hosted cohort. Negative changes mean faster; positive changes mean slower. The paired median, interval, and equal-work total are copied from the frozen harness; hosts are not pooled. An audit pass is not a speedup claim.

## Canonical slot fingerprints

[Candidate source](https://github.com/ManabiIO/manabitan/commit/178ee43328141693e88b90b4b518d483c87b2fac) · [Complete workflow](https://github.com/ManabiIO/manabitan/actions/runs/46104243724)

| Dictionary / order | Paired median | Descriptive 95% interval | Equal-work total | Faster pairs | Identical-code control | Memory screen |
|---|---:|---|---:|---:|---:|---|
| [jmdict-AB](https://github.com/ManabiIO/manabitan/actions/runs/46104243724/job/140853308364) | +1.168% | -0.293% to +3.086% | +1.504% | 3/12 | -0.486% | Passed |
| [jmdict-BA](https://github.com/ManabiIO/manabitan/actions/runs/46104243724/job/140853308317) | -1.219% | -2.751% to +2.145% | +0.969% | 7/12 | -0.578% | Passed |
| [jitendex-AB](https://github.com/ManabiIO/manabitan/actions/runs/46104243724/job/140853308103) | +1.769% | -0.654% to +3.852% | +6.725% | 4/12 | +1.080% | Passed |
| [jitendex-BA](https://github.com/ManabiIO/manabitan/actions/runs/46104243724/job/140853308341) | -0.064% | -2.087% to +1.837% | -0.191% | 6/12 | +0.618% | Passed |
| [vndb-AB](https://github.com/ManabiIO/manabitan/actions/runs/46104243724/job/140853308356) | +1.143% | +0.688% to +2.031% | +1.575% | 2/12 | -1.320% | Passed |
| [vndb-BA](https://github.com/ManabiIO/manabitan/actions/runs/46104243724/job/140853308373) | -0.298% | -0.888% to +0.722% | -0.053% | 7/12 | -0.484% | Passed |

## Composite parser minsize

[Candidate source](https://github.com/ManabiIO/manabitan/commit/2907ba1bad0958c22fe363f88d7cceb4d4bc604e) · [Complete workflow](https://github.com/ManabiIO/manabitan/actions/runs/46104898097)

| Dictionary / order | Paired median | Descriptive 95% interval | Equal-work total | Faster pairs | Identical-code control | Memory screen |
|---|---:|---|---:|---:|---:|---|
| [jmdict-AB](https://github.com/ManabiIO/manabitan/actions/runs/46104898097/job/140855328442) | -1.423% | -2.326% to +0.509% | -2.067% | 9/12 | +0.569% | Passed |
| [jmdict-BA](https://github.com/ManabiIO/manabitan/actions/runs/46104898097/job/140855328275) | +1.685% | +0.338% to +2.206% | +1.669% | 2/12 | -0.071% | Passed |
| [jitendex-AB](https://github.com/ManabiIO/manabitan/actions/runs/46104898097/job/140855328432) | +0.755% | -0.700% to +1.589% | +0.697% | 4/12 | -0.134% | Passed |
| [jitendex-BA](https://github.com/ManabiIO/manabitan/actions/runs/46104898097/job/140855328443) | +1.314% | -0.365% to +2.314% | +2.353% | 4/12 | -1.325% | Passed |
| [vndb-AB](https://github.com/ManabiIO/manabitan/actions/runs/46104898097/job/140855328400) | -0.378% | -1.332% to +0.514% | +0.366% | 8/12 | -1.705% | Sampling coverage failed |
| [vndb-BA](https://github.com/ManabiIO/manabitan/actions/runs/46104898097/job/140855328461) | +0.907% | -0.602% to +3.335% | +1.367% | 4/12 | -2.894% | Passed |

## Bounded wide keyword comparisons

[Candidate source](https://github.com/ManabiIO/manabitan/commit/ebf4278afc59d83f191692bd587f0e1f7e8682b3) · [Complete workflow](https://github.com/ManabiIO/manabitan/actions/runs/46112384728)

| Dictionary / order | Paired median | Descriptive 95% interval | Equal-work total | Faster pairs | Identical-code control | Memory screen |
|---|---:|---|---:|---:|---:|---|
| jmdict-AB | Pending retained cohort | — | — | — | — | — |
| jmdict-BA | Pending retained cohort | — | — | — | — | — |
| jitendex-AB | Pending retained cohort | — | — | — | — | — |
| jitendex-BA | Pending retained cohort | — | — | — | — | — |
| vndb-AB | Pending retained cohort | — | — | — | — | — |
| vndb-BA | Pending retained cohort | — | — | — | — | — |

## Evidence limits

- A reproduced audit or a correctness/memory pass does not establish a performance gain.
- Intervals are descriptive 95% paired bootstrap intervals from the frozen acquisition harness, not a new significance or promotion test.
- Browser semantic receipts cover counts, normalized storage, restart, twelve fixed lookup terms across six passes, and separate all-referenced-media checks; they are not exhaustive persisted-row equality.
- A failure of the frozen 250 ms memory-sampling coverage bound leaves memory comparison fields unqualified; it is not proof of increased memory use.
- Internal stage elapsed timers overlap and do not isolate CPU cost or prove the cause of a full-import difference.
- Wide candidate source QA and separate full-parser corpus parity are mandatory additional acceptance gates, outside this timing projection.

This file is a mechanical projection, not a pull-request decision. The JSON companion binds every source report by path, byte length and SHA-256. Raw observations, failures and audit scripts are retained separately.
