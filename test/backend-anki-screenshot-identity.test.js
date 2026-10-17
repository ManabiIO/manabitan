/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {mediaFileNameHashOrTimestamp} from '../ext/js/data/anki-util.js';

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

test('concurrent Anki clipboard images keep distinct media filenames and reuse unchanged content', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_797_000_000_000);
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const imageDataUrls = [
        'data:image/png;base64,Zmlyc3Q=',
        'data:image/png;base64,c2Vjb25k',
        'data:image/png;base64,c2Vjb25k',
    ];
    Reflect.set(backend, '_clipboardReader', {getImage: vi.fn(async () => imageDataUrls.shift())});

    /** @type {Map<string, string>} */
    const storedMedia = new Map();
    const ankiConnect = /** @type {import('../ext/js/comm/anki-connect.js').AnkiConnect} */ (/** @type {unknown} */ ({
        storeMediaFile: vi.fn(async (fileName, content) => {
            storedMedia.set(fileName, content);
            return fileName;
        }),
    }));

    const [firstFileName, secondFileName] = await Promise.all([
        Backend.prototype._injectAnkiNoteClipboardImage.call(backend, ankiConnect, Date.now()),
        Backend.prototype._injectAnkiNoteClipboardImage.call(backend, ankiConnect, Date.now()),
    ]);
    expect(firstFileName).not.toBe(secondFileName);
    expect(new Set(storedMedia.values())).toEqual(new Set(['Zmlyc3Q=', 'c2Vjb25k']));

    const reusedFileName = await Backend.prototype._injectAnkiNoteClipboardImage.call(backend, ankiConnect, Date.now());
    expect(reusedFileName).toBe(secondFileName);
    expect(storedMedia.size).toBe(2);
});

test('timestamp fallback keeps distinct Anki media payloads under their returned filenames', async () => {
    const originalFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
    Object.defineProperty(Uint8Array, 'fromBase64', {configurable: true, value: () => { throw new Error('fromBase64 unavailable'); }});
    try {
        const timestamp = 1_797_000_000_000;
        const storedMedia = new Map();
        const returnedFileNames = await Promise.all([
            mediaFileNameHashOrTimestamp('yomitan_audio', 'Zmlyc3Q=', '.mp3', null, timestamp),
            mediaFileNameHashOrTimestamp('yomitan_audio', 'c2Vjb25k', '.mp3', null, timestamp),
        ]);
        for (const [index, fileName] of returnedFileNames.entries()) {
            storedMedia.set(fileName, ['Zmlyc3Q=', 'c2Vjb25k'][index]);
        }
        expect(returnedFileNames[0]).not.toBe(returnedFileNames[1]);
        expect(new Set(storedMedia.values())).toEqual(new Set(['Zmlyc3Q=', 'c2Vjb25k']));
    } finally {
        if (typeof originalFromBase64 === 'undefined') {
            Reflect.deleteProperty(Uint8Array, 'fromBase64');
        } else {
            Object.defineProperty(Uint8Array, 'fromBase64', originalFromBase64);
        }
    }
});
