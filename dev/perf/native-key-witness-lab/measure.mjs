/* SPDX-License-Identifier: GPL-3.0-or-later
 * Temporary native parser experiment; no complete-import speedup claim.
 */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const [dictionary, sourceRoot, wasmPath, output, manifestRoot, repeatsText = '1'] = process.argv.slice(2);
if (!dictionary || !sourceRoot || !wasmPath || !output || !manifestRoot) throw new Error('dictionary source-root wasm-path output manifest-root [repeats]');
const repeats = Number(repeatsText);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Invalid repetitions');
if (typeof process.threadCpuUsage !== 'function') throw new Error('threadCpuUsage is required');
const parserPath = path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js');
const parser = await import(pathToFileURL(parserPath));
const prep = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')));
const wasm = await fs.readFile(wasmPath);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compileStart = performance.now();
parser.setTermBankWasmModule(await WebAssembly.compile(wasm));
const compileWallMs = performance.now() - compileStart;
const options = {singleChunk: true, compactContentMetadata: true, emitTermByteLists: false,
    computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
    mediaHintFastScan: true, validateGlossaryTypes: true, prepareLookupIndexes: true};
let manifest;
let file;
let groups;
let synthetic;
if (dictionary.startsWith('unique-')) {
    const kind = dictionary.slice(7);
    if (!['fixed', 'varying', 'long'].includes(kind)) throw new Error('Unknown control');
    const encoder = new TextEncoder();
    const rows = 60000;
    const banks = [];
    for (let bank = 0; bank < 2; ++bank) {
        const values = [];
        for (let local = 0; local < rows / 2; ++local) {
            const i = bank * rows / 2 + local;
            const n = String(i).padStart(8, '0');
            const prefix = kind === 'varying' ? '日'.repeat(2 + i % 10) : '日'.repeat(kind === 'long' ? 20 : 8);
            const readingPrefix = kind === 'varying' ? '語'.repeat(2 + (i + 3) % 10) : '語'.repeat(kind === 'long' ? 20 : 8);
            values.push([prefix + n, readingPrefix + n, '', '', i % 7, ['definition ' + i], i, '']);
        }
        banks.push(encoder.encode(JSON.stringify(values)));
    }
    synthetic = banks;
    groups = [banks];
    manifest = {dictionary, termRows: rows, sourceBytes: banks.reduce((n, b) => n + b.byteLength, 0),
        archiveSha256: sha(Buffer.concat(banks))};
} else {
    manifest = JSON.parse(await fs.readFile(path.join(manifestRoot, dictionary + '-sources.json')));
    file = await fs.open(manifest.archivePath, 'r');
    const banks = manifest.entries;
    const count = Math.min(banks.length, Math.max(12, Math.ceil(manifest.sourceBytes / (24 * 1024 * 1024))));
    groups = [];
    let start = 0, consumed = 0;
    for (let i = 0; i < count - 1; ++i) {
        const remaining = count - i;
        const target = (manifest.sourceBytes - consumed) / remaining;
        const maxEnd = banks.length - (remaining - 1);
        let end = start + 1, bytes = banks[start].uncompressedSize;
        while (end < maxEnd) {
            const next = bytes + banks[end].uncompressedSize;
            if (Math.abs(next - target) > Math.abs(bytes - target)) break;
            bytes = next;
            ++end;
        }
        groups.push(banks.slice(start, end));
        start = end;
        consumed += bytes;
    }
    groups.push(banks.slice(start));
    if (dictionary === 'vndb') options.experimentalNativeEscapedKeys = true;
}
function updateView(hash, name, view) {
    if (view === undefined || view === null) { hash.update(name + ':absent;'); return; }
    if (!ArrayBuffer.isView(view)) throw new Error('Expected view ' + name);
    hash.update(name + ':' + view.constructor.name + ':' + view.byteLength + ':');
    hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}
function digestChunk(chunk) {
    const digest = createHash('sha256');
    digest.update(JSON.stringify({rowCount: chunk.rowCount, contentRowStart: chunk.contentRowStart,
        contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex, contentBytesLength: chunk.contentBytesLength,
        useResolvedContentReferences: chunk.useResolvedContentReferences}));
    for (const field of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentHash1List',
        'contentHash2List', 'contentMetaList', 'contentUniqueIndexList']) updateView(digest, field, chunk[field]);
    const base = chunk.contentBytesBaseOffset;
    const length = chunk.contentBytesLength;
    if (typeof base !== 'number' || typeof length !== 'number' || !chunk.contentBytesBuffer) throw new Error('Missing complete content slab');
    updateView(digest, 'contentSlab', chunk.contentBytesBuffer.subarray(base, base + length));
    if (chunk.contentDedupPlan) {
        const plan = chunk.contentDedupPlan;
        digest.update(JSON.stringify({uniqueCount: plan.uniqueCount, sourceRowCount: plan.sourceRowCount}));
        for (const field of ['uniqueRowIndexes', 'uniqueSignatures']) updateView(digest, field, plan[field]);
    }
    const addPlan = (plan, prefix) => {
        for (const field of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer',
            'expressionIndexes', 'readingIndexes']) updateView(digest, prefix + field, plan[field]);
    };
    addPlan(chunk.termRecordPreinternedPlan, 'full:');
    let indexBytes = 0;
    for (const [key, index] of chunk.preparedLookupIndexes) {
        digest.update(key);
        updateView(digest, 'index', index.bytes);
        indexBytes += index.bytes.byteLength;
        addPlan(index.preinternedPlan, key + ':');
    }
    for (const row of chunk.mediaRows) digest.update(JSON.stringify(row));
    return {digest: digest.digest('hex'), indexBytes, mediaRows: chunk.mediaRows.length};
}
async function loadGroup(group) {
    if (synthetic) return group;
    const results = [];
    for (const entry of group) {
        const bytes = new Uint8Array(entry.compressedSize);
        const read = await file.read(bytes, 0, bytes.byteLength, entry.offset);
        if (read.bytesRead !== bytes.byteLength) throw new Error('Truncated source');
        results.push({...entry, bytes});
    }
    return results;
}
const cpu = () => process.threadCpuUsage();
const cpuMs = delta => (delta.user + delta.system) / 1000;
async function execute(sources, verify) {
    let chunk;
    const t = performance.now(), c = cpu();
    const preloadedSource = synthetic ? undefined : await parser.inflateCompressedTermBankSourcesWasm(sources, options, true);
    const inflated = performance.now(), ic = cpu();
    await parser.parseTermBankWithWasmColumnChunks(synthetic ? sources : new Uint8Array(0), 3, value => {
        chunk = value;
        if (!(chunk.preparedLookupIndexes instanceof Map)) {
            const result = prep.prepareTermLookupIndexesFromPreinternedPlan(chunk);
            if (!result) throw new Error('Missing indexes');
            chunk.preparedLookupIndexes = result.indexes;
        }
    }, 2048, {...options, preloadedSource});
    const end = performance.now(), endCpu = cpu();
    const profile = parser.consumeLastTermBankWasmParseProfile();
    if (!chunk || !profile || !prep.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount)) throw new Error('Incomplete parser result');
    const data = verify ? digestChunk(chunk) : {};
    const out = {...data, rows: chunk.rowCount, wallMs: end - t,
        threadCpuMs: cpuMs({user: endCpu.user - c.user, system: endCpu.system - c.system}),
        parseWallMs: end - inflated,
        parseThreadCpuMs: cpuMs({user: endCpu.user - ic.user, system: endCpu.system - ic.system}),
        inflateWallMs: inflated - t, profile};
    chunk = null;
    return out;
}
const result = {dictionary, node: process.version, sourceRoot, wasmPath, wasmSha256: sha(wasm),
    parserJsSha256: sha(await fs.readFile(parserPath)), runnerSha256: sha(await fs.readFile(new URL(import.meta.url))),
    archiveSha256: manifest.archiveSha256, sourceBytes: manifest.sourceBytes, termRows: manifest.termRows,
    groupCount: groups.length, options, compileWallMs,
    boundary: 'Sequential resident native inflate+CRC+parse+complete lookup; excludes file IO, module compile, warmups, explicit GC, digest, result copy, IPC and OPFS. Not a complete import.',
    repeats, complete: false, excludedWarmups: [], observations: []};
const save = async () => fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
await save();
try {
    let warm = await loadGroup(groups[0]);
    for (let i = 0; i < 2; ++i) result.excludedWarmups.push(await execute(warm, false));
    warm = null;
    globalThis.gc?.();
    for (let repeat = 0; repeat < repeats; ++repeat) {
        const observation = {repeat, complete: false, entries: []};
        result.observations.push(observation);
        for (let group = 0; group < groups.length; ++group) {
            let sources = await loadGroup(groups[group]);
            const value = await execute(sources, true);
            observation.entries.push({group, ...value});
            sources = null;
            globalThis.gc?.();
            await save();
        }
        if (observation.entries.reduce((n, x) => n + x.rows, 0) !== manifest.termRows) throw new Error('Row count differs');
        observation.complete = true;
    }
    result.complete = true;
} catch (error) {
    result.error = String(error);
    throw error;
} finally {
    if (file) await file.close();
    result.maxRssKiB = process.resourceUsage().maxRSS;
    result.memory = process.memoryUsage();
    await save();
}
const entries = result.observations.flatMap(x => x.entries);
const sum = field => entries.reduce((n, x) => n + x[field], 0);
console.log(JSON.stringify({dictionary, output, wasmSha256: result.wasmSha256, groups: groups.length, repeats,
    rows: sum('rows'), wallMs: sum('wallMs'), threadCpuMs: sum('threadCpuMs'),
    parseThreadCpuMs: sum('parseThreadCpuMs'),
    fallbacks: entries.reduce((n, x) => n + (x.profile.fusedParseFallbacks ?? 0), 0),
    maxRssKiB: result.maxRssKiB}));
