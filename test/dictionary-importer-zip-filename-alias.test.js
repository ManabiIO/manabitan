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

import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/**
 * Reproduce UTF-8 filename bytes incorrectly marked as legacy CP437, without
 * depending on a private dictionary archive outside the repository.
 * @returns {Promise<ArrayBuffer>}
 */
async function createLegacyFilenameArchive() {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0, extendedTimestamp: false});
    await writer.add('daijirin2/文-default.svg', new TextReader('<svg/>'));
    const bytes = await writer.close();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = bytes.byteLength - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    const centralOffset = view.getUint32(endOffset + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    const localOffset = view.getUint32(centralOffset + 42, true);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    for (const offset of [localOffset + 6, centralOffset + 8]) {
        view.setUint16(offset, view.getUint16(offset, true) & ~0x0800, true);
    }
    return new Uint8Array(bytes).buffer;
}

describe('DictionaryImporter ZIP filename aliases', () => {
    test.each([true, false])('relays archive/index diagnostics only when enabled=%s', async (debugImportLogging) => {
        const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
        await writer.add('index.json', new TextReader(JSON.stringify({title: 'Test', revision: '1', format: 999})));
        const bytes = await writer.close();
        const database = new DictionaryDatabase();
        const preparedSpy = vi.spyOn(database, 'isPrepared').mockReturnValue(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const onDebug = vi.fn();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), undefined, onDebug);
        try {
            const result = await importer.importDictionary(database, new Uint8Array(bytes).buffer, {debugImportLogging});
            expect(result.result).toBeNull();
            expect(result.errors[0].message).toBe('Unsupported dictionary format version: 999');
            if (debugImportLogging) {
                const phaseMessages = onDebug.mock.calls.map(([message]) => message).filter((message) => !message.startsWith('archive catalog reader ') && !message.startsWith('archive catalog read '));
                expect(phaseMessages.slice(0, 3)).toEqual([
                    'archive catalog begin', 'archive catalog complete files=1', 'index read begin',
                ]);
                expect(onDebug).not.toHaveBeenCalledWith('index read complete');
            } else {
                expect(onDebug).not.toHaveBeenCalled();
            }
        } finally {
            preparedSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    test('identifies an unresolved Blob catalog read and stops range diagnostics after catalog completion', async () => {
        const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
        await writer.add('index.json', new TextReader(JSON.stringify({title: 'Test', revision: '1', format: 999})));
        const bytes = await writer.close();
        /** @type {() => void} */
        let releaseRead = () => {};
        const readGate = new Promise((resolve) => { releaseRead = () => resolve(undefined); });
        class GatedBlob extends Blob {
            /**
             * @param {number} [start]
             * @param {number} [end]
             * @param {string} [contentType]
             * @returns {Blob}
             */
            slice(start, end, contentType) {
                const result = super.slice(start, end, contentType);
                const arrayBuffer = result.arrayBuffer.bind(result);
                result.arrayBuffer = async () => {
                    await readGate;
                    return await arrayBuffer();
                };
                return result;
            }
        }
        const database = new DictionaryDatabase();
        const preparedSpy = vi.spyOn(database, 'isPrepared').mockReturnValue(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const onDebug = vi.fn();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), undefined, onDebug);
        const importPromise = importer.importDictionary(database, new GatedBlob([bytes]), {debugImportLogging: true});
        const tailOffset = bytes.byteLength - 22;
        try {
            await vi.waitFor(() => expect(onDebug).toHaveBeenCalledWith(`archive catalog read begin offset=${tailOffset} length=22`));
            expect(onDebug).not.toHaveBeenCalledWith(expect.stringContaining('archive catalog read complete'));
            expect(onDebug).not.toHaveBeenCalledWith('index read begin');
            releaseRead();
            const result = await importPromise;
            expect(result.errors[0].message).toBe('Unsupported dictionary format version: 999');
            const messages = onDebug.mock.calls.map(([message]) => message);
            expect(messages).toContain(`archive catalog read complete offset=${tailOffset} length=22 bytes=22`);
            const indexReadPosition = messages.indexOf('index read begin');
            expect(indexReadPosition).toBeGreaterThan(0);
            expect(messages.slice(indexReadPosition).some((message) => message.startsWith('archive catalog read '))).toBe(false);
        } finally {
            releaseRead();
            await importPromise;
            preparedSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    test('indexes UTF-8 raw filenames alongside mojibake decoded ZIP names', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const archiveContent = await createLegacyFilenameArchive();
        const getFilesFromArchive = /** @type {(archiveContent: ArrayBuffer|Blob) => Promise<{fileMap: Map<string, unknown>, zipReader: {close: () => Promise<void>}}>} */ (
            Reflect.get(importer, '_getFilesFromArchive')
        );

        const {fileMap, zipReader} = await getFilesFromArchive.call(importer, archiveContent);
        try {
            expect(fileMap.has('daijirin2/µûç-default.svg')).toBe(true);
            expect(fileMap.has('daijirin2/文-default.svg')).toBe(true);
            expect(fileMap.get('daijirin2/文-default.svg')).toBe(fileMap.get('daijirin2/µûç-default.svg'));
        } finally {
            await zipReader.close();
        }
    });
});
