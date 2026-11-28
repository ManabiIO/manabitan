/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryRuntimeWorkerProxy, OffscreenProxy} from '../ext/js/background/offscreen-proxy.js';
import {termContentOptimizationNotificationId, TermContentOptimizationControl} from '../ext/js/background/term-content-optimization-control.js';
import {API} from '../ext/js/comm/api.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {log} from '../ext/js/core/log.js';
import {TermContentIdleScheduler} from '../ext/js/dictionary/term-content-idle-scheduler.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/** @typedef {(signal: AbortSignal) => Promise<{pending: boolean, retryAt?: number}>} RunStep */

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('self', {postMessage: vi.fn(), addEventListener: vi.fn()});
    vi.spyOn(log, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {number} revision
 * @param {string[]} ownerIds
 * @param {boolean} [ready]
 * @returns {import('offscreen').TermContentOptimizationState}
 */
function state(revision, ownerIds, ready = true) {
    return {sessionId: 'backend-one', revision, ownerIds, ready};
}

async function workerFixture() {
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js');
    const worker = new OffscreenDictionaryWorkerHandler();
    const runStep = vi.fn(async (/** @type {AbortSignal} */ _signal) => ({pending: false}));
    const scheduler = new TermContentIdleScheduler({runStep: /** @type {RunStep} */ (/** @type {unknown} */ (runStep)), idleMs: 10});
    scheduler.setHold('!backend-startup', true);
    Reflect.set(worker, '_termContentIdleScheduler', scheduler);
    let prepared = false;
    const database = {
        isPrepared: () => prepared,
        prepare: vi.fn(async () => { prepared = true; }),
        close: vi.fn(async () => { prepared = false; }),
        purge: vi.fn(async () => { prepared = false; }),
        usesFallbackStorage: () => false,
        getOpenStorageDiagnostics: () => null,
        getDictionaryInfo: vi.fn(async () => []),
        warmTermLookupCaches: vi.fn(async () => {}),
    };
    const translator = {prepare: vi.fn(), clearDatabaseCaches: vi.fn(), findTerms: vi.fn(async () => ({}))};
    Reflect.set(worker, '_dictionaryDatabase', database);
    Reflect.set(worker, '_translator', translator);
    /**
     * @param {string} action
     * @param {import('core').SerializableObject} [params]
     */
    const send = async (action, params = {}) => {
        worker._onMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({data: {id: 1, action, params}, ports: []})));
        await Reflect.get(worker, '_requestQueue');
        await Promise.allSettled(Reflect.get(worker, '_activeConcurrentLookupPromises'));
    };
    return {worker, scheduler, runStep, database, translator, send};
}

function backendFixture() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const snapshots = /** @type {import('offscreen').TermContentOptimizationState[]} */ ([]);
    const sendMessagePromise = vi.fn(async (/** @type {import('offscreen').ApiMessageAny} */ _message) => {});
    const setTermContentOptimizationState = vi.fn((/** @type {import('offscreen').TermContentOptimizationState} */ snapshot) => { snapshots.push(snapshot); });
    const refresh = vi.fn(async () => {});
    Object.assign(backend, {
        _setDictionaryImportModePromise: null,
        _dictionaryImportModeActive: false,
        _dictionaryImportOwners: new Set(),
        _ownedDictionaryImports: new Map(),
        _pendingDatabaseUpdatedNotifications: [],
        _deferredDictionaryRefreshDuringImport: false,
        _dictionaryDatabasePreparePromise: null,
        _offscreen: {sendMessagePromise, setTermContentOptimizationState},
        _localDictionaryRuntime: null,
        _translator: {clearDatabaseCaches: vi.fn()},
        _clearTextParseCache: vi.fn(),
        _ensureDictionaryDatabaseReady: vi.fn(async () => {}),
        _refreshDictionaryDatabaseAfterUpdate: refresh,
        _clearDictionaryRefreshRetry: vi.fn(),
        _scheduleDictionaryRefreshRetry: vi.fn(),
        _sendApplicationDatabaseUpdated: vi.fn(),
        _termContentOptimizationReady: true,
    });
    return {backend, snapshots, sendMessagePromise, refresh};
}

test('database readiness cannot release backend startup/options readiness', async () => {
    const {worker, scheduler, runStep} = await workerFixture();
    try {
        await worker._ensureDatabasePrepared();
        worker._applyTermContentOptimizationState(state(1, [], false));
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).not.toHaveBeenCalled();
        worker._applyTermContentOptimizationState(state(2, []));
        await vi.advanceTimersByTimeAsync(9);
        expect(runStep).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runStep).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
});

test('long archive acquisition and two owners remain held until both frontend completions', async () => {
    const {worker, scheduler, runStep} = await workerFixture();
    const {backend, snapshots} = backendFixture();
    try {
        await worker._ensureDatabasePrepared();
        await backend._setDictionaryImportMode(true, 'page-a');
        await backend._setDictionaryImportMode(true, 'page-b');
        worker._applyTermContentOptimizationState(snapshots.at(-1));
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).not.toHaveBeenCalled();
        await backend._setDictionaryImportMode(false, 'page-a', true);
        await backend._setDictionaryImportMode(false, 'page-a');
        worker._applyTermContentOptimizationState(snapshots.at(-1));
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).not.toHaveBeenCalled();
        await backend._setDictionaryImportMode(false, 'page-b', true);
        worker._applyTermContentOptimizationState(snapshots.at(-1));
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).not.toHaveBeenCalled();
        await backend._setDictionaryImportMode(false, 'page-b');
        worker._applyTermContentOptimizationState(snapshots.at(-1));
        await vi.advanceTimersByTimeAsync(10);
        expect(runStep).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
});

test('an undelivered optimizer wake cannot delay import transitions and stale holds stay retired', async () => {
    const {worker, scheduler, runStep} = await workerFixture();
    const {backend, snapshots, sendMessagePromise} = backendFixture();
    const lostDelivery = deferPromise();
    sendMessagePromise.mockImplementation(async () => { await lostDelivery.promise; });
    /** @param {import('offscreen').TermContentOptimizationState|undefined} optimizationState */
    const deliverNotification = (optimizationState) => {
        worker._onMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: termContentOptimizationNotificationId, optimizationState}, ports: [],
        })));
    };
    try {
        await worker._ensureDatabasePrepared();
        const entering = backend._setDictionaryImportMode(true, 'page-a');
        await vi.advanceTimersByTimeAsync(0);
        expect(sendMessagePromise).not.toHaveBeenCalled();
        await entering;
        const held = snapshots.at(-1);
        // Ordinary requests carry this snapshot even when the wake is lost.
        worker._applyTermContentOptimizationState(held);
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).not.toHaveBeenCalled();

        const exiting = backend._setDictionaryImportMode(false, 'page-a');
        await vi.advanceTimersByTimeAsync(0);
        expect(sendMessagePromise).not.toHaveBeenCalled();
        await exiting;
        const released = snapshots.at(-1);
        expect(released?.ownerIds).toEqual([]);
        deliverNotification(released);
        deliverNotification(held);
        expect(self.postMessage).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10);
        expect(runStep).toHaveBeenCalledOnce();

        const replacement = await workerFixture();
        try {
            await replacement.worker._ensureDatabasePrepared();
            replacement.worker._applyTermContentOptimizationState(released);
            await vi.advanceTimersByTimeAsync(10);
            expect(replacement.runStep).toHaveBeenCalledOnce();
        } finally { await replacement.scheduler.close(); }
    } finally {
        lostDelivery.resolve(void 0);
        await scheduler.close();
    }
});

test('backend refresh longer than idle and frontend pending publication both retain the hold', async () => {
    const {backend, snapshots, refresh} = backendFixture();
    const gate = deferPromise();
    await backend._setDictionaryImportMode(true, 'page-a');
    refresh.mockImplementationOnce(async () => { await gate.promise; });
    const exiting = backend._setDictionaryImportMode(false, 'page-a', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshots.at(-1)?.ownerIds).toEqual(['page-a']);
    gate.resolve(void 0);
    await exiting;
    expect(snapshots.at(-1)?.ownerIds).toEqual(['page-a']);
    await backend._setDictionaryImportMode(false, 'page-a');
    expect(snapshots.at(-1)?.ownerIds).toEqual([]);
});

test('retired backend session and out-of-order snapshots cannot resurrect old holds', () => {
    const control = new TermContentOptimizationControl();
    expect(control.accept(state(1, ['page-a']))).toBe(true);
    expect(control.accept(state(2, []))).toBe(true);
    expect(control.accept(state(1, ['page-a']))).toBe(false);
    expect(control.accept({...state(0, []), sessionId: 'backend-two'})).toBe(true);
    expect(control.accept(state(99, ['page-a']))).toBe(false);
    expect(control.state?.ownerIds).toEqual([]);
});

test('diagnostic/status polling and warmup do not preempt; visible lookup preempts before dispatch', async () => {
    const {worker, scheduler, runStep, send, translator} = await workerFixture();
    const gate = deferPromise();
    /** @type {AbortSignal|undefined} */
    let signal;
    runStep.mockImplementationOnce(async (value) => {
        signal = value;
        await gate.promise;
        return {pending: false};
    });
    try {
        await worker._ensureDatabasePrepared();
        worker._applyTermContentOptimizationState(state(1, []));
        await vi.advanceTimersByTimeAsync(10);
        for (const action of ['getDatabaseRuntimeStateOffscreen', 'getDictionaryInfoOffscreen', 'warmTermLookupCachesOffscreen']) {
            await send(action);
        }
        await send('cancelDictionaryImportOffscreen', {lookupOnly: true, operationId: 'missing'});
        expect(signal?.aborted).toBe(false);
        translator.findTerms.mockImplementationOnce(async () => {
            expect(signal?.aborted).toBe(true);
            return {};
        });
        await send('findTermsStructuredOffscreen', {text: 'word', mode: 'simple', options: {}});
        expect(translator.findTerms).toHaveBeenCalledOnce();
    } finally { gate.resolve(void 0); await scheduler.close(); }
});

test.each(['databaseRefreshOffscreen', 'databaseSetSuspendedOffscreen', 'databasePurgeOffscreen'])('teardown %s joins aborted I/O and can run again after reopen', async (action) => {
    const {worker, scheduler, runStep, database} = await workerFixture();
    const gate = deferPromise();
    /** @type {AbortSignal|undefined} */
    let signal;
    runStep.mockImplementationOnce(async (value) => {
        signal = value;
        await gate.promise;
        return {pending: true};
    });
    try {
        await worker._ensureDatabasePrepared();
        worker._applyTermContentOptimizationState(state(1, []));
        await vi.advanceTimersByTimeAsync(10);
        const teardown = worker._invokeAction(action, action === 'databaseSetSuspendedOffscreen' ? {suspended: true} : {}, []);
        await Promise.resolve();
        expect(signal?.aborted).toBe(true);
        expect(database.close).not.toHaveBeenCalled();
        expect(database.purge).not.toHaveBeenCalled();
        gate.resolve(void 0);
        await teardown;
        if (action === 'databaseSetSuspendedOffscreen') { await worker._invokeAction(action, {suspended: false}, []); }
        await worker._ensureDatabasePrepared();
        await vi.advanceTimersByTimeAsync(10);
        expect(runStep).toHaveBeenCalledTimes(2);
    } finally { gate.resolve(void 0); await scheduler.close(); }
});

test('API retains page observer through backend exit until frontend completion', async () => {
    const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ ({}));
    const close = vi.fn();
    Reflect.set(api, '_dictionaryImportOwnerClient', {close});
    Reflect.get(api, '_dictionaryImportOwnerSessions').set('page-a', {active: true});
    vi.spyOn(api, '_invoke').mockResolvedValue(void 0);
    await api.setDictionaryImportMode(false, 'page-a', true);
    expect(close).not.toHaveBeenCalled();
    await api.setDictionaryImportMode(false, 'page-a');
    expect(close).toHaveBeenCalledExactlyOnceWith('page-a');
});

test('frontend releases optimization only after progress/error publication and awaited callback', async () => {
    const gate = deferPromise();
    const backendExit = deferPromise();
    const progress = {hidden: false};
    vi.stubGlobal('document', {querySelectorAll: vi.fn((selector) => (selector.includes('mdict') ? [] : [progress]))});
    vi.stubGlobal('chrome', {runtime: {getManifest: () => ({version: '1'})}});
    const calls = /** @type {unknown[][]} */ ([]);
    const setDictionaryImportMode = vi.fn(async (...args) => {
        calls.push(args);
        if (args[0] === false && args[2] === true) { await backendExit.promise; }
    });
    const callback = vi.fn(async () => { await gate.promise; });
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
    const showErrors = vi.fn();
    Object.assign(controller, {
        _modifying: false,
        _activeImportRunGeneration: 0,
        _statusFooter: null,
        _settingsController: {application: {api: {setDictionaryImportMode}}, getOptionsFull: async () => ({global: {database: {}}})},
        _getUseImportSession: () => false,
        _getImportPerformanceFlags: () => ({}),
        _preventPageExit: () => ({end: vi.fn()}),
        _setModifying: vi.fn(),
        _hideErrors: vi.fn(),
        _showErrors: showErrors,
        _triggerStorageChanged: vi.fn(),
        _signalImportSessionCompletion: vi.fn(),
    });
    const tracker = {dictionaryCount: 0, setImportRunCheck: vi.fn(), onProgress: vi.fn(), onImportComplete: vi.fn(), getStepTimingHistory: () => []};
    const dictionaries = (async function *emptyDictionaries() {})();
    const importing = controller._importDictionaries(dictionaries, null, callback, /** @type {import('../ext/js/pages/settings/dictionary-import-controller.js').ImportProgressTracker} */ (/** @type {unknown} */ (tracker)));
    try {
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[2]).toBe(true);
        expect(callback).not.toHaveBeenCalled();
        backendExit.resolve(void 0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(progress.hidden).toBe(true);
        expect(showErrors).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledOnce();
        expect(calls).toHaveLength(2);
        gate.resolve(void 0);
        await importing;
        expect(calls).toHaveLength(3);
        expect(calls[2]).toEqual([false, calls[0]?.[1]]);
    } finally {
        backendExit.resolve(void 0);
        gate.resolve(void 0);
        await importing;
    }
});


test('ordinary local and Chromium proxy requests replay desired holds without another RPC', async () => {
    const invoke = vi.fn(async () => {});
    const local = /** @type {DictionaryRuntimeWorkerProxy} */ (Object.create(DictionaryRuntimeWorkerProxy.prototype));
    const notifyTermContentOptimizationState = vi.fn();
    Reflect.set(local, '_client', {invoke, notifyTermContentOptimizationState});
    local.setTermContentOptimizationState(state(1, ['page-a']));
    expect(invoke).not.toHaveBeenCalled();
    expect(notifyTermContentOptimizationState).toHaveBeenCalledWith(state(1, ['page-a']));
    await local.sendMessagePromise({action: 'databasePrepareOffscreen'});
    expect(invoke).toHaveBeenLastCalledWith('databasePrepareOffscreen', {optimizationState: state(1, ['page-a'])});
    local.setTermContentOptimizationState(state(2, []));
    await local.sendMessagePromise({action: 'clearDatabaseCachesOffscreen'});
    expect(invoke).toHaveBeenLastCalledWith('clearDatabaseCachesOffscreen', {optimizationState: state(2, [])});

    const sendMessagePromise = vi.fn(async () => ({result: void 0}));
    const sendMessageIgnoreResponse = vi.fn(() => { throw new Error('optional channel unavailable'); });
    const ensureOffscreenDocument = vi.fn(async () => {});
    const chromium = /** @type {OffscreenProxy} */ (Object.create(OffscreenProxy.prototype));
    Object.assign(chromium, {
        _ensureOffscreenDocument: ensureOffscreenDocument,
        _webExtension: {sendMessagePromise, sendMessageIgnoreResponse},
        _getMessageResponseResult: () => void 0,
    });
    chromium.setTermContentOptimizationState(state(1, ['page-a']));
    expect(sendMessageIgnoreResponse).toHaveBeenCalledWith({action: 'setTermContentOptimizationHoldOffscreen', optimizationState: state(1, ['page-a'])});
    expect(ensureOffscreenDocument).not.toHaveBeenCalled();
    await chromium.sendMessagePromise({action: 'databasePrepareOffscreen'});
    expect(sendMessagePromise).toHaveBeenLastCalledWith({action: 'databasePrepareOffscreen', optimizationState: state(1, ['page-a'])});
    chromium.setTermContentOptimizationState(state(2, []));
    await chromium.sendMessagePromise({action: 'clearDatabaseCachesOffscreen'});
    expect(sendMessagePromise).toHaveBeenLastCalledWith({action: 'clearDatabaseCachesOffscreen', optimizationState: state(2, [])});
});


test('observer loss ends import mode but retains optional hold until explicit UI completion or boot reconciliation', async () => {
    const {backend, snapshots} = backendFixture();
    await backend._setDictionaryImportMode(true, 'page-a');
    Reflect.set(backend, '_orphanedDictionaryImportOwners', new Set(['page-a']));
    Reflect.set(backend, '_dictionaryImportOwnerConnections', new Map());
    await backend._releaseOrphanedDictionaryImportOwner('page-a');
    expect(backend._dictionaryImportOwners.size).toBe(0);
    expect(backend._dictionaryImportModeActive).toBe(false);
    expect(snapshots.at(-1)?.ownerIds).toEqual(['page-a']);
    await backend._setDictionaryImportMode(false, 'page-a');
    expect(snapshots.at(-1)?.ownerIds).toEqual([]);
});


test('a build without the complete optimizer host drains its idle wake without retry errors', async () => {
    const {worker, scheduler: replaced} = await workerFixture();
    await replaced.close();
    const runStep = vi.fn(async (/** @type {AbortSignal} */ signal) => await worker._runOnlineContentOptimizationStep(signal));
    const onError = vi.fn();
    const scheduler = new TermContentIdleScheduler({runStep: /** @type {RunStep} */ (/** @type {unknown} */ (runStep)), onError, idleMs: 10, retryMs: 20});
    scheduler.setHold('!backend-startup', true);
    Reflect.set(worker, '_termContentIdleScheduler', scheduler);
    try {
        await worker._ensureDatabasePrepared();
        worker._applyTermContentOptimizationState(state(1, []));
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
        scheduler.wake();
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).toHaveBeenCalledTimes(2);
        expect(onError).not.toHaveBeenCalled();
    } finally { await scheduler.close(); }
});

test('an installed optimizer adapter still exposes failures and receives foreground cancellation', async () => {
    const {worker, scheduler, database} = await workerFixture();
    const failure = new Error('Installed host I/O failed');
    const runStep = vi.fn(async (/** @type {AbortSignal} */ _signal) => { throw failure; });
    Reflect.set(database, 'runOnlineContentOptimizationStep', runStep);
    const controller = new AbortController();
    try {
        await worker._ensureDatabasePrepared();
        await expect(worker._runOnlineContentOptimizationStep(controller.signal)).rejects.toBe(failure);
        expect(runStep).toHaveBeenCalledExactlyOnceWith(controller.signal);
        controller.abort();
        await expect(worker._runOnlineContentOptimizationStep(controller.signal)).resolves.toEqual({pending: false});
        expect(runStep).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
});


test('full-capacity owner handover retains admission without overflowing the hold registry', async () => {
    const {worker, scheduler, runStep} = await workerFixture();
    const oldOwners = Array.from({length: 128}, (_, index) => 'old-' + index);
    const newOwners = Array.from({length: 128}, (_, index) => 'new-' + index);
    try {
        await worker._ensureDatabasePrepared();
        worker._applyTermContentOptimizationState(state(1, oldOwners));
        expect(() => worker._applyTermContentOptimizationState(state(2, newOwners))).not.toThrow();
        await vi.advanceTimersByTimeAsync(1000);
        expect(runStep).not.toHaveBeenCalled();
        worker._applyTermContentOptimizationState(state(3, []));
        await vi.advanceTimersByTimeAsync(10);
        expect(runStep).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
});
