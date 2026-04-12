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

import {querySelectorNotNull} from '../dom/query-selector.js';

/**
 * @param {import('dictionary-importer').Summary[]} dictionaryInfos
 */
export function renderDictionaryInfo(dictionaryInfos) {
    const fragment = document.createDocumentFragment();
    let first = true;
    for (const {title} of dictionaryInfos) {
        if (first) {
            first = false;
        } else {
            fragment.appendChild(document.createTextNode(', '));
        }

        const node = document.createElement('span');
        node.className = 'installed-dictionary';
        node.textContent = title;
        fragment.appendChild(node);
    }

    /** @type {HTMLElement} */
    const noneElement = querySelectorNotNull(document, '#installed-dictionaries-none');

    noneElement.hidden = (dictionaryInfos.length > 0);
    /** @type {HTMLElement} */
    const container = querySelectorNotNull(document, '#installed-dictionaries');
    container.textContent = '';
    container.appendChild(fragment);
}

/**
 * @param {import('../comm/api.js').API} api
 */
export async function showDictionaryInfo(api) {
    let dictionaryInfos;
    try {
        dictionaryInfos = await api.getDictionaryInfo();
    } catch (e) {
        return;
    }

    renderDictionaryInfo(dictionaryInfos);
}

export class DictionaryInfoController {
    /**
     * @param {import('../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {number} */
        this._refreshGeneration = 0;
    }

    /**
     * @returns {Promise<void>}
     */
    async refresh() {
        const refreshGeneration = ++this._refreshGeneration;
        let dictionaryInfos;
        try {
            dictionaryInfos = await this._api.getDictionaryInfo();
        } catch (e) {
            return;
        }
        if (refreshGeneration !== this._refreshGeneration) { return; }
        renderDictionaryInfo(dictionaryInfos);
    }
}
