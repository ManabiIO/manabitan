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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';
import {Backend} from '../ext/js/background/backend.js';
import {OffscreenProxy} from '../ext/js/background/offscreen-proxy.js';

const control = vi.hoisted(() => ({
    gate: /** @type {Promise<void>|null} */ (null),
    calls: 0,
    result: /** @type {unknown} */ ({title: 'Fixture'}),
    outcome: /** @type {unknown} */ (undefined),
    publishedReceipt: /** @type {import('dictionary-importer').ImportResult|null} */ (null),
    lastOperationId: /** @type {string|undefined} */ (undefined),
}));

vi.mock('../ext/js/core/log.js', () => ({log: {warn: vi.fn(), error: vi.fn()}}));
vi.mock('../ext/js/dictionary/dictionary-database.js', () => ({
    DictionaryDatabase: class {
        isPrepared() { return true; }
        async prepare() {}
        usesFallbackStorage() { return false; }
        getOpenStorageDiagnostics() { return null; }
        /**
         * @param {string} _operationId
         * @returns {import('dictionary-importer').ImportResult|null}
         */
        getPublishedDictionaryImport(_operationId) { return control.publishedReceipt; }
    },
}));
vi.mock('../ext/js/language/translator.js', () => ({
    Translator: class {
        prepare() {}
        clearDatabaseCaches() {}
    },
}));
vi.mock('../ext/js/dictionary/dictionary-importer-media-loader.js', () => ({DictionaryImporterMediaLoader: class {}}));
vi.mock('../ext/js/dictionary/dictionary-importer.js', () => ({
    DictionaryImporter: class {
        /**
         * @param {unknown} _loader
         * @param {unknown} _progress
         * @param {() => boolean} cancelled
         */
        constructor(_loader, _progress, cancelled) { this._cancelled = cancelled; }
        /**
         * @param {unknown} _database
         * @param {unknown} _archive
         * @param {import('dictionary-importer').ImportDetails} details
         * @returns {Promise<{result: unknown, errors: Error[], debug: null, outcome: unknown}>}
         */
        async importDictionary(_database, _archive, details) {
            ++control.calls;
            control.lastOperationId = details.operationId;
            await control.gate;
            if (this._cancelled()) { throw new Error('Import cancelled'); }
            return {result: control.result, errors: [], debug: null, outcome: control.outcome};
        }
    },
}));

/**
 * @param {string} name
 * @returns {string}
 */
function operationId(name) { return `${Date.now()}:${name}`; }

async function harness() {
    vi.stubGlobal('self', {addEventListener: vi.fn(), postMessage: vi.fn()});
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
    const worker = new OffscreenDictionaryWorkerHandler();
    let requestId = 0;
    /**
     * @param {string} id
     * @param {boolean} [deadPort]
     * @returns {{postMessage: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>}}
     */
    const submit = (id, deadPort = false) => {
        const port = {
            postMessage: vi.fn(() => {
                if (deadPort) { throw new Error('Port closed'); }
            }),
            close: vi.fn(),
        };
        Reflect.get(worker, '_onMessage').call(worker, /** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: ++requestId, action: 'importDictionaryOffscreen', params: {operationId: id, archiveContent: new Blob(['fixture']), details: {}}},
            ports: [(/** @type {unknown} */ (port))],
        })));
        return port;
    };
    /**
     * @param {string|undefined} id
     * @param {boolean} [lookupOnly]
     * @param {string|undefined} [workerGeneration]
     * @returns {Promise<import('offscreen').ImportOperationStatus>}
     */
    const query = (id, lookupOnly = true, workerGeneration) => /** @type {Promise<import('offscreen').ImportOperationStatus>} */ (
        Reflect.get(worker, '_invokeAction').call(worker, 'cancelDictionaryImportOffscreen', {operationId: id, lookupOnly, workerGeneration}, [])
    );
    const drain = () => /** @type {Promise<void>} */ (Reflect.get(worker, '_requestQueue'));
    return {worker, submit, query, drain};
}

afterEach(() => {
    control.gate = null;
    control.calls = 0;
    control.result = {title: 'Fixture'};
    control.outcome = undefined;
    control.publishedReceipt = null;
    control.lastOperationId = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('dictionary import operation ownership', () => {
    test('queued cancellation targets B and does not cancel A', async () => {
        const {worker, submit, query, drain} = await harness();
        let release = () => {};
        Reflect.set(worker, '_requestQueue', new Promise((resolve) => { release = resolve; }));
        const a = operationId('A');
        const b = operationId('B');
        const portA = submit(a);
        const portB = submit(b);
        expect(await query(a)).toMatchObject({operationId: a, state: 'queued'});
        expect(await query(b)).toMatchObject({operationId: b, state: 'queued'});
        await query(b, false);
        await query(operationId('unknown'), false);
        release();
        await drain();
        expect(portA.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'complete'}));
        expect(portB.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'}));
        expect(await query(a)).toMatchObject({state: 'completed', published: true});
        expect(await query(b)).toMatchObject({state: 'cancelled'});
    });

    test('cancelling active A or stale A never cancels subsequent B', async () => {
        const {submit, query, drain} = await harness();
        let release = () => {};
        control.gate = new Promise((resolve) => { release = resolve; });
        const a = operationId('A');
        const b = operationId('B');
        submit(a);
        await vi.waitFor(() => expect(control.calls).toBe(1));
        expect(await query(a)).toMatchObject({state: 'running'});
        const portB = submit(b);
        await query(undefined, false);
        await query(operationId('unknown'), false);
        expect(await query(a)).toMatchObject({state: 'running'});
        await query(a, false);
        release();
        await drain();
        await query(a, false);
        expect(await query(a)).toMatchObject({state: 'cancelled'});
        expect(await query(b)).toMatchObject({state: 'completed', published: true});
        expect(portB.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'complete'}));
    });

    test('retains completed publication on failed post and reconciles without replay', async () => {
        const {submit, query, drain} = await harness();
        const id = operationId('A');
        control.outcome = {status: 'published', generationId: 'durable-generation'};
        const port = submit(id, true);
        await drain();
        const status = await query(id);
        expect(status).toMatchObject({state: 'completed', published: true, result: {result: {title: 'Fixture'}, outcome: control.outcome}});
        expect(port.close).toHaveBeenCalledOnce();
        const api = /** @type {API} */ (Object.create(API.prototype));
        const lookup = vi.fn(() => query(id));
        Reflect.set(api, 'getDictionaryImportOperationStatus', lookup);
        const error = new Error('Response port delivery failed');
        error.name = 'DictionaryImportTransportError';
        const recovered = await Reflect.get(api, '_reconcileDictionaryImport').call(api, Promise.reject(error), id);
        expect(recovered).toEqual(status.result);
        expect(lookup).toHaveBeenCalledWith(id);
        expect(control.calls).toBe(1);
        expect(control.lastOperationId).toBe(id);
    });

    test('failed result is not published and durable aborted outcome is preserved', async () => {
        const {submit, query, drain} = await harness();
        const id = operationId('failed');
        control.result = null;
        control.outcome = {status: 'aborted'};
        submit(id);
        await drain();
        expect(await query(id)).toMatchObject({state: 'completed', published: false, result: {result: null, outcome: {status: 'aborted'}}});
    });

    test('an uncertain durable outcome remains unknown after lost delivery', async () => {
        const {submit, query, drain} = await harness();
        const id = operationId('uncertain');
        control.result = null;
        control.outcome = {status: 'unknown', warnings: ['Rollback could not be confirmed']};
        submit(id, true);
        await drain();
        const status = await query(id);
        expect(status).toMatchObject({state: 'unknown', outcome: control.outcome, result: {result: null, outcome: control.outcome}});
        expect(status.published).toBeUndefined();
        const api = /** @type {API} */ (Object.create(API.prototype));
        Reflect.set(api, 'getDictionaryImportOperationStatus', vi.fn(async () => status));
        const error = new Error('Lost response');
        error.name = 'DictionaryImportTransportError';
        await expect(Reflect.get(api, '_reconcileDictionaryImport').call(api, Promise.reject(error), id)).rejects.toThrow('outcome unknown');
        expect(control.calls).toBe(1);
    });

    test('pruning never drops queued or running ownership', async () => {
        const {submit, query, drain} = await harness();
        let release = () => {};
        control.gate = new Promise((resolve) => { release = resolve; });
        const a = operationId('A');
        const b = operationId('B');
        submit(a);
        submit(b);
        await vi.waitFor(() => expect(control.calls).toBe(1));
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
        expect(await query(a)).toMatchObject({state: 'running'});
        expect(await query(b)).toMatchObject({state: 'queued'});
        await query(b, false);
        release();
        await drain();
        expect(await query(a)).toMatchObject({state: 'completed'});
        expect(await query(b)).toMatchObject({state: 'cancelled'});
    });

    test('API recovers a failed terminal post through the real supervised response port', async () => {
        const {worker, query} = await harness();
        const api = /** @type {API} */ (Object.create(API.prototype));
        const id = operationId('A');
        Reflect.set(api, '_shutdownRejectors', new Set());
        Reflect.set(api, '_getPmTransportError', vi.fn(() => null));
        const statusLookup = vi.fn(() => query(id));
        Reflect.set(api, 'getDictionaryImportOperationStatus', statusLookup);
        const invoke = vi.fn((action, params, transfers) => {
            const transferred = structuredClone(transfers[0], {transfer: [transfers[0]]});
            const port = {
                /** @param {{type: string}} message */
                postMessage(message) {
                    if (message.type === 'complete') { throw new Error('Terminal delivery lost'); }
                    transferred.postMessage(message);
                },
                close() { transferred.close(); },
            };
            Reflect.get(worker, '_onMessage').call(worker, /** @type {MessageEvent} */ (/** @type {unknown} */ ({data: {id: 1, action, params}, ports: [port]})));
            return Promise.resolve();
        });
        Reflect.set(api, '_pmInvoke', invoke);
        const result = await api.importDictionaryOffscreen(new Blob(['fixture']), /** @type {import('dictionary-importer').ImportDetails} */ ({}), null, id, 'page-A');
        expect(result).toMatchObject({result: {title: 'Fixture'}, errors: []});
        expect(statusLookup).toHaveBeenCalledExactlyOnceWith(id);
        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke.mock.calls[0][1]).toMatchObject({operationId: id, ownerId: 'page-A'});
        expect(Reflect.get(api, '_shutdownRejectors').size).toBe(0);
        expect(control.calls).toBe(1);
    });

    test('invalid, duplicate and expired IDs reject without replay', async () => {
        const {submit, drain} = await harness();
        const id = operationId('A');
        submit(id);
        await drain();
        for (const invalid of [id, '', 'A', 'x'.repeat(129), `${Date.now() - 600001}:expired`]) {
            const port = submit(invalid);
            expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'}));
            expect(port.close).toHaveBeenCalledOnce();
        }
        expect(control.calls).toBe(1);
    });

    test('registry is bounded, terminal entries prune and expired IDs cannot replay', async () => {
        const {worker, submit, query, drain} = await harness();
        const first = operationId('first');
        submit(first);
        await drain();
        for (let i = 1; i < 128; ++i) { submit(operationId(`entry-${i}`)); }
        await drain();
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2);
        const overflow = submit(operationId('overflow'));
        await drain();
        expect(overflow.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'complete'}));
        expect(await query(first)).toMatchObject({state: 'unknown'});
        const replay = submit(first);
        expect(replay.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'}));
        expect(Reflect.get(worker, '_importOperations').size).toBe(128);
        const future = Date.now() + 600001;
        vi.spyOn(Date, 'now').mockReturnValue(future);
        expect(await query(first)).toMatchObject({state: 'unknown'});
        expect(Reflect.get(worker, '_importOperations').size).toBe(0);
        submit(first);
        expect(control.calls).toBe(129);
        submit(operationId('fresh'));
        await drain();
        expect(control.calls).toBe(130);
    });

    test('a mismatched worker generation is unknown without affecting ownership', async () => {
        const {submit, query, drain} = await harness();
        const id = operationId('A');
        submit(id);
        await drain();
        expect(await query(id, true, 'obsolete-worker')).toMatchObject({state: 'unknown'});
        expect(await query(id)).toMatchObject({state: 'completed'});
        expect(control.calls).toBe(1);
    });

    test.each(['queued', 'running'])('generation mismatch never reconciles an in-flight %s operation from summary metadata', async (state) => {
        const {worker, submit, query, drain} = await harness();
        let release = () => {};
        const gate = new Promise((resolve) => { release = () => resolve(void 0); });
        if (state === 'queued') {
            Reflect.set(worker, '_requestQueue', gate);
        } else {
            control.gate = gate;
        }
        const id = operationId('in-flight');
        submit(id);
        if (state === 'running') { await vi.waitFor(() => expect(control.calls).toBe(1)); }
        control.publishedReceipt = /** @type {import('dictionary-importer').ImportResult} */ (/** @type {unknown} */ ({
            result: {title: 'Fixture', importSuccess: true, storageImportOperationId: id, storageGenerationId: 'staged-generation'},
            errors: [],
            outcome: {status: 'published', generationId: 'staged-generation'},
        }));
        try {
            expect(await query(id, true, 'obsolete-worker')).toMatchObject({state: 'unknown'});
            expect(await query(id)).toMatchObject({state});
        } finally {
            control.publishedReceipt = null;
            release();
            await drain();
        }
    });

    test('restart and generation mismatch reconcile only an exact durable publication', async () => {
        const id = operationId('published');
        const oldWorker = await harness();
        oldWorker.submit(id);
        await oldWorker.drain();
        const oldGeneration = (await oldWorker.query(id)).workerGeneration;
        control.publishedReceipt = /** @type {import('dictionary-importer').ImportResult} */ (/** @type {unknown} */ ({
            result: {title: 'Fixture', importSuccess: true, storageImportOperationId: id, storageGenerationId: 'durable-generation'},
            errors: [],
            outcome: {status: 'published', generationId: 'durable-generation'},
        }));
        const restarted = await harness();
        const receipt = await restarted.query(id, true, oldGeneration);
        expect(receipt).toMatchObject({state: 'completed', published: true, result: control.publishedReceipt});
        expect(receipt.workerGeneration).not.toBe(oldGeneration);
        expect(await restarted.query(operationId('wrong-id'))).toMatchObject({state: 'unknown'});
        const duplicate = restarted.submit(id);
        await restarted.drain();
        expect(duplicate.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'}));
        expect(control.calls).toBe(1);
    });

    test('restart without an exact successful summary cannot claim abort or publication', async () => {
        const {query} = await harness();
        const id = operationId('aborted-before-restart');
        expect(await query(id)).toMatchObject({state: 'unknown'});
        expect(control.calls).toBe(0);
    });

    test.each(['queued', 'running', 'unknown'])('transport failure with %s status reports unknown, never retries', async (state) => {
        const api = /** @type {API} */ (Object.create(API.prototype));
        const id = operationId('A');
        Reflect.set(api, 'getDictionaryImportOperationStatus', vi.fn(async () => ({operationId: id, state})));
        const error = new Error('Lost response');
        error.name = 'DictionaryImportTransportError';
        await expect(Reflect.get(api, '_reconcileDictionaryImport').call(api, Promise.reject(error), id)).rejects.toThrow('outcome unknown');
        expect(control.calls).toBe(0);
    });

    test('duplicate rejection cannot recover an earlier completion as the new request', async () => {
        const api = /** @type {API} */ (Object.create(API.prototype));
        const lookup = vi.fn();
        Reflect.set(api, 'getDictionaryImportOperationStatus', lookup);
        await expect(Reflect.get(api, '_reconcileDictionaryImport').call(api, Promise.reject(new Error('Duplicate dictionary import operation ID')), operationId('A'))).rejects.toThrow('Duplicate');
        expect(lookup).not.toHaveBeenCalled();
    });

    test('stale page A cleanup and unowned cleanup cannot cancel page B', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const sendMessagePromise = vi.fn().mockResolvedValue(void 0);
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_dictionaryImportModeActive', true);
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A', 'page-B']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map([
            ['A', {ownerId: 'page-A', settled: true, cancelled: false}],
            ['B', {ownerId: 'page-B', settled: true, cancelled: false}],
        ]));
        Reflect.set(backend, '_offscreen', {sendMessagePromise});
        await backend._setDictionaryImportMode(false, 'page-A');
        await backend._setDictionaryImportMode(false, 'page-A');
        await backend._setDictionaryImportMode(false);
        expect(sendMessagePromise).toHaveBeenCalledExactlyOnceWith({action: 'cancelDictionaryImportOffscreen', params: {operationId: 'A'}});
        expect(Reflect.get(backend, '_dictionaryImportModeActive')).toBe(true);
        expect(Reflect.get(backend, '_ownedDictionaryImports').get('B')?.cancelled).toBe(false);
    });

    test('cancellation during offscreen handoff setup prevents late admission', async () => {
        const proxy = /** @type {OffscreenProxy} */ (Object.create(OffscreenProxy.prototype));
        let release = () => {};
        const gate = new Promise((resolve) => { release = () => resolve(void 0); });
        Reflect.set(proxy, '_ensureOffscreenPort', vi.fn(() => gate));
        Reflect.set(proxy, '_ensureOffscreenDocument', vi.fn().mockResolvedValue(void 0));
        Reflect.set(proxy, '_webExtension', {sendMessagePromise: vi.fn().mockResolvedValue({result: undefined})});
        Reflect.set(proxy, '_getMessageResponseResult', vi.fn());
        Reflect.set(proxy, '_currentOffscreenPort', {});
        const send = vi.fn();
        Reflect.set(proxy, '_sendOffscreenControlMessage', send);
        const id = operationId('A');
        const pending = proxy.sendMessageViaPort({action: 'importDictionaryOffscreen', params: {operationId: id, archiveContent: new Blob([]), details: /** @type {import('dictionary-importer').ImportDetails} */ ({})}}, []);
        const failure = expect(pending).rejects.toThrow('cancelled before runtime admission');
        await proxy.sendMessagePromise({action: 'cancelDictionaryImportOffscreen', params: {operationId: id}});
        release();
        await failure;
        expect(send).not.toHaveBeenCalled();
        expect(Reflect.get(proxy, '_pendingImportOperations').size).toBe(0);
    });

    test('status queries while handoff is pending are lookup-only and do not cancel', async () => {
        const proxy = /** @type {OffscreenProxy} */ (Object.create(OffscreenProxy.prototype));
        const id = operationId('A');
        const operation = {cancelled: false};
        Reflect.set(proxy, '_pendingImportOperations', new Map([[id, operation]]));
        Reflect.set(proxy, '_ensureOffscreenDocument', vi.fn().mockResolvedValue(void 0));
        Reflect.set(proxy, '_webExtension', {sendMessagePromise: vi.fn().mockResolvedValue({result: {state: 'unknown'}})});
        Reflect.set(proxy, '_getMessageResponseResult', vi.fn());
        await proxy.sendMessagePromise({action: 'cancelDictionaryImportOffscreen', params: {operationId: id, lookupOnly: true}});
        expect(operation.cancelled).toBe(false);
    });

    test.each(['url', 'port', 'runtime', 'prepare'])('backend releases ownership after a pre-admission %s failure', async (failure) => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map());
        Reflect.set(backend, '_offscreen', failure === 'prepare' ? {prepare: vi.fn().mockRejectedValue(new Error('Preparation failed'))} : null);
        Reflect.set(backend, '_localDictionaryRuntime', null);
        const details = /** @type {import('dictionary-importer').ImportDetails} */ ({});
        // Failures within one still-active settings session must not fill the 128-entry registry.
        for (let i = 0; i < 129; ++i) {
            const port = /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage: vi.fn(), close: vi.fn()}));
            const params = {operationId: operationId(`failure-${i}`), ownerId: 'page-A', details};
            await (failure === 'url' ?
                backend._onPmImportDictionaryUrlOffscreen({...params, url: ''}, [port]) :
                backend._onPmImportDictionaryOffscreen({...params, archiveContent: new Blob([])}, failure === 'port' ? [] : [port]));
            expect(Reflect.get(backend, '_ownedDictionaryImports').size).toBe(0);
        }
        expect(Reflect.get(backend, '_dictionaryImportOwners').has('page-A')).toBe(true);
    });

    test('backend retains ownership when runtime handoff may already have admitted an import', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A', 'page-B']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map());
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_offscreen', null);
        const error = new Error('Handoff acknowledgement lost');
        error.name = 'DictionaryImportTransportError';
        const cancel = vi.fn().mockResolvedValue(void 0);
        Reflect.set(backend, '_localDictionaryRuntime', {sendMessageViaPort: vi.fn().mockRejectedValue(error), sendMessagePromise: cancel});
        const port = /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage: vi.fn(), close: vi.fn()}));
        const id = operationId('uncertain-handoff');
        await backend._onPmImportDictionaryOffscreen({operationId: id, ownerId: 'page-A', archiveContent: new Blob([]), details: /** @type {import('dictionary-importer').ImportDetails} */ ({})}, [port]);
        expect(Reflect.get(backend, '_ownedDictionaryImports').get(id)).toMatchObject({settled: true, completed: false});
        await backend._setDictionaryImportMode(false, 'page-A');
        expect(cancel).toHaveBeenCalledExactlyOnceWith({action: 'cancelDictionaryImportOffscreen', params: {operationId: id}});
        expect(Reflect.get(backend, '_ownedDictionaryImports').size).toBe(0);
    });

    test('backend releases completed ownership after supervised dispatch, not before', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const id = operationId('A');
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map());
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', {
            /**
             * @param {unknown} _message
             * @param {MessagePort[]} ports
             * @returns {Promise<void>}
             */
            async sendMessageViaPort(_message, ports) {
                const transferred = structuredClone(ports[0], {transfer: [ports[0]]});
                expect(Reflect.get(backend, '_ownedDictionaryImports').get(id)?.settled).toBe(false);
                transferred.postMessage({type: 'complete', result: {result: {title: 'Fixture'}, errors: []}});
                transferred.close();
            },
        });
        const channel = new MessageChannel();
        const delivered = new Promise((resolve) => { channel.port1.onmessage = (event) => resolve(event.data); });
        const pending = backend._onPmImportDictionaryOffscreen({operationId: id, ownerId: 'page-A', archiveContent: new Blob([]), details: /** @type {import('dictionary-importer').ImportDetails} */ ({})}, [channel.port2]);
        const operation = Reflect.get(backend, '_ownedDictionaryImports').get(id);
        await pending;
        expect(await delivered).toMatchObject({type: 'complete'});
        expect(Reflect.get(backend, '_ownedDictionaryImports').size).toBe(0);
        expect(operation?.responseCleanup).toBeUndefined();
        channel.port1.close();
    });

    test('owner release closes only its abandoned relay and client response ports once', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const a = operationId('A');
        const b = operationId('B');
        const NativeMessageChannel = MessageChannel;
        const clientA = new NativeMessageChannel();
        const clientB = new NativeMessageChannel();
        const closeClientA = vi.spyOn(clientA.port2, 'close');
        const closeClientB = vi.spyOn(clientB.port2, 'close');
        /** @type {MessageChannel[]} */
        const relays = [];
        vi.stubGlobal('MessageChannel', class extends NativeMessageChannel {
            constructor() {
                super();
                relays.push(this);
                vi.spyOn(this.port1, 'close');
                vi.spyOn(this.port2, 'close');
            }
        });
        /** @type {MessagePort[]} */
        const transferredPorts = [];
        const cancellation = vi.fn().mockResolvedValue(void 0);
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A', 'page-B']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map());
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', {
            sendMessagePromise: cancellation,
            /**
             * @param {unknown} _message
             * @param {MessagePort[]} ports
             * @returns {Promise<void>}
             */
            async sendMessageViaPort(_message, ports) {
                transferredPorts.push(structuredClone(ports[0], {transfer: [ports[0]]}));
                // Handoff acknowledged, but no progress or terminal reply follows.
            },
        });
        /** @type {Array<[string, string, MessagePort]>} */
        const requests = [[a, 'page-A', clientA.port2], [b, 'page-B', clientB.port2]];
        for (const [id, ownerId, port] of requests) {
            await backend._onPmImportDictionaryOffscreen({operationId: id, ownerId, archiveContent: new Blob([]), details: /** @type {import('dictionary-importer').ImportDetails} */ ({})}, [port]);
        }
        const operationA = Reflect.get(backend, '_ownedDictionaryImports').get(a);
        const cleanupA = operationA?.responseCleanup;
        expect(cleanupA).toEqual(expect.any(Function));
        await backend._setDictionaryImportMode(false, 'page-A');
        await backend._setDictionaryImportMode(false, 'page-A');
        cleanupA?.();
        expect(relays[0].port1.close).toHaveBeenCalledOnce();
        expect(relays[0].port2.close).toHaveBeenCalledOnce();
        expect(closeClientA).toHaveBeenCalledOnce();
        expect(relays[0].port1.onmessage).toBeNull();
        expect(relays[0].port1.onmessageerror).toBeNull();
        expect(operationA?.responseCleanup).toBeUndefined();
        expect(relays[1].port1.close).not.toHaveBeenCalled();
        expect(relays[1].port2.close).not.toHaveBeenCalled();
        expect(closeClientB).not.toHaveBeenCalled();
        expect(Reflect.get(backend, '_ownedDictionaryImports').get(b)?.responseCleanup).toEqual(expect.any(Function));
        expect(cancellation).toHaveBeenCalledExactlyOnceWith({action: 'cancelDictionaryImportOffscreen', params: {operationId: a}});
        Reflect.get(backend, '_ownedDictionaryImports').get(b)?.responseCleanup?.();
        for (const port of transferredPorts) { port.close(); }
        clientA.port1.close();
        clientB.port1.close();
    });

    test('backend preserves cancelled admission token until an awaited handoff settles', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        const id = operationId('A');
        let release = () => {};
        const gate = new Promise((resolve) => { release = () => resolve(void 0); });
        const forward = vi.fn();
        Reflect.set(backend, '_dictionaryImportOwners', new Set(['page-A', 'page-B']));
        Reflect.set(backend, '_ownedDictionaryImports', new Map());
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_offscreen', {prepare: () => gate, sendMessageViaPort: forward, sendMessagePromise: vi.fn().mockResolvedValue(void 0)});
        const responsePort = /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage: vi.fn(), close: vi.fn()}));
        const pending = backend._onPmImportDictionaryOffscreen({operationId: id, ownerId: 'page-A', archiveContent: new Blob([]), details: /** @type {import('dictionary-importer').ImportDetails} */ ({})}, [responsePort]);
        await backend._setDictionaryImportMode(false, 'page-A');
        expect(Reflect.get(backend, '_ownedDictionaryImports').get(id)).toMatchObject({cancelled: true, settled: false});
        release();
        await pending;
        expect(forward).not.toHaveBeenCalled();
        expect(Reflect.get(backend, '_ownedDictionaryImports').size).toBe(0);
    });
});
