/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const root = process.env.MANABITAN_TEST_ROOT ?
    pathToFileURL(`${path.resolve(process.env.MANABITAN_TEST_ROOT)}${path.sep}`) :
    new URL('../../../', import.meta.url)
const {DictionaryImportJournal} = await import(new URL('ext/js/dictionary/dictionary-import-journal.js', root))
const {DictionaryImportSession} = await import(new URL('ext/js/dictionary/dictionary-import-session.js', root))
const deferred = () => {
    let resolve
    const promise = new Promise((r) => { resolve = r })
    return {promise, resolve}
}
const flush = async () => {
    for (let i = 0; i < 80; ++i) { await Promise.resolve() }
}
const record = (sessionId = 'A') => ({
    version: 1, sessionId, createdAt: 1,
    contentCheckpoint: {segments: [{fileName: 'content-0', fileLength: 4}]},
    recordCheckpoint: {shards: [{fileName: 'record-0', fileLength: 8}]},
})

// Only the filesystem boundary is replaced. Writes publish on close and each
// getFile call returns its captured snapshot, not the latest mutable contents.
function journalFixture(initial = JSON.stringify(record('old'))) {
    let contents = initial
    const hooks = {}
    const missing = () => new DOMException('Missing', 'NotFoundError')
    const handle = {
        async getFile() {
            if (contents === null) { throw missing() }
            const snapshot = new Blob([contents])
            await hooks.snapshot?.()
            return snapshot
        },
        async createWritable() {
            let staged = ''
            return {
                async write(value) { await hooks.write?.(); staged = value },
                async close() { await hooks.close?.(); contents = staged },
                async abort() {},
            }
        },
    }
    const directory = {
        async getFileHandle(_name, {create = false} = {}) {
            if (contents === null) {
                if (!create) { throw missing() }
                contents = ''
            }
            return handle
        },
        async removeEntry() {
            await hooks.remove?.()
            if (contents === null) { throw missing() }
            contents = null
        },
    }
    const journal = new DictionaryImportJournal()
    journal._getRoot = async () => directory
    return {journal, hooks, contents: () => contents}
}

for (const operation of ['write', 'clear', 'read']) {
    test(`journal ${operation} cannot overtake an earlier writer`, async () => {
        const f = journalFixture()
        const gate = deferred()
        const entered = deferred()
        f.hooks.close = async () => { delete f.hooks.close; entered.resolve(); await gate.promise }
        const first = f.journal.write(record('A'))
        await entered.promise
        let settled = false
        const second = (operation === 'write' ? f.journal.write(record('B')) : f.journal[operation]())
            .then((value) => { settled = true; return value })
        await flush()
        const overtook = settled
        gate.resolve()
        await first
        const result = await second
        assert.equal(overtook, false)
        if (operation === 'read') { assert.deepEqual(result, record('A')) }
        assert.deepEqual(await f.journal.read(), operation === 'clear' ? null : record(operation === 'write' ? 'B' : 'A'))
    })
}

test('empty-file cleanup does not delete a later journal write', async () => {
    const f = journalFixture('')
    const gate = deferred()
    const entered = deferred()
    f.hooks.snapshot = async () => { delete f.hooks.snapshot; entered.resolve(); await gate.promise }
    const reading = f.journal.read()
    await entered.promise
    const writing = f.journal.write(record('B'))
    await flush()
    gate.resolve()
    await Promise.all([reading, writing])
    assert.deepEqual(await f.journal.read(), record('B'))
})

test('delayed clear cannot delete its successor write', async () => {
    const f = journalFixture()
    const gate = deferred()
    const entered = deferred()
    f.hooks.remove = async () => { delete f.hooks.remove; entered.resolve(); await gate.promise }
    const clearing = f.journal.clear()
    await entered.promise
    const writing = f.journal.write(record('B'))
    await flush()
    gate.resolve()
    await Promise.all([clearing, writing])
    assert.deepEqual(await f.journal.read(), record('B'))
})

test('failed write preserves old bytes without poisoning later recovery', async () => {
    const f = journalFixture()
    const error = new Error('write failed')
    f.hooks.write = () => { throw error }
    await assert.rejects(f.journal.write(record()), (value) => value === error)
    assert.deepEqual(await f.journal.read(), record('old'))
    delete f.hooks.write
    await f.journal.write(record('recovered'))
    assert.deepEqual(await f.journal.read(), record('recovered'))
})

test('queued writes keep the checkpoint snapshot taken at invocation', async () => {
    const f = journalFixture()
    const gate = deferred()
    const entered = deferred()
    f.hooks.close = async () => { delete f.hooks.close; entered.resolve(); await gate.promise }
    const first = f.journal.write(record('A'))
    await entered.promise
    const value = record('B')
    const second = f.journal.write(value)
    value.sessionId = 'changed'
    value.contentCheckpoint.segments[0].fileLength = 0
    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(await f.journal.read(), record('B'))
})

function sessionFixture() {
    const events = []
    const errors = []
    const database = {
        async startBulkImport() { events.push('start'); return 'owner' },
        async finishBulkImport(_callback, publication, owner) {
            assert.equal(owner, 'owner')
            assert.equal(publication.primaryKey, 42)
            events.push('finish')
            return {committed: true}
        },
        async abortBulkImport(owner) { assert.equal(owner, 'owner'); events.push('abort') },
        async deleteDictionaryImportPlaceholder(key) { assert.equal(key, 42); events.push('cleanup') },
    }
    const options = {
        dictionaryDatabase: database, dictionaryTitle: 'A', dictionarySummaryPrimaryKey: 42, errors,
        archiveReader: {async close() { events.push('archive') }},
        disposeParser: async () => { events.push('parser') },
    }
    return {options, database, events, errors}
}
const summary = {title: 'A', importSuccess: true}

for (const boundary of ['source', 'parser']) {
    test(`reentrant ${boundary} disposal waits for its original operation`, async () => {
        const f = sessionFixture()
        const gate = deferred()
        let calls = 0
        let nested
        let session
        const dispose = async () => {
            if (++calls === 1) { nested = session.disposeImportResources(); await gate.promise }
        }
        if (boundary === 'parser') { f.options.disposeParser = dispose }
        session = new DictionaryImportSession(f.options)
        if (boundary === 'source') { session.setSourcePipeline({dispose}) }
        const outer = session.disposeImportResources()
        await flush()
        const closedEarly = f.events.includes('archive')
        gate.resolve()
        await Promise.all([outer, nested])
        assert.equal(nested, outer)
        assert.equal(calls, 1)
        assert.equal(closedEarly, false)
        assert.equal(f.events.filter((event) => event === 'archive').length, 1)
    })
}

test('reentrant start shares one acquired owner', async () => {
    const f = sessionFixture()
    let calls = 0
    let nested
    let session
    f.database.startBulkImport = async () => {
        if (++calls === 1) { nested = session.startBulkImport() }
        return 'owner'
    }
    session = new DictionaryImportSession(f.options)
    const outer = session.startBulkImport()
    await outer
    await nested
    assert.equal(nested, outer)
    assert.equal(calls, 1)
})

test('reentrant finalization cannot attempt publication twice', async () => {
    const f = sessionFixture()
    const session = new DictionaryImportSession(f.options)
    await session.startBulkImport()
    let nested
    let calls = 0
    session.setSourcePipeline({async dispose() {
        if (++calls === 1) { nested = session.finalizeBulkImport(() => {}, summary) }
    }})
    const outer = session.finalizeBulkImport(() => {}, summary)
    await outer
    await nested
    assert.equal(nested, outer)
    assert.equal(f.events.filter((event) => event === 'finish').length, 1)
    assert.equal(session.state, 'published')
})

test('disposal rejects installing a new source from a parser callback', async () => {
    const f = sessionFixture()
    let session
    let rejected = false
    f.options.disposeParser = async () => {
        try { session.setSourcePipeline({async dispose() {}}) } catch (_) { rejected = true }
    }
    session = new DictionaryImportSession(f.options)
    await session.disposeImportResources()
    assert.equal(rejected, true)
})

test('reentrant placeholder cleanup is single-flight', async () => {
    const f = sessionFixture()
    let calls = 0
    let nested
    let session
    f.database.deleteDictionaryImportPlaceholder = async () => {
        if (++calls === 1) { nested = session.cleanupIncompleteSummary() }
    }
    session = new DictionaryImportSession(f.options)
    session.recordFailure(new Error('cancelled'))
    const outer = session.cleanupIncompleteSummary()
    await outer
    await nested
    assert.equal(nested, outer)
    assert.equal(calls, 1)
})

test('an early cleanup no-op does not disable later cleanup', async () => {
    const f = sessionFixture()
    const session = new DictionaryImportSession(f.options)
    await session.cleanupIncompleteSummary()
    session.recordFailure(new Error('later failure'))
    await session.cleanupIncompleteSummary()
    assert.deepEqual(f.events, ['cleanup'])
})

test('immediate finalization joins a pending start and preserves ordering', async () => {
    const f = sessionFixture()
    const session = new DictionaryImportSession(f.options)
    session.setSourcePipeline({async dispose() { f.events.push('source') }})
    const start = session.startBulkImport()
    const finish = session.finalizeBulkImport(() => {}, summary)
    await start
    assert.deepEqual(await finish, {committed: true})
    assert.deepEqual(f.events, ['start', 'source', 'parser', 'archive', 'finish'])
})

test('a rejected start cannot abort another database owner', async () => {
    const f = sessionFixture()
    const error = new Error('busy')
    f.database.startBulkImport = async () => { throw error }
    const session = new DictionaryImportSession(f.options)
    await assert.rejects(session.startBulkImport(), (value) => value === error)
    await session.finalizeBulkImport(() => {}, summary)
    assert.equal(f.events.includes('abort'), false)
    assert.equal(f.events.includes('finish'), false)
    assert.deepEqual(f.errors, [error])
})

test('published summaries survive late failures', async () => {
    const f = sessionFixture()
    const session = new DictionaryImportSession(f.options)
    await session.startBulkImport()
    await session.finalizeBulkImport(() => {}, summary)
    session.recordFailure(new Error('late observer'))
    await session.cleanupIncompleteSummary()
    assert.equal(f.events.includes('cleanup'), false)
})
