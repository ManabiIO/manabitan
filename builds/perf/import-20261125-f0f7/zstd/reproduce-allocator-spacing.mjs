#!/usr/bin/env node

// Native allocator spacing only. This does not measure process memory,
// dictionary import latency, or the retained size of a live worker pool.
// Usage: node reproduce-allocator-spacing.mjs /path/to/manabitan > receipt.json

import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

if (process.argv.length !== 3) {
    throw new Error('Usage: node reproduce-allocator-spacing.mjs /path/to/manabitan')
}

const sourceRoot = resolve(process.argv[2])
const paths = {
    module: 'dev/lib/zstd-simd-module.js',
    wasm: 'dev/data/zstd-simd.wasm',
    dictionary: 'dev/data/zstd-dicts/jmdict.zdict',
    wrapper: 'dev/lib/zstd-wasm.js',
    codec: 'ext/js/dictionary/zstd-term-content.js',
    worker: 'ext/js/dictionary/zstd-term-content-compression-worker.js',
}
const expected = {
    module: '9ec18a2a02698c24e797882ffcee1ef8d97dd7b00e5fa58aa5a0365c7234fe48',
    wasm: 'ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc',
    dictionary: 'f384a821c2f122bde518ee8a513ea76cbe9876c3534fc1fff4cacdf1ecc509cb',
}
const inputs = {}
let wasmBinary
for (const [name, path] of Object.entries(paths)) {
    const bytes = await readFile(resolve(sourceRoot, path))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    inputs[name] = {path, bytes: bytes.byteLength, sha256}
    if (expected[name] && sha256 !== expected[name]) {
        throw new Error(`Checked ${name} differs from the recorded probe: ${sha256}`)
    }
    if (name === 'wasm') { wasmBinary = bytes }
}
const {stdout} = await promisify(execFile)('git', ['-C', sourceRoot, 'rev-parse', 'HEAD', 'HEAD^{tree}'], {encoding: 'utf8'})
const [commit, tree] = stdout.trim().split('\n')
const {default: create} = await import(pathToFileURL(resolve(sourceRoot, paths.module)).href)

const observations = []
for (const kind of ['none', 'CCtx', 'DCtx']) {
    // The factory creates a fresh WASM instance and allocator for every case.
    const module = await create({wasmBinary})
    let before = 0
    let ptr = 0
    let after = 0
    try {
        before = module._malloc(1)
        if (before === 0) { throw new Error('Before-marker allocation failed') }
        if (kind !== 'none') {
            ptr = module[`_ZSTD_create${kind}`]()
            if (ptr === 0) { throw new Error(`${kind} creation failed`) }
        }
        after = module._malloc(1)
        if (after === 0) { throw new Error('After-marker allocation failed') }
        observations.push({kind, before, ptr, after, gap: after - before, heapBytes: module.HEAPU8.byteLength})
    } finally {
        if (ptr !== 0) { module[`_ZSTD_free${kind}`](ptr) }
        if (before !== 0) { module._free(before) }
        if (after !== 0) { module._free(after) }
    }
}

const baselineGap = observations[0].gap
const decoderSpacing = observations[2].gap - baselineGap
console.log(JSON.stringify({
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runtime: {node: process.version, platform: process.platform, arch: process.arch},
    source: {root: sourceRoot, commit, tree},
    inputs,
    scope: 'Native allocator address spacing between two one-byte allocations in fresh WASM modules; no compression or dictionary loading is performed.',
    observations,
    derived: {
        baselineMarkerSpacingBytes: baselineGap,
        compressionContextSpacingBytes: observations[1].gap - baselineGap,
        decompressionContextSpacingBytes: decoderSpacing,
        fourOmittedDecoderContextsSpacingBytes: 4 * decoderSpacing,
        wasmBufferBytes: observations.map(({heapBytes}) => heapBytes),
    },
    interpretation: [
        'Subtract the blank marker-pair spacing to isolate the context allocation plus allocator overhead.',
        'The four-context value is an arithmetic projection for four compression workers, not a measured live pool.',
        'WASM buffer byte lengths are reported separately; omitted contexts do not reduce the initial reservation in this probe.',
        'These observations do not measure RSS, PSS, peak memory, full-import latency, or full-import throughput.',
        'The dictionary hash identifies the application input; this allocation-only probe does not load dictionary bytes.',
    ],
}, null, 2))
