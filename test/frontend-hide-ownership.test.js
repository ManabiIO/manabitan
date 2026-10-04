/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {log} from '../ext/js/core/log.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/**
 * @returns {{frontend: Frontend, hide: import('vitest').Mock, clear: import('vitest').Mock, pointer: import('vitest').Mock<() => Promise<boolean>>, report: import('vitest').MockInstance<typeof log.error>}}
 */
function setup() {
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    const hide = vi.fn();
    const clear = vi.fn();
    const pointer = vi.fn(/** @returns {Promise<boolean>} */ async () => false);
    for (const [name, value] of Object.entries({
        _clearSelectionTimer: null,
        _clearSelectionRequest: null,
        _isPointerOverPopup: false,
        _isPointerOverAnyPopup: pointer,
        _popup: {hide, clearAutoPlayTimer: vi.fn().mockResolvedValue(void 0)},
        _textScanner: {hasSelection: () => true, clearSelection: clear},
    })) { Reflect.set(frontend, name, value); }
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    return {frontend, hide, clear, pointer, report};
}

test('healthy zero-delay hiding retains the event-settling delay and hides exactly once', async () => {
    const {frontend, hide, clear} = setup();
    const request = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(49);
    expect(hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(hide).toHaveBeenCalledExactlyOnceWith(true);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

test('configured delay and passive focus policy are preserved', async () => {
    const {frontend, hide} = setup();
    const request = frontend._clearSelectionDelayed(100, false, true);
    await vi.advanceTimersByTimeAsync(149);
    expect(hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(hide).toHaveBeenCalledExactlyOnceWith(false);
});

test('cancellation during the initial event wait prevents latent hiding and releases timers', async () => {
    const {frontend, hide, clear, pointer} = setup();
    const request = frontend._clearSelectionDelayed(100, false, false);
    frontend._stopClearSelectionDelayed();
    await vi.advanceTimersByTimeAsync(150);
    await request;
    expect(hide).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

test('cancellation during the first pointer check prevents hiding newer content', async () => {
    const {frontend, hide, pointer} = setup();
    const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    pointer.mockReturnValueOnce(pending.promise);
    const request = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    frontend._stopClearSelectionDelayed();
    pending.resolve(false);
    await request;
    expect(hide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

test('cancellation during the configured delay clears the timer and settles the request', async () => {
    const {frontend, hide} = setup();
    const request = frontend._clearSelectionDelayed(100, false, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(1);
    frontend._stopClearSelectionDelayed();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await request;
    expect(hide).not.toHaveBeenCalled();
});

test('cancellation during the final pointer check prevents a stale callback from hiding', async () => {
    const {frontend, hide, pointer} = setup();
    const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    pointer.mockResolvedValueOnce(false).mockReturnValueOnce(pending.promise);
    const request = frontend._clearSelectionDelayed(100, false, false);
    await vi.advanceTimersByTimeAsync(150);
    expect(pointer).toHaveBeenCalledTimes(2);
    frontend._stopClearSelectionDelayed();
    pending.resolve(false);
    await request;
    await Promise.resolve();
    expect(hide).not.toHaveBeenCalled();
});

test('restart supersedes an older operation still in its initial wait', async () => {
    const {frontend, hide} = setup();
    const older = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(25);
    const newer = frontend._clearSelectionDelayed(100, true, false);
    await vi.advanceTimersByTimeAsync(25);
    expect(hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(125);
    await Promise.all([older, newer]);
    expect(hide).toHaveBeenCalledTimes(1);
});

test('non-restarting requests share pending event work without postponing hiding', async () => {
    const {frontend, hide, pointer} = setup();
    const first = frontend._clearSelectionDelayed(100, false, false);
    await vi.advanceTimersByTimeAsync(25);
    const repeated = frontend._clearSelectionDelayed(100, false, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(pointer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(75);
    await Promise.all([first, repeated]);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(pointer).toHaveBeenCalledTimes(2);
});

test('pointer-check rejection is contained and leaves a later request retryable', async () => {
    const {frontend, hide, pointer, report} = setup();
    const error = new Error('Pointer check unavailable');
    pointer.mockRejectedValueOnce(error);
    const first = frontend._clearSelectionDelayed(0, false, false);
    const observed = first.then(() => null, (failure) => failure);
    await vi.advanceTimersByTimeAsync(50);
    expect(await observed).toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(hide).not.toHaveBeenCalled();
    const retry = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    await retry;
    expect(hide).toHaveBeenCalledTimes(1);
});

test('the final asynchronous timer pointer check cannot leak rejection', async () => {
    const {frontend, hide, pointer, report} = setup();
    const error = new Error('Final pointer check unavailable');
    pointer.mockResolvedValueOnce(false).mockImplementationOnce(async () => { throw error; });
    const request = frontend._clearSelectionDelayed(100, false, false);
    const observed = request.then(() => null, (failure) => failure);
    await vi.advanceTimersByTimeAsync(150);
    expect(await observed).toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(hide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

test('a throwing reporter cannot strand the hide request or leak rejection', async () => {
    const {frontend, pointer, report} = setup();
    pointer.mockRejectedValueOnce(new Error('Pointer check failed'));
    report.mockImplementationOnce(() => { throw new Error('Reporter failed'); });
    const request = frontend._clearSelectionDelayed(0, false, false);
    const observed = request.then(() => null, (failure) => failure);
    await vi.advanceTimersByTimeAsync(50);
    expect(await observed).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

test('pointer presence cancels automatic hiding without poisoning the next attempt', async () => {
    const {frontend, hide, pointer} = setup();
    pointer.mockResolvedValueOnce(true);
    const first = frontend._clearSelectionDelayed(100, false, false);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    expect(hide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const next = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    await next;
    expect(hide).toHaveBeenCalledTimes(1);
});

test('manual clearing invalidates an outstanding pointer check without duplicate hides', async () => {
    const {frontend, hide, clear, pointer} = setup();
    const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    pointer.mockReturnValueOnce(pending.promise);
    const request = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    frontend._clearSelection(false);
    pending.resolve(false);
    await request;
    expect(hide).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
});

test('no selection starts no timers or pointer checks', async () => {
    const {frontend, hide, pointer} = setup();
    vi.spyOn(frontend._textScanner, 'hasSelection').mockReturnValue(false);
    await frontend._clearSelectionDelayed(100, false, false);
    expect(hide).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});

test('superseding a pointer check cannot let its completion clear the replacement timer', async () => {
    const {frontend, hide, pointer} = setup();
    const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    pointer.mockReturnValueOnce(pending.promise);
    const older = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    const newer = frontend._clearSelectionDelayed(100, true, false);
    pending.resolve(false);
    await older;
    expect(hide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    await newer;
    expect(hide).toHaveBeenCalledTimes(1);
});

test('a stale pointer failure cannot report an error or poison newer work', async () => {
    const {frontend, hide, pointer, report} = setup();
    const pending = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    pointer.mockReturnValueOnce(pending.promise);
    const older = frontend._clearSelectionDelayed(0, false, false);
    const observed = older.then(() => null, (failure) => failure);
    await vi.advanceTimersByTimeAsync(50);
    frontend._stopClearSelectionDelayed();
    const newer = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    await newer;
    pending.reject(new Error('Stale pointer failure'));
    expect(await observed).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalledTimes(1);
});

test('pointer presence at the final check releases ownership for a later hide', async () => {
    const {frontend, hide, pointer} = setup();
    pointer.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const first = frontend._clearSelectionDelayed(100, false, false);
    await vi.advanceTimersByTimeAsync(150);
    await first;
    expect(hide).not.toHaveBeenCalled();
    const next = frontend._clearSelectionDelayed(0, false, false);
    await vi.advanceTimersByTimeAsync(50);
    await next;
    expect(hide).toHaveBeenCalledTimes(1);
});
