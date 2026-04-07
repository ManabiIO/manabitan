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

import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {StorageController} from '../ext/js/pages/settings/storage-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

/**
 * @param {Document} document
 * @returns {HTMLElement}
 */
function setupStorageRuntimeDom(document) {
    document.body.innerHTML = `
        <button id="storage-refresh"></button>
        <div id="storage-runtime-check"></div>
    `;
    return /** @type {HTMLElement} */ (document.querySelector('#storage-runtime-check'));
}

/**
 * @returns {StorageController}
 */
function createControllerForInternalTests() {
    return /** @type {StorageController} */ (Object.create(StorageController.prototype));
}

describe('StorageController runtime check', () => {
    const {window} = testEnv;

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        window.document.body.innerHTML = '';
    });

    test('shows backend runtime health even when the page itself lacks SyncAccessHandle', async () => {
        const controller = createControllerForInternalTests();
        const runtimeCheckNode = setupStorageRuntimeDom(window.document);
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 Firefox/999.0',
            storage: {
                getDirectory: async () => ({}),
            },
        });
        vi.stubGlobal('FileSystemFileHandle', function FileSystemFileHandle() {});
        Reflect.set(controller, '_persistentStorageController', {
            application: {
                api: {
                    debugDictionaryStorageState: vi.fn().mockResolvedValue({
                        openStorageDiagnostics: {mode: 'opfs-sahpool', openFailureClass: null},
                        startupDiagnosticsSnapshot: null,
                    }),
                },
            },
        });
        Reflect.set(controller, '_storageRuntimeCheckNode', runtimeCheckNode);

        await controller._updateRuntimeCheck();

        expect(runtimeCheckNode.textContent).toContain('dictionary backend usable=true');
        expect(runtimeCheckNode.textContent).toContain('backend mode=opfs-sahpool');
        expect(runtimeCheckNode.textContent).toContain('page createSyncAccessHandle=false');
    });

    test('surfaces backend startup failure in settings runtime check text', async () => {
        const controller = createControllerForInternalTests();
        const runtimeCheckNode = setupStorageRuntimeDom(window.document);
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 Chrome/999.0',
            storage: {},
        });
        Reflect.set(controller, '_persistentStorageController', {
            application: {
                api: {
                    debugDictionaryStorageState: vi.fn().mockRejectedValue(new Error('opfs-sahpool requires a DedicatedWorkerGlobalScope')),
                },
            },
        });
        Reflect.set(controller, '_storageRuntimeCheckNode', runtimeCheckNode);

        await controller._updateRuntimeCheck();

        expect(runtimeCheckNode.textContent).toContain('dictionary backend usable=false');
        expect(runtimeCheckNode.textContent).toContain('backend startup error=opfs-sahpool requires a DedicatedWorkerGlobalScope');
    });
});
