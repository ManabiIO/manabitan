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
function nextMessage(port, timeoutMs = 250) {
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
    vi.unstubAllGlobals();
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
        const handlerResult = Reflect.get(offscreen, '_importDictionaryOffscreenHandler').call(
            offscreen,
            {operationId: `${Date.now()}:test`, archiveContent: new Blob(['dictionary']), details: {}},
            [caller.port2],
        );
        expect(handlerResult).toBeUndefined();

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
        const handlerResult = Reflect.get(offscreen, '_importDictionaryOffscreenHandler').call(
            offscreen,
            {operationId: `${Date.now()}:test`, archiveContent: new Blob(['dictionary']), details: {}},
            [caller.port2],
        );
        expect(handlerResult).toBeUndefined();
        await vi.waitFor(() => expect(transferredPort).not.toBeNull());
        const workerPort = /** @type {MessagePort} */ (/** @type {unknown} */ (transferredPort));
        workerPort.postMessage({type: 'progress', progress: {step: 2}});
        expect(await progressPromise).toEqual({type: 'progress', progress: {step: 2}});

        const completePromise = nextMessage(caller.port1);
        workerPort.postMessage({type: 'complete', result: {title: 'Test'}});
        expect(await completePromise).toEqual({type: 'complete', result: {title: 'Test'}});
        caller.port1.close();
        workerPort.close();
    });
});


function createSupervisedImportFixture() {
    const offscreen = /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
    const caller = new MessageChannel();
    const NativeMessageChannel = MessageChannel;
    /** @type {MessageChannel[]} */
    const channels = [];
    vi.stubGlobal('MessageChannel', class extends NativeMessageChannel {
        constructor() {
            super();
            channels.push(this);
            vi.spyOn(this.port1, 'close');
        }
    });
    /** @type {PromiseWithResolvers<unknown>} */
    const finished = Promise.withResolvers();
    /** @type {MessagePort|null} */
    let workerPort = null;
    Reflect.set(offscreen, '_invokeDictionaryWorker', vi.fn((_action, _params, transferables) => {
        workerPort = structuredClone(transferables[0], {transfer: transferables});
        return finished.promise;
    }));
    /** @type {unknown[]} */
    const received = [];
    caller.port1.onmessage = (event) => { received.push(event.data); };
    offscreen._importDictionaryOffscreenHandler({operationId: `${Date.now()}:supervision`, archiveContent: new Blob([]), details: /** @type {import('dictionary-importer').ImportDetails} */ ({})}, [caller.port2]);
    if (!workerPort) { throw new Error('Worker response port was not transferred'); }
    const channel = channels[0];
    return {
        channel,
        workerPort: /** @type {MessagePort} */ (workerPort),
        finished,
        received,
        failPacket() { channel.port1.dispatchEvent(new MessageEvent('messageerror')); },
        close() {
            finished.resolve(void 0);
            for (const value of channels) {
                value.port1.close();
                value.port2.close();
            }
            if (workerPort) { /** @type {MessagePort} */ (workerPort).close(); }
            caller.port1.close();
            caller.port2.close();
        },
    };
}

test('offscreen response messageerror preserves a still-running worker relay and later completion', async () => {
    const fixture = createSupervisedImportFixture();
    try {
        fixture.failPacket();
        expect(fixture.channel.port1.close).not.toHaveBeenCalled();
        expect(fixture.received).toEqual([]);
        const completion = {type: 'complete', result: {result: {title: 'Published'}, errors: [], outcome: {status: 'published'}}};
        fixture.workerPort.postMessage(completion);
        await vi.waitFor(() => expect(fixture.received).toEqual([completion]));
        fixture.finished.resolve(void 0);
        await fixture.finished.promise;
        expect(fixture.channel.port1.close).toHaveBeenCalledOnce();
    } finally {
        fixture.close();
    }
});

test.each(['before', 'after'])('a lost offscreen terminal packet reports transport failure only after worker settlement (%s acknowledgement)', async (acknowledgement) => {
    const fixture = createSupervisedImportFixture();
    try {
        if (acknowledgement === 'before') {
            fixture.finished.resolve(void 0);
            await fixture.finished.promise;
            await Promise.resolve();
        }
        fixture.failPacket();
        if (acknowledgement === 'after') {
            expect(fixture.received).toEqual([]);
            fixture.finished.resolve(void 0);
            await fixture.finished.promise;
        }
        await vi.waitFor(() => expect(fixture.received).toHaveLength(1));
        expect(fixture.received[0]).toMatchObject({type: 'error', error: {name: 'DictionaryImportTransportError'}});
        fixture.failPacket();
        await Promise.resolve();
        expect(fixture.received).toHaveLength(1);
    } finally {
        fixture.close();
    }
});

test('worker invocation failure after a response packet failure still reports an uncertain terminal outcome', async () => {
    const fixture = createSupervisedImportFixture();
    try {
        fixture.failPacket();
        const failure = new Error('Worker crashed');
        failure.name = 'DictionaryWorkerTransportError';
        fixture.finished.reject(failure);
        await vi.waitFor(() => expect(fixture.received).toHaveLength(1));
        expect(fixture.received[0]).toMatchObject({type: 'error', error: {name: 'DictionaryImportTransportError', message: 'Worker crashed'}});
    } finally {
        fixture.close();
    }
});
