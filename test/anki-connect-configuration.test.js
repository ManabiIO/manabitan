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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';

/**
 * @param {unknown} data
 * @returns {Response}
 */
function ankiResponse(data) {
    return new Response(JSON.stringify(data), {status: 200});
}

describe('AnkiConnect configuration-scoped version checks', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('checks the new server version instead of reusing the old server capability', async () => {
        /** @type {string[]} */
        const versionServers = [];
        vi.stubGlobal('fetch', async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
            const body = /** @type {{action: string}} */ (JSON.parse(String(init.body)));
            if (body.action === 'version') {
                versionServers.push(url);
                return ankiResponse(url === 'http://older-anki.test' ? 1 : 2);
            }
            return ankiResponse([]);
        });

        const client = new AnkiConnect();
        client.enabled = true;
        client.server = 'http://newer-anki.test';
        await expect(client.getDeckNames()).resolves.toStrictEqual([]);

        client.server = 'http://older-anki.test';
        await expect(client.getDeckNames()).rejects.toThrow('Extension and plugin versions incompatible');
        expect(versionServers).toStrictEqual(['http://newer-anki.test', 'http://older-anki.test']);
    });

    test('ignores a previous server version response after the endpoint switches', async () => {
        /** @type {((value: Response) => void)|null} */
        let releaseOldVersion = null;
        /** @type {string[]} */
        const versionServers = [];
        vi.stubGlobal('fetch', async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
            const body = /** @type {{action: string}} */ (JSON.parse(String(init.body)));
            if (body.action === 'version') {
                versionServers.push(url);
                if (url === 'http://old-anki.test') {
                    return await new Promise((resolve) => {
                        releaseOldVersion = resolve;
                    });
                }
                return ankiResponse(2);
            }
            return ankiResponse([]);
        });

        const client = new AnkiConnect();
        client.enabled = true;
        client.server = 'http://old-anki.test';
        const firstRequest = client.getDeckNames();
        client.server = 'http://new-anki.test';
        await expect(client.getDeckNames()).resolves.toStrictEqual([]);
        if (releaseOldVersion === null) { throw new Error('Old version request was not started'); }
        releaseOldVersion(ankiResponse(1));
        await expect(firstRequest).resolves.toStrictEqual([]);
        await expect(client.getDeckNames()).resolves.toStrictEqual([]);
        expect(versionServers).toStrictEqual(['http://old-anki.test', 'http://new-anki.test']);
    });

    test('rechecks version when API key changes or the connector is re-enabled', async () => {
        /** @type {(string|undefined)[]} */
        const keys = [];
        vi.stubGlobal('fetch', async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
            const body = /** @type {{action: string, key?: string}} */ (JSON.parse(String(init.body)));
            if (body.action === 'version') {
                keys.push(body.key);
                return ankiResponse(2);
            }
            return ankiResponse([]);
        });

        const client = new AnkiConnect();
        client.enabled = true;
        client.server = 'http://anki.test';
        client.apiKey = 'old-key';
        await client.getDeckNames();

        client.apiKey = 'new-key';
        await client.getDeckNames();

        client.enabled = false;
        client.enabled = true;
        await client.getDeckNames();
        expect(keys).toStrictEqual(['old-key', 'new-key', 'new-key']);
    });
});
