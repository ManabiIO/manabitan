/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {safePerformance} from '../core/safe-performance.js';

// Diagnostic overlay only. No rows, chunks, promises, sources or storage owners
// are retained. All timestamps belong to the import coordinator's one clock.
const MAX_EVENTS = 4096;
const MAX_GROUPS = 64;
const MAX_OPERATIONS = 1024;
const TOKEN_STRIDE = 65536;
const FLAGS = Object.freeze({overflow: 1, context: 2, duplicate: 4, route: 8, failure: 16, clock: 32, incomplete: 64, allocation: 128});

export const GROUP_STAGE = Object.freeze({
    pipelineStart: 1,
    groupReady: 2,
    sinkEnter: 3,
    sinkRelease: 4,
    dbBegin: 5,
    dedupBegin: 6,
    dedupEnd: 7,
    contentDispatch: 8,
    contentBegin: 9,
    compressionStart: 10,
    storageReady: 11,
    metadataPublished: 12,
    recordBegin: 13,
    recordDone: 14,
    joinBegin: 15,
    compressionDone: 16,
    contentDone: 17,
    contentObserved: 18,
    joinSettled: 19,
    dbDone: 20,
    pipelineEnd: 21,
    operationFailed: 22,
    unsupportedRoute: 23,
});

class ImportGroupStageDiagnostic {
    constructor() {
        /** @type {ReturnType<ImportGroupStageDiagnostic['_createState']>|null} */
        this._state = null;
        this._generation = 0;
        this._allocationFailed = false;
    }

    beginImport() {
        if (this._state !== null && !this._state.exported) {
            this._state.flags |= FLAGS.context;
            return;
        }
        try {
            this._state = this._createState();
            this._allocationFailed = false;
        } catch (_) {
            this._state = null;
            this._allocationFailed = true;
        }
    }

    _createState() {
        const base = ++this._generation * TOKEN_STRIDE;
        return {
            base, startedAt: safePerformance.now(), flags: Number.isSafeInteger(base) ? 0 : FLAGS.context,
            exported: false, pipelineCount: 0, pipelineEnded: false, groupCount: 0, workerCount: 0,
            activeGroup: -1, contentParent: 0, recordParent: 0, eventCount: 0, operationCount: 0,
            event: new Uint8Array(MAX_EVENTS), group: new Int16Array(MAX_EVENTS),
            operation: new Uint16Array(MAX_EVENTS), at: new Float64Array(MAX_EVENTS), value: new Float64Array(MAX_EVENTS),
            groupMask: new Uint32Array(MAX_GROUPS), operationMask: new Uint32Array(MAX_OPERATIONS),
            operationKind: new Uint8Array(MAX_OPERATIONS), operationGroup: new Int16Array(MAX_OPERATIONS),
            operationParent: new Uint16Array(MAX_OPERATIONS),
        };
    }

    /** @param {number} groupCount @returns {number} */
    beginPipeline(groupCount) {
        const s = this._state;
        if (s === null) { return 0; }
        if (++s.pipelineCount !== 1 || s.exported) { s.flags |= FLAGS.context; }
        s.groupCount = groupCount;
        if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > MAX_GROUPS) { s.flags |= FLAGS.overflow; }
        return s.base;
    }

    /** @param {number} pipeline @param {number} workers */
    startPipeline(pipeline, workers) {
        const s = this._state;
        if (!this._isPipeline(pipeline) || s === null) { return; }
        s.workerCount = workers;
        if (workers !== 3) { s.flags |= FLAGS.route; }
        this._record(GROUP_STAGE.pipelineStart, -1, 0, workers);
    }

    /** @param {number} pipeline @param {number} group @param {number} event @param {number} [value] */
    group(pipeline, group, event, value = 0) {
        const s = this._state;
        if (!this._isPipeline(pipeline) || s === null) { return; }
        if (!Number.isInteger(group) || group < 0 || group >= s.groupCount || group >= MAX_GROUPS) {
            s.flags |= FLAGS.context;
            return;
        }
        const bit = 1 << event;
        if (s.groupMask[group] & bit) { s.flags |= FLAGS.duplicate; }
        s.groupMask[group] |= bit;
        if (event === GROUP_STAGE.sinkEnter) {
            if (s.activeGroup !== -1) { s.flags |= FLAGS.context; }
            s.activeGroup = group;
        } else if (event === GROUP_STAGE.sinkRelease) {
            if (s.activeGroup !== group || s.contentParent !== 0 || s.recordParent !== 0) { s.flags |= FLAGS.context; }
            s.activeGroup = -1;
        }
        this._record(event, group, 0, value);
    }

    /** @param {number} pipeline @param {boolean} ok */
    endPipeline(pipeline, ok) {
        const s = this._state;
        if (!this._isPipeline(pipeline) || s === null) { return; }
        if (s.pipelineEnded) { s.flags |= FLAGS.duplicate; }
        s.pipelineEnded = true;
        if (!ok) { s.flags |= FLAGS.failure; }
        this._record(GROUP_STAGE.pipelineEnd, -1, 0, ok ? 1 : 0);
    }

    /** @param {number} rows @returns {number} */
    beginDb(rows) { return this._beginOperation(1, 0, GROUP_STAGE.dbBegin, rows); }

    /**
     * A synchronous dispatch scope only: its children capture their own token
     * before the existing async function reaches its first await. No scope is
     * inferred from whichever group happens to be active in a later callback.
     * @param {number} db
     */
    startContentDispatch(db) {
        const s = this._state;
        if (s === null) { return; }
        if (s.contentParent !== 0) { s.flags |= FLAGS.context; }
        s.contentParent = 0;
        if (this._operationIndex(db, 1) < 0) { return; }
        s.contentParent = db;
    }

    /** @param {number} db @param {boolean} accepted */
    endContentDispatch(db, accepted) {
        const s = this._state;
        if (s === null || this._operationIndex(db, 1) < 0) { return; }
        if (s.contentParent !== db) { s.flags |= FLAGS.context; }
        s.contentParent = 0;
        this.mark(db, GROUP_STAGE.contentDispatch, accepted ? 1 : 0);
        if (!accepted) { this.mark(db, GROUP_STAGE.unsupportedRoute); }
    }

    /** @param {number} spans @returns {number} */
    beginContent(spans) {
        return this._beginOperation(2, this._state?.contentParent ?? 0, GROUP_STAGE.contentBegin, spans);
    }

    /** @param {number} db */
    expectRecord(db) {
        const s = this._state;
        if (s === null) { return; }
        if (s.recordParent !== 0) { s.flags |= FLAGS.context; }
        s.recordParent = 0;
        if (this._operationIndex(db, 1) < 0) { return; }
        s.recordParent = db;
    }

    /** @param {number} rows @returns {number} */
    beginRecord(rows) {
        const s = this._state;
        if (s === null) { return 0; }
        const parent = s.recordParent;
        s.recordParent = 0;
        return this._beginOperation(3, parent, GROUP_STAGE.recordBegin, rows);
    }

    /** @param {number} token @param {number} event @param {number} [value] @param {number} [at] */
    mark(token, event, value = 0, at = safePerformance.now()) {
        const s = this._state;
        const index = this._operationIndex(token);
        if (s === null || index < 0) { return; }
        const bit = 1 << event;
        if (s.operationMask[index] & bit) { s.flags |= FLAGS.duplicate; }
        s.operationMask[index] |= bit;
        if (event === GROUP_STAGE.operationFailed) { s.flags |= FLAGS.failure; }
        if (event === GROUP_STAGE.unsupportedRoute) { s.flags |= FLAGS.route; }
        this._record(event, s.operationGroup[index], index + 1, value, at);
    }

    /** @param {number} token @param {number} [kind] @returns {number} */
    _operationIndex(token, kind = 0) {
        const s = this._state;
        if (s === null) { return -1; }
        const index = token - s.base - 1;
        if (!Number.isInteger(index) || index < 0 || index >= s.operationCount || s.exported || (kind !== 0 && s.operationKind[index] !== kind)) {
            s.flags |= FLAGS.context;
            return -1;
        }
        return index;
    }

    /** @param {number} pipeline @returns {boolean} */
    _isPipeline(pipeline) {
        const s = this._state;
        if (s === null) { return false; }
        if (pipeline !== s.base || s.exported) { s.flags |= FLAGS.context; return false; }
        return true;
    }

    /** @param {number} kind @param {number} parent @param {number} event @param {number} value @returns {number} */
    _beginOperation(kind, parent, event, value) {
        const s = this._state;
        if (s === null) { return 0; }
        let group = s.activeGroup;
        let parentIndex = -1;
        if (kind !== 1) {
            parentIndex = this._operationIndex(parent, 1);
            if (parentIndex < 0) { return 0; }
            group = s.operationGroup[parentIndex];
        }
        if (s.exported || group < 0 || group >= s.groupCount || group >= MAX_GROUPS || group !== s.activeGroup) {
            s.flags |= FLAGS.context;
            return 0;
        }
        if (s.operationCount >= MAX_OPERATIONS) { s.flags |= FLAGS.overflow; return 0; }
        const index = s.operationCount++;
        s.operationKind[index] = kind;
        s.operationGroup[index] = group;
        s.operationParent[index] = parentIndex + 1;
        const token = s.base + index + 1;
        this.mark(token, event, value);
        return token;
    }

    /** @param {number} event @param {number} group @param {number} operation @param {number} value @param {number} [at] */
    _record(event, group, operation, value, at = safePerformance.now()) {
        const s = this._state;
        if (s === null) { return; }
        if (s.eventCount >= MAX_EVENTS) { s.flags |= FLAGS.overflow; return; }
        const index = s.eventCount++;
        const relative = at - s.startedAt;
        if (!Number.isFinite(relative) || relative < 0 || (index > 0 && relative < s.at[index - 1])) { s.flags |= FLAGS.clock; }
        s.event[index] = event;
        s.group[index] = group;
        s.operation[index] = operation;
        s.at[index] = relative;
        s.value[index] = value;
    }

    /**
     * Called only after the existing bulk-finalization boundary. The entire
     * allocation/serialization/phase insertion is best effort and cannot turn a
     * committed import into failure. Missing output is inconclusive to the reader.
     * @param {import('dictionary-importer').ImportPhaseTiming[]} phases
     * @param {boolean} importSucceeded
     */
    appendPhase(phases, importSucceeded) {
        try {
            const s = this._state;
            if (s === null) {
                phases.push({phase: 'diagnostic-coordinator-groups-v1', elapsedMs: 0, details: {payload: JSON.stringify({schemaVersion: 1, complete: false, flags: this._allocationFailed ? FLAGS.allocation : FLAGS.incomplete})}});
                return;
            }
            const requiredGroup = (1 << GROUP_STAGE.groupReady) | (1 << GROUP_STAGE.sinkEnter) | (1 << GROUP_STAGE.sinkRelease);
            const requiredDb = [GROUP_STAGE.dbBegin, GROUP_STAGE.dedupBegin, GROUP_STAGE.dedupEnd, GROUP_STAGE.contentDispatch, GROUP_STAGE.storageReady, GROUP_STAGE.metadataPublished, GROUP_STAGE.joinBegin, GROUP_STAGE.contentObserved, GROUP_STAGE.joinSettled, GROUP_STAGE.dbDone].reduce((mask, event) => mask | (1 << event), 0);
            const requiredContent = [GROUP_STAGE.contentBegin, GROUP_STAGE.compressionStart, GROUP_STAGE.compressionDone, GROUP_STAGE.contentDone].reduce((mask, event) => mask | (1 << event), 0);
            const requiredRecord = (1 << GROUP_STAGE.recordBegin) | (1 << GROUP_STAGE.recordDone);
            if (!importSucceeded || !s.pipelineEnded || s.pipelineCount !== 1 || s.activeGroup !== -1 || s.contentParent !== 0 || s.recordParent !== 0) { s.flags |= FLAGS.incomplete; }
            const dbCounts = new Uint16Array(MAX_GROUPS);
            const contentCounts = new Uint16Array(MAX_OPERATIONS);
            const recordCounts = new Uint16Array(MAX_OPERATIONS);
            for (let i = 0; i < s.operationCount; ++i) {
                if (s.operationKind[i] === 1) {
                    ++dbCounts[s.operationGroup[i]];
                } else if (s.operationKind[i] === 2) {
                    ++contentCounts[s.operationParent[i] - 1];
                } else {
                    ++recordCounts[s.operationParent[i] - 1];
                }
            }
            for (let i = 0; i < Math.min(s.groupCount, MAX_GROUPS); ++i) {
                if ((s.groupMask[i] & requiredGroup) !== requiredGroup || dbCounts[i] === 0) { s.flags |= FLAGS.incomplete; }
            }
            for (let i = 0; i < s.operationCount; ++i) {
                const required = s.operationKind[i] === 1 ? requiredDb : s.operationKind[i] === 2 ? requiredContent : requiredRecord;
                if ((s.operationMask[i] & required) !== required) { s.flags |= FLAGS.incomplete; }
                if (s.operationKind[i] === 1 && (contentCounts[i] === 0 || recordCounts[i] === 0)) { s.flags |= FLAGS.incomplete; }
            }
            s.exported = true;
            const payload = {
                schemaVersion: 1, purpose: 'diagnostic-only; no relative-speed claim',
                clock: 'coordinator safePerformance.now; observations, not worker CPU completion',
                complete: s.flags === 0, flags: s.flags, flagNames: FLAGS,
                limits: {events: MAX_EVENTS, groups: MAX_GROUPS, operations: MAX_OPERATIONS},
                generation: this._generation, pipelineCount: s.pipelineCount, groupCount: s.groupCount, workerCount: s.workerCount,
                eventNames: GROUP_STAGE, eventCount: s.eventCount, operationCount: s.operationCount,
                operationKinds: {db: 1, content: 2, record: 3},
                operationCounts: {dbByGroup: Array.from(dbCounts.subarray(0, Math.min(s.groupCount, MAX_GROUPS))), contentByOperation: Array.from(contentCounts.subarray(0, s.operationCount)), recordByOperation: Array.from(recordCounts.subarray(0, s.operationCount))},
                operations: {kind: Array.from(s.operationKind.subarray(0, s.operationCount)), group: Array.from(s.operationGroup.subarray(0, s.operationCount)), parent: Array.from(s.operationParent.subarray(0, s.operationCount))},
                events: {code: Array.from(s.event.subarray(0, s.eventCount)), group: Array.from(s.group.subarray(0, s.eventCount)), operation: Array.from(s.operation.subarray(0, s.eventCount)), atMs: Array.from(s.at.subarray(0, s.eventCount)), value: Array.from(s.value.subarray(0, s.eventCount))},
            };
            phases.push({phase: 'diagnostic-coordinator-groups-v1', elapsedMs: 0, details: {payload: JSON.stringify(payload)}});
        } catch (_) {
            // No secondary observer work or logging on failure. Absence of a
            // complete payload must never be interpreted as a zero-length gap.
        }
    }
}

export const groupStageDiagnostic = new ImportGroupStageDiagnostic();
