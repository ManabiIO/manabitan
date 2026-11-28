/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {CompressionIndexWorkerTransport} from '../ext/js/dictionary/compression-index-worker-transport.js';
import {ImportIndexWorkerClient, serializeImportIndexWorkerError} from '../ext/js/dictionary/term-record-import-index-worker-client.js';

/** @typedef {{id: number, writerId: number, action: string, chunks?: Uint8Array[]}} Request */

class SessionPort extends EventTarget {
    constructor() {
        super();
        /** @type {Request[]} */
        this.requests = [];
        /** @type {number} */
        this.starts = 0;
        /** @type {number} */
        this.closes = 0;
    }

    /** */
    start() { ++this.starts; }
    /** */
    close() { ++this.closes; }

    /**
     * @param {Request} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer) {
        this.requests.push(structuredClone(message, {transfer}));
    }

    /** @param {unknown} data */
    emit(data) {
        this.dispatchEvent(new MessageEvent('message', {data}));
    }

    /**
     * @param {Request} request
     * @param {Record<string, unknown>} [response]
     */
    reply(request, response = {}) {
        this.emit({id: request.id, ...response});
    }
}

/** @type {Array<() => void>} */
const cleanups = [];

/** @returns {{port: SessionPort, transport: CompressionIndexWorkerTransport, client: ImportIndexWorkerClient, failures: Error[], releases: () => number}} */
function session() {
    const port = new SessionPort();
    /** @type {Error[]} */
    const failures = [];
    let releases = 0;
    const transport = new CompressionIndexWorkerTransport(
        /** @type {MessagePort} */ (/** @type {unknown} */ (port)),
        (error) => {
            failures.push(error);
            transport.fail(error);
        },
        () => { ++releases; },
    );
    const client = new ImportIndexWorkerClient(transport);
    cleanups.push(() => { transport.fail(new Error('Test owner retired')); });
    port.emit({type: 'ready'});
    return {port, transport, client, failures, releases: () => releases};
}

/**
 * @returns {Promise<ReturnType<typeof session> & {writer: NonNullable<Awaited<ReturnType<ImportIndexWorkerClient['open']>>>}>}
 * @throws {Error} If the fake owner did not acquire a writer.
 */
async function writerSession() {
    const state = session();
    const opening = state.client.open(/** @type {FileSystemFileHandle} */ ({}));
    await Promise.resolve();
    state.port.reply(state.port.requests[0], {result: 'opened'});
    const writer = await opening;
    if (writer === null) { throw new Error('Expected an acquired writer'); }
    return {...state, writer};
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) { cleanup(); }
    vi.useRealTimers();
});

describe('borrowed codec index transport ownership', () => {
    test('retires only after explicit acknowledgement, without terminating its codec owner', async () => {
        const {port, client, writer, failures, releases} = await writerSession();
        const bytes = Uint8Array.of(8, 6, 7, 5, 3, 0, 9);
        const writing = writer.writeOwnedChunks([bytes]);
        expect(bytes.byteLength).toBe(0);
        expect(port.requests[1].chunks?.map((chunk) => [...chunk])).toEqual([[8, 6, 7, 5, 3, 0, 9]]);
        port.reply(port.requests[1]);
        await writing;
        const closing = writer.close();
        port.reply(port.requests[2]);
        await closing;
        const disposing = client.dispose();
        expect(client.dispose()).toBe(disposing);
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeChunks', 'close', 'dispose-session']);
        expect(port.requests[3].writerId).toBe(0);
        expect(port.closes).toBe(0);
        expect(releases()).toBe(0);
        port.reply(port.requests[3], {result: 'disposed'});
        await disposing;
        await client.dispose();
        expect(failures).toEqual([]);
        expect(port.starts).toBe(1);
        expect(port.closes).toBe(1);
        expect(releases()).toBe(1);
        await expect(client.open(/** @type {FileSystemFileHandle} */ ({}))).rejects.toThrow('closed');
    });

    test('an ambiguous disposal rejection revokes the owner before rejecting retirement', async () => {
        const {port, client, failures, releases} = session();
        const disposing = client.dispose();
        const failure = disposing.catch((error) => error);
        port.reply(port.requests[0], {
            error: serializeImportIndexWorkerError(new Error('Storage session has an uncertain handle'), new Map()),
        });
        expect((await failure).message).toContain('uncertain handle');
        expect(failures).toHaveLength(1);
        expect(port.closes).toBe(1);
        expect(releases()).toBe(1);
        await expect(client.open(/** @type {FileSystemFileHandle} */ ({}))).rejects.toThrow('uncertain handle');
    });

    test('rejects an invalid disposal acknowledgement and preserves terminal failure', async () => {
        const {port, client, failures} = session();
        const disposing = client.dispose();
        const failure = disposing.catch((error) => error);
        port.reply(port.requests[0], {result: 'opened'});
        expect((await failure).message).toContain('invalid disposal status');
        expect(failures).toHaveLength(1);
        expect(port.closes).toBe(1);
        expect(client.dispose()).toBe(disposing);
    });

    test('pool failure immediately settles transferred writes and forbids retries', async () => {
        const {port, transport, client, writer, failures} = await writerSession();
        const bytes = Uint8Array.of(1, 4, 9);
        const writing = writer.writeOwnedChunks([bytes]);
        const failed = writing.catch((error) => error);
        expect(bytes.byteLength).toBe(0);
        transport.fail(new Error('Codec lane crashed'));
        const failure = await failed;
        expect(failure.message).toBe('Codec lane crashed');
        await expect(writer.close()).rejects.toBe(failure);
        await expect(writer.write(Uint8Array.of(16))).rejects.toBe(failure);
        await client.dispose();
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeChunks']);
        expect(port.closes).toBe(1);
        expect(failures).toEqual([]);
    });

    test('pool failure immediately settles an ambiguous open', async () => {
        const {port, transport, client} = session();
        const opening = client.open(/** @type {FileSystemFileHandle} */ ({}));
        const failed = opening.catch((error) => error);
        await Promise.resolve();
        expect(port.requests[0].action).toBe('open');
        transport.fail(new Error('Owner terminated during acquisition'));
        const failure = await failed;
        await expect(client.open(/** @type {FileSystemFileHandle} */ ({}))).rejects.toBe(failure);
        expect(port.requests).toHaveLength(1);
        expect(port.closes).toBe(1);
    });

    test('rejects unknown response IDs without acknowledging a write', async () => {
        const {port, client, writer, failures} = await writerSession();
        const writing = writer.writeOwnedChunks([Uint8Array.of(1)]);
        const failed = writing.catch((error) => error);
        port.emit({id: port.requests[1].id + 1, compressed: new ArrayBuffer(1)});
        expect((await failed).message).toContain('unknown response');
        expect(failures).toHaveLength(1);
        await expect(client.open(/** @type {FileSystemFileHandle} */ ({}))).rejects.toThrow('unknown response');
    });

    test('a message deserialization error revokes all ownership', async () => {
        const {port, client, writer, failures} = await writerSession();
        const writing = writer.writeOwnedChunks([Uint8Array.of(2)]);
        const failed = writing.catch((error) => error);
        port.dispatchEvent(new Event('messageerror'));
        expect((await failed).message).toContain('invalid message');
        expect(failures).toHaveLength(1);
        await client.dispose();
        expect(port.closes).toBe(1);
    });

    test('retains request timeout without transferring detached data twice', async () => {
        vi.useFakeTimers();
        const {port, client, writer, failures} = await writerSession();
        const writing = writer.writeOwnedChunks([Uint8Array.of(3)]);
        const failed = writing.catch((error) => error);
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await failed).message).toContain('timed out');
        expect(failures).toHaveLength(1);
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeChunks']);
        await client.dispose();
        expect(port.closes).toBe(1);
    });
});
