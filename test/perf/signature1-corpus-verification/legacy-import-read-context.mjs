// Scoped real-SQLite legacy-root context for the untimed a300 term-sink verifier.
// Product resolvers, leases, exact comparisons, caches and OPFS reads are unchanged.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const SQLITE_ASSETS = Object.freeze({
    'ext/lib/sqlite/index.mjs': {bytes: 373254, sha256: '044a5844df842a96908eb9aa5542896ae6df174c23866f2c8573ded2ea5df9a2'},
    'ext/lib/sqlite/sqlite3.wasm': {bytes: 859730, sha256: '2d8049756d9d3765f3afac6eb4766457152fb5f417d2febe2836ee3c2223b3e2'},
});
const EXPECTED_STATE = Object.freeze({
    epoch: 0,
    logicalHighWater: 0,
    rootId: 'legacy-root-v0',
    manifest: {version: 1, legacy: true, regions: []},
});

export async function loadLegacyReadContextSqlite(sourceRoot) {
    const assets = {};
    const bytesByPath = new Map();
    for (const [file, expected] of Object.entries(SQLITE_ASSETS)) {
        const bytes = await readFile(path.join(sourceRoot, file));
        const actual = {bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex')};
        assert.deepEqual(actual, expected, `Pinned normal SQLite asset ${file}`);
        assets[file] = actual;
        bytesByPath.set(file, bytes);
    }
    // The exact generated JavaScript and WASM bytes were verified immediately above.
    // eslint-disable-next-line no-unsanitized/method
    const {default: initialize} = await import(pathToFileURL(path.join(sourceRoot, 'ext/lib/sqlite/index.mjs')).href);
    const sqlite3 = await initialize({wasmBinary: bytesByPath.get('ext/lib/sqlite/sqlite3.wasm')});
    return {sqlite3, assetIdentity: assets};
}

function assertNoOnlineOrLifecycleActivity(database) {
    assert.equal(database._closingPromise, null, 'Scoped import must not be closing');
    assert.equal(database._purgingPromise, null, 'Scoped import must not be purging');
    assert.equal(database._onlineContentSnapshots, null, 'Scoped import has no online snapshot');
    assert.equal(database._onlineContentSnapshotsRootId, null, 'Scoped import has no online snapshot root');
    assert.equal(database._onlineContentPublicationRecoveryRequired, false, 'Scoped import has no publication recovery');
    assert.equal(database._onlineContentOptimizationRunner, null, 'Scoped import has no online optimization job');
    assert(database._termRecordStore._dictionaryHealthByName instanceof Map, 'Expected actual record-store health map');
    assert.equal(database._termRecordStore._dictionaryHealthByName.size, 0, 'Scoped import requires healthy fresh record stores');
    for (const key of ['_onlineContentLayoutManifestCache', '_onlineContentLayoutWindowCache', '_onlineContentDictionaryCache']) {
        assert(database[key] instanceof Map, key);
        assert.equal(database[key].size, 0, `Scoped import must not populate ${key}`);
    }
}

export function attachLegacyImportReadContext(database, sqlite3) {
    assert.equal(database._db, null, 'Refuse to replace an existing database');
    assert.equal(database._sqlite3, null, 'Refuse to replace an existing SQLite owner');
    assertNoOnlineOrLifecycleActivity(database);
    assert.equal(database._termContentStore.getLogicalLength(), 0, 'Seed only the initially empty prepared legacy store');
    const connection = new sqlite3.oo1.DB(':memory:', 'c');
    let closed = false;
    database._db = connection;
    database._sqlite3 = sqlite3;
    const assertOwnership = () => {
        assert.equal(closed, false, 'Scoped connection was already closed');
        assert.equal(database._db, connection, 'Scoped connection ownership changed');
        assert.equal(database._sqlite3, sqlite3, 'Scoped SQLite module ownership changed');
        assert.equal(connection.isOpen(), true, 'Scoped connection is closed');
    };
    const assertState = () => {
        assertOwnership();
        assertNoOnlineOrLifecycleActivity(database);
        const state = database.getOnlineContentStorageState();
        assert.deepEqual(state, EXPECTED_STATE, 'Require the unchanged committed epoch-0 legacy root');
        assertNoOnlineOrLifecycleActivity(database);
        assert.equal(database._acquireTermContentReadContext(), null, 'Epoch zero must use the production unleased legacy path');
        return state;
    };
    const close = () => {
        if (closed) { return; }
        assert.equal(database._db, connection, 'Refuse to detach a foreign database');
        assert.equal(database._sqlite3, sqlite3, 'Refuse to detach a foreign SQLite owner');
        connection.close();
        database._db = null;
        database._sqlite3 = null;
        closed = true;
    };
    try {
        database._initializeOnlineContentSchema();
        database._seedTermContentStorageState();
        assertState();
        return {assertState, close};
    } catch (error) {
        close();
        throw error;
    }
}
