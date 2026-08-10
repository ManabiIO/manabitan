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

vi.mock('../ext/js/core/log.js', () => ({log: {error: vi.fn(), warn: vi.fn()}}));

const {Offscreen} = await import('../ext/js/background/offscreen.js');

/**
 * @param {Offscreen} offscreen
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @param {MessagePort[]} [ports]
 * @returns {{controlPort: MessagePort & {postMessage: ReturnType<typeof vi.fn>}}}
 */
function dispatchControlMessage(offscreen, action, params = {}, ports = []) {
    const controlPort = /** @type {MessagePort & {postMessage: ReturnType<typeof vi.fn>}} */ (/** @type {unknown} */ ({
        postMessage: vi.fn(),
    }));
    Reflect.get(Offscreen.prototype, '_onMcMessage').call(offscreen, {
        currentTarget: controlPort,
        data: {id: 7, action, params},
        ports,
    });
    return {controlPort};
}

describe('Offscreen control message acknowledgements', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('acknowledges a completed transferred-port setup', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        const handler = vi.fn(async () => {});
        Reflect.set(offscreen, '_mcApiMap', new Map([['connectToDatabaseWorker', handler]]));

        const {controlPort} = dispatchControlMessage(offscreen, 'connectToDatabaseWorker');

        await vi.waitFor(() => expect(controlPort.postMessage).toHaveBeenCalledWith({id: 7, result: undefined}));
        expect(handler).toHaveBeenCalledOnce();
    });

    test('returns setup failures through the control channel', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        Reflect.set(offscreen, '_mcApiMap', new Map([
            ['connectToDatabaseWorker', async () => { throw new Error('Database preparation failed'); }],
        ]));

        const {controlPort} = dispatchControlMessage(offscreen, 'connectToDatabaseWorker');

        await vi.waitFor(() => expect(controlPort.postMessage).toHaveBeenCalledWith({
            id: 7,
            error: expect.objectContaining({message: 'Database preparation failed'}),
        }));
    });

    test('returns structured lookup results through the control channel', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        const result = {dictionaryEntries: [{id: 1}], originalTextLength: 2};
        Reflect.set(offscreen, '_mcApiMap', new Map([
            ['findTermsStructuredOffscreen', async () => result],
        ]));

        const {controlPort} = dispatchControlMessage(offscreen, 'findTermsStructuredOffscreen');

        await vi.waitFor(() => expect(controlPort.postMessage).toHaveBeenCalledWith({id: 7, result}));
    });

    test('acknowledges import dispatch before the streamed import completes', async () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        /** @type {(reason?: unknown) => void} */
        let rejectImport = () => {};
        const invoke = vi.fn(() => new Promise((_resolve, reject) => { rejectImport = reject; }));
        Reflect.set(offscreen, '_dictionaryWorkerClient', {invoke});
        Reflect.set(offscreen, '_mcApiMap', new Map([
            ['importDictionaryOffscreen', Reflect.get(Offscreen.prototype, '_importDictionaryOffscreenHandler').bind(offscreen)],
        ]));
        const responsePort = /** @type {MessagePort & {postMessage: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>}} */ (/** @type {unknown} */ ({
            postMessage: vi.fn(),
            close: vi.fn(),
        }));

        const {controlPort} = dispatchControlMessage(
            offscreen,
            'importDictionaryOffscreen',
            {archiveContent: new Blob([]), details: {}},
            [responsePort],
        );

        expect(controlPort.postMessage).toHaveBeenCalledWith({id: 7, result: undefined});
        expect(responsePort.postMessage).not.toHaveBeenCalled();
        rejectImport(new Error('Import worker failed'));
        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith({
            type: 'error',
            error: expect.objectContaining({message: 'Import worker failed'}),
        }));
        expect(responsePort.close).toHaveBeenCalledOnce();
    });

    test('returns an error for unknown control actions', () => {
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        Reflect.set(offscreen, '_mcApiMap', new Map());

        const {controlPort} = dispatchControlMessage(offscreen, 'unknownAction');

        expect(controlPort.postMessage).toHaveBeenCalledWith({
            id: 7,
            error: expect.objectContaining({message: 'Unknown offscreen control action: unknownAction'}),
        });
    });
});
