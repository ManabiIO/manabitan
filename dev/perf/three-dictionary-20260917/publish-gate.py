"""Read-only publication gate for the exact three-dictionary decoder candidate."""
from pathlib import Path
import hashlib, json, math, os, statistics

root = Path(os.environ['RUNNER_TEMP'])
patch_hash = '4496e241a56bd344a3be7170f042cd68bcac6b8cd4616070bacdd2c325f653c4'
wasm_hash = '257eb063b09c2f848605c2b25f919b99d6e98397a3686550a1fb5b77164a36b1'
fixtures = {
    'jmdict': ('7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a', 526942),
    'jitendex': ('8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc', 435448),
    'wty-en-en': ('b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5', 1643040),
}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
results = []
for cohort, directory, marker in [('confirm', 'confirmation', 'QUALIFIED'), ('replication', 'replication', 'COMPLETE')]:
    for dictionary, (fixture_hash, rows) in fixtures.items():
        p = root / directory / f'three-inflate-{cohort}-{dictionary}'
        assert (p/'complete.txt').read_text().strip() == marker
        assert sha(p/'product.patch') == patch_hash
        s = json.loads((p/'summary.json').read_text())
        assert s['status'] == 'success' and s['blocks'] == 6 and len(s['observations']) == 52
        assert s['base'] == '8191f6c6997d7afc5d54e647e93af6def48dfa98'
        assert s['dictionary'] == dictionary and s['fixture']['sha256'] == fixture_hash and s['fixture']['termRows'] == rows
        assert s['identities']['ext/lib/term-bank-parser.wasm'] == wasm_hash
        selected = ['control', 'inflate'] if cohort == 'confirm' else ['inflate', 'control']
        expected = []
        for variant in selected:
            for arm in ['A', 'B']:
                expected.append(dict(variant=variant, arm=arm, block=0, warmup=True, flags={'experimentalLibdeflate': True} if variant == 'inflate' and arm == 'B' else {}))
        for block in range(1, 7):
            for variant in selected:
                for arm in ['A', 'B', 'B', 'A']:
                    expected.append(dict(variant=variant, arm=arm, block=block, warmup=False, flags={'experimentalLibdeflate': True} if variant == 'inflate' and arm == 'B' else {}))
        assert s['plan'] == expected
        assert len({o['id'] for o in s['observations']}) == 52
        work = None
        for entry, o in zip(expected, s['observations']):
            assert {k: o[k] for k in entry} == entry
            assert Path(o['report']).name == o['report']
            report_path = p/o['report']
            assert sha(report_path) == o['reportSha256']
            r = json.loads(report_path.read_text())
            assert r['status'] == 'success' and r['skippedVerification'] is False and not r.get('failureReason')
            b = r['benchmark']
            assert b['importFlags'] == entry['flags'] and b['dictionary'] == dictionary
            assert all(b[k] is False for k in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
            assert all(b[k] is True for k in ['pinnedDictionaries', 'productionImportDefaults', 'authoritativeTiming'])
            v = b['validation']
            assert v['termRows'] == rows and v['contentReadable'] is True and v['probeCount'] == 12
            assert v['title'] == s['fixture']['expectedTitle'] and v['revision'] == s['fixture']['revision']
            assert len(v['probeTerms']) == 12
            imports = [x['data'] for x in r['phases'] if (x.get('data') or {}).get('kind') == 'dictionary-import']
            assert len(imports) == 1
            data = imports[0]; debug = data['importDebug']; timing = data['browserTiming']
            assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and debug['hasResult'] is True
            assert debug['resultTitle'] == s['fixture']['expectedTitle'] and debug['usesFallbackStorage'] is False
            assert debug['openStorageDiagnostics']['mode'] == 'opfs-sahpool'
            assert timing['trigger'] == 'file-input-change' and timing['errorCount'] == 0 and timing['sequence'] == 1 and timing['sequenceBefore'] == 0
            assert math.isclose(o['totalImportMs'], timing['completedAtMs']-timing['startedAtMs'], rel_tol=1e-12)
            phases = debug['importerPhaseTimings']
            parser = next(x['details'] for x in phases if x['phase'].startswith('term-file-fast-path:'))
            final = next(x['details'] for x in phases if x['phase'] == 'bulk-finalization')
            assert parser == o['parser'] and final == o['finalization'] and final['ok'] is True
            assert {k:v for k,v in parser['parserExperiments'].items() if v} == entry['flags']
            signature = {k:parser[k] for k in ['rows','batchedFileCount','parserSourceCompressedBytes','parserSourceUncompressedBytes','parserEncodedContentBytes','parserFusedAttempts','parserFusedFallbacks','parserParallelWorkerCount','parserParallelGroupCount','dedupUniqueCount']}
            signature.update({k:final[k] for k in ['termContentTotalWriteBytes','termRecordTotalWriteBytes','termRecordLookupIndexWriteBytes']})
            if work is None: work = signature
            assert signature == work
        cells = {}
        for variant in selected:
            observations = [o for o in s['observations'] if o['variant'] == variant and not o['warmup']]
            pairs = []
            for i in range(0, 24, 4):
                a1,b1,b2,a2 = [o['totalImportMs'] for o in observations[i:i+4]]
                pairs += [100*(b1/a1-1), 100*(b2/a2-1)]
            median = statistics.median(pairs)
            assert math.isclose(median, s['results'][variant]['pairedMedianPercent'], rel_tol=1e-10, abs_tol=1e-10)
            cells[variant] = dict(medianPairedPercent=median, pairsFaster=sum(x<0 for x in pairs), pairedPercentages=pairs)
        assert cells['inflate']['medianPairedPercent'] < 0 and cells['inflate']['pairsFaster'] >= 9
        assert s['results']['inflate']['equalWorkPercent'] < 0
        results.append(dict(cohort=cohort,dictionary=dictionary,results=cells,observations=52,work=work,summarySha256=sha(p/'summary.json')))

jmdict = root/'confirmation/three-inflate-confirm-jmdict'
lifecycle = json.loads((jmdict/'lifecycle.json').read_text())
assert lifecycle['status'] == 'success' and lifecycle['skippedVerification'] is False and len(lifecycle['phases']) == 83
wty = root/'confirmation/three-inflate-confirm-wty-en-en'
corpus = json.loads((wty/'corpus-parity.json').read_text())
assert corpus['status'] == 'success' and corpus['wasmSha256'] == wasm_hash and len(corpus['groups']) == 68
assert [m['rows'] for m in corpus['modes']] == [1643040,1643040]
for g in corpus['groups']:
    for field in ['rows','contentBytes','mediaRows','sourceDigest','sha256']:
        assert g['baseline'][field] == g['candidate'][field]
Path('builds/three-publication/gate.json').write_text(json.dumps(dict(status='success',cohorts=results,observations=312),indent=2)+'\n')
print('All six complete fixed-plan cohorts and exact source/lifecycle/corpus receipts verified; no observations removed or controls subtracted')
