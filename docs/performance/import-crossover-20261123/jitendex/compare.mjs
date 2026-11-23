import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const root = new URL('./', import.meta.url)
const baseline = JSON.parse(await fs.readFile(new URL('baseline.json', root)))
const candidate = JSON.parse(await fs.readFile(new URL('candidate.json', root)))
const compared = [
    'runnerSha256', 'bridgeSha256', 'archiveSha256', 'manifestSha256', 'manifestInputDigest',
    'sourceRows', 'sourceJsonBytes', 'verifiedContents', 'verifiedBytes', 'verifiedFrames',
    'verifiedReferences', 'decodedContentSha256', 'persistedBytes', 'persistedSha256',
    'compressionDictName', 'compressionLevel', 'blockTargetBytes', 'workers', 'dispatch', 'groups',
]
for (const key of compared) assert.deepEqual(candidate[key], baseline[key], `Changed ${key}`)
assert.equal(baseline.lazyBatchCalls, 0)
assert.equal(candidate.lazyBatchCalls, 22)
const report = {
    result: 'passed', baselineCommit: baseline.sourceCommit, candidateCommit: candidate.sourceCommit,
    scope: baseline.scope, corpusArchiveSha256: baseline.archiveSha256,
    groups: baseline.groups.length, sourceRows: baseline.sourceRows,
    selectedContents: baseline.verifiedContents, selectedSourceBytes: baseline.verifiedBytes,
    blockPlansEqual: true, compressedEnvelopesSha256Equal: baseline.verifiedFrames,
    eachDecodedFrameComparedExactlyWithSource: true,
    decodedSourceSha256: baseline.decodedContentSha256,
    exactReferenceRecordsVerifiedPerRun: baseline.verifiedReferences,
    persistedBytes: baseline.persistedBytes, persistedSha256: baseline.persistedSha256,
    candidateWarmPackingDispatchGroups: candidate.lazyBatchCalls,
    retainedInputGroups: candidate.retainedInputGroups,
    largestSourceGroupBytes: candidate.largestSourceGroupBytes,
    workerTransferredBuffers: candidate.dispatch.blocks,
    workerTransferredLogicalBytes: candidate.dispatch.logicalBytes,
    workerTransferredBackingBytes: candidate.dispatch.backingBytes,
    timingCollected: false,
}
await fs.writeFile(new URL('summary.json', root), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
