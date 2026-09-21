// Qualification-only observer appended identically to both block-store variants.
// Deliberately not production telemetry or timing qualification.
const qualificationBlockCounters = new WeakMap();
function qualificationBlockStats(store) {
    let stats = qualificationBlockCounters.get(store);
    if (!stats) {
        stats = {batchCalls: 0, batchRequests: 0, batchFailures: 0, returnedBytes: 0, maxBatchBackingBytes: 0, blockLoads: 0, declaredLoadBytes: 0, activeLoads: 0, activeBytes: 0, peakLoads: 0, peakBytes: 0};
        qualificationBlockCounters.set(store, stats);
    }
    return stats;
}
const qualificationOriginalBatch = TermContentBlockStore.prototype.readDetailedBatch;
TermContentBlockStore.prototype.readDetailedBatch = async function(requests) {
    const stats = qualificationBlockStats(this);
    ++stats.batchCalls;
    stats.batchRequests += requests.length;
    const results = await qualificationOriginalBatch.call(this, requests);
    const buffers = new Set();
    for (const result of results) {
        if (result.status !== 'ok') { ++stats.batchFailures; continue; }
        stats.returnedBytes += result.bytes.byteLength;
        buffers.add(result.bytes.buffer);
    }
    const retained = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    stats.maxBatchBackingBytes = Math.max(stats.maxBatchBackingBytes, retained);
    return results;
};
const qualificationOriginalLoad = TermContentBlockStore.prototype._loadBlock;
TermContentBlockStore.prototype._loadBlock = async function(key, reference, dictionary, context) {
    const stats = qualificationBlockStats(this);
    ++stats.blockLoads;
    ++stats.activeLoads;
    stats.declaredLoadBytes += reference.blockUncompressedLength;
    stats.activeBytes += reference.blockUncompressedLength;
    stats.peakLoads = Math.max(stats.peakLoads, stats.activeLoads);
    stats.peakBytes = Math.max(stats.peakBytes, stats.activeBytes);
    try {
        return await qualificationOriginalLoad.call(this, key, reference, dictionary, context);
    } finally {
        --stats.activeLoads;
        stats.activeBytes -= reference.blockUncompressedLength;
    }
};
const qualificationOriginalDiagnostics = TermContentBlockStore.prototype.getDiagnostics;
TermContentBlockStore.prototype.getDiagnostics = function() {
    return {...qualificationOriginalDiagnostics.call(this), qualification: {...qualificationBlockStats(this)}};
};
