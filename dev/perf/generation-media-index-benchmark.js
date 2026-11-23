#!/usr/bin/env node
/*
 * Copyright (C) 2026  Manabitan authors
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
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readDenseZipDirectory} from '../../ext/js/dictionary/dense-zip-directory.js';
import {getImageMediaTypeFromFileName} from '../../ext/js/media/media-util.js';
import {safePerformance} from '../../ext/js/core/safe-performance.js';
import * as candidate from '../../ext/js/dictionary/dictionary-generation-media-store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modulePath = 'ext/js/dictionary/dictionary-generation-media-store.js';
const schedules = ['ABC', 'CBA', 'BCA', 'ACB', 'CAB', 'BAC', 'BAC', 'CAB', 'ACB', 'BCA', 'CBA', 'ABC'];
const warmups = 4;

/** @typedef {{createMs: number, restrictMs: number, totalMs: number, cpuUserMs: number, cpuSystemMs: number, threadCpuUserMs: number, threadCpuSystemMs: number, threadCpuMs: number}} Measurement */

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const chunk of /** @type {AsyncIterable<Buffer>} */ (createReadStream(file))) { hash.update(chunk); }
    return hash.digest('hex');
}

/**
 * @returns {Promise<void>}
 * @throws {Error} If the invocation or runtime cannot run the fixed schedule.
 */
async function main() {
    const [fixtureArg, baselineArg, ...extra] = process.argv.slice(2);
    if (!fixtureArg || !baselineArg || extra.length > 0) {
        throw new Error('Usage: node dev/perf/generation-media-index-benchmark.js <dictionary.zip> <baseline-checkout>');
    }
    const fixture = path.resolve(fixtureArg);
    const baselineRoot = path.resolve(baselineArg);
    const baselineSource = path.join(baselineRoot, modulePath);
    const candidateSource = path.join(root, modulePath);
    const threadCpuReader = /** @type {unknown} */ (Reflect.get(process, 'threadCpuUsage'));
    if (typeof threadCpuReader !== 'function') { throw new Error('This benchmark requires process.threadCpuUsage'); }
    const readThreadCpuUsage = /** @type {typeof process.cpuUsage} */ (threadCpuReader);
    // eslint-disable-next-line no-unsanitized/method -- The CLI explicitly selects a local baseline checkout and a fixed module path.
    const baselineNamespace = /** @type {unknown} */ (await import(pathToFileURL(baselineSource).href));
    const baseline = /** @type {typeof candidate} */ (baselineNamespace);
    const archive = await openAsBlob(fixture);
    const entries = await readDenseZipDirectory(archive);
    assert(entries !== null, 'Expected a dense ZIP directory');
    const media = entries.filter(({filename}) => getImageMediaTypeFromFileName(filename) !== null);
    assert(media.length > 0, 'Expected image entries');
    const firstOffset = media[0].offset;
    const last = media[media.length - 1];
    const dataBytes = last.offset + 30 + last.rawFilename.length + last.compressedSize - firstOffset;
    const records = media.map((entry) => ({
        path: entry.filename,
        packedOffset: entry.offset + 30 + entry.rawFilename.length - firstOffset,
        packedLength: entry.compressedSize,
        compressionMethod: entry.compressionMethod,
        uncompressedLength: entry.uncompressedSize,
        signature: entry.signature,
    }));
    const paths = records.map((record) => record.path);
    const original = baseline.createGenerationMediaIndex(records, dataBytes);
    assert(original !== null, 'Expected a canonical decimal media namespace');
    assert.deepEqual(candidate.createGenerationMediaIndex(records, dataBytes), original);
    const workloads = {full: paths, partial: paths.filter((_, index) => index % 7 !== 0)};
    /** @type {Record<string, {paths: number, observations: Array<{order: string, arms: Record<string, Measurement>}>}>} */
    const results = {};
    for (const [workload, selectedPaths] of Object.entries(workloads)) {
        const oracle = baseline.restrictGenerationMediaIndex(original, selectedPaths);
        assert(oracle !== null);
        for (const module of [baseline, candidate]) {
            for (let i = 0; i < warmups; ++i) {
                const plan = module.createGenerationMediaIndex(records, dataBytes);
                assert(plan !== null);
                assert.deepEqual(module.restrictGenerationMediaIndex(plan, selectedPaths), oracle);
            }
        }
        const observations = [];
        for (const order of schedules) {
            /** @type {Record<string, Measurement>} */
            const arms = {};
            for (const label of order) {
                const module = label === 'B' ? candidate : baseline;
                const cpu = process.cpuUsage();
                const threadCpu = readThreadCpuUsage();
                const start = safePerformance.now();
                const plan = module.createGenerationMediaIndex(records, dataBytes);
                const created = safePerformance.now();
                assert(plan !== null);
                const restricted = module.restrictGenerationMediaIndex(plan, selectedPaths);
                const end = safePerformance.now();
                const usedThreadCpu = readThreadCpuUsage(threadCpu);
                const usedCpu = process.cpuUsage(cpu);
                // All descriptor fields and index bytes are checked outside timing.
                assert.deepEqual(restricted, oracle);
                arms[label] = {
                    createMs: created - start,
                    restrictMs: end - created,
                    totalMs: end - start,
                    cpuUserMs: usedCpu.user / 1000,
                    cpuSystemMs: usedCpu.system / 1000,
                    threadCpuUserMs: usedThreadCpu.user / 1000,
                    threadCpuSystemMs: usedThreadCpu.system / 1000,
                    threadCpuMs: (usedThreadCpu.user + usedThreadCpu.system) / 1000,
                };
            }
            observations.push({order, arms});
        }
        results[workload] = {paths: selectedPaths.length, observations};
    }
    process.stdout.write(JSON.stringify({
        schemaVersion: 2,
        boundary: 'Resident source-derived metadata through media index creation and reference restriction',
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model,
        warmupsPerSourceAndWorkload: warmups,
        source: {
            baseline: {root: baselineRoot, sha256: await hashFile(baselineSource)},
            candidate: {root, sha256: await hashFile(candidateSource)},
            harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
        },
        fixture: {path: fixture, sizeBytes: archive.size, sha256: await hashFile(fixture)},
        entries: records.length,
        slots: original.descriptor.slotCount,
        indexBytes: original.index.byteLength,
        results,
    }, null, 4) + '\n');
}

await main();
