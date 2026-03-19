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
import {bench, describe} from 'vitest';
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
function createControllerForInternalBenchmarks() {
    return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
}

/**
 * @param {number} groupCount
 * @returns {File[]}
 */
function createGroupedImportFiles(groupCount) {
    /** @type {File[]} */
    const files = [];
    for (let i = 0; i < groupCount; ++i) {
        const label = `Fixture-${String(i).padStart(4, '0')}`;
        files.push(
            createFile(`${label}.zip`, createBytes(32, i)),
            createFile(`${label}.2.mdd`, createBytes(64, i + 1)),
            createFile(`${label}.mdx`, createBytes(96, i + 2)),
            createFile(`${label}.mdd`, createBytes(64, i + 3)),
            createFile(`${label}.1.mdd`, createBytes(64, i + 4)),
        );
    }
    return files;
}

const createImportSourcesFromFiles = /** @type {(this: DictionaryImportController, files: File[]) => {sources: Array<{type: string}>, errors: Error[], hasMdx: boolean}} */ (
    Reflect.get(DictionaryImportController.prototype, '_createImportSourcesFromFiles')
);
const readMdxImportSourceBytes = /** @type {(this: DictionaryImportController, source: {type: 'mdx', mdxFile: File, mddFiles: File[]}, onProgress: import('dictionary-worker').ImportProgressCallback) => Promise<{mdxBytes: ArrayBuffer, mddFiles: Array<{name: string, bytes: ArrayBuffer}>, totalBytes: number}>} */ (
    Reflect.get(DictionaryImportController.prototype, '_readMdxImportSourceBytes')
);

const groupedImportFiles = createGroupedImportFiles(250);
const protocolMdxFile = createFile('fixture.mdx', createBytes(512 * 1024, 7));
const protocolMddFiles = [
    createFile('fixture.mdd', createBytes(256 * 1024, 13)),
    createFile('fixture.1.mdd', createBytes(256 * 1024, 29)),
];

describe('MDX import flow', () => {
    bench(`DictionaryImportController._createImportSourcesFromFiles mixed local batch (n=${groupedImportFiles.length})`, () => {
        const controller = createControllerForInternalBenchmarks();
        const result = createImportSourcesFromFiles.call(controller, groupedImportFiles);
        if (result.sources.length !== 500 || result.errors.length > 0 || result.hasMdx !== true) {
            throw new Error('Unexpected grouping result');
        }
    });

    bench(`DictionaryImportController._readMdxImportSourceBytes direct upload prep (${protocolMdxFile.size + protocolMddFiles.reduce((sum, file) => sum + file.size, 0)} bytes)`, async () => {
        const controller = createControllerForInternalBenchmarks();
        controller._reportMdxConversionProgress = () => {};
        await readMdxImportSourceBytes.call(controller, {
            type: 'mdx',
            mdxFile: protocolMdxFile,
            mddFiles: protocolMddFiles,
        }, () => {});
    });
});
