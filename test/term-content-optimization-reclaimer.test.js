/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {createTermContentOptimizationCheckpoint} from '../ext/js/dictionary/term-content-optimization-controller.js';
import {TermContentOptimizationReclaimer} from '../ext/js/dictionary/term-content-optimization-reclaimer.js';
import {ContentStorageSnapshots} from '../ext/js/dictionary/term-content-storage-snapshots.js';

/** @typedef {import('@sqlite.org/sqlite-wasm').Database} Database */
/** @typedef {import('../ext/js/dictionary/term-content-optimization-controller.js').OptimizationJob} Job */
/** @typedef {import('../ext/js/dictionary/term-content-physical-file-store.js').ContentPhysicalFile} PhysicalFile */
/** @typedef {import('vitest').Mock<(file: PhysicalFile) => Promise<void>>} MockRemove */

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {Database[]} */
const connections = [];

beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(() => {
    for (const db of connections.splice(0)) { db.close(); }
    vi.restoreAllMocks();
});

const digest = 'a'.repeat(64);
const oldPath = 'manabitan-term-content.bin';

/**
 * @param {Database} db
 * @param {string} id
 * @param {string} state
 * @param {string} [owner]
 * @param {string} [path]
 */
function insertFile(db, id, state, owner = 'job', path = 'manabitan-online-content-v1/' + id + '.bin') {
    db.exec({sql: 'INSERT INTO termContentStorageFiles VALUES (?, ?, ?, ?, ?, ?)',
        bind: [id, path, state === 'intent' ? 0 : 4, null, state, owner]});
}

/**
 * @param {Database} db
 * @param {string} rootId
 * @param {number} epoch
 * @param {string} state
 * @param {string} fileId
 * @param {string|null} [codecId]
 */
function insertRoot(db, rootId, epoch, state, fileId, codecId = null) {
    const layoutId = `${rootId}-layout`;
    const regionId = `${rootId}-region`;
    const region = {regionId, logicalStart: 0, logicalLength: 4};
    const directory = JSON.stringify({version: 1, regions: [{...region, layoutId}]});
    const manifest = JSON.stringify({version: 1,
        ...region,
        extents: codecId === null ? [{logicalOffset: 0, length: 4, fileId, physicalOffset: 0}] : [],
        blocks: codecId === null ? [] : [{fileId, codecId}],
        removed: []});
    db.exec({sql: 'INSERT INTO termContentStorageRoots VALUES (?, ?, 4, ?, ?, 0)', bind: [rootId, epoch, state, directory]});
    db.exec({sql: 'INSERT INTO termContentStorageLayouts VALUES (?, 1, ?, ?, ?)', bind: [layoutId, regionId, manifest, digest]});
    db.exec({sql: 'INSERT INTO termContentStorageRootLayouts VALUES (?, ?, ?, 0, 4)', bind: [rootId, regionId, layoutId]});
}

/**
 * @param {Job['checkpoint']['afterReclaim']} [next]
 * @returns {{db: Database, job: Job, state: {leased: boolean}, removeFile: MockRemove, reclaimer: TermContentOptimizationReclaimer, options: ConstructorParameters<typeof TermContentOptimizationReclaimer>[0]}}
 */
function createFixture(next = 'completed') {
    const db = new sqlite3.oo1.DB(':memory:');
    connections.push(db);
    db.exec('PRAGMA foreign_keys = ON');
    const database = new DictionaryDatabase();
    database._db = db;
    database._initializeOnlineContentSchema();
    insertFile(db, 'source', 'retired', 'import-old', oldPath);
    insertFile(db, 'replacement', 'active');
    insertRoot(db, 'old-root', 1, 'retired', 'source');
    insertRoot(db, 'current-root', 2, 'active', 'replacement');
    db.exec("INSERT INTO termContentStorageState VALUES (1, 2, 4, 'current-root')");
    const checkpoint = createTermContentOptimizationCheckpoint('generation:strategy', {dictionaryCapacity: 16384, strategy: 1, level: 1});
    checkpoint.afterReclaim = next;
    if (next === 'recompress') {
        checkpoint.samples = [{fileId: 'sample', byteLength: 4, sha256: digest}];
        checkpoint.dictionary = {fileId: 'dictionary', byteLength: 4, sha256: digest};
    }
    /** @type {Job} */
    const job = {jobId: 'job',
        dictionaryTitle: 'Fixture',
        dictionaryGeneration: 'generation',
        strategyVersion: 'strategy',
        phase: 'reclaim',
        checkpoint,
        checkpointVersion: 4,
        retryAfter: null};
    db.exec({sql: `INSERT INTO termContentOptimizationJobs (
        jobId, dictionaryTitle, dictionaryGeneration, strategyVersion, phase, cursorJson, checkpointJson,
        checkpointVersion, retryAfter, updatedAt
    ) VALUES ('job', 'Fixture', 'generation', 'strategy', 'reclaim', 'null', ?, 4, NULL, 0)`,
    bind: [JSON.stringify(checkpoint)]});
    db.exec({sql: "INSERT INTO termContentOptimizationCheckpoints VALUES ('job', -1, 'retired-file', 'source', 0, 4, NULL, ?)",
        bind: [JSON.stringify({version: 1, sourceRootId: 'old-root', path: oldPath, ownerJobId: 'import-old'})]});
    const state = {leased: false};
    /** @type {(file: PhysicalFile) => Promise<void>} */
    const remove = () => Promise.resolve();
    const removeFile = vi.fn(remove);
    const options = {getDb: () => db,
        assertReady: vi.fn(),
        confirmAutocommit: (/** @type {Database} */ connection) => sqlite3.capi.sqlite3_get_autocommit(connection) === 1,
        quarantine: vi.fn(),
        hasActiveLeases: () => state.leased,
        removeFile,
        now: () => 100};
    const reclaimer = new TermContentOptimizationReclaimer(options);
    return {db, job, state, removeFile, reclaimer, options};
}

test('waits for leases and durably claims one exact retired file before removing it', async () => {
    const {db, job, state, reclaimer, removeFile} = createFixture();
    state.leased = true;
    const {signal} = new AbortController();
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: false, retryAt: 1100});
    expect(removeFile).not.toHaveBeenCalled();
    state.leased = false;
    removeFile.mockImplementationOnce((file) => {
        expect(file).toEqual({fileId: 'source', path: oldPath, byteLength: 4});
        expect(db.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'source'")).toBe('deleting');
        return Promise.resolve();
    });
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: false});
    expect(db.selectValue("SELECT 1 FROM termContentStorageFiles WHERE fileId = 'source'")).toBeUndefined();
    expect(db.selectValue("SELECT 1 FROM termContentOptimizationCheckpoints WHERE kind = 'retired-file'")).toBeUndefined();
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: false});
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: false});
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: true});
    expect(db.selectValues('SELECT rootId FROM termContentStorageRoots')).toEqual(['current-root']);
    expect(removeFile).toHaveBeenCalledTimes(1);
});

test('an old snapshot lease pins its retired file across root publication until the read finishes', async () => {
    const {db, job, state, reclaimer, removeFile} = createFixture();
    const snapshots = new ContentStorageSnapshots({epoch: 1,
        logicalHighWater: 4,
        regions: [{regionId: 'old-root-region', layoutId: 'old-root-layout', logicalStart: 0, logicalLength: 4}]});
    const oldRead = snapshots.acquire();
    snapshots.publish(snapshots.current, {epoch: 2,
        logicalHighWater: 4,
        regions: [{regionId: 'current-root-region', layoutId: 'current-root-layout', logicalStart: 0, logicalLength: 4}]});
    Object.defineProperty(state, 'leased', {get: () => snapshots.hasActiveLeases});

    expect(oldRead.root.regions[0].layoutId).toBe('old-root-layout');
    expect(snapshots.isLayoutPinned('old-root-layout')).toBe(true);
    await expect(reclaimer.runStep(job, new AbortController().signal)).resolves.toMatchObject({job, done: false});
    expect(db.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'source'")).toBe('retired');
    expect(removeFile).not.toHaveBeenCalled();

    oldRead.release();
    expect(snapshots.isLayoutPinned('old-root-layout')).toBe(false);
    await expect(reclaimer.runStep(job, new AbortController().signal)).resolves.toEqual({job, done: false});
    expect(removeFile).toHaveBeenCalledWith({fileId: 'source', path: oldPath, byteLength: 4});
});


test('joins an interrupted removal and replays its deleting receipt after restart', async () => {
    const {db, job, reclaimer, removeFile, options} = createFixture();
    const controller = new AbortController();
    removeFile.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve();
    });
    await expect(reclaimer.runStep(job, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(db.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'source'")).toBe('deleting');
    expect(db.selectValue("SELECT 1 FROM termContentOptimizationCheckpoints WHERE kind = 'retired-file'")).toBe(1);
    removeFile.mockRejectedValueOnce(new DOMException('Gone', 'NotFoundError'));
    const restarted = new TermContentOptimizationReclaimer(options);
    await expect(restarted.runStep(job, new AbortController().signal)).resolves.toEqual({job, done: false});
    expect(db.selectValue("SELECT 1 FROM termContentStorageFiles WHERE fileId = 'source'")).toBeUndefined();
});

test('keeps samples and the dictionary for the next batch and deletes unpublished batch files', async () => {
    const {db, job, reclaimer, removeFile} = createFixture('recompress');
    insertFile(db, 'sample', 'staged');
    insertFile(db, 'dictionary', 'active');
    insertFile(db, 'temp-pack', 'intent');
    const {signal} = new AbortController();
    await reclaimer.runStep(job, signal);
    removeFile.mockRejectedValueOnce(new DOMException('Never created', 'NotFoundError'));
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: false});
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: true});
    expect(db.selectValues('SELECT fileId FROM termContentStorageFiles ORDER BY fileId')).toEqual(['dictionary', 'replacement', 'sample']);
    expect(removeFile).toHaveBeenNthCalledWith(2, {fileId: 'temp-pack', path: 'manabitan-online-content-v1/temp-pack.bin', byteLength: 0});
});

test.each(['active root', 'staged root', 'active codec', 'recovery checkpoint', 'missing layout join', 'omitted root region', 'noncontiguous layout', 'mismatched receipt'])('does not delete files protected by %s', async (kind) => {
    const {db, job, reclaimer, removeFile} = createFixture();
    switch (kind) {
        case 'active root':
            db.exec("UPDATE termContentStorageLayouts SET manifestJson = json_set(manifestJson, '$.extents[0].fileId', 'source') WHERE layoutId = 'current-root-layout'");
            break;
        case 'staged root':
            insertRoot(db, 'staged-root', 3, 'staged', 'source');
            break;
        case 'active codec':
            db.exec({sql: "INSERT INTO termContentStorageCodecs VALUES ('shared-codec', 'source', 1, 4, ?, '{}')", bind: [digest]});
            db.exec({sql: "UPDATE termContentStorageLayouts SET manifestJson = json_set(manifestJson, '$.blocks', json(?)) WHERE layoutId = 'current-root-layout'",
                bind: [JSON.stringify([{fileId: 'replacement', codecId: 'shared-codec'}])]});
            break;
        case 'recovery checkpoint':
            db.exec("INSERT INTO termContentOptimizationCheckpoints VALUES ('job', 1, 'recovery-asset', 'source', 0, 4, NULL, '{}')");
            break;
        case 'missing layout join':
            db.exec("DELETE FROM termContentStorageRootLayouts WHERE rootId = 'current-root'");
            break;
        case 'omitted root region':
            db.exec("UPDATE termContentStorageRoots SET manifestJson = json_set(manifestJson, '$.regions', json('[]')) WHERE rootId = 'current-root'");
            break;
        case 'noncontiguous layout':
            db.exec("UPDATE termContentStorageRoots SET manifestJson = json_set(manifestJson, '$.regions[0].logicalStart', 1) WHERE rootId = 'current-root'");
            db.exec("UPDATE termContentStorageRootLayouts SET logicalStart = 1 WHERE rootId = 'current-root'");
            db.exec("UPDATE termContentStorageLayouts SET manifestJson = json_set(manifestJson, '$.logicalStart', 1) WHERE layoutId = 'current-root-layout'");
            break;
        case 'mismatched receipt':
            db.exec('UPDATE termContentOptimizationCheckpoints SET byteLength = 5 WHERE sequence = -1');
            break;
    }
    await expect(reclaimer.runStep(job, new AbortController().signal)).rejects.toThrow(/referenced|live layout closure|does not match/);
    expect(removeFile).not.toHaveBeenCalled();
    expect(db.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'source'")).toBe('retired');
});

test('retains a transient failure and never unlinks under a stale job or caller-owned transaction', async () => {
    const {db, job, reclaimer, removeFile} = createFixture();
    const {signal} = new AbortController();
    const transient = new DOMException('Unavailable', 'NotReadableError');
    removeFile.mockRejectedValueOnce(transient);
    await expect(reclaimer.runStep(job, signal)).rejects.toBe(transient);
    expect(db.selectValue("SELECT state FROM termContentStorageFiles WHERE fileId = 'source'")).toBe('deleting');
    await expect(reclaimer.runStep({...job, checkpointVersion: 3}, signal)).rejects.toThrow(/stale/);
    db.exec('BEGIN');
    try {
        await expect(reclaimer.runStep(job, signal)).rejects.toThrow(/transaction ownership/);
        expect(sqlite3.capi.sqlite3_get_autocommit(db)).toBe(0);
    } finally { db.exec('ROLLBACK'); }
    expect(removeFile).toHaveBeenCalledTimes(1);
});

test('a committed cleanup with a lost acknowledgement does not unlink again', async () => {
    const {db, job, reclaimer, removeFile} = createFixture();
    const {signal} = new AbortController();
    const exec = db.exec.bind(db);
    const receiptLost = new Error('Cleanup acknowledgement was lost');
    const spy = vi.spyOn(db, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0]);
        const result = Reflect.apply(exec, db, args);
        if (sql === 'COMMIT') { throw receiptLost; }
        return result;
    });
    try {
        await expect(reclaimer.runStep(job, signal)).rejects.toBe(receiptLost);
        expect(db.selectValue("SELECT 1 FROM termContentStorageFiles WHERE fileId = 'source'")).toBeUndefined();
        expect(db.selectValue("SELECT 1 FROM termContentOptimizationCheckpoints WHERE kind = 'retired-file'")).toBeUndefined();
        expect(spy.mock.calls.some((args) => /** @type {unknown} */ (args[0]) === 'ROLLBACK')).toBe(false);
    } finally { spy.mockRestore(); }
    await expect(reclaimer.runStep(job, signal)).resolves.toEqual({job, done: false});
    expect(removeFile).toHaveBeenCalledTimes(1);
});


test.each(['no-files', 'intent', 'retired-receipt'])('only durable deferred physical ownership blocks another job reclamation: %s', async (mode) => {
    const {db, job, reclaimer, removeFile} = createFixture();
    db.exec(`INSERT INTO termContentOptimizationJobs (
            jobId, dictionaryTitle, dictionaryGeneration, strategyVersion, phase,
            cursorJson, checkpointJson, checkpointVersion, retryAfter, updatedAt
        ) VALUES ('parked', 'Parked', 'later-generation', 'strategy', 'deferred', 'null', '{}', 1, 50000, 0)`);
    if (mode === 'intent') {
        insertFile(db, 'parked-file', 'intent', 'parked');
    } else if (mode === 'retired-receipt') {
        db.exec("INSERT INTO termContentOptimizationCheckpoints VALUES ('parked', -2, 'retired-file', 'parked-source', 0, 4, NULL, '{}')");
    }
    const attempt = reclaimer.runStep(job, new AbortController().signal);
    if (mode === 'no-files') {
        await expect(attempt).resolves.toEqual({job, done: false});
        expect(removeFile).toHaveBeenCalledOnce();
        expect(db.selectValue("SELECT phase FROM termContentOptimizationJobs WHERE jobId = 'parked'")).toBe('deferred');
    } else {
        await expect(attempt).rejects.toThrow(/reclamation job is stale/);
        expect(removeFile).not.toHaveBeenCalled();
    }
});
