# Current-develop compatibility review

This is a read-only review of already retrieved GitHub source and comparison data. It does not record a merge, rebase, merged-tree execution, artifact rebuild or new performance measurement.

## Exact comparison

The measured baseline is `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`; the measured image-path candidate is `e90c4c04172b691985858609094887f9541541dd`. The reviewed develop head is `dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16`, which added four commits through PR #972.

The [current-develop-to-candidate three-dot comparison](https://github.com/ManabiIO/manabitan/compare/dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16...e90c4c04172b691985858609094887f9541541dd) is two commits ahead and four behind, with merge base `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. Its PR diff remains exactly three files, 233 insertions and nine deletions: the two parser/worker JavaScript files and `test/term-bank-media-projection.test.js`.

The [upstream delta](https://github.com/ManabiIO/manabitan/compare/9e10d3b3fcf66d344ab31bc42c9b522fa5215da2...dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16) changes five disjoint files: the dictionary-WASM manifest and binary, native parser C source, `dev/perf/import-lookup-screen.js`, and `test/term-bank-format3-row.test.js`. It reuses scalar token ends and recognizes one compact structured glossary-list shape. The screen helper only reports two additional existing profile fields.

The file-disjoint changes give no identified textual conflict. No merge command was executed, so this is not a claim that a combined tree has been built or tested.

## Native projection and lifetime contracts

Exact retrieved-source comparisons between baseline C blob `ccfba94ced59e465859ccec855f4e6947f23f413` and current C blob `403272a3e65cbd4084f6211a46df7d3db78979ac` establish unchanged text for:

| Contract block | Compared source length | Result |
| --- | ---: | --- |
| Complete 17-word `TermRowMeta` definition | 592 bytes | Identical |
| Complete image-projector implementation and exported ABI | 5,452 bytes | Identical |
| Media-marker and type-text matcher block | 671 bytes | Identical |
| Generic composite parser and hint implementation | 12,190 bytes | Identical |

The new compact-list recognizer accepts only its complete fixed text-list shape. Leaf strings still use the existing bounded JSON string validator. Literal or escaped `img`/`image` markers fall back to the general parser when media hints are enabled. Changes in keys, structure or styling also fall back. The recognizer keeps its cursor local and only supplies an end position after a complete match; it does not modify hints on a failed attempt. Strict parsing still initializes all three hint fields to zero before glossary parsing. The admitted shape has no image selector, type-text object or structural whitespace requiring those hints.

Scalar token-end reuse adds internal C output parameters only. It retains numeric conversion, negative-zero score fallback and null-sequence handling. The exported functions, native projection pointer/length layout, source allocation, row spans and worker ownership/lifetime contracts are unchanged. Candidate batching still copies source bytes synchronously before parser memory reuse. No static integration blocker was identified.

## Required distinction and decision

[AGENTS.md at the reviewed develop head](https://github.com/ManabiIO/manabitan/blob/dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16/AGENTS.md) is unchanged. It requires full unit tests and the dry build for dictionary/worker changes, with relevant browser or integration coverage. It has no explicit requirement to rerun the performance campaign solely because the target branch advanced. The separate [frozen acquisition policy](https://github.com/ManabiIO/manabitan/blob/d36ee85feb1513af31f769175affa33b3696a307/dev/perf/path-qualification-7c02/README.md) remains bound to 9e/e90 and forbids replacing failed acquired observations.

If the original gates had passed, a review PR could have disclosed that historical scope while current-base integration validation remained outstanding. Calling a combined product validated would require the applicable unit/dry-build/native artifact checks, including the media-projection and format-3 cases, and relevant actual-extension coverage on that tree. Static compatibility does not establish current-develop performance; no historical measurement may be relabeled.

The original campaign's independently confirmed mandatory memory-coverage failures already block a review recommendation. No integration execution, rebase, new campaign or optimization PR was undertaken as part of this review.
