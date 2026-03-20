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

import type * as DictionaryImporter from './dictionary-importer';

export function isDictionaryAutoUpdateSchedule(value: unknown): value is DictionaryImporter.DictionaryAutoUpdateSchedule;

export function getNextDictionaryAutoUpdateTime(
    schedule: DictionaryImporter.DictionaryAutoUpdateSchedule,
    referenceTimestamp: number | null | undefined,
): number | null;

export function createDictionaryAutoUpdate(
    schedule: DictionaryImporter.DictionaryAutoUpdateSchedule,
    lastUpdatedAt: number | null | undefined,
): DictionaryImporter.DictionaryAutoUpdateInfo;

export function normalizeDictionarySummary(summary: DictionaryImporter.Summary): DictionaryImporter.Summary;

export function setDictionarySummaryAutoUpdate(
    summary: DictionaryImporter.Summary,
    details?: {
        schedule?: DictionaryImporter.DictionaryAutoUpdateSchedule;
        lastUpdatedAt?: number | null;
    },
): DictionaryImporter.Summary;
