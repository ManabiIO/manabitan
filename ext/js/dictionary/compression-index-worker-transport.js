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

import {toError} from '../core/to-error.js';

/**
 * A private index session borrows one ready codec worker. The pool remains the
 * worker owner: ordinary retirement closes only this port, whereas an ambiguous
 * protocol or transport failure revokes the complete pool and its open handles.
 */
export class CompressionIndexWorkerTransport extends EventTarget {
    /**
     * @param {MessagePort} port
     * @param {(error: Error) => void} failOwner
     * @param {() => void} releaseOwner
     */
    constructor(port, failOwner, releaseOwner) {
        super();
        /** @type {MessagePort} */
        this._port = port;
        /** @type {(error: Error) => void} */
        this._failOwner = failOwner;
        /** @type {() => void} */
        this._releaseOwner = releaseOwner;
        /** @type {boolean} */
        this._closed = false;
        /** @type {(event: MessageEvent<unknown>) => void} */
        this._onPortMessage = (event) => {
            if (!this._closed) {
                this.dispatchEvent(new MessageEvent('message', {data: event.data}));
            }
        };
        /** @type {() => void} */
        this._onPortMessageError = () => {
            this._failOwner(new Error('Shared import index transport returned an invalid message'));
        };
        port.addEventListener('message', this._onPortMessage);
        port.addEventListener('messageerror', this._onPortMessageError);
        port.start();
    }

    /**
     * @param {unknown} message
     * @param {Transferable[]} [transfer]
     * @throws {Error} If the borrowed session is closed.
     */
    postMessage(message, transfer = []) {
        if (this._closed) { throw new Error('Shared import index transport is closed'); }
        this._port.postMessage(message, transfer);
    }

    /** Ambiguous failure must stop any remote owner before rollback. */
    terminate() {
        if (!this._closed) {
            this._failOwner(new Error('Shared import index transport failed'));
        }
    }

    /** Called only after the server acknowledges an empty disposed session. */
    release() {
        this._close();
    }

    /**
     * Pool failure settles this session immediately, including idle open writers.
     * @param {unknown} value
     */
    fail(value) {
        if (this._closed) { return; }
        const error = toError(value);
        this._close();
        this.dispatchEvent(Object.assign(new Event('error'), {message: error.message}));
    }

    /** */
    _close() {
        if (this._closed) { return; }
        this._closed = true;
        this._port.removeEventListener('message', this._onPortMessage);
        this._port.removeEventListener('messageerror', this._onPortMessageError);
        this._port.close();
        this._releaseOwner();
    }
}
