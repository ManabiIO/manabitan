import assert from 'node:assert/strict'
import {copyFile, cp, mkdir, readFile} from 'node:fs/promises'
import path from 'node:path'
import {getDictionaryWasmManifest, getDictionaryWasmSourceIdentity, loadDictionaryWasm, verifyDictionaryWasmToolchain} from '../../dictionary-wasm.js'
import {command, kit, kitIdentity, plan, repo, sha256, verifyRuntime, writeJson} from './common.mjs'

assert.equal(process.argv.length, 3, 'Usage: node prepare.mjs OUTPUT_DIRECTORY')
assert.equal(process.version, plan.nodeVersion)
const output = path.resolve(process.argv[2])
const relativeOutput = path.relative(repo, output).replaceAll('\\', '/')
assert.ok(relativeOutput.startsWith('builds/') && !relativeOutput.split('/').includes('..'), 'Keep generated evidence inside this checkout builds/')
await mkdir(path.dirname(output), {recursive: true})
await mkdir(output, {recursive: false})
const receipt = {complete: false, study: plan.study, baseline: plan.baseline, head: command('git', ['rev-parse', 'HEAD']), startedAt: new Date().toISOString(), variants: {}}
try {
    receipt.runtimeIdentity = await verifyRuntime()
    receipt.kitIdentity = await kitIdentity()
    const compiler = path.resolve(command('which', [process.env.MANABITAN_CLANG ?? 'clang-21']))
    // LLVM's multicall linker dispatches by its invoked basename. Keep the
    // wasm-ld symlink name instead of resolving it to the generic lld driver.
    const linker = path.resolve(command('which', [process.env.MANABITAN_WASM_LD ?? 'wasm-ld-21']))
    const compilerVersion = command(compiler, ['--version'])
    const linkerVersion = command(linker, ['--version'])
    verifyDictionaryWasmToolchain(compilerVersion, linkerVersion, plan.toolchain)
    receipt.toolchain = {compiler, linker, compilerVersion, linkerVersion}
    const baselineManifest = getDictionaryWasmManifest(repo)
    loadDictionaryWasm(repo)
    assert.deepEqual(baselineManifest.toolchain, plan.toolchain)
    assert.equal(sha256(await readFile(path.join(repo, 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm'))), plan.canonicalScannerSha256)
    await mkdir(path.join(output, 'modules'))
    for (const [name, expected] of Object.entries(plan.variants)) {
        const stage = path.join(output, 'native-stages', name)
        await mkdir(path.join(stage, 'ext/js/dictionary'), {recursive: true})
        await cp(path.join(repo, 'ext/js/dictionary/wasm'), path.join(stage, 'ext/js/dictionary/wasm'), {recursive: true})
        await mkdir(path.join(stage, 'dev/data'), {recursive: true})
        await cp(path.join(repo, 'dev/data/dictionary-wasm'), path.join(stage, 'dev/data/dictionary-wasm'), {recursive: true})
        if (name !== 'baseline') {
            const inputs = path.join(kit, expected.directory)
            const patch = path.join(inputs, 'parser.patch')
            assert.equal(sha256(await readFile(patch)), expected.patchSha256)
            const changes = command('git', ['apply', '--numstat', patch]).split('\n')
            assert.equal(changes.length, 1)
            assert.equal(changes[0].split('\t')[2], 'ext/js/dictionary/wasm/term-bank-parser.c')
            const prefix = path.relative(repo, stage).replaceAll('\\', '/')
            command('git', ['apply', `--directory=${prefix}`, '--check', patch])
            command('git', ['apply', `--directory=${prefix}`, patch])
            await copyFile(path.join(inputs, 'manifest.json'), path.join(stage, 'dev/data/dictionary-wasm/manifest.json'))
            await copyFile(path.join(inputs, 'term-bank-parser.wasm'), path.join(stage, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
        }
        const parserSource = path.join(stage, 'ext/js/dictionary/wasm/term-bank-parser.c')
        assert.equal(sha256(await readFile(parserSource)), expected.cSha256)
        assert.equal(sha256(await readFile(path.join(stage, 'dev/data/dictionary-wasm/manifest.json'))), expected.manifestSha256)
        const manifest = getDictionaryWasmManifest(stage)
        assert.deepEqual(manifest.toolchain, baselineManifest.toolchain)
        const source = getDictionaryWasmSourceIdentity(stage)
        const artifacts = loadDictionaryWasm(stage)
        const rebuilds = {}
        await mkdir(path.join(stage, 'rebuilt'))
        for (const target of manifest.targets) {
            const original = baselineManifest.targets.find((entry) => entry.name === target.name)
            assert.deepEqual(target.sources, original.sources)
            assert.deepEqual(target.arguments, original.arguments)
            const destination = path.join(stage, 'rebuilt', target.name)
            const args = [`-fuse-ld=${linker}`, ...target.arguments, '-o', destination, ...target.sources.map((file) => path.join(stage, file))]
            command(compiler, args)
            const rebuilt = await readFile(destination)
            assert.ok(WebAssembly.validate(rebuilt), `${name}/${target.name} failed WebAssembly validation`)
            assert.equal(sha256(rebuilt), target.sha256, `Pinned rebuild differs for ${name}/${target.name}`)
            assert.ok(rebuilt.equals(artifacts.get(target.name)), 'Stored and rebuilt bytes differ')
            rebuilds[target.name] = {sha256: sha256(rebuilt), bytes: rebuilt.byteLength, command: [compiler, ...args]}
            if (target.name === 'term-bank-parser.wasm') {
                assert.equal(rebuilt.byteLength, expected.wasmBytes)
                assert.equal(sha256(rebuilt), expected.wasmSha256)
                await copyFile(destination, path.join(output, 'modules', `${name}.wasm`))
            } else assert.equal(sha256(rebuilt), plan.canonicalScannerSha256)
        }
        receipt.variants[name] = {source, rebuilds}
        await writeJson(path.join(output, 'preparation.json'), receipt)
        console.log(`Rebuilt and verified ${name}: ${expected.wasmBytes} parser bytes`)
    }
    assert.deepEqual(await verifyRuntime(), receipt.runtimeIdentity)
    assert.deepEqual(await kitIdentity(), receipt.kitIdentity)
    receipt.complete = true
    receipt.finishedAt = new Date().toISOString()
} catch (error) {
    receipt.error = String(error.stack ?? error)
    throw error
} finally {
    await writeJson(path.join(output, 'preparation.json'), receipt)
}
