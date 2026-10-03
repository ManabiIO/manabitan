# Dictionary Runtime Contracts

## Publication and Health

SQLite metadata and OPFS storage have one runtime owner. Import publication keeps
the existing journal and storage-finalization order. A successful metadata commit
assigns `storageGenerationId` from the owning import session. Display titles and
physical storage names are not publication identities.

Durable `dictionaryStorageHealth` rows bind to that generation. A replacement
moves the old title to its recovery title and the staging title to the final title
in one metadata transaction, including health and auxiliary rows. Runtime mappings
publish after commit; old physical storage cleanup is best effort. Existing record
formats do not change. Legacy unbound health can apply only to legacy summaries,
not summaries with a new publication identity.

Completed updates retain their explicit `updateSessionToken` completion receipt
without `transientUpdateStage`. Startup restoration clears the interrupted
operation's token instead of reporting it as a successfully completed update.

## Request Ownership and Outcomes

Settings sessions have owner IDs; each import has a separate operation ID.
Cancellation targets an operation, never an ambient active import or queue slot.
Releasing one settings owner cannot cancel another owner's work. Response relays
are closed on completion, failure, or owner release.

The bounded worker receipt registry supports response reconciliation without
replaying a mutation. Successful publication also persists the operation ID in
the committed summary, permitting exact reconciliation after a worker restart.
A title match alone is insufficient. Deleted or superseded receipts and
unconfirmed rollbacks remain `unknown`; they must not be reported as confirmed
failure or retried automatically. Post-publication housekeeping failures are
warnings, not failed imports.

The owning SQLite connection can see staged summaries before commit. Durable
receipt queries therefore return no publication while its import transaction is
open. A stale-worker query for an operation still queued or running in the current
worker stays `unknown`; it must not adopt staged metadata as a completion receipt.

## Lookup Availability and Repair

Interactive term lookup uses `repairMode: 'background'`. Maintenance callers may
explicitly await repair. Repairs are single-flight per dictionary, serialized
across dictionaries, generation-fenced, cooperatively cancellable, and joined
before destructive storage mutation. Transient failures use bounded backoff.

An unavailable dictionary cannot contribute an ordinary cached miss. Query caches
and readiness markers retire together on health transitions. Record accessors
decode only requested cached UTF-8 keys; complete record reads never depend on
JavaScript index construction or warmup. Terms responses carry
`dictionaryAvailability` when results may be incomplete, including healthy
sibling results. Lookup-owned observations survive repair finishing before the
response is delivered. Search and hover preserve that status, avoid speculative
shortening, and allow a later hover at the same source to retry.

Confirmed authoritative damage requests reimport. Repair or transient filesystem
failure instead reports temporary unavailability. Neither silently appears as
"No results". Availability notifications belong to the current display token.

## Media Readiness

Database readiness does not require SVG WASM or fonts. The SVG renderer prepares
those resources lazily with retryable single-flight initialization. Raster media
does not depend on that initialization. Rendering owns native handles and copies
pixels before freeing or transferring them; failure does not poison term lookup.

## Implementation References

- [Database publication and health](../../ext/js/dictionary/dictionary-database.js)
- [Record availability and repair](../../ext/js/dictionary/term-record-opfs-store.js)
- [Import operation ownership](../../ext/js/background/offscreen-dictionary-worker.js)
- [Lazy media rendering](../../ext/js/dictionary/dictionary-media-renderer.js)
