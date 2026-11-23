import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'

const worktree = resolve(process.argv[2] ?? '/workspace/scratch/0a1757ac2970/jmdict-stacked')
const parentSha = '10a8f09e96ff943ec1351b1391cb56fa7e20feed'
const path = 'ext/js/dictionary/term-record-opfs-store.js'
const url = pathToFileURL(resolve(worktree, path))
let parentSource = execFileSync('git', ['show', `${parentSha}:${path}`], {cwd: worktree, encoding: 'utf8'})
parentSource = parentSource.replace(/from (['"])(\.[^'"]*)\1/g, (_, quote, specifier) => `from ${quote}${new URL(specifier, url).href}${quote}`)
const parent = await import(`data:text/javascript;base64,${Buffer.from(parentSource).toString('base64')}`)
const candidate = await import(url.href)
const base = 2 ** 40 + 123
let checked = 0
let rejected = 0
const formats = new Map()

function verify(name, setup) {
    const outputs = [parent, candidate].map((module) => {
        const {ids, offsets, lengths, scores} = setup()
        const chunk = module.createArtifactTermRecordChunkWithResolvedContent({rowCount: ids.length, scoreList: scores}, ids, offsets, lengths)
        try { return {bytes: new module.TermRecordOpfsStore()._encodeArtifactRecordFields(chunk, [], [], base)} }
        catch (error) { return {error: {name: error.name, message: error.message}} }
    })
    assert.deepEqual(outputs[1], outputs[0], name)
    ++checked
    if (outputs[0].error) ++rejected
    else {
        const bytes = outputs[0].bytes
        assert.equal(bytes.buffer.byteLength, bytes.byteLength, name)
        const format = bytes.byteLength >= 16 && new DataView(bytes.buffer).getUint32(0, true) === 0x3246524d ? 'compact' : 'legacy'
        formats.set(format, (formats.get(format) ?? 0) + 1)
    }
}

for (const count of [0, 1, 4, 5, 6, 7, 63, 64, 65, 127, 128, 2001]) {
    for (const runLength of [1, 2, 3, 4, 5, 47]) {
        for (const large of [false, true]) {
            verify(`count${count}/run${runLength}/large${large}`, () => {
                const values = [-2147483648, -257, -256, -1, 0, 1, 255, 256, 2147483647]
                return {
                    ids: Uint32Array.from({length: count}, (_, i) => Math.floor(i / runLength) % 4),
                    offsets: Float64Array.of(base, base + 128, -1, base + 0xfffffffe),
                    lengths: Uint32Array.of(0, 7, 65534, large ? 65535 : 42),
                    scores: Int32Array.from({length: count}, (_, i) => values[Math.floor(i / (runLength + 1)) % values.length]),
                }
            })
        }
    }
}
for (const count of [65535, 65536, 65540, 70000]) {
    for (const uniqueScores of [65534, 65535, 65536]) {
        for (const invalidAt of [-1, 0, 65535, count - 1]) {
            if (invalidAt >= count) continue
            verify(`cardinality${count}/${uniqueScores}/invalid${invalidAt}`, () => {
                const ids = new Uint32Array(count)
                if (invalidAt >= 0) ids[invalidAt] = 1
                return {ids, offsets: Float64Array.of(base), lengths: Uint32Array.of(7), scores: Int32Array.from({length: count}, (_, i) => i % uniqueScores - 32768)}
            })
        }
    }
}
for (const largeAt of [0, 63, 119]) {
    for (const invalidAt of [0, 64, 119]) {
        if (invalidAt === largeAt) continue
        verify(`largeAt${largeAt}/invalidAt${invalidAt}`, () => {
            const ids = new Uint32Array(120)
            ids[largeAt] = 1
            ids[invalidAt] = 2
            return {ids, offsets: Float64Array.of(base, base + 17), lengths: Uint32Array.of(7, 65535), scores: new Int32Array(120).fill(75)}
        })
    }
}
console.log(JSON.stringify({
    parent: parentSha,
    candidateBlob: execFileSync('git', ['hash-object', path], {cwd: worktree, encoding: 'utf8'}).trim(),
    cases: checked,
    exactErrorParityCases: rejected,
    formats: Object.fromEntries(formats),
    result: 'exact byte/error parity',
}, null, 2))
