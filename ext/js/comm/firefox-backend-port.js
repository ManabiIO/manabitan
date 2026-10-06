/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

/**
 * @returns {MessagePort}
 * @throws {Error} If the Firefox backend channel cannot be initialized.
 */
export function createFirefoxBackendPort() {
    /** @type {SharedWorker|null} */
    let sharedWorkerBridge = null;
    /** @type {MessageChannel|null} */
    let backendChannel = null;
    try {
        sharedWorkerBridge = new SharedWorker(new URL('shared-worker-bridge.js', import.meta.url), {type: 'module'});
        backendChannel = new MessageChannel();
        sharedWorkerBridge.port.postMessage({action: 'connectToBackend1'}, [backendChannel.port1]);
        sharedWorkerBridge.port.close();
        return backendChannel.port2;
    } catch (error) {
        for (const port of [sharedWorkerBridge?.port, backendChannel?.port1, backendChannel?.port2]) {
            try {
                port?.close();
            } catch (_) {
                // A failed close must not prevent release of the other ports.
            }
        }
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Failed to initialize Firefox backend bridge. You may need to refresh the page. ${normalizedError.message}`);
    }
}
