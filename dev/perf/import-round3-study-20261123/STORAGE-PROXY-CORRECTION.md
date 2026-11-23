# Corrected reference-validation comparison

This fresh campaign compares the unchanged develop baseline with the corrected
reference-validation candidate. Both exact commits are recorded in
`candidates.json`. The runtime differences are limited to
`dictionary-database.js` and `term-record-opfs-store.js`.

The original #809 candidate could validate Proxy property descriptors while the
actual encoder read different reference columns. An actual-encoder witness
shows the baseline rejecting a malformed `NaN` offset, the original candidate
appending it, and the corrected candidate rejecting it before any append.
The original performance receipts remain preserved and describe only that
original source revision.

The correction uses a module-private origin map populated by a factory that
creates the chunk and reference object. It proves those objects' identity,
then checks their current columns and values for every synchronous run. It
does not cache validation across awaited appends. Unproven objects, Proxy
wrappers, replaced references, accessors and shared columns retain the generic
per-row validation. The real producer still reaches the consecutive-ID fast
path, with exact encoded bytes checked independently.

This study retains the already frozen timing driver, UI timing boundary,
pinned fixtures, source/package guards and complete restart readback. Each
corpus has two fixed 26-observation replications: eight adjacent counterbalanced
candidate pairs and four baseline A/A control pairs per replication, plus one
warmup per arm. All original results and failures are retained. There is no
process-memory sampling and no replacement of unfavorable observations.

Both semantic and physical probe results must match exactly between arms.
This new campaign qualifies the corrected source only; it does not retroactively
qualify the original Proxy behavior or reinterpret the old component timing.
