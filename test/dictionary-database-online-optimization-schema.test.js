/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {createHash} from 'node:crypto';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {createContentLayoutResolver} from '../ext/js/dictionary/term-content-layout.js';
import {TermContentIntegrityError} from '../ext/js/dictionary/term-content-opfs-store.js';
import {ContentPhysicalFileIntegrityError, parseContentPhysicalFile} from '../ext/js/dictionary/term-content-physical-file-store.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = [];

beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    for (const connection of connections.splice(0)) { connection.close(); }
    vi.restoreAllMocks();
});

test('creates additive online-layout metadata around the untouched legacy content root', async () => {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    const database = new DictionaryDatabase();
    database._db = connection;
    database._sqlite3 = sqlite3;
    vi.spyOn(database._termContentStore, 'getLogicalLength').mockReturnValue(20);
    vi.spyOn(database, '_ensureTermsVirtualTable').mockResolvedValue();
    vi.spyOn(database, '_migrateTermsContentSchema').mockResolvedValue();
    vi.spyOn(database, '_migrateMediaSchema').mockResolvedValue();
    vi.spyOn(database, '_createIndexesSql').mockReturnValue([]);
    vi.spyOn(database, '_createDropIndexesSql').mockReturnValue([]);

    await database._initializeSchema();
    connection.exec({
        sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: 'JMdict', $summary: JSON.stringify({title: 'JMdict', importSuccess: true, storageGenerationId: 'generation-1'})},
    });

    expect(connection.selectObjects(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'termContentStorage%'
        ORDER BY name
    `).map(({name}) => name)).toEqual([
        'termContentStorageCodecs',
        'termContentStorageFiles',
        'termContentStorageLayouts',
        'termContentStorageRootLayouts',
        'termContentStorageRoots',
        'termContentStorageState',
    ]);
    expect(connection.selectObjects(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'termContentOptimization%'
        ORDER BY name
    `).map(({name}) => name)).toEqual([
        'termContentOptimizationCheckpoints',
        'termContentOptimizationJobs',
    ]);
    expect(connection.selectObject('SELECT * FROM termContentStorageState')).toEqual({
        singleton: 1,
        activeEpoch: 0,
        logicalHighWater: 20,
        activeRootId: 'legacy-root-v0',
    });
    expect(connection.selectObject('SELECT * FROM termContentStorageRoots')).toMatchObject({
        rootId: 'legacy-root-v0',
        epoch: 0,
        logicalHighWater: 20,
        state: 'active',
        manifestJson: '{"version":1,"legacy":true}',
    });
    expect(database.getOnlineContentStorageState()).toMatchObject({
        epoch: 0, logicalHighWater: 20, rootId: 'legacy-root-v0', manifest: {version: 1, legacy: true},
    });

    const job = {
        jobId: 'job-1',
        dictionaryTitle: 'JMdict',
        dictionaryGeneration: 'generation-1',
        strategyVersion: 'fastcover-f18-v1',
        phase: 'sample',
        cursor: {nextEntry: 8192},
        checkpoint: {samplesFileId: 'samples-1', sampleBytes: 1048576},
    };
    database.saveOnlineContentOptimizationJob(job);
    expect(database.getOnlineContentOptimizationJobs()).toMatchObject([{...job, retryAfter: null}]);
    expect(() => database.saveOnlineContentOptimizationJob({...job, jobId: 'job-2', phase: 'train'})).toThrow();
    expect(() => database.saveOnlineContentOptimizationJob({...job, dictionaryTitle: 'Renamed', expectedCheckpointVersion: 0})).toThrow(/identity is immutable/);
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'recompress', expectedCheckpointVersion: 0})).toThrow(/phase transition/);
    expect(() => database.saveOnlineContentOptimizationJob({...job, expectedCheckpointVersion: 7})).toThrow(/checkpoint is stale/);
    connection.exec({
        sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
        bind: {$title: 'JMdict', $summary: JSON.stringify({title: 'JMdict', importSuccess: true, storageGenerationId: 'generation-2'})},
    });
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'sample', expectedCheckpointVersion: 0})).toThrow(/target generation is no longer current/);
    connection.exec({
        sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
        bind: {$title: 'JMdict', $summary: JSON.stringify({title: 'JMdict', importSuccess: true, storageGenerationId: 'generation-1'})},
    });
    expect(database.reserveOnlineContentStorageFile('job-1', 'sample-file-1')).toBe('manabitan-online-content-v1/sample-file-1.bin');
    database.sealOnlineContentStorageFile('job-1', 'sample-file-1', 4096);
    expect(connection.selectObject('SELECT byteLength, sha256, state FROM termContentStorageFiles WHERE fileId = \'sample-file-1\'')).toEqual({
        byteLength: 4096, sha256: null, state: 'staged',
    });
    database.saveOnlineContentOptimizationJob({...job, phase: 'train', expectedCheckpointVersion: 0});
    database.saveOnlineContentOptimizationJob({...job, phase: 'recompress', expectedCheckpointVersion: 1});
    installPhysicalFixture(connection, 'legacy-layout-pack', 20);
    installLayoutFixture({database, connection}, [{version: 1,
        regionId: 'initial-region',
        logicalStart: 0,
        logicalLength: 20,
        extents: [{logicalOffset: 0, length: 20, fileId: 'legacy-layout-pack', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    await database._termContentStore.activateCommittedRoot({storageEpoch: 1, logicalHighWater: 20});
    database.reserveOnlineContentStorageFile('job-1', 'replacement-1');
    database.sealOnlineContentStorageFile('job-1', 'replacement-1', 20);
    /**
     * @param {string} fileId
     * @param {string[]} activatedFileIds
     * @param {string} rootId
     * @returns {{rootId: string, epoch: number, logicalHighWater: number}}
     */
    const invalidPublication = (fileId, activatedFileIds, rootId) => {
        const manifest = {
            version: 1,
            regionId: 'bad-region',
            logicalStart: 0,
            logicalLength: 20,
            extents: [{logicalOffset: 0, length: 20, fileId, physicalOffset: 0}],
            blocks: [],
            removed: [],
        };
        const manifestJson = JSON.stringify(manifest);
        return database.publishOnlineContentStorageRoot({
            jobId: 'job-1',
            dictionaryGeneration: 'generation-1',
            strategyVersion: 'fastcover-f18-v1',
            expectedCheckpointVersion: 2,
            expectedRootId: 'root-fixture',
            rootId,
            logicalHighWater: 20,
            manifest: {version: 1, regions: [{regionId: 'bad-region', layoutId: `${rootId}-layout`, logicalStart: 0, logicalLength: 20}]},
            layouts: [{layoutId: `${rootId}-layout`,
                regionId: 'bad-region',
                manifest,
                manifestSha256: createHash('sha256').update(manifestJson).digest('hex')}],
            activatedFileIds,
            retiredFileIds: [],
            cursor: {frame: 0},
            checkpoint: {nextAction: 'reclaim'},
        });
    };
    expect(() => invalidPublication('missing-file', [], 'missing-root')).toThrow(/physical file closure/iu);
    database.reserveOnlineContentStorageFile('job-1', 'unreferenced-stage');
    database.sealOnlineContentStorageFile('job-1', 'unreferenced-stage', 20);
    expect(() => invalidPublication('replacement-1', ['replacement-1', 'unreferenced-stage'], 'foreign-stage-root')).toThrow(/outside the next root closure/iu);
    const regionManifest = {
        version: 1,
        regionId: 'region-1',
        logicalStart: 0,
        logicalLength: 20,
        extents: [{logicalOffset: 0, length: 20, fileId: 'replacement-1', physicalOffset: 0}],
        blocks: [],
        removed: [],
    };
    const regionManifestJson = JSON.stringify(regionManifest);
    const regionManifestSha256 = createHash('sha256').update(regionManifestJson).digest('hex');
    const rootManifest = {
        version: 1,
        regions: [{regionId: 'region-1', layoutId: 'layout-1', logicalStart: 0, logicalLength: 20}],
    };
    expect(database.publishOnlineContentStorageRoot({
        jobId: 'job-1',
        dictionaryGeneration: 'generation-1',
        strategyVersion: 'fastcover-f18-v1',
        expectedCheckpointVersion: 2,
        expectedRootId: 'root-fixture',
        rootId: 'root-1',
        logicalHighWater: 20,
        manifest: rootManifest,
        layouts: [{layoutId: 'layout-1', regionId: 'region-1', manifest: regionManifest, manifestSha256: regionManifestSha256}],
        activatedFileIds: ['replacement-1'],
        retiredFileIds: [],
        cursor: {frame: 0},
        checkpoint: {nextAction: 'reclaim'},
    })).toEqual({rootId: 'root-1', epoch: 2, logicalHighWater: 20});
    expect(connection.selectObject('SELECT activeRootId, activeEpoch FROM termContentStorageState')).toEqual({
        activeRootId: 'root-1',
        activeEpoch: 2,
    });
    expect(connection.selectObject('SELECT state FROM termContentStorageFiles WHERE fileId = \'replacement-1\'')).toEqual({state: 'active'});
    expect(database.getOnlineContentOptimizationJobs()[0].phase).toBe('reclaim');
    const window = await database.getOnlineContentLayoutWindow(3);
    if (window === null) { throw new Error('Expected a published layout window'); }
    expect(window).toMatchObject({rootId: 'root-1', epoch: 2});
    const resolver = createContentLayoutResolver(window.resolverData);
    expect(resolver.resolveLogical(2, 3)).toEqual([{fileId: 'replacement-1', physicalOffset: 2, length: 3}]);
    connection.exec("UPDATE termContentStorageRoots SET manifestJson = '{\"version\":2,\"regions\":[]}' WHERE rootId = 'root-1'");
    expect(() => database.getOnlineContentStorageState()).toThrow(/unsupported.*manifest version/iu);
    expect(() => database.publishOnlineContentStorageRoot({
        jobId: 'job-1',
        dictionaryGeneration: 'generation-1',
        strategyVersion: 'fastcover-f18-v1',
        expectedCheckpointVersion: 2,
        expectedRootId: 'root-fixture',
        rootId: 'root-stale',
        logicalHighWater: 20,
        manifest: {version: 1, regions: []},
        layouts: [],
        activatedFileIds: [],
        retiredFileIds: [],
        cursor: {},
        checkpoint: {},
    })).toThrow(/root changed/);
    expect(connection.selectValues('SELECT rootId FROM termContentStorageRoots ORDER BY epoch')).toEqual(['legacy-root-v0', 'root-fixture', 'root-1']);

    // Reopening is idempotent and never resets a subsequently published root.
    connection.exec('UPDATE termContentStorageState SET activeEpoch = 3, activeRootId = \'root-3\' WHERE singleton = 1');
    await database._initializeSchema();
    expect(connection.selectObject('SELECT activeEpoch, activeRootId FROM termContentStorageState')).toEqual({
        activeEpoch: 3,
        activeRootId: 'root-3',
    });
});

test('online metadata coexists with an ordinary schema-10 profile', async () => {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    connection.exec('CREATE TABLE dictionaries (id INTEGER PRIMARY KEY, title TEXT)');
    connection.exec(`CREATE TABLE termContentOptimizationJobs (
        jobId TEXT PRIMARY KEY, dictionaryTitle TEXT NOT NULL, dictionaryGeneration TEXT NOT NULL,
        strategyVersion TEXT NOT NULL, phase TEXT NOT NULL, cursorJson TEXT NOT NULL,
        checkpointJson TEXT NOT NULL, retryAfter INTEGER, updatedAt INTEGER NOT NULL
    )`);
    connection.exec("INSERT INTO dictionaries VALUES (1, 'Existing dictionary')");
    const database = new DictionaryDatabase();
    database._db = connection;
    database._sqlite3 = sqlite3;

    connection.exec('PRAGMA user_version = 10');
    database._initializeOnlineContentSchema();
    await database._runSchemaMigrations();
    expect(connection.selectValue('PRAGMA user_version')).toBe(10);

    expect(connection.selectValues('SELECT title FROM dictionaries')).toEqual(['Existing dictionary']);
});

/**
 * @param {number} highWater
 * @returns {Promise<{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database}>}
 */
async function createLayoutDatabase(highWater) {
    const connection = new sqlite3.oo1.DB(':memory:');
    connections.push(connection);
    const database = new DictionaryDatabase();
    database._db = connection;
    database._sqlite3 = sqlite3;
    vi.spyOn(database._termContentStore, 'getLogicalLength').mockReturnValue(highWater);
    vi.spyOn(database, '_ensureTermsVirtualTable').mockResolvedValue();
    vi.spyOn(database, '_migrateTermsContentSchema').mockResolvedValue();
    vi.spyOn(database, '_migrateMediaSchema').mockResolvedValue();
    vi.spyOn(database, '_createIndexesSql').mockReturnValue([]);
    vi.spyOn(database, '_createDropIndexesSql').mockReturnValue([]);
    await database._initializeSchema();
    return {database, connection};
}

/**
 * @param {{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database}} fixture
 * @param {Array<import('../ext/js/dictionary/term-content-layout.js').Manifest>} manifests
 */
function installLayoutFixture({connection}, manifests) {
    const regions = manifests.map((manifest) => ({regionId: manifest.regionId,
        layoutId: manifest.regionId + '-layout',
        logicalStart: manifest.logicalStart,
        logicalLength: manifest.logicalLength}));
    const highWater = regions.reduce((sum, region) => sum + region.logicalLength, 0);
    connection.exec("UPDATE termContentStorageRoots SET state = 'retired' WHERE rootId = 'legacy-root-v0'");
    connection.exec({sql: "INSERT INTO termContentStorageRoots(rootId, epoch, logicalHighWater, state, manifestJson, createdAt) VALUES ('root-fixture', 1, $highWater, 'active', $manifest, 1)",
        bind: {$highWater: highWater, $manifest: JSON.stringify({version: 1, regions})}});
    connection.exec({sql: "UPDATE termContentStorageState SET activeRootId = 'root-fixture', activeEpoch = 1, logicalHighWater = $highWater WHERE singleton = 1", bind: {$highWater: highWater}});
    for (const manifest of manifests) {
        const json = JSON.stringify(manifest),
            layoutId = manifest.regionId + '-layout';
        connection.exec({sql: 'INSERT INTO termContentStorageLayouts(layoutId, version, regionId, manifestJson, manifestSha256) VALUES ($layoutId, 1, $regionId, $json, $sha)',
            bind: {$layoutId: layoutId, $regionId: manifest.regionId, $json: json, $sha: createHash('sha256').update(json).digest('hex')}});
        connection.exec({sql: "INSERT INTO termContentStorageRootLayouts(rootId, regionId, layoutId, logicalStart, logicalLength) VALUES ('root-fixture', $regionId, $layoutId, $start, $length)",
            bind: {$regionId: manifest.regionId, $layoutId: layoutId, $start: manifest.logicalStart, $length: manifest.logicalLength}});
    }
}

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} connection
 * @param {string} id
 * @param {number} length
 * @param {string|null} [sha]
 * @param {string} [path]
 */
function installPhysicalFixture(connection, id, length, sha = null, path = 'manabitan-online-content-v1/' + id + '.bin') {
    connection.exec({sql: "INSERT INTO termContentStorageFiles(fileId, path, byteLength, sha256, state, ownerJobId) VALUES ($id, $path, $length, $sha, 'active', 'fixture-owner')",
        bind: {$id: id, $path: path, $length: length, $sha: sha}});
}

test('continuation-only windows retain the predecessor frame owner and preserve unrelated bytes', async () => {
    const f = await createLayoutDatabase(40);
    const digest = 'a'.repeat(64);
    const frame = {kind: /** @type {const} */ ('block'),
        logicalOffset: 16,
        recordLength: 18,
        sourceStoredLength: 18,
        originalCodecId: null,
        expectedDecodedLength: 10,
        originalEnvelope: /** @type {const} */ ('mbc2'),
        fileId: 'pack-a',
        physicalOffset: 16,
        storedLength: 5,
        codecId: 'codec-1',
        envelope: /** @type {const} */ ('none'),
        decodedLength: 10,
        decodedDigest: digest};
    installPhysicalFixture(f.connection, 'pack-a', 21);
    installPhysicalFixture(f.connection, 'pack-b', 6);
    installPhysicalFixture(f.connection, 'dict-1', 8, digest);
    f.connection.exec({sql: "INSERT INTO termContentStorageCodecs(codecId, fileId, formatVersion, dictionaryBytes, dictionarySha256, strategyJson) VALUES ('codec-1', 'dict-1', 1, 8, $digest, '{}')", bind: {$digest: digest}});
    installLayoutFixture(f, [
        {version: 1,
            regionId: 'a',
            logicalStart: 0,
            logicalLength: 20,
            extents: [{logicalOffset: 0, length: 16, fileId: 'pack-a', physicalOffset: 0}],
            blocks: [frame],
            removed: [{logicalOffset: 16, length: 4, frameLogicalOffset: 16}]},
        {version: 1,
            regionId: 'b',
            logicalStart: 20,
            logicalLength: 20,
            extents: [{logicalOffset: 14, length: 6, fileId: 'pack-b', physicalOffset: 0}],
            blocks: [],
            removed: [{logicalOffset: 0, length: 14, frameLogicalOffset: 16}]},
    ]);
    const window = await f.database.getOnlineContentLayoutWindow(36);
    if (window === null) { throw new Error('Expected active layout'); }
    expect(window.resolverData.externalFrames).toEqual([frame]);
    const resolver = createContentLayoutResolver(window.resolverData);
    expect(resolver.resolveLogical(36, 3)).toEqual([{fileId: 'pack-b', physicalOffset: 2, length: 3}]);
    expect(window.fileLocators.get('pack-a')).toMatchObject({path: 'manabitan-online-content-v1/pack-a.bin'});
});

test('identity layout reads the registered legacy file without copying or fabricating an optimizer path', async () => {
    const f = await createLayoutDatabase(4);
    installPhysicalFixture(f.connection, 'legacy-0', 4, null, 'manabitan-term-content.bin');
    installLayoutFixture(f, [{version: 1,
        regionId: 'legacy-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'legacy-0', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    const reader = vi.spyOn(f.database._onlineContentPhysicalFileStore, 'readSlice').mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const frame = await f.database._resolveOnlineContentFrame({kind: 'block',
        logicalOffset: 0,
        recordLength: 4,
        sourceStoredLength: 4,
        originalCodecId: null,
        expectedDecodedLength: 4,
        originalEnvelope: 'none'});
    if (frame === null) { throw new Error('Expected leased frame'); }
    try {
        expect(frame.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 4}), 0, 4);
    } finally { frame.release(); }
});

test('activates immutable legacy addressing once and publishes an exact partial-tail arena', async () => {
    const f = await createLayoutDatabase(4);
    f.database._sqlite3 = sqlite3;
    const inventory = vi.spyOn(f.database._termContentStore, 'inventoryLegacyFiles').mockResolvedValue([
        {fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 4, logicalStart: 0, logicalEnd: 4},
    ]);
    vi.spyOn(f.database._termContentStore, 'activateCommittedRoot').mockResolvedValue();
    const state = await f.database.activateOnlineContentStorage();
    expect(state).toMatchObject({epoch: 1, logicalHighWater: 4});
    expect((await f.database.activateOnlineContentStorage()).rootId).toBe(state.rootId);
    expect(inventory).toHaveBeenCalledTimes(1);
    const physical = vi.spyOn(f.database._onlineContentPhysicalFileStore, 'readSlice').mockImplementation(async (file, offset, length) => {
        const source = file.fileId === 'legacy-0' ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6]);
        return source.slice(offset, offset + length);
    });
    const old = f.database._acquireTermContentReadContext();
    if (old === null) { throw new Error('Expected immutable root context'); }
    try {
        /** @type {import('../ext/js/dictionary/term-content-layout.js').FrameIdentity} */
        const identity = {kind: 'block',
            logicalOffset: 0,
            recordLength: 4,
            sourceStoredLength: 4,
            originalCodecId: null,
            expectedDecodedLength: 4,
            originalEnvelope: 'none'};
        const oldFrame = await old.resolveFrame(identity);
        if (oldFrame === null) { throw new Error('Expected original frame'); }
        const plan = await f.database._prepareOnlineContentIdentityPlan('import-test', 4, 6, [{
            fileId: 'arena-test',
            path: 'manabitan-term-content-arenas-v1/test/manabitan-term-content.bin',
            byteLength: 2,
            logicalStart: 4,
            logicalEnd: 6,
        }]);
        f.connection.exec('BEGIN IMMEDIATE');
        f.database._insertOnlineContentIdentityRoot(state, 'root-with-arena', plan, 'import-owner');
        f.connection.exec('COMMIT');
        expect(f.connection.selectValue('SELECT activeRootId FROM termContentStorageState WHERE singleton = 1')).toBe('root-with-arena');
        f.database.getOnlineContentStorageState();
        expect(await old.isCurrentRange(0, 4)).toBe(true);
        expect(await old.readSlice(0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(await old.readSlice(4, 2)).toBeNull();
        const current = f.database._acquireTermContentReadContext();
        if (current === null) { throw new Error('Expected appended root context'); }
        try {
            expect(await current.readSlice(2, 4)).toEqual(new Uint8Array([3, 4, 5, 6]));
        } finally { current.release(); }
        expect(physical).toHaveBeenCalledWith(expect.objectContaining({path: 'manabitan-term-content.bin'}), 0, 4);
        const readsBeforeProof = physical.mock.calls.length;
        physical.mockRejectedValue(new Error('Current payload is temporarily unreadable'));
        expect(await old.isCurrentFrame(identity, oldFrame.physicalKey)).toBe(true);
        expect(physical).toHaveBeenCalledTimes(readsBeforeProof);
    } finally { old.release(); }
});

test('pre-acquisition physical corruption carries exact immutable source identity and releases its lease', async () => {
    const f = await createLayoutDatabase(4);
    installPhysicalFixture(f.connection, 'legacy-0', 4, null, 'manabitan-term-content.bin');
    installLayoutFixture(f, [{version: 1,
        regionId: 'physical-owner',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'legacy-0', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    vi.spyOn(f.database._onlineContentPhysicalFileStore, 'readSlice').mockImplementation(async (file) => {
        throw new ContentPhysicalFileIntegrityError('Physical bytes changed', file);
    });
    await expect(f.database._resolveOnlineContentFrame({kind: 'block',
        logicalOffset: 0,
        recordLength: 4,
        sourceStoredLength: 4,
        originalCodecId: null,
        expectedDecodedLength: 4,
        originalEnvelope: 'none'})).rejects.toMatchObject({
        name: 'TermContentIntegrityError', physicalKey: expect.stringContaining('legacy-0/manabitan-term-content.bin'),
    });
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(false);
});

test.each(['checksum', 'transient'])('classifies active manifest %s failure without touching physical payloads', async (failure) => {
    const f = await createLayoutDatabase(4);
    installPhysicalFixture(f.connection, 'legacy-0', 4, null, 'manabitan-term-content.bin');
    installLayoutFixture(f, [{version: 1,
        regionId: 'manifest-owner',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'legacy-0', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    const physical = vi.spyOn(f.database._onlineContentPhysicalFileStore, 'readSlice');
    if (failure === 'checksum') {
        f.connection.exec("UPDATE termContentStorageLayouts SET manifestSha256 = '" + '0'.repeat(64) + "'");
    } else {
        vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('Temporary hash resource failure'));
    }
    const pending = f.database._resolveOnlineContentFrame({kind: 'block',
        logicalOffset: 0,
        recordLength: 4,
        sourceStoredLength: 4,
        originalCodecId: null,
        expectedDecodedLength: 4,
        originalEnvelope: 'none'});
    await (failure === 'checksum' ?
        expect(pending).rejects.toBeInstanceOf(TermContentIntegrityError) :
        expect(pending).rejects.toThrow('Temporary hash resource failure'));
    expect(physical).not.toHaveBeenCalled();
});

test('identity activation rejects inventory disagreement before opening a publication transaction', async () => {
    const f = await createLayoutDatabase(4);
    vi.spyOn(f.database._termContentStore, 'inventoryLegacyFiles').mockResolvedValue([
        {fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 3, logicalStart: 0, logicalEnd: 3},
    ]);
    await expect(f.database.activateOnlineContentStorage()).rejects.toThrow(/committed logical high-water/);
    expect(f.database.getOnlineContentStorageState().epoch).toBe(0);
    expect(f.connection.selectValue('SELECT count(*) FROM termContentStorageFiles')).toBe(0);
});

test('foreground preemption during legacy inventory leaves activation unpublished', async () => {
    const f = await createLayoutDatabase(4);
    const controller = new AbortController();
    vi.spyOn(f.database._termContentStore, 'inventoryLegacyFiles').mockImplementation(async () => {
        controller.abort();
        return [{fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 4, logicalStart: 0, logicalEnd: 4}];
    });
    const activate = vi.spyOn(f.database._termContentStore, 'activateCommittedRoot');
    await expect(f.database.activateOnlineContentStorage(controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(f.database.getOnlineContentStorageState().epoch).toBe(0);
    expect(f.connection.selectValue('SELECT count(*) FROM termContentStorageFiles')).toBe(0);
    expect(activate).not.toHaveBeenCalled();
});


/**
 * @param {string} [phase]
 * @returns {Promise<{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, job: {jobId: string, dictionaryTitle: string, dictionaryGeneration: string, strategyVersion: string, phase: string, cursor: {frame: number}, checkpoint: object}}>}
 */
async function createJobFixture(phase = 'discover') {
    const f = await createLayoutDatabase(4);
    f.database._sqlite3 = sqlite3;
    f.connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'job-generation'})}});
    const job = {jobId: 'job-fixture',
        dictionaryTitle: 'Fixture',
        dictionaryGeneration: 'job-generation',
        strategyVersion: 'frame64k-f18-v1',
        phase,
        cursor: {frame: 0},
        checkpoint: {}};
    f.database.saveOnlineContentOptimizationJob(job);
    return {...f, job};
}

/**
 * @param {number} logicalOffset
 * @param {string} [fileId]
 * @returns {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor}
 */
function discoveredPhysicalFrame(logicalOffset, fileId = 'frame-file') {
    return {identity: {kind: 'block',
        logicalOffset,
        recordLength: 18,
        sourceStoredLength: 18,
        originalCodecId: null,
        expectedDecodedLength: 10,
        originalEnvelope: 'mbc2'},
    physicalKey: fileId + ':' + logicalOffset,
    storedLength: 18,
    codecId: 'codec-1',
    envelope: 'none',
    decodedLength: 10,
    decodedDigest: 'a'.repeat(64)};
}

test('records unique frame references and advances the discovery receipt atomically', async () => {
    const {database, connection, job} = await createJobFixture();
    const frame = discoveredPhysicalFrame(5);
    expect(database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {nextLogicalOffset: 6},
        checkpoint: {discovered: 1}},
    frames: [frame, frame]})).toBe(1);
    expect(connection.selectValue("SELECT COUNT(*) FROM termContentOptimizationCheckpoints WHERE jobId = 'job-fixture' AND kind = 'frame'")).toBe(1);
    expect(database.getOnlineContentOptimizationFramePage('job-fixture')).toMatchObject({frames: [frame], cursor: null, hasMore: false});
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {nextLogicalOffset: 6}, checkpointVersion: 1});
});

test('conflicting immutable frames roll back every insert and cursor update', async () => {
    const {database, connection, job} = await createJobFixture();
    const frame = discoveredPhysicalFrame(5);
    database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {nextLogicalOffset: 6},
        checkpoint: {}},
    frames: [frame]});
    const conflict = {...frame, physicalKey: 'other-file:5'};
    expect(() => database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 1,
        cursor: {nextLogicalOffset: 9},
        checkpoint: {bad: true}},
    frames: [conflict, discoveredPhysicalFrame(9)]})).toThrow(/conflicts/);
    expect(connection.selectValue("SELECT COUNT(*) FROM termContentOptimizationCheckpoints WHERE jobId = 'job-fixture' AND kind = 'frame'")).toBe(1);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {nextLogicalOffset: 6}, checkpointVersion: 1});
});

test('stale checkpoint and generation cannot advance the frame cursor', async () => {
    const {database, connection, job} = await createJobFixture();
    const page = {job: {...job, expectedCheckpointVersion: 0, cursor: {nextLogicalOffset: 8}, checkpoint: {}}, frames: [discoveredPhysicalFrame(7)]};
    connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
        bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'stale'})}});
    expect(() => database.recordOnlineContentOptimizationFramePage(page)).toThrow(/generation is no longer current/);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {frame: 0}, checkpointVersion: 0});
    connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
        bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'job-generation'})}});
    database.recordOnlineContentOptimizationFramePage(page);
    expect(() => database.recordOnlineContentOptimizationFramePage(page)).toThrow(/stale/);
    expect(database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(1);
});

test('frame pages are bounded, ordered, large-offset safe, and JSON cursor resumable', async () => {
    const {database, job} = await createJobFixture();
    const offset = 2 ** 40;
    database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {nextLogicalOffset: offset + 2},
        checkpoint: {}},
    frames: [discoveredPhysicalFrame(offset + 1), discoveredPhysicalFrame(offset)]});
    const first = database.getOnlineContentOptimizationFramePage('job-fixture', null, 1);
    expect(first.frames[0].identity.logicalOffset).toBe(offset);
    expect(JSON.parse(JSON.stringify(first.cursor))).toEqual({nextLogicalOffset: offset});
    expect(database.getOnlineContentOptimizationFramePage('job-fixture', JSON.parse(JSON.stringify(first.cursor)), 1).frames[0].identity.logicalOffset).toBe(offset + 1);
    expect(() => database.getOnlineContentOptimizationFramePage('job-fixture', null, 257)).toThrow(/cursor/);
});

test('frame metadata admission rejects an oversized bounded descriptor page', async () => {
    const {database, connection, job} = await createJobFixture();
    const frame = discoveredPhysicalFrame(1);
    frame.physicalKey = 'あ'.repeat(7000);
    expect(() => database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {nextLogicalOffset: 2},
        checkpoint: {}},
    frames: [frame]})).toThrow(/metadata exceeds/);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {frame: 0}, checkpointVersion: 0});
    expect(connection.selectValue("SELECT COUNT(*) FROM termContentOptimizationCheckpoints WHERE jobId = 'job-fixture'")).toBe(0);
});

test('successful frame commit survives a lost acknowledgement and resumes its exact receipt', async () => {
    const {database, connection, job} = await createJobFixture();
    const exec = connection.exec.bind(connection);
    let loseAcknowledgement = true;
    vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
        const result = exec(...args);
        if (sql === 'COMMIT' && loseAcknowledgement) {
            loseAcknowledgement = false;
            throw new Error('lost commit acknowledgement');
        }
        return result;
    });
    expect(database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {nextLogicalOffset: 3},
        checkpoint: {receipt: 'exact'}},
    frames: [discoveredPhysicalFrame(2)]})).toBe(1);
    expect(database.getOnlineContentOptimizationFramePage('job-fixture').frames).toHaveLength(1);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({checkpointVersion: 1, cursor: {nextLogicalOffset: 3}});
});

test('pre-commit SQL failure rolls back both frame rows and the cursor', async () => {
    const {database, connection, job} = await createJobFixture();
    const exec = connection.exec.bind(connection);
    vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
        if (typeof sql === 'string' && sql.includes('INSERT INTO termContentOptimizationCheckpoints')) { throw new Error('injected insert failure'); }
        return exec(...args);
    });
    expect(() => database.recordOnlineContentOptimizationFramePage({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {nextLogicalOffset: 3},
        checkpoint: {}},
    frames: [discoveredPhysicalFrame(2)]})).toThrow(/injected insert failure/);
    expect(connection.selectValue("SELECT COUNT(*) FROM termContentOptimizationCheckpoints WHERE jobId = 'job-fixture'")).toBe(0);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({checkpointVersion: 0, cursor: {frame: 0}});
});

test('replays only an identical owned file intent and an identical staged seal', async () => {
    const {database, connection} = await createJobFixture();
    const path = database.reserveOnlineContentStorageFile('job-fixture', 'sample-replay');
    expect(database.reserveOnlineContentStorageFile('job-fixture', 'sample-replay')).toBe(path);
    expect(() => database.reserveOnlineContentStorageFile('different-owner', 'sample-replay')).toThrow(/missing, conflicting/);
    database.sealOnlineContentStorageFile('job-fixture', 'sample-replay', 40, 'a'.repeat(64));
    expect(() => database.sealOnlineContentStorageFile('job-fixture', 'sample-replay', 40, 'a'.repeat(64))).not.toThrow();
    expect(() => database.sealOnlineContentStorageFile('job-fixture', 'sample-replay', 41, 'a'.repeat(64))).toThrow(/could not be sealed/);
    expect(() => database.sealOnlineContentStorageFile('job-fixture', 'sample-replay', 40, 'b'.repeat(64))).toThrow(/could not be sealed/);
    expect(() => database.reserveOnlineContentStorageFile('job-fixture', 'sample-replay')).toThrow(/already sealed/);
    expect(connection.selectObject("SELECT byteLength, sha256, state FROM termContentStorageFiles WHERE fileId = 'sample-replay'"))
        .toEqual({byteLength: 40, sha256: 'a'.repeat(64), state: 'staged'});
});

test.each(['discover', 'sample', 'train'])('%s no-gain cleanup remains resumable until every pending file is reclaimed', async (phase) => {
    const {database, connection, job} = await createJobFixture(phase);
    database.reserveOnlineContentStorageFile(job.jobId, 'pending-sample');
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'no-gain', expectedCheckpointVersion: 0})).toThrow(/must reclaim/);
    expect(database.saveOnlineContentOptimizationJob({...job, phase: 'reclaim', checkpoint: {afterReclaim: 'no-gain'}, expectedCheckpointVersion: 0})).toBe(1);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'reclaim', checkpoint: {afterReclaim: 'no-gain'}});
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'no-gain', expectedCheckpointVersion: 1})).toThrow(/must reclaim/);
    connection.exec("DELETE FROM termContentStorageFiles WHERE fileId = 'pending-sample'");
    expect(database.saveOnlineContentOptimizationJob({...job, phase: 'no-gain', expectedCheckpointVersion: 1})).toBe(2);
});

test('reclaim can resume the next region with generation and checkpoint compare-and-swap guards', async () => {
    const {database, connection, job} = await createJobFixture('recompress');
    expect(database.saveOnlineContentOptimizationJob({...job, phase: 'reclaim', cursor: {frame: 7}, expectedCheckpointVersion: 0})).toBe(1);
    const resumed = {...job, phase: 'recompress', cursor: {frame: 7}, expectedCheckpointVersion: 1};
    expect(database.saveOnlineContentOptimizationJob(resumed)).toBe(2);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'recompress', cursor: {frame: 7}, checkpointVersion: 2});
    expect(() => database.saveOnlineContentOptimizationJob(resumed)).toThrow(/checkpoint is stale/);
    database.saveOnlineContentOptimizationJob({...job, phase: 'reclaim', cursor: {frame: 12}, expectedCheckpointVersion: 2});
    connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
        bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'replacement-generation'})}});
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'recompress', expectedCheckpointVersion: 3})).toThrow(/target generation/);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'reclaim', cursor: {frame: 12}, checkpointVersion: 3});
});

test.each(['valid', 'before-commit', 'training-cost', 'after-commit', 'after-commit-bad-receipt', 'after-commit-unreadable-root'])('reconciles online root publication %s without rolling back published bytes', async (fault) => {
    const {database, connection, job} = await createJobFixture('recompress');
    installPhysicalFixture(connection, 'source-pack', 4);
    installLayoutFixture({database, connection}, [{version: 1,
        regionId: 'receipt-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'source-pack', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    await database._termContentStore.activateCommittedRoot({storageEpoch: 1, logicalHighWater: 4});
    const before = await database._termContentStore.createImportCheckpoint();
    expect(before).toMatchObject({version: 2, storageEpoch: 1, logicalHighWater: 4});
    database.reserveOnlineContentStorageFile(job.jobId, 'receipt-replacement');
    database.sealOnlineContentStorageFile(job.jobId, 'receipt-replacement', 4);
    const manifest = {version: 1,
        regionId: 'receipt-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'receipt-replacement', physicalOffset: 0}],
        blocks: [],
        removed: []};
    const publication = {jobId: job.jobId,
        dictionaryGeneration: job.dictionaryGeneration,
        strategyVersion: job.strategyVersion,
        expectedCheckpointVersion: 0,
        expectedRootId: 'root-fixture',
        rootId: 'receipt-root',
        logicalHighWater: 4,
        manifest: {version: 1, regions: [{regionId: 'receipt-region', layoutId: 'receipt-layout', logicalStart: 0, logicalLength: 4}]},
        layouts: [{layoutId: 'receipt-layout', regionId: 'receipt-region', manifest, manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}],
        activatedFileIds: ['receipt-replacement'],
        retiredFileIds: ['source-pack'],
        retireFramesThrough: 4,
        cursor: {frame: 4},
        checkpoint: {nextAction: 'reclaim'}};
    connection.exec(`INSERT INTO termContentOptimizationCheckpoints(jobId, sequence, kind, fileId, byteOffset, byteLength, sha256, metadataJson)
        VALUES ('job-fixture', 0, 'frame', NULL, 0, 1, NULL, '{}')`);
    if (fault === 'training-cost') {
        // These pages were allocated after the job began, but before it
        // attempted publication. Deleting rows does not truncate them.
        connection.exec(`INSERT INTO termContentOptimizationCheckpoints(jobId, sequence, kind, fileId, byteOffset, byteLength, sha256, metadataJson)
            VALUES ('job-fixture', 99, 'frame', NULL, 0, 0, NULL, zeroblob(262144))`);
    }
    const quarantine = vi.spyOn(database, '_quarantineBulkImportConnection').mockImplementation(() => {});
    const execute = connection.exec.bind(connection);
    const selectValue = connection.selectValue.bind(connection);
    let failNextReadback = false;
    const selectSpy = vi.spyOn(connection, 'selectValue').mockImplementation((...args) => {
        if (failNextReadback && args[0] === 'SELECT activeRootId FROM termContentStorageState WHERE singleton = 1') {
            failNextReadback = false;
            throw new Error('Durable root readback unavailable');
        }
        return Reflect.apply(selectValue, connection, args);
    });
    const acknowledgement = new Error('COMMIT acknowledgement failed');
    const spy = vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0]);
        if (sql === 'COMMIT' && fault === 'before-commit') { throw acknowledgement; }
        const result = Reflect.apply(execute, connection, args);
        if (sql === 'COMMIT' && fault !== 'valid') {
            if (fault === 'after-commit-bad-receipt') { execute("UPDATE termContentOptimizationJobs SET checkpointVersion = 99 WHERE jobId = 'job-fixture'"); }
            failNextReadback = fault === 'after-commit-unreadable-root';
            throw acknowledgement;
        }
        return result;
    });
    try {
        if (fault === 'valid' || fault === 'after-commit') {
            expect(database.publishOnlineContentStorageRoot(publication)).toEqual({rootId: 'receipt-root', epoch: 2, logicalHighWater: 4});
            expect(await database._termContentStore.createImportCheckpoint()).toMatchObject({
                version: 2, storageEpoch: 2, logicalHighWater: 4,
            });
            expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'reclaim', cursor: {frame: 4}, checkpointVersion: 1});
            expect(database._onlineContentPublicationRecoveryRequired).toBe(false);
        } else if (fault === 'before-commit' || fault === 'training-cost') {
            if (fault === 'training-cost') {
                expect(() => database.publishOnlineContentStorageRoot({...publication, physicalSavings: 32768}))
                    .toThrow(/database allocation consumes/);
            } else {
                expect(() => database.publishOnlineContentStorageRoot(publication)).toThrow(acknowledgement);
            }
            expect(await database._termContentStore.createImportCheckpoint()).toMatchObject({
                version: 2, storageEpoch: 1, logicalHighWater: 4,
            });
        } else {
            expect(() => database.publishOnlineContentStorageRoot(publication)).toThrow(
                fault === 'after-commit-unreadable-root' ? /requires connection recovery/ : /no matching job receipt/,
            );
            expect(database._onlineContentPublicationRecoveryRequired).toBe(true);
            expect(quarantine).toHaveBeenCalledOnce();
        }
        const committed = fault !== 'before-commit' && fault !== 'training-cost';
        expect(connection.selectValue('SELECT activeRootId FROM termContentStorageState')).toBe(committed ? 'receipt-root' : 'root-fixture');
        expect(connection.selectValue("SELECT COUNT(*) FROM termContentOptimizationCheckpoints WHERE kind = 'frame' AND sequence = 0"))
            .toBe(committed ? 0 : 1);
        expect(connection.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'receipt-replacement'"))
            .toBe(committed ? 'active' : 'staged');
        const retirements = connection.selectObjects("SELECT fileId, byteLength, metadataJson FROM termContentOptimizationCheckpoints WHERE kind = 'retired-file'");
        expect(retirements).toHaveLength(committed ? 1 : 0);
        if (committed) {
            expect(retirements[0]).toMatchObject({fileId: 'source-pack', byteLength: 4});
            expect(JSON.parse(String(retirements[0].metadataJson))).toEqual({version: 1,
                path: 'manabitan-online-content-v1/source-pack.bin',
                ownerJobId: 'fixture-owner',
                sourceRootId: 'root-fixture'});
        }
        if (fault === 'after-commit') {
            expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'completed', expectedCheckpointVersion: 1})).toThrow(/must reclaim/);
        }
        expect(spy.mock.calls.some((args) => /** @type {unknown} */ (args[0]) === 'ROLLBACK')).toBe(!committed);
    } finally {
        spy.mockRestore();
        selectSpy.mockRestore();
    }
});


/**
 * @param {number} offset
 * @param {string} [physicalKey]
 * @returns {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor}
 */
function discoveredFrame(offset, physicalKey = 'root:source-a:0+32,source-b:0+32') {
    return {identity: {kind: 'block',
        logicalOffset: offset,
        recordLength: 64,
        sourceStoredLength: 64,
        originalCodecId: null,
        expectedDecodedLength: 128,
        originalEnvelope: 'none'},
    physicalKey,
    storedLength: 64,
    codecId: null,
    envelope: 'none',
    decodedLength: 128,
    decodedDigest: null};
}

/**
 * @param {Awaited<ReturnType<typeof createJobFixture>>} fixture
 * @param {number} version
 * @param {number} cursor
 * @param {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor[]} frames
 * @returns {number}
 */
function saveDiscoveredPage(fixture, version, cursor, frames) {
    return fixture.database.recordOnlineContentOptimizationFramePage({
        job: {...fixture.job, phase: 'discover', cursor: {record: cursor}, checkpoint: {discovery: true}, expectedCheckpointVersion: version}, frames,
    });
}

test('durable frame pages deduplicate exact replay and preserve generalized physical span identity', async () => {
    const f = await createJobFixture();
    const frame = discoveredFrame(2 ** 34 + 7);
    expect(saveDiscoveredPage(f, 0, 1, [frame, structuredClone(frame)])).toBe(1);
    f.connection.exec({
        sql: 'UPDATE termContentOptimizationCheckpoints SET metadataJson = $metadataJson WHERE jobId = $jobId',
        bind: {$metadataJson: JSON.stringify({version: 1, frame}), $jobId: f.job.jobId},
    });
    expect(saveDiscoveredPage(f, 1, 2, [structuredClone(frame)])).toBe(2);
    expect(f.connection.selectValue("SELECT COUNT(*) FROM termContentOptimizationCheckpoints WHERE kind = 'frame'")).toBe(1);
    expect(f.database.getOnlineContentOptimizationFramePage(f.job.jobId)).toEqual({frames: [frame], cursor: null, hasMore: false});
    expect(f.database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {record: 2}, checkpointVersion: 2});
});

test('a conflict rolls back preceding frame inserts and keeps the previous durable cursor', async () => {
    const f = await createJobFixture();
    saveDiscoveredPage(f, 0, 1, [discoveredFrame(10)]);
    expect(() => saveDiscoveredPage(f, 1, 2, [discoveredFrame(20), discoveredFrame(10, 'different-immutable-file')])).toThrow(/conflicts/);
    expect(f.database.getOnlineContentOptimizationFramePage(f.job.jobId).frames).toEqual([discoveredFrame(10)]);
    expect(f.database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {record: 1}, checkpointVersion: 1});
    expect(() => saveDiscoveredPage(f, 0, 3, [])).toThrow(/stale/);
    f.connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
        bind: {$title: f.job.dictionaryTitle, $summary: JSON.stringify({title: f.job.dictionaryTitle, importSuccess: true, storageGenerationId: 'new-generation'})}});
    expect(() => saveDiscoveredPage(f, 1, 3, [discoveredFrame(30)])).toThrow(/target generation/);
    expect(f.database.getOnlineContentOptimizationJobs()[0].cursor).toEqual({record: 1});
});

test('the real optimizer host resumes after the final nonempty SQL frame page', async () => {
    const f = await createLayoutDatabase(4);
    installPhysicalFixture(f.connection, 'host-source', 4);
    installLayoutFixture(f, [{version: 1,
        regionId: 'host-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'host-source', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    await f.database._termContentStore.activateCommittedRoot({storageEpoch: 1, logicalHighWater: 4});
    f.connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'host-generation'})}});
    const repack = vi.fn(() => { throw new Error('Unexpected repack during discovery and sampling'); });
    const createRunner = () => f.database.createOnlineContentOptimizationRunner({
        planBatch: repack,
        stageBatch: repack,
        verificationPage: repack,
        measureBatch: repack,
        publishBatch: repack,
    });
    const signal = new AbortController().signal;
    const run = createRunner();
    await run(signal);
    const [job] = f.database.getOnlineContentOptimizationJobs(true);
    expect(job).toMatchObject({dictionaryGeneration: 'host-generation', phase: 'discover', checkpointVersion: 0});
    f.database.checkpointOnlineContentOptimizationJob({
        job: {...job, phase: 'sample', expectedCheckpointVersion: 0},
        frames: [discoveredFrame(0)],
    });

    await run(signal);
    expect(f.database.getOnlineContentOptimizationJobs(true)[0]).toMatchObject({
        phase: 'sample', checkpoint: {sampleMode: 'summary', frameCursor: 0, sampler: {summary: {entries: 1}}},
    });
    await createRunner()(signal);
    expect(f.database.getOnlineContentOptimizationJobs(true)[0]).toMatchObject({
        phase: 'sample', checkpoint: {sampleMode: 'select', frameCursor: null, sampler: {summary: {entries: 1}}},
    });
    expect(repack).not.toHaveBeenCalled();
});

test('ordered keyset pages survive JSON restart without 32-bit offset truncation', async () => {
    const f = await createJobFixture();
    const offsets = [2 ** 35 + 17, 3, 2 ** 32 + 9];
    saveDiscoveredPage(f, 0, 3, offsets.map((offset) => discoveredFrame(offset)));
    const first = f.database.getOnlineContentOptimizationFramePage(f.job.jobId, null, 1);
    const second = f.database.getOnlineContentOptimizationFramePage(f.job.jobId, JSON.parse(JSON.stringify(first.cursor)), 1);
    const third = f.database.getOnlineContentOptimizationFramePage(f.job.jobId, JSON.parse(JSON.stringify(second.cursor)), 1);
    expect([first, second, third].flatMap((page) => page.frames.map((frame) => frame.identity.logicalOffset)))
        .toEqual([...offsets].sort((a, b) => a - b));
    expect(first.hasMore).toBe(true);
    expect(third).toMatchObject({cursor: null, hasMore: false});
});

test('frame page input and output respect encoded metadata budgets', async () => {
    const f = await createJobFixture();
    const frames = Array.from({length: 100}, (_, index) => discoveredFrame(index * 100, 'x'.repeat(12000)));
    expect(() => saveDiscoveredPage(f, 0, 100, frames)).toThrow(/metadata exceeds admission/);
    expect(f.connection.selectValue('SELECT COUNT(*) FROM termContentOptimizationCheckpoints')).toBe(0);
    saveDiscoveredPage(f, 0, 50, frames.slice(0, 50));
    saveDiscoveredPage(f, 1, 100, frames.slice(50));
    const page = f.database.getOnlineContentOptimizationFramePage(f.job.jobId, null, 128);
    expect(page.frames.length).toBeLessThan(100);
    expect(page.hasMore).toBe(true);
    const second = f.database.getOnlineContentOptimizationFramePage(f.job.jobId, JSON.parse(JSON.stringify(page.cursor)), 128);
    expect(page.frames.length + second.frames.length).toBe(100);
});

test('damaged optional frame metadata fails without quarantining imported content', async () => {
    const f = await createJobFixture();
    saveDiscoveredPage(f, 0, 1, [discoveredFrame(0)]);
    f.connection.exec("UPDATE termContentOptimizationCheckpoints SET metadataJson = '{\"version\":999}'");
    let caught;
    try {
        f.database.getOnlineContentOptimizationFramePage(f.job.jobId);
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(TermContentIntegrityError);
    expect(f.connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1);
    expect(f.database._onlineContentPublicationRecoveryRequired).toBe(false);
});

test.each(['begin-ack', 'before-commit', 'after-commit'])('frame checkpoint reconciles %s with exact receipt ownership', async (fault) => {
    const f = await createJobFixture();
    const execute = f.connection.exec.bind(f.connection);
    const failure = new Error('Injected transaction acknowledgement failure');
    const spy = vi.spyOn(f.connection, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0]);
        if (fault === 'before-commit' && sql === 'COMMIT') { throw failure; }
        const result = Reflect.apply(execute, f.connection, args);
        if ((fault === 'begin-ack' && sql === 'BEGIN IMMEDIATE') || (fault === 'after-commit' && sql === 'COMMIT')) { throw failure; }
        return result;
    });
    try {
        if (fault === 'after-commit') {
            expect(saveDiscoveredPage(f, 0, 1, [discoveredFrame(4)])).toBe(1);
        } else {
            expect(() => saveDiscoveredPage(f, 0, 1, [discoveredFrame(4)])).toThrow(failure);
        }
        const committed = fault === 'after-commit';
        expect(f.database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(committed ? 1 : 0);
        expect(f.database.getOnlineContentOptimizationFramePage(f.job.jobId).frames).toHaveLength(committed ? 1 : 0);
        expect(spy.mock.calls.some((args) => /** @type {unknown} */ (args[0]) === 'ROLLBACK')).toBe(!committed);
        const pointer = f.connection.pointer;
        if (typeof pointer === 'undefined') { throw new Error('Expected an open fixture connection'); }
        expect(sqlite3.capi.sqlite3_get_autocommit(pointer)).toBe(1);
    } finally { spy.mockRestore(); }
});


test('a deferred job with an unreclaimed artifact retains physical ownership', async () => {
    const {database, connection, job} = await createJobFixture();
    database.reserveOnlineContentStorageFile(job.jobId, 'pending-private-file');
    database.saveOnlineContentOptimizationJob({...job,
        phase: 'deferred',
        expectedCheckpointVersion: 0,
        cursor: {frame: 8},
        checkpoint: {resumePhase: 'discover'},
        retryAfter: Date.now() + 30000});
    connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: 'Other', $summary: JSON.stringify({title: 'Other', importSuccess: true, storageGenerationId: 'other-generation'})}});
    const next = {...job, jobId: 'next-job', dictionaryTitle: 'Other', dictionaryGeneration: 'other-generation'};
    expect(() => database.saveOnlineContentOptimizationJob(next)).toThrow(/unfinished.*owns maintenance/);
    expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(2);
    expect(database.getOnlineContentOptimizationJobs()).toHaveLength(1);
    database.saveOnlineContentOptimizationJob({...job, phase: 'reclaim', expectedCheckpointVersion: 1});
    connection.exec(`DELETE FROM termContentStorageFiles WHERE ownerJobId = '${job.jobId}'`);
    database.saveOnlineContentOptimizationJob({...job, phase: 'failed', expectedCheckpointVersion: 2});
    expect(database.saveOnlineContentOptimizationJob(next)).toBe(0);
});

test('deferral before any file intent leaves the next generation free to use the write slot', async () => {
    const {database, connection, job} = await createJobFixture();
    database.saveOnlineContentOptimizationJob({...job,
        phase: 'deferred',
        expectedCheckpointVersion: 0,
        retryAfter: Date.now() + 30000,
        checkpoint: {resumePhase: 'discover'}});
    connection.exec({
        sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: 'Other', $summary: JSON.stringify({title: 'Other', importSuccess: true, storageGenerationId: 'other-generation'})},
    });
    const next = {...job, jobId: 'next-job', dictionaryTitle: 'Other', dictionaryGeneration: 'other-generation'};
    expect(database.saveOnlineContentOptimizationJob(next)).toBe(0);
    expect(database.getOnlineContentOptimizationJobs(true).map((entry) => entry.phase).sort()).toEqual(['deferred', 'discover']);
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'discover', expectedCheckpointVersion: 1}))
        .toThrow(/unfinished.*owns maintenance/);
});

test('a failed terminal verdict must clean staged artifacts before releasing ownership', async () => {
    const {database, connection, job} = await createJobFixture();
    database.reserveOnlineContentStorageFile(job.jobId, 'failed-private-artifact');
    expect(() => database.saveOnlineContentOptimizationJob({...job, phase: 'failed', expectedCheckpointVersion: 0})).toThrow(/must reclaim/);
    database.saveOnlineContentOptimizationJob({...job, phase: 'reclaim', expectedCheckpointVersion: 0});
    connection.exec("DELETE FROM termContentStorageFiles WHERE fileId = 'failed-private-artifact'");
    expect(database.saveOnlineContentOptimizationJob({...job, phase: 'failed', expectedCheckpointVersion: 1})).toBe(2);
});

test('optimization follows the same storage generation through an actual dictionary rename', async () => {
    const f = await createJobFixture();
    saveDiscoveredPage(f, 0, 1, [discoveredFrame(4)]);
    await f.database.replaceDictionaryTitle('Fixture', 'Renamed');
    expect(f.database._getOnlineContentOptimizationTarget(f.job)).toMatchObject({title: 'Renamed'});
    expect(saveDiscoveredPage(f, 1, 2, [discoveredFrame(4), discoveredFrame(128)])).toBe(2);
    expect(f.database.getOnlineContentOptimizationJobs()[0]).toMatchObject({dictionaryTitle: 'Fixture', dictionaryGeneration: 'job-generation', cursor: {record: 2}});
    f.connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'different-generation'})}});
    expect(f.database._getOnlineContentOptimizationTarget(f.job)).toMatchObject({title: 'Renamed'});
    f.connection.exec("DELETE FROM dictionaries WHERE title = 'Renamed'");
    expect(f.database._getOnlineContentOptimizationTarget(f.job)).toBeNull();
    expect(() => saveDiscoveredPage(f, 2, 3, [discoveredFrame(192)])).toThrow(/target generation/);
});

test('ambiguous renamed generations cannot silently select a different dictionary', async () => {
    const {database, connection, job} = await createJobFixture();
    connection.exec("DELETE FROM dictionaries WHERE title = 'Fixture'");
    for (const title of ['One', 'Two']) {
        connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
            bind: {$title: title, $summary: JSON.stringify({title, importSuccess: true, storageGenerationId: job.dictionaryGeneration})}});
    }
    expect(() => database._getOnlineContentOptimizationTarget(job)).toThrow(/multiple installed owners/);
    expect(database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(0);
});


/**
 * @returns {Promise<Awaited<ReturnType<typeof createJobFixture>> & {resources: ReturnType<DictionaryDatabase['createOnlineContentOptimizationReadResources']>}>}
 */
async function privateSourceFixture() {
    const f = await createJobFixture();
    installPhysicalFixture(f.connection, 'private-legacy', 4, null, 'manabitan-term-content.bin');
    installLayoutFixture(f, [{version: 1,
        regionId: 'private-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'private-legacy', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    return {...f, resources: f.database.createOnlineContentOptimizationReadResources()};
}

/**
 * @returns {import('../ext/js/dictionary/term-content-layout.js').FrameIdentity}
 */
function privateFrameIdentity() {
    return {kind: 'legacy-entry',
        logicalOffset: 0,
        recordLength: 4,
        sourceStoredLength: 4,
        originalCodecId: null,
        expectedDecodedLength: 4,
        originalEnvelope: 'none'};
}

test('maintenance sources use private caches and classify actual frames without payload I/O', async () => {
    const f = await privateSourceFixture();
    const foreground = await f.database.getOnlineContentLayoutWindow(0);
    const globalReads = vi.spyOn(f.database._onlineContentPhysicalFileStore, 'readSlice').mockRejectedValue(new Error('Foreground cache must not own optional reads'));
    const privateReads = vi.spyOn(f.resources.physicalFiles, 'readSlice').mockImplementation(async (_file, offset, length) => new Uint8Array([1, 2, 3, 4]).slice(offset, offset + length));
    const source = f.database.acquireOnlineContentOptimizationSource(f.job, new AbortController().signal, f.resources);
    try {
        expect(source.target).toEqual({title: 'Fixture', termRecordStorageName: 'Fixture', generation: 'job-generation'});
        const frame = await source.source.describe(privateFrameIdentity());
        expect(frame).toMatchObject({codecId: null, storedLength: 4, decodedLength: 4});
        expect(frame.physicalKey).not.toContain(source.snapshot.rootId);
        expect(privateReads).not.toHaveBeenCalled();
        expect(await source.source.readSlice(1, 2)).toEqual(new Uint8Array([2, 3]));
        const chunks = [];
        for await (const chunk of source.readFrameChunks(privateFrameIdentity())) { chunks.push(...chunk); }
        expect(chunks).toEqual([1, 2, 3, 4]);
        expect(globalReads).not.toHaveBeenCalled();
        expect(f.resources.windows.size).toBe(1);
        expect(f.database._onlineContentLayoutWindowCache.size).toBe(1);
        expect(f.resources.windows.values().next().value).not.toBe(foreground);
        expect(f.database._onlineContentLayoutWindowCache.values().next().value).toBe(foreground);
    } finally { await source.close(); }
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(false);
});

test('closing a source joins started I/O before releasing its root lease and rejects new reads', async () => {
    const f = await privateSourceFixture();
    /** @type {(value: Uint8Array) => void} */
    let finish = () => {};
    /** @type {Promise<Uint8Array>} */
    const pending = new Promise((resolve) => { finish = resolve; });
    const read = vi.spyOn(f.resources.physicalFiles, 'readSlice').mockReturnValue(pending);
    const source = f.database.acquireOnlineContentOptimizationSource(f.job, new AbortController().signal, f.resources);
    const result = source.source.readSlice(0, 4).catch((error) => error);
    await vi.waitFor(() => { expect(read).toHaveBeenCalledOnce(); });
    const closing = source.close();
    expect(source.close()).toBe(closing);
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(true);
    await expect(source.source.readSlice(0, 4)).rejects.toThrow(/closed/);
    finish(new Uint8Array([1, 2, 3, 4]));
    expect(await result).toMatchObject({message: expect.stringContaining('closed')});
    await closing;
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(false);
});

test('real discovery physical identity survives unrelated root appends and exact frame replay', async () => {
    const f = await privateSourceFixture();
    const old = f.database.acquireOnlineContentOptimizationSource(f.job, new AbortController().signal, f.resources);
    try {
        const before = await old.source.describe(privateFrameIdentity());
        const state = f.database.getOnlineContentStorageState();
        const plan = await f.database._prepareOnlineContentIdentityPlan('private-append', 4, 6, [{fileId: 'private-arena',
            path: 'manabitan-term-content-arenas-v1/private-append/manabitan-term-content.bin',
            byteLength: 2,
            logicalStart: 4,
            logicalEnd: 6}]);
        f.connection.exec('BEGIN IMMEDIATE');
        f.database._insertOnlineContentIdentityRoot(state, 'private-appended-root', plan, 'append-owner');
        f.connection.exec('COMMIT');
        const next = f.database.acquireOnlineContentOptimizationSource(f.job, new AbortController().signal, f.resources);
        try {
            const after = await next.source.describe(privateFrameIdentity());
            expect(next.snapshot.rootId).not.toBe(old.snapshot.rootId);
            expect(after).toEqual(before);
            saveDiscoveredPage(f, 0, 1, [before]);
            expect(saveDiscoveredPage(f, 1, 2, [after])).toBe(2);
        } finally { await next.close(); }
    } finally { await old.close(); }
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(false);
});

test('abort and generation replacement stop real optional sources without changing dictionary health', async () => {
    const f = await privateSourceFixture();
    const controller = new AbortController();
    const source = f.database.acquireOnlineContentOptimizationSource(f.job, controller.signal, f.resources);
    try {
        controller.abort();
        await expect(source.source.describe(privateFrameIdentity())).rejects.toMatchObject({name: 'AbortError'});
    } finally { await source.close(); }
    const current = f.database.acquireOnlineContentOptimizationSource(f.job, new AbortController().signal, f.resources);
    try {
        f.connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
            bind: {$title: 'Fixture', $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'new-generation'})}});
        await expect(current.source.readSlice(0, 4)).rejects.toThrow(/target generation/);
        expect(f.database._onlineContentPublicationRecoveryRequired).toBe(false);
        expect(f.connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1);
    } finally { await current.close(); }
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(false);
});


test('failed checkpoint rollback quarantines the uncertain SQLite owner', async () => {
    const {database, connection, job} = await createJobFixture();
    const execute = connection.exec.bind(connection);
    const close = vi.spyOn(connection, 'close');
    const spy = vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        if (/** @type {unknown} */ (args[0]) === 'COMMIT') { throw new Error('commit rejected'); }
        if (/** @type {unknown} */ (args[0]) === 'ROLLBACK') { throw new Error('rollback rejected'); }
        return Reflect.apply(execute, connection, args);
    });
    expect(() => database.recordOnlineContentOptimizationFramePage({
        job: {...job, expectedCheckpointVersion: 0}, frames: [discoveredFrame(5)],
    })).toThrow(/rollback could not be confirmed/);
    expect(database._onlineContentPublicationRecoveryRequired).toBe(true);
    expect(database._db).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(() => database.getOnlineContentStorageState()).toThrow();
    spy.mockRestore();
    connections.splice(connections.indexOf(connection), 1);
});

test('an empty immutable store resets only after the last reader releases its lease', async () => {
    const f = await createJobFixture();
    installPhysicalFixture(f.connection, 'reset-source', 4);
    installLayoutFixture(f, [{version: 1,
        regionId: 'reset-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'reset-source', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    f.database.getOnlineContentStorageState();
    const purge = vi.spyOn(f.database, 'purge').mockResolvedValue(true);
    await f.database._resetEmptyOnlineContentStorage();
    expect(purge).not.toHaveBeenCalled();
    const lease = f.database._onlineContentSnapshots?.acquire();
    if (!lease) { throw new Error('Expected an immutable snapshot'); }
    f.connection.exec("DELETE FROM dictionaries WHERE title = 'Fixture'");
    try {
        await f.database._resetEmptyOnlineContentStorage();
        expect(purge).not.toHaveBeenCalled();
    } finally {
        lease.release();
    }
    await f.database._resetEmptyOnlineContentStorage();
    expect(purge).toHaveBeenCalledOnce();
});

test('online recovery refuses transaction-local roots and retains existing reader leases', async () => {
    const f = await createJobFixture();
    installPhysicalFixture(f.connection, 'recovery-source', 4);
    installLayoutFixture(f, [{version: 1,
        regionId: 'recovery-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'recovery-source', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    f.database.getOnlineContentStorageState();
    const snapshots = f.database._onlineContentSnapshots;
    if (snapshots === null) { throw new Error('Expected immutable snapshots'); }
    const lease = snapshots.acquire();
    f.database._onlineContentPublicationRecoveryRequired = true;
    f.connection.exec('BEGIN');
    try {
        expect(() => f.database.getOnlineContentStorageState()).toThrow(/unconfirmed SQLite transaction/);
        expect(() => f.database._confirmOnlineContentConnectionRecovery()).toThrow(/autocommit/);
        expect(f.database._onlineContentPublicationRecoveryRequired).toBe(true);
    } finally { f.connection.exec('ROLLBACK'); }
    f.database._confirmOnlineContentConnectionRecovery();
    expect(f.database._onlineContentPublicationRecoveryRequired).toBe(false);
    expect(f.database._onlineContentSnapshots).toBe(snapshots);
    expect(snapshots.hasActiveLeases).toBe(true);
    expect(lease.root.epoch).toBe(1);
    lease.release();
    expect(snapshots.hasActiveLeases).toBe(false);
});


test.each(['valid', 'wrong-digest', 'lost-commit-ack', 'unused-codec', 'begin-before', 'begin-after', 'short-dictionary', 'oversized-dictionary'])('publishes staged codec metadata with root cutover: %s', async (fault) => {
    const f = await createJobFixture('recompress');
    installPhysicalFixture(f.connection, 'codec-source', 20);
    installLayoutFixture(f, [{version: 1,
        regionId: 'codec-region',
        logicalStart: 0,
        logicalLength: 20,
        extents: [{logicalOffset: 0, length: 20, fileId: 'codec-source', physicalOffset: 0}],
        blocks: [],
        removed: []}]);
    await f.database._termContentStore.activateCommittedRoot({storageEpoch: 1, logicalHighWater: 20});
    const sha = 'd'.repeat(64),
        codecId = 'manabitan-zstd-' + sha;
    const dictionaryBytes = fault === 'short-dictionary' ? 7 : (fault === 'oversized-dictionary' ? 112641 : 16384);
    f.database.reserveOnlineContentStorageFile(f.job.jobId, 'codec-dictionary');
    f.database.sealOnlineContentStorageFile(f.job.jobId, 'codec-dictionary', dictionaryBytes, fault === 'wrong-digest' ? 'e'.repeat(64) : sha);
    f.database.reserveOnlineContentStorageFile(f.job.jobId, 'codec-frame');
    f.database.sealOnlineContentStorageFile(f.job.jobId, 'codec-frame', 12);
    const manifest = {version: 1,
        regionId: 'codec-region',
        logicalStart: 0,
        logicalLength: 20,
        extents: [],
        removed: [{logicalOffset: 0, length: 20}],
        blocks: [{kind: 'block',
            logicalOffset: 0,
            recordLength: 20,
            sourceStoredLength: 20,
            originalCodecId: null,
            expectedDecodedLength: 4,
            originalEnvelope: 'mbc2',
            fileId: 'codec-frame',
            physicalOffset: 0,
            storedLength: 12,
            codecId,
            envelope: 'mbc2',
            decodedLength: 4,
            decodedDigest: 'a'.repeat(64)}]};
    const publication = {jobId: f.job.jobId,
        dictionaryGeneration: f.job.dictionaryGeneration,
        strategyVersion: f.job.strategyVersion,
        expectedCheckpointVersion: 0,
        expectedRootId: 'root-fixture',
        rootId: 'codec-root',
        logicalHighWater: 20,
        manifest: {version: 1, regions: [{regionId: 'codec-region', layoutId: 'codec-layout', logicalStart: 0, logicalLength: 20}]},
        layouts: [{layoutId: 'codec-layout',
            regionId: 'codec-region',
            manifest,
            manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}],
        activatedFileIds: ['codec-dictionary', 'codec-frame'],
        retiredFileIds: ['codec-source'],
        codecs: [{codecId: fault === 'unused-codec' ? 'manabitan-zstd-' + 'f'.repeat(64) : codecId,
            fileId: 'codec-dictionary',
            dictionaryBytes,
            dictionarySha256: sha,
            strategy: {version: 1}}],
        cursor: {frame: 1},
        checkpoint: {afterReclaim: 'completed'}};
    const execute = f.connection.exec.bind(f.connection);
    const spy = vi.spyOn(f.connection, 'exec').mockImplementation((...args) => {
        if (/** @type {unknown} */ (args[0]) === 'BEGIN IMMEDIATE' && fault === 'begin-before') { throw new Error('begin admission failed'); }
        const result = Reflect.apply(execute, f.connection, args);
        if (/** @type {unknown} */ (args[0]) === 'BEGIN IMMEDIATE' && fault === 'begin-after') { throw new Error('begin acknowledgement failed'); }
        if (/** @type {unknown} */ (args[0]) === 'COMMIT' && fault === 'lost-commit-ack') { throw new Error('lost codec commit acknowledgement'); }
        return result;
    });
    try {
        if (['wrong-digest', 'unused-codec', 'begin-before', 'begin-after', 'short-dictionary', 'oversized-dictionary'].includes(fault)) {
            expect(() => f.database.publishOnlineContentStorageRoot(publication)).toThrow();
            expect(f.connection.selectValue('SELECT COUNT(*) FROM termContentStorageCodecs')).toBe(0);
            expect(f.connection.selectValue('SELECT activeRootId FROM termContentStorageState')).toBe('root-fixture');
            expect(f.database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(0);
            const pointer = f.connection.pointer;
            if (typeof pointer !== 'number') { throw new Error('Expected open SQLite owner'); }
            expect(sqlite3.capi.sqlite3_get_autocommit(pointer)).toBe(1);
            expect(f.database._db).toBe(f.connection);
            expect(f.database._onlineContentPublicationRecoveryRequired).toBe(false);
        } else {
            expect(f.database.publishOnlineContentStorageRoot(publication).rootId).toBe('codec-root');
            expect(f.connection.selectObject('SELECT codecId, fileId, dictionaryBytes, dictionarySha256 FROM termContentStorageCodecs'))
                .toEqual({codecId, fileId: 'codec-dictionary', dictionaryBytes: 16384, dictionarySha256: sha});
            expect(f.connection.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'codec-dictionary'")).toBe('active');
        }
    } finally { spy.mockRestore(); }
});


test('controller file reservations and job cursor commit together', async () => {
    const {database, connection, job} = await createJobFixture('sample');
    const version = database.checkpointOnlineContentOptimizationJob({job: {...job,
        expectedCheckpointVersion: 0,
        cursor: {sample: 1},
        checkpoint: {pendingSample: 'atomic-sample'}},
    frames: [],
    reserveFileIds: ['atomic-sample']});
    expect(version).toBe(1);
    expect(connection.selectObject("SELECT ownerJobId, state FROM termContentStorageFiles WHERE fileId = 'atomic-sample'"))
        .toEqual({ownerJobId: job.jobId, state: 'intent'});
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({cursor: {sample: 1}, checkpointVersion: 1});
    expect(() => database.checkpointOnlineContentOptimizationJob({job: {...job, expectedCheckpointVersion: 1, phase: 'completed'},
        frames: [],
        reserveFileIds: ['aborted-intent']})).toThrow();
    expect(connection.selectValue("SELECT COUNT(*) FROM termContentStorageFiles WHERE fileId = 'aborted-intent'")).toBe(0);
    expect(database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(1);
});

test.each(['normal', 'lost-ack'])('final discovery frame and next phase have one receipt: %s', async (fault) => {
    const {database, connection, job} = await createJobFixture();
    const execute = connection.exec.bind(connection);
    const spy = vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const result = Reflect.apply(execute, connection, args);
        if (/** @type {unknown} */ (args[0]) === 'COMMIT' && fault === 'lost-ack') { throw new Error('lost final discovery acknowledgement'); }
        return result;
    });
    try {
        expect(database.checkpointOnlineContentOptimizationJob({job: {...job, phase: 'sample', expectedCheckpointVersion: 0},
            frames: [discoveredFrame(5)]})).toBe(1);
        expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'sample', checkpointVersion: 1});
        expect(database.getOnlineContentOptimizationFramePage(job.jobId).frames).toEqual([discoveredFrame(5)]);
    } finally { spy.mockRestore(); }
});

test('sealing an observed sample and advancing training is atomic', async () => {
    const {database, connection, job} = await createJobFixture('sample');
    database.reserveOnlineContentStorageFile(job.jobId, 'seal-sample');
    expect(database.checkpointOnlineContentOptimizationJob({job: {...job, phase: 'train', expectedCheckpointVersion: 0},
        frames: [],
        sealedFiles: [{fileId: 'seal-sample', byteLength: 64, sha256: 'a'.repeat(64)}]})).toBe(1);
    expect(connection.selectObject("SELECT byteLength, state FROM termContentStorageFiles WHERE fileId = 'seal-sample'"))
        .toEqual({byteLength: 64, state: 'staged'});
    database.reserveOnlineContentStorageFile(job.jobId, 'seal-failed');
    expect(() => database.checkpointOnlineContentOptimizationJob({job: {...job, phase: 'completed', expectedCheckpointVersion: 1},
        frames: [],
        sealedFiles: [{fileId: 'seal-failed', byteLength: 64, sha256: 'b'.repeat(64)}]})).toThrow();
    expect(connection.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'seal-failed'")).toBe('intent');
});


test.each(['before', 'after'])('activation safely handles a failed BEGIN acknowledgement: %s', async (fault) => {
    const f = await createLayoutDatabase(4);
    f.database._sqlite3 = sqlite3;
    vi.spyOn(f.database._termContentStore, 'inventoryLegacyFiles').mockResolvedValue([
        {fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 4, logicalStart: 0, logicalEnd: 4},
    ]);
    const execute = f.connection.exec.bind(f.connection);
    const spy = vi.spyOn(f.connection, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0]);
        if (sql === 'BEGIN IMMEDIATE' && fault === 'before') { throw new Error('admission failed'); }
        const result = Reflect.apply(execute, f.connection, args);
        if (sql === 'BEGIN IMMEDIATE') { throw new Error('acknowledgement failed'); }
        return result;
    });
    await expect(f.database.activateOnlineContentStorage()).rejects.toThrow(/failed/);
    const pointer = f.connection.pointer;
    if (typeof pointer !== 'number') { throw new Error('Expected open SQLite owner'); }
    expect(sqlite3.capi.sqlite3_get_autocommit(pointer)).toBe(1);
    expect(f.database.getOnlineContentStorageState().epoch).toBe(0);
    expect(f.database._onlineContentPublicationRecoveryRequired).toBe(false);
    expect(spy.mock.calls.some((args) => /** @type {unknown} */ (args[0]) === 'ROLLBACK')).toBe(fault === 'after');
});

test('committed activation with failed runtime adoption quarantines its owner for reopen', async () => {
    const f = await createLayoutDatabase(4);
    f.database._sqlite3 = sqlite3;
    vi.spyOn(f.database._termContentStore, 'inventoryLegacyFiles').mockResolvedValue([
        {fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 4, logicalStart: 0, logicalEnd: 4},
    ]);
    vi.spyOn(f.database._termContentStore, 'activateCommittedRoot').mockRejectedValueOnce(new Error('adoption failed'));
    const close = vi.spyOn(f.connection, 'close');
    await expect(f.database.activateOnlineContentStorage()).rejects.toThrow(/requires connection recovery/);
    expect(f.database._onlineContentPublicationRecoveryRequired).toBe(true);
    expect(f.database._db).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    connections.splice(connections.indexOf(f.connection), 1);
});


test('real discovery adapter returns bounded records then the shared artifact without changing foreground caches', async () => {
    const f = await createJobFixture();
    const job = {...f.job, checkpointVersion: 0};
    const reference = {recordId: 1, entryContentOffset: 0, entryContentLength: 4, entryContentDictName: 'raw'};
    const iterator = vi.spyOn(f.database._termRecordStore, 'iterateContentReferences').mockResolvedValue({references: [reference,
        {...reference, recordId: 2, entryContentOffset: -1},
        {...reference, recordId: 3, entryContentLength: -1}],
    cursor: null,
    done: true,
    bytesRead: 128});
    f.connection.exec("INSERT INTO sharedGlossaryArtifacts(dictionary, contentOffset, contentLength, contentDictName, uncompressedLength) VALUES ('Fixture', 4, 12, 'raw-v4', 64)");
    const signal = new AbortController().signal;
    const page = await f.database.readOnlineContentOptimizationDiscoveryPage(job, null, signal);
    expect(page).toMatchObject({items: [{kind: 'reference', reference}], cursor: {stage: 'artifact'}, done: false});
    expect(iterator.mock.calls[0][3]).toMatchObject({maxReferences: 64, byteBudget: 262144});
    const artifact = await f.database.readOnlineContentOptimizationDiscoveryPage(job, page.cursor, signal);
    expect(artifact).toMatchObject({items: [{kind: 'artifact',
        artifact: {contentOffset: 4,
            contentLength: 12,
            contentDictName: 'raw-v4',
            uncompressedLength: 64}}],
    done: true});
    expect(await f.database.readOnlineContentOptimizationDiscoveryPage(job, artifact.cursor, signal))
        .toMatchObject({items: [], done: true});
    expect(f.database._sharedGlossaryArtifactMetaByDictionary.size).toBe(0);
    expect(f.database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(0);
});

test('discovery adapter rechecks foreground preemption after iterator I/O', async () => {
    const f = await createJobFixture();
    const abort = new AbortController();
    vi.spyOn(f.database._termRecordStore, 'iterateContentReferences').mockImplementation(async () => {
        abort.abort();
        return {references: [], cursor: null, done: true, bytesRead: 0};
    });
    await expect(f.database.readOnlineContentOptimizationDiscoveryPage({...f.job, checkpointVersion: 0}, null, abort.signal))
        .rejects.toMatchObject({name: 'AbortError'});
    expect(f.database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(0);
});

test('discovery adapter rejects generation replacement after iterator I/O', async () => {
    const f = await createJobFixture();
    vi.spyOn(f.database._termRecordStore, 'iterateContentReferences').mockImplementation(async () => {
        f.connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
            bind: {$title: 'Fixture',
                $summary: JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'new-generation'})}});
        return {references: [], cursor: null, done: true, bytesRead: 0};
    });
    await expect(f.database.readOnlineContentOptimizationDiscoveryPage({...f.job, checkpointVersion: 0}, null, new AbortController().signal))
        .rejects.toThrow(/generation changed/);
    expect(f.database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(0);
});

test('a renamed physical record store replays discovery without carrying its obsolete shard cursor', async () => {
    const f = await createJobFixture();
    f.connection.exec({sql: 'UPDATE dictionaries SET title = $title, summaryJson = $summary WHERE title = $old',
        bind: {$old: 'Fixture',
            $title: 'Renamed',
            $summary: JSON.stringify({title: 'Renamed',
                importSuccess: true,
                storageGenerationId: f.job.dictionaryGeneration,
                termRecordStorageName: 'new-physical-name'})}});
    const iterator = vi.spyOn(f.database._termRecordStore, 'iterateContentReferences')
        .mockResolvedValue({references: [], cursor: null, done: true, bytesRead: 0});
    const cursor = {version: 1, stage: 'records', storageName: 'old-physical-name', referenceCursor: {obsolete: true}};
    const result = await f.database.readOnlineContentOptimizationDiscoveryPage({...f.job, checkpointVersion: 0}, cursor, new AbortController().signal);
    expect(iterator.mock.calls[0].slice(0, 3)).toEqual(['new-physical-name', f.job.dictionaryGeneration, null]);
    expect(result).toMatchObject({cursor: {storageName: 'new-physical-name', stage: 'artifact'}, done: false});
});


test('discovery rejects a physical record storage change after I/O within the same logical generation', async () => {
    const f = await createJobFixture();
    vi.spyOn(f.database._termRecordStore, 'iterateContentReferences').mockImplementation(async () => {
        f.connection.exec({sql: 'UPDATE dictionaries SET summaryJson = $summary WHERE title = $title',
            bind: {$title: 'Fixture',
                $summary: JSON.stringify({title: 'Fixture',
                    importSuccess: true,
                    storageGenerationId: f.job.dictionaryGeneration,
                    termRecordStorageName: 'changed-during-read'})}});
        return {references: [], cursor: null, done: true, bytesRead: 0};
    });
    await expect(f.database.readOnlineContentOptimizationDiscoveryPage({...f.job, checkpointVersion: 0}, null, new AbortController().signal))
        .rejects.toThrow(/physical record storage changed/);
    expect(f.database.getOnlineContentOptimizationJobs()[0].checkpointVersion).toBe(0);
});


test.each(['legacy', 'explicit'])('supports opaque Unicode %s generations through rename and checkpoint CAS', async (kind) => {
    const f = await createLayoutDatabase(4);
    f.database._sqlite3 = sqlite3;
    const title = '日本語の自作辞書';
    const generation = kind === 'legacy' ? title : '世'.repeat(256);
    const summary = {title, importSuccess: true, ...(kind === 'explicit' ? {storageGenerationId: generation} : {})};
    f.connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES ($title, 1, $summary)',
        bind: {$title: title, $summary: JSON.stringify(summary)}});
    const job = {jobId: 'unicode-job',
        dictionaryTitle: title,
        dictionaryGeneration: generation,
        strategyVersion: 'strategy',
        phase: 'discover',
        cursor: null,
        checkpoint: {}};
    f.database.saveOnlineContentOptimizationJob(job);
    expect(f.database.getOnlineContentOptimizationJobs()[0].dictionaryGeneration).toBe(generation);
    f.connection.exec({sql: 'UPDATE dictionaries SET title = $new, summaryJson = $summary WHERE title = $old',
        bind: {$old: title,
            $new: '改名した辞書',
            $summary: JSON.stringify({title: '改名した辞書',
                importSuccess: true,
                storageGenerationId: generation,
                termRecordStorageName: title})}});
    expect(f.database.saveOnlineContentOptimizationJob({...job, phase: 'sample', expectedCheckpointVersion: 0})).toBe(1);
    expect(f.database._getOnlineContentOptimizationTarget(job)?.title).toBe('改名した辞書');
});


test.each(['transaction-owner', 'reused-layout-bytes'])('root publication rejects %s without changing the current root', async (fault) => {
    const {database, connection, job} = await createJobFixture('recompress');
    installPhysicalFixture(connection, 'original-pack', 4);
    const original = {version: 1,
        regionId: 'guard-region',
        logicalStart: 0,
        logicalLength: 4,
        extents: [{logicalOffset: 0, length: 4, fileId: 'original-pack', physicalOffset: 0}],
        blocks: [],
        removed: []};
    installLayoutFixture({database, connection}, [original]);
    await database._termContentStore.activateCommittedRoot({storageEpoch: 1, logicalHighWater: 4});
    database.reserveOnlineContentStorageFile(job.jobId, 'guard-replacement');
    database.sealOnlineContentStorageFile(job.jobId, 'guard-replacement', 4);
    const changed = {...original, extents: [{logicalOffset: 0, length: 4, fileId: 'guard-replacement', physicalOffset: 0}]};
    const publication = {jobId: job.jobId,
        dictionaryGeneration: job.dictionaryGeneration,
        strategyVersion: job.strategyVersion,
        expectedCheckpointVersion: 0,
        expectedRootId: 'root-fixture',
        rootId: 'guard-root',
        logicalHighWater: 4,
        manifest: {version: 1, regions: [{regionId: 'guard-region', layoutId: 'guard-region-layout', logicalStart: 0, logicalLength: 4}]},
        layouts: [{layoutId: 'guard-region-layout', regionId: 'guard-region', manifest: changed, manifestSha256: createHash('sha256').update(JSON.stringify(original)).digest('hex')}],
        activatedFileIds: ['guard-replacement'],
        retiredFileIds: ['original-pack'],
        cursor: {frame: 4},
        checkpoint: {nextAction: 'reclaim'}};
    const pointer = connection.pointer;
    if (typeof pointer === 'undefined') { throw new Error('Expected an open SQLite connection'); }
    if (fault === 'transaction-owner') {
        connection.exec('BEGIN IMMEDIATE');
        connection.exec("UPDATE dictionaries SET version = 7 WHERE title = 'Fixture'");
    }
    try {
        expect(() => database.publishOnlineContentStorageRoot(publication)).toThrow(
            fault === 'transaction-owner' ? /requires transaction ownership/ : /layout identity was reused/,
        );
        expect(connection.selectValue('SELECT activeRootId FROM termContentStorageState')).toBe('root-fixture');
        expect(connection.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'original-pack'")).toBe('active');
        expect(connection.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'guard-replacement'")).toBe('staged');
        expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'recompress', checkpointVersion: 0});
        if (fault === 'transaction-owner') {
            expect(sqlite3.capi.sqlite3_get_autocommit(pointer)).toBe(0);
            expect(connection.selectValue("SELECT version FROM dictionaries WHERE title = 'Fixture'")).toBe(7);
        }
    } finally {
        if (sqlite3.capi.sqlite3_get_autocommit(pointer) !== 1) { connection.exec('ROLLBACK'); }
    }
});

test('lost checkpoint acknowledgement requires the exact durable retry time', async () => {
    const {database, connection, job} = await createJobFixture();
    const execute = connection.exec.bind(connection);
    const failure = new Error('lost deferred acknowledgement');
    vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const result = Reflect.apply(execute, connection, args);
        if (/** @type {unknown} */ (args[0]) === 'COMMIT') {
            execute("UPDATE termContentOptimizationJobs SET retryAfter = 99 WHERE jobId = 'job-fixture'");
            throw failure;
        }
        return result;
    });
    expect(() => database.checkpointOnlineContentOptimizationJob({job: {...job,
        phase: 'deferred',
        expectedCheckpointVersion: 0,
        retryAfter: 42},
    frames: []})).toThrow(failure);
    expect(database.getOnlineContentOptimizationJobs()[0]).toMatchObject({phase: 'deferred', checkpointVersion: 1, retryAfter: 99});
});


test.each(['truncated', 'transient'])('codec dictionary %s reads retain their authoritative failure class and release leases', async (fault) => {
    const f = await createLayoutDatabase(20);
    const sha = 'b'.repeat(64);
    const codecId = 'manabitan-zstd-' + sha;
    installPhysicalFixture(f.connection, 'read-pack', 13);
    installPhysicalFixture(f.connection, 'read-dictionary', 8, sha);
    f.connection.exec({sql: 'INSERT INTO termContentStorageCodecs(codecId, fileId, formatVersion, dictionaryBytes, dictionarySha256, strategyJson) VALUES ($codecId, \'read-dictionary\', 1, 8, $sha, \'{}\')',
        bind: {$codecId: codecId, $sha: sha}});
    const identity = {kind: /** @type {const} */ ('block'),
        logicalOffset: 0,
        recordLength: 20,
        sourceStoredLength: 20,
        originalCodecId: null,
        expectedDecodedLength: 4,
        originalEnvelope: /** @type {const} */ ('mbc2')};
    installLayoutFixture(f, [{version: 1,
        regionId: 'read-codec-region',
        logicalStart: 0,
        logicalLength: 20,
        extents: [],
        removed: [{logicalOffset: 0, length: 20, frameLogicalOffset: 0}],
        blocks: [{...identity,
            fileId: 'read-pack',
            physicalOffset: 0,
            storedLength: 13,
            codecId,
            envelope: 'mbc2',
            decodedLength: 4,
            decodedDigest: 'a'.repeat(64)}]}]);
    const transient = new Error('Temporary codec OPFS failure');
    vi.spyOn(f.database._onlineContentPhysicalFileStore, 'readSlice').mockImplementation(async (file) => {
        if (file.fileId === 'read-dictionary') {
            if (fault === 'transient') { throw transient; }
            throw new ContentPhysicalFileIntegrityError('Codec physical length changed', file);
        }
        return new Uint8Array(13);
    });
    await expect(f.database._termContentBlockStore.readDecodedFrameDetailed(identity)).resolves.toMatchObject({
        status: fault === 'truncated' ? 'corrupt' : 'temporarilyUnavailable',
        reason: fault === 'truncated' ? expect.stringContaining('truncated or changed') : transient.message,
    });
    expect(f.database._onlineContentSnapshots?.hasActiveLeases).toBe(false);
    expect(f.database._onlineContentDictionaryCache.has(codecId)).toBe(false);
});

test('matched generations complete with no layout activation and a replacement generation is screened again', async () => {
    const {database, connection} = await createLayoutDatabase(0);
    connection.exec('PRAGMA user_version = 11');
    /**
     * @param {string} generation
     */
    const importFixtureGeneration = (generation) => {
        connection.exec({sql: 'DELETE FROM dictionaries'});
        connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES (?, 1, ?)',
            bind: ['Corpus', JSON.stringify({title: 'Corpus', importSuccess: true, storageGenerationId: generation})]});
    };
    importFixtureGeneration('initial');
    const activation = vi.spyOn(database, 'activateOnlineContentStorage');
    const scanned = vi.spyOn(database._termRecordStore, 'iterateContentReferences').mockImplementation(async (_name, _generation, _cursor, options) => {
        expect(options.skipSelector?.('raw-block-v1:jmdict')).toBe(true);
        expect(options.skipSelector?.('raw-block-v1')).toBe(false);
        return {references: [], cursor: null, done: true, bytesRead: 30};
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 4; ++i) { await database.runOnlineContentOptimizationStep(signal); }
    await expect(database.runOnlineContentOptimizationStep(signal)).resolves.toEqual({pending: false});
    expect(database.getOnlineContentOptimizationJobs().map((entry) => entry.phase)).toEqual(['no-gain']);
    expect(scanned).toHaveBeenCalledOnce();
    expect(activation).not.toHaveBeenCalled();
    expect(connection.selectValue('PRAGMA user_version')).toBe(11);

    importFixtureGeneration('replacement');
    for (let i = 0; i < 4; ++i) { await database.runOnlineContentOptimizationStep(signal); }
    await expect(database.runOnlineContentOptimizationStep(signal)).resolves.toEqual({pending: false});
    expect(scanned).toHaveBeenCalledTimes(2);
    expect(activation).not.toHaveBeenCalled();
    expect(connection.selectValue('PRAGMA user_version')).toBe(11);
});

test('a replaced dictionary invalidates its legacy proof inside the activation transaction', async () => {
    const {database, connection, job} = await createJobFixture();
    connection.exec('PRAGMA user_version = 10');
    const signal = new AbortController().signal;
    const proof = database._createLegacyOptimizationEligibilitySource(job, signal, () => {});
    vi.spyOn(database._termContentStore, 'inventoryLegacyFiles').mockImplementation(async () => {
        connection.exec({sql: 'UPDATE dictionaries SET summaryJson = ? WHERE title = ?',
            bind: [JSON.stringify({title: 'Fixture', importSuccess: true, storageGenerationId: 'replacement'}), 'Fixture']});
        return [{fileId: 'legacy-0', path: 'manabitan-term-content.bin', byteLength: 4, logicalStart: 0, logicalEnd: 4}];
    });
    const adopt = vi.spyOn(database._termContentStore, 'activateCommittedRoot');
    await expect(database.activateOnlineContentStorage(signal, proof.assertCurrent)).rejects.toThrow(/eligibility target generation/);
    expect(database.getOnlineContentStorageState().epoch).toBe(0);
    expect(connection.selectValue('PRAGMA user_version')).toBe(10);
    expect(connection.selectValue('SELECT count(*) FROM termContentStorageFiles')).toBe(0);
    expect(adopt).not.toHaveBeenCalled();
});


test.each(['missing-closure', 'missing-registry', 'missing-sidecar', 'wrong-bytes', 'valid'])('resolved private codec treats sidecar integrity strictly: %s', async (mode) => {
    const {database, connection} = await createLayoutDatabase(4);
    const payload = new Uint8Array([1, 2, 3]);
    const dict = new Uint8Array(8).fill(7);
    const sha = createHash('sha256').update(dict).digest('hex');
    const codecId = 'manabitan-zstd-' + sha;
    const codec = {codecId, fileId: 'private-dict', formatVersion: 1, dictionaryBytes: dict.length, dictionarySha256: sha};
    const file = {fileId: 'private-dict',
        byteLength: dict.length,
        sha256: sha,
        path: 'manabitan-online-content-v1/private-dict.bin'};
    const payloadFile = {fileId: 'private-frame',
        byteLength: payload.length,
        sha256: null,
        path: 'manabitan-online-content-v1/private-frame.bin'};
    installPhysicalFixture(connection, file.fileId, file.byteLength, sha);
    if (mode !== 'missing-registry') {
        connection.exec({
            sql: 'INSERT INTO termContentStorageCodecs VALUES (?, ?, 1, ?, ?, ?)',
            bind: [codecId, file.fileId, dict.length, sha, '{}'],
        });
    }
    const io = vi.spyOn(database, '_readOnlineContentPhysicalSlice').mockImplementation(async (locator) => {
        if (locator.fileId === payloadFile.fileId) { return payload; }
        if (mode === 'missing-sidecar') { throw new DOMException('Missing file', 'NotFoundError'); }
        return mode === 'wrong-bytes' ? new Uint8Array(dict.length) : dict;
    });
    const rootWindow = {rootId: 'root-fixture',
        epoch: 1,
        fileLocators: new Map([[file.fileId, parseContentPhysicalFile(file)], [payloadFile.fileId, parseContentPhysicalFile(payloadFile)]]),
        resolverData: {manifests: [],
            externalFrames: [],
            files: [file, payloadFile],
            physicalFiles: [file, payloadFile],
            codecs: mode === 'missing-closure' ? [] : [codec]}};
        /** @type {import('../ext/js/dictionary/term-content-layout.js').ResolvedContentFrame} */
    const frame = {identity: {kind: 'block',
        logicalOffset: 0,
        recordLength: 3,
        sourceStoredLength: 3,
        originalCodecId: null,
        expectedDecodedLength: 3,
        originalEnvelope: 'none'},
    sourceStoredLength: 3,
    spans: [{fileId: payloadFile.fileId, physicalOffset: 0, length: payload.length}],
    storedLength: payload.length,
    codecId,
    envelope: 'none',
    decodedLength: 3,
    decodedDigest: null};
    const result = database._readOnlineContentResolvedFrame(rootWindow, frame, 'test-physical-key');
    await (mode === 'valid' ? expect(result).resolves.toMatchObject({codecId, bytes: payload}) : expect(result).rejects.toBeInstanceOf(TermContentIntegrityError));
    if (mode === 'missing-closure') { expect(io).not.toHaveBeenCalled(); }
});
