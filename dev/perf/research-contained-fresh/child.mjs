import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {inflateRawSync, crc32} from 'node:zlib';
import {summarize, grouped, sha} from './helpers.mjs';

const config = JSON.parse(await fs.readFile(new URL('./config.json', import.meta.url)));
const contract = JSON.parse(await fs.readFile(new URL('./contract.json', import.meta.url)));
const builds = JSON.parse(await fs.readFile(config.evidence + '/builds.json'));
const [candidate, dictionary, phase, onlyArm] = process.argv.slice(2);
const mode='fresh';assert(['baseline',candidate].includes(onlyArm));
assert(contract.variants.includes(candidate));
assert(contract.datasets.includes(dictionary));
assert(['inflate', 'parse'].includes(phase));

assert(process.version.startsWith('v22.') && typeof gc === 'function');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: config.source, encoding: 'utf8'}).trim(), config.head);
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: config.source, encoding: 'utf8'}).trim(), '');
const sourceUrl = new URL('file://' + config.source + '/');
const {ZipReader, Uint8ArrayReader} = await import(new URL('node_modules/@zip.js/zip.js/index.js', sourceUrl));
const {RawZipPayloadReader} = await import(new URL('ext/js/dictionary/term-bank-source-pipeline.js', sourceUrl));
const {encodePersistedTermLookupIndexFromPreinternedPlan: encodeIndex} = await import(new URL('ext/js/dictionary/term-lookup-index.js', sourceUrl));
const info = dictionary === 'jmdict' ? {
    file: 'JMdict.zip', sha: '7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a', groups: 20, rows: 526942, media: false,
} : {
    file: 'jitendex-yomitan.zip', sha: '8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc', groups: 22, rows: 435448, media: true,
};
const bytes = new Uint8Array(await fs.readFile(config.fixtureRoot + '/' + info.file));
assert.equal(sha(bytes), info.sha);
const reader = new ZipReader(new Uint8ArrayReader(bytes), {useWebWorkers: false});
const sources = [];
try {
    const entries = (await reader.getEntries()).map((entry) => ({entry, match: /^term_bank_(\d+)\.json$/.exec(entry.filename)})).filter(({match}) => match).sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
    const raw = new RawZipPayloadReader(bytes.buffer);
    for (const {entry} of entries) {
        assert.equal(entry.compressionMethod, 8);
        const compressed = await raw.read(entry, new AbortController().signal);
        const inflated = new Uint8Array(inflateRawSync(compressed));
        assert.equal(inflated.byteLength, entry.uncompressedSize);
        assert.equal(crc32(inflated), entry.signature);
        sources.push({bytes: compressed, decoded: inflated, estimatedBytes: inflated.byteLength, compressionMethod: 8, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, signature: entry.signature, filename: entry.filename});
    }
} finally { await reader.close(); }
const groups = grouped(sources, sources.reduce((n, s) => n + s.estimatedBytes, 0), info.groups);
const groupHashes = groups.map((group) => {
    const hash = crypto.createHash('sha256');
    for (const s of group) hash.update(s.decoded);
    return hash.digest('hex');
});
const parsers = {};
for (const arm of [onlyArm]) {
    const wasm = await fs.readFile(new URL(arm + '.wasm', import.meta.url));
    assert.equal(sha(wasm), builds.find((b) => b.side === arm).sha256);
    const module = await WebAssembly.compile(wasm);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const parser = await import(new URL('ext/js/dictionary/term-bank-wasm-parser.js', sourceUrl));
    parser.setTermBankWasmModule(module);
    await parser.initializeTermBankWasmParser();
    parsers[arm] = parser;
}
const parseOptions = {singleChunk: true, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, prepareLookupIndexes: true, useNativeStringPlan: true, maxPendingChunks: 1, mediaHintFastScan: info.media, validateGlossaryTypes: true};
const generateGolden=process.env.CONTAINED_GENERATE_GOLDEN==='1';
const oracles=generateGolden?{}:{baseline:JSON.parse(await fs.readFile(config.originalEvidence+'/wide-'+dictionary+'-'+phase+'-cohort.json')).oracle};
async function run(arm, passes, verify) {
    const parser = parsers[arm];
    let wallMs = 0, cpuMs = 0, count = 0, maxHeap = 0;
    const summaries = [];
    for (let pass = 0; pass < passes; ++pass) {
        for (let gi = 0; gi < groups.length; ++gi) {
            const group = groups[gi];
            let inflated, captured;
            const cpu = process.cpuUsage(), started = performance.now();
            if (phase === 'inflate') {
                inflated = await parser.inflateCompressedTermBankSourcesWasm(group);
            } else {
                await parser.parseTermBankWithWasmColumnChunks(group.map((s) => s.decoded), 3, (chunk) => {
                    assert.equal(captured, undefined);
                    captured = parser.copyWasmBackedColumnChunk(chunk, true);
                }, 1, parseOptions);
            }
            wallMs += performance.now() - started;
            const used = process.cpuUsage(cpu);
            cpuMs += (used.user + used.system) / 1000;
            if (phase === 'inflate') {
                maxHeap = Math.max(maxHeap, inflated.wasm.memory.buffer.byteLength);
                assert(inflated.jsonLength > 0);
                if (verify && pass === passes - 1) {
                    const actual = sha(new Uint8Array(inflated.wasm.memory.buffer, inflated.jsonPtr, inflated.jsonLength));
                    assert.equal(actual, groupHashes[gi]);
                    summaries.push(actual);
                }
            } else {
                assert(captured);
                const profile = parser.consumeLastTermBankWasmParseProfile();
                assert(profile.fusedParseAttempts > 0);
                assert.equal(profile.fusedParseFallbacks, 0);
                maxHeap = Math.max(maxHeap, profile.maxWasmHeapBytes);
                if (pass === passes - 1) count += captured.rowCount;
                if (verify && pass === passes - 1) {
                    assert.equal(captured.preparedLookupIndexes.size, 1);
                    const [[key, index]] = captured.preparedLookupIndexes;
                    assert.equal(key, `0:${captured.rowCount}`);
                    assert.deepEqual(index.bytes, encodeIndex(captured.termRecordPreinternedPlan, captured.readingEqualsExpressionList, captured.sequenceList, captured.rowCount));
                    summaries.push({...summarize(captured, encodeIndex), finishedNativeLookupSha256: sha(index.bytes)});
                }
            }
        }
    }
    if (phase === 'parse') assert.equal(count, info.rows);
    if (verify) {
        if (oracles.baseline === undefined) { assert.equal(arm, 'baseline'); oracles.baseline = summaries; }
        else assert.deepEqual(summaries, oracles.baseline);
    }
    return {arm, passes, wallMs, cpuMs, maxHeapBytes: maxHeap, allGroupsVerified: verify, rows: phase === 'parse' ? count : null, oracleSha256: verify ? sha(Buffer.from(JSON.stringify(summaries))) : null};
}

if(generateGolden){const checked=await run('baseline',1,true);await fs.writeFile(config.originalEvidence+'/wide-'+dictionary+'-'+phase+'-cohort.json',JSON.stringify({oracle:oracles.baseline,sha256:checked.oracleSha256})+'\n',{flag:'wx'});console.log(JSON.stringify({golden:true,dictionary,phase,sha256:checked.oracleSha256}));}else{
if(phase==='parse')await parsers[onlyArm].inflateCompressedTermBankSourcesWasm(groups[0]);
await run(onlyArm,contract.warmupCorpusPassesPerArm,false);
gc();
const measured=await run(onlyArm,phase==='inflate'?contract.inflaterCorpusPassesPerObservation:contract.parserCorpusPassesPerObservation,false);
const verified=await run(onlyArm,1,true);
console.log(JSON.stringify({...measured,postBatchOracleVerified:true,oracleSha256:verified.oracleSha256,
 head:config.head,phase,dictionary,initialization:'Freshprocess oneJSmodule/oneWASM; decoder primed before parse warmup',loadAfter:os.loadavg()}));

}
