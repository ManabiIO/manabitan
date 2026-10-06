/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, beforeAll, describe, expect, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {PopupFactory} from '../ext/js/app/popup-factory.js';
import {CrossFrameAPI} from '../ext/js/comm/cross-frame-api.js';
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';
import {log} from '../ext/js/core/log.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {Display} from '../ext/js/display/display.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {createDomTest} from './fixtures/dom-test.js';
import {chrome, fetch} from './mocks/common.js';

const test = createDomTest();
/** @type {import('settings').ProfileOptions} */
let defaults;
beforeAll(async () => {
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', fetch);
    try {
        const util = new OptionsUtil();
        await util.prepare();
        defaults = util.getDefault().profiles[0].options;
    } finally { vi.unstubAllGlobals(); }
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {number} length
 * @param {boolean} [enabled]
 * @returns {import('settings').ProfileOptions}
 */
function options(length, enabled = true) {
    const result = structuredClone(defaults);
    result.scanning.length = length;
    result.general.enable = enabled;
    result.scanning.enableOnSearchPage = enabled;
    return result;
}

/** @returns {{application: import('../ext/js/application.js').Application, api: {optionsGet: import('vitest').Mock, getZoom: import('vitest').Mock, broadcastTab: import('vitest').Mock}, hotkeys: HotkeyHandler}} */
function environment() {
    const api = {optionsGet: vi.fn().mockResolvedValue(options(10)), getZoom: vi.fn().mockResolvedValue({zoomFactor: 1}), broadcastTab: vi.fn().mockResolvedValue(void 0)};
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (new EventDispatcher()));
    Object.assign(application, {
        api,
        tabId: 1,
        frameId: 1,
        webExtension: {unloaded: false},
        crossFrame: new CrossFrameAPI(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)), 1, 1),
    });
    const messages = {addListener: vi.fn(), removeListener: vi.fn()};
    vi.stubGlobal('chrome', {runtime: {onMessage: messages}});
    return {application, api, hotkeys: new HotkeyHandler()};
}

/**
 * @param {boolean} [prepared]
 * @returns {{frontend: Frontend, application: import('../ext/js/application.js').Application, api: ReturnType<typeof environment>['api'], hotkeys: HotkeyHandler}}
 */
function createFrontend(prepared = true) {
    const {application, api, hotkeys} = environment();
    const frontend = new Frontend({
        application,
        pageType: 'web',
        popupFactory: new PopupFactory(application),
        depth: 0,
        parentFrameId: null,
        parentPopupId: null,
        useProxyPopup: false,
        allowRootFramePopupProxy: true,
        hotkeyHandler: hotkeys,
        browser: 'chrome',
        canUseWindowPopup: true,
        childrenSupported: true,
    });
    frontend._prepared = prepared;
    vi.spyOn(frontend, '_updatePopup').mockResolvedValue(void 0);
    vi.spyOn(frontend, '_updateContentScale').mockImplementation(() => {});
    vi.spyOn(frontend, '_startPopupPrewarmForHover').mockImplementation(() => {});
    vi.spyOn(frontend, '_prepareSiteSpecific').mockImplementation(() => {});
    return {frontend, application, api, hotkeys};
}

describe('Frontend options ownership', () => {
    test('an obsolete dictionary rescan cannot clear newer selection', async ({window: _window}) => {
        const {frontend} = createFrontend();
        const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        vi.spyOn(frontend._textScanner, 'searchLast').mockImplementationOnce(() => {
            entered.resolve(); return pending.promise;
        }).mockResolvedValue(false);
        const clear = vi.spyOn(frontend, '_clearSelection').mockImplementation(() => {});
        const older = frontend._onDatabaseUpdated({type: 'dictionary', cause: 'import'});
        await entered.promise;
        await frontend.updateOptions();
        const count = clear.mock.calls.length;
        pending.resolve(false);
        await older;
        expect(clear).toHaveBeenCalledTimes(count);
    });

    test('late options cannot disable a scanner enabled by a newer profile', async ({window: _window}) => {
        const {frontend, api} = createFrontend();
        const older = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        api.optionsGet.mockImplementationOnce(() => {
            entered.resolve(); return older.promise;
        }).mockResolvedValueOnce(options(20, true));
        const first = frontend.updateOptions();
        await entered.promise;
        await frontend.updateOptions();
        older.resolve(options(10, false));
        await first;
        expect(frontend._textScanner.isEnabled()).toBe(true);
        expect(frontend._options?.scanning.length).toBe(20);
    });

    test('an obsolete popup wait cannot apply its old scanner configuration', async ({window: _window}) => {
        const {frontend, api} = createFrontend();
        const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        api.optionsGet.mockResolvedValueOnce(options(10)).mockResolvedValueOnce(options(20));
        const scannerOptions = vi.spyOn(frontend._textScanner, 'setOptions');
        vi.mocked(frontend._updatePopup).mockImplementationOnce(async () => {
            entered.resolve(); await pending.promise;
        });
        const first = frontend.updateOptions();
        await entered.promise;
        await frontend.updateOptions();
        pending.resolve();
        await first;
        expect(scannerOptions).toHaveBeenCalledTimes(1);
        expect(scannerOptions.mock.calls[0][0].scanLength).toBe(20);
    });

    test('an obsolete failure cannot hide or clear a newer successful lookup', async ({window: _window}) => {
        const {frontend, api} = createFrontend();
        const pending = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        api.optionsGet.mockImplementationOnce(() => {
            entered.resolve(); return pending.promise;
        }).mockResolvedValueOnce(options(20));
        const clear = vi.spyOn(frontend, '_clearSelection').mockImplementation(() => {});
        const first = frontend._onOptionsUpdated();
        await entered.promise;
        await frontend._onOptionsUpdated();
        const clearCount = clear.mock.calls.length;
        pending.reject(new Error('Obsolete options failure'));
        await first;
        expect(clear).toHaveBeenCalledTimes(clearCount);
        expect(frontend._textScanner.isEnabled()).toBe(true);
    });

    test('overlapping options notifications retain their active marker until both settle', async ({window: _window}) => {
        const {frontend} = createFrontend();
        const firstWait = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const secondWait = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        vi.spyOn(frontend, 'updateOptions').mockReturnValueOnce(firstWait.promise).mockReturnValueOnce(secondWait.promise);
        const first = frontend._onOptionsUpdated();
        const second = frontend._onOptionsUpdated();
        firstWait.resolve();
        await first;
        const activeWhileSecondPending = frontend._optionsUpdateSearchActive;
        secondWait.resolve();
        await second;
        expect(activeWhileSecondPending).toBe(true);
        expect(frontend._optionsUpdateSearchActive).toBe(false);
    });
});

describe('Frontend preparation', () => {
    test('successful preparation starts real prewarm after enabling the scanner', async ({window: _window}) => {
        const {frontend} = createFrontend(false);
        vi.mocked(frontend._startPopupPrewarmForHover).mockRestore();
        /** @type {boolean[]} */
        const popupStates = [];
        /** @type {boolean[]} */
        const lookupStates = [];
        vi.spyOn(frontend, '_prewarmPopupForHover').mockImplementation(async () => { popupStates.push(frontend._textScanner.isEnabled()); });
        vi.spyOn(frontend, '_prewarmLookupForHover').mockImplementation(async () => { lookupStates.push(frontend._textScanner.isEnabled()); });
        await frontend.prepare();
        expect(popupStates).toContain(true);
        expect(lookupStates).toContain(true);
    });

    test('preparation follows a newer options request rather than enabling stale settings', async ({window: _window}) => {
        const {frontend, api} = createFrontend(false);
        const pending = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        api.optionsGet.mockImplementationOnce(() => {
            entered.resolve(); return pending.promise;
        }).mockResolvedValueOnce(options(20, false));
        const preparation = frontend.prepare();
        await entered.promise;
        await frontend.updateOptions();
        pending.reject(new Error('Retired preparation request'));
        await preparation;
        expect(frontend._prepared).toBe(true);
        expect(frontend._options?.scanning.length).toBe(20);
        expect(frontend._textScanner.isEnabled()).toBe(false);
    });

    test('concurrent preparation shares one attempt and success is idempotent', async ({window: _window}) => {
        const {frontend, api} = createFrontend(false);
        const pending = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        api.optionsGet.mockReturnValue(pending.promise);
        const first = frontend.prepare();
        const second = frontend.prepare();
        pending.resolve(options(10));
        await Promise.all([first, second]);
        await frontend.prepare();
        expect(second).toBe(first);
        expect(api.optionsGet).toHaveBeenCalledTimes(1);
        expect(api.broadcastTab).toHaveBeenCalledTimes(1);
    });

    for (const stage of ['options', 'site', 'ready']) {
        test(`failure during ${stage} is cleaned up and the same instance can retry`, async ({window: _window}) => {
            const {frontend, api, application, hotkeys} = createFrontend(false);
            const original = vi.fn();
            hotkeys.registerActions([['profilePrevious', original]]);
            const error = new Error(`Injected ${stage} failure`);
            if (stage === 'options') { api.optionsGet.mockRejectedValueOnce(error); }
            if (stage === 'site') {
                vi.mocked(frontend._prepareSiteSpecific).mockImplementationOnce(() => { throw error; });
            }
            if (stage === 'ready') {
                vi.spyOn(frontend, '_signalFrontendReady').mockImplementationOnce(() => { throw error; });
            }
            await expect(frontend.prepare()).rejects.toBe(error);
            expect(frontend._prepared).toBe(false);
            expect(frontend._textScanner.isEnabled()).toBe(false);
            expect(application.hasListeners('optionsUpdated')).toBe(false);
            expect(Reflect.get(application.crossFrame, '_apiMap').size).toBe(0);
            expect(Reflect.get(hotkeys, '_actions').get('profilePrevious')).toBe(original);
            await frontend.prepare();
            expect(frontend._prepared).toBe(true);
            expect(frontend._textScanner.isEnabled()).toBe(true);
            expect(application.hasListeners('optionsUpdated')).toBe(true);
            expect(Reflect.get(application.crossFrame, '_apiMap').size).toBe(5);
        });
    }

    test('fullscreen events do not become options contexts', async ({window}) => {
        const {frontend} = createFrontend(false);
        await frontend.prepare();
        const update = vi.mocked(frontend._updatePopup);
        update.mockClear();
        window.document.dispatchEvent(new window.Event('fullscreenchange'));
        expect(update).toHaveBeenCalledExactlyOnceWith();
    });

    test('cleanup failure finishes other cleanup and blocks unsafe duplicate registration', async ({window}) => {
        const {frontend, application, api, hotkeys} = createFrontend(false);
        const original = vi.fn();
        hotkeys.registerActions([['profilePrevious', original]]);
        vi.spyOn(frontend, '_signalFrontendReady').mockImplementationOnce(() => { throw new Error('Setup failed'); });
        vi.spyOn(window, 'removeEventListener').mockImplementationOnce(() => { throw new Error('Removal failed'); });
        const failure = await frontend.prepare().catch((error) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors.map(/**
                                   * @param {Error} error
                                   * @returns {string}
                                   */ (error) => error.message,
        )).toStrictEqual(['Setup failed', 'Removal failed']);
        expect(Reflect.get(application.crossFrame, '_apiMap').size).toBe(0);
        expect(Reflect.get(hotkeys, '_actions').get('profilePrevious')).toBe(original);
        await expect(frontend.prepare()).rejects.toBe(failure);
        expect(api.optionsGet).toHaveBeenCalledTimes(1);
    });
});

test('failed retired popup acquisition cannot evict its cache replacement', async ({window: _window}) => {
    const {frontend} = createFrontend();
    const pending = /** @type {PromiseWithResolvers<null>} */ (Promise.withResolvers());
    const old = frontend._cachePopup('default', pending.promise);
    const observed = old.catch((error) => error);
    const replacement = frontend._cachePopup('default', Promise.resolve(null));
    const error = new Error('Retired acquisition');
    pending.reject(error);
    expect(await observed).toBe(error);
    expect(frontend._popupCache.get('default')).toBe(replacement);
});

test('root-frame offset fallback owns popup refresh rejection', async ({window: _window}) => {
    const {frontend} = createFrontend();
    const popup = {on: vi.fn()};
    vi.spyOn(frontend, '_waitForFrontendReady').mockResolvedValue(void 0);
    vi.spyOn(frontend._application.crossFrame, 'invoke').mockResolvedValue(/** @type {never} */ ({popupId: 'root'}));
    vi.spyOn(frontend._popupFactory, 'getOrCreatePopup').mockResolvedValue(/** @type {import('popup').PopupAny} */ (/** @type {unknown} */ (popup)));
    await frontend._getIframeProxyPopup();
    const error = new Error('Fallback popup unavailable');
    const failed = Promise.reject(error);
    // Observe the rejection independently so the pre-fix repro reports an assertion failure.
    await failed.catch(() => {});
    const ownership = vi.spyOn(failed, 'catch');
    vi.mocked(frontend._updatePopup).mockReturnValue(failed);
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    popup.on.mock.calls[0][1]();
    await Promise.resolve();
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(frontend._allowRootFramePopupProxy).toBe(false);
});

test('overlapping popup acquisition is shared and uses the latest captured context', async ({window: _window}) => {
    const {frontend} = createFrontend();
    const pending = /** @type {PromiseWithResolvers<import('popup').PopupAny>} */ (Promise.withResolvers());
    const acquire = vi.spyOn(frontend, '_getDefaultPopup').mockReturnValue(pending.promise);
    const contextRead = vi.spyOn(frontend, '_getOptionsContext');
    const popup = {setOptionsContext: vi.fn().mockResolvedValue(void 0), on: vi.fn(), off: vi.fn()};
    frontend._options = options(10);
    const firstContext = {depth: 0, url: 'https://old.test'};
    const latestContext = {depth: 0, url: 'https://latest.test'};
    const first = Frontend.prototype._updatePopup.call(frontend, firstContext);
    const second = Frontend.prototype._updatePopup.call(frontend, latestContext);
    pending.resolve(/** @type {import('popup').PopupAny} */ (/** @type {unknown} */ (popup)));
    await Promise.all([first, second]);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(contextRead).not.toHaveBeenCalled();
    expect(popup.setOptionsContext).toHaveBeenCalledExactlyOnceWith(latestContext);
    expect(frontend._popup).toBe(popup);
});

for (const mode of ['default', 'proxy', 'window', 'iframe']) {
    test(`${mode} popup creation retries after a transient failure`, async ({window}) => {
        const {frontend} = createFrontend();
        const error = new Error('Transient popup creation failure');
        const popup = {setOptionsContext: vi.fn().mockResolvedValue(void 0), on: vi.fn(), off: vi.fn()};
        vi.spyOn(frontend._popupFactory, 'getOrCreatePopup').mockRejectedValueOnce(error).mockResolvedValue(/** @type {import('popup').PopupAny} */ (/** @type {unknown} */ (popup)));
        frontend._options = options(10);
        frontend._options.general.usePopupWindow = mode === 'window';
        frontend._options.general.showIframePopupsInRootFrame = mode === 'iframe';
        frontend._useProxyPopup = mode === 'proxy';
        frontend._parentFrameId = 1;
        frontend._parentPopupId = 'parent';
        Object.defineProperty(window, 'parent', {value: mode === 'iframe' ? {} : window});
        vi.spyOn(frontend, '_getOptionsContext').mockResolvedValue({depth: 0, url: 'https://example.test'});
        vi.spyOn(frontend, '_waitForFrontendReady').mockResolvedValue(void 0);
        vi.spyOn(frontend._application.crossFrame, 'invoke').mockResolvedValue(/** @type {never} */ ({popupId: 'root'}));
        await expect(Frontend.prototype._updatePopup.call(frontend)).rejects.toBe(error);
        await Frontend.prototype._updatePopup.call(frontend);
        expect(frontend._popupFactory.getOrCreatePopup).toHaveBeenCalledTimes(2);
        expect(frontend._popup).toBe(popup);
    });
}

for (const stage of ['options', 'ready']) {
    test(`nested frontend remains unpublished on ${stage} failure and reuses one factory on retry`, async ({window}) => {
        const {application, api, hotkeys} = environment();
        const display = /** @type {Display} */ (Object.create(Display.prototype));
        Object.assign(display, {
            _application: application,
            _hotkeyHandler: hotkeys,
            _pageType: 'search',
            _childrenSupported: true,
            _depth: 0,
            _frontend: null,
            _frontendPending: null,
            _frontendSetupPromise: null,
            _parentFrameId: null,
            _parentPopupId: null,
            _browser: 'chrome',
        });
        const error = new Error('Nested setup failed');
        vi.spyOn(log, 'error').mockImplementation(() => {});
        vi.spyOn(Frontend.prototype, '_updatePopup').mockResolvedValue(void 0);
        vi.spyOn(Frontend.prototype, '_startPopupPrewarmForHover').mockImplementation(() => {});
        vi.spyOn(Frontend.prototype, '_updateContentScale').mockImplementation(() => {});
        vi.spyOn(Frontend.prototype, '_prepareSiteSpecific').mockImplementation(() => {});
        if (stage === 'options') { api.optionsGet.mockRejectedValueOnce(error); }
        if (stage === 'ready') {
            vi.spyOn(Frontend.prototype, '_signalFrontendReady').mockImplementationOnce(() => { throw error; });
        }
        const added = vi.spyOn(window, 'addEventListener');
        await display._updateNestedFrontend(options(10));
        const pending = display._frontendPending;
        expect(display._frontend).toBeNull();
        expect(pending).not.toBeNull();
        expect(Reflect.get(application.crossFrame, '_apiMap').size).toBe(19);
        expect(Reflect.get(application.crossFrame, '_apiMap').has('popupFactoryCancelPublication')).toBe(true);
        await display._updateNestedFrontend(options(10));
        expect(display._frontend).toBe(pending?.frontend);
        expect(display._frontendPending).toBeNull();
        expect(Reflect.get(application.crossFrame, '_apiMap').size).toBe(24);
        expect(added.mock.calls.filter(([name]) => name === 'message')).toHaveLength(1);
        expect(display._frontend?.popup).toBeNull();
    });
}
