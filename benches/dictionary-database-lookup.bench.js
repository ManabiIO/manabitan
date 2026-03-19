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

import {afterAll, beforeAll, bench, describe} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../test/mocks/dictionary-importer-media-loader.js';
import {
    createExpressionSample,
    createGeneratedDictionaryArchiveData,
    createInMemoryOpfsDirectoryHandle,
    installBenchmarkGlobals,
    installInMemoryOpfsNavigator,
} from './benchmark-utils.js';

installBenchmarkGlobals();

const {archiveData, dictionaryName, expressions, termCount} = await createGeneratedDictionaryArchiveData({
    dictionaryName: 'Generated Lookup Benchmark Dictionary',
    bankCount: 4,
    rowsPerBank: 1792,
    glossaryCharacters: 224,
});
const dictionaryImporter = new DictionaryImporter(new DictionaryImporterMediaLoader());
const dictionarySet = new Set([dictionaryName]);
const exactQueries = createExpressionSample(expressions, 128);
const prefixQueries = createExpressionSample(expressions, 64, 17).map((expression) => expression.slice(0, 10));
const prefixExpectedResultCount = prefixQueries.length * 10;
const benchmarkOptions = Object.freeze({
    time: 2000,
    warmupTime: 500,
    warmupIterations: 4,
});
/** @type {DictionaryDatabase|null} */
let dictionaryDatabase = null;
/** @type {(() => void)|null} */
let restoreNavigator = null;

beforeAll(async () => {
    const uniquePrefixQueries = new Set(prefixQueries);
    if (uniquePrefixQueries.size !== prefixQueries.length) {
        throw new Error('Expected benchmark prefix queries to be unique');
    }
    const opfsRootDirectoryHandle = createInMemoryOpfsDirectoryHandle();
    restoreNavigator = installInMemoryOpfsNavigator(opfsRootDirectoryHandle);
    dictionaryDatabase = new DictionaryDatabase();
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
        throw new Error(`Lookup benchmark import setup failed: errors=${errors.length}`);
    }
});

afterAll(async () => {
    if (dictionaryDatabase !== null && dictionaryDatabase.isPrepared()) {
        await dictionaryDatabase.close();
    }
    dictionaryDatabase = null;
    if (typeof restoreNavigator === 'function') {
        restoreNavigator();
    }
    restoreNavigator = null;
});

describe('Dictionary database lookup', () => {
    bench(`DictionaryDatabase.findTermsBulk exact generated terms (terms=${termCount}, n=${exactQueries.length})`, async () => {
        if (dictionaryDatabase === null) {
            throw new Error('Lookup benchmark database was not initialized');
        }
        const results = await dictionaryDatabase.findTermsBulk(exactQueries, dictionarySet, 'exact');
        if (results.length !== exactQueries.length) {
            throw new Error(`Expected ${exactQueries.length} exact results, got ${results.length}`);
        }
    }, benchmarkOptions);

    bench(`DictionaryDatabase.findTermsBulk prefix generated terms (terms=${termCount}, n=${prefixQueries.length})`, async () => {
        if (dictionaryDatabase === null) {
            throw new Error('Lookup benchmark database was not initialized');
        }
        const results = await dictionaryDatabase.findTermsBulk(prefixQueries, dictionarySet, 'prefix');
        if (results.length !== prefixExpectedResultCount) {
            throw new Error(`Expected ${prefixExpectedResultCount} prefix results, got ${results.length}`);
        }
    }, benchmarkOptions);
});
