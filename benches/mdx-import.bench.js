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

import {IDBKeyRange, indexedDB} from 'fake-indexeddb';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'node:url';
import path from 'path';
import {bench, describe, vi} from 'vitest';
import {chrome, fetch} from '../test/mocks/common.js';
import {DictionaryImporterMediaLoader} from '../test/mocks/dictionary-importer-media-loader.js';
import {setupStubs} from '../test/utilities/database.js';

setupStubs();
installBenchmarkConsoleFilter();
vi.stubGlobal('indexedDB', indexedDB);
vi.stubGlobal('IDBKeyRange', IDBKeyRange);
vi.stubGlobal('fetch', fetch);
vi.stubGlobal('chrome', chrome);

const pakoModule = await import('../ext/js/dictionary/mdx/vendor/pako-inflate.js');
vi.stubGlobal('pako', Reflect.get(pakoModule, 'default') ?? pakoModule);

const {DictionaryDatabase: DictionaryDatabaseClass} = await import('../ext/js/dictionary/dictionary-database.js');
const {DictionaryImporter: DictionaryImporterClass} = await import('../ext/js/dictionary/dictionary-importer.js');
const {createMdxImportData} = await import('../ext/js/dictionary/mdx/mdx-converter.js');

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(dirname, '..', 'test', 'data', 'dictionaries');
const importDataBenchmarkOptions = Object.freeze({
    throws: true,
    time: 0,
    iterations: 16,
    warmupTime: 0,
    warmupIterations: 4,
});
const importerBenchmarkOptions = Object.freeze({
    throws: true,
    time: 0,
    iterations: 3,
    warmupTime: 0,
    warmupIterations: 1,
    setup: resetImportBenchmarkContext,
});
const mdxImportOptions = Object.freeze({
    enableAudio: false,
});
const importDetails = Object.freeze({
    prefixWildcardsSupported: true,
    yomitanVersion: '0.0.0.0',
});
const fixtures = Object.freeze([
    createFixture('playwright-read.mdx'),
    createFixture('playwright-yome.mdx'),
]);

/** @type {{dictionaryDatabase: import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase, dictionaryImporter: import('../ext/js/dictionary/dictionary-importer.js').DictionaryImporter}|null} */
let importContext = null;
let importIteration = 0;

process.once('beforeExit', () => {
    void destroyImportBenchmarkContext();
});

describe('MDX import', () => {
    bench(`createMdxImportData - fixture batch (n=${fixtures.length})`, async () => {
        for (const fixture of fixtures) {
            await createMdxImportData(
                fixture.fileName,
                mdxImportOptions,
                fixture.bytes,
                [],
            );
        }
    }, importDataBenchmarkOptions);

    bench(`DictionaryImporter.importMdxDictionary - shared prepared database fixture batch (n=${fixtures.length})`, async () => {
        if (importContext === null) {
            throw new Error('Benchmark import context is not initialized');
        }

        const iterationId = ++importIteration;
        for (const fixture of fixtures) {
            const titleOverride = createIterationDictionaryTitle(fixture.fileName, iterationId);
            const {result, errors} = await importContext.dictionaryImporter.importMdxDictionary(
                importContext.dictionaryDatabase,
                {
                    mdxFileName: fixture.fileName,
                    mdxBytes: fixture.bytes,
                    mddFiles: [],
                    options: {
                        ...mdxImportOptions,
                        titleOverride,
                    },
                },
                importDetails,
            );
            if (result === null || result.title !== titleOverride || errors.length > 0) {
                throw new Error(`Expected fixture ${fixture.fileName} to import without errors`);
            }
        }
    }, importerBenchmarkOptions);
});

/**
 * @param {string} fileName
 * @returns {{fileName: string, bytes: Uint8Array}}
 */
function createFixture(fileName) {
    return {
        fileName,
        bytes: Uint8Array.from(readFileSync(path.join(fixtureDirectory, fileName))),
    };
}

/**
 * @param {string} fileName
 * @param {number} iterationId
 * @returns {string}
 */
function createIterationDictionaryTitle(fileName, iterationId) {
    return `${fileName.replace(/\.mdx$/u, '')} benchmark ${iterationId}`;
}

async function createImportBenchmarkContext() {
    importContext = {
        dictionaryDatabase: new DictionaryDatabaseClass(),
        dictionaryImporter: new DictionaryImporterClass(new DictionaryImporterMediaLoader()),
    };
    await importContext.dictionaryDatabase.prepare();
}

async function resetImportBenchmarkContext() {
    await destroyImportBenchmarkContext();
    importIteration = 0;
    await createImportBenchmarkContext();
}

async function destroyImportBenchmarkContext() {
    if (importContext === null) {
        return;
    }

    try {
        await importContext.dictionaryDatabase.purge();
    } finally {
        if (importContext.dictionaryDatabase.isPrepared()) {
            await importContext.dictionaryDatabase.close();
        }
        importContext = null;
    }
}

function installBenchmarkConsoleFilter() {
    for (const methodName of /** @type {const} */ (['log', 'warn', 'error'])) {
        const original = console[methodName].bind(console);
        console[methodName] = (...args) => {
            if (shouldSuppressBenchmarkConsoleMessage(args)) {
                return;
            }
            original(...args);
        };
    }
}

/**
 * @param {unknown[]} args
 * @returns {boolean}
 */
function shouldSuppressBenchmarkConsoleMessage(args) {
    const first = args[0];
    return (
        typeof first === 'string' &&
        (
            first.startsWith('SQL TRACE #') ||
            first.startsWith('Ignoring inability to install OPFS sqlite3_vfs:')
        )
    );
}
