/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {log} from '../ext/js/core/log.js';
import {DictionaryWorker} from '../ext/js/dictionary/dictionary-worker.js';

class MockWorker {
    /** */
    constructor() {
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
        /** @type {Map<string, Set<EventListener>>} */
        this.listeners = new Map();
    }

    /**
     * @param {string} type
     * @param {EventListener} listener
     */
    addEventListener(type, listener) {
        let listeners = this.listeners.get(type);
        if (typeof listeners === 'undefined') {
            listeners = new Set();
            this.listeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    /**
     * @param {string} type
     * @param {EventListener} listener
     */
    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    /** @param {unknown} data */
    emitMessage(data) {
        const listeners = this.listeners.get('message');
        // Snapshot additions while respecting removals during dispatch, as DOM
        // events do. Iterating a live array skips listeners after a removal.
        const snapshot = [...(listeners ?? [])];
        for (const listener of snapshot) {
            if (listeners?.has(listener)) { listener(new MessageEvent('message', {data})); }
        }
    }
}

/** @returns {MockWorker[]} */
function installWorkerMock() {
    /** @type {MockWorker[]} */
    const workers = [];
    vi.stubGlobal('Worker', vi.fn(function mockWorker() {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
    }));
    return workers;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DictionaryWorker progress observer isolation', () => {
    test.each([[false, false], [false, true], [true, false], [true, true]])('a throwing progress observer cannot abort mutation (reuse=%s, logger fails=%s)', async (reuseWorker, loggerFails) => {
        const workers = installWorkerMock();
        const report = vi.spyOn(log, 'error').mockImplementation(() => {
            if (loggerFails) { throw new Error('Logger unavailable'); }
        });
        const client = new DictionaryWorker({reuseWorker});
        const failure = new Error('Detached settings view');
        const onProgress = vi.fn(() => { throw failure; });
        const pending = client.deleteDictionary('Test', onProgress);
        const worker = workers[0];

        expect(() => worker.emitMessage({action: 'progress', params: {args: ['progress']}})).not.toThrow();
        expect(onProgress).toHaveBeenCalledWith('progress');
        expect(report).toHaveBeenCalledWith(failure);
        expect(worker.terminate).not.toHaveBeenCalled();

        worker.emitMessage({action: 'complete', params: {result: undefined}});
        await expect(pending).resolves.toBeUndefined();
        expect(worker.terminate).toHaveBeenCalledTimes(reuseWorker ? 0 : 1);
        client.destroy();
    });
});

describe('DictionaryWorker lifecycle', () => {
    test.each([1, 3])('destroys all %i active non-reused workers', async (count) => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker();
        const rejected = vi.fn();
        const completed = vi.fn();
        const pending = Array.from({length: count}, () => client.getMdxVersion().then(completed, rejected));
        expect(workers).toHaveLength(count);

        client.destroy();
        await Promise.resolve();

        expect(rejected).toHaveBeenCalledTimes(count);
        expect(completed).not.toHaveBeenCalled();
        for (const [error] of rejected.mock.calls) {
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe('Dictionary worker destroyed');
        }
        for (const worker of workers) {
            expect(worker.terminate).toHaveBeenCalledExactlyOnceWith();
            expect([...worker.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
            worker.emitMessage({action: 'complete', params: {result: 99}});
        }
        client.destroy();
        for (const worker of workers) { expect(worker.terminate).toHaveBeenCalledTimes(1); }
        await Promise.all(pending);
    });

    test.each([false, true])('allows a fresh request after destruction (reuse=%s)', async (reuseWorker) => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const rejected = vi.fn();
        const first = client.getMdxVersion().catch(rejected);
        client.destroy();
        await Promise.resolve();
        expect(rejected).toHaveBeenCalledTimes(1);
        await first;

        const second = client.getMdxVersion();
        expect(workers).toHaveLength(2);
        workers[0].emitMessage({action: 'complete', params: {result: 99}});
        workers[1].emitMessage({action: 'complete', params: {result: 2}});
        await expect(second).resolves.toBe(2);
        client.destroy();
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    });

    test('destroys an idle reusable worker only once', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker: true});
        const pending = client.getMdxVersion();
        workers[0].emitMessage({action: 'complete', params: {result: 1}});
        await expect(pending).resolves.toBe(1);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        client.destroy();
        client.destroy();
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    });
});

describe.each([false, true])('DictionaryWorker malformed protocol messages (reuse=%s)', (reuseWorker) => {
    test.each([
        ['null message body', null],
        ['missing action', {}],
        ['unknown action', {action: 'unexpected', params: {}}],
        ['null progress parameters', {action: 'progress', params: null}],
        ['missing progress arguments', {action: 'progress', params: {}}],
    ])('rejects instead of stranding the caller for %s', async (_name, message) => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const rejected = vi.fn();
        const completed = vi.fn();
        const pending = client.getMdxVersion().then(completed, rejected);

        expect(() => workers[0].emitMessage(message)).not.toThrow();
        await Promise.resolve();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(completed).not.toHaveBeenCalled();
        expect(workers[0].terminate).toHaveBeenCalledExactlyOnceWith();
        expect([...workers[0].listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
        await pending;

        const next = client.getMdxVersion();
        expect(workers).toHaveLength(2);
        workers[1].emitMessage({action: 'complete', params: {result: 7}});
        await expect(next).resolves.toBe(7);
        client.destroy();
    });
});

describe.each([false, true])('DictionaryWorker completion decoding (reuse=%s)', (reuseWorker) => {
    test.each([
        ['null serialized error', {error: null}],
        ['null completion parameters', null],
        ['missing completion parameters', void 0],
    ])('rejects rather than stranding the caller for %s', async (_name, params) => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const rejected = vi.fn();
        const completed = vi.fn();
        const pending = client.getMdxVersion().then(completed, rejected);

        expect(() => workers[0].emitMessage({action: 'complete', params})).not.toThrow();
        await Promise.resolve();
        expect(rejected).toHaveBeenCalledTimes(1);
        expect(rejected.mock.calls[0][0]).toBeInstanceOf(TypeError);
        expect(completed).not.toHaveBeenCalled();
        expect(workers[0].listeners.get('message')?.size).toBe(0);
        await pending;
        client.destroy();
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    });

    test('preserves valid serialized errors and their data', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const error = new ExtensionError('import failed');
        error.data = {phase: 'write'};
        const pending = client.getMdxVersion();
        const assertion = expect(pending).rejects.toMatchObject({message: 'import failed', data: {phase: 'write'}});
        workers[0].emitMessage({action: 'complete', params: {error: ExtensionError.serialize(error)}});
        await assertion;
        client.destroy();
    });

    test('still rejects invalid formatted import results', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const pending = client.importDictionary(new ArrayBuffer(0), {}, null);
        const assertion = expect(pending).rejects.toBeInstanceOf(TypeError);
        workers[0].emitMessage({action: 'complete', params: {result: null}});
        await assertion;
        client.destroy();
    });

    test('can complete a later request after a decoding failure', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const rejected = vi.fn();
        const first = client.getMdxVersion().catch(rejected);
        expect(() => workers[0].emitMessage({action: 'complete', params: {error: null}})).not.toThrow();
        await first;
        expect(rejected).toHaveBeenCalledTimes(1);

        const second = client.getMdxVersion();
        const worker = workers[reuseWorker ? 0 : 1];
        worker.emitMessage({action: 'progress', params: {args: []}});
        worker.emitMessage({action: 'complete', params: {result: 7}});
        worker.emitMessage({action: 'complete', params: {result: 8}});
        await expect(second).resolves.toBe(7);
        client.destroy();
    });
});


describe('DictionaryWorker reusable request serialization', () => {
    test('keeps concurrent request completions correlated by admitting one at a time', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker: true});

        const first = client.getMdxVersion();
        const second = client.getMdxVersion();

        expect(workers).toHaveLength(1);
        expect(workers[0].postMessage).toHaveBeenCalledTimes(1);

        workers[0].emitMessage({action: 'complete', params: {result: 1}});
        await expect(first).resolves.toBe(1);
        await Promise.resolve();

        expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
        workers[0].emitMessage({action: 'complete', params: {result: 2}});
        await expect(second).resolves.toBe(2);

        client.destroy();
    });

    test('does not deliver progress to a queued invocation', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker: true});
        const firstProgress = vi.fn();
        const secondProgress = vi.fn();

        const first = client.importDictionary(new ArrayBuffer(0), {}, firstProgress);
        const second = client.importDictionary(new ArrayBuffer(0), {}, secondProgress);

        workers[0].emitMessage({action: 'progress', params: {args: ['first']}});
        expect(firstProgress).toHaveBeenCalledExactlyOnceWith('first');
        expect(secondProgress).not.toHaveBeenCalled();

        workers[0].emitMessage({
            action: 'complete',
            params: {result: {result: null, errors: [], debug: null}},
        });
        await first;
        await Promise.resolve();

        workers[0].emitMessage({action: 'progress', params: {args: ['second']}});
        expect(secondProgress).toHaveBeenCalledExactlyOnceWith('second');
        workers[0].emitMessage({
            action: 'complete',
            params: {result: {result: null, errors: [], debug: null}},
        });
        await second;

        client.destroy();
    });

    test('destroy rejects active and queued reusable requests without starting queued work', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker: true});
        const first = client.getMdxVersion();
        const second = client.getMdxVersion();

        expect(workers).toHaveLength(1);
        expect(workers[0].postMessage).toHaveBeenCalledTimes(1);

        client.destroy();

        await expect(first).rejects.toThrow('Dictionary worker destroyed');
        await expect(second).rejects.toThrow('Dictionary worker destroyed');
        expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
        expect(workers[0].terminate).toHaveBeenCalledExactlyOnceWith();

        const third = client.getMdxVersion();
        expect(workers).toHaveLength(2);
        workers[1].emitMessage({action: 'complete', params: {result: 3}});
        await expect(third).resolves.toBe(3);
        client.destroy();
    });

    test('continues the queue after a reusable request fails', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker: true});
        const first = client.getMdxVersion();
        const second = client.getMdxVersion();

        workers[0].emitMessage({action: 'complete', params: {error: null}});
        await expect(first).rejects.toBeInstanceOf(TypeError);
        await Promise.resolve();

        expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
        workers[0].emitMessage({action: 'complete', params: {result: 4}});
        await expect(second).resolves.toBe(4);
        client.destroy();
    });
});


describe('DictionaryWorker cleanup fault containment', () => {
    test.each([false, true])('registration failure retires the failed worker and permits retry (reuse=%s)', async (reuseWorker) => {
        const workers = installWorkerMock();
        const originalAdd = MockWorker.prototype.addEventListener;
        let failRegistration = true;
        const add = vi.spyOn(MockWorker.prototype, 'addEventListener').mockImplementation((type, listener) => {
            if (type === 'error' && failRegistration) {
                failRegistration = false;
                throw new Error('Listener registration failed');
            }
            originalAdd.call(workers[0], type, listener);
        });
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const client = new DictionaryWorker({reuseWorker});
        await expect(client.getMdxVersion()).rejects.toThrow('Listener registration failed');
        expect(Reflect.get(client, '_activeInvocations').size).toBe(0);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        add.mockRestore();
        const retry = client.getMdxVersion();
        expect(workers).toHaveLength(2);
        workers[1].emitMessage({action: 'complete', params: {result: 2}});
        await expect(retry).resolves.toBe(2);
        client.destroy();
    });

    test.each([false, true])('completion cleanup failure cannot strand a published result (reuse=%s)', async (reuseWorker) => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker({reuseWorker});
        const completed = vi.fn();
        const rejected = vi.fn();
        const pending = client.getMdxVersion().then(completed, rejected);
        const originalRemove = workers[0].removeEventListener;
        const removal = vi.spyOn(workers[0], 'removeEventListener').mockImplementation((type, listener) => {
            if (type === 'message') { throw new Error('Dead event target'); }
            originalRemove.call(workers[0], type, listener);
        });
        const report = vi.spyOn(log, 'error').mockImplementation(() => { throw new Error('Logger unavailable'); });
        expect(() => workers[0].emitMessage({action: 'complete', params: {result: 7}})).not.toThrow();
        await Promise.resolve();
        expect(completed).toHaveBeenCalledExactlyOnceWith(7);
        expect(rejected).not.toHaveBeenCalled();
        expect(removal.mock.calls.map(([type]) => type)).toEqual(['message', 'error', 'messageerror']);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalled();
        await pending;
        const retry = client.getMdxVersion();
        expect(workers).toHaveLength(2);
        workers[1].emitMessage({action: 'complete', params: {result: 9}});
        await expect(retry).resolves.toBe(9);
        client.destroy();
    });

    test('destroy settles every invocation even when cleanup of an earlier worker fails', async () => {
        const workers = installWorkerMock();
        const client = new DictionaryWorker();
        const rejected = vi.fn();
        const pending = [client.getMdxVersion().catch(rejected), client.getMdxVersion().catch(rejected)];
        vi.spyOn(workers[0], 'removeEventListener').mockImplementation(() => { throw new Error('Removal failed'); });
        workers[0].terminate.mockImplementation(() => { throw new Error('Termination failed'); });
        vi.spyOn(log, 'error').mockImplementation(() => {});
        expect(() => client.destroy()).not.toThrow();
        await Promise.resolve();
        expect(rejected).toHaveBeenCalledTimes(2);
        for (const [error] of rejected.mock.calls) { expect(error.message).toBe('Dictionary worker destroyed'); }
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(Reflect.get(client, '_activeInvocations').size).toBe(0);
        await Promise.all(pending);
    });
});
