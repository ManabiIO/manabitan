# Anki note-type mapping compatibility

Manabitan maps existing Anki models; it does not install community note types. The production implementation is [`anki-note-type-field-util.js`](../../ext/js/data/anki-note-type-field-util.js), called when a model is selected in the Anki settings controller.

## Reviewed packages

On September 14, 2026, the compatibility workflow downloaded all four actual APKGs, verified their integrity, and extracted their complete model schemas. Kiku's package also includes an unrelated Basic model; the checker deliberately selects the known model rather than assuming the first model is the right one.

| Source | Reviewed revision | Model fields | Authoritative field documentation |
| --- | --- | --- | --- |
| [Kiku](https://github.com/youyoumu/kiku/releases/tag/v2.1.0) | v2.1.0 | 24 | [Installation](https://kiku.youyoumu.my.id/installation.html) |
| [Lapis](https://github.com/donkuri/lapis/releases/tag/1.7.0) | 1.7.0 | 22 | [Publisher's setup guide](https://github.com/donkuri/lapis#how-to-use-lapis) |
| [Senren](https://github.com/BrenoAqua/Senren/releases/tag/v5.1.0) | v5.1.0 | 22 | [Yomitan setup](https://brenoaqua.github.io/Senren/yomitan/) |
| [Crop Theft Vocab](https://github.com/Kuuuube/crop-theft/tree/88865e6209251b1baaaca7219be0dd6073e74cb8) | 88865e6209251b1baaaca7219be0dd6073e74cb8 | 9 | [Field setup](https://github.com/Kuuuube/crop-theft#field-setup) |

The first three revisions were the latest published stable releases at the check. Crop Theft publishes an APKG in its repository and has no numbered GitHub release; its latest mode resolves the current default branch to a commit before fetching the file.

[`contracts.json`](../../test/data/anki-note-types/contracts.json) records the package sources, reviewed hashes, and independently reviewed expected field values. [`upstream-snapshot.json`](../../test/data/anki-note-types/upstream-snapshot.json) retains only the actual extracted schemas and provenance, not decks, notes, templates, fonts, or media.

## Findings and changes

The [initial package run](https://github.com/ManabiIO/manabitan/actions/runs/34879349946) downloaded all four packages successfully before checking the old production mapping. It reproduced a real Kiku mismatch and a gap in the initial Senren field contract. Lapis and Crop Theft passed.

Kiku 2.1 uses `{sentence-furigana-plain}` for `SentenceFurigana`; Lapis 1.7 explicitly recommends leaving that field empty. The presets now have distinct identities and Kiku-specific overrides, while sharing the unchanged common field values. Kiku's `RelatedExpression` and `SentenceTranslation` remain explicitly blank. The renderer behavior in Kiku 2.1 is why this must not be treated as an interchangeable Lapis default.

The actual Senren 5.1 package contains `hint`, which is absent from the upstream Yomitan setup table. The reviewed contract and preset now explicitly leave it blank. Previously it happened to be blank through the unknown-field fallback; this was a coverage gap, not evidence of a broken hint generator. Senren's sentence `group` and target `highlight` wrappers remain intact.

The mapper also now defines own data properties for output fields. An Anki field named `__proto__` must survive enumeration and JSON serialization rather than invoking the inherited prototype setter. Regression tests also cover `constructor` and `hasOwnProperty`.

The [post-fix run](https://github.com/ManabiIO/manabitan/actions/runs/34880737480) passed both actual-package modes for all four types, 17 offline Node tests, 14 Python reader tests, and the original 7 mapper tests. Its lint step stopped while loading the repository configuration because generated template libraries were missing; the workflow subsequently added the normal `build:libs` prerequisite. Consult the current PR run for the latest overall workflow status rather than treating the historical run as fully green.

## Running the checks

Node 22 or newer is required. Offline mapping tests have no npm or network dependency:

```sh
node --test dev/tests/anki-note-type-compatibility.js
```

The package reader needs Python and zstandard. Use a virtual environment:

```sh
python -m venv .venv-anki
. .venv-anki/bin/activate
python -m pip install zstandard==0.25.0
python -m unittest discover -s dev/tests -p 'test_anki*.py' -v

python dev/anki-note-type-upstream.py --mode pinned --output builds/anki-pinned.json
node dev/anki-note-type-compatibility.js builds/anki-pinned.json

python dev/anki-note-type-upstream.py --mode latest --output builds/anki-latest.json
node dev/anki-note-type-compatibility.js builds/anki-latest.json
```

`GITHUB_TOKEN` is optional for public downloads but useful for GitHub API rate limits. CI supplies a read-only token. Authentication is sent only to the API host and removed on cross-host redirects.

For the original mapper tests and repository lint rules:

```sh
npm ci
npm run build:libs
npx vitest run test/anki-note-type-field-util.test.js
npx eslint ext/js/data/anki-note-type-field-util.js dev/anki-note-type-compatibility.js dev/tests/anki-note-type-compatibility.js
```

The normal development TypeScript configuration includes both new JavaScript tools. The dedicated workflow runs on relevant PRs; its weekly schedule and manual dispatch become available on the default branch after merge. Pinned and latest package checks run separately, so upstream availability does not get confused with an offline mapping regression.

## What these checks guarantee

The checker calls the production mapper with the field names and order read from the APKG. Every output value and overwrite mode must match the reviewed contract, including intentionally blank fields. Markers must exist in the production marker inventory or the controlled dynamic-marker fixture, and the identifying first field must map to the expression.

Negative controls prove that added, missing, renamed and duplicate fields, a changed first field, an incorrect mapping, missing or ambiguous models, duplicate reports, and failed downloads do not pass. An upstream field addition is reported for review even when the runtime mapper would leave it blank.

The Python tests cover legacy `col.models` metadata, modern `notetypes`/`fields` tables, compressed `collection.anki21b`, dummy legacy collections, corrupt collections, bounds, checksums, permitted URLs and release selection. The reader never imports the package into Anki or executes its templates. It limits downloaded and decompressed collection sizes, reads the database read-only, and does not fall back to a dummy legacy database when the real modern collection is corrupt.

## What still needs human review

A template can change behavior without changing field names. A passing field contract is not proof of card rendering, media playback, duplicate handling, AnkiConnect availability, or browser/device integration. Review publisher instructions and template changes when updating supported versions, then make a real test note with representative dictionaries and available media.

AnkiConnect's model name and field list do not reliably identify the community template's release. Current Kiku defaults target 2.1; old models called Kiku need an upgrade or a deliberately blank `SentenceFurigana`. Existing saved mappings are not rewritten automatically. For an existing Kiku format, change that field explicitly rather than cycling note types and risking customized mappings.

Preset model-name normalization is deliberately limited. Field names remain exact and case-sensitive, presets only apply to term formats, and unknown extra fields remain blank. Generic mappings preserve same-named values where possible but retain the existing initialization of overwrite modes to `coalesce`. Main-definition selection uses the first available single-glossary marker, not a promise about the user's preferred dictionary; no eligible marker means a blank field.

When a latest-package check fails, inspect the report and publisher's changes. Update the mapping, reviewed expected values, schema snapshot, version and hash together only after review. Never regenerate expected values from the production mapper or silently accept new fields just to turn the check green.
