from pathlib import Path
import difflib, os, subprocess
r=Path.cwd(); o=Path(os.environ['RUNNER_TEMP'])/'names-evidence'; o.mkdir(exist_ok=True); original={}; updated={}
expected_blobs = {'ext/js/dictionary/term-record-opfs-store.js': '69f56e47bd8ca02065ae06554b7efcbde61305f5', 'ext/js/dictionary/dictionary-database.js': '42bf665846a9d2cdc3aaa1880548705c6e9a38ab', 'ext/js/dictionary/dictionary-worker-handler.js': '9b3c3262df7547388290cf4f8c1ead4ee6280a29', 'ext/js/pages/settings/dictionary-import-controller.js': '8c1f382d615b6e35b2c6ce5cc02cb02517bb3682', 'test/term-record-opfs-store.test.js': '6914419e284709a3a72ad5616af971aa95870c58', 'test/dictionary-database-import-cleanup.test.js': '2867a356341c78f1fb6646ea0432d7faedf14110', 'test/dictionary-import-controller-update-profile.test.js': '669d343edb9eb159d7e58bf3ae28e873102a00ce', 'test/dictionary-worker-handler-cleanup.test.js': '47e01284422473d1c74a9a3375fc2acb166b6fdf'}
for path, expected in expected_blobs.items():
    assert subprocess.check_output(['git', 'hash-object', path], text=True).strip() == expected, path
def replace(path, substitutions):
 p=(r/path).read_text(); original[path]=p
 for old,new in substitutions:
  assert old in p,(path,old)
  p=p.replace(old,new)
 updated[path]=p
store='ext/js/dictionary/term-record-opfs-store.js'; db='ext/js/dictionary/dictionary-database.js'; worker='ext/js/dictionary/dictionary-worker-handler.js'; page='ext/js/pages/settings/dictionary-import-controller.js'
replace(store,[(f'`${{{name}}}`.trim()',f'`${{{name}}}`') for name in ['value','dictionaryName','fromDictionaryName','toDictionaryName']]+[
 ('    async ensureDictionariesLoaded(dictionaryNames) {','    async ensureDictionariesLoaded(dictionaryNames) {\n        // Persisted names are identities; whitespace and U+FEFF are significant.'),
])
replace(db,[(f'`${{{name}}}`.trim()',f'`${{{name}}}`') for name in ['title','fromDictionaryTitle','toDictionaryTitle','dictionaryTitle','dictionaryName','storageName']]+[
 ('replacedDictionaryTitle.trim()', 'replacedDictionaryTitle'),
 ("String(dictionaryName || '').trim()", "String(dictionaryName || '')"),
 ('value.trim().length > 0', 'value.length > 0'),('return value.trim();','return value;'),
 ('this._asString(row.title).trim()', 'this._asString(row.title)'),
 ("title.replace(/\\s+\\[(?:update-staging|cutover|replaced) [^\\]]+\\]$/, '').trim()", "title.replace(/ \\[(?:update-staging|cutover|replaced) [^\\]]+\\]$/, '')"),
 ('    _registerTermRecordStorageName(dictionaryName, storageName) {','    _registerTermRecordStorageName(dictionaryName, storageName) {\n        // UI input normalization must not rewrite logical or physical storage identity.'),
])
replace(worker,[
 ("(Reflect.get(detailsRecord, 'replacementDictionaryTitle')).trim()", "(Reflect.get(detailsRecord, 'replacementDictionaryTitle'))"),
 ("(Reflect.get(result, 'sourceTitle')).trim()", "(Reflect.get(result, 'sourceTitle'))"),
 ('result.title.trim()', 'result.title'),('titleRaw.trim()', 'titleRaw'),
 ("String(dictionaryName || '').trim()", "String(dictionaryName || '')"),
])
replace(page,[
 ('dictionaryTitle.trim()', 'dictionaryTitle'),
 ('importDetails.replacementDictionaryTitle.trim()', 'importDetails.replacementDictionaryTitle'),
 ('result.sourceTitle.trim()', 'result.sourceTitle'),("String(result.title || '').trim()", "String(result.title || '')"),
 ('summary.sourceTitle.trim()', 'summary.sourceTitle'),('summary.replacedDictionaryTitle.trim()', 'summary.replacedDictionaryTitle'),
])
recordtests=r'''

describe('TermRecordOpfsStore exact dictionary identity', () => {
    const names = ['Dictionary', ' Dictionary ', '\ufeffDictionary', 'Dictionary\t', ' '];
    /** @param {string[]} dictionaryNames */
    const recordsFor = (dictionaryNames) => dictionaryNames.map((dictionary, i) => ({
        dictionary, expression: '猫', reading: 'ねこ', expressionReverse: null, readingReverse: null,
        entryContentOffset: i * 16, entryContentLength: 8, entryContentDictName: 'raw', score: 1, sequence: i,
    }));
    /** @param {Map<string, Uint8Array>} files */
    const reopen = async (files) => {
        const reader = new TermRecordOpfsStore();
        reader._recordsDirectoryHandle = createFakeDirectoryHandle(files);
        await reader._loadShardFiles(false);
        return reader;
    };

    test('lazy loading and diagnostics distinguish padded, BOM and whitespace-only names', async () => {
        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        const writer = await reopen(files);
        await writer.beginImportSession();
        await writer.appendBatch(recordsFor(names));
        await writer.endImportSession();
        const original = new Map([...files].map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
        const reader = await reopen(files);
        await reader.ensureDictionariesLoaded(names);
        for (const [i, name] of names.entries()) {
            assert.deepEqual(reader.findTermIds(name, '猫', 'expression'), [i + 1]);
            assert.equal((await reader.getByIdsAsync([i + 1])).get(i + 1)?.dictionary, name);
        }
        const diagnostics = reader.getDiagnostics(names).dictionaries;
        assert.ok(Array.isArray(diagnostics));
        assert.deepEqual(diagnostics.map(({dictionaryName}) => dictionaryName), names);
        assert.deepEqual(files, original);
    });

    test('index preparation and unavailable health never redirect to a trimmed sibling', async () => {
        const writer = new TermRecordOpfsStore();
        await writer.appendBatch(recordsFor(names));
        writer.ensureDictionaryIndexes(names);
        assert.deepEqual([...writer._indexByDictionary.keys()].sort(), [...names].sort());
        const reader = new TermRecordOpfsStore();
        reader.markDictionaryReimportRequired('Dictionary', 'terminal sibling');
        await reader.ensureDictionariesLoaded([' Dictionary ', '\ufeffDictionary']);
        assert.equal(reader.getDictionaryHealth('Dictionary').status, 'reimportRequired');
        assert.equal(reader.getDictionaryHealth(' Dictionary ').status, 'temporarilyUnavailable');
        assert.equal(reader.getDictionaryHealth('\ufeffDictionary').status, 'temporarilyUnavailable');
    });

    test('physical rename and deletion affect only the exact source and destination', async () => {
        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        const writer = await reopen(files);
        await writer.beginImportSession();
        await writer.appendBatch(recordsFor(['Dictionary', ' Dictionary ', 'Renamed']));
        await writer.endImportSession();
        const reader = await reopen(files);
        assert.equal(await reader.replaceDictionaryName(' Dictionary ', 'Renamed '), 1);
        const renamed = await reopen(files);
        await renamed.ensureDictionariesLoaded(['Dictionary', 'Renamed', 'Renamed ']);
        assert.deepEqual(renamed.findTermIds('Dictionary', '猫', 'expression'), [1]);
        assert.deepEqual(renamed.findTermIds('Renamed ', '猫', 'expression'), [2]);
        assert.deepEqual(renamed.findTermIds('Renamed', '猫', 'expression'), [3]);
        await renamed.deleteByDictionary('Renamed ');
        const deleted = await reopen(files);
        await deleted.ensureDictionariesLoaded(['Dictionary', 'Renamed', 'Renamed ']);
        assert.deepEqual(deleted.findTermIds('Dictionary', '猫', 'expression'), [1]);
        assert.deepEqual(deleted.findTermIds('Renamed', '猫', 'expression'), [3]);
        assert.deepEqual(deleted.findTermIds('Renamed ', '猫', 'expression'), []);
    });

    test('preserved rename rollback keeps exact source bytes and sibling dictionaries', async () => {
        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        const writer = await reopen(files);
        await writer.beginImportSession();
        await writer.appendBatch(recordsFor(['Dictionary', ' Dictionary ']));
        await writer.endImportSession();
        const original = new Map([...files].map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
        const reader = await reopen(files);
        assert.equal(await reader.replaceDictionaryName(' Dictionary ', '\ufeffRenamed ', true), 1);
        const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {storage: {getDirectory: async () => ({getDirectoryHandle: async () => createFakeDirectoryHandle(files)})}},
        });
        try {
            await reader.rollbackPreservedDictionaryRename(' Dictionary ', '\ufeffRenamed ');
            await reader.ensureDictionariesLoaded(['Dictionary', ' Dictionary ']);
            assert.deepEqual(reader.findTermIds('Dictionary', '猫', 'expression'), [1]);
            assert.deepEqual(reader.findTermIds(' Dictionary ', '猫', 'expression'), [2]);
            assert.deepEqual(files, original);
        } finally {
            if (typeof navigatorDescriptor === 'undefined') {
                Reflect.deleteProperty(globalThis, 'navigator');
            } else {
                Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
            }
        }
    });

    test('database mapping refresh preserves exact logical and physical storage names', () => {
        const database = new DictionaryDatabase();
        const rows = names.map((title) => ({title, summaryJson: JSON.stringify({termRecordStorageName: title})}));
        Reflect.set(database, '_db', {selectObjects: () => rows});
        database._refreshTermRecordStorageNameMappings();
        for (const title of names) {
            assert.equal(database._getTermRecordStorageName(title), title);
            assert.equal(database._getDictionaryNameForTermRecordStorage(title), title);
        }
        database._registerTermRecordStorageName('Logical', '\ufeffPhysical ');
        assert.equal(database._getTermRecordStorageName('Logical'), '\ufeffPhysical ');
        assert.equal(database._getDictionaryNameForTermRecordStorage('\ufeffPhysical '), 'Logical');
        assert.equal(database._getSummaryTermRecordStorageName({termRecordStorageName: ' '}, 'fallback'), ' ');
        assert.throws(() => database._registerTermRecordStorageName('Other', '\ufeffPhysical '), /collision/u);
    });

    test('startup integrity and durable health preserve title identity without orphaning shards', async () => {
        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        const writer = await reopen(files);
        await writer.beginImportSession();
        await writer.appendBatch(recordsFor(names));
        await writer.endImportSession();
        const original = new Map([...files].map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
        const database = new DictionaryDatabase();
        const reader = await reopen(files);
        Reflect.set(database, '_termRecordStore', reader);
        Reflect.set(database, '_db', {
            selectObjects: () => names.map((title) => ({title, summaryJson: JSON.stringify({counts: {terms: {total: 1}}})})),
        });
        database._refreshTermRecordStorageNameMappings();
        const integrity = await database._cleanupMissingTermRecordShards();
        assert.deepEqual(integrity.markedReimportRequiredTitles, []);
        assert.equal(integrity.shardIntegrity.removedOrphanShardCount, 0);
        assert.deepEqual(files, original);
        Reflect.set(database, '_db', {selectObjects: () => [{title: ' Dictionary ', reason: 'damaged'}]});
        database._restoreTermRecordDictionaryHealth();
        assert.equal(reader.getDictionaryHealth(' Dictionary ').status, 'reimportRequired');
        assert.equal(reader.getDictionaryHealth('Dictionary').status, 'available');
    });
});
'''
testpath='test/term-record-opfs-store.test.js'; t=(r/testpath).read_text(); original[testpath]=t
updated[testpath]=t.replace('import {describe, expect, test, vi}',"import assert from 'node:assert/strict';\nimport {describe, expect, test, vi}")+recordtests
p='test/dictionary-database-import-cleanup.test.js'; t=(r/p).read_text(); original[p]=t
start=t.index("    test('publishes an update by changing metadata")
end=t.index("    test('removes only an explicit failed-import",start)
block=t[start:end]
block=block.replace("test('publishes an update by changing metadata without copying immutable shards', async () =>", "test.each(['JMdict', ' \\ufeffJMdict '])('publishes an update with exact titles: %j', async (dictionaryTitle) =>")
block=block.replace("test('restores the old generation when direct staged publication fails', async () =>", "test.each(['JMdict', ' \\ufeffJMdict '])('restores exact titles after failed publication: %j', async (dictionaryTitle) =>")
block=block.replace("'JMdict'",'dictionaryTitle').replace('`JMdict ', '`${dictionaryTitle} ')
block=block.replace('test.each([dictionaryTitle,', "test.each(['JMdict',")
block=block.replace("'records-new'", "'\\ufeffrecords-new '").replace("'records-old'", "' records-old '")
t=t[:start]+block+t[end:]
newtest=r'''
    test('startup restoration removes only the generated separator from a replaced title', async () => {
        const database = new DictionaryDatabase();
        const originalTitle = ' \ufeffJMdict  ';
        const replacedTitle = `${originalTitle} [replaced identity-token]`;
        const restore = vi.spyOn(database, 'replaceDictionaryTitle').mockResolvedValue();
        vi.spyOn(database, 'deleteDictionary').mockResolvedValue();
        Reflect.set(database, '_db', {
            selectObjects: vi.fn(() => [{id: 1, title: replacedTitle, summaryJson: JSON.stringify({
                title: replacedTitle, importSuccess: true, transientUpdateStage: 'replaced', updateSessionToken: 'identity-token',
            })}]),
            exec: vi.fn(),
        });
        await database._cleanupIncompleteImports();
        expect(restore).toHaveBeenCalledWith(replacedTitle, originalTitle, expect.objectContaining({title: originalTitle}), null);
    });
'''
pos=t.index("    test('keeps dictionary metadata and requests reimport")
t=t[:pos]+newtest+'\n'+t[pos:]; updated[p]=t
p='test/dictionary-import-controller-update-profile.test.js'; t=(r/p).read_text(); original[p]=t
start=t.index("    test('skips profile dictionary rewrites")
end=t.index('\n});',start)
block=t[start:end]
block=block.replace("test('skips profile dictionary rewrites for profiles without carried-over update settings', async () =>", "test.each(['', ' \\ufeff'])('profile update preserves exact titles: %j', async (padding) =>")
block=block.replace('        const controller =', '        const oldTitle = `${padding}Jitendex.org [2025-01-01]${padding}`;\n        const newTitle = `${padding}Jitendex.org [2026-02-05]${padding}`;\n        const controller =',1)
block=block.replace("'Jitendex.org [2025-01-01]'",'oldTitle').replace("'Jitendex.org [2026-02-05]'",'newTitle')
block=block.replace('        expect(replaceDictionaryTitle).toHaveBeenCalledTimes(1);', '        expect(replaceDictionaryTitle).toHaveBeenCalledTimes(1);\n        expect(replaceDictionaryTitle).toHaveBeenCalledWith(expect.objectContaining({toDictionaryTitle: newTitle, replacedDictionaryTitle: oldTitle}));')
t=t[:start]+block+t[end:]
newtest=r'''
    test('visibility checks the exact installed title, not its trimmed sibling', async () => {
        const title = ' \ufeffJMdict ';
        const controller = createControllerForInternalTests();
        const exact = {name: title, enabled: true};
        const sibling = {name: 'JMdict', enabled: false};
        Reflect.set(controller, '_settingsController', {
            profileIndex: 0,
            getOptionsFull: vi.fn().mockResolvedValue({profiles: [{id: 'profile-1', options: {dictionaries: [exact, sibling]}}]}),
        });
        await expect(verifyImportedDictionaryVisible.call(controller, title, true)).resolves.toBeUndefined();
        exact.enabled = false;
        sibling.enabled = true;
        await expect(verifyImportedDictionaryVisible.call(controller, title, true)).rejects.toThrow('was not enabled');
    });
'''
pos=t.index("    test.each(['', ")
t=t[:pos]+newtest+'\n'+t[pos:]; updated[p]=t
p='test/dictionary-worker-handler-cleanup.test.js'; t=(r/p).read_text(); original[p]=t
newtest=r'''

describe('DictionaryWorkerHandler exact cleanup identity', () => {
    test('does not trim persisted names when deleting transient metadata or selecting its shards', async () => {
        const handler = new DictionaryWorkerHandler();
        const title = ' \ufeffJMdict [update-staging identity-token]';
        const sibling = title.trim();
        let predicate = (/** @type {string} */ _name) => false;
        const database = {
            getDictionaryInfo: vi.fn(async () => [{title, updateSessionToken: 'identity-token'}, {title: sibling, updateSessionToken: 'identity-token'}]),
            deleteDictionary: vi.fn(async (name) => {
                if (name !== title) { throw new Error('wrong identity'); }
            }),
            cleanupTransientTermRecordShards: vi.fn(async (callback) => { predicate = callback; return []; }),
        };
        await handler._cleanupTransientReplacementTitles(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            title,
        );
        expect(database.deleteDictionary).toHaveBeenCalledWith(title, 1000, expect.any(Function));
        expect(predicate(title)).toBe(true);
        // A differently spelled installed dictionary must never inherit permission to delete.
        expect(predicate(sibling)).toBe(false);
    });
});
'''
updated[p]=t+newtest
def patch(path): return ''.join(difflib.unified_diff(original[path].splitlines(True),updated[path].splitlines(True),fromfile='a/'+path,tofile='b/'+path))
(o/'names-tests.patch').write_text(''.join(patch(path) for path in updated if path.startswith('test/')))
(o/'names-fix.patch').write_text(''.join(patch(path) for path in updated if path.startswith('ext/')))
