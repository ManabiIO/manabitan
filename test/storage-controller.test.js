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

// @vitest-environment jsdom

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {StorageController} from '../ext/js/pages/settings/storage-controller.js';

describe('StorageController runtime check', () => {
    /** @type {import('../ext/js/pages/settings/storage-controller.js').StorageController} */
    let controller;
    /** @type {{persisted: ReturnType<typeof vi.fn>, estimate: ReturnType<typeof vi.fn>}} */
    let storageMock;
    /** @type {{session: {get: ReturnType<typeof vi.fn>}, local: {get: ReturnType<typeof vi.fn>}}} */
    let chromeStorageMock;

    beforeEach(() => {
        document.body.innerHTML = `
            <button id="storage-refresh"></button>
            <div id="storage-runtime-check"></div>
        `;
        storageMock = {
            persisted: vi.fn(async () => false),
            estimate: vi.fn(async () => ({usage: 1024, quota: 4096})),
        };
        Object.defineProperty(globalThis.navigator, 'storage', {
            configurable: true,
            value: storageMock,
        });
        class MockFileSystemFileHandle {}
        MockFileSystemFileHandle.prototype.createSyncAccessHandle = () => {};
        vi.stubGlobal('FileSystemFileHandle', MockFileSystemFileHandle);
        chromeStorageMock = {
            session: {
                get: vi.fn(async () => ({manabitanLastBackendStartupError: null})),
            },
            local: {
                get: vi.fn(async () => ({manabitanLastBackendStartupError: null})),
            },
        };
        vi.stubGlobal('chrome', {storage: chromeStorageMock});
    });

    afterEach(() => {
        controller = undefined;
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    test('shows backend storage state when backend is reachable', async () => {
        const application = {
            api: {
                debugDictionaryStorageState: vi.fn(async () => ({
                    usesFallbackStorage: false,
                    openStorageDiagnostics: {mode: 'opfs-sahpool'},
                    startupDiagnosticsSnapshot: {dictionaryPrepareError: ''},
                    dictionaryRows: [{title: 'Jitendex'}],
                    offscreenDictionaryRows: [{title: 'Jitendex'}],
                })),
            },
            on: vi.fn(),
        };
        const persistentStorageController = {
            application,
            isStoragePeristent: vi.fn(async () => false),
        };

        controller = new StorageController(/** @type {any} */ (persistentStorageController));
        controller.prepare();
        await vi.waitFor(() => {
            expect((/** @type {HTMLElement} */ (document.querySelector('#storage-runtime-check')).textContent || '').length).toBeGreaterThan(0);
        });

        const text = /** @type {HTMLElement} */ (document.querySelector('#storage-runtime-check')).textContent || '';
        expect(text).toContain('backend reachable=true');
        expect(text).toContain('dictionary backend usable=true');
        expect(text).toContain('backend mode=opfs-sahpool');
        expect(text).toContain('dictionaryRows=1');
        expect(text).toContain('offscreenDictionaryRows=1');
    });

    test('shows stored startup failure when backend API is unreachable', async () => {
        chromeStorageMock.session.get.mockResolvedValue({
            manabitanLastBackendStartupError: {
                errorMessage: 'Failed to initialize OPFS runtime',
            },
        });
        const application = {
            api: {
                debugDictionaryStorageState: vi.fn(async () => {
                    throw new Error('Receiving end does not exist.');
                }),
            },
            on: vi.fn(),
        };
        const persistentStorageController = {
            application,
            isStoragePeristent: vi.fn(async () => false),
        };

        controller = new StorageController(/** @type {any} */ (persistentStorageController));
        controller.prepare();
        await vi.waitFor(() => {
            expect((/** @type {HTMLElement} */ (document.querySelector('#storage-runtime-check')).textContent || '').length).toBeGreaterThan(0);
        });

        const text = /** @type {HTMLElement} */ (document.querySelector('#storage-runtime-check')).textContent || '';
        expect(text).toContain('backend reachable=false');
        expect(text).toContain('dictionary backend usable=false');
        expect(text).toContain('backendError=Receiving end does not exist.');
        expect(text).toContain('startupError=Failed to initialize OPFS runtime');
    });
});
