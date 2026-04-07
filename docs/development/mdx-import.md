# Experimental MDX Import

Manabitan’s experimental MDX flow now imports `.mdx` and companion `.mdd` files directly in the extension. Drag-and-drop and file-picker imports do not require an MDX-specific native helper or an MDX-specific `nativeMessaging` permission prompt.

## Runtime flow

- [`dictionary-import-controller.js`](../../ext/js/pages/settings/dictionary-import-controller.js) groups `.mdx` / `.mdd` inputs, reports the existing settings-page upload progress, and sends raw MDX bytes to the dictionary worker without changing the UI flow.
- [`dictionary-worker.js`](../../ext/js/dictionary/dictionary-worker.js) and [`dictionary-worker-handler.js`](../../ext/js/dictionary/dictionary-worker-handler.js) expose the direct `importMdxDictionary` worker action and keep MDX imports on the same import-session path as ZIP imports.
- [`mdx-converter.js`](../../ext/js/dictionary/mdx/mdx-converter.js) parses MDX data, resolves `@@@LINK=` redirects, migrates HTML into structured content, rewrites asset/audio references, and materializes an in-memory dictionary file map for the importer.
- [`dictionary-importer.js`](../../ext/js/dictionary/dictionary-importer.js) consumes either ZIP-backed archive entries or the in-memory MDX file map through the same import pipeline.
- Vendored parser code under [`ext/js/dictionary/mdx/vendor/`](../../ext/js/dictionary/mdx/vendor/) is browser-adapted third-party code and intentionally kept out of the normal type/lint surface.

## What still lives in `dev/native/mdx-import/`

- [`mdx_to_yomitan.py`](../../dev/native/mdx-import/mdx_to_yomitan.py) remains the reference Python implementation for parity checks and development experiments.
- [`native_host.py`](../../dev/native/mdx-import/native_host.py) remains available as a non-runtime reference for the old native-host approach.

Those files are no longer part of the extension’s normal MDX import path, and runtime MDX imports no longer go through a generated intermediate ZIP archive.

## Local testing

1. Build or load the extension normally.
2. Open settings and import an `.mdx` file, optionally alongside matching `.mdd` files.
3. Verify the dictionary appears in the installed list, the settings preview resolves, and a search lookup returns glossary content.

The Playwright coverage for this lives in [`integration.spec.js`](../../test/playwright/integration.spec.js) and uses the local `読め` / `Read` MDX fixtures from [`test/data/dictionaries/`](../../test/data/dictionaries/).

## Notes

- `.mdd` files are optional unless the dictionary actually ships bundled media or images.
- URL import still accepts a direct `.mdx` URL or a simple HTML directory listing that exposes one `.mdx` file plus matching `.mdd` links.
- Unsupported, encrypted, or unhandled MDX variants should fail with parser/import errors instead of helper-install errors.
- The browser path currently targets the same experimental compatibility band as the old helper flow; it is not meant as a blanket promise for every MDX variant in the wild.
