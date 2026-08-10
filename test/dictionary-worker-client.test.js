/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const reportDiagnostics = vi.fn();
vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({reportDiagnostics}));

const {DictionaryWorkerClient} = await import('../ext/js/background/dictionary-worker-client.js');
const {
    dictionaryRuntimeActionNames,
    dictionaryRuntimeActionPolicies,
    getDictionaryRuntimeActionPolicy,
    hasDictionaryRuntimeActionPolicy,
} = await import('../ext/js/background/dictionary-runtime-action-policy.js');

class FakeWorker {
    /** @type {FakeWorker[]} */
    static instances = [];
    /** @type {number} */
    static constructorFailuresRemaining = 0;

    constructor() {
        if (FakeWorker.constructorFailuresRemaining > 0) {
            --FakeWorker.constructorFailuresRemaining;
            throw new Error('Worker construction failed');
        }
        /** @type {Map<string, Function[]>} */
        this.listeners = new Map();
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
        FakeWorker.instances.push(this);
    }

    /**
     * @param {string} type
     * @param {Function} listener
     */
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    /**
     * @param {string} type
     * @param {Record<string, unknown>} event
     */
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener({...event, currentTarget: this});
        }
    }
}

describe('dictionary runtime action policies', () => {
    test('cover the complete worker action surface', () => {
        expect([...dictionaryRuntimeActionNames].sort()).toEqual([
            'cancelDictionaryImportOffscreen',
            'clearDatabaseCachesOffscreen',
            'connectToDatabaseWorker',
            'databaseGetMediaOffscreen',
            'databasePrepareOffscreen',
            'databasePurgeOffscreen',
            'databaseRefreshOffscreen',
            'databaseSetSuspendedOffscreen',
            'debugDictionaryLookupStateOffscreen',
            'debugDictionaryStorageStateOffscreen',
            'deleteDictionaryOffscreen',
            'findKanjiOffscreen',
            'findTermsBulkOffscreen',
            'findTermsOffscreen',
            'findTermsStructuredOffscreen',
            'getDatabaseRuntimeStateOffscreen',
            'getDictionaryCountsOffscreen',
            'getDictionaryInfoOffscreen',
            'getDictionaryTermProbeOffscreen',
            'getTermFrequenciesOffscreen',
            'importDictionaryOffscreen',
            'replaceDictionaryTitleOffscreen',
            'translatorPrepareOffscreen',
            'warmTermLookupCachesOffscreen',
        ].sort());
        for (const action of dictionaryRuntimeActionNames) {
            expect(hasDictionaryRuntimeActionPolicy(action)).toBe(true);
            expect(dictionaryRuntimeActionPolicies[action]).toMatchObject({
                concurrency: expect.any(String),
                timeoutClass: expect.any(String),
                retryable: expect.any(Boolean),
                requiresDatabase: expect.any(Boolean),
            });
        }
    });

    test('limits automatic retry and lookup concurrency to interactive reads', () => {
        const retryableActions = dictionaryRuntimeActionNames.filter((action) => getDictionaryRuntimeActionPolicy(action).retryable);
        const lookupActions = dictionaryRuntimeActionNames.filter((action) => getDictionaryRuntimeActionPolicy(action).concurrency === 'lookup');
        expect(retryableActions.sort()).toEqual([
            'findKanjiOffscreen',
            'findTermsOffscreen',
            'findTermsStructuredOffscreen',
            'getTermFrequenciesOffscreen',
        ].sort());
        expect(lookupActions.sort()).toEqual(retryableActions.sort());
    });
});

describe('DictionaryWorkerClient', () => {
    beforeEach(() => {
        FakeWorker.instances = [];
        FakeWorker.constructorFailuresRemaining = 0;
        vi.stubGlobal('Worker', FakeWorker);
        reportDiagnostics.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('restarts and retries an interactive lookup once after timeout', async () => {
        vi.useFakeTimers();
        const client = new DictionaryWorkerClient('/dictionary-worker.js', {context: 'Test worker'});
        const promise = client.invoke('findTermsOffscreen', {text: '日本'});
        const firstWorker = FakeWorker.instances[0];

        await vi.advanceTimersByTimeAsync(30_000);
        const secondWorker = FakeWorker.instances[1];
        expect(firstWorker.terminate).toHaveBeenCalledOnce();
        expect(secondWorker).toBeDefined();
        expect(secondWorker.postMessage).toHaveBeenCalledWith(
            {id: 2, action: 'findTermsOffscreen', params: {text: '日本'}},
            [],
        );

        secondWorker.emit('message', {data: {id: 2, result: {ok: true}}});
        await expect(promise).resolves.toEqual({ok: true});
        expect(reportDiagnostics).toHaveBeenCalledWith('dictionary-worker-request-retry', expect.objectContaining({
            action: 'findTermsOffscreen',
            attempt: 2,
        }));
    });

    test('stops after one failed lookup retry', async () => {
        vi.useFakeTimers();
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const promise = client.invoke('findKanjiOffscreen', {text: '日'});
        const expectation = expect(promise).rejects.toThrow(/findKanjiOffscreen.*30000ms/);

        await vi.advanceTimersByTimeAsync(60_000);
        await expectation;
        expect(FakeWorker.instances).toHaveLength(2);
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
        expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce();
    });

    test('never retries a timed-out mutation', async () => {
        vi.useFakeTimers();
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const promise = client.invoke('deleteDictionaryOffscreen', {dictionaryTitle: 'Test'});
        const expectation = expect(promise).rejects.toThrow(/deleteDictionaryOffscreen.*300000ms/);

        await vi.advanceTimersByTimeAsync(300_000);
        await expectation;
        expect(FakeWorker.instances).toHaveLength(1);
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    });

    test('does not retry a structured application error', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const promise = client.invoke('findTermsOffscreen', {text: '日本'});
        FakeWorker.instances[0].emit('message', {
            data: {id: 1, error: {name: 'Error', message: 'Invalid lookup options', stack: ''}},
        });

        await expect(promise).rejects.toThrow('Invalid lookup options');
        expect(FakeWorker.instances).toHaveLength(1);
    });

    test('does not retry a request that cannot be serialized', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        FakeWorker.instances[0].postMessage.mockImplementationOnce(() => {
            throw new DOMException('Value could not be cloned', 'DataCloneError');
        });

        await expect(client.invoke('findTermsOffscreen', {text: '日本'})).rejects.toThrow('failed to send findTermsOffscreen');
        expect(FakeWorker.instances).toHaveLength(1);
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    });

    test('does not replay a mutation rejected by a shared worker failure', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const lookupPromise = client.invoke('findTermsOffscreen', {text: '日本'});
        const mutationPromise = client.invoke('deleteDictionaryOffscreen', {dictionaryTitle: 'Test'});
        const mutationExpectation = expect(mutationPromise).rejects.toThrow('crashed');

        FakeWorker.instances[0].emit('error', {message: 'crashed'});
        await mutationExpectation;
        await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
        FakeWorker.instances[1].emit('message', {data: {id: 3, result: {ok: true}}});
        await expect(lookupPromise).resolves.toEqual({ok: true});
        expect(FakeWorker.instances[1].postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({action: 'deleteDictionaryOffscreen'}),
            expect.anything(),
        );
    });

    test('can recover on a later request after worker recreation throws', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const failedLookup = client.invoke('findTermsOffscreen', {text: '日本'});
        FakeWorker.constructorFailuresRemaining = 1;
        FakeWorker.instances[0].emit('error', {message: 'crashed'});
        await expect(failedLookup).rejects.toThrow('could not be restarted');

        const recoveredLookup = client.invoke('findTermsOffscreen', {text: '日本'});
        expect(FakeWorker.instances).toHaveLength(2);
        FakeWorker.instances[1].emit('message', {data: {id: 2, result: {ok: true}}});
        await expect(recoveredLookup).resolves.toEqual({ok: true});
    });

    test('ignores a late response from a terminated worker generation', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const promise = client.invoke('findTermsOffscreen', {text: '日本'});
        const firstWorker = FakeWorker.instances[0];
        firstWorker.emit('error', {message: 'crashed'});
        await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));

        firstWorker.emit('message', {data: {id: 1, result: {stale: true}}});
        expect(reportDiagnostics).not.toHaveBeenCalledWith('dictionary-worker-unmatched-response', expect.anything());
        FakeWorker.instances[1].emit('message', {data: {id: 2, result: {ok: true}}});
        await expect(promise).resolves.toEqual({ok: true});
    });

    test('restarts after a malformed response instead of waiting for timeout', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const promise = client.invoke('findTermsOffscreen', {text: '日本'});
        FakeWorker.instances[0].emit('message', {data: {result: {invalid: true}}});

        await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
        expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
        FakeWorker.instances[1].emit('message', {data: {id: 2, result: {ok: true}}});
        await expect(promise).resolves.toEqual({ok: true});
    });

    test('restarts after an invalid serialized error response', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        const promise = client.invoke('findTermsOffscreen', {text: '日本'});
        FakeWorker.instances[0].emit('message', {data: {id: 1, error: null}});

        await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
        FakeWorker.instances[1].emit('message', {data: {id: 2, result: {ok: true}}});
        await expect(promise).resolves.toEqual({ok: true});
    });

    test('isolates failures in the fatal-error observer', async () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js', {
            onFatalError: () => { throw new Error('Observer failed'); },
        });
        const promise = client.invoke('deleteDictionaryOffscreen', {dictionaryTitle: 'Test'});
        FakeWorker.instances[0].emit('error', {message: 'crashed'});

        await expect(promise).rejects.toThrow('crashed');
        expect(reportDiagnostics).toHaveBeenCalledWith('dictionary-worker-fatal-callback-failed', expect.objectContaining({
            message: 'Observer failed',
        }));
    });

    test('consumes one-way acknowledgements without unmatched-response diagnostics', () => {
        const client = new DictionaryWorkerClient('/dictionary-worker.js');
        client.post('importDictionaryOffscreen', {archiveContent: null}, []);
        FakeWorker.instances[0].emit('message', {data: {id: 1, result: undefined}});

        expect(reportDiagnostics).not.toHaveBeenCalledWith('dictionary-worker-unmatched-response', expect.anything());
    });
});
