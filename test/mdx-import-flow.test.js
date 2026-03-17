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
import {Mdx} from '../ext/js/comm/mdx.js';
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
 * @typedef {{stage: 'upload'|'convert'|'download', completed: number, total: number}} MdxProgressEvent
 */

/**
 * @typedef {{action: string, params: Record<string, unknown>}} NativeAction
 */

/**
 * @typedef {{type: 'mdx', mdxFile: File, mddFiles: File[]}} TestMdxSource
 */

describe('MDX import protocol flow', () => {
    test('Mdx.convertDictionary uploads companions, runs conversion, and downloads the archive', async () => {
        const mdxFile = createFile('fixture.mdx', createBytes(320_000, 11));
        const mddFiles = [
            createFile('fixture.mdd', createBytes(160_000, 47)),
            createFile('fixture.1.mdd', createBytes(96_000, 89)),
        ];
        const archiveBytes = createBytes(290_000, 131);
        /** @type {MdxProgressEvent[]} */
        const progressEvents = [];
        /** @type {NativeAction[]} */
        const actions = [];
        /** @type {Map<string, Uint8Array[]>} */
        const uploadChunks = new Map();
        /** @type {Map<string, number>} */
        const uploadSizes = new Map();

        const mdx = new Mdx();
        mdx._setupPortWrapper = async () => {};
        mdx._invoke = async (action, params) => {
            actions.push({action, params});
            switch (action) {
                case 'begin_upload': {
                    const fileName = typeof params.fileName === 'string' ? params.fileName : 'unknown';
                    const uploadId = `upload:${fileName}`;
                    uploadChunks.set(uploadId, []);
                    uploadSizes.set(uploadId, Number(params.totalBytes));
                    return {uploadId};
                }
                case 'upload_chunk': {
                    const uploadId = typeof params.uploadId === 'string' ? params.uploadId : '';
                    const data = typeof params.data === 'string' ? params.data : '';
                    const chunk = new Uint8Array(Buffer.from(data, 'base64'));
                    uploadChunks.get(uploadId)?.push(chunk);
                    return {};
                }
                case 'finish_upload':
                    return {};
                case 'convert':
                    return 'job:fixture';
                case 'download_begin':
                    return {totalBytes: archiveBytes.byteLength, archiveFileName: 'fixture.zip'};
                case 'download_chunk': {
                    const offset = typeof params.offset === 'number' ? params.offset : 0;
                    const chunkBytes = typeof params.chunkBytes === 'number' ? params.chunkBytes : archiveBytes.byteLength;
                    const end = Math.min(offset + chunkBytes, archiveBytes.byteLength);
                    return {data: Buffer.from(archiveBytes.slice(offset, end)).toString('base64')};
                }
                case 'download_end':
                    return {};
                default:
                    throw new Error(`Unexpected action: ${action}`);
            }
        };

        const result = await mdx.convertDictionary(
            {
                mdxFile,
                mddFiles,
                titleOverride: 'Fixture Dictionary',
                descriptionOverride: 'Fixture Description',
                revision: '2026.03.17',
                enableAudio: true,
            },
            (details) => {
                progressEvents.push(details);
            },
        );

        expect(result.archiveFileName).toBe('fixture.zip');
        expect(new Uint8Array(result.archiveContent)).toStrictEqual(archiveBytes);

        expect(actions.map(({action}) => action)).toStrictEqual([
            'begin_upload',
            'upload_chunk',
            'upload_chunk',
            'upload_chunk',
            'finish_upload',
            'begin_upload',
            'upload_chunk',
            'upload_chunk',
            'finish_upload',
            'begin_upload',
            'upload_chunk',
            'finish_upload',
            'convert',
            'download_begin',
            'download_chunk',
            'download_chunk',
            'download_chunk',
            'download_end',
        ]);

        const uploadedMdx = Buffer.concat(uploadChunks.get('upload:fixture.mdx') || []);
        const uploadedMdd = Buffer.concat(uploadChunks.get('upload:fixture.mdd') || []);
        const uploadedMdd1 = Buffer.concat(uploadChunks.get('upload:fixture.1.mdd') || []);
        expect(uploadedMdx.length).toBe(mdxFile.size);
        expect(uploadedMdd.length).toBe(mddFiles[0].size);
        expect(uploadedMdd1.length).toBe(mddFiles[1].size);
        expect(uploadedMdx.equals(Buffer.from(await mdxFile.arrayBuffer()))).toBe(true);
        expect(uploadedMdd.equals(Buffer.from(await mddFiles[0].arrayBuffer()))).toBe(true);
        expect(uploadedMdd1.equals(Buffer.from(await mddFiles[1].arrayBuffer()))).toBe(true);
        expect(uploadSizes).toStrictEqual(new Map([
            ['upload:fixture.mdx', mdxFile.size],
            ['upload:fixture.mdd', mddFiles[0].size],
            ['upload:fixture.1.mdd', mddFiles[1].size],
        ]));

        const convertCall = actions.find(({action}) => action === 'convert');
        expect(convertCall).toBeDefined();
        expect(convertCall?.params).toMatchObject({
            mdxUploadId: 'upload:fixture.mdx',
            mddUploadIds: ['upload:fixture.mdd', 'upload:fixture.1.mdd'],
            options: {
                titleOverride: 'Fixture Dictionary',
                descriptionOverride: 'Fixture Description',
                revision: '2026.03.17',
                enableAudio: true,
                includeAssets: true,
                termBankSize: 10000,
            },
        });

        expect(progressEvents.some(({stage}) => stage === 'upload')).toBe(true);
        expect(progressEvents).toContainEqual({stage: 'convert', completed: 1, total: 1});
        expect(progressEvents.at(-1)).toStrictEqual({
            stage: 'download',
            completed: archiveBytes.byteLength,
            total: archiveBytes.byteLength,
        });
        const totalUploadBytes = mdxFile.size + mddFiles.reduce((sum, file) => sum + file.size, 0);
        expect(progressEvents.find(({stage}) => stage === 'upload')).toMatchObject({
            stage: 'upload',
            total: totalUploadBytes,
        });
    });
});

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
        controller._mdx = /** @type {Mdx} */ (/** @type {unknown} */ ({convertDictionary}));
        controller._getMdxImportOptions = () => ({
            titleOverride: 'Fixture Override',
            descriptionOverride: 'Fixture Description',
            revision: '2026.03',
            enableAudio: true,
        });
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
                titleOverride: 'Fixture Override',
                descriptionOverride: 'Fixture Description',
                revision: '2026.03',
                enableAudio: true,
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
