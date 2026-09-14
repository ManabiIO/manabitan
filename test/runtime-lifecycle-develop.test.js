/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({
    isDevDiagnosticsBuild: false,
    reportDiagnostics: vi.fn(),
    reportDiagnosticsLazy: vi.fn(),
}));

const {Backend} = await import('../ext/js/background/backend.js');
const {OffscreenProxy} = await import('../ext/js/background/offscreen-proxy.js');

function deferred() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = /** @type {Promise<void>} */ (new Promise((resolvePromise) => {
        resolve = resolvePromise;
    }));
    return {promise, resolve};
}

function createPort() {
    return /** @type {MessagePort} */ (/** @type {unknown} */ ({
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessage: null,
        onmessageerror: null,
    }));
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('develop runtime lifecycle regressions', () => {
    test('publishes the mutation tail before a task can synchronously re-enter', async () => {
        const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryMutationPromise', null);
        const gate = deferred();
        const started = deferred();
        /** @type {string[]} */
        const events = [];
        /** @type {Promise<void>|undefined} */
        let nested;
        const first = backend._runDictionaryMutation(async () => {
            events.push('first-start');
            nested = backend._runDictionaryMutation(async () => { events.push('nested'); });
            started.resolve();
            await gate.promise;
            events.push('first-end');
        });
        try {
            await started.promise;
            expect(events).toEqual(['first-start']);
        } finally {
            gate.resolve();
            await first;
            await nested;
        }
        expect(events).toEqual(['first-start', 'first-end', 'nested']);
    });

    test('coalesces the offscreen existence probe and creation', async () => {
        const probeGate = deferred();
        const createDocument = vi.fn().mockResolvedValue(void 0);
        const getContexts = vi.fn(async () => {
            await probeGate.promise;
            return [];
        });
        vi.stubGlobal('chrome', {
            runtime: {
                lastError: void 0,
                getURL: () => 'chrome-extension://test/offscreen.html',
                getContexts,
            },
            offscreen: {createDocument},
        });
        const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({sendMessagePromise: vi.fn()})));
        const ensure = /** @type {() => Promise<void>} */ (Reflect.get(proxy, '_ensureOffscreenDocument').bind(proxy));
        const first = ensure();
        const second = ensure();
        expect(getContexts).toHaveBeenCalledOnce();
        probeGate.resolve();
        await Promise.all([first, second]);
        expect(createDocument).toHaveBeenCalledOnce();
    });

    test('ordinary offscreen recovery closes the port owned by a vanished document', async () => {
        const oldPort = createPort();
        const createDocument = vi.fn().mockResolvedValue(void 0);
        vi.stubGlobal('chrome', {
            runtime: {
                lastError: void 0,
                getURL: () => 'chrome-extension://test/offscreen.html',
                getContexts: vi.fn().mockResolvedValue([]),
            },
            offscreen: {createDocument},
        });
        const webExtension = {sendMessagePromise: vi.fn().mockResolvedValue({result: null})};
        const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        await proxy.registerOffscreenPort(oldPort);
        await proxy.sendMessagePromise({action: 'getDictionaryInfoOffscreen'});
        expect(createDocument).toHaveBeenCalledOnce();
        expect(oldPort.close).toHaveBeenCalledOnce();
        expect(Reflect.get(proxy, '_currentOffscreenPort')).toBeNull();
    });

    test('successful control-port bootstrap clears its registration deadline', async () => {
        vi.useFakeTimers();
        const port = createPort();
        vi.stubGlobal('chrome', {
            runtime: {
                lastError: void 0,
                getURL: () => 'chrome-extension://test/offscreen.html',
                getContexts: vi.fn().mockResolvedValue([{}]),
            },
            offscreen: {createDocument: vi.fn().mockResolvedValue(void 0)},
        });
        /** @type {InstanceType<typeof OffscreenProxy>|null} */
        let proxy = null;
        const webExtension = {
            sendMessagePromise: vi.fn(async () => {
                queueMicrotask(() => { void proxy?.registerOffscreenPort(port); });
                return {result: null};
            }),
        };
        proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (webExtension)));
        const ensurePort = /** @type {() => Promise<void>} */ (Reflect.get(proxy, '_ensureOffscreenPort').bind(proxy));
        await ensurePort();
        expect(vi.getTimerCount()).toBe(0);
    });
});
