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

import {API} from './comm/api.js';
import {CrossFrameAPI} from './comm/cross-frame-api.js';
import {createApiMap, invokeApiMapHandler} from './core/api-map.js';
import {EventDispatcher} from './core/event-dispatcher.js';
import {ExtensionError} from './core/extension-error.js';
import {log} from './core/log.js';
import {deferPromise} from './core/utilities.js';
import {WebExtension} from './extension/web-extension.js';

const backendStartupFailureStorageKey = 'manabitanLastBackendStartupError';
const backendReadyTimeoutMs = 15_000;
const startupMessageRetryDelayMs = 100;
const mediaDrawingWorkerRestartWindowMs = 30_000;
const mediaDrawingWorkerMaxRestartsPerWindow = 3;

/**
 * @returns {boolean}
 */
function checkChromeNotAvailable() {
    let hasChrome = false;
    let hasBrowser = false;
    try {
        hasChrome = (typeof chrome === 'object' && chrome !== null && typeof chrome.runtime !== 'undefined');
    } catch (e) {
        // NOP
    }
    try {
        hasBrowser = (typeof browser === 'object' && browser !== null && typeof browser.runtime !== 'undefined');
    } catch (e) {
        // NOP
    }
    return (hasBrowser && !hasChrome);
}

// Set up chrome alias if it's not available (Edge Legacy)
if (checkChromeNotAvailable()) {
    // @ts-expect-error - objects should have roughly the same interface
    // eslint-disable-next-line no-global-assign
    chrome = browser;
}

/**
 * @returns {Promise<string>}
 */
async function getStoredBackendStartupFailureMessage() {
    for (const storageArea of [chrome.storage?.session, chrome.storage?.local]) {
        if (!(storageArea && typeof storageArea.get === 'function')) { continue; }
        try {
            const result = await storageArea.get(backendStartupFailureStorageKey);
            const value = /** @type {unknown} */ (Reflect.get(result, backendStartupFailureStorageKey));
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                const errorMessage = /** @type {unknown} */ (Reflect.get(value, 'errorMessage'));
                if (typeof errorMessage === 'string' && errorMessage.length > 0) {
                    return errorMessage;
                }
            }
        } catch (_) {
            // NOP
        }
    }
    return '';
}

/**
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableRuntimeDisconnectError(error) {
    const {message} = error;
    return (
        message.includes('Receiving end does not exist') ||
        message.includes('Could not establish connection') ||
        message.includes('The message port closed before a response was received')
    );
}

/**
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
function sleep(delayMs) {
    return new Promise((resolve) => {
        globalThis.setTimeout(resolve, delayMs);
    });
}

/**
 * @param {WebExtension} webExtension
 * @param {unknown} message
 * @param {number} [attempts]
 * @returns {Promise<unknown>}
 */
async function sendExtensionMessageWithRetry(webExtension, message, attempts = 2) {
    let remainingAttempts = attempts;
    for (;;) {
        if (webExtension.unloaded) {
            throw new Error('Lost connection to the extension runtime. Refresh this page to reconnect.');
        }
        try {
            return await webExtension.sendMessagePromise(message);
        } catch (error) {
            if (!(error instanceof Error) || remainingAttempts <= 1 || !isRetryableRuntimeDisconnectError(error)) {
                throw error;
            }
            remainingAttempts -= 1;
            if (webExtension.unloaded) {
                throw new Error('Lost connection to the extension runtime. Refresh this page to reconnect.');
            }
            await sleep(startupMessageRetryDelayMs);
        }
    }
}

/**
 * @param {WebExtension} webExtension
 */
async function waitForBackendReady(webExtension) {
    const {promise, resolve} = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
    /** @type {import('application').ApiMap} */
    const apiMap = createApiMap([['applicationBackendReady', () => { resolve(); }]]);
    /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
    const onMessage = ({action, params}, _sender, callback) => invokeApiMapHandler(apiMap, action, params, [], callback);
    const onUnloaded = () => {
        resolve();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    webExtension.on('unloaded', onUnloaded);
    let timeoutId = null;
    let unloaded = false;
    try {
        await sendExtensionMessageWithRetry(webExtension, {action: 'requestBackendReadySignal'});
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(async () => {
                const storedFailureMessage = await getStoredBackendStartupFailureMessage();
                const suffix = storedFailureMessage.length > 0 ? ` Startup failure: ${storedFailureMessage}` : '';
                reject(new Error(`Timed out waiting for backend ready signal after ${String(backendReadyTimeoutMs)}ms.${suffix}`));
            }, backendReadyTimeoutMs);
        });
        await Promise.race([
            promise.then(() => {
                unloaded = webExtension.unloaded;
            }),
            timeoutPromise,
        ]);
        if (unloaded) {
            throw new Error('Lost connection to the extension runtime while waiting for backend startup. Refresh this page to reconnect.');
        }
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        chrome.runtime.onMessage.removeListener(onMessage);
        webExtension.off('unloaded', onUnloaded);
    }
}

/**
 * @param {unknown} error
 * @returns {void}
 */
function showStartupFailureUi(error) {
    if (!(window.location.protocol === new URL(import.meta.url).protocol)) { return; }
    const message = error instanceof Error ? error.message : String(error);
    try {
        document.documentElement.dataset.loadingStalled = 'true';
        document.documentElement.dataset.loadingError = 'true';
        if (document.body !== null) {
            document.body.hidden = false;
        }
        let container = document.querySelector('#startup-error-message');
        if (!(container instanceof HTMLElement)) {
            container = document.createElement('div');
            container.id = 'startup-error-message';
            container.style.whiteSpace = 'pre-wrap';
            container.style.margin = '16px';
            container.style.padding = '12px 16px';
            container.style.border = '1px solid rgba(208, 2, 27, 0.35)';
            container.style.background = 'rgba(208, 2, 27, 0.08)';
            container.style.color = '#7a1020';
            container.style.fontFamily = 'monospace';
            container.style.fontSize = '13px';
            container.style.lineHeight = '1.5';
            if (document.body !== null) {
                document.body.prepend(container);
            }
        }
        container.textContent = (
            'Manabitan failed to start the dictionary backend.\n' +
            `error=${message}`
        );
    } catch (_) {
        // NOP
    }
}

/**
 * @param {string} message
 * @returns {void}
 */
function showRuntimeDisconnectedUi(message) {
    if (!(window.location.protocol === new URL(import.meta.url).protocol)) { return; }
    try {
        document.documentElement.dataset.loadingStalled = 'true';
        document.documentElement.dataset.loadingError = 'true';
        if (document.body !== null) {
            document.body.hidden = false;
        }
        let container = document.querySelector('#startup-error-message');
        if (!(container instanceof HTMLElement)) {
            container = document.createElement('div');
            container.id = 'startup-error-message';
            container.style.whiteSpace = 'pre-wrap';
            container.style.margin = '16px';
            container.style.padding = '12px 16px';
            container.style.border = '1px solid rgba(208, 2, 27, 0.35)';
            container.style.background = 'rgba(208, 2, 27, 0.08)';
            container.style.color = '#7a1020';
            container.style.fontFamily = 'monospace';
            container.style.fontSize = '13px';
            container.style.lineHeight = '1.5';
            if (document.body !== null) {
                document.body.prepend(container);
            }
        }
        container.textContent = message;
    } catch (_) {
        // NOP
    }
}

/**
 * @returns {Promise<void>}
 */
function waitForDomContentLoaded() {
    return new Promise((resolve) => {
        if (document.readyState !== 'loading') {
            resolve();
            return;
        }
        const onDomContentLoaded = () => {
            document.removeEventListener('DOMContentLoaded', onDomContentLoaded);
            resolve();
        };
        document.addEventListener('DOMContentLoaded', onDomContentLoaded);
    });
}

/**
 * @returns {MessagePort}
 */
function createFirefoxBackendPort() {
    const sharedWorkerBridge = new SharedWorker(new URL('comm/shared-worker-bridge.js', import.meta.url), {type: 'module'});
    const backendChannel = new MessageChannel();
    try {
        sharedWorkerBridge.port.postMessage({action: 'connectToBackend1'}, [backendChannel.port1]);
        sharedWorkerBridge.port.close();
        return backendChannel.port2;
    } catch (error) {
        try {
            sharedWorkerBridge.port.close();
        } catch (_) {
            // NOP
        }
        try {
            backendChannel.port1.close();
        } catch (_) {
            // NOP
        }
        try {
            backendChannel.port2.close();
        } catch (_) {
            // NOP
        }
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Failed to initialize Firefox backend bridge. You may need to refresh the page. ${normalizedError.message}`);
    }
}

/**
 * @returns {Worker}
 */
function createMediaDrawingWorker() {
    return new Worker(new URL('display/media-drawing-worker.js', import.meta.url), {type: 'module'});
}

/**
 * The Yomitan class is a core component through which various APIs are handled and invoked.
 * @augments EventDispatcher<import('application').Events>
 */
export class Application extends EventDispatcher {
    /**
     * Creates a new instance. The instance should not be used until it has been fully prepare()'d.
     * @param {API} api
     * @param {CrossFrameAPI} crossFrameApi
     */
    constructor(api, crossFrameApi) {
        super();
        /** @type {WebExtension} */
        this._webExtension = new WebExtension();
        /** @type {?boolean} */
        this._isBackground = null;
        /** @type {API} */
        this._api = api;
        /** @type {CrossFrameAPI} */
        this._crossFrame = crossFrameApi;
        /** @type {boolean} */
        this._isReady = false;
        /* eslint-disable @stylistic/no-multi-spaces */
        /** @type {import('application').ApiMap} */
        this._apiMap = createApiMap([
            ['applicationIsReady',         this._onMessageIsReady.bind(this)],
            ['applicationGetUrl',          this._onMessageGetUrl.bind(this)],
            ['applicationOptionsUpdated',  this._onMessageOptionsUpdated.bind(this)],
            ['applicationDatabaseUpdated', this._onMessageDatabaseUpdated.bind(this)],
            ['applicationZoomChanged',     this._onMessageZoomChanged.bind(this)],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */
    }

    /** @type {WebExtension} */
    get webExtension() {
        return this._webExtension;
    }

    /**
     * Gets the API instance for communicating with the backend.
     * This value will be null on the background page/service worker.
     * @type {API}
     */
    get api() {
        return this._api;
    }

    /**
     * Gets the CrossFrameAPI instance for communicating with different frames.
     * This value will be null on the background page/service worker.
     * @type {CrossFrameAPI}
     */
    get crossFrame() {
        return this._crossFrame;
    }

    /**
     * @type {?number}
     */
    get tabId() {
        return this._crossFrame.tabId;
    }

    /**
     * @type {?number}
     */
    get frameId() {
        return this._crossFrame.frameId;
    }

    /**
     * Prepares the instance for use.
     */
    prepare() {
        chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
        log.on('logGenericError', this._onLogGenericError.bind(this));
    }

    /**
     * Sends a message to the backend indicating that the frame is ready and all script
     * setup has completed.
     */
    ready() {
        if (this._isReady) { return; }
        this._isReady = true;
        void sendExtensionMessageWithRetry(this._webExtension, {action: 'applicationReady'}).catch((error) => {
            log.error(error);
        });
    }

    /** */
    triggerStorageChanged() {
        this.trigger('storageChanged', {});
    }

    /** */
    triggerClosePopups() {
        this.trigger('closePopups', {});
    }

    /**
     * @param {boolean} waitForDom
     * @param {(application: Application) => (Promise<void>)} mainFunction
     */
    static async main(waitForDom, mainFunction) {
        const supportsServiceWorker = 'serviceWorker' in navigator; // Basically, all browsers except Firefox. But it's possible Firefox will support it in the future, so we check in this fashion to be future-proof.
        const inExtensionContext = window.location.protocol === new URL(import.meta.url).protocol; // This code runs both in content script as well as in the iframe, so we need to differentiate the situation
        /** @type {MessagePort | null} */
        // If this is Firefox, we don't have a service worker and can't postMessage,
        // so we temporarily create a SharedWorker in order to establish a MessageChannel
        // which we can use to postMessage with the backend.
        // This can only be done in the extension context (aka iframe within popup),
        // not in the content script context.
        const backendPort = !supportsServiceWorker && inExtensionContext ?
            createFirefoxBackendPort() :
            null;

        const webExtension = new WebExtension();
        log.configure(webExtension.extensionName);

        /** @type {Worker|null} */
        let mediaDrawingWorker = null;
        const api = new API(webExtension, null, backendPort);
        /** @type {Promise<void>|null} */
        let restartingMediaDrawingWorkerPromise = null;
        /** @type {number|null} */
        let heartbeatInterval = null;
        /** @type {boolean} */
        let runtimeResourcesClosed = false;
        /** @type {number[]} */
        let mediaDrawingWorkerRestartTimes = [];
        /**
         * @param {string} reason
         * @returns {Promise<void>}
         */
        const restartMediaDrawingWorker = async (reason) => {
            if (runtimeResourcesClosed) { return; }
            if (!inExtensionContext) { return; }
            if (restartingMediaDrawingWorkerPromise !== null) {
                await restartingMediaDrawingWorkerPromise;
                return;
            }
            restartingMediaDrawingWorkerPromise = (async () => {
                const now = Date.now();
                mediaDrawingWorkerRestartTimes = mediaDrawingWorkerRestartTimes.filter((time) => (now - time) < mediaDrawingWorkerRestartWindowMs);
                if (reason !== 'initial' && mediaDrawingWorkerRestartTimes.length >= mediaDrawingWorkerMaxRestartsPerWindow) {
                    closeRuntimeResources();
                    showRuntimeDisconnectedUi(
                        'Manabitan repeatedly lost its media rendering worker.\n' +
                        'Refresh this page to reconnect.',
                    );
                    throw new Error('Media drawing worker restart limit exceeded');
                }
                try {
                    mediaDrawingWorker?.terminate();
                } catch (_) {
                    // NOP
                }
                const nextWorker = createMediaDrawingWorker();
                if (runtimeResourcesClosed) {
                    try {
                        nextWorker.terminate();
                    } catch (_) {
                        // NOP
                    }
                    throw new Error('Media drawing worker startup was interrupted by runtime shutdown');
                }
                nextWorker.addEventListener('error', (event) => {
                    if (runtimeResourcesClosed) { return; }
                    const message = typeof event.message === 'string' && event.message.length > 0 ? event.message : 'unknown media worker failure';
                    log.error(new Error(`Media drawing worker failed: ${message}`));
                    void restartMediaDrawingWorker('error');
                });
                nextWorker.addEventListener('messageerror', () => {
                    if (runtimeResourcesClosed) { return; }
                    log.error(new Error('Media drawing worker message deserialization failed'));
                    void restartMediaDrawingWorker('messageerror');
                });
                mediaDrawingWorker = nextWorker;
                api.setMediaDrawingWorker(nextWorker);
                if (reason !== 'initial') {
                    mediaDrawingWorkerRestartTimes.push(now);
                    log.error(new Error(`Media drawing worker restarted after ${reason}`));
                }
            })();
            try {
                await restartingMediaDrawingWorkerPromise;
            } finally {
                restartingMediaDrawingWorkerPromise = null;
            }
        };
        /**
         * @returns {void}
         */
        const closeRuntimeResources = () => {
            if (runtimeResourcesClosed) { return; }
            runtimeResourcesClosed = true;
            if (heartbeatInterval !== null) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            api.shutdownRuntimeConnections();
            if (mediaDrawingWorker !== null) {
                try {
                    mediaDrawingWorker.terminate();
                } catch (_) {
                    // NOP
                }
                mediaDrawingWorker = null;
            }
        };
        webExtension.on('unloaded', () => {
            closeRuntimeResources();
            showRuntimeDisconnectedUi(
                'Manabitan lost its connection to the extension runtime.\n' +
                'Refresh this page to reconnect.',
            );
        });
        if (inExtensionContext) {
            await restartMediaDrawingWorker('initial');
        }
        /** @type {boolean} */
        let heartbeatFailureLogged = false;
        let startupCompleted = false;
        try {
            await waitForBackendReady(webExtension);
            if (mediaDrawingWorker !== null) {
                await api.ensureMediaDrawingWorkerConnected();
            }
            heartbeatInterval = setInterval(() => {
                void api.heartbeat().then(() => {
                    heartbeatFailureLogged = false;
                }).catch((error) => {
                    if (heartbeatFailureLogged) { return; }
                    heartbeatFailureLogged = true;
                    log.error(error);
                });
            }, 20 * 1000);

            const {tabId, frameId} = await api.frameInformationGet();
            const crossFrameApi = new CrossFrameAPI(api, tabId, frameId);
            crossFrameApi.prepare();
            const application = new Application(api, crossFrameApi);
            application.prepare();
            if (waitForDom) { await waitForDomContentLoaded(); }
            await mainFunction(application);
            startupCompleted = true;
        } catch (error) {
            closeRuntimeResources();
            showStartupFailureUi(error);
            log.error(error);
            throw error;
        } finally {
            if (!startupCompleted) {
                closeRuntimeResources();
            }
        }
    }

    // Private

    /**
     * @returns {string}
     */
    _getUrl() {
        return location.href;
    }

    /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
    _onMessage({action, params}, _sender, callback) {
        return invokeApiMapHandler(this._apiMap, action, params, [], callback);
    }

    /** @type {import('application').ApiHandler<'applicationIsReady'>} */
    _onMessageIsReady() {
        return this._isReady;
    }

    /** @type {import('application').ApiHandler<'applicationGetUrl'>} */
    _onMessageGetUrl() {
        return {url: this._getUrl()};
    }

    /** @type {import('application').ApiHandler<'applicationOptionsUpdated'>} */
    _onMessageOptionsUpdated({source}) {
        if (source !== 'background') {
            this.trigger('optionsUpdated', {source});
        }
    }

    /** @type {import('application').ApiHandler<'applicationDatabaseUpdated'>} */
    _onMessageDatabaseUpdated({type, cause}) {
        this.trigger('databaseUpdated', {type, cause});
    }

    /** @type {import('application').ApiHandler<'applicationZoomChanged'>} */
    _onMessageZoomChanged({oldZoomFactor, newZoomFactor}) {
        this.trigger('zoomChanged', {oldZoomFactor, newZoomFactor});
    }

    /**
     * @param {import('log').Events['logGenericError']} params
     */
    async _onLogGenericError({error, level, context}) {
        try {
            await this._api.logGenericErrorBackend(ExtensionError.serialize(error), level, context);
        } catch (e) {
            // NOP
        }
    }
}
