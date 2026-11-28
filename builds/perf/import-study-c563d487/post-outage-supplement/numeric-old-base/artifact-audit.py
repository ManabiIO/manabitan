#!/usr/bin/env python3
"""Audit retained numeric-suffix ZIP bytes; never launch a benchmark or browser."""
from pathlib import Path, PurePosixPath
import collections
import datetime
import errno
import hashlib
import importlib.util
import io
import json
import math
import statistics
import subprocess
import sys
import traceback
import zipfile

sys.dont_write_bytecode = True
WORKSPACE = Path(__file__).resolve().parents[2]
BASELINE = WORKSPACE / 'manabitan'
BASE_SHA = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE_SHA = '399feae29fea358560af27af68f03dfb6d8b6f58'
TOOLING_SHA = 'ee9450923d14e95b7958feeffffde4998cf8c5d9'
MARKER = 'MANABITAN_QUALIFICATION_JSON '
GONE = {errno.ENOENT, errno.ESRCH}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def pick(value, keys):
    return {key: value.get(key) for key in keys}


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def compact_validation(value):
    result = pick(value, ('title', 'revision', 'termRows', 'contentReadable', 'probeCount', 'probeTerms', 'outputDigestSha256'))
    result['restart'] = pick(value['restart'], ('title', 'revision', 'termRows', 'contentReadable', 'probeCount', 'mediaFiles'))
    result['media'] = pick(value['media'], ('mode', 'totalFiles', 'totalBytes', 'files', 'bytes', 'sha256'))
    result['storage'] = value['storage']
    lookup = value['lookup']
    rows = lookup['observations']
    semantics = [{k: v for k, v in row.items() if k != 'elapsedMs'} for row in rows]
    semantics.sort(key=lambda row: (row.get('pass', -1), row.get('term', '')))
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row['pass']].append(row)
    passes = []
    for number, group in sorted(groups.items(), key=lambda item: str(item[0])):
        times = [row['elapsedMs'] for row in group if type(row.get('elapsedMs')) in (int, float)]
        passes.append({'pass': number, 'count': len(group), 'elapsedCount': len(times),
                       'totalMs': sum(times), 'medianMs': statistics.median(times) if times else None,
                       'maxMs': max(times) if times else None})
    result['lookup'] = {'timingBoundary': lookup.get('timingBoundary'), 'observationCount': len(rows),
                        'distinctPassTerms': len({(row.get('pass'), row.get('term')) for row in rows}),
                        'allExactHeadwordMatches': all(row.get('hasExactHeadwordMatch') is True for row in rows),
                        'semanticSha256': digest(semantics), 'passes': passes}
    return result


def tree_identity(tree):
    fields = ('pid', 'startTimeTicks', 'parentPid', 'executable', 'comm', 'argv', 'role')
    return [tuple(process[key] for key in fields) for process in tree['processes']]


def exited_zombie(before, after):
    if after is None or before.get('smapsReadError', {}).get('errno') != errno.ESRCH:
        return False
    if any(type(before.get(key)) is not int or type(after.get(key)) is not int or before[key] != after[key]
           for key in ('pid', 'startTimeTicks')):
        return False
    for process in (before, after):
        if (process.get('state') != 'Z' or type(process.get('threadCount')) is not int
                or process['threadCount'] != 1 or process.get('executable', 'unknown') is not None):
            return False
        if not any(error.get('field') == 'executable' and error.get('errno') == errno.ENOENT
                   for error in process.get('metadataReadErrors', [])):
            return False
    return True


def reconstruct_memory(value, markers):
    """Independent per-process/window arithmetic under the existing a7f7 policy."""
    assert markers == value['windowMarkers']
    scans = value['samples']
    previous_end = 0
    read_processes = 0
    for index, sample in enumerate(scans):
        begin, end = sample['startedAtMonotonicNs'], sample['finishedAtMonotonicNs']
        assert type(begin) is int and type(end) is int and previous_end <= begin <= end, index
        previous_end = end
        before, after = sample['discoveryBefore'], sample['discoveryAfter']
        stable = tree_identity(before) == tree_identity(after)
        assert sample['stableObservedProcessTree'] == stable
        reads, unavailable = sample['processes'], sample['unavailableProcesses']
        assert len({p['pid'] for p in reads + unavailable}) == len(reads) + len(unavailable)
        assert {p['pid'] for p in before['processes']} == {p['pid'] for p in reads + unavailable}
        read_processes += len(reads)
        for field, reported in [('pssKiB', 'readableProcessPssKiB'), ('privateKiB', 'readableProcessPrivateKiB')]:
            assert all(type(p[field]) is int and p[field] >= 0 for p in reads)
            assert sample[reported] == sum(p[field] for p in reads)
        after_pids = {p['pid']: p for p in after['processes']}
        zombies = {p['pid'] for p in unavailable if exited_zombie(p, after_pids.get(p['pid']))}
        assert {p['pid'] for p in sample['confirmedExitedZombies']} == zombies
        unreadable = [p for p in unavailable if p['pid'] not in zombies]
        assert sample['unreadableAddressSpaces'] == unreadable
        roles = {p['role'] for p in reads}
        assert sample['observedRoles'] == sorted(roles)
        failures = []
        if not before['browserSeedPids']:
            failures.append('no-browser-seed')
        if len(reads) < 2:
            failures.append('no-multiple-process-coverage')
        if 'browser' not in roles:
            failures.append('no-readable-browser-process')
        if 'renderer' not in roles:
            failures.append('no-readable-renderer-process')
        if not stable:
            failures.append('process-tree-changed-during-scan')
        if unreadable:
            failures.append('unreadable-discovered-process-smaps')
        if any(error['errno'] not in GONE for error in before['inventoryIdentityReadErrors'] + after['inventoryIdentityReadErrors']):
            failures.append('incomplete-process-identity-inventory')
        assert failures == sample['qualificationFailures']
        assert sample['qualifiedForWholeTreePss'] == (not failures)

    assert len(markers) == 2 and [m['event'] for m in markers] == ['start', 'end']
    assert all(type(m['monotonicNs']) is str and m['monotonicNs'].isdigit() for m in markers)
    begin, end = [int(m['monotonicNs']) for m in markers]
    assert end > begin
    overlap = [s for s in scans if s['finishedAtMonotonicNs'] >= begin and s['startedAtMonotonicNs'] <= end]
    inside = [s for s in overlap if s['startedAtMonotonicNs'] >= begin and s['finishedAtMonotonicNs'] <= end]
    covered = [s for s in inside if s['qualifiedForWholeTreePss']]
    overlap_covered = [s for s in overlap if s['qualifiedForWholeTreePss']]
    before = [s for s in scans if s['qualifiedForWholeTreePss'] and s['finishedAtMonotonicNs'] <= begin]
    after = [s for s in scans if s['qualifiedForWholeTreePss'] and s['startedAtMonotonicNs'] >= end]
    before_gap = (begin - before[-1]['finishedAtMonotonicNs']) / 1e6 if before else None
    after_gap = (after[0]['startedAtMonotonicNs'] - end) / 1e6 if after else None
    points = [begin] + [(s['startedAtMonotonicNs'] + s['finishedAtMonotonicNs']) // 2 for s in covered] + [end]
    gaps = [(b - a) / 1e6 for a, b in zip(points, points[1:])]
    max_gap = max(gaps)
    failures = []
    if before_gap is None or before_gap > 250:
        failures.append('missing-covered-pre-import-bracket')
    if after_gap is None or after_gap > 250:
        failures.append('missing-covered-post-import-bracket')
    if len(covered) < 5:
        failures.append('fewer-than-five-covered-import-scans')
    if max_gap > 250:
        failures.append('covered-import-scan-gap-over-250ms')
    if value['benchmarkExitCode'] != 0:
        failures.append('benchmark-command-failed')
    if not overlap_covered:
        failures.append('no-stable-fully-read-browser-renderer-tree')
    if any(s['stableObservedProcessTree'] and s['unreadableAddressSpaces'] for s in overlap) or any(
            p['smapsReadError']['errno'] not in GONE for s in overlap for p in s['unreadableAddressSpaces']):
        failures.append('process-smaps-coverage-unqualified')
    if any('incomplete-process-identity-inventory' in s['qualificationFailures'] for s in overlap):
        failures.append('process-identity-coverage-unqualified')
    failures = list(dict.fromkeys(failures))
    qualified = not failures
    computed = {
        'schemaVersion': 3, 'observerRule': 'import-window-stable-single-thread-zombie-esrch-v1',
        'authoritativeTiming': False, 'qualifiedForWholeTreePss': qualified, 'qualificationFailures': failures,
        'sampleCount': len(overlap), 'stableFullyReadTreeSampleCount': len(overlap_covered),
        'observedProcessCountRange': [min((len(s['processes']) for s in overlap_covered), default=0),
                                      max((len(s['processes']) for s in overlap_covered), default=0)],
        'samplesWithUnavailableSmaps': sum(bool(s['unavailableProcesses']) for s in overlap),
        'samplesWithUnreadableAddressSpaces': sum(bool(s['unreadableAddressSpaces']) for s in overlap),
        'confirmedExitedZombieObservationCount': sum(len(s['confirmedExitedZombies']) for s in overlap),
        'confirmedExitedZombieIdentityCount': len({(p['pid'], p['startTimeTicks']) for s in overlap for p in s['confirmedExitedZombies']}),
        'windowDurationMs': (end - begin) / 1e6,
        'preImportBracketGapMs': before_gap, 'postImportBracketGapMs': after_gap,
        'maximumCoveredSampleGapMs': max_gap, 'allObservedSampleCount': len(scans),
        'overlappingImportSampleCount': len(overlap), 'fullyContainedImportSampleCount': len(inside),
        'stableFullyReadImportSampleCount': len(covered),
        'maxSampledPssKiB': max((s['readableProcessPssKiB'] for s in covered), default=None) if qualified else None,
        'maxSampledPrivateKiB': max((s['readableProcessPrivateKiB'] for s in covered), default=None) if qualified else None,
    }
    assert pick(value, computed) == computed
    assert value['scope'] == 'Discovered Chromium process tree from immediately before file-input dispatch through observed UI import completion; startup, media readback and restart excluded from maxima'
    assert value['sampling'] == 'Linux /proc smaps_rollup; 25 ms wait between scans; non-atomic stable identity/metadata checks'
    return {**computed, 'rawProcessReadCount': read_processes,
            'maximumGapProof': [{'leftNs': points[i], 'rightNs': points[i + 1], 'gapMs': gap}
                                for i, gap in enumerate(gaps) if gap == max_gap]}


def audit(root):
    metadata = json.loads((root / 'artifact-download-receipt.json').read_text())
    archive = root / 'original-artifact.zip'
    with archive.open('rb') as stream:
        observed_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert observed_sha == metadata['artifact']['digest'].removeprefix('sha256:')
    assert archive.stat().st_size == metadata['artifact']['size_in_bytes']
    source_paths = ['dev/perf/import-qualification-20261125-a7f7.py'] + [
        'dev/perf/import-memory-20261125-a7f7/' + x for x in ['audit_memory.py', 'chromium_memory.py', 'protocol.py', 'qualification_receipts.py']]
    source_hashes = {}
    for name in source_paths:
        raw = (BASELINE / name).read_bytes()
        assert raw == subprocess.check_output(['git', 'show', BASE_SHA + ':' + name], cwd=BASELINE)
        source_hashes[name] = sha(raw)
    policies = BASELINE / 'dev/perf/import-memory-20261125-a7f7'
    canonicalize = module(policies / 'qualification_receipts.py', 'frozen_qualification_receipts')
    protocol = module(policies / 'protocol.py', 'frozen_memory_protocol')

    lines = (root / 'primary-records.jsonl').read_text().splitlines()
    assert all(not line.strip() or line.startswith(MARKER) for line in lines)
    primary = [json.loads(line[len(MARKER):]) for line in lines if line.startswith(MARKER)]
    assert len(primary) == 55
    by_kind = collections.defaultdict(list)
    for record in primary:
        by_kind[record['kind']].append(record['value'])
    cohort = by_kind['cohort'][0]
    assert cohort['baseline'] == BASE_SHA and cohort['candidate'] == CANDIDATE_SHA
    assert cohort['workflowCommit'] == TOOLING_SHA and cohort['runId'] == '46113243549' and cohort['attempt'] == '1'
    assert cohort['observerSha256'] == source_hashes[source_paths[0]]
    fixture_lock = BASELINE / 'test/perf/dictionaries.lock.json'
    assert sha(fixture_lock.read_bytes()) == cohort['fixtureLockSha256']
    fixture = json.loads(fixture_lock.read_text())['dictionaries'][cohort['dictionary']]
    assert cohort['fixture'] == fixture

    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        assert len(names) == len(set(names))
        member_hashes = {}
        for item in z.infolist():
            path = PurePosixPath(item.filename)
            assert not path.is_absolute() and '..' not in path.parts
            with z.open(item) as stream:
                member_hashes[item.filename] = {'sha256': hashlib.file_digest(stream, 'sha256').hexdigest(),
                                                'bytes': item.file_size, 'compressedBytes': item.compress_size, 'crc32': item.CRC}
        read = lambda name: json.loads(z.read(name))
        plan = read('registered-plan.json')
        identities = read('source-identities.json')
        browser = read('browser-identity.json')
        assert plan == by_kind['registered-plan'][0]
        assert browser == by_kind['browser-identity'][0]
        assert plan['baseline'] == BASE_SHA and plan['candidate'] == CANDIDATE_SHA
        assert plan['dictionary'] == cohort['dictionary'] and plan['initialOrder'] == cohort['order']
        assert plan['flags'] == {} and plan['pairs'] == 12
        workflow = WORKSPACE / 'experiments/row-suffix-numeric/qualification/bound-publication/import-numeric-suffix-qualification-c563d487.yml'
        assert cohort == {'dictionary': plan['dictionary'], 'order': plan['initialOrder'],
                          'baseline': BASE_SHA, 'candidate': CANDIDATE_SHA, 'expectedObservationCount': 42,
                          'workflowCommit': TOOLING_SHA, 'runId': '46113243549', 'attempt': '1', 'fixture': fixture,
                          'fixtureLockSha256': sha(fixture_lock.read_bytes()),
                          'observerSha256': source_hashes[source_paths[0]], 'workflowSha256': sha(workflow.read_bytes()),
                          'logExtractionPolicy': 'Read-only after acquisition; every raw report discovered, no timing or semantic replacements'}
        for filename in ('prospective-review-criteria.json', 'prospective-review-criteria-v2.json', 'package-entry-amendment.json'):
            assert z.read(filename) == (WORKSPACE / 'experiments/row-suffix-numeric/qualification' / filename).read_bytes()
        source_projection = []
        changed = identities['changedPackageEntries']
        assert changed == ['js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm']
        package_checks = {}
        package_maps = {}
        for arm, identity in identities['arms'].items():
            result = {key: value for key, value in identity.items() if key != 'entries'}
            result.update(packageEntryCount=len(identity['entries']), packageEntriesSha256=digest(identity['entries']),
                          changedPackageEntryHashes={name: identity['entries'].get(name) for name in changed})
            source_projection.append({'arm': arm, **result})
            package_name = 'package-' + arm + '.zip'
            package = z.read(package_name)
            assert sha(package) == identity['packageSha256']
            with zipfile.ZipFile(io.BytesIO(package)) as nested:
                file_entries = [entry for entry in nested.infolist() if not entry.is_dir()]
                actual_entries = {entry.filename: sha(nested.read(entry)) for entry in file_entries}
                assert len(actual_entries) == len(file_entries)
                assert actual_entries == identity['entries']
                expected_native = {
                    'A': {'js/dictionary/wasm/term-bank-parser.c': '5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a',
                          'lib/term-bank-parser.wasm': '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'},
                    'B': {'js/dictionary/wasm/term-bank-parser.c': '461021621f35788899ab4b5b62603423f54e0ee766ff8f1ca20529fca4da1372',
                          'lib/term-bank-parser.wasm': '18524ff89d179878aff0d681987c1b6f7b6274c25db050421436abd25c4b004a'},
                }
                assert {name: actual_entries[name] for name in changed} == expected_native[arm]
                package_maps[arm] = actual_entries
                package_checks[arm] = {'zipSha256': sha(package), 'zipBytes': len(package), 'entries': len(file_entries),
                                      'entryMapSha256': digest(actual_entries),
                                      'changedEntries': {name: {'sha256': actual_entries[name], 'bytes': nested.getinfo(name).file_size,
                                                               'compressedBytes': nested.getinfo(name).compress_size} for name in changed}}
            del package
        assert source_projection == by_kind['source-identity']
        assert sorted(name for name in set(package_maps['A']) | set(package_maps['B'])
                      if package_maps['A'].get(name) != package_maps['B'].get(name)) == changed
        assert by_kind['package-diff'] == [{'changedPackageEntries': changed, 'controlC': identities.get('controlC')}]
        assert identities['controlC'] == 'Same A source, package, runtime, and flags under a distinct observation label'

        roles = {}
        for position, item in enumerate(plan['schedule'], 1):
            roles[item['id']] = {**item, 'position': position, 'authoritativeCohort': item['kind'] == 'candidate'}
        for position, arm in enumerate(plan['initialOrder'], 1):
            roles['exhaustive-media-' + arm] = {'kind': 'exhaustive-media', 'arm': arm, 'position': position, 'authoritativeCohort': False}
        for item in plan['memorySchedule']:
            roles['memory/' + item['name']] = {**item, 'kind': 'memory', 'authoritativeCohort': False}
        reports = sorted(name[:-len('/run-1.json')] for name in names if name.endswith('/run-1.json'))
        assert len(reports) == 42 and set(reports) == set(roles)
        assert set(reports) == {name[:-len('/run.log')] for name in names if name.endswith('/run.log')}
        observed = []
        semantic_receipts = []
        raw_times = []
        memory_plan = read('memory/plan.json')
        original_harness = z.read('memory/harness-original.js')
        instrumented_harness = z.read('memory/harness-instrumented.js')
        assert original_harness.decode() == (BASELINE / 'test/chromium/extension-two-dictionary-import.e2e.js').read_text()
        assert protocol.memory_overlay(original_harness.decode()).encode() == instrumented_harness
        assert sha(instrumented_harness) == memory_plan['overlaySha256'] == '81adafaae2763693ae074bd8fe30c6712d066c29ec424c6385590f6eaa10a9bb'
        allocation = plan['vndbSahAllocationPolicy']['rangeUnits'] if plan['vndbSahAllocationPolicy'] else None
        for name in reports:
            report = read(name + '/run-1.json'); summary = read(name + '/summary.json'); canonical = read(name + '/canonical-receipt.json')
            run = summary['runs'][0]; benchmark = report['benchmark']; validation = benchmark['validation']; role = roles[name]
            memory = role['kind'] == 'memory'
            identity = identities['arms']['A' if role['arm'] == 'C' else role['arm']]
            expected_hashes = dict(identity['sourceHashes'])
            if memory:
                expected_hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = memory_plan['overlaySha256']
            semantic = canonicalize.validate_import_summary(
                summary, report, dictionary=cohort['dictionary'], fixture=fixture, source_sha=identity['sha'],
                package_sha256=identity['packageSha256'], browser_version=browser['version'], import_flags=None,
                source_hashes=expected_hashes, source_dirty=memory,
                media_check='all' if role['kind'] == 'exhaustive-media' else 'sample', vndb_sah_allocation_units=allocation)
            assert semantic == canonical
            semantic_receipts.append({'id': name, 'commonSha256': digest(semantic['common']), 'media': semantic['media']})
            phases = [phase for phase in report['phases'] if phase['name'] in
                      (fixture['label'] + ': total import', 'Import ' + fixture['label'] + ' via file input')]
            phase_rows = [{**pick(phase, ('name', 'startMs', 'endMs', 'durationMs')),
                           'browserTiming': (phase.get('data') or {}).get('browserTiming'),
                           'importDebug': pick((phase.get('data') or {}).get('importDebug') or {},
                                               ('hasResult', 'resultTitle', 'errorCount', 'addSettingsErrorCount', 'usesFallbackStorage'))}
                          for phase in phases]
            item = {
                'id': name, 'role': role, 'requestedFlags': plan['flags'],
                'report': pick(report, ('status', 'failureReason', 'skipReason', 'skippedVerification', 'buildTarget', 'browserFlavor', 'launchMode', 'browserVersion', 'packageSha256')),
                'benchmark': pick(benchmark, ('dictionary', 'pinnedDictionaries', 'productionImportDefaults', 'traceEnabled', 'authoritativeTiming', 'phaseProfiling', 'phaseScreenshots', 'processSampling', 'importFlags', 'mediaCheck')),
                'summary': pick(summary, ('schemaVersion', 'dictionary', 'buildTarget', 'authoritativeTiming', 'traceEnabled', 'gitSha', 'source', 'browserVersion', 'importFlags', 'mediaCheck', 'timingBoundary', 'timing')),
                'fixtureSha256': digest(summary['fixture']), 'runCount': len(summary['runs']),
                'run': pick(run, ('index', 'tracePath', 'browserVersion', 'packageSha256', 'totalImportMs', 'automationObservedImportMs', 'workerImportMs')),
                'rawPhases': phase_rows, 'validation': compact_validation(validation),
                'summaryValidationSha256': digest(run['validation']), 'rawValidationSha256': digest(validation),
                'canonicalCommonSha256': digest(canonical['common']), 'canonicalMedia': canonical['media'],
                'host': summary['hostEnvironment'], 'rawHost': report['hostEnvironment'],
                'fileSha256': {filename: member_hashes[name + '/' + filename]['sha256']
                               for filename in ('run-1.json', 'summary.json', 'canonical-receipt.json')},
            }
            observed.append(item)
            total = next(phase for phase in phases if phase['name'].endswith(': total import'))['data']['browserTiming']
            monotonic = total['completedAtMs'] - total['startedAtMs']
            assert monotonic == run['totalImportMs']
            raw_times.append({'id': name, 'kind': role['kind'], 'arm': role['arm'], 'rawMonotonicImportMs': monotonic})
        assert observed == by_kind['observation']
        assert len({x['commonSha256'] for x in semantic_receipts}) == 1
        result_files = []
        for item in by_kind['result-file']:
            path = item['path']
            assert member_hashes[path]['sha256'] == item['sha256']
            assert read(path) == item['value']
            result_files.append({'path': path, 'sha256': item['sha256']})
        assert len(result_files) == 6
        assert by_kind['extraction-complete'] == [{'rawReportCount': 42, 'attemptedObservationCount': 42,
                                                   'plannedObservationCount': 42, 'analysisPresent': True, 'unattemptedPlannedIds': []}]

        memory_details = []
        reconstructed_observations = []
        assert memory_plan['schedule'] == plan['memorySchedule']
        assert memory_plan['sourceHashes'] == identities['arms']
        for item in memory_plan['schedule']:
            name = 'memory/' + item['name']
            data = read(name + '/memory.json')
            markers = [json.loads(line) for line in z.read(name + '/markers.jsonl').decode().splitlines() if line]
            computed = reconstruct_memory(data, markers)
            memory_details.append({'name': item['name'], 'arm': item['arm'], 'pair': item['pair'],
                                   'rawMemorySha256': member_hashes[name + '/memory.json']['sha256'],
                                   'rawMarkersSha256': member_hashes[name + '/markers.jsonl']['sha256'], **computed})
            reconstructed_observations.append({**item, **{k: v for k, v in data.items() if k != 'samples'}})
        assert reconstructed_observations == read('memory/observations.json')
        comparison = read('memory/memory-comparison.json')
        assert comparison['observations'] == reconstructed_observations
        qualified = all(row['qualifiedForWholeTreePss'] for row in reconstructed_observations)
        assert comparison['everyObservationQualified'] == qualified
        metrics = {}
        for field in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
            changes = []
            for pair in comparison['pairs']:
                arms = {row['arm']: row for row in reconstructed_observations if row['pair'] == pair['pair']}
                pair_qualified = all(row['qualifiedForWholeTreePss'] for row in arms.values())
                assert pair['qualified'] == pair_qualified
                baseline, candidate = arms['A'][field], arms['B'][field]
                change = 100 * (candidate / baseline - 1) if pair_qualified and baseline > 0 else None
                assert pair[field] == {'baseline': baseline, 'candidate': candidate, 'changePercent': change}
                changes.append(change)
            metrics[field] = {'medianPairedChangePercent': statistics.median(changes) if qualified else None,
                              'maximumPairedChangePercent': max(changes) if qualified else None}
        assert comparison['metrics'] == metrics
        memory_pass = qualified and all(metric['medianPairedChangePercent'] <= 5 and metric['maximumPairedChangePercent'] <= 10 for metric in metrics.values())
        assert comparison['passesProspectiveMemoryScreen'] == memory_pass
        raw_memory_audit = {'schemaVersion': 1, 'observations': 4,
                            'rawScanCount': sum(row['allObservedSampleCount'] for row in reconstructed_observations),
                            'everyObservationQualified': qualified, 'passesProspectiveMemoryScreen': memory_pass, 'metrics': metrics}
        assert read('memory/memory-audit.json') == raw_memory_audit
        assert not read('memory/semantic-failures.json')
        assert read('analysis.json')['memoryPassed'] == memory_pass

    manifest_path = root / 'artifact-member-sha256.json'
    assert not manifest_path.exists()
    manifest_path.write_text(json.dumps(member_hashes, indent=2) + '\n')
    return {'schema': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope': 'Original ZIP bytes, all raw reports and process-memory scans; no new acquisition, timing or selected reruns',
            'auditIntegrityPassed': True, 'runId': 46113243549, 'dictionary': cohort['dictionary'], 'order': cohort['order'],
            'artifact': metadata['artifact'], 'zipSha256': observed_sha, 'zipBytes': archive.stat().st_size,
            'memberCount': len(member_hashes), 'memberManifestSha256': sha(manifest_path.read_bytes()),
            'primaryRecordsSha256': sha((root / 'primary-records.jsonl').read_bytes()),
            'frozenObserverSourceHashes': source_hashes, 'auditorSha256': sha(Path(__file__).read_bytes()),
            'all55PrimaryRecordsReconciled': True, 'rawReports': len(reports), 'rawFileHashBindings': 3 * len(reports),
            'allCanonicalReceiptsRecomputedWithUnchangedFrozenValidator': True,
            'completeCommonSemanticSha256': semantic_receipts[0]['commonSha256'],
            'releasePackages': package_checks, 'onlyChangedReleaseEntries': changed,
            'memoryOverlayExact': True, 'memory': {'rawAudit': raw_memory_audit, 'observations': memory_details},
            'rawMonotonicTimes': raw_times,
            'limits': ['This independently reconstructs retained sampled process-tree data under the frozen a7f7 policy; it is not an exact peak measurement.',
                       'No missing read is assigned zero; failed coverage gates remain failed and unqualified maxima remain null.',
                       'Primary paired statistics and all exclusions remain unchanged; this artifact audit makes no new performance decision.',
                       'The product source remains bound to9e10; no gain transfers to the later dcfc composition.']}


if __name__ == '__main__':
    directory = Path(sys.argv[1]).resolve()
    output = directory / 'independent-artifact-audit.json'
    assert not output.exists(), 'Never overwrite a completed artifact audit'
    try:
        result = audit(directory)
    except BaseException as error:
        failure = directory / ('artifact-audit-failure-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f') + '.json')
        failure.write_text(json.dumps({'auditorSha256': sha(Path(__file__).read_bytes()), 'type': type(error).__name__,
                                      'message': str(error), 'traceback': traceback.format_exc(),
                                      'noMeasurementsChanged': True}, indent=2) + '\n')
        raise
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'auditSha256': sha(output.read_bytes()), 'auditIntegrityPassed': result['auditIntegrityPassed'],
                      'reports': result['rawReports'], 'primaryRecords': 55, 'rawMemory': result['memory']['rawAudit'],
                      'perMemoryObservation': [{key: row[key] for key in ['name', 'qualifiedForWholeTreePss',
                       'qualificationFailures', 'allObservedSampleCount', 'maximumCoveredSampleGapMs']} for row in result['memory']['observations']]}, indent=2))
