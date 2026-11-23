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

/** Shape of the retained runtime import study's evidence inventory. */
export type RuntimeImportEvidenceIndex = {
    schemaVersion: 1;
    bundles: RuntimeImportEvidenceBundle[];
};

export type RuntimeImportEvidenceBundle = {
    path: string;
    bytes: number;
    sha256: string;
    files: number;
    candidate?: 'cache' | 'columns' | 'row' | 'source' | 'combined';
    dictionary?: 'jmdict' | 'jitendex' | 'vndb';
    stage?: 'screen' | 'qualification';
    artifactId?: number;
    timedReports?: number;
    diagnostics?: number;
};
