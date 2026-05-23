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
        async prepare() {}
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

        /**
         * @returns {Promise<{result: {title: string}, errors: Error[], debug: null}>}
         */
        async importDictionary() {
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
        expect(workerPostMessage).toHaveBeenCalledWith({id: 1, result: undefined});
        expect(logWarn).toHaveBeenCalledTimes(1);
        expect(logError).not.toHaveBeenCalled();
    });
});
