/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {writeFile, readFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createNodeOpfs} from './node-opfs-adapter.mjs'

const [rootArg = '.', output, model = 'terminal'] = process.argv.slice(2)
// eslint-disable-next-line no-unsanitized/method -- The test runner imports production source from the explicitly supplied checkout path.
const {DictionaryImportJournal} = await import(pathToFileURL(path.resolve(rootArg, 'ext/js/dictionary/dictionary-import-journal.js')).href)
const filename = 'manabitan-dictionary-import-journal.json'
const makeRecord = () => ({
    version: 1,
    sessionId: 'session-α',
    createdAt: 1789921902000,
    contentCheckpoint: {segments: [{fileName: 'segment-0.bin', fileLength: 20}]},
    recordCheckpoint: {
        shards: [
            {fileName: 'records-A.bin', fileLength: 40},
            {fileName: 'index-A.bin', fileLength: 60},
        ],
    },
})
const cases = []
const unhandled = []
process.on('unhandledRejection', (e) => {
    unhandled.push(String(e))
})
async function run(name, fn) {
    const fs = await createNodeOpfs({terminalWriteErrors: model === 'terminal'})
    const journal = new DictionaryImportJournal()
    journal._getRoot = async () => fs.root
    try {
        await fn(journal, fs)
        cases.push({name, status: 'passed'})
    } catch (e) {
        cases.push({name, status: 'failed', message: e.message, stack: e.stack})
    } finally {
        await fs.dispose()
    }
}
const mutations = {
    'shortened content prefix': (r) => {
        r.contentCheckpoint.segments[0].fileLength = 0
    },
    'removed content inventory': (r) => {
        r.contentCheckpoint.segments.length = 0
    },
    'removed record inventory': (r) => {
        r.recordCheckpoint.shards.splice(0)
    },
    'replaced record inventory': (r) => {
        r.recordCheckpoint = {shards: []}
    },
    'changed record file identity': (r) => {
        r.recordCheckpoint.shards[0].fileName = 'different.bin'
    },
    'changed session identity': (r) => {
        r.sessionId = 'different-session'
    },
    'invalid length after validation': (r) => {
        r.recordCheckpoint.shards[0].fileLength = -1
    },
    'duplicate name after validation': (r) => {
        r.recordCheckpoint.shards.push({...r.recordCheckpoint.shards[0]})
    },
}
for (const boundary of ['root', 'handle', 'writable']) {
    for (const [description, mutate] of Object.entries(mutations)) {
        await run(`${boundary}: snapshot survives ${description}`, async (journal, fs) => {
            const record = makeRecord()
            const expected = structuredClone(record)
            if (boundary === 'root') {
                journal._getRoot = async () => {
                    mutate(record)
                    return fs.root
                }
            } else if (boundary === 'handle') {
                fs.hooks.beforeGetFileHandle = () => {
                    mutate(record)
                }
            } else {
                fs.hooks.beforeCreateWritable = () => {
                    mutate(record)
                }
            }
            await journal.write(record)
            assert.deepEqual(JSON.parse(await readFile(path.join(fs.rootPath, filename), 'utf8')), expected, 'Persisted recovery instructions changed after validation')
        })
    }
}
for (const converted of [null, {}, {version: 2}, {...makeRecord(), sessionId: ''}, {...makeRecord(), recordCheckpoint: {shards: [null]}}]) {
    await run(`reject invalid serialized value ${JSON.stringify(converted)}`, async (journal, fs) => {
        const old = makeRecord()
        await journal.write(old)
        fs.operations.length = 0
        let rootCalls = 0
        journal._getRoot = async () => {
            rootCalls++
            return fs.root
        }
        const record = makeRecord()
        record.toJSON = () => converted
        await assert.rejects(journal.write(record))
        assert.equal(rootCalls, 0, 'Invalid serialized state must not acquire filesystem access')
        assert.equal(fs.operations.length, 0)
        assert.deepEqual(JSON.parse(await readFile(path.join(fs.rootPath, filename), 'utf8')), old)
    })
}
for (const failure of ['cycle', 'throw']) {
    await run(`serialization ${failure} rejects before opening a writable`, async (journal, fs) => {
        const record = makeRecord()
        if (failure === 'cycle') {
            record.extra = record
        } else {
            record.toJSON = () => {
                throw new Error('serialization failed')
            }
        }
        await assert.rejects(journal.write(record))
        assert.deepEqual(fs.operations, [])
    })
}
for (const location of ['beforeWrite', 'beforeClose']) {
    await run(`${location} failure preserves prior committed journal`, async (journal, fs) => {
        const old = makeRecord()
        await journal.write(old)
        const injected = new Error(location)
        fs.hooks[location] = () => {
            throw injected
        }
        const next = makeRecord()
        next.sessionId = 'next'
        await assert.rejects(journal.write(next), (e) => e === injected)
        assert.deepEqual(JSON.parse(await readFile(path.join(fs.rootPath, filename), 'utf8')), old)
        assert(fs.operations.some((x) => x.type === 'abort'))
    })
}
await run('write and abort failures retain both causes', async (journal, fs) => {
    const a = new Error('write')
    const b = new Error('abort')
    fs.hooks.beforeWrite = () => {
        throw a
    }
    fs.hooks.beforeAbort = () => {
        throw b
    }
    await assert.rejects(journal.write(makeRecord()), (e) => e instanceof AggregateError && e.errors[0] === a && e.errors[1] === b)
})
await run('ordinary write/read/clear round trip', async (journal) => {
    assert.equal(await journal.read(), null)
    const record = makeRecord()
    await journal.write(record)
    assert.deepEqual(await journal.read(), record)
    await journal.clear()
    await journal.clear()
    assert.equal(await journal.read(), null)
})
await run('empty journal is removable before import mutation', async (journal, fs) => {
    await writeFile(path.join(fs.rootPath, filename), '')
    assert.equal(await journal.read(), null)
    assert(fs.operations.some((x) => x.type === 'remove'))
})
await run('unreadable journal is not treated as missing', async (journal, fs) => {
    const e = new DOMException('busy', 'NotReadableError')
    fs.hooks.beforeGetFileHandle = () => {
        throw e
    }
    await assert.rejects(journal.read(), (error) => error === e)
    assert(!fs.operations.some((x) => x.type === 'remove'))
})
await run('malformed committed journal remains available for diagnosis', async (journal, fs) => {
    await writeFile(path.join(fs.rootPath, filename), '{"broken":')
    await assert.rejects(journal.read())
    assert.equal(await readFile(path.join(fs.rootPath, filename), 'utf8'), '{"broken":')
})
for (const mutate of [
    (r) => {
        r.version = 2
    },
    (r) => {
        r.sessionId = ''
    },
    (r) => {
        r.createdAt = Number.NaN
    },
    (r) => {
        r.contentCheckpoint.segments = new Array(1)
    },
    (r) => {
        r.recordCheckpoint.shards[0].fileLength = Number.MAX_SAFE_INTEGER + 1
    },
    (r) => {
        r.contentCheckpoint.segments[0].fileName = '../invalid'
    },
]) {
    await run(`invalid admission control ${mutate.toString()}`, async (journal, fs) => {
        const record = makeRecord()
        mutate(record)
        await assert.rejects(journal.write(record))
        assert.equal(fs.operations.length, 0)
    })
}
await run('OPFS unavailable preserves existing read/write contract', async (journal) => {
    journal._getRoot = async () => null
    assert.equal(await journal.read(), null)
    await assert.rejects(journal.write(makeRecord()), /requires OPFS/)
    await assert.rejects(journal.clear(), /requires OPFS/)
})
await new Promise((r) => {
    setImmediate(r)
})
const result = {
    runtime: process.version,
    model,
    boundary: 'Production journal with commit-on-close temporary-file adapter, not native OPFS',
    passed: cases.filter((x) => x.status === 'passed').length,
    failed: cases.filter((x) => x.status === 'failed').length,
    cases,
    unhandled,
}
if (output) {
    await mkdir(path.dirname(path.resolve(output)), {recursive: true})
    await writeFile(output, JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({passed: result.passed, failed: result.failed, unhandled}))
process.exitCode = result.failed > 0 || unhandled.length > 0 ? 1 : 0
