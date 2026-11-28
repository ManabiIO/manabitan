/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Temporary diagnostic only. All observations are non-authoritative timing.
 * This module owns only its event records and weak identity maps. It performs
 * no async work, I/O, task scheduling, or product buffer ownership changes.
 */

const MAX_EVENTS = 10000;
const pipelineRuns = new WeakMap();
const chunkGroups = new WeakMap();
const runs = [];
const groups = [];
const events = [];
const unboundEvents = {};
let recorderErrors = 0;
let droppedEvents = 0;

function identities(chunk) {
    if (typeof chunk !== 'object' || chunk === null) { return []; }
    const keys = [chunk];
    if (typeof chunk.contentDedupPlan === 'object' && chunk.contentDedupPlan !== null) {
        keys.push(chunk.contentDedupPlan);
    }
    if (chunk.contentMetaList?.byteLength > 0) { keys.push(chunk.contentMetaList); }
    // Resolved record slices preserve these columns, but do not preserve the
    // parser plan. Never bind shared empty deferred-resolution sentinels.
    const offsets = chunk.resolvedContentReferences?.offsets;
    if (offsets?.byteLength > 0) { keys.push(offsets); }
    return keys;
}

function groupFor(chunk) {
    const keys = identities(chunk);
    let group;
    for (const key of keys) {
        group = chunkGroups.get(key);
        if (typeof group !== 'undefined') { break; }
    }
    if (typeof group !== 'undefined') {
        for (const key of keys) { chunkGroups.set(key, group); }
    }
    return group;
}

function record(group, event, details) {
    if (events.length >= MAX_EVENTS) {
        ++droppedEvents;
        return;
    }
    events.push({
        sequence: events.length,
        run: group.run,
        group: group.group,
        event,
        atMs: performance.now(),
        details,
    });
}

export function beginCanonicalTimeline(owner, groupCount, workerCount) {
    try {
        if (pipelineRuns.has(owner)) { ++recorderErrors; return; }
        const run = {run: runs.length, groupCount, workerCount, startedAtMs: performance.now()};
        runs.push(run);
        pipelineRuns.set(owner, run);
    } catch { ++recorderErrors; }
}

export function bindCanonicalTimelineGroup(owner, chunk, groupIndex, details) {
    try {
        const run = pipelineRuns.get(owner);
        if (typeof run === 'undefined') { ++recorderErrors; return; }
        const group = {run: run.run, group: groupIndex, ...details};
        groups.push(group);
        for (const key of identities(chunk)) { chunkGroups.set(key, group); }
        record(group, 'group-ready', {});
    } catch { ++recorderErrors; }
}

export function markCanonicalTimeline(chunk, event, details = {}) {
    try {
        const group = groupFor(chunk);
        if (typeof group === 'undefined') {
            unboundEvents[event] = (unboundEvents[event] ?? 0) + 1;
            return;
        }
        record(group, event, details);
    } catch { ++recorderErrors; }
}

export function appendCanonicalTimelinePhase(result) {
    try {
        if (!Array.isArray(result.debug?.phaseTimings)) { ++recorderErrors; return; }
        const epochMs = Date.now();
        result.debug.phaseTimings.push({
            phase: 'canonical-lookahead-diagnostic-b9cacc',
            elapsedMs: 0,
            startEpochMs: epochMs,
            endEpochMs: epochMs,
            details: {
                schemaVersion: 1,
                authoritativeTiming: false,
                clock: 'performance.now() in the import/storage worker realm',
                timeOriginMs: performance.timeOrigin,
                scope: 'Standalone marks only; no added await, promise handler, scheduling, or product ownership change. Apparent wait windows are not proven idle CPU.',
                recorderErrors,
                droppedEvents,
                unboundEvents: {...unboundEvents},
                runs: runs.slice(),
                groups: groups.slice(),
                events: events.slice(),
            },
        });
    } catch { ++recorderErrors; }
}
