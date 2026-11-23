#!/usr/bin/env node
/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, openAsBlob} from 'node:fs';
import {mkdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {DictionaryImporter} from '../../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../../ext/js/dictionary/dictionary-importer-media-loader.js';
import {parsePositiveInteger} from './benchmark-support.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'baseline-root': {type: 'string'},
    'pairs': {type: 'string', default: '12'},
    'out': {type: 'string', default: 'builds/perf/archive-classification.json'},
}});
assert(values['baseline-root'], '--baseline-root must name a prepared source checkout');
assert(positionals.length > 0, 'Provide at least one dictionary ZIP path');
assert(typeof globalThis.gc === 'function', 'Run Node with --expose-gc');
const collectGarbage = globalThis.gc;
const pairs = parsePositiveInteger(values.pairs, 'pairs');
const baselineRoot = path.resolve(values['baseline-root']);
const importerPath = 'ext/js/dictionary/dictionary-importer.js';
const baselinePath = path.join(baselineRoot, importerPath);
const baselineModule = /** @type {typeof import('../../ext/js/dictionary/dictionary-importer.js')} */ (
    await import(pathToFileURL(baselinePath).href)
);
const baseline = new baselineModule.DictionaryImporter(new DictionaryImporterMediaLoader());
const candidate = new DictionaryImporter(new DictionaryImporterMediaLoader());
const readArchive = /** @type {DictionaryImporter['_getFilesFromArchive']} */ (Reflect.get(baseline, '_getFilesFromArchive')).bind(baseline);
const classifyBaseline = /** @type {DictionaryImporter['_getArchiveFiles']} */ (Reflect.get(baseline, '_getArchiveFiles')).bind(baseline);
const classifyCandidate = /** @type {DictionaryImporter['_getArchiveFiles']} */ (Reflect.get(candidate, '_getArchiveFiles')).bind(candidate);
const threadCpuUsage = /** @type {(previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage} */ (Reflect.get(process, 'threadCpuUsage'));
assert(typeof threadCpuUsage === 'function', 'Use a Node version supporting threadCpuUsage');
/** @type {import('dictionary-importer').QueryDetails} */
const baselineQueries = [
    ['termFiles', /^term_bank_(\d+)\.json$/],
    ['termArtifactFiles', /^term_bank_(\d+)\.mbtb$/],
    ['termMetaFiles', /^term_meta_bank_(\d+)\.json$/],
    ['kanjiFiles', /^kanji_bank_(\d+)\.json$/],
    ['kanjiMetaFiles', /^kanji_meta_bank_(\d+)\.json$/],
    ['tagFiles', /^tag_bank_(\d+)\.json$/],
];

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) { hash.update(/** @type {Buffer} */ (bytes)); }
    return hash.digest('hex');
}

/**
 * @param {() => import('dictionary-importer').QueryResult} classify
 * @param {import('dictionary-importer').QueryResult} expected
 * @param {number} iterations
 * @returns {{wallMs: number, cpuMs: number}}
 */
function measure(classify, expected, iterations) {
    collectGarbage();
    let result = expected;
    const cpuStart = threadCpuUsage();
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; ++i) { result = classify(); }
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
    const cpu = threadCpuUsage(cpuStart);
    assert.deepEqual(result, expected, 'Classified bank entries or order differ');
    return {wallMs, cpuMs: (cpu.user + cpu.system) / 1000 / iterations};
}

const source = {
    baselineRoot,
    candidateRoot: root,
    baselineImporterSha256: await hashFile(baselinePath),
    candidateImporterSha256: await hashFile(path.join(root, importerPath)),
};
/** @type {Array<object>} */
const dictionaries = [];
const report = {
    schemaVersion: 1,
    scope: 'Resident ZIP metadata to classified and sorted bank lists; excludes ZIP I/O, term parsing, storage and UI',
    node: process.version,
    runnerSha256: await hashFile(fileURLToPath(import.meta.url)),
    source,
    archives: positionals.map((file) => path.resolve(file)),
    pairs,
    warmups: 3,
    order: 'Alternating AB/BA',
    status: 'running',
    error: '',
    dictionaries,
};
const output = path.resolve(values.out);
await mkdir(path.dirname(output), {recursive: true});
const save = async () => { await writeFile(output, JSON.stringify(report, null, 4) + '\n'); };
await save();
try {
    for (const archivePath of positionals) {
        const archive = path.resolve(archivePath);
        const fixture = {file: path.basename(archive), sizeBytes: (await stat(archive)).size, sha256: await hashFile(archive)};
        const {fileMap, zipReader, catalog} = await readArchive(await openAsBlob(archive));
        try {
            const methods = {
                baseline: () => classifyBaseline(fileMap, baselineQueries),
                candidate: () => classifyCandidate(fileMap),
            };
            const expected = methods.baseline();
            assert.deepEqual(methods.candidate(), expected);
            // Fix work amounts from metadata size before observing any timing.
            const iterations = fileMap.size >= 1024 ? 2 : 100;
            /** @type {Array<object>} */
            const observations = [];
            const entry = {
                fixture,
                catalog,
                entries: fileMap.size,
                iterations,
                banks: Object.fromEntries([...expected].map(([key, files]) => [key, files.length])),
                observations,
            };
            dictionaries.push(entry);
            for (const classify of Object.values(methods)) {
                for (let i = 0; i < report.warmups; ++i) { assert.deepEqual(classify(), expected); }
            }
            for (let pair = 0; pair < pairs; ++pair) {
                const order = pair % 2 === 0 ? /** @type {const} */ (['baseline', 'candidate']) : /** @type {const} */ (['candidate', 'baseline']);
                const first = measure(methods[order[0]], expected, iterations);
                const second = measure(methods[order[1]], expected, iterations);
                observations.push({pair, order, [order[0]]: first, [order[1]]: second});
                await save();
            }
        } finally {
            await zipReader.close();
        }
    }
    assert.equal(await hashFile(baselinePath), source.baselineImporterSha256, 'Baseline changed during the comparison');
    assert.equal(await hashFile(path.join(root, importerPath)), source.candidateImporterSha256, 'Candidate changed during the comparison');
    report.status = 'complete';
} catch (error) {
    report.status = 'failed';
    report.error = String(error);
    throw error;
} finally {
    await save();
}
console.log(output);
