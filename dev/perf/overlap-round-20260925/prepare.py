from pathlib import Path
import hashlib

out = Path('builds/overlap-round')
out.mkdir(parents=True, exist_ok=True)
p = Path('ext/js/dictionary/term-content-block-store.js')
base = p.read_text()
assert hashlib.sha256(base.encode()).hexdigest() == '899f662f48c0b5935bdb442cba19e0d75112c843e6dd2144cd16c714752c5a70'
(out / 'base.js').write_text(base)
s = base.replace("            compressionDictName !== 'jmdict' ||", "            (compressionDictName !== 'jmdict' &&\n                !(force && this._compressionExperiments.experimentalGenericSpanCompression)) ||")
assert s != base
s = s.replace('     * a conservative margin beyond the normal measured-savings threshold.', '     * a conservative margin beyond the normal measured-savings threshold.\n     * Generic spans require a prior measured block-storage selection and the\n     * existing generic-span option; never use the initial-selection estimate.')
a = s.index('    _beginAppendSharedSpans(')
j = s.rfind('     * @param {string} compressionDictName', 0, a)
assert j >= 0
s = s[:j] + s[j:].replace('     * @param {string} compressionDictName', '     * @param {string|null} compressionDictName', 1)
assert hashlib.sha256(s.encode()).hexdigest() == '353496180bf8626098e6fdb6b6a98a144b6c42f1107630591be8ba1b3aa2157c'
p.write_text(s)
(out / 'candidate.js').write_text(s)

p = Path('test/term-content-block-store.test.js')
s = p.read_text()
for title in ['publishes reserved references while shared compression is pending', 'uses the reserved block plan after parallel shared compression fails', 'does not reread shared source after compression acknowledged consumption']:
    old = "    test('" + title + "', async () => {"
    a = s.index(old)
    b = s.index('\n    test(', a + len(old))
    f = s[a:b].replace(old, "    test.each(['jmdict', null])('" + title + " (%s)', async (dictName) => {")
    n = f.index('        const source =')
    f = f[:n] + '        blockStore.setCompressionExperiments({experimentalGenericSpanCompression: true});\n' + f[n:]
    f = f.replace("lengths, 'jmdict', true)", 'lengths, dictName, true)').replace("            'jmdict',\n            true,", '            dictName,\n            true,')
    f = f.replace("contentDictName: 'raw-block-v2:jmdict'", "contentDictName: dictName === null ? 'raw-block-v2' : 'raw-block-v2:jmdict'")
    s = s[:a] + f + s[b:]
p.write_text(s)

p = Path('test/generic-span-codec-integration.test.js')
s = p.read_text()
pos = s.index("    test('consumes the shared source")
extra = """    test.each([512, 4096, 1024 * 1024])('reserves generic spans only after measured selection (%i)', async (blockTargetBytes) => {
        const {source, offsets, lengths, expected} = makeSource();
        const late = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes, minInputBytes: 0});
        const early = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes, minInputBytes: 0});
        late.setCompressionExperiments(options);
        early.setCompressionExperiments(options);
        const lateSession = late.beginImportSession();
        const earlySession = early.beginImportSession();
        expect(earlySession.tryBeginAppendSpans('generic', source, offsets, lengths, null)).toBeNull();
        const first = await earlySession.appendSpans('generic', source, offsets, lengths, null);
        const firstLate = await lateSession.appendSpans('generic', source, offsets, lengths, null);
        expect(first).not.toBeNull();
        expect(firstLate).not.toBeNull();
        expect(earlySession.tryBeginAppendSpans('other', source, offsets, lengths, null)).toBeNull();
        const operation = earlySession.tryBeginAppendSpans('generic', source, offsets, lengths, null);
        if (operation === null) { throw new Error('Expected prior measured selection to enable reservations'); }
        expect(operation.initialSelection).toBe(false);
        const a = await lateSession.appendSpans('generic', source, offsets, lengths, null);
        const b = await operation.completion;
        await operation.sourceConsumed;
        if (a === null) { throw new Error('Expected compressed late append'); }
        expect(b.initialSelectionSavingsMiss).toBe(false);
        expect(b.compressedBytes).toBe(a.compressedBytes);
        expect(b.uncompressedBytes).toBe(a.uncompressedBytes);
        expect(b.contentDictName).toBe(a.contentDictName);
        early.setCompressionExperiments({experimentalGenericSpanCompression: false});
        expect(earlySession.tryBeginAppendSpans('generic', source, offsets, lengths, null)).toBeNull();
        early.setCompressionExperiments(options);
        const next = early.beginImportSession();
        expect(next.tryBeginAppendSpans('generic', source, offsets, lengths, null)).toBeNull();
        source.fill(255);
        early.clearCache();
        late.clearCache();
        for (let i = 0; i < expected.length; ++i) {
            expect(await early.read(b.contentOffsets[i], b.contentLengths[i], b.contentDictName)).toEqual(expected[i]);
            expect(await late.read(a.contentOffsets[i], a.contentLengths[i], a.contentDictName)).toEqual(expected[i]);
        }
        earlySession.close();
        lateSession.close();
        next.close();
    });

"""
p.write_text(s[:pos] + extra + s[pos:])
