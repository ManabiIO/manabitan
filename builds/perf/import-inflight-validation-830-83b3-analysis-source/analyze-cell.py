#!/usr/bin/env python3
"""Read one frozen hosted qualification cell; never acquire or alter observations."""
import argparse
import hashlib
import importlib
import json
import math
from pathlib import Path
import random
import statistics
import sys
import zipfile

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '049cb11e6963604435998aa060e1400cc00365cb'
TREES = {'A': 'd99ea4d04658f7ec1c76acdc5f3684594212a471', 'B': 'a47cc23bcfa039a9defe66db2b15d79ea2198072'}
PACKAGE_LOCK = '01e065503317a90b43a5bc60cd9f874238762c75a13c8115a9c484a626960a96'
FIXTURE_LOCK = '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89'
WASM = '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'
TOOLING = {
    'dev/perf/import-qualification-20261125-a7f7.py': 'cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef',
    'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py': '4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51',
    'dev/perf/import-memory-20261125-a7f7/protocol.py': 'ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7',
    'dev/perf/import-memory-20261125-a7f7/audit_memory.py': '871f29b9d87c42468714263a0eda05ee9edd2f76bff269ea9cb6d6d1fe51de7c',
    'dev/perf/import-memory-20261125-a7f7/chromium_memory.py': '8044bf3f4c48a868c7e076dc5f1bef9c2663f6323fe4a4fba5c121161cada4c7',
}
RUNTIME = {
    'js/dictionary/dictionary-database.js': {'A': '75da1c10c8cefd238e17aaabb44fca71f39e2f4e412660420c1e675d9cc7b84b', 'B': '12569a57197d4923fff7ed74fe6da071b4fff6d7a01bb9112e848c2a9d25cbbd'},
}
PROVENANCE_PATHS = {
    'package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/benchmark-support.js',
    'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js',
    'test/chromium/import-flags-ab-benchmark.js', 'test/chromium/extension-two-dictionary-import.e2e.js',
    'test/e2e/import-timing.js', 'ext/js/pages/settings/dictionary-import-controller.js',
    'builds/manabitan-chrome-dev.zip', 'builds/manabitan-chrome.zip',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def same(actual, expected, label):
    require(canonical(actual) == canonical(expected), label + ' differs')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def sha_file(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def schedule(first, pairs):
    opposite = first[::-1]
    result = []
    for pair, order in enumerate((first, opposite), 1):
        result.extend({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm} for arm in order)
    for pair in range(1, pairs + 1):
        order = first if pair % 2 else opposite
        result.extend({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm} for arm in order)
        if pair % 3 == 0:
            control = pair // 3
            order = 'AC' if (control + (first == 'BA')) % 2 else 'CA'
            result.extend({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm} for arm in order)
    return result


def statistics_for(observations, kind, right):
    grouped = {}
    for row in observations:
        if row.get('kind') == kind:
            grouped.setdefault(row['pair'], []).append(row)
    pairs = []
    incomplete = []
    for number, rows in sorted(grouped.items()):
        arms = {row['arm']: row for row in rows}
        if len(rows) != 2 or set(arms) != {'A', right} or not all(finite(row.get('totalImportMs')) for row in rows):
            incomplete.append({'pair': number, 'observations': rows})
            continue
        a, b = arms['A']['totalImportMs'], arms[right]['totalImportMs']
        pairs.append({'pair': number, 'order': ''.join(row['arm'] for row in rows), 'baselineMs': a, 'rightMs': b,
                      'ratio': b / a, 'changePercent': (b / a - 1) * 100, 'deltaMs': b - a,
                      'observationIds': [row['id'] for row in rows]})
    result = {'kind': kind, 'rightArm': right, 'pairs': pairs, 'incompletePairs': incomplete}
    if not pairs:
        return result
    ratios = [row['ratio'] for row in pairs]
    rng = random.Random(897)
    bootstrap = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    result['driverComparable'] = {
        'count': len(pairs), 'ratios': ratios,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(row['rightMs'] for row in pairs) / sum(row['baselineMs'] for row in pairs) - 1) * 100,
        'worstPairChangePercent': (max(ratios) - 1) * 100,
        'descriptiveBootstrap95Percent': [(bootstrap[index] - 1) * 100 for index in (249, 9749)],
        'fasterPairs': sum(ratio < 1 for ratio in ratios),
    }
    result['medianPairedDeltaMs'] = statistics.median(row['deltaMs'] for row in pairs)
    result['orderStrata'] = {}
    for order in sorted({row['order'] for row in pairs}):
        selected = [row for row in pairs if row['order'] == order]
        result['orderStrata'][order] = {'pairIds': [row['pair'] for row in selected], 'count': len(selected),
                                     'medianPairedChangePercent': (statistics.median(row['ratio'] for row in selected) - 1) * 100}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path, help='The single import-inflight-validation-830-83b3 directory from one artifact')
    parser.add_argument('--repo', required=True, type=Path, help='Local frozen baseline checkout providing verified auditors and fixture lock')
    parser.add_argument('--cell', required=True, choices=['jmdict-AB', 'jmdict-BA', 'jitendex-AB', 'vndb-AB'])
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--verify-packages', action='store_true', help='Stream both already-local package ZIPs and every member; otherwise gate stays pending')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    repo = args.repo.resolve()
    dictionary, first = args.cell.rsplit('-', 1)
    pairs = 12 if dictionary == 'jmdict' else 6
    expected = schedule(first, pairs)
    report = {'schemaVersion': 1, 'cell': args.cell, 'runId': 46114139837, 'baseline': BASELINE, 'candidate': CANDIDATE,
              'acquisitionChanged': False, 'timingClaim': False, 'hostPooling': False, 'controlSubtraction': False,
              'expectedCounts': {'ordinary': len(expected), 'warmup': 4, 'candidate': pairs * 2, 'control': pairs // 3 * 2, 'exhaustiveMedia': 2, 'memory': 4},
              'issues': [], 'gates': {}, 'inputFiles': {}, 'readbacks': [], 'allRecordedObservations': [],
              'limits': ['Descriptive per-host statistics; complete qualification is not itself a latency claim.',
                         'Incomplete schedules retain all recorded values and complete-pair statistics are provisional.',
                         'Warmup, identical controls, exhaustive media and memory never enter the candidate estimate.']}

    def remember(file):
        require(file.is_file() and not file.is_symlink(), 'Missing or linked input: ' + str(file))
        key = str(file)
        report['inputFiles'][key] = {'sha256': sha_file(file), 'bytes': file.stat().st_size}
        return file

    def load(file):
        remember(file)
        require(file.stat().st_size <= 64 * 1024 * 1024, 'JSON input exceeds bounded reader limit: ' + str(file))
        return json.loads(file.read_text(), object_pairs_hook=unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON token: ' + value)))

    def stage(name, function):
        try:
            value = function()
            report['gates'][name] = 'passed'
            return value
        except Exception as error:
            report['gates'][name] = 'failed'
            report['issues'].append({'stage': name, 'type': type(error).__name__, 'message': str(error)})
            return None

    def tooling():
        for relative, expected_sha in TOOLING.items():
            require(sha_file(remember(repo / relative)) == expected_sha, 'Frozen auditor changed: ' + relative)
        require(sha_file(remember(repo / 'package-lock.json')) == PACKAGE_LOCK, 'Package lock changed')
        require(sha_file(remember(repo / 'test/perf/dictionaries.lock.json')) == FIXTURE_LOCK, 'Fixture lock changed')
        sys.path.insert(0, str(repo / 'dev/perf/import-memory-20261125-a7f7'))
        return (importlib.import_module('qualification_receipts'), importlib.import_module('protocol'), importlib.import_module('audit_memory'))

    auditors = stage('frozenAuditors', tooling)
    plan = stage('planRead', lambda: load(evidence / 'registered-plan.json'))
    identities = stage('sourceIdentitiesRead', lambda: load(evidence / 'source-identities.json'))
    browser = stage('browserIdentityRead', lambda: load(evidence / 'browser-identity.json'))
    observations = stage('observationsRead', lambda: load(evidence / 'observations.json'))
    fixture = load(repo / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    reference = None

    def inventory_attempts():
        recorded = {row['id'] for row in observations} if type(observations) is list else set()
        attempts = []
        for item in expected:
            directory = evidence / item['id']
            require(not directory.is_symlink(), 'Linked observation directory: ' + item['id'])
            available = []
            if directory.is_dir():
                for file in sorted(directory.iterdir()):
                    if file.suffix in {'.json', '.jsonl', '.log', '.txt'}:
                        remember(file)
                        available.append({'path': str(file), **report['inputFiles'][str(file)]})
            state = 'recorded' if item['id'] in recorded else 'attempted-without-observation' if available else 'missing'
            attempts.append({**item, 'state': state, 'availableEvidence': available})
        report['expectedAttemptInventory'] = attempts
        report['unrecordedAttempts'] = [row for row in attempts if row['state'] == 'attempted-without-observation']

    stage('attemptInventory', inventory_attempts)

    def check_plan():
        for key, value in {'baseline': BASELINE, 'candidate': CANDIDATE, 'dictionary': dictionary, 'initialOrder': first, 'pairs': pairs, 'flags': {}, 'expectedWorkers': None, 'schedule': expected}.items():
            same(plan[key], value, 'plan.' + key)
        same(sorted(plan['expectedPackageEntries']), sorted(RUNTIME), 'package whitelist')
        if dictionary == 'vndb':
            same(plan['vndbSahAllocationPolicy'], {'unitBytes': 4096, 'rangeUnits': [37, 37], 'origin': 'explicit'}, 'VNDB allocation contract')
        else:
            same(plan['vndbSahAllocationPolicy'], None, 'non-VNDB allocation contract')
        same([{key: row[key] for key in ['id', 'kind', 'pair', 'arm']} for row in observations], expected, 'complete chronological schedule')

    stage('registeredSchedule', check_plan)

    def check_sources():
        same(browser['version'], '153.0.8010.12', 'locked Chromium version')
        require(len(browser['sha256']) == 64, 'Missing browser binary SHA')
        arms = identities['arms']
        for arm, sha in [('A', BASELINE), ('B', CANDIDATE)]:
            identity = arms[arm]
            same(identity['sha'], sha, arm + ' commit')
            same(identity['tree'], TREES[arm], arm + ' tree')
            same(identity['lockSha256'], PACKAGE_LOCK, arm + ' package lock')
            same(identity['fixtureLockSha256'], FIXTURE_LOCK, arm + ' fixture lock')
            same(identity['entries']['lib/term-bank-parser.wasm'], WASM, arm + ' packaged parser WASM')
            for member, hashes in RUNTIME.items():
                same(identity['entries'][member], hashes[arm], arm + ' runtime ' + member)
            same(sorted(identity['sourceHashes']), sorted(PROVENANCE_PATHS), arm + ' provenance path set')
            for relative, sha_value in identity['sourceHashes'].items():
                if not relative.startswith('builds/'):
                    same(sha_value, sha_file(remember(repo / relative)), arm + ' harness source ' + relative)
        same(sorted(arms['A']['entries']), sorted(arms['B']['entries']), 'package member set')
        changed = sorted(name for name in arms['A']['entries'] if arms['A']['entries'][name] != arms['B']['entries'][name])
        same(changed, sorted(RUNTIME), 'actual member changes')
        same(sorted(identities['changedPackageEntries']), changed, 'recorded member changes')

    stage('sourceFixtureRuntimeBindings', check_sources)

    def validate_one(relative, arm, media='sample', overlay=None):
        summary = load(evidence / relative / 'summary.json')
        raw = load(evidence / relative / 'run-1.json')
        phase = [row for row in raw['phases'] if row.get('name') == fixture['label'] + ': total import']
        require(len(phase) == 1, 'One complete-import phase required')
        timing = phase[0]['data']['browserTiming']
        duration = timing['completedAtMs'] - timing['startedAtMs']
        require(finite(duration), 'Invalid browser endpoint duration')
        recorded = summary['runs'][0]['totalImportMs']
        require(abs(recorded - duration) <= 0.001, 'Browser endpoint readback mismatch')
        entry = {'id': relative, 'arm': arm, 'totalImportMs': recorded, 'rawBrowserDurationMs': duration,
                 'sourceSha': summary['source']['gitSha'], 'packageSha256': raw['packageSha256'], 'receiptValidated': False}
        report['readbacks'].append(entry)
        require(auditors is not None, 'Frozen auditors unavailable')
        identity = identities['arms'][arm]
        hashes = dict(identity['sourceHashes'])
        if overlay is not None:
            hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = hashlib.sha256(overlay).hexdigest()
        receipt = auditors[0].validate_import_summary(summary, raw, dictionary=dictionary, fixture=fixture,
            source_sha=identity['sha'], package_sha256=identity['packageSha256'], browser_version=browser['version'],
            import_flags=None, source_hashes=hashes, source_dirty=overlay is not None, media_check=media,
            vndb_sah_allocation_units=[37, 37] if dictionary == 'vndb' else None)
        same(load(evidence / relative / 'canonical-receipt.json'), receipt, 'stored canonical receipt ' + relative)
        entry['receiptValidated'] = True
        entry['canonicalSha256'] = hashlib.sha256(canonical(receipt).encode()).hexdigest()
        return receipt

    if type(observations) is list:
        report['allRecordedObservations'] = observations
        for observation in observations:
            def check_observation(row=observation):
                nonlocal reference
                require(row['id'] in {item['id'] for item in expected}, 'Unexpected observation id')
                receipt = validate_one(row['id'], 'B' if row['arm'] == 'B' else 'A')
                same(report['readbacks'][-1]['totalImportMs'], row['totalImportMs'], 'observations/readback duration')
                load(evidence / row['id'] / 'host-before.json')
                load(evidence / row['id'] / 'host-after.json')
                if reference is None:
                    reference = receipt
                else:
                    auditors[0].require_matching_receipts(reference, receipt)
            stage('ordinary:' + str(observation.get('id')), check_observation)
        report['warmups'] = [row for row in observations if row.get('kind') == 'warmup']
        report['candidateVsBaseline'] = statistics_for(observations, 'candidate', 'B')
        report['identicalCodeControl'] = statistics_for(observations, 'control', 'C')

    full_reference = None
    for arm in first:
        def check_media(selected=arm):
            nonlocal full_reference
            receipt = validate_one('exhaustive-media-' + selected, selected, media='all')
            auditors[0].require_matching_receipts(reference, receipt, compare_media=False)
            if full_reference is None:
                full_reference = receipt
            else:
                auditors[0].require_matching_receipts(full_reference, receipt)
        stage('exhaustiveMedia:' + arm, check_media)

    def check_memory():
        require(auditors is not None, 'Frozen auditors unavailable')
        memory = evidence / 'memory'
        memory_plan = load(memory / 'plan.json')
        replication = 1 if first == 'AB' else 2
        expected_memory = auditors[1].schedule(replication)
        same(memory_plan['dictionary'], dictionary, 'memory dictionary')
        same(memory_plan['replication'], replication, 'memory replication')
        same(memory_plan['authoritativeTiming'], False, 'memory timing status')
        same(memory_plan['schedule'], expected_memory, 'memory schedule')
        same(plan['memorySchedule'], expected_memory, 'registered memory schedule')
        same(memory_plan['sourceHashes'], identities['arms'], 'memory source identities')
        original = remember(memory / 'harness-original.js').read_bytes()
        overlay = remember(memory / 'harness-instrumented.js').read_bytes()
        same(hashlib.sha256(original).hexdigest(), identities['arms']['A']['sourceHashes']['test/chromium/extension-two-dictionary-import.e2e.js'], 'original memory harness')
        require(auditors[1].memory_overlay(original.decode()).encode() == overlay, 'Exact memory overlay differs')
        same(hashlib.sha256(overlay).hexdigest(), memory_plan['overlaySha256'], 'overlay digest')
        for item in expected_memory:
            receipt = validate_one('memory/' + item['name'], item['arm'], overlay=overlay)
            auditors[0].require_matching_receipts(reference, receipt)
            load(memory / item['name'] / 'memory.json')
            remember(memory / item['name'] / 'markers.jsonl')
        same(load(memory / 'semantic-failures.json'), [], 'memory semantics')
        memory_observations = load(memory / 'observations.json')
        memory_comparison = load(memory / 'memory-comparison.json')
        expected_comparison = auditors[1].memory_comparison(memory_observations, dictionary, replication, auditors[1].schedule)
        same(memory_comparison, expected_comparison, 'complete recomputed memory comparison')
        result = auditors[2].audit_cell(memory)
        same(load(memory / 'memory-audit.json'), result, 'saved memory audit')
        report['memoryAudit'] = result
        require(result['passesProspectiveMemoryScreen'], 'Frozen prospective memory gate failed')

    stage('separateMemory', check_memory)

    def check_driver_analysis():
        actual = load(evidence / 'analysis.json')
        same(actual['candidateVsBaseline'], report['candidateVsBaseline']['driverComparable'], 'driver candidate statistics')
        same(actual['identicalCodeControl'], report['identicalCodeControl']['driverComparable'], 'driver identical statistics')
        same(actual['memoryPassed'], report['gates']['separateMemory'] == 'passed', 'driver memory result')
        report['driverAnalysis'] = actual

    stage('independentStatistics', check_driver_analysis)

    def verify_packages():
        for arm in 'AB':
            file = remember(evidence / f'package-{arm}.zip')
            same(sha_file(file), identities['arms'][arm]['packageSha256'], arm + ' package bytes')
            entries = {}
            with zipfile.ZipFile(file) as archive:
                require(len(archive.namelist()) == len(set(archive.namelist())), 'Duplicate package members')
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    digest = hashlib.sha256()
                    with archive.open(info) as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                            digest.update(chunk)
                    entries[info.filename] = digest.hexdigest()
            same(entries, identities['arms'][arm]['entries'], arm + ' package member bytes')

    if args.verify_packages:
        stage('packageBytes', verify_packages)
    else:
        report['gates']['packageBytes'] = 'pending-not-requested'
    report['allRequiredGatesPassed'] = all(value == 'passed' for value in report['gates'].values())
    report['completeTimingScheduleVerified'] = report['gates'].get('registeredSchedule') == 'passed' and all(report['gates'].get('ordinary:' + row['id']) == 'passed' for row in expected)
    report['analyzerSha256'] = sha_file(Path(__file__))
    require(not args.output.exists(), 'Refusing to overwrite an analysis result')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + '\n')
    print(json.dumps({'cell': args.cell, 'output': str(args.output), 'allRequiredGatesPassed': report['allRequiredGatesPassed'],
                      'completeTimingScheduleVerified': report['completeTimingScheduleVerified'], 'issues': report['issues'],
                      'candidate': report.get('candidateVsBaseline', {}).get('driverComparable'),
                      'control': report.get('identicalCodeControl', {}).get('driverComparable')}, indent=2))
    return 0 if report['allRequiredGatesPassed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
