import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, readdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

export const kit = path.dirname(fileURLToPath(import.meta.url))
export const repo = path.resolve(kit, '../../..')
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
export const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n')
export const plan = await readJson(path.join(kit, 'plan.json'))

export function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, {cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options})
    if (result.error || result.status !== 0) {
        throw new Error(`${executable} ${args.join(' ')} failed: ${result.error ?? result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    }
    return result.stdout.trim()
}

export async function runtimeIdentity() {
    const files = command('git', ['ls-files', '-z', 'ext/js']).split('\0').filter((file) => file.endsWith('.js'))
    files.push('dev/dictionary-wasm.js', 'dev/json.js', 'package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json')
    files.sort()
    const hashes = {}
    const digest = createHash('sha256')
    for (const file of files) {
        const hash = sha256(await readFile(path.join(repo, file)))
        hashes[file] = hash
        digest.update(`${file}\0${hash}\n`)
    }
    return {digest: digest.digest('hex'), count: files.length, files: hashes}
}

export async function kitIdentity() {
    const files = []
    async function visit(directory) {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            assert.ok(!entry.isSymbolicLink(), 'Linked kit inputs are unsupported')
            const file = path.join(directory, entry.name)
            if (entry.isDirectory()) await visit(file)
            else if (entry.isFile()) files.push(path.relative(kit, file).replaceAll('\\', '/'))
        }
    }
    await visit(kit)
    const hashes = {}
    const digest = createHash('sha256')
    for (const file of files.sort()) {
        const hash = sha256(await readFile(path.join(kit, file)))
        hashes[file] = hash
        digest.update(`${file}\0${hash}\n`)
    }
    return {digest: digest.digest('hex'), files: hashes}
}

export function verifyDesign() {
    assert.equal(process.version, plan.nodeVersion, 'This study pins the Node patch version')
    assert.equal(typeof process.threadCpuUsage, 'function')
    assert.equal(typeof globalThis.gc, 'function', 'Launch the runner with --expose-gc')
    const arms = Object.keys(plan.arms)
    assert.equal(arms.join(''), 'ABCDEFGH')
    assert.equal(plan.arms.A, 'baseline')
    assert.equal(plan.arms.C, 'baseline')
    assert.equal(plan.schedule.length, 16)
    assert.equal(plan.observationsPerArm, 16)
    assert.deepEqual(plan.warmupOrder, ['ABCDEFGH', 'HGFEDCBA'])
    const positions = new Map()
    const adjacencies = new Map()
    for (const order of plan.schedule) {
        assert.equal([...order].sort().join(''), arms.join(''))
        for (let i = 0; i < order.length; i++) {
            const position = `${i}/${order[i]}`
            positions.set(position, (positions.get(position) ?? 0) + 1)
            if (i) {
                const pair = order.slice(i - 1, i + 1)
                adjacencies.set(pair, (adjacencies.get(pair) ?? 0) + 1)
            }
        }
    }
    assert.equal(positions.size, 64)
    assert.ok([...positions.values()].every((count) => count === 2))
    assert.equal(adjacencies.size, 56)
    assert.ok([...adjacencies.values()].every((count) => count === 2))
}

export async function verifyRuntime() {
    command('git', ['diff', '--exit-code', plan.baseline, '--', 'ext/js', 'dev/data/dictionary-wasm', 'dev/dictionary-wasm.js', 'dev/json.js', 'package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json'])
    const identity = await runtimeIdentity()
    assert.equal(identity.count, plan.runtimeSourceFileCount)
    assert.equal(identity.digest, plan.runtimeSourceDigest)
    assert.equal(sha256(await readFile(path.join(repo, 'test/perf/dictionaries.lock.json'))), plan.lockSha256)
    return identity
}
