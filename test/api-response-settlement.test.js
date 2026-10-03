/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';
import {CrossFrameAPIPort} from '../ext/js/comm/cross-frame-api.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';

function createApi() {
    /** @type {Array<(response: unknown) => void>} */
    const callbacks = [];
    const transport = {
        sendMessage: vi.fn((_message, callback) => { callbacks.push(callback); }),
        getLastError: vi.fn(() => /** @type {Error|null} */ (null)),
    };
    const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (transport)));
    return {api, transport, callbacks};
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('dictionary import asynchronous response settlement', () => {
    const kinds = /** @type {const} */ (['file', 'url']);

    /**
     * @param {((progress: import('dictionary-importer').ProgressData) => void)|null} onProgress
     * @returns {{
     *   api: API,
     *   port: Pick<MessagePort, 'onmessage'|'onmessageerror'> & {close: ReturnType<typeof vi.fn>},
     *   invoke: import('vitest').MockInstance<API['_pmInvoke']>,
     *   deliver: (data: unknown) => void,
     *   start: (kind: 'file'|'url') => Promise<unknown>,
     * }}
     */
    function createImport(onProgress) {
        const {api} = createApi();
        const port = {onmessage: /** @type {((event: MessageEvent) => void)|null} */ (null), onmessageerror: null, close: vi.fn()};
        vi.stubGlobal('MessageChannel', class {
            constructor() {
                this.port1 = port;
                this.port2 = {close: vi.fn()};
            }
        });
        vi.stubGlobal('navigator', {serviceWorker: {}});
        const invoke = vi.spyOn(api, '_pmInvoke').mockResolvedValue();
        /** @param {unknown} data */
        const deliver = (data) => { port.onmessage?.(new MessageEvent('message', {data})); };
        /**
         * @param {'file'|'url'} kind
         * @returns {Promise<unknown>}
         */
        const start = (kind) => {
            const details = /** @type {import('dictionary-importer').ImportDetails} */ ({});
            return kind === 'file' ?
                api.importDictionaryOffscreen(new Blob([]), details, onProgress, 'operation') :
                api.importDictionaryUrlOffscreen('https://example.com/dictionary.zip', details, onProgress, 'operation');
        };
        return {api, port, invoke, deliver, start};
    }

    describe.each(kinds)('%s import', (kind) => {
        test.each(['complete', 'error'])('malformed %s reply reconciles without throwing or retrying the mutation', async (type) => {
            vi.useFakeTimers();
            const {api, port, invoke, deliver, start} = createImport(null);
            const status = vi.spyOn(api, 'getDictionaryImportOperationStatus').mockResolvedValue({operationId: 'operation', workerGeneration: 'generation', state: 'completed', result: {result: {title: 'Published'}, errors: []}});
            const malformed = {hasValue: true, value: {toString: null, valueOf: null}};
            /** @type {Array<unknown>} */
            const outcomes = [];
            const pending = start(kind).then(
                (value) => { outcomes.push(value); },
                (error) => { outcomes.push(error); },
            );
            const data = type === 'complete' ? {type, result: {errors: [malformed]}} : {type, error: malformed};
            expect(() => { deliver(data); }).not.toThrow();
            await pending;
            expect(outcomes).toEqual([{result: {title: 'Published'}, errors: []}]);
            expect(status).toHaveBeenCalledExactlyOnceWith('operation');
            expect(invoke).toHaveBeenCalledTimes(1);
            expect(port.close).toHaveBeenCalledOnce();
            expect(api._shutdownRejectors.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            deliver({type: 'error', error: malformed});
            expect(outcomes).toHaveLength(1);
        });

        test('malformed reply with unavailable status reports an unknown outcome, never retries', async () => {
            vi.useFakeTimers();
            const {api, port, invoke, deliver, start} = createImport(null);
            vi.spyOn(api, 'getDictionaryImportOperationStatus').mockRejectedValue(new Error('worker unavailable'));
            const assertion = expect(start(kind)).rejects.toThrow('outcome unknown (operation); import was not retried');
            expect(() => { deliver({type: 'error', error: {hasValue: true, value: {toString: null, valueOf: null}}}); }).not.toThrow();
            await assertion;
            expect(invoke).toHaveBeenCalledTimes(1);
            expect(port.close).toHaveBeenCalledOnce();
            expect(api._shutdownRejectors.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        });

        test('throwing progress observer does not abandon a live import', async () => {
            vi.useFakeTimers();
            const {api, port, deliver, start} = createImport(() => { throw new Error('UI observer failed'); });
            const status = vi.spyOn(api, 'getDictionaryImportOperationStatus');
            const pending = start(kind);
            expect(() => { deliver({type: 'progress', progress: {index: 1, count: 2}}); }).not.toThrow();
            deliver({type: 'complete', result: {errors: []}});
            await expect(pending).resolves.toEqual({errors: []});
            expect(status).not.toHaveBeenCalled();
            expect(port.close).toHaveBeenCalledOnce();
            expect(api._shutdownRejectors.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        });

        test('valid worker error settles directly and preserves metadata', async () => {
            vi.useFakeTimers();
            const {api, port, deliver, start} = createImport(null);
            const status = vi.spyOn(api, 'getDictionaryImportOperationStatus');
            const assertion = expect(start(kind)).rejects.toMatchObject({name: 'ArchiveError', message: 'Invalid CRC', stack: 'worker stack', data: {bank: 'term_bank_1.json'}});
            deliver({type: 'error', error: {name: 'ArchiveError', message: 'Invalid CRC', stack: 'worker stack', data: {bank: 'term_bank_1.json'}}});
            await assertion;
            expect(status).not.toHaveBeenCalled();
            expect(port.close).toHaveBeenCalledOnce();
            expect(api._shutdownRejectors.size).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});

describe('cross-frame asynchronous response settlement', () => {
    test.each([null, {error: null}, {error: {hasValue: true, value: {toString: null, valueOf: null}}}])('malformed terminal payload %j rejects without stranding the invocation', async (data) => {
        vi.useFakeTimers();
        const port = new CrossFrameAPIPort(1, 2, /** @type {chrome.runtime.Port} */ (/** @type {unknown} */ ({postMessage: vi.fn()})), new Map());
        /** @type {Array<{value?: unknown, error?: unknown}>} */
        const outcomes = [];
        const pending = port.invoke('popupFactoryIsVisible', {id: 'popup'}, 1000, 2000)
            .then((value) => { outcomes.push({value}); }, (error) => { outcomes.push({error}); });
        port._onMessage({type: 'ack', id: 0});
        expect(() => { port._onMessage(/** @type {import('cross-frame-api').Message} */ (/** @type {unknown} */ ({type: 'result', id: 0, data}))); }).not.toThrow();
        await Promise.resolve();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].error).toBeInstanceOf(TypeError);
        await pending;
        expect(port._activeInvocations.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);

        const next = port.invoke('popupFactoryIsVisible', {id: 'popup'}, 1000, 2000);
        port._onMessage({type: 'ack', id: 1});
        port._onMessage({type: 'result', id: 1, data: {result: true}});
        await expect(next).resolves.toBe(true);
        expect(port._activeInvocations.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('API asynchronous response settlement', () => {
    test.each(['null-error', 'decoder-throws', 'last-error-throws'])('response failure is contained and leaves no stranded request: %s', async (fault) => {
        vi.useFakeTimers();
        const {api, transport, callbacks} = createApi();
        const error = new Error('Response decoding failed');
        if (fault === 'decoder-throws') {
            vi.spyOn(ExtensionError, 'deserialize').mockImplementationOnce(() => { throw error; });
        } else if (fault === 'last-error-throws') {
            transport.getLastError.mockImplementationOnce(() => { throw error; });
        }
        /** @type {Array<{value?: unknown, error?: unknown}>} */
        const outcomes = [];
        const pending = api.getDictionaryInfo()
            .then((value) => { outcomes.push({value}); }, (reason) => { outcomes.push({error: reason}); });
        // Browser delivery is asynchronous. A synchronous transport mock lets
        // sendMessage's outer catch mask exceptions from the response callback.
        expect(() => { callbacks[0]({error: fault === 'null-error' ? null : {name: 'Error', message: 'failure', stack: ''}}); }).not.toThrow();
        await Promise.resolve();
        expect(outcomes).toHaveLength(1);
        if (fault === 'null-error') {
            expect(outcomes[0].error).toBeInstanceOf(TypeError);
        } else {
            expect(outcomes[0].error).toBe(error);
        }
        await pending;
        expect(vi.getTimerCount()).toBe(0);
        expect(api._shutdownRejectors.size).toBe(0);

        callbacks[0]({result: []});
        const next = api.getDictionaryInfo();
        callbacks[1]({result: []});
        await expect(next).resolves.toEqual([]);
        expect(outcomes).toHaveLength(1);
        expect(api._shutdownRejectors.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        api.shutdownRuntimeConnections();
    });

    test('valid serialized errors keep their name, stack and metadata', async () => {
        vi.useFakeTimers();
        const {api, callbacks} = createApi();
        const pending = api.getDictionaryInfo();
        const assertion = expect(pending).rejects.toMatchObject({name: 'DatabaseUnavailable', message: 'OPFS temporarily unavailable', stack: 'recorded stack', data: {retryable: true}});
        callbacks[0]({error: {name: 'DatabaseUnavailable', message: 'OPFS temporarily unavailable', stack: 'recorded stack', data: {retryable: true}}});
        await assertion;
        expect(api._shutdownRejectors.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each([null, undefined, 42])('unexpected response %j rejects and releases ownership', async (response) => {
        vi.useFakeTimers();
        const {api, callbacks} = createApi();
        const pending = api.getDictionaryInfo();
        const assertion = expect(pending).rejects.toThrow('Unexpected');
        callbacks[0](response);
        await assertion;
        expect(api._shutdownRejectors.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('shutdown during response error inspection owns settlement over a late successful payload', async () => {
        vi.useFakeTimers();
        const {api, transport, callbacks} = createApi();
        transport.getLastError.mockImplementationOnce(() => {
            api.shutdownRuntimeConnections();
            return null;
        });
        const pending = api.getDictionaryInfo();
        const assertion = expect(pending).rejects.toThrow('Runtime connections have been shut down');
        callbacks[0]({result: []});
        await assertion;
        expect(api._shutdownRejectors.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
