/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {Status} from './protocol.js';

/**
 * Browser storage usage and persistence are best-effort diagnostics, not a
 * prerequisite for a committed dictionary lookup/import/delete to succeed.
 * @param storage
 */
export async function webStorageDiagnostics(storage: Partial<Pick<StorageManager, 'estimate' | 'persisted'>>): Promise<Status['storage']> {
    const [estimate, persisted] = await Promise.allSettled([
        Promise.resolve().then(() => storage.estimate?.()),
        Promise.resolve().then(() => storage.persisted?.()),
    ]);
    const measured = estimate.status === 'fulfilled' ? estimate.value : null;
    return {
        usage: measured?.usage,
        quota: measured?.quota,
        persisted: persisted.status === 'fulfilled' && persisted.value === true,
    };
}
