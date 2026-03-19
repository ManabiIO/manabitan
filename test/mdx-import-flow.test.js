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
    test('DictionaryImportController imports converted MDX archives through the zip importer path', async () => {
        const controller = createControllerForInternalTests();
        /** @type {TestMdxSource} */
        const source = {
            type: 'mdx',
            mdxFile: createFile('fixture.mdx', createBytes(32_000, 17)),
            mddFiles: [
                createFile('fixture.mdd', createBytes(8_000, 23)),
            ],
        };
        const archiveBytes = createBytes(24_000, 211);
        /** @type {import('dictionary-importer').ProgressData[]} */
        const progressEvents = [];
        const convertDictionary = vi.fn(async (details, onProgress) => {
            onProgress({stage: 'upload', completed: 20_000, total: 40_000});
            onProgress({stage: 'convert', completed: 1, total: 1});
            onProgress({stage: 'download', completed: archiveBytes.byteLength, total: archiveBytes.byteLength});
            return {
                archiveContent: Uint8Array.from(archiveBytes).buffer,
                archiveFileName: 'fixture.zip',
            };
        });
        const importDictionaryArchiveContent = vi.fn(async () => []);
        controller._mdx = /** @type {import('../ext/js/comm/mdx.js').Mdx} */ (/** @type {unknown} */ ({convertDictionary}));
        controller._importDictionaryArchiveContent = importDictionaryArchiveContent;
        controller._reportMdxConversionProgress = DictionaryImportController.prototype._reportMdxConversionProgress;

        const dictionaryWorker = /** @type {import('../ext/js/dictionary/dictionary-worker.js').DictionaryWorker} */ (/** @type {unknown} */ ({}));
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
        expect(convertDictionary).toHaveBeenCalledTimes(1);
        expect(convertDictionary).toHaveBeenCalledWith(
            {
                mdxFile: source.mdxFile,
                mddFiles: source.mddFiles,
                enableAudio: false,
            },
            expect.any(Function),
        );

        expect(importDictionaryArchiveContent).toHaveBeenCalledTimes(1);
        const importCall = importDictionaryArchiveContent.mock.calls[0];
        if (typeof importCall === 'undefined') {
            throw new Error('Expected MDX archive import handoff');
        }
        const importCallValues = /** @type {unknown[]} */ (/** @type {unknown} */ (importCall));
        const dictionaryTitle = /** @type {string} */ (importCallValues[0]);
        const archiveContent = /** @type {ArrayBuffer} */ (importCallValues[1]);
        const profilesDictionarySettings = /** @type {null} */ (importCallValues[2]);
        const importDetailsCall = /** @type {import('dictionary-importer').ImportDetails} */ (importCallValues[3]);
        const dictionaryWorkerCall = importCallValues[4];
        const useImportSession = /** @type {boolean} */ (importCallValues[5]);
        const finalizeImportSession = /** @type {boolean} */ (importCallValues[6]);
        const onProgress = /** @type {Function} */ (importCallValues[7]);
        const importStartTime = /** @type {number} */ (importCallValues[8]);
        const localPhaseTimings = /** @type {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} */ (importCallValues[9]);
        const recordLocalPhase = /** @type {Function} */ (importCallValues[10]);
        expect(dictionaryTitle).toBe('fixture.zip');
        expect(new Uint8Array(archiveContent)).toStrictEqual(archiveBytes);
        expect(profilesDictionarySettings).toBeNull();
        expect(importDetailsCall).toBe(importDetails);
        expect(dictionaryWorkerCall).toBe(dictionaryWorker);
        expect(useImportSession).toBe(true);
        expect(finalizeImportSession).toBe(false);
        expect(onProgress).toBeInstanceOf(Function);
        expect(typeof importStartTime).toBe('number');
        expect(localPhaseTimings).toHaveLength(1);
        expect(localPhaseTimings[0]).toMatchObject({
            phase: 'convert-mdx',
            details: {
                archiveFileName: 'fixture.zip',
                mddCount: 1,
                archiveSizeBytes: archiveBytes.byteLength,
            },
        });
        expect(recordLocalPhase).toBeInstanceOf(Function);

        expect(progressEvents[0]).toStrictEqual({nextStep: true, index: 0, count: 0});
        expect(progressEvents.every(({nextStep}, index) => index === 0 || nextStep === false)).toBe(true);
        expect(progressEvents.at(-1)).toMatchObject({
            nextStep: false,
        });
        expect(progressEvents.at(-1)?.index).toBe(progressEvents.at(-1)?.count);
        expect(progressEvents.at(-1)?.count).toBeGreaterThan(0);
    });
});
