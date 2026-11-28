#!/usr/bin/env python3
"""Read-only audit of the two completed current-source overlap Vndb artifacts."""
import hashlib
import io
import json
import math
from pathlib import Path
import random
import statistics
import zipfile

from qualification_receipts import validate_import_summary, require_matching_receipts
from audit_memory import audit_cell

ROOT = Path(__file__).resolve().parent
BASE = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
CANDIDATE = 'c98110712296be803fcb30b9295bb11c7d0b44bc'
PARSER = '5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695'
INPUTS = json.loads((ROOT / 'inputs.json').read_text())
METADATA = {x['id']: x for x in json.loads((ROOT / 'artifacts-api.json').read_text())}
FIXTURE_LOCK = Path('/workspace/scratch/da6c4dbd0097/manabitan/test/perf/dictionaries.lock.json')
FIXTURE_BYTES = FIXTURE_LOCK.read_bytes()
FIXTURE = json.loads(FIXTURE_BYTES)['dictionaries']['vndb']

def digest(data):
    return hashlib.sha256(data).hexdigest()

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')

def checked_archive(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    assert len(names) == len(set(names))
    assert all(not Path(n).is_absolute() and '..' not in Path(n).parts and '\\' not in n for n in names)
    assert z.testzip() is None
    return z

def stats(observations, kind):
    other = 'B' if kind == 'candidate' else 'C'
    grouped = {}
    for x in observations:
        if x['kind'] == kind:
            group = grouped.setdefault(x['pair'], {})
            assert x['arm'] not in group
            group[x['arm']] = x['totalImportMs']
    assert sorted(grouped) == list(range(1, (12 if kind == 'candidate' else 4) + 1))
    pairs = [grouped[i] for i in sorted(grouped)]
    assert all(set(p) == {'A', other} and all(math.isfinite(v) and v > 0 for v in p.values()) for p in pairs)
    ms = [p[other] - p['A'] for p in pairs]
    ratios = [p[other] / p['A'] for p in pairs]
    randomizer = random.Random(897)
    boot_ms, boot_percent = [], []
    for _ in range(10000):
        indexes = [randomizer.randrange(len(pairs)) for _ in pairs]
        boot_ms.append(statistics.median(ms[i] for i in indexes))
        boot_percent.append((statistics.median(ratios[i] for i in indexes) - 1) * 100)
    boot_ms.sort()
    boot_percent.sort()
    return {
        'count': len(pairs), 'baselineMedianMs': statistics.median(p['A'] for p in pairs),
        'otherMedianMs': statistics.median(p[other] for p in pairs),
        'medianPairedChangeMs': statistics.median(ms),
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(p[other] for p in pairs) / sum(p['A'] for p in pairs) - 1) * 100,
        'fasterPairs': sum(v < 0 for v in ms),
        'descriptiveBootstrap95Ms': [boot_ms[249], boot_ms[9749]],
        'descriptiveBootstrap95Percent': [boot_percent[249], boot_percent[9749]],
        'pairedMs': ms, 'pairedRatios': ratios,
        'baselineEqualWorkTotalMs': sum(p['A'] for p in pairs),
        'otherEqualWorkTotalMs': sum(p[other] for p in pairs),
    }

def describe(values):
    assert values and all(isinstance(x, (int, float)) and math.isfinite(x) for x in values)
    return {'values': values, 'min': min(values), 'median': statistics.median(values), 'max': max(values)}

def extract_phase_metrics(run):
    phases = run['importDebug']['importerPhaseTimings']
    by_name = {p['phase']: p for p in phases}
    assert len(by_name) == len(phases)
    data = by_name['import-data-banks']['details']
    finish = by_name['bulk-finalization']['details']
    terms = [p for p in phases if p['phase'].startswith('term-file-fast-path:')]
    assert len(terms) == 1
    td = terms[0]['details']
    assert data['terms'] == 6648310 and data['media'] == 146570
    assert td['parserParallelWorkerCount'] == 3 and td['parserParallelGroupCount'] == 170
    assert td['parserBorrowedContentResultCount'] == 0
    assert td['parserFusedFallbacks'] == 0
    assert data['step4MediaZipBatchEntryCount'] == 146570 and data['step4MediaZipBatchUncompressedBytes'] == 188131284
    metrics = {
        'totalImportMs': run['totalImportMs'], 'workerImportMs': run['workerImportMs'],
        'archiveAndIndexMs': by_name['archive-and-index']['elapsedMs'],
        'termFastPathElapsedMs': terms[0]['elapsedMs'],
        'importDataBanksElapsedMs': by_name['import-data-banks']['elapsedMs'],
        'bulkFinalizationElapsedMs': by_name['bulk-finalization']['elapsedMs'],
    }
    for key in ['step4MediaResolveMs', 'step4MediaWriteMs', 'step4MediaZipBatchReadMs',
                'step4MediaZipBatchInflateMs', 'step4MediaZipBatchCount',
                'step4MediaZipBatchEntryCount', 'step4MediaZipBatchRangeBytes',
                'step4MediaZipBatchCompressedBytes', 'step4MediaZipBatchUncompressedBytes',
                'step4TagReadMs', 'step4BulkAddTagsMetaMs', 'step4BulkAddTermsMs']:
        metrics[key] = data[key]
    for key in ['commitMs', 'termContentEndImportSessionMs', 'termContentEndImportSessionCloseWritableMs',
                'termRecordEndImportSessionMs', 'termRecordEndImportSessionFlushPendingWritesMs',
                'termRecordEndImportSessionAwaitQueuedWritesMs', 'termRecordEndImportSessionCloseWritableMs',
                'termRecordLookupIndexAwaitMs', 'createIndexesMs', 'termsVirtualTableSyncMs', 'totalMs']:
        metrics[key] = finish[key]
    for key in ['dedupCanonicalScanMs', 'contentCompressMs', 'contentMetadataMs', 'termRecordFieldEncodeMs',
                'termRecordValidationMs', 'dedupRecentSourceCacheMs', 'parserSourceInflateMs',
                'parserResultCopyMs', 'parserLookupIndexEncodeMs']:
        metrics[key] = td[key]
    metrics['mediaWriteShareOfTotalPercent'] = 100 * data['step4MediaWriteMs'] / run['totalImportMs']
    return metrics

result = {
    'schemaVersion': 1,
    'scope': 'Independent full-artifact audit of two completed Vndb owned-overlap hosts, plus separate baseline-A diagnostic phase extraction. No observations excluded, pooled or reacquired.',
    'runId': 46132124178, 'baseline': BASE, 'candidate': CANDIDATE,
    'dictionary': 'vndb',
    'validatorSources': {name: digest((ROOT / name).read_bytes()) for name in ['qualification_receipts.py', 'audit_memory.py', 'chromium_memory.py']},
    'statistics': {'bootstrapSeed': 897, 'resamples': 10000, 'sampleUnit': 'complete pair', 'interval': 'descriptive sorted percentile indices249/9749; no population-general inference'},
    'gates': {'medianChangePercentMax': 1, 'equalWorkChangePercentMax': 1, 'upper95PercentMax': 3,
              'controlGate': 'Absolute median paired control change and absolute equal-work control change must each be at most1% on each host; use unrounded values.'},
    'cells': []
}
for config, printed in zip(INPUTS['downloads'], INPUTS['printed'], strict=True):
    order = config['order']
    assert order == printed['order']
    raw = (ROOT / ('vndb-' + order + '.zip')).read_bytes()
    assert len(raw) == config['bytes'] and digest(raw) == config['sha256']
    meta = METADATA[config['artifactId']]
    assert meta['size_in_bytes'] == len(raw) and meta['digest'] == 'sha256:' + digest(raw)
    assert meta['workflow_run']['id'] == result['runId'] and meta['workflow_run']['head_sha'] == CANDIDATE
    assert meta['name'] == 'content-overlap-vndb-' + order + '-' + CANDIDATE and not meta['expired']
    retained = ROOT / ('vndb-' + order + '-retained')
    retained.mkdir(exist_ok=True)
    with checked_archive(ROOT / ('vndb-' + order + '.zip')) as z:
        names = z.namelist()
        manifest = {}
        for name in names:
            data = z.read(name)
            manifest[name] = {'bytes': len(data), 'sha256': digest(data)}
        def read(name):
            return json.loads(z.read(name))
        for witness in printed['json']:
            data = z.read(witness['path'])
            assert digest(data) == witness['sha256'] and json.loads(data) == witness['data']
        for witness in printed['canonical']:
            assert read(witness['path']) == witness['data']
        plan = read('registered-plan.json')
        assert plan['baseline'] == BASE and plan['candidate'] == CANDIDATE
        assert plan['dictionary'] == 'vndb' and plan['initialOrder'] == order
        assert plan['pairs'] == 12 and plan['expectedWorkers'] == 3 and plan['flags'] == {}
        identities = read('source-identities.json')
        assert identities['changedPackageEntries'] == ['js/dictionary/dictionary-database.js', 'js/dictionary/dictionary-import-session.js', 'js/dictionary/dictionary-importer.js', 'js/dictionary/term-bank-wasm-parser.js', 'js/dictionary/term-content-ownership.js', 'js/dictionary/zstd-term-content.js']
        assert identities['addedPackageEntries'] == ['js/dictionary/artifact-term-chunk-pipeline.js']
        assert identities['removedPackageEntries'] == []
        assert len(printed['identities']) == 1
        printed_identity = printed['identities'][0]
        for arm, source in [('A', BASE), ('B', CANDIDATE)]:
            ident = identities['arms'][arm]
            assert ident['sha'] == source
            assert ident['fixtureLockSha256'] == digest(FIXTURE_BYTES)
            packaged = z.read('package-' + arm + '.zip')
            assert digest(packaged) == ident['packageSha256']
            with zipfile.ZipFile(io.BytesIO(packaged)) as package:
                entries = {x.filename: digest(package.read(x)) for x in package.infolist() if not x.is_dir()}
                assert entries == ident['entries']
                assert digest(package.read('lib/term-bank-parser.wasm')) == PARSER
            pident = printed_identity['arms'][arm]
            assert pident['packageMemberCount'] == len(entries)
            assert pident['sha'] == source and pident['packageSha256'] == ident['packageSha256']
        observations = read('observations.json')
        assert len(observations) == 36
        assert [{k: x[k] for k in ['id', 'kind', 'pair', 'arm']} for x in observations] == plan['schedule']
        browser = read('browser-identity.json')
        canonical_reference = None
        phases, baseline_primary = [], []
        for observation in observations:
            name = observation['id']
            summary, report = read(name + '/summary.json'), read(name + '/run-1.json')
            arm = 'B' if observation['arm'] == 'B' else 'A'
            ident = identities['arms'][arm]
            canonical = validate_import_summary(
                summary, report, dictionary='vndb', fixture=FIXTURE, source_sha=ident['sha'],
                package_sha256=ident['packageSha256'], browser_version=browser['version'],
                import_flags=None, source_hashes=ident['sourceHashes'], source_dirty=False, media_check='sample', vndb_sah_allocation_units=(37, 37)
            )
            assert canonical == read(name + '/canonical-receipt.json')
            if canonical_reference is None:
                canonical_reference = canonical
            else:
                require_matching_receipts(canonical_reference, canonical)
            run = summary['runs'][0]
            assert run['totalImportMs'] == observation['totalImportMs']
            metrics = extract_phase_metrics(run)
            phase = {**observation, 'source': ident['sha'], 'packageSha256': ident['packageSha256'],
                     'sourceSummarySha256': manifest[name + '/summary.json']['sha256'],
                     'sourceRawReportSha256': manifest[name + '/run-1.json']['sha256'],
                     'metrics': metrics, 'step4Breakdown': run['step4Breakdown'],
                     'stepTimingSummary': run['stepTimingSummary'], 'importDebug': run['importDebug']}
            phases.append(phase)
            if observation['kind'] == 'candidate' and observation['arm'] == 'A':
                baseline_primary.append(phase)
        assert len(baseline_primary) == 12
        exhaustive = {}
        for arm in ['A', 'B']:
            ident = identities['arms'][arm]
            name = 'exhaustive-media-' + arm
            canonical = validate_import_summary(
                read(name + '/summary.json'), read(name + '/run-1.json'),
                dictionary='vndb', fixture=FIXTURE, source_sha=ident['sha'],
                package_sha256=ident['packageSha256'], browser_version=browser['version'],
                import_flags=None, source_hashes=ident['sourceHashes'], source_dirty=False, media_check='all', vndb_sah_allocation_units=(37, 37)
            )
            assert canonical == read(name + '/canonical-receipt.json')
            require_matching_receipts(canonical_reference, canonical, compare_media=False)
            exhaustive[arm] = canonical
        require_matching_receipts(exhaustive['A'], exhaustive['B'])
        for name in names:
            if name.startswith('memory/'):
                dest = retained / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(z.read(name))
        memory = audit_cell(retained / 'memory')
        assert memory == read('memory/memory-audit.json')
        assert memory['observations'] == 4
        assert memory['everyObservationQualified'] == (order == 'BA')
        assert memory['passesProspectiveMemoryScreen'] == (order == 'BA')
        assert read('memory/semantic-failures.json') == []
        candidate, control = stats(observations, 'candidate'), stats(observations, 'control')
        reported = read('analysis.json')
        for actual, expected in [(candidate, reported['candidateVsBaseline']), (control, reported['identicalCodeControl'])]:
            for key in ['count', 'medianPairedChangePercent', 'equalWorkChangePercent', 'fasterPairs']:
                assert abs(actual[key] - expected[key]) < 1e-9, (order, key)
            assert all(abs(a-b) < 1e-9 for a, b in zip(actual['descriptiveBootstrap95Percent'], expected['descriptiveBootstrap95Percent'], strict=True))
            assert actual['pairedRatios'] == expected['ratios']
        gates = {
            'medianChangeAtMost1Percent': candidate['medianPairedChangePercent'] <= 1,
            'equalWorkChangeAtMost1Percent': candidate['equalWorkChangePercent'] <= 1,
            'upper95ChangeAtMost3Percent': candidate['descriptiveBootstrap95Percent'][1] <= 3
        }
        control_gates = {'absoluteMedianChangeAtMost1Percent': abs(control['medianPairedChangePercent']) <= 1, 'absoluteEqualWorkChangeAtMost1Percent': abs(control['equalWorkChangePercent']) <= 1}
        baseline_stats = {key: describe([x['metrics'][key] for x in baseline_primary]) for key in baseline_primary[0]['metrics']}
        for name in ['registered-plan.json', 'observations.json', 'analysis.json', 'source-identities.json', 'browser-identity.json']:
            (retained / name).write_bytes(z.read(name))
        save(retained / 'artifact-members-sha256.json', manifest)
        save(retained / 'all-observation-raw-phases.json', phases)
        save(retained / 'baseline-A-primary-raw-phases.json', baseline_primary)
        save(retained / 'baseline-A-primary-phase-statistics.json', baseline_stats)
        result['cells'].append({
            'order': order, 'artifactId': config['artifactId'], 'artifactBytes': len(raw), 'artifactSha256': digest(raw),
            'jobId': config['jobId'], 'artifactMembers': len(names), 'allZipMembersCrcAndSha256Verified': True,
            'ordinaryObservationCount': len(observations), 'candidatePairs': 12, 'controlPairs': 4,
            'allOrdinarySummaryAndRawReportsRevalidated': True, 'allCanonicalReceiptsMatch': True,
            'exhaustiveMedia': exhaustive['A']['media'], 'sourceIdentities': {a: {k:v for k,v in x.items() if k != 'entries'} for a,x in identities['arms'].items()},
            'candidate': candidate, 'control': control, 'registeredVndbNonRegressionGates': gates,
            'passesRegisteredVndbNonRegression': all(gates.values()), 'registeredControlGates': control_gates, 'passesRegisteredControlGates': all(control_gates.values()), 'passesAllHostGates': all(gates.values()) and all(control_gates.values()) and memory['passesProspectiveMemoryScreen'], 'memoryAuditRecomputedFromRawScans': memory, 'memoryQualificationObservations': [{k:v for k,v in x.items() if k in ('name','arm','pair','qualifiedForWholeTreePss','qualificationFailures','maxSampledPssKiB','maxSampledPrivateKiB','maximumCoveredSampleGapMs','fullyContainedImportSampleCount')} for x in read('memory/observations.json')], 'memorySemanticFailures': read('memory/semantic-failures.json'),
            'baselinePhaseScope': 'Only the 12 A observations in candidate pairs; warmups, A/C controls, B and instrumented memory kept separately. No host pooling.',
            'baselinePrimaryPhaseStatistics': baseline_stats,
        })
result['decision'] = 'NO_REPLICATED_OVERLAP_GAIN; AB timing/control nonregression passes but memory sampling coverage fails; BA fails all timing nonregression gates and the absolute median control gate. No exclusions or pooling.'
result['phaseDecision'] = 'These owned-overlap phase receipts are separate from the previously audited tag study. All170 VNDB parser groups retain their owned route and zero fused fallbacks. Elapsed phase sums overlap and are diagnostic only.'
result['limits'] = [
    'Source/raw phase counters are elapsed spans and may overlap or include waiting; they are not additive CPU costs or a removable-time guarantee.',
    'Media ZIP batch count does not establish SQL write-batch/statement geometry.',
    'The overlap candidate has no replicated current-source gain; preserve every candidate/control tail without exclusion or pooling.',
    'Current-source source/semantic tests pass independently of performance; memory observations are separate and non-authoritative for timing.'
]
save(ROOT / 'vndb-independent-audit.json', result)
print(json.dumps({
    'decision': result['decision'],
    'cells': [{
        'order': c['order'], 'candidate': c['candidate'], 'control': c['control'],
        'nonregression': c['registeredVndbNonRegressionGates'],
        'controlGates': c['registeredControlGates'], 'passesAllHostGates': c['passesAllHostGates'],
        'memory': c['memoryAuditRecomputedFromRawScans'],
        'baselinePhaseMedians': {k:v['median'] for k,v in c['baselinePrimaryPhaseStatistics'].items()}
    } for c in result['cells']]
}, indent=2))
