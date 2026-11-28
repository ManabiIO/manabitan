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

// Keep room for SQLite publication, journals, and unrelated origin writes.
// The Storage API estimate is advisory; actual OPFS quota failures still
// follow the durable stage retry path.
const RESERVE_BYTES = 16 * 1024 * 1024;

/**
 * @param {number} writeBytes
 * @param {AbortSignal} [signal]
 * @param {() => Promise<StorageEstimate>} [estimate]
 * @returns {Promise<void>}
 * @throws {DOMException} If space is low, cannot be estimated, or work is preempted.
 */
export async function assertTermContentOptimizationHeadroom(
    writeBytes,
    signal,
    estimate = () => navigator.storage.estimate(),
) {
    if (!Number.isSafeInteger(writeBytes) || writeBytes <= 0 || writeBytes > Number.MAX_SAFE_INTEGER - RESERVE_BYTES) {
        throw new RangeError('Invalid optimizer staging size');
    }
    signal?.throwIfAborted();
    let storage;
    try {
        storage = await estimate();
    } catch (_) {
        // An unavailable estimate cannot authorize new optional writes.
    }
    signal?.throwIfAborted();
    const {quota, usage} = storage ?? {};
    if (typeof quota !== 'number' || typeof usage !== 'number' ||
    !Number.isFinite(quota) || !Number.isFinite(usage) || usage < 0 ||
    quota - usage < writeBytes + RESERVE_BYTES) {
        throw new DOMException('Insufficient or unknown OPFS headroom for online term content staging', 'QuotaExceededError');
    }
}
