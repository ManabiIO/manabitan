/*
 * Copyright (C) 2026  Yomitan Authors
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
import {DictionaryWorkerHandler} from '../ext/js/dictionary/dictionary-worker-handler.js';

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * @param {Array<number>} values
 * @returns {() => number}
 */
function createNowMock(values) {
    let index = 0;
    return () => {
        const value = values[index];
        if (typeof value === 'number') {
            index += 1;
            return value;
        }
        return values.at(-1) ?? 0;
    };
}

describe('DictionaryWorkerHandler direct MDX import progress', () => {
    test('throttles intermediate progress updates and records the emitted message count', async () => {
        const handler = new DictionaryWorkerHandler();
        const onProgress = vi.fn();
        vi.spyOn(Date, 'now').mockReturnValue(1000);

        const importMdxDictionary = vi.fn(async (
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ _dictionaryDatabase,
            /** @type {{mdxFileName: string, mdxBytes: Uint8Array, mddFiles: Array<{name: string, bytes: Uint8Array}>, options?: Record<string, unknown>}} */ mdxSource,
            /** @type {import('dictionary-importer').ImportDetails} */ details,
            /** @type {(progress: {completed: number, total: number}) => void} */ onPrepareProgress,
        ) => {
            expect(mdxSource).toMatchObject({
                mdxFileName: 'fixture.mdx',
                mddFiles: [{name: 'fixture.mdd'}],
            });
            expect(mdxSource.mdxBytes).toBeInstanceOf(Uint8Array);
            expect(mdxSource.mddFiles[0]?.bytes).toBeInstanceOf(Uint8Array);
            expect(details).toMatchObject({yomitanVersion: '1.2.3.4'});

            onPrepareProgress({completed: 0, total: 1000});
            onPrepareProgress({completed: 1, total: 1000});
            onPrepareProgress({completed: 9, total: 1000});
            onPrepareProgress({completed: 10, total: 1000});
            onPrepareProgress({completed: 11, total: 1000});
            onPrepareProgress({completed: 1000, total: 1000});

            return {
                result: null,
                errors: [],
                debug: {
                    phaseTimings: [{phase: 'prepare-mdx', elapsedMs: 12, details: {source: 'fixture'}}],
                },
            };
        });

        Reflect.set(handler, '_runImport', vi.fn(async (
            /** @type {import('dictionary-importer').ImportDetails} */ details,
            /** @type {(value: {nextStep: boolean, index: number, count: number}) => void} */ progressCallback,
            /** @type {(dictionaryImporter: {importMdxDictionary: typeof importMdxDictionary}, dictionaryDatabase: import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase) => Promise<unknown>} */ importCallback,
        ) => {
            expect(details).toMatchObject({yomitanVersion: '1.2.3.4'});
            expect(progressCallback).toBe(onProgress);
            return await importCallback(
                {importMdxDictionary},
                /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({})),
            );
        }));

        const result = await handler._importMdxDictionary({
            details: {prefixWildcardsSupported: true, yomitanVersion: '1.2.3.4'},
            mdxFileName: 'fixture.mdx',
            mdxBytes: new Uint8Array([1, 2, 3]).buffer,
            mddFiles: [{name: 'fixture.mdd', bytes: new Uint8Array([4, 5]).buffer}],
            options: {enableAudio: false},
        }, onProgress);

        expect(importMdxDictionary).toHaveBeenCalledTimes(1);
        expect(onProgress.mock.calls.map(([value]) => value)).toStrictEqual([
            {nextStep: false, index: 450, count: 1000},
            {nextStep: false, index: 456, count: 1000},
            {nextStep: false, index: 1000, count: 1000},
        ]);
        expect(result).toMatchObject({
            debug: {
                phaseTimings: [{
                    phase: 'prepare-mdx',
                    details: {
                        source: 'fixture',
                        progressMessageCount: 3,
                    },
                }],
            },
        });
    });

    test('emits a time-based progress update when entry deltas stay below the percentage threshold', async () => {
        const handler = new DictionaryWorkerHandler();
        const onProgress = vi.fn();
        vi.spyOn(Date, 'now').mockImplementation(createNowMock([1000, 1000, 1051, 1051]));

        Reflect.set(handler, '_runImport', vi.fn(async (
            /** @type {import('dictionary-importer').ImportDetails} */ _details,
            /** @type {(value: {nextStep: boolean, index: number, count: number}) => void} */ _progressCallback,
            /** @type {(dictionaryImporter: {importMdxDictionary: (dictionaryDatabase: import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase, mdxSource: {mdxFileName: string, mdxBytes: Uint8Array, mddFiles: Array<{name: string, bytes: Uint8Array}>, options?: Record<string, unknown>}, importDetails: import('dictionary-importer').ImportDetails, onPrepareProgress: (progress: {completed: number, total: number}) => void) => Promise<unknown>}, dictionaryDatabase: import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase) => Promise<unknown>} */ importCallback,
        ) => (
            await importCallback(
                {
                    importMdxDictionary: async (
                        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ _dictionaryDatabase,
                        /** @type {{mdxFileName: string, mdxBytes: Uint8Array, mddFiles: Array<{name: string, bytes: Uint8Array}>, options?: Record<string, unknown>}} */ _mdxSource,
                        /** @type {import('dictionary-importer').ImportDetails} */ _importDetails,
                        /** @type {(progress: {completed: number, total: number}) => void} */ onPrepareProgress,
                    ) => {
                        onPrepareProgress({completed: 0, total: 10000});
                        onPrepareProgress({completed: 10, total: 10000});
                        onPrepareProgress({completed: 20, total: 10000});
                        onPrepareProgress({completed: 10000, total: 10000});
                        return {
                            result: null,
                            errors: [],
                            debug: {
                                phaseTimings: [{phase: 'prepare-mdx', elapsedMs: 1, details: {}}],
                            },
                        };
                    },
                },
                /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({})),
            )
        )));

        await handler._importMdxDictionary({
            details: {prefixWildcardsSupported: true, yomitanVersion: '1.2.3.4'},
            mdxFileName: 'fixture.mdx',
            mdxBytes: new Uint8Array([1]).buffer,
            mddFiles: [],
            options: {enableAudio: false},
        }, onProgress);

        expect(onProgress.mock.calls.map(([value]) => value)).toStrictEqual([
            {nextStep: false, index: 450, count: 1000},
            {nextStep: false, index: 451, count: 1000},
            {nextStep: false, index: 1000, count: 1000},
        ]);
    });
});
