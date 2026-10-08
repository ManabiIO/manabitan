/* SPDX-License-Identifier: GPL-3.0-or-later */
import {expect, test, vi} from 'vitest';
import {webStorageDiagnostics} from '../ext/web/storage-diagnostics.js';

test('origin storage telemetry returns measured values when available', async () => {
    const data = await webStorageDiagnostics({
        estimate: async () => ({usage: 2048, quota: 4096}),
        persisted: async () => true,
    });
    expect(data).toEqual({usage: 2048, quota: 4096, persisted: true});
});

test('quota estimate failure does not hide a successful persistence check', async () => {
    const data = await webStorageDiagnostics({
        estimate: async () => { throw new Error('Quota API temporarily blocked'); },
        persisted: async () => true,
    });
    expect(data.usage).toBeUndefined();
    expect(data.quota).toBeUndefined();
    expect(data.persisted).toBe(true);
});

test('missing or rejected persistence status is reported conservatively', async () => {
    const missing = await webStorageDiagnostics({});
    expect(missing.usage).toBeUndefined();
    expect(missing.quota).toBeUndefined();
    expect(missing.persisted).toBe(false);
    const rejected = await webStorageDiagnostics({
        estimate: async () => ({usage: 1024}),
        persisted: async () => { throw new DOMException('Blocked', 'SecurityError'); },
    });
    expect(rejected.usage).toBe(1024);
    expect(rejected.quota).toBeUndefined();
    expect(rejected.persisted).toBe(false);
});

test('synchronous diagnostic errors are also isolated', async () => {
    const data = await webStorageDiagnostics({
        estimate() { throw new Error('Sync failure'); },
        persisted() { throw new Error('Sync failure'); },
    });
    expect(data.usage).toBeUndefined();
    expect(data.quota).toBeUndefined();
    expect(data.persisted).toBe(false);
});

test('a hanging quota estimate cannot block known persistence or dictionary status', async () => {
    vi.useFakeTimers();
    try {
        const pending = webStorageDiagnostics({
            estimate: () => new Promise(() => {}),
            persisted: async () => true,
        });
        await vi.advanceTimersByTimeAsync(2000);
        const data = await pending;
        expect(data.usage).toBeUndefined();
        expect(data.quota).toBeUndefined();
        expect(data.persisted).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});
