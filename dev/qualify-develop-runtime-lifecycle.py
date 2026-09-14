from pathlib import Path
import sys


def replace_method(path, class_name, method_name, replacement):
    file_path = Path(path)
    text = file_path.read_text()
    class_start = text.index(f'export class {class_name} {{')
    start = text.index(f'    async {method_name}(', class_start)
    end = text.index('\n    }\n', start) + len('\n    }\n')
    file_path.write_text(text[:start] + replacement + text[end:])


def add_tests():
    path = Path('test/runtime-lifecycle-develop.test.js')
    if path.exists():
        raise SystemExit(f'{path} already exists')
    path.write_text(r'''/*
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
''')


def apply_fixes():
    replace_method(
        'ext/js/background/backend.js',
        'Backend',
        '_runDictionaryMutation',
        '''    async _runDictionaryMutation(task) {
        const previousPromise = this._dictionaryMutationPromise;
        // Publish the tail before caller code can synchronously re-enter this queue.
        const mutationPromise = Promise.resolve().then(async () => {
            if (previousPromise !== null) {
                try {
                    await previousPromise;
                } catch (_) {
                    // A prior failed mutation must not poison later queued mutations.
                }
            }
            await task();
        });
        this._dictionaryMutationPromise = mutationPromise;
        try {
            await mutationPromise;
        } finally {
            if (this._dictionaryMutationPromise === mutationPromise) {
                this._dictionaryMutationPromise = null;
            }
        }
    }
''',
    )
    replace_method(
        'ext/js/background/offscreen-proxy.js',
        'OffscreenProxy',
        '_ensureOffscreenDocument',
        '''    async _ensureOffscreenDocument() {
        if (this._creatingOffscreen !== null) {
            await this._creatingOffscreen;
            return;
        }
        // Coalesce the existence probe as well as creation so two delayed
        // negative probes cannot race into duplicate createDocument calls.
        const creatingPromise = (async () => {
            if (await this._hasOffscreenDocument()) { return; }
            const port = this._currentOffscreenPort;
            if (port !== null) { this._clearCurrentOffscreenPort(port); }
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: [
                    /** @type {chrome.offscreen.Reason} */ ('CLIPBOARD'),
                ],
                justification: 'Access to the clipboard',
            });
        })();
        this._creatingOffscreen = creatingPromise;
        try {
            await creatingPromise;
        } finally {
            if (this._creatingOffscreen === creatingPromise) {
                this._creatingOffscreen = null;
            }
        }
    }
''',
    )
    replace_method(
        'ext/js/background/offscreen-proxy.js',
        'OffscreenProxy',
        '_ensureOffscreenPort',
        '''    async _ensureOffscreenPort() {
        // Develop's acknowledged control protocol detects a silently stale port
        // itself, so avoid a getContexts preflight on every healthy request.
        if (this._currentOffscreenPort !== null) { return; }
        if (this._registeringOffscreenPort !== null) {
            await this._registeringOffscreenPort;
            return;
        }
        const registeringPromise = (async () => {
            await this._ensureOffscreenDocument();
            if (this._currentOffscreenPort !== null) { return; }
            const response = await this._webExtension.sendMessagePromise({action: 'createAndRegisterPortOffscreen'});
            this._getMessageResponseResult(/** @type {import('core').Response<void>} */ (response));
            /** @type {ReturnType<typeof setTimeout>|undefined} */
            let timeout;
            try {
                await Promise.race([
                    this._offscreenPortReadyPromise,
                    new Promise((resolve, reject) => {
                        timeout = setTimeout(() => reject(new Error('Timed out waiting for offscreen control port registration')), 5000);
                    }),
                ]);
            } finally {
                clearTimeout(timeout);
            }
        })();
        this._registeringOffscreenPort = registeringPromise;
        try {
            await registeringPromise;
        } finally {
            if (this._registeringOffscreenPort === registeringPromise) {
                this._registeringOffscreenPort = null;
            }
        }
    }
''',
    )

    path = Path('test/offscreen-dictionary-worker-import.test.js')
    text = path.read_text()
    first_start = text.index("    test('queues lookups behind import while processing cancellation outside the mutation queue'")
    second_start = text.index("    test('fans out adjacent lookups after an import instead of serializing them'", first_start)
    third_start = text.index("    test('drains an active lookup before starting an import mutation'", second_start)
    first = r'''    test('rejects lookups while import is active and recovers after cancellation', async () => {
        importControl.waitForCancellation = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => { listeners.set(type, listener); }),
            postMessage: workerPostMessage,
        });
        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        const responsePort = {postMessage: vi.fn(), close: vi.fn()};
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 1, action: 'importDictionaryOffscreen', params: {archiveContent: new Blob(['dictionary']), details: {}}},
            ports: [responsePort],
        })));
        await vi.waitFor(() => expect(importControl.started).toBe(true));

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 2,
                action: 'findTermsOffscreen',
                params: {mode: 'group', text: '日本', options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []}},
            },
            ports: [],
        })));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({
            id: 2,
            error: expect.objectContaining({message: 'Cannot execute findTermsOffscreen: dictionary import is in progress'}),
        })));

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 3, action: 'cancelDictionaryImportOffscreen', params: {}},
            ports: [],
        })));
        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: undefined}));

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 4,
                action: 'findTermsOffscreen',
                params: {mode: 'group', text: '日本', options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []}},
            },
            ports: [],
        })));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({
            id: 4,
            result: {dictionaryEntries: [], originalTextLength: 0},
        }));
        expect(responsePort.close).toHaveBeenCalledOnce();
    });

'''
    second = r'''    test('rejects adjacent lookups during import and fans them out after import completes', async () => {
        importControl.waitForCancellation = true;
        importControl.waitForLookupRelease = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => { listeners.set(type, listener); }),
            postMessage: workerPostMessage,
        });
        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        const responsePort = {postMessage: vi.fn(), close: vi.fn()};
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 1, action: 'importDictionaryOffscreen', params: {archiveContent: new Blob(['dictionary']), details: {}}},
            ports: [responsePort],
        })));
        await vi.waitFor(() => expect(importControl.started).toBe(true));
        const lookupParams = {
            mode: 'group',
            text: '日本',
            options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []},
        };
        for (const id of [2, 3]) {
            onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
                data: {id, action: 'findTermsOffscreen', params: lookupParams},
                ports: [],
            })));
        }
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 2, error: expect.any(Object)})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 3, error: expect.any(Object)})));
        expect(importControl.lookupStartedCount).toBe(0);

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 4, action: 'cancelDictionaryImportOffscreen', params: {}},
            ports: [],
        })));
        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: undefined}));

        for (const id of [5, 6]) {
            onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
                data: {id, action: 'findTermsOffscreen', params: lookupParams},
                ports: [],
            })));
        }
        await vi.waitFor(() => expect(importControl.lookupStartedCount).toBe(2));
        expect(workerPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 5}));
        expect(workerPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 6}));
        importControl.releaseLookup?.();
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 5, result: expect.any(Object)})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 6, result: expect.any(Object)})));
    });

'''
    path.write_text(text[:first_start] + first + second + text[third_start:])


if len(sys.argv) != 2 or sys.argv[1] not in {'add-tests', 'apply-fixes'}:
    raise SystemExit('Usage: qualify-develop-runtime-lifecycle.py add-tests|apply-fixes')

if sys.argv[1] == 'add-tests':
    add_tests()
else:
    apply_fixes()
