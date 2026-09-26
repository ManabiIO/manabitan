/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import {TextToSpeechAudio} from '../ext/js/media/text-to-speech-audio.js';

class MockSpeechSynthesisUtterance {
    /**
     * @param {string} text
     */
    constructor(text) {
        /** @type {string} */
        this.text = text;
        /** @type {string} */
        this.lang = '';
        /** @type {number} */
        this.volume = 1;
        /** @type {?SpeechSynthesisVoice} */
        this.voice = null;
    }
}

/**
 * @param {string} lang
 * @returns {SpeechSynthesisVoice}
 */
function createVoice(lang) {
    return /** @type {SpeechSynthesisVoice} */ ({
        default: false,
        lang,
        localService: true,
        name: `Voice ${lang}`,
        voiceURI: `voice:${lang}`,
    });
}

describe('TextToSpeechAudio', () => {
    /** @type {ReturnType<typeof vi.fn>} */
    let cancel;
    /** @type {ReturnType<typeof vi.fn>} */
    let speak;

    beforeEach(() => {
        cancel = vi.fn();
        speak = vi.fn();
        vi.stubGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
        vi.stubGlobal('speechSynthesis', {cancel, speak});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test.each([
        'en-US',
        'fr-FR',
        'cmn-CN',
        'pt-BR',
        '',
    ])('uses the selected voice language %s', async (lang) => {
        const voice = createVoice(lang);
        const audio = new TextToSpeechAudio('example', voice);

        await audio.play();

        expect(speak).toHaveBeenCalledTimes(1);
        const utterance = /** @type {MockSpeechSynthesisUtterance} */ (speak.mock.calls[0][0]);
        expect(utterance.text).toBe('example');
        expect(utterance.lang).toBe(lang);
        expect(utterance.voice).toBe(voice);
    });

    test('keeps Japanese voice language unchanged', async () => {
        const voice = createVoice('ja-JP');
        const audio = new TextToSpeechAudio('日本語', voice);

        await audio.play();

        const utterance = /** @type {MockSpeechSynthesisUtterance} */ (speak.mock.calls[0][0]);
        expect(utterance.lang).toBe('ja-JP');
    });

    test('applies volume set before playback', async () => {
        const audio = new TextToSpeechAudio('example', createVoice('en-US'));
        audio.volume = 0.25;

        await audio.play();

        const utterance = /** @type {MockSpeechSynthesisUtterance} */ (speak.mock.calls[0][0]);
        expect(utterance.volume).toBe(0.25);
    });

    test('updates active utterance volume', async () => {
        const audio = new TextToSpeechAudio('example', createVoice('en-US'));
        await audio.play();
        const utterance = /** @type {MockSpeechSynthesisUtterance} */ (speak.mock.calls[0][0]);

        audio.volume = 0.4;

        expect(utterance.volume).toBe(0.4);
    });

    test('cancels queued speech before playing', async () => {
        const audio = new TextToSpeechAudio('example', createVoice('en-US'));

        await audio.play();

        expect(cancel).toHaveBeenCalledOnce();
        expect(speak).toHaveBeenCalledOnce();
    });

    test('pause cancels speech', () => {
        const audio = new TextToSpeechAudio('example', createVoice('en-US'));

        audio.pause();

        expect(cancel).toHaveBeenCalledOnce();
        expect(speak).not.toHaveBeenCalled();
    });
});
