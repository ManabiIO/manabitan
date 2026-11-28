import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {defaultEvidenceRoot, fileIdentity, loadVerificationManifest} from './common.mjs';

const {values, positionals} = parseArgs({allowPositionals: true, options: {'evidence-dir': {type: 'string'}}});
assert.equal(positionals.length, 3, 'Usage: node compare-results.mjs OFF_DIRECTORY ON_DIRECTORY NEW_REPORT [--evidence-dir DATA]');
const [aDirectory, bDirectory, output] = positionals.map((value) => path.resolve(value));
const {manifest} = await loadVerificationManifest(path.resolve(values['evidence-dir'] ?? defaultEvidenceRoot));
const read = async (root, name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const [a, b] = await Promise.all([read(aDirectory, 'result.json'), read(bDirectory, 'result.json')]);
assert(a.success && b.success && !a.timingEligible && !b.timingEligible);
assert.equal(a.arm, 'A'); assert.equal(b.arm, 'B');
assert.match(a.source.commit, /^[0-9a-f]{40}$/);
assert.equal(a.source.runtimeProfileCommit, manifest.sourceProfiles.B.runtimeCommit);
assert.deepEqual(a.source.trees, manifest.sourceProfiles.B.trees);
assert.deepEqual(a.source.canonicalIdentity, manifest.sourceProfiles.B.canonicalIdentity);
assert.equal(a.summary.format4Chunks, 0);
assert.equal(a.summary.actualSavedFieldBytes, 0);
for (const key of ['source',
    'corpus',
    'fixture',
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
    'actualContentBytes',
    'signatureAllocation']) {
    assert.deepEqual(b[key], a[key], `Disabled/enabled ${key}`);
}
assert.equal(a.groupResults.length, b.groupResults.length);
for (let index = 0; index < a.groupResults.length; ++index) {
    const omitDiagnostics = ({memory: _memory, summary: _summary, ...rest}) => rest;
    assert.deepEqual(omitDiagnostics(b.groupResults[index]), omitDiagnostics(a.groupResults[index]), `Complete source/parser/group ${index}`);
}
assert.equal(a.sourceChecks.length, b.sourceChecks.length);
for (let index = 0; index < a.sourceChecks.length; ++index) {
    const omitFormat = ({format: _format, ...rest}) => rest;
    assert.deepEqual(omitFormat(b.sourceChecks[index]), omitFormat(a.sourceChecks[index]), `Every source row/table ${index}`);
}
assert.equal(a.chunks.length, b.chunks.length);
for (let index = 0; index < a.chunks.length; ++index) {
    const off = a.chunks[index];
    const on = b.chunks[index];
    for (const key of ['group',
        'firstId',
        'count',
        'contentOffsetBase',
        'lookupPayloadBytes',
        'lookupPayloadSha256',
        'expandedFormat',
        'expandedBytes',
        'expandedSha256',
        'expandedEnvelopeSha256',
        'allRowsMatchSource',
        'sourceTable']) {
        assert.deepEqual(on[key], off[key], `Expanded field/envelope ${index}/${key}`);
    }
    if (on.format !== 4) { assert.deepEqual(on, off, `Fallback bytes ${index}`); } else {
        assert.equal(off.format, 2);
        assert(on.bytes < off.bytes);
        assert.equal(on.actualSavedFieldBytes, off.bytes - on.bytes);
    }
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
const [aExpanded, bExpanded, aActual, bActual] = await Promise.all([
    read(aDirectory, 'final-output-oracle.json'),
    read(bDirectory, 'final-output-oracle.json'),
    read(aDirectory, 'actual-output-oracle.json'),
    read(bDirectory, 'actual-output-oracle.json'),
]);
assert.deepEqual(aActual, aExpanded, 'Default-off actual files may not change');
assert.deepEqual(bExpanded, aExpanded, 'Every expanded actual file byte and every logical metadata column');
assert.deepEqual(bActual.metadata, aActual.metadata);
for (const file of aActual.persisted.files.filter((file) => !file.path.endsWith('.mbtr.mbti'))) {
    assert.deepEqual(bActual.persisted.files.find((item) => item.path === file.path), file);
}
assert.deepEqual(aActual.persisted.files.map((file) => file.path), bActual.persisted.files.map((file) => file.path));
assert.deepEqual(await fileIdentity(path.join(aDirectory, 'final-output-oracle.json')), a.finalOracle);
assert.deepEqual(await fileIdentity(path.join(bDirectory, 'final-output-oracle.json')), b.finalOracle);
assert.deepEqual(b.finalOracle, a.finalOracle);
const saved = a.actualIndexBytes - b.actualIndexBytes;
assert.equal(saved, a.actualAllFilesBytes - b.actualAllFilesBytes);
assert.equal(saved, b.summary.actualSavedFieldBytes);
assert.equal(a.summary.writtenFieldsBytes - b.summary.writtenFieldsBytes, saved);
const fallbackCounts = {};
for (const chunk of b.chunks.filter((chunk) => chunk.format !== 4)) {
    const table = chunk.sourceTable;
    const reasons = !table.hasReferenceTable ?
['no-reference-table'] :
[
    chunk.format !== 2 && 'existing-noncompact-format',
    !table.countRepresentable && 'reference-count',
    table.proposedBytes !== null && table.proposedBytes >= table.existingCompactBytes && 'no-strict-size-saving',
    table.offsetsBeforeBase > 0 && 'unused-offset-before-split-base',
    table.unsafeOffsets > 0 && 'unsafe-offset',
    table.wideLengths > 0 && 'wide-length',
    table.numericalAndSizeEligible && 'factory-or-column-admission',
].filter(Boolean);
    for (const reason of reasons) { fallbackCounts[reason] = (fallbackCounts[reason] ?? 0) + 1; }
}
const result = {schemaVersion: 1,
    success: true,
    timingEligible: false,
    corpus: a.corpus,
    candidateCommit: a.source.commit,
    runtimeCommit: a.source.runtimeProfileCommit,
    disabled: {directory: aDirectory,
        fieldsBytes: a.summary.writtenFieldsBytes,
        indexBytes: a.actualIndexBytes,
        contentBytes: a.actualContentBytes,
        allTermFileBytes: a.actualAllFilesBytes},
    enabled: {directory: bDirectory,
        fieldsBytes: b.summary.writtenFieldsBytes,
        indexBytes: b.actualIndexBytes,
        contentBytes: b.actualContentBytes,
        allTermFileBytes: b.actualAllFilesBytes},
    actualSavedBytes: saved,
    fieldReductionPercent: saved / a.summary.writtenFieldsBytes * 100,
    indexReductionPercent: saved / a.actualIndexBytes * 100,
    termFileReductionPercent: saved / a.actualAllFilesBytes * 100,
    rows: a.rows,
    groups: a.groupResults.length,
    chunks: a.chunks.length,
    format4Chunks: b.summary.format4Chunks,
    format4Rows: b.summary.format4Rows,
    fallbackCounts,
    exactParserOutputsAndLookupPayloads: true,
    everyActualFieldRowMatchesSource: true,
    everyActualFinalChunkReread: true,
    everyExpandedFileAndMetadataMatchesOriginalOracle: true,
    finalOutputOracle: a.finalOracle,
    actualPersistedFiles: bActual.persisted.files,
    defaultOffPreservesEveryOriginalFileByte: true,
    limitations: ['Sequential production-group term sink, not whole-browser import timing.',
        'Separate media persistence/UI/SQLite/restart/lookup are outside this corpus boundary.',
        'Actual persisted size does not establish browser memory or elapsed-time improvement.']};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'});
console.log(JSON.stringify({corpus: result.corpus,
    success: true,
    actualSavedBytes: saved,
    format4Chunks: result.format4Chunks,
    indexReductionPercent: result.indexReductionPercent}));
