/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

afterEach(() => {
    vi.restoreAllMocks();
});

test('concurrent Anki screenshots keep distinct media filenames', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_797_000_000_000);
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const screenshotDataUrls = [
        'data:image/png;base64,Zmlyc3Q=',
        'data:image/png;base64,c2Vjb25k',
    ];
    Reflect.set(backend, '_getScreenshot', vi.fn(async () => screenshotDataUrls.shift()));

    /** @type {Map<string, string>} */
    const storedMedia = new Map();
    const ankiConnect = /** @type {import('../ext/js/comm/anki-connect.js').AnkiConnect} */ (/** @type {unknown} */ ({
        storeMediaFile: vi.fn(async (fileName, content) => {
            storedMedia.set(fileName, content);
            return fileName;
        }),
    }));
    const details = {tabId: 1, frameId: 0, format: /** @type {const} */ ('png'), quality: 92};

    const [firstFileName, secondFileName] = await Promise.all([
        Backend.prototype._injectAnkiNoteScreenshot.call(backend, ankiConnect, Date.now(), details),
        Backend.prototype._injectAnkiNoteScreenshot.call(backend, ankiConnect, Date.now(), details),
    ]);

    expect(firstFileName).not.toBe(secondFileName);
    expect(storedMedia.size).toBe(2);
    expect(new Set(storedMedia.values())).toEqual(new Set(['Zmlyc3Q=', 'c2Vjb25k']));
});
