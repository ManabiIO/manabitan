# Merged review repair: web request admission

Baseline: develop / aggregate #65, `54ac62a39386459b7822fc644e5a1a6b1a619619`.

The worker dispatches operations serially. The old client nevertheless armed a 30-second status/lookup watchdog at submission, including while a valid 15-minute import owned the worker. That waiting request could terminate a progressing import.

The client now owns a bounded FIFO admission queue (32 waiting requests), dispatches one ordinary request at a time, and arms its existing timeout only at dispatch. Cancelling a queued request does not touch the worker. Cancelling a running read rejects its caller but retains the owner/watchdog until the terminal reply; an import/delete continues reporting the actual commit outcome. Close is deliberately out-of-band, rejects waiting work, and bounds cancellation/drain to 60 seconds. The importer, SQL engine, journal, and worker protocol are unchanged.

## Executed locally

Node 22.16.0, Linux, TypeScript transpilation of the complete real client/protocol, controlled Worker boundary and virtual timers.

- Both progressing-import/queued-status and progressing-import/queued-lookup methods fail behaviorally against the unchanged baseline client: 2 failures, 0 cancellations/skips.
- Current source: 9 methods pass, 0 failures/cancellations/skips. Includes queue bounds, queued/running cancellation, active stall, cancellation-after-commit and bounded/idempotent close.
- These are not real dictionary runtime measurements, browser/OPFS qualification or whole-project type/lint results. No performance percentage is claimed.

Run: `node --test web/test/client-admission.test.mjs`.

To repeat paired red: export the baseline client's exact source to a file, then run `MANABITAN_CLIENT_BASELINE=/path/client.ts node --test --test-name-pattern='queued (status|lookup)' web/test/client-admission.test.mjs`.

The permanent read-only workflow executes these tests and web TypeScript. Before release, run real Chromium and Firefox/Edge web runtime coverage on the exact aggregate with this fix: long import with queued lookup/status, cancellation before/after commit, close, restart recovery and second-tab handoff. Historical aggregate #65 results do not automatically qualify this head.
