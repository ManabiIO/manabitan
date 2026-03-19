/*
 * Copyright (C) 2026  Manabitan authors
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

import {bench, describe} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../test/mocks/dictionary-importer-media-loader.js';
import {
    createGeneratedDictionaryArchiveData,
    createInMemoryOpfsDirectoryHandle,
    installBenchmarkGlobals,
    installInMemoryOpfsNavigator,
} from './benchmark-utils.js';

installBenchmarkGlobals();

const {archiveData, termCount} = await createGeneratedDictionaryArchiveData({
    dictionaryName: 'Generated Import Benchmark Dictionary',
    bankCount: 4,
    rowsPerBank: 1536,
    glossaryCharacters: 224,
});
const dictionaryImporter = new DictionaryImporter(new DictionaryImporterMediaLoader());
const benchmarkOptions = Object.freeze({
    time: 1500,
    warmupTime: 500,
    warmupIterations: 2,
});

describe('Dictionary import', () => {
    bench(`DictionaryImporter.importDictionary raw-bytes generated archive (terms=${termCount})`, async () => {
        const opfsRootDirectoryHandle = createInMemoryOpfsDirectoryHandle();
        const restoreNavigator = installInMemoryOpfsNavigator(opfsRootDirectoryHandle);
        const dictionaryDatabase = new DictionaryDatabase();
        try {
            await dictionaryDatabase.prepare();
            const {errors, result} = await dictionaryImporter.importDictionary(
                dictionaryDatabase,
                archiveData,
                {
                    prefixWildcardsSupported: true,
                    termContentStorageMode: 'raw-bytes',
                    yomitanVersion: '0.0.0.0',
                },
            );
            if (errors.length > 0 || result === null) {
                throw new Error(`Import benchmark setup failed: errors=${errors.length}`);
            }
        } finally {
            if (dictionaryDatabase.isPrepared()) {
                await dictionaryDatabase.close();
            }
            restoreNavigator();
        }
    }, benchmarkOptions);
});
