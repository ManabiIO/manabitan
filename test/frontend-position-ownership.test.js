/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {Popup} from '../ext/js/app/popup.js';
import {log} from '../ext/js/core/log.js';

afterEach(() => { vi.restoreAllMocks(); });

/** @returns {import('text-source').TextSource} */
function source() {
    return /** @type {import('text-source').TextSource} */ (/** @type {unknown} */ ({
        getRects: () => [{left: 10, top: 0, right: 15, bottom: 5}],
        getWritingMode: () => 'horizontal-tb',
    }));
}

/** @returns {{frontend: Frontend, popup: Popup, visible: import('vitest').Mock, report: import('vitest').MockInstance<typeof log.error>}} */
function setup() {
    const popup = /** @type {Popup} */ (Object.create(Popup.prototype));
    const visible = vi.fn().mockResolvedValue(true);
    for (const [key, value] of Object.entries({
        _optionsContext: {url: 'https://example.test/'},
        _visible: {value: false},
        _child: null,
        _hidePopupTimer: null,
        _frame: {dataset: {}, style: {}},
        _displayModeIsFullWidth: false,
        _inject: vi.fn().mockResolvedValue(true),
        _getViewport: vi.fn().mockReturnValue({left: 0, top: 0, right: 1000, bottom: 1000}),
        _getPosition: vi.fn().mockReturnValue({left: 10, top: 0, width: 100, height: 100, after: false, below: true}),
        _setVisible: vi.fn(),
        _invokeSafe: vi.fn().mockResolvedValue(void 0),
        _updateHostPageDebugState: vi.fn(),
        _incrementHostDebugCounter: vi.fn().mockReturnValue(1),
        isVisible: visible,
    })) { Reflect.set(popup, key, value); }
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    const selected = source();
    for (const [key, value] of Object.entries({
        _popup: popup,
        _lastShowPromise: Promise.resolve(),
        _textScanner: {getCurrentTextSource: () => selected, allowCurrentTextSourceRetry: vi.fn()},
        _application: {webExtension: {unloaded: false}},
        _updatePageDebugState: vi.fn(),
    })) { Reflect.set(frontend, key, value); }
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    return {frontend, popup, visible, report};
}

/** @returns {import('display').ContentDetails} */
function content() {
    return {focus: false, historyMode: 'clear', params: {type: 'terms', query: 'new-word'}, state: {}, content: {}};
}

for (const phase of ['options', 'injection', 'delivery']) {
    test(`repositioning cannot cancel fresh content waiting for ${phase}`, async () => {
        const {frontend, popup} = setup();
        const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        if (phase === 'options') {
            vi.spyOn(popup, '_setOptionsContextIfDifferent').mockReturnValueOnce(pending.promise);
        } else if (phase === 'injection') {
            vi.spyOn(popup, '_inject').mockImplementationOnce(async () => {
                await pending.promise;
                return true;
            });
        } else {
            vi.spyOn(popup, '_invokeSafe').mockReturnValueOnce(pending.promise);
        }
        const details = content();
        const selected = /** @type {import('text-source').TextSource} */ (frontend._textScanner.getCurrentTextSource());
        const show = frontend._showPopupContent(selected, phase === 'options' ? {url: 'https://other.test/', depth: 0} : null, details);
        await Promise.resolve();
        const reposition = frontend._updatePopupPosition();
        await Promise.resolve();
        await Promise.resolve();
        const showsWhilePending = vi.mocked(popup._setVisible).mock.calls.length;
        pending.resolve();
        await Promise.all([show, reposition]);
        expect(showsWhilePending).toBe(0);
        expect(popup._invokeSafe).toHaveBeenCalledExactlyOnceWith('displaySetContent', {details});
        expect(popup._setVisible).toHaveBeenCalledWith(true);
    });
}

for (const replacement of ['cleared', 'new-source', 'new-popup', 'new-show']) {
    test(`visibility completion cannot reposition after ${replacement}`, async () => {
        const {frontend, visible} = setup();
        const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
        visible.mockReturnValueOnce(pending.promise);
        const show = vi.spyOn(frontend, '_showPopupContent').mockResolvedValue(void 0);
        const reposition = frontend._updatePopupPosition();
        // Both the existing implementation and a show-aware implementation
        // have entered the asynchronous visibility read by this boundary.
        await Promise.resolve();
        await Promise.resolve();
        expect(visible).toHaveBeenCalledTimes(1);
        switch (replacement) {
            case 'cleared':
                vi.spyOn(frontend._textScanner, 'getCurrentTextSource').mockReturnValue(null);
                break;
            case 'new-source':
                vi.spyOn(frontend._textScanner, 'getCurrentTextSource').mockReturnValue(source());
                break;
            case 'new-popup':
                Reflect.set(frontend, '_popup', {showContent: vi.fn()});
                break;
            default:
                Reflect.set(frontend, '_lastShowPromise', Promise.resolve());
                break;
        }
        pending.resolve(true);
        await reposition;
        expect(show).not.toHaveBeenCalled();
    });
}

test('healthy completed content is repositioned without sending new definitions', async () => {
    const {frontend, popup} = setup();
    await frontend._updatePopupPosition();
    expect(popup._setVisible).toHaveBeenCalledExactlyOnceWith(true);
    expect(popup._invokeSafe).not.toHaveBeenCalled();
});

test('hidden popup and absent source require no show', async () => {
    const {frontend, popup, visible} = setup();
    visible.mockResolvedValueOnce(false);
    await frontend._updatePopupPosition();
    vi.spyOn(frontend._textScanner, 'getCurrentTextSource').mockReturnValue(null);
    await frontend._updatePopupPosition();
    expect(visible).toHaveBeenCalledTimes(1);
    expect(popup._setVisible).not.toHaveBeenCalled();
});

test('failed content delivery is not converted into a position-only show', async () => {
    const {frontend, popup, visible, report} = setup();
    const failure = new Error('Content transport failed');
    vi.spyOn(popup, '_invokeSafe').mockRejectedValueOnce(failure);
    const selected = /** @type {import('text-source').TextSource} */ (frontend._textScanner.getCurrentTextSource());
    const show = frontend._showPopupContent(selected, null, content());
    const observed = show.catch((error) => error);
    const reposition = frontend._updatePopupPosition();
    expect(await observed).toBe(failure);
    await reposition;
    expect(visible).not.toHaveBeenCalled();
    expect(popup._setVisible).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
});

test('visibility failure is contained and a later reposition can recover', async () => {
    const {frontend, popup, visible, report} = setup();
    const failure = new Error('Visibility transport failed');
    visible.mockRejectedValueOnce(failure);
    const observed = await frontend._updatePopupPosition().then(() => null, (error) => error);
    await frontend._updatePopupPosition();
    expect(observed).toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(popup._setVisible).toHaveBeenCalledExactlyOnceWith(true);
});

test('geometry failure is contained and does not poison the next reposition', async () => {
    const {frontend, popup, report} = setup();
    const selected = /** @type {import('text-source').TextSource} */ (frontend._textScanner.getCurrentTextSource());
    const failure = new Error('Detached range');
    vi.spyOn(selected, 'getRects').mockImplementationOnce(() => { throw failure; });
    const observed = await frontend._updatePopupPosition().then(() => null, (error) => error);
    await frontend._updatePopupPosition();
    expect(observed).toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(popup._setVisible).toHaveBeenCalledExactlyOnceWith(true);
});

test('a newer show supersedes position work waiting for the previous content', async () => {
    const {frontend, popup, visible} = setup();
    const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    Reflect.set(frontend, '_lastShowPromise', pending.promise);
    const reposition = frontend._updatePopupPosition();
    Reflect.set(frontend, '_lastShowPromise', Promise.resolve());
    pending.resolve();
    await reposition;
    expect(visible).not.toHaveBeenCalled();
    expect(popup._setVisible).not.toHaveBeenCalled();
});

test('concurrent resize notifications coalesce rather than superseding each other', async () => {
    const {frontend, popup} = setup();
    await Promise.all([frontend._updatePopupPosition(), frontend._updatePopupPosition(), frontend._updatePopupPosition()]);
    expect(popup._setVisible).toHaveBeenCalledExactlyOnceWith(true);
});

test('obsolete visibility failures do not report an error for the replacement selection', async () => {
    const {frontend, visible, report} = setup();
    const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    visible.mockReturnValueOnce(pending.promise);
    const reposition = frontend._updatePopupPosition();
    await Promise.resolve();
    await Promise.resolve();
    vi.spyOn(frontend._textScanner, 'getCurrentTextSource').mockReturnValue(source());
    pending.reject(new Error('Obsolete visibility failure'));
    await reposition;
    expect(report).not.toHaveBeenCalled();
});

test('extension unload contains visibility failure without reporting it', async () => {
    const {frontend, visible, report} = setup();
    Reflect.set(frontend._application.webExtension, 'unloaded', true);
    visible.mockRejectedValueOnce(new Error('Unloaded extension'));
    await frontend._updatePopupPosition();
    expect(report).not.toHaveBeenCalled();
});

test('old show completion cannot mark a newer pending popup request settled', async () => {
    const {frontend, popup} = setup();
    const older = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const newer = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    vi.spyOn(popup, 'showContent').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const selected = /** @type {import('text-source').TextSource} */ (frontend._textScanner.getCurrentTextSource());
    const first = frontend._showPopupContent(selected, null, content());
    const second = frontend._showPopupContent(selected, null, content());
    const debug = vi.mocked(frontend._updatePageDebugState);
    debug.mockClear();
    older.resolve();
    await first;
    const staleCompletionUpdates = debug.mock.calls.length;
    newer.resolve();
    await second;
    expect(staleCompletionUpdates).toBe(0);
    expect(debug).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({popupShowSettled: true}));
});
