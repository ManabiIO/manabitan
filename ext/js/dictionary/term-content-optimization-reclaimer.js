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

import {parseJson} from '../core/json.js';
import {toError} from '../core/to-error.js';
import {parseContentPhysicalFile} from './term-content-physical-file-store.js';

/** @typedef {import('@sqlite.org/sqlite-wasm').Database} Database */
/** @typedef {import('./term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('./term-content-physical-file-store.js').ContentPhysicalFile} PhysicalFile */
/** @typedef {PhysicalFile & {ownerJobId: string, sha256: string|null, state: string}} OwnedFile */
/** @typedef {{sequence: number, metadataJson: string}} Retirement */
/** @typedef {{file: OwnedFile, retirement: Retirement|null}} Deletion */

const LEASE_RETRY_MS = 1000;

// Foreground reads follow the root directory and require the corresponding
// root-layout row. A missing or incompatible join invalidates the closure.
const LIVE_LAYOUTS = `
    WITH liveRoots AS (
        SELECT rootId, logicalHighWater, manifestJson FROM termContentStorageRoots
        WHERE state IN ('active', 'staged') AND epoch > 0
    ), liveRegions AS (
        SELECT root.rootId,
            json_extract(region.value, '$.regionId') AS regionId,
            json_extract(region.value, '$.layoutId') AS layoutId,
            json_extract(region.value, '$.logicalStart') AS logicalStart,
            json_extract(region.value, '$.logicalLength') AS logicalLength,
            LAG(json_extract(region.value, '$.logicalStart') + json_extract(region.value, '$.logicalLength'), 1, 0)
                OVER (PARTITION BY root.rootId ORDER BY region.key) AS previousEnd
        FROM liveRoots root CROSS JOIN json_each(root.manifestJson, '$.regions') region
    ), liveLayouts AS (
        SELECT region.*, l.manifestJson
        FROM liveRegions region
        LEFT JOIN termContentStorageRootLayouts r ON r.rootId = region.rootId
            AND r.regionId = region.regionId AND r.layoutId = region.layoutId
            AND r.logicalStart = region.logicalStart AND r.logicalLength = region.logicalLength
        LEFT JOIN termContentStorageLayouts l ON l.layoutId = r.layoutId
            AND l.regionId = r.regionId AND l.version = 1
    )
`;

/**
 * Removes one file per step. Its exact claim is committed before touching OPFS
 * so preemption or a lost acknowledgement can replay the same deletion.
 */
export class TermContentOptimizationReclaimer {
    /**
     * @param {{getDb: () => Database, assertReady: () => void, hasActiveLeases: () => boolean, removeFile: (file: PhysicalFile) => Promise<void>, confirmAutocommit: (db: Database) => boolean, quarantine: (errors: Error[]) => void, now?: () => number}} options
     */
    constructor({getDb, assertReady, hasActiveLeases, removeFile, confirmAutocommit, quarantine, now = Date.now}) {
        /** @type {() => Database} */
        this._getDb = getDb;
        /** @type {() => void} */
        this._assertReady = assertReady;
        /** @type {() => boolean} */
        this._hasActiveLeases = hasActiveLeases;
        /** @type {(file: PhysicalFile) => Promise<void>} */
        this._removeFile = removeFile;
        /** @type {(db: Database) => boolean} */
        this._confirmAutocommit = confirmAutocommit;
        /** @type {(errors: Error[]) => void} */
        this._quarantine = quarantine;
        /** @type {() => number} */
        this._now = now;
        /** @type {boolean} */
        this._running = false;
    }

    /**
     * @param {Job} job
     * @param {AbortSignal} signal
     * @returns {Promise<{job: Job, done: boolean, retryAt?: number}>}
     * @throws {Error} If admission or durable ownership changes.
     */
    async runStep(job, signal) {
        if (this._running) { throw new Error('An online content reclaim step is already running'); }
        this._running = true;
        try {
            const db = this._admit(job, signal);
            if (this._hasActiveLeases()) { return {job, done: false, retryAt: this._now() + LEASE_RETRY_MS}; }
            const nextBatch = job.checkpoint.afterReclaim === 'recompress';
            const deletion = this._selectDeletion(db, job.jobId, nextBatch ? this._trainingFiles(job) : []);
            if (deletion === null) { return {job, done: nextBatch || !this._pruneMetadata(db, job.jobId)}; }

            this._assertOutsideLiveClosure(db, job.jobId, deletion);
            const {file, retirement} = deletion;
            const bind = {$fileId: file.fileId,
                $path: file.path,
                $ownerJobId: file.ownerJobId,
                $byteLength: file.byteLength,
                $sha256: file.sha256,
                $state: file.state};
            if (file.state !== 'deleting') {
                db.exec({
                    sql: `
                    UPDATE termContentStorageFiles SET state = 'deleting'
                    WHERE fileId = $fileId AND path = $path AND ownerJobId = $ownerJobId
                        AND byteLength = $byteLength AND sha256 IS $sha256 AND state = $state
                    `,
                    bind: bind,
                });
                if (db.selectValue('SELECT changes()') !== 1) { throw new Error('Online content deletion claim changed'); }
            }
            signal.throwIfAborted();
            try {
                await this._removeFile({fileId: file.fileId, path: file.path, byteLength: file.byteLength});
            } catch (error) {
                // An intent may never have been written. A missing file after
                // a restart is also safe once this exact deletion is durable.
                if (!(error instanceof DOMException) || error.name !== 'NotFoundError') { throw error; }
            }
            if (this._admit(job, signal) !== db) { throw new Error('Online content reclamation connection changed'); }
            this._transaction(db, () => {
                if (retirement !== null) { this._finishRetirement(db, job.jobId, file, retirement); }
                db.exec({
                    sql: `
                    DELETE FROM termContentStorageFiles
                    WHERE fileId = $fileId AND path = $path AND ownerJobId = $ownerJobId
                        AND byteLength = $byteLength AND sha256 IS $sha256 AND state = $state
                    `,
                    bind: {...bind, $state: 'deleting'},
                });
                if (db.selectValue('SELECT changes()') !== 1) { throw new Error('Online content deletion receipt changed'); }
            });
            return {job, done: false};
        } finally {
            this._running = false;
        }
    }

    /**
     * @param {Job} job
     * @param {AbortSignal} signal
     * @returns {Database}
     * @throws {Error} If the given job or connection is stale.
     */
    _admit(job, signal) {
        signal.throwIfAborted();
        this._assertReady();
        const db = this._getDb();
        if (!this._confirmAutocommit(db)) { throw new Error('Online content reclamation requires transaction ownership'); }
        const owned = db.selectValue(`
            SELECT 1 FROM termContentOptimizationJobs
            WHERE jobId = $jobId AND dictionaryTitle = $title AND dictionaryGeneration = $generation
                AND strategyVersion = $strategy AND phase = 'reclaim' AND checkpointVersion = $version
                AND checkpointJson = $checkpoint
                AND NOT EXISTS (
                    SELECT 1 FROM termContentOptimizationJobs AS other
                    WHERE other.jobId <> $jobId AND (
                        other.phase IN ('discover', 'sample', 'train', 'recompress', 'reclaim') OR
                        (other.phase = 'deferred' AND (
                            EXISTS (SELECT 1 FROM termContentStorageFiles AS file WHERE file.ownerJobId = other.jobId
                                AND file.state IN ('intent', 'staged', 'retired', 'deleting')) OR
                            EXISTS (SELECT 1 FROM termContentOptimizationCheckpoints AS checkpoint WHERE checkpoint.jobId = other.jobId
                                AND checkpoint.kind = 'retired-file')
                        ))
                    )
                )
        `, {$jobId: job.jobId,
            $title: job.dictionaryTitle,
            $generation: job.dictionaryGeneration,
            $strategy: job.strategyVersion,
            $version: job.checkpointVersion,
            $checkpoint: JSON.stringify(job.checkpoint)});
        if (job.phase !== 'reclaim' || owned !== 1) { throw new Error('Online content reclamation job is stale'); }
        if (!['recompress', 'completed', 'no-gain', 'failed'].includes(job.checkpoint.afterReclaim)) {
            throw new Error('Online content reclaim checkpoint has no valid next phase');
        }
        const root = db.selectValue(`
            SELECT 1 FROM termContentStorageState s JOIN termContentStorageRoots r ON r.rootId = s.activeRootId
            WHERE s.singleton = 1 AND r.state = 'active' AND r.epoch > 0
                AND r.epoch = s.activeEpoch AND r.logicalHighWater = s.logicalHighWater
        `);
        if (root !== 1) { throw new Error('Online content reclamation requires a committed immutable root'); }
        return db;
    }

    /**
     * @param {Job} job
     * @returns {string[]}
     * @throws {Error} If the next batch lacks its trained dictionary.
     */
    _trainingFiles({checkpoint}) {
        if (checkpoint.dictionary === null) { throw new Error('Online content reclaim checkpoint lacks its dictionary'); }
        return [checkpoint.dictionary.fileId, ...checkpoint.samples.map((sample) => sample.fileId)];
    }

    /**
     * @param {Database} db
     * @param {string} jobId
     * @param {string[]} retained
     * @returns {Deletion|null}
     * @throws {Error} If durable ownership cannot be established.
     */
    _selectDeletion(db, jobId, retained) {
        const retired = db.selectObject(`
            SELECT f.*, c.fileId AS retiredFileId, c.sequence, c.byteOffset, c.byteLength AS retiredBytes,
                c.sha256 AS retiredSha256, c.metadataJson
            FROM termContentOptimizationCheckpoints c
            LEFT JOIN termContentStorageFiles f ON f.fileId = c.fileId
            WHERE c.jobId = $jobId AND c.kind = 'retired-file'
            ORDER BY c.sequence LIMIT 1
        `, {$jobId: jobId});
        if (typeof retired !== 'undefined') {
            const file = this._readOwnedFile(retired);
            const {retiredFileId, sequence, byteOffset, retiredBytes, retiredSha256, metadataJson} = retired;
            if (file.fileId !== retiredFileId || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence >= 0 ||
            typeof metadataJson !== 'string' || byteOffset !== 0 || file.byteLength <= 0 ||
            file.byteLength !== retiredBytes || file.sha256 !== retiredSha256 ||
            (file.state !== 'retired' && file.state !== 'deleting')) {
                throw new Error('Online content retirement receipt does not match its file');
            }
            const receipt = parseJson(metadataJson);
            const rootId = /** @type {unknown} */ (typeof receipt === 'object' && receipt !== null ? Reflect.get(receipt, 'sourceRootId') : null);
            if (typeof receipt !== 'object' || receipt === null || Reflect.get(receipt, 'version') !== 1 ||
            Reflect.get(receipt, 'path') !== file.path || Reflect.get(receipt, 'ownerJobId') !== file.ownerJobId ||
            typeof rootId !== 'string' ||
            db.selectValue("SELECT 1 FROM termContentStorageRoots WHERE rootId = $rootId AND state = 'retired'", {$rootId: rootId}) !== 1 ||
            retained.includes(file.fileId)) {
                throw new Error('Online content retirement has an invalid source root or file owner');
            }
            return {file, retirement: {sequence, metadataJson}};
        }
        const unpublished = db.selectObject(`
            SELECT fileId, path, byteLength, sha256, state, ownerJobId
            FROM termContentStorageFiles
            WHERE ownerJobId = ? AND state IN ('intent', 'staged', 'deleting')
                AND fileId NOT IN (SELECT value FROM json_each(?))
            ORDER BY state <> 'deleting', fileId LIMIT 1
        `, [jobId, JSON.stringify(retained)]);
        if (typeof unpublished === 'undefined') {
            const orphan = db.selectValue(`
                SELECT 1 FROM termContentStorageFiles WHERE ownerJobId = $jobId AND state = 'retired' LIMIT 1
            `, {$jobId: jobId});
            if (orphan === 1) { throw new Error('Online content retired file has no deletion receipt'); }
            return null;
        }
        const file = this._readOwnedFile(unpublished);
        if (file.ownerJobId !== jobId || parseContentPhysicalFile(file).kind !== 'optimizer') {
            throw new Error('Online content staged deletion exceeds the job namespace');
        }
        return {file, retirement: null};
    }

    /**
     * @param {Record<string, unknown>} row
     * @returns {OwnedFile}
     * @throws {Error} If the catalog row is not an immutable file identity.
     */
    _readOwnedFile({fileId, path, byteLength, ownerJobId, sha256, state}) {
        if (typeof fileId !== 'string' || typeof path !== 'string' || typeof byteLength !== 'number' ||
        typeof ownerJobId !== 'string' || ownerJobId.length === 0 || typeof state !== 'string' ||
        (sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)))) {
            throw new Error('Online content deletion has invalid file metadata');
        }
        const file = {fileId, path, byteLength, ownerJobId, sha256, state};
        parseContentPhysicalFile(file);
        return file;
    }

    /**
     * @param {Database} db
     * @param {string} jobId
     * @param {Deletion} deletion
     * @throws {Error} If a live or recovery owner can still access the file.
     */
    _assertOutsideLiveClosure(db, jobId, {file, retirement}) {
        this._assertLiveMetadata(db);
        const referenced = db.selectValue(LIVE_LAYOUTS + `
            SELECT 1 FROM liveLayouts l WHERE
                EXISTS (SELECT 1 FROM json_each(l.manifestJson, '$.extents') e
                    WHERE json_extract(e.value, '$.fileId') = $fileId)
                OR EXISTS (SELECT 1 FROM json_each(l.manifestJson, '$.blocks') b
                    LEFT JOIN termContentStorageCodecs c ON c.codecId = json_extract(b.value, '$.codecId')
                    WHERE json_extract(b.value, '$.fileId') = $fileId OR c.fileId = $fileId)
            LIMIT 1
        `, {$fileId: file.fileId});
        const checkpoint = db.selectValue(`
            SELECT 1 FROM termContentOptimizationCheckpoints
            WHERE fileId = $fileId AND NOT (jobId = $jobId AND sequence IS $sequence AND kind = 'retired-file')
            LIMIT 1
        `, {$fileId: file.fileId, $jobId: jobId, $sequence: retirement?.sequence ?? null});
        const unpublishedCodec = retirement === null && db.selectValue(
            'SELECT 1 FROM termContentStorageCodecs WHERE fileId = $fileId LIMIT 1',
            {$fileId: file.fileId},
        ) === 1;
        if (referenced === 1 || checkpoint === 1 || unpublishedCodec) {
            throw new Error('Online content deletion is still referenced by a root, codec, or checkpoint');
        }
    }

    /**
     * @param {Database} db
     * @throws {Error} If the live closure cannot be established.
     */
    _assertLiveMetadata(db) {
        const malformed = db.selectValue(LIVE_LAYOUTS + `
            SELECT 1 FROM liveRoots root
            WHERE json_extract(root.manifestJson, '$.version') IS NOT 1
                OR json_type(root.manifestJson, '$.regions') IS NOT 'array'
                OR root.logicalHighWater IS NOT (
                    SELECT COALESCE(SUM(region.logicalLength), 0)
                    FROM liveRegions region WHERE region.rootId = root.rootId
                )
                OR json_array_length(root.manifestJson, '$.regions') <> (
                    SELECT COUNT(*) FROM termContentStorageRootLayouts r WHERE r.rootId = root.rootId
                )
            UNION ALL SELECT 1 FROM liveLayouts
            WHERE json_extract(manifestJson, '$.version') IS NOT 1
                OR json_extract(manifestJson, '$.regionId') IS NOT regionId
                OR json_extract(manifestJson, '$.logicalStart') IS NOT logicalStart
                OR json_extract(manifestJson, '$.logicalLength') IS NOT logicalLength
                OR typeof(logicalLength) <> 'integer' OR logicalLength <= 0 OR logicalLength > 134217728
                OR typeof(logicalStart) <> 'integer' OR logicalStart IS NOT previousEnd
                OR json_type(manifestJson, '$.extents') IS NOT 'array'
                OR json_type(manifestJson, '$.blocks') IS NOT 'array'
            LIMIT 1
        `);
        if (malformed === 1) { throw new Error('Online content reclamation cannot establish the live layout closure'); }
    }

    /**
     * @param {Database} db
     * @param {string} jobId
     * @param {OwnedFile} file
     * @param {Retirement} retirement
     * @throws {Error} If the exact retirement receipt no longer matches.
     */
    _finishRetirement(db, jobId, file, {sequence, metadataJson}) {
        db.exec({
            sql: `
            DELETE FROM termContentOptimizationCheckpoints
            WHERE jobId = $jobId AND sequence = $sequence AND kind = 'retired-file' AND fileId = $fileId
                AND byteOffset = 0 AND byteLength = $byteLength AND sha256 IS $sha256 AND metadataJson = $metadataJson
            `,
            bind: {$jobId: jobId,
                $sequence: sequence,
                $fileId: file.fileId,
                $byteLength: file.byteLength,
                $sha256: file.sha256,
                $metadataJson: metadataJson},
        });
        if (db.selectValue('SELECT changes()') !== 1) { throw new Error('Online content retirement receipt changed'); }
        // A retired codec registration can be dropped only when no live layout
        // uses that codec. The closure check preceded the exact durable claim.
        db.exec({sql: 'DELETE FROM termContentStorageCodecs WHERE fileId = $fileId', bind: {$fileId: file.fileId}});
    }

    /**
     * @param {Database} db
     * @param {string} jobId
     * @returns {boolean} Whether another terminal cleanup step is needed.
     */
    _pruneMetadata(db, jobId) {
        const retired = db.selectValue(`
            SELECT r.rootId FROM termContentStorageRoots r WHERE r.state = 'retired'
                AND NOT EXISTS (
                    SELECT 1 FROM termContentOptimizationCheckpoints c WHERE c.kind = 'retired-file'
                        AND json_extract(c.metadataJson, '$.sourceRootId') = r.rootId
                )
            ORDER BY r.epoch LIMIT 1
        `);
        if (typeof retired === 'string') {
            this._transaction(db, () => {
                db.exec({sql: 'DELETE FROM termContentStorageRootLayouts WHERE rootId = $rootId', bind: {$rootId: retired}});
                db.exec({sql: "DELETE FROM termContentStorageRoots WHERE rootId = $rootId AND state = 'retired'", bind: {$rootId: retired}});
            });
            return true;
        }
        this._assertLiveMetadata(db);
        db.exec(`
            DELETE FROM termContentStorageLayouts WHERE layoutId IN (
                SELECT l.layoutId FROM termContentStorageLayouts l
                WHERE NOT EXISTS (SELECT 1 FROM termContentStorageRootLayouts r WHERE r.layoutId = l.layoutId)
                ORDER BY l.layoutId LIMIT 64
            )
        `);
        if (db.selectValue('SELECT changes()') !== 0) { return true; }
        db.exec({
            sql: `
            DELETE FROM termContentOptimizationCheckpoints
            WHERE jobId = $jobId AND sequence IN (
                SELECT sequence FROM termContentOptimizationCheckpoints
                WHERE jobId = $jobId AND kind = 'frame' ORDER BY sequence LIMIT 64
            )
            `,
            bind: {$jobId: jobId},
        });
        return db.selectValue('SELECT changes()') !== 0;
    }

    /**
     * @param {Database} db
     * @param {() => void} operation
     * @throws {Error} If mutation fails or rollback cannot be confirmed.
     */
    _transaction(db, operation) {
        try {
            db.exec('BEGIN IMMEDIATE');
            operation();
            db.exec('COMMIT');
        } catch (error) {
            // A late acknowledgement leaves either the exact deletion receipt
            // for retry or no remaining receipt after a committed cleanup.
            if (!this._confirmAutocommit(db)) {
                try {
                    db.exec('ROLLBACK');
                } catch (rollbackError) {
                    const errors = [toError(error), toError(rollbackError)];
                    this._quarantine(errors);
                    throw new AggregateError(errors, 'Online content reclaim rollback could not be confirmed');
                }
            }
            throw error;
        }
    }
}
