# Experimental MDX Import

Manabitan’s experimental MDX flow now converts `.mdx` and companion `.mdd` files directly in the extension, then hands the generated Yomitan archive to the normal importer. Drag-and-drop and file-picker imports do not require an MDX-specific native helper or an MDX-specific `nativeMessaging` permission prompt.

## Runtime flow

- [`mdx.js`](../../ext/js/comm/mdx.js) reads the selected `.mdx`/`.mdd` files, starts the browser worker, and keeps the existing `getVersion` / `getLocalVersion` / `convertDictionary` contract used by settings.
- [`mdx-worker-main.js`](../../ext/js/dictionary/mdx-worker-main.js) runs conversion off the UI thread.
- [`mdx-converter.js`](../../ext/js/dictionary/mdx/mdx-converter.js) parses MDX data, resolves `@@@LINK=` redirects, migrates HTML into structured content, rewrites asset/audio references, and packages a normal Yomitan archive.
- Vendored parser code under [`ext/js/dictionary/mdx/vendor/`](../../ext/js/dictionary/mdx/vendor/) is browser-adapted third-party code and intentionally kept out of the normal type/lint surface.

## What still lives in `dev/native/mdx-import/`

- [`mdx_to_yomitan.py`](../../dev/native/mdx-import/mdx_to_yomitan.py) remains the reference Python implementation for parity checks and development experiments.
- [`native_host.py`](../../dev/native/mdx-import/native_host.py) remains available as a non-runtime reference for the old native-host approach.

Those files are no longer part of the extension’s normal MDX import path.

## Local testing

1. Build or load the extension normally.
2. Open settings and import an `.mdx` file, optionally alongside matching `.mdd` files.
3. Verify the dictionary appears in the installed list, the settings preview resolves, and a search lookup returns glossary content.

The Playwright coverage for this lives in [`integration.spec.js`](../../test/playwright/integration.spec.js) and uses the local `読め` / `Read` MDX fixtures from [`test/data/dictionaries/`](../../test/data/dictionaries/).

## Notes

- `.mdd` files are optional unless the dictionary actually ships bundled media or images.
- URL import still accepts a direct `.mdx` URL or a simple HTML directory listing that exposes one `.mdx` file plus matching `.mdd` links.
- Unsupported, encrypted, or unhandled MDX variants should now fail with parser/converter errors instead of helper-install errors.
- The browser path currently targets the same experimental compatibility band as the old helper flow; it is not meant as a blanket promise for every MDX variant in the wild.
