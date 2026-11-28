// Source-bound compiler reproduction and input unpacking. No kernel execution or timing.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {gunzipSync} from 'node:zlib'
import {hash, hashFile, toolingRoot, verifySourceInventory, writeJson} from './common.mjs'

const {values} = parseArgs({options: {
    'project-root': {type: 'string'}, clang: {type: 'string'}, linker: {type: 'string'},
    output: {type: 'string'}, 'inputs-output': {type: 'string'},
}})
assert(values['project-root'] && values.clang && values.linker && values.output && values['inputs-output'])
const project = path.resolve(values['project-root'])
const output = path.resolve(values.output)
const inputs = path.resolve(values['inputs-output'])
await mkdir(output)
const binding = JSON.parse(await readFile(path.join(toolingRoot, 'build-binding.json'), 'utf8'))
const report = {scope: 'Pinned native reproduction and fixed dataset extraction; no kernel execution or timing',
    status: 'running', stage: 'source', node: process.version, binding,
    sourceInventorySha256: null, groups: []}
const receipt = path.join(output, 'build.json')
await writeJson(receipt, report)
const git = (...args) => execFileSync('git', ['-C', project, ...args], {encoding: 'utf8'}).trim()
try {
    assert.equal(process.version, binding.nodeVersion)
    report.sourceInventorySha256 = await verifySourceInventory()
    assert.equal(git('rev-parse', 'HEAD'), binding.baselineHead)
    assert.equal(git('status', '--porcelain=v1', '--untracked-files=no'), '')
    const source = await readFile(path.join(project, binding.baselineStorePath), 'utf8')
    assert.equal(hash(source), binding.baselineStoreSha256)
    const start = source.indexOf('            while (runEnd < runLimitEnd) {', source.indexOf('    async _encodeAndAppendArtifactChunkForState('))
    const end = source.indexOf('\n            const runContentOffsetBase =', start)
    assert(start >= 0 && end > start)
    const loop = source.slice(start, end)
    assert.equal(hash(loop), binding.baselineLoopSha256)
    function exactFunction(name) {
        const first = source.indexOf(`function ${name}(`)
        const last = source.indexOf('\n}\n', first) + 2
        assert(first >= 0 && last > first)
        return source.slice(first, last)
    }
    const portable = `// Exact loop and validation helpers from frozen ${binding.baselineHead}.\n` +
        '// Extraction changes JavaScript function size, call shape, and possible JIT behavior.\n' +
        'const MAX_CONTENT_OFFSET_DELTA = 0xfffffffe\nconst U32_NULL = 0xffffffff\n' +
        exactFunction('validateContentOffset') + '\n' + exactFunction('validateContentLength') + '\n' +
        'export function baselineScan(references, runStart, runLimitEnd) {\n' +
        '    const chunk = null, contentOffsets = null, contentLengths = null, useFixedContentSpan = false\n' +
        '    let runEnd = runStart\n    let minContentOffset = Number.POSITIVE_INFINITY\n    let maxContentOffset = Number.NEGATIVE_INFINITY\n' +
        loop + '\n    return {runEnd, minimum: minContentOffset, maximum: maxContentOffset}\n}\n'
    assert.equal(hash(portable), binding.portableBaselineSha256)
    assert.equal(await readFile(path.join(toolingRoot, 'baseline-loop.mjs'), 'utf8'), portable)
    assert.equal(await hashFile(path.join(toolingRoot, 'record-run-validator.c')), binding.kernelSourceSha256)
    assert.equal(await hashFile(path.join(toolingRoot, 'native-validator.mjs')), binding.adapterSha256)
    report.stage = 'compiler'
    report.compilerVersion = execFileSync(values.clang, ['--version'], {encoding: 'utf8'}).trim()
    report.linkerVersion = execFileSync(values.linker, ['--version'], {encoding: 'utf8'}).trim()
    assert.match(report.compilerVersion, /clang version 21\.1\.8\b/)
    assert.match(report.linkerVersion, /LLD 21\.1\.8\b/)
    await writeJson(receipt, report)
    const built = path.join(output, 'record-run-validator.wasm')
    const sourcePath = path.join(toolingRoot, 'record-run-validator.c')
    report.arguments = [`-fuse-ld=${path.resolve(values.linker)}`, ...binding.arguments, '-o', built, sourcePath]
    execFileSync(values.clang, report.arguments, {stdio: 'inherit'})
    execFileSync(values.clang, [...binding.arguments.filter((x) => !x.startsWith('-Wl,')),
        '-S', '-o', path.join(output, 'record-run-validator.s'), sourcePath], {stdio: 'inherit'})
    const compiled = await readFile(built)
    assert.equal(hash(compiled), binding.kernelSha256)
    assert.deepEqual(compiled, await readFile(path.join(toolingRoot, 'record-run-validator.wasm')))
    assert(WebAssembly.validate(compiled))
    const module = new WebAssembly.Module(compiled)
    report.imports = WebAssembly.Module.imports(module)
    report.exports = WebAssembly.Module.exports(module)
    assert.deepEqual(report.imports, [{module: 'env', name: 'memory', kind: 'memory'}])
    assert.deepEqual(report.exports, [{name: 'validate_record_run', kind: 'function'}])
    const assembly = await readFile(path.join(output, 'record-run-validator.s'), 'utf8')
    assert(!assembly.includes('__stack_pointer'))
    report.builtModuleSha256 = hash(compiled)
    report.builtModuleBytes = compiled.byteLength
    report.stackPointerReferences = 0
    report.stage = 'inputs'
    await writeJson(receipt, report)
    const inventoryBytes = await readFile(path.join(toolingRoot, 'input-inventory.json'))
    assert.equal(hash(inventoryBytes), binding.inputInventorySha256)
    const inventory = JSON.parse(inventoryBytes)
    const archive = await readFile(path.join(toolingRoot, binding.inputArchive.file))
    assert.equal(archive.byteLength, binding.inputArchive.bytes)
    assert.equal(hash(archive), binding.inputArchive.sha256)
    const raw = gunzipSync(archive, {maxOutputLength: binding.inputArchive.uncompressedBytes})
    assert.equal(raw.byteLength, binding.inputArchive.uncompressedBytes)
    await mkdir(inputs)
    let cursor = 0
    for (const group of inventory.groups) {
        assert.match(group.file, /^group-\d\d\.bin$/)
        const payload = raw.subarray(cursor, cursor + group.bytes)
        cursor += group.bytes
        assert.equal(payload.byteLength, group.bytes)
        assert.equal(hash(payload), group.sha256)
        await writeFile(path.join(inputs, group.file), payload, {flag: 'wx'})
        report.groups.push({group: group.group, file: group.file, bytes: payload.byteLength, sha256: hash(payload)})
    }
    assert.equal(cursor, raw.byteLength)
    assert.equal(report.groups.length, 12)
    report.inputArchive = binding.inputArchive
    report.stage = 'final-identity'
    assert.equal(await verifySourceInventory(), report.sourceInventorySha256)
    assert.equal(git('rev-parse', 'HEAD'), binding.baselineHead)
    assert.equal(git('status', '--porcelain=v1', '--untracked-files=no'), '')
    assert.equal(await hashFile(path.join(project, binding.baselineStorePath)), binding.baselineStoreSha256)
    report.finalIdentityCheck = 'passed'
    report.stage = 'finished'
    report.status = 'success'
} catch (error) {
    report.status = 'failed'
    report.error = String(error?.stack || error)
    await writeJson(receipt, report)
    throw error
}
await writeJson(receipt, report)
console.log(JSON.stringify({status: report.status, moduleSha256: report.builtModuleSha256,
    moduleBytes: report.builtModuleBytes, inputArchive: report.inputArchive, groups: report.groups.length}))
