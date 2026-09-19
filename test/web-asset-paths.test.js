/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
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
    test.each(['https://reader.example/vendor/manabitan/v1/', 'chrome-extension://test/', 'moz-extension://test/'])('keeps resources within %s independently of the hosting page', (root) => {
        for (const [file, pattern, relative] of resources) {
            const source = readFileSync(new URL(`../ext/js/${file}`, import.meta.url), 'utf8');
            const match = source.match(pattern);
            if (match === null) { throw new Error(`Resource argument not found in ${file}`); }
            const expression = match[1].replaceAll('import.meta.url', JSON.stringify(`${root}js/${file}`));
            const actual = runInNewContext(expression, {URL});
            expect(new URL(actual, `${root}../../book/123`).href).toBe(`${root}${relative}`);
        }
    });

    test('DictionaryWorker constructs its real module URL', async () => {
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const terminate = vi.fn();
        const worker = {
            addEventListener: vi.fn(/**
                                     * @param {string} name
                                     * @param {(event: MessageEvent) => void} listener
                                     */ (name, listener) => { listeners.set(name, listener); },
            ),
            removeEventListener: vi.fn(),
            postMessage: vi.fn(),
            terminate,
        };
        const workerConstructor = vi.fn(function createWorker() { return worker; });
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
