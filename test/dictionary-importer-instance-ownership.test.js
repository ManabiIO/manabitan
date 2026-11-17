/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @typedef {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} Database */
/** @typedef {import('dictionary-importer').ImportResult} ImportResult */
/** @typedef {{own: (reader: {close: () => Promise<void>}) => void}} ArchiveOwnership */

const database = /** @type {Database} */ (/** @type {unknown} */ ({}));
const details = /** @type {import('dictionary-importer').ImportDetails} */ ({});

/** @returns {ImportResult} */
function result() { return {result: null, errors: []}; }

/** @returns {import('core').DeferredPromiseDetails<void>} */
function barrier() { return deferPromise(); }

test('concurrent imports cannot replace the instance read scope before database admission', async () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const entered = barrier();
    const release = barrier();
    let calls = 0;
    const body = vi.fn(async () => {
        if (++calls === 1) {
            entered.resolve();
            await release.promise;
        }
        return result();
    });
    Reflect.set(importer, '_importDictionary', body);
    const first = importer.importDictionary(database, null, details);
    await entered.promise;
    const ownerScope = Reflect.get(importer, '_directZipReads');
    try {
        await expect(importer.importDictionary(database, null, details)).rejects.toThrow('already has an active import');
        expect(body).toHaveBeenCalledOnce();
        expect(Reflect.get(importer, '_directZipReads')).toBe(ownerScope);
    } finally {
        release.resolve();
        await first;
    }
    expect(Reflect.get(importer, '_directZipReads')).toBeNull();
    await importer.importDictionary(database, null, details);
    expect(body).toHaveBeenCalledTimes(2);
});

test('synchronous setup reentry is rejected without resetting the active instance owner', async () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    /** @type {Promise<ImportResult>|null} */
    let nested = null;
    let calls = 0;
    Reflect.set(importer, '_importDictionary', async () => {
        if (++calls === 1) {
            nested = importer.importDictionary(database, null, details);
            // Attach a handler in the same turn; assertion still sees rejection.
            void nested.catch(() => {});
        }
        return result();
    });
    await importer.importDictionary(database, null, details);
    await expect(nested).rejects.toThrow('already has an active import');
    expect(calls).toBe(1);
    await importer.importDictionary(database, null, details);
    expect(calls).toBe(2);
});

test.each(['success', 'failure'])('instance ownership lasts through pending archive cleanup after %s', async (outcome) => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const closing = barrier();
    const release = barrier();
    let closes = 0;
    const close = vi.fn(async () => {
        if (++closes === 1) {
            closing.resolve();
            await release.promise;
        }
    });
    const failure = new Error('Archive setup failed');
    const body = vi.fn(async (
        /** @type {Database} */ _database,
        /** @type {ArrayBuffer|Blob|null} */ _content,
        /** @type {import('dictionary-importer').ImportDetails} */ _details,
        /** @type {ArchiveOwnership} */ owner,
    ) => {
        owner.own({close});
        if (outcome === 'failure') { throw failure; }
        return result();
    });
    Reflect.set(importer, '_importDictionary', body);
    const pending = importer.importDictionary(database, null, details);
    const checked = outcome === 'failure' ? expect(pending).rejects.toBe(failure) : expect(pending).resolves.toMatchObject({result: null});
    await closing.promise;
    try {
        await expect(importer.importDictionary(database, null, details)).rejects.toThrow('already has an active import');
        expect(body).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    } finally {
        release.resolve();
        await checked;
    }
    Reflect.set(importer, '_importDictionary', async () => result());
    await expect(importer.importDictionary(database, null, details)).resolves.toMatchObject({result: null});
});

test('setup and archive-close failures release the instance for a later import', async () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    Reflect.set(importer, '_importDictionary', async (
        /** @type {Database} */ _database,
        /** @type {ArrayBuffer|Blob|null} */ _content,
        /** @type {import('dictionary-importer').ImportDetails} */ _details,
        /** @type {ArchiveOwnership} */ owner,
    ) => {
        owner.own({close: async () => { throw new Error('Close failed'); }});
        throw new Error('Setup failed');
    });
    await expect(importer.importDictionary(database, null, details)).rejects.toBeInstanceOf(AggregateError);
    Reflect.set(importer, '_importDictionary', async () => result());
    await expect(importer.importDictionary(database, null, details)).resolves.toMatchObject({result: null});
});
