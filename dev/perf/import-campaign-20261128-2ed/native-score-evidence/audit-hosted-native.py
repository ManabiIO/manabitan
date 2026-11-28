"""Independently audit one frozen native-score complete-import screen artifact.

Usage: python3 audit-hosted-native.py ZIP DICTIONARY ARTIFACT_SHA256 NEW_DIRECTORY
The artifact stays intact; only compact receipts are copied. Diagnostic traces
are inventoried separately and never become qualification observations.
"""
import hashlib
import io
import json
import math
import pathlib
import random
import statistics
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True
ROOT = pathlib.Path('/workspace/scratch/2ed731c9ad68/manabitan')
CONTRACT_PATH = pathlib.Path(__file__).with_name('hosted-audit-contract.json')
CONTRACT_SHA256 = 'b9911771809c190c9e05473d161bedc20b6cd22db47aa3db08ebf8cf7c329919'
FILE_SET_POLICY = 'Only explicitly named additions; no removed files; every common entry hashed and exact changed-entry set required'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def expected_schedule():
    result = []
    for pair, order in ((1, 'AB'), (2, 'BA')):
        for arm in order:
            result.append({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm})
    for pair in range(1, 7):
        for arm in 'AB' if pair % 2 else 'BA':
            result.append({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm})
        if pair in (3, 6):
            control_pair = pair // 3
            for arm in 'AC' if control_pair == 1 else 'CA':
                result.append({'id': f'control-{control_pair:02d}-{arm}', 'kind': 'control', 'pair': control_pair, 'arm': arm})
    return result


def check_package_entries(baseline, candidate, contract):
    added = sorted(set(candidate) - set(baseline))
    removed = sorted(set(baseline) - set(candidate))
    changed = sorted(name for name in set(baseline) | set(candidate) if baseline.get(name) != candidate.get(name))
    assert added == sorted(contract['expectedAddedEntries']), ('Unexpected package additions', added)
    assert removed == [], ('Removed package entries', removed)
    assert changed == sorted(contract['expectedChangedOrAddedEntries']), ('Unexpected package delta', changed)
    for name, expected in contract['expectedBaselineChangedEntryHashes'].items():
        assert baseline[name] == expected, ('Baseline runtime mismatch', name)
    for name, expected in contract['expectedCandidateChangedEntryHashes'].items():
        assert candidate[name] == expected, ('Candidate runtime mismatch', name)
    return {'added': added, 'removed': removed, 'changedOrAdded': changed}


def paired(observations, kind, numerator):
    values = {}
    for item in observations:
        if item['kind'] == kind:
            target = values.setdefault(item['pair'], {})
            assert item['arm'] not in target
            target[item['arm']] = item['totalImportMs']
    assert len(values) == (6 if kind == 'candidate' else 2)
    assert all(set(pair) == {'A', numerator} for pair in values.values())
    ratios = [pair[numerator] / pair['A'] for pair in values.values()]
    rng = random.Random(897)
    resampled = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        'count': len(ratios), 'ratios': ratios,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(v[numerator] for v in values.values()) / sum(v['A'] for v in values.values()) - 1) * 100,
        'worstPairChangePercent': (max(ratios) - 1) * 100,
        'descriptiveBootstrap95Percent': [(resampled[index] - 1) * 100 for index in (249, 9749)],
        'fasterPairs': sum(value < 1 for value in ratios),
    }


def parser_metrics(run):
    result = {'parserAggregate': [], 'step4Aggregate': [], 'step4Dictionaries': run['step4Breakdown']['dictionaries']}
    for index, phase in enumerate(run.get('importDebug', {}).get('importerPhaseTimings', [])):
        details = phase.get('details', {})
        for label, prefix in (('parserAggregate', 'parser'), ('step4Aggregate', 'fastPathParser')):
            if prefix + 'FusedAttempts' in details:
                result[label].append({'phaseIndex': index, 'metrics': {
                    name.removeprefix(prefix): value for name, value in details.items() if name.startswith(prefix)
                }})
    return result


def audit_admission(records, dictionary, contract):
    deviations = []
    expected = contract['expectedNativePlans'][dictionary]
    reference = next(row for row in records if row['arm'] == 'A')
    for record in records:
        for label in ('parserAggregate', 'step4Aggregate'):
            items = record['parserMetrics'][label]
            if len(items) != 1:
                deviations.append({'id': record['id'], 'layer': label, 'reason': 'Expected one whole-import aggregate', 'observedCount': len(items)})
                continue
            actual = items[0]['metrics']
            for key, value in expected.items():
                observed = actual.get(key)
                target = value if record['arm'] == 'B' else 0
                # Baseline predates these counters; absence is the expected zero.
                if record['arm'] == 'A' and observed is None:
                    observed = 0
                if observed != target:
                    deviations.append({'id': record['id'], 'layer': label, 'metric': key, 'expected': target, 'actual': observed})
            baseline_items = reference['parserMetrics'][label]
            if len(baseline_items) == 1:
                baseline = baseline_items[0]['metrics']
                for key in contract['baselineEquivalentParserMetrics']:
                    if key not in actual or key not in baseline or actual.get(key) != baseline.get(key):
                        deviations.append({'id': record['id'], 'layer': label, 'metric': key, 'baseline': baseline.get(key), 'actual': actual.get(key), 'reason': 'Parser route/heap counter differs or is absent'})
        if len(record['parserMetrics']['parserAggregate']) == len(record['parserMetrics']['step4Aggregate']) == 1:
            parser = record['parserMetrics']['parserAggregate'][0]['metrics']
            step4 = record['parserMetrics']['step4Aggregate'][0]['metrics']
            for key in set(expected) | set(contract['baselineEquivalentParserMetrics']):
                if parser.get(key) != step4.get(key):
                    deviations.append({'id': record['id'], 'metric': key, 'parser': parser.get(key), 'step4': step4.get(key), 'reason': 'Parser and step4 aggregates disagree'})
    return {'passed': not deviations, 'expectedCandidateCounters': expected,
            'referenceBaselineObservation': reference['id'], 'deviations': deviations,
            'interpretation': contract['nativeMetricInterpretation']}


def main():
    archive_path = pathlib.Path(sys.argv[1])
    dictionary = sys.argv[2]
    expected_archive_sha = sys.argv[3].removeprefix('sha256:')
    destination = pathlib.Path(sys.argv[4])
    destination.mkdir(parents=True, exist_ok=False)
    result = {'dictionary': dictionary, 'artifactSha256': expected_archive_sha,
              'complete': False, 'independentlyRecomputed': [], 'speedQualified': False,
              'auditorSha256': digest_file(pathlib.Path(__file__)), 'contractSha256': CONTRACT_SHA256}

    def write_result():
        (destination / 'independent-audit.json').write_text(json.dumps(result, indent=2) + '\n')

    try:
        assert digest_file(CONTRACT_PATH) == CONTRACT_SHA256
        contract = json.loads(CONTRACT_PATH.read_text())
        assert dictionary in contract['expectedNativePlans']
        for path, expected in contract['verifierDependencies'].items():
            assert digest_file(ROOT / path) == expected, ('Verifier dependency changed', path)
        for path, expected in contract['sameSourceHashes'].items():
            assert digest_file(ROOT / path) == expected, ('Source provenance changed', path)
        sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
        from audit_memory import audit_cell
        from protocol import memory_overlay, schedule as memory_schedule, memory_comparison
        from qualification_receipts import validate_import_summary, require_matching_receipts
        assert digest_file(archive_path) == expected_archive_sha
        result['independentlyRecomputed'].append('artifact-and-frozen-auditor-dependency-hashes')
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.namelist()
            assert len(members) == len(set(members))
            manifest = [{'path': info.filename, 'bytes': info.file_size, 'crc32': info.CRC} for info in archive.infolist()]
            (destination / 'artifact-file-list.json').write_text(json.dumps(manifest, indent=2) + '\n')

            def read_json(name):
                return json.loads(archive.read(name))

            for name in [
                'analysis.json', 'observations.json', 'registered-plan.json',
                'source-identities.json', 'browser-identity.json', 'qualification-driver.py',
                'memory/plan.json', 'memory/observations.json', 'memory/memory-comparison.json',
                'memory/memory-audit.json', 'memory/memory-audit-failure.json', 'memory/semantic-failures.json',
            ]:
                if name in members:
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
            plan = read_json('registered-plan.json')
            assert plan['baseline'] == contract['baseline'] and plan['candidate'] == contract['candidate']
            assert plan['dictionary'] == dictionary and plan['pairs'] == 6 and plan['initialOrder'] == 'AB'
            assert plan['flags'] == {} and plan['expectedWorkers'] is None
            assert plan['schedule'] == expected_schedule()
            assert plan['memorySchedule'] == memory_schedule(1)
            assert plan['expectedPackageEntries'] == contract['expectedChangedOrAddedEntries']
            assert plan['expectedAddedPackageEntries'] == contract['expectedAddedEntries']
            assert plan['packageFileSetPolicy'] == FILE_SET_POLICY
            assert plan['qualificationDriverSha256'] == contract['driverSha256']
            assert digest(archive.read('qualification-driver.py')) == contract['driverSha256']
            if dictionary == 'vndb':
                assert plan['vndbSahAllocationPolicy'] == {'rangeUnits': [37, 37], 'origin': 'explicit', 'unitBytes': 4096}
            else:
                assert plan['vndbSahAllocationPolicy'] is None
            result['independentlyRecomputed'].append('frozen-driver-and-exact-prospective-schedules')

            identities = read_json('source-identities.json')
            assert set(identities['arms']) == {'A', 'B'}
            assert identities['arms']['A']['sha'] == contract['baseline']
            assert identities['arms']['A']['tree'] == contract['baselineTree']
            assert identities['arms']['B']['sha'] == contract['candidate']
            assert identities['arms']['B']['tree'] == contract['candidateTree']
            assert identities['changedPackageEntries'] == sorted(contract['expectedChangedOrAddedEntries'])
            assert identities['addedPackageEntries'] == sorted(contract['expectedAddedEntries'])
            assert identities['removedPackageEntries'] == []
            packages = {}
            for arm, identity in identities['arms'].items():
                data = archive.read(f'package-{arm}.zip')
                assert digest(data) == identity['packageSha256']
                with zipfile.ZipFile(io.BytesIO(data)) as package:
                    assert len(package.namelist()) == len(set(package.namelist()))
                    packages[arm] = {entry.filename: digest(package.read(entry)) for entry in package.infolist() if not entry.is_dir()}
                    assert packages[arm] == identity['entries']
                assert identity['lockSha256'] == contract['sameSourceHashes']['package-lock.json']
                assert identity['fixtureLockSha256'] == contract['sameSourceHashes']['test/perf/dictionaries.lock.json']
                assert identity['sourceHashes'] == {
                    **contract['sameSourceHashes'], 'builds/manabitan-chrome-dev.zip': None,
                    'builds/manabitan-chrome.zip': identity['packageSha256'],
                }
                result.setdefault('packageBytes', {})[arm] = len(data)
            result['packageDelta'] = check_package_entries(packages['A'], packages['B'], contract)
            result['independentlyRecomputed'].append('complete-package-hashes-exact-eight-entry-union-and-single-added-helper')

            observations = read_json('observations.json')
            assert [{key: item[key] for key in ('id', 'kind', 'pair', 'arm')} for item in observations] == expected_schedule()
            assert len(observations) == 20
            fixtures = json.loads((ROOT / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']
            browser = read_json('browser-identity.json')['version']
            reference = None
            all_media_reference = None
            items = [(item['id'], 'B' if item['arm'] == 'B' else 'A', 'sample', None, item['totalImportMs']) for item in observations]
            items += [(f'exhaustive-media-{arm}', arm, 'all', None, None) for arm in 'AB']
            original_harness = archive.read('memory/harness-original.js')
            overlay = archive.read('memory/harness-instrumented.js')
            assert digest(original_harness) == contract['sameSourceHashes']['test/chromium/extension-two-dictionary-import.e2e.js']
            assert memory_overlay(original_harness.decode()).encode() == overlay
            overlay_hash = digest(overlay)
            memory_plan = read_json('memory/plan.json')
            assert memory_plan == {'schedule': memory_schedule(1), 'replication': 1, 'dictionary': dictionary,
                                   'authoritativeTiming': False, 'sourceHashes': identities['arms'], 'overlaySha256': overlay_hash}
            items += [(f"memory/{item['name']}", item['arm'], 'sample', overlay_hash, None) for item in memory_schedule(1)]
            assert len(items) == contract['expectedObservationCount']
            metric_records = []
            for location, arm, media_check, harness_hash, expected_duration in items:
                identity = identities['arms'][arm]
                source_hashes = identity['sourceHashes'].copy()
                if harness_hash is not None:
                    source_hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = harness_hash
                summary = read_json(f'{location}/summary.json')
                raw = read_json(f'{location}/run-1.json')
                receipt = validate_import_summary(summary, raw, dictionary=dictionary, fixture=fixtures[dictionary],
                    source_sha=identity['sha'], package_sha256=identity['packageSha256'], browser_version=browser,
                    import_flags=None, source_hashes=source_hashes, source_dirty=harness_hash is not None,
                    media_check=media_check, vndb_sah_allocation_units=[37, 37] if dictionary == 'vndb' else None)
                assert receipt == read_json(f'{location}/canonical-receipt.json')
                if expected_duration is not None:
                    assert math.isfinite(expected_duration) and expected_duration > 0
                    assert summary['runs'][0]['totalImportMs'] == expected_duration
                if reference is None:
                    reference = receipt
                else:
                    require_matching_receipts(reference, receipt, compare_media=media_check == 'sample')
                if media_check == 'all':
                    if all_media_reference is not None:
                        require_matching_receipts(all_media_reference, receipt)
                    all_media_reference = receipt
                metric_records.append({'id': location, 'arm': arm, 'totalImportMs': summary['runs'][0]['totalImportMs'],
                    'authoritativeTiming': expected_duration is not None and not location.startswith('warmup-'),
                    'summarySha256': digest(archive.read(f'{location}/summary.json')),
                    'rawSha256': digest(archive.read(f'{location}/run-1.json')),
                    'parserMetrics': parser_metrics(summary['runs'][0])})
            (destination / 'observation-route-metrics.json').write_text(json.dumps(metric_records, indent=2) + '\n')
            result['nativeTransportAdmission'] = audit_admission(metric_records, dictionary, contract)
            result['verifiedSemanticObservations'] = len(metric_records)
            result['independentlyRecomputed'].append('all-26-source-bound-monotonic-timing-and-semantic-receipts')
            assert read_json('memory/semantic-failures.json') == []
            result['diagnosticTraceMembers'] = [name for name in members if name.startswith('diagnostic-trace-')]
            result['diagnosticTracePolicy'] = contract['diagnosticTracePolicy']

            analysis = read_json('analysis.json')
            assert paired(observations, 'candidate', 'B') == analysis['candidateVsBaseline']
            assert paired(observations, 'control', 'C') == analysis['identicalCodeControl']
            result['candidateVsBaseline'] = analysis['candidateVsBaseline']
            result['identicalCodeControl'] = analysis['identicalCodeControl']
            result['independentlyRecomputed'].append('all-six-pairs-two-controls-and-fixed-bootstrap')

            with tempfile.TemporaryDirectory(prefix='manabitan-2ed-native-audit-') as temp:
                temp = pathlib.Path(temp)
                needed = ['memory/plan.json', 'memory/observations.json', 'memory/memory-comparison.json']
                for item in memory_schedule(1):
                    needed += [f"memory/{item['name']}/memory.json", f"memory/{item['name']}/markers.jsonl"]
                for name in needed:
                    target = temp / name.removeprefix('memory/')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
                recomputed = audit_cell(temp)
                assert recomputed == read_json('memory/memory-audit.json')
                assert memory_comparison(read_json('memory/observations.json'), dictionary, 1, memory_schedule) == read_json('memory/memory-comparison.json')
                result['memoryAudit'] = recomputed
                result['memoryFailures'] = [{'name': item['name'], 'qualificationFailures': item.get('qualificationFailures'),
                    'maximumCoveredSampleGapMs': item.get('maximumCoveredSampleGapMs'),
                    'preImportBracketGapMs': item.get('preImportBracketGapMs'),
                    'postImportBracketGapMs': item.get('postImportBracketGapMs'), 'qualified': item['qualifiedForWholeTreePss']}
                    for item in read_json('memory/observations.json')]
            result['independentlyRecomputed'].append('every-original-memory-scan-marker-and-unchanged-quality-limit')
            assert analysis['memoryPassed'] == recomputed['passesProspectiveMemoryScreen']
            result['screenStatus'] = analysis['status']
            result['memoryPassed'] = analysis['memoryPassed']
            result['complete'] = True
            write_result()
            # Admission mismatches retain all timing and semantic/memory evidence.
            # They block qualification and require diagnosis; no observation is dropped.
            assert result['nativeTransportAdmission']['passed'], 'Native transport/route admission differs; inspect retained observation-route-metrics.json and deviations'
            result['independentlyRecomputed'].append('every-candidate-native-plan-counter-and-baseline-equivalent-parser-route')
            write_result()
            print(json.dumps(result, indent=2))
    except Exception as failure:
        result['auditFailure'] = {'type': type(failure).__name__, 'message': str(failure)}
        write_result()
        raise


if __name__ == '__main__':
    main()
