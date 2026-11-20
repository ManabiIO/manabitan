/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {runInNewContext} from 'node:vm'
import {collectPersistedTermPayloadDigest} from './persisted-term-payload-digest.mjs'
import {readPersistedPayload, assertPayloadReloadUnchanged} from '../firefox/jmdict-persisted-payload-observation.js'

const encode = (value) => new TextEncoder().encode(value)

function fixture(generation = 1) {
    const record = new Uint8Array(30)
    record.set(encode('MBTRD16X'))
    record.fill(generation, 8, 24)
    record.set([1, 2, 3, 4, 5, 6], 24)
    const index = new Uint8Array(96)
    index.set(encode('MBTIDX11'))
    const view = new DataView(index.buffer)
    view.setBigUint64(8, BigInt(record.length), true)
    view.setUint32(16, 1, true)
    view.setUint32(20, 1, true)
    index.fill(generation, 24, 40)
    index.fill(9, 40)
    const content = Uint8Array.of(4, 5, 6, 7, 8)
    const source = new Map([
        ['manabitan-term-content.bin', content],
        ['manabitan-term-records/dict-Example.mbtr', record],
        ['manabitan-term-records/dict-Example.mbtr.mbti', index],
    ])
    return {source, record, index, content}
}

function rootFromFiles(source) {
    const fileHandle = (path) => ({
        kind: 'file',
        getFile: async () => new File([source.get(path)], path, {lastModified: 42}),
    })
    const records = {
        kind: 'directory',
        async *entries() {
            for (const path of source.keys()) {
                if (path.startsWith('manabitan-term-records/')) {
                    yield [path.slice('manabitan-term-records/'.length), fileHandle(path)]
                }
            }
        },
    }
    return {
        async *entries() {
            for (const path of source.keys()) {
                if (!path.includes('/')) { yield [path, fileHandle(path)] }
            }
            yield ['manabitan-term-records', records]
        },
    }
}

test('only generation IDs normalize, with every persisted file included and no source writes', async () => {
    const a = fixture(1)
    const b = fixture(2)
    const [left, right] = await Promise.all([
        collectPersistedTermPayloadDigest(1, rootFromFiles(a.source)),
        collectPersistedTermPayloadDigest(1, rootFromFiles(b.source)),
    ])
    assert.equal(left.normalizedManifestSha256, right.normalizedManifestSha256)
    assert.notEqual(left.rawManifestSha256, right.rawManifestSha256)
    assert.equal(left.excludedByteCount, 32)
    assert.equal(left.rowCount, 1)
    assert.equal(left.fileCount, 3)
    assert.equal(left.totalBytes, 131)
    assert.deepEqual([...a.record.subarray(8, 24)], new Array(16).fill(1))
    assert.deepEqual([...a.index.subarray(24, 40)], new Array(16).fill(1))
    assert.equal(left.files.find(({kind}) => kind === 'content').excludedRange, null)
})

for (const kind of ['content', 'record', 'index']) {
    test(`changing the last ${kind} payload byte changes the normalized digest`, async () => {
        const baseline = fixture()
        const changed = fixture()
        changed[kind][changed[kind].length - 1] ^= 1
        const a = await collectPersistedTermPayloadDigest(1, rootFromFiles(baseline.source))
        const b = await collectPersistedTermPayloadDigest(1, rootFromFiles(changed.source))
        assert.notEqual(a.normalizedManifestSha256, b.normalizedManifestSha256)
    })
}

test('generation mismatch is rejected before normalization', async () => {
    const f = fixture()
    f.index[39] ^= 1
    await assert.rejects(collectPersistedTermPayloadDigest(1, rootFromFiles(f.source)), /generation mismatch/)
})

for (const kind of ['record', 'index']) {
    test(`unknown ${kind} format is rejected rather than normalized`, async () => {
        const f = fixture()
        f[kind][0] = 0
        await assert.rejects(collectPersistedTermPayloadDigest(1, rootFromFiles(f.source)), /Unrecognized/)
    })
}

test('missing descriptor or sidecar is rejected', async () => {
    for (const suffix of ['.mbtr', '.mbtr.mbti']) {
        const f = fixture()
        f.source.delete(`manabitan-term-records/dict-Example${suffix}`)
        await assert.rejects(collectPersistedTermPayloadDigest(1, rootFromFiles(f.source)), /No persisted term-record descriptors|Descriptor has no index|Index has no descriptor/)
    }
})

test('unexpected files, segment gaps and invalid segment names fail closed', async () => {
    for (const name of ['manabitan-term-records/unknown.tmp', 'manabitan-term-content^2.bin', 'manabitan-term-content^01.bin']) {
        const f = fixture()
        f.source.set(name, Uint8Array.of(1))
        await assert.rejects(collectPersistedTermPayloadDigest(1, rootFromFiles(f.source)), /Unexpected|not contiguous/)
    }
})

test('additional contiguous content segments are included in the digest', async () => {
    const f = fixture()
    f.source.set('manabitan-term-content^1.bin', Uint8Array.of(77))
    const a = await collectPersistedTermPayloadDigest(1, rootFromFiles(f.source))
    f.source.set('manabitan-term-content^1.bin', Uint8Array.of(78))
    const b = await collectPersistedTermPayloadDigest(1, rootFromFiles(f.source))
    assert.equal(a.fileCount, 4)
    assert.notEqual(a.normalizedManifestSha256, b.normalizedManifestSha256)
})

test('exact expected row count and descriptor length are checked', async () => {
    const f = fixture()
    await assert.rejects(collectPersistedTermPayloadDigest(2, rootFromFiles(f.source)), /do not equal expected rows/)
    new DataView(f.index.buffer).setBigUint64(8, 99n, true)
    await assert.rejects(collectPersistedTermPayloadDigest(1, rootFromFiles(f.source)), /Descriptor length mismatch/)
})

test('truncated index and descriptor headers are rejected', async () => {
    for (const suffix of ['.mbtr', '.mbtr.mbti']) {
        const f = fixture()
        f.source.set(`manabitan-term-records/dict-Example${suffix}`, new Uint8Array(8))
        await assert.rejects(collectPersistedTermPayloadDigest(1, rootFromFiles(f.source)), /Truncated/)
    }
})

test('a changed inventory is rejected', async () => {
    const f = fixture()
    const root = rootFromFiles(f.source)
    const entries = root.entries.bind(root)
    let inventories = 0
    root.entries = async function *changedEntries() {
        if (++inventories === 2) { f.source.set('manabitan-term-content^1.bin', Uint8Array.of(1)) }
        yield *entries()
    }
    await assert.rejects(collectPersistedTermPayloadDigest(1, root), /inventory changed/)
})

test('serialized browser function has no dependency on module-scope helpers', async () => {
    const f = fixture()
    const context = {
        navigator: {storage: {getDirectory: async () => rootFromFiles(f.source)}},
        crypto,
        TextEncoder,
        TextDecoder,
    }
    const result = await runInNewContext(`(${collectPersistedTermPayloadDigest.toString()})(1)`, context)
    assert.equal(result.rowCount, 1)
    assert.equal(result.fileCount, 3)
    assert.equal(result.inventoryStable, true)
})

test('observer injects the complete reader and receives a full payload receipt', async () => {
    const f = fixture()
    const driver = {
        async executeAsyncScript(script, expectedRows) {
            return await new Promise((resolve, reject) => {
                try {
                    runInNewContext(script, {
                        arguments: [expectedRows, (value) => resolve(JSON.parse(JSON.stringify(value)))],
                        navigator: {storage: {getDirectory: async () => rootFromFiles(f.source)}},
                        crypto,
                        TextEncoder,
                        TextDecoder,
                    })
                } catch (error) { reject(error) }
            })
        },
    }
    const before = await readPersistedPayload(driver, 1)
    const after = await readPersistedPayload(driver, 1)
    assert.equal(before.fileCount, 3)
    assert.equal(assertPayloadReloadUnchanged(before, after).rawEqualityOverReload, true)
    f.content[f.content.length - 1] ^= 1
    const changed = await readPersistedPayload(driver, 1)
    assert.throws(() => assertPayloadReloadUnchanged(before, changed), /Raw persisted payload changed/)
})

test('reload equality includes generation fields which fresh-arm comparison normalizes', async () => {
    const before = await collectPersistedTermPayloadDigest(1, rootFromFiles(fixture(1).source))
    const changedGeneration = await collectPersistedTermPayloadDigest(1, rootFromFiles(fixture(2).source))
    assert.equal(before.normalizedManifestSha256, changedGeneration.normalizedManifestSha256)
    assert.throws(() => assertPayloadReloadUnchanged(before, changedGeneration), /Raw persisted payload changed/)
})

test('observer propagates browser reader failures and rejects missing receipts', async () => {
    await assert.rejects(readPersistedPayload({executeAsyncScript: async () => ({error: 'OPFS read failed'})}, 1), /OPFS read failed/)
    await assert.rejects(readPersistedPayload({executeAsyncScript: async () => ({value: null})}, 1))
})
