/* SPDX-License-Identifier: GPL-3.0-or-later */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const codec = vi.hoisted(() => ({
    initializeTermContentZstd: vi.fn(async () => {}),
    compressTermContentZstd: vi.fn((/** @type {Uint8Array} */ bytes) => Uint8Array.from(bytes)),
    compressWrappedTermContentZstd: vi.fn(),
    finishWrappedTermContentZstdSpans: vi.fn(),
    prepareWrappedTermContentZstdSpans: vi.fn(),
}));
vi.mock('../ext/js/dictionary/zstd-term-content.js', () => codec);

/** @type {MessagePort[]} */
const ports = [];
/** @type {((event: MessageEvent<unknown>) => void)|null} */
let listener = null;
/** @type {unknown[]} */
let responses = [];

/**
 * @param {MessagePort} port
 * @returns {Promise<Record<string, unknown>>}
 */
function receive(port) {
    return new Promise((resolve) => {
        port.addEventListener('message', (event) => { resolve(event.data); }, {once: true});
        port.start();
    });
}

/** @param {Record<string, unknown>} data */
function send(data) {
    if (listener === null) { throw new Error('Compression listener unavailable'); }
    listener(new MessageEvent('message', {data}));
}

/** @returns {Promise<MessagePort>} */
async function bind() {
    const {port1, port2} = new MessageChannel();
    ports.push(port1, port2);
    const ready = receive(port1);
    send({type: 'bind-import-index', port: port2});
    expect(await ready).toEqual({type: 'ready'});
    return port1;
}

/** @param {MessagePort} port */
async function detach(port) {
    const completed = receive(port);
    port.postMessage({id: 1, writerId: 0, action: 'dispose-session'});
    expect(await completed).toEqual({id: 1, result: 'disposed'});
}

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    listener = null;
    responses = [];
    vi.stubGlobal('__manabitanTermContentCompressionWorker', false);
    vi.stubGlobal('self', {
        /**
         * @param {string} type
         * @param {(event: MessageEvent<unknown>) => void} callback
         */
        addEventListener(type, callback) {
            if (type === 'message') { listener = callback; }
        },
        /**
         * @param {unknown} value
         * @param {Transferable[]} [transfer]
         */
        postMessage(value, transfer = []) { responses.push(structuredClone(value, {transfer})); },
    });
    await import('../ext/js/dictionary/zstd-term-content-compression-worker.js');
    await vi.waitFor(() => { expect(responses).toContainEqual({type: 'ready'}); });
});

afterEach(() => {
    for (const port of ports.splice(0)) { port.close(); }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('compression worker import index port binding', () => {
    test('isolates equal request IDs while compression continues and can bind a later session', async () => {
        const port = await bind();
        send({id: 1, content: Uint8Array.of(4, 5, 6)});
        await detach(port);
        await vi.waitFor(() => {
            expect(responses).toContainEqual({id: 1, compressed: Uint8Array.of(4, 5, 6).buffer, envelopeMs: 0});
        });
        expect(responses).toHaveLength(2);
        const next = await bind();
        await detach(next);
        send({id: 2, content: Uint8Array.of(7)});
        await vi.waitFor(() => {
            expect(responses).toContainEqual({id: 2, compressed: Uint8Array.of(7).buffer, envelopeMs: 0});
        });
        expect(codec.initializeTermContentZstd).toHaveBeenCalledOnce();
    });

    test('rejects a second live binding without dispatching it as a compression job', async () => {
        const first = await bind();
        const {port1, port2} = new MessageChannel();
        ports.push(port1, port2);
        const rejected = receive(port1);
        send({type: 'bind-import-index', port: port2});
        expect(await rejected).toMatchObject({type: 'initialization-error', error: expect.stringContaining('already owns')});
        expect(responses).toEqual([{type: 'ready'}]);
        await detach(first);
        await detach(await bind());
    });

    test('a malformed bind cannot enter the compression request namespace', async () => {
        send({type: 'bind-import-index', port: null, id: 99});
        await Promise.resolve();
        expect(responses).toEqual([{type: 'ready'}]);
        expect(codec.compressTermContentZstd).not.toHaveBeenCalled();
        await detach(await bind());
    });
});
