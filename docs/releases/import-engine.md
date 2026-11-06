# Dictionary engine update

This release improves dictionary import, lookup responsiveness, and recovery after interrupted imports. It also fixes legacy format-1 dictionary glossaries, malformed source-bank validation, and temporary storage or decompression failures that could incorrectly require a reimport.

## Upgrading an existing installation

Older dictionary storage formats need to be rebuilt. Keep your original dictionary ZIP files available before upgrading. Imported dictionary data is reset; dictionary names, available download sources, and dictionary-specific profile settings are retained so you can restore your setup.

1. Open **Settings > Dictionaries**.
2. Open each dictionary marked **Re-import required**.
3. Choose **Download again** when a download source is available, or **Choose file...** and select the original dictionary ZIP.
4. Wait for the import to finish, then verify a lookup. Repeat for the remaining affected dictionaries.

Your ordinary extension and Anki settings are retained. If a local dictionary has no download source, its original archive is required; a settings backup does not contain dictionary entries. Older format-1 imports that already contain malformed glossaries also need reimporting.

## Installation and updates

See the [installation instructions](../../README.md#installation) for the available browser packages.

The ZIP packages attached by the tag workflow are unsigned prerelease builds. A passing build or provenance attestation does not establish browser-store signing, normal end-user installation, or automatic updates. Those distribution paths require separate qualification.

Firefox for Android remains experimental. Automated checks exercise import, lookup, replacement, visible search, and mining in an actual Firefox Android runtime using temporary add-on installation. Signed distribution and ordinary installation/update delivery remain unqualified.

These changes have not established whole-import parity with Hoshidicts; no such performance claim is made.
