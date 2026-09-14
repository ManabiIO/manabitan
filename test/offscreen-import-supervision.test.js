/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Offscreen} from '../ext/js/background/offscreen.js';

/**
 * @param {MessagePort} port
 * @param {number} timeoutMs
 * @returns {Promise<unknown|'timeout'>}
 */
function nextMessage(port, timeoutMs = 50) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve('timeout'), timeoutMs);
        port.onmessage = (event) => {
            clearTimeout(timeout);
            resolve(event.data);
        };
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Offscreen import supervision', () => {
    test('reports a worker failure after worker-side response-port ownership transfer', async () => {
        const offscreen = /** @type {InstanceType<typeof Offscreen>} */ (Object.create(Offscreen.prototype));
        const caller = new MessageChannel();
        const failure = new Error('dictionary worker crashed after accepting import');
        const invokeDictionaryWorker = vi.fn((_action, _params, transferables) => {
            const port = /** @type {MessagePort} */ (transferables[0]);
            structuredClone(port, {transfer: [port]});
            return Promise.reject(failure);
        });
        Reflect.set(offscreen, '_invokeDictionaryWorker', invokeDictionaryWorker);

        const messagePromise = nextMessage(caller.port1);
        Reflect.get(offscreen, '_importDictionaryOffscreenHandler').call(
            offscreen,
            {archiveContent: new Blob(['dictionary']), details: {}},
            [caller.port2],
        );

        const message = await messagePromise;
        expect(message).not.toBe('timeout');
        expect(message).toMatchObject({
            type: 'error',
            error: {message: failure.message},
        });
        expect(invokeDictionaryWorker).toHaveBeenCalledOnce();
        caller.port1.close();
    });

    test('forwards worker progress and completion through the supervised response channel', async () => {
        const offscreen = /** @type {InstanceType<typeof Offscreen>} */ (Object.create(Offscreen.prototype));
        const caller = new MessageChannel();
        /** @type {MessagePort|null} */
        let transferredPort = null;
        const invokeDictionaryWorker = vi.fn((_action, _params, transferables) => {
            const port = /** @type {MessagePort} */ (transferables[0]);
            transferredPort = structuredClone(port, {transfer: [port]});
            return new Promise(() => {});
        });
        Reflect.set(offscreen, '_invokeDictionaryWorker', invokeDictionaryWorker);

        const progressPromise = nextMessage(caller.port1);
        Reflect.get(offscreen, '_importDictionaryOffscreenHandler').call(
            offscreen,
            {archiveContent: new Blob(['dictionary']), details: {}},
            [caller.port2],
        );
        await vi.waitFor(() => expect(transferredPort).not.toBeNull());
        transferredPort?.postMessage({type: 'progress', progress: {step: 2}});
        expect(await progressPromise).toEqual({type: 'progress', progress: {step: 2}});

        const completePromise = nextMessage(caller.port1);
        transferredPort?.postMessage({type: 'complete', result: {title: 'Test'}});
        expect(await completePromise).toEqual({type: 'complete', result: {title: 'Test'}});
        caller.port1.close();
        transferredPort?.close();
    });
});
