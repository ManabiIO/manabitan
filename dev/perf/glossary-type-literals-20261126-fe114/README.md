# Structured glossary literal dispatch: correctness evidence

This directory records parser correctness for
[the published source](https://github.com/ManabiIO/manabitan/commit/e197c714ac7738097b6cf005f178b075eaf2ab80),
against develop `0143e9596cd8f790d5e166d4ba6a2425fbc57f14`. Acquisition used local
native-change commit `1499a61a7d981179a24757e0d649b7e43e4e0cac`. The published
source adds only the browser qualification workflow to those runtime/test
changes; its tree `82ef06f34589040a07c7a65d963a5e0fb2df9de7` matches local workflow
commit `772d6cb6d6e0f440579ed7560fc6e4abf4a52bd9` exactly. The provenance record
includes both local and public identities. This evidence does not establish a
complete-import speedup or peak-memory result. Browser qualification is a
separate requirement.

The change recognizes the complete literal `"structured-content"` immediately
after an already-validated top-level glossary `type` key. It consumes the colon,
optional single space, value, and adjacent comma in one parser dispatch. Other
values, spacing, and escaped value spellings retain general parsing. Required
fields, duplicate-key behavior, normalization/media hints, and logical source
bounds remain checked.

## Full-corpus result

Both native modules produced identical public outputs for every locked source
bank. Every per-group receipt field matches; the only difference between each
dictionary's A/B reports is the expected native module SHA-256.

| Dictionary | Source banks | Two-bank groups | Rows per arm | Result    |
| ---------- | -----------: | --------------: | -----------: | --------- |
| JMdict     |           53 |              27 |      528,299 | Identical |
| Jitendex   |          219 |             110 |      436,555 | Identical |
| VNDB       |          665 |             333 |    6,648,310 | Identical |
| Total      |          937 |             470 |    7,613,164 | Identical |

The [provenance receipt](provenance.json.txt) binds the unchanged JavaScript
parser wrapper, fixture lock, dependency lock, original checker sources, native
artifacts, and source manifests. Baseline parser WASM is
`b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa`;
candidate WASM is
`051373ece6336a53091094fe1ee37a96ff3d771d6906a72f99ea6b7ee14137d6`.
Both use the pinned LLVM 21.1.8 build. The canonical-scanner artifact is unchanged.

The replay verifies the complete archive hash, each bank's ZIP CRC, ordered bank
coverage, and the locked total row count. It copies the public parser result
inside the borrowed-memory lease, then hashes all fields: canonical content and
metadata, numerics, interned keys, prepared lookup bytes and filters, and media
path projections. Repeated object references are hashed by value. The sole
omitted field is the nondeterministic `preparedLookupIndexEncodeMs` diagnostic.

Archives are read through a file-backed reader. The directory iterator retains
only term-bank entries, and each process holds one parser module and a bounded
two-bank input group. Node 22.22.0 ran with `--expose-gc
--max-old-space-size=384`; explicit collection between groups bounds discarded
owned projections. This is a correctness procedure, not a timing or memory
measurement.

The raw `mediaRows` field counts parser-selected rows, including repeated paths
and possible false-positive media hints. In particular, VNDB's 146,876 selected
rows are not a distinct-media count. The archive lock declares 146,570 media
files; this replay does not read or validate those payloads.

## Focused and adversarial validation

The committed native regression suite has 22 passing cases covering strict
fused parsing, whitespace and escaped-key fallback, required fields and
duplicate keys, nested media/text hints, malformed delimiters, and bounded loads
at eight source alignments. The targeted command left 187 existing cases
unselected. Changed-test ESLint, `git diff --check`, and library generation also
passed. Raw logs were not retained for these commands; the provenance record
labels their recorded command/result summary accordingly.

The separately retained [adversarial receipt](adversarial-receipt.json.txt)
records 58,126 baseline/candidate comparisons, including 5,556 accepted inputs.
Fourteen glossary forms were mutated at every byte and truncated at eight
alignments. Strict hinted and unhinted native parsing matched on acceptance and
all 17 row-metadata columns. This check ran under Node 24.22.3, an allowed
repository runtime, and made no performance measurement.

## Reproduction and scope

Checker files retain their exact acquisition bytes as text so historical
evidence is not treated as active repository tooling. Restore the `.mjs` suffix
to run [the corpus replay](replay.mjs.txt). Its arguments are repository root,
native WASM path, locked dictionary name, and output JSON path. For example,
after placing the locked archives under `builds/e2e-dictionary-cache`:

```sh
cp dev/perf/glossary-type-literals-20261126-fe114/replay.mjs.txt /tmp/glossary-replay.mjs
git show 0143e9596cd8f790d5e166d4ba6a2425fbc57f14:dev/data/dictionary-wasm/term-bank-parser.wasm > /tmp/glossary-baseline.wasm
node --expose-gc --max-old-space-size=384 /tmp/glossary-replay.mjs "$PWD" /tmp/glossary-baseline.wasm jitendex /tmp/jitendex-A.json
node --expose-gc --max-old-space-size=384 /tmp/glossary-replay.mjs "$PWD" "$PWD/dev/data/dictionary-wasm/term-bank-parser.wasm" jitendex /tmp/jitendex-B.json
```

Repeat with `jmdict` and `vndb`, then compare every report field except
`wasmSha256`. [The adversarial checker](adversarial-check.mjs.txt) preserves its
original absolute input/output paths; adjust those three acquisition paths when
reproducing elsewhere. The retained assembly script records the report-audit
assertions and source binding without changing the raw receipts.

This replay uses two-bank groups and the decoded-bank main-thread path. It does
not reproduce the production worker partition, worker transfer, compression,
OPFS transactions, browser restart, or actual media readback. It does not replace
the complete browser import, media, timing, or memory qualification.

An earlier [discarded screen](abandoned-screen.mjs.txt) terminated with exit 137
before producing a usable result. It retained two parser instances and whole
archives, and its hash traversal included internal heap-backed views. None of
its measurements or comparisons is used here. The corrected bounded replay
above is the source of all full-corpus receipts.
