/* SPDX-License-Identifier: GPL-3.0-or-later */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {attachImportIndexWorkerPort, ImportIndexWorkerHandler} from '../ext/js/dictionary/term-record-import-index-worker-handler.js';

/** @typedef {{id?: number, type?: string, result?: unknown, error?: {id?: number, name?: string, message?: string, errors?: unknown[]}}} Response */

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    let resolve = () => {};
    const promise = /** @type {Promise<void>} */ (new Promise((done) => { resolve = done; }));
    return {promise, resolve};
}

/** @returns {{write: import('vitest').Mock, truncate: import('vitest').Mock, flush: import('vitest').Mock, close: import('vitest').Mock}} */
function accessHandle() {
    return {
        write: vi.fn((/** @type {Uint8Array} */ bytes) => bytes.byteLength),
        truncate: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
    };
}

/**
 * @param {(() => void)|null} [dispose]
 * @returns {{handler: ImportIndexWorkerHandler, responses: Response[], dispose: (() => void)|null}}
 */
function server(dispose = vi.fn()) {
    /** @type {Response[]} */
    const responses = [];
    const handler = new ImportIndexWorkerHandler((value) => { responses.push(/** @type {Response} */ (value)); }, dispose);
    return {handler, responses, dispose};
}

/** @type {MessagePort[]} */
const ports = [];

/**
 * @param {MessagePort} port
 * @returns {Promise<Response>}
 */
function receive(port) {
    return new Promise((resolve) => {
        port.addEventListener('message', (event) => { resolve(event.data); }, {once: true});
        port.start();
    });
}

afterEach(() => {
    for (const port of ports.splice(0)) { port.close(); }
    vi.restoreAllMocks();
});

describe('borrowed import index session ownership', () => {
    test('preserves ordinary writer operations and detaches only after final flush and close', async () => {
        const access = accessHandle();
        const {handler, responses, dispose} = server();
        await handler.handleRequest({id: 1, writerId: 1, action: 'open', fileHandle: {async createSyncAccessHandle() { return access; }}});
        await handler.handleRequest({id: 2, writerId: 1, action: 'writeChunks', chunks: [Uint8Array.of(1, 2, 3)]});
        await handler.handleRequest({id: 3, writerId: 1, action: 'seek', offset: 1});
        await handler.handleRequest({id: 4, writerId: 1, action: 'writeChunks', chunks: [Uint8Array.of(9)]});
        await handler.handleRequest({id: 5, writerId: 1, action: 'truncate', size: 2});
        await handler.handleRequest({id: 6, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)?.error?.message).toContain('pending storage');
        expect(dispose).not.toHaveBeenCalled();
        await handler.handleRequest({id: 7, writerId: 1, action: 'close'});
        expect(access.flush).toHaveBeenCalledOnce();
        expect(access.close).toHaveBeenCalledOnce();
        await handler.handleRequest({id: 8, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)).toEqual({id: 8, result: 'disposed'});
        expect(dispose).toHaveBeenCalledOnce();
        expect(access.write).toHaveBeenNthCalledWith(1, Uint8Array.of(1, 2, 3), {at: 0});
        expect(access.write).toHaveBeenNthCalledWith(2, Uint8Array.of(9), {at: 1});
        expect(access.truncate.mock.calls.map(([size]) => size)).toEqual([0, 2]);
    });

    test('does not detach while acquisition can still create a handle', async () => {
        const gate = deferred();
        const access = accessHandle();
        const {handler, responses, dispose} = server();
        const opening = handler.handleRequest({
            id: 1, writerId: 1, action: 'open',
            fileHandle: {async createSyncAccessHandle() { await gate.promise; return access; }},
        });
        await handler.handleRequest({id: 2, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)?.error?.message).toContain('pending storage');
        expect(dispose).not.toHaveBeenCalled();
        gate.resolve();
        await opening;
        expect(responses.at(-1)).toEqual({id: 1, result: 'opened'});
        await handler.handleRequest({id: 3, writerId: 1, action: 'abort'});
        await handler.handleRequest({id: 4, writerId: 0, action: 'dispose-session'});
        expect(access.flush).not.toHaveBeenCalled();
        expect(access.close).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
    });

    test('does not detach an empty writer map while a prior request is still settling', async () => {
        const gate = deferred();
        const access = accessHandle();
        const {handler, responses, dispose} = server();
        await handler.handleRequest({id: 1, writerId: 1, action: 'open', fileHandle: {async createSyncAccessHandle() { return access; }}});
        const writer = /** @type {import('../ext/js/dictionary/term-record-import-index-writer.js').SyncImportIndexWriter} */ (Reflect.get(handler, '_writers').get(1));
        const original = writer.writeChunks.bind(writer);
        vi.spyOn(writer, 'writeChunks').mockImplementation(async (chunks) => {
            await gate.promise;
            await original(chunks);
        });
        const writing = handler.handleRequest({id: 2, writerId: 1, action: 'writeChunks', chunks: [Uint8Array.of(7)]});
        await handler.handleRequest({id: 3, writerId: 1, action: 'close'});
        await handler.handleRequest({id: 4, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)?.error?.message).toContain('pending storage');
        expect(dispose).not.toHaveBeenCalled();
        gate.resolve();
        await writing;
        expect(responses.at(-1)?.error?.message).toContain('closed');
        await handler.handleRequest({id: 5, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)?.error?.message).toContain('storage failure');
        expect(dispose).not.toHaveBeenCalled();
    });

    test('keeps error identity and aggregate children within one session', async () => {
        const writeError = new Error('write witness');
        const closeError = new Error('close witness');
        const access = accessHandle();
        access.write.mockImplementation(() => { throw writeError; });
        access.close.mockImplementation(() => { throw closeError; });
        const {handler, responses} = server();
        await handler.handleRequest({id: 1, writerId: 1, action: 'open', fileHandle: {async createSyncAccessHandle() { return access; }}});
        await handler.handleRequest({id: 2, writerId: 1, action: 'writeChunks', chunks: [Uint8Array.of(1)]});
        const failedWrite = responses.at(-1)?.error;
        await handler.handleRequest({id: 3, writerId: 1, action: 'close'});
        const failedClose = responses.at(-1)?.error;
        expect(failedWrite?.message).toBe('write witness');
        expect(failedClose?.name).toBe('AggregateError');
        expect(failedClose?.errors?.[0]).toMatchObject({id: failedWrite?.id, message: 'write witness'});
        expect(failedClose?.errors?.[1]).toMatchObject({message: 'close witness'});
        expect(Reflect.get(handler, '_writers').size).toBe(0);
    });

    test('failed native close prevents graceful reuse even after the writer leaves the map', async () => {
        const access = accessHandle();
        access.close.mockImplementation(() => { throw new Error('Native handle close failed'); });
        const {handler, responses, dispose} = server();
        await handler.handleRequest({id: 1, writerId: 1, action: 'open', fileHandle: {async createSyncAccessHandle() { return access; }}});
        await handler.handleRequest({id: 2, writerId: 1, action: 'close'});
        expect(responses.at(-1)?.error?.message).toBe('Native handle close failed');
        expect(Reflect.get(handler, '_writers').size).toBe(0);
        await handler.handleRequest({id: 3, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)?.error?.message).toContain('storage failure');
        expect(dispose).not.toHaveBeenCalled();
    });

    test('failed acquisition cleanup prevents graceful reuse with no published writer', async () => {
        const access = accessHandle();
        access.truncate.mockImplementation(() => { throw new Error('Native truncate failed'); });
        access.close.mockImplementation(() => { throw new Error('Acquisition cleanup close failed'); });
        const {handler, responses, dispose} = server();
        await handler.handleRequest({id: 1, writerId: 1, action: 'open', fileHandle: {async createSyncAccessHandle() { return access; }}});
        expect(responses.at(-1)?.error?.name).toBe('AggregateError');
        expect(Reflect.get(handler, '_writers').size).toBe(0);
        expect(Reflect.get(handler, '_opening').size).toBe(0);
        await handler.handleRequest({id: 2, writerId: 0, action: 'dispose-session'});
        expect(responses.at(-1)?.error?.message).toContain('storage failure');
        expect(dispose).not.toHaveBeenCalled();
    });

    test('unsupported acquisition may detach, but a dedicated worker cannot detach its endpoint', async () => {
        const {handler, responses, dispose} = server();
        await handler.handleRequest({id: 1, writerId: 1, action: 'open', fileHandle: {}});
        expect(responses.at(-1)).toEqual({id: 1, result: 'unsupported'});
        await handler.handleRequest({id: 2, writerId: 0, action: 'dispose-session'});
        expect(dispose).toHaveBeenCalledOnce();
        const dedicated = server(null);
        await dedicated.handler.handleRequest({id: 1, writerId: 0, action: 'dispose-session'});
        expect(dedicated.responses.at(-1)?.error?.message).toContain('cannot detach');
    });

    test('acknowledges disposal through a real port before closing it and removes its listener', async () => {
        const {port1, port2} = new MessageChannel();
        ports.push(port1, port2);
        const disposed = vi.fn();
        const remove = vi.spyOn(port2, 'removeEventListener');
        const ready = receive(port1);
        attachImportIndexWorkerPort(port2, disposed);
        expect(await ready).toEqual({type: 'ready'});
        const completion = receive(port1);
        port1.postMessage({id: 1, writerId: 0, action: 'dispose-session'});
        expect(await completion).toEqual({id: 1, result: 'disposed'});
        expect(disposed).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
    });

    test('never reopens a detached request owner', async () => {
        const {handler, responses, dispose} = server();
        await handler.handleRequest({id: 1, writerId: 0, action: 'dispose-session'});
        const open = vi.fn(async () => accessHandle());
        await handler.handleRequest({id: 2, writerId: 1, action: 'open', fileHandle: {createSyncAccessHandle: open}});
        expect(responses.at(-1)?.error?.message).toContain('disposed');
        expect(open).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });
});
