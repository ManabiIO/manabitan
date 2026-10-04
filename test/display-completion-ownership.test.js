/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, expect, vi} from 'vitest';
import {safePerformance} from '../ext/js/core/safe-performance.js';
import {Display} from '../ext/js/display/display.js';
import {DisplayHistory} from '../ext/js/display/display-history.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function createDisplay() {
    vi.spyOn(safePerformance, 'mark').mockImplementation(() => void 0);
    vi.spyOn(safePerformance, 'measure').mockImplementation(() => void 0);
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    const render = vi.fn(/** @returns {Promise<void>} */ async () => {});
    const report = vi.fn();
    for (const [name, value] of Object.entries({
        _history: new DisplayHistory(true, false),
        _historyHasChanged: false,
        _historyChangeIgnore: false,
        _stateChangeCompleteResolvers: [],
        _options: null,
        _setContentToken: null,
        _dictionaryAvailabilityNotification: null,
        _closePopups: vi.fn(),
        _closeAllPopupMenus: vi.fn(),
        _eventListeners: {removeAllEventListeners: vi.fn()},
        _contentManager: {unloadAll: vi.fn()},
        _hideTagNotification: vi.fn(),
        _hideInflectionNotification: vi.fn(),
        _triggerContentClear: vi.fn(),
        _elementOverflowController: {clearElements: vi.fn()},
        _setContentTermsOrKanji: render,
        _clearContent: vi.fn(),
        _index: 0,
        _windowScroll: {x: 0, y: 0},
        onError: report,
    })) { Reflect.set(display, name, value); }
    /** @type {Promise<void>[]} */
    const operations = [];
    display.history.on('stateChanged', () => {
        const operation = display._onStateChanged();
        operations.push(operation);
        void operation.catch(() => {});
    });
    return {display, render, report, operations};
}

/**
 * @param {string} query
 * @param {import('display').HistoryMode} [historyMode]
 * @returns {import('display').ContentDetails}
 */
function content(query, historyMode = 'new') {
    return {focus: false, params: {query, type: 'terms'}, state: null, content: null, historyMode};
}

/**
 * @param {Promise<void>} promise
 * @returns {{done: boolean}}
 */
function observe(promise) {
    const state = {done: false};
    void promise.then(() => { state.done = true; });
    return state;
}

for (const fails of [false, true]) {
    test(`older render ${fails ? 'failure' : 'completion'} does not acknowledge a newer pending render`, async ({window: _window}) => {
        vi.useFakeTimers();
        const {display, render, operations} = createDisplay();
        const older = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const newer = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        render.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const first = display.setContent(content('older'));
        const second = display.setContent(content('newer'));
        const firstState = observe(first);
        const secondState = observe(second);
        if (fails) {
            older.reject(new Error('Older lookup failed'));
        } else {
            older.resolve();
        }
        await operations[0];
        await Promise.resolve();
        expect(firstState.done).toBe(true);
        expect(secondState.done).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        newer.resolve();
        await Promise.all([first, second, ...operations]);
        expect(vi.getTimerCount()).toBe(0);
    });
}

test('newer render completion does not acknowledge an older still-pending operation', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render, operations} = createDisplay();
    const older = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    render.mockReturnValueOnce(older.promise);
    const first = display.setContent(content('older'));
    const firstState = observe(first);
    await display.setContent(content('newer'));
    expect(firstState.done).toBe(false);
    older.resolve();
    await Promise.all([first, ...operations]);
    expect(vi.getTimerCount()).toBe(0);
});

test('initial rendering without a setContent waiter cannot acknowledge a later request', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render, operations} = createDisplay();
    const initial = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const later = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    history.replaceState(null, '', '?type=terms&query=initial');
    render.mockReturnValueOnce(initial.promise).mockReturnValueOnce(later.promise);
    const initialRender = display._onStateChanged();
    const request = display.setContent(content('later'));
    const state = observe(request);
    initial.resolve();
    await initialRender;
    expect(state.done).toBe(false);
    later.resolve();
    await Promise.all([request, ...operations]);
    expect(vi.getTimerCount()).toBe(0);
});

for (const failure of ['history', 'parameters']) {
    test(`synchronous ${failure} failure releases its completion waiter and timer`, async ({window: _window}) => {
        vi.useFakeTimers();
        const {display} = createDisplay();
        if (failure === 'history') {
            vi.spyOn(display.history, 'replaceState').mockImplementationOnce(() => { throw new Error('History unavailable'); });
        }
        const details = content('failure');
        if (failure === 'parameters') { details.params = /** @type {import('display').HistoryParams} */ (/** @type {unknown} */ (null)); }
        expect(() => display.setContent(details)).toThrow();
        expect(display._stateChangeCompleteResolvers).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        await display.setContent(content('recovered'));
        expect(vi.getTimerCount()).toBe(0);
    });
}

for (const mode of /** @type {import('display').HistoryMode[]} */ (['clear', 'overwrite', 'new'])) {
    test(`${mode} history mode completes only after its own render`, async ({window: _window}) => {
        vi.useFakeTimers();
        const {display, render, operations} = createDisplay();
        display._historyHasChanged = true;
        const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        render.mockReturnValueOnce(pending.promise);
        const completion = display.setContent(content('request', mode));
        const state = observe(completion);
        await Promise.resolve();
        expect(state.done).toBe(false);
        pending.resolve();
        await Promise.all([completion, ...operations]);
        expect(vi.getTimerCount()).toBe(0);
    });
}

test('a render failure settles its own completion and the next request works', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render, report, operations} = createDisplay();
    const error = new Error('Lookup failed');
    render.mockRejectedValueOnce(error);
    await display.setContent(content('failed'));
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    await display.setContent(content('recovered'));
    await Promise.all(operations);
    expect(render).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
});

test('ignored history metadata updates cannot take over an active render completion', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render, operations} = createDisplay();
    const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    render.mockReturnValueOnce(pending.promise);
    const completion = display.setContent(content('pending'));
    const state = observe(completion);
    display._replaceHistoryStateNoNavigate({}, null);
    await operations[1];
    expect(state.done).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([completion, ...operations]);
    expect(vi.getTimerCount()).toBe(0);
});

test('an older timeout and late completion cannot settle a newer waiting render', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render, operations} = createDisplay();
    const older = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const newer = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    render.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = display.setContent(content('older'));
    await vi.advanceTimersByTimeAsync(1000);
    const second = display.setContent(content('newer'));
    const state = observe(second);
    await vi.advanceTimersByTimeAsync(4000);
    await first;
    expect(state.done).toBe(false);
    older.resolve();
    await operations[0];
    expect(state.done).toBe(false);
    newer.resolve();
    await Promise.all([second, ...operations]);
    expect(vi.getTimerCount()).toBe(0);
});

test('a failure before render setup settles its request and later rendering recovers', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, report, operations, render} = createDisplay();
    const error = new Error('Notification teardown failed');
    Reflect.set(display, '_dictionaryAvailabilityNotification', {close: vi.fn().mockImplementationOnce(() => { throw error; })});
    const completion = display.setContent(content('failed'));
    await operations[0];
    const state = observe(completion);
    await Promise.resolve();
    expect(state.done).toBe(true);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(render).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await display.setContent(content('recovered'));
    expect(render).toHaveBeenCalledTimes(1);
});

test('a throwing error reporter does not reject the history handler or strand its completion', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render, report, operations} = createDisplay();
    render.mockRejectedValueOnce(new Error('Lookup failed'));
    report.mockImplementationOnce(() => { throw new Error('Error reporting failed'); });
    const completion = display.setContent(content('failed'));
    await expect(operations[0]).resolves.toBeUndefined();
    const state = observe(completion);
    await Promise.resolve();
    expect(state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await display.setContent(content('recovered'));
    expect(render).toHaveBeenCalledTimes(2);
});

test('failed final profiling cannot reject history events or retain completion timers', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, operations} = createDisplay();
    vi.mocked(safePerformance.measure).mockImplementation((name) => {
        if (name === 'display:_onStateChanged') { throw new Error('Profiling unavailable'); }
        return void 0;
    });
    const completion = display.setContent(content('request'));
    await expect(operations[0]).resolves.toBeUndefined();
    const state = observe(completion);
    await Promise.resolve();
    expect(state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

test('the bounded completion fallback still settles when no render event is handled', async ({window: _window}) => {
    vi.useFakeTimers();
    const {display, render} = createDisplay();
    display._historyChangeIgnore = true;
    const completion = display.setContent(content('ignored'));
    const state = observe(completion);
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await completion;
    expect(display._stateChangeCompleteResolvers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(render).not.toHaveBeenCalled();
});
