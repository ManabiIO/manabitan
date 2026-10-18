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

// Content-Length is an untrusted allocation hint, not a body-size limit.
const RESPONSE_PREALLOCATION_MAX_BYTES = 16 * 1024 * 1024;

/**
 * This class is used to generate `fetch()` requests on the background page
 * with additional controls over anonymity and error handling.
 */
export class RequestBuilder {
    /**
     * Creates a new instance.
     */
    constructor() {
        /** @type {TextEncoder} */
        this._textEncoder = new TextEncoder();
        /** @type {Set<number>} */
        this._ruleIds = new Set();
    }

    /**
     * Initializes the instance.
     */
    async prepare() {
        try {
            await this._clearDynamicRules();
            await this._clearSessionRules();
        } catch (e) {
            // NOP
        }
    }

    /**
     * Runs an anonymized fetch request, which strips the `Cookie` header and adjust the `Origin` header.
     * @param {string} url The URL to fetch.
     * @param {RequestInit} init The initialization parameters passed to the `fetch` function.
     * @returns {Promise<Response>} The response of the `fetch` call.
     */
    async fetchAnonymous(url, init) {
        const id = this._getNewRuleId();
        const parsedUrl = new URL(url);
        parsedUrl.hash = '';
        url = parsedUrl.href;
        const originUrl = this._getOriginURL(url);

        this._ruleIds.add(id);
        let releaseRuleId = true;
        try {
            /** @type {chrome.declarativeNetRequest.Rule[]} */
            const addRules = [{
                id,
                priority: 1,
                condition: {
                    urlFilter: `|${this._escapeDnrUrl(url)}|`,
                    resourceTypes: [
                        /** @type {chrome.declarativeNetRequest.ResourceType} */ ('xmlhttprequest'),
                    ],
                },
                action: {
                    type: /** @type {chrome.declarativeNetRequest.RuleActionType} */ ('modifyHeaders'),
                    requestHeaders: [
                        {
                            operation: /** @type {chrome.declarativeNetRequest.HeaderOperation} */ ('remove'),
                            header: 'Cookie',
                        },
                        {
                            operation: /** @type {chrome.declarativeNetRequest.HeaderOperation} */ ('set'),
                            header: 'Origin',
                            value: originUrl,
                        },
                    ],
                    responseHeaders: [
                        {
                            operation: /** @type {chrome.declarativeNetRequest.HeaderOperation} */ ('remove'),
                            header: 'Set-Cookie',
                        },
                    ],
                },
            }];

            await this._updateSessionRules({addRules});
            try {
                return await fetch(url, init);
            } finally {
                // A failed browser cleanup leaves the rule alive. Keep its ID
                // reserved locally so a later request cannot collide with it.
                releaseRuleId = await this._tryUpdateSessionRules({removeRuleIds: [id]});
            }
        } finally {
            if (releaseRuleId) {
                this._ruleIds.delete(id);
            }
        }
    }

    /**
     * Reads the array buffer body of a fetch response, with optional progress and cancellation.
     * @param {Response} response The response of a `fetch` call.
     * @param {?(done: boolean) => void} onProgress The progress callback.
     * @param {?AbortSignal} [signal] Cancels consumption as well as the underlying reader.
     * @returns {Promise<Uint8Array>} The resulting binary data.
     */
    static async readFetchResponseArrayBuffer(response, onProgress, signal = null) {
        /** @type {ReadableStreamDefaultReader<Uint8Array>|undefined} */
        let reader;
        try {
            if (onProgress !== null || signal !== null) {
                const {body} = response;
                if (body !== null) {
                    reader = body.getReader();
                }
            }
        } catch (e) {
            // Not supported
        }

        const checkAborted = () => {
            if (signal !== null && signal.aborted) { throw signal.reason; }
        };
        /** @returns {Promise<Uint8Array>} */
        const consume = async () => {
            checkAborted();
            if (typeof reader === 'undefined') {
                const result = await response.arrayBuffer();
                checkAborted();
                if (onProgress !== null) {
                    onProgress(true);
                }
                checkAborted();
                return new Uint8Array(result);
            }

            const contentLengthString = response.headers.get('Content-Length');
            const contentLength = contentLengthString !== null && /^\d+$/.test(contentLengthString) ?
                Number(contentLengthString) :
                Number.NaN;
            let target = Number.isSafeInteger(contentLength) && contentLength <= RESPONSE_PREALLOCATION_MAX_BYTES ?
                new Uint8Array(contentLength) :
                null;
            let targetPosition = 0;
            let totalLength = 0;
            const targets = [];

            while (true) {
                const {done, value} = await reader.read();
                checkAborted();
                if (done) { break; }
                // Empty chunks do not advance an idle download or need storage.
                if (value.length === 0) { continue; }
                if (onProgress !== null) {
                    onProgress(false);
                }
                checkAborted();
                if (target === null) {
                    targets.push({array: value, length: value.length});
                } else if (targetPosition + value.length > target.length) {
                    targets.push({array: target.subarray(0, targetPosition), length: targetPosition}, {array: value, length: value.length});
                    target = null;
                } else {
                    target.set(value, targetPosition);
                    targetPosition += value.length;
                }
                totalLength += value.length;
            }

            if (target === null) {
                target = this._joinUint8Arrays(targets, totalLength);
            } else if (totalLength < target.length) {
                target = target.slice(0, totalLength);
            }

            if (onProgress !== null) {
                onProgress(true);
            }

            checkAborted();
            return /** @type {Uint8Array} */ (target);
        };
        /** @type {?(() => void)} */
        let onAbort = null;
        try {
            if (signal === null) { return await consume(); }
            /** @type {Promise<never>} */
            const aborted = new Promise((_resolve, reject) => {
                onAbort = () => { reject(signal.reason); };
                signal.addEventListener('abort', onAbort);
            });
            // Native cancellation may settle late or not at all. Retire the
            // caller independently; consume also checks before publishing data.
            return await Promise.race([consume(), aborted]);
        } catch (error) {
            // Own cancellation failures without awaiting an uncooperative
            // stream. This also covers the arrayBuffer fallback path.
            try {
                const cancellation = typeof reader === 'undefined' ? response.body?.cancel(error) : reader.cancel(error);
                if (cancellation) { void cancellation.catch(() => {}); }
            } catch (e) {
                // Preserve the original read/consumer/cancellation error.
            }
            throw error;
        } finally {
            if (signal !== null && onAbort !== null) { signal.removeEventListener('abort', onAbort); }
            if (typeof reader !== 'undefined') { reader.releaseLock(); }
        }
    }

    // Private

    /** */
    async _clearSessionRules() {
        const rules = await this._getSessionRules();

        if (rules.length === 0) { return; }

        const removeRuleIds = [];
        for (const {id} of rules) {
            removeRuleIds.push(id);
        }

        await this._updateSessionRules({removeRuleIds});
    }

    /**
     * @returns {Promise<chrome.declarativeNetRequest.Rule[]>}
     */
    _getSessionRules() {
        return new Promise((resolve, reject) => {
            chrome.declarativeNetRequest.getSessionRules((result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * @param {chrome.declarativeNetRequest.UpdateRuleOptions} options
     * @returns {Promise<void>}
     */
    _updateSessionRules(options) {
        return new Promise((resolve, reject) => {
            chrome.declarativeNetRequest.updateSessionRules(options, () => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * @param {chrome.declarativeNetRequest.UpdateRuleOptions} options
     * @returns {Promise<boolean>}
     */
    async _tryUpdateSessionRules(options) {
        try {
            await this._updateSessionRules(options);
            return true;
        } catch (e) {
            return false;
        }
    }

    /** */
    async _clearDynamicRules() {
        const rules = await this._getDynamicRules();

        if (rules.length === 0) { return; }

        const removeRuleIds = [];
        for (const {id} of rules) {
            removeRuleIds.push(id);
        }

        await this._updateDynamicRules({removeRuleIds});
    }

    /**
     * @returns {Promise<chrome.declarativeNetRequest.Rule[]>}
     */
    _getDynamicRules() {
        return new Promise((resolve, reject) => {
            chrome.declarativeNetRequest.getDynamicRules((result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * @param {chrome.declarativeNetRequest.UpdateRuleOptions} options
     * @returns {Promise<void>}
     */
    _updateDynamicRules(options) {
        return new Promise((resolve, reject) => {
            chrome.declarativeNetRequest.updateDynamicRules(options, () => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * @returns {number}
     * @throws {Error}
     */
    _getNewRuleId() {
        let id = 1;
        while (this._ruleIds.has(id)) {
            const pre = id;
            ++id;
            if (id === pre) { throw new Error('Could not generate an id'); }
        }
        return id;
    }

    /**
     * @param {string} url
     * @returns {string}
     */
    _getOriginURL(url) {
        const url2 = new URL(url);
        return `${url2.protocol}//${url2.host}`;
    }

    /**
     * @param {string} url
     * @returns {string}
     */
    _escapeDnrUrl(url) {
        return url.replace(/[|*^]/g, (char) => this._urlEncodeUtf8(char));
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    _urlEncodeUtf8(text) {
        const array = this._textEncoder.encode(text);
        let result = '';
        for (const byte of array) {
            result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
        }
        return result;
    }

    /**
     * @param {{array: Uint8Array, length: number}[]} items
     * @param {number} totalLength
     * @returns {Uint8Array}
     */
    static _joinUint8Arrays(items, totalLength) {
        if (items.length === 1) {
            const {array, length} = items[0];
            if (array.length === length) { return array; }
        }
        const result = new Uint8Array(totalLength);
        let position = 0;
        for (const {array, length} of items) {
            result.set(array.subarray(0, length), position);
            position += length;
        }
        return result;
    }
}
