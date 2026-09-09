/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

/** Shape of the immutable import benchmark fixture manifest.
 * Semantic hash, size, title, revision and row-count checks remain in the
 * performance fixture loader and its regression tests.
 */
export type PerformanceDictionaryLock = {
    schemaVersion: 1;
    dictionaries: Record<'jmdict' | 'jmnedict' | 'jitendex', PerformanceDictionaryFixture>;
};

export type PerformanceDictionaryFixture = {
    label: string;
    cacheFile: string;
    release: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    expectedTitle: string;
    revision: string;
    termRows: number;
};
