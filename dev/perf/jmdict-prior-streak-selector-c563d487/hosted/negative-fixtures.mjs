#!/usr/bin/env node
/* All input generation, compression, model assertions, and hashes are untimed. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import path from 'node:path';
import {rowSpec, rowsPerBank, rowsPerCase, caseNames, fixtureGeometry, validateGeometry} from './fixture-model.mjs';
import {modelCase} from './state-model.mjs';

assert(process.argv[2], 'Expected a NEW fixture output directory; this command is never timed');
assert.equal(process.version, 'v22.22.0');
const output = path.resolve(process.argv[2]);
await mkdir(output, {recursive: false});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedBytes = await readFile(new URL('./expected-counts.json', import.meta.url));
const expected = JSON.parse(expectedBytes);
const legacyBytes = await readFile(new URL('./legacy-fixture-manifest.json', import.meta.url));
const legacy = JSON.parse(legacyBytes);
assert.equal(sha(legacyBytes), 'c41ac6611de35dc5ccf74f6705ac59dc3fabb4a5a14450ffb2996740c7679af1');
assert.equal(process.versions.zlib, legacy.zlib);
const sourceNames = ['negative-fixtures.mjs', 'fixture-model.mjs', 'state-model.mjs', 'expected-counts.json',
    'legacy-fixture-manifest.json', 'diagnostic-fields.json'];
const sourceHashes = {};
for (const name of sourceNames) { sourceHashes[name] = sha(await readFile(new URL(name, import.meta.url))); }
const receipt = {schema: 1, scope: 'Excluded synthetic fixture generation and independent finite-state model; no native module or timings',
    node: process.version, zlib: process.versions.zlib, sourceHashes, completedCases: [], complete: false};
const manifest = {schema: 2, generatorSha256: sourceHashes['negative-fixtures.mjs'], sourceHashes,
    node: process.version, zlib: process.versions.zlib, compression: {method: 8, level: 6},
    rowsPerCase, rowsPerBank, banksPerCase: 2,
    grouping: 'Both banks in one fused group; recent records, streak and budget continue across the bank boundary',
    geometry: fixtureGeometry, flags: {}, cases: []};
const modelReport = {schema: 1, scope: receipt.scope, sourceHashes, cases: [], complete: false};
try {
    validateGeometry();
    assert.deepEqual(expected.cases.map(({id}) => id), [1, 2, 3, 4, 5, 6]);
    for (let caseId = 1; caseId <= 6; ++caseId) {
        const modeled = modelCase(caseId);
        modelReport.cases.push(modeled);
        const target = expected.cases.find(({id}) => id === caseId);
        const directory = `case-${caseId}`;
        await mkdir(path.join(output, directory));
        const entry = {id: caseId, name: caseNames[caseId - 1], rows: rowsPerCase, banks: [],
            expectedUniqueCount: target.expectedUniqueCount, expectedMechanics: target.expectedMechanics,
            expectedPublic: target.expectedPublic, expectedShadow: target.expectedShadow,
            legacyBankIdentityRequired: caseId <= 3};
        for (let bank = 0; bank < 2; ++bank) {
            const rows = Array.from({length: rowsPerBank}, (_, i) => rowSpec(caseId, bank * rowsPerBank + i).text);
            const bytes = Buffer.from('[' + rows.join(',') + ']', 'utf8');
            assert.equal(bytes.length, modeled.bankBytes[bank]);
            const compressed = deflateRawSync(bytes, {level: 6});
            const rawFile = `${directory}/term_bank_${bank + 1}.json`;
            const compressedFile = `${directory}/term_bank_${bank + 1}.deflate`;
            const identity = {rawFile, compressedFile, rows: rowsPerBank, firstGlobalRow: bank * rowsPerBank,
                rawSha256: sha(bytes), compressedSha256: sha(compressed), uncompressedSize: bytes.length,
                compressedSize: compressed.length, compressionMethod: 8, signature: crc32(bytes)};
            if (caseId <= 3) {
                assert.deepEqual(identity, legacy.cases[caseId - 1].banks[bank], `Every raw/compressed/CRC identity of legacy case${caseId}/bank${bank + 1} must remain exact`);
            }
            await writeFile(path.join(output, rawFile), bytes, {flag: 'wx'});
            await writeFile(path.join(output, compressedFile), compressed, {flag: 'wx'});
            entry.banks.push(identity);
        }
        manifest.cases.push(entry);
        receipt.completedCases.push({caseId, bankIdentities: entry.banks, counts: modeled.counts, uniqueCount: modeled.uniqueCount});
        console.log('PRIOR_STREAK_NEGATIVE_FIXTURE_CASE ' + JSON.stringify(receipt.completedCases.at(-1)));
    }
    modelReport.complete = true;
    const modelBytes = Buffer.from(JSON.stringify(modelReport, null, 2) + '\n');
    manifest.modelReceiptSha256 = sha(modelBytes);
    await writeFile(path.join(output, 'state-model-result.json'), modelBytes, {flag: 'wx'});
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    receipt.fixtureManifestSha256 = sha(manifestBytes);
    await writeFile(path.join(output, 'manifest.json'), manifestBytes, {flag: 'wx'});
    for (const name of sourceNames) {
        await writeFile(path.join(output, `source-${name}`), await readFile(new URL(name, import.meta.url)), {flag: 'wx'});
    }
    receipt.complete = true;
    console.log('PRIOR_STREAK_NEGATIVE_FIXTURES ' + JSON.stringify({complete: true, fixtureManifestSha256: receipt.fixtureManifestSha256,
        sourceHashes, cases: manifest.cases.map(({id, name, banks, expectedUniqueCount, expectedPublic}) => ({id, name, banks, expectedUniqueCount, expectedPublic}))}));
} catch (error) {
    receipt.error = {message: String(error), stack: error.stack};
    throw error;
} finally {
    await writeFile(path.join(output, 'preparation-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
}
