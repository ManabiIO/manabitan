/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

const logError = vi.fn();
vi.mock('../ext/js/core/log.js', () => ({log: {error: logError, warn: vi.fn()}}));
vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({reportDiagnostics: vi.fn()}));

const {DictionaryWorkerClient} = await import('../ext/js/background/dictionary-worker-client.js');
const {Offscreen} = await import('../ext/js/background/offscreen.js');

describe('Offscreen dictionary worker recovery', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        logError.mockReset();
    });

    test('routes Chromium lookups through the shared recovering client', async () => {
        class FakeWorker {
            /** @type {FakeWorker[]} */
            static instances = [];

            constructor() {
                this.listeners = new Map();
                this.postMessage = vi.fn();
                this.terminate = vi.fn();
                FakeWorker.instances.push(this);
            }

            /**
             * @param {string} type
             * @param {Function} listener
             */
            addEventListener(type, listener) {
                this.listeners.set(type, listener);
            }
        }
        vi.stubGlobal('Worker', FakeWorker);
        const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
        Reflect.set(offscreen, '_dictionaryWorkerClient', new DictionaryWorkerClient('/dictionary-worker.js', {
            context: 'Offscreen dictionary worker',
            onFatalError: (error) => { logError(error); },
        }));

        const promise = Reflect.get(Offscreen.prototype, '_invokeDictionaryWorker').call(
            offscreen,
            'findTermsOffscreen',
            {},
        );
        FakeWorker.instances[0].listeners.get('error')?.({message: 'crashed'});
        await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
        FakeWorker.instances[1].listeners.get('message')?.({data: {id: 2, result: {ok: true}}});

        await expect(promise).resolves.toEqual({ok: true});
        expect(logError).toHaveBeenCalledOnce();
    });
});
