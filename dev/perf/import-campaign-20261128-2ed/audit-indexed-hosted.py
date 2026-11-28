"""Recompute one frozen indexed-score-validation screen from its retained artifact ZIP.

Only compact evidence is copied to the destination. Packages and raw process
samples are audited directly from the ZIP or in a temporary directory.
"""
import hashlib
import io
import json
import math
import pathlib
import random
import re
import statistics
import subprocess
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '7e488d809ba18ce120f5766651bdfdf622561fab'
TREE = '4ecebc3a54f8ae865ae3f98943695fa9cbb8341d'
ROOT = pathlib.Path('/workspace/scratch/2ed731c9ad68/manabitan')
sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
from audit_memory import audit_cell
from qualification_receipts import validate_import_summary, require_matching_receipts
from protocol import memory_overlay, schedule as memory_schedule

archive_path = pathlib.Path(sys.argv[1])
dictionary = sys.argv[2]
expected_archive_sha = sys.argv[3].removeprefix('sha256:')
destination = pathlib.Path(sys.argv[4])
destination.mkdir(parents=True, exist_ok=False)
hash_ = hashlib.sha256()
with archive_path.open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        hash_.update(block)
assert hash_.hexdigest() == expected_archive_sha

selected = [
    'analysis.json', 'observations.json', 'registered-plan.json',
    'source-identities.json', 'browser-identity.json',
    'memory/plan.json', 'memory/memory-comparison.json',
    'memory/memory-audit.json', 'memory/memory-audit-failure.json',
    'memory/semantic-failures.json',
]
result = {'dictionary': dictionary, 'artifactSha256': expected_archive_sha,
          'complete': False, 'independentlyRecomputed': [], 'speedQualified': False}

def write_result():
    (destination / 'independent-audit.json').write_text(json.dumps(result, indent=2) + '\n')

def expected_timing_schedule():
    schedule = []
    for pair, order in enumerate(('AB', 'BA'), 1):
        for arm in order:
            schedule.append({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm})
    for pair in range(1, 7):
        for arm in ('AB' if pair % 2 else 'BA'):
            schedule.append({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm})
        if pair % 3 == 0:
            control = pair // 3
            for arm in ('AC' if control % 2 else 'CA'):
                schedule.append({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm})
    return schedule

def paired(observations, kind, numerator):
    values = {}
    for item in observations:
        if item['kind'] == kind:
            values.setdefault(item['pair'], {})[item['arm']] = item['totalImportMs']
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

try:
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.namelist()
        assert len(members) == len(set(members))
        manifest = [{'path': info.filename, 'bytes': info.file_size, 'crc32': info.CRC} for info in archive.infolist()]
        (destination / 'artifact-file-list.json').write_text(json.dumps(manifest, indent=2) + '\n')
        def read_json(name):
            return json.loads(archive.read(name))
        for name in selected:
            if name in members:
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))

        plan = read_json('registered-plan.json')
        assert plan['baseline'] == BASE and plan['candidate'] == CANDIDATE
        assert plan['dictionary'] == dictionary and plan['pairs'] == 6 and plan['initialOrder'] == 'AB'
        assert plan['flags'] == {}
        assert plan['schedule'] == expected_timing_schedule()
        assert plan['memorySchedule'] == memory_schedule(1)
        expected_entries = {'js/dictionary/term-record-opfs-store.js'}
        assert set(plan['expectedPackageEntries']) == expected_entries
        if dictionary == 'vndb':
            assert plan['vndbSahAllocationPolicy']['rangeUnits'] == [37, 37]
            assert plan['vndbSahAllocationPolicy']['origin'] == 'explicit'

        identities = read_json('source-identities.json')
        assert identities['arms']['A']['sha'] == BASE
        assert identities['arms']['A']['tree'] == 'd99ea4d04658f7ec1c76acdc5f3684594212a471'
        assert identities['arms']['B']['sha'] == CANDIDATE
        assert identities['arms']['B']['tree'] == TREE
        assert set(identities['changedPackageEntries']) == expected_entries
        packages = {}
        assert set(identities['arms']) == {'A', 'B'}
        for arm, identity in identities['arms'].items():
            for path, expected_hash in identity['sourceHashes'].items():
                if path.startswith('builds/'):
                    continue
                source_bytes = subprocess.check_output(['git', 'show', f'{BASE}:{path}'], cwd=ROOT)
                assert hashlib.sha256(source_bytes).hexdigest() == expected_hash, (arm, path)
        for arm, identity in identities['arms'].items():
            data = archive.read(f'package-{arm}.zip')
            assert hashlib.sha256(data).hexdigest() == identity['packageSha256']
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                assert len(package.namelist()) == len(set(package.namelist()))
                packages[arm] = {entry.filename: hashlib.sha256(package.read(entry)).hexdigest()
                                 for entry in package.infolist() if not entry.is_dir()}
                assert packages[arm] == identity['entries']
            result.setdefault('packageBytes', {})[arm] = len(data)
        assert packages['A'].keys() == packages['B'].keys()
        assert {name for name in packages['A'] if packages['A'][name] != packages['B'][name]} == expected_entries
        assert packages['A']['js/dictionary/term-record-opfs-store.js'] == '7325a63fa3d054a3c8b426c87880671ca57f5956dce842d9daef4acd4d617594'
        assert packages['B']['js/dictionary/term-record-opfs-store.js'] == '63942c3dc97eab215293bf04a138844d505605386bc61322b3f2f29e20d1d769'
        result['independentlyRecomputed'].append('complete-package-bytes-and-frozen-runtime-identity')

        observations = read_json('observations.json')
        assert [{key: item[key] for key in ('id', 'kind', 'pair', 'arm')} for item in observations] == plan['schedule']
        assert len(observations) == 20
        fixtures = json.loads((ROOT / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']
        browser = read_json('browser-identity.json')['version']
        reference = None
        receipt_count = 0
        all_media_reference = None
        items = [(item['id'], 'B' if item['arm'] == 'B' else 'A', 'sample', None, item['totalImportMs'])
                 for item in observations]
        items += [(f'exhaustive-media-{arm}', arm, 'all', None, None) for arm in 'AB']
        overlay = archive.read('memory/harness-instrumented.js')
        original_harness = archive.read('memory/harness-original.js')
        assert hashlib.sha256(original_harness).hexdigest() == identities['arms']['A']['sourceHashes']['test/chromium/extension-two-dictionary-import.e2e.js']
        assert overlay == memory_overlay(original_harness.decode()).encode()
        overlay_hash = hashlib.sha256(overlay).hexdigest()
        memory_plan = read_json('memory/plan.json')
        assert memory_plan['schedule'] == memory_schedule(1)
        assert memory_plan['replication'] == 1 and memory_plan['dictionary'] == dictionary
        assert memory_plan['overlaySha256'] == overlay_hash
        items += [(f"memory/{item['name']}", item['arm'], 'sample', overlay_hash, None)
                  for item in read_json('memory/plan.json')['schedule']]
        assert len(items) == 26
        assert {name for name in members if name.endswith('/summary.json')} == {f'{item[0]}/summary.json' for item in items}
        assert {name for name in members if re.search(r'/run-\d+\.json$', name)} == {f'{item[0]}/run-1.json' for item in items}
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
            receipt_count += 1
        assert receipt_count == 26
        result['verifiedSemanticObservations'] = receipt_count
        result['independentlyRecomputed'].append('all-26-source-bound-monotonic-timing-and-semantic-receipts')
        assert read_json('memory/semantic-failures.json') == []

        analysis = read_json('analysis.json')
        assert paired(observations, 'candidate', 'B') == analysis['candidateVsBaseline']
        assert paired(observations, 'control', 'C') == analysis['identicalCodeControl']
        result['candidateVsBaseline'] = analysis['candidateVsBaseline']
        result['identicalCodeControl'] = analysis['identicalCodeControl']
        result['independentlyRecomputed'].append('all-pairs-control-statistics-and-bootstrap')

        with tempfile.TemporaryDirectory(prefix='manabitan-2ed-indexed-audit-') as temp:
            temp = pathlib.Path(temp)
            needed = ['memory/plan.json', 'memory/observations.json', 'memory/memory-comparison.json']
            for item in read_json('memory/plan.json')['schedule']:
                needed += [f"memory/{item['name']}/memory.json", f"memory/{item['name']}/markers.jsonl"]
            for name in needed:
                target = temp / name.removeprefix('memory/')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
            recomputed = audit_cell(temp)
            assert recomputed == read_json('memory/memory-audit.json')
            result['memoryAudit'] = recomputed
            result['memoryFailures'] = [{'name': item['name'], 'qualificationFailures': item.get('qualificationFailures'),
                                         'maximumCoveredSampleGapMs': item.get('maximumCoveredSampleGapMs'),
                                         'preImportBracketGapMs': item.get('preImportBracketGapMs'),
                                         'postImportBracketGapMs': item.get('postImportBracketGapMs'),
                                         'qualified': item['qualifiedForWholeTreePss']}
                                        for item in read_json('memory/observations.json')]
        result['independentlyRecomputed'].append('every-original-memory-scan-and-marker')
        assert analysis['memoryPassed'] == recomputed['passesProspectiveMemoryScreen']
        result['screenStatus'] = analysis['status']
        result['memoryPassed'] = analysis['memoryPassed']
        result['complete'] = True
        write_result()
        print(json.dumps(result, indent=2))
except Exception as failure:
    result['auditFailure'] = {'type': type(failure).__name__, 'message': str(failure)}
    write_result()
    raise
