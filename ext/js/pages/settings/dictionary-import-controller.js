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

import {ExtensionError} from '../../core/extension-error.js';
import {reportDiagnostics} from '../../core/diagnostics-reporter.js';
import {parseJson, readResponseJson} from '../../core/json.js';
import {log} from '../../core/log.js';
import {safePerformance} from '../../core/safe-performance.js';
import {toError} from '../../core/to-error.js';
import {getKebabCase} from '../../data/anki-template-util.js';
import {DictionaryWorker} from '../../dictionary/dictionary-worker.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {DictionaryController} from './dictionary-controller.js';

const OPFS_REQUIRED_USER_MESSAGE = 'Manabitan requires OPFS storage support. Update to Chrome/Edge 120+ or Firefox 115+ and reload the extension.';
const RECOMMENDED_DICTIONARY_CATEGORIES = ['terms', 'kanji', 'frequency', 'grammar', 'pronunciation'];
const MDX_CONVERSION_PROGRESS_TOTAL = 1000;
const MDX_UPLOAD_PROGRESS_RATIO = 0.45;
const DUPLICATE_IMPORT_SKIP_ERROR_PATTERN = /^Dictionary .+ is already imported, skipped it\.$/;

/**
 * @typedef {object} ZipImportSource
 * @property {'zip'} type
 * @property {File} file
 */

/**
 * @typedef {object} MdxImportSource
 * @property {'mdx'} type
 * @property {File} mdxFile
 * @property {File[]} mddFiles
 */

/**
 * @typedef {ZipImportSource|MdxImportSource} DictionaryImportSource
 */

/**
 * @typedef {{source: DictionaryImportSource}} PendingImportSource
 */

/**
 * @param {string} fileName
 * @returns {string}
 */
function getLowercaseFileName(fileName) {
    return fileName.trim().toLowerCase();
}

/**
 * @param {string} fileName
 * @returns {boolean}
 */
function isZipDictionaryFileName(fileName) {
    return getLowercaseFileName(fileName).endsWith('.zip');
}

/**
 * @param {string} fileName
 * @returns {boolean}
 */
function isMdxDictionaryFileName(fileName) {
    return getLowercaseFileName(fileName).endsWith('.mdx');
}

/**
 * @param {string} fileName
 * @returns {boolean}
 */
function isMddDictionaryFileName(fileName) {
    return /(?:\.\d+)?\.mdd$/i.test(fileName.trim());
}

/**
 * @param {File} file
 * @returns {string}
 */
function getDictionaryFilePath(file) {
    const value = (typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0) ? file.webkitRelativePath : file.name;
    return value.replaceAll('\\', '/');
}

/**
 * @param {string} filePath
 * @returns {string|null}
 */
function getDictionaryImportSourceKeyFromPath(filePath) {
    const normalizedFilePath = getLowercaseFileName(filePath);
    if (isMdxDictionaryFileName(normalizedFilePath)) {
        return normalizedFilePath.slice(0, -4);
    }
    const match = /^(.*?)(?:\.\d+)?\.mdd$/i.exec(normalizedFilePath);
    return match ? match[1] : null;
}

/**
 * @param {string} url
 * @returns {string|null}
 */
function getDictionaryFileNameFromUrl(url) {
    try {
        const {pathname} = new URL(url);
        const segments = pathname.split('/').filter((value) => value.length > 0);
        const fileName = segments[segments.length - 1];
        if (typeof fileName !== 'string' || fileName.length === 0) { return null; }
        return decodeURIComponent(fileName);
    } catch (_error) {
        return null;
    }
}

/**
 * @param {number} valueMs
 * @returns {string}
 */
function formatDurationMs(valueMs) {
    return `${valueMs.toFixed(1)}ms`;
}

/**
 * @returns {{source: 'performance.memory'|'unavailable', usedJSHeapSize: number|null, totalJSHeapSize: number|null, jsHeapSizeLimit: number|null, usedHeapPercent: number|null}}
 */
function getImportMemorySnapshot() {
    const performanceValue = Reflect.get(globalThis, 'performance');
    if (!(typeof performanceValue === 'object' && performanceValue !== null)) {
        return {
            source: 'unavailable',
            usedJSHeapSize: null,
            totalJSHeapSize: null,
            jsHeapSizeLimit: null,
            usedHeapPercent: null,
        };
    }
    const memoryValue = Reflect.get(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (performanceValue)), 'memory');
    if (!(typeof memoryValue === 'object' && memoryValue !== null)) {
        return {
            source: 'unavailable',
            usedJSHeapSize: null,
            totalJSHeapSize: null,
            jsHeapSizeLimit: null,
            usedHeapPercent: null,
        };
    }
    const memoryRecord = /** @type {Record<string, unknown>} */ (memoryValue);
    const usedJSHeapSizeRaw = Reflect.get(memoryRecord, 'usedJSHeapSize');
    const totalJSHeapSizeRaw = Reflect.get(memoryRecord, 'totalJSHeapSize');
    const jsHeapSizeLimitRaw = Reflect.get(memoryRecord, 'jsHeapSizeLimit');
    const usedJSHeapSize = typeof usedJSHeapSizeRaw === 'number' && Number.isFinite(usedJSHeapSizeRaw) ? usedJSHeapSizeRaw : null;
    const totalJSHeapSize = typeof totalJSHeapSizeRaw === 'number' && Number.isFinite(totalJSHeapSizeRaw) ? totalJSHeapSizeRaw : null;
    const jsHeapSizeLimit = typeof jsHeapSizeLimitRaw === 'number' && Number.isFinite(jsHeapSizeLimitRaw) ? jsHeapSizeLimitRaw : null;
    let usedHeapPercent = null;
    if (
        usedJSHeapSize !== null &&
        totalJSHeapSize !== null &&
        totalJSHeapSize > 0
    ) {
        usedHeapPercent = (usedJSHeapSize / totalJSHeapSize) * 100;
    }
    return {
        source: 'performance.memory',
        usedJSHeapSize,
        totalJSHeapSize,
        jsHeapSizeLimit,
        usedHeapPercent,
    };
}

/**
 * @param {{source: 'performance.memory'|'unavailable', usedJSHeapSize: number|null}} start
 * @param {{source: 'performance.memory'|'unavailable', usedJSHeapSize: number|null}} end
 * @returns {number|null}
 */
function getHeapDeltaBytes(start, end) {
    if (start.source !== 'performance.memory' || end.source !== 'performance.memory') { return null; }
    if (typeof start.usedJSHeapSize !== 'number' || typeof end.usedJSHeapSize !== 'number') { return null; }
    return end.usedJSHeapSize - start.usedJSHeapSize;
}

/**
 * @param {unknown} value
 * @returns {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>}
 */
function normalizeImporterPhaseTimings(value) {
    if (!Array.isArray(value)) { return []; }
    /** @type {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} */
    const results = [];
    for (const item of value) {
        if (!(typeof item === 'object' && item !== null && !Array.isArray(item))) {
            continue;
        }
        const phaseRaw = /** @type {unknown} */ (Reflect.get(item, 'phase'));
        const elapsedMsRaw = /** @type {unknown} */ (Reflect.get(item, 'elapsedMs'));
        const detailsRaw = /** @type {unknown} */ (Reflect.get(item, 'details'));
        if (typeof phaseRaw !== 'string' || typeof elapsedMsRaw !== 'number' || !Number.isFinite(elapsedMsRaw)) {
            continue;
        }
        if (typeof detailsRaw === 'object' && detailsRaw !== null && !Array.isArray(detailsRaw)) {
            results.push({
                phase: phaseRaw,
                elapsedMs: Math.max(0, elapsedMsRaw),
                details: /** @type {Record<string, string|number|boolean|null>} */ (detailsRaw),
            });
            continue;
        }
        results.push({
            phase: phaseRaw,
            elapsedMs: Math.max(0, elapsedMsRaw),
        });
    }
    return results;
}

/**
 * @param {string} url
 * @returns {string}
 */
function summarizeUrlForDiagnostics(url) {
    const trimmed = url.trim();
    if (trimmed.startsWith('manabitan-e2e-dict:')) { return trimmed; }
    try {
        const parsed = new URL(trimmed);
        return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
        return trimmed;
    }
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isOpfsUnavailableMessage(message) {
    return (
        message.includes('OPFS is required') ||
        message.includes('OPFS unlink API is unavailable') ||
        message.includes('OPFS importDb API is unavailable') ||
        message.includes('no such vfs: opfs')
    );
}

/**
 * @param {string} message
 * @returns {'unsupported-opfs'|'lock-contention'|'corruption'|'transient-open-race'|'unknown'}
 */
function classifyImportOpenFailure(message) {
    const text = message.toLowerCase();
    if (
        text.includes('no such vfs') ||
        text.includes('opfs is required') ||
        text.includes('missing sharedarraybuffer')
    ) {
        return 'unsupported-opfs';
    }
    if (
        text.includes('sqlite_busy') ||
        text.includes('database is locked') ||
        text.includes('database table is locked') ||
        text.includes('locked')
    ) {
        return 'lock-contention';
    }
    if (
        text.includes('sqlite_corrupt') ||
        text.includes('database disk image is malformed') ||
        text.includes('file is not a database')
    ) {
        return 'corruption';
    }
    if (
        text.includes('sqlite_cantopen') ||
        text.includes('unable to open database file')
    ) {
        return 'transient-open-race';
    }
    return 'unknown';
}

/**
 * @param {number} attempt
 * @returns {number}
 */
function getImportRetryDelayMs(attempt) {
    const base = Math.min(1200, 100 * (2 ** (attempt - 1)));
    const jitter = Math.floor(Math.random() * 50);
    return base + jitter;
}

/**
 * @returns {{name: string, version: string, id: string}|null}
 */
function getExtensionBuildStamp() {
    try {
        const manifest = chrome.runtime.getManifest();
        const id = typeof chrome.runtime.id === 'string' ? chrome.runtime.id : '';
        return {
            name: typeof manifest.name === 'string' ? manifest.name : '',
            version: typeof manifest.version === 'string' ? manifest.version : '',
            id,
        };
    } catch (_) {
        return null;
    }
}

export class DictionaryImportController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('./modal-controller.js').ModalController} modalController
     * @param {import('./status-footer.js').StatusFooter} statusFooter
     */
    constructor(settingsController, modalController, statusFooter) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {import('./status-footer.js').StatusFooter} */
        this._statusFooter = statusFooter;
        /** @type {boolean} */
        this._modifying = false;
        /** @type {HTMLButtonElement} */
        this._purgeButton = querySelectorNotNull(document, '#dictionary-delete-all-button');
        /** @type {HTMLButtonElement} */
        this._purgeConfirmButton = querySelectorNotNull(document, '#dictionary-confirm-delete-all-button');
        /** @type {HTMLButtonElement} */
        this._importFileInput = querySelectorNotNull(document, '#dictionary-import-file-input');
        /** @type {HTMLButtonElement} */
        this._importFileDrop = querySelectorNotNull(document, '#dictionary-drop-file-zone');
        /** @type {number} */
        this._importFileDropItemCount = 0;
        /** @type {HTMLInputElement} */
        this._importButton = querySelectorNotNull(document, '#dictionary-import-button');
        /** @type {HTMLInputElement} */
        this._importConfirmButton = querySelectorNotNull(document, '#dictionary-import-confirm-button');
        /** @type {HTMLInputElement} */
        this._importURLButton = querySelectorNotNull(document, '#dictionary-import-url-button');
        /** @type {HTMLInputElement} */
        this._importURLText = querySelectorNotNull(document, '#dictionary-import-url-text');
        /** @type {HTMLElement} */
        this._importSourceList = querySelectorNotNull(document, '#dictionary-import-source-list');
        /** @type {HTMLElement} */
        this._importSourceEmpty = querySelectorNotNull(document, '#dictionary-import-source-empty');
        /** @type {?import('./modal.js').Modal} */
        this._importModal = null;
        /** @type {?import('./modal.js').Modal} */
        this._purgeConfirmModal = null;
        /** @type {?import('./modal.js').Modal} */
        this._recommendedDictionariesModal = null;
        /** @type {HTMLElement} */
        this._errorContainer = querySelectorNotNull(document, '#dictionary-error');
        /** @type {HTMLElement|null} */
        this._recommendedDiagnosticsContainer = document.querySelector('#recommended-dictionaries-diagnostics');
        /** @type {HTMLElement|null} */
        this._recommendedErrorContainer = document.querySelector('#recommended-dictionaries-error');
        /** @type {HTMLElement|null} */
        this._welcomeLanguageAutoImportStatusContainer = document.querySelector('#welcome-language-auto-import-status');
        /** @type {HTMLSelectElement|null} */
        this._languageSelect = document.querySelector('#language-select');
        /** @type {boolean} */
        this._welcomeLanguageAutoImportEnabled = this._isWelcomePage();
        /** @type {boolean} */
        this._showRecommendedDiagnosticsInUi = (Reflect.get(globalThis, 'manabitanShowRecommendedDiagnosticsInUi') === true);
        /** @type {[originalMessage: string, newMessage: string][]} */
        this._errorToStringOverrides = [
            [
                'A mutation operation was attempted on a database that did not allow mutations.',
                'Access to IndexedDB appears to be restricted. Firefox seems to require that the history preference is set to "Remember history" before IndexedDB use of any kind is allowed.',
            ],
            [
                'The operation failed for reasons unrelated to the database itself and not covered by any other error code.',
                'Unable to access IndexedDB due to a possibly corrupt user profile. Try using the "Refresh Firefox" feature to reset your user profile.',
            ],
            [
                'OPFS is required',
                OPFS_REQUIRED_USER_MESSAGE,
            ],
            [
                'no such vfs: opfs',
                OPFS_REQUIRED_USER_MESSAGE,
            ],
        ];
        /** @type {string[]} */
        this._recommendedDictionaryQueue = [];
        /** @type {boolean} */
        this._recommendedDictionaryActiveImport = false;
        /** @type {DictionaryWorker|null} */
        this._sessionDictionaryWorker = null;
        /** @type {boolean} */
        this._recommendedDictionariesRenderPending = false;
        /** @type {boolean} */
        this._recommendedDictionariesPrimed = false;
        /** @type {DictionaryImportSource[]} */
        this._pendingImportSources = [];
        /** @type {(event: MouseEvent) => void} */
        this._onDocumentClickCaptureBind = this._onDocumentClickCapture.bind(this);
        /** @type {(event: Event) => void} */
        this._onModalVisibilityChangedEventBind = this._onModalVisibilityChangedEvent.bind(this);
        /** @type {(details: {visible: boolean}) => void} */
        this._onImportModalVisibilityChangedBind = this._onImportModalVisibilityChanged.bind(this);
        /** @type {(details: {visible: boolean}) => void} */
        this._onRecommendedDictionariesModalVisibilityChangedBind = this._onRecommendedDictionariesModalVisibilityChanged.bind(this);
        /** @type {(event: Event) => void} */
        this._onWelcomeLanguageSelectChangedBind = this._onWelcomeLanguageSelectChanged.bind(this);
        reportDiagnostics('dictionary-import-controller-constructed', {
            href: globalThis.location?.href ?? null,
        });
    }

    /** */
    prepare() {
        reportDiagnostics('dictionary-import-controller-prepare-begin', {
            href: globalThis.location?.href ?? null,
        });
        this._importModal = this._modalController.getModal('dictionary-import');
        this._purgeConfirmModal = this._modalController.getModal('dictionary-confirm-delete-all');
        this._recommendedDictionariesModal = this._modalController.getModal('recommended-dictionaries');

        this._purgeButton.addEventListener('click', this._onPurgeButtonClick.bind(this), false);
        this._purgeConfirmButton.addEventListener('click', this._onPurgeConfirmButtonClick.bind(this), false);
        this._importButton.addEventListener('click', this._onImportButtonClick.bind(this), false);
        this._importConfirmButton.addEventListener('click', this._onImportConfirm.bind(this), false);
        this._importURLButton.addEventListener('click', this._onImportFromURL.bind(this), false);
        this._importFileInput.addEventListener('change', this._onImportFileChange.bind(this), false);

        this._importFileDrop.addEventListener('click', this._onImportFileButtonClick.bind(this), false);
        this._importFileDrop.addEventListener('dragenter', this._onFileDropEnter.bind(this), false);
        this._importFileDrop.addEventListener('dragover', this._onFileDropOver.bind(this), false);
        this._importFileDrop.addEventListener('dragleave', this._onFileDropLeave.bind(this), false);
        this._importFileDrop.addEventListener('drop', this._onFileDrop.bind(this), false);

        this._settingsController.on('importDictionaryFromUrl', this._onEventImportDictionaryFromUrl.bind(this));

        document.addEventListener('click', this._onDocumentClickCaptureBind, true);
        globalThis.addEventListener('manabitan:modal-visibility-changed', this._onModalVisibilityChangedEventBind, false);
        this._importModal?.on('visibilityChanged', this._onImportModalVisibilityChangedBind);
        this._recommendedDictionariesModal?.on('visibilityChanged', this._onRecommendedDictionariesModalVisibilityChangedBind);
        if (this._welcomeLanguageAutoImportEnabled && this._languageSelect instanceof HTMLSelectElement) {
            this._languageSelect.addEventListener('change', this._onWelcomeLanguageSelectChangedBind, false);
        }
        globalThis.addEventListener('beforeunload', this._onBeforeUnload.bind(this), {once: true});
        this._renderPendingImportSources();
        reportDiagnostics('dictionary-import-controller-prepare-complete', {
            hasRecommendedModal: this._recommendedDictionariesModal !== null,
            href: globalThis.location?.href ?? null,
        });
    }

    // Private

    /**
     * @param {boolean} useImportSession
     * @returns {DictionaryWorker}
     */
    _getDictionaryWorker(useImportSession) {
        if (!useImportSession) {
            return new DictionaryWorker({reuseWorker: false});
        }
        if (this._sessionDictionaryWorker === null) {
            this._sessionDictionaryWorker = new DictionaryWorker({reuseWorker: true});
        }
        return this._sessionDictionaryWorker;
    }

    /**
     * @param {DictionaryWorker} dictionaryWorker
     * @param {boolean} useImportSession
     */
    _releaseDictionaryWorker(dictionaryWorker, useImportSession) {
        if (useImportSession) {
            if (this._sessionDictionaryWorker === dictionaryWorker) {
                this._sessionDictionaryWorker.destroy();
                this._sessionDictionaryWorker = null;
            }
            return;
        }
        dictionaryWorker.destroy();
    }

    /** */
    _onBeforeUnload() {
        document.removeEventListener('click', this._onDocumentClickCaptureBind, true);
        globalThis.removeEventListener('manabitan:modal-visibility-changed', this._onModalVisibilityChangedEventBind, false);
        this._importModal?.off('visibilityChanged', this._onImportModalVisibilityChangedBind);
        this._recommendedDictionariesModal?.off('visibilityChanged', this._onRecommendedDictionariesModalVisibilityChangedBind);
        if (this._welcomeLanguageAutoImportEnabled && this._languageSelect instanceof HTMLSelectElement) {
            this._languageSelect.removeEventListener('change', this._onWelcomeLanguageSelectChangedBind, false);
        }
        if (this._sessionDictionaryWorker !== null) {
            this._sessionDictionaryWorker.destroy();
            this._sessionDictionaryWorker = null;
        }
    }

    /**
     * @returns {boolean}
     */
    _isWelcomePage() {
        const pathname = String(globalThis.location?.pathname ?? '');
        return pathname.endsWith('/welcome.html');
    }

    /**
     * @param {{visible: boolean}} details
     */
    _onRecommendedDictionariesModalVisibilityChanged({visible}) {
        if (!visible || this._recommendedDictionariesRenderPending) { return; }
        this._recommendedDictionariesRenderPending = true;
        void this._onRecommendedDictionariesOpen();
    }

    /**
     * @param {{visible: boolean}} details
     */
    _onImportModalVisibilityChanged({visible}) {
        if (visible) { return; }
        this._importURLText.value = '';
        this._clearPendingImportSources();
    }

    /**
     * @param {MouseEvent} e
     */
    _onDocumentClickCapture(e) {
        const target = e.target;
        if (!(target instanceof Element)) { return; }
        const actionNode = target.closest('[data-modal-action="show,recommended-dictionaries"]');
        if (!(actionNode instanceof HTMLElement)) { return; }
        reportDiagnostics('recommended-dictionaries-click-capture', {
            pending: this._recommendedDictionariesRenderPending,
            href: globalThis.location?.href ?? null,
        });
        if (this._recommendedDictionariesRenderPending) { return; }
        this._recommendedDictionariesRenderPending = true;
        void this._onRecommendedDictionariesOpen();
    }

    /**
     * @param {Event} event
     */
    _onModalVisibilityChangedEvent(event) {
        if (!(event instanceof CustomEvent)) { return; }
        const detail = /** @type {unknown} */ (event.detail);
        if (!(typeof detail === 'object' && detail !== null)) { return; }
        if (Reflect.get(detail, 'modalId') !== 'recommended-dictionaries') { return; }
        if (Reflect.get(detail, 'visible') !== true) { return; }
        reportDiagnostics('recommended-dictionaries-modal-visibility-listener', {
            pending: this._recommendedDictionariesRenderPending,
            source: Reflect.get(detail, 'source'),
            animate: Reflect.get(detail, 'animate'),
            href: globalThis.location?.href ?? null,
        });
        if (this._recommendedDictionariesRenderPending) { return; }
        reportDiagnostics('recommended-dictionaries-modal-visible-event', {
            source: Reflect.get(detail, 'source'),
            animate: Reflect.get(detail, 'animate'),
        });
        this._recommendedDictionariesRenderPending = true;
        void this._onRecommendedDictionariesOpen();
    }

    /**
     * @param {Event} event
     */
    async _onWelcomeLanguageSelectChanged(event) {
        if (!this._welcomeLanguageAutoImportEnabled) { return; }
        const target = event.currentTarget;
        if (!(target instanceof HTMLSelectElement)) { return; }
        const requestedLanguage = target.value.trim();
        if (requestedLanguage.length === 0) { return; }

        this._setWelcomeLanguageAutoImportStatus('', false);
        if (this._modifying) {
            reportDiagnostics('recommended-dictionaries-welcome-auto-import-skipped-busy', {
                requestedLanguage,
            });
            return;
        }

        const {recommendedDictionaries} = await this._loadRecommendedDictionaries();
        /** @type {import('dictionary-importer').Summary[]} */
        let installedDictionaries = [];
        try {
            installedDictionaries = await this._settingsController.getDictionaryInfo();
        } catch (error) {
            const e = toError(error);
            if (isOpfsUnavailableMessage(e.message)) {
                const opfsError = new Error(OPFS_REQUIRED_USER_MESSAGE);
                this._showErrors([opfsError]);
                this._setWelcomeLanguageAutoImportStatus(OPFS_REQUIRED_USER_MESSAGE, true);
                reportDiagnostics('recommended-dictionaries-welcome-auto-import-skipped-error', {
                    requestedLanguage,
                    message: e.message,
                });
                return;
            }
            log.warn(`[recommended-dictionaries] getDictionaryInfo failed before welcome auto import; continuing with empty installed set. ${e.message}`);
            reportDiagnostics('recommended-dictionaries-welcome-auto-import-installed-query-failed', {
                requestedLanguage,
                message: e.message,
            });
        }

        const decision = this._getWelcomeAutoImportDecision(requestedLanguage, recommendedDictionaries, installedDictionaries);
        switch (decision.status) {
            case 'no-match':
                this._setWelcomeLanguageAutoImportStatus(`No recommended dictionaries are currently available for "${requestedLanguage}".`, false);
                reportDiagnostics('recommended-dictionaries-welcome-auto-import-skip-no-match', {
                    requestedLanguage,
                });
                return;
            case 'already-installed':
                this._setWelcomeLanguageAutoImportStatus(`All recommended dictionaries for "${requestedLanguage}" are already installed.`, false);
                reportDiagnostics('recommended-dictionaries-welcome-auto-import-skip-already-installed', {
                    requestedLanguage,
                    resolvedLanguage: decision.resolvedLanguage,
                });
                return;
            case 'ready':
                this._setWelcomeLanguageAutoImportStatus(`Downloading ${String(decision.urls.length)} recommended dictionaries for "${requestedLanguage}"...`, false);
                reportDiagnostics('recommended-dictionaries-welcome-auto-import-start', {
                    requestedLanguage,
                    resolvedLanguage: decision.resolvedLanguage,
                });
                reportDiagnostics('recommended-dictionaries-welcome-auto-import-queued', {
                    requestedLanguage,
                    resolvedLanguage: decision.resolvedLanguage,
                    queuedUrlCount: decision.urls.length,
                });
                await this.importFilesFromURLs(decision.urls.join('\n'), null, null);
                return;
        }
    }

    /**
     * @param {string} source
     */
    _primeRecommendedDictionaries(source) {
        if (this._recommendedDictionariesPrimed || this._recommendedDictionariesRenderPending) { return; }
        this._recommendedDictionariesRenderPending = true;
        const startedAt = safePerformance.now();
        reportDiagnostics('recommended-dictionaries-prime-begin', {
            source,
            href: globalThis.location?.href ?? null,
        });
        void (async () => {
            try {
                await this._renderRecommendedDictionaries();
                this._recommendedDictionariesPrimed = true;
                reportDiagnostics('recommended-dictionaries-prime-complete', {
                    source,
                    elapsedMs: Math.max(0, safePerformance.now() - startedAt),
                });
            } catch (error) {
                const e = toError(error);
                reportDiagnostics('recommended-dictionaries-prime-failed', {
                    source,
                    message: e.message,
                });
                log.error(e);
            } finally {
                this._recommendedDictionariesRenderPending = false;
            }
        })();
    }

    /**
     * @param {MouseEvent} e
     */
    async _onRecommendedImportClick(e) {
        if (!e.target || !(e.target instanceof HTMLButtonElement)) {
            reportDiagnostics('recommended-dictionaries-import-click-ignored', {
                reason: 'target-not-button',
                targetType: typeof e.target,
            });
            return;
        }

        const import_url = e.target.attributes.getNamedItem('data-import-url');
        if (!import_url) {
            reportDiagnostics('recommended-dictionaries-import-click-ignored', {
                reason: 'missing-data-import-url',
                buttonText: e.target.textContent ?? '',
            });
            return;
        }
        const importUrl = import_url.value;
        this._recommendedDictionaryQueue.push(importUrl);

        e.target.disabled = true;
        reportDiagnostics('recommended-dictionaries-import-clicked', {
            importUrl: summarizeUrlForDiagnostics(importUrl),
            queueLength: this._recommendedDictionaryQueue.length,
        });

        if (this._recommendedDictionaryActiveImport) { return; }

        this._recommendedDictionaryActiveImport = true;
        try {
            while (this._recommendedDictionaryQueue.length > 0) {
                const url = this._recommendedDictionaryQueue[0];
                if (!url) {
                    void this._recommendedDictionaryQueue.shift();
                    continue;
                }
                reportDiagnostics('recommended-dictionaries-import-queue-item-start', {
                    importUrl: summarizeUrlForDiagnostics(url),
                    queueLength: this._recommendedDictionaryQueue.length,
                });

                try {
                    const importProgressTracker = new ImportProgressTracker(this._getUrlImportSteps(), 1);
                    const onProgress = importProgressTracker.onProgress.bind(importProgressTracker);
                    await this._importDictionaries(
                        this._generateFilesFromUrls([url], onProgress),
                        null,
                        null,
                        importProgressTracker,
                    );
                } catch (error) {
                    const e2 = toError(error);
                    log.error(e2);
                    this._showErrors([e2]);
                    reportDiagnostics('recommended-dictionaries-import-failed', {
                        importUrl: summarizeUrlForDiagnostics(url),
                        message: e2.message,
                    });
                    this._setRecommendedImportButtonDisabled(url, false);
                } finally {
                    void this._recommendedDictionaryQueue.shift();
                    reportDiagnostics('recommended-dictionaries-import-queue-item-finished', {
                        importUrl: summarizeUrlForDiagnostics(url),
                        queueLength: this._recommendedDictionaryQueue.length,
                    });
                }
            }
        } finally {
            this._recommendedDictionaryActiveImport = false;
            reportDiagnostics('recommended-dictionaries-import-queue-idle', {
                queueLength: this._recommendedDictionaryQueue.length,
            });
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _onRecommendedDictionariesOpen() {
        const startedAt = safePerformance.now();
        log.log('[recommended-dictionaries] open requested');
        const buildStamp = getExtensionBuildStamp();
        let buildStampText = 'build=unknown';
        if (buildStamp !== null) {
            buildStampText = `build=${buildStamp.name} v${buildStamp.version} id=${buildStamp.id}`;
        }
        this._clearRecommendedError();
        this._setRecommendedDiagnostics(`${buildStampText}\nLoading recommended dictionaries...`);
        reportDiagnostics('recommended-dictionaries-open-requested', {
            buildStamp,
        });
        try {
            await this._renderRecommendedDictionaries();
            const endedAt = safePerformance.now();
            log.log(`[recommended-dictionaries] render completed in ${formatDurationMs(endedAt - startedAt)}`);
        } catch (error) {
            const e = toError(error);
            log.error(e);
            const userError = this._errorToString(e);
            this._setRecommendedError(userError);
            this._setRecommendedDiagnostics(`FAILED to render recommended dictionaries:\n${e.message}`);
            reportDiagnostics('recommended-dictionaries-open-failed', {
                message: e.message,
            });
            if (!isOpfsUnavailableMessage(e.message)) {
                this._showErrors([e]);
            }
        } finally {
            this._recommendedDictionariesRenderPending = false;
        }
    }

    /** */
    async _renderRecommendedDictionaries() {
        /** @type {string[]} */
        const diagnostics = [];
        const {recommendedDictionaries, source, url} = await this._loadRecommendedDictionaries();
        diagnostics.push(`source=${url}`, `feed=${source}`);

        /** @type {import('dictionary-recommended.js').RecommendedDictionaryElementMap[]} */
        const recommendedDictionaryCategories = [
            {property: 'terms', element: querySelectorNotNull(querySelectorNotNull(document, '#recommended-term-dictionaries'), '.recommended-dictionary-list')},
            {property: 'kanji', element: querySelectorNotNull(querySelectorNotNull(document, '#recommended-kanji-dictionaries'), '.recommended-dictionary-list')},
            {property: 'frequency', element: querySelectorNotNull(querySelectorNotNull(document, '#recommended-frequency-dictionaries'), '.recommended-dictionary-list')},
            {property: 'grammar', element: querySelectorNotNull(querySelectorNotNull(document, '#recommended-grammar-dictionaries'), '.recommended-dictionary-list')},
            {property: 'pronunciation', element: querySelectorNotNull(querySelectorNotNull(document, '#recommended-pronunciation-dictionaries'), '.recommended-dictionary-list')},
        ];

        const language = String((await this._settingsController.getOptions()).general.language || '').trim();
        const resolvedLanguage = this._resolveRecommendedLanguage(language, recommendedDictionaries, true);

        if (typeof resolvedLanguage !== 'string') {
            diagnostics.push(`requestedLanguage="${language}" resolvedLanguage=none`);
            this._setRecommendedDiagnostics(diagnostics.join('\n'));
            for (const {element} of recommendedDictionaryCategories) {
                const dictionaryCategoryParent = element.parentElement;
                if (dictionaryCategoryParent) {
                    dictionaryCategoryParent.hidden = true;
                }
            }
            return;
        }

        /** @type {import('dictionary-importer').Summary[]} */
        let installedDictionaries = [];
        try {
            installedDictionaries = await this._settingsController.getDictionaryInfo();
            diagnostics.push(`installedQuery=ok count=${String(installedDictionaries.length)}`);
        } catch (error) {
            const e = toError(error);
            if (isOpfsUnavailableMessage(e.message)) {
                throw new Error(OPFS_REQUIRED_USER_MESSAGE);
            }
            log.warn(`[recommended-dictionaries] getDictionaryInfo failed; continuing with empty installed set. ${e.message}`);
            diagnostics.push(`installedQuery=failed:${e.message}`);
        }
        const {installedDictionaryNames, installedDictionaryDownloadUrls} = this._getInstalledDictionaryLookupSets(installedDictionaries);

        /** @type {number} */
        let renderedRecommendationCount = 0;
        for (const {property, element} of recommendedDictionaryCategories) {
            const languageConfig = /** @type {Record<string, unknown>} */ (recommendedDictionaries[resolvedLanguage]);
            const values = Reflect.get(languageConfig, property);
            const dictionariesForCategory = /** @type {import('dictionary-recommended.js').RecommendedDictionary[]} */ (Array.isArray(values) ? values : []);
            renderedRecommendationCount += dictionariesForCategory.length;
            this._renderRecommendedDictionaryGroup(dictionariesForCategory, element, installedDictionaryNames, installedDictionaryDownloadUrls);
        }
        diagnostics.push(`renderedFrom=${resolvedLanguage}`);
        log.log(`[recommended-dictionaries] resolvedLanguage="${resolvedLanguage}" renderedCount=${String(renderedRecommendationCount)}`);
        diagnostics.push(
            `requestedLanguage="${language}" resolvedLanguage="${resolvedLanguage}"`,
            `renderedRecommendationCount=${String(renderedRecommendationCount)}`,
        );
        this._setRecommendedDiagnostics(diagnostics.join('\n'));
        reportDiagnostics('recommended-dictionaries-render', {
            requestedLanguage: language,
            resolvedLanguage,
            renderedRecommendationCount,
            diagnostics,
        });

        /** @type {NodeListOf<HTMLElement>} */
        const buttons = document.querySelectorAll('.action-button[data-action=import-recommended-dictionary]');
        for (const button of buttons) {
            button.addEventListener('click', this._onRecommendedImportClick.bind(this), false);
        }
    }

    /**
     * @param {string} text
     */
    _setRecommendedDiagnostics(text) {
        const container = this._recommendedDiagnosticsContainer;
        if (!(container instanceof HTMLElement)) { return; }
        if (!this._showRecommendedDiagnosticsInUi) {
            container.textContent = '';
            container.hidden = true;
            return;
        }
        container.textContent = text;
        container.hidden = false;
    }

    /**
     * @param {string} text
     */
    _setRecommendedError(text) {
        const container = this._recommendedErrorContainer;
        if (!(container instanceof HTMLElement)) { return; }
        container.textContent = text;
        container.hidden = false;
    }

    /** */
    _clearRecommendedError() {
        const container = this._recommendedErrorContainer;
        if (!(container instanceof HTMLElement)) { return; }
        container.textContent = '';
        container.hidden = true;
    }

    /**
     * @param {string} text
     * @param {boolean} isError
     */
    _setWelcomeLanguageAutoImportStatus(text, isError) {
        const container = this._welcomeLanguageAutoImportStatusContainer;
        if (!(container instanceof HTMLElement)) { return; }
        const message = text.trim();
        container.hidden = message.length === 0;
        container.textContent = message;
        container.classList.toggle('danger-text', isError);
    }

    /**
     * @returns {Promise<{recommendedDictionaries: import('dictionary-recommended.js').RecommendedDictionaries, source: 'extension-data'|'fallback', url: string}>}
     */
    async _loadRecommendedDictionaries() {
        const url = '../../data/recommended-dictionaries.json';
        try {
            const response = await fetch(url, {
                method: 'GET',
                mode: 'no-cors',
                cache: 'default',
                credentials: 'omit',
                redirect: 'follow',
                referrerPolicy: 'no-referrer',
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch ${url}: ${response.status}`);
            }
            const recommendedDictionaries = await readResponseJson(response);
            if (recommendedDictionaries && typeof recommendedDictionaries === 'object' && !Array.isArray(recommendedDictionaries)) {
                return {
                    recommendedDictionaries: /** @type {import('dictionary-recommended.js').RecommendedDictionaries} */ (recommendedDictionaries),
                    source: 'extension-data',
                    url,
                };
            }
            throw new Error('Invalid recommended dictionary feed format');
        } catch (error) {
            log.warn(`Using fallback recommended dictionaries due to fetch/parse error: ${toError(error).message}`);
            return {
                recommendedDictionaries: this._getFallbackRecommendedDictionaries(),
                source: 'fallback',
                url,
            };
        }
    }

    /**
     * @param {string} requestedLanguage
     * @param {import('dictionary-recommended.js').RecommendedDictionaries} recommendedDictionaries
     * @param {boolean} allowJapaneseFallback
     * @returns {string|null}
     */
    _resolveRecommendedLanguage(requestedLanguage, recommendedDictionaries, allowJapaneseFallback) {
        const languageCandidates = [];
        const language = requestedLanguage.trim();
        if (language.length > 0) {
            languageCandidates.push(language);
            const baseLanguage = language.split('-')[0];
            if (baseLanguage.length > 0 && baseLanguage !== language) {
                languageCandidates.push(baseLanguage);
            }
        }
        if (allowJapaneseFallback && !languageCandidates.includes('ja')) {
            languageCandidates.push('ja');
        }

        let resolvedLanguage = languageCandidates.find((candidate) => candidate in recommendedDictionaries);
        if (
            allowJapaneseFallback &&
            typeof resolvedLanguage === 'string' &&
            resolvedLanguage !== 'ja' &&
            this._getRecommendedDictionaryEntriesForLanguage(recommendedDictionaries, resolvedLanguage).length === 0 &&
            ('ja' in recommendedDictionaries)
        ) {
            resolvedLanguage = 'ja';
        }
        return typeof resolvedLanguage === 'string' ? resolvedLanguage : null;
    }

    /**
     * @param {import('dictionary-recommended.js').RecommendedDictionaries} recommendedDictionaries
     * @param {string} resolvedLanguage
     * @returns {import('dictionary-recommended.js').RecommendedDictionary[]}
     */
    _getRecommendedDictionaryEntriesForLanguage(recommendedDictionaries, resolvedLanguage) {
        const languageConfig = /** @type {Record<string, unknown>} */ (recommendedDictionaries[resolvedLanguage]);
        if (!(typeof languageConfig === 'object' && languageConfig !== null && !Array.isArray(languageConfig))) {
            return [];
        }
        /** @type {import('dictionary-recommended.js').RecommendedDictionary[]} */
        const results = [];
        for (const category of RECOMMENDED_DICTIONARY_CATEGORIES) {
            const valuesRaw = /** @type {unknown} */ (Reflect.get(languageConfig, category));
            if (!Array.isArray(valuesRaw)) { continue; }
            const values = /** @type {unknown[]} */ (valuesRaw);
            for (const value of values) {
                if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) { continue; }
                const dictionary = /** @type {Record<string, unknown>} */ (value);
                const name = Reflect.get(dictionary, 'name');
                const downloadUrl = Reflect.get(dictionary, 'downloadUrl');
                const description = Reflect.get(dictionary, 'description');
                const homepage = Reflect.get(dictionary, 'homepage');
                if (!(typeof name === 'string' && typeof downloadUrl === 'string' && typeof description === 'string')) {
                    continue;
                }
                results.push({
                    name,
                    downloadUrl,
                    description,
                    ...(typeof homepage === 'string' ? {homepage} : {}),
                });
            }
        }
        return results;
    }

    /**
     * @param {import('dictionary-importer').Summary[]} installedDictionaries
     * @returns {{installedDictionaryNames: Set<string>, installedDictionaryDownloadUrls: Set<string>}}
     */
    _getInstalledDictionaryLookupSets(installedDictionaries) {
        /** @type {Set<string>} */
        const installedDictionaryNames = new Set();
        /** @type {Set<string>} */
        const installedDictionaryDownloadUrls = new Set();
        for (const dictionary of installedDictionaries) {
            if (!(typeof dictionary === 'object' && dictionary !== null && !Array.isArray(dictionary))) {
                continue;
            }
            const titleValue = /** @type {unknown} */ (Reflect.get(dictionary, 'title'));
            const downloadUrlValue = /** @type {unknown} */ (Reflect.get(dictionary, 'downloadUrl'));
            const title = typeof titleValue === 'string' ? titleValue : '';
            const downloadUrl = typeof downloadUrlValue === 'string' ? downloadUrlValue : '';
            if (title.length > 0) {
                installedDictionaryNames.add(title);
            }
            if (downloadUrl.length > 0) {
                installedDictionaryDownloadUrls.add(downloadUrl);
            }
        }
        return {installedDictionaryNames, installedDictionaryDownloadUrls};
    }

    /**
     * @param {string} requestedLanguage
     * @param {import('dictionary-recommended.js').RecommendedDictionaries} recommendedDictionaries
     * @param {import('dictionary-importer').Summary[]} installedDictionaries
     * @returns {{status: 'ready', resolvedLanguage: string, urls: string[]}|{status: 'no-match', resolvedLanguage: null, urls: []}|{status: 'already-installed', resolvedLanguage: string, urls: []}}
     */
    _getWelcomeAutoImportDecision(requestedLanguage, recommendedDictionaries, installedDictionaries) {
        const resolvedLanguage = this._resolveRecommendedLanguage(requestedLanguage, recommendedDictionaries, false);
        if (resolvedLanguage === null) {
            return {status: 'no-match', resolvedLanguage: null, urls: []};
        }

        const recommendations = this._getRecommendedDictionaryEntriesForLanguage(recommendedDictionaries, resolvedLanguage);
        if (recommendations.length === 0) {
            return {status: 'no-match', resolvedLanguage: null, urls: []};
        }

        const {installedDictionaryNames, installedDictionaryDownloadUrls} = this._getInstalledDictionaryLookupSets(installedDictionaries);
        /** @type {Set<string>} */
        const seenDownloadUrls = new Set();
        /** @type {string[]} */
        const urls = [];
        for (const recommendation of recommendations) {
            const downloadUrl = typeof recommendation.downloadUrl === 'string' ? recommendation.downloadUrl.trim() : '';
            if (downloadUrl.length === 0 || seenDownloadUrls.has(downloadUrl)) { continue; }
            seenDownloadUrls.add(downloadUrl);

            const dictionaryName = typeof recommendation.name === 'string' ? recommendation.name : '';
            if (installedDictionaryNames.has(dictionaryName) || installedDictionaryDownloadUrls.has(downloadUrl)) {
                continue;
            }
            urls.push(downloadUrl);
        }

        if (urls.length === 0) {
            return {status: 'already-installed', resolvedLanguage, urls: []};
        }
        return {status: 'ready', resolvedLanguage, urls};
    }

    /**
     * @returns {import('dictionary-recommended.js').RecommendedDictionaries}
     */
    _getFallbackRecommendedDictionaries() {
        return {
            ja: {
                terms: [
                    {
                        name: 'Jitendex',
                        description: 'Japanese-to-English dictionary with example sentences and usage notes.',
                        homepage: 'https://jitendex.org',
                        downloadUrl: 'https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip',
                    },
                    {
                        name: 'JMdict',
                        description: 'Large Japanese multilingual dictionary from the Electronic Dictionary Research and Development Group.',
                        homepage: 'https://www.edrdg.org/jmdict/j_jmdict.html',
                        downloadUrl: 'https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english.zip',
                    },
                ],
                kanji: [],
                frequency: [],
                grammar: [],
                pronunciation: [],
            },
        };
    }

    /**
     *
     * @param {import('dictionary-recommended.js').RecommendedDictionary[]} recommendedDictionaries
     * @param {HTMLElement} dictionariesList
     * @param {Set<string>} installedDictionaryNames
     * @param {Set<string>} installedDictionaryDownloadUrls
     */
    _renderRecommendedDictionaryGroup(recommendedDictionaries, dictionariesList, installedDictionaryNames, installedDictionaryDownloadUrls) {
        const dictionariesListParent = dictionariesList.parentElement;
        dictionariesList.innerHTML = '';
        // Hide section if no dictionaries are available
        if (dictionariesListParent) {
            dictionariesListParent.hidden = recommendedDictionaries.length === 0;
        }
        for (const dictionary of recommendedDictionaries) {
            if (dictionariesList) {
                if (dictionariesListParent) {
                    dictionariesListParent.hidden = false;
                }
                const template = this._settingsController.instantiateTemplate('recommended-dictionaries-list-item');
                const label = querySelectorNotNull(template, '.settings-item-label');
                const description = querySelectorNotNull(template, '.description');
                /** @type {HTMLAnchorElement} */
                const homepage = querySelectorNotNull(template, '.homepage');
                /** @type {HTMLButtonElement} */
                const button = querySelectorNotNull(template, '.action-button[data-action=import-recommended-dictionary]');
                button.disabled = (
                    installedDictionaryNames.has(dictionary.name) ||
                    installedDictionaryDownloadUrls.has(dictionary.downloadUrl) ||
                    this._recommendedDictionaryQueue.includes(dictionary.downloadUrl)
                );

                const urlAttribute = document.createAttribute('data-import-url');
                urlAttribute.value = dictionary.downloadUrl;
                button.attributes.setNamedItem(urlAttribute);

                label.textContent = dictionary.name;
                description.textContent = dictionary.description;
                if (dictionary.homepage) {
                    homepage.target = '_blank';
                    homepage.href = dictionary.homepage;
                } else {
                    homepage.remove();
                }

                dictionariesList.append(template);
            }
        }
    }

    /**
     * @param {string} importUrl
     * @param {boolean} disabled
     */
    _setRecommendedImportButtonDisabled(importUrl, disabled) {
        /** @type {NodeListOf<HTMLButtonElement>} */
        const buttons = document.querySelectorAll('.action-button[data-action=import-recommended-dictionary]');
        for (const button of buttons) {
            if (button.dataset.importUrl !== importUrl) { continue; }
            button.disabled = disabled;
        }
    }

    /**
     * @param {import('settings-controller').EventArgument<'importDictionaryFromUrl'>} details
     */
    _onEventImportDictionaryFromUrl({url, profilesDictionarySettings, onImportDone}) {
        void this.importFilesFromURLs(url, profilesDictionarySettings, onImportDone);
    }

    /** */
    _onImportFileButtonClick() {
        /** @type {HTMLInputElement} */ (this._importFileInput).click();
    }

    /**
     * @param {DragEvent} e
     */
    _onFileDropEnter(e) {
        e.preventDefault();
        if (!e.dataTransfer) { return; }
        for (const item of e.dataTransfer.items) {
            if (item.kind === 'file') {
                this._importFileDrop.classList.add('drag-over');
                break;
            }
        }
    }

    /**
     * @param {DragEvent} e
     */
    _onFileDropOver(e) {
        e.preventDefault();
    }

    /**
     * @param {DragEvent} e
     */
    _onFileDropLeave(e) {
        e.preventDefault();
        this._importFileDrop.classList.remove('drag-over');
    }

    /**
     * @param {DragEvent} e
     */
    async _onFileDrop(e) {
        e.preventDefault();
        this._importFileDrop.classList.remove('drag-over');
        if (e.dataTransfer === null) { return; }
        /** @type {File[]} */
        const fileArray = [];
        for (const fileEntry of await this._getAllFileEntries(e.dataTransfer.items)) {
            if (!fileEntry) { return; }
            try {
                fileArray.push(await new Promise((resolve, reject) => { fileEntry.file(resolve, reject); }));
            } catch (error) {
                log.error(error);
            }
        }
        const {sources, errors, hasMdx} = this._createImportSourcesFromFiles(fileArray);
        if (sources.length === 0) {
            if (errors.length > 0) { this._showErrors(errors); }
            return;
        }
        if (hasMdx) {
            try {
                await this._ensureMdxImportReady();
            } catch (error) {
                this._showErrors([toError(error), ...errors]);
                return;
            }
        }
        this._importSelectedSources(sources, errors);
    }

    /**
     * @param {DataTransferItemList} dataTransferItemList
     * @returns {Promise<FileSystemFileEntry[]>}
     */
    async _getAllFileEntries(dataTransferItemList) {
        /** @type {(FileSystemFileEntry)[]} */
        const fileEntries = [];
        /** @type {(FileSystemEntry | null)[]} */
        const entries = [];
        for (let i = 0; i < dataTransferItemList.length; i++) {
            entries.push(dataTransferItemList[i].webkitGetAsEntry());
        }
        this._importFileDropItemCount = entries.length - 1;
        while (entries.length > 0) {
            this._importFileDropItemCount += 1;
            this._validateDirectoryItemCount();

            /** @type {(FileSystemEntry | null) | undefined} */
            const entry = entries.shift();
            if (!entry) { continue; }
            if (entry.isFile) {
                if (
                    isZipDictionaryFileName(entry.name) ||
                    isMdxDictionaryFileName(entry.name) ||
                    isMddDictionaryFileName(entry.name)
                ) {
                    // @ts-expect-error - ts does not recognize `if (entry.isFile)` as verifying `entry` is type `FileSystemFileEntry` and instanceof does not work
                    fileEntries.push(entry);
                }
            } else if (entry.isDirectory) {
                // @ts-expect-error - ts does not recognize `if (entry.isDirectory)` as verifying `entry` is type `FileSystemDirectoryEntry` and instanceof does not work
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                entries.push(...await this._readAllDirectoryEntries(entry.createReader()));
            }
        }
        return fileEntries;
    }

    /**
     * @param {FileSystemDirectoryReader} directoryReader
     * @returns {Promise<(FileSystemEntry)[]>}
     */
    async _readAllDirectoryEntries(directoryReader) {
        const entries = [];
        /** @type {(FileSystemEntry)[]} */
        let readEntries = await new Promise((resolve) => { directoryReader.readEntries(resolve); });
        while (readEntries.length > 0) {
            this._importFileDropItemCount += readEntries.length;
            this._validateDirectoryItemCount();

            entries.push(...readEntries);
            readEntries = await new Promise((resolve) => { directoryReader.readEntries(resolve); });
        }
        return entries;
    }

    /**
     * @throws
     */
    _validateDirectoryItemCount() {
        if (this._importFileDropItemCount > 1000) {
            this._importFileDropItemCount = 0;
            const errorText = 'Directory upload item count too large';
            this._showErrors([new Error(errorText)]);
            throw new Error(errorText);
        }
    }

    /**
     * @param {File} file
     * @returns {string|null}
     */
    _getMdxImportSourceKey(file) {
        return getDictionaryImportSourceKeyFromPath(getDictionaryFilePath(file));
    }

    /**
     * @param {File} file
     * @returns {number}
     */
    _getMddSequenceIndex(file) {
        return this._getMddSequenceIndexFromName(file.name);
    }

    /**
     * @param {string} fileName
     * @returns {number}
     */
    _getMddSequenceIndexFromName(fileName) {
        const match = /\.([0-9]+)\.mdd$/i.exec(getLowercaseFileName(fileName));
        if (match !== null) {
            return Number.parseInt(match[1], 10);
        }
        return 0;
    }

    /**
     * @param {string} fileName
     * @returns {string|null}
     */
    _getMdxImportSourceKeyFromName(fileName) {
        return getDictionaryImportSourceKeyFromPath(fileName);
    }

    /**
     * @param {File[]} files
     * @returns {{sources: DictionaryImportSource[], errors: Error[], hasMdx: boolean}}
     */
    _createImportSourcesFromFiles(files) {
        /** @type {Array<{firstIndex: number, source: DictionaryImportSource}>} */
        const pendingSources = [];
        /** @type {Error[]} */
        const errors = [];
        /** @type {Map<string, {firstIndex: number, mdxFile: File|null, mddFiles: File[]}>} */
        const mdxGroups = new Map();
        let hasMdx = false;

        for (const [index, file] of files.entries()) {
            const filePath = getDictionaryFilePath(file);
            if (isZipDictionaryFileName(filePath)) {
                pendingSources.push({firstIndex: index, source: {type: 'zip', file}});
                continue;
            }
            if (!(isMdxDictionaryFileName(filePath) || isMddDictionaryFileName(filePath))) {
                errors.push(new Error(`Unsupported dictionary file: ${file.name}`));
                continue;
            }
            const key = this._getMdxImportSourceKey(file);
            if (key === null) {
                errors.push(new Error(`Unsupported MDX resource file: ${file.name}`));
                continue;
            }

            let group = mdxGroups.get(key);
            if (typeof group === 'undefined') {
                group = {firstIndex: index, mdxFile: null, mddFiles: []};
                mdxGroups.set(key, group);
            }
            group.firstIndex = Math.min(group.firstIndex, index);
            if (isMdxDictionaryFileName(filePath)) {
                if (group.mdxFile !== null) {
                    errors.push(new Error(`Multiple MDX files matched the same dictionary group: ${file.name}`));
                    continue;
                }
                group.mdxFile = file;
            } else {
                group.mddFiles.push(file);
            }
        }

        const orderedMdxSources = [...mdxGroups.values()]
            .sort((a, b) => a.firstIndex - b.firstIndex);
        for (const group of orderedMdxSources) {
            if (group.mdxFile === null) {
                const firstResource = group.mddFiles[0];
                errors.push(new Error(`Found MDD resources without a matching MDX file: ${firstResource ? firstResource.name : 'unknown resource'}`));
                continue;
            }
            group.mddFiles.sort((a, b) => this._getMddSequenceIndex(a) - this._getMddSequenceIndex(b));
            pendingSources.push({
                firstIndex: group.firstIndex,
                source: {
                    type: 'mdx',
                    mdxFile: group.mdxFile,
                    mddFiles: [...group.mddFiles],
                },
            });
        }

        pendingSources.sort((a, b) => a.firstIndex - b.firstIndex);
        const sources = pendingSources.map(({source}) => source);
        hasMdx = sources.some((source) => source.type === 'mdx');
        return {sources, errors, hasMdx};
    }

    /**
     * @param {DictionaryImportSource[]} sources
     * @param {Error[]} [errors]
     */
    _appendPendingImportSources(sources, errors = []) {
        this._pendingImportSources.push(...sources);
        this._renderPendingImportSources();
        this._hideErrors();
        if (errors.length > 0) {
            this._showErrors(errors);
        }
    }

    /**
     * @param {DictionaryImportSource[]} sources
     * @param {Error[]} [initialErrors]
     */
    _importSelectedSources(sources, initialErrors = []) {
        if (sources.length === 0) { return; }
        /** @type {import('./modal.js').Modal} */ (this._importModal).setVisible(false);
        void this._importDictionaries(
            this._arrayToAsyncGenerator(sources),
            null,
            null,
            new ImportProgressTracker(this._getFileImportSteps(), sources.length),
            initialErrors,
        );
    }

    /** */
    _clearPendingImportSources() {
        this._pendingImportSources = [];
        this._renderPendingImportSources();
    }

    /** */
    _renderPendingImportSources() {
        this._importSourceList.textContent = '';
        const hasSources = this._pendingImportSources.length > 0;
        this._importSourceEmpty.hidden = hasSources;
        this._importConfirmButton.disabled = !hasSources;
        if (!hasSources) {
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const source of this._pendingImportSources) {
            const node = /** @type {HTMLElement} */ (this._settingsController.instantiateTemplate('dictionary-import-source'));
            const title = querySelectorNotNull(node, '.dictionary-import-source-title');
            const description = querySelectorNotNull(node, '.dictionary-import-source-description');
            title.textContent = this._getPendingImportSourceLabel(source);
            description.textContent = this._getPendingImportSourceDescription(source);

            fragment.appendChild(node);
        }
        this._importSourceList.appendChild(fragment);
    }

    /**
     * @param {DictionaryImportSource} source
     * @returns {string}
     */
    _getPendingImportSourceLabel(source) {
        return source.type === 'zip' ? source.file.name : source.mdxFile.name;
    }

    /**
     * @param {DictionaryImportSource} source
     * @returns {string}
     */
    _getPendingImportSourceDescription(source) {
        if (source.type === 'zip') {
            return 'ZIP archive';
        }
        const mddCount = source.mddFiles.length;
        return mddCount > 0 ? `MDX dictionary with ${mddCount} matching MDD file${mddCount === 1 ? '' : 's'}` : 'MDX dictionary';
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureMdxImportReady() {
        await this._getMdxVersion();
    }

    /**
     * @returns {Promise<number>}
     */
    async _getMdxVersion() {
        const dictionaryWorker = new DictionaryWorker({reuseWorker: false});
        try {
            return await dictionaryWorker.getMdxVersion();
        } finally {
            dictionaryWorker.destroy();
        }
    }

    /**
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @param {{stage: 'upload'|'convert'|'download', completed: number, total: number}} details
     */
    _reportMdxConversionProgress(onProgress, details) {
        const {stage, completed, total} = details;
        let progress = 0;
        switch (stage) {
            case 'upload':
                progress = (total > 0 ? completed / total : 0) * MDX_UPLOAD_PROGRESS_RATIO;
                break;
            case 'convert':
                progress = MDX_UPLOAD_PROGRESS_RATIO + ((total > 0 ? completed / total : 1) * (1 - MDX_UPLOAD_PROGRESS_RATIO));
                break;
            case 'download':
                progress = 1;
                break;
        }
        onProgress({
            nextStep: false,
            index: Math.round(Math.max(0, Math.min(1, progress)) * MDX_CONVERSION_PROGRESS_TOTAL),
            count: MDX_CONVERSION_PROGRESS_TOTAL,
        });
    }

    /**
     * @param {MouseEvent} e
     */
    _onImportButtonClick(e) {
        e.preventDefault();
        /** @type {import('./modal.js').Modal} */ (this._importModal).setVisible(true);
    }

    /** */
    _onImportConfirm() {
        if (this._pendingImportSources.length === 0) { return; }
        this._importSelectedSources([...this._pendingImportSources]);
    }

    /**
     * @param {MouseEvent} e
     */
    _onPurgeButtonClick(e) {
        e.preventDefault();
        /** @type {import('./modal.js').Modal} */ (this._purgeConfirmModal).setVisible(true);
    }

    /**
     * @param {MouseEvent} e
     */
    _onPurgeConfirmButtonClick(e) {
        e.preventDefault();
        /** @type {import('./modal.js').Modal} */ (this._purgeConfirmModal).setVisible(false);
        void this._purgeDatabase();
    }

    /**
     * @param {Event} e
     */
    async _onImportFileChange(e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        const {files} = node;
        if (files === null) { return; }
        const files2 = [...files];
        node.value = '';
        const {sources, errors, hasMdx} = this._createImportSourcesFromFiles(files2);
        if (sources.length === 0) {
            if (errors.length > 0) { this._showErrors(errors); }
            return;
        }
        if (hasMdx) {
            try {
                await this._ensureMdxImportReady();
            } catch (error) {
                this._showErrors([toError(error), ...errors]);
                return;
            }
        }
        this._importSelectedSources(sources, errors);
    }

    /** */
    async _onImportFromURL() {
        const text = this._importURLText.value.trim();
        if (!text) { return; }
        /** @type {Error[]} */
        const errors = [];
        /** @type {DictionaryImportSource[]} */
        const sources = [];
        const onProgress = () => {};
        for await (const source of this._generateFilesFromUrls(text.split('\n'), onProgress, (error) => {
            errors.push(error);
        })) {
            sources.push(source);
        }
        if (sources.length === 0) {
            if (errors.length > 0) {
                this._showErrors(errors);
            }
            return;
        }
        this._importURLText.value = '';
        this._appendPendingImportSources(sources, errors);
    }

    /**
     * @param {string} text
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {import('settings-controller').ImportDictionaryDoneCallback} onImportDone
     */
    async importFilesFromURLs(text, profilesDictionarySettings, onImportDone) {
        const urls = text.split('\n');

        const importProgressTracker = new ImportProgressTracker(this._getUrlImportSteps(), urls.length);
        const onProgress = importProgressTracker.onProgress.bind(importProgressTracker);
        void this._importDictionaries(
            this._generateFilesFromUrls(urls, onProgress),
            profilesDictionarySettings,
            onImportDone,
            importProgressTracker,
            [],
        );
    }

    /**
     * @param {string[]} urls
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @param {(error: Error) => void} [onError]
     * @yields {Promise<DictionaryImportSource>}
     * @returns {AsyncGenerator<DictionaryImportSource, void, void>}
     */
    async *_generateFilesFromUrls(urls, onProgress, onError = void 0) {
        let mdxImportReady = false;
        for (const url of urls) {
            onProgress({nextStep: true, index: 0, count: 0});
            const trimmedUrl = url.trim();
            if (trimmedUrl.length === 0) { continue; }
            const downloadStartTime = safePerformance.now();
            log.log(`[ImportTiming] download started: ${trimmedUrl}`);
            reportDiagnostics('dictionary-url-download-begin', {
                url: summarizeUrlForDiagnostics(trimmedUrl),
            });

            try {
                if (trimmedUrl.startsWith('manabitan-e2e-dict:')) {
                    const inlineArchiveBase64 = this._getInlineArchiveBase64ForUrl(trimmedUrl);
                    if (typeof inlineArchiveBase64 !== 'string') {
                        throw new Error(`Missing inline archive for ${trimmedUrl}`);
                    }
                    const tokenName = trimmedUrl.slice('manabitan-e2e-dict:'.length).trim();
                    const safeName = tokenName.length > 0 ? tokenName.replaceAll(/[^a-zA-Z0-9._-]/g, '-') : 'fileFromURL';
                    const file = new File([this._base64ToUint8Array(inlineArchiveBase64)], `${safeName}.zip`, {type: 'application/zip'});
                    const downloadEndTime = safePerformance.now();
                    log.log(`[ImportTiming] download completed in ${formatDurationMs(downloadEndTime - downloadStartTime)}: ${trimmedUrl} (inline archive)`);
                    reportDiagnostics('dictionary-url-download-complete', {
                        url: summarizeUrlForDiagnostics(trimmedUrl),
                        inline: true,
                        elapsedMs: Math.max(0, downloadEndTime - downloadStartTime),
                        sizeBytes: file.size,
                    });
                    yield {type: 'zip', file};
                    continue;
                }
                const directFileName = getDictionaryFileNameFromUrl(trimmedUrl);
                if (!mdxImportReady && directFileName !== null && isMdxDictionaryFileName(directFileName)) {
                    await this._ensureMdxImportReady();
                    mdxImportReady = true;
                }
                const source = await this._createImportSourceFromUrl(trimmedUrl, onProgress);
                if (source.type === 'mdx' && !mdxImportReady) {
                    await this._ensureMdxImportReady();
                    mdxImportReady = true;
                }
                const downloadEndTime = safePerformance.now();
                log.log(`[ImportTiming] download completed in ${formatDurationMs(downloadEndTime - downloadStartTime)}: ${trimmedUrl}`);
                reportDiagnostics('dictionary-url-download-complete', {
                    url: summarizeUrlForDiagnostics(trimmedUrl),
                    inline: false,
                    elapsedMs: Math.max(0, downloadEndTime - downloadStartTime),
                    sizeBytes: this._getImportSourceSizeBytes(source),
                    sourceType: source.type,
                });
                yield source;
            } catch (error) {
                const downloadEndTime = safePerformance.now();
                log.log(`[ImportTiming] download failed after ${formatDurationMs(downloadEndTime - downloadStartTime)}: ${trimmedUrl}`);
                reportDiagnostics('dictionary-url-download-failed', {
                    url: summarizeUrlForDiagnostics(trimmedUrl),
                    elapsedMs: Math.max(0, downloadEndTime - downloadStartTime),
                    message: toError(error).message,
                });
                if (trimmedUrl.startsWith('manabitan-e2e-dict:')) {
                    throw error;
                }
                log.error(error);
                if (typeof onError === 'function') {
                    onError(toError(error));
                }
            }
        }
    }

    /**
     * @param {DictionaryImportSource} source
     * @returns {number}
     */
    _getImportSourceSizeBytes(source) {
        if (source.type === 'zip') {
            return source.file.size;
        }
        return source.mdxFile.size + source.mddFiles.reduce((sum, file) => sum + file.size, 0);
    }

    /**
     * @param {string} url
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<DictionaryImportSource>}
     */
    async _createImportSourceFromUrl(url, onProgress) {
        const directFileName = getDictionaryFileNameFromUrl(url);
        if (directFileName !== null && isZipDictionaryFileName(directFileName)) {
            const file = await this._downloadFileFromUrl(url, onProgress, directFileName);
            return {type: 'zip', file};
        }
        if (directFileName !== null && isMdxDictionaryFileName(directFileName)) {
            return await this._downloadMdxImportSourceFromUrl(url, onProgress, directFileName);
        }

        const response = await this._downloadBlobResponseFromUrl(url, onProgress);
        if (this._isHtmlUrlResponse(response)) {
            const listingHtml = await response.blob.text();
            const mdxListing = this._parseMdxListingDocument(url, listingHtml, null);
            if (mdxListing === null) {
                throw new Error(`URL did not point to a supported dictionary file or MDX directory listing: ${url}`);
            }
            return await this._downloadMdxImportSourceFromListing(mdxListing, onProgress);
        }

        const fileName = response.fileName || directFileName || 'fileFromURL.zip';
        return {type: 'zip', file: new File([response.blob], fileName, {type: response.blob.type || 'application/zip'})};
    }

    /**
     * @param {string} url
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @param {string} mdxFileName
     * @returns {Promise<MdxImportSource>}
     */
    async _downloadMdxImportSourceFromUrl(url, onProgress, mdxFileName) {
        const mdxFile = await this._downloadFileFromUrl(url, onProgress, mdxFileName);
        const listing = await this._getMdxListingForUrl(url, mdxFile.name);
        if (listing === null) {
            return {type: 'mdx', mdxFile, mddFiles: []};
        }
        const mddFiles = await this._downloadListingFiles(listing.mddLinks, onProgress);
        return {type: 'mdx', mdxFile, mddFiles};
    }

    /**
     * @param {{mdxLink: {url: string, fileName: string}, mddLinks: Array<{url: string, fileName: string}>}} listing
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<MdxImportSource>}
     */
    async _downloadMdxImportSourceFromListing(listing, onProgress) {
        const mdxFile = await this._downloadFileFromUrl(listing.mdxLink.url, onProgress, listing.mdxLink.fileName);
        const mddFiles = await this._downloadListingFiles(listing.mddLinks, onProgress);
        return {type: 'mdx', mdxFile, mddFiles};
    }

    /**
     * @param {string} url
     * @param {string} mdxFileName
     * @returns {Promise<{mdxLink: {url: string, fileName: string}, mddLinks: Array<{url: string, fileName: string}>}|null>}
     */
    async _getMdxListingForUrl(url, mdxFileName) {
        try {
            const parentUrl = new URL('.', url).href;
            const response = await fetch(parentUrl);
            if (!response.ok) { return null; }
            const contentType = response.headers.get('content-type') || '';
            if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) { return null; }
            const html = await response.text();
            return this._parseMdxListingDocument(parentUrl, html, mdxFileName);
        } catch (_error) {
            return null;
        }
    }

    /**
     * @param {Array<{url: string, fileName: string}>} listingFiles
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<File[]>}
     */
    async _downloadListingFiles(listingFiles, onProgress) {
        /** @type {File[]} */
        const files = [];
        for (const {url, fileName} of listingFiles) {
            files.push(await this._downloadFileFromUrl(url, onProgress, fileName));
        }
        files.sort((a, b) => this._getMddSequenceIndex(a) - this._getMddSequenceIndex(b));
        return files;
    }

    /**
     * @param {string} baseUrl
     * @param {string} html
     * @param {string|null} mdxFileName
     * @returns {{mdxLink: {url: string, fileName: string}, mddLinks: Array<{url: string, fileName: string}>}|null}
     */
    _parseMdxListingDocument(baseUrl, html, mdxFileName) {
        if (typeof DOMParser === 'undefined') { return null; }
        const document = new DOMParser().parseFromString(html, 'text/html');
        /** @type {Array<{url: string, fileName: string}>} */
        const fileLinks = [];
        for (const link of document.querySelectorAll('a[href]')) {
            const href = link.getAttribute('href');
            if (typeof href !== 'string' || href.length === 0) { continue; }
            let resolvedUrl;
            try {
                resolvedUrl = new URL(href, baseUrl).href;
            } catch (_error) {
                continue;
            }
            const fileName = getDictionaryFileNameFromUrl(resolvedUrl);
            if (fileName === null) { continue; }
            fileLinks.push({url: resolvedUrl, fileName});
        }

        let mdxLink = null;
        if (typeof mdxFileName === 'string' && mdxFileName.length > 0) {
            mdxLink = fileLinks.find(({fileName}) => fileName === mdxFileName && isMdxDictionaryFileName(fileName)) || null;
        } else {
            const mdxLinks = fileLinks.filter(({fileName}) => isMdxDictionaryFileName(fileName));
            if (mdxLinks.length !== 1) { return null; }
            [mdxLink] = mdxLinks;
        }
        if (mdxLink === null) { return null; }

        const mdxKey = this._getMdxImportSourceKeyFromName(mdxLink.fileName);
        if (mdxKey === null) { return null; }
        const mddLinks = fileLinks
            .filter(({fileName}) => (
                isMddDictionaryFileName(fileName) &&
                this._getMdxImportSourceKeyFromName(fileName) === mdxKey
            ))
            .sort((a, b) => this._getMddSequenceIndexFromName(a.fileName) - this._getMddSequenceIndexFromName(b.fileName));
        return {mdxLink, mddLinks};
    }

    /**
     * @param {string} url
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @param {string} fallbackFileName
     * @returns {Promise<File>}
     */
    async _downloadFileFromUrl(url, onProgress, fallbackFileName) {
        const {blob, fileName} = await this._downloadBlobResponseFromUrl(url, onProgress);
        return new File([blob], fileName || fallbackFileName, {type: blob.type});
    }

    /**
     * @param {string} url
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<{blob: Blob, fileName: string|null, contentType: string}>}
     */
    _downloadBlobResponseFromUrl(url, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'blob';
            xhr.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress({nextStep: false, index: event.loaded, count: event.total});
                }
            };
            xhr.onload = () => {
                if (xhr.status !== 200) {
                    reject(new Error(`Failed to fetch the URL: ${url}`));
                    return;
                }
                if (!(xhr.response instanceof Blob)) {
                    reject(new Error(`Failed to fetch blob from ${url}`));
                    return;
                }
                resolve({
                    blob: xhr.response,
                    fileName: this._getDownloadedFileName(url, xhr),
                    contentType: xhr.getResponseHeader('content-type') || xhr.response.type || '',
                });
            };
            xhr.onerror = () => {
                reject(new Error(`Error fetching URL: ${url}`));
            };
            xhr.send();
        });
    }

    /**
     * @param {string} url
     * @param {XMLHttpRequest} xhr
     * @returns {string|null}
     */
    _getDownloadedFileName(url, xhr) {
        const contentDisposition = xhr.getResponseHeader('content-disposition') || '';
        const fileNameMatch = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(contentDisposition);
        if (fileNameMatch !== null) {
            const rawFileName = fileNameMatch[1].trim().replace(/^"|"$/g, '');
            try {
                return decodeURIComponent(rawFileName);
            } catch (_error) {
                return rawFileName;
            }
        }
        return getDictionaryFileNameFromUrl(url);
    }

    /**
     * @param {{blob: Blob, fileName: string|null, contentType: string}} response
     * @returns {boolean}
     */
    _isHtmlUrlResponse(response) {
        if (/text\/html|application\/xhtml\+xml/i.test(response.contentType)) {
            return true;
        }
        const fileName = response.fileName;
        return typeof fileName === 'string' && /\.x?html?$/i.test(fileName);
    }

    /**
     * @param {string} url
     * @returns {string|null}
     */
    _getInlineArchiveBase64ForUrl(url) {
        if (!url.startsWith('manabitan-e2e-dict:')) { return null; }
        const source = globalThis.localStorage?.getItem('manabitanE2eArchiveMap') || '';
        if (source.length === 0) { return null; }
        /** @type {unknown} */
        let value;
        try {
            value = parseJson(source);
        } catch (_error) {
            return null;
        }
        if (!(value && typeof value === 'object' && !Array.isArray(value))) { return null; }
        const content = /** @type {unknown} */ (Reflect.get(value, url));
        return (typeof content === 'string' && content.length > 0) ? content : null;
    }

    /**
     * @param {string} base64
     * @returns {Uint8Array}
     */
    _base64ToUint8Array(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; ++i) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /** */
    async _purgeDatabase() {
        if (this._modifying) { return; }

        const prevention = this._preventPageExit();

        try {
            this._setModifying(true);
            this._hideErrors();

            await this._settingsController.application.api.purgeDatabase();
            const errors = await this._clearDictionarySettings();

            if (errors.length > 0) {
                this._showErrors(errors);
            }
        } catch (error) {
            this._showErrors([toError(error)]);
        } finally {
            prevention.end();
            this._setModifying(false);
            this._triggerStorageChanged();
        }
    }

    /**
     * @param {AsyncGenerator<DictionaryImportSource, void, void>} dictionaries
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {import('settings-controller').ImportDictionaryDoneCallback} onImportDone
     * @param {ImportProgressTracker} importProgressTracker
     * @param {Error[]} [initialErrors]
     */
    async _importDictionaries(dictionaries, profilesDictionarySettings, onImportDone, importProgressTracker, initialErrors = []) {
        if (this._modifying) { return; }

        const statusFooter = this._statusFooter;
        const progressSelector = '.dictionary-import-progress';
        const progressContainers = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`#dictionaries-modal ${progressSelector}`));
        const recommendedProgressContainers = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`#recommended-dictionaries-modal ${progressSelector}`));

        const prevention = this._preventPageExit();

        const onProgress = importProgressTracker.onProgress.bind(importProgressTracker);
        Reflect.set(globalThis, '__manabitanImportStepTimingHistory', []);

        /** @type {Error[]} */
        let errors = [...initialErrors];
        const useImportSession = this._getUseImportSession();
        log.log(`[ImportTiming] import session reuse enabled=${String(useImportSession)} (globalOverride=${String(this._getUseImportSession())})`);
        reportDiagnostics('dictionary-import-session-begin', {
            dictionaryCount: importProgressTracker.dictionaryCount,
            useImportSession,
            hasProfilesDictionarySettings: profilesDictionarySettings !== null,
        });
        const dictionaryWorker = this._getDictionaryWorker(useImportSession);
        let importModeEnabled = false;
        const importStartTime = safePerformance.now();
        try {
            this._setModifying(true);
            this._hideErrors();
            await this._settingsController.application.api.setDictionaryImportMode(true);
            importModeEnabled = true;

            for (const progress of [...progressContainers, ...recommendedProgressContainers]) { progress.hidden = false; }

            const optionsFull = await this._settingsController.getOptionsFull();
            const {
                skipImageMetadata,
                skipMediaImport,
                mediaResolutionConcurrency,
                debugImportLogging,
                enableTermEntryContentDedup,
                termContentStorageMode,
            } = this._getImportPerformanceFlags();
            const importDetails = {
                prefixWildcardsSupported: optionsFull.global.database.prefixWildcardsSupported,
                yomitanVersion: chrome.runtime.getManifest().version,
                skipImageMetadata,
                skipMediaImport,
                mediaResolutionConcurrency,
                debugImportLogging,
                enableTermEntryContentDedup,
                termContentStorageMode,
            };

            for (let i = 0; i < importProgressTracker.dictionaryCount; ++i) {
                importProgressTracker.onNextDictionary();
                if (statusFooter !== null) { statusFooter.setTaskActive(progressSelector, true); }
                const dictionaryLoopStartTime = safePerformance.now();
                const finalizeImportSession = useImportSession && i >= (importProgressTracker.dictionaryCount - 1);
                reportDiagnostics('dictionary-import-item-begin', {
                    index: i + 1,
                    dictionaryCount: importProgressTracker.dictionaryCount,
                    finalizeImportSession,
                });
                const nextDictionary = await dictionaries.next();
                const source = nextDictionary.done ? null : nextDictionary.value;
                if (source && typeof source === 'object' && source.type === 'zip' && source.file instanceof File) {
                    errors = [
                        ...errors,
                        ...(await this._importDictionaryFromZip(
                            source.file,
                            profilesDictionarySettings,
                            importDetails,
                            dictionaryWorker,
                            useImportSession,
                            finalizeImportSession,
                            onProgress,
                        ) ?? []),
                    ];
                } else if (
                    source &&
                    typeof source === 'object' &&
                    source.type === 'mdx' &&
                    source.mdxFile instanceof File &&
                    Array.isArray(source.mddFiles)
                ) {
                    errors = [
                        ...errors,
                        ...(await this._importDictionaryFromMdx(
                            source,
                            profilesDictionarySettings,
                            importDetails,
                            dictionaryWorker,
                            useImportSession,
                            finalizeImportSession,
                            onProgress,
                        ) ?? []),
                    ];
                } else {
                    errors.push(new Error(`Failed to read file ${i + 1} of ${importProgressTracker.dictionaryCount} (value-type=${typeof source}).`));
                    reportDiagnostics('dictionary-import-item-invalid-file', {
                        index: i + 1,
                        dictionaryCount: importProgressTracker.dictionaryCount,
                        valueType: typeof source,
                    });
                    continue;
                }
                const dictionaryLoopEndTime = safePerformance.now();
                log.log(`[ImportTiming] dictionary ${i + 1}/${importProgressTracker.dictionaryCount} total ${formatDurationMs(dictionaryLoopEndTime - dictionaryLoopStartTime)}`);
                reportDiagnostics('dictionary-import-item-complete', {
                    index: i + 1,
                    dictionaryCount: importProgressTracker.dictionaryCount,
                    elapsedMs: Math.max(0, dictionaryLoopEndTime - dictionaryLoopStartTime),
                    cumulativeErrorCount: errors.length,
                    fileName: (
                        source && typeof source === 'object' && source.type === 'mdx' && source.mdxFile instanceof File ?
                        source.mdxFile.name :
                        (source && typeof source === 'object' && source.type === 'zip' && source.file instanceof File ?
                        source.file.name :
                        null)
                    ),
                    memory: getImportMemorySnapshot(),
                });
            }
        } catch (error) {
            errors.push(toError(error));
            reportDiagnostics('dictionary-import-session-error', {
                message: toError(error).message,
            });
        } finally {
            importProgressTracker.onImportComplete(errors.length);
            Reflect.set(globalThis, '__manabitanImportStepTimingHistory', importProgressTracker.getStepTimingHistory());
            const importEndTime = safePerformance.now();
            log.log(`[ImportTiming] import session complete in ${formatDurationMs(importEndTime - importStartTime)} (errors=${errors.length})`);
            reportDiagnostics('dictionary-import-session-complete', {
                dictionaryCount: importProgressTracker.dictionaryCount,
                elapsedMs: Math.max(0, importEndTime - importStartTime),
                errorCount: errors.length,
                memory: getImportMemorySnapshot(),
            });
            this._showErrors(errors);
            prevention.end();
            for (const progress of [...progressContainers, ...recommendedProgressContainers]) { progress.hidden = true; }
            if (statusFooter !== null) { statusFooter.setTaskActive(progressSelector, false); }
            this._setModifying(false);
            this._releaseDictionaryWorker(dictionaryWorker, useImportSession);
            if (importModeEnabled) {
                try {
                    await this._settingsController.application.api.setDictionaryImportMode(false);
                } catch (error) {
                    log.error(error);
                }
            }
            this._triggerStorageChanged();
            if (onImportDone) { onImportDone(); }
        }
    }

    /**
     * @returns {import('dictionary-importer').ImportSteps}
     */
    _getFileImportSteps() {
        return [
            {label: ''}, // Dictionary import is uninitialized
            {label: 'Initializing import'}, // Dictionary import is uninitialized
            {label: 'Preparing dictionary'}, // Convert MDX or read local archive bytes
            {label: 'Loading dictionary'}, // Load dictionary archive and read index
            {label: 'Importing data'}, // Parse archive banks and import data
            {label: 'Finalizing import'}, // Update dictionary descriptor
        ];
    }

    /**
     * @returns {import('dictionary-importer').ImportSteps}
     */
    _getUrlImportSteps() {
        const urlImportSteps = this._getFileImportSteps();
        urlImportSteps.splice(2, 0, {label: 'Downloading dictionary'});
        return urlImportSteps;
    }

    /**
     * @returns {{skipImageMetadata: boolean, skipMediaImport: boolean, mediaResolutionConcurrency: number, debugImportLogging: boolean, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes'}}
     */
    _getImportPerformanceFlags() {
        const flags = /** @type {unknown} */ (Reflect.get(globalThis, 'manabitanImportPerformanceFlags'));
        if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) {
            return {
                skipImageMetadata: false,
                skipMediaImport: false,
                mediaResolutionConcurrency: 8,
                debugImportLogging: false,
                enableTermEntryContentDedup: true,
                termContentStorageMode: 'baseline',
            };
        }
        const flagsRecord = /** @type {Record<string, unknown>} */ (flags);
        const mediaResolutionConcurrency = Number.isFinite(flagsRecord.mediaResolutionConcurrency) ? Math.trunc(/** @type {number} */ (flagsRecord.mediaResolutionConcurrency)) : 8;
        const termContentStorageModeRaw = flagsRecord.termContentStorageMode;
        const termContentStorageMode = (termContentStorageModeRaw === 'raw-bytes') ?
            termContentStorageModeRaw :
            'baseline';
        return {
            skipImageMetadata: flagsRecord.skipImageMetadata === true,
            skipMediaImport: flagsRecord.skipMediaImport === true,
            mediaResolutionConcurrency: Math.max(1, Math.min(32, mediaResolutionConcurrency)),
            debugImportLogging: flagsRecord.debugImportLogging === true,
            enableTermEntryContentDedup: flagsRecord.enableTermEntryContentDedup !== false,
            termContentStorageMode,
        };
    }

    /**
     * @returns {boolean}
     */
    _getUseImportSession() {
        return Reflect.get(globalThis, 'manabitanImportUseSession') !== false;
    }

    /**
     * @param {Record<string, unknown>} snapshot
     */
    _recordImportDebugSnapshot(snapshot) {
        Reflect.set(globalThis, '__manabitanLastImportDebug', snapshot);
        const historyRaw = /** @type {unknown} */ (Reflect.get(globalThis, '__manabitanImportDebugHistory'));
        /** @type {Record<string, unknown>[]} */
        const history = [];
        if (Array.isArray(historyRaw)) {
            for (const entry of /** @type {unknown[]} */ (historyRaw)) {
                if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
                    history.push(/** @type {Record<string, unknown>} */ (entry));
                }
            }
        }
        history.push(snapshot);
        if (history.length > 20) {
            history.splice(0, history.length - 20);
        }
        Reflect.set(globalThis, '__manabitanImportDebugHistory', history);
    }

    /**
     * @template T
     * @param {T[]} arr
     * @yields {Promise<T>}
     * @returns {AsyncGenerator<T, void, void>}
     */
    async *_arrayToAsyncGenerator(arr) {
        for (const item of arr) {
            yield item;
        }
    }

    /**
     * @param {MdxImportSource} source
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<{mdxBytes: ArrayBuffer, mddFiles: Array<{name: string, bytes: ArrayBuffer}>, totalBytes: number}>}
     */
    async _readMdxImportSourceBytes(source, onProgress) {
        const uploadFiles = [source.mdxFile, ...source.mddFiles];
        const totalUploadBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
        let uploadedBytes = 0;
        /**
         * @param {File} file
         * @returns {Promise<ArrayBuffer>}
         */
        const readFileWithProgress = async (file) => {
            const buffer = await file.arrayBuffer();
            uploadedBytes += file.size;
            this._reportMdxConversionProgress(onProgress, {
                stage: 'upload',
                completed: uploadedBytes,
                total: totalUploadBytes,
            });
            return buffer;
        };

        const mdxBytes = await readFileWithProgress(source.mdxFile);
        /** @type {Array<{name: string, bytes: ArrayBuffer}>} */
        const mddFiles = [];
        for (const file of source.mddFiles) {
            mddFiles.push({
                name: file.name,
                bytes: await readFileWithProgress(file),
            });
        }
        return {mdxBytes, mddFiles, totalBytes: totalUploadBytes};
    }

    /**
     * @param {MdxImportSource} source
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {import('dictionary-importer').ImportDetails} importDetails
     * @param {DictionaryWorker} dictionaryWorker
     * @param {boolean} useImportSession
     * @param {boolean} finalizeImportSession
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<Error[] | undefined>}
     */
    async _importDictionaryFromMdx(source, profilesDictionarySettings, importDetails, dictionaryWorker, useImportSession, finalizeImportSession, onProgress) {
        const sourceTitle = source.mdxFile.name || 'unknown-dictionary.mdx';
        const importStartTime = safePerformance.now();
        /** @type {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} */
        const localPhaseTimings = [];
        /**
         * @param {string} phase
         * @param {number} startTime
         * @param {number} endTime
         * @param {Record<string, string|number|boolean|null>} [details]
         */
        const recordLocalPhase = (phase, startTime, endTime, details = {}) => {
            const elapsedMs = Math.max(0, endTime - startTime);
            localPhaseTimings.push({phase, elapsedMs, details});
            log.log(`[ImportTiming] [${sourceTitle}] phase ${phase} ${formatDurationMs(elapsedMs)} details=${JSON.stringify(details)}`);
        };

        log.log(`[ImportTiming] [${sourceTitle}] starting MDX import`);
        reportDiagnostics('dictionary-import-mdx-begin', {
            dictionaryTitle: sourceTitle,
            mddCount: source.mddFiles.length,
            sizeBytes: source.mdxFile.size,
            useImportSession,
            finalizeImportSession,
        });

        onProgress({nextStep: true, index: 0, count: 0});
        const readStartTime = safePerformance.now();
        const {mdxBytes, mddFiles, totalBytes} = await this._readMdxImportSourceBytes(source, onProgress);
        const readEndTime = safePerformance.now();
        recordLocalPhase('read-mdx-source', readStartTime, readEndTime, {
            mddCount: source.mddFiles.length,
            sizeBytes: totalBytes,
        });

        return await this._importDictionaryWithWorkerInvocation(
            sourceTitle,
            profilesDictionarySettings,
            useImportSession,
            finalizeImportSession,
            importStartTime,
            localPhaseTimings,
            recordLocalPhase,
            async () => await dictionaryWorker.importMdxDictionary(
                source.mdxFile.name,
                new Uint8Array(mdxBytes).buffer,
                mddFiles.map(({name, bytes}) => ({name, bytes: new Uint8Array(bytes).buffer})),
                {
                    ...importDetails,
                    ...(useImportSession ? {useImportSession: true, finalizeImportSession} : {}),
                },
                onProgress,
                {enableAudio: false},
            ),
        );
    }

    /**
     * @param {File} file
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {import('dictionary-importer').ImportDetails} importDetails
     * @param {DictionaryWorker} dictionaryWorker
     * @param {boolean} useImportSession
     * @param {boolean} finalizeImportSession
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @returns {Promise<Error[] | undefined>}
     */
    async _importDictionaryFromZip(file, profilesDictionarySettings, importDetails, dictionaryWorker, useImportSession, finalizeImportSession, onProgress) {
        const dictionaryTitle = file.name || 'unknown-dictionary';
        const importStartTime = safePerformance.now();
        /** @type {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} */
        const localPhaseTimings = [];
        /**
         * @param {string} phase
         * @param {number} startTime
         * @param {number} endTime
         * @param {Record<string, string|number|boolean|null>} [details]
         */
        const recordLocalPhase = (phase, startTime, endTime, details = {}) => {
            const elapsedMs = Math.max(0, endTime - startTime);
            localPhaseTimings.push({phase, elapsedMs, details});
            log.log(`[ImportTiming] [${dictionaryTitle}] phase ${phase} ${formatDurationMs(elapsedMs)} details=${JSON.stringify(details)}`);
        };

        log.log(`[ImportTiming] [${dictionaryTitle}] starting import`);
        reportDiagnostics('dictionary-import-zip-begin', {
            dictionaryTitle,
            sizeBytes: file.size,
            useImportSession,
            finalizeImportSession,
        });

        onProgress({nextStep: true, index: 0, count: 0});
        const readStartTime = safePerformance.now();
        const archiveContent = await this._readFile(file);
        const readEndTime = safePerformance.now();
        recordLocalPhase('read-archive', readStartTime, readEndTime, {
            sizeBytes: archiveContent.byteLength,
        });

        return await this._importDictionaryArchiveContent(
            dictionaryTitle,
            archiveContent,
            profilesDictionarySettings,
            importDetails,
            dictionaryWorker,
            useImportSession,
            finalizeImportSession,
            onProgress,
            importStartTime,
            localPhaseTimings,
            recordLocalPhase,
        );
    }

    /**
     * @param {string} dictionaryTitle
     * @param {ArrayBuffer} archiveContent
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {import('dictionary-importer').ImportDetails} importDetails
     * @param {DictionaryWorker} dictionaryWorker
     * @param {boolean} useImportSession
     * @param {boolean} finalizeImportSession
     * @param {import('dictionary-worker').ImportProgressCallback} onProgress
     * @param {number} importStartTime
     * @param {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} localPhaseTimings
     * @param {(phase: string, startTime: number, endTime: number, details?: Record<string, string|number|boolean|null>) => void} recordLocalPhase
     * @returns {Promise<Error[] | undefined>}
     */
    async _importDictionaryArchiveContent(dictionaryTitle, archiveContent, profilesDictionarySettings, importDetails, dictionaryWorker, useImportSession, finalizeImportSession, onProgress, importStartTime, localPhaseTimings, recordLocalPhase) {
        const archiveContentBytes = new Uint8Array(archiveContent);
        return await this._importDictionaryWithWorkerInvocation(
            dictionaryTitle,
            profilesDictionarySettings,
            useImportSession,
            finalizeImportSession,
            importStartTime,
            localPhaseTimings,
            recordLocalPhase,
            async () => await dictionaryWorker.importDictionary(
                new Uint8Array(archiveContentBytes).buffer,
                {
                    ...importDetails,
                    ...(useImportSession ? {useImportSession: true, finalizeImportSession} : {}),
                },
                onProgress,
            ),
        );
    }

    /**
     * @param {string} dictionaryTitle
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {boolean} useImportSession
     * @param {boolean} finalizeImportSession
     * @param {number} importStartTime
     * @param {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} localPhaseTimings
     * @param {(phase: string, startTime: number, endTime: number, details?: Record<string, string|number|boolean|null>) => void} recordLocalPhase
     * @param {() => Promise<import('dictionary-importer').ImportResult & {debug?: {usesFallbackStorage?: boolean, openStorageDiagnostics?: unknown, useImportSession?: boolean, finalizeImportSession?: boolean, importerDebug?: {phaseTimings?: Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>|null}|null}}>} invokeWorkerImport
     * @returns {Promise<Error[] | undefined>}
     */
    async _importDictionaryWithWorkerInvocation(dictionaryTitle, profilesDictionarySettings, useImportSession, finalizeImportSession, importStartTime, localPhaseTimings, recordLocalPhase, invokeWorkerImport) {
        const workerImportStartTime = safePerformance.now();
        /** @type {import('dictionary-importer').ImportResult & {debug?: {usesFallbackStorage?: boolean, openStorageDiagnostics?: unknown, useImportSession?: boolean, finalizeImportSession?: boolean, importerDebug?: {phaseTimings?: Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>|null}|null}}} */
        let importResult;
        const maxImportAttempts = 6;
        for (let attempt = 1; ; ++attempt) {
            try {
                importResult = await invokeWorkerImport();
            } catch (error) {
                const message = (error instanceof Error) ? error.message : String(error);
                const failureClass = classifyImportOpenFailure(message);
                const isRetryableThrown = (failureClass === 'lock-contention' || failureClass === 'transient-open-race');
                if (!isRetryableThrown || attempt >= maxImportAttempts) {
                    throw error;
                }
                log.log(`[ImportTiming] [${dictionaryTitle}] retrying import after transient open failure (${failureClass}) attempt ${attempt}`);
                await new Promise((resolve) => {
                    setTimeout(resolve, getImportRetryDelayMs(attempt));
                });
                continue;
            }
            const retryableImportError = Array.isArray(importResult.errors) && importResult.errors.some((error) => {
                const message = (error instanceof Error) ? error.message : String(error);
                const failureClass = classifyImportOpenFailure(message);
                return (failureClass === 'lock-contention' || failureClass === 'transient-open-race');
            });
            if (!retryableImportError || attempt >= maxImportAttempts) {
                break;
            }
            log.log(`[ImportTiming] [${dictionaryTitle}] retrying import after transient open failure in importer result (attempt ${attempt})`);
            await new Promise((resolve) => {
                setTimeout(resolve, getImportRetryDelayMs(attempt));
            });
        }
        const workerImportEndTime = safePerformance.now();
        log.log(`[ImportTiming] [${dictionaryTitle}] worker importDictionary ${formatDurationMs(workerImportEndTime - workerImportStartTime)}`);
        recordLocalPhase('worker-import-dictionary', workerImportStartTime, workerImportEndTime, {
            useImportSession,
            finalizeImportSession,
        });

        const {result, errors, debug} = importResult;
        const importerPhaseTimings = normalizeImporterPhaseTimings(debug?.importerDebug?.phaseTimings ?? null);
        reportDiagnostics('dictionary-import-worker-phase-summary', {
            dictionaryTitle,
            elapsedMs: Math.max(0, workerImportEndTime - workerImportStartTime),
            importerPhaseTimings,
            localPhaseTimings,
            memory: getImportMemorySnapshot(),
        });
        for (const phase of importerPhaseTimings) {
            log.log(
                `[ImportTiming] [${dictionaryTitle}] worker phase "${phase.phase}" ${formatDurationMs(phase.elapsedMs)}` +
                `${phase.details ? ` details=${JSON.stringify(phase.details)}` : ''}`,
            );
        }
        if (!result) {
            reportDiagnostics('dictionary-import-zip-no-result', {
                dictionaryTitle,
                errorCount: Array.isArray(errors) ? errors.length : -1,
                usesFallbackStorage: debug?.usesFallbackStorage ?? null,
                importerPhaseTimings,
                localPhaseTimings,
            });
            this._recordImportDebugSnapshot({
                dictionaryTitle,
                hasResult: false,
                resultTitle: null,
                errorCount: Array.isArray(errors) ? errors.length : -1,
                addSettingsErrorCount: null,
                fallbackDatabaseContentBase64Length: null,
                usesFallbackStorage: debug?.usesFallbackStorage ?? null,
                openStorageDiagnostics: debug?.openStorageDiagnostics ?? null,
                useImportSession: debug?.useImportSession ?? null,
                finalizeImportSession: debug?.finalizeImportSession ?? null,
                importerPhaseTimings,
                localPhaseTimings,
            });
            return errors;
        }

        if (debug?.usesFallbackStorage === true) {
            const fallbackError = new Error(`OPFS is required for import but fallback storage was detected. diagnostics=${JSON.stringify(debug.openStorageDiagnostics ?? null)}`);
            const errorsWithOpfsRequirement = [...errors, fallbackError];
            reportDiagnostics('dictionary-import-zip-opfs-fallback-detected', {
                dictionaryTitle,
                errorCount: errorsWithOpfsRequirement.length,
            });
            this._recordImportDebugSnapshot({
                dictionaryTitle,
                hasResult: false,
                resultTitle: result.title || null,
                errorCount: errorsWithOpfsRequirement.length,
                addSettingsErrorCount: null,
                fallbackDatabaseContentBase64Length: null,
                usesFallbackStorage: debug.usesFallbackStorage,
                openStorageDiagnostics: debug.openStorageDiagnostics ?? null,
                useImportSession: debug.useImportSession ?? null,
                finalizeImportSession: debug.finalizeImportSession ?? null,
                importerPhaseTimings,
                localPhaseTimings,
            });
            return errorsWithOpfsRequirement;
        }

        const addSettingsStartTime = safePerformance.now();
        const errors2 = await this._addDictionarySettings(result, profilesDictionarySettings);
        const addSettingsEndTime = safePerformance.now();
        log.log(`[ImportTiming] [${dictionaryTitle}] add dictionary settings ${formatDurationMs(addSettingsEndTime - addSettingsStartTime)}`);
        recordLocalPhase('add-dictionary-settings', addSettingsStartTime, addSettingsEndTime, {
            settingsErrorCount: errors2.length,
        });
        this._recordImportDebugSnapshot({
            dictionaryTitle,
            hasResult: true,
            resultTitle: result.title || null,
            errorCount: Array.isArray(errors) ? errors.length : -1,
            addSettingsErrorCount: errors2.length,
            fallbackDatabaseContentBase64Length: null,
            usesFallbackStorage: debug?.usesFallbackStorage ?? null,
            openStorageDiagnostics: debug?.openStorageDiagnostics ?? null,
            useImportSession: debug?.useImportSession ?? null,
            finalizeImportSession: debug?.finalizeImportSession ?? null,
            importerPhaseTimings,
            localPhaseTimings,
        });

        if (!(useImportSession && !finalizeImportSession)) {
            const triggerDatabaseUpdatedStartTime = safePerformance.now();
            await this._settingsController.application.api.triggerDatabaseUpdated('dictionary', 'import');
            const triggerDatabaseUpdatedEndTime = safePerformance.now();
            log.log(`[ImportTiming] [${dictionaryTitle}] triggerDatabaseUpdated ${formatDurationMs(triggerDatabaseUpdatedEndTime - triggerDatabaseUpdatedStartTime)}`);
            recordLocalPhase('trigger-database-updated', triggerDatabaseUpdatedStartTime, triggerDatabaseUpdatedEndTime);
        } else {
            log.log(`[ImportTiming] [${dictionaryTitle}] triggerDatabaseUpdated deferred until import session finalize`);
            localPhaseTimings.push({
                phase: 'trigger-database-updated',
                elapsedMs: 0,
                details: {deferred: true},
            });
        }

        if (profilesDictionarySettings !== null) {
            const profileUpdateStartTime = safePerformance.now();
            const options = await this._settingsController.getOptionsFull();
            const {profiles} = options;

            for (const profile of profiles) {
                for (const cardFormat of profile.options.anki.cardFormats) {
                    const ankiTermFields = cardFormat.fields;
                    const oldFieldSegmentRegex = new RegExp(getKebabCase(profilesDictionarySettings[profile.id].name), 'g');
                    const newFieldSegment = getKebabCase(result.title);
                    for (const key of Object.keys(ankiTermFields)) {
                        ankiTermFields[key].value = ankiTermFields[key].value.replace(oldFieldSegmentRegex, newFieldSegment);
                    }
                }
            }
            await this._settingsController.setAllSettings(options);
            const profileUpdateEndTime = safePerformance.now();
            log.log(`[ImportTiming] [${dictionaryTitle}] update profile dictionary references ${formatDurationMs(profileUpdateEndTime - profileUpdateStartTime)}`);
            recordLocalPhase('update-profile-dictionary-references', profileUpdateStartTime, profileUpdateEndTime);
        }

        const importEndTime = safePerformance.now();
        log.log(`[ImportTiming] [${dictionaryTitle}] total import path ${formatDurationMs(importEndTime - importStartTime)} (errors=${errors.length + errors2.length})`);
        reportDiagnostics('dictionary-import-zip-complete', {
            dictionaryTitle,
            elapsedMs: Math.max(0, importEndTime - importStartTime),
            importErrors: errors.length,
            settingsErrors: errors2.length,
            resultTitle: result.title || null,
            importerPhaseTimings,
            localPhaseTimings,
            memory: getImportMemorySnapshot(),
        });

        if (errors.length > 0) {
            errors.push(new Error(`Dictionary may not have been imported properly: ${errors.length} error${errors.length === 1 ? '' : 's'} reported.`));
            this._showErrors([...errors, ...errors2]);
        } else if (errors2.length > 0) {
            this._showErrors(errors2);
        }
    }

    /**
     * @param {import('dictionary-importer').Summary} summary
     * @param {import('settings-controller').ProfilesDictionarySettings} profilesDictionarySettings
     * @returns {Promise<Error[]>}
     */
    async _addDictionarySettings(summary, profilesDictionarySettings) {
        const {title, sequenced, styles} = summary;
        let optionsFull;
        // Workaround Firefox bug sometimes causing getOptionsFull to fail
        for (let i = 0, success = false; (i < 10) && (success === false); i++) {
            try {
                optionsFull = await this._settingsController.getOptionsFull();
                success = true;
            } catch (error) {
                log.error(error);
            }
        }
        if (!optionsFull) { return [new Error('Failed to automatically set dictionary settings. A page refresh and manual enabling of the dictionary may be required.')]; }

        const profileIndex = this._settingsController.profileIndex;
        /** @type {import('settings-modifications').Modification[]} */
        const targets = [];
        const profileCount = optionsFull.profiles.length;
        for (let i = 0; i < profileCount; ++i) {
            const {options, id: profileId} = optionsFull.profiles[i];
            const enabled = profileIndex === i;
            const defaultSettings = DictionaryController.createDefaultDictionarySettings(title, enabled, styles);
            const path1 = `profiles[${i}].options.dictionaries`;

            if (profilesDictionarySettings === null || typeof profilesDictionarySettings[profileId] === 'undefined') {
                targets.push({action: 'push', path: path1, items: [defaultSettings]});
            } else {
                const {index, alias, name, ...currentSettings} = profilesDictionarySettings[profileId];
                const newAlias = alias === name ? title : alias;
                targets.push({
                    action: 'splice',
                    path: path1,
                    start: index,
                    items: [{
                        ...currentSettings,
                        styles,
                        name: title,
                        alias: newAlias,
                    }],
                    deleteCount: 0,
                });
            }

            if (sequenced && options.general.mainDictionary === '') {
                const path2 = `profiles[${i}].options.general.mainDictionary`;
                targets.push({action: 'set', path: path2, value: title});
            }
        }
        return await this._modifyGlobalSettings(targets);
    }

    /**
     * @returns {Promise<Error[]>}
     */
    async _clearDictionarySettings() {
        const optionsFull = await this._settingsController.getOptionsFull();
        /** @type {import('settings-modifications').Modification[]} */
        const targets = [];
        const profileCount = optionsFull.profiles.length;
        for (let i = 0; i < profileCount; ++i) {
            const path1 = `profiles[${i}].options.dictionaries`;
            targets.push({action: 'set', path: path1, value: []});
            const path2 = `profiles[${i}].options.general.mainDictionary`;
            targets.push({action: 'set', path: path2, value: ''});
        }
        return await this._modifyGlobalSettings(targets);
    }

    /**
     * @returns {import('settings-controller').PageExitPrevention}
     */
    _preventPageExit() {
        return this._settingsController.preventPageExit();
    }

    /**
     * @param {Error[]} errors
     */
    _showErrors(errors) {
        reportDiagnostics('dictionary-import-errors-shown', {
            errorCount: errors.length,
            messages: errors.slice(0, 5).map((error) => this._errorToString(error)),
        });
        /** @type {Map<string, {count: number, error: Error}>} */
        const uniqueErrors = new Map();
        for (const error of errors) {
            const errorString = this._errorToString(error);
            const entry = uniqueErrors.get(errorString);
            if (typeof entry === 'undefined') {
                uniqueErrors.set(errorString, {count: 1, error});
            } else {
                entry.count += 1;
            }
        }

        for (const {error} of uniqueErrors.values()) {
            if (this._isDuplicateImportSkipError(error)) {
                log.warn(error);
            } else {
                log.error(error);
            }
        }

        const fragment = document.createDocumentFragment();
        for (const [e, {count}] of uniqueErrors.entries()) {
            const div = document.createElement('p');
            if (count > 1) {
                div.textContent = `${e} `;
                const em = document.createElement('em');
                em.textContent = `(${count})`;
                div.appendChild(em);
            } else {
                div.textContent = `${e}`;
            }
            fragment.appendChild(div);
        }

        const errorContainer = /** @type {HTMLElement} */ (this._errorContainer);
        errorContainer.appendChild(fragment);
        errorContainer.hidden = false;
    }

    /**
     * @param {Error} error
     * @returns {boolean}
     */
    _isDuplicateImportSkipError(error) {
        return DUPLICATE_IMPORT_SKIP_ERROR_PATTERN.test(error.message);
    }

    /** */
    _hideErrors() {
        const errorContainer = /** @type {HTMLElement} */ (this._errorContainer);
        errorContainer.textContent = '';
        errorContainer.hidden = true;
    }

    /**
     * @param {File} file
     * @returns {Promise<ArrayBuffer>}
     */
    _readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(/** @type {ArrayBuffer} */ (reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * @param {Error} error
     * @returns {string}
     */
    _errorToString(error) {
        const errorMessage = error.toString();

        for (const [match, newErrorString] of this._errorToStringOverrides) {
            if (errorMessage.includes(match)) {
                return newErrorString;
            }
        }

        return errorMessage;
    }

    /**
     * @param {boolean} value
     */
    _setModifying(value) {
        this._modifying = value;
        this._setButtonsEnabled(!value);
    }

    /**
     * @param {boolean} value
     */
    _setButtonsEnabled(value) {
        value = !value;
        for (const node of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.dictionary-database-mutating-input'))) {
            node.disabled = value;
        }
    }

    /**
     * @param {import('settings-modifications').Modification[]} targets
     * @returns {Promise<Error[]>}
     */
    async _modifyGlobalSettings(targets) {
        const results = await this._settingsController.modifyGlobalSettings(targets);
        const errors = [];
        for (const {error} of results) {
            if (typeof error !== 'undefined') {
                errors.push(ExtensionError.deserialize(error));
            }
        }
        return errors;
    }

    /** */
    _triggerStorageChanged() {
        this._settingsController.application.triggerStorageChanged();
    }
}

export class ImportProgressTracker {
    /**
     * @param {import('dictionary-importer').ImportSteps} steps
     * @param {number} dictionaryCount
     */
    constructor(steps, dictionaryCount) {
        /** @type {import('dictionary-importer').ImportSteps} */
        this._steps = steps;
        /** @type {number} */
        this._dictionaryCount = dictionaryCount;

        /** @type {number} */
        this._stepIndex = 0;
        /** @type {number} */
        this._dictionaryIndex = 0;
        /** @type {number} */
        this._importStartTime = safePerformance.now();
        /** @type {number} */
        this._dictionaryStartTime = this._importStartTime;
        /** @type {number} */
        this._stepStartTime = this._importStartTime;
        /** @type {number} */
        this._stepChangeCount = 0;
        /** @type {Array<Record<string, unknown>>} */
        this._stepTimingHistory = [];
        /** @type {ReturnType<typeof getImportMemorySnapshot>} */
        this._stepStartMemory = getImportMemorySnapshot();
        /** @type {ReturnType<typeof getImportMemorySnapshot>} */
        this._dictionaryStartMemory = this._stepStartMemory;

        const progressSelector = '.dictionary-import-progress';
        /** @type {NodeListOf<HTMLElement>} */
        this._progressBars = (document.querySelectorAll(`${progressSelector} .progress-bar`));
        /** @type {NodeListOf<HTMLElement>} */
        this._infoLabels = (document.querySelectorAll(`${progressSelector} .progress-info`));
        /** @type {NodeListOf<HTMLElement>} */
        this._statusLabels = (document.querySelectorAll(`${progressSelector} .progress-status`));
        /** @type {string} */
        this._lastInfoLabelText = '';
        /** @type {string} */
        this._lastStatusText = '';
        /** @type {number} */
        this._lastPercent = -1;

        this.onProgress({nextStep: false, index: 0, count: 0});
    }

    /** @type {string} */
    get statusPrefix() {
        return `Importing dictionary${this._dictionaryCount > 1 ? ` (${this._dictionaryIndex} of ${this._dictionaryCount})` : ''}`;
    }

    /** @type {import('dictionary-importer').ImportStep} */
    get currentStep() {
        return this._steps[this._stepIndex];
    }

    /** @type {number} */
    get stepCount() {
        return this._steps.length;
    }

    /** @type {number} */
    get dictionaryCount() {
        return this._dictionaryCount;
    }

    /**
     * @returns {Array<Record<string, unknown>>}
     */
    getStepTimingHistory() {
        return this._stepTimingHistory.map((item) => ({...item}));
    }

    /** @type {import('dictionary-worker').ImportProgressCallback} */
    onProgress(data) {
        const {nextStep, index, count} = data;
        const previousStepIndex = this._stepIndex;
        if (nextStep && this._steps.length > 0) {
            this._stepIndex = Math.min(this._stepIndex + 1, this._steps.length - 1);
        }
        const currentStep = this.currentStep;
        const currentLabel = currentStep?.label ?? 'Working';
        const currentStepDisplay = `Step ${this._stepIndex + 1} of ${this.stepCount}`;
        const labelText = `${this.statusPrefix} - ${currentStepDisplay}: ${currentLabel}...`;
        if (labelText !== this._lastInfoLabelText) {
            this._lastInfoLabelText = labelText;
            for (const label of this._infoLabels) { label.textContent = labelText; }
        }

        const hasFiniteCount = Number.isFinite(count) && count > 0;
        let percentRaw = hasFiniteCount ? (index / count * 100) : 0;
        // Avoid showing a misleading 100% while a non-final step is still open.
        if (!nextStep && hasFiniteCount && this._stepIndex < (this.stepCount - 1) && index >= count) {
            percentRaw = 99.99;
        }
        const percent = Math.max(0, Math.min(100, percentRaw));
        if (this._lastPercent < 0 || Math.abs(percent - this._lastPercent) >= 0.1) {
            this._lastPercent = percent;
            const cssString = `${percent.toFixed(2)}%`;
            for (const progressBar of this._progressBars) { progressBar.style.width = cssString; }
        }
        const statusString = `${Math.floor(percent).toFixed(0)}%`;
        if (statusString !== this._lastStatusText) {
            this._lastStatusText = statusString;
            for (const label of this._statusLabels) { label.textContent = statusString; }
        }

        if (currentStep && typeof currentStep.callback === 'function') {
            currentStep.callback();
        }

        if (nextStep && this._steps.length > 0 && this._stepIndex !== previousStepIndex) {
            const now = safePerformance.now();
            const completedStep = this._steps[previousStepIndex];
            const completedLabel = (typeof completedStep?.label === 'string' && completedStep.label.length > 0) ? completedStep.label : 'Starting import state';
            const stepDuration = now - this._stepStartTime;
            const stepEndMemory = getImportMemorySnapshot();
            const stepHeapDeltaBytes = getHeapDeltaBytes(this._stepStartMemory, stepEndMemory);
            log.log(`[ImportTiming] ${this.statusPrefix} completed Step ${previousStepIndex + 1} of ${this.stepCount} "${completedLabel}" in ${formatDurationMs(stepDuration)}`);
            const stepTiming = {
                dictionaryIndex: this._dictionaryIndex,
                dictionaryCount: this._dictionaryCount,
                stepIndex: previousStepIndex + 1,
                stepCount: this.stepCount,
                stepDisplay: `Step ${previousStepIndex + 1} of ${this.stepCount}`,
                label: completedLabel,
                uiLabelText: `${this.statusPrefix} - Step ${previousStepIndex + 1} of ${this.stepCount}: ${completedLabel}...`,
                nextUiLabelText: labelText,
                elapsedMs: Math.max(0, stepDuration),
                dictionaryElapsedMs: Math.max(0, now - this._dictionaryStartTime),
                totalElapsedMs: Math.max(0, now - this._importStartTime),
                memoryStart: this._stepStartMemory,
                memoryEnd: stepEndMemory,
                heapDeltaBytes: stepHeapDeltaBytes,
            };
            this._stepTimingHistory.push(stepTiming);
            if (this._stepTimingHistory.length > 256) {
                this._stepTimingHistory.splice(0, this._stepTimingHistory.length - 256);
            }
            reportDiagnostics('dictionary-import-step-complete', stepTiming);
            this._stepStartTime = now;
            this._stepStartMemory = stepEndMemory;
            this._stepChangeCount += 1;
        }
    }

    /** */
    onNextDictionary() {
        const now = safePerformance.now();
        if (this._dictionaryIndex > 0) {
            const previousDictionaryDuration = now - this._dictionaryStartTime;
            log.log(`[ImportTiming] dictionary ${this._dictionaryIndex}/${this._dictionaryCount} total progress phase time ${formatDurationMs(previousDictionaryDuration)}`);
        }
        this._dictionaryIndex += 1;
        this._stepIndex = 0;
        this._dictionaryStartTime = now;
        this._stepStartTime = now;
        this._dictionaryStartMemory = getImportMemorySnapshot();
        this._stepStartMemory = this._dictionaryStartMemory;
        log.log(`[ImportTiming] dictionary ${this._dictionaryIndex}/${this._dictionaryCount} started`);
        reportDiagnostics('dictionary-import-dictionary-start', {
            dictionaryIndex: this._dictionaryIndex,
            dictionaryCount: this._dictionaryCount,
            stepDisplay: `Step 1 of ${this.stepCount}`,
            totalElapsedMs: Math.max(0, now - this._importStartTime),
            memoryStart: this._dictionaryStartMemory,
        });
        this.onProgress({
            nextStep: true,
            index: 0,
            count: 0,
        });
    }

    /**
     * @param {number} errorCount
     */
    onImportComplete(errorCount) {
        const now = safePerformance.now();
        const currentStepLabel = this.currentStep?.label ?? `Step ${this._stepIndex + 1}`;
        const currentStepDuration = now - this._stepStartTime;
        const currentDictionaryDuration = now - this._dictionaryStartTime;
        const totalDuration = now - this._importStartTime;
        const memoryEnd = getImportMemorySnapshot();
        log.log(`[ImportTiming] ${this.statusPrefix} current step "${currentStepLabel}" open for ${formatDurationMs(currentStepDuration)}`);
        log.log(`[ImportTiming] dictionary ${this._dictionaryIndex}/${this._dictionaryCount} total progress phase time ${formatDurationMs(currentDictionaryDuration)}`);
        log.log(`[ImportTiming] all dictionaries progress phases complete in ${formatDurationMs(totalDuration)} (step-transitions=${this._stepChangeCount}, errors=${errorCount})`);
        const finalStepTiming = {
            dictionaryIndex: this._dictionaryIndex,
            dictionaryCount: this._dictionaryCount,
            stepIndex: this._stepIndex + 1,
            stepCount: this.stepCount,
            stepDisplay: `Step ${this._stepIndex + 1} of ${this.stepCount}`,
            label: currentStepLabel,
            elapsedMs: Math.max(0, currentStepDuration),
            dictionaryElapsedMs: Math.max(0, currentDictionaryDuration),
            totalElapsedMs: Math.max(0, totalDuration),
            memoryStart: this._stepStartMemory,
            memoryEnd,
            heapDeltaBytes: getHeapDeltaBytes(this._stepStartMemory, memoryEnd),
            finalOpenStep: true,
        };
        this._stepTimingHistory.push(finalStepTiming);
        if (this._stepTimingHistory.length > 256) {
            this._stepTimingHistory.splice(0, this._stepTimingHistory.length - 256);
        }
        reportDiagnostics('dictionary-import-step-final', finalStepTiming);
        reportDiagnostics('dictionary-import-progress-summary', {
            dictionaryIndex: this._dictionaryIndex,
            dictionaryCount: this._dictionaryCount,
            currentStepIndex: this._stepIndex + 1,
            currentStepDisplay: `Step ${this._stepIndex + 1} of ${this.stepCount}`,
            currentStepLabel,
            currentStepElapsedMs: Math.max(0, currentStepDuration),
            currentDictionaryElapsedMs: Math.max(0, currentDictionaryDuration),
            totalElapsedMs: Math.max(0, totalDuration),
            stepTransitions: this._stepChangeCount,
            errorCount,
            memoryStart: this._dictionaryStartMemory,
            memoryEnd,
            dictionaryHeapDeltaBytes: getHeapDeltaBytes(this._dictionaryStartMemory, memoryEnd),
            currentStepHeapDeltaBytes: getHeapDeltaBytes(this._stepStartMemory, memoryEnd),
        });
    }
}
