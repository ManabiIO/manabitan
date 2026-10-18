/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabaseWorkerHandler} from '../ext/js/dictionary/dictionary-database-worker-handler.js';

const mocks = vi.hoisted(() => ({
    createDatabase: vi.fn(),
    prepareDatabase: vi.fn(),
    connect: vi.fn(),
    logError: vi.fn(),
}));

vi.mock('../ext/js/dictionary/dictionary-database.js', () => ({
    DictionaryDatabase: class {
        constructor() { mocks.createDatabase(); }
        prepare() { return mocks.prepareDatabase(); }
        /**
         * @param {MessagePort} port
         * @returns {Promise<void>}
         */
        connectToDatabaseWorker(port) { return mocks.connect(port); }
    },
}));
vi.mock('../ext/js/core/log.js', () => ({log: {error: mocks.logError}}));

/** @type {EventTarget} */
let worker;

beforeEach(() => {
    vi.resetAllMocks();
    mocks.prepareDatabase.mockResolvedValue(void 0);
    mocks.connect.mockResolvedValue(void 0);
    worker = new EventTarget();
    vi.stubGlobal('self', worker);
});

afterEach(() => { vi.unstubAllGlobals(); });

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferredReady() {
    /** @type {() => void} */
    let resolve = () => {};
    /** @type {Promise<void>} */
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

/**
 * @param {object} port
 * @param {string} [action]
 */
function sendConnection(port, action = 'connectToDatabaseWorker') {
    const event = new Event('message');
    Object.defineProperties(event, {
        data: {value: {action}},
        ports: {value: [port]},
    });
    worker.dispatchEvent(event);
}

describe('database worker startup connections', () => {
    test('retains an early transferred port until database preparation finishes', async () => {
        const pending = deferredReady();
        mocks.prepareDatabase.mockReturnValue(pending.promise);
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        const port = {};
        sendConnection(port);
        await Promise.resolve();
        expect(mocks.prepareDatabase).toHaveBeenCalledTimes(1);
        expect(mocks.connect).not.toHaveBeenCalled();
        pending.resolve();
        await ready;
        await Promise.resolve();
        expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(port);
    });

    test('delivers multiple early ports and a later port in arrival order', async () => {
        const pending = deferredReady();
        mocks.prepareDatabase.mockReturnValue(pending.promise);
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        const ports = [{}, {}, {}];
        sendConnection(ports[0]);
        sendConnection(ports[1]);
        pending.resolve();
        await ready;
        sendConnection(ports[2]);
        await Promise.resolve();
        expect(mocks.connect.mock.calls).toEqual(ports.map((port) => [port]));
    });

    test('shares repeated preparation without duplicating databases or listeners', async () => {
        const pending = deferredReady();
        mocks.prepareDatabase.mockReturnValue(pending.promise);
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        expect(handler.prepare()).toBe(ready);
        const port = {};
        sendConnection(port);
        pending.resolve();
        await ready;
        await Promise.resolve();
        expect(handler.prepare()).toBe(ready);
        expect(mocks.createDatabase).toHaveBeenCalledTimes(1);
        expect(mocks.prepareDatabase).toHaveBeenCalledTimes(1);
        expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(port);
    });

    test('preserves startup failure logging and observes connection rejection', async () => {
        const startupError = new Error('prepare failed');
        const connectionError = new Error('database is not prepared');
        mocks.prepareDatabase.mockRejectedValue(startupError);
        mocks.connect.mockRejectedValue(connectionError);
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        sendConnection({});
        await ready;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.logError.mock.calls).toEqual([[startupError], [connectionError]]);
    });

    test('observes synchronous connection failure and continues accepting ports', async () => {
        const error = new Error('connection failed');
        mocks.connect.mockImplementationOnce(() => { throw error; });
        const handler = new DictionaryDatabaseWorkerHandler();
        await handler.prepare();
        sendConnection({});
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(error);
        const port = {};
        sendConnection(port);
        await Promise.resolve();
        expect(mocks.connect).toHaveBeenLastCalledWith(port);
        expect(mocks.connect).toHaveBeenCalledTimes(2);
    });

    test('observes asynchronous connection failure', async () => {
        const error = new Error('connection failed');
        mocks.connect.mockRejectedValue(error);
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        sendConnection({});
        await ready;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(error);
    });

    test('handles message deserialization errors while startup is pending', async () => {
        const pending = deferredReady();
        mocks.prepareDatabase.mockReturnValue(pending.promise);
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        const event = new Event('messageerror');
        worker.dispatchEvent(event);
        expect(mocks.logError).toHaveBeenCalledWith(expect.objectContaining({
            message: 'DictionaryDatabaseWorkerHandler: Error receiving message from main thread',
            data: event,
        }));
        pending.resolve();
        await ready;
    });

    test('logs unknown messages during startup', async () => {
        const handler = new DictionaryDatabaseWorkerHandler();
        const ready = handler.prepare();
        sendConnection({}, 'unknown-action');
        expect(mocks.logError).toHaveBeenCalledExactlyOnceWith('Unknown action: unknown-action');
        await ready;
    });
});
