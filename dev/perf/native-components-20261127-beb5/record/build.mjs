/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

const compiler = process.env.MANABITAN_CLANG
const linker = process.env.MANABITAN_WASM_LD
assert(compiler && linker, 'Provide the pinned MANABITAN_CLANG and MANABITAN_WASM_LD executables')
const compilerVersion = execFileSync(compiler, ['--version'], {encoding: 'utf8'}).split('\n')[0]
const linkerVersion = execFileSync(linker, ['--version'], {encoding: 'utf8'}).split('\n')[0]
assert(/\b21\.1\.8\b/.test(compilerVersion))
assert(/\b21\.1\.8\b/.test(linkerVersion))
const flags = ['--target=wasm32', '-O3', '-mbulk-memory', '-nostdlib', '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,-z,stack-size=65536', '-Wl,--strip-all']
execFileSync(compiler, [`-fuse-ld=${linker}`, ...flags, '-o', fileURLToPath(new URL('record-fields.wasm', import.meta.url)), fileURLToPath(new URL('record-fields.c', import.meta.url))])
const files = {}
for (const name of ['record-fields.c', 'record-fields.wasm', 'prototype.mjs', 'edge-check.mjs', 'screen.mjs', 'build.mjs']) {
    files[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')
}
assert(WebAssembly.validate(await readFile(new URL('record-fields.wasm', import.meta.url))))
await writeFile(new URL('manifest.json', import.meta.url), JSON.stringify({format: 1, compilerVersion, linkerVersion, flags, files}, null, 2) + '\n')
process.stdout.write(JSON.stringify({compilerVersion, linkerVersion, files}) + '\n')
