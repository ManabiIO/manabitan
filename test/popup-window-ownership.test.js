/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {expect, test, vi} from 'vitest';
import {PopupWindow} from '../ext/js/app/popup-window.js';

function createPopup() {
    const create = vi.fn(/** @returns {Promise<{tabId: ?number, windowId: number}>} */ async () => ({tabId: 7, windowId: 70}));
    const invoke = vi.fn().mockResolvedValue(void 0);
    const visible = vi.fn().mockResolvedValue(true);
    const webExtension = {unloaded: false};
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api: {getOrCreateSearchPopup: create, isTabSearchPopup: visible},
        crossFrame: {invokeTab: invoke},
        webExtension,
    }));
    return {popup: new PopupWindow(application, 'window', 0, 0), create, invoke, visible, webExtension};
}

/** @type {import('popup').ContentDetails} */
const outer = {optionsContext: null, sourceRects: [], writingMode: 'horizontal-tb'};

/**
 * @param {string} query
 * @returns {import('display').ContentDetails}
 */
function content(query) {
    return {focus: false, params: {query, type: 'terms'}, state: null, content: null, historyMode: 'new'};
}

test('overlapping cold shows share creation and only deliver the latest content', async () => {
    const {popup, create, invoke} = createPopup();
    const opening = /** @type {PromiseWithResolvers<{tabId: ?number, windowId: number}>} */ (Promise.withResolvers());
    create.mockReturnValue(opening.promise);
    const first = popup.showContent(outer, content('older'));
    const second = popup.showContent(outer, content('newer'));
    opening.resolve({tabId: 7, windowId: 70});
    await Promise.all([first, second]);
    expect(create).toHaveBeenCalledExactlyOnceWith({focus: 'ifCreated'});
    expect(invoke).toHaveBeenCalledExactlyOnceWith(7, 0, 'displayPopupMessage2', {action: 'displaySetContent', params: {details: content('newer'), publication: {source: Reflect.get(popup, '_publicationSource'), generation: 2}}});
});

test('a stale failed show cannot reopen or overwrite a newer healthy show', async () => {
    const {popup, create, invoke} = createPopup();
    await popup.showContent(outer, content('initial'));
    const delivery = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    invoke.mockReturnValueOnce(delivery.promise);
    const older = popup.showContent(outer, content('older'));
    await popup.showContent(outer, content('newer'));
    delivery.reject(new Error('Old delivery failed late'));
    await older;
    expect(create).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(invoke.mock.calls.map((call) => call[3].action)).toEqual([
        'displaySetContent', 'displaySetContent', 'displayCancelPublication', 'displaySetContent',
    ]);
    expect(invoke.mock.calls[2][3].params.publication.generation).toBe(2);
    expect(invoke.mock.calls[3][3].params.publication.generation).toBe(3);
});

for (const recoveredTabId of [7, 8]) {
    test(`a delayed non-opening failure cannot clear a recovered tab ${recoveredTabId}`, async () => {
        const {popup, create, invoke, visible} = createPopup();
        await popup.showContent(outer, content('initial'));
        const oldDelivery = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        invoke.mockReturnValueOnce(oldDelivery.promise);
        const css = popup.setCustomCss('body { color: red; }');
        invoke.mockRejectedValueOnce(new Error('Cached tab closed'));
        create.mockResolvedValueOnce({tabId: recoveredTabId, windowId: 70});
        await popup.showContent(outer, content('recovered'));
        oldDelivery.reject(new Error('Old CSS delivery failed late'));
        await css;
        expect(await popup.isVisible()).toBe(true);
        expect(visible).toHaveBeenCalledExactlyOnceWith(recoveredTabId);
        await popup.showContent(outer, content('next'));
        expect(create).toHaveBeenCalledTimes(2);
    });
}

test('extension unload during creation prevents publication and content delivery', async () => {
    const {popup, create, invoke, visible, webExtension} = createPopup();
    const opening = /** @type {PromiseWithResolvers<{tabId: ?number, windowId: number}>} */ (Promise.withResolvers());
    create.mockReturnValueOnce(opening.promise);
    const show = popup.showContent(outer, content('pending'));
    webExtension.unloaded = true;
    opening.resolve({tabId: 7, windowId: 70});
    await show;
    expect(invoke).not.toHaveBeenCalled();
    expect(await popup.isVisible()).toBe(false);
    expect(visible).not.toHaveBeenCalled();
});

for (const tabId of [null, -1, 1.5, Number.NaN, Infinity]) {
    test(`invalid created tab ID ${String(tabId)} never falls through to cross-frame routing`, async () => {
        const {popup, create, invoke} = createPopup();
        create.mockResolvedValueOnce({tabId, windowId: 70});
        await expect(popup.showContent(outer, content('invalid'))).rejects.toThrow('Invalid popup tab ID');
        expect(invoke).not.toHaveBeenCalled();
        await popup.showContent(outer, content('retry'));
        expect(create).toHaveBeenCalledTimes(2);
        expect(invoke.mock.calls[0][0]).toBe(7);
    });
}

test('a failed first delivery releases its tab reference and a later show retries cleanly', async () => {
    const {popup, create, invoke, visible} = createPopup();
    const error = new Error('Popup disappeared after creation');
    invoke.mockRejectedValueOnce(error);
    await expect(popup.showContent(outer, content('failed'))).rejects.toBe(error);
    expect(await popup.isVisible()).toBe(false);
    expect(visible).not.toHaveBeenCalled();
    create.mockResolvedValueOnce({tabId: 8, windowId: 80});
    await popup.showContent(outer, content('retry'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.at(-1)?.[0]).toBe(8);
});

test('a rejected creation is shared, settled and does not poison a later attempt', async () => {
    const {popup, create, invoke} = createPopup();
    const opening = /** @type {PromiseWithResolvers<{tabId: ?number, windowId: number}>} */ (Promise.withResolvers());
    create.mockReturnValueOnce(opening.promise).mockReturnValueOnce(opening.promise);
    const first = popup.showContent(outer, content('first'));
    const second = popup.showContent(outer, content('second'));
    const results = Promise.allSettled([first, second]);
    const error = new Error('Window creation unavailable');
    opening.reject(error);
    expect(await results).toStrictEqual([{status: 'rejected', reason: error}, {status: 'rejected', reason: error}]);
    expect(create).toHaveBeenCalledTimes(1);
    create.mockReset().mockResolvedValue({tabId: 7, windowId: 70});
    await popup.showContent(outer, content('retry'));
    expect(invoke).toHaveBeenCalledTimes(1);
});

test('non-opening commands and null content never create a popup window', async () => {
    const {popup, create, invoke} = createPopup();
    await popup.setCustomCss('body {}');
    await popup.setOptionsContext({depth: 0, url: 'https://example.test'});
    await popup.clearAutoPlayTimer();
    await popup.showContent(outer, null);
    popup.hide(false);
    expect(create).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
});

test('an existing healthy tab remains reusable for shows and non-opening commands', async () => {
    const {popup, create, invoke} = createPopup();
    await popup.showContent(outer, content('first'));
    popup.hide(false);
    await popup.setCustomCss('body {}');
    await popup.showContent(outer, content('second'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.map((call) => call[0])).toStrictEqual([7, 7, 7]);
});

test('a late first-delivery failure cannot invalidate a newer successful show', async () => {
    const {popup, invoke, create, visible} = createPopup();
    const delivery = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const started = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    invoke.mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
    });
    const older = popup.showContent(outer, content('older'));
    await started.promise;
    await popup.showContent(outer, content('newer'));
    delivery.reject(new Error('Old first delivery failed'));
    await older;
    expect(await popup.isVisible()).toBe(true);
    expect(visible).toHaveBeenCalledExactlyOnceWith(7);
    expect(create).toHaveBeenCalledTimes(1);
});

test('unload during a failed cached delivery prevents reopening', async () => {
    const {popup, invoke, create, webExtension} = createPopup();
    await popup.showContent(outer, content('initial'));
    const delivery = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    invoke.mockReturnValueOnce(delivery.promise);
    const pending = popup.showContent(outer, content('pending'));
    webExtension.unloaded = true;
    delivery.reject(new Error('Extension unloaded'));
    await pending;
    expect(create).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(await popup.isVisible()).toBe(false);
});

test('a synchronous creation error releases ownership for a later retry', async () => {
    const {popup, create, invoke} = createPopup();
    const error = new Error('Creation failed synchronously');
    create.mockImplementationOnce(() => { throw error; });
    await expect(popup.showContent(outer, content('failed'))).rejects.toBe(error);
    await popup.showContent(outer, content('retry'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(1);
});
