/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

export const TERM_IMPORT_METRIC_KEYS = Object.freeze([
    'mediaResolveMs',
    'mediaWriteMs',
    'serializationMs',
    'bulkAddTermsMs',
    'contentAppendMs',
    'dedupScanMs',
    'contentStoreMs',
    'contentMetadataMs',
    'termRecordBuildMs',
    'termRecordEncodeMs',
    'termRecordWriteMs',
    'termsVtabInsertMs',
    'termRecordInternMs',
    'termRecordPackLengthsMs',
    'termRecordHeapCopyMs',
    'termRecordWasmEncodeMs',
]);

/**
 * @returns {Record<string, number>}
 */
export function createTermImportMetrics() {
    /** @type {Record<string, number>} */
    const metrics = {};
    for (const key of TERM_IMPORT_METRIC_KEYS) {
        metrics[key] = 0;
    }
    return metrics;
}

/**
 * @param {Record<string, number>} target
 * @param {Record<string, number|null|undefined>} source
 * @returns {Record<string, number>}
 */
export function addTermImportMetrics(target, source) {
    for (const key of TERM_IMPORT_METRIC_KEYS) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            target[key] = (target[key] ?? 0) + value;
        }
    }
    return target;
}

/**
 * Copies only the stable import metrics into diagnostics payloads.
 * @param {Record<string, number|null|undefined>} source
 * @returns {Record<string, number>}
 */
export function copyTermImportMetrics(source) {
    return addTermImportMetrics(createTermImportMetrics(), source);
}
