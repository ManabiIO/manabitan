import assert from 'node:assert/strict'
import {mkdir, readFile, rename, rm, stat} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import path from 'node:path'
import {plan, readJson, repo, sha256} from './common.mjs'

assert.equal(process.argv.length, 3, 'Usage: node fetch-fixture.mjs ARCHIVE_PATH')
const destination = path.resolve(process.argv[2])
const lock = await readJson(path.join(repo, 'test/perf/dictionaries.lock.json'))
assert.deepEqual(lock.dictionaries[plan.dictionary], plan.fixture)
async function verify(file) {
    assert.equal((await stat(file)).size, plan.fixture.sizeBytes)
    assert.equal(sha256(await readFile(file)), plan.fixture.sha256)
}
let exists = true
try { await stat(destination) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    exists = false
}
if (exists) await verify(destination)
else {
    await mkdir(path.dirname(destination), {recursive: true})
    const temporary = `${destination}.download-${process.pid}`
    try {
        const response = await fetch(plan.fixture.url)
        assert.equal(response.status, 200, `Archive fetch returned ${response.status}`)
        assert.ok(response.body)
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, {flags: 'wx'}))
        await verify(temporary)
        await rename(temporary, destination)
    } finally { await rm(temporary, {force: true}) }
}
console.log(JSON.stringify({archive: destination, bytes: plan.fixture.sizeBytes, sha256: plan.fixture.sha256}))
