/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const simd = process.argv.includes('--simd')
const compiler = process.env.MANABITAN_CLANG || 'clang-21'
const linker = process.env.MANABITAN_WASM_LD || 'wasm-ld-21'
const compilerVersion = execFileSync(compiler, ['--version'], {encoding: 'utf8'})
const linkerVersion = execFileSync(linker, ['--version'], {encoding: 'utf8'})
assert.match(compilerVersion, /\bclang version 21\.1\.8\b/)
assert.match(linkerVersion, /\bLLD 21\.1\.8\b/)
const source = join(directory, 'xxh32-stream.c')
const output = join(directory, simd ? 'xxh32-stream-simd.wasm' : 'xxh32-stream.wasm')
const args = [
    `-fuse-ld=${linker}`, '--target=wasm32', '-O3', '-std=c11', '-nostdlib',
    '-ffreestanding', '-fno-builtin', '-fno-stack-protector',
    '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,--strip-all',
    '-Wl,--initial-memory=65536', '-Wl,--max-memory=65536',
    '-Wl,--stack-first', '-Wl,-z,stack-size=1024', '-o', output, source,
]
if (simd) args.splice(2, 0, '-msimd128')
execFileSync(compiler, args, {stdio: 'inherit'})
const bytes = readFileSync(output)
assert(WebAssembly.validate(bytes))
const {instance} = await WebAssembly.instantiate(bytes)
assert.equal(instance.exports.memory.buffer.byteLength, 65536)
assert.equal(instance.exports.xxh32_scratch_capacity(), 61440)
assert.throws(() => instance.exports.memory.grow(1), RangeError)
const hash = (data) => createHash('sha256').update(data).digest('hex')
const receipt = {
    compilerVersion: '21.1.8', linkerVersion: '21.1.8',
    sourceSha256: hash(readFileSync(source)), wasmSha256: hash(bytes),
    wasmBytes: bytes.byteLength, memoryBytes: 65536, scratchBytes: 61440,
    simd,
    arguments: args.map((value) => value.replace(directory + '/', '')),
}
writeFileSync(join(directory, simd ? 'build-receipt-simd.json' : 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt, null, 2))
