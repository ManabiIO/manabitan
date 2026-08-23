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

/**
 * @typedef {'lookup'|'exclusive'|'cancellation'|'streamed-import'} DictionaryRuntimeConcurrency
 * @typedef {'interactive'|'standard'|'maintenance'|'streamed-import'} DictionaryRuntimeTimeoutClass
 * @typedef {{
 *   concurrency: DictionaryRuntimeConcurrency,
 *   timeoutClass: DictionaryRuntimeTimeoutClass,
 *   retryable: boolean,
 *   requiresDatabase: boolean,
 * }} DictionaryRuntimeActionPolicy
 */

const interactiveLookupPolicy = Object.freeze({
    concurrency: /** @type {const} */ ('lookup'),
    timeoutClass: /** @type {const} */ ('interactive'),
    retryable: true,
    requiresDatabase: true,
});

const standardReadPolicy = Object.freeze({
    concurrency: /** @type {const} */ ('exclusive'),
    timeoutClass: /** @type {const} */ ('standard'),
    retryable: false,
    requiresDatabase: true,
});

const maintenancePolicy = Object.freeze({
    concurrency: /** @type {const} */ ('exclusive'),
    timeoutClass: /** @type {const} */ ('maintenance'),
    retryable: false,
    requiresDatabase: true,
});

const cooperativeMaintenanceReadPolicy = Object.freeze({
    concurrency: /** @type {const} */ ('lookup'),
    timeoutClass: /** @type {const} */ ('maintenance'),
    retryable: false,
    requiresDatabase: true,
});

/** @type {Readonly<Record<string, Readonly<DictionaryRuntimeActionPolicy>>>} */
export const dictionaryRuntimeActionPolicies = Object.freeze({
    databasePrepareOffscreen: Object.freeze({
        concurrency: 'exclusive', timeoutClass: 'standard', retryable: false, requiresDatabase: false,
    }),
    getDatabaseRuntimeStateOffscreen: Object.freeze({
        concurrency: 'exclusive', timeoutClass: 'standard', retryable: false, requiresDatabase: false,
    }),
    databaseSetSuspendedOffscreen: Object.freeze({
        concurrency: 'exclusive', timeoutClass: 'maintenance', retryable: false, requiresDatabase: false,
    }),
    getDictionaryInfoOffscreen: standardReadPolicy,
    deleteDictionaryOffscreen: maintenancePolicy,
    replaceDictionaryTitleOffscreen: maintenancePolicy,
    getDictionaryCountsOffscreen: standardReadPolicy,
    getDictionaryTermProbeOffscreen: standardReadPolicy,
    findTermsBulkOffscreen: Object.freeze({
        concurrency: 'exclusive', timeoutClass: 'maintenance', retryable: false, requiresDatabase: true,
    }),
    // Cache warming only reads persistent state and uses the same coalesced
    // cache loaders as visible lookups. Let interactive reads run alongside it
    // so a best-effort post-import warm cannot become a first-hover barrier.
    warmTermLookupCachesOffscreen: cooperativeMaintenanceReadPolicy,
    debugDictionaryStorageStateOffscreen: maintenancePolicy,
    debugDictionaryLookupStateOffscreen: maintenancePolicy,
    databasePurgeOffscreen: maintenancePolicy,
    databaseRefreshOffscreen: maintenancePolicy,
    databaseGetMediaOffscreen: standardReadPolicy,
    translatorPrepareOffscreen: standardReadPolicy,
    findKanjiOffscreen: interactiveLookupPolicy,
    findTermsOffscreen: interactiveLookupPolicy,
    findTermsStructuredOffscreen: interactiveLookupPolicy,
    getTermFrequenciesOffscreen: interactiveLookupPolicy,
    clearDatabaseCachesOffscreen: Object.freeze({
        concurrency: 'exclusive', timeoutClass: 'standard', retryable: false, requiresDatabase: false,
    }),
    cancelDictionaryImportOffscreen: Object.freeze({
        concurrency: 'cancellation', timeoutClass: 'standard', retryable: false, requiresDatabase: false,
    }),
    importDictionaryOffscreen: Object.freeze({
        concurrency: 'streamed-import', timeoutClass: 'streamed-import', retryable: false, requiresDatabase: true,
    }),
    connectToDatabaseWorker: standardReadPolicy,
});

export const dictionaryRuntimeActionNames = Object.freeze(Object.keys(dictionaryRuntimeActionPolicies));

const unknownActionPolicy = Object.freeze({
    concurrency: /** @type {const} */ ('exclusive'),
    timeoutClass: /** @type {const} */ ('standard'),
    retryable: false,
    requiresDatabase: false,
});

/**
 * Unknown actions remain exclusive so the worker can return its normal structured error.
 * @param {string} action
 * @returns {Readonly<DictionaryRuntimeActionPolicy>}
 */
export function getDictionaryRuntimeActionPolicy(action) {
    return dictionaryRuntimeActionPolicies[action] ?? unknownActionPolicy;
}

/**
 * @param {string} action
 * @returns {boolean}
 */
export function hasDictionaryRuntimeActionPolicy(action) {
    return Object.hasOwn(dictionaryRuntimeActionPolicies, action);
}
