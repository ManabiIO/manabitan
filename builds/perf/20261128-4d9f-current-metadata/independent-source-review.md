# Final metadata source review and online-Zstd integration

## Outcome and scope

No new semantic blocker was found in the metadata representation patch or its clean integration onto a300da36d00df8e353c5679b1528b50a1299b75f. This is a source review, not a new test or performance acquisition. The older full-corpus and browser observations remain bound to their recorded f28/81e sources.

Reviewed frozen candidate: 172dfa06e1a5e6d28ff97cdeae2bb5df6ac95b6d, publicly equivalent to 90a0e7d7f93582b0f20d97c057b553a5194f5774, full tree e5060ae9f1e78fe069abdfc225ced1a79bde4237.

Latest integrated candidate: 5b178ff002216d74cc8a09336c375832fc4dd994, parent a300da36d00df8e353c5679b1528b50a1299b75f, full tree 525583edb6429008801d181ee03b3e9e5c519eae, ext tree 6882b13827d4bb648a4a9297f293e55f055b74ed.

## Semantic and failure review

- **Exact signature values and rejection behavior.** Marker 2 reconstructs the literal MBR6 first word. Markers 0/1 retain the old unsigned/physical behavior; the second and third words stay physical. All production signature-presence readers were located. Hash-collision filtering still observes the same signature triple and then the same full-byte equality path. This does not introduce the previously rejected lazy-signature cold reads.
- **Free and stale slots.** S1 materialization visits every marker-2 slot, including free/stale entries, and leaves arena marker bytes unchanged. Unsigned replacement materializes before dropping marker 2 so the old raw word survives. Generic rollback retains stale words; native rollback clears its newly allocated suffix exactly as before. Growth preserves the dense high-water prefix and the established zero tail.
- **Aliased inputs and private accessors.** Source signature words are sampled before materialization or authoritative writes. The generic writer snapshots the three signature primitives once; post-read refresh samples before calling mutable object setters. The private setter strengthening is deliberate and covered by the retained accessor controls. Physical name and ID backing remains stable until its ordinary growth/reset boundary, so existing aliased scalar read/write ordering remains available. S1 materialization does not mutate arena bytes that accepted inputs may alias.
- **Three optional columns.** A nonzero or signed-zero Float64 ID column is allocated privately. S1 preparation and dictionary-name interning/materialization finish before that new ID array or entry words publish. A later allocation failure may leave benign S1 materialization or an unused interned name, but leaves the old logical entry, markers, IDs, counts and source-visible arena bytes unchanged. The upstream empty-Float64 positive-zero sentinel is preserved; null is not substituted for it.
- **Dictionary-name prefix.** The virtual form is one value over a prefix plus zero capacity tail. Equal-value rewrites/extensions remain virtual; holes or a differing value allocate the complete Uint32 column first. Once physical, writes retain the original backing and scalar behavior. Complete bulk validation and alias checks precede prefix advancement, allocation and stores; the empty ID view and null name view are skipped only where they have no writable range.
- **Native boundary.** The wrapper requires the new feature export before native metadata mutation. Native header[6] reports nonmagic insertions. The wrapper maps immutable SIGS scratch through the actual unique/staged output columns and materializes before adoption, callbacks or await, including when an existing physical S1 array must be overwritten with a new magic word. Synchronous allocation/hook/trap failure follows the existing journal rollback. The legacy export retains its old pointer/marker contract.

## Interaction with merged #982

The original 14 changed paths remain the exact integration scope. All 19 optimized metadata method bodies are byte-identical to172; all other 13 changed files, including native code/assets and tests, are byte-identical. Every changed or new upstream non-constructor method remains byte-identical to a300. The sole shared edited method is constructor; independent upstream online-store/cache/resolver additions and our metadata representation fields merged without conflict.

The meaningful caller interaction is #982 broadening exact comparison to supported legacy Zstd representations and retaining online read contexts. Those new read, lease, root publication and cleanup methods are unchanged by this patch. Generic non-MBR6 signatures still materialize before mutation and use the unchanged triple comparison. The metadata prefix transparently materializes on a dictionary-name transition. No new cache, lease, await, I/O, publication or rollback path was added by the integration.

A source-level non-overlap proof cannot establish latest-source corpus behavior. The separate a300/5b profile must run its fixed full-output/allocation oracles and ordinary CI before those results are attributed to the latest integration. No old timing, memory or unit outcome is silently relabeled.

## Allocation limitation

This is not a universal allocation-neutral representation. A rare generic S1 materialization adds an external full-capacity Uint32 array. At some capacities the combination of that array and a page-rounded native arena can exceed the old integrated layout by less than one 64 KiB page. The qualified 4/4/1 MiB figures are the actual retained backings of the observed corpora; they do not prove browser peak/settled memory or import speed.

## Publication overlay

A temporary private Git-index overlay of the three roots from a2214153fc7bc239935d2b1852b22ad80184dbaf changed exactly85 helper/evidence paths and produced tree a3b79a0a20afdc32a7f836911eff547b89c98ac4. The complete ext and dev trees, runtime test fixture, package lock and dictionary lock remained identical to5b. No active worktree was changed.

Persistent receipts written before the execution outage:
- experiments/metadata-latest-982/source-manifest.json
- experiments/metadata-latest-982/source.patch
- experiments/metadata-latest-982/source-overlap.json
- experiments/metadata-latest-982/helper-overlay-proof.json

This note was completed through the cloud after the host became unavailable. No local build or test was run during this final review.
