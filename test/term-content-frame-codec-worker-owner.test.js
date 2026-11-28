import {describe, expect, test, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {TermContentFrameCodecError, TermContentFrameCodecWorkerOwner} from '../ext/js/dictionary/term-content-frame-codec-worker-owner.js';

/** @typedef {{id: number, action: 'decode', bytes: Uint8Array, codecId: string|null, envelope: 'none'|'mbc2', expectedDecodedLength: number, maxOutputSize: number, dictionary?: Uint8Array}} DecodeRequest */
/** @typedef {(event: import('core').SafeAny) => void} FakeWorkerListener */

class FakeWorker {
    constructor() {
        /** @type {Map<string, Set<FakeWorkerListener>>} */
        this.listeners = new Map();
        this.terminated = false;
        /** @type {{message: import('core').SafeAny, received: import('core').SafeAny, transfer: ArrayBuffer[]}[]} */
        this.posts = [];
    }

    /**
     * @param {string} type
     * @param {FakeWorkerListener} listener
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
     * @param {FakeWorkerListener} listener
     */
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    /**
     * @param {import('core').SafeAny} message
     * @param {ArrayBuffer[]} [transfer]
     */
    postMessage(message, transfer = []) {
        const received = structuredClone(message, {transfer});
        this.posts.push({message, received, transfer});
    }

    terminate() { this.terminated = true; }
    /**
     * @param {string} type
     * @param {import('core').SafeAny} data
     */
    emit(type, data) {
        for (const listener of this.listeners.get(type) ?? []) { listener({data, message: 'Worker failed'}); }
    }
}

/**
 * @param {ConstructorParameters<typeof TermContentFrameCodecWorkerOwner>[0]} [options]
 * @returns {{owner: TermContentFrameCodecWorkerOwner, worker: FakeWorker}}
 */
function setup(options = {}) {
    const worker = new FakeWorker();
    const owner = new TermContentFrameCodecWorkerOwner({
        createWorker: () => /** @type {Worker} */ (/** @type {unknown} */ (worker)),
        ...options,
    });
    return {owner, worker};
}

/**
 * @param {Partial<DecodeRequest>} [overrides]
 * @returns {DecodeRequest}
 */
function decodeRequest(overrides = {}) {
    return {action: 'decode',
        id: 0,
        bytes: Uint8Array.from([1, 2, 3]),
        codecId: null,
        envelope: 'none',
        expectedDecodedLength: 3,
        maxOutputSize: 3,
        ...overrides};
}

describe('independent term-content codec worker owner', () => {
    test('maintenance codec worker uses only the low-level codec and does not load import presets or pools', () => {
        const source = readFileSync(new URL('../ext/js/dictionary/term-content-frame-codec-worker.js', import.meta.url), 'utf8');
        expect(source).toContain("from '../../lib/zstd-wasm.js'");
        expect(source).not.toContain("from './zstd-term-content.js'");
        expect(source).not.toContain('__manabitanTermContentCompressionWorker');
    });

    test('reserves the single operation during cold worker initialization', async () => {
        const {owner, worker} = setup();
        const first = owner.run(decodeRequest());
        await expect(owner.run(decodeRequest())).rejects.toThrow(/active operation/iu);
        worker.emit('message', {type: 'ready'});
        await vi.waitFor(() => expect(worker.posts).toHaveLength(1));
        const {id} = worker.posts[0].message;
        worker.emit('message', {id, bytes: Uint8Array.of(4, 5, 6).buffer});
        await expect(first).resolves.toEqual(Uint8Array.of(4, 5, 6));
        expect(worker.posts).toHaveLength(1);
        owner.close();
    });

    test('aborts and terminates if preemption lands while the worker factory is running', async () => {
        const controller = new AbortController();
        const worker = new FakeWorker();
        const owner = new TermContentFrameCodecWorkerOwner({createWorker: () => {
            controller.abort();
            return /** @type {Worker} */ (/** @type {unknown} */ (worker));
        }});
        await expect(owner.run(decodeRequest(), {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(worker.terminated).toBe(true);
        expect(owner._active).toBeNull();
        owner.close();
    });

    test('keeps the one worker lazy and transfers only private input and dictionary copies', async () => {
        const {owner, worker} = setup();
        const bytes = new Uint8Array(16).fill(7).subarray(4, 12);
        const dictionary = new Uint8Array(12).fill(9).subarray(2, 10);
        const promise = owner.run(decodeRequest({bytes, codecId: 'codec-1', dictionary, envelope: 'mbc2'}));
        expect(worker.posts).toHaveLength(0);
        worker.emit('message', {type: 'ready'});
        await vi.waitFor(() => expect(worker.posts).toHaveLength(1));
        const {message, transfer} = worker.posts[0];
        expect(message.bytes.byteLength).toBe(0);
        expect(message.dictionary.byteLength).toBe(0);
        expect(transfer).toHaveLength(2);
        expect(bytes).toEqual(new Uint8Array(8).fill(7));
        expect(dictionary).toEqual(new Uint8Array(8).fill(9));
        const output = Uint8Array.from([4, 5, 6]);
        worker.emit('message', {id: message.id, bytes: output.buffer});
        await expect(promise).resolves.toEqual(output);
        expect(owner._worker).toBe(worker);
        owner.close();
        expect(worker.terminated).toBe(true);
    });

    test('synchronously terminates hung decode on foreground preemption and rejects late replies', async () => {
        const {owner, worker} = setup();
        const controller = new AbortController();
        const promise = owner.run(decodeRequest(), {signal: controller.signal});
        worker.emit('message', {type: 'ready'});
        await vi.waitFor(() => expect(worker.posts).toHaveLength(1));
        const {id} = worker.posts[0].message;
        controller.abort();
        await expect(promise).rejects.toMatchObject({name: 'AbortError'});
        expect(worker.terminated).toBe(true);
        expect(owner._active).toBeNull();
        worker.emit('message', {id, bytes: Uint8Array.of(1).buffer});
        expect(owner._active).toBeNull();
    });

    test('validates limits before opening a worker', async () => {
        const {owner, worker} = setup();
        await expect(owner.run(decodeRequest({expectedDecodedLength: 0}))).rejects.toBeInstanceOf(TypeError);
        await expect(owner.run(decodeRequest({bytes: new Uint8Array(0)}))).rejects.toBeInstanceOf(TypeError);
        expect(worker.posts).toHaveLength(0);
        owner.close();
    });

    test('classifies codec failure and worker setup failure without affecting the caller bytes', async () => {
        const {owner, worker} = setup();
        const request = decodeRequest();
        const original = Uint8Array.from(request.bytes);
        const promise = owner.run(request);
        worker.emit('message', {type: 'ready'});
        await vi.waitFor(() => expect(worker.posts).toHaveLength(1));
        const {id} = worker.posts[0].message;
        worker.emit('message', {id, error: 'Bad frame', errorKind: 'invalid-input'});
        await expect(promise).rejects.toMatchObject({name: 'TermContentFrameCodecError', kind: 'invalid-input'});
        expect(request.bytes).toEqual(original);

        const failed = new TermContentFrameCodecWorkerOwner({createWorker: () => { throw new Error('blocked'); }});
        await expect(failed.run(decodeRequest())).rejects.toBeInstanceOf(TermContentFrameCodecError);
        failed.close();
    });
});
