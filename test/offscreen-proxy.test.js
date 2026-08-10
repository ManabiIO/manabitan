/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({reportDiagnostics: vi.fn()}));

const {DictionaryRuntimeWorkerProxy, TranslatorProxy} = await import('../ext/js/background/offscreen-proxy.js');

describe('DictionaryRuntimeWorkerProxy', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('uses shared recovery and lookup retry behavior', async () => {
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
        const proxy = new DictionaryRuntimeWorkerProxy('/dictionary-worker.js');
        const promise = proxy.sendMessagePromise(/** @type {import('offscreen').ApiMessageAny} */ ({action: 'findTermsOffscreen'}));
        FakeWorker.instances[0].listeners.get('error')?.({message: 'crashed'});

        await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
        expect(FakeWorker.instances[1].postMessage).toHaveBeenCalledWith(
            {id: 2, action: 'findTermsOffscreen', params: {}},
            [],
        );
        FakeWorker.instances[1].listeners.get('message')?.({data: {id: 2, result: {ok: true}}});
        await expect(promise).resolves.toEqual({ok: true});
    });

    test('forwards transferred import ports as one-way requests', async () => {
        class FakeWorker {
            constructor() {
                this.postMessage = vi.fn();
            }

            addEventListener() {}
        }
        vi.stubGlobal('Worker', FakeWorker);
        const proxy = new DictionaryRuntimeWorkerProxy('/dictionary-worker.js');
        const port = /** @type {MessagePort} */ (/** @type {unknown} */ ({name: 'response-port'}));

        await proxy.sendMessageViaPort(
            {action: 'importDictionaryOffscreen', params: {archiveContent: new Blob([]), details: {}}},
            [port],
        );

        const client = Reflect.get(proxy, '_client');
        const worker = Reflect.get(client, '_worker');
        expect(worker.postMessage).toHaveBeenCalledWith(
            {id: 1, action: 'importDictionaryOffscreen', params: {archiveContent: expect.any(Blob), details: {}}},
            [port],
        );
    });
});

describe('TranslatorProxy', () => {
    test('sends native lookup settings through the structured-clone transport', async () => {
        const sendMessageViaPort = vi.fn(async () => ({dictionaryEntries: [], originalTextLength: 0}));
        const messenger = /** @type {ConstructorParameters<typeof TranslatorProxy>[0]} */ (/** @type {unknown} */ ({sendMessageViaPort}));
        const proxy = new TranslatorProxy(messenger);
        const enabledDictionaryMap = new Map([['JMdict', {
            index: 0,
            alias: 'JMdict',
            allowSecondarySearches: false,
            partsOfSpeechFilter: true,
            useDeinflections: true,
        }]]);
        const excludeDictionaryDefinitions = new Set(['Excluded']);
        const textReplacements = [[{pattern: /a\/b\\c/giu, replacement: 'x'}]];
        const options = /** @type {import('translation').FindTermsOptions} */ ({
            enabledDictionaryMap,
            excludeDictionaryDefinitions,
            textReplacements,
        });

        await proxy.findTerms('group', 'first', options);
        await proxy.findTerms('group', 'second', options);

        expect(sendMessageViaPort).toHaveBeenCalledTimes(2);
        expect(sendMessageViaPort.mock.calls[0][0]).toEqual({
            action: 'findTermsStructuredOffscreen',
            params: {mode: 'group', text: 'first', options},
        });
        expect(sendMessageViaPort.mock.calls[0][1]).toEqual([]);
        expect(sendMessageViaPort.mock.calls[0][0].params.options.enabledDictionaryMap).toBe(enabledDictionaryMap);
        expect(sendMessageViaPort.mock.calls[0][0].params.options.excludeDictionaryDefinitions).toBe(excludeDictionaryDefinitions);
        expect(sendMessageViaPort.mock.calls[0][0].params.options.textReplacements[0][0].pattern).toBeInstanceOf(RegExp);
    });
});
