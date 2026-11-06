/*
 * Copyright (C) 2026 Manabitan authors
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

import {deferPromise} from '../core/utilities.js';

/** Browser-owned port lifetime survives cancelled beforeunload prompts. */
export class DictionaryImportOwnerClient {
    constructor() {
        /** @type {Map<string, {port: chrome.runtime.Port, ready: Promise<void>, stop: () => void}>} */
        this._connections = new Map();
    }

    /**
     * @param {string} ownerId
     * @returns {Promise<void>}
     */
    open(ownerId) {
        const existing = this._connections.get(ownerId);
        if (existing) { return existing.ready; }
        if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(ownerId)) { return Promise.reject(new Error('Invalid dictionary import session owner')); }
        const port = chrome.runtime.connect({name: JSON.stringify({name: 'dictionary-import-owner', ownerId})});
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const {promise: ready, resolve, reject} = deferPromise();
        let settled = false;
        const closeConnection = () => {
            if (this._connections.get(ownerId)?.ready === ready) { this.close(ownerId); }
        };
        const removeMessageListener = () => {
            try { port.onMessage.removeListener(onMessage); } catch (_) { /* A dead browser context may reject listener cleanup. */ }
        };
        /** @param {Error|null} error */
        const finish = (error) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            removeMessageListener();
            if (error) {
                reject(error);
                closeConnection();
            } else { resolve(); }
        };
        /** @param {unknown} message */
        const onMessage = (message) => {
            if (typeof message !== 'object' || message === null || Reflect.get(message, 'ownerId') !== ownerId) { return; }
            if (Reflect.get(message, 'type') === 'ready') { finish(null); }
            if (Reflect.get(message, 'type') === 'error') { finish(new Error(String(Reflect.get(message, 'message')))); }
        };
        const onDisconnect = () => {
            // Consume runtime.lastError on browser-rejected connections.
            const message = chrome.runtime.lastError?.message;
            finish(new Error(message || 'Dictionary import owner disconnected before readiness'));
            closeConnection();
        };
        const timer = setTimeout(() => { finish(new Error('Dictionary import owner readiness timed out')); }, 30000);
        const stop = () => {
            try { port.onDisconnect.removeListener(onDisconnect); } catch (_) { /* Continue settling and closing other owners. */ }
            removeMessageListener();
            finish(new Error('Dictionary import owner disconnected before readiness'));
        };
        this._connections.set(ownerId, {port, ready, stop});
        try {
            port.onMessage.addListener(onMessage);
            port.onDisconnect.addListener(onDisconnect);
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
        return ready;
    }

    /** @param {string} ownerId */
    close(ownerId) {
        const connection = this._connections.get(ownerId);
        if (!connection) { return; }
        this._connections.delete(ownerId);
        connection.stop();
        try { connection.port.disconnect(); } catch (_) { /* A dead browser context may already have closed it. */ }
    }

    /** Close every task-owned connection and settle pending readiness. */
    closeAll() {
        for (const ownerId of this._connections.keys()) { this.close(ownerId); }
    }
}
