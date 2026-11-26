import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const [baselineArgument, candidateArgument, fixtureArgument, outputArgument] = process.argv.slice(2)
if (!baselineArgument || !candidateArgument || !fixtureArgument || !outputArgument) {
    throw new Error('Usage: node catalog-independent-review.mjs BASELINE_ROOT CANDIDATE_ROOT FIXTURE_DIR OUTPUT_JSON')
}
const baselineRoot = path.resolve(baselineArgument)
const candidateRoot = path.resolve(candidateArgument)
const fixtureDir = path.resolve(fixtureArgument)
const importerPath = 'ext/js/dictionary/dictionary-importer.js'
const lockPath = 'test/perf/dictionaries.lock.json'
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashFile = async (file) => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
}
const source = async (root) => ({
    root,
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    importerSha256: await hashFile(path.join(root, importerPath)),
    lockSha256: await hashFile(path.join(root, lockPath)),
})
const baselineSource = await source(baselineRoot)
const candidateSource = await source(candidateRoot)
const {DictionaryImporter: Baseline} = await import(pathToFileURL(path.join(baselineRoot, importerPath)))
const {DictionaryImporter: Candidate} = await import(pathToFileURL(path.join(candidateRoot, importerPath)))
const baselineMethod = Baseline.prototype._getArchiveFiles
const candidateMethod = Candidate.prototype._getArchiveFiles
const locks = JSON.parse(await readFile(path.join(baselineRoot, lockPath), 'utf8')).dictionaries
const queries = () => [
    ['termFiles', /^term_bank_(\d+)\.json$/],
    ['termArtifactFiles', /^term_bank_(\d+)\.mbtb$/],
    ['termMetaFiles', /^term_meta_bank_(\d+)\.json$/],
    ['kanjiFiles', /^kanji_bank_(\d+)\.json$/],
    ['kanjiMetaFiles', /^kanji_meta_bank_(\d+)\.json$/],
    ['tagFiles', /^tag_bank_(\d+)\.json$/],
]
const receipt = {
    purpose: 'Correctness and deterministic regex work comparison only; no timing or whole-import performance claim',
    node: process.version,
    baselineSource,
    candidateSource,
    runnerSha256: await hashFile(new URL(import.meta.url)),
    cases: [],
}
const checkCase = (name, names) => {
    const files = new Map(names.map((filename, index) => [filename, {filename, index}]))
    const expected = baselineMethod.call({}, files, queries())
    const actual = candidateMethod.call({}, files)
    assert.deepEqual(actual, expected)
    assert.deepEqual(candidateMethod.call({}, files, undefined), expected)
    assert.deepEqual(candidateMethod.call({}, files, queries()), expected)
    assert.deepEqual(candidateMethod.call({}, files, queries().slice(0, 2)), baselineMethod.call({}, files, queries().slice(0, 2)))
    const custom = () => [['images', /^(.+)\.png$/], ['terms', /^term_bank_(\d+)\.json$/]]
    assert.deepEqual(candidateMethod.call({}, files, custom()), baselineMethod.call({}, files, custom()))
    for (const [kind, rows] of actual) {
        rows.forEach((row, index) => assert.equal(row, expected.get(kind)[index]))
    }
    const skippedEntries = [...files.keys()].filter((filename) => !filename.startsWith('t') && !filename.startsWith('k')).length
    const result = {
        name,
        files: files.size,
        classified: Object.fromEntries([...actual].map(([key, rows]) => [key, rows.length])),
        orderedOutputSha256: hashBytes(JSON.stringify([...actual].map(([key, rows]) => [key, rows.map((row) => row.filename)]))),
        skippedEntries,
        builtinRegexTestsAvoided: 6 * skippedEntries,
        defaultExplicitUndefinedCustomAndPrunedParity: true,
        preservedEntryIdentity: true,
    }
    receipt.cases.push(result)
    return result
}

for (const id of ['jmdict', 'jitendex', 'vndb']) {
    const spec = locks[id]
    const archive = path.join(fixtureDir, spec.cacheFile)
    assert.equal((await stat(archive)).size, spec.sizeBytes)
    const archiveSha256 = await hashFile(archive)
    assert.equal(archiveSha256, spec.sha256)
    const names = execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trimEnd().split('\n')
    Object.assign(checkCase(id, names), {archiveSha256, archiveBytes: spec.sizeBytes})
}
const names = [
    '', 'term_bank_1.json\n', 'kanji_bank_2.json\r', 'term_bank_1.json\u2028',
    'term_bank_01.json', 'term_bank_1.json', 'term_bank_0001.json',
    'term_bank_9999999999999999999999999999.json', 'term_bank_9999999999999999999999999998.json',
    'term_bank_000.json', 'term_bank_٠.json', 'term_bank_１.json', 'Term_bank_1.json',
    'nested/term_bank_1.json', 'term_bank_1.JSON', 'term_bank_1.json.png', 'kanji_bank_1.json',
    'tag_bank_1.json', 'term_bank_1.mbtb', 'term_meta_bank_1.json', 'kanji_meta_bank_1.json', 'zero.png', '😀.png',
]
for (let index = 0; index < 3000; ++index) {
    for (const prefix of ['media/', 'term_bank_', 'kanji_bank_', 'term_meta_bank_', 'tag_bank_']) {
        names.push(`${prefix}${index % 2 === 0 ? '000' : ''}${index}.${index % 3 === 0 ? 'json' : 'png'}`)
    }
}
checkCase('adversarial', names.reverse())
assert.deepEqual(await source(baselineRoot), baselineSource)
assert.deepEqual(await source(candidateRoot), candidateSource)
await writeFile(outputArgument, JSON.stringify(receipt, null, 2) + '\n')
console.log(`Passed ${receipt.cases.length} catalog cases with exact ordered output and entry identity`)
