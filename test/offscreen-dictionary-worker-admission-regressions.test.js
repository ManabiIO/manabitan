/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

const control = vi.hoisted(() => ({
    uncloneableLookup: false,
    progressThenComplete: false,
    importerCalls: 0,
}));

vi.mock('../ext/js/core/log.js', () => ({
    log: {warn: vi.fn(), error: vi.fn()},
}));

vi.mock('../ext/js/dictionary/dictionary-database.js', () => ({
    DictionaryDatabase: class {
        /** @returns {boolean} */
        isPrepared() { return true; }
        /** @returns {Promise<void>} */
        async prepare() {}
        /** @returns {Promise<void>} */
        async close() {}
        /** @returns {boolean} */
        usesFallbackStorage() { return false; }
        /** @returns {null} */
        getOpenStorageDiagnostics() { return null; }
    },
}));

vi.mock('../ext/js/language/translator.js', () => ({
    Translator: class {
        /** */
        prepare() {}
        /** */
        clearDatabaseCaches() {}
        /** @returns {Promise<unknown>} */
        async findTerms() {
            return control.uncloneableLookup ?
                {dictionaryEntries: [() => {}], originalTextLength: 0} :
                {dictionaryEntries: [], originalTextLength: 0};
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
         */
        constructor(_mediaLoader, onProgress) {
            this._onProgress = onProgress;
        }

        /** @returns {Promise<{result: unknown, errors: Error[], debug: null}>} */
        async importDictionary() {
            ++control.importerCalls;
            if (control.progressThenComplete) {
                this._onProgress({index: 1, count: 1, nextStep: false});
            }
            return {result: {title: 'Fixture'}, errors: [], debug: null};
        }
    },
}));

/**
 * @returns {Promise<{
 *   onMessage: (event: MessageEvent) => void,
 *   messages: unknown[],
 * }>}
 */
async function createWorkerHarness() {
    /** @type {Map<string, (event: MessageEvent) => void>} */
    const listeners = new Map();
    /** @type {unknown[]} */
    const messages = [];
    vi.stubGlobal('self', {
        addEventListener: vi.fn((type, listener) => {
            listeners.set(type, listener);
        }),
        postMessage(message) {
            const cloned = structuredClone(message);
            messages.push(cloned);
        },
    });
    await import('../ext/js/background/offscreen-dictionary-worker.js');
    const onMessage = listeners.get('message');
    if (typeof onMessage !== 'function') { throw new Error('worker message handler was not installed'); }
    return {onMessage, messages};
}

/**
 * @param {(event: MessageEvent) => void} onMessage
 * @param {number} id
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @param {MessagePort[]} [ports]
 */
function send(onMessage, id, action, params = {}, ports = []) {
    onMessage(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
        data: {id, action, params},
        ports,
    })));
}

afterEach(() => {
    control.uncloneableLookup = false;
    control.progressThenComplete = false;
    control.importerCalls = 0;
    vi.resetModules();
    vi.unstubAllGlobals();
});

describe('offscreen dictionary worker admission and reply ownership', () => {
    test('suspended import releases admission and cannot block lookup after resume', async () => {
        const {onMessage, messages} = await createWorkerHarness();
        send(onMessage, 1, 'databaseSetSuspendedOffscreen', {suspended: true});
        await vi.waitFor(() => expect(messages).toContainEqual({id: 1, result: undefined}));

        const responseMessages = [];
        const responsePort = /** @type {MessagePort} */ (/** @type {unknown} */ ({
            postMessage(message) { responseMessages.push(structuredClone(message)); },
            close: vi.fn(),
        }));
        send(onMessage, 2, 'importDictionaryOffscreen', {
            archiveContent: new Blob(['dictionary']),
            details: {},
        }, [responsePort]);
        await vi.waitFor(() => expect(
            responseMessages.some((message) => message?.type === 'error'),
        ).toBe(true));

        send(onMessage, 3, 'databaseSetSuspendedOffscreen', {suspended: false});
        await vi.waitFor(() => expect(messages).toContainEqual({id: 3, result: undefined}));
        send(onMessage, 4, 'findTermsStructuredOffscreen', {
            mode: 'group',
            text: '猫',
            options: {},
        });
        await vi.waitFor(() => expect(messages).toContainEqual({
            id: 4,
            result: {dictionaryEntries: [], originalTextLength: 0},
        }));
        expect(control.importerCalls).toBe(0);
    });

    test('uncloneable ordinary result returns a bounded transport error without retrying action', async () => {
        control.uncloneableLookup = true;
        const {onMessage, messages} = await createWorkerHarness();
        send(onMessage, 1, 'findTermsStructuredOffscreen', {
            mode: 'group',
            text: '猫',
            options: {},
        });
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toMatchObject({
            id: 1,
            error: {
                name: 'DataCloneError',
                message: expect.any(String),
            },
        });
    });

    test('progress delivery failure cannot suppress terminal completion fallback', async () => {
        control.progressThenComplete = true;
        const {onMessage} = await createWorkerHarness();
        /** @type {unknown[]} */
        const delivered = [];
        let progressFailed = false;
        let completionFailed = false;
        const responsePort = /** @type {MessagePort} */ (/** @type {unknown} */ ({
            postMessage(message) {
                if (message?.type === 'progress' && !progressFailed) {
                    progressFailed = true;
                    throw new DOMException('progress clone failed', 'DataCloneError');
                }
                if (message?.type === 'complete' && !completionFailed) {
                    completionFailed = true;
                    throw new DOMException('completion clone failed', 'DataCloneError');
                }
                delivered.push(structuredClone(message));
            },
            close: vi.fn(),
        }));
        send(onMessage, 1, 'importDictionaryOffscreen', {
            archiveContent: new Blob(['dictionary']),
            details: {},
        }, [responsePort]);

        await vi.waitFor(() => expect(delivered.some((message) => message?.type === 'error')).toBe(true));
        expect(delivered).toContainEqual(expect.objectContaining({
            type: 'error',
            error: expect.objectContaining({
                message: expect.stringContaining('could not be delivered'),
            }),
        }));
        expect(control.importerCalls).toBe(1);
    });
});
