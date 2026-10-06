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

// The native queue is shared by every speech wrapper in this realm.
/** @type {Set<() => void>} */
const pendingSpeechStarts = new Set();

export class TextToSpeechAudio {
    /**
     * @param {string} text
     * @param {SpeechSynthesisVoice} voice
     */
    constructor(text, voice) {
        /** @type {string} */
        this._text = text;
        /** @type {SpeechSynthesisVoice} */
        this._voice = voice;
        /** @type {?SpeechSynthesisUtterance} */
        this._utterance = null;
        /** @type {number} */
        this._volume = 1;
        /** @type {?(() => void)} */
        this._playCleanup = null;
    }

    /** @type {number} */
    get currentTime() {
        return 0;
    }

    set currentTime(value) {
        // NOP
    }

    /** @type {number} */
    get volume() {
        return this._volume;
    }

    set volume(value) {
        this._volume = value;
        if (this._utterance !== null) {
            this._utterance.volume = value;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async play() {
        this.pause();
        try {
            // A fresh utterance prevents late events from a cancelled attempt
            // from confirming the next attempt using the same audio object.
            const utterance = new SpeechSynthesisUtterance(typeof this._text === 'string' ? this._text : '');
            utterance.lang = this._voice.lang;
            utterance.volume = this._volume;
            utterance.voice = this._voice;
            this._utterance = utterance;

            /** @type {Promise<void>} */
            const started = new Promise((resolve) => {
                const finish = () => {
                    utterance.removeEventListener('start', finish);
                    utterance.removeEventListener('end', finish);
                    utterance.removeEventListener('error', finish);
                    pendingSpeechStarts.delete(finish);
                    if (this._playCleanup === finish) { this._playCleanup = null; }
                    resolve();
                };
                this._playCleanup = finish;
                pendingSpeechStarts.add(finish);
                // speak() only queues speech; DisplayAudio must keep this start
                // cancellable until the engine actually begins speaking.
                utterance.addEventListener('start', finish);
                utterance.addEventListener('end', finish);
                utterance.addEventListener('error', finish);
                try {
                    speechSynthesis.speak(utterance);
                } catch (e) {
                    finish();
                }
            });
            await started;
        } catch (e) {
            // Preserve the non-throwing behavior when speech is unavailable.
            this._playCleanup?.();
        }
    }

    /**
     * @returns {void}
     */
    pause() {
        this._utterance = null;
        // Native cancel() affects all wrappers, and some engines omit the
        // cancellation event for queued speech. Release every affected start.
        for (const cleanup of [...pendingSpeechStarts]) { cleanup(); }
        try {
            speechSynthesis.cancel();
        } catch (e) {
            // NOP
        }
    }
}
