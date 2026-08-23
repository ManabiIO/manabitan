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

const logWarn = vi.fn();
const logError = vi.fn();
const importControl = vi.hoisted(() => ({
    waitForCancellation: false,
    started: false,
    waitForLookupRelease: false,
    lookupStarted: false,
    lookupStartedCount: 0,
    lookupGate: /** @type {Promise<void>|null} */ (null),
    releaseLookup: /** @type {(() => void)|null} */ (null),
    waitForWarmRelease: false,
    warmStarted: false,
    warmGate: /** @type {Promise<void>|null} */ (null),
    releaseWarm: /** @type {(() => void)|null} */ (null),
    prepareError: false,
    cancelledAtStart: false,
    translatorClearCount: 0,
    lastFindTermsOptions: /** @type {import('translation').FindTermsOptions|null} */ (null),
}));

vi.mock('../ext/js/core/log.js', () => ({
    log: {
        warn: logWarn,
        error: logError,
    },
}));

vi.mock('../ext/js/dictionary/dictionary-database.js', () => ({
    DictionaryDatabase: class {
        /** @returns {boolean} */
        isPrepared() { return false; }
        /** @returns {Promise<void>} */
        async prepare() {
            if (importControl.prepareError) {
                throw new Error('Database preparation failed');
            }
        }

        /** @returns {boolean} */
        usesFallbackStorage() { return false; }
        /** @returns {null} */
        getOpenStorageDiagnostics() { return null; }
        /** @returns {Promise<void>} */
        async warmTermLookupCaches() {
            importControl.warmStarted = true;
            if (!importControl.waitForWarmRelease) { return; }
            if (importControl.warmGate === null) {
                importControl.warmGate = new Promise((resolve) => {
                    importControl.releaseWarm = resolve;
                });
            }
            await importControl.warmGate;
        }
    },
}));

vi.mock('../ext/js/language/translator.js', () => ({
    Translator: class {
        /** */
        prepare() {}
        /** */
        clearDatabaseCaches() { ++importControl.translatorClearCount; }
        /**
         * @param {import('translator').FindTermsMode} _mode
         * @param {string} _text
         * @param {import('translation').FindTermsOptions} options
         * @returns {Promise<{dictionaryEntries: unknown[], originalTextLength: number}>}
         */
        async findTerms(_mode, _text, options) {
            importControl.lastFindTermsOptions = options;
            if (importControl.waitForLookupRelease) {
                importControl.lookupStarted = true;
                ++importControl.lookupStartedCount;
                if (importControl.lookupGate === null) {
                    importControl.lookupGate = new Promise((resolve) => {
                        importControl.releaseLookup = resolve;
                    });
                }
                await importControl.lookupGate;
            }
            return {dictionaryEntries: [], originalTextLength: 0};
        }
    },
}));

vi.mock('../ext/js/dictionary/dictionary-importer-media-loader.js', () => ({
    DictionaryImporterMediaLoader: class {},
}));

vi.mock('../ext/js/dictionary/dictionary-importer.js', () => ({
    DictionaryImporter: class {
        /**
         * @param {unknown} _mediaLoader
         * @param {(progress: unknown) => void} onProgress
         * @param {() => boolean} isCancelled
         */
        constructor(_mediaLoader, onProgress, isCancelled) {
            this._onProgress = onProgress;
            this._isCancelled = isCancelled;
        }

        /**
         * @returns {Promise<{result: {title: string}, errors: Error[], debug: null}>}
         */
        async importDictionary() {
            importControl.cancelledAtStart = this._isCancelled();
            if (importControl.waitForCancellation) {
                importControl.started = true;
                while (!this._isCancelled()) {
                    await new Promise((resolve) => { setTimeout(resolve, 1); });
                }
                throw new Error('Dictionary import was cancelled');
            }
            this._onProgress({nextStep: false, index: 1, count: 2});
            this._onProgress({nextStep: false, index: 2, count: 2});
            return {
                result: {title: 'Fixture'},
                errors: [],
                debug: null,
            };
        }
    },
}));

describe('Offscreen dictionary worker import response port handling', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        logWarn.mockReset();
        logError.mockReset();
        importControl.waitForCancellation = false;
        importControl.started = false;
        importControl.waitForLookupRelease = false;
        importControl.lookupStarted = false;
        importControl.lookupStartedCount = 0;
        importControl.lookupGate = null;
        importControl.releaseLookup = null;
        importControl.waitForWarmRelease = false;
        importControl.warmStarted = false;
        importControl.warmGate = null;
        importControl.releaseWarm = null;
        importControl.prepareError = false;
        importControl.cancelledAtStart = false;
        importControl.translatorClearCount = 0;
        importControl.lastFindTermsOptions = null;
    });

    test('accepts native structured-clone lookup settings', async () => {
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        listeners.get('message')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 1,
                action: 'findTermsStructuredOffscreen',
                params: {
                    mode: 'group',
                    text: 'a/b',
                    options: {
                        enabledDictionaryMap: new Map(),
                        excludeDictionaryDefinitions: new Set(['Excluded']),
                        textReplacements: [[{
                            pattern: /a\/b\\c/giu,
                            replacement: 'x',
                        }]],
                    },
                },
            },
            ports: [],
        })));

        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({
            id: 1,
            result: {dictionaryEntries: [], originalTextLength: 0},
        }));
        const pattern = importControl.lastFindTermsOptions?.textReplacements[0]?.[0]?.pattern;
        expect(pattern).toBeInstanceOf(RegExp);
        expect(pattern?.source).toBe(String.raw`a\/b\\c`);
        expect(pattern?.flags).toBe('giu');
        expect(importControl.lastFindTermsOptions?.enabledDictionaryMap).toBeInstanceOf(Map);
        expect(importControl.lastFindTermsOptions?.excludeDictionaryDefinitions).toBeInstanceOf(Set);
    });

    test('continues import work when progress delivery fails', async () => {
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');

        const onMessage = listeners.get('message');
        expect(onMessage).toBeTypeOf('function');

        const responsePort = {
            postMessage: vi.fn((message) => {
                if (message?.type === 'progress') {
                    throw new Error('response port closed during progress');
                }
            }),
            close: vi.fn(),
        };

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 1,
                action: 'importDictionaryOffscreen',
                params: {
                    archiveContent: new Blob(['dictionary']),
                    details: {},
                },
            },
            ports: [responsePort],
        })));

        await vi.waitFor(() => {
            expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'complete',
            }));
        });

        expect(responsePort.postMessage).toHaveBeenCalledWith({
            type: 'progress',
            progress: {nextStep: false, index: 1, count: 2},
        });
        expect(responsePort.postMessage).not.toHaveBeenCalledWith({
            type: 'progress',
            progress: {nextStep: false, index: 2, count: 2},
        });
        expect(responsePort.close).toHaveBeenCalledTimes(1);
        expect(importControl.translatorClearCount).toBe(1);
        expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: undefined});
        expect(logWarn).toHaveBeenCalledTimes(1);
        expect(logError).not.toHaveBeenCalled();
    });

    test('reports setup failures through the import response port', async () => {
        importControl.prepareError = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        const responsePort = {postMessage: vi.fn(), close: vi.fn()};
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 1, action: 'importDictionaryOffscreen', params: {archiveContent: new Blob(['dictionary']), details: {}}},
            ports: [responsePort],
        })));

        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'})));
        expect(responsePort.close).toHaveBeenCalledOnce();
        expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: undefined});
    });

    test('does not retain cancellation state after an import is missing its response port', async () => {
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 1, action: 'importDictionaryOffscreen', params: {archiveContent: null, details: {}}},
            ports: [],
        })));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 1, error: expect.anything()})));

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 2, action: 'cancelDictionaryImportOffscreen', params: {}},
            ports: [],
        })));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({id: 2, result: undefined}));

        const responsePort = {postMessage: vi.fn(), close: vi.fn()};
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 3, action: 'importDictionaryOffscreen', params: {archiveContent: null, details: {}}},
            ports: [responsePort],
        })));
        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'complete'})));
        expect(importControl.cancelledAtStart).toBe(false);
    });

    test('falls back to a serializable error when the completion payload cannot be cloned', async () => {
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: vi.fn(),
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const responsePort = {
            postMessage: vi.fn((message) => {
                if (message?.type === 'complete') {
                    throw new DOMException('Could not clone', 'DataCloneError');
                }
            }),
            close: vi.fn(),
        };
        listeners.get('message')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 1, action: 'importDictionaryOffscreen', params: {archiveContent: null, details: {}}},
            ports: [responsePort],
        })));

        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
            error: expect.objectContaining({message: expect.stringContaining('could not be delivered')}),
        })));
        expect(responsePort.close).toHaveBeenCalledOnce();
        expect(logWarn).toHaveBeenCalledOnce();
    });

    test('queues lookups behind import while processing cancellation outside the mutation queue', async () => {
        importControl.waitForCancellation = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
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
                params: {
                    mode: 'group',
                    text: '日本',
                    options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []},
                },
            },
            ports: [],
        })));
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        expect(workerPostMessage).not.toHaveBeenCalledWith({
            id: 2,
            result: {dictionaryEntries: [], originalTextLength: 0},
        });
        expect(workerPostMessage).not.toHaveBeenCalledWith({id: 1, result: undefined});

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 3, action: 'cancelDictionaryImportOffscreen', params: {}},
            ports: [],
        })));

        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: undefined}));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({
            id: 2,
            result: {dictionaryEntries: [], originalTextLength: 0},
        }));
        expect(responsePort.close).toHaveBeenCalledOnce();
    });

    test('fans out adjacent lookups after an import instead of serializing them', async () => {
        importControl.waitForCancellation = true;
        importControl.waitForLookupRelease = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
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
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 4, action: 'cancelDictionaryImportOffscreen', params: {}},
            ports: [],
        })));

        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'})));
        await vi.waitFor(() => expect(importControl.lookupStartedCount).toBe(2));
        expect(workerPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 2}));
        expect(workerPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 3}));

        importControl.releaseLookup?.();
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 2})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 3})));
    });

    test('drains an active lookup before starting an import mutation', async () => {
        importControl.waitForLookupRelease = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 1,
                action: 'findTermsOffscreen',
                params: {
                    mode: 'group',
                    text: '日本',
                    options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []},
                },
            },
            ports: [],
        })));
        await vi.waitFor(() => expect(importControl.lookupStarted).toBe(true));

        const responsePort = {postMessage: vi.fn(), close: vi.fn()};
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 2, action: 'importDictionaryOffscreen', params: {archiveContent: new Blob(['dictionary']), details: {}}},
            ports: [responsePort],
        })));
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        expect(responsePort.postMessage).not.toHaveBeenCalled();

        importControl.releaseLookup?.();
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({
            id: 1,
            result: {dictionaryEntries: [], originalTextLength: 0},
        }));
        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'complete'})));
        expect(workerPostMessage).toHaveBeenCalledWith({id: 2, result: undefined});
    });

    test('runs policy-classified lookup requests concurrently', async () => {
        importControl.waitForLookupRelease = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        const lookupParams = {
            mode: 'group',
            text: '日本',
            options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []},
        };
        for (const id of [1, 2]) {
            onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
                data: {id, action: 'findTermsOffscreen', params: lookupParams},
                ports: [],
            })));
        }

        await vi.waitFor(() => expect(importControl.lookupStartedCount).toBe(2));
        expect(workerPostMessage).not.toHaveBeenCalled();
        importControl.releaseLookup?.();
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledTimes(2));
        expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: {dictionaryEntries: [], originalTextLength: 0}});
        expect(workerPostMessage).toHaveBeenCalledWith({id: 2, result: {dictionaryEntries: [], originalTextLength: 0}});
    });

    test('does not block a visible lookup behind cooperative cache warming', async () => {
        importControl.waitForWarmRelease = true;
        importControl.waitForLookupRelease = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 1, action: 'warmTermLookupCachesOffscreen', params: {dictionaryNames: ['JMdict']}},
            ports: [],
        })));
        await vi.waitFor(() => expect(importControl.warmStarted).toBe(true));

        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 2,
                action: 'findTermsOffscreen',
                params: {
                    mode: 'group',
                    text: '日本',
                    options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []},
                },
            },
            ports: [],
        })));
        await vi.waitFor(() => expect(importControl.lookupStarted).toBe(true));
        expect(workerPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 1}));
        expect(workerPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({id: 2}));

        importControl.releaseLookup?.();
        importControl.releaseWarm?.();
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 1})));
        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith(expect.objectContaining({id: 2})));
    });

    test('honors cancellation while an import is queued behind an active lookup', async () => {
        importControl.waitForCancellation = true;
        importControl.waitForLookupRelease = true;
        /** @type {Map<string, (event: MessageEvent) => void>} */
        const listeners = new Map();
        const workerPostMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type, listener) => {
                listeners.set(type, listener);
            }),
            postMessage: workerPostMessage,
        });

        await import('../ext/js/background/offscreen-dictionary-worker.js');
        const onMessage = listeners.get('message');
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {
                id: 1,
                action: 'findTermsOffscreen',
                params: {
                    mode: 'group',
                    text: '日本',
                    options: {enabledDictionaryMap: [], excludeDictionaryDefinitions: null, textReplacements: []},
                },
            },
            ports: [],
        })));
        await vi.waitFor(() => expect(importControl.lookupStarted).toBe(true));

        const responsePort = {postMessage: vi.fn(), close: vi.fn()};
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 2, action: 'importDictionaryOffscreen', params: {archiveContent: new Blob(['dictionary']), details: {}}},
            ports: [responsePort],
        })));
        onMessage?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
            data: {id: 3, action: 'cancelDictionaryImportOffscreen', params: {}},
            ports: [],
        })));

        await vi.waitFor(() => expect(workerPostMessage).toHaveBeenCalledWith({id: 3, result: undefined}));
        expect(importControl.started).toBe(false);
        importControl.releaseLookup?.();

        await vi.waitFor(() => expect(importControl.started).toBe(true));
        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'error'})));
        expect(responsePort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'complete'}));
        expect(responsePort.close).toHaveBeenCalledOnce();
        expect(workerPostMessage).toHaveBeenCalledWith({id: 2, result: undefined});
    });
});
