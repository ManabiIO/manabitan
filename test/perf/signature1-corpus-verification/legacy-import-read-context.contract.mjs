import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {open, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createBoundedNodeOpfs} from './node-opfs-bounded.mjs';
import {attachLegacyImportReadContext, loadLegacyReadContextSqlite} from './legacy-import-read-context.mjs';

const sourceRoot = process.env.MANABITAN_LEGACY_READ_SOURCE_ROOT;
const sourceCommit = process.env.MANABITAN_LEGACY_READ_SOURCE_COMMIT;
assert.equal(typeof sourceRoot, 'string', 'Provide the explicit frozen runtime checkout');
assert.match(sourceCommit ?? '', /^[0-9a-f]{40}$/, 'Provide its exact frozen commit');
const root = path.resolve(sourceRoot);
assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), sourceCommit);
assert.equal(execFileSync('git', ['-C', root, 'diff', 'HEAD', '--binary', '--', 'ext', 'dev/lib', 'dev/data/dictionary-wasm', 'package-lock.json']).byteLength, 0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The exact source checkout and clean runtime were verified above.
// eslint-disable-next-line no-unsanitized/method
const sourceModule = (file) => import(pathToFileURL(path.join(root, file)).href);
const originalFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let sqlite3;
let DictionaryDatabase;
let decodeReference;
let referenceBytes;

before(async () => {
    assert.equal(process.version, 'v22.22.0');
    assert.equal(typeof globalThis.Worker, 'undefined', 'Small contracts use the existing single-frame main-thread codec path');
    const assetHashes = {
        'ext/lib/zstd.wasm': 'ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc',
        'ext/lib/zstd-dicts/jmdict.zdict': 'f384a821c2f122bde518ee8a513ea76cbe9876c3534fc1fff4cacdf1ecc509cb',
    };
    const admitted = new Map();
    for (const [file, expected] of Object.entries(assetHashes)) {
        const bytes = await readFile(path.join(root, file));
        assert.equal(sha256(bytes), expected);
        admitted.set(pathToFileURL(path.join(root, file)).href, bytes);
    }
    globalThis.fetch = async (input) => {
        const bytes = admitted.get(new URL(String(input)).href);
        assert(bytes, 'Contract fetch must stay inside the exact two frozen codec assets');
        return new Response(bytes, {headers: {'Content-Type': 'application/wasm'}});
    };
    ({sqlite3} = await loadLegacyReadContextSqlite(root));
    ({DictionaryDatabase} = await sourceModule('ext/js/dictionary/dictionary-database.js'));
    const raw = await sourceModule('ext/js/dictionary/raw-term-content.js');
    decodeReference = raw.decodeRawTermContentCompactBlockReference;
    referenceBytes = raw.RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
    await (await sourceModule('ext/js/dictionary/zstd-term-content.js')).initializeTermContentZstd();
});

after(() => {
    globalThis.fetch = originalFetch;
    if (navigatorDescriptor) { Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); } else { delete globalThis.navigator; }
});

function sourceValues() {
    const bytes = new Uint8Array(64).fill(65);
    bytes.set([1, 2, 3, 4], 0);
    bytes.set([5, 6, 7, 8], 30);
    bytes.set([9, 10, 11, 12], 60);
    return bytes;
}

function signature(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function withFixture(callback, {attach = true, values = [sourceValues()]} = {}) {
    const environment = await createBoundedNodeOpfs();
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {
        hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => environment.root},
    }});
    const database = new DictionaryDatabase();
    let boundary = null;
    try {
        await database._termContentStore.prepare();
        await database._termRecordStore.prepare();
        if (attach) { boundary = attachLegacyImportReadContext(database, sqlite3); }
        await database._termContentStore.beginImportSession();
        const stored = await database._termContentBlockStore.tryAppend(values, null, true);
        assert(stored);
        assert.equal(stored.contentDictName, 'raw-block-v2');
        await database._termContentStore.endImportSession();
        assert.equal(database._termContentBlockStore._cache.size, 0);
        assert.equal(database._recentTermContentSourceBatches.size, 0);
        assert.equal(database._inFlightTermContentSourceBatches.size, 0);
        const metas = values.map((bytes, index) => ({
            id: index + 1,
            offset: stored.contentOffsets[index],
            length: stored.contentLengths[index],
            dictName: stored.contentDictName,
            signature1: signature(bytes, 0),
            signature2: signature(bytes, Math.floor((bytes.length - 4) / 2)),
            signature3: signature(bytes, bytes.length - 4),
        }));
        const lookup = async (bytes, primary = metas[0]) => await database._findMatchingPersistedTermEntryContentMetaBatch([
            {hash1: 10, hash2: 20, contentBytes: bytes, primary},
        ]);
        await callback({database, boundary, environment, stored, metas, values, lookup});
    } finally {
        await database._termContentStore.endImportSession();
        boundary?.close();
        await environment.dispose();
    }
}

test('unattached actual cold block reader reproduces the missing database boundary', async () => {
    await withFixture(async ({lookup, values}) => {
        await assert.rejects(lookup(values[0]), /Database not open/);
    }, {attach: false});
});

test('real legacy root permits cold exact reuse without altering SQLite or replacing readers', async () => {
    await withFixture(async ({database, boundary, metas, values, lookup}) => {
        boundary.assertState();
        const beforeBytes = sqlite3.capi.sqlite3_js_db_export(database._db.pointer);
        const resolver = database._termContentBlockStore._onlineFrameResolver;
        const provider = database._termContentBlockStore._readContextProvider;
        const [result] = await lookup(values[0]);
        assert.equal(result.existingMeta, metas[0]);
        assert.equal(result.exactFallback, true);
        assert.equal(result.recentSourceHit, undefined);
        assert(database._termContentBlockStore._cache.size > 0, 'An actual compressed frame was decoded');
        assert.equal(database._termContentBlockStore._onlineFrameResolver, resolver);
        assert.equal(database._termContentBlockStore._readContextProvider, provider);
        assert.equal(database._acquireTermContentReadContext(), null);
        assert.deepEqual(sqlite3.capi.sqlite3_js_db_export(database._db.pointer), beforeBytes);
        boundary.assertState();
    });
});

test('matching hashes and three signatures still reject unequal persisted bytes', async () => {
    await withFixture(async ({values, lookup}) => {
        const collision = Uint8Array.from(values[0]);
        collision[12] ^= 1;
        const [result] = await lookup(collision);
        assert.equal(result.existingMeta, undefined);
        assert.equal(result.exactFallback, true);
    });
});

test('ordered hash collisions retain exact comparison through the later stored candidate', async () => {
    const first = sourceValues();
    const second = Uint8Array.from(first);
    second[12] ^= 1;
    await withFixture(async ({database, metas, values, lookup}) => {
        database._termEntryContentMetaCollisionsByHashPair.set('10:20', [metas[1]]);
        const [result] = await lookup(values[1]);
        assert.equal(result.existingMeta, metas[1]);
        assert.equal(result.exactFallback, true);
    }, {values: [first, second]});
});

for (const [name, sql] of [
    ['missing state', 'DELETE FROM termContentStorageState'],
    ['missing root', 'DELETE FROM termContentStorageRoots'],
    ['mismatched root high-water', 'UPDATE termContentStorageRoots SET logicalHighWater = 1'],
]) {
    test(`actual ${name} rejects the boundary and propagates through exact dedupe`, async () => {
        await withFixture(async ({database, boundary, values, lookup}) => {
            database._db.exec(sql);
            assert.throws(() => boundary.assertState());
            await assert.rejects(lookup(values[0]), /Online content (?:storage state is missing|root publication metadata is inconsistent)/);
        });
    });
}

test('an online epoch cannot silently enter the legacy-only harness boundary', async () => {
    await withFixture(async ({database, boundary}) => {
        database._db.exec("UPDATE termContentStorageState SET activeEpoch = 1; UPDATE termContentStorageRoots SET epoch = 1, manifestJson = '{\"version\":1,\"regions\":[]}';");
        assert.throws(() => boundary.assertState());
    });
});

test('a malformed real root manifest rejects exact reads as corruption', async () => {
    await withFixture(async ({database, boundary, values, lookup}) => {
        database._db.exec("UPDATE termContentStorageRoots SET manifestJson = '{'");
        assert.throws(() => boundary.assertState(), /unsupported or invalid manifest version/);
        await assert.rejects(lookup(values[0]), {
            name: 'TermContentLookupReadError',
            status: 'corrupt',
            message: /unsupported or invalid manifest version/,
        });
        assert.equal(database._termContentBlockStore._cache.size, 0);
    });
});

for (const property of ['_closingPromise', '_purgingPromise']) {
    test(`the production ${property} guard rejects reads before content can escape`, async () => {
        await withFixture(async ({database, boundary, values, lookup}) => {
            database[property] = Promise.resolve();
            try {
                assert.throws(() => boundary.assertState(), /Scoped import must not be/);
                await assert.rejects(lookup(values[0]), {
                    name: 'TermContentLookupReadError',
                    status: 'temporarilyUnavailable',
                    message: /Dictionary content lifecycle is closing/,
                });
                assert.equal(database._termContentBlockStore._cache.size, 0);
            } finally { database[property] = null; }
        });
    });
}

test('actual stored compressed payload corruption remains a checksum failure', async () => {
    await withFixture(async ({database, environment, metas, values, lookup}) => {
        const content = database._termContentStore;
        const ref = decodeReference(await content.readSlice(metas[0].offset, referenceBytes), metas[0].length);
        assert(ref);
        const file = path.join(environment.rootPath, 'manabitan-term-content.bin');
        assert.equal((await stat(file)).size, content.getLogicalLength());
        const bytes = await readFile(file);
        assert.deepEqual([...bytes.subarray(ref.blockOffset, ref.blockOffset + 4)], [0x4d, 0x42, 0x43, 0x32]);
        const handle = await open(file, 'r+');
        try {
            const position = ref.blockOffset + 12;
            await handle.write(Uint8Array.of(bytes[position] ^ 1), 0, 1, position);
        } finally { await handle.close(); }
        content._invalidateReadState();
        database._termContentBlockStore.clearCache();
        await assert.rejects(lookup(values[0]), /checksum does not match/);
    });
});

test('a real frame read cannot publish bytes after cache generation invalidation', {timeout: 10000}, async () => {
    await withFixture(async ({database, metas, values, lookup}) => {
        const content = database._termContentStore;
        const ref = decodeReference(await content.readSlice(metas[0].offset, referenceBytes), metas[0].length);
        assert(ref);
        content._invalidateReadState();
        const originalRead = content.readSlice;
        let signalEntered;
        let releaseRead;
        const entered = new Promise((resolve) => { signalEntered = resolve; });
        const released = new Promise((resolve) => { releaseRead = resolve; });
        content.readSlice = async function readWithTestBarrier(offset, length) {
            const bytes = await Reflect.apply(originalRead, this, [offset, length]);
            if (offset === ref.blockOffset && length === ref.blockCompressedLength) {
                signalEntered();
                await released;
            }
            return bytes;
        };
        let pending;
        let timer;
        try {
            pending = lookup(values[0]);
            const outcome = pending.then((value) => ({value}), (error) => ({error}));
            await Promise.race([
                entered,
                outcome.then(() => { throw new Error('Frame read completed before the required physical-read barrier'); }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Physical-read barrier was not reached')), 3000); }),
            ]);
            clearTimeout(timer);
            database._termContentBlockStore.clearCache();
            releaseRead();
            const result = await outcome;
            assert(result.error instanceof Error);
            assert.equal(result.error.name, 'TermContentLookupReadError');
            assert.equal(result.error.status, 'temporarilyUnavailable');
            assert.match(result.error.message, /Term content changed during read/);
            assert.equal(database._termContentBlockStore._cache.size, 0);
        } finally {
            clearTimeout(timer);
            releaseRead();
            if (pending) { await pending.catch(() => {}); }
            delete content.readSlice;
        }
    });
});

test('foreign connection replacement is rejected without closing either connection', async () => {
    await withFixture(async ({database, boundary}) => {
        const owned = database._db;
        const foreign = new sqlite3.oo1.DB(':memory:', 'c');
        try {
            database._db = foreign;
            assert.throws(() => boundary.assertState());
            assert.throws(() => boundary.close());
            assert.equal(owned.selectValue('SELECT 1'), 1);
            assert.equal(foreign.selectValue('SELECT 1'), 1);
        } finally {
            database._db = owned;
            foreign.close();
        }
        boundary.close();
        boundary.close();
        assert.equal(database._db, null);
    });
});
