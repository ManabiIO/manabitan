/*
 * Copyright (C) 2026  Yomitan Authors
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


/** @type {?AudioContext} */
let sharedAudioContext = null;

/**
 * @returns {AudioContext}
 */
function getSharedAudioContext() {
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
        sharedAudioContext = new AudioContext();
    }
    return sharedAudioContext;
}

export class WebAudioLocalAudio {
    /**
     * @param {string} base64Data
     * @param {string} contentType
     */
    constructor(base64Data, contentType) {
        /** @type {string} */
        this._base64Data = base64Data;
        /** @type {string} */
        this._contentType = contentType;
        /** @type {number} */
        this._volume = 1;
        /** @type {number} */
        this._currentTime = 0;
        /** @type {AudioContext} */
        this._audioContext = getSharedAudioContext();
        /** @type {?AudioBufferSourceNode} */
        this._bufferSource = null;
        /** @type {?GainNode} */
        this._gainNode = null;
        /** @type {?AudioBuffer} */
        this._decodedBuffer = null;
        /** @type {?import('core').TokenObject} */
        this._playToken = null;
    }

    /** @type {number} */
    get currentTime() { return this._currentTime; }

    set currentTime(value) { this._currentTime = value; }

    /** @type {number} */
    get volume() { return this._volume; }

    set volume(value) {
        this._volume = value;
        if (this._gainNode) { this._gainNode.gain.value = value; }
    }

    /** @type {number} */
    get duration() { return this._decodedBuffer ? this._decodedBuffer.duration : 0; }

    /** */
    async prepare() {
        const byteCharacters = atob(this._base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);

        this._decodedBuffer = await this._audioContext.decodeAudioData(byteArray.buffer);
    }

    /**
     * @returns {Promise<void>}
     */
    async play() {
        if (!this._decodedBuffer || !this._audioContext) { return; }
        this.pause();
        const token = {};
        this._playToken = token;
        try {
            if (this._audioContext.state === 'suspended') {
                await this._audioContext.resume();
            }
            // A pause or newer play request can supersede this one during resume.
            if (this._playToken !== token) { return; }

            const bufferSource = this._audioContext.createBufferSource();
            this._bufferSource = bufferSource;
            bufferSource.buffer = this._decodedBuffer;

            this._gainNode = this._audioContext.createGain();
            this._gainNode.gain.value = this._volume;

            bufferSource.connect(this._gainNode);
            this._gainNode.connect(this._audioContext.destination);
            bufferSource.onended = () => {
                if (this._bufferSource === bufferSource) { this.pause(); }
            };
            bufferSource.start(0, this._currentTime);
        } catch (e) {
            if (this._playToken === token) { this.pause(); }
            throw e;
        }
    }

    /**
     * @returns {void}
     */
    pause() {
        this._playToken = null;
        const bufferSource = this._bufferSource;
        const gainNode = this._gainNode;
        this._bufferSource = null;
        this._gainNode = null;
        if (bufferSource) {
            bufferSource.onended = null;
            try { bufferSource.stop(); } catch (e) { /* NOP */ }
            bufferSource.disconnect();
        }
        if (gainNode) { gainNode.disconnect(); }
    }
}
