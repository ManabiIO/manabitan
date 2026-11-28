import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
    'source-root': {type: 'string'},
    'cache-dir': {type: 'string'},
    'dictionary': {type: 'string'},
    'output': {type: 'string'},
    'max-groups': {type: 'string'},
}});
const root = path.resolve(values['source-root']);
const output = path.resolve(values.output);
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const resource = new URL(String(input));
    return resource.protocol === 'file:' ?
        new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}}) :
        await originalFetch(input, init);
};
const parser = await load('ext/js/dictionary/term-bank-wasm-parser.js');
const {DictionaryDatabase} = await load('ext/js/dictionary/dictionary-database.js');
const zip = await load('node_modules/@zip.js/zip.js/index.js');
const locks = JSON.parse(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries;
const fixture = locks[values.dictionary];
if (!fixture) { throw new Error('Unknown dictionary'); }
const archive = await readFile(path.join(values['cache-dir'], fixture.cacheFile));
if (hash(archive) !== fixture.sha256) { throw new Error('Archive hash differs from lock'); }
const reader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(archive)));
const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
const totalBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
const media = values.dictionary !== 'jmdict';
const requestedGroups = Math.max(3 * (media ? 3 : 4), Math.ceil(totalBytes / (24 * 1024 * 1024)));

// Exact partitionSourceBanks algorithm from the pinned production parser.
// Sources are read sequentially for this content replay; it is not browser timing.
function partition(contentBytes, total, requestedGroupCount) {
    const groupCount = Math.min(requestedGroupCount, contentBytes.length);
    const groups = [];
    let start = 0;
    let consumedBytes = 0;
    for (let groupIndex = 0; groupIndex < groupCount - 1; ++groupIndex) {
        const remainingGroups = groupCount - groupIndex;
        const targetBytes = (total - consumedBytes) / remainingGroups;
        let end = start + 1;
        let bytes = contentBytes[start].uncompressedSize;
        const maxEnd = contentBytes.length - (remainingGroups - 1);
        while (end < maxEnd) {
            const nextBytes = bytes + contentBytes[end].uncompressedSize;
            if (Math.abs(nextBytes - targetBytes) > Math.abs(bytes - targetBytes)) { break; }
            bytes = nextBytes;
            ++end;
        }
        groups.push(contentBytes.slice(start, end));
        start = end;
        consumedBytes += bytes;
    }
    groups.push(contentBytes.slice(start));
    return groups;
}

const groups = partition(entries, totalBytes, requestedGroups);
const database = new DictionaryDatabase();
const blockTargetBytes = database._termContentBlockStore._blockTargetBytes;
if (!Number.isSafeInteger(blockTargetBytes) || blockTargetBytes <= 0) { throw new Error('Missing production block size'); }
database._bulkImportTransactionOpen = true;
database._deferTermsVirtualTableSync = true;
database._termContentZstdInitialized = false;
database._termRecordStore = {
    appendBatchFromArtifactChunkResolvedContent: async () => ({buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0}),
};
let cursor = 0;
const storedBlocks = [];
const blockManifest = [];
const groupManifest = [];
let groupIndex = -1;
let rowCount = 0;
let pendingRows = 0;
let persistedHits = 0;

database._readTermEntryContentBytesDetailed = async (offset, length) => {
    let low = 0;
    let high = storedBlocks.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (storedBlocks[mid].start <= offset) { low = mid + 1; } else { high = mid; }
    }
    const block = storedBlocks[low - 1];
    if (!block || offset + length > block.start + block.bytes.length) {
        throw new Error('Exact dedup replay requested missing content');
    }
    return {status: 'ok', bytes: block.bytes.subarray(offset - block.start, offset - block.start + length)};
};
database._persistArtifactTermContent = async (_dictionary, pendingContentBytes, pendingContentDictNames, uniformContentDictName, spans) => {
    if (pendingContentDictNames !== null || spans === null) { throw new Error('Expected uniform canonical spans'); }
    const {buffer, offsets, lengths} = spans;
    const pendingOffsets = new Float64Array(lengths.length);
    const pendingLengths = new Uint32Array(lengths);
    const groupBlocks = [];
    let start = 0;
    while (start < lengths.length) {
        let end = start;
        let total = 0;
        while (end < lengths.length) {
            const next = lengths[end];
            if (total > 0 && total + next > blockTargetBytes && next > 0) { break; }
            total += next;
            ++end;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (let index = start; index < end; ++index) {
            bytes.set(buffer.subarray(offsets[index], offsets[index] + lengths[index]), offset);
            pendingOffsets[index] = cursor + offset;
            offset += lengths[index];
        }
        const filename = `group-${String(groupIndex + 1).padStart(3, '0')}-block-${String(groupBlocks.length + 1).padStart(3, '0')}.bin`;
        await writeFile(path.join(output, filename), bytes);
        const manifest = {filename, group: groupIndex, spans: end - start, bytes: total, sha256: hash(bytes)};
        blockManifest.push(manifest);
        groupBlocks.push(manifest);
        storedBlocks.push({start: cursor, bytes});
        cursor += total;
        start = end;
    }
    pendingRows += lengths.length;
    return {pendingOffsets, pendingLengths, pendingResolvedDictNames: uniformContentDictName, blockProfile: null};
};
await mkdir(output, {recursive: true});
const wasm = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'));
parser.setTermBankWasmModule(await WebAssembly.compile(wasm));
for (groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
    if (values['max-groups'] && groupIndex >= Number(values['max-groups'])) { break; }
    const group = groups[groupIndex];
    const sources = [];
    for (const entry of group) {
        sources.push(await entry.getData(new zip.Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}));
    }
    await parser.parseTermBankWithWasmColumnChunks(sources, 3, async (chunk) => {
        const owned = parser.copyWasmBackedColumnChunk(chunk, false, media, true);
        owned.dictionary = fixture.expectedTitle;
        owned.dictionaryTotalRows = fixture.termRows;
        owned.contentDictNameList = null;
        owned.uniformContentDictName = 'raw-v6';
        await database._bulkAddArtifactTermsChunkWithContentDedup(owned);
        rowCount += owned.rowCount;
        const metrics = database._lastBulkAddTermsMetrics;
        persistedHits += metrics.dedupPersistedHitCount;
        groupManifest.push({group: groupIndex, files: group.map((entry) => entry.filename), rows: owned.rowCount, metrics});
    }, 2048, {
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: media,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
    });
    globalThis.gc?.();
    console.log(`${values.dictionary} group ${groupIndex + 1}/${groups.length}: ${rowCount} rows, ${pendingRows} unique rows, ${cursor} packed bytes, rss=${process.memoryUsage().rss}`);
}
await reader.close();
if (!values['max-groups'] && rowCount !== fixture.termRows) { throw new Error('Row count mismatch'); }
const report = {
    scope: 'Sequential content replay using production parser and database canonical dedup; production three-worker grouping and database-configured whole-content block packing. Storage and records mocked. No browser latency or memory claim.',
    dictionary: values.dictionary,
    fixture,
    sourceRoot: root,
    wasmSha256: hash(wasm),
    sourceHashes: Object.fromEntries(await Promise.all([
        'ext/js/dictionary/term-bank-wasm-parser.js',
        'ext/js/dictionary/dictionary-database.js',
        'ext/js/dictionary/term-content-block-store.js',
        'ext/js/dictionary/term-content-canonical-scan.js',
    ].map(async (file) => [file, hash(await readFile(path.join(root, file)))]))),
    rows: rowCount,
    uniqueRows: pendingRows,
    persistedHits,
    packedBytes: cursor,
    blockTargetBytes,
    partial: rowCount !== fixture.termRows,
    blocks: blockManifest,
    groups: groupManifest,
};
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({dictionary: values.dictionary, rows: rowCount, uniqueRows: pendingRows, persistedHits, packedBytes: cursor, blocks: blockManifest.length}));
