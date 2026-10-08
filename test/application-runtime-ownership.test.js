/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {setImmediate} from 'node:timers';
import {afterEach, expect, vi} from 'vitest';
import {Application} from '../ext/js/application.js';
import {API} from '../ext/js/comm/api.js';
import {CrossFrameAPI} from '../ext/js/comm/cross-frame-api.js';
import {log} from '../ext/js/core/log.js';
import {WebExtension} from '../ext/js/extension/web-extension.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
/**
 * @typedef {object} ApplicationHarness
 * @property {(EventTarget & {terminate: import('vitest').Mock, postMessage: import('vitest').Mock})[]} workers
 * @property {import('vitest').MockInstance<API['shutdownRuntimeConnections']>} shutdown
 * @property {import('vitest').MockInstance<typeof log.error>} report
 */
/** @type {Set<WebExtension>} */
const startupExtensions = new Set();

afterEach(() => {
    for (const extension of startupExtensions) { extension.triggerUnloaded(); }
    startupExtensions.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {number} [failCreationAt]
 * @returns {ApplicationHarness} Harness spies and created workers.
 */
function setupApplication(window, failCreationAt = 0) {
    vi.useFakeTimers();
    vi.stubGlobal('window', {location: {protocol: 'file:'}, setInterval: globalThis.setInterval});
    vi.stubGlobal('navigator', {serviceWorker: {}});
    /** @type {Set<(message: {action: string, params: undefined}, sender: object, callback: () => void) => unknown>} */
    const listeners = new Set();
    vi.stubGlobal('chrome', {
        runtime: {
            getURL: (/** @type {string} */ path) => `file:///extension/${path}`,
            getManifest: () => ({name: 'Manabitan', version: 'test'}),
            onMessage: {addListener: vi.fn((listener) => listeners.add(listener)), removeListener: vi.fn((listener) => listeners.delete(listener))},
        },
    });
    vi.spyOn(WebExtension.prototype, 'sendMessagePromise').mockImplementation(/** @this {WebExtension} */ async function readySignal() {
        startupExtensions.add(this);
        for (const listener of listeners) { listener({action: 'applicationBackendReady', params: undefined}, {}, () => {}); }
    });
    vi.spyOn(log, 'configure').mockImplementation(() => {});
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(API.prototype, 'ensureMediaDrawingWorkerConnected').mockResolvedValue();
    vi.spyOn(API.prototype, 'frameInformationGet').mockResolvedValue({tabId: 1, frameId: 0});
    vi.spyOn(CrossFrameAPI.prototype, 'prepare').mockImplementation(() => {});
    vi.spyOn(Application.prototype, 'prepare').mockImplementation(() => {});
    const shutdown = vi.spyOn(API.prototype, 'shutdownRuntimeConnections');
    const workers = /** @type {TestWorker[]} */ ([]);
    let creationCount = 0;
    class TestWorker extends window.EventTarget {
        constructor() {
            super();
            creationCount++;
            if (creationCount === failCreationAt) { throw new Error('worker constructor failed'); }
            this.terminate = vi.fn();
            this.postMessage = vi.fn();
            workers.push(this);
        }
    }
    vi.stubGlobal('Worker', TestWorker);
    return {workers, shutdown, report};
}

for (const type of ['error', 'messageerror']) {
    test(`obsolete worker ${type} cannot restart the healthy replacement`, async ({window}) => {
        const {workers, shutdown} = setupApplication(window);
        await Application.main(false, async () => {});
        const obsolete = workers[0];
        obsolete.dispatchEvent(new window.Event(type));
        await new Promise(setImmediate);
        expect(workers).toHaveLength(2);
        obsolete.dispatchEvent(new window.Event(type));
        await new Promise(setImmediate);
        expect(workers).toHaveLength(2);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        expect(shutdown).not.toHaveBeenCalled();
    });
}

test('initial worker construction failure uses startup cleanup and error UI', async ({window}) => {
    const {shutdown} = setupApplication(window, 1);
    const main = vi.fn(async () => {});
    await expect(Application.main(false, main)).rejects.toThrow('worker constructor failed');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(window.document.documentElement.dataset.loadingError).toBe('true');
    expect(window.document.querySelector('#startup-error-message')?.textContent).toContain('worker constructor failed');
    expect(main).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

test('restart construction failure is handled and closes unusable runtime resources', async ({window}) => {
    const {workers, shutdown, report} = setupApplication(window, 2);
    await Application.main(false, async () => {});
    workers[0].dispatchEvent(new window.Event('error'));
    await new Promise(setImmediate);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(window.document.querySelector('#startup-error-message')?.textContent).toContain('worker constructor failed');
    expect(report.mock.calls.some(([error]) => error instanceof Error && error.message === 'worker constructor failed')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

test('restart limit is handled without an unhandled rejection', async ({window}) => {
    const {workers, shutdown, report} = setupApplication(window);
    await Application.main(false, async () => {});
    for (let i = 0; i < 4; i++) {
        workers.at(-1)?.dispatchEvent(new window.Event('error'));
        await new Promise(setImmediate);
    }
    expect(workers).toHaveLength(4);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(window.document.querySelector('#startup-error-message')?.textContent).toContain('repeatedly lost its media rendering worker');
    expect(report.mock.calls.some(([error]) => error instanceof Error && error.message === 'Media drawing worker restart limit exceeded')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

for (const constructor of ['SharedWorker', 'MessageChannel']) {
    test(`initial Firefox ${constructor} failure shows startup error and releases acquired ports`, async ({window}) => {
        const {workers} = setupApplication(window);
        vi.stubGlobal('navigator', {});
        const bridgePort = {postMessage: vi.fn(), close: vi.fn()};
        vi.stubGlobal('SharedWorker', class {
            constructor() {
                if (constructor === 'SharedWorker') { throw new Error('bridge constructor failed'); }
                this.port = bridgePort;
            }
        });
        vi.stubGlobal('MessageChannel', class {
            constructor() { throw new Error('channel constructor failed'); }
        });
        const message = constructor === 'SharedWorker' ? 'bridge constructor failed' : 'channel constructor failed';
        const main = vi.fn(async () => {});
        await expect(Application.main(false, main)).rejects.toThrow(message);
        expect(window.document.documentElement.dataset.loadingError).toBe('true');
        expect(window.document.querySelector('#startup-error-message')?.textContent).toContain(message);
        if (constructor === 'MessageChannel') { expect(bridgePort.close).toHaveBeenCalledTimes(1); }
        expect(main).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });
}

test('backend readiness request errors reject startup even if a ready broadcast arrived', async ({window}) => {
    const {shutdown} = setupApplication(window);
    const ready = vi.mocked(WebExtension.prototype.sendMessagePromise).getMockImplementation();
    /**
     * @this {WebExtension}
     * @param {unknown} message
     * @returns {Promise<unknown>}
     */
    async function failedReadyRequest(message) {
        await ready?.call(this, message);
        return {error: {name: 'Error', message: 'bridge registration failed', stack: ''}};
    }
    vi.mocked(WebExtension.prototype.sendMessagePromise).mockImplementation(failedReadyRequest);
    const main = vi.fn(async () => {});
    await expect(Application.main(false, main)).rejects.toThrow('bridge registration failed');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(main).not.toHaveBeenCalled();
    expect(window.document.querySelector('#startup-error-message')?.textContent).toContain('bridge registration failed');
    expect(vi.getTimerCount()).toBe(0);
});


test('a stalled backend-ready handshake times out and releases runtime resources', async ({window}) => {
    const {shutdown} = setupApplication(window);
    vi.mocked(WebExtension.prototype.sendMessagePromise).mockImplementation(
        () => new Promise(() => {}),
    );
    const main = vi.fn(async () => {});
    const pending = Application.main(false, main);
    const rejection = expect(pending).rejects.toThrow('Timed out waiting for backend ready signal after 15000ms.');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(main).not.toHaveBeenCalled();
    expect(window.document.querySelector('#startup-error-message')?.textContent).toContain('Timed out waiting');
    expect(vi.getTimerCount()).toBe(0);
});

test('the backend deadline rejects even if reading the stored startup failure hangs', async ({window}) => {
    const {shutdown} = setupApplication(window);
    const storageGet = vi.fn(() => new Promise(() => {}));
    Reflect.set(chrome, 'storage', {session: {get: storageGet}});
    vi.mocked(WebExtension.prototype.sendMessagePromise).mockResolvedValue(void 0);
    const main = vi.fn(async () => {});
    const pending = Application.main(false, main);
    const rejection = expect(pending).rejects.toThrow('Timed out waiting for backend ready signal after 15000ms.');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(storageGet).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(main).not.toHaveBeenCalled();
    expect(window.document.querySelector('#startup-error-message')?.textContent).toContain('Timed out waiting');
    expect(vi.getTimerCount()).toBe(0);
});
