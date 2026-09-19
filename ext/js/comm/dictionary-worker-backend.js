/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {ExtensionError} from '../core/extension-error.js';

/** @typedef {import('dictionary-worker-handler').DictionaryWorkerBackend} DictionaryWorkerBackend */

/**
 * Extension-only transport adapter. It does not install a web messaging bridge
 * or expose arbitrary extension actions to webpages. Importing this module is
 * safe without a global chrome object; the extension entry point supplies it.
 * @implements {DictionaryWorkerBackend}
 */
export class ExtensionDictionaryWorkerBackend {
    /**
     * @param {Pick<typeof chrome.runtime, 'sendMessage'|'lastError'>|undefined} runtime
     */
    constructor(runtime) {
        /** @type {Pick<typeof chrome.runtime, 'sendMessage'|'lastError'>|undefined} */
        this._runtime = runtime;
    }

    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<void>}
     */
    async deleteDictionaryByTitle(dictionaryTitle) {
        await this._invoke('deleteDictionaryByTitle', {dictionaryTitle});
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    async getDictionaryCounts(dictionaryNames, getTotal) {
        return await this._invoke('getDictionaryCounts', {dictionaryNames, getTotal});
    }

    /**
     * @template [T=unknown]
     * @param {'deleteDictionaryByTitle'|'getDictionaryCounts'} action
     * @param {import('core').SerializableObject} params
     * @returns {Promise<T>}
     */
    async _invoke(action, params) {
        const runtime = this._runtime;
        if (typeof runtime?.sendMessage !== 'function') {
            throw new Error(`Cannot invoke dictionary action ${action}: extension runtime unavailable`);
        }
        return await new Promise((resolve, reject) => {
            runtime.sendMessage({action, params}, (responseRaw) => {
                // lastError is scoped to this callback and must be read here.
                const runtimeError = runtime.lastError;
                if (typeof runtimeError !== 'undefined') {
                    reject(new Error(runtimeError.message));
                    return;
                }
                const response = /** @type {unknown} */ (responseRaw);
                if (!(typeof response === 'object' && response !== null && !Array.isArray(response))) {
                    reject(new Error(`Dictionary action ${action} returned invalid response`));
                    return;
                }
                const responseRecord = /** @type {Record<string, unknown>} */ (response);
                const error = Reflect.get(responseRecord, 'error');
                if (typeof error !== 'undefined' && error !== null) {
                    if (typeof error === 'object' && !Array.isArray(error)) {
                        reject(ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (error)));
                    } else {
                        reject(new Error(`Dictionary action ${action} returned invalid error payload`));
                    }
                    return;
                }
                resolve(/** @type {T} */ (Reflect.get(responseRecord, 'result')));
            });
        });
    }
}
