/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {after, test} from 'node:test'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import ts from 'typescript'

const temporary = await mkdtemp(join(tmpdir(), 'manabitan-client-admission-'))
for (const name of ['client', 'protocol']) {
    const input = process.env.MANABITAN_CLIENT_BASELINE && name === 'client' ?
        await readFile(process.env.MANABITAN_CLIENT_BASELINE, 'utf8') :
        await readFile(new URL(`../../ext/web/${name}.ts`, import.meta.url), 'utf8')
    const {outputText, diagnostics} = ts.transpileModule(input, {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
        reportDiagnostics: true,
    })
    assert.equal(diagnostics.length, 0)
    await writeFile(join(temporary, `${name}.mjs`), outputText.replace("'./protocol.js'", "'./protocol.mjs'"))
}
const {ManabiTanWebClient} = await import(pathToFileURL(join(temporary, 'client.mjs')).href)
after(() => rm(temporary, {recursive: true, force: true}))

class Clock {
    time = 0
    next = 0
    tasks = new Map()
    set = (callback, delay) => {const id = ++this.next; this.tasks.set(id, {at: this.time + delay, callback}); return id}
    clear = (id) => this.tasks.delete(id)
    advance(milliseconds) {
        const end = this.time + milliseconds
        while (true) {
            const next = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
            if (!next) {break}
            this.time = next[1].at
            this.tasks.delete(next[0])
            next[1].callback()
        }
        this.time = end
    }
}
class WorkerBoundary {
    static latest
    listeners = new Map()
    messages = []
    terminated = false
    constructor() {WorkerBoundary.latest = this}
    addEventListener(name, callback) {this.listeners.set(name, callback)}
    postMessage(message) {this.messages.push(message)}
    terminate() {this.terminated = true}
    finish(id, result = null, error) {this.listeners.get('message')({data: {version: 1, id, result, error}})}
    progress(id) {this.listeners.get('message')({data: {version: 1, id, progress: {completed: 1}}})}
}
async function scenario(run) {
    const original = {Worker: globalThis.Worker, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout}
    const clock = new Clock()
    Object.assign(globalThis, {Worker: WorkerBoundary, setTimeout: clock.set, clearTimeout: clock.clear})
    const client = new ManabiTanWebClient()
    const worker = WorkerBoundary.latest
    try {await run({client, worker, clock})} finally {
        worker.listeners.get('error')()
        Object.assign(globalThis, original)
    }
}
const observe = (promise) => promise.then((value) => ({value}), (error) => ({error}))

for (const method of ['status', 'lookup']) {
    test(`queued ${method} does not own the progressing import's watchdog`, () => scenario(async ({client, worker, clock}) => {
        const importing = observe(client.importDictionary(new Blob(['dictionary'])))
        const waiting = observe(client[method]('日本'))
        const importID = worker.messages[0].id
        for (let i = 0; i < 4; ++i) {clock.advance(10_000); worker.progress(importID)}
        assert.equal(worker.terminated, false)
        assert.deepEqual(worker.messages.map((m) => m.operation), ['import'])
        worker.finish(importID, {cancelledAfterCommit: false})
        assert.equal((await importing).error, undefined)
        assert.equal(worker.messages[1].operation, method)
        clock.advance(29_999)
        assert.equal(worker.terminated, false)
        worker.finish(worker.messages[1].id, 'lookup-result')
        assert.equal((await waiting).value, 'lookup-result')
    }))
}
test('queued cancellation never posts work and cannot release the current owner', () => scenario(async ({client, worker, clock}) => {
    const importing = observe(client.importDictionary(new Blob(['x'])))
    const controller = new AbortController()
    const waiting = observe(client.status({signal: controller.signal}))
    controller.abort()
    assert.equal((await waiting).error.name, 'AbortError')
    clock.advance(40_000)
    assert.equal(worker.terminated, false)
    assert.deepEqual(worker.messages.map((m) => m.operation), ['import'])
    worker.finish(worker.messages[0].id)
    await importing
}))
test('cancelled executing read retains its owner until the worker terminal reply', () => scenario(async ({client, worker}) => {
    const controller = new AbortController()
    const first = observe(client.lookup('日本', {signal: controller.signal}))
    const second = observe(client.status())
    controller.abort()
    assert.equal((await first).error.name, 'AbortError')
    assert.deepEqual(worker.messages.map((m) => m.operation), ['lookup', 'cancel'])
    worker.finish(worker.messages[0].id, null, {name: 'AbortError', message: 'cancelled'})
    assert.equal(worker.messages[2].operation, 'status')
    worker.finish(worker.messages[2].id)
    await second
}))
test('a stalled executing operation still terminates its worker', () => scenario(async ({client, worker, clock}) => {
    const lookup = observe(client.lookup('日本'))
    const status = observe(client.status())
    clock.advance(30_001)
    assert.equal(worker.terminated, true)
    assert.equal((await lookup).error.code, 'worker_timeout')
    assert.equal((await status).error.code, 'worker_timeout')
}))
test('import cancellation-after-commit remains a successful committed result', () => scenario(async ({client, worker}) => {
    const controller = new AbortController()
    const importing = observe(client.importDictionary(new Blob(['x']), {signal: controller.signal}))
    controller.abort()
    worker.finish(worker.messages[0].id, {cancelledAfterCommit: true})
    assert.equal((await importing).value.cancelledAfterCommit, true)
}))
test('close rejects queued work, is out-of-band, and retains the committed import outcome', () => scenario(async ({client, worker}) => {
    const importing = observe(client.importDictionary(new Blob(['x'])))
    const queued = observe(client.status())
    const closing = client.close()
    assert.equal(client.close(), closing)
    assert.equal((await queued).error.name, 'AbortError')
    assert.deepEqual(worker.messages.map((m) => m.operation), ['import', 'close'])
    worker.finish(worker.messages[0].id, {cancelledAfterCommit: true})
    assert.equal((await importing).value.cancelledAfterCommit, true)
    worker.finish(worker.messages[1].id)
    await closing
    assert.equal(worker.terminated, true)
}))
test('close is bounded even when the active importer will not settle', () => scenario(async ({client, worker, clock}) => {
    const importing = observe(client.importDictionary(new Blob(['x'])))
    const closing = observe(client.close())
    clock.advance(60_001)
    assert.equal(worker.terminated, true)
    assert.equal((await closing).error.code, 'worker_timeout')
    assert.equal((await importing).error.code, 'worker_timeout')
}))
test('admission queue is bounded independently of executing work', () => scenario(async ({client, worker}) => {
    const importing = observe(client.importDictionary(new Blob(['x'])))
    const waiting = Array.from({length: 32}, () => observe(client.status()))
    assert.equal((await observe(client.status())).error.code, 'busy')
    const closing = client.close()
    await Promise.all(waiting)
    worker.finish(worker.messages[0].id)
    worker.finish(worker.messages[1].id)
    await Promise.all([importing, closing])
}))
