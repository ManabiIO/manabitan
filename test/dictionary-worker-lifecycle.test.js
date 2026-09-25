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
    vi.stubGlobal('Worker', vi.fn(() => {
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
