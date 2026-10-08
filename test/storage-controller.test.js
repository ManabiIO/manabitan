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
    /** @type {import('../ext/js/pages/settings/storage-controller.js').StorageController|undefined} */
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

    test('retries a failed storage estimate on the next manual refresh', async () => {
        document.body.insertAdjacentHTML('beforeend', `
            <div class="storage-use-valid" hidden></div>
            <div class="storage-use-invalid" hidden></div>
        `);
        storageMock.estimate.mockRejectedValueOnce(new Error('Transient storage failure'));
        const application = {
            api: {debugDictionaryStorageState: vi.fn(async () => null)},
            on: vi.fn(),
        };
        const persistentStorageController = {
            application,
            isStoragePeristent: vi.fn(async () => false),
        };
        controller = new StorageController(/** @type {any} */ (persistentStorageController));
        controller.prepare();

        await vi.waitFor(() => {
            expect((/** @type {HTMLElement} */ (document.querySelector('.storage-use-invalid'))).hidden).toBe(false);
            expect(application.api.debugDictionaryStorageState).toHaveBeenCalledOnce();
        });

        document.querySelector('#storage-refresh')?.dispatchEvent(new MouseEvent('click'));
        await vi.waitFor(() => {
            expect(storageMock.estimate).toHaveBeenCalledTimes(2);
            expect((/** @type {HTMLElement} */ (document.querySelector('.storage-use-valid'))).hidden).toBe(false);
        });
    });

    test('applies the latest storage estimate after changes during an in-flight refresh', async () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="storage-usage"></div>');
        /** @type {() => void} */
        let releaseFirstEstimate = () => {};
        const firstEstimateGate = new Promise((resolve) => {
            releaseFirstEstimate = () => resolve(undefined);
        });
        storageMock.estimate.mockImplementationOnce(async () => {
            await firstEstimateGate;
            return {usage: 100, quota: 5000000000};
        }).mockResolvedValue({usage: 2500, quota: 5000000000});

        const application = {
            api: {debugDictionaryStorageState: vi.fn(async () => null)},
            on: vi.fn(),
        };
        const persistentStorageController = {
            application,
            isStoragePeristent: vi.fn(async () => false),
        };
        controller = new StorageController(/** @type {any} */ (persistentStorageController));
        controller.prepare();

        const onStorageChanged = /** @type {() => void} */ (application.on.mock.calls[0][1]);
        onStorageChanged();
        onStorageChanged();
        releaseFirstEstimate();

        await vi.waitFor(() => {
            expect(storageMock.estimate).toHaveBeenCalledTimes(2);
            expect(document.querySelector('.storage-usage')?.textContent).toBe('2.5KB');
        });
    });

});
