import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '../../../node_modules/@zip.js/zip.js/index.js';
import {setTermBankWasmModule, parseTermBankWithWasmColumnChunks} from '../../../ext/js/dictionary/term-bank-wasm-parser.js';
import {snapshotTermBankExperiments} from '../../../ext/js/dictionary/term-bank-experiments.js';
const root = path.resolve(import.meta.dirname, '../../..');
const dictionary = process.argv[2] ?? 'jmdict';
const output = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, `records-${dictionary}`));
const sha = (x) => createHash('sha256').update(x).digest('hex');
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'));
const spec = JSON.parse(lockBytes).dictionaries[dictionary];
if (!spec) { throw Error('Unknown dictionary'); }
const archive = await readFile(path.join(root, 'builds/e2e-dictionary-cache', spec.cacheFile));
if (sha(archive) !== spec.sha256) { throw Error('Archive hash mismatch'); }
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
const totalBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
// Existing medium-capability planner, 3 parser workers: 4 groups/worker for
// plain JMdict, 3 for media-aware banks. This is capture, not import timing.
const groupCount = Math.min(entries.length, Math.max(dictionary === 'jmdict' ? 12 : 9, Math.ceil(totalBytes / (24 * 1024 * 1024))));
const groups = [];
let sourceStart = 0;
let consumed = 0;
for (let group = 0; group < groupCount - 1; ++group) {
    const target = (totalBytes - consumed) / (groupCount - group);
    let end = sourceStart + 1;
    let bytes = entries[sourceStart].uncompressedSize;
    const maxEnd = entries.length - (groupCount - group - 1);
    while (end < maxEnd) {
        const next = bytes + entries[end].uncompressedSize;
        if (Math.abs(next - target) > Math.abs(bytes - target)) { break; }
        bytes = next;
        ++end;
    }
    groups.push(entries.slice(sourceStart, end));
    sourceStart = end;
    consumed += bytes;
}
groups.push(entries.slice(sourceStart));
const wasmBytes = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'));
setTermBankWasmModule(await WebAssembly.compile(wasmBytes));
const options = {...snapshotTermBankExperiments({}), singleChunk: true, emitTermByteLists: false,
    computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
    mediaHintFastScan: dictionary !== 'jmdict', validateGlossaryTypes: true, prepareLookupIndexes: false};
const records = [];
let rows = 0;
let perGroupUnique = 0;
let logicalBytes = 0;
let perGroupUniqueBytes = 0;
const logicalDigest = createHash('sha256');
await mkdir(output, {recursive: true});
for (let group = 0; group < groups.length; ++group) {
    const banks = [];
    for (const entry of groups[group]) {
        banks.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}));
    }
    let groupRows = 0;
    let groupUnique = 0;
    let groupBytes = 0;
    await parseTermBankWithWasmColumnChunks(banks, 3, async (chunk) => {
        const {contentMetaList: meta, contentBytesBuffer: buffer, contentBytesBaseOffset: base} = chunk;
        if (!meta || !buffer || typeof base !== 'number' || !chunk.contentUniqueIndexList) { throw Error('Missing canonical slab/unique plan'); }
        // Retain only this group's borrowed spans. Exact cross-group dedup is
        // a separate disk-backed phase, avoiding a corpus-sized JS object map.
        const parts = [];
        let packedBytes = 0;
        let nextUnique = 0;
        for (let row = 0; row < chunk.rowCount; ++row) {
            const uniqueIndex = chunk.contentUniqueIndexList[row];
            const mi = (chunk.contentMetaByUniqueIndex ? uniqueIndex : row) * 4;
            const bytes = Buffer.from(buffer.buffer, buffer.byteOffset + base + meta[mi], meta[mi + 1]);
            logicalDigest.update(bytes);
            logicalBytes += bytes.length;
            ++rows;
            ++groupRows;
            if (uniqueIndex < nextUnique) { continue; }
            if (uniqueIndex !== nextUnique) { throw Error('Canonical unique IDs are not contiguous'); }
            ++nextUnique;
            const header = Buffer.allocUnsafe(12);
            header.writeUInt32LE(bytes.length, 0);
            header.writeUInt32LE(meta[mi + 2], 4);
            header.writeUInt32LE(meta[mi + 3], 8);
            parts.push(header, bytes);
            packedBytes += 12 + bytes.length;
            ++groupUnique;
            ++perGroupUnique;
            groupBytes += bytes.length;
            perGroupUniqueBytes += bytes.length;
        }
        const data = Buffer.concat(parts, packedBytes);
        const name = `records-${String(records.length).padStart(3, '0')}.gz`;
        await writeFile(path.join(output, name), gzipSync(data, {level: 1}));
        records.push({name, group, bytes: data.length, uniqueEntries: groupUnique, canonicalBytes: groupBytes, sha256: sha(data)});
    }, 2048, options);
    process.stderr.write(`${dictionary} ${group + 1}/${groups.length} rows=${rows} groupUnique=${groupUnique} bytes=${groupBytes}\n`);
    if (global.gc) { global.gc(); }
}
await reader.close();
if (rows !== spec.termRows) { throw Error(`Row count ${rows} differs from ${spec.termRows}`); }
const report = {boundary: 'Frozen-parser per-group canonical unique records, before disk-backed exact cross-group dedup. Existing medium-capability grouping; no import timing or browser storage claim.',
    dictionary, archiveSha256: spec.sha256, lockSha256: sha(lockBytes), wasmSha256: sha(wasmBytes),
    captureSha256: sha(await readFile(import.meta.filename)), rows, perGroupUnique, logicalBytes,
    perGroupUniqueBytes, logicalDigest: logicalDigest.digest('hex'), sourceBytes: totalBytes,
    sourceGroups: groups.map((group) => group.map((entry) => entry.filename)), records,
    node: process.version, maxRssKiB: process.resourceUsage().maxRSS};
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({...report, records: records.length, sourceGroups: undefined}, null, 2));
