import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js';

const root = process.cwd();
const outputRoot = process.argv[2];
if (!outputRoot) { throw new Error('Output directory required'); }
await mkdir(outputRoot, {recursive: true});
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
        const ends = [];
        for (let field = 0; field < 8; ++field) {
            offset = skipSpace(bytes, offset);
            const start = offset;
            offset = valueEnd(bytes, offset);
            fields.push(bytes.subarray(start, offset));
            ends.push(offset);
            offset = skipSpace(bytes, offset);
            if (field < 7 && bytes[offset++] !== 44) { throw new Error('Missing row comma'); }
        }
        if (bytes[offset++] !== 93) { throw new Error('Missing row end'); }
        const semantic = semanticRows[rowIndex++];
        if (!Array.isArray(semantic) || semantic.length !== 8) { throw new Error('Unexpected semantic row length'); }
        yield {fields, semantic, suffixes: Object.fromEntries([2, 5, 6, 7].map((field) => [field, bytes.subarray(ends[field - 1], offset)])),
            probeWindow: bytes.subarray(ends[4]), rowIndex};
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

for (const dictionary of ['jmdict', 'jitendex']) {
    const spec = locks[dictionary];
    const archive = await readFile(path.join(root, 'builds/e2e-dictionary-cache', spec.cacheFile));
    if (sha256(archive) !== spec.sha256) { throw new Error('Locked archive hash mismatch'); }
    const suffixes = Object.fromEntries([2, 5, 6, 7].map((field) => [field, {
        adjacentPairs: 0, equalPairs: 0, equalBytes: 0, totalBytes: 0, crossBankPairs: 0, crossBankEqualPairs: 0,
    }]));
    const fields = Array.from({length: 8}, (_, field) => ({field, rawEqualPairs: 0, semanticEqualPairs: 0, semanticDifferentPairs: 0}));
    const semanticDifferentMasks = {};
    const counts = {rows: 0, adjacentPairs: 0, afterScoreEqualWithDifferentScore: 0,
        afterScoreProbeBytes: 0, afterScoreBoundsRejects: 0, afterScorePrefixFalsePositives: 0};
    const examples = [];
    const banks = [];
    let previous = null;
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
        for (const entry of entries) {
            if (!entry.getData) { throw new Error('Unreadable ' + entry.filename); }
            const inflated = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true});
            const bytes = Buffer.from(inflated.buffer, inflated.byteOffset, inflated.byteLength);
            const bank = {filename: entry.filename, sourceBytes: bytes.length, sourceSha256: sha256(bytes), rows: 0, suffixEqualPairs: {2: 0, 5: 0, 6: 0, 7: 0}};
            for (const row of scanBank(bytes)) {
                for (const field of [2, 5, 6, 7]) { suffixes[field].totalBytes += row.suffixes[field].length; }
                if (previous !== null) {
                    ++counts.adjacentPairs;
                    const differentFields = [];
                    const rawDifferentFields = [];
                    for (let field = 0; field < 8; ++field) {
                        const rawEqual = previous.fields[field].equals(row.fields[field]);
                        if (rawEqual) { ++fields[field].rawEqualPairs; }
                        else { rawDifferentFields.push(field); }
                        const semanticEqual = rawEqual || isDeepStrictEqual(previous.semantic[field], row.semantic[field]);
                        if (semanticEqual) { ++fields[field].semanticEqualPairs; }
                        else { ++fields[field].semanticDifferentPairs; differentFields.push(field); }
                    }
                    const mask = differentFields.join(',');
                    semanticDifferentMasks[mask] = (semanticDifferentMasks[mask] ?? 0) + 1;
                    for (const field of [2, 5, 6, 7]) {
                        const summary = suffixes[field];
                        ++summary.adjacentPairs;
                        if (bank.rows === 0) { ++summary.crossBankPairs; }
                        if (previous.suffixes[field].equals(row.suffixes[field])) {
                            ++summary.equalPairs;
                            summary.equalBytes += row.suffixes[field].length;
                            ++bank.suffixEqualPairs[field];
                            if (bank.rows === 0) { ++summary.crossBankEqualPairs; }
                        }
                    }
                    const previousSuffix = previous.suffixes[5];
                    if (previousSuffix.length <= row.probeWindow.length) {
                        let compared = 0;
                        while (compared < previousSuffix.length && previousSuffix[compared] === row.probeWindow[compared]) { ++compared; }
                        counts.afterScoreProbeBytes += Math.min(compared + 1, previousSuffix.length);
                        if (compared === previousSuffix.length && previousSuffix.length !== row.suffixes[5].length) { ++counts.afterScorePrefixFalsePositives; }
                    } else { ++counts.afterScoreBoundsRejects; }
                    if (previous.suffixes[5].equals(row.suffixes[5]) && differentFields.includes(4)) {
                        ++counts.afterScoreEqualWithDifferentScore;
                        if (examples.length < 3) {
                            examples.push({bank: entry.filename, row: row.rowIndex,
                                previous: {expression: previous.semantic[0], reading: previous.semantic[1], score: previous.semantic[4], sequence: previous.semantic[6], tags: previous.semantic[7]},
                                current: {expression: row.semantic[0], reading: row.semantic[1], score: row.semantic[4], sequence: row.semantic[6], tags: row.semantic[7]},
                                rawDifferentFields, semanticDifferentFields: differentFields,
                                suffixBytes: row.suffixes[5].length, suffixSha256: sha256(row.suffixes[5])});
                        }
                    }
                }
                previous = {fields: row.fields, semantic: row.semantic, suffixes: row.suffixes};
                ++counts.rows;
                ++bank.rows;
            }
            banks.push(bank);
        }
    } finally { await reader.close(); }
    if (counts.rows !== spec.termRows) { throw new Error('Locked row count mismatch'); }
    for (const summary of Object.values(suffixes)) {
        summary.equalPairFraction = summary.equalPairs / summary.adjacentPairs;
        summary.equalByteFraction = summary.equalBytes / summary.totalBytes;
    }
    const report = {dictionary, node: process.version, archiveSha256: spec.sha256,
        lockSha256: sha256(locksBytes), runnerSha256: sha256(runnerBytes),
        boundary: 'Exact bytes after token f-1 through closing row bracket for suffix f (including raw delimiters and whitespace); fields are 0-based. Includes adjacent source-bank boundaries. JSON.parse is diagnostic oracle only, outside any timing. Semantic comparison uses deep strict equality and is separate from raw-byte proof.',
        counts, suffixes, fields, semanticDifferentMasks, examples, banks};
    await writeFile(path.join(outputRoot, dictionary + '-suffix-census.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('SUFFIX_CENSUS ' + JSON.stringify({...report, banks: banks.length}));
}
if (sha256(await readFile(fileURLToPath(import.meta.url))) !== sha256(runnerBytes)) { throw new Error('Runner changed'); }
