/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {DictionaryDatabaseWorkerHandler} from '../ext/js/dictionary/dictionary-database-worker-handler.js';

afterEach(() => { vi.restoreAllMocks(); });

test('database-worker connect event attaches rejection ownership', async () => {
    const handler = new DictionaryDatabaseWorkerHandler();
    const error = new Error('connection failed');
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
    const connect = vi.fn(() => Promise.reject(error));
    // Model the prepared worker and use a real rejecting promise, rather than
    // requiring catch() to be attached directly to an artificial task object.
    Reflect.set(handler, '_preparePromise', Promise.resolve());
    Reflect.set(handler, '_dictionaryDatabase', {connectToDatabaseWorker: connect});
    const port = {};

    Reflect.get(handler, '_onMessage').call(
        handler,
        /** @type {import('core').SafeAny} */ ({
            data: {action: 'connectToDatabaseWorker', params: {}},
            ports: [port],
        }),
    );

    await vi.waitFor(() => { expect(logError).toHaveBeenCalledExactlyOnceWith(error); });
    expect(connect).toHaveBeenCalledExactlyOnceWith(port);
});
