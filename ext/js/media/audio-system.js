/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {API} from '../comm/api.js';
import {EventDispatcher} from '../core/event-dispatcher.js';
import {isLocalhostUrl} from '../core/utilities.js';
import {TextToSpeechAudio} from './text-to-speech-audio.js';
import {WebAudioLocalAudio} from './web-audio-local-audio.js';

const AUDIO_LOAD_TIMEOUT_MS = 15000;

/**
 * @augments EventDispatcher<import('audio-system').Events>
 */
export class AudioSystem extends EventDispatcher {
    /**
     * @param {API?} api
     */
    constructor(api) {
        super();
        /** @type {?HTMLAudioElement} */
        this._fallbackAudio = null;
        /** @type {?import('settings').FallbackSoundType} */
        this._fallbackSoundType = null;
        /** @type {API?} */
        this._api = api;
    }

    /**
     * @returns {void}
     */
    prepare() {
        // speechSynthesis.getVoices() will not be populated unless some API call is made.
        if (
            typeof speechSynthesis !== 'undefined' &&
            typeof speechSynthesis.addEventListener === 'function'
        ) {
            speechSynthesis.addEventListener('voiceschanged', this._onVoicesChanged.bind(this), false);
        }
    }

    /**
     * @param {import('settings').FallbackSoundType} fallbackSoundType
     * @returns {HTMLAudioElement}
     */
    getFallbackAudio(fallbackSoundType) {
        if (this._fallbackAudio === null || this._fallbackSoundType !== fallbackSoundType) {
            this._fallbackSoundType = fallbackSoundType;
            switch (fallbackSoundType) {
                case 'click':
                    this._fallbackAudio = new Audio('/data/audio/fallback-click.mp3');
                    break;
                case 'bloop':
                    this._fallbackAudio = new Audio('/data/audio/fallback-bloop.mp3');
                    break;
                case 'none':
                    // audio handler expects audio url to always be present, empty string must be used instead of `new Audio()`
                    this._fallbackAudio = new Audio('');
                    break;
            }
        }
        return this._fallbackAudio;
    }

    /**
     * @param {string} url
     * @param {import('settings').AudioSourceType} sourceType
     * @returns {Promise<HTMLAudioElement|WebAudioLocalAudio>}
     */
    async createAudio(url, sourceType) {
        if (isLocalhostUrl(url) && this._api) {
            return await this._createLocalAudio(url);
        }

        const audio = new Audio(url);
        try {
            await this._waitForData(audio);
            if (!this._isAudioValid(audio, sourceType)) {
                throw new Error('Could not retrieve audio');
            }
            return audio;
        } catch (e) {
            // Do not leave failed or timed-out elements fetching in the background.
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            throw e;
        }
    }

    /**
     * @param {string} text
     * @param {string} voiceUri
     * @returns {TextToSpeechAudio}
     * @throws {Error}
     */
    createTextToSpeechAudio(text, voiceUri) {
        const voice = this._getTextToSpeechVoiceFromVoiceUri(voiceUri);
        if (voice === null) {
            throw new Error('Invalid text-to-speech voice');
        }
        return new TextToSpeechAudio(text, voice);
    }

    // Private

    /**
     * @param {string} url
     * @returns {Promise<WebAudioLocalAudio>}
     */
    async _createLocalAudio(url) {
        const api = this._api;
        if (api === null) { throw new Error('Local audio API unavailable'); }
        const timeoutError = new Error('Local audio loading timed out');
        let expired = false;
        /** @type {?import('core').Timeout} */
        let timer = null;
        /** @type {Promise<never>} */
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                expired = true;
                reject(timeoutError);
            }, AUDIO_LOAD_TIMEOUT_MS);
        });
        /** @returns {Promise<WebAudioLocalAudio>} */
        const prepare = async () => {
            const response = await api.fetchLocalAudioData(url);
            // The bridge has no cancellation parameter. Ignore a late response
            // before allocating a context or starting another decode operation.
            if (expired) { throw timeoutError; }
            if (!response) { throw new Error('Failed to fetch local audio from background context'); }
            const audio = new WebAudioLocalAudio(response.data, response.contentType || 'audio/mpeg');
            await audio.prepare();
            if (expired) { throw timeoutError; }
            return audio;
        };
        try {
            // Use one budget for transport and decoding so either stall can
            // fall through to another source without poisoning future retries.
            return await Promise.race([prepare(), timeout]);
        } finally {
            expired = true;
            if (timer !== null) { clearTimeout(timer); }
        }
    }

    /**
     * @param {Event} event
     */
    _onVoicesChanged(event) {
        this.trigger('voiceschanged', event);
    }

    /**
     * @param {HTMLAudioElement} audio
     * @returns {Promise<void>}
     */
    _waitForData(audio) {
        if (audio.error !== null) { return Promise.reject(audio.error); }
        if (audio.readyState >= 2) { return Promise.resolve(); } // HAVE_CURRENT_DATA
        return new Promise((resolve, reject) => {
            let settled = false;
            /** @type {?import('core').Timeout} */
            let timer = null;
            const cleanup = () => {
                if (settled) { return false; }
                settled = true;
                if (timer !== null) { clearTimeout(timer); }
                audio.removeEventListener('loadeddata', onLoadedData);
                audio.removeEventListener('error', onError);
                audio.removeEventListener('abort', onAbort);
                return true;
            };
            const onLoadedData = () => {
                if (cleanup()) { resolve(); }
            };
            const onError = () => {
                if (cleanup()) { reject(audio.error ?? new Error('Failed to load audio')); }
            };
            const onAbort = () => {
                if (cleanup()) { reject(new Error('Audio loading aborted')); }
            };
            const onTimeout = () => {
                if (cleanup()) { reject(new Error('Audio loading timed out')); }
            };
            audio.addEventListener('loadeddata', onLoadedData);
            audio.addEventListener('error', onError);
            audio.addEventListener('abort', onAbort);
            // A silent/stalled provider must not prevent trying the next source.
            timer = setTimeout(onTimeout, AUDIO_LOAD_TIMEOUT_MS);
        });
    }

    /**
     * @param {HTMLAudioElement} audio
     * @param {import('settings').AudioSourceType} sourceType
     * @returns {boolean}
     */
    _isAudioValid(audio, sourceType) {
        switch (sourceType) {
            case 'jpod101':
            {
                const duration = audio.duration;
                return (
                    duration !== 5.694694 && // Invalid audio (Chrome)
                    duration !== 5.651111 // Invalid audio (Firefox)
                );
            }
            default:
                return true;
        }
    }

    /**
     * @param {string} voiceUri
     * @returns {?SpeechSynthesisVoice}
     */
    _getTextToSpeechVoiceFromVoiceUri(voiceUri) {
        try {
            for (const voice of speechSynthesis.getVoices()) {
                if (voice.voiceURI === voiceUri) {
                    return voice;
                }
            }
        } catch (e) {
            // NOP
        }
        return null;
    }
}
