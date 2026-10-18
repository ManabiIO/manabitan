/*
 * Copyright (C) 2024-2026  Yomitan Authors
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
import {log} from '../core/log.js';
import {DictionaryDatabase} from './dictionary-database.js';

export class DictionaryDatabaseWorkerHandler {
    constructor() {
        /** @type {DictionaryDatabase?} */
        this._dictionaryDatabase = null;
        /** @type {Promise<void>|null} */
        this._preparePromise = null;
    }

    /** @returns {Promise<void>} */
    prepare() {
        if (this._preparePromise !== null) { return this._preparePromise; }
        const dictionaryDatabase = new DictionaryDatabase();
        this._dictionaryDatabase = dictionaryDatabase;
        // Publish readiness and install listeners before database startup yields.
        // A transferred connection port must not be lost while prepare is pending.
        this._preparePromise = Promise.resolve().then(async () => {
            try {
                await dictionaryDatabase.prepare();
            } catch (e) {
                log.error(e);
            }
        });
        self.addEventListener('message', this._onMessage.bind(this), false);
        self.addEventListener('messageerror', (event) => {
            const error = new ExtensionError('DictionaryDatabaseWorkerHandler: Error receiving message from main thread');
            error.data = event;
            log.error(error);
        });
        return this._preparePromise;
    }
    // Private

    /**
     * @param {MessageEvent<import('dictionary-database-worker-handler').MessageToWorker>} event
     */
    _onMessage(event) {
        const {action} = event.data;
        switch (action) {
            case 'connectToDatabaseWorker': {
                const port = event.ports[0];
                const task = this._preparePromise?.then(() => this._dictionaryDatabase?.connectToDatabaseWorker(port));
                if (typeof task !== 'undefined') {
                    void task.catch((error) => { log.error(error); });
                }
                break;
            }
            default:
                log.error(`Unknown action: ${action}`);
        }
    }
}
