/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

// Component benchmark, not a complete dictionary import. Use separate worktrees:
// node --expose-gc dev/perf/bench-raw-term-content-20260921.mjs \
//   --baseline=/tmp/manabitan-base/ext/js/dictionary/raw-term-content.js \
//   --output=/tmp/raw-encoding.json --rounds=9
// --operation=references measures reference validation overhead instead.

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {availableParallelism, cpus} from 'node:os'
import {performance} from 'node:perf_hooks'
import {resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

/** @typedef {typeof import('../../ext/js/dictionary/raw-term-content.js')} RawModule */

const options = new Map(process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.+)$/.exec(arg)
    assert.ok(match, `Expected --name=value, received ${arg}`)
    return [match[1], match[2]]
}))
for (const key of options.keys()) {
    assert.ok(['baseline', 'candidate', 'output', 'rounds', 'rows', 'operation'].includes(key), `Unknown option: ${key}`)
}
const baselinePath = options.get('baseline')
const output = options.get('output')
assert.ok(baselinePath && output, '--baseline and --output are required')
const gc = globalThis.gc
assert.ok(gc, 'Run Node with --expose-gc')
const operation = options.get('operation') ?? 'encode'
assert.ok(operation === 'encode' || operation === 'references')
const rounds = Number(options.get('rounds') ?? 9)
const rows = Number(options.get('rows') ?? (operation === 'encode' ? 24000 : 200000))
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 101)
assert.ok(Number.isSafeInteger(rows) && rows > 0 && rows <= 1_000_000)
const baselineURL = pathToFileURL(resolve(baselinePath))
const candidatePath = options.get('candidate')
const candidateURL = typeof candidatePath === 'string' ? pathToFileURL(resolve(candidatePath)) : new URL('../../ext/js/dictionary/raw-term-content.js', import.meta.url)
/** @type {RawModule} */
const aModule = await import(baselineURL.href)
/** @type {RawModule} */
const bModule = await import(candidateURL.href)
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
/**
 * @param {number[]} values
 * @returns {number}
 */
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const i = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[i - 1] + sorted[i]) / 2 : sorted[i]
}
/** @type {object[]} */
const results = []

/**
 * @param {string} name
 * @param {() => number} a
 * @param {() => number} b
 * @param {number} expectedChecksum
 * @param {string} outputHash
 * @param {Record<string, string|number>} workload
 */
function measure(name, a, b, expectedChecksum, outputHash, workload) {
    for (let warmup = 0; warmup < 6; ++warmup) {
        assert.equal(a(), expectedChecksum)
        assert.equal(b(), expectedChecksum)
    }
    const samples = []
    const pairs = []
    for (let block = 0; block < rounds; ++block) {
        /** @type {('A'|'B')[]} */
        const order = block % 2 === 0 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B']
        /** @type {{A: number[], B: number[]}} */
        const times = {A: [], B: []}
        for (const variant of order) {
            if (gc) { gc() }
            const start = performance.now()
            const checksum = (variant === 'A' ? a : b)()
            const ms = performance.now() - start
            assert.equal(checksum, expectedChecksum)
            times[variant].push(ms)
            samples.push({block, variant, ms, checksum})
        }
        const baselineMs = (times.A[0] + times.A[1]) / 2
        const candidateMs = (times.B[0] + times.B[1]) / 2
        pairs.push({block, baselineMs, candidateMs, deltaPercent: (candidateMs / baselineMs - 1) * 100})
    }
    const result = {
        name, workload, expectedOutputSha256: outputHash, expectedChecksum,
        medianBaselineMs: median(pairs.map((p) => p.baselineMs)),
        medianCandidateMs: median(pairs.map((p) => p.candidateMs)),
        medianPairedDeltaPercent: median(pairs.map((p) => p.deltaPercent)),
        fasterBlocks: pairs.filter((p) => p.deltaPercent < 0).length,
        pairs, samples,
    }
    results.push(result)
    console.log(`${name}: ${result.medianPairedDeltaPercent.toFixed(2)}%, ${result.fasterBlocks}/${rounds} faster blocks`)
}

if (operation === 'encode') {
    const encoder = new TextEncoder()
    /** @type {[string, string, number][]} */
    const workloads = [
        ['empty-small', 'empty', 64],
        ['empty-medium', 'empty', 1024],
        ['mixed-fields', 'mixed', 64],
        ['nonempty-control', 'nonempty', 64],
        ['escaped-control', 'escaped', 64],
    ]
    for (const [name, mode, glossarySize] of workloads) {
        const entries = Array.from({length: rows}, (_, i) => ({
            tags: /** @type {[string, string, string]} */ (mode === 'empty' || (mode === 'mixed' && i % 4 !== 0) ? ['', '', ''] : mode === 'escaped' ? ['a"\\b', '\ufeffnoun\n', '\0\ud800'] : ['v1', 'noun', 'common']),
            glossary: encoder.encode(JSON.stringify([`meaning ${i} 猫`, 'x'.repeat(glossarySize)])),
        }))
        let expected = 0
        const digest = createHash('sha256')
        for (const {tags, glossary} of entries) {
            const a = aModule.encodeRawTermContentBinary(...tags, glossary, encoder)
            const b = bModule.encodeRawTermContentBinary(...tags, glossary, encoder)
            assert.deepEqual(b, a)
            digest.update(a)
            expected += a.length + a[16] + a[a.length - 2]
        }
        /**
         * @param {RawModule} module
         * @returns {number}
         */
        const run = (module) => {
            let checksum = 0
            for (const {tags, glossary} of entries) {
                const bytes = module.encodeRawTermContentBinary(tags[0], tags[1], tags[2], glossary, encoder)
                checksum += bytes.length + bytes[16] + bytes[bytes.length - 2]
            }
            return checksum
        }
        measure(name, () => run(aModule), () => run(bModule), expected, digest.digest('hex'), {
            rows, mode, glossarySize,
            boundary: 'complete raw-v2 encoder, including output allocation and copying; source glossary UTF-8 prepared outside timing',
        })
    }
} else {
    /** @type {[string, number, 'writeRawTermContentBlockReference'|'writeRawTermContentCompactBlockReference'][]} */
    const workloads = [
        ['legacy-reference-slab', 28, 'writeRawTermContentBlockReference'],
        ['compact-reference-slab', 20, 'writeRawTermContentCompactBlockReference'],
    ]
    for (const [name, width, functionName] of workloads) {
        const aBytes = new Uint8Array(width * rows)
        const bBytes = new Uint8Array(width * rows)
        const aView = new DataView(aBytes.buffer)
        const bView = new DataView(bBytes.buffer)
        /**
         * @param {RawModule['writeRawTermContentBlockReference']|RawModule['writeRawTermContentCompactBlockReference']} writer
         * @param {DataView} view
         * @returns {number}
         */
        const run = (writer, view) => {
            let checksum = 0
            for (let i = 0; i < rows; ++i) {
                const at = i * width
                writer(view, at, 0x100000007 + i * 8192, 4096, 8192, i % 4096, 128)
                checksum += view.getUint32(at + width - 4, true)
            }
            return checksum
        }
        const a = () => run(aModule[functionName], aView)
        const b = () => run(bModule[functionName], bView)
        const expected = a()
        assert.equal(b(), expected)
        assert.deepEqual(bBytes, aBytes)
        measure(name, a, b, expected, sha256(aBytes), {rows, width, boundary: 'reference writes into a preallocated slab; not a complete import'})
    }
}

await writeFile(resolve(output), `${JSON.stringify({
    schemaVersion: 1, recordedAt: new Date().toISOString(), syntheticOnly: true,
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    cpu: cpus()[0].model, availableParallelism: availableParallelism(), rounds, rows, operation,
    methodology: 'Six paired warmups; alternating ABBA/BAAB blocks; GC outside timing; complete byte equality outside timing and consumed checksums inside; arithmetic median of paired block changes',
    sources: {
        baselineSha256: sha256(await readFile(baselineURL)),
        candidateSha256: sha256(await readFile(candidateURL)),
        harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    },
    results,
}, null, 2)}\n`)
