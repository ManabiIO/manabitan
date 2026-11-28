// Protocol-only checks. No dictionary import, worker, or filesystem mutation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./timeline-runtime.js', import.meta.url), 'utf8');
const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const owner = {};
runtime.beginCanonicalTimeline(owner, 2, 1);
const empty = new Float64Array(0);
const original = [0, 1].map(() => ({
    contentDedupPlan: {resolvedOffsets: empty},
    contentMetaList: new Uint32Array(0),
}));
for (let group = 0; group < 2; ++group) {
    runtime.bindCanonicalTimelineGroup(owner, original[group], group, {rowCount: 10});
    // The importer creates a wrapper with the same plan object.
    const importerChunk = {...original[group], dictionary: 'JMdict'};
    runtime.markCanonicalTimeline(importerChunk, 'sink-enter');
    // Resolution replaces the shared empty sentinels, and the record factory
    // spreads the original chunk while attaching the newly resolved columns.
    const offsets = new Float64Array([1, 2]);
    importerChunk.contentDedupPlan.resolvedOffsets = offsets;
    const recordChunk = {...importerChunk, resolvedContentReferences: {offsets}};
    runtime.markCanonicalTimeline(recordChunk, 'record-start');
    // _encodeAndAppendArtifactChunkForState slices rows but preserves the
    // resolved offsets column. The sliced object omits contentDedupPlan.
    const slicedRecord = {rowCount: 5, resolvedContentReferences: {offsets}};
    runtime.markCanonicalTimeline(slicedRecord, 'record-encode-start', {rows: 5});
    runtime.markCanonicalTimeline(slicedRecord, 'record-encode-end', {rows: 5});
}
const result = {debug: {phaseTimings: []}};
runtime.appendCanonicalTimelinePhase(result);
assert.equal(result.debug.phaseTimings.length, 1);
const data = result.debug.phaseTimings[0].details;
assert.equal(data.recorderErrors, 0);
assert.equal(data.droppedEvents, 0);
assert.deepEqual(data.unboundEvents, {});
assert.deepEqual(data.events.map(({group}) => group), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
assert.deepEqual(data.events.map(({sequence}) => sequence), Array.from({length: 10}, (_, i) => i));
assert.doesNotThrow(() => JSON.stringify(result));
// Shared empty sentinels must never make an unrelated object look like a
// previously bound group; diagnostics must report that loss explicitly.
runtime.markCanonicalTimeline({resolvedContentReferences: {offsets: empty}}, 'unknown-empty-source');
const second = {debug: {phaseTimings: []}};
runtime.appendCanonicalTimelinePhase(second);
assert.deepEqual(second.debug.phaseTimings[0].details.unboundEvents, {'unknown-empty-source': 1});
assert.equal(second.debug.phaseTimings[0].details.events.length, 10);
console.log('Runtime identity checks passed: importer wrappers, record wrappers, record slices, and shared empty sentinels.');
