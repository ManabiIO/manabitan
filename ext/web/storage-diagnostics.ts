/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {Status} from './protocol.js';

/**
 * Optional telemetry is not permitted to block a committed operation.
 * @param read
 */
async function limitedStorageMetric<T>(read: () => Promise<T> | undefined): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(read),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 2000);
            }),
        ]) ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Browser storage usage and persistence are best-effort diagnostics, not a
 * prerequisite for a committed dictionary lookup/import/delete to succeed.
 * @param storage
 */
export async function webStorageDiagnostics(storage: Partial<Pick<StorageManager, 'estimate' | 'persisted'>>): Promise<Status['storage']> {
    const [measured, persisted] = await Promise.all([
        limitedStorageMetric(() => storage.estimate?.()),
        limitedStorageMetric(() => storage.persisted?.()),
    ]);
    return {
        usage: measured?.usage,
        quota: measured?.quota,
        persisted: persisted === true,
    };
}
