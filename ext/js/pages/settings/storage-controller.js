/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {querySelectorNotNull} from '../../dom/query-selector.js';

export class StorageController {
    /**
     * @param {import('./persistent-storage-controller.js').PersistentStorageController} persistentStorageController
     */
    constructor(persistentStorageController) {
    /** @type {import('./persistent-storage-controller.js').PersistentStorageController} */
        this._persistentStorageController = persistentStorageController;
        /** @type {?StorageEstimate} */
        this._mostRecentStorageEstimate = null;
        /** @type {boolean} */
        this._storageEstimateFailed = false;
        /** @type {boolean} */
        this._isUpdating = false;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUsageNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageQuotaNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseFiniteNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseExhaustWarnNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseInfiniteNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseValidNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseInvalidNodes = null;
        /** @type {HTMLElement|null} */
        this._storageRuntimeCheckNode = null;
        /** @type {string|null} */
        this._dictionaryBackendRuntimeError = null;
    }

    /** */
    prepare() {
        this._storageUsageNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-usage'));
        this._storageQuotaNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-quota'));
        this._storageUseFiniteNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-finite'));
        this._storageUseExhaustWarnNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-exhaustion-alert'));
        this._storageUseInfiniteNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-infinite'));
        this._storageUseValidNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-valid'));
        this._storageUseInvalidNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-invalid'));
        this._storageRuntimeCheckNode = document.querySelector('#storage-runtime-check');
        /** @type {HTMLButtonElement} */
        const storageRefreshButton = querySelectorNotNull(document, '#storage-refresh');

        storageRefreshButton.addEventListener('click', this._onStorageRefreshButtonClick.bind(this), false);
        this._persistentStorageController.application.on('storageChanged', this._onStorageChanged.bind(this));

        void this._updateStats();
    }

    // Private

    /** */
    _onStorageRefreshButtonClick() {
        void this._updateStats();
    }

    /** */
    _onStorageChanged() {
        void this._updateStats();
    }

    /** */
    async _updateStats() {
        if (this._isUpdating) { return; }

        try {
            this._isUpdating = true;

            const estimate = await this._storageEstimate();
            const valid = (estimate !== null);
            let storageIsLow = false;

            // Firefox reports usage as 0 when persistent storage is enabled.
            const finite = valid && ((typeof estimate.usage === 'number' && estimate.usage > 0) || !(await this._persistentStorageController.isStoragePeristent()));
            if (finite) {
                let {usage, quota} = estimate;

                if (typeof usage !== 'number') { usage = 0; }
                if (typeof quota !== 'number') {
                    quota = 0;
                } else {
                    storageIsLow = quota <= (3 * 1000000000);
                }
                const usageString = this._bytesToLabeledString(usage);
                const quotaString = this._bytesToLabeledString(quota);
                for (const node of /** @type {NodeListOf<HTMLElement>} */ (this._storageUsageNodes)) {
                    node.textContent = usageString;
                }
                for (const node of /** @type {NodeListOf<HTMLElement>} */ (this._storageQuotaNodes)) {
                    node.textContent = quotaString;
                }
            }

            this._setElementsVisible(this._storageUseFiniteNodes, valid && finite);
            this._setElementsVisible(this._storageUseInfiniteNodes, valid && !finite);
            this._setElementsVisible(this._storageUseValidNodes, valid);
            this._setElementsVisible(this._storageUseInvalidNodes, !valid);
            this._setElementsVisible(this._storageUseExhaustWarnNodes, storageIsLow);
            await this._updateRuntimeCheck();
        } finally {
            this._isUpdating = false;
        }
    }

    /** */
    async _updateRuntimeCheck() {
        if (this._storageRuntimeCheckNode === null) { return; }
        const userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
        const browserLabel = /Firefox\//i.test(userAgent) ? 'Firefox runtime' : 'Extension runtime';
        const storageValue = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (Reflect.get(navigator, 'storage') ?? {}));
        const hasStorageGetDirectory = typeof Reflect.get(storageValue, 'getDirectory') === 'function';
        const hasCreateSyncAccessHandle = (
            typeof Reflect.get(globalThis, 'FileSystemFileHandle') === 'function' &&
            typeof Reflect.get(
                /** @type {{prototype?: Record<string, unknown>}} */ (/** @type {unknown} */ (Reflect.get(globalThis, 'FileSystemFileHandle'))).prototype ?? {},
                'createSyncAccessHandle',
            ) === 'function'
        );
        let dictionaryBackendUsable = false;
        let backendMode = null;
        let backendStartupError = null;
        let backendOpenFailureClass = null;
        try {
            const storageState = /** @type {unknown} */ (await this._persistentStorageController.application.api.debugDictionaryStorageState());
            const storageStateRecord = (
                typeof storageState === 'object' &&
                storageState !== null &&
                !Array.isArray(storageState)
            ) ? /** @type {Record<string, unknown>} */ (storageState) : null;
            const rawOpenStorageDiagnostics = storageStateRecord !== null ? Reflect.get(storageStateRecord, 'openStorageDiagnostics') : null;
            const rawStartupDiagnosticsSnapshot = storageStateRecord !== null ? Reflect.get(storageStateRecord, 'startupDiagnosticsSnapshot') : null;
            /** @type {Record<string, unknown>|null} */
            let openStorageDiagnostics = null;
            if (
                typeof rawOpenStorageDiagnostics === 'object' &&
                rawOpenStorageDiagnostics !== null &&
                !Array.isArray(rawOpenStorageDiagnostics)
            ) {
                openStorageDiagnostics = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (rawOpenStorageDiagnostics));
            }
            /** @type {Record<string, unknown>|null} */
            let startupDiagnosticsSnapshot = null;
            if (
                typeof rawStartupDiagnosticsSnapshot === 'object' &&
                rawStartupDiagnosticsSnapshot !== null &&
                !Array.isArray(rawStartupDiagnosticsSnapshot)
            ) {
                startupDiagnosticsSnapshot = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (rawStartupDiagnosticsSnapshot));
            }
            dictionaryBackendUsable = true;
            backendMode = typeof openStorageDiagnostics?.mode === 'string' ? openStorageDiagnostics.mode : null;
            backendOpenFailureClass = typeof openStorageDiagnostics?.openFailureClass === 'string' ? openStorageDiagnostics.openFailureClass : null;
            backendStartupError = (
                typeof startupDiagnosticsSnapshot?.dictionaryPrepareError === 'string' &&
                startupDiagnosticsSnapshot.dictionaryPrepareError.length > 0
            ) ? startupDiagnosticsSnapshot.dictionaryPrepareError : null;
            this._dictionaryBackendRuntimeError = backendStartupError;
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            this._dictionaryBackendRuntimeError = normalizedError.message;
            backendStartupError = normalizedError.message;
        }
        this._storageRuntimeCheckNode.textContent = (
            `${browserLabel} check:\n` +
            `dictionary backend usable=${String(dictionaryBackendUsable)}\n` +
            `backend mode=${String(backendMode)}\n` +
            `backend startup error=${String(backendStartupError)}\n` +
            `backend open failure class=${String(backendOpenFailureClass)}\n` +
            `page storage.getDirectory=${String(hasStorageGetDirectory)}\n` +
            `page createSyncAccessHandle=${String(hasCreateSyncAccessHandle)}`
        );
    }

    // Private

    /**
     * @returns {Promise<?StorageEstimate>}
     */
    async _storageEstimate() {
        if (this._storageEstimateFailed && this._mostRecentStorageEstimate === null) {
            return null;
        }
        try {
            const value = await navigator.storage.estimate();
            this._mostRecentStorageEstimate = value;
            return value;
        } catch (e) {
            this._storageEstimateFailed = true;
        }
        return null;
    }

    /**
     * @param {number} size
     * @returns {string}
     */
    _bytesToLabeledString(size) {
        const base = 1000;
        const labels = [' bytes', 'KB', 'MB', 'GB', 'TB'];
        const maxLabelIndex = labels.length - 1;
        let labelIndex = 0;
        while (size >= base && labelIndex < maxLabelIndex) {
            size /= base;
            ++labelIndex;
        }
        const label = labelIndex === 0 ? `${size}` : size.toFixed(1);
        return `${label}${labels[labelIndex]}`;
    }

    /**
     * @param {?NodeListOf<HTMLElement>} elements
     * @param {boolean} visible
     */
    _setElementsVisible(elements, visible) {
        if (elements === null) { return; }
        visible = !visible;
        for (const element of elements) {
            element.hidden = visible;
        }
    }
}
