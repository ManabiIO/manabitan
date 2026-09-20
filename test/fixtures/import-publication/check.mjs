/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

// Execute the production finalizer with a real SQLite engine. In a complete
// checkout its method is extracted directly, avoiding the extension's WASM
// initialization. Local review capsules pass an explicit source excerpt.
const [rootArg = '.', outputArg, excerptArg] = process.argv.slice(2)
const root = path.resolve(rootArg)
const {DictionaryImportSession} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/dictionary-import-session.js')).href)
const {toError} = await import(pathToFileURL(path.join(root, 'ext/js/core/to-error.js')).href)
const sourcePath = excerptArg ? path.resolve(excerptArg) : path.join(root, 'ext/js/dictionary/dictionary-database.js')
let source = await readFile(sourcePath, 'utf8')
if (!excerptArg) {
    const start = source.indexOf('    async finishBulkImport(')
    const end = source.indexOf('\n    /**', start + 1)
    assert(start >= 0 && end > start, 'Production finalizer was not found')
    source = source.slice(start, end).trimEnd() + '\n'
}
const diagnostics = []
let logFailure = null
const Finalizer = new Function('safePerformance', 'toError', 'reportDiagnostics', 'log', `return class Finalizer {\n${source}\n}`)(
    performance, toError, (...args) => { diagnostics.push(args) },
    {log: () => { if (logFailure) { throw logFailure } }},
)
const cases = []
const unhandled = []
process.on('unhandledRejection', (error) => { unhandled.push(String(error)) })
const workDir = await mkdtemp(path.join(tmpdir(), 'manabitan-publication-'))
const names = ['A', ' A ', '日本語辞典']
let serial = 0
function deferred() {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return {promise, resolve}
}
function flatten(error) {
    return error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]
}
async function run(name, fn) {
    try { await fn(); cases.push({name, status: 'passed'}) }
    catch (error) { cases.push({name, status: 'failed', message: error.message, stack: error.stack}) }
}

function createHarness(fault = {}, title = 'A') {
    const file = path.join(workDir, `${++serial}.sqlite`)
    const sql = new DatabaseSync(file)
    sql.exec('CREATE TABLE dictionaries (id INTEGER PRIMARY KEY, title TEXT, published INTEGER); CREATE TABLE dictionaryImportPublications (sessionId TEXT PRIMARY KEY, publishedAt INTEGER)')
    sql.prepare('INSERT INTO dictionaries VALUES (?, ?, 0)').run(1, title)
    const owner = new Finalizer()
    const errors = []
    const trace = []
    const injected = new Error(`injected:${Object.keys(fault).join(',') || 'none'}`)
    let closed = false
    const readRows = () => sql.prepare('SELECT id, title, published FROM dictionaries ORDER BY id').all().map((x) => ({...x}))
    const transport = {
        exec(input) {
            const text = typeof input === 'string' ? input : input.sql
            trace.push(text)
            if ((text === 'COMMIT' && fault.commit) || (text.startsWith('INSERT OR REPLACE') && fault.marker)) { throw injected }
            if (typeof input === 'string') { sql.exec(input) }
            else { sql.prepare(text).run(...input.bind) }
        },
    }
    Object.assign(owner, {
        _bulkImportTransactionOpen: false,
        _bulkImportJournalRecord: null,
        _termsVirtualTableDirty: Boolean(fault.vtab),
        _importDebugLogging: Boolean(fault.log),
        _importJournalRecoveryPending: false,
        _waitForBulkImportSetup: async () => {},
        _beginBulkImportFinalization: () => transport,
        _endBulkImportLifecycle: () => { trace.push('idle') },
        _termContentStore: {
            endImportSession: async () => { trace.push('content-finalized'); if (fault.content) { throw injected } },
            getLastEndImportSessionMetrics: () => null,
        },
        _termRecordStore: {
            endImportSession: async () => { trace.push('records-finalized'); if (fault.records) { throw injected } },
            getLastEndImportSessionMetrics: () => null,
        },
        _syncTermsVirtualTableFromRecordStore: async () => { if (fault.vtab) { throw injected } },
        _termContentBlockStore: {getDiagnostics: () => { if (fault.metrics) { throw injected }; return {compressionExperiments: {}} }},
        _createIndexesSql: () => fault.checkpoint ? ['SELECT 1'] : [],
        _importJournal: {clear: async () => {
            trace.push('journal-clear')
            fault.entered?.resolve()
            if (fault.gate) { await fault.gate.promise }
            if (fault.journal) { throw injected }
        }},
        _deleteImportPublicationMarkerBestEffort: (id) => { sql.prepare('DELETE FROM dictionaryImportPublications WHERE sessionId = ?').run(id) },
        _clearBulkImportRuntimeCaches: () => { trace.push('cache-reset'); if (fault.cache) { throw injected } },
        _applyRuntimePragmas: () => { trace.push('runtime-pragmas'); if (fault.pragmas) { throw injected } },
        _closeBulkImportBlockSession: (collection) => { trace.push('block-close'); if (fault.blockClose) { collection.push(injected) } },
        _restoreRuntimeAfterBulkImportFailure: (_, collection) => {
            trace.push('restore-runtime')
            if (fault.restore) { collection.push(new Error('injected:restore')) }
        },
        _rollbackBulkImportSqlite: (_, collection) => {
            if (!owner._bulkImportTransactionOpen) { return true }
            try { transport.exec('ROLLBACK') } catch (error) { collection.push(error); return false }
            owner._bulkImportTransactionOpen = false
            return true
        },
        _rollbackBulkImport: async (_, collection) => {
            trace.push('rollback-opfs')
            const result = owner._rollbackBulkImportSqlite(null, collection)
            owner._bulkImportJournalRecord = null
            return result
        },
        _endBulkImportStoreSessions: async (_, content, records) => { trace.push(`end-extra:${content}:${records}`) },
        _quarantineBulkImportConnection: () => { trace.push('quarantine') },
        bulkUpdate: async (_, rows) => {
            if (fault.summary) { throw injected }
            sql.prepare('UPDATE dictionaries SET title = ?, published = 1 WHERE id = ?').run(rows[0].data.title, rows[0].primaryKey)
        },
        startBulkImport: async () => {
            trace.push('start')
            sql.exec('BEGIN IMMEDIATE')
            owner._bulkImportTransactionOpen = true
            owner._bulkImportJournalRecord = {sessionId: 'session-1'}
            if (fault.setup) { throw injected }
        },
        abortBulkImport: async () => {
            trace.push('abort')
            owner._rollbackBulkImportSqlite(null, [])
            owner._bulkImportJournalRecord = null
        },
        deleteDictionary: async (name) => {
            trace.push('delete-dictionary')
            sql.prepare('DELETE FROM dictionaries WHERE title = ?').run(name)
        },
        deleteDictionaryImportPlaceholder: async (id) => {
            trace.push('delete-placeholder')
            sql.prepare('DELETE FROM dictionaries WHERE id = ? AND published = 0').run(id)
        },
    })
    const session = new DictionaryImportSession({
        dictionaryDatabase: owner, dictionaryTitle: title, dictionarySummaryPrimaryKey: 1, errors,
        archiveReader: {close: async () => { trace.push('archive-close'); if (fault.archive) { throw injected } }},
        disposeParser: async () => { trace.push('parser-dispose'); if (fault.parser) { throw injected } },
    })
    session.setSourcePipeline({dispose: async () => { trace.push('source-dispose'); if (fault.source) { throw injected } }})
    if (fault.log) { logFailure = injected }
    const summary = {title, revision: 'test', sequenced: true}
    const finish = () => session.finalizeBulkImport(() => { if (fault.checkpoint) { throw injected } }, summary)
    function reopenRows() {
        const reopened = new DatabaseSync(file, {readOnly: true})
        try { return reopened.prepare('SELECT id, title, published FROM dictionaries ORDER BY id').all().map((x) => ({...x})) }
        finally { reopened.close() }
    }
    return {owner, sql, session, errors, trace, injected, finish, summary, readRows, reopenRows, close() { if (!closed) { closed = true; logFailure = null; sql.close() } }}
}

try {
    for (const title of names) {
        for (const location of ['pragmas', 'cache', 'metrics', 'blockClose', 'log']) {
            await run(`published ${JSON.stringify(title)} survives ${location} failure`, async () => {
                const h = createHarness({[location]: true}, title)
                try {
                    await h.session.startBulkImport()
                    const p1 = h.finish()
                    assert.equal(h.finish(), p1, 'Finalization promise must be shared')
                    const result = await p1
                    const committed = [{id: 1, title, published: 1}]
                    assert.deepEqual(h.reopenRows(), committed, 'COMMIT must be durable before cleanup')
                    assert.equal(result, null, 'The cleanup failure must not be hidden')
                    await h.session.cleanupIncompleteSummary()
                    await h.session.cleanupIncompleteSummary()
                    assert.deepEqual(h.reopenRows(), committed, 'Cleanup deleted a successfully committed dictionary')
                    assert.equal(h.session.state, 'published')
                    assert.equal(h.session.failed, true)
                    assert(h.errors.flatMap(flatten).includes(h.injected), 'Original error identity must survive')
                    assert(!h.trace.includes('rollback-opfs'))
                    assert(!h.trace.includes('delete-dictionary'))
                    assert.equal(h.trace.filter((x) => x === 'COMMIT').length, 1)
                } finally { h.close() }
            })
        }
    }
    for (const location of ['content', 'records', 'vtab', 'summary', 'marker', 'commit', 'checkpoint']) {
        await run(`pre-publication ${location} failure still rolls back`, async () => {
            const h = createHarness({[location]: true})
            try {
                await h.session.startBulkImport()
                assert.equal(await h.finish(), null)
                assert.equal(h.session.state, 'failed')
                assert(h.errors.flatMap(flatten).includes(h.injected))
                assert(h.trace.includes('rollback-opfs'))
                assert(h.reopenRows().every((x) => x.published === 0))
                await h.session.cleanupIncompleteSummary()
                assert.deepEqual(h.reopenRows(), [])
                assert(h.trace.includes('delete-dictionary'))
            } finally { h.close() }
        })
    }
    for (const location of ['source', 'parser', 'archive', 'setup']) {
        await run(`${location} failure aborts before committing`, async () => {
            const h = createHarness({[location]: true})
            try {
                await h.session.startBulkImport().catch(() => {})
                assert.deepEqual(await h.finish(), {aborted: true})
                assert.equal(h.session.state, 'aborted')
                await h.session.cleanupIncompleteSummary()
                assert.deepEqual(h.reopenRows(), [])
                assert(!h.trace.includes('COMMIT'))
                assert(h.trace.includes('delete-placeholder'))
            } finally { h.close() }
        })
    }
    for (const fault of [{}, {journal: true}, {pragmas: true, restore: true}, {cache: true, restore: true}, {journal: true, metrics: true}]) {
        await run(`publication control ${JSON.stringify(fault)}`, async () => {
            const h = createHarness(fault)
            try {
                await h.session.startBulkImport()
                await h.finish()
                await h.session.cleanupIncompleteSummary()
                assert.deepEqual(h.reopenRows(), [{id: 1, title: 'A', published: 1}])
                assert.equal(h.session.state, 'published')
                if (fault.restore) { assert(h.errors[0] instanceof AggregateError); assert.equal(h.errors[0].errors.length, 2) }
                if (fault.journal) { assert.equal(h.owner._importJournalRecoveryPending, true) }
                if (Object.keys(fault).length === 0 || (fault.journal && !fault.metrics)) { assert.equal(h.session.failed, false) }
            } finally { h.close() }
        })
    }
    await run('publication is acknowledged before journal cleanup yields', async () => {
        const entered = deferred()
        const gate = deferred()
        const h = createHarness({entered, gate, pragmas: true})
        try {
            await h.session.startBulkImport()
            const pending = h.finish()
            await entered.promise
            const stateAtCommit = h.session.state
            const rowsAtCommit = h.reopenRows()
            gate.resolve()
            await pending
            assert.deepEqual(rowsAtCommit, [{id: 1, title: 'A', published: 1}])
            assert.equal(stateAtCommit, 'published')
            await h.session.cleanupIncompleteSummary()
            assert.equal(h.reopenRows().length, 1)
        } finally { gate.resolve(); h.close() }
    })
    await run('direct finalizer without callback retains original success contract', async () => {
        const h = createHarness()
        try {
            await h.owner.startBulkImport()
            const result = await h.owner.finishBulkImport(null, {summary: h.summary, primaryKey: 1})
            assert(result !== null)
            assert.equal(h.reopenRows()[0].published, 1)
        } finally { h.close() }
    })
    await run('late failure after acknowledged publication does not delete', async () => {
        const h = createHarness()
        try {
            await h.session.startBulkImport()
            await h.finish()
            h.session.recordFailure(new Error('late cancellation'))
            await h.session.cleanupIncompleteSummary()
            assert.equal(h.reopenRows()[0].published, 1)
            assert.equal(h.session.state, 'published')
        } finally { h.close() }
    })
    await new Promise((resolve) => setImmediate(resolve))
    const result = {sourcePath, methodSha256: createHash('sha256').update(source).digest('hex'), runtime: process.version,
        sqlite: 'node:sqlite, real on-disk SQLite; not repository sqlite-wasm',
        boundary: 'Full production session and extracted finalizer; other database helpers and OPFS stores are controlled doubles',
        passed: cases.filter((x) => x.status === 'passed').length, failed: cases.filter((x) => x.status === 'failed').length, unhandled, cases}
    if (outputArg) { await mkdir(path.dirname(path.resolve(outputArg)), {recursive: true}); await writeFile(outputArg, JSON.stringify(result, null, 2)) }
    console.log(JSON.stringify({passed: result.passed, failed: result.failed, unhandled}))
    process.exitCode = result.failed > 0 || unhandled.length > 0 ? 1 : 0
} finally { await rm(workDir, {recursive: true, force: true}) }
