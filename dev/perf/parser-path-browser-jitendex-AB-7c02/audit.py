#!/usr/bin/env python3
"""Read-only independent audit of the frozen Jitendex AB browser artifact.

Imports only the existing pure receipt/protocol/memory audit helpers. Never
imports the acquisition runner or invokes a browser, native module or test.
All derived output is outside the retained artifact directory.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import sys
import traceback
import zipfile

sys.dont_write_bytecode = True
WORKSPACE = Path('/workspace/scratch/7c02210aa375')
RESEARCH = WORKSPACE / 'import-experiments-7c02'
REPO = WORKSPACE / 'manabitan'
ARTIFACT = Path('/tmp/manabitan-path-qualification-7c02/jitendex-AB-15256555705')
RESULT = ARTIFACT / 'result'
OUTPUT = RESEARCH / 'path-hosted-audits/jitendex-AB'
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'e90c4c04172b691985858609094887f9541541dd'
HEAD = 'd36ee85feb1513af31f769175affa33b3696a307'
ZIP_SHA = '82ab640cdc6aec23a033dc3960cfe7e26bb1cc778d22c5efa602eddd4f81ff46'
CHANGED = ['js/dictionary/term-bank-wasm-parser-worker.js', 'js/dictionary/term-bank-wasm-parser.js']


def read_json(path):
    return json.loads(Path(path).read_text())


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha_file(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def same(a, b, label):
    assert canonical(a) == canonical(b), label


def git_bytes(path):
    return subprocess.check_output(['git', 'show', f'{BASE}:{path}'], cwd=REPO)


def expected_schedule():
    rows = []
    for pair, order in enumerate(('AB', 'BA'), 1):
        for arm in order:
            rows.append({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm})
    for pair in range(1, 13):
        for arm in ('AB' if pair % 2 else 'BA'):
            rows.append({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm})
        if pair % 3 == 0:
            control = pair // 3
            for arm in ('AC' if control % 2 else 'CA'):
                rows.append({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm})
    return rows


def paired_summary(rows, kind, right):
    pairs = {}
    for row in rows:
        if row['kind'] == kind:
            arms = pairs.setdefault(row['pair'], {})
            assert row['arm'] not in arms, 'duplicate paired arm'
            arms[row['arm']] = row['totalImportMs']
    assert list(pairs) == list(range(1, (12 if kind == 'candidate' else 4) + 1))
    assert all(set(x) == {'A', right} for x in pairs.values())
    values = list(pairs.values())
    ratios = [x[right] / x['A'] for x in values]
    rng = random.Random(897)
    boot = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        'count': len(values), 'ratios': ratios,
        'medianPairedChangePercent': 100 * (statistics.median(ratios) - 1),
        'equalWorkChangePercent': 100 * (sum(x[right] for x in values) / sum(x['A'] for x in values) - 1),
        'worstPairChangePercent': 100 * (max(ratios) - 1),
        'descriptiveBootstrap95Percent': [100 * (boot[i] - 1) for i in (249, 9749)],
        'fasterPairs': sum(x < 1 for x in ratios),
    }


def audit(report):
    prep = read_json(RESEARCH / 'path-publication-review/browser-result-audit-preparation.json')
    helper_checks = []
    for item in prep['files']:
        path = WORKSPACE / item['path']
        assert path.stat().st_size == item['size'] and sha_file(path) == item['sha256'], item['path']
        helper_checks.append({'path': item['path'], 'sha256': item['sha256']})
    checklist = WORKSPACE / prep['checklist']['path']
    assert sha_file(checklist) == prep['checklist']['sha256']
    report['frozenAuditSources'] = helper_checks
    report['checklistSha256'] = sha_file(checklist)
    sys.path.insert(0, str(REPO / 'dev/perf/import-memory-20261125-a7f7'))
    from qualification_receipts import validate_import_summary, require_matching_receipts
    from protocol import schedule as memory_schedule, memory_overlay, memory_comparison
    from audit_memory import audit_cell

    metadata_path = RESEARCH / 'path-hosted/artifact-15256555705-metadata.json'
    preservation_path = RESEARCH / 'path-hosted/artifact-15256555705-preservation.json'
    metadata, preservation = read_json(metadata_path), read_json(preservation_path)
    assert metadata['id'] == 15256555705 and metadata['name'] == 'parser-path-qualification-7c02-jitendex-AB'
    assert metadata['workflow_run']['id'] == 46113567719 and metadata['workflow_run']['head_sha'] == HEAD
    assert metadata['digest'] == 'sha256:' + ZIP_SHA
    assert preservation['artifactId'] == 15256555705 and preservation['jobId'] == 140904689410
    assert preservation['runId'] == 46113567719 and preservation['crcPassed'] is True
    archive = Path(preservation['zipPath'])
    assert archive.stat().st_size == metadata['size_in_bytes'] == preservation['zipBytes'] == 35590927
    assert sha_file(archive) == preservation['zipSha256'] == ZIP_SHA
    assert Path(preservation['extractionPath']) == ARTIFACT
    member_map = {x['name']: x for x in preservation['members']}
    assert len(member_map) == len(preservation['members']) == 317
    assert {str(p.relative_to(ARTIFACT)) for p in ARTIFACT.rglob('*') if p.is_file()} == set(member_map)
    with zipfile.ZipFile(archive) as zipped:
        actual = [x for x in zipped.infolist() if not x.is_dir()]
        assert len({x.filename for x in actual}) == len(actual) == 317
        assert {x.filename for x in actual} == set(member_map)
        for entry in actual:
            expected = member_map[entry.filename]
            data = zipped.read(entry)  # also checks the original ZIP CRC
            assert len(data) == expected['bytes'] == entry.file_size
            assert sha_bytes(data) == expected['sha256'] == sha_file(ARTIFACT / entry.filename)
    artifact_manifest = [{'path': n, 'bytes': x['bytes'], 'sha256': x['sha256']} for n, x in sorted(member_map.items())]
    report['artifact'] = {'id': metadata['id'], 'runId': 46113567719, 'jobId': 140904689410,
                          'researchCommit': HEAD, 'zipBytes': archive.stat().st_size, 'zipSha256': ZIP_SHA,
                          'metadataSha256': sha_file(metadata_path), 'preservationSha256': sha_file(preservation_path),
                          'members': 317, 'expandedBytes': sum(x['bytes'] for x in member_map.values()),
                          'allOriginalZipCrcAndMemberHashesMatched': True,
                          'memberManifestSha256': sha_bytes(canonical(artifact_manifest).encode())}

    plan, identities, browser = (read_json(RESULT / n) for n in ('registered-plan.json', 'source-identities.json', 'browser-identity.json'))
    arms = identities['arms']
    assert set(arms) == {'A', 'B'}
    assert arms['A']['sha'] == BASE and arms['A']['tree'] == 'd99ea4d04658f7ec1c76acdc5f3684594212a471'
    assert arms['B']['sha'] == CANDIDATE and arms['B']['tree'] == '586061b2dfb33d9ebd3fc12a340f4def5a09abea'
    assert sorted(identities['changedPackageEntries']) == CHANGED
    assert identities['controlC'] == 'Same A source, package, runtime, and flags under a distinct observation label'
    fixture_lock = git_bytes('test/perf/dictionaries.lock.json')
    fixture = json.loads(fixture_lock)['dictionaries']['jitendex']
    assert fixture['termRows'] == 436555 and fixture['mediaFiles'] == 236 and fixture['mediaBytes'] == 4992155
    assert fixture['sha256'] == 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356'
    entry_maps = {}
    packages = {}
    for arm, identity in arms.items():
        package = RESULT / f'package-{arm}.zip'
        assert sha_file(package) == identity['packageSha256']
        with zipfile.ZipFile(package) as zipped:
            members = zipped.infolist()
            assert len({x.filename for x in members}) == len(members)
            entries = {x.filename: sha_bytes(zipped.read(x)) for x in members if not x.is_dir()}
        same(entries, identity['entries'], f'{arm} complete package entry hashes')
        assert len(entries) == 554
        assert entries['lib/term-bank-parser.wasm'] == '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'
        assert entries['lib/zstd.wasm'] == 'ad3a18c197d72167262d01fd202976325f57a6697bca627f4527c96d4dbbcfcc'
        assert identity['lockSha256'] == sha_bytes(git_bytes('package-lock.json'))
        assert identity['fixtureLockSha256'] == sha_bytes(fixture_lock)
        for name, expected in identity['sourceHashes'].items():
            if name == 'builds/manabitan-chrome.zip':
                assert expected == identity['packageSha256']
            elif name == 'builds/manabitan-chrome-dev.zip':
                assert expected is None
            else:
                assert sha_bytes(git_bytes(name)) == expected, (arm, name)
        entry_maps[arm] = entries
        packages[arm] = {k: identity[k] for k in ('sha', 'tree', 'packageSha256', 'lockSha256', 'fixtureLockSha256')}
        packages[arm]['entryCount'] = len(entries)
    assert entry_maps['A'].keys() == entry_maps['B'].keys()
    assert sorted(k for k in entry_maps['A'] if entry_maps['A'][k] != entry_maps['B'][k]) == CHANGED
    assert entry_maps['B'][CHANGED[0]] == 'b368f85dc737f4cd2567fa1723e69f3276f6f8c0441085af3b94ac80ed2a0057'
    assert entry_maps['B'][CHANGED[1]] == '69f6f44bb25b1ade2e77ad51a5c830ac359ec3d44f364a3c0ed6131728f54518'
    assert browser['version'] == '153.0.8010.12'
    assert browser['sha256'] == '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e'
    assert '/chromium-1243/' in browser['executable']
    assert browser['versionOutput'] == 'Google Chrome for Testing 153.0.8010.12'
    report['identities'] = {'baseline': BASE, 'candidate': CANDIDATE, 'packages': packages,
                            'changedPackageEntries': CHANGED, 'browser': browser, 'fixture': fixture,
                            'fullPackageHashesAndMapsRecomputed': True,
                            'frozenGitSourceHashesIndependentlyMatched': True,
                            'browserBinaryDigestIsOriginalCapturedIdentityNotARehashOfAnIncludedBinary': True}

    scheduled = expected_schedule()
    for key, expected in {'baseline': BASE, 'candidate': CANDIDATE, 'dictionary': 'jitendex',
                          'initialOrder': 'AB', 'pairs': 12, 'flags': {}, 'expectedWorkers': 3,
                          'vndbSahAllocationPolicy': None, 'schedule': scheduled,
                          'memorySchedule': memory_schedule(1)}.items():
        same(plan[key], expected, 'registered plan ' + key)
    assert sorted(plan['expectedPackageEntries']) == CHANGED
    observations = read_json(RESULT / 'observations.json')
    same([{k: x[k] for k in ('id', 'kind', 'pair', 'arm')} for x in observations], scheduled, 'complete ordered ordinary schedule')
    assert all(set(x) == {'id', 'kind', 'pair', 'arm', 'totalImportMs'} for x in observations)
    assert all(type(x['totalImportMs']) in (int, float) and math.isfinite(x['totalImportMs']) and x['totalImportMs'] > 0 for x in observations)
    assert len({x['id'] for x in observations}) == 36
    assert sorted(p.name for p in RESULT.iterdir() if p.is_dir()) == sorted([x['id'] for x in scheduled] + ['exhaustive-media-A', 'exhaustive-media-B', 'memory'])

    imports = []
    reference = None

    def validate_import(location, arm, kind, media='sample', overlay=None):
        nonlocal reference
        summary, raw = read_json(location / 'summary.json'), read_json(location / 'run-1.json')
        identity = arms['B' if arm == 'B' else 'A']
        hashes = dict(identity['sourceHashes'])
        if overlay is not None:
            hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = sha_bytes(overlay.encode())
        receipt = validate_import_summary(summary, raw, dictionary='jitendex', fixture=fixture,
            source_sha=identity['sha'], package_sha256=identity['packageSha256'],
            browser_version=browser['version'], import_flags=None, source_hashes=hashes,
            source_dirty=overlay is not None, media_check=media)
        same(receipt, read_json(location / 'canonical-receipt.json'), str(location.name) + ' canonical receipt')
        assert summary['runs'][0]['step4Breakdown']['dictionaries'][0]['parserWorkerCount'] == 3
        if reference is None:
            reference = receipt
        else:
            require_matching_receipts(reference, receipt, compare_media=media == 'sample')
        assert raw['failureReason'] == '' and raw['skipReason'] == ''
        assert len(raw['phases']) == raw['phaseCount']
        assert f'[perf-import] Jitendex run 1/1' in (location / 'run.log').read_text()
        imports.append({'path': str(location.relative_to(RESULT)), 'kind': kind, 'arm': arm,
            'startedAtIso': raw['startedAtIso'], 'totalImportMs': summary['runs'][0]['totalImportMs'],
            'sourceDirty': summary['source']['dirty'], 'nodeVersion': summary['hostEnvironment']['nodeVersion'],
            'browserVersion': summary['browserVersion'], 'canonicalSha256': sha_bytes(canonical(receipt).encode()),
            'outputDigestSha256': receipt['common']['validation']['outputDigestSha256'],
            'lookupObservations': len(receipt['common']['validation']['lookup']['observations']),
            'storageBytes': receipt['common']['validation']['storage']['bytes'], 'media': receipt['media']})
        return summary, receipt

    for observation in observations:
        location = RESULT / observation['id']
        summary, _ = validate_import(location, observation['arm'], observation['kind'])
        same(summary['runs'][0]['totalImportMs'], observation['totalImportMs'], observation['id'] + ' timing')
        for name in ('host-before.json', 'host-after.json'):
            host = read_json(location / name)
            assert host['nodeVersion'] == 'v22.22.0' and host['platform'] == 'linux' and host['arch'] == 'x64'
    media_reference = None
    for arm in 'AB':
        _, receipt = validate_import(RESULT / f'exhaustive-media-{arm}', arm, 'exhaustive-media', 'all')
        if media_reference is not None:
            require_matching_receipts(media_reference, receipt)
        media_reference = receipt

    memory_root = RESULT / 'memory'
    mp = read_json(memory_root / 'plan.json')
    same(mp['schedule'], memory_schedule(1), 'memory schedule')
    same(mp['sourceHashes'], arms, 'memory source and complete package identities')
    assert mp['replication'] == 1 and mp['dictionary'] == 'jitendex' and mp['authoritativeTiming'] is False
    original = (memory_root / 'harness-original.js').read_text()
    overlay = (memory_root / 'harness-instrumented.js').read_text()
    assert original.encode() == git_bytes('test/chromium/extension-two-dictionary-import.e2e.js')
    assert memory_overlay(original) == overlay and sha_bytes(overlay.encode()) == mp['overlaySha256']
    assert 'await mkdtemp(path.join(os.tmpdir(), profilePrefix))' in original
    assert read_json(memory_root / 'semantic-failures.json') == []
    for forbidden in ('sampling-failure.json', 'memory-incomplete.json', 'memory-audit-failure.json'):
        assert not list(memory_root.rglob(forbidden)), forbidden
    coverage = []
    for item in memory_schedule(1):
        location = memory_root / item['name']
        validate_import(location, item['arm'], 'memory', overlay=overlay)
        memory = read_json(location / 'memory.json')
        assert memory['schemaVersion'] == 3 and memory['observerRule'] == 'import-window-stable-single-thread-zombie-esrch-v1'
        assert memory['benchmarkExitCode'] == 0 and memory['authoritativeTiming'] is False
        assert memory['qualifiedForWholeTreePss'] is True and memory['qualificationFailures'] == []
        assert memory['stableFullyReadImportSampleCount'] >= 5
        assert 0 <= memory['preImportBracketGapMs'] <= 250 and 0 <= memory['postImportBracketGapMs'] <= 250
        assert 0 <= memory['maximumCoveredSampleGapMs'] <= 250
        coverage.append({**item, **{k: memory[k] for k in (
            'allObservedSampleCount', 'fullyContainedImportSampleCount', 'stableFullyReadImportSampleCount',
            'preImportBracketGapMs', 'postImportBracketGapMs', 'maximumCoveredSampleGapMs',
            'maxSampledPssKiB', 'maxSampledPrivateKiB', 'qualifiedForWholeTreePss')}})
    independent_memory = audit_cell(memory_root)
    same(independent_memory, read_json(memory_root / 'memory-audit.json'), 'recomputed raw scan and coverage audit')
    mem_obs = read_json(memory_root / 'observations.json')
    same([{k: x[k] for k in ('index', 'name', 'arm', 'pair')} for x in mem_obs], memory_schedule(1), 'all four original memory identities')
    memory_result = memory_comparison(mem_obs, 'jitendex', 1, memory_schedule)
    same(memory_result, read_json(memory_root / 'memory-comparison.json'), 'independent memory comparison')
    assert independent_memory['everyObservationQualified'] is True
    report['memory'] = {'recomputedAudit': independent_memory, 'coverage': coverage,
                        'pairedMetrics': memory_result['metrics'], 'pairs': memory_result['pairs'],
                        'overlaySha256': mp['overlaySha256'], 'exactOverlayAndOriginalHarnessMatched': True,
                        'instrumentedDurationsExcludedFromOrdinaryStatistics': True}
    assert len(imports) == 42
    times = [datetime.fromisoformat(x['startedAtIso'].replace('Z', '+00:00')) for x in imports]
    assert times == sorted(times), 'original ordinary, exhaustive and memory acquisition order'
    assert len({x['outputDigestSha256'] for x in imports}) == 1
    assert len({x['storageBytes'] for x in imports}) == 1
    report['correctness'] = {'ordinaryImports': 36, 'excludedWarmups': 4, 'candidatePairs': 12, 'controlPairs': 4,
                             'exhaustiveMediaImports': 2, 'separateMemoryImports': 4, 'totalImports': 42,
                             'allExactOrderedScheduleFieldsMatched': True, 'allSummaryRawCanonicalBindingsPassed': True,
                             'allSourcePackageBrowserAndNodeBindingsPassed': True, 'allWorkersEqualThree': True,
                             'allSemanticRestartLookupAndStorageReceiptsMatched': True,
                             'freshProfilePolicyBoundToUnchangedMkdtempHarness': True,
                             'lookupObservationsPerImport': 72, 'termRowsPerImport': fixture['termRows'],
                             'uniqueMediaFiles': 236, 'mediaBytes': 4992155,
                             'outputDigestSha256': imports[0]['outputDigestSha256'],
                             'storageBytes': imports[0]['storageBytes'], 'imports': imports}

    analysis, cell = read_json(RESULT / 'analysis.json'), read_json(ARTIFACT / 'cell-summary.json')
    candidate = paired_summary(observations, 'candidate', 'B')
    control = paired_summary(observations, 'control', 'C')
    same(candidate, analysis['candidateVsBaseline'], 'all independent candidate statistics including bootstrap')
    same(control, analysis['identicalCodeControl'], 'all independent control statistics including bootstrap')
    same(cell['analysis'], analysis, 'cell analysis exact binding')
    same(cell['ordinaryObservations'], observations, 'cell complete ordinary observations exact binding')
    assert cell['dictionary'] == 'jitendex' and cell['initialOrder'] == 'AB'
    b_values = [x['totalImportMs'] for x in observations if x['kind'] == 'candidate' and x['arm'] == 'B']
    c_values = [x['totalImportMs'] for x in observations if x['kind'] == 'control' and x['arm'] == 'C']
    b_vs_c = 100 * (statistics.median(b_values) / statistics.median(c_values) - 1)
    same(b_vs_c, cell['candidateMedianVsControlCPercent'], 'independent B median versus C')
    memory_passed = independent_memory['passesProspectiveMemoryScreen']
    assert analysis['memoryPassed'] is memory_passed
    assert analysis['status'] == ('correctness-memory-passed' if memory_passed else 'memory-or-semantics-failed')
    controls_passed = control['count'] == 4 and abs(control['medianPairedChangePercent']) <= 5
    nonregression = memory_passed and controls_passed and candidate['medianPairedChangePercent'] <= 3 and candidate['equalWorkChangePercent'] <= 3 and candidate['descriptiveBootstrap95Percent'][1] <= 5
    strong_gain = memory_passed and controls_passed and candidate['medianPairedChangePercent'] <= -5 and b_vs_c <= -5 and candidate['fasterPairs'] >= 10 and candidate['equalWorkChangePercent'] < 0 and candidate['descriptiveBootstrap95Percent'][1] < 0
    gates = {'correctnessAndMemory': memory_passed, 'completeSchedule': True,
             'unchangedControls': controls_passed, 'nonRegression': nonregression, 'wholeImportGain': strong_gain}
    same(gates, cell['gates'], 'all independently recomputed saved gates')
    assert cell['complete'] is True
    report['statistics'] = {'candidateVsBaseline': candidate, 'identicalCodeControl': control,
                             'candidateMedianVsControlCPercent': b_vs_c,
                             'allSavedValuesRecomputedExactly': True,
                             'descriptiveBootstrap': {'seedPerComparison': 897, 'completePairResamples': 10000, 'indexes': [249, 9749]}}
    report['gates'] = gates
    report['mandatoryHostEligibility'] = all(gates[x] for x in ('correctnessAndMemory', 'completeSchedule', 'unchangedControls', 'nonRegression'))
    report['decision'] = 'Jitendex AB passes this host mandatory correctness, memory, control and nonregression screens; no whole-import gain established. This is not campaign or PR qualification.' if report['mandatoryHostEligibility'] else 'Jitendex AB fails mandatory publication eligibility; no filtering, replacement or rerun is authorized.'
    # Rehash every extracted original after all pure helpers finish.
    for name, item in member_map.items():
        path = ARTIFACT / name
        assert path.stat().st_size == item['bytes'] and sha_file(path) == item['sha256'], 'artifact changed during audit: ' + name
    assert sha_file(archive) == ZIP_SHA
    report['originalsUnmodifiedAfterAudit'] = True
    report['auditStatus'] = 'passed'


if __name__ == '__main__':
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / 'independent-audit.json'
    assert not target.exists(), 'retain an existing audit instead of silently replacing it'
    report = {'schemaVersion': 1, 'createdAtUtc': datetime.now(timezone.utc).isoformat(),
              'auditStatus': 'started', 'dictionary': 'jitendex', 'initialOrder': 'AB',
              'scope': 'Independent saved-data audit only. No benchmark, browser, test or native execution.',
              'auditorScriptSha256': sha_file(__file__), 'artifactRoot': str(ARTIFACT),
              'publicationBoundary': 'Workflow success is not publication eligibility. All six independent hosts are required; no pooling or control adjustment.'}
    try:
        audit(report)
    except Exception as error:
        report['auditStatus'] = 'failed'
        report['error'] = {'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()}
        raise
    finally:
        target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: report[k] for k in ('auditStatus', 'mandatoryHostEligibility', 'gates', 'statistics', 'decision', 'originalsUnmodifiedAfterAudit')}, indent=2))
