from pathlib import Path
import sys

root = Path(sys.argv[1])
header = (root / 'ext/js/display/display-generator.js').read_text().split('import ')[0]
(root / 'test/web-asset-paths.test.js').write_text(header + r'''import {afterEach, describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DictionaryWorker} from '../ext/js/dictionary/dictionary-worker.js';

// Evaluate the actual production resource arguments under HTTP and extension
// module locations. This unit contract does not claim browser OPFS coverage.
/** @type {Array<[string, RegExp, string]>} */
const resources = [
    ['dictionary/dictionary-database.js', /new Worker\((.+), \{type: 'module'\}\)/, 'js/dictionary/dictionary-database-worker-main.js'],
    ['dictionary/dictionary-database.js', /initWasm\(fetch\((.+)\)\)/, 'lib/resvg.wasm'],
    ['dictionary/dictionary-database.js', /const font = await fetch\((.+)\);/, 'fonts/NotoSansJP-Regular.ttf'],
    ['dictionary/zstd-term-content.js', /await init\((.+)\);/, 'lib/zstd.wasm'],
    ['dictionary/zstd-term-content.js', /const response = await fetch\((.+)\);/, 'lib/zstd-dicts/jmdict.zdict'],
    ['dictionary/dictionary-importer.js', /deflate: \[(.+)\]/, 'lib/z-worker.js'],
    ['dictionary/dictionary-importer.js', /inflate: \[(.+)\]/, 'lib/z-worker.js'],
    ['display/display-generator.js', /loadFromFiles\(\[(.+)\]\)/, 'templates-display.html'],
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('relocatable dictionary assets', () => {
    test.each(['https://reader.example/vendor/manabitan/v1/', 'chrome-extension://test/', 'moz-extension://test/'])(
        'keeps resources within %s independently of the hosting page', (root) => {
            for (const [file, pattern, relative] of resources) {
                const source = readFileSync(new URL(`../ext/js/${file}`, import.meta.url), 'utf8');
                const match = source.match(pattern);
                if (match === null) { throw new Error(`Resource argument not found in ${file}`); }
                const expression = match[1].replaceAll('import.meta.url', JSON.stringify(`${root}js/${file}`));
                const actual = runInNewContext(expression, {URL});
                expect(new URL(actual, `${root}../../book/123`).href).toBe(`${root}${relative}`);
            }
        },
    );

    test('DictionaryWorker constructs its real module URL', async () => {
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const terminate = vi.fn();
        const worker = {
            addEventListener: vi.fn(/** @param {string} name @param {(event: MessageEvent) => void} listener */ (name, listener) => { listeners.set(name, listener); }),
            removeEventListener: vi.fn(), postMessage: vi.fn(), terminate,
        };
        const workerConstructor = vi.fn(function () { return worker; });
        vi.stubGlobal('Worker', workerConstructor);
        const client = new DictionaryWorker();
        const response = client.getMdxVersion();
        expect(workerConstructor).toHaveBeenCalledWith(new URL('../ext/js/dictionary/dictionary-worker-main.js', import.meta.url), {type: 'module'});
        const listener = listeners.get('message');
        if (typeof listener !== 'function') { throw new Error('Missing worker message listener'); }
        listener(new MessageEvent('message', {data: {action: 'complete', params: {result: 1}}}));
        await expect(response).resolves.toBe(1);
        expect(terminate).toHaveBeenCalledOnce();
    });
});
''')
if '--tests-only' in sys.argv:
    raise SystemExit(0)
replacements = {
    'ext/js/dictionary/dictionary-database.js': [
        ("new Worker('/js/dictionary/dictionary-database-worker-main.js', {type: 'module'})", "new Worker(new URL('./dictionary-database-worker-main.js', import.meta.url), {type: 'module'})"),
        ("initWasm(fetch('/lib/resvg.wasm'))", "initWasm(fetch(new URL('../../lib/resvg.wasm', import.meta.url)))"),
        ("fetch('/fonts/NotoSansJP-Regular.ttf')", "fetch(new URL('../../fonts/NotoSansJP-Regular.ttf', import.meta.url))"),
    ],
    'ext/js/dictionary/dictionary-worker.js': [("new Worker('/js/dictionary/dictionary-worker-main.js', {type: 'module'})", "new Worker(new URL('./dictionary-worker-main.js', import.meta.url), {type: 'module'})")],
    'ext/js/dictionary/zstd-term-content.js': [
        ("init('/lib/zstd.wasm')", "init(new URL('../../lib/zstd.wasm', import.meta.url).href)"),
        ("fetch('/lib/zstd-dicts/jmdict.zdict')", "fetch(new URL('../../lib/zstd-dicts/jmdict.zdict', import.meta.url))"),
    ],
    'ext/js/dictionary/dictionary-importer.js': [
        ("deflate: ['../../lib/z-worker.js']", "deflate: [new URL('../../lib/z-worker.js', import.meta.url).href]"),
        ("inflate: ['../../lib/z-worker.js']", "inflate: [new URL('../../lib/z-worker.js', import.meta.url).href]"),
    ],
    'ext/js/display/display-generator.js': [("this._templates.loadFromFiles(['/templates-display.html'])", "this._templates.loadFromFiles([new URL('../../templates-display.html', import.meta.url).href])")],
    'test/mdx-client.test.js': [("expect(worker?.url).toBe('/js/dictionary/dictionary-worker-main.js');", "expect(worker?.url).toEqual(new URL('../ext/js/dictionary/dictionary-worker-main.js', import.meta.url));")],
}
for file, pairs in replacements.items():
    path = root / file
    text = path.read_text()
    for before, after in pairs:
        if text.count(before) != 1:
            raise RuntimeError((file, before, text.count(before)))
        text = text.replace(before, after)
    path.write_text(text)
