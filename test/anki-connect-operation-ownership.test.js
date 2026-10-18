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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {parseJson} from '../ext/js/core/json.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {string} expression
 * @returns {import('anki').Note}
 */
function note(expression) {
    return {
        fields: {Expression: expression},
        deckName: 'Japanese',
        modelName: 'Basic',
        tags: [],
        options: {allowDuplicate: false, duplicateScope: 'deck', duplicateScopeOptions: {deckName: 'Japanese', checkChildren: false, checkAllModels: false}},
    };
}

/**
 * @param {RequestInit|undefined} options
 * @returns {import('anki').MessageBody}
 */
function requestBody(options) {
    return /** @type {import('anki').MessageBody} */ (parseJson(String(options?.body)));
}

/** @returns {{client: AnkiConnect, fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>}} */
function setup() {
    const client = new AnkiConnect();
    client.enabled = true;
    client.server = 'http://localhost:8765';
    client.apiKey = 'first-key';
    const fetch = vi.fn(/** @type {typeof globalThis.fetch} */ (async (_url, options) => {
        const {action} = requestBody(options);
        let result;
        switch (action) {
            case 'version': result = 6; break;
            case 'addNote': result = 123; break;
            case 'findNotes': result = [11, 22]; break;
            default: result = [[11], [22]]; break;
        }
        return new Response(JSON.stringify(result));
    }));
    vi.stubGlobal('fetch', fetch);
    return {client, fetch};
}

/**
 * @param {AnkiConnect} client
 * @param {string} setting
 */
function changeConnection(client, setting) {
    if (setting === 'server') {
        client.server = 'http://localhost:8766';
    } else if (setting === 'apiKey') {
        client.apiKey = 'second-key';
    } else {
        client.enabled = false;
    }
}

describe.each(['server', 'apiKey', 'enabled'])('Anki operation ownership when %s changes', (setting) => {
    test('does not retarget a note between a cached version check and dispatch', async () => {
        const {client, fetch} = setup();
        await client.getVersion();
        fetch.mockClear();
        const pending = client.addNote(note('cat'));
        const rejected = expect(pending).rejects.toThrow('Anki connection settings changed');
        changeConnection(client, setting);

        await rejected;
        expect(fetch).not.toHaveBeenCalled();
    });

    test('does not revive an old operation when settings are restored', async () => {
        const {client, fetch} = setup();
        await client.getVersion();
        fetch.mockClear();
        const pending = client.addNote(note('cat'));
        const rejected = expect(pending).rejects.toThrow('Anki connection settings changed');
        changeConnection(client, setting);
        client.server = 'http://localhost:8765';
        client.apiKey = 'first-key';
        client.enabled = true;

        await rejected;
        expect(fetch).not.toHaveBeenCalled();
        expect(await client.addNote(note('dog'))).toBe(123);
        expect(fetch.mock.calls.map(([, options]) => requestBody(options).action)).toEqual(['version', 'addNote']);
    });

    test('does not retarget a note while its initial version check is pending', async () => {
        const {client, fetch} = setup();
        const version = /** @type {import('core').DeferredPromiseDetails<Response>} */ (deferPromise());
        fetch.mockReturnValueOnce(version.promise);
        const pending = client.addNote(note('cat'));
        const rejected = expect(pending).rejects.toThrow('Anki connection settings changed');
        changeConnection(client, setting);
        version.resolve(new Response('6'));

        await rejected;
        expect(fetch).toHaveBeenCalledOnce();
        expect(requestBody(fetch.mock.calls[0][1]).action).toBe('version');
    });

    test('does not publish a note result if settings change before its caller resumes', async () => {
        const {client, fetch} = setup();
        await client.getVersion();
        fetch.mockClear();
        const invoke = client._invoke.bind(client);
        vi.spyOn(client, '_invoke').mockImplementation((...args) => {
            const pending = invoke(...args);
            if (args[0] === 'addNote') {
                void pending.then(() => { changeConnection(client, setting); }, () => {});
            }
            return pending;
        });

        await expect(client.addNote(note('cat'))).rejects.toThrow('Anki connection settings changed');
        expect(fetch).toHaveBeenCalledOnce();
    });

    test.each(['response', 'body'])('does not publish a note result after a stale %s completes', async (stage) => {
        const {client, fetch} = setup();
        await client.getVersion();
        fetch.mockClear();
        const entered = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const response = /** @type {import('core').DeferredPromiseDetails<Response>} */ (deferPromise());
        const body = /** @type {import('core').DeferredPromiseDetails<string>} */ (deferPromise());
        const result = new Response('123');
        if (stage === 'body') {
            vi.spyOn(result, 'text').mockImplementation(() => {
                entered.resolve();
                return body.promise;
            });
            fetch.mockResolvedValueOnce(result);
        } else {
            fetch.mockImplementationOnce(() => {
                entered.resolve();
                return response.promise;
            });
        }
        const pending = client.addNote(note('cat'));
        const rejected = expect(pending).rejects.toThrow('Anki connection settings changed');
        await entered.promise;
        changeConnection(client, setting);
        if (stage === 'body') {
            body.resolve('123');
        } else {
            response.resolve(result);
        }

        await rejected;
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe('http://localhost:8765');
        expect(requestBody(fetch.mock.calls[0][1])).toMatchObject({action: 'addNote', key: 'first-key'});
    });
});

test.each(['server', 'apiKey'])('does not mix candidate note IDs across %s configurations', async (setting) => {
    const {client, fetch} = setup();
    await client.getVersion();
    fetch.mockClear();
    const invoke = client._invoke.bind(client);
    vi.spyOn(client, '_invoke').mockImplementation((...args) => {
        const pending = invoke(...args);
        if (args[0] === 'findNotes') {
            // This runs after transport completion, before the composite caller resumes.
            void pending.then(() => { changeConnection(client, setting); }, () => {});
        }
        return pending;
    });

    await expect(client.findNoteIds([note('cat'), note('dog')])).rejects.toThrow('Anki connection settings changed');
    expect(fetch).toHaveBeenCalledOnce();
    expect(requestBody(fetch.mock.calls[0][1]).action).toBe('findNotes');
});

test('unchanged connection adds a note normally', async () => {
    const {client, fetch} = setup();
    expect(await client.addNote(note('cat'))).toBe(123);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, options]) => requestBody(options).action)).toEqual(['version', 'addNote']);
});

test('an ordinary connection failure does not poison subsequent version checks', async () => {
    const {client, fetch} = setup();
    fetch.mockRejectedValueOnce(new Error('temporarily unreachable'));
    await expect(client.addNote(note('cat'))).rejects.toThrow('Anki connection failure');
    expect(await client.addNote(note('dog'))).toBe(123);
    expect(fetch.mock.calls.map(([, options]) => requestBody(options).action)).toEqual(['version', 'version', 'addNote']);
});
