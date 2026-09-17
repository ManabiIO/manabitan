from pathlib import Path
import base64, gzip, hashlib, subprocess, sys

ASSETS = Path(__file__).parent
modes = set(sys.argv[1:] or ['keys', 'skip', 'retain'])

def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == count, (path, old[:100], text.count(old), count)
    p.write_text(text.replace(old, new))

def flag(name):
    replace('ext/js/dictionary/term-bank-experiments.js', '    return Object.freeze({\n', f'    return Object.freeze({{\n        {name}: options.{name} === true,\n')
    replace('types/ext/dictionary-importer.d.ts', 'export type ImportExperiments = {\n', f'export type ImportExperiments = {{\n    {name}?: boolean;\n')

if 'keys' in modes:
    # Retain the exact previously measured patch, verified before applying.
    # The transport text contains one duplicated base64 pair; normalize that
    # spelling only. The decompressed SHA is the authoritative content gate.
    encoded = (ASSETS / 'known-keys.patch.gz.b64').read_text().replace('vApBlBlQk59', 'vApBlQk59')
    patch = gzip.decompress(base64.b64decode(encoded))
    assert hashlib.sha256(patch).hexdigest() == 'e674915f28c2bd00b1da7218ba630a3636ea6f10509bbf6f24f820a9dba2b237'
    Path('builds').mkdir(exist_ok=True)
    Path('builds/known-keys.patch').write_bytes(patch)
    subprocess.run(['git', 'apply', '--check', 'builds/known-keys.patch'], check=True)
    subprocess.run(['git', 'apply', 'builds/known-keys.patch'], check=True)

p = 'ext/js/dictionary/term-bank-wasm-parser.js'
if 'skip' in modes:
    flag('experimentalSkipFusedParse')
    replace(p, '        allowFusedParse &&\n', '        allowFusedParse &&\n        experiments.experimentalSkipFusedParse !== true &&\n')

if 'retain' in modes:
    flag('experimentalRetainedFusedFallback')
    replace(p, '    const initialMetaCapacity = Math.min(\n', '''    /** @type {TermBankExperimentProfile} */
    let retainedFallbackProfile = {};
    const sourceHeapEnd = experiments.experimentalRetainedFusedFallback === true ? wasm.wasm_alloc(0) : 0;
    const initialMetaCapacity = Math.min(
''')
    replace(p, '    if (useFusedParse) {\n', '    fusedParse: if (useFusedParse) {\n')
    replace(p, '        if (encodedContentBytes === -4 || encodedContentBytes === -5) {\n', '''        if (encodedContentBytes === -4 || encodedContentBytes === -5) {
            if (experiments.experimentalRetainedFusedFallback === true) {
                // No result has escaped this parser call. Preserve the source
                // prefix, discard only speculative output, and fall through to
                // the ordinary validating parser without recursion or copying.
                // wasm_alloc reserves bytes; it does not clear them. The source
                // checkpoint precedes every fused output allocation, including
                // source-bank spans and any compressed-preload bookkeeping.
                retainedFallbackProfile = {
                    fusedParseAttempts: 1,
                    fusedParseFallbacks: 1,
                    discardedFusedParseMs: parseBankMs,
                    discardedFusedRows: new Uint32Array(wasm.memory.buffer, rowCountPtr, 1)[0],
                    escapedKeyDecodeCount,
                    validatedGlossaryReuseCount,
                    globalExactContentReuseCount,
                    fastGlossaryNormalizationCount,
                    fastGlossaryNormalizationFallbackCount,
                };
                wasm.wasm_reset_heap();
                const heapBase = wasm.wasm_alloc(0);
                if (sourceHeapEnd < heapBase ||
                    wasm.wasm_alloc(sourceHeapEnd - heapBase) !== heapBase ||
                    wasm.wasm_alloc(0) !== sourceHeapEnd) {
                    throw new TermBankWasmResourceError('Failed to reserve retained parser source');
                }
                break fusedParse;
            }
''')
    replace(p, '    return {\n        wasm,\n        bankSpanCount,\n        jsonPtr,', '    return {\n        ...retainedFallbackProfile,\n        wasm,\n        bankSpanCount,\n        jsonPtr,')

if 'skip' in modes and 'retain' in modes:
    test = Path('test/term-bank-experiments.test.js')
    test.write_text(test.read_text() + '''

describe('fused fallback scheduling experiments', () => {
    test('both new scheduling flags default off and require literal true', () => {
        const defaults = snapshotTermBankExperiments()
        expect(defaults.experimentalSkipFusedParse).toBe(false)
        expect(defaults.experimentalRetainedFusedFallback).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({
                experimentalSkipFusedParse: value,
                experimentalRetainedFusedFallback: value,
            }))
            expect(snapshotTermBankExperiments(options).experimentalSkipFusedParse).toBe(false)
            expect(snapshotTermBankExperiments(options).experimentalRetainedFusedFallback).toBe(false)
        }
    })

    test.each([false, true])('bypass preserves valid fused output, preload=%s', async (preload) => {
        const sources = [JSON.stringify([row('first'), row('second')]), JSON.stringify([row('third')])]
        const baseline = await parse(sources, {}, preload)
        expect(baseline.profile.fusedParseAttempts).toBe(1)
        expect(baseline.profile.fusedParseFallbacks).toBe(0)
        const candidate = await parse(sources, {experimentalSkipFusedParse: true}, preload)
        expect(candidate.profile.fusedParseAttempts).toBe(0)
        expect(candidate.rows).toEqual(baseline.rows)
    })

    test.each([false, true])('retained fallback preserves escaped-token output and hints, preload=%s', async (preload) => {
        const sources = [JSON.stringify([row('first'), row('quoted "key"', [{type: 'text', text: '日本語'}])]),
            JSON.stringify([row('last', [{type: 'image', path: 'asset.png'}])])]
        for (const experimentalTermBankSpans of [false, true]) {
            const baseline = await parse(sources, {experimentalTermBankSpans}, preload)
            expect(baseline.profile.fusedParseFallbacks).toBe(1)
            const candidate = await parse(sources, {experimentalTermBankSpans, experimentalRetainedFusedFallback: true}, preload)
            expect(candidate.profile.fusedParseFallbacks).toBe(1)
            expect(candidate.profile.discardedFusedRows).toBe(baseline.profile.discardedFusedRows)
            expect(candidate.rows).toEqual(baseline.rows)
            const again = await parse(sources, {experimentalTermBankSpans}, preload)
            expect(again.rows).toEqual(baseline.rows)
        }
    })

    test('retained fallback reclaims fixed-capacity output after a late failure', async () => {
        const rows = Array.from({length: 22000}, (_, i) => row(`entry-${i}`))
        const sources = [JSON.stringify(rows.slice(0, 11000)), JSON.stringify(rows.slice(11000))]
        const baseline = await parse(sources, {}, true)
        expect(baseline.profile.fusedParseFallbacks).toBe(1)
        expect(baseline.profile.discardedFusedRows).toBe(20000)
        const candidate = await parse(sources, {experimentalRetainedFusedFallback: true}, true)
        expect(candidate.rows).toEqual(baseline.rows)
    })

    test.each([false, true])('retained source does not hide malformed trailing banks, spans=%s', async (experimentalTermBankSpans) => {
        const sources = [JSON.stringify([row('quoted "key"')]), '[[],,]']
        await expect(parse(sources, {experimentalRetainedFusedFallback: true, experimentalTermBankSpans}, true)).rejects.toThrow()
        const valid = [JSON.stringify([row('recovered')]), JSON.stringify([row('next')])]
        expect((await parse(valid, {experimentalRetainedFusedFallback: true}, true)).rows).toEqual((await parse(valid, {}, true)).rows)
    })
})
''')
print('Prepared experiments:', sorted(modes))
