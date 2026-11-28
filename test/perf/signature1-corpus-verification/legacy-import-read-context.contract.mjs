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
let encodeRawContent;

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
    encodeRawContent = raw.encodeRawTermContentBinary;
    await (await sourceModule('ext/js/dictionary/zstd-term-content.js')).initializeTermContentZstd();
});

after(() => {
    globalThis.fetch = originalFetch;
    if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    } else {
        delete globalThis.navigator;
    }
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
    Object.defineProperty(globalThis, 'navigator', {configurable: true,
        value: {
            hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => environment.root},
        }});
    const database = new DictionaryDatabase();
    let boundary = null;
    try {
        await database._termContentStore.prepare();
        await database._termRecordStore.prepare();
        if (attach) { boundary = await attachLegacyImportReadContext(database, sqlite3); }
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

test('the actual nonempty public sink keeps real schema invalidation and cold exact reuse active', {timeout: 30000}, async (context) => {
    const environment = await createBoundedNodeOpfs();
    Object.defineProperty(globalThis, 'navigator', {configurable: true,
        value: {
            hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => environment.root},
        }});
    const database = new DictionaryDatabase();
    let boundary = null;
    const cleanupErrors = [];
    try {
        await database._termContentStore.prepare();
        await database._termRecordStore.prepare();
        boundary = await attachLegacyImportReadContext(database, sqlite3);
        const initialRoot = boundary.assertState();
        assert.equal(database._db.selectValue('PRAGMA user_version'), 0);
        assert.match(database._db.selectValue("SELECT sql FROM sqlite_master WHERE name = 'terms'"), /CREATE VIRTUAL TABLE.*manabitan_terms/s);
        const tables = ['termGlossaryTokens', 'termGlossarySearchTerms', 'dictionaryGlossarySearchIndex'];
        for (const table of tables) {
            assert.equal(database._db.selectValue(`SELECT count(*) FROM ${table}`), 0);
        }
        const sqliteIdentity = () => {
            const bytes = sqlite3.capi.sqlite3_js_db_export(database._db.pointer);
            return {bytes: bytes.byteLength, sha256: sha256(bytes), userVersion: database._db.selectValue('PRAGMA user_version')};
        };
        const initialSqlite = sqliteIdentity();
        database.setImportOptimizationFlags({termContentStorageMode: 'raw-bytes', queueTermContentWrites: true});
        database._bulkImportTransactionOpen = true;
        database._deferTermsVirtualTableSync = true;
        database._termContentZstdInitialized = true;
        await database._termContentStore.beginImportSession();
        await database._termRecordStore.beginImportSession();
        database._termContentBlockImportSession = database._termContentBlockStore.beginImportSession();

        const encoder = new TextEncoder();
        // One valid content value crosses the unchanged 512 KiB block minimum.
        // This is a tiny synthetic integration fixture, not a corpus policy.
        const bytes = encodeRawContent('', '', '', encoder.encode(JSON.stringify(['public sink '.repeat(50000)])), encoder);
        assert(bytes.byteLength > 512 * 1024 && bytes.byteLength < 1024 * 1024);
        const dictionary = 'Public sink integration';
        const unrelated = 'Unrelated dictionary';
        const chunk = (ordinal) => ({
            dictionary,
            dictionaryTotalRows: 2,
            rowCount: 1,
            expressionBytesList: [encoder.encode(`public-term-${ordinal}`)],
            readingBytesList: [new Uint8Array(0)],
            readingEqualsExpressionList: Uint8Array.of(1),
            scoreList: Int32Array.of(ordinal),
            sequenceList: Int32Array.of(ordinal),
            contentBytesList: [bytes],
            contentHash1List: Uint32Array.of(10),
            contentHash2List: Uint32Array.of(20),
            contentDictNameList: null,
            uniformContentDictName: 'raw-v2',
            termRecordPreinternedPlan: null,
        });
        const assertPersistedRows = async (expectedCount) => {
            // Real OPFS imports deliberately avoid the resident row cache.
            // Load and decode the authoritative index before counting records.
            const records = database._termRecordStore;
            await records.ensureDictionariesLoaded([dictionary]);
            assert.equal(records.getDictionaryRecordCount(dictionary), expectedCount);
            assert.equal(records.size, expectedCount);
            const ids = records.getDictionaryIdBatch(dictionary, 0, expectedCount + 1);
            assert.deepEqual(ids, Array.from({length: expectedCount}, (_, index) => index + 1));
            const rows = await records.getByIdsAsync(ids);
            assert.equal(rows.size, expectedCount);
            const meta = database._getTermEntryContentMetaByHashPair(10, 20);
            assert(meta);
            for (const id of ids) {
                const row = rows.get(id);
                assert(row);
                assert.equal(row.id, id);
                assert.equal(row.dictionary, dictionary);
                assert.equal(row.expression, `public-term-${id}`);
                assert.equal(row.reading, `public-term-${id}`);
                assert.equal(row.score, id);
                assert.equal(row.sequence, id);
                assert.equal(row.entryContentOffset, meta.offset);
                assert.equal(row.entryContentLength, bytes.byteLength);
                assert.equal(row.entryContentDictName, meta.dictName);
            }
        };
        await database.bulkAddArtifactTermsChunk(chunk(1));
        await Promise.all([database._termContentStore.endImportSession(), database._termRecordStore.endImportSession()]);
        await assertPersistedRows(1);
        assert.equal(database._termRecordStore.size, 1);
        assert.equal(database._lastBulkAddTermsMetrics.dedupUniqueCount, 1);
        assert.deepEqual(boundary.assertState(), initialRoot);
        const afterEmptyInvalidation = sqliteIdentity();
        assert.equal(afterEmptyInvalidation.userVersion, 0);
        for (const table of tables) {
            assert.equal(database._db.selectValue(`SELECT count(*) FROM ${table}`), 0);
        }
        const primary = database._getTermEntryContentMetaByHashPair(10, 20);
        assert(primary);
        assert.equal(primary.dictName, 'raw-block-v2');
        const storedLength = database._termContentStore.getLogicalLength();
        assert(storedLength > 0 && storedLength < bytes.byteLength);
        assert.equal(database._recentTermContentSourceBatches.size, 0);
        assert.equal(database._inFlightTermContentSourceBatches.size, 0);
        database._termContentStore._invalidateReadState();
        database._termContentBlockStore.clearCache();
        const [cold] = await database._findMatchingPersistedTermEntryContentMetaBatch([
            {hash1: 10, hash2: 20, contentBytes: bytes, primary},
        ]);
        assert.equal(cold.existingMeta, primary);
        assert.equal(cold.exactFallback, true);
        assert(database._termContentBlockStore._cache.size > 0, 'Cold equality decoded the actual persisted compressed frame');

        for (const title of [dictionary, unrelated]) {
            database._db.exec({sql: 'INSERT INTO termGlossaryTokens(dictionary, token, termId) VALUES (?, ?, ?)', bind: [title, 'seed', 1]});
            database._db.exec({sql: 'INSERT INTO termGlossarySearchTerms(dictionary, termId, score) VALUES (?, ?, ?)', bind: [title, 1, 9]});
            database._db.exec({sql: 'INSERT INTO dictionaryGlossarySearchIndex(dictionary, version, termCount, completedAt) VALUES (?, ?, ?, ?)', bind: [title, 1, 1, 1]});
        }
        const beforeRealInvalidation = sqliteIdentity();
        database._termContentStore._invalidateReadState();
        database._termContentBlockStore.clearCache();
        await database._termContentStore.beginImportSession();
        await database._termRecordStore.beginImportSession();
        await database.bulkAddArtifactTermsChunk(chunk(2));
        await Promise.all([database._termContentStore.endImportSession(), database._termRecordStore.endImportSession()]);
        await assertPersistedRows(2);
        assert.equal(database._termRecordStore.size, 2);
        assert.equal(database._lastBulkAddTermsMetrics.dedupUniqueCount, 0);
        assert.equal(database._lastBulkAddTermsMetrics.dedupPersistedHitCount, 1);
        assert.equal(database._lastBulkAddTermsMetrics.dedupRecentSourceHitCount, 0);
        assert(database._lastBulkAddTermsMetrics.dedupExactFallbackCount > 0);
        assert(database._termContentBlockStore._cache.size > 0, 'Public duplicate ingestion retains actual cold frame decoding');
        assert.equal(database._termContentStore.getLogicalLength(), storedLength);
        const reused = database._getTermEntryContentMetaByHashPair(10, 20);
        assert.equal(reused.offset, primary.offset);
        assert.equal(reused.length, primary.length);
        assert.equal(reused.dictName, primary.dictName);
        for (const table of tables) {
            assert.equal(database._db.selectValue(`SELECT count(*) FROM ${table} WHERE dictionary = ?`, [dictionary]), 0);
            assert.equal(database._db.selectValue(`SELECT count(*) FROM ${table} WHERE dictionary = ?`, [unrelated]), 1);
        }
        assert.deepEqual(boundary.assertState(), initialRoot);
        const afterRealInvalidation = sqliteIdentity();
        assert.equal(afterRealInvalidation.userVersion, 0);
        context.diagnostic(JSON.stringify({
            name: 'actual-public-sink-sqlite-boundary',
            sourceCommit,
            initialSqlite,
            afterEmptyInvalidation,
            emptyGlossaryInvalidationPreservesEverySqliteByte: initialSqlite.bytes === afterEmptyInvalidation.bytes && initialSqlite.sha256 === afterEmptyInvalidation.sha256,
            beforeRealInvalidation,
            afterRealInvalidation,
            root: initialRoot,
            actualTermRows: database._termRecordStore.size,
            coldPersistedExactComparison: true,
            publicDuplicateExactReuse: true,
            actualScopedGlossaryInvalidation: true,
        }));
    } finally {
        try {
            database._termContentBlockImportSession?.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
        const drains = await Promise.allSettled([
            Promise.resolve().then(() => database._termContentStore.endImportSession()),
            Promise.resolve().then(() => database._termRecordStore.endImportSession()),
        ]);
        for (const result of drains) {
            if (result.status === 'rejected') { cleanupErrors.push(result.reason); }
        }
        try {
            boundary?.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await environment.dispose();
        } catch (error) {
            cleanupErrors.push(error);
        }
        context.diagnostic(JSON.stringify({name: 'actual-public-sink-cleanup', errors: cleanupErrors.map(String)}));
    }
    if (cleanupErrors.length > 0) { throw cleanupErrors[0]; }
});
