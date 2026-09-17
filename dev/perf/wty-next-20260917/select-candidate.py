from pathlib import Path
import subprocess, sys

assets=Path(__file__).parent
modes=sys.argv[1:]
assert modes and set(modes)<=set(['keys','skip','retain'])
subprocess.run([sys.executable,str(assets/'prepare-candidates.py'),*modes],check=True)
p=Path('test/term-bank-experiments.test.js')

if 'retain' in modes and 'skip' not in modes:
    p.write_text(p.read_text()+'''

describe('retained fused fallback', () => {
    test('defaults off, snapshots literal true, and does not consume a native bit', () => {
        expect(snapshotTermBankExperiments().experimentalRetainedFusedFallback).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({experimentalRetainedFusedFallback: value}))
            expect(snapshotTermBankExperiments(options).experimentalRetainedFusedFallback).toBe(false)
        }
        const options = {experimentalRetainedFusedFallback: true}
        const snapshot = snapshotTermBankExperiments(options)
        options.experimentalRetainedFusedFallback = false
        expect(snapshot.experimentalRetainedFusedFallback).toBe(true)
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(getTermBankExperimentMask(snapshot)).toBe(0)
    })

    test('keeps non-fused single-bank parsing unchanged', async () => {
        const sources = [JSON.stringify([row('first'), row('last')])]
        const baseline = await parse(sources)
        const candidate = await parse(sources, {experimentalRetainedFusedFallback: true})
        expect(candidate.profile.fusedParseAttempts).toBe(0)
        expect(candidate.rows).toEqual(baseline.rows)
    })

    test.each([false, true])('keeps successful fused parsing unchanged, preload=%s', async (preload) => {
        const sources = [JSON.stringify([row('first')]), JSON.stringify([row('last')])]
        const baseline = await parse(sources, {}, preload)
        const candidate = await parse(sources, {experimentalRetainedFusedFallback: true}, preload)
        expect(candidate.profile.fusedParseAttempts).toBe(1)
        expect(candidate.profile.fusedParseFallbacks).toBe(0)
        expect(candidate.rows).toEqual(baseline.rows)
    })

    test.each([false, true])('preserves escaped-token fallback output and hints, preload=%s', async (preload) => {
        const sources = [JSON.stringify([row('first'), row('quoted "key"', [{type: 'text', text: '日本語'}])]),
            JSON.stringify([row('last', [{type: 'image', path: 'asset.png'}])])]
        for (const experimentalTermBankSpans of [false, true]) {
            const baseline = await parse(sources, {experimentalTermBankSpans}, preload)
            expect(baseline.profile.fusedParseFallbacks).toBe(1)
            const candidate = await parse(sources, {experimentalTermBankSpans, experimentalRetainedFusedFallback: true}, preload)
            expect(candidate.profile.fusedParseFallbacks).toBe(1)
            expect(candidate.profile.discardedFusedRows).toBe(baseline.profile.discardedFusedRows)
            expect(candidate.rows).toEqual(baseline.rows)
            expect((await parse(sources, {experimentalTermBankSpans}, preload)).rows).toEqual(baseline.rows)
        }
    })

    test('reclaims fixed-capacity output after a late fallback', async () => {
        const rows = Array.from({length: 22000}, (_, i) => row(`entry-${i}`))
        const sources = [JSON.stringify(rows.slice(0, 11000)), JSON.stringify(rows.slice(11000))]
        const baseline = await parse(sources, {}, true)
        expect(baseline.profile.fusedParseFallbacks).toBe(1)
        expect(baseline.profile.discardedFusedRows).toBe(20000)
        const candidate = await parse(sources, {experimentalRetainedFusedFallback: true}, true)
        expect(candidate.rows).toEqual(baseline.rows)
    })

    test.each([false, true])('preserves the exact original inflated source allocation, spans=%s', async (experimentalTermBankSpans) => {
        const banks = [JSON.stringify([row('quoted "key"'), ...Array.from({length: 500}, (_, i) => row(`entry-${i}`))]), JSON.stringify([row('end')])]
        const experiments = {experimentalTermBankSpans, experimentalRetainedFusedFallback: true}
        const preloadedSource = await inflateCompressedTermBankSourcesWasm(banks.map((bank) => compressed(bank, 8)), experiments)
        const sourceHash = () => createHash('sha256').update(new Uint8Array(preloadedSource.wasm.memory.buffer, preloadedSource.jsonPtr, preloadedSource.jsonLength)).digest('hex')
        const before = sourceHash()
        let rows = 0
        await parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => { rows += chunk.rowCount }, 8192, {
            ...experiments,
            preloadedSource,
            computeContentHashes: true,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            mediaHintFastScan: true,
            singleChunk: true,
            prepareLookupIndexes: false,
        })
        expect(rows).toBe(502)
        expect(consumeLastTermBankWasmParseProfile()?.fusedParseFallbacks).toBe(1)
        expect(sourceHash()).toBe(before)
    })

    test.each([false, true])('does not hide malformed trailing banks and recovers, spans=%s', async (experimentalTermBankSpans) => {
        const sources = [JSON.stringify([row('quoted "key"')]), '[[],,]']
        await expect(parse(sources, {experimentalRetainedFusedFallback: true, experimentalTermBankSpans}, true)).rejects.toThrow()
        const valid = [JSON.stringify([row('recovered')]), JSON.stringify([row('next')])]
        expect((await parse(valid, {experimentalRetainedFusedFallback: true}, true)).rows).toEqual((await parse(valid, {}, true)).rows)
    })
})
''')
if 'skip' in modes and 'retain' not in modes:
    p.write_text(p.read_text()+'''

describe('explicit fused parser bypass', () => {
    test('defaults off and requires literal true', () => {
        expect(snapshotTermBankExperiments().experimentalSkipFusedParse).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({experimentalSkipFusedParse: value}))
            expect(snapshotTermBankExperiments(options).experimentalSkipFusedParse).toBe(false)
        }
        expect(snapshotTermBankExperiments({experimentalSkipFusedParse: true}).experimentalSkipFusedParse).toBe(true)
    })
    test.each([false, true])('bypasses fused work without changing rows, preload=%s', async (preload) => {
        for (const experimentalTermBankSpans of [false, true]) {
            const sources = [JSON.stringify([row('first'), row('second')]), JSON.stringify([row('last')])]
            const baseline = await parse(sources, {experimentalTermBankSpans}, preload)
            expect(baseline.profile.fusedParseAttempts).toBe(1)
            const candidate = await parse(sources, {experimentalSkipFusedParse: true, experimentalTermBankSpans}, preload)
            expect(candidate.profile.fusedParseAttempts).toBe(0)
            expect(candidate.rows).toEqual(baseline.rows)
        }
    })
    test.each([false, true])('still rejects invalid source and recovers, spans=%s', async (experimentalTermBankSpans) => {
        await expect(parse([JSON.stringify([row('first')]), '[[],,]'], {experimentalSkipFusedParse: true, experimentalTermBankSpans}, true)).rejects.toThrow()
        const sources = [JSON.stringify([row('safe')]), JSON.stringify([row('after failure')])]
        expect((await parse(sources, {experimentalSkipFusedParse: true, experimentalTermBankSpans}, true)).rows).toEqual((await parse(sources, {experimentalTermBankSpans}, true)).rows)
    })
})
''')
print('Isolated candidate modes:',modes)
