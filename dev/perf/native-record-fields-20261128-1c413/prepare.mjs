import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync, copyFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {here, repository, plan, sha256, verifyPlan, verifySources} from './common.mjs'

assert(process.argv.length === 3 || process.argv.length === 4)
const localUntimed = process.argv[3] === '--local-untimed'
assert(process.argv.length === 3 || localUntimed)
if (!localUntimed) assert.equal(process.version, plan.nodeVersion)
const outputDirectory = resolve(process.argv[2])
mkdirSync(outputDirectory)
const receipt = {complete: false, timingAcquisition: false, node: process.version, plannedNode: plan.nodeVersion, localUntimed, sources: null}
try {
    receipt.schedule = verifyPlan()
    receipt.sources = verifySources()
    const source = JSON.parse(readFileSync(resolve(here, 'source.json')))
    for (const file of [...source.files, {path: 'source.json'}]) {
        const target = resolve(outputDirectory, 'frozen-kit', file.path)
        mkdirSync(dirname(target), {recursive: true})
        copyFileSync(resolve(here, file.path), target)
    }
    copyFileSync(resolve(repository, source.workflow.path), resolve(outputDirectory, 'frozen-workflow.yml'))
    const compiler = process.env.CLANG ?? 'clang-21'
    const linker = process.env.WASM_LD ?? 'wasm-ld-21'
    for (const [name, executable] of [['compiler', compiler], ['linker', linker]]) {
        const result = spawnSync(executable, ['--version'], {encoding: 'utf8'})
        assert.equal(result.status, 0, result.stderr)
        assert(/\b21\.1\.8\b/.test(result.stdout), result.stdout)
        receipt[name + 'Version'] = result.stdout.trim()
    }
    const args = ['-fuse-ld=' + linker, '--target=wasm32', '-O3', '-nostdlib', '-mbulk-memory', '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,-z,stack-size=65536', '-Wl,--strip-all', '-o', resolve(outputDirectory, 'rebuilt-record-fields.wasm'), resolve(here, 'record-fields.c')]
    receipt.buildCommand = [compiler, ...args]
    const build = spawnSync(compiler, args, {encoding: 'utf8', timeout: 120000})
    writeFileSync(resolve(outputDirectory, 'build.log'), (build.stdout ?? '') + (build.stderr ?? ''))
    receipt.buildExitCode = build.status
    assert.equal(build.status, 0, build.stderr)
    const rebuilt = readFileSync(resolve(outputDirectory, 'rebuilt-record-fields.wasm'))
    assert.equal(rebuilt.byteLength, plan.native.wasmBytes)
    assert.equal(sha256(rebuilt), plan.native.wasmSha256)
    receipt.rebuild = {bytes: rebuilt.byteLength, sha256: sha256(rebuilt)}
    const environment = {...process.env, NODE_DISABLE_COMPILE_CACHE: '1', RECORD_FIELD_TEST_OUTPUT: resolve(outputDirectory, 'focused-tests')}
    delete environment.NODE_COMPILE_CACHE
    delete environment.NODE_OPTIONS
    delete environment.NODE_V8_COVERAGE
    const tests = spawnSync(process.execPath, [resolve(here, 'tests.mjs')], {encoding: 'utf8', env: environment, timeout: 120000, maxBuffer: 8 * 1024 * 1024})
    writeFileSync(resolve(outputDirectory, 'tests.stdout.txt'), tests.stdout ?? '')
    writeFileSync(resolve(outputDirectory, 'tests.stderr.txt'), tests.stderr ?? '')
    receipt.testExitCode = tests.status
    assert.equal(tests.status, 0, tests.stderr)
    const report = JSON.parse(readFileSync(resolve(outputDirectory, 'focused-tests/001/report.json')))
    assert.equal(report.complete, true)
    assert.equal(report.failed, 0)
    assert.equal(report.passed, 51)
    receipt.tests = {passed: report.passed, failed: report.failed, reportSha256: sha256(readFileSync(resolve(outputDirectory, 'focused-tests/001/report.json')))}
    receipt.complete = true
} catch (error) {
    receipt.error = String(error)
    receipt.stack = error.stack
    process.exitCode = 1
} finally {
    writeFileSync(resolve(outputDirectory, 'preparation.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt))
}
