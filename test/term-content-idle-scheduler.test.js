/*
 * Copyright (C) 2026 Manabitan authors
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

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {TermContentIdleScheduler} from '../ext/js/dictionary/term-content-idle-scheduler.js';

/** @typedef {(signal: AbortSignal) => Promise<{pending: boolean, retryAt?: number}>} RunStep */
/** @typedef {Partial<Omit<ConstructorParameters<typeof TermContentIdleScheduler>[0], 'runStep'>>} SchedulerOptions */

/** @returns {{promise: Promise<void>, resolve: (value?: void|PromiseLike<void>) => void, reject: (reason?: unknown) => void}} */
const deferred = () => {
    /** @type {(value?: void|PromiseLike<void>) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return {promise, resolve, reject};
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/**
 * @param {RunStep|import('vitest').Mock<RunStep>} [runStep]
 * @param {SchedulerOptions} [options]
 * @returns {{runStep: RunStep|import('vitest').Mock<RunStep>, scheduler: TermContentIdleScheduler}}
 */
function setup(runStep, options = {}) {
    const actualRunStep = runStep ?? vi.fn(async () => ({pending: false}));
    const scheduler = new TermContentIdleScheduler({
        runStep: /** @type {RunStep} */ (/** @type {unknown} */ (actualRunStep)),
        idleMs: 10,
        retryMs: 100,
        ...options,
    });
    return {runStep: actualRunStep, scheduler};
}

test('does not load/run maintenance before explicit readiness or full import release', async () => {
    const {scheduler, runStep} = setup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).not.toHaveBeenCalled();

    scheduler.setHold('import-a', true);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).not.toHaveBeenCalled();

    scheduler.setHold('import-a', false);
    await vi.advanceTimersByTimeAsync(9);
    expect(runStep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runStep).toHaveBeenCalledTimes(1);
    await scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
});

test('long archive acquisition and multiple owner holds cannot restart background work', async () => {
    const {scheduler, runStep} = setup();
    scheduler.wake();
    scheduler.setHold('page-a', true);
    scheduler.setHold('page-a', true);
    scheduler.setHold('page-b', true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(runStep).not.toHaveBeenCalled();

    scheduler.setHold('page-a', false);
    scheduler.setHold('page-a', false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(runStep).not.toHaveBeenCalled();

    scheduler.setHold('page-b', false);
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(1);
    await scheduler.close();
});

test('full import ownership release wakes post-import discovery after earlier startup work completed', async () => {
    const runStep = vi.fn().mockResolvedValueOnce({pending: false}).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(1);

    scheduler.setHold('page-a', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).toHaveBeenCalledTimes(1);

    scheduler.setHold('page-a', false);
    await vi.advanceTimersByTimeAsync(9);
    expect(runStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});

test('foreground abort is synchronous and foreground does not wait for outstanding optional I/O', async () => {
    const io = deferred();
    const terminated = vi.fn();
    const runStep = vi.fn(/** @type {RunStep} */ (async (signal) => {
        signal.addEventListener('abort', terminated, {once: true});
        await io.promise;
        return {pending: true};
    }));
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    const release = scheduler.foregroundStarted();
    expect(terminated).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).toHaveBeenCalledTimes(1);
    release();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).toHaveBeenCalledTimes(1);

    io.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalled();
    await scheduler.close();
});

test('adjacent visible requests each retire exactly once before the idle timer restarts', async () => {
    const {scheduler, runStep} = setup();
    scheduler.wake();
    const a = scheduler.foregroundStarted();
    const b = scheduler.foregroundStarted();
    a();
    a();
    await vi.advanceTimersByTimeAsync(100);
    expect(runStep).not.toHaveBeenCalled();

    b();
    await vi.advanceTimersByTimeAsync(9);
    expect(runStep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runStep).toHaveBeenCalledTimes(1);
    await scheduler.close();
});

test('one bounded step at a time even when many wakeups arrive during it', async () => {
    const io = deferred();
    const runStep = vi.fn().mockImplementationOnce(async () => {
        await io.promise;
        return {pending: false};
    }).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 30; ++i) {
        scheduler.wake();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).toHaveBeenCalledTimes(1);

    io.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});

test('bounded steps yield a task without repeating the full foreground quiet window', async () => {
    const runStep = vi.fn().mockResolvedValueOnce({pending: true}).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(runStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});

test('foreground between bounded steps restores the full quiet window', async () => {
    const runStep = vi.fn().mockResolvedValueOnce({pending: true}).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    const release = scheduler.foregroundStarted();
    await vi.advanceTimersByTimeAsync(50);
    expect(runStep).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(9);
    expect(runStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});

test('unexpected optional failure backs off even when diagnostics throw', async () => {
    const failure = new Error('Optional I/O failed');
    const onError = vi.fn(() => { throw new Error('diagnostics'); });
    const runStep = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep, {onError});
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(failure);

    await vi.advanceTimersByTimeAsync(99);
    expect(runStep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
});

test('new candidate wakeup rechecks eligibility while per-job cooldown stays owned by the adapter', async () => {
    const runStep = vi.fn().mockResolvedValueOnce({pending: true, retryAt: 10000}).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});

test('close cancels immediately, joins old work, ignores late completion and never starts again', async () => {
    const io = deferred();
    const received = {signal: /** @type {AbortSignal|null} */ (null)};
    const {scheduler, runStep} = setup(vi.fn(/** @type {RunStep} */ (async (signal) => {
        received.signal = signal;
        await io.promise;
        return {pending: true};
    })));
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);

    const closed = scheduler.close();
    expect(received.signal?.aborted).toBe(true);
    let joined = false;
    void closed.then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    scheduler.wake();
    scheduler.setHold('a', false);
    scheduler.foregroundStarted()();

    io.resolve();
    await closed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.close();
});

test('preemption inside a synchronous step admission still settles and preserves a trailing wake', async () => {
    /** @type {() => void} */
    let release = () => {};
    const runStep = vi.fn().mockImplementationOnce(async () => {
        release = scheduler.foregroundStarted();
        return {pending: false};
    }).mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});

test('malformed step results are optional failures with bounded retry, never tight loops', async () => {
    const onError = vi.fn();
    const runStep = vi.fn(async () => /** @type {import('core').SafeAny} */ ({pending: 'yes'}));
    const {scheduler} = setup(runStep, {onError});
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(runStep).toHaveBeenCalledTimes(1);
    await scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
});

for (const outcome of ['deferred', 'failed']) {
    test('a wake during an active step bypasses its old ' + outcome + ' cooldown', async () => {
        const io = deferred();
        const runStep = vi.fn().mockImplementationOnce(async () => {
            await io.promise;
            if (outcome === 'failed') { throw new Error('Old optional step failed'); }
            return {pending: false, retryAt: 60000};
        }).mockResolvedValue({pending: false});
        const {scheduler} = setup(runStep);
        scheduler.wake();
        await vi.advanceTimersByTimeAsync(10);
        expect(runStep).toHaveBeenCalledTimes(1);
        scheduler.wake();
        io.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect(runStep).toHaveBeenCalledTimes(2);
        await scheduler.close();
        expect(vi.getTimerCount()).toBe(0);
    });
}


test('full import release rechecks a new generation before an earlier queue retry', async () => {
    const runStep = vi.fn().mockResolvedValueOnce({pending: true, retryAt: Date.now() + 10000})
        .mockResolvedValue({pending: false});
    const {scheduler} = setup(runStep);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(1);
    scheduler.setHold('import-owner', true);
    scheduler.setHold('import-owner', false);
    await vi.advanceTimersByTimeAsync(10);
    expect(runStep).toHaveBeenCalledTimes(2);
    await scheduler.close();
});
