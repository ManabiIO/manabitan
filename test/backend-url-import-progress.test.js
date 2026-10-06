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

import {afterEach, describe, expect, test, vi} from 'vitest';

const {Backend} = await import('../ext/js/background/backend.js');

/** @typedef {import('dictionary-importer').ImportDetails} ImportDetails */

class PendingArchiveRequest {
    static HEADERS_RECEIVED = 2;
    /** @type {PendingArchiveRequest[]} */
    static instances = [];
    /** @type {(() => void)|null} */
    onload = null;
    /** @type {(() => void)|null} */
    onerror = null;
    /** @type {(() => void)|null} */
    onabort = null;
    /** @type {(() => void)|null} */
    ontimeout = null;
    /** @type {((event: ProgressEvent) => void)|null} */
    onprogress = null;
    /** @type {(() => void)|null} */
    onreadystatechange = null;
    readyState = 1;
    status = 200;
    response = new Blob(['dictionary']);
    open = vi.fn();
    send = vi.fn();
    abort = vi.fn(() => { this.onabort?.(); });
    getResponseHeader = vi.fn(() => null);
    constructor() { PendingArchiveRequest.instances.push(this); }
}

afterEach(() => {
    PendingArchiveRequest.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Backend URL import progress', () => {
    test('closing one settings owner aborts only its pending archive download and prevents admission', async () => {
        vi.stubGlobal('XMLHttpRequest', PendingArchiveRequest);
        const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A', 'page-B']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map());
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', {sendMessagePromise: vi.fn().mockResolvedValue(void 0)});
        const forward = vi.fn().mockResolvedValue(void 0);
        Reflect.set(backend, '_forwardDictionaryImportToRuntime', forward);
        const port = () => /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage: vi.fn(), close: vi.fn()}));
        const portA = port();
        const portB = port();
        const params = {url: 'https://example.com/dictionary.zip', details: /** @type {ImportDetails} */ ({})};
        const pendingA = backend._onPmImportDictionaryUrlOffscreen({...params, operationId: 'download-A', ownerId: 'page-A'}, [portA]);
        const pendingB = backend._onPmImportDictionaryUrlOffscreen({...params, operationId: 'download-B', ownerId: 'page-B'}, [portB]);
        const [requestA, requestB] = PendingArchiveRequest.instances;
        await backend._setDictionaryImportMode(false, 'page-A');
        const stopped = requestA.abort.mock.calls.length === 1;
        // Always drain the old implementation too so a red test cannot leak pending work.
        if (!stopped) { requestA.onerror?.(); }
        requestB.onload?.();
        await Promise.all([pendingA, pendingB]);
        expect(stopped).toBe(true);
        expect(requestB.abort).not.toHaveBeenCalled();
        expect(forward).toHaveBeenCalledExactlyOnceWith(requestB.response, {}, portB, 'download-B', 'page-B');
        expect(portA.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'}));
        expect(portA.close).toHaveBeenCalledOnce();
        expect(Reflect.get(backend, '_ownedDictionaryImports').has('download-A')).toBe(false);
        expect(Reflect.get(backend, '_ownedDictionaryImports').get('download-B')?.downloadAbortController).toBeUndefined();
    });

    test.each(['success', 'failure', 'abort'])('archive download removes its abort listener after %s', async (outcome) => {
        vi.stubGlobal('XMLHttpRequest', PendingArchiveRequest);
        const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const pending = Reflect.get(backend, '_downloadDictionaryArchiveBlobViaXhr').call(backend, 'https://example.com/dictionary.zip', 120_000, vi.fn(), undefined, controller.signal);
        const observed = outcome === 'success' ? expect(pending).resolves.toBeInstanceOf(Blob) : expect(pending).rejects.toThrow();
        const [request] = PendingArchiveRequest.instances;
        if (outcome === 'success') { request.onload?.(); }
        if (outcome === 'failure') { request.onerror?.(); }
        if (outcome === 'abort') { controller.abort(); }
        // Drain the unmodified downloader without hanging the red test.
        if (outcome === 'abort' && request.abort.mock.calls.length === 0) { request.onerror?.(); }
        await observed;
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(request.onload).toBeNull();
        expect(request.onerror).toBeNull();
        expect(request.onabort).toBeNull();
        controller.abort();
        expect(request.abort).toHaveBeenCalledTimes(outcome === 'abort' ? 1 : 0);
    });

    test('an already-cancelled download never sends a request', async () => {
        vi.stubGlobal('XMLHttpRequest', PendingArchiveRequest);
        const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
        const controller = new AbortController();
        controller.abort();
        const pending = Reflect.get(backend, '_downloadDictionaryArchiveBlobViaXhr').call(backend, 'https://example.com/dictionary.zip', 120_000, vi.fn(), undefined, controller.signal);
        const [request] = PendingArchiveRequest.instances;
        const sent = request?.send.mock.calls.length ?? 0;
        // Drain an uncancelled baseline request before asserting.
        request?.onerror?.();
        await expect(pending).rejects.toThrow();
        expect(sent).toBe(0);
    });

    test('a synchronous send failure detaches download handlers and cancellation', async () => {
        vi.stubGlobal('XMLHttpRequest', class extends PendingArchiveRequest {
            constructor() {
                super();
                this.send.mockImplementation(() => { throw new Error('Request could not be sent'); });
            }
        });
        const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        await expect(Reflect.get(backend, '_downloadDictionaryArchiveBlobViaXhr').call(backend, 'https://example.com/dictionary.zip', 120_000, vi.fn(), undefined, controller.signal)).rejects.toThrow('Request could not be sent');
        const [request] = PendingArchiveRequest.instances;
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(request.onload).toBeNull();
        expect(request.onerror).toBeNull();
        expect(request.onabort).toBeNull();
        controller.abort();
        expect(request.abort).not.toHaveBeenCalled();
    });

    test('_onPmImportDictionaryOffscreen does not throw when error delivery to a dead response port fails', async () => {
        const responsePort = {
            postMessage: vi.fn(() => {
                throw new Error('response port is closed');
            }),
            close: vi.fn(() => {
                throw new Error('response port close failed');
            }),
        };
        const responsePorts = /** @type {MessagePort[]} */ (/** @type {unknown} */ ([responsePort]));
        const context = /** @type {any} */ ({
            _registerDictionaryImportOwner: vi.fn(),
            _settleDictionaryImportOwnership: vi.fn(),
            _forwardDictionaryImportToRuntime: vi.fn(async () => {
                throw new Error('dictionary runtime unavailable');
            }),
        });

        await expect(Reflect.get(Backend.prototype, '_onPmImportDictionaryOffscreen').call(
            context,
            {operationId: `${Date.now()}:file`, archiveContent: new Blob(['dictionary']), details: /** @type {ImportDetails} */ (/** @type {unknown} */ ({}))},
            responsePorts,
        )).resolves.toBeUndefined();

        expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
        }));
        expect(responsePort.close).toHaveBeenCalledTimes(1);
    });

    test('_onPmImportDictionaryUrlOffscreen reports download progress before forwarding to runtime', async () => {
        const responsePort = {
            postMessage: vi.fn(),
            close: vi.fn(),
        };
        const responsePorts = /** @type {MessagePort[]} */ (/** @type {unknown} */ ([responsePort]));
        const archiveBlob = new Blob(['dictionary']);
        const forwardDictionaryImportToRuntime = vi.fn(async () => {});
        const downloadDictionaryArchiveBlobViaXhr = vi.fn(async (_url, _timeoutMs, _onPhase, onProgress) => {
            onProgress?.(25, 100);
            onProgress?.(100, 100);
            return archiveBlob;
        });
        const context = /** @type {any} */ ({
            _registerDictionaryImportOwner: vi.fn(),
            _settleDictionaryImportOwnership: vi.fn(),
            _lastDictionaryUrlImportDebug: null,
            _downloadDictionaryArchiveBlobViaXhr: downloadDictionaryArchiveBlobViaXhr,
            _forwardDictionaryImportToRuntime: forwardDictionaryImportToRuntime,
        });

        await Reflect.get(Backend.prototype, '_onPmImportDictionaryUrlOffscreen').call(
            context,
            {operationId: 'url-operation', url: 'https://example.com/jitendex.zip', details: /** @type {ImportDetails} */ (/** @type {unknown} */ ({}))},
            responsePorts,
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
        expect(forwardDictionaryImportToRuntime).toHaveBeenCalledWith(archiveBlob, {}, responsePort, 'url-operation', undefined);
        expect(responsePort.close).not.toHaveBeenCalled();
    });

    test('_onPmImportDictionaryUrlOffscreen treats download progress as best effort', async () => {
        const responsePort = {
            postMessage: vi.fn(() => {
                throw new Error('response port is closed');
            }),
            close: vi.fn(),
        };
        const responsePorts = /** @type {MessagePort[]} */ (/** @type {unknown} */ ([responsePort]));
        const archiveBlob = new Blob(['dictionary']);
        const forwardDictionaryImportToRuntime = vi.fn(async () => {});
        const downloadDictionaryArchiveBlobViaXhr = vi.fn(async (_url, _timeoutMs, _onPhase, onProgress) => {
            onProgress?.(50, 100);
            return archiveBlob;
        });
        const context = /** @type {any} */ ({
            _registerDictionaryImportOwner: vi.fn(),
            _settleDictionaryImportOwnership: vi.fn(),
            _lastDictionaryUrlImportDebug: null,
            _downloadDictionaryArchiveBlobViaXhr: downloadDictionaryArchiveBlobViaXhr,
            _forwardDictionaryImportToRuntime: forwardDictionaryImportToRuntime,
        });

        await Reflect.get(Backend.prototype, '_onPmImportDictionaryUrlOffscreen').call(
            context,
            {operationId: 'url-operation', url: 'https://example.com/jitendex.zip', details: /** @type {ImportDetails} */ (/** @type {unknown} */ ({}))},
            responsePorts,
        );

        expect(responsePort.postMessage).toHaveBeenCalledTimes(2);
        expect(forwardDictionaryImportToRuntime).toHaveBeenCalledWith(archiveBlob, {}, responsePort, 'url-operation', undefined);
        expect(responsePort.close).not.toHaveBeenCalled();
    });
});
