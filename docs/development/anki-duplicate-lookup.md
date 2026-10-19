# Anki duplicate lookup

Duplicate note IDs must use the same first-field identity as Anki. A named-field search can also match a secondary field or a case-only variant, and can miss HTML-equivalent first fields. IDs returned by this lookup drive View and Overwrite actions.

The client resolves note type IDs through `modelNamesAndIds` and uses Anki’s native `dupe:<note-type-id>,<first-field-value>` search. All-model scope combines one native duplicate query per note type. Deck and child-deck restrictions remain part of each query. Values are quoted with backslash and quote escaping; `*`, `_`, `:`, and commas remain literal duplicate text. The query does not implement HTML normalization or checksums in JavaScript.

The supported release baseline is maintained AnkiConnect with its supported Anki Desktop versions. [AnkiConnect currently requires Anki Desktop 26.08 or later](https://git.sr.ht/~foosoft/anki-connect/blob/master/README.md), and retains the legacy API used by this client. The AnkiConnect API version is not the Anki Desktop version.

Anki 2.1.38–2.1.40 has different backslash handling in native duplicate searches and is outside this qualification boundary. Do not add a guessed alternate escape or an HTML-entity substitution: either can change duplicate identity. Supporting these historical parsers requires a separately verified design. No application-version capability is inferred from the API version.

Native query acceptance and matching have been checked against the Anki 26.08 and 26.9.3 Rust backends in disposable collections, including cross-model first fields, case, HTML, literal characters, deck scopes and ordinary misses. This engine evidence is separate from mocked browser save-flow tests; neither establishes a complete installation/update test with an external Anki Desktop process.

The shared Anki mock supports only the generated query subset and bounded HTML fixtures. Its results cannot substitute for native search-engine verification.
