/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance as safePerformance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import * as candidate from '../../ext/js/data/array-buffer-util.js';

/**
 * @param {number} size
 * @returns {Uint8Array<ArrayBuffer>}
 */
function createBytes(size) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; ++i) { bytes[i] = ((i * 73) ^ (i >>> 8)) & 255; }
    return bytes;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}

/**
 * @param {URL} url
 * @returns {Promise<string>}
 */
async function sourceHash(url) {
    return createHash('sha256').update(await readFile(url)).digest('hex');
}

/** @returns {Promise<void>} */
async function main() {
    const [baselinePath, pairsArgument = '20'] = process.argv.slice(2);
    const pairs = Number(pairsArgument);
    if (typeof baselinePath !== 'string' || !Number.isSafeInteger(pairs) || pairs < 1) {
        throw new Error('Usage: node --expose-gc dev/bin/benchmark-array-buffer-base64.js BASELINE_MODULE [PAIRS=20]');
    }
    const collectGarbage = globalThis.gc;
    if (typeof collectGarbage !== 'function') { throw new Error('Run with --expose-gc for comparable batches'); }
    const baselineUrl = pathToFileURL(resolve(baselinePath));
    // The CLI operator explicitly selects a trusted local baseline module.
    // pathToFileURL keeps this loader restricted to a local filesystem URL.
    // eslint-disable-next-line no-unsanitized/method
    const baseline = /** @type {typeof candidate} */ (await import(baselineUrl.href));
    const candidateUrl = new URL('../../ext/js/data/array-buffer-util.js', import.meta.url);
    let assertions = 0;
    for (const size of [0, 1, 2, 3, 255, 256, 257, 32767, 32768, 32769, 65535, 65536, 65537, 131071, 131072, 1048576, 4194304]) {
        const input = createBytes(size);
        const expectedBinary = Buffer.from(input).toString('latin1');
        const expectedBase64 = Buffer.from(input).toString('base64');
        for (const implementation of [baseline, candidate]) {
            assert.equal(implementation.arrayBufferToBinaryString(input.buffer), expectedBinary);
            assert.equal(implementation.arrayBufferToBase64(input.buffer), expectedBase64);
            assert.deepEqual(new Uint8Array(implementation.base64ToArrayBuffer(expectedBase64)), input);
            assertions += 3;
        }
    }
    const cases = [
        {label: '256 B', size: 256, iterations: 500},
        {label: '4 KiB', size: 4096, iterations: 100},
        {label: '32 KiB', size: 32768, iterations: 20},
        {label: '128 KiB', size: 131072, iterations: 5},
        {label: '1 MiB', size: 1048576, iterations: 1},
        {label: '4 MiB', size: 4194304, iterations: 1},
    ];
    const results = [];
    let sink = 0;
    for (const testCase of cases) {
        const {size, iterations} = testCase;
        const input = createBytes(size).buffer;
        /**
         * @param {typeof candidate} implementation
         * @returns {number}
         */
        const measure = (implementation) => {
            collectGarbage();
            const start = safePerformance.now();
            for (let i = 0; i < iterations; ++i) {
                const value = implementation.arrayBufferToBase64(input);
                sink = (sink + value.length + value.charCodeAt(value.length >> 1)) | 0;
            }
            return (safePerformance.now() - start) / iterations;
        };
        for (let i = 0; i < 8; ++i) {
            measure(baseline);
            measure(candidate);
        }
        const samples = [];
        for (let i = 0; i < pairs; ++i) {
            let baselineMs;
            let candidateMs;
            if (i % 2 === 0) {
                baselineMs = measure(baseline);
                candidateMs = measure(candidate);
            } else {
                candidateMs = measure(candidate);
                baselineMs = measure(baseline);
            }
            samples.push({baselineMs, candidateMs, changePct: (candidateMs / baselineMs - 1) * 100});
        }
        const result = {
            ...testCase,
            baselineMedianMs: median(samples.map((value) => value.baselineMs)),
            candidateMedianMs: median(samples.map((value) => value.candidateMs)),
            pairedMedianChangePct: median(samples.map((value) => value.changePct)),
            fasterPairs: samples.filter((value) => value.candidateMs < value.baselineMs).length,
            samples,
        };
        results.push(result);
        console.error(`${testCase.label}: paired median ${result.pairedMedianChangePct.toFixed(2)}%, faster ${result.fasterPairs}/${pairs}`);
    }
    console.log(JSON.stringify({
        scope: 'Production arrayBufferToBase64 helper only; not a dictionary import or browser benchmark',
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        baselineModule: baselineUrl.href,
        baselineSourceSha256: await sourceHash(baselineUrl),
        candidateSourceSha256: await sourceHash(candidateUrl),
        assertions,
        pairs,
        warmups: 8,
        sink,
        cases: results,
    }, null, 2));
}

/**
 * @param {unknown} error
 * @returns {void}
 */
function onError(error) {
    console.error(error);
    process.exitCode = 1;
}

void main().catch(onError);
