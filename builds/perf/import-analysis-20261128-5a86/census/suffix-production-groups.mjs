import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js';

const root = process.cwd();
const outputRoot = process.argv[2];
if (!outputRoot) { throw new Error('Output directory required'); }
await mkdir(outputRoot, {recursive: false});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const locksBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'));
const locks = JSON.parse(locksBytes).dictionaries;
const runnerBytes = await readFile(fileURLToPath(import.meta.url));
const isSpace = (byte) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
function skipSpace(bytes, offset) {
    while (isSpace(bytes[offset])) { ++offset; }
    return offset;
}
function stringEnd(bytes, start) {
    let offset = start + 1;
    while (offset < bytes.length) {
        const quote = bytes.indexOf(34, offset);
        if (quote < 0) { throw new Error('Unterminated string'); }
        let precedingEscapes = 0;
        for (let i = quote - 1; i > start && bytes[i] === 92; --i) { ++precedingEscapes; }
        if ((precedingEscapes & 1) === 0) { return quote + 1; }
        offset = quote + 1;
    }
    throw new Error('Unterminated string');
}
function valueEnd(bytes, start) {
    const first = bytes[start];
    if (first === 34) { return stringEnd(bytes, start); }
    if (first === 91 || first === 123) {
        let depth = 1;
        for (let offset = start + 1; offset < bytes.length; ++offset) {
            const byte = bytes[offset];
            if (byte === 34) { offset = stringEnd(bytes, offset) - 1; }
            else if (byte === 91 || byte === 123) { ++depth; }
            else if ((byte === 93 || byte === 125) && --depth === 0) { return offset + 1; }
        }
        throw new Error('Unterminated composite');
    }
    let offset = start;
    while (offset < bytes.length && bytes[offset] !== 44 && bytes[offset] !== 93 && !isSpace(bytes[offset])) { ++offset; }
    if (offset === start) { throw new Error('Empty scalar'); }
    return offset;
}
function* scanBank(bytes) {
    const semanticRows = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(semanticRows)) { throw new Error('Invalid bank root'); }
    let rowIndex = 0;
    let offset = skipSpace(bytes, 0);
    if (bytes[offset++] !== 91) { throw new Error('Missing bank array'); }
    while (true) {
        offset = skipSpace(bytes, offset);
        if (bytes[offset] === 93) { ++offset; break; }
        if (bytes[offset++] !== 91) { throw new Error('Missing row array'); }
        const fields = [];
        const starts = [];
        const ends = [];
        for (let field = 0; field < 8; ++field) {
            offset = skipSpace(bytes, offset);
            const start = offset;
            offset = valueEnd(bytes, offset);
            fields.push(bytes.subarray(start, offset));
            starts.push(start);
            ends.push(offset);
            offset = skipSpace(bytes, offset);
            if (field < 7 && bytes[offset++] !== 44) { throw new Error('Missing row comma'); }
        }
        if (bytes[offset++] !== 93) { throw new Error('Missing row end'); }
        const semantic = semanticRows[rowIndex++];
        if (!Array.isArray(semantic) || semantic.length !== 8) { throw new Error('Unexpected semantic row length'); }
        yield {fields, semantic, suffixes: Object.fromEntries([2, 5, 6, 7].map((field) => [field, bytes.subarray(ends[field - 1], offset)])),
            probeWindow: bytes.subarray(ends[4]), rowIndex, bytes, starts, ends, rowEnd: offset};
        offset = skipSpace(bytes, offset);
        if (bytes[offset] === 44) { ++offset; }
        else if (bytes[offset] !== 93) { throw new Error('Invalid bank row separator'); }
    }
    if (skipSpace(bytes, offset) !== bytes.length || rowIndex !== semanticRows.length) { throw new Error('Incomplete bank traversal'); }
}
const selfTestRows = [...scanBank(Buffer.from(JSON.stringify([
    ['a', '', '', '', 1, ['same', {type: 'text', text: 'quote " and slash \\'}], 10, ''],
    ['b', '', '', '', 2, ['same', {type: 'text', text: 'quote " and slash \\'}], 10, ''],
])))];
if (selfTestRows.length !== 2 || selfTestRows[0].suffixes[2].equals(selfTestRows[1].suffixes[2]) ||
    !selfTestRows[0].suffixes[5].equals(selfTestRows[1].suffixes[5]) ||
    !selfTestRows[0].suffixes[6].equals(selfTestRows[1].suffixes[6]) ||
    !selfTestRows[0].suffixes[7].equals(selfTestRows[1].suffixes[7])) { throw new Error('Raw suffix scanner self-test failed'); }

// Diagnostic model of the exact frozen production parser. No native parser or
// worker instrumentation is added, and the report makes no timing claim.
const baselineCommit = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
const candidateCommit = '38031a752b26c9b630e5f2f1d45e780786656c74';
const sourcePath = 'ext/js/dictionary/wasm/term-bank-parser.c';
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], {cwd: root});
const candidateSource = execFileSync('git', ['show', `${candidateCommit}:${sourcePath}`], {cwd: root});
assert.equal(sha256(baselineSource), '5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a');
assert.equal(sha256(candidateSource), '5fb1656504b65502f396d23d1222342f9c9b6485f90b949207758cb8058fa3ca');
assert.equal(sha256(locksBytes), '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89');
assert.equal(process.version, 'v22.22.0');
const upstreamCensus = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'suffix-window4.mjs'));
const corpusReplay = await readFile('/tmp/manabitan-session-5a86/corpus-proof-5a86/replay.mjs');
assert.equal(sha256(corpusReplay), 'fd7a947fcd095a66691713bc9d4e9b83f2da889ff2fb8473925c34bfd5f81190');

// Same byte balancing as partitionSourceBanks and the frozen correctness replay.
function partition(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const groupCount = Math.min(entries.length, Math.max(3 * 4, Math.ceil(total / (24 * 1024 * 1024))));
    const groups = [];
    let start = 0;
    let consumed = 0;
    for (let index = 0; index < groupCount - 1; ++index) {
        const remaining = groupCount - index;
        const target = (total - consumed) / remaining;
        let end = start + 1;
        let bytes = entries[start].uncompressedSize;
        const maxEnd = entries.length - (remaining - 1);
        while (end < maxEnd) {
            const nextBytes = bytes + entries[end].uncompressedSize;
            if (Math.abs(nextBytes - target) > Math.abs(bytes - target)) { break; }
            bytes = nextBytes;
            ++end;
        }
        groups.push(entries.slice(start, end));
        start = end;
        consumed += bytes;
    }
    groups.push(entries.slice(start));
    return groups;
}

function probeCounts() {
    return {candidates: 0, boundsRejects: 0, firstByteRejects: 0,
        glossaryTailRejects: 0, glossaryMiddleRejects: 0, suffixTailRejects: 0,
        fullEqualityRejects: 0, fullEqualityCalls: 0, sampleBytePairs: 0, fullBytePairs: 0};
}

// Count the compared byte pairs in the C comparator's 32/8/1-byte block order.
// This models logical memory work only, not generated instructions or cycles.
function equalBytes(a, aStart, b, bStart, length, counts, kind) {
    assert(aStart >= 0 && bStart >= 0 && aStart + length <= a.length && bStart + length <= b.length);
    let offset = 0;
    for (const width of [32, 8, 1]) {
        while (length - offset >= width) {
            counts[kind] += width;
            if (a.compare(b, bStart + offset, bStart + offset + width, aStart + offset, aStart + offset + width) !== 0) { return false; }
            offset += width;
        }
    }
    return true;
}

function glossaryProbe(row, prior, lookback, counts) {
    const start = row.starts[5];
    for (let distance = 1; distance <= Math.min(lookback, prior.length); ++distance) {
        const previous = prior.at(-distance);
        const length = previous.fields[5].length;
        const previousStart = previous.starts[5];
        ++counts.candidates;
        if (length === 0 || length > row.bytes.length - start) { ++counts.boundsRejects; continue; }
        if (row.bytes[start] !== previous.bytes[previousStart]) { ++counts.firstByteRejects; continue; }
        const sample = Math.min(length, 8);
        const eq = (relative, width, kind) => equalBytes(row.bytes, start + relative, previous.bytes, previousStart + relative, width, counts, kind);
        if (!eq(length - sample, sample, 'sampleBytePairs')) { ++counts.glossaryTailRejects; continue; }
        if (!eq(Math.floor((length - sample) / 2), sample, 'sampleBytePairs')) { ++counts.glossaryMiddleRejects; continue; }
        ++counts.fullEqualityCalls;
        if (!eq(0, length, 'fullBytePairs')) { ++counts.fullEqualityRejects; continue; }
        assert(row.fields[5].equals(previous.fields[5]), 'Validated glossary prefix must be the complete valid current glossary');
        return distance;
    }
    return 0;
}

function suffixProbe(row, prior, checkedGlossaries, counts) {
    const start = row.starts[5];
    for (let distance = checkedGlossaries + 1; distance <= Math.min(4, prior.length); ++distance) {
        const previous = prior.at(-distance);
        const previousStart = previous.starts[5];
        const glossaryLength = previous.fields[5].length;
        ++counts.candidates;
        if (glossaryLength === 0 || glossaryLength > row.bytes.length - start) { ++counts.boundsRejects; continue; }
        const sample = Math.min(glossaryLength, 8);
        const eq = (relative, width, kind) => equalBytes(row.bytes, start + relative, previous.bytes, previousStart + relative, width, counts, kind);
        if (!eq(glossaryLength - sample, sample, 'sampleBytePairs')) { ++counts.glossaryTailRejects; continue; }
        if (!eq(Math.floor((glossaryLength - sample) / 2), sample, 'sampleBytePairs')) { ++counts.glossaryMiddleRejects; continue; }
        const previousClose = skipSpace(previous.bytes, previous.ends[7]);
        assert.equal(previous.bytes[previousClose], 93);
        assert.equal(previousClose + 1, previous.rowEnd);
        const length = previousClose + 1 - previousStart;
        if (length > row.bytes.length - start) { ++counts.boundsRejects; continue; }
        const tailSample = Math.min(length, 8);
        if (!eq(length - tailSample, tailSample, 'sampleBytePairs')) { ++counts.suffixTailRejects; continue; }
        ++counts.fullEqualityCalls;
        if (!eq(0, length, 'fullBytePairs')) { ++counts.fullEqualityRejects; continue; }
        assert.equal(start + length, row.rowEnd, 'Full suffix proof must end at the complete current row');
        assert(row.fields[5].equals(previous.fields[5]));
        assert(row.bytes.subarray(start, row.rowEnd).equals(previous.bytes.subarray(previousStart, previous.rowEnd)));
        return distance;
    }
    return 0;
}

function contentMatch(row, prior) {
    for (let distance = 1; distance <= Math.min(4, prior.length); ++distance) {
        const previous = prior.at(-distance);
        if ([5, 3, 2, 7].every((field) => row.fields[field].equals(previous.fields[field]))) { return distance; }
    }
    return 0;
}

function lookbackFor(state, prior) {
    return state.budget > 0 ? 4 : (prior.length > 0 && prior.at(-1).fields[5].length >= 512 ? 1 : 0);
}

function updateState(state, witness, checkedGlossaries, rawContentMatch, rowCount) {
    if (rowCount > 0) {
        if (witness > 0 && witness <= checkedGlossaries) { state.budget = 4; }
        else if (state.budget > 0) { --state.budget; }
    }
    if (rawContentMatch > 0) {
        if (state.streak >= 4 || ++state.streak >= 4) { state.budget = 4; }
    } else { state.streak = 0; }
}

// Probe sequencing regressions use valid raw JSON: short equal suffixes,
// unequal sequence, already checked glossary, whitespace and escaped strings.
const sampleRows = [...scanBank(Buffer.from('[ ["a","","","",1, ["x\\\"y"], 11, "" ], ["b","","","",2,["x\\\"y"], 12, "" ], ["c","","","",3, ["x\\\"y"], 11, "" ] ]'))];
assert.equal(suffixProbe(sampleRows[1], [sampleRows[0]], 0, probeCounts()), 0);
assert.equal(suffixProbe(sampleRows[2], sampleRows.slice(0, 2), 0, probeCounts()), 2);
assert.equal(suffixProbe(sampleRows[2], sampleRows.slice(0, 2), 2, probeCounts()), 0);
assert.equal(glossaryProbe(sampleRows[2], sampleRows.slice(0, 2), 1, probeCounts()), 1);

const spec = locks.jmdict;
const archive = await readFile(path.join(root, 'builds/e2e-dictionary-cache', spec.cacheFile));
assert.equal(sha256(archive), spec.sha256);
assert.equal(archive.length, spec.sizeBytes);
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
const report = {schema: 1, complete: false, dictionary: 'jmdict', node: process.version,
    source: {baselineCommit, candidateCommit, baselineSourceSha256: sha256(baselineSource), candidateSourceSha256: sha256(candidateSource)},
    provenance: {archiveSha256: spec.sha256, fixtureLockSha256: sha256(locksBytes), runnerSha256: sha256(runnerBytes),
        upstreamCensusSha256: sha256(upstreamCensus), corpusReplaySha256: sha256(corpusReplay)},
    policy: {parserWorkers: 3, groupsPerWorker: 4, targetBytes: 24 * 1024 * 1024, window: 4, previousGlossaryMinBytes: 512,
        admissionMatches: 4, probeBudget: 4, resetAtGroupBoundary: true, retainAcrossBankBoundary: true},
    scope: 'Exact raw-token opportunity model for frozen strict format-3 baseline and suffix candidate on the fixed full JMdict corpus. Prior row history, budget and streak reset per production group. Baseline glossary probes run first; suffix probes use only older unchecked distances and the exact final candidate prefilters. Valid JSON and ZIP CRC are independently checked. Counts describe validation avoided and byte comparison work; they are not native instrumented counts, timings, instructions, process-memory or speed estimates.',
    groups: [], totals: {banks: 0, rows: 0, sourceBytes: 0, glossaryBytes: 0, baselineReuseRows: 0, baselineSkippedGlossaryBytes: 0,
        suffixReuseRows: 0, suffixSkippedGlossaryBytes: 0, suffixSkippedGrammarTailBytes: 0, candidateReuseRows: 0,
        candidateSkippedGlossaryBytes: 0, rawContentMatches: 0, crossBankBaselineReuseRows: 0, crossBankSuffixReuseRows: 0},
};
const output = path.join(outputRoot, 'jmdict-suffix-production-groups.json');
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
await save();
try {
    const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
    assert.equal(entries.length, 53);
    const groups = partition(entries);
    assert.equal(groups.length, 12);
    for (const [groupIndex, group] of groups.entries()) {
        const prior = [];
        const baselineState = {budget: 0, streak: 0};
        const candidateState = {budget: 0, streak: 0};
        const counts = {groupIndex, firstBank: group[0].filename, lastBank: group.at(-1).filename,
            banks: 0, rows: 0, sourceBytes: 0, glossaryBytes: 0, baselineReuseRows: 0, baselineSkippedGlossaryBytes: 0,
            suffixReuseRows: 0, suffixSkippedGlossaryBytes: 0, suffixSkippedGrammarTailBytes: 0, candidateReuseRows: 0,
            candidateSkippedGlossaryBytes: 0, rawContentMatches: 0, crossBankBaselineReuseRows: 0, crossBankSuffixReuseRows: 0,
            baselineReuseDistances: [0, 0, 0, 0], suffixReuseDistances: [0, 0, 0, 0],
            admittedLookbackRows: [0, 0, 0, 0, 0], baselineProbes: probeCounts(), suffixProbes: probeCounts(), bankInputs: []};
        const sourceDigest = createHash('sha256');
        report.groups.push(counts);
        for (const entry of group) {
            const inflated = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true});
            const bytes = Buffer.from(inflated.buffer, inflated.byteOffset, inflated.byteLength);
            assert.equal(bytes.length, entry.uncompressedSize);
            sourceDigest.update(bytes);
            const bank = {filename: entry.filename, rows: 0, sourceBytes: bytes.length, crc32: entry.signature >>> 0, sha256: sha256(bytes)};
            counts.bankInputs.push(bank);
            for (const row of scanBank(bytes)) {
                row.bank = entry.filename;
                const lookback = lookbackFor(baselineState, prior);
                assert.equal(lookback, lookbackFor(candidateState, prior));
                ++counts.admittedLookbackRows[lookback];
                const baselineWitness = glossaryProbe(row, prior, lookback, counts.baselineProbes);
                const suffixWitness = baselineWitness === 0 ? suffixProbe(row, prior, lookback, counts.suffixProbes) : 0;
                const candidateWitness = baselineWitness || suffixWitness;
                const rawMatch = contentMatch(row, prior);
                const glossaryBytes = row.fields[5].length;
                counts.glossaryBytes += glossaryBytes;
                if (baselineWitness > 0) {
                    ++counts.baselineReuseRows;
                    counts.baselineSkippedGlossaryBytes += glossaryBytes;
                    ++counts.baselineReuseDistances[baselineWitness - 1];
                    if (prior.at(-baselineWitness).bank !== row.bank) { ++counts.crossBankBaselineReuseRows; }
                }
                if (suffixWitness > 0) {
                    ++counts.suffixReuseRows;
                    counts.suffixSkippedGlossaryBytes += glossaryBytes;
                    counts.suffixSkippedGrammarTailBytes += row.rowEnd - row.starts[5] - glossaryBytes;
                    ++counts.suffixReuseDistances[suffixWitness - 1];
                    if (prior.at(-suffixWitness).bank !== row.bank) { ++counts.crossBankSuffixReuseRows; }
                }
                if (candidateWitness > 0) { ++counts.candidateReuseRows; counts.candidateSkippedGlossaryBytes += glossaryBytes; }
                if (rawMatch > 0) { ++counts.rawContentMatches; }
                updateState(baselineState, baselineWitness, lookback, rawMatch, counts.rows);
                updateState(candidateState, candidateWitness, lookback, rawMatch, counts.rows);
                assert.deepEqual(candidateState, baselineState, 'Candidate must retain exact baseline admission state');
                ++counts.rows;
                ++bank.rows;
                prior.push(row);
                if (prior.length > 4) { prior.shift(); }
            }
            ++counts.banks;
            counts.sourceBytes += bytes.length;
            await save();
        }
        counts.concatenatedSourceSha256 = sourceDigest.digest('hex');
        for (const key of Object.keys(report.totals)) { report.totals[key] += counts[key]; }
        await save();
        console.log(JSON.stringify({...counts, bankInputs: undefined}));
    }
    assert.equal(report.totals.rows, spec.termRows);
    assert.equal(report.totals.banks, 53);
    assert.equal(report.totals.sourceBytes, 171617523);
    assert.equal(report.totals.baselineReuseRows, 54641, 'Must reproduce the existing exact-default browser profile');
    assert.equal(report.totals.rawContentMatches, 154416, 'Must reproduce existing recent-content dedup hits');
    report.complete = true;
    await save();
    console.log('TOTALS ' + JSON.stringify(report.totals));
} finally { await reader.close(); }

