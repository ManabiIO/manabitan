/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, openAsBlob} from 'node:fs';
import {mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js';
import {BASE_SHA, STORE_PATH, exposeValidator, git, identity, localImport, sha256, updateFramed, updateValidationDigest} from './common.mjs';

// Real current corpus -> actual record encoders -> complete sidecar envelopes.
// One source bank at a time is a bounded fixture shape, not a production planner
// assertion. Persistence is intercepted; deterministic native-content spans
// replace compressed physical offsets. This phase is entirely untimed.
const [baseArg, candidateArg, cacheArg, outputArg, dictionary] = process.argv.slice(2);
assert(baseArg && candidateArg && cacheArg && outputArg && ['jmdict', 'jitendex', 'vndb'].includes(dictionary));
const [baseRoot, candidateRoot, cacheRoot, outputRoot] = [baseArg, candidateArg, cacheArg, outputArg].map((value) => resolve(value));
await mkdir(outputRoot, {recursive: true});
const baseline = await identity(baseRoot);
const candidate = await identity(candidateRoot);
assert.equal(baseline.head, BASE_SHA);
assert.equal(baseline.trackedChanges, '');
assert.equal(candidate.trackedChanges, '');
assert.equal(git(candidateRoot, 'rev-parse', 'HEAD^'), BASE_SHA);
assert.equal(git(candidateRoot, 'diff', '--name-only', BASE_SHA, candidate.head), STORE_PATH);
for (const field of ['wasmSha256', 'dependencyLockSha256', 'fixtureLockSha256']) { assert.equal(candidate[field], baseline[field]); }
const baseSource = await readFile(join(baseRoot, STORE_PATH), 'utf8');
const oldLoop = '    for (const scoreKey of scoreKeys) {\n        if (scoreKey >= scoreCount) {';
const newLoop = '    for (let i = 0; i < scoreKeys.length; ++i) {\n        if (scoreKeys[i] >= scoreCount) {';
assert.equal(baseSource.split(oldLoop).length, 2);
assert.equal(await readFile(join(candidateRoot, STORE_PATH), 'utf8'), baseSource.replace(oldLoop, newLoop));
const fixture = JSON.parse(await readFile(join(baseRoot, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries[dictionary];
const archivePath = join(cacheRoot, fixture.cacheFile);
const archiveHash = createHash('sha256');
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes); }
assert.equal(archiveHash.digest('hex'), fixture.sha256);
const archive = await openAsBlob(archivePath);
assert.equal(archive.size, fixture.sizeBytes);
const parser = await localImport(baseRoot, 'ext/js/dictionary/term-bank-wasm-parser.js');
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(join(baseRoot, 'ext/lib/term-bank-parser.wasm'))));
const baseModule = await localImport(baseRoot, STORE_PATH);
const candidateModule = await localImport(candidateRoot, STORE_PATH);
const validateBase = await exposeValidator(baseRoot);
const validateCandidate = await exposeValidator(candidateRoot);
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 1, deviceMemory: 4}});
const reader = new ZipReader(new BlobReader(archive));
const entries = await reader.getEntries();
const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
const inputFile = await open(join(outputRoot, 'inputs.bin'), 'wx');
const inputHash = createHash('sha256');
const sidecarHash = createHash('sha256');
const validatorHash = createHash('sha256');
let filePosition = 0;
let rows = 0;
let compactRows = 0;
let contentBase = 2 ** 40;
const manifest = {
    schema: 1, complete: false, dictionary, fixture, baseline, candidate,
    selection: 'Every emitted record run from every locked term bank, in numeric bank order; no timing-based selection.',
    scope: 'Component fixture capture: sequential one-bank parser and record encoders, deterministic native-content spans, intercepted persistence. No compression, OPFS, worker IPC, browser, UI, or import-completion qualification.',
    node: process.version, runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    commonSha256: sha256(await readFile(new URL('./common.mjs', import.meta.url))),
    groups: [], inputs: [],
};

async function appendAligned(bytes) {
    const padding = (8 - filePosition % 8) % 8;
    if (padding > 0) {
        const zeros = new Uint8Array(padding);
        await inputFile.writeFile(zeros);
        inputHash.update(zeros);
        filePosition += padding;
    }
    const offset = filePosition;
    await inputFile.writeFile(bytes);
    inputHash.update(bytes);
    filePosition += bytes.byteLength;
    return offset;
}

async function encode(module, chunk, offsets, lengths) {
    const store = new module.TermRecordOpfsStore();
    const writes = [];
    const envelopes = [];
    store._appendEncodedChunk = async (...args) => {
        writes.push(args.slice(1));
        envelopes.push(store._createLookupIndexChunk(args[1], args[2], args[4], args[5], args[6], args[7]));
    };
    const recordChunk = module.createArtifactTermRecordChunkWithResolvedContent(
        {...chunk, dictionary: fixture.expectedTitle}, chunk.contentUniqueIndexList, offsets, lengths, chunk.preparedLookupIndexes,
    );
    await store._encodeAndAppendArtifactChunkForState({}, recordChunk, rows + 1, new Float64Array(0), new Uint32Array(0),
        chunk.termRecordPreinternedPlan, 'raw', chunk.preparedLookupIndexes);
    return {writes, envelopes};
}

async function consume(chunk) {
    const plan = chunk.contentDedupPlan;
    assert(plan && chunk.contentUniqueIndexList && chunk.contentMetaList);
    const offsets = new Float64Array(plan.uniqueCount);
    const lengths = new Uint32Array(plan.uniqueCount);
    for (let i = 0; i < plan.uniqueCount; ++i) {
        const meta = (chunk.contentMetaByUniqueIndex ? i : plan.uniqueRowIndexes[i]) * 4;
        offsets[i] = contentBase + chunk.contentMetaList[meta];
        lengths[i] = chunk.contentMetaList[meta + 1];
    }
    const before = await encode(baseModule, chunk, offsets, lengths);
    const after = await encode(candidateModule, chunk, offsets, lengths);
    assert.deepEqual(after.writes, before.writes);
    assert.deepEqual(after.envelopes, before.envelopes);
    assert.equal(before.writes.reduce((total, item) => total + item[1], 0), chunk.rowCount);
    for (let i = 0; i < before.writes.length; ++i) {
        const [firstId, count, contentDictName, base, payload, fields, format] = before.writes[i];
        assert(payload instanceof Uint8Array && fields instanceof Uint8Array);
        updateFramed(sidecarHash, before.envelopes[i]);
        if (format === 2) {
            const parsedBase = validateBase(fields, count);
            assert.deepEqual(validateCandidate(fields, count), parsedBase);
            updateValidationDigest(validatorHash, parsedBase);
            compactRows += count;
        }
        manifest.inputs.push({
            firstId, count, contentDictName, base, format,
            payloadOffset: await appendAligned(payload), payloadLength: payload.byteLength,
            fieldsOffset: await appendAligned(fields), fieldsLength: fields.byteLength,
            envelopeSha256: sha256(before.envelopes[i]),
        });
    }
    manifest.groups.push({rows: chunk.rowCount, runRows: before.writes.map((item) => item[1]),
        preparedRanges: [...chunk.preparedLookupIndexes.keys()]});
    rows += chunk.rowCount;
    contentBase += chunk.contentBytesLength ?? chunk.contentBytesBuffer.byteLength;
}

const media = fixture.mediaFiles > 0;
const options = {emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
    emitTokenBinaryContent: true, mediaHintFastScan: media, projectImagePaths: media,
    validateGlossaryTypes: true, prepareLookupIndexes: true, maxPendingChunks: 2, singleChunk: true};
let failure = null;
try {
    for (let i = 0; i < termFiles.length; ++i) {
        const file = termFiles[i];
        const bytes = await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true});
        await parser.parseTermBankWithWasmColumnChunks(bytes, 3, consume, 2048, options);
        parser.consumeLastTermBankWasmParseProfile();
        if (i % 25 === 0 || i + 1 === termFiles.length) {
            console.log('SCORE_PREP_PROGRESS ' + JSON.stringify({dictionary, banks: i + 1, rows}));
        }
    }
    assert.equal(rows, fixture.termRows);
    assert(compactRows > 0);
    assert.deepEqual(await identity(baseRoot), baseline);
    assert.deepEqual(await identity(candidateRoot), candidate);
    manifest.complete = true;
} catch (error) {
    failure = error;
    manifest.error = String(error);
} finally {
    const cleanup = await Promise.allSettled([parser.disposeParallelTermBankParser(), reader.close(), inputFile.close()]);
    for (const result of cleanup) {
        if (result.status === 'rejected') { failure ??= result.reason; manifest.complete = false; manifest.error = String(failure); }
    }
    Object.assign(manifest, {rows, compactRows, banks: termFiles.length, inputBytes: filePosition,
        inputSha256: inputHash.digest('hex'), expectedSidecarDigest: sidecarHash.digest('hex'),
        expectedValidatorDigest: validatorHash.digest('hex'), parserOptions: options});
    await writeFile(join(outputRoot, 'inputs.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
}
if (failure !== null) { throw failure; }
console.log('SCORE_PREPARED ' + JSON.stringify({dictionary, complete: true, rows, compactRows,
    banks: termFiles.length, runs: manifest.inputs.length, inputBytes: filePosition,
    inputSha256: manifest.inputSha256, sidecarDigest: manifest.expectedSidecarDigest}));
