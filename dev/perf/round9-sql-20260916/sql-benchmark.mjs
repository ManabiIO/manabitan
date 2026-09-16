import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import JSZip from 'jszip'

const [aRoot, bRoot, cache, output] = process.argv.slice(2)
assert(aRoot && bRoot && cache && output)
const pairs = Number(process.env.PAIRS ?? 12)
const initialOrder = process.env.INITIAL_ORDER ?? 'BA'
assert(Number.isInteger(pairs) && pairs >= 4 && pairs <= 16)
assert(['AB', 'BA'].includes(initialOrder))
await mkdir(output, {recursive: true})
const sqlite = await sqlite3InitModule()
const A = (await import(pathToFileURL(path.join(aRoot, 'ext/js/dictionary/dictionary-database.js')).href)).DictionaryDatabase
const B = (await import(pathToFileURL(path.join(bRoot, 'ext/js/dictionary/dictionary-database.js')).href)).DictionaryDatabase
const reports = []
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const identities = {}
for (const [arm, root] of [['A', aRoot], ['B', bRoot]]) {
    identities[arm] = {}
    for (const file of ['ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-record-opfs-store.js', 'test/perf/dictionaries.lock.json']) {
        identities[arm][file] = sha(await readFile(path.join(root, file)))
    }
}
const persist = async () => writeFile(path.join(output, 'sql-results.json'), JSON.stringify({
    kind: 'Real SQLite-WASM query components, not full browser imports', node: process.version,
    sqlite: sqlite.capi.sqlite3_libversion(), pairs, initialOrder, retries: 0, outlierRemoval: false,
    identities, reports,
}, null, 2))

async function compare(label, execute, expected, details) {
    const plan = []
    for (const arm of initialOrder) { plan.push({kind: 'warmup', pair: 0, arm, binary: arm}) }
    for (let pair = 1; pair <= pairs; ++pair) {
        const order = pair % 2 ? initialOrder : [...initialOrder].reverse().join('')
        for (const arm of order) { plan.push({kind: 'measured', pair, arm, binary: arm}) }
        if (pair % 2 === 0) {
            for (const arm of pair % 4 ? 'AB' : 'BA') { plan.push({kind: 'aa', pair: pair / 2, arm, binary: 'A'}) }
        }
    }
    const report = {label, ...details, plan, observations: [], complete: false}
    reports.push(report)
    await persist()
    for (const item of plan) {
        const start = performance.now()
        const result = await execute(item.binary)
        const ms = performance.now() - start
        assert.deepEqual(result, expected, `${label}: ${JSON.stringify(item)}`)
        report.observations.push({...item, ms})
    }
    report.complete = true
    await persist()
    const changes = []
    for (let pair = 1; pair <= pairs; ++pair) {
        const a = report.observations.find((v) => v.kind === 'measured' && v.pair === pair && v.arm === 'A').ms
        const b = report.observations.find((v) => v.kind === 'measured' && v.pair === pair && v.arm === 'B').ms
        changes.push(100 * (b / a - 1))
    }
    changes.sort((a, b) => a - b)
    console.log(JSON.stringify({label, pairedMedianPercent: (changes[Math.floor((pairs - 1) / 2)] + changes[Math.floor(pairs / 2)]) / 2}))
}

// Synthetic side tables isolate count refresh. Indexed configurations explicitly
// set the same runtime option which preserves indexed equality queries.
const tables = ['kanji', 'kanjiMeta', 'termMeta', 'tagMeta', 'media']
for (const rowsPerTable of [256, 32768]) {
    for (const [dictionaryCount, indexed] of [[1, false], [2, false], [4, false], [8, false], [16, false], [8, true]]) {
        const db = new sqlite.oo1.DB(':memory:')
        try {
            db.exec('CREATE TABLE dictionaries(title TEXT, summaryJson TEXT)')
            const names = Array.from({length: dictionaryCount}, (_, i) => `dict-${i}`)
            for (const name of names) {
                db.exec({sql: 'INSERT INTO dictionaries VALUES(?, ?)', bind: [name, JSON.stringify({counts: {terms: {total: 20000}}})]})
            }
            for (const table of tables) {
                db.exec(`CREATE TABLE ${table}(dictionary TEXT NOT NULL)`)
                db.exec(`WITH RECURSIVE c(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM c WHERE x<${rowsPerTable - 1}) INSERT INTO ${table} SELECT 'dict-'||(x % ${dictionaryCount}) FROM c`)
                if (indexed) { db.exec(`CREATE INDEX idx_${table} ON ${table}(dictionary)`) }
            }
            const arms = {A: new A(), B: new B()}
            for (const database of Object.values(arms)) {
                Reflect.set(database, '_db', db)
                Reflect.set(database, '_enableSqliteSecondaryIndexes', indexed)
            }
            const total = {terms: dictionaryCount * 20000}
            for (const table of tables) { total[table] = rowsPerTable }
            const counts = names.map((_, i) => {
                const result = {terms: 20000}
                for (const table of tables) { result[table] = Math.floor(rowsPerTable / dictionaryCount) + (i < rowsPerTable % dictionaryCount ? 1 : 0) }
                return result
            })
            await compare(`counts-${rowsPerTable}-${dictionaryCount}-${indexed ? 'indexed' : 'unindexed'}`,
                (arm) => arms[arm].getDictionaryCounts(names, true), {total, counts},
                {workload: 'synthetic side-table count refresh', rowsPerTable, dictionaryCount, indexed})
        } finally { db.close() }
    }
}

// Seed resident term metadata from both complete locked archives. ZIP decoding,
// record construction, and expected-result counting are outside query timers.
// This does not represent import, OPFS residency loading, or interactive lookup.
const lock = JSON.parse(await readFile(path.join(aRoot, 'test/perf/dictionaries.lock.json'), 'utf8'))
const termArms = {}
for (const [arm, Type] of [['A', A], ['B', B]]) {
    const database = new Type()
    const db = new sqlite.oo1.DB(':memory:')
    Reflect.set(database, '_db', db)
    Reflect.set(database, '_sqlite3', sqlite)
    database._registerTermsVirtualTableModule()
    db.exec('CREATE VIRTUAL TABLE terms USING manabitan_terms')
    termArms[arm] = {database, db, store: Reflect.get(database, '_termRecordStore')}
}
const fixtures = []
let id = 1
try {
    for (const key of ['jmdict', 'jitendex']) {
        const entry = lock.dictionaries[key]
        const bytes = await readFile(path.join(cache, entry.cacheFile))
        assert.equal(sha(bytes), entry.sha256)
        const archive = await JSZip.loadAsync(bytes)
        const index = JSON.parse(await archive.file('index.json').async('string'))
        assert.equal(index.title, entry.expectedTitle)
        assert.equal(index.revision, entry.revision)
        const bankNames = Object.keys(archive.files).filter((name) => /^term_bank_\d+\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        let rows = 0
        let expression = null
        let sequence = null
        let expressionMatches = 0
        let sequenceMatches = 0
        for (const name of bankNames) {
            const bank = JSON.parse(await archive.file(name).async('string'))
            for (const row of bank) {
                if (expression === null && typeof row[0] === 'string' && row[0].length > 0) { expression = row[0] }
                if (sequence === null && Number.isSafeInteger(row[6]) && row[6] >= 0) { sequence = row[6] }
                if (row[0] === expression) { ++expressionMatches }
                if (row[6] === sequence) { ++sequenceMatches }
                const record = {id, dictionary: index.title, expression: row[0], reading: row[1], sequence: row[6] ?? null,
                    expressionReverse: null, readingReverse: null, entryContentOffset: -1, entryContentLength: -1,
                    entryContentDictName: 'raw', score: row[4] ?? 0}
                for (const value of Object.values(termArms)) { value.store._storeRecord({...record}) }
                ++id
                ++rows
            }
        }
        assert.equal(rows, entry.termRows)
        assert(expression !== null && sequence !== null)
        fixtures.push({key, title: index.title, rows, expression, sequence, expressionMatches, sequenceMatches, archiveSha256: entry.sha256})
    }
    for (const f of fixtures) {
        const queries = [
            ['expression', 'dictionary = ?1 AND expression = ?2', [f.title, f.expression], f.expressionMatches],
            ['sequence', 'dictionary = ?1 AND sequence = ?2', [f.title, f.sequence], f.sequenceMatches],
            ['dictionary-count', 'dictionary = ?1', [f.title], f.rows],
        ]
        for (const [name, where, bindings, expected] of queries) {
            const sql = `SELECT COUNT(*) FROM terms WHERE ${where}`
            const statements = Object.fromEntries(Object.entries(termArms).map(([arm, value]) => [arm, value.db.prepare(sql)]))
            try {
                await compare(`terms-${f.key}-${name}`, (arm) => {
                    const statement = statements[arm]
                    statement.bind(bindings)
                    try { assert(statement.step()); return statement.get(0) } finally { statement.reset() }
                }, expected, {workload: 'resident full-corpus metadata query', fixture: f, totalResidentRows: id - 1,
                    sql, bindings, expectedCount: expected})
            } finally { for (const statement of Object.values(statements)) { statement.finalize() } }
        }
    }
} finally {
    for (const value of Object.values(termArms)) {
        value.db.close()
        Reflect.get(value.database, '_termsVtabModule')?.dispose()
    }
}
await persist()
await writeFile(path.join(output, 'sql-complete.json'), JSON.stringify({status: 'success', completed: reports.length, planned: 18}))
