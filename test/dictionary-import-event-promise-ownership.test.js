/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/**
 * @returns {{promise: Promise<void>, catchSpy: ReturnType<typeof vi.fn>}}
 */
function createObservedTask() {
    const catchSpy = vi.fn(() => Promise.resolve());
    return {
        promise: /** @type {Promise<void>} */ (/** @type {unknown} */ ({catch: catchSpy})),
        catchSpy,
    };
}

test('event-driven file and URL imports attach rejection ownership', () => {
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));

    const fileTask = createObservedTask();
    controller.importFiles = vi.fn(() => fileTask.promise);
    controller._onEventImportDictionaryFromFile({
        files: [],
        profilesDictionarySettings: null,
        onImportDone: null,
        importDetailsOverrides: null,
    });
    expect(fileTask.catchSpy).toHaveBeenCalledOnce();

    const urlTask = createObservedTask();
    controller.importFilesFromURLs = vi.fn(() => urlTask.promise);
    controller._onEventImportDictionaryFromUrl({
        url: 'https://example.invalid/dictionary.zip',
        profilesDictionarySettings: null,
        onImportDone: null,
        importDetailsOverrides: null,
    });
    expect(urlTask.catchSpy).toHaveBeenCalledOnce();
});
