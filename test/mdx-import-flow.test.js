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

import {File as NodeFile} from 'node:buffer';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/**
 * @param {number} length
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
function createBytes(length, seed = 0) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; ++i) {
        bytes[i] = (seed + i) % 251;
    }
    return bytes;
}

/**
 * @param {string} name
 * @param {Uint8Array} bytes
 * @returns {File}
 */
function createFile(name, bytes) {
    const file = new NodeFile([bytes], name, {type: 'application/octet-stream'});
    Reflect.set(file, 'webkitRelativePath', '');
    return /** @type {File} */ (/** @type {unknown} */ (file));
}

/**
 * @returns {DictionaryImportController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
}

/**
 * @typedef {{type: 'mdx', mdxFile: File, mddFiles: File[]}} TestMdxSource
 */

describe('MDX import controller handoff', () => {
    test('DictionaryImportController imports MDX sources through the direct dictionary-worker path', async () => {
        const controller = createControllerForInternalTests();
        /** @type {TestMdxSource} */
        const source = {
            type: 'mdx',
            mdxFile: createFile('fixture.mdx', createBytes(32_000, 17)),
            mddFiles: [
                createFile('fixture.mdd', createBytes(8_000, 23)),
            ],
        };
        /** @type {import('dictionary-importer').ProgressData[]} */
        const progressEvents = [];
        const importDictionaryWithWorkerInvocation = vi.fn(async (...args) => {
            const invokeWorkerImport = /** @type {() => Promise<unknown>} */ (args[7]);
            await invokeWorkerImport();
            return [];
        });
        controller._importDictionaryWithWorkerInvocation = importDictionaryWithWorkerInvocation;
        controller._reportMdxConversionProgress = DictionaryImportController.prototype._reportMdxConversionProgress;

        const importMdxDictionary = vi.fn().mockResolvedValue({
            result: null,
            errors: [],
            debug: {importerDebug: {phaseTimings: []}},
        });
        const dictionaryWorker = /** @type {import('../ext/js/dictionary/dictionary-worker.js').DictionaryWorker} */ (/** @type {unknown} */ ({
            importMdxDictionary,
        }));
        const importDetails = /** @type {import('dictionary-importer').ImportDetails} */ ({
            prefixWildcardsSupported: true,
            yomitanVersion: '0.0.0',
            skipImageMetadata: false,
            skipMediaImport: false,
            mediaResolutionConcurrency: 8,
            debugImportLogging: false,
            enableTermEntryContentDedup: true,
            termContentStorageMode: 'baseline',
        });

        const errors = await controller._importDictionaryFromMdx(
            source,
            null,
            importDetails,
            dictionaryWorker,
            true,
            false,
            (details) => {
                progressEvents.push(details);
            },
        );

        expect(errors).toStrictEqual([]);
        expect(importDictionaryWithWorkerInvocation).toHaveBeenCalledTimes(1);
        const importCall = importDictionaryWithWorkerInvocation.mock.calls[0];
        if (typeof importCall === 'undefined') {
            throw new Error('Expected direct MDX worker import handoff');
        }
        const importCallValues = /** @type {unknown[]} */ (/** @type {unknown} */ (importCall));
        const dictionaryTitle = /** @type {string} */ (importCallValues[0]);
        const profilesDictionarySettings = /** @type {null} */ (importCallValues[1]);
        const useImportSession = /** @type {boolean} */ (importCallValues[2]);
        const finalizeImportSession = /** @type {boolean} */ (importCallValues[3]);
        const importStartTime = /** @type {number} */ (importCallValues[4]);
        const localPhaseTimings = /** @type {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} */ (importCallValues[5]);
        const recordLocalPhase = /** @type {Function} */ (importCallValues[6]);
        const invokeWorkerImport = /** @type {Function} */ (importCallValues[7]);
        expect(dictionaryTitle).toBe('fixture.mdx');
        expect(profilesDictionarySettings).toBeNull();
        expect(useImportSession).toBe(true);
        expect(finalizeImportSession).toBe(false);
        expect(typeof importStartTime).toBe('number');
        expect(localPhaseTimings).toHaveLength(1);
        expect(localPhaseTimings[0]).toMatchObject({
            phase: 'read-mdx-source',
            details: {
                mddCount: 1,
                sizeBytes: 40_000,
            },
        });
        expect(recordLocalPhase).toBeInstanceOf(Function);
        expect(invokeWorkerImport).toBeInstanceOf(Function);

        expect(importMdxDictionary).toHaveBeenCalledTimes(1);
        const workerCall = importMdxDictionary.mock.calls[0];
        expect(workerCall?.[0]).toBe('fixture.mdx');
        expect(new Uint8Array(/** @type {ArrayBuffer} */ (workerCall?.[1]))).toStrictEqual(createBytes(32_000, 17));
        expect((/** @type {Array<{name: string, bytes: ArrayBuffer}>} */ (workerCall?.[2])).map(({name}) => name)).toStrictEqual(['fixture.mdd']);
        expect(workerCall?.[3]).toStrictEqual({
            ...importDetails,
            useImportSession: true,
            finalizeImportSession: false,
        });
        expect(workerCall?.[5]).toStrictEqual({enableAudio: false});

        expect(progressEvents[0]).toStrictEqual({nextStep: true, index: 0, count: 0});
        expect(progressEvents.every(({nextStep}, index) => index === 0 || nextStep === false)).toBe(true);
        expect(progressEvents.at(-1)).toMatchObject({
            nextStep: false,
        });
        expect(progressEvents.at(-1)?.index).toBe(450);
        expect(progressEvents.at(-1)?.count).toBe(1000);
    });
});
