from pathlib import Path

path = Path('test/offscreen-proxy-bridge.test.js')
text = path.read_text()
old = """        globalThis.chrome = /** @type {typeof globalThis.chrome} */ ({runtime: {lastError: undefined}});\n"""
new = """        globalThis.chrome = /** @type {typeof globalThis.chrome} */ (/** @type {unknown} */ ({\n            runtime: {\n                lastError: undefined,\n                getURL: vi.fn(() => 'chrome-extension://test/offscreen.html'),\n                getContexts: vi.fn().mockResolvedValue([{}]),\n            },\n            offscreen: {\n                createDocument: vi.fn().mockResolvedValue(void 0),\n            },\n        }));\n"""
if text.count(old) != 1:
    raise SystemExit(f'expected one bridge beforeEach fixture, got {text.count(old)}')
path.write_text(text.replace(old, new, 1))
