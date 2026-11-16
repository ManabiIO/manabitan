/*
 * Copyright (C) 2025-2026  Yomitan Authors
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

import {toError} from '../../core/to-error.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class YomitanApiController {
    /**
     * @param {import('../../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../../comm/api.js').API} */
        this._api = api;
        /** @type {HTMLButtonElement} */
        this._testButton = querySelectorNotNull(document, '#test-yomitan-api-button');
        /** @type {HTMLElement} */
        this._resultsContainer = querySelectorNotNull(document, '#test-yomitan-api-results');
        /** @type {HTMLInputElement} */
        this._urlInput = querySelectorNotNull(document, '#test-yomitan-url-input');
        /** @type {boolean} */
        this._testActive = false;
        /** @type {number} */
        this._urlGeneration = 0;
        /** @type {string} */
        this._observedUrl = this._urlInput.value;
    }

    /** */
    prepare() {
        this._testButton.addEventListener('click', this._onTestButtonClick.bind(this), false);
        this._urlInput.addEventListener('input', this._onUrlChanged.bind(this), false);
        this._urlInput.addEventListener('settingChanged', this._onUrlChanged.bind(this), false);
    }

    // Private

    /**
     * @param {MouseEvent} e
     */
    _onTestButtonClick(e) {
        e.preventDefault();
        void this._testYomitanApi();
    }

    /** @param {Event} event */
    _onUrlChanged(event) {
        const url = this._urlInput.value;
        if (event.type === 'settingChanged' && url === this._observedUrl) { return; }
        this._observedUrl = url;
        ++this._urlGeneration;
        this._resultsContainer.textContent = '';
        this._resultsContainer.hidden = true;
    }

    /** */
    async _testYomitanApi() {
        if (this._testActive) { return; }

        const url = this._urlInput.value;
        const generation = this._urlGeneration;
        const isCurrent = () => generation === this._urlGeneration && url === this._urlInput.value;
        try {
            this._testActive = true;
            const resultsContainer = /** @type {HTMLElement} */ (this._resultsContainer);
            /** @type {HTMLButtonElement} */ (this._testButton).disabled = true;
            resultsContainer.textContent = '';
            resultsContainer.hidden = true;
            await this._api.testYomitanApi(url);
            if (isCurrent()) { this._setStatus('Connection was successful', false); }
        } catch (e) {
            if (isCurrent()) { this._setStatus(toError(e).message, true); }
        } finally {
            this._testActive = false;
            /** @type {HTMLButtonElement} */ (this._testButton).disabled = false;
        }
    }

    /**
     * @param {string} message
     * @param {boolean} isError
     */
    _setStatus(message, isError) {
        const resultsContainer = /** @type {HTMLElement} */ (this._resultsContainer);
        resultsContainer.textContent = message;
        resultsContainer.hidden = false;
        resultsContainer.classList.toggle('danger-text', isError);
    }
}
