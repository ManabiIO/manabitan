/*
 * Copyright (C) 2026  Yomitan Authors
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

import {describe, expect, test, vi} from 'vitest';

const {Backend} = await import('../ext/js/background/backend.js');

describe('Backend URL import progress', () => {
    test.each(['_localDictionaryRuntime', '_offscreen'])('forwards owned archive bytes into %s without a Blob clone', async (runtimeKey) => {
        const channel = new MessageChannel();
        const archive = new Uint8Array([80, 75, 5, 6]).buffer;
        /** @type {MessagePort[]} */
        const receivedPorts = [];
        const runtime = {
            prepare: vi.fn(async () => {}),
            sendMessageViaPort: vi.fn(async (message, transfers) => {
                const received = structuredClone({message, responsePort: transfers[0]}, {transfer: transfers});
                receivedPorts.push(received.responsePort);
                expect(archive.byteLength).toBe(0);
                expect([...new Uint8Array(received.message.params.archiveContent)]).toEqual([80, 75, 5, 6]);
            }),
        };
        const context = {_offscreen: null, _localDictionaryRuntime: null, [runtimeKey]: runtime};
        try {
            await Reflect.get(Backend.prototype, '_forwardDictionaryImportToRuntime').call(context, archive, {}, channel.port2);
            expect(runtime.sendMessageViaPort).toHaveBeenCalledOnce();
        } finally {
            for (const receivedPort of receivedPorts) { receivedPort.close(); }
            channel.port1.close();
            channel.port2.close();
        }
    });

    test('_onPmImportDictionaryUrlOffscreen reports download progress before forwarding to runtime', async () => {
        const responsePort = {
            postMessage: vi.fn(),
            close: vi.fn(),
        };
        const archiveBlob = new Blob(['dictionary']);
        const forwardDictionaryImportToRuntime = vi.fn(async () => {});
        const downloadDictionaryArchiveBlobViaXhr = vi.fn(async (_url, _timeoutMs, _onPhase, onProgress) => {
            onProgress?.(25, 100);
            onProgress?.(100, 100);
            return archiveBlob;
        });
        const context = /** @type {any} */ ({
            _lastDictionaryUrlImportDebug: null,
            _downloadDictionaryArchiveBlobViaXhr: downloadDictionaryArchiveBlobViaXhr,
            _forwardDictionaryImportToRuntime: forwardDictionaryImportToRuntime,
        });

        await Reflect.get(Backend.prototype, '_onPmImportDictionaryUrlOffscreen').call(
            context,
            {url: 'https://example.com/jitendex.zip', details: {}},
            [(/** @type {MessagePort} */ (/** @type {unknown} */ (responsePort)))],
        );

        expect(responsePort.postMessage).toHaveBeenNthCalledWith(1, {
            type: 'progress',
            progress: {nextStep: true, index: 0, count: 0},
        });
        expect(responsePort.postMessage).toHaveBeenNthCalledWith(2, {
            type: 'progress',
            progress: {nextStep: false, index: 25, count: 100},
        });
        expect(responsePort.postMessage).toHaveBeenNthCalledWith(3, {
            type: 'progress',
            progress: {nextStep: false, index: 100, count: 100},
        });
        expect(forwardDictionaryImportToRuntime).toHaveBeenCalledWith(archiveBlob, {}, responsePort);
        expect(responsePort.close).not.toHaveBeenCalled();
    });
});
