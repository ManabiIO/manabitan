# Independent source review: combined implicit metadata columns

Reviewed runtime commit `55e87bc64c9b043a91f1d075f0324d3176c18c9a` against S1-only `232de57c6fd78ef1115d6db97d2ac5bb2c224417`, including prefix predecessor `5ee2c0c1db0036fb7289952675d315c54c58cce7` and pre-snapshot combined checkpoint `9cbe508a322b4e7ef30c285fb7000721824f8416`. No runtime edits or tests were executed by this reviewer. The implementation agent reports the final seven-file/275-test focused cohort passed; the relevant tests were inspected independently.

**No source-level correctness blocker found.** Full combined corpus/runtime qualification remains a separate gate. S1-only corpus receipts must retain their original identity and must not be relabeled as this combined runtime.

## Dictionary-name representation

The null physical column represents one normalized Uint32 value on `[0, prefixEnd)` and zero through the remaining capacity. The prepare helper admits only a representable same-value overlap/extension or a zero write entirely in the zero tail. A different prefix value, a hole before a nonzero write, or an overwrite with zero inside a nonzero prefix materializes first. The fill helper is reached only after validated range preparation. Numeric private IDs retain Uint32 coercion, including negative, fractional, overflowing and nonfinite numbers. Missing numeric indexes retain undefined behavior.

Materialization fills all prefix words, including free/empty IDs, and publishes its new array only after allocation/fill succeeds. It does not mutate source-visible native arena bytes. Once physical, the column stays physical until reset; dense growth creates a replacement as before. Virtual growth clips the prefix only at the dense high-water mark, matching the previous typed-array copy limit and preserving stale words for free indexes below that mark. A same-capacity rehash retains the complete existing prefix, matching reuse of the old physical column.

All runtime references to the dictionary-name column remain inside DictionaryDatabase. The getter now reads the logical representation. The resize, generic setter, fast byte-backed insertion, contiguous publication and scalar publication paths all prepare before their first entry mutation. No external runtime consumer still assumes a non-null physical view.

## Alias and allocation order

The contiguous publication proof includes the physical dictionary-name table whenever it exists. Overlapping input/write views still return false and use the original per-row fallback order. When the column is null, it cannot already back an admitted input view; a newly materialized private allocation introduces no alias with those inputs. The inspected physical-alias test covers staged indexes in the dictionary-name backing and confirms fallback preserves its scalar behavior.

Fast byte-backed insertion captures all three source signatures before S1 preparation, dictionary-name preparation, index allocation and metadata writes. A nonrepresentable dictionary ID may materialize the old capacity before the ordinary dense allocator grows; the later resize copies the same dense prefix and updates the current table before the write. Existing high-water/free-ID allocation behavior is preserved.

In the combined generic setter, signature preparation precedes dictionary-name preparation, and both precede entry writes. If the second allocation fails, the first physical S1 array may remain allocated, and interning may retain an unused new dictionary name. The old logical signature words, markers, entry IDs/offsets/state, published/pending counts and source-visible arena bytes remain unchanged. This is the established entry-atomic contract, not an added guarantee to roll back benign allocation/cache growth. The paired failure tests cover both failure orders and subsequent successful retry.

## Signature snapshots

The earlier private setter could reread an accessor-backed signature between admission/preparation and the final write. The production caller inventory supplies fresh ordinary cache/collision literals or ordinary metadata snapshots; no imported-data/public path admitting such accessors was found. This was a latent generic-method assumption, not a demonstrated dictionary-triggered issue.

The final revision captures the three primitives once in `_writeTermEntryContentMetaHashPairIndex`, then uses that same tuple for type checks, allocation and writes. `_setTermContentSignatures` computes all three source words before assigning to the caller metadata object and uses those captured values for storage, preventing an accessor setter from mutating later source reads. Four inspected controls cover changing getters, nonmagic preparation failure, a setter mutating source bytes, and refresh allocation failure. This change does not alter the native scanner or common parser loops.

## Remaining qualification boundaries

The independent full-corpus oracle for combined runs must reconstruct both logical S1/presence and the dictionary-name prefix without invoking product getters, exclude the two representation-only prefix scalars from comparison to old metadata shape, and count any physical dictionary-name/S1 arrays separately from native memory. It must pin this new runtime/source tree and retain the original S1-only results separately. Browser peak/settled memory and whole-import speed require their own evidence.

Reviewed dictionary-database.js SHA256: `e03a59c69e3054b02f4383ebc480c18ef858678436efa3eb5b25d97eb1168476`.
