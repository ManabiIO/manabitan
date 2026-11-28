#!/usr/bin/env node
// Diagnostic capture of current canonical JMdict compression inputs; no timing claim.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js';

const [sourceRootArg, cacheArg, outputArg] = process.argv.slice(2);
if (!sourceRootArg || !cacheArg || !outputArg) { throw new Error('Usage: capture BASELINE CACHE OUTPUT'); }
const sourceRoot = path.resolve(sourceRootArg);
const output = path.resolve(outputArg);
const expectedCommit = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(), expectedCommit);
assert.equal(execFileSync('git', ['diff', '--name-only'], {cwd: sourceRoot, encoding: 'utf8'}).trim(), '');
await mkdir(output, {recursive: true});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const load = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
const parser = await load('ext/js/dictionary/term-bank-wasm-parser.js');
const ownership = await load('ext/js/dictionary/term-content-ownership.js');
const support = await load('dev/perf/import-ownership-support-a7c4.js');
const {DictionaryDatabase} = await load('ext/js/dictionary/dictionary-database.js');
const {NativeCanonicalScanner} = await load('ext/js/dictionary/term-content-canonical-scan.js');
const {RAW_TERM_CONTENT_TOKEN_DICT_NAME} = await load('ext/js/dictionary/raw-term-content.js');
const sourcePaths = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/term-content-ownership.js',
    'ext/js/dictionary/dictionary-database.js',
    'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/term-content-canonical-scan.js',
    'ext/js/dictionary/raw-term-content.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/manifest.json',
];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, sha256(await readFile(path.join(sourceRoot, file)))])));
assert.equal(sourceHashes['ext/js/dictionary/term-bank-wasm-parser.js'], support.expectedParserSha256);
assert.equal(sourceHashes['ext/js/dictionary/term-bank-wasm-parser-worker.js'], support.expectedWorkerSha256);
assert.equal(sourceHashes['ext/js/dictionary/term-content-ownership.js'], support.expectedOwnershipSha256);
const lockBytes = await readFile(path.join(sourceRoot, 'test/perf/dictionaries.lock.json'));
const fixture = JSON.parse(lockBytes.toString()).dictionaries.jmdict;
const archive = await readFile(path.join(path.resolve(cacheArg), fixture.cacheFile));
assert.equal(archive.length, fixture.sizeBytes);
assert.equal(sha256(archive), fixture.sha256);
const wasmBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'));
const canonicalBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-content-canonical-scan-v1.wasm'));
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
const canonicalModule = await WebAssembly.compile(canonicalBytes);
const blockSource = await readFile(path.join(sourceRoot, 'ext/js/dictionary/term-content-block-store.js'), 'utf8');
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n}', start);
    if (start < 0 || end < start || source.indexOf('function ' + name + '(', start + 1) >= 0) { throw new Error('Ambiguous block helper: ' + name); }
    return source.slice(start, end + 2);
}
const packingCode = [
    'export ' + extractFunction(blockSource, 'planContentSpansIntoSlabs'),
    'export ' + extractFunction(blockSource, 'packPlannedContentSpansIntoSlabs'),
    extractFunction(blockSource, 'packContentSpanBlock'),
    '',
].join('\n');
const packingPath = path.join(output, 'packing-support.mjs');
await writeFile(packingPath, packingCode, {flag: 'wx'});
const packing = await import(pathToFileURL(packingPath).href);
const sourceBanks = [];
const names = new Map();
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
try {
    const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
    for (const entry of entries) {
        assert.equal(typeof entry.getData, 'function');
        const bytes = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true});
        sourceBanks.push(bytes);
        names.set(bytes, entry.filename);
    }
} finally { await reader.close(); }
const groups = support.partitionSourceBanks(sourceBanks, sourceBanks.reduce((sum, bytes) => sum + bytes.byteLength, 0), 12);
const database = new DictionaryDatabase();
database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule});
database._bulkImportTransactionOpen = true;
// Capture keeps current parsing, canonical selection, exact equality and metadata
// publication. Storage/record writes are replaced by immutable in-memory references.
database._tryBeginPersistArtifactTermContent = () => null;
database._appendResolvedArtifactTermRecords = async () => {};
const stored = new Map();
let nextOffset = 1;
let groupIndex = -1;
let rows = 0;
let uniqueRows = 0;
let persistedHits = 0;
let packedBytes = 0;
const blocks = [];
const groupResults = [];
const sourceRowDigest = createHash('sha256');
const resolvedRowDigest = createHash('sha256');
database._readTermEntryContentBytesDetailed = async (offset, length) => {
    const value = stored.get(offset);
    assert(value && value.byteLength === length, 'Capture storage reference missing');
    return {status: 'ok', bytes: value};
};
database._persistArtifactTermContent = async (_dictionary, pendingContentBytes, _names, uniformContentDictName, spans) => {
    assert(spans && spans.buffer instanceof Uint8Array, 'Expected current canonical span path');
    assert.equal(pendingContentBytes.length, 0);
    const {blockStartIndexes, packedChunkLengths} = packing.planContentSpansIntoSlabs(spans.lengths, 1048576);
    const packed = packing.packPlannedContentSpansIntoSlabs(spans.buffer, spans.offsets, spans.lengths, blockStartIndexes, packedChunkLengths);
    for (let blockIndex = 0; blockIndex < packed.length; ++blockIndex) {
        const bytes = packed[blockIndex];
        const filename = 'group-' + String(groupIndex + 1).padStart(3, '0') + '-block-' + String(blockIndex + 1).padStart(3, '0') + '.bin';
        await writeFile(path.join(output, filename), bytes, {flag: 'wx'});
        blocks.push({filename, group: groupIndex, spans: blockStartIndexes[blockIndex + 1] - blockStartIndexes[blockIndex], bytes: bytes.length, sha256: sha256(bytes)});
        packedBytes += bytes.length;
    }
    const pendingOffsets = new Float64Array(spans.lengths.length);
    const pendingLengths = new Uint32Array(spans.lengths);
    for (let i = 0; i < spans.lengths.length; ++i) {
        const start = spans.offsets[i];
        const length = spans.lengths[i];
        pendingOffsets[i] = nextOffset;
        stored.set(nextOffset, spans.buffer.subarray(start, start + length));
        nextOffset += Math.max(1, length);
    }
    return {pendingOffsets, pendingLengths, pendingResolvedDictNames: uniformContentDictName, blockProfile: null};
};
const manifest = {
    scope: 'Diagnostic current-source canonical content capture. Sequential ordinary 12-group parser + actual owned chunk boundary + real native canonical dedup/metadata; in-memory persistence and no record/OPFS/compression execution. Not browser performance evidence.',
    dictionary: 'jmdict',
    sourceCommit: expectedCommit,
    sourceRoot,
    sourceHashes,
    fixture,
    lockSha256: sha256(lockBytes),
    dictionaryArchiveSha256: fixture.sha256,
    wasmSha256: sha256(wasmBytes),
    canonicalWasmSha256: sha256(canonicalBytes),
    dictionarySha256: sha256(await readFile(path.join(sourceRoot, 'ext/lib/zstd-dicts/jmdict.zdict'))),
    packingSupportSha256: sha256(packingCode),
    captureScriptSha256: sha256(await readFile(new URL(import.meta.url))),
    ownershipSupportSha256: sha256(await readFile(path.join(sourceRoot, 'dev/perf/import-ownership-support-a7c4.js'))),
    blockTargetBytes: 1048576,
    partial: true,
    blocks,
    groups: groupResults,
};
const save = async () => writeFile(path.join(output, 'manifest.json'), JSON.stringify({...manifest, rows, uniqueRows, persistedHits, packedBytes}, null, 2) + '\n');
await save();
try {
    for (const group of groups) {
        ++groupIndex;
        let chunk = null;
        await parser.parseTermBankWithWasmColumnChunks(group, 3, (value) => {
            assert.equal(chunk, null);
            chunk = support.copyOwnedChunkForMeasurement(parser, ownership, value, {prepareLookupRoute: true});
        }, 2048, {
            singleChunk: true, maxPendingChunks: 1, compactContentMetadata: true,
            emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
            emitTokenBinaryContent: true, mediaHintFastScan: false, validateGlossaryTypes: true,
            prepareLookupIndexes: true, prepareLookupRoute: true,
        });
        const profile = parser.consumeLastTermBankWasmParseProfile();
        assert(chunk && profile);
        assert.equal(profile.fusedParseAttempts, 1);
        assert.equal(profile.fusedParseFallbacks, 0);
        assert.equal(profile.nativeLookupScratchReuseGroups, 1);
        assert.equal(profile.nativeSegmentedLookupSegments, 0);
        chunk.dictionary = fixture.expectedTitle;
        chunk.contentDictNameList = null;
        chunk.uniformContentDictName = RAW_TERM_CONTENT_TOKEN_DICT_NAME;
        chunk.dictionaryTotalRows = fixture.termRows;
        chunk.useResolvedContentReferences = true;
        assert(ownership.registerOwnedTermContent(chunk.contentBytesBuffer));
        await database._bulkAddArtifactTermsChunkWithContentDedup(chunk);
        const metrics = {...database._lastBulkAddTermsMetrics};
        rows += chunk.rowCount;
        uniqueRows += metrics.dedupUniqueCount;
        persistedHits += metrics.dedupPersistedHitCount;
        const plan = chunk.contentDedupPlan;
        assert(plan && plan.resolvedFlags.length === plan.uniqueCount);
        for (let row = 0; row < chunk.rowCount; ++row) {
            const unique = chunk.contentUniqueIndexList[row];
            assert.equal(plan.resolvedFlags[unique], 1);
            const metaIndex = (chunk.contentMetaByUniqueIndex === true ? unique : row) * 4;
            const sourceOffset = chunk.contentBytesBaseOffset + chunk.contentMetaList[metaIndex];
            const length = chunk.contentMetaList[metaIndex + 1];
            const original = chunk.contentBytesBuffer.subarray(sourceOffset, sourceOffset + length);
            const resolved = stored.get(plan.resolvedOffsets[unique]);
            assert(resolved && resolved.byteLength === length);
            assert.equal(plan.resolvedLengths[unique], length);
            sourceRowDigest.update(original);
            resolvedRowDigest.update(resolved);
        }
        groupResults.push({group: groupIndex, files: group.map((bytes) => names.get(bytes)), rows: chunk.rowCount, profile, metrics});
        await save();
        console.log(JSON.stringify({stage: 'canonical-capture', group: groupIndex, rows: chunk.rowCount, uniqueRows: metrics.dedupUniqueCount, persistedHits: metrics.dedupPersistedHitCount}));
    }
    assert.deepEqual(groupResults.map((g) => g.rows), [50000, 40000, 40000, 40000, 50000, 50000, 40000, 50000, 40000, 40000, 40000, 48299]);
    assert.equal(rows, fixture.termRows);
    assert.equal(uniqueRows, 362032);
    assert.equal(persistedHits, 3998);
    assert.equal(packedBytes, 100300626);
    assert.equal(blocks.length, 103);
    const sourceDigest = sourceRowDigest.digest('hex');
    const resolvedDigest = resolvedRowDigest.digest('hex');
    assert.equal(sourceDigest, resolvedDigest, 'Canonical references changed row content');
    assert.equal(database._nativeCanonicalScanner.stats.fallbacks, 0);
    assert(database._nativeCanonicalScanner.stats.calls > 0);
    for (const file of sourcePaths) { assert.equal(sha256(await readFile(path.join(sourceRoot, file))), sourceHashes[file]); }
    Object.assign(manifest, {partial: false, rowContentSha256: sourceDigest, nativeCanonicalStats: database._nativeCanonicalScanner.stats});
    await save();
    console.log(JSON.stringify({stage: 'canonical-capture-complete', rows, uniqueRows, persistedHits, packedBytes, blocks: blocks.length, rowContentSha256: sourceDigest}));
} catch (error) {
    manifest.error = String(error?.stack ?? error);
    await save();
    throw error;
}
