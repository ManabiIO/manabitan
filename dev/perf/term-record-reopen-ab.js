#!/usr/bin/env node
/*
 * Research-only cold persistent-index reopen benchmark.
 * Not part of the product PR.
 */

import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const candidateRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const baselineRoot = path.resolve(process.argv[2] ?? '');
if (baselineRoot.length === 0) {
    throw new Error('Usage: node --expose-gc dev/perf/term-record-reopen-ab.js BASELINE_ROOT [PAIRS]');
}
const pairs = Number(process.argv[3] ?? '12');
if (!Number.isSafeInteger(pairs) || pairs < 4) {
    throw new RangeError('Pairs must be an integer >= 4');
}
const dictionaryName = 'Cold Reopen Benchmark';
const rowCount = 120_000;
const rowsPerAppend = 20_000;
const targetRow = rowCount - 1;
const targetExpression = `term-${String(targetRow).padStart(6, '0')}`;
const encoder = new TextEncoder();

/**
 * @param {Map<string, Uint8Array>} fileBytesByName
 * @param {{indexFileName?: string|null, counters?: {fullReads: number, fullBytes: number, rangeReads: number, rangeBytes: number}}} [options]
 * @returns {FileSystemDirectoryHandle}
 */
function createFakeDirectoryHandle(fileBytesByName, {indexFileName = null, counters = void 0} = {}) {
    /**
     * @param {string} name
     * @param {{create?: boolean}} [options]
     * @returns {Promise<FileSystemFileHandle>}
     */
    const getFileHandle = async (name, options = {}) => {
        if (!fileBytesByName.has(name)) {
            if (options.create !== true) { throw new Error(`File not found: ${name}`); }
            fileBytesByName.set(name, new Uint8Array());
        }
        return /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
            kind: 'file',
            name,
            async getFile() {
                const bytes = fileBytesByName.get(name) ?? new Uint8Array();
                if (name === indexFileName && counters) {
                    return /** @type {File} */ (/** @type {unknown} */ ({
                        size: bytes.byteLength,
                        async arrayBuffer() {
                            counters.fullReads += 1;
                            counters.fullBytes += bytes.byteLength;
                            return Uint8Array.from(bytes).buffer;
                        },
                        /**
                         * @param {number} start
                         * @param {number} end
                         * @returns {Blob}
                         */
                        slice(start, end) {
                            counters.rangeReads += 1;
                            counters.rangeBytes += Math.max(0, end - start);
                            return new Blob([bytes.subarray(start, end)]);
                        },
                    }));
                }
                const file = new Blob([bytes]);
                Object.defineProperty(file, 'name', {value: name});
                return /** @type {File} */ (file);
            },
            async createWritable() {
                let nextBytes = fileBytesByName.get(name) ?? new Uint8Array();
                let cursor = nextBytes.byteLength;
                return {
                    /** @param {number} position */
                    async seek(position) { cursor = position; },
                    /** @param {number} length */
                    async truncate(length) {
                        if (length <= nextBytes.byteLength) {
                            nextBytes = nextBytes.slice(0, length);
                        } else {
                            const expanded = new Uint8Array(length);
                            expanded.set(nextBytes);
                            nextBytes = expanded;
                        }
                        cursor = Math.min(cursor, length);
                    },
                    /** @param {FileSystemWriteChunkType} value */
                    async write(value) {
                        /** @type {Uint8Array} */
                        let bytes;
                        if (value instanceof ArrayBuffer) {
                            bytes = new Uint8Array(value);
                        } else if (ArrayBuffer.isView(value)) {
                            bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                        } else if (value instanceof Blob) {
                            bytes = new Uint8Array(await value.arrayBuffer());
                        } else {
                            throw new TypeError(`Unsupported write: ${String(value)}`);
                        }
                        const required = cursor + bytes.byteLength;
                        if (required > nextBytes.byteLength) {
                            const expanded = new Uint8Array(required);
                            expanded.set(nextBytes);
                            nextBytes = expanded;
                        }
                        nextBytes.set(bytes, cursor);
                        cursor += bytes.byteLength;
                    },
                    async close() { fileBytesByName.set(name, nextBytes); },
                };
            },
        }));
    };
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        getFileHandle,
        async removeEntry(name) { fileBytesByName.delete(name); },
        async *entries() {
            for (const name of fileBytesByName.keys()) {
                yield [name, await getFileHandle(name, {create: false})];
            }
        },
    }));
}

/**
 * @param {string} root
 * @returns {Promise<typeof import('../../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore>}
 */
async function loadStore(root) {
    const url = pathToFileURL(path.join(root, 'ext/js/dictionary/term-record-opfs-store.js')).href;
    return (await import(url)).TermRecordOpfsStore;
}

const CandidateStore = await loadStore(candidateRoot);
const BaselineStore = await loadStore(baselineRoot);

/** @returns {Promise<Map<string, Uint8Array>>} */
async function createFixture() {
    const files = new Map();
    const directory = createFakeDirectoryHandle(files);
    const store = new CandidateStore();
    Reflect.set(store, '_recordsDirectoryHandle', directory);
    for (let start = 0; start < rowCount; start += rowsPerAppend) {
        const count = Math.min(rowsPerAppend, rowCount - start);
        const expressionBytesList = new Array(count);
        const readingBytesList = new Array(count);
        const scoreList = new Int32Array(count);
        const sequenceList = new Int32Array(count);
        const offsets = new Float64Array(count);
        const lengths = new Uint32Array(count);
        for (let i = 0; i < count; ++i) {
            const row = start + i;
            const suffix = String(row).padStart(6, '0');
            expressionBytesList[i] = encoder.encode(`term-${suffix}`);
            readingBytesList[i] = encoder.encode(`read-${suffix}`);
            scoreList[i] = (row % 2001) - 1000;
            sequenceList[i] = row + 1;
            offsets[i] = row * 16;
            lengths[i] = 8;
        }
        await store.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: rowCount,
                rowCount: count,
                expressionBytesList,
                readingBytesList,
                readingEqualsExpressionList: new Uint8Array(count),
                scoreList,
                sequenceList,
            },
            offsets,
            lengths,
            'raw',
        );
    }
    await store._closeAllWritables();
    return files;
}

console.error(`Generating ${rowCount} row fixture...`);
const files = await createFixture();
const indexFileName = [...files.keys()].find((name) => name.endsWith('.mbti'));
if (typeof indexFileName !== 'string') { throw new Error('Missing lookup-index sidecar'); }
const indexBytes = files.get(indexFileName);
if (!(indexBytes instanceof Uint8Array)) { throw new Error('Missing lookup-index bytes'); }
const indexHash = createHash('sha256').update(indexBytes).digest('hex');
const indexView = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
const persistedChunkCount = indexView.getUint32(16, true);
const persistedRecordCount = indexView.getUint32(20, true);
if (persistedRecordCount !== rowCount || persistedChunkCount < 2) {
    throw new Error(`Unexpected sidecar dimensions: chunks=${persistedChunkCount} rows=${persistedRecordCount}`);
}

globalThis.gc?.();
const fixtureMemory = process.memoryUsage();

/**
 * @param {typeof CandidateStore} Store
 * @param {string} arm
 * @returns {Promise<object>}
 */
async function measure(Store, arm) {
    globalThis.gc?.();
    const before = process.memoryUsage();
    const counters = {fullReads: 0, fullBytes: 0, rangeReads: 0, rangeBytes: 0};
    const directory = createFakeDirectoryHandle(files, {indexFileName, counters});
    const store = new Store();
    Reflect.set(store, '_recordsDirectoryHandle', directory);
    const started = performance.now();
    await store._loadShardFiles(false);
    await store.ensureDictionariesLoaded([dictionaryName]);
    const ids = store.findTermIds(dictionaryName, targetExpression, 'expression');
    const id = ids[0] ?? -1;
    if (id <= 0) { throw new Error(`${arm}: target lookup failed`); }
    const record = (await store.getByIdsAsync([id])).get(id);
    if (
        record?.expression !== targetExpression ||
        record.reading !== `read-${String(targetRow).padStart(6, '0')}` ||
        record.entryContentOffset !== targetRow * 16 ||
        record.entryContentLength !== 8 ||
        record.sequence !== targetRow + 1
    ) {
        throw new Error(`${arm}: materialized record mismatch`);
    }
    if (store.getDictionaryRecordCount(dictionaryName) !== rowCount) {
        throw new Error(`${arm}: dictionary count mismatch`);
    }
    const elapsedMs = performance.now() - started;
    const live = process.memoryUsage();
    return {
        arm,
        elapsedMs,
        fullReads: counters.fullReads,
        fullBytes: counters.fullBytes,
        rangeReads: counters.rangeReads,
        rangeBytes: counters.rangeBytes,
        arrayBufferDelta: live.arrayBuffers - before.arrayBuffers,
        externalDelta: live.external - before.external,
        heapUsedDelta: live.heapUsed - before.heapUsed,
    };
}

for (let i = 0; i < 2; ++i) {
    await measure(BaselineStore, 'A-warmup');
    await measure(CandidateStore, 'B-warmup');
}

const observations = [];
for (let pair = 0; pair < pairs; ++pair) {
    const order = pair % 2 === 0 ?
        [['A', BaselineStore], ['B', CandidateStore]] :
        [['B', CandidateStore], ['A', BaselineStore]];
    for (const [arm, Store] of order) {
        const result = await measure(Store, arm);
        observations.push({pair: pair + 1, ...result});
        console.error(`pair ${pair + 1}/${pairs} ${arm}: ${result.elapsedMs.toFixed(2)}ms full=${result.fullBytes} range=${result.rangeBytes}`);
    }
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const paired = [];
for (let pair = 1; pair <= pairs; ++pair) {
    const a = observations.find((value) => value.pair === pair && value.arm === 'A');
    const b = observations.find((value) => value.pair === pair && value.arm === 'B');
    if (!a || !b) { throw new Error(`Missing pair ${pair}`); }
    paired.push({
        pair,
        baselineMs: a.elapsedMs,
        candidateMs: b.elapsedMs,
        changePct: (b.elapsedMs / a.elapsedMs - 1) * 100,
    });
}
const output = {
    schemaVersion: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    baselineRoot,
    candidateRoot,
    fixture: {
        rowCount,
        rowsPerAppend,
        indexFileName,
        indexBytes: indexBytes.byteLength,
        indexSha256: indexHash,
        persistedChunkCount,
        persistedRecordCount,
        memory: fixtureMemory,
    },
    pairs,
    paired,
    summary: {
        pairedMedianChangePct: median(paired.map((value) => value.changePct)),
        fasterPairs: paired.filter((value) => value.candidateMs < value.baselineMs).length,
        baselineMedianMs: median(observations.filter((value) => value.arm === 'A').map((value) => value.elapsedMs)),
        candidateMedianMs: median(observations.filter((value) => value.arm === 'B').map((value) => value.elapsedMs)),
        baselineFullBytes: observations.find((value) => value.arm === 'A')?.fullBytes ?? null,
        candidateFullBytes: observations.find((value) => value.arm === 'B')?.fullBytes ?? null,
        baselineRangeBytes: observations.find((value) => value.arm === 'A')?.rangeBytes ?? null,
        candidateRangeBytes: observations.find((value) => value.arm === 'B')?.rangeBytes ?? null,
        baselineArrayBufferDeltaMedian: median(observations.filter((value) => value.arm === 'A').map((value) => value.arrayBufferDelta)),
        candidateArrayBufferDeltaMedian: median(observations.filter((value) => value.arm === 'B').map((value) => value.arrayBufferDelta)),
    },
    observations,
};
console.log(JSON.stringify(output, null, 2));
