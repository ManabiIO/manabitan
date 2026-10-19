/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';

afterEach(() => {
    vi.useRealTimers();
});

const languageSummary = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja'}));
const definitionDetails = {type: /** @type {const} */ ('term'), term: '音声', reading: 'おんせい'};

/**
 * @param {AudioDownloader} audioDownloader
 * @returns {Backend}
 */
function createBackend(audioDownloader) {
    return /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {_audioDownloader: audioDownloader}));
}

/**
 * @param {import('settings').AudioSourceOptions[]} sources
 * @param {number|null} [idleTimeout]
 * @returns {import('api').InjectAnkiNoteMediaAudioDetails}
 */
function audioDetails(sources, idleTimeout = null) {
    return {sources, preferredAudioIndex: null, idleTimeout, languageSummary, enableDefaultAudioSources: false};
}

/**
 * @param {AnkiConnect['storeMediaFile']} storeMediaFile
 * @returns {AnkiConnect}
 */
function createAnkiConnect(storeMediaFile) {
    return /** @type {AnkiConnect} */ (Object.assign(Object.create(AnkiConnect.prototype), {storeMediaFile}));
}

test('Anki media result retains idle timeout issue guidance and serialized cause', async () => {
    vi.useFakeTimers();
    const downloader = new AudioDownloader(/** @type {any} */ ({
        fetchAnonymous: async () => await new Promise(() => {}),
    }));
    const backend = createBackend(downloader);
    vi.spyOn(backend, '_injectAnkiNoteDictionaryMedia').mockResolvedValue({results: [], errors: []});
    const inject = Backend.prototype._injectAnkNoteMedia.call(
        backend,
        createAnkiConnect(vi.fn()),
        Date.now(),
        definitionDetails,
        audioDetails([{type: 'custom', url: 'https://audio.example/slow.mp3', voice: ''}], 1000),
        null,
        null,
        [],
    );
    await vi.advanceTimersByTimeAsync(1000);
    const result = await inject;
    expect(result.errors).toHaveLength(1);
    const error = ExtensionError.deserialize(result.errors[0]);
    expect(error).toMatchObject({
        name: 'ExtensionError',
        message: 'Audio download was cancelled due to an idle timeout',
        data: {
            referenceUrl: '/issues.html#audio-download-idle-timeout',
            errors: [{name: 'AbortError', message: 'Audio download idle timeout'}],
        },
    });
});

test('Anki media injection stores a later audio provider after an earlier HTTP failure', async () => {
    /** @type {string[]} */
    const requests = [];
    const downloader = new AudioDownloader(/** @type {any} */ ({
        async fetchAnonymous(/** @type {string} */ url) {
            requests.push(url);
            return url.endsWith('/missing') ?
                new Response('', {status: 503}) :
                new Response(makeWav(), {headers: {'Content-Type': 'audio/wav'}});
        },
    }));
    const storeMediaFile = vi.fn(/** @type {AnkiConnect['storeMediaFile']} */ (async (filename) => filename));
    const backend = createBackend(downloader);
    const filename = await Backend.prototype._injectAnkiNoteAudio.call(
        backend,
        createAnkiConnect(storeMediaFile),
        123,
        definitionDetails,
        audioDetails([
            {type: 'custom', url: 'https://audio.example/missing', voice: ''},
            {type: 'custom', url: 'https://audio.example/fallback.wav', voice: ''},
        ]),
    );

    expect(filename).toMatch(/^yomitan_audio_/);
    expect(requests).toEqual(['https://audio.example/missing', 'https://audio.example/fallback.wav']);
    expect(storeMediaFile).toHaveBeenCalledOnce();
    expect(storeMediaFile.mock.calls[0][1]).toBe(Buffer.from(makeWav()).toString('base64'));
});

test('Anki idle timeout releases the next provider and stores its successful recording', async () => {
    vi.useFakeTimers();
    /** @type {string[]} */
    const requests = [];
    const downloader = new AudioDownloader(/** @type {any} */ ({
        async fetchAnonymous(/** @type {string} */ url) {
            requests.push(url);
            if (url.endsWith('/slow')) { return await new Promise(() => {}); }
            return new Response(makeWav(), {headers: {'Content-Type': 'audio/wav'}});
        },
    }));
    const storeMediaFile = vi.fn(/** @type {AnkiConnect['storeMediaFile']} */ (async (filename) => filename));
    const backend = createBackend(downloader);
    vi.spyOn(backend, '_injectAnkiNoteDictionaryMedia').mockResolvedValue({results: [], errors: []});
    const inject = Backend.prototype._injectAnkNoteMedia.call(
        backend,
        createAnkiConnect(storeMediaFile),
        123,
        definitionDetails,
        audioDetails([
            {type: 'custom', url: 'https://audio.example/slow', voice: ''},
            {type: 'custom', url: 'https://audio.example/fallback', voice: ''},
        ], 1000),
        null,
        null,
        [],
    );
    await vi.advanceTimersByTimeAsync(1000);
    const result = await inject;

    expect(result.errors).toEqual([]);
    expect(result.audioFileName).toMatch(/^yomitan_audio_/);
    expect(requests).toEqual(['https://audio.example/slow', 'https://audio.example/fallback']);
    expect(storeMediaFile).toHaveBeenCalledOnce();
    expect(storeMediaFile.mock.calls[0][1]).toBe(Buffer.from(makeWav()).toString('base64'));
});

test('ordinary unavailable Anki audio remains a nonfatal missing-media result', async () => {
    const downloader = new AudioDownloader(/** @type {any} */ ({
        async fetchAnonymous() { return new Response('', {status: 503}); },
    }));
    const storeMediaFile = vi.fn();
    const backend = createBackend(downloader);
    await expect(Backend.prototype._injectAnkiNoteAudio.call(
        backend,
        createAnkiConnect(storeMediaFile),
        123,
        definitionDetails,
        audioDetails([{type: 'custom', url: 'https://audio.example/missing', voice: ''}]),
    )).resolves.toBeNull();
    expect(storeMediaFile).not.toHaveBeenCalled();
});

/** @returns {Uint8Array} */
function makeWav() {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    /**
     * @param {number} offset
     * @param {string} value
     */
    const writeText = (offset, value) => {
        for (let i = 0; i < value.length; ++i) { bytes[offset + i] = value.charCodeAt(i); }
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 38, true);
    writeText(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, 2, true);
    view.setInt16(44, 0, true);
    return bytes;
}
