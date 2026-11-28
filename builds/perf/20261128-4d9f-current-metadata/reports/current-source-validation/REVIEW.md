# Current-parent implicit metadata integration

Parent: `f28c2801fcfd9416f220b46b9cbafeee901c1cb2`.

Integrated source: `fc431c38e5c614069e75652d60b3b5c50682986b`, tree `6e38383f06102c62c851c4bee0d72cadb0ecebe2`.

Worktree: `/home/agent/manabitan-metadata-current-4d9ffe79ec6f`.

This is a source-only integration checkpoint. No tests, build, full-corpus acquisition, browser timing, or browser memory measurement has yet run on this revision. The earlier dcfc/55e87bc evidence remains bound to those earlier sources.

## Scope and preserved changes

The applied patch is the complete runtime/test delta from dcfc02a0 to frozen combined candidate55e87bc. Fourteen files differ from the new parent: the original13 paths plus a dedicated interaction test. The canonical C, WASM asset, manifest, scanner wrapper and arena source are byte-identical to55e87bc; no compiler run or native algorithm revision was required.

The new parent's full indexed score-key validator, compact-block source witness, block-reference type/prefetch handling, lazy record-ID tests, and in-flight-source tests remain present. The six non-overlapping runtime/test files are byte-identical to f28c2801. Existing overlapping test files retain both sets of tests; their alias controls explicitly materialize a dictionary-name column when physical overlap is the behavior under test.

`source-manifest.json` inventories all paths changed by either branch and their parent, frozen-candidate and integrated hashes. `integration-vs-parent.patch` and `integration-vs-55e87bc.patch` preserve the exact resulting deltas.

## Setter conflict and failure ordering

There was one textual conflict in `_writeTermEntryContentMetaHashPairIndex`. The merged order is:

1. Validate and snapshot the ID; validate offset/length using the existing contract.
2. Snapshot the three signature primitives once, as in55e87bc.
3. Allocate a required physical ID column into a local variable. Positive zero keeps the empty column; negative zero and nonzero values retain the parent's physical Float64 representation.
4. Prepare signature storage, including preserving a stale implicit signature when an unsigned replacement requires it.
5. Intern and prepare dictionary-name storage.
6. Publish the ID-column pointer, then perform scalar field/signature writes.

A failure in either later optional allocation cannot expose the new ID column or partially replace the logical entry. A successful signature materialization can remain after a later name-column failure, and an unused interned name can remain; those were already accepted benign allocation/cache effects in55e87bc. All previous logical words, markers, counts and source arena bytes remain unchanged by that failure.

Physical ID arrays retain their backing and scalar write order. Contiguous publication's alias check skips only the empty ID column and null dictionary-name column; materialized arrays still participate in input/output and output/output overlap checks. The existing direct byte-backed insertion samples all signature words before zeroing the ID slot, so a source view into that physical ID column remains safe.

Growth preserves the parent's empty ID representation, and only allocates/copies it after materialization. Dictionary-name prefix clipping follows the existing dense high-water copy boundary. Signature materialization continues to leave arena presence-marker bytes unchanged. Reset returns all three optional representations to their intended initial state.

The indexed score-key validation has no direct data dependency on these metadata columns. The new source-witness and block-reference paths also retain their existing object/buffer identity checks and use the same published metadata interface; no witness admission or persistence boundary was broadened.

## Prepared interaction controls

`test/dictionary-content-implicit-columns.test.js` adds seven cases:

- Positive-zero IDs, MBR6 signature words and one dictionary prefix remain implicit through growth.
- A nonzero ID and a signed-zero ID each materialize all exceptional columns without changing earlier entries.
- ID, signature and dictionary-name allocation failures each leave the old logical entry and ID pointer unchanged.
- Direct insertion captures all signature words before clearing a source-aliased physical ID slot.

These tests are source-ready but unexecuted at this checkpoint. The existing lazy-ID, signature, prefix, canonical journal, publication-alias and growth suites remain necessary validation, followed by the required broader unit/build gates and current-parent corpus/browser qualification.

Independent source review by `prior_import_work` found no blocker in the setter resolution, optional-column ordering, or alias inventory. `git diff --cached --check` passed before commit, and the worktree was tracked-clean when the manifest was recorded.
