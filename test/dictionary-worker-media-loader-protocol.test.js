/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {expect, test} from 'vitest';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {DictionaryWorkerMediaLoader} from '../ext/js/dictionary/dictionary-worker-media-loader.js';

/**
 * @typedef {{action: string, params: {id: string, content: ArrayBuffer, mediaType: string}}} OutgoingMessage
 * @typedef {{loader: DictionaryWorkerMediaLoader, messages: OutgoingMessage[]}} Fixture
 */

/**
 * Only postMessage is mocked; the production loader, decoder and timers are real.
 * @param {(fixture: Fixture) => Promise<void>} callback
 * @param {boolean} [failPosting]
 * @returns {Promise<void>}
 */
async function withLoader(callback, failPosting = false) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
    /** @type {OutgoingMessage[]} */
    const messages = [];
    Object.defineProperty(globalThis, 'self', {
        configurable: true,
        value: {
            /** @param {OutgoingMessage} message */
            postMessage(message) {
                if (failPosting) { throw new Error('postMessage failed'); }
                messages.push(message);
            },
        },
    });
    const loader = new DictionaryWorkerMediaLoader();
    try {
        await callback({loader, messages});
    } finally {
        for (const {timer} of loader._requests.values()) { clearTimeout(timer); }
        loader._requests.clear();
        if (typeof descriptor === 'undefined') {
            Reflect.deleteProperty(globalThis, 'self');
        } else {
            Object.defineProperty(globalThis, 'self', descriptor);
        }
    }
}

/**
 * Observe a potentially pending promise without awaiting it indefinitely.
 * @param {Promise<unknown>} promise
 * @returns {{status: string, value?: unknown}}
 */
function observe(promise) {
    /** @type {{status: string, value?: unknown}} */
    const state = {status: 'pending'};
    void promise.then((value) => {
        state.status = 'resolved';
        state.value = value;
    }, (value) => {
        state.status = 'rejected';
        state.value = value;
    });
    return state;
}

/**
 * The null error deliberately models a malformed protocol response.
 * @param {DictionaryWorkerMediaLoader} loader
 * @param {string} id
 * @returns {unknown}
 */
function deliverMalformedError(loader, id) {
    try {
        loader.handleMessage(/** @type {import('dictionary-worker-media-loader').HandleMessageParams} */ (
            /** @type {unknown} */ ({id, error: null})
        ));
    } catch (e) {
        return e;
    }
    return void 0;
}

test('malformed media error rejects instead of leaving a cleared request pending', async () => {
    await withLoader(async ({loader, messages}) => {
        const state = observe(loader.getImageDetails(new ArrayBuffer(0), 'image/png'));
        const thrown = deliverMalformedError(loader, messages[0].params.id);
        await Promise.resolve();
        expect(state.status).toBe('rejected');
        expect(state.value instanceof TypeError).toBe(true);
        expect(thrown).toBe(void 0);
        expect(loader._requests.size).toBe(0);
    });
});

test('valid media results retain object identity and clear their pending request', async () => {
    await withLoader(async ({loader, messages}) => {
        const content = new ArrayBuffer(0);
        const state = observe(loader.getImageDetails(content, 'image/png'));
        const result = {content, width: 13, height: 17};
        loader.handleMessage({id: messages[0].params.id, result});
        await Promise.resolve();
        expect(state.status).toBe('resolved');
        expect(state.value).toBe(result);
        expect(loader._requests.size).toBe(0);
    });
});

test('valid serialized ExtensionErrors preserve their message and data', async () => {
    await withLoader(async ({loader, messages}) => {
        const state = observe(loader.getImageDetails(new ArrayBuffer(0), 'image/png'));
        const error = new ExtensionError('cannot decode image');
        error.data = {path: 'image.png'};
        loader.handleMessage({id: messages[0].params.id, error: ExtensionError.serialize(error)});
        await Promise.resolve();
        expect(state.status).toBe('rejected');
        expect(state.value instanceof ExtensionError).toBe(true);
        const decoded = /** @type {ExtensionError} */ (state.value);
        expect(decoded.message).toBe(error.message);
        expect(decoded.data).toEqual(error.data);
        expect(loader._requests.size).toBe(0);
    });
});

test('unknown and duplicate responses do not disturb an active media request', async () => {
    await withLoader(async ({loader, messages}) => {
        const content = new ArrayBuffer(0);
        const state = observe(loader.getImageDetails(content, 'image/png'));
        expect(deliverMalformedError(loader, 'unknown-request-id')).toBe(void 0);
        expect(loader._requests.size).toBe(1);
        const result = {content, width: 1, height: 1};
        const id = messages[0].params.id;
        loader.handleMessage({id, result});
        expect(deliverMalformedError(loader, id)).toBe(void 0);
        await Promise.resolve();
        expect(state.status).toBe('resolved');
        expect(state.value).toBe(result);
        expect(loader._requests.size).toBe(0);
    });
});

test('a malformed response settles only its request while another completes normally', async () => {
    await withLoader(async ({loader, messages}) => {
        const content = new ArrayBuffer(0);
        const first = observe(loader.getImageDetails(content, 'image/png'));
        const second = observe(loader.getImageDetails(content, 'image/png'));
        const thrown = deliverMalformedError(loader, messages[0].params.id);
        expect(loader._requests.size).toBe(1);
        const result = {content, width: 2, height: 3};
        loader.handleMessage({id: messages[1].params.id, result});
        await Promise.resolve();
        expect(first.status).toBe('rejected');
        expect(second.status).toBe('resolved');
        expect(second.value).toBe(result);
        expect(thrown).toBe(void 0);
        expect(loader._requests.size).toBe(0);
    });
});

test('postMessage failure still rejects and removes its timer-backed request', async () => {
    await withLoader(async ({loader}) => {
        const state = observe(loader.getImageDetails(new ArrayBuffer(0), 'image/png'));
        await Promise.resolve();
        expect(state.status).toBe('rejected');
        expect((/** @type {Error} */ (state.value)).message).toBe('postMessage failed');
        expect(loader._requests.size).toBe(0);
    }, true);
});
