/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {DictionaryDatabaseWorkerHandler} from '../ext/js/dictionary/dictionary-database-worker-handler.js';

test('database-worker connect event attaches rejection ownership', () => {
    const handler = new DictionaryDatabaseWorkerHandler();
    const catchSpy = vi.fn(() => Promise.resolve());
    const task = /** @type {Promise<void>} */ (/** @type {unknown} */ ({catch: catchSpy}));
    Reflect.set(handler, '_dictionaryDatabase', {
        connectToDatabaseWorker: vi.fn(() => task),
    });

    Reflect.get(handler, '_onMessage').call(handler, {
        data: {action: 'connectToDatabaseWorker'},
        ports: [{}],
    });

    expect(catchSpy).toHaveBeenCalledOnce();
});
