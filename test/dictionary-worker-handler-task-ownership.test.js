/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {DictionaryWorkerHandler} from '../ext/js/dictionary/dictionary-worker-handler.js';

test.each([
    'importDictionary',
    'importMdxDictionary',
    'deleteDictionary',
    'getDictionaryCounts',
    'getMdxVersion',
])('event-dispatched %s attaches rejection ownership', (action) => {
    const handler = new DictionaryWorkerHandler();
    const catchSpy = vi.fn(() => Promise.resolve());
    const task = /** @type {Promise<unknown>} */ (/** @type {unknown} */ ({catch: catchSpy}));
    vi.spyOn(handler, '_onMessageWithProgress').mockReturnValue(task);

    Reflect.get(handler, '_onMessage').call(handler, {data: {action, params: {}}});

    expect(catchSpy).toHaveBeenCalledOnce();
});
