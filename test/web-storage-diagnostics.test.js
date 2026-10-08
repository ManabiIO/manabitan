/* SPDX-License-Identifier: GPL-3.0-or-later */
import {expect, test} from 'vitest';
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
        estimate: async () => {throw new Error('Quota API temporarily blocked');},
        persisted: async () => true,
    });
    expect(data).toEqual({usage: undefined, quota: undefined, persisted: true});
});

test('missing or rejected persistence status is reported conservatively', async () => {
    const missing = await webStorageDiagnostics({});
    expect(missing).toEqual({usage: undefined, quota: undefined, persisted: false});
    const rejected = await webStorageDiagnostics({
        estimate: async () => ({usage: 1024}),
        persisted: async () => {throw new DOMException('Blocked', 'SecurityError');},
    });
    expect(rejected).toEqual({usage: 1024, quota: undefined, persisted: false});
});

test('synchronous diagnostic errors are also isolated', async () => {
    const data = await webStorageDiagnostics({
        estimate() {throw new Error('Sync failure');},
        persisted() {throw new Error('Sync failure');},
    });
    expect(data).toEqual({usage: undefined, quota: undefined, persisted: false});
});
