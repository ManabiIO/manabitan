/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {hash, hashFile, readJson, toolingRoot, writeJson} from './common.mjs'

const {values} = parseArgs({options: {
    'project-root': {type: 'string'}, output: {type: 'string'},
    clang: {type: 'string', default: 'clang-21'}, linker: {type: 'string', default: 'wasm-ld-21'},
}})
assert(values['project-root'] && values.output)
const projectRoot = path.resolve(values['project-root'])
const output = path.resolve(values.output)
await mkdir(output, {recursive: true})
const protocol = await readJson(path.join(toolingRoot, 'protocol.json'))
assert.equal(process.version, protocol.nodeVersion)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: projectRoot, encoding: 'utf8'}).trim(), protocol.baseline.sourceCommit)
execFileSync('git', ['diff', '--exit-code'], {cwd: projectRoot})
const manifest = await readJson(path.join(projectRoot, 'dev/data/dictionary-wasm/manifest.json'))
const target = manifest.targets.find(({name}) => name === 'term-content-canonical-scan-v1.wasm')
assert(target)
assert.equal(target.sha256, protocol.baseline.sha256)
const compilerVersion = execFileSync(values.clang, ['--version'], {encoding: 'utf8'})
const linkerVersion = execFileSync(values.linker, ['--version'], {encoding: 'utf8'})
assert.equal(compilerVersion.match(/\bclang version (\d+\.\d+\.\d+)/)?.[1], protocol.compiler.clangVersion)
assert.equal(linkerVersion.match(/\bLLD (\d+\.\d+\.\d+)/)?.[1], protocol.compiler.lldVersion)
const report = {schemaVersion: 1, sourceCommit: protocol.baseline.sourceCommit, compilerVersion, linkerVersion, arguments: target.arguments, modules: []}
for (const entry of [protocol.baseline, ...Object.values(protocol.variants)]) {
    const source = entry.id === 'baseline' ? path.join(projectRoot, entry.sourcePath) : path.join(toolingRoot, entry.sourcePath)
    assert.equal(await hashFile(source), entry.sourceSha256, entry.id)
    const destination = path.join(output, entry.id + '.wasm')
    const args = [`-fuse-ld=${values.linker}`, ...target.arguments, '-o', destination, source]
    execFileSync(values.clang, args, {stdio: 'inherit'})
    const bytes = await readFile(destination)
    assert.ok(WebAssembly.validate(bytes), entry.id)
    assert.equal(hash(bytes), entry.sha256, entry.id)
    report.modules.push({id: entry.id, sha256: hash(bytes), sourceSha256: entry.sourceSha256, bytes: bytes.byteLength, arguments: args})
    await writeJson(path.join(output, 'build-report.json'), report)
}
console.log(JSON.stringify(report))
