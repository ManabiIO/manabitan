import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {defaultEvidenceRoot, fileIdentity, loadVerificationManifest} from './common.mjs';

const {values, positionals} = parseArgs({allowPositionals: true, options: {'evidence-dir': {type: 'string'}}});
assert.equal(positionals.length, 3, 'Usage: node compare-results-with-legacy-context.mjs A_DIRECTORY B_DIRECTORY NEW_REPORT [--evidence-dir DATA]');
const [aDirectory, bDirectory, output] = positionals.map((value) => path.resolve(value));
const {manifest} = await loadVerificationManifest(path.resolve(values['evidence-dir'] ?? defaultEvidenceRoot));
const read = async (directory, file) => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
const [a, b] = await Promise.all([read(aDirectory, 'result.json'), read(bDirectory, 'result.json')]);
assert(a.success && b.success && !a.timingEligible && !b.timingEligible);
assert.equal(a.arm, 'A'); assert.equal(b.arm, 'B');
assert.equal(a.source.runtimeProfileCommit, manifest.sourceProfiles.A.runtimeCommit);
assert.equal(b.source.runtimeProfileCommit, manifest.sourceProfiles.B.runtimeCommit);
const recordIdRepresentation = manifest.logicalRecordIdRepresentation ?? 'physical-float64';
assert.equal(a.recordIdRepresentation ?? 'physical-float64', recordIdRepresentation);
assert.equal(b.recordIdRepresentation ?? 'physical-float64', recordIdRepresentation);
assert.equal(a.corpus, b.corpus);
assert.equal(manifest.legacyImportReadContext?.mode, 'real-sqlite-epoch-zero-schema-v2');
const expectedLegacyState = {epoch: 0, logicalHighWater: 0, rootId: 'legacy-root-v0', manifest: {version: 1, legacy: true, regions: []}};
for (const result of [a, b]) {
    assert.equal(result.legacyImportReadContext.mode, 'real-sqlite-epoch-zero-schema-v2');
    assert.deepEqual(result.legacyImportReadContext.assets, manifest.legacyImportReadContext.assets);
    assert.deepEqual(result.legacyImportReadContext.initialState, expectedLegacyState);
    assert.deepEqual(result.legacyImportReadContext.finalState, expectedLegacyState);
    assert.equal(result.legacyImportReadContext.groupStates.length, result.groupResults.length);
    for (const [index, entry] of result.legacyImportReadContext.groupStates.entries()) {
        assert.equal(entry.group, index);
        assert.deepEqual(entry.state, expectedLegacyState);
    }
}
for (const [directory, result] of [[aDirectory, a], [bDirectory, b]]) {
    const cleanup = await read(directory, 'legacy-read-context-cleanup.json');
    assert.deepEqual(cleanup.drainResults, [{status: 'fulfilled'}, {status: 'fulfilled'}]);
    assert.equal(cleanup.workerResults.length, result.compression.codecWorkers + result.indexWorker.count);
    assert(cleanup.workerResults.every((entry) => entry.status === 'fulfilled'));
    assert.deepEqual(cleanup.resourceResults, [{status: 'fulfilled'}, {status: 'fulfilled'}]);
    assert.equal(cleanup.closedOwnedConnection, true);
    assert.equal(cleanup.closeError, null);
}
for (const key of ['fixture',
    'lockSha256',
    'node',
    'runtimeIdentity',
    'evidenceIdentity',
    'execArgv',
    'helperIdentity',
    'policy',
    'rows',
    'mediaRows',
    'totalBytes',
    'bankCount',
    'archiveCatalog',
    'archiveEntryCount',
    'manifestSha256',
    'compression',
    'indexWorker',
    'legacyImportReadContext',
    'summary',
    'actualIndexBytes',
    'actualContentBytes',
    'actualAllFilesBytes',
    'files',
    'sourceChecks',
    'chunks']) { assert.deepEqual(b[key], a[key], `Parent/candidate ${key}`); }
assert.equal(a.groupResults.length, b.groupResults.length);
const allocation = [];
for (let index = 0; index < a.groupResults.length; ++index) {
    const ag = a.groupResults[index];
    const bg = b.groupResults[index];
    const withoutDiagnostics = ({memory: _memory, metadataAllocation: _metadataAllocation, ...rest}) => rest;
    assert.deepEqual(withoutDiagnostics(bg), withoutDiagnostics(ag), `Complete group ${index} source/sink oracle`);
    for (const key of ['arenaWasAllocated', 'denseCount', 'capacity', 'hashSlots']) { assert.equal(bg.metadataAllocation[key], ag.metadataAllocation[key], `Group ${index} allocation ${key}`); }
    if (recordIdRepresentation === 'implicit-positive-zero-or-full-float64') {
        assert.deepEqual(bg.metadataAllocation.upstreamRecordIds, ag.metadataAllocation.upstreamRecordIds, `Group ${index} preserves upstream ID allocation`);
    }
    allocation.push({group: index,
        parent: ag.metadataAllocation,
        candidate: bg.metadataAllocation,
        signatureArenaBytesAvoided: ag.metadataAllocation.ownedArenaAndSignature1Bytes - bg.metadataAllocation.ownedArenaAndSignature1Bytes,
        dictionaryNameBytesAvoided: ag.metadataAllocation.dictionaryNameIds.backingBytes - bg.metadataAllocation.dictionaryNameIds.backingBytes,
        ownedBytesAvoided: ag.metadataAllocation.ownedArenaAndOptionalColumnsBytes - bg.metadataAllocation.ownedArenaAndOptionalColumnsBytes});
}
if (a.corpus === 'vndb') {
    for (const key of ['sha256',
        'sourceCommit',
        'groupsMatched',
        'mediaRows',
        'projectedPaths',
        'uniqueImagePaths',
        'repeatedProjectedReferences',
        'projectedPathDigest',
        'uniqueImagePathsSha256',
        'allGroupsAndProjectedPathsMatch']) {
        assert.deepEqual(b.mediaOracle[key], a.mediaOracle[key], `Independent media oracle ${key}`);
    }
}
const [aOracle, bOracle] = await Promise.all([read(aDirectory, 'final-output-oracle.json'), read(bDirectory, 'final-output-oracle.json')]);
assert.deepEqual(bOracle, aOracle, 'Every normalized persisted file and every independently decoded logical metadata column');
const [aOracleIdentity, bOracleIdentity] = await Promise.all([
    fileIdentity(path.join(aDirectory, 'final-output-oracle.json')),
    fileIdentity(path.join(bDirectory, 'final-output-oracle.json')),
]);
assert.deepEqual(aOracleIdentity, a.finalOracle);
assert.deepEqual(bOracleIdentity, b.finalOracle);
assert.deepEqual(bOracleIdentity, aOracleIdentity);
assert.equal(b.nullPhysicalSignature1EveryGroup, true, 'All three corpora must retain the qualified implicit S1 path');
if (a.corpus === 'jmdict') {
    assert.equal(b.nullPhysicalDictionaryNameIdsEveryGroup, true);
    assert.equal(b.metadataAllocation.dictionaryNameIds.backingBytes, 0);
    assert.deepEqual(b.metadataAllocation.dictionaryNameIds.representation, {
        _termEntryContentMetaDictNameIdPrefixValue: 1,
        _termEntryContentMetaDictNameIdPrefixEnd: 362032,
    });
    assert.equal(a.metadataAllocation.ownedArenaAndOptionalColumnsBytes - b.metadataAllocation.ownedArenaAndOptionalColumnsBytes, 4194304);
}
const result = {
    schemaVersion: 1,
    success: true,
    timingEligible: false,
    corpus: a.corpus,
    recordIdRepresentation,
    parent: {directory: aDirectory, commit: a.source.commit},
    candidate: {directory: bDirectory, commit: b.source.commit},
    rows: a.rows,
    groups: a.groupResults.length,
    fixture: a.fixture,
    node: a.node,
    exactParserOutputsAndLookupPayloads: true,
    exactRecordFieldsAndEnvelopes: true,
    exactNormalizedFinalFileBytes: true,
    exactIndependentLogicalMetadata: true,
    finalOutputOracle: aOracleIdentity,
    persistedFiles: aOracle.persisted.files,
    generationLinkageVerified: aOracle.persisted.generationLinkageVerified,
    logicalMetadataColumns: Object.keys(aOracle.metadata),
    compression: a.compression,
    indexWorker: a.indexWorker,
    legacyImportReadContext: a.legacyImportReadContext,
    parentAllocation: a.metadataAllocation,
    candidateAllocation: b.metadataAllocation,
    finalSignatureArenaBytesAvoided: a.metadataAllocation.ownedArenaAndSignature1Bytes - b.metadataAllocation.ownedArenaAndSignature1Bytes,
    finalDictionaryNameBytesAvoided: a.metadataAllocation.dictionaryNameIds.backingBytes - b.metadataAllocation.dictionaryNameIds.backingBytes,
    finalOwnedBytesAvoided: a.metadataAllocation.ownedArenaAndOptionalColumnsBytes - b.metadataAllocation.ownedArenaAndOptionalColumnsBytes,
    candidateNullPhysicalSignature1EveryGroup: b.nullPhysicalSignature1EveryGroup,
    candidateNullPhysicalDictionaryNameIdsEveryGroup: b.nullPhysicalDictionaryNameIdsEveryGroup,
    perGroupAllocation: allocation,
    limitations: ['Sequential production-group term-sink replay, not concurrent browser import timing.',
        'Final owned-array/native-memory accounting is not browser peak or settled memory.',
        'Media projection/reference coverage is checked; separate media persistence, UI, SQLite, restart and lookup remain outside this boundary.'],
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'});
console.log(JSON.stringify({success: true,
    corpus: result.corpus,
    rows: result.rows,
    groups: result.groups,
    finalOutputOracle: result.finalOutputOracle.sha256,
    finalOwnedBytesAvoided: result.finalOwnedBytesAvoided,
    candidateNullPhysicalSignature1EveryGroup: result.candidateNullPhysicalSignature1EveryGroup,
    candidateNullPhysicalDictionaryNameIdsEveryGroup: result.candidateNullPhysicalDictionaryNameIdsEveryGroup}));
