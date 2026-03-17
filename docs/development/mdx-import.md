# Experimental MDX Import Helper

Manabitan’s experimental MDX import flow converts `.mdx` and companion `.mdd` files into a normal Yomitan archive before import. The extension-side UI expects a native messaging host named `manabitan_mdx`, and the reference helper lives in [`dev/native/mdx-import/`](/Users/skerraut/Documents/manabitan/dev/native/mdx-import).

## What’s included

- [`mdx_to_yomitan.py`](/Users/skerraut/Documents/manabitan/dev/native/mdx-import/mdx_to_yomitan.py): converts `.mdx` plus optional `.mdd` resources into `index.json` + `term_bank_*.json` + extracted assets.
- [`native_host.py`](/Users/skerraut/Documents/manabitan/dev/native/mdx-import/native_host.py): a chunked native-messaging host that matches the browser-side protocol used by [`mdx.js`](/Users/skerraut/Documents/manabitan/ext/js/comm/mdx.js).

## Local setup

1. Create a Python environment and install the dependency used by the converter.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install pyglossary
```

2. Install a native host manifest named `manabitan_mdx`.

Example manifest:

```json
{
  "name": "manabitan_mdx",
  "description": "Manabitan experimental MDX converter",
  "path": "/absolute/path/to/python-wrapper.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<your-extension-id>/"]
}
```

3. Point the manifest `path` at a wrapper script that activates the environment and runs:

```bash
python /absolute/path/to/dev/native/mdx-import/native_host.py
```

4. Grant the extension the optional `nativeMessaging` permission, then reload the extension.

## Notes

- The helper is intentionally conservative: it targets Yomitan format 3 and keeps Manabitan’s existing importer/database pipeline untouched.
- During conversion, the host stages the uploaded `.mdx` and any matching `.mdd` files into a per-job workspace so PyGlossary can use its normal `FILE.mdd`, `FILE.1.mdd`, `FILE.2.mdd`, ... discovery rules.
- The settings UI also supports a best-effort follow-up folder picker when someone manually selects only an `.mdx` file. If the browser grants folder access, Manabitan scans that folder for matching companion resources before starting conversion.
- URL imports can now accept a direct `.mdx` URL or a simple HTML directory listing that exposes one `.mdx` file plus matching `.mdd` links, such as the `mdx.mdict.org` listing pages used in testing.
- Conversion failures for encrypted, unsupported-compression, or otherwise unsupported MDX variants are returned with structured error codes so the extension can show more actionable guidance than a raw Python traceback.
- The converter is a reference-quality skeleton, not a fully productized packager. Review the HTML rewriting, metadata mapping, and packaging paths against real-world MDX datasets before distributing it broadly.
