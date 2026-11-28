// Source fixture for run-old-reader-check.mjs. It is copied into one temporary
// candidate test file only for this explicit qualification; no normal unit auto-discovery.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {expect, test, vi} from 'vitest';

test('actual a300 reader refuses floor13 before recovery and preserves SQLite bytes', async () => {
    const configuration = JSON.parse(process.env.MANABITAN_REFERENCE_OLD_READER_CONFIG);
    const root = configuration.readerRoot;
    const oldFile = path.join(root, 'ext/js/dictionary/dictionary-database.js');
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash(await readFile(oldFile)), configuration.readerDatabaseSha256);
    const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    assert.equal(candidateCommit, configuration.candidateCommit);
    assert.equal(execFileSync('git', ['diff', 'HEAD', '--binary', '--', 'ext', 'dev/lib', 'dev/data/dictionary-wasm', 'package-lock.json']).byteLength, 0);
    const sqlite3 = await sqlite3InitModule();
    const connection = new sqlite3.oo1.DB(':memory:');
    // Wrapper-owned helper URL, bound in the explicit source receipt.
    // eslint-disable-next-line no-unsanitized/method
    const {createBoundedNodeOpfs} = await import(configuration.opfsAdapter);
    const environment = await createBoundedNodeOpfs();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => environment.root}});
    const fileHashes = async () => {
        const files = [];
        const walk = async (relative) => {
            for (const entry of await readdir(path.join(environment.rootPath, relative), {withFileTypes: true})) {
                const name = path.join(relative, entry.name);
                if (entry.isDirectory()) {
                    await walk(name);
                } else {
                    const bytes = await readFile(path.join(environment.rootPath, name));
                    files.push({name, bytes: bytes.byteLength, sha256: hash(bytes)});
                }
            }
        };
        await walk('');
        return files.sort((a, b) => a.name.localeCompare(b.name));
    };
    try {
        // Explicit source checkout validated by the wrapper's full runtime profile.
        // eslint-disable-next-line no-unsanitized/method
        const {TermRecordOpfsStore, createArtifactTermRecordChunkWithResolvedContent} = await import(path.join(process.cwd(), 'ext/js/dictionary/term-record-opfs-store.js'));
        const writer = new TermRecordOpfsStore();
        await writer.prepare();
        writer.setImportExperiments({experimentalReferenceTableFields: true});
        await writer.beginImportSession();
        const expressions = Array.from({length: 128}, (_, row) => new TextEncoder().encode(`term${row}`));
        const chunk = createArtifactTermRecordChunkWithResolvedContent({
            dictionary: 'Published format4',
            dictionaryTotalRows: 528299,
            rowCount: 128,
            expressionBytesList: expressions,
            readingBytesList: expressions,
            readingEqualsExpressionList: new Uint8Array(128).fill(1),
            scoreList: Int32Array.from({length: 128}, (_, row) => row % 5),
            sequenceList: new Int32Array(128).fill(-1),
        }, Uint32Array.from({length: 128}, (_, row) => row % 3), Float64Array.of(16, 40, 100), Uint32Array.of(7, 9, 11));
        await writer.appendBatchFromArtifactChunkResolvedContent(chunk, [], [], 'raw');
        await writer.endImportSession();
        assert.equal(writer.getLastEndImportSessionMetrics().referenceTableFieldChunkCount, 1);
        const beforeFiles = await fileHashes();
        assert.equal(beforeFiles.length, 2);
        const index = await readFile(path.join(environment.rootPath, beforeFiles.find((file) => file.name.endsWith('.mbti')).name));
        assert.equal(index.readUInt32LE(76), 4);
        connection.exec("CREATE TABLE published_dictionary(summary TEXT, payload BLOB); INSERT INTO published_dictionary VALUES ('format4 published', X'00010203FF');");
        connection.exec('BEGIN; PRAGMA user_version = 13; COMMIT;');
        const before = sqlite3.capi.sqlite3_js_db_export(connection.pointer);
        const sqliteFile = path.join(root, 'ext/js/dictionary/sqlite-wasm.js');
        vi.doMock(sqliteFile, async () => ({
            ...await vi.importActual(sqliteFile),
            getSqlite3: vi.fn(async () => sqlite3),
            openOpfsDatabase: vi.fn(async () => connection),
        }));
        // Exact previous-reader file identity checked above and by the wrapper.
        // eslint-disable-next-line no-unsanitized/method
        const {DictionaryDatabase} = await import(oldFile);
        const database = new DictionaryDatabase();
        const recovery = vi.spyOn(database, '_recoverInterruptedImportSession').mockResolvedValue();
        const content = vi.spyOn(database._termContentStore, 'prepare').mockResolvedValue();
        const activateRoot = vi.spyOn(database._termContentStore, 'activateCommittedRoot').mockResolvedValue();
        const purge = vi.spyOn(database, '_resumePersistentDictionaryPurge').mockResolvedValue(false);
        const records = vi.spyOn(database._termRecordStore, 'prepare').mockResolvedValue();
        const schema = vi.spyOn(database, '_initializeSchema').mockResolvedValue();
        const runtime = vi.spyOn(database, '_applyRuntimePragmas').mockImplementation(() => {});
        const health = vi.spyOn(database, '_restoreTermRecordDictionaryHealth').mockImplementation(() => {});
        await expect(database._openConnection()).rejects.toThrow('Dictionary storage schema 13 is newer than this build supports (12)');
        for (const method of [recovery, content, activateRoot, purge, records, schema, runtime, health]) { expect(method).not.toHaveBeenCalled(); }
        const after = sqlite3.capi.sqlite3_js_db_export(connection.pointer);
        assert.deepEqual(after, before);
        const afterFiles = await fileHashes();
        assert.deepEqual(afterFiles, beforeFiles);
        assert.equal(connection.selectValue('PRAGMA user_version'), 13);
        assert.deepEqual(connection.selectValues('SELECT summary FROM published_dictionary'), ['format4 published']);
        await writeFile(configuration.resultPath, JSON.stringify({
            success: true,
            readerDatabaseSha256: hash(await readFile(oldFile)),
            candidateCommit,
            readerCommit: configuration.readerCommit,
            beforeDatabaseSha256: hash(before),
            afterDatabaseSha256: hash(after),
            databaseBytes: after.byteLength,
            userVersion: 13,
            recoveryCalls: recovery.mock.calls.length,
            contentPrepareCalls: content.mock.calls.length,
            contentActivateRootCalls: activateRoot.mock.calls.length,
            persistentPurgeCalls: purge.mock.calls.length,
            recordPrepareCalls: records.mock.calls.length,
            schemaCalls: schema.mock.calls.length,
            runtimePragmaCalls: runtime.mock.calls.length,
            healthRestoreCalls: health.mock.calls.length,
            beforeFiles,
            afterFiles,
            actualFormat4Chunks: 1,
            boundary: 'Actual previous DictionaryDatabase._openConnection with real SQLite and real format4 record/index files from the candidate writer. OPFS prepare/recovery are observation spies and never reached; every SQLite and OPFS byte remains identical. No older-browser restart claim.',
        }, null, 2) + '\n');
    } finally {
        connection.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        await environment.dispose();
    }
});
