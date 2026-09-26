from pathlib import Path
import hashlib
import json
import sys

root = Path(sys.argv[1])
target = root / 'test/dictionary-importer-term-manifest-completeness.test.js'
s = target.read_text()
s = s.replace('packedSource?: boolean}}', 'packedSource?: boolean, manifestText?: string}}')
s = s.replace('replaceList = false, packedSource = true} = {})', 'replaceList = false, packedSource = true, manifestText = void 0} = {})')
s = s.replace("new TextReader(JSON.stringify({\n        termBanks:", "new TextReader(manifestText ?? JSON.stringify({\n        termBanks:")
anchor = "    test('a complete packed manifest imports every bank', async () => {"
addition = '''    test.each(['{"termBanks":', 'null', '[]', 'true', '"invalid"'])('rejects an unreadable or malformed manifest root: %s', async (manifestText) => {
        const db = database()
        const close = vi.spyOn(ArchiveZipReader.prototype, 'close')
        await expect(importArchive(db, await archive('valid', {manifestText})))
            .rejects.toThrow(/incomplete.*term.*artifact.*manifest/i)
        expect(db.terms).toEqual([])
        expect(close).toHaveBeenCalledOnce()
        expect(db.startBulkImport).not.toHaveBeenCalled()
        expect(db.addWithResult).not.toHaveBeenCalled()
    })

    test.each(['{"termBanks":', 'null', '[]', 'true', '"invalid"'])('malformed manifest root falls back only to ordinary banks: %s', async (manifestText) => {
        const db = database()
        const result = await importArchive(db, await archive('valid', {manifestText, ordinary: true, standalone: true}))
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.terms.total).toBe(2)
        expect(result.result?.counts?.tagMeta.total).toBe(1)
        expect(db.terms).toEqual(['source1', 'source2'])
        expect(db.bulkAddArtifactTermsChunk).not.toHaveBeenCalled()
    })

'''
assert s.count(anchor) == 1
s = s.replace(anchor, addition + anchor)
target.write_text(s)
if '--tests-only' in sys.argv:
    sys.exit(0)
target = root / 'ext/js/dictionary/dictionary-importer.js'
s = target.read_text()
old = "        const incompleteTermArtifactManifest = termArtifactManifest?.termBanksComplete === false;"
new = """        const incompleteTermArtifactManifest = fileMap.has(TERM_BANK_ARTIFACT_MANIFEST_FILE) && (
            termArtifactManifest === null || termArtifactManifest.termBanksComplete === false
        );"""
assert s.count(old) == 1
s = s.replace(old, new)
old = "        if (!(typeof manifest === 'object' && manifest !== null)) {"
new = "        if (!(typeof manifest === 'object' && manifest !== null) || Array.isArray(manifest)) {"
assert s.count(old) == 1
s = s.replace(old, new)
target.write_text(s)
expected = {
    'ext/js/dictionary/dictionary-importer.js': 'd591a671bea5777e08541a3ef36726ec1b5af6d0142bc6a869e80caff4ab65f0',
    'test/dictionary-importer-term-manifest-completeness.test.js': 'cca6ba006af1949f714820b0a08b53894aece30ed5d859f14b3bc3a2daee4876',
}
for p, value in expected.items():
    assert hashlib.sha256((root / p).read_bytes()).hexdigest() == value, p
print(json.dumps(expected, indent=2))
