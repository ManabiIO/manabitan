#!/usr/bin/env python3
import hashlib
import json
import pathlib
import statistics
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
dictionary = sys.argv[2]
fixture = json.loads(pathlib.Path('test/perf/dictionaries.lock.json').read_text())['dictionaries'][dictionary]
plan = json.loads((root / 'plan.json').read_text())
observations = json.loads((root / 'observations.json').read_text())
identities = json.loads((root / 'timing-identities.json').read_text())
recorded = json.loads((root / 'result.json').read_text())
assert len(plan) == len(observations) == 68
assert (root / 'COMPLETE').read_text().strip() == '68'
for name, expected in identities.items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected
assert hashlib.sha256((root / 'candidate/parser.js').read_bytes()).hexdigest() == '1e3e02c3bccbbe0966a0c9ad73e21dbcfc9fdb9553d1a83ac93318561b7c1257'
assert (root / 'candidate/parser.wasm').read_bytes() == (root / 'parent/parser.wasm').read_bytes()
a = zipfile.ZipFile(root / 'parent/package.zip')
b = zipfile.ZipFile(root / 'candidate/package.zip')
assert a.namelist() == b.namelist()
assert [name for name in a.namelist() if a.read(name) != b.read(name)] == ['js/dictionary/term-bank-wasm-parser.js']
assert b.read('js/dictionary/term-bank-wasm-parser.js') == (root / 'candidate/parser.js').read_bytes()
flags = {'P': {}, 'A': {}, 'B': {'experimentalNativeSegmentedLookup': True},
         'C': {'experimentalNativeSegmentedLookup': True, 'experimentalLookupScratchReuse': True}}
flag_names = {'experimentalParserWorkers3', 'experimentalLibdeflate', 'experimentalSkipFusedParse',
              'experimentalLookupScratchReuse', 'experimentalNativeSegmentedLookup', 'experimentalDirectLookupArena',
              'experimentalSinglePassLookupCompaction', 'experimentalTermBankSpans', 'experimentalNativeEscapedKeys',
              'experimentalValidatedGlossaryReuse', 'experimentalFusedSingleBank', 'experimentalGlobalExactContentReuse',
              'experimentalFastGlossaryNormalization'}
work = {}
for index, (expected, row) in enumerate(zip(plan, observations)):
    assert all(row[key] == value for key, value in expected.items()) and row['index'] == index
    arm = row['arm']
    report = root / pathlib.Path(row['report']).parent.name / 'run-1.json'
    raw = report.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == row['reportSha256']
    data = json.loads(raw)
    assert data['status'] == 'success' and data['skippedVerification'] is False
    config = data['benchmark']
    assert config['importFlags'] == flags[arm] and config['dictionary'] == dictionary
    assert config['pinnedDictionaries'] is True and config['productionImportDefaults'] is True
    assert config['authoritativeTiming'] is True
    assert all(config[key] is False for key in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
    validation = config['validation']
    assert validation['title'] == fixture['expectedTitle'] and validation['revision'] == fixture['revision']
    assert validation['termRows'] == fixture['termRows'] and validation['probeCount'] >= 12 and validation['contentReadable'] is True
    phases = [p for p in data['phases'] if p['name'] == fixture['label'] + ': total import']
    assert len(phases) == 1
    details = phases[0]['data']
    timing = details['browserTiming']
    assert timing['errorCount'] == 0 and timing['trigger'] == 'file-input-change'
    assert timing['sequence'] > timing['sequenceBefore']
    assert abs(timing['completedAtMs'] - timing['startedAtMs'] - row['ms']) < 1e-7
    debug = details['importDebug']
    assert debug['hasResult'] is True and debug['errorCount'] == debug['addSettingsErrorCount'] == 0
    assert debug['usesFallbackStorage'] is False
    receipts = []
    for phase in debug['importerPhaseTimings']:
        for key, value in phase.get('details', {}).items():
            if key in ['parserExperiments', 'fastPathParserExperiments', 'fastPathParserEffectiveExperiments']:
                receipts.append(value)
                assert set(value) == flag_names
                assert all(value[name] is flags[arm].get(name, False) for name in flag_names)
    assert receipts
    variant = 'parent' if arm in ['P', 'C'] else 'candidate'
    assert row['packageSha256'] == identities[variant + '/package.zip']
    groups = [p['details'] for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    work.setdefault(arm, []).append({
        'heap': max(p['parserMaxWasmHeapBytes'] for p in groups),
        'segments': sum(p['parserNativeSegmentedLookupSegments'] for p in groups),
        'fallbacks': sum(p['parserNativeSegmentedLookupFallbacks'] for p in groups),
        'scratch': sum(p['parserNativeLookupScratchReusedBytes'] for p in groups),
    })
result = {}
for kind in ['candidate', 'control', 'source-overhead', 'previous-bounded-path']:
    rows = [x for x in observations if x['kind'] == kind]
    changes, totals, aa, bb = [], [], [], []
    for offset in range(0, len(rows), 4):
        block = rows[offset:offset + 4]
        assert [r['label'] for r in block] == list('ABBA')
        totals.append(100 * ((block[1]['ms'] + block[2]['ms']) / (block[0]['ms'] + block[3]['ms']) - 1))
        for ai, bi in [(0, 1), (3, 2)]:
            x, y = block[ai]['ms'], block[bi]['ms']
            aa.append(x)
            bb.append(y)
            changes.append(100 * (y / x - 1))
    result[kind] = {'pairChangesPct': changes, 'blockChangesPct': totals,
                    'medianPairedPct': statistics.median(changes),
                    'medianAbsolutePct': statistics.median(map(abs, changes)),
                    'equalWorkPct': 100 * (sum(bb) / sum(aa) - 1),
                    'fasterPairs': sum(x < 0 for x in changes),
                    'aMedianMs': statistics.median(aa), 'bMedianMs': statistics.median(bb)}
    assert result[kind] == recorded[kind]
corpus = json.loads((root / 'corpus.json').read_text())
assert corpus['complete'] is True and len(corpus['observations']) == 4
assert all(o['result']['rows'] == fixture['termRows'] for o in corpus['observations'])
assert len({o['result']['digest'] for o in corpus['observations']}) == 1
compact = {arm: {key: sorted({x[key] for x in rows}) for key in ['heap', 'segments', 'fallbacks', 'scratch']} for arm, rows in work.items()}
output = {'dictionary': dictionary, 'auditedReports': len(observations), 'results': result, 'work': compact,
          'corpusRows': fixture['termRows'], 'corpusDigest': corpus['observations'][0]['result']['digest']}
(root / 'audited.json').write_text(json.dumps(output, indent=2))
print(json.dumps(output, indent=2))
