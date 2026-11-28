import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {copyFile, mkdir, readFile, symlink, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const [baselineArgument, captureArgument, cacheArgument, outputArgument, order = 'AB'] = process.argv.slice(2)
assert(baselineArgument && captureArgument && cacheArgument && outputArgument,
    'Usage: run.mjs <baselineRoot> <captureDir> <cacheDir> <outputDir> <AB|BA>')
assert(order === 'AB' || order === 'BA')
const baseline = resolve(baselineArgument)
const capture = resolve(captureArgument)
const cache = resolve(cacheArgument)
const output = resolve(outputArgument)
const directory = dirname(fileURLToPath(import.meta.url))
const candidate = join(output, 'source-candidate')
const measurement = join(output, 'measurement')
const identity = JSON.parse(await readFile(join(directory, 'candidate.json'), 'utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, {recursive: true})
let stage = 'initial identities'
let complete = false
let failure = null
const commands = []

async function command(name, program, args, options = {}) {
    const result = spawnSync(program, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options})
    commands.push({name, program, args, cwd: options.cwd ?? null, status: result.status, signal: result.signal, error: result.error?.message ?? null})
    await writeFile(join(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''), {flag: 'wx'})
    await writeFile(join(output, 'commands.json'), JSON.stringify(commands, null, 2) + '\n')
    assert.equal(result.status, 0, `${name} must complete`)
    return result.stdout.trim()
}

function sections(bytes) {
    assert.equal(bytes.readUInt32LE(0), 0x6d736100)
    let cursor = 8
    const result = new Map()
    const unsigned = () => {
        let value = 0
        let shift = 0
        for (;;) {
            const byte = bytes[cursor++]
            value |= (byte & 127) << shift
            if ((byte & 128) === 0) { return value >>> 0 }
            shift += 7
            assert(shift <= 28)
        }
    }
    while (cursor < bytes.byteLength) {
        const id = bytes[cursor++]
        const size = unsigned()
        assert(cursor + size <= bytes.byteLength)
        if (id !== 0) { assert(!result.has(id)); result.set(id, bytes.subarray(cursor, cursor + size)) }
        cursor += size
    }
    return result
}

try {
    assert.equal(await command('baseline-head', 'git', ['-C', baseline, 'rev-parse', 'HEAD']), identity.baselineCommit)
    for (const file of identity.files) { assert.equal(hash(await readFile(join(baseline, file.path))), file.baselineSha256) }
    assert.equal(hash(await readFile(join(directory, 'candidate.patch'))), identity.patchSha256)
    assert.equal(hash(await readFile(join(directory, 'screen.mjs'))), identity.screenSha256)
    assert.equal(hash(await readFile(join(directory, 'screen-child.mjs'))), identity.childSha256)
    assert.equal(hash(await readFile(join(directory, 'source-groups.json'))), identity.sourceGroupsSha256)
    const manifest = JSON.parse(await readFile(join(baseline, 'dev/data/dictionary-wasm/manifest.json'), 'utf8'))
    assert.equal(manifest.toolchain.compilerVersion, identity.compilerVersion)
    assert.equal(manifest.toolchain.linkerVersion, identity.linkerVersion)
    const target = manifest.targets.find(({name}) => name === 'term-bank-parser.wasm')
    assert(target)
    assert.equal(target.sha256, identity.baselineProductionWasmSha256)
    const compiler = await command('compiler-path', 'which', [process.env.MANABITAN_CLANG || 'clang-21'])
    const linker = await command('linker-path', 'which', [process.env.MANABITAN_WASM_LD || 'wasm-ld-21'])
    const compilerVersion = await command('compiler-version', compiler, ['--version'])
    const linkerVersion = await command('linker-version', linker, ['--version'])
    assert.match(compilerVersion, /\bclang version 21\.1\.8\b/)
    assert.match(linkerVersion, /\bLLD 21\.1\.8\b/)
    stage = 'baseline production rebuild'
    await command('baseline-production-rebuild', process.execPath, [join(baseline, 'dev/bin/build-dictionary-wasm.js'), '--check'], {
        cwd: baseline,
        env: {...process.env, MANABITAN_CLANG: compiler, MANABITAN_WASM_LD: linker},
    })
    stage = 'isolated candidate source'
    await command('candidate-worktree', 'git', ['-C', baseline, 'worktree', 'add', '--detach', candidate, identity.baselineCommit])
    await command('candidate-apply-check', 'git', ['-C', candidate, 'apply', '--check', join(directory, 'candidate.patch')])
    await command('candidate-apply', 'git', ['-C', candidate, 'apply', join(directory, 'candidate.patch')])
    const changed = await command('candidate-changed-paths', 'git', ['-C', candidate, 'diff', '--name-only'])
    assert.deepEqual(changed.split('\n').sort(), identity.files.map(({path}) => path).sort())
    for (const file of identity.files) { assert.equal(hash(await readFile(join(candidate, file.path))), file.candidateSha256) }
    await symlink(join(baseline, 'node_modules'), join(candidate, 'node_modules'), 'dir')
    stage = 'frozen timing modules'
    for (const [name, root, expected] of [['baseline', baseline, identity.baselineTestWasmSha256], ['candidate', candidate, identity.candidateTestWasmSha256]]) {
        const destination = join(measurement, name, 'parser.wasm')
        await mkdir(dirname(destination), {recursive: true})
        const args = [`-fuse-ld=${linker}`, ...target.arguments, '-Wl,--export=term_bank_inflate', '-o', destination, ...target.sources.map((path) => join(root, path))]
        await command(`${name}-timing-module`, compiler, args, {cwd: root})
        assert.equal(hash(await readFile(destination)), expected)
    }
    const production = await readFile(join(baseline, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
    const timing = await readFile(join(measurement, 'baseline/parser.wasm'))
    assert.equal(hash(production), identity.baselineProductionWasmSha256)
    const productionSections = sections(production)
    const timingSections = sections(timing)
    assert.deepEqual([...timingSections.keys()], [...productionSections.keys()])
    const sectionProof = []
    for (const [id, bytes] of productionSections) {
        const equal = bytes.equals(timingSections.get(id))
        if (id !== 7) { assert(equal, `Native section ${id} must be identical`) }
        sectionProof.push({id, equal, productionSha256: hash(bytes), timingSha256: hash(timingSections.get(id))})
    }
    await writeFile(join(output, 'build-receipt.json'), JSON.stringify({identity, compilerVersion, linkerVersion, sectionProof, scope: 'Timing variants add only the direct term_bank_inflate export. Baseline code and every other noncustom section exactly equal the production artifact. Candidate timing bytes are independently frozen to the locally verified module.'}, null, 2) + '\n', {flag: 'wx'})
    await mkdir(join(candidate, 'ext/lib'), {recursive: true})
    await copyFile(join(measurement, 'candidate/parser.wasm'), join(candidate, 'ext/lib/term-bank-parser.wasm'))
    stage = 'verified source geometry'
    await command('prepare-inputs', 'python3', [join(directory, 'prepare-inputs.py'), baseline, cache, capture, join(measurement, 'jmdict-groups.json')])
    await copyFile(join(directory, 'screen.mjs'), join(measurement, 'screen.mjs'))
    await copyFile(join(directory, 'screen-child.mjs'), join(measurement, 'screen-child.mjs'))
    stage = 'fixed component cohort'
    await command('screen', process.execPath, [join(measurement, 'screen.mjs'), join(output, 'cohort'), order], {timeout: 20 * 60 * 1000})
    stage = 'post-cohort identities'
    for (const file of identity.files) {
        assert.equal(hash(await readFile(join(baseline, file.path))), file.baselineSha256)
        assert.equal(hash(await readFile(join(candidate, file.path))), file.candidateSha256)
    }
    complete = true
} catch (error) {
    failure = error.stack ?? String(error)
    throw error
} finally {
    await writeFile(join(output, 'status.json'), JSON.stringify({complete, failure, stage, identity, commands}, null, 2) + '\n', {flag: 'wx'})
}
