# Serialized web-client deadline repair

Follow-up to aggregate #65. Production baseline: `54ac62a39386459b7822fc644e5a1a6b1a619619`.

## Invariant

One Worker dispatches requests serially. Only its oldest transport-pending request owns execution time. A queued request has no independent permission to terminate that owner. A terminal response advances the watchdog; queued cancellation/busy responses cannot reset it. Cancelling a nonmutating caller rejects that caller immediately but retains its transport record until acknowledgement. Mutation cancellation still waits for the real committed/rolled-back outcome. The independent whole-close deadline remains bounded.

Do not change the worker to concurrent dispatch without changing this client contract. Progress does not extend the active operation's hard deadline. No import parser, database, sidecar, journal, or wire-protocol behavior changed.

## Evidence

- Tests-first commit: `92e4b80f537586cfa18f82a814d32cd7b232385f`.
- Behavioral fix: `adeaa2d3ea302e9edf86070a8f20f70ede156068`.
- Repository-format follow-up: `7b84ba5190a321fdebca76ddc9e049a9c02017b1`.
- The identical 11-case harness fails seven named assertions on baseline and passes all cases with the fix. It compiles actual client/protocol source and substitutes only Worker and timers. `test/web-client-deadline.test.js` invokes it through the normal suite.
- Initial-fix CI run `35489227179`: unit, all TypeScript jobs, build, Chromium extension E2E, Firefox extension E2E, HTML/CSS/JSON/Markdown passed. JavaScript lint failed and prompted the format-only follow-up. Edge and Firefox Android were skipped.
- Initial-fix static web acceptance run `35489227216`: passed.
- Full checks must be rerun on the final formatted head. Earlier runs are not automatically final-head evidence.

Commands: `npm ci`, `npm run build:libs`, `node web/client-deadline-check.mjs`, and the repository's regular CI suite. Building the generated libraries is required before ESLint imports its configuration.

## Acceptance still separate

The synthetic timer suite is not a real dictionary import benchmark. Retain real web-runtime import/recovery evidence and do not treat skipped Edge as qualification. Reader UI integration, final backend/frontend deployment pairing, Apple platform behavior, and signed native CloudKit are outside this client-only repair. No performance percentage or universal browser compatibility is claimed.
