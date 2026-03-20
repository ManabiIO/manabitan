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

const DICTIONARY_AUTO_UPDATE_INTERVALS_MS = Object.freeze({
    manual: null,
    hourly: 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
});

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeTimestamp(value) {
    return (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is import('dictionary-importer').DictionaryAutoUpdateSchedule}
 */
export function isDictionaryAutoUpdateSchedule(value) {
    return (
        typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(DICTIONARY_AUTO_UPDATE_INTERVALS_MS, value)
    );
}

/**
 * @param {import('dictionary-importer').DictionaryAutoUpdateSchedule} schedule
 * @param {number|null|undefined} referenceTimestamp
 * @returns {number|null}
 */
export function getNextDictionaryAutoUpdateTime(schedule, referenceTimestamp) {
    const interval = isDictionaryAutoUpdateSchedule(schedule) ? DICTIONARY_AUTO_UPDATE_INTERVALS_MS[schedule] : null;
    const normalizedReferenceTimestamp = normalizeTimestamp(referenceTimestamp);
    return (interval !== null && normalizedReferenceTimestamp !== null) ? normalizedReferenceTimestamp + interval : null;
}

/**
 * @param {import('dictionary-importer').DictionaryAutoUpdateSchedule} schedule
 * @param {number|null|undefined} lastUpdatedAt
 * @param {number|null|undefined} [nextUpdateAt]
 * @returns {import('dictionary-importer').DictionaryAutoUpdateInfo}
 */
export function createDictionaryAutoUpdate(schedule, lastUpdatedAt, nextUpdateAt = void 0) {
    const normalizedSchedule = isDictionaryAutoUpdateSchedule(schedule) ? schedule : 'manual';
    const normalizedLastUpdatedAt = normalizeTimestamp(lastUpdatedAt);
    const normalizedNextUpdateAt = normalizeTimestamp(nextUpdateAt);
    return {
        schedule: normalizedSchedule,
        lastUpdatedAt: normalizedLastUpdatedAt,
        nextUpdateAt: (
            normalizedSchedule === 'manual' ?
                null :
                normalizedNextUpdateAt ?? getNextDictionaryAutoUpdateTime(normalizedSchedule, normalizedLastUpdatedAt)
        ),
    };
}

/**
 * @param {import('dictionary-importer').Summary} summary
 * @returns {import('dictionary-importer').Summary}
 */
export function normalizeDictionarySummary(summary) {
    const normalizedSummary = (
        typeof summary === 'object' &&
        summary !== null &&
        !Array.isArray(summary)
    ) ?
        summary :
        /** @type {import('dictionary-importer').Summary} */ ({});
    const importDate = normalizeTimestamp(normalizedSummary.importDate);
    /** @type {{schedule?: unknown, lastUpdatedAt?: unknown, nextUpdateAt?: unknown}} */
    const rawAutoUpdate = (
        typeof normalizedSummary.autoUpdate === 'object' &&
        normalizedSummary.autoUpdate !== null &&
        !Array.isArray(normalizedSummary.autoUpdate)
    ) ?
        normalizedSummary.autoUpdate :
        {};
    const schedule = (
        normalizedSummary.isUpdatable === true &&
        isDictionaryAutoUpdateSchedule(rawAutoUpdate.schedule)
    ) ?
        rawAutoUpdate.schedule :
        'manual';
    const lastUpdatedAt = normalizeTimestamp(rawAutoUpdate.lastUpdatedAt) ?? importDate;
    const nextUpdateAt = normalizeTimestamp(rawAutoUpdate.nextUpdateAt);
    const autoUpdate = createDictionaryAutoUpdate(schedule, lastUpdatedAt, nextUpdateAt);
    return {
        ...normalizedSummary,
        autoUpdate,
    };
}

/**
 * @param {import('dictionary-importer').Summary} summary
 * @param {{schedule?: import('dictionary-importer').DictionaryAutoUpdateSchedule, lastUpdatedAt?: number|null, nextUpdateAt?: number|null}} [details]
 * @returns {import('dictionary-importer').Summary}
 */
export function setDictionarySummaryAutoUpdate(summary, details = {}) {
    const normalizedSummary = normalizeDictionarySummary(summary);
    const {schedule, lastUpdatedAt, nextUpdateAt} = details;
    const normalizedAutoUpdate = /** @type {import('dictionary-importer').DictionaryAutoUpdateInfo} */ (normalizedSummary.autoUpdate);
    const requestedSchedule = typeof schedule === 'undefined' ? normalizedAutoUpdate.schedule : schedule;
    const nextSchedule = (
        normalizedSummary.isUpdatable === true &&
        isDictionaryAutoUpdateSchedule(requestedSchedule)
    ) ?
        requestedSchedule :
        'manual';
    const nextLastUpdatedAt = Object.prototype.hasOwnProperty.call(details, 'lastUpdatedAt') ?
        normalizeTimestamp(lastUpdatedAt) :
        normalizedAutoUpdate.lastUpdatedAt;
    let nextNextUpdateAt;
    if (Object.prototype.hasOwnProperty.call(details, 'nextUpdateAt')) {
        nextNextUpdateAt = normalizeTimestamp(nextUpdateAt);
    } else if (
        nextSchedule === normalizedAutoUpdate.schedule &&
        nextLastUpdatedAt === normalizedAutoUpdate.lastUpdatedAt
    ) {
        nextNextUpdateAt = normalizedAutoUpdate.nextUpdateAt;
    } else {
        nextNextUpdateAt = null;
    }
    return {
        ...normalizedSummary,
        autoUpdate: createDictionaryAutoUpdate(nextSchedule, nextLastUpdatedAt, nextNextUpdateAt),
    };
}
