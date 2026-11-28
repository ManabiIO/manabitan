/*
 * Copyright (C) 2026  Yomitan Authors
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
/* eslint @stylistic/semi: ["error", "never"] */

/**
 * Parser workers send empty resolution columns until the ordered storage sink
 * needs them. Existing eager plans retain their arrays and resolved entries.
 * Allocate the complete triple before publishing any field so an allocation
 * failure leaves the plan retryable, including its epoch and resolution cursor.
 * @param {import('./dictionary-database.js').ArtifactTermContentDedupPlan} plan
 * @throws {RangeError} If a deferred plan is not in its initial state.
 */
export function initializeTermContentPlanResolution(plan) {
    if (plan.resolutionDeferred !== true) { return }
    const {uniqueCount, sourceRowCount} = plan
    if (
        typeof uniqueCount !== 'number' || !Number.isSafeInteger(uniqueCount) || uniqueCount <= 0 ||
        typeof sourceRowCount !== 'number' || !Number.isSafeInteger(sourceRowCount) || sourceRowCount < uniqueCount ||
        !(plan.uniqueRowIndexes instanceof Uint32Array) || plan.uniqueRowIndexes.length !== uniqueCount ||
        plan.resolvedFlags.length > 0 || plan.resolvedOffsets.length > 0 || plan.resolvedLengths.length > 0 ||
        plan.resolvedDictNames !== null || typeof plan.resolvedUniformDictName !== 'undefined' ||
        plan.pendingEpochs !== null || plan.pendingIndexes !== null ||
        plan.nextEpoch !== 1 || plan.nextUnresolvedUniqueIndex !== 0 || plan.persistedLookupRequired !== null
    ) {
        throw new RangeError('Deferred term content resolution metadata is invalid')
    }
    const flags = new Uint8Array(uniqueCount)
    const offsets = new Float64Array(uniqueCount)
    const lengths = new Uint32Array(uniqueCount)
    plan.resolvedFlags = flags
    plan.resolvedOffsets = offsets
    plan.resolvedLengths = lengths
    plan.resolutionDeferred = false
}
