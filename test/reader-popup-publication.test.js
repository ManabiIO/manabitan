import {describe, expect, test, vi} from 'vitest';
import {Popup} from '../ext/js/app/popup.js';
import {PopupFactory} from '../ext/js/app/popup-factory.js';
import {PopupProxy} from '../ext/js/app/popup-proxy.js';
import {PopupWindow} from '../ext/js/app/popup-window.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';

function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((/** @type {(value: unknown) => void} */ r) => { resolve = (value = true) => r(value); });
    return {promise, resolve};
}

function guard() {
    let current = true;
    let cancel = () => {};
    const unsubscribe = vi.fn();
    return {
        isCurrent: () => current,
        subscribe: (/** @type {() => void} */ callback) => { cancel = callback; return unsubscribe; },
        invalidate: () => { current = false; cancel(); },
        unsubscribe,
    };
}

/** @returns {import('popup').ContentDetails} */
const details = () => ({optionsContext: null, sourceRects: [], writingMode: 'horizontal-tb'});

/**
 * @param {unknown} value
 * @returns {import('../ext/js/application.js').Application}
 */
function fakeApplication(value) {
    return /** @type {import('../ext/js/application.js').Application} */ (value);
}

/** @returns {import('display').ContentDetails} */
function displayDetails() {
    return /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));
}

function popup() {
    return Object.assign(Object.create(Popup.prototype), {
        _publicationGeneration: 0,
        _publicationSource: '0123456789abcdef0123456789abcdef',
        _optionsGeneration: 0,
        _cancelPendingPublication: null,
        _optionsContext: {},
        _child: null,
        _updateHostPageDebugState: vi.fn(),
        _incrementHostDebugCounter: vi.fn(),
        _setOptionsContextIfDifferent: vi.fn(),
        stopHideDelayed: vi.fn(),
        _inject: vi.fn(async () => true),
        _invokeSafe: vi.fn(async () => {}),
        _show: vi.fn(),
        isVisibleSync: () => false,
    });
}

describe('popup publication cancellation', () => {
    test('position-only update does not supersede pending content or reveal hidden stale content', async () => {
        const p = popup();
        const wait = deferred();
        p._inject.mockReturnValueOnce(wait.promise);
        const result = p.showContent(details(), {id: 'reader'}, guard());
        await p.showContent(details(), null);
        expect(p._show).not.toHaveBeenCalled();
        wait.resolve();
        await result;
        expect(p._invokeSafe).toHaveBeenCalledExactlyOnceWith('displaySetContent', {details: {id: 'reader'}, publication: {source: p._publicationSource, generation: 1}});
        expect(p._show).toHaveBeenCalledOnce();
    });

    test('proxy position-only token does not supersede pending full content token', async () => {
        const wait = deferred();
        /**
         * @param {number} _frame
         * @param {string} _action
         * @param {{publication?: import('popup').PublicationToken}} _params
         * @returns {Promise<void>}
         */
        async function invokeRemote(_frame, _action, _params) {
            await wait.promise;
        }
        const invoke = vi.fn(invokeRemote);
        const p = new PopupProxy(fakeApplication({crossFrame: {invoke}, webExtension: {unloaded: false}}), 'p', 0, 1, null);
        const full = p.showContent(details(), displayDetails(), guard());
        const position = p.showContent(details(), null);
        expect(invoke.mock.calls[0][2].publication).toEqual(invoke.mock.calls[1][2].publication);
        wait.resolve();
        await Promise.all([full, position]);
    });

    test('late stale options do not mutate context or presentation options', async () => {
        const p = popup();
        const old = deferred();
        const next = deferred();
        p._application = {api: {optionsGet: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)}};
        p._themeController = {};
        p.updateTheme = vi.fn();
        const g = guard();
        const oldOptions = Popup.prototype._setOptionsContext.call(p, {url: 'old', depth: 0}, g.isCurrent);
        const nextOptions = Popup.prototype._setOptionsContext.call(p, {url: 'https://new.example', depth: 0}, () => true);
        g.invalidate();
        next.resolve({general: {popupWidth: 900}, scanning: {}});
        await nextOptions;
        old.resolve({general: {popupWidth: 100}, scanning: {}});
        await oldOptions;
        expect(p._optionsContext).toEqual({url: 'https://new.example', depth: 0});
        expect(p._initialWidth).toBe(900);
        expect(p.updateTheme).toHaveBeenCalledOnce();
    });

    test('factory validates wire tokens, retains one entry per proxy, and admits navigated proxies', () => {
        const f = Object.assign(Object.create(PopupFactory.prototype), {_publications: new Map(), _getPopup: () => ({})});
        for (const generation of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(f._acceptPublication('p', {source: 'proxy', generation})).toBe(false);
        }
        expect(f._acceptPublication('p', {source: '', generation: 1})).toBe(false);
        for (let generation = 1; generation < 1000; ++generation) {
            expect(f._acceptPublication('p', {source: 'proxy', generation})).toBe(true);
        }
        expect(f._publications.get('p').size).toBe(1);
        for (let i = 1; i < 64; ++i) {
            expect(f._acceptPublication('p', {source: `proxy-${i}`, generation: 1})).toBe(true);
        }
        expect(f._acceptPublication('p', {source: 'next-navigation', generation: 1})).toBe(true);
        expect(f._publications.get('p').size).toBe(65);
    });

    test('cancellation before show RPC remains a tombstone', async () => {
        const p = popup();
        const f = Object.assign(Object.create(PopupFactory.prototype), {_publications: new Map(), _getPopup: () => p});
        /** @type {import('popup').PublicationToken} */
        const publication = {source: 'proxy', generation: 1};
        f._onApiCancelPublication({id: 'p', publication});
        await f._onApiShowContent({id: 'p', publication, details: details(), displayDetails: {}});
        expect(p._inject).not.toHaveBeenCalled();
    });

    test.each(['options', 'inject'])('invalidated while waiting for %s does not publish', async (phase) => {
        const p = popup();
        const wait = deferred();
        const g = guard();
        const d = details();
        if (phase === 'options') {
            d.optionsContext = {url: 'https://example.test', depth: 0};
            p._setOptionsContextIfDifferent.mockReturnValue(wait.promise);
        } else {
            p._inject.mockReturnValue(wait.promise);
        }
        const result = p.showContent(d, {}, g);
        g.invalidate();
        wait.resolve();
        await result;
        expect(p._invokeSafe).not.toHaveBeenCalled();
        expect(p._show).not.toHaveBeenCalled();
        expect(g.unsubscribe).toHaveBeenCalledOnce();
    });

    test('ordinary show supersedes delayed reader without an old hide', async () => {
        const p = popup();
        const wait = deferred();
        p._inject.mockReturnValueOnce(wait.promise);
        const old = p.showContent(details(), {id: 'old'}, guard());
        await p.showContent(details(), {id: 'new'});
        wait.resolve();
        await old;
        expect(p._invokeSafe).toHaveBeenCalledExactlyOnceWith('displaySetContent', {details: {id: 'new'}, publication: {source: p._publicationSource, generation: 2}});
        expect(p._show).toHaveBeenCalledOnce();
    });

    test('hide while injecting prevents resurrection', async () => {
        const p = popup();
        const wait = deferred();
        p._inject.mockReturnValue(wait.promise);
        const result = p.showContent(details(), {}, guard());
        p.hide(false);
        wait.resolve();
        await result;
        expect(p._show).not.toHaveBeenCalled();
    });

    test('real _show rechecks after its own injection wait', async () => {
        const p = popup();
        const wait = deferred();
        p._inject.mockReturnValue(wait.promise);
        const g = guard();
        const result = Popup.prototype._show.call(p, [], 'horizontal-tb', g.isCurrent);
        g.invalidate();
        wait.resolve();
        await result;
    });

    test('new display RPC does not wait for old rendering and stale completion does not show', async () => {
        const p = popup();
        const wait = deferred();
        p._invokeSafe.mockReturnValueOnce(wait.promise);
        const old = p.showContent(details(), {id: 'old'}, guard());
        await vi.waitFor(() => expect(p._invokeSafe).toHaveBeenCalledOnce());
        const next = p.showContent(details(), {id: 'new'});
        await next;
        expect(p._invokeSafe).toHaveBeenCalledTimes(3);
        expect(p._show).toHaveBeenCalledOnce();
        wait.resolve();
        await Promise.all([old, next]);
        expect(p._invokeSafe.mock.calls.filter((/** @type {[string, unknown]} */ call) => call[0] === 'displaySetContent').map((/** @type {[string, {details: {id: string}}]} */ call) => call[1].details.id)).toEqual(['old', 'new']);
        expect(p._show).toHaveBeenCalledOnce();
    });

    test('proxy sends tokens, forwards cancellation, and cleans up subscription', async () => {
        const wait = deferred();
        const invoke = vi.fn(async (/** @type {number} */ _frame, /** @type {string} */ _action, /** @type {unknown} */ params) => {
            structuredClone(params);
            await wait.promise;
        });
        const p = new PopupProxy(fakeApplication({crossFrame: {invoke}, webExtension: {unloaded: false}}), 'p', 0, 1, null);
        const g = guard();
        const result = p.showContent(details(), displayDetails(), g);
        g.invalidate();
        expect(invoke.mock.calls.map((call) => call[1])).toEqual(['popupFactoryShowContent', 'popupFactoryCancelPublication']);
        wait.resolve();
        await result;
        expect(g.unsubscribe).toHaveBeenCalledOnce();
    });

    test('host rejects late show/hide and cancellation never hides newer content', async () => {
        const p = popup();
        const f = Object.assign(Object.create(PopupFactory.prototype), {
            _publications: new Map(),
            _getPopup: () => p,
            _popupCanShow: () => true,
            _getPopupOffset: () => ({x: 0, y: 0}),
        });
        p.hide = vi.fn();
        /** @type {import('popup').PublicationToken} */
        const publication = {source: 'proxy', generation: 2};
        await f._onApiShowContent({id: 'p', details: details(), displayDetails: {}, publication});
        await f._onApiHide({id: 'p', changeFocus: false, publication: {...publication, generation: 1}});
        f._onApiCancelPublication({id: 'p', publication: {...publication, generation: 1}});
        await f._onApiShowContent({id: 'p', details: details(), displayDetails: {}, publication: {...publication, generation: 1}});
        expect(p._show).toHaveBeenCalledOnce();
        expect(p.hide).not.toHaveBeenCalled();
    });

    test('host cancellation reaches delayed injection and rejects cancellation-before-show', async () => {
        const p = popup();
        const wait = deferred();
        p._inject.mockReturnValue(wait.promise);
        const f = Object.assign(Object.create(PopupFactory.prototype), {
            _publications: new Map(),
            _getPopup: () => p,
            _popupCanShow: () => true,
            _getPopupOffset: () => ({x: 0, y: 0}),
        });
        /** @type {import('popup').PublicationToken} */
        const publication = {source: 'proxy', generation: 1};
        const result = f._onApiShowContent({id: 'p', details: details(), displayDetails: {}, publication});
        f._onApiCancelPublication({id: 'p', publication});
        wait.resolve();
        await result;
        await f._onApiShowContent({id: 'p', details: details(), displayDetails: {}, publication});
        expect(p._invokeSafe).not.toHaveBeenCalled();
    });

    test('window does not dispatch after cancelled popup creation', async () => {
        const wait = deferred();
        const invokeTab = vi.fn();
        const p = new PopupWindow(fakeApplication({
            webExtension: {unloaded: false},
            crossFrame: {invokeTab},
            api: {getOrCreateSearchPopup: async () => { await wait.promise; return {tabId: 1}; }},
        }), 'p', 0, 0);
        const g = guard();
        const result = p.showContent(details(), displayDetails(), g);
        await p.showContent(details(), null);
        expect(p._publicationGeneration).toBe(1);
        await Promise.resolve();
        g.invalidate();
        wait.resolve();
        await result;
        expect(invokeTab).not.toHaveBeenCalled();
        expect(g.unsubscribe).toHaveBeenCalledOnce();
    });

    test('window publication timeout survives serialization and rejects without retry, releasing its subscription', async () => {
        const timeout = new Error('Popup content rendering timed out');
        timeout.name = 'PopupContentTimeoutError';
        const receivedError = ExtensionError.deserialize(ExtensionError.serialize(timeout));
        expect(receivedError.name).toBe('PopupContentTimeoutError');
        const invokeTab = vi.fn().mockRejectedValue(receivedError);
        const getOrCreateSearchPopup = vi.fn().mockResolvedValue({tabId: 20});
        const p = new PopupWindow(fakeApplication({
            webExtension: {unloaded: false},
            crossFrame: {invokeTab},
            api: {getOrCreateSearchPopup},
        }), 'p', 0, 0);
        p._popupTabId = 10;
        const g = guard();
        await expect(p.showContent(details(), displayDetails(), g)).rejects.toBe(receivedError);
        expect(invokeTab).toHaveBeenCalledOnce();
        expect(getOrCreateSearchPopup).not.toHaveBeenCalled();
        expect(p._popupTabId).toBe(10);
        expect(g.unsubscribe).toHaveBeenCalledOnce();
        expect(p._cancelPendingPublication).toBeNull();
    });

    test('window transport failure still recovers through popup creation and retry', async () => {
        const invokeTab = vi.fn().mockRejectedValueOnce(new Error('closed')).mockResolvedValue(void 0);
        const getOrCreateSearchPopup = vi.fn().mockResolvedValue({tabId: 20});
        const p = new PopupWindow(fakeApplication({
            webExtension: {unloaded: false},
            crossFrame: {invokeTab},
            api: {getOrCreateSearchPopup},
        }), 'p', 0, 0);
        p._popupTabId = 10;
        const g = guard();
        await p.showContent(details(), displayDetails(), g);
        expect(getOrCreateSearchPopup).toHaveBeenCalledExactlyOnceWith({focus: 'ifCreated'});
        expect(invokeTab).toHaveBeenCalledTimes(2);
        expect(invokeTab.mock.calls[0][0]).toBe(10);
        expect(invokeTab.mock.calls[1][0]).toBe(20);
        expect(invokeTab.mock.calls[1][3]).toEqual(invokeTab.mock.calls[0][3]);
        expect(g.unsubscribe).toHaveBeenCalledOnce();
        expect(p._cancelPendingPublication).toBeNull();
    });

    test('window failed existing-tab RPC cannot create fallback after cancellation', async () => {
        const wait = deferred();
        const getOrCreateSearchPopup = vi.fn();
        const p = new PopupWindow(fakeApplication({
            webExtension: {unloaded: false},
            crossFrame: {invokeTab: async () => { await wait.promise; throw new Error('closed'); }},
            api: {getOrCreateSearchPopup},
        }), 'p', 0, 0);
        p._popupTabId = 10;
        const g = guard();
        const result = p.showContent(details(), displayDetails(), g);
        g.invalidate();
        wait.resolve();
        await result;
        expect(getOrCreateSearchPopup).not.toHaveBeenCalled();
        expect(g.unsubscribe).toHaveBeenCalledOnce();
    });

    test('cancellation of dispatched local render uses matching receiver token', async () => {
        const p = popup();
        const wait = deferred();
        p._invokeSafe.mockReturnValueOnce(wait.promise);
        const g = guard();
        const result = p.showContent(details(), {}, g);
        await vi.waitFor(() => expect(p._invokeSafe).toHaveBeenCalledOnce());
        const publication = p._invokeSafe.mock.calls[0][1].publication;
        g.invalidate();
        expect(p._invokeSafe).toHaveBeenLastCalledWith('displayCancelPublication', {publication});
        wait.resolve();
        await result;
        expect(p._show).not.toHaveBeenCalled();
        expect(p._cancelPendingPublication).toBeNull();
    });

    test('factory forwards cancellation to dispatched host render and releases listener', async () => {
        const p = popup();
        const wait = deferred();
        p._invokeSafe.mockReturnValueOnce(wait.promise);
        const f = Object.assign(Object.create(PopupFactory.prototype), {
            _publications: new Map(),
            _getPopup: () => p,
            _popupCanShow: () => true,
            _getPopupOffset: () => ({x: 0, y: 0}),
        });
        /** @type {import('popup').PublicationToken} */
        const publication = {source: 'proxy', generation: 1};
        const result = f._onApiShowContent({id: 'p', publication, details: details(), displayDetails: {}});
        await vi.waitFor(() => expect(p._invokeSafe).toHaveBeenCalledOnce());
        const receiverToken = p._invokeSafe.mock.calls[0][1].publication;
        f._onApiCancelPublication({id: 'p', publication});
        expect(p._invokeSafe).toHaveBeenLastCalledWith('displayCancelPublication', {publication: receiverToken});
        wait.resolve();
        await result;
        expect(f._publications.get('p').get('proxy').listeners.size).toBe(0);
    });

    test('window cancels only dispatched receiver publication', async () => {
        const wait = deferred();
        const invokeTab = vi.fn().mockImplementation(async () => {}).mockImplementationOnce(async () => { await wait.promise; });
        const p = new PopupWindow(fakeApplication({webExtension: {unloaded: false}, crossFrame: {invokeTab}}), 'p', 0, 0);
        p._popupTabId = 1;
        const g = guard();
        const result = p.showContent(details(), displayDetails(), g);
        const publication = invokeTab.mock.calls[0][3].params.publication;
        g.invalidate();
        expect(invokeTab.mock.calls[1][3]).toEqual({action: 'displayCancelPublication', params: {publication}});
        wait.resolve();
        await result;
        expect(p._cancelPendingPublication).toBeNull();
    });

    test('old prewarm does not dispatch after real lookup starts during injection', async () => {
        const p = popup();
        const wait = deferred();
        p._inject.mockReturnValueOnce(wait.promise);
        const warm = p.prewarmContent({id: 'warm'});
        await p.showContent(details(), {id: 'real'});
        wait.resolve();
        await warm;
        expect(p._invokeSafe).toHaveBeenCalledExactlyOnceWith('displaySetContent', {details: {id: 'real'}, publication: {source: p._publicationSource, generation: 2}});
    });

    test('prewarm and real content share one source with increasing receiver generations', async () => {
        const p = popup();
        await p.prewarmContent({id: 'warm'});
        await p.showContent(details(), {id: 'real'});
        expect(p._invokeSafe.mock.calls[0][1].publication).toEqual({source: p._publicationSource, generation: 1});
        expect(p._invokeSafe.mock.calls[1][1].publication).toEqual({source: p._publicationSource, generation: 2});
    });

    test('prewarm does not reserve a generation or replace visible content', async () => {
        const p = popup();
        p.isVisibleSync = () => true;
        await p.prewarmContent({id: 'warm'});
        expect(p._publicationGeneration).toBe(0);
        expect(p._inject).not.toHaveBeenCalled();
        expect(p._invokeSafe).not.toHaveBeenCalled();
    });

    test('concurrent explicit options updates cannot restore old context', async () => {
        const p = popup();
        const old = deferred();
        p._application = {api: {optionsGet: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({general: {popupWidth: 900}, scanning: {}})}};
        p._themeController = {};
        p.updateTheme = vi.fn();
        const first = p.setOptionsContext({url: 'https://old.example'});
        await p.setOptionsContext({url: 'https://new.example'});
        old.resolve({general: {popupWidth: 100}, scanning: {}});
        await first;
        expect(p._optionsContext.url).toBe('https://new.example');
        expect(p._initialWidth).toBe(900);
        expect(p.updateTheme).toHaveBeenCalledOnce();
    });
});
