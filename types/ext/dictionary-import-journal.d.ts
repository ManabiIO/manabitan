/*
 * Copyright (C) 2026  Manabitan authors
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

declare module 'dictionary-import-journal' {
    export type LegacyTermContentCheckpoint = {
        version?: 1;
        segments: Array<{fileName: string, fileLength: number}>;
    };

    export type TermContentArenaCheckpoint = {
        version: 2;
        storageEpoch: number;
        logicalHighWater: number;
        arenaNamespace: string;
        segments: [];
    };

    export type TermContentCheckpoint = LegacyTermContentCheckpoint | TermContentArenaCheckpoint;

    export type TermContentArenaFile = {
        fileId: string;
        path: string;
        byteLength: number;
        logicalStart: number;
        logicalEnd: number;
    };

    export type SealedTermContentArena = {
        checkpoint: TermContentArenaCheckpoint;
        arenaNamespace: string;
        storageEpoch: number;
        logicalStart: number;
        logicalEnd: number;
        logicalHighWater: number;
        files: TermContentArenaFile[];
    };

    export type TermRecordCheckpoint = {
        shards: Array<{fileName: string, fileLength: number}>;
    };

    export type DictionaryImportJournalRecord = {
        version: 1 | 2;
        sessionId: string;
        contentCheckpoint: TermContentCheckpoint;
        recordCheckpoint: TermRecordCheckpoint;
        createdAt: number;
    };
}
