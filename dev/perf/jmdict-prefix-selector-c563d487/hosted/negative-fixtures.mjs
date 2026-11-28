#!/usr/bin/env node
/* Frozen negative fixtures; generation/compression is outside all timing. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import path from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const rowsPerBank = 10000;
const rowsPerCase = 20000;
const names = ['unique-short-keys', 'same-key-short-full-misses', 'alternating-older-long-full-misses'];
function family(length) {
    const mutationStart = length - 24;
    const tailStart = length - 8;
    const middleStart = Math.floor((length - 8) / 2);
    assert(mutationStart >= middleStart + 8 && mutationStart + 6 <= tailStart);
    return {serializedGlossaryBytes: length, mutation: {start: mutationStart, endExclusive: mutationStart + 6},
        tailSample: {start: tailStart, endExclusive: length}, middleSample: {start: middleStart, endExclusive: middleStart + 8},
        shape: 'One-element JSON array containing one ASCII string; byte lengths include all JSON delimiters'};
}
const families = {short: family(240), long: family(4096)};
function glossary(length, index) {
    const marker = String(index).padStart(6, '0');
    assert.equal(marker.length, 6);
    const mutationStart = length - 24;
    const result = '["' + 'x'.repeat(mutationStart - 2) + marker + 'x'.repeat(16) + '"]';
    assert.equal(Buffer.byteLength(result), length);
    assert.equal(result.slice(mutationStart, mutationStart + 6), marker);
    return result;
}
function makeRow(caseId, index) {
    const expression = caseId === 1 ? `k${String(index).padStart(6, '0')}` : 'shared';
    const long = caseId === 3 && index % 2 === 1;
    const tags = caseId === 3 ? (long ? 'bb' : 'aa') : 'aa';
    const gloss = glossary(long ? 4096 : 240, index);
    return `[${JSON.stringify(expression)},"",${JSON.stringify(tags)},"",0,${gloss},1,""]`;
}
function expected(caseId) {
    const common = {rows: 20000, hits: 0, hitBytes: 0, originalGlossaryReuses: 0, totalGlossaryReuses: 0,
        priorStreakRows: 0, recentContentHits: 0, budgetPositiveRows: 0, budgetRefreshByRecentStreak: 0,
        boundsRejected: 0, openerRejected: 0, tailRejected: 0, middleRejected: 0,
        selectedDistance1: 0, selectedDistance2: 0, selectedDistance3: 0, selectedDistance4: 0,
        hitDistance1: 0, hitDistance2: 0, hitDistance3: 0, hitDistance4: 0,
        selectedAtLeast512: 0, selectedAtLeast512Bytes: 0,
        definitionLengthRejected: 0, rulesLengthRejected: 0, definitionSignatureRejected: 0, rulesSignatureRejected: 0};
    if (caseId === 1) {
        return {...common, keyIdentityRows: 19999, admissions: 0, candidateRecordsInspected: 0, noPrefixCandidate: 0,
            selected: 0, selectedBytes: 0, fullRejected: 0, fullBytesOffered: 0, failedFullBytesOffered: 0,
            maxSelectedBytes: 0, maxFailedFullBytes: 0, originalLookbackZeroRows: 19999, originalLookbackPositiveRows: 0};
    }
    if (caseId === 2) {
        return {...common, keyIdentityRows: 19999, admissions: 19999, candidateRecordsInspected: 19999, noPrefixCandidate: 0,
            selected: 19999, selectedDistance1: 19999, selectedBytes: 19999 * 240,
            fullRejected: 19999, fullBytesOffered: 19999 * 240, failedFullBytesOffered: 19999 * 240,
            maxSelectedBytes: 240, maxFailedFullBytes: 240, originalLookbackZeroRows: 19999, originalLookbackPositiveRows: 0};
    }
    return {...common, keyIdentityRows: 10000, admissions: 10000, candidateRecordsInspected: 19999, noPrefixCandidate: 1,
        selected: 9999, selectedDistance2: 9999, selectedBytes: 9999 * 4096,
        selectedAtLeast512: 9999, selectedAtLeast512Bytes: 9999 * 4096,
        fullRejected: 9999, fullBytesOffered: 9999 * 4096, failedFullBytesOffered: 9999 * 4096,
        maxSelectedBytes: 4096, maxFailedFullBytes: 4096, originalLookbackZeroRows: 10000, originalLookbackPositiveRows: 9999,
        definitionSignatureRejected: 10000};
}
function validateGeometry() {
    for (const {serializedGlossaryBytes: length, mutation, tailSample, middleSample} of Object.values(families)) {
        const first = glossary(length, 9999);
        const second = glossary(length, 10001);
        assert.notEqual(first, second);
        assert.equal(first.slice(tailSample.start, tailSample.endExclusive), second.slice(tailSample.start, tailSample.endExclusive));
        assert.equal(first.slice(middleSample.start, middleSample.endExclusive), second.slice(middleSample.start, middleSample.endExclusive));
        assert.equal(first.slice(0, mutation.start), second.slice(0, mutation.start));
        assert.equal(JSON.parse(first)[0].length, length - 4);
    }
    for (let caseId = 1; caseId <= 3; ++caseId) {
        for (const index of [0, 1, 2, 3, 9998, 9999, 10000, 10001, 19998, 19999]) {
            const value = JSON.parse(makeRow(caseId, index));
            assert.equal(value.length, 8);
            assert.equal(value[1], '');
            assert(encoder.encode(JSON.stringify(value[0])).length <= 34);
            assert.equal(JSON.stringify(value[5]).length, caseId === 3 && index % 2 === 1 ? 4096 : 240);
        }
    }
    assert.notEqual(JSON.stringify('aa').slice(0, 4), JSON.stringify('bb').slice(0, 4));
}
validateGeometry();
if (process.argv[2] === '--self-test') {
    console.log(JSON.stringify({selfTest: true, families, expected: Object.fromEntries(names.map((name, i) => [name, expected(i + 1)]))}));
} else {
    assert(process.argv[2], 'Expected a fresh fixture output directory');
    const output = path.resolve(process.argv[2]);
    await mkdir(output, {recursive: false});
    const generatorBytes = await readFile(fileURLToPath(import.meta.url));
    const manifest = {schema: 1, generatorSha256: sha(generatorBytes), node: process.version,
        zlib: process.versions.zlib, compression: {method: 8, level: 6}, rowsPerCase, rowsPerBank,
        banksPerCase: 2, grouping: 'Both banks in one fused group, no reset at the second bank',
        globalMarker: 'Six decimal digits, global row index 0..19999, never reset at bank boundary', families,
        flags: {}, cases: []};
    for (let caseId = 1; caseId <= 3; ++caseId) {
        const directory = `case-${caseId}`;
        await mkdir(path.join(output, directory));
        const entry = {id: caseId, name: names[caseId - 1], rows: rowsPerCase, banks: [],
            expectedMechanics: expected(caseId), expectedPublic: {fusedAttempts: 1, fusedFallbacks: 0, glossaryReuseCount: 0, recentContentDedupHitCount: 0}};
        for (let bank = 0; bank < 2; ++bank) {
            const rowTexts = Array.from({length: rowsPerBank}, (_, i) => makeRow(caseId, bank * rowsPerBank + i));
            const bytes = encoder.encode('[' + rowTexts.join(',') + ']');
            const compressed = deflateRawSync(bytes, {level: 6});
            const rawFile = `${directory}/term_bank_${bank + 1}.json`;
            const compressedFile = `${directory}/term_bank_${bank + 1}.deflate`;
            await writeFile(path.join(output, rawFile), bytes);
            await writeFile(path.join(output, compressedFile), compressed);
            entry.banks.push({rawFile, compressedFile, rows: rowsPerBank, firstGlobalRow: bank * rowsPerBank,
                rawSha256: sha(bytes), compressedSha256: sha(compressed), uncompressedSize: bytes.length,
                compressedSize: compressed.length, compressionMethod: 8, signature: crc32(bytes)});
        }
        manifest.cases.push(entry);
    }
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(path.join(output, 'generator-source.mjs'), generatorBytes);
    console.log('PREFIX_NEGATIVE_FIXTURES ' + JSON.stringify(manifest));
}
