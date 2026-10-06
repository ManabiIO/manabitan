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

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {toError} from '../core/to-error.js';
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';

/**
 * The content manager which is used when generating HTML display content.
 */
export class DisplayContentManager {
    /**
     * Creates a new instance of the class.
     * @param {import('./display.js').Display} display The display instance that owns this object.
     */
    constructor(display) {
        /** @type {import('./display.js').Display} */
        this._display = display;
        /** @type {import('core').TokenObject} */
        this._token = {};
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {import('display-content-manager').LoadMediaRequest[]} */
        this._loadMediaRequests = [];
    }

    /** @type {import('display-content-manager').LoadMediaRequest[]} */
    get loadMediaRequests() {
        return this._loadMediaRequests;
    }

    /**
     * Queues loading media file from a given dictionary.
     * @param {string} path
     * @param {string} dictionary
     * @param {OffscreenCanvas} canvas
     */
    loadMedia(path, dictionary, canvas) {
        this._loadMediaRequests.push({path, dictionary, canvas});
    }

    /**
     * Unloads all media that has been loaded.
     */
    unloadAll() {
        this._token = {};

        this._eventListeners.removeAllEventListeners();

        this._loadMediaRequests = [];
    }

    /**
     * Sets up attributes and events for a link element.
     * @param {HTMLAnchorElement} element The link element.
     * @param {string} href The URL.
     * @param {boolean} internal Whether or not the URL is an internal or external link.
     */
    prepareLink(element, href, internal) {
        element.href = href;
        if (!internal) {
            element.target = '_blank';
            element.rel = 'noreferrer noopener';
        }
        this._eventListeners.addEventListener(element, 'click', this._onLinkClick.bind(this));
    }

    /**
     * Execute media requests
     */
    async executeMediaRequests() {
        this._display.application.api.drawMedia(this._loadMediaRequests, this._loadMediaRequests.map(({canvas}) => canvas));
        this._loadMediaRequests = [];
    }

    /**
     * @param {string} path
     * @param {string} dictionary
     * @param {Window} window
     */
    async openMediaInTab(path, dictionary, window) {
        const token = this._token;
        try {
            const data = await this._display.application.api.getMedia([{path, dictionary}]);
            if (token !== this._token) { return; }
            const media = data[0];
            if (typeof media === 'undefined' || media.path !== path || media.dictionary !== dictionary) {
                throw new Error(`Could not find media at path ${JSON.stringify(path)} in ${dictionary}`);
            }
            const buffer = base64ToArrayBuffer(media.content);
            const blob = new Blob([buffer], {type: media.mediaType});
            const blobUrl = URL.createObjectURL(blob);
            try {
                // Noopener may return null even when navigation succeeds. Keep
                // the URL alive across lookup changes so the new tab can load it.
                window.open(blobUrl, '_blank', 'noopener,noreferrer');
            } catch (error) {
                URL.revokeObjectURL(blobUrl);
                throw error;
            }
        } catch (error) {
            if (token === this._token) { this._display.onError(toError(error)); }
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onLinkClick(e) {
        const {href} = /** @type {HTMLAnchorElement} */ (e.currentTarget);
        if (typeof href !== 'string') { return; }

        const baseUrl = new URL(location.href);
        const url = new URL(href, baseUrl);
        const internal = (url.protocol === baseUrl.protocol && url.host === baseUrl.host);
        if (!internal) { return; }

        e.preventDefault();

        /** @type {import('display').HistoryParams} */
        const params = {};
        for (const [key, value] of url.searchParams.entries()) {
            params[key] = value;
        }
        void this._display.setContent({
            historyMode: 'new',
            focus: false,
            params,
            state: null,
            content: null,
        });
    }
}
