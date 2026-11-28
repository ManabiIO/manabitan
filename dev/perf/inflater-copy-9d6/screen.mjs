import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import os from 'node:os'

const [outputArgument, initialOrder = 'AB'] = process.argv.slice(2)
assert(outputArgument)
assert(initialOrder === 'AB' || initialOrder === 'BA')
const directory = dirname(fileURLToPath(import.meta.url))
const output = resolve(outputArgument)
const child = join(directory, 'screen-child.mjs')
const input = join(directory, 'jmdict-groups.json')
const wasmPaths = {A: join(directory, 'baseline/parser.wasm'), B: join(directory, 'candidate/parser.wasm'), C: join(directory, 'baseline/parser.wasm')}
const wasmHashes = {A: '674741af5e0ee70afa9f902b52870041ffd95a20dccc6e898f03f49dba339c31', B: 'f2a8aac2961b6ee806a5fe33f23ccff6fc240fad64ec528ce1f20d2780a0c3d5', C: '674741af5e0ee70afa9f902b52870041ffd95a20dccc6e898f03f49dba339c31'}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
for (const arm of ['A', 'B', 'C']) { assert.equal(hash(await readFile(wasmPaths[arm])), wasmHashes[arm]) }
const frozen = {}
for (const path of [fileURLToPath(import.meta.url), child, input, ...new Set(Object.values(wasmPaths))]) { frozen[path] = hash(await readFile(path)) }
const orders = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']
const schedule = initialOrder === 'AB' ? orders : orders.map((order) => [...order].map((arm) => arm === 'A' ? 'B' : arm === 'B' ? 'A' : arm).join(''))
const protocol = {
    baselineCommit: '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2',
    initialOrder, schedule, frozen, wasmHashes,
    node: process.version, v8: process.versions.v8,
    endpoint: 'Native inflate_and_join_term_banks including immediate CRC, exact12currentJMdictgroups/53banks. Sequential single-instance component; does not measure browser import or three-worker scheduling.',
    protocol: 'Cold primary: six A/B/C permutation blocks, fresh child per observation, zero warmup, one corpus pass. Warm separate: same six permutations, fresh child per observation,4excluded passes and10measured passes. Identical A/C controls, exact parity on every pass, no tail exclusions, control subtraction or reruns.',
    hostBefore: {load: os.loadavg(), cpuModel: os.cpus()[0]?.model, parallelism: os.availableParallelism(), freeMemory: os.freemem()},
}
await mkdir(output, {recursive: true})
await writeFile(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n', {flag: 'wx'})
const observations = []
let complete = false
let failure = null
let geometry = null
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
try {
    for (const mode of ['cold', 'warm']) {
        for (let block = 0; block < schedule.length; ++block) {
            for (const arm of schedule[block]) {
                const name = `${mode}-${String(block + 1).padStart(2, '0')}-${arm}`
                const resultPath = join(output, `${name}.json`)
                const args = ['--expose-gc', '--max-old-space-size=512', child, wasmPaths[arm], input, resultPath, mode]
                const processResult = spawnSync(process.execPath, args, {encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 90_000})
                await writeFile(join(output, `${name}.command.json`), JSON.stringify({program: process.execPath, args, status: processResult.status, signal: processResult.signal, error: processResult.error?.message ?? null}, null, 2) + '\n', {flag: 'wx'})
                await writeFile(join(output, `${name}.log`), (processResult.stdout ?? '') + (processResult.stderr ?? ''), {flag: 'wx'})
                assert.equal(processResult.status, 0, `${name} must complete`)
                const observation = JSON.parse(await readFile(resultPath, 'utf8'))
                assert.equal(observation.complete, true)
                assert.equal(observation.wasmSha256, wasmHashes[arm])
                assert.equal(observation.scriptSha256, frozen[child])
                assert.equal(observation.inputSha256, frozen[input])
                assert.equal(observation.outputDigest, '343a73cf768e5feaa5a1e557de40b3742a3de404524d164884c4787c668c6be8')
                assert.equal(observation.warmups.length, mode === 'cold' ? 0 : 4)
                assert.equal(observation.observations.length, mode === 'cold' ? 1 : 10)
                const currentGeometry = observation.observations[0].groups.map(({inputPtr, outputPtr, uncompressedBytes}) => ({inputPtr, outputPtr, uncompressedBytes}))
                if (geometry === null) { geometry = currentGeometry }
                assert.deepEqual(currentGeometry, geometry)
                observations.push({mode, block, order: schedule[block], arm, meanMs: observation.meanMs, resultFile: `${name}.json`})
                await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n')
                console.log(JSON.stringify(observations.at(-1)))
            }
        }
    }
    for (const [path, expected] of Object.entries(frozen)) { assert.equal(hash(await readFile(path)), expected) }
    complete = true
} catch (error) {
    failure = error.stack ?? String(error)
    throw error
} finally {
    const comparisons = {}
    for (const mode of ['cold', 'warm']) {
        comparisons[mode] = {}
        for (const [left, right] of [['B', 'A'], ['B', 'C'], ['C', 'A']]) {
            const pairs = []
            for (let block = 0; block < schedule.length; ++block) {
                const a = observations.find((value) => value.mode === mode && value.block === block && value.arm === left)
                const b = observations.find((value) => value.mode === mode && value.block === block && value.arm === right)
                if (a && b) { pairs.push({block, percent: (a.meanMs / b.meanMs - 1) * 100, ms: a.meanMs - b.meanMs}) }
            }
            comparisons[mode][`${left}/${right}`] = {pairs, medianPercent: pairs.length ? median(pairs.map(({percent}) => percent)) : null, medianMs: pairs.length ? median(pairs.map(({ms}) => ms)) : null, faster: pairs.filter(({ms}) => ms < 0).length}
        }
    }
    const result = {complete, failure, protocol, observations, comparisons, geometry, hostAfter: {load: os.loadavg(), freeMemory: os.freemem()}}
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
    console.log(JSON.stringify({complete, failure, comparisons}))
}
