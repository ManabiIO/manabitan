/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {Popup} from '../ext/js/app/popup.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {Display} from '../ext/js/display/display.js';
import {log} from '../ext/js/core/log.js';
import {chrome, fetch} from './mocks/common.js';

/** @type {import('settings').ProfileOptions} */
let defaults;
beforeAll(async () => {
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', fetch);
    try {
        const util = new OptionsUtil();
        await util.prepare();
        defaults = util.getDefault().profiles[0].options;
    } finally {
        vi.unstubAllGlobals();
    }
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {number} width
 * @returns {import('settings').ProfileOptions}
 */
function options(width) {
    const result = structuredClone(defaults);
    result.general.popupWidth = width;
    return result;
}

const a = {depth: 0, url: 'https://a.test'};
const b = {depth: 0, url: 'https://b.test'};

/**
 * @param {'popup'|'display'} kind
 * @returns {{owner: Popup|Display, optionsGet: import('vitest').Mock, publish: import('vitest').Mock, invoke: import('vitest').Mock}}
 */
function createOwner(kind) {
    const owner = kind === 'popup' ? /** @type {Popup} */ (Object.create(Popup.prototype)) : /** @type {Display} */ (Object.create(Display.prototype));
    const optionsGet = vi.fn();
    const publish = vi.fn();
    const invoke = vi.fn().mockResolvedValue(void 0);
    const fields = {
        _application: {api: {optionsGet}},
        _optionsContext: null,
        _optionsContextRequest: null,
        _frameConnected: true,
        _themeController: {updateTheme: publish},
        _invokeSafe: invoke,
        _dictionaryCssMediaResolver: {prune: vi.fn()},
        _updateHotkeys: vi.fn(),
        _updateDocumentOptions: publish,
        _setTheme: vi.fn(),
        _setStickyHeader: vi.fn(),
        _hotkeyHelpController: {setOptions: vi.fn(), setupNode: vi.fn()},
        _displayGenerator: {updateHotkeys: vi.fn(), updateLanguage: vi.fn()},
        _elementOverflowController: {setOptions: vi.fn()},
        _queryParser: {setOptions: vi.fn()},
        _updateNestedFrontend: vi.fn().mockResolvedValue(void 0),
        _updateContentTextScanner: vi.fn(),
        trigger: vi.fn(),
    };
    for (const [key, value] of Object.entries(fields)) { Reflect.set(owner, key, value); }
    vi.stubGlobal('document', {documentElement: {}});
    return {owner, optionsGet, publish, invoke};
}

/**
 * @param {Popup|Display} owner
 * @returns {number|undefined}
 */
function appliedWidth(owner) {
    return owner instanceof Popup ? owner._initialWidth : owner._options?.general.popupWidth;
}

describe.each(['popup', 'display'])('%s options publication', (kind) => {
    const ownerKind = /** @type {'popup'|'display'} */ (kind);

    test('a late response cannot overwrite the newest profile or notify its display', async () => {
        const {owner, optionsGet, publish, invoke} = createOwner(ownerKind);
        const older = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        optionsGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce(options(700));
        const first = owner.setOptionsContext(a);
        await owner.setOptionsContext(b);
        older.resolve(options(300));
        await first;
        expect(appliedWidth(owner)).toBe(700);
        expect(publish).toHaveBeenCalledTimes(1);
        if (owner instanceof Popup) { expect(invoke).toHaveBeenCalledExactlyOnceWith('displaySetOptionsContext', {optionsContext: b}); }
    });

    test('same-context consumers wait for the pending load rather than treating it as applied', async () => {
        const {owner, optionsGet} = createOwner(ownerKind);
        const pending = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        optionsGet.mockReturnValue(pending.promise);
        const first = owner.setOptionsContext(a);
        let consumed = false;
        const consumer = owner._setOptionsContextIfDifferent({...a}).then(() => { consumed = true; });
        await Promise.resolve();
        const consumedBeforeLoad = consumed;
        pending.resolve(options(500));
        await Promise.all([first, consumer]);
        expect(consumedBeforeLoad).toBe(false);
        expect(optionsGet).toHaveBeenCalledTimes(1);
        expect(appliedWidth(owner)).toBe(500);
    });

    test('a failed load is retryable through the same-context path', async () => {
        const {owner, optionsGet} = createOwner(ownerKind);
        const error = new Error('Temporary options failure');
        optionsGet.mockRejectedValueOnce(error).mockResolvedValueOnce(options(600));
        await expect(owner.setOptionsContext(a)).rejects.toBe(error);
        await owner._setOptionsContextIfDifferent({...a});
        expect(optionsGet).toHaveBeenCalledTimes(2);
        expect(appliedWidth(owner)).toBe(600);
    });

    test('explicit same-context refresh still reloads changed settings', async () => {
        const {owner, optionsGet} = createOwner(ownerKind);
        optionsGet.mockResolvedValueOnce(options(300)).mockResolvedValueOnce(options(700));
        await owner.setOptionsContext(a);
        await owner.setOptionsContext({...a});
        await owner._setOptionsContextIfDifferent({...a});
        expect(optionsGet).toHaveBeenCalledTimes(2);
        expect(appliedWidth(owner)).toBe(700);
    });

    test('a failed refresh cannot reuse an older successful load for that context', async () => {
        const {owner, optionsGet} = createOwner(ownerKind);
        const error = new Error('Refresh failed');
        optionsGet.mockResolvedValueOnce(options(300)).mockRejectedValueOnce(error).mockResolvedValueOnce(options(700));
        await owner.setOptionsContext(a);
        await expect(owner.setOptionsContext({...a})).rejects.toBe(error);
        await owner._setOptionsContextIfDifferent({...a});
        expect(optionsGet).toHaveBeenCalledTimes(3);
        expect(appliedWidth(owner)).toBe(700);
    });

    test('same-context explicit refreshes have independent publication ownership', async () => {
        const {owner, optionsGet, publish} = createOwner(ownerKind);
        const older = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        optionsGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce(options(700));
        const first = owner.setOptionsContext(a);
        await owner.setOptionsContext({...a});
        older.resolve(options(300));
        await first;
        expect(appliedWidth(owner)).toBe(700);
        expect(publish).toHaveBeenCalledTimes(1);
    });

    test('returning to an applied context supersedes another pending context', async () => {
        const {owner, optionsGet} = createOwner(ownerKind);
        const pending = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        optionsGet.mockResolvedValueOnce(options(300)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(options(500));
        await owner.setOptionsContext(a);
        const second = owner.setOptionsContext(b);
        await owner._setOptionsContextIfDifferent({...a});
        pending.resolve(options(700));
        await second;
        expect(appliedWidth(owner)).toBe(500);
        expect(owner._optionsContext).toStrictEqual(a);
    });

    test('an obsolete failure cannot evict the successfully loaded newer context', async () => {
        const {owner, optionsGet} = createOwner(ownerKind);
        const older = /** @type {PromiseWithResolvers<import('settings').ProfileOptions>} */ (Promise.withResolvers());
        optionsGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce(options(700));
        const failure = expect(owner.setOptionsContext(a)).rejects.toThrow('Obsolete failure');
        await owner.setOptionsContext(b);
        older.reject(new Error('Obsolete failure'));
        await failure;
        await owner._setOptionsContextIfDifferent({...b});
        expect(optionsGet).toHaveBeenCalledTimes(2);
        expect(appliedWidth(owner)).toBe(700);
    });
});

test('nested scanner waits for setup before applying the latest disabled state', async () => {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const disabled = vi.fn();
    const frontend = {setDisabledOverride: disabled};
    const setup = vi.fn().mockImplementation(async () => {
        Reflect.set(display, '_frontend', frontend);
        await pending.promise;
    });
    for (const [key, value] of Object.entries({
        _application: {tabId: 1, frameId: 1},
        _pageType: 'search',
        _childrenSupported: true,
        _frontend: null,
        _frontendSetupPromise: null,
        _nestedFrontendUpdateToken: null,
        _setupNestedFrontend: setup,
    })) { Reflect.set(display, key, value); }
    const enabled = options(300);
    enabled.scanning.enableOnSearchPage = true;
    const stopped = options(300);
    stopped.scanning.enableOnSearchPage = false;
    const first = display._updateNestedFrontend(enabled);
    const second = display._updateNestedFrontend(stopped);
    const callsBeforeReady = disabled.mock.calls.length;
    pending.resolve();
    await Promise.all([first, second]);
    expect(callsBeforeReady).toBe(0);
    expect(disabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(setup).toHaveBeenCalledTimes(1);
});

test('popup theme failure belongs to the load and does not poison same-context retry', async () => {
    const {owner, optionsGet} = createOwner('popup');
    const error = new Error('Theme unavailable');
    optionsGet.mockResolvedValue(options(500));
    const updateTheme = vi.spyOn(/** @type {Popup} */ (owner), 'updateTheme').mockRejectedValueOnce(error).mockResolvedValue(void 0);
    // Observe detached work on the unfixed baseline without masking its load result.
    const load = owner.setOptionsContext(a);
    await Promise.resolve();
    for (const {value} of updateTheme.mock.results) { void value.catch(() => {}); }
    await expect(load).rejects.toBe(error);
    await owner._setOptionsContextIfDifferent({...a});
    expect(optionsGet).toHaveBeenCalledTimes(2);
});

test('nested scanner failure is reported without rejecting the successful options load', async () => {
    const {owner, optionsGet} = createOwner('display');
    const error = new Error('Nested scanner failed');
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    const pending = Promise.reject(error);
    void pending.catch(() => {});
    Reflect.set(owner, '_updateNestedFrontend', vi.fn().mockReturnValue(pending));
    optionsGet.mockResolvedValue(options(700));
    await owner.setOptionsContext(a);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(appliedWidth(owner)).toBe(700);
    expect(owner.trigger).toHaveBeenCalledExactlyOnceWith('optionsUpdated', {options: options(700)});
});
