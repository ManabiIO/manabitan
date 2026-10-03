/*
 * Copyright (C) 2026 Manabitan authors
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

import {describe, expect, test, vi} from 'vitest';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {deferPromise} from '../ext/js/core/utilities.js';

/** @returns {AnkiConnect} */
function createClient() {
    const client = new AnkiConnect();
    client.enabled = true;
    client.server = 'http://localhost:8765';
    client.apiKey = 'first-key';
    return client;
}

/**
 * @param {AnkiConnect} client
 * @param {string} setting
 */
function changeConnection(client, setting) {
    if (setting === 'server') {
        client.server = 'http://localhost:8766';
    } else {
        client.apiKey = 'second-key';
    }
}

describe.each(['server', 'apiKey'])('Anki version ownership after changing %s', (setting) => {
    test('does not trust the previous connection version', async () => {
        const client = createClient();
        const version = vi.spyOn(client, '_getVersion').mockResolvedValueOnce(6).mockResolvedValue(1);
        const invoke = vi.spyOn(client, '_invoke').mockResolvedValue(['Japanese']);
        expect(await client.getDeckNames()).toEqual(['Japanese']);
        changeConnection(client, setting);

        await expect(client.getDeckNames()).rejects.toThrow('versions incompatible');
        expect(version).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenCalledOnce();
    });

    test.each(['resolve', 'reject'])('ignores an obsolete version request that will %s', async (outcome) => {
        const client = createClient();
        const old = /** @type {import('core').DeferredPromiseDetails<number>} */ (deferPromise());
        const current = /** @type {import('core').DeferredPromiseDetails<number>} */ (deferPromise());
        const version = vi.spyOn(client, '_getVersion').mockReturnValueOnce(old.promise).mockReturnValue(current.promise);
        const invoke = vi.spyOn(client, '_invoke').mockResolvedValue(['Japanese']);
        const first = client.getDeckNames();
        const firstResult = first.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        changeConnection(client, setting);
        const second = client.getDeckNames();
        const secondResult = second.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        expect(version).toHaveBeenCalledTimes(2);

        if (outcome === 'resolve') {
            old.resolve(1);
        } else {
            old.reject(new Error('old connection failed'));
        }
        // An obsolete completion must neither settle callers nor clear the new flight.
        await old.promise.catch(() => {});
        expect(invoke).not.toHaveBeenCalled();
        const third = client.getDeckNames();
        const thirdResult = third.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        expect(version).toHaveBeenCalledTimes(2);
        current.resolve(6);

        const results = await Promise.all([firstResult, secondResult, thirdResult]);
        expect(results).toEqual(new Array(3).fill({value: ['Japanese'], error: null}));
        expect(version).toHaveBeenCalledTimes(2);
    });
});

test('identical Anki connection settings retain a successful version check', async () => {
    const client = createClient();
    const version = vi.spyOn(client, '_getVersion').mockResolvedValue(6);
    vi.spyOn(client, '_invoke').mockResolvedValue(['Japanese']);
    await client.getDeckNames();
    client.server = 'http://localhost:8765';
    client.apiKey = 'first-key';
    await client.getDeckNames();
    expect(version).toHaveBeenCalledOnce();
});
