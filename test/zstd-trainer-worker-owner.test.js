/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {ZstdTrainerWorkerOwner, ZstdTrainingUnavailableError} from '../ext/js/dictionary/zstd-trainer-worker-owner.js';

// Real structuredClone transfer semantics: assertions must catch detached borrowed data.
class FakeWorker {
    constructor() {
        /** @type {Map<string, Set<(event: import('core').SafeAny) => void>>} */
        this.listeners = new Map();
        this.terminate = vi.fn();
        this.postMessage = vi.fn((message, transfers) => {
            this.received = structuredClone(message, {transfer: transfers});
        });
    }

    /**
     * @param {string} type
     * @param {(event: import('core').SafeAny) => void} listener
     */
    addEventListener(type, listener) {
        let listeners = this.listeners.get(type);
        if (typeof listeners === 'undefined') {
            listeners = new Set();
            this.listeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    /**
     * @param {string} type
     * @param {(event: import('core').SafeAny) => void} listener
     */
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    /**
     * @param {string} type
     * @param {import('core').SafeAny} event
     */
    emit(type, event) {
        for (const listener of (this.listeners.get(type) ?? [])) { listener(event); }
    }

    listenerCount() {
        let count = 0;
        for (const set of this.listeners.values()) { count += set.size; }
        return count;
    }

    reply(overrides = {}) {
        const dictionary = new Uint8Array(16).fill(7);
        const data = structuredClone({id: this.received.id, dictionary, initializeMs: 4, trainMs: 12, heapBytes: 65536, ...overrides}, {transfer: [dictionary.buffer]});
        this.emit('message', {data});
    }
}

function input() {
    const source = new Uint8Array(40).fill(9);
    const table = new Uint8Array(40).fill(255);
    const lengths = table.subarray(4, 36);
    const view = new DataView(lengths.buffer, lengths.byteOffset, lengths.byteLength);
    for (let i = 0; i < 8; ++i) { view.setUint32(i * 4, 4, true); }
    return {source, table, request: {samples: source.subarray(4, 36), lengths, dictionaryCapacity: 1024}};
}

function setup(options = {}) {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => /** @type {Worker} */ (/** @type {unknown} */ (worker)));
    const owner = new ZstdTrainerWorkerOwner({createWorker, timeoutMs: 50, ...options});
    return {worker, createWorker, owner};
}

function trackedAbort() {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    return {controller, add, remove};
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

test('does not construct or load a worker before admission; invalid/preaborted jobs never start', async () => {
    const {owner, worker, createWorker} = setup();
    expect(createWorker).not.toHaveBeenCalled();
    const {controller, add} = trackedAbort();
    controller.abort(new Error('Foreground lookup'));
    await expect(owner.train(input().request, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(createWorker).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const invalid = setup();
    const request = input().request;
    request.lengths.fill(0);
    await expect(invalid.owner.train(request)).rejects.toBeInstanceOf(TypeError);
    expect(invalid.createWorker).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

test('transfers private exact copies of borrowed subarrays and returns owned output after disposal', async () => {
    const {owner, worker} = setup();
    const {source, table, request} = input();
    const originalSource = [...source];
    const originalTable = [...table];
    const {controller, add, remove} = trackedAbort();
    const promise = owner.train(request, {signal: controller.signal});
    const [posted, transfers] = worker.postMessage.mock.calls[0];
    expect(posted.samples.byteLength).toBe(0); // Real transfer detached the private copy.
    expect(posted.lengths.byteLength).toBe(0);
    expect(transfers).toHaveLength(2);
    expect(worker.received.samples.byteOffset).toBe(0);
    expect(worker.received.samples.buffer.byteLength).toBe(32);
    expect(worker.received.lengths.byteOffset).toBe(0);
    expect(worker.received.lengths.buffer.byteLength).toBe(32);
    expect(source).toEqual(originalSource);
    expect(table).toEqual(originalTable);
    expect(source.byteLength).toBe(40);
    worker.reply();
    const result = await promise;
    expect(result).toEqual({dictionary: new Uint8Array(16).fill(7), initializeMs: 4, trainMs: 12, heapBytes: 65536});
    expect(result.dictionary.buffer.byteLength).toBe(16);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(result.dictionary[0]).toBe(7);
});

test('foreground abort synchronously terminates CPU work, settles once, and ignores queued late success', async () => {
    const {owner, worker} = setup();
    const {controller, add, remove} = trackedAbort();
    const promise = owner.train(input().request, {signal: controller.signal});
    const settled = vi.fn();
    void promise.then(settled, settled);
    const queued = [...worker.listeners.get('message') ?? []][0];
    const id = worker.received.id;
    controller.abort(new Error('Foreground lookup'));
    expect(worker.terminate).toHaveBeenCalledTimes(1); // Before a microtask or worker reply.
    queued({data: {id, dictionary: new Uint8Array(16), initializeMs: 0, trainMs: 0, heapBytes: 65536}});
    await expect(promise).rejects.toMatchObject({name: 'AbortError'});
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
});

test('finite timeout releases a stuck worker without cooperative acknowledgement', async () => {
    const {owner, worker} = setup();
    const promise = owner.train(input().request);
    const rejection = expect(promise).rejects.toMatchObject({name: 'ZstdTrainingUnavailableError', message: 'Optional Zstd training timed out'});
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test('mismatched job ids cannot finish another live job; training failure kinds remain distinct', async () => {
    const first = setup();
    const old = first.owner.train(input().request);
    const oldId = first.worker.received.id;
    first.worker.reply({error: 'Corpus not trainable', errorKind: 'corpus'});
    await expect(old).rejects.toMatchObject({name: 'ZstdTrainingCorpusError'});
    const second = setup();
    const current = second.owner.train(input().request);
    expect(second.worker.received.id).not.toBe(oldId);
    second.worker.reply({id: oldId});
    expect(second.worker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    second.worker.reply();
    await expect(current).resolves.toHaveProperty('dictionary');
    expect(second.worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

for (const [errorKind, name] of [
    ['invalid-input', 'TypeError'],
    ['resource', 'ZstdTrainingResourceError'],
    ['invalid-output', 'ZstdTrainingOutputError'],
    ['unavailable', 'ZstdTrainingUnavailableError'],
]) {
    test('maps trainer failure kind ' + errorKind, async () => {
        const {owner, worker} = setup();
        const promise = owner.train(input().request);
        worker.reply({error: 'Trainer failure', errorKind});
        await expect(promise).rejects.toMatchObject({name});
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(worker.listenerCount()).toBe(0);
    });
}

for (const type of ['error', 'messageerror']) {
    test(type + ' disposes listeners, timer, and abort observer', async () => {
        const {owner, worker} = setup();
        const {controller, add, remove} = trackedAbort();
        const promise = owner.train(input().request, {signal: controller.signal});
        const event = {error: new Error('Worker crashed'), preventDefault: vi.fn()};
        worker.emit(type, event);
        await expect(promise).rejects.toBeInstanceOf(ZstdTrainingUnavailableError);
        if (type === 'error') { expect(event.preventDefault).toHaveBeenCalledTimes(1); }
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(worker.listenerCount()).toBe(0);
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
        expect(vi.getTimerCount()).toBe(0);
    });
}

test('postMessage failure makes no transfer assumption and leaves borrowed sources usable', async () => {
    const {owner, worker} = setup();
    const {source, table, request} = input();
    worker.postMessage.mockImplementation(() => { throw new DOMException('Clone failed', 'DataCloneError'); });
    const promise = owner.train(request);
    await expect(promise).rejects.toBeInstanceOf(ZstdTrainingUnavailableError);
    const [posted] = worker.postMessage.mock.calls[0];
    expect(posted.samples.byteLength).toBe(32); // Throws before transfer.
    expect(posted.lengths.byteLength).toBe(32);
    expect(source.byteLength).toBe(40);
    expect(table.byteLength).toBe(40);
    expect(worker.listenerCount()).toBe(0);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

test('factory failure is observed without a worker or timer', async () => {
    const {owner} = setup({createWorker: () => { throw new Error('Asset unavailable'); }});
    await expect(owner.train(input().request)).rejects.toBeInstanceOf(ZstdTrainingUnavailableError);
    expect(vi.getTimerCount()).toBe(0);
});

test('factory-triggered abort still terminates its just-created worker', async () => {
    const {controller} = trackedAbort();
    const worker = new FakeWorker();
    const owner = new ZstdTrainerWorkerOwner({createWorker: () => {
        controller.abort();
        return /** @type {Worker} */ (/** @type {unknown} */ (worker));
    }});
    await expect(owner.train(input().request, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

for (const bad of [{dictionary: new Uint8Array(2)}, {initializeMs: Number.NaN}, {trainMs: -1}, {heapBytes: Infinity}]) {
    test('invalid matching response cannot escape as trained dictionary: ' + Object.keys(bad)[0], async () => {
        const {owner, worker} = setup();
        const promise = owner.train(input().request);
        worker.reply(bad);
        await expect(promise).rejects.toBeInstanceOf(ZstdTrainingUnavailableError);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(worker.listenerCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
}

test('a borrowed output subarray is made exact before its owning slab can be discarded', async () => {
    const {owner, worker} = setup();
    const promise = owner.train(input().request);
    const slab = new Uint8Array(100).fill(5);
    worker.emit('message', {data: {id: worker.received.id, dictionary: slab.subarray(4, 20), initializeMs: 0, trainMs: 1, heapBytes: 65536}});
    const {dictionary} = await promise;
    slab.fill(0);
    expect(dictionary).toEqual(new Uint8Array(16).fill(5));
    expect(dictionary.byteOffset).toBe(0);
    expect(dictionary.buffer.byteLength).toBe(16);
});

test('one owner admits exactly one disposable job', async () => {
    const {owner, worker, createWorker} = setup();
    const first = owner.train(input().request);
    await expect(owner.train(input().request)).rejects.toThrow('already used');
    expect(createWorker).toHaveBeenCalledTimes(1);
    worker.reply();
    await first;
    await expect(owner.train(input().request)).rejects.toThrow('already used');
    expect(createWorker).toHaveBeenCalledTimes(1);
});

for (const timeoutMs of [0, -1, Infinity, Number.NaN, 2147483648]) {
    test('rejects unbounded or unsafe timer option ' + timeoutMs, () => {
        expect(() => new ZstdTrainerWorkerOwner({timeoutMs})).toThrow(RangeError);
    });
}


test('postMessage failure after transfer still preserves caller-owned sources', async () => {
    const {owner, worker} = setup();
    const {source, table, request} = input();
    worker.postMessage.mockImplementation((message, transfers) => {
        structuredClone(message, {transfer: transfers});
        throw new TypeError('Injected transport failure after transfer');
    });
    await expect(owner.train(request)).rejects.toBeInstanceOf(ZstdTrainingUnavailableError);
    const [posted] = worker.postMessage.mock.calls[0];
    expect(posted.samples.byteLength).toBe(0);
    expect(posted.lengths.byteLength).toBe(0);
    expect(source.byteLength).toBe(40);
    expect(table.byteLength).toBe(40);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test('timeout rejection is internally observed while a foreground caller delays awaiting', async () => {
    const {owner} = setup();
    const promise = owner.train(input().request);
    await vi.advanceTimersByTimeAsync(100);
    // Vitest also reports unhandled rejections; this must remain safely awaitable later.
    await expect(promise).rejects.toBeInstanceOf(ZstdTrainingUnavailableError);
    expect(vi.getTimerCount()).toBe(0);
});
