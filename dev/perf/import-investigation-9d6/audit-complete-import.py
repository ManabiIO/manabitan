"""Audit downloaded complete-import evidence without running a benchmark."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import statistics
import subprocess
import sys
import zipfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('evidence', type=Path)
parser.add_argument('--repository', type=Path, required=True)
parser.add_argument('--candidate', required=True)
parser.add_argument('--dictionary', choices=['jmdict', 'jitendex', 'vndb'], required=True)
parser.add_argument('--order', choices=['AB', 'BA'], required=True)
parser.add_argument('--package-entry', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.evidence.resolve()
repo = args.repository.resolve()
baseline = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
sys.path.insert(0, str(repo / 'dev/perf/import-memory-20261125-a7f7'))


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def tree(commit):
    return subprocess.check_output(
        ['git', '-C', str(repo), 'rev-parse', commit + '^{tree}'], text=True
    ).strip()


def git_sha256(commit, filename):
    data = subprocess.check_output(['git', '-C', str(repo), 'show', commit + ':' + filename])
    return hashlib.sha256(data).hexdigest()


bound_helpers = {}
for helper in ['audit_memory.py', 'qualification_receipts.py', 'protocol.py', 'chromium_memory.py']:
    filename = 'dev/perf/import-memory-20261125-a7f7/' + helper
    bound_helpers[helper] = sha(repo / filename)
    assert bound_helpers[helper] == git_sha256(baseline, filename), filename
from audit_memory import audit_cell
from qualification_receipts import validate_import_summary, require_matching_receipts
from protocol import memory_overlay, schedule as memory_schedule


def schedule(order):
    result = []
    for pair, arms in [(1, order), (2, order[::-1])]:
        for arm in arms:
            result.append(dict(id=f'warmup-{pair}-{arm}', kind='warmup', pair=pair, arm=arm))
    for pair in range(1, 13):
        for arm in order if pair % 2 else order[::-1]:
            result.append(dict(id=f'pair-{pair:02}-{arm}', kind='candidate', pair=pair, arm=arm))
        if pair % 3 == 0:
            control = pair // 3
            first = 'AC' if order == 'AB' else 'CA'
            for arm in first if control % 2 else first[::-1]:
                result.append(dict(id=f'control-{control:02}-{arm}', kind='control', pair=control, arm=arm))
    return result


def statistics_for(rows, kind, right):
    selected = [row for row in rows if row['kind'] == kind]
    pairs = []
    for number in sorted({row['pair'] for row in selected}):
        values = [row for row in selected if row['pair'] == number]
        assert len(values) == 2 and {row['arm'] for row in values} == {'A', right}
        a = next(row['totalImportMs'] for row in values if row['arm'] == 'A')
        b = next(row['totalImportMs'] for row in values if row['arm'] == right)
        pairs.append({'pair': number, 'order': ''.join(row['arm'] for row in values),
                      'baselineMs': a, 'comparisonMs': b, 'savedMs': a - b, 'ratio': b / a})
    ratios = [pair['ratio'] for pair in pairs]
    rng = random.Random(897)
    bootstrap = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    recorded = {
        'count': len(pairs), 'ratios': ratios,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(p['comparisonMs'] for p in pairs) / sum(p['baselineMs'] for p in pairs) - 1) * 100,
        'worstPairChangePercent': (max(ratios) - 1) * 100,
        'descriptiveBootstrap95Percent': [(bootstrap[i] - 1) * 100 for i in (249, 9749)],
        'fasterPairs': sum(ratio < 1 for ratio in ratios),
    }
    detail = {
        'baselineMedianMs': statistics.median(p['baselineMs'] for p in pairs),
        'comparisonMedianMs': statistics.median(p['comparisonMs'] for p in pairs),
        'medianSavedMs': statistics.median(p['savedMs'] for p in pairs),
        'pairs': pairs,
    }
    return recorded, detail


plan = read(root / 'registered-plan.json')
assert plan['baseline'] == baseline and plan['candidate'] == args.candidate
assert plan['dictionary'] == args.dictionary and plan['initialOrder'] == args.order
assert plan['pairs'] == 12 and plan['flags'] == {}
expected_schedule = schedule(args.order)
assert len(expected_schedule) == 36 and plan['schedule'] == expected_schedule
assert plan['expectedPackageEntries'] == [args.package_entry]
assert plan['expectedWorkers'] is None
replication = 1 if args.order == 'AB' else 2
assert plan['memorySchedule'] == memory_schedule(replication)
assert plan['vndbSahAllocationPolicy'] == (
    {'unitBytes': 4096, 'rangeUnits': [37, 37], 'origin': 'explicit'}
    if args.dictionary == 'vndb' else None
)
identities = read(root / 'source-identities.json')
assert identities['changedPackageEntries'] == [args.package_entry]
for arm, commit in [('A', baseline), ('B', args.candidate)]:
    identity = identities['arms'][arm]
    assert identity['sha'] == commit and identity['tree'] == tree(commit)
    archive = root / f'package-{arm}.zip'
    assert sha(archive) == identity['packageSha256']
    with zipfile.ZipFile(archive) as package:
        names = [item.filename for item in package.infolist()]
        assert len(names) == len(set(names))
        entries = {item.filename: hashlib.sha256(package.read(item)).hexdigest()
                   for item in package.infolist() if not item.is_dir()}
    assert entries == identity['entries']
    product_source = {
        'lib/zstd.wasm': 'dev/data/zstd-simd.wasm',
        'js/dictionary/dictionary-database.js': 'ext/js/dictionary/dictionary-database.js',
    }[args.package_entry]
    assert entries[args.package_entry] == git_sha256(commit, product_source)
    assert identity['fixtureLockSha256'] == '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89'
    assert identity['lockSha256'] == git_sha256(commit, 'package-lock.json')
    for filename, digest in identity['sourceHashes'].items():
        if not filename.startswith('builds/'):
            assert digest == git_sha256(commit, filename), (arm, filename)
    assert identity['sourceHashes']['builds/manabitan-chrome.zip'] == identity['packageSha256']
assert identities['arms']['A']['entries'].keys() == identities['arms']['B']['entries'].keys()
changed = [name for name, digest in identities['arms']['A']['entries'].items()
           if digest != identities['arms']['B']['entries'][name]]
assert changed == [args.package_entry]

browser = read(root / 'browser-identity.json')
assert browser['version'] == '153.0.8010.12'
assert sha(repo / 'test/perf/dictionaries.lock.json') == '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89'
fixture = read(repo / 'test/perf/dictionaries.lock.json')['dictionaries'][args.dictionary]
allocation = [37, 37] if args.dictionary == 'vndb' else None
reference = None
validated = []


def validate(directory, arm, media='sample', overlay=None):
    global reference
    identity = identities['arms'][arm]
    source_hashes = identity['sourceHashes'].copy()
    if overlay is not None:
        source_hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = sha(overlay)
    summary = read(directory / 'summary.json')
    receipt = validate_import_summary(
        summary, read(directory / 'run-1.json'), dictionary=args.dictionary, fixture=fixture,
        source_sha=identity['sha'], package_sha256=identity['packageSha256'],
        browser_version=browser['version'], import_flags=None, source_hashes=source_hashes,
        source_dirty=overlay is not None, media_check=media,
        vndb_sah_allocation_units=allocation,
    )
    assert receipt == read(directory / 'canonical-receipt.json')
    if reference is None:
        reference = receipt
    else:
        require_matching_receipts(reference, receipt, compare_media=media == 'sample')
    validated.append(directory.relative_to(root).as_posix())
    return summary, receipt


observations = read(root / 'observations.json')
assert [{k: row[k] for k in ['id', 'kind', 'pair', 'arm']} for row in observations] == expected_schedule
for observation in observations:
    directory = root / observation['id']
    summary, _ = validate(directory, 'B' if observation['arm'] == 'B' else 'A')
    assert summary['runs'][0]['totalImportMs'] == observation['totalImportMs']
    assert (directory / 'host-before.json').is_file() and (directory / 'host-after.json').is_file()
media_receipts = [validate(root / f'exhaustive-media-{arm}', arm, 'all')[1] for arm in args.order]
require_matching_receipts(*media_receipts)
memory_root = root / 'memory'
memory_plan = read(memory_root / 'plan.json')
assert memory_plan['authoritativeTiming'] is False
assert memory_plan['dictionary'] == args.dictionary
assert memory_plan['sourceHashes'] == identities['arms']
assert memory_plan['replication'] == replication
assert memory_plan['schedule'] == memory_schedule(replication)
overlay = memory_root / 'harness-instrumented.js'
assert memory_plan['overlaySha256'] == sha(overlay)
assert sha(memory_root / 'harness-original.js') == git_sha256(baseline, 'test/chromium/extension-two-dictionary-import.e2e.js')
assert overlay.read_text() == memory_overlay((memory_root / 'harness-original.js').read_text())
for observation in memory_plan['schedule']:
    validate(memory_root / observation['name'], observation['arm'], overlay=overlay)
assert read(memory_root / 'semantic-failures.json') == []
memory = audit_cell(memory_root)
analysis = read(root / 'analysis.json')
candidate, candidate_detail = statistics_for(observations, 'candidate', 'B')
control, control_detail = statistics_for(observations, 'control', 'C')
assert candidate == analysis['candidateVsBaseline']
assert control == analysis['identicalCodeControl']
assert analysis['memoryPassed'] == memory['passesProspectiveMemoryScreen']
assert len(validated) == 42
result = {
    'complete': True, 'auditedAt': datetime.now(timezone.utc).isoformat(),
    'auditorSha256': sha(Path(__file__)), 'evidence': str(root),
    'boundBaselineHelpers': bound_helpers,
    'baseline': baseline, 'candidate': args.candidate, 'dictionary': args.dictionary,
    'order': args.order, 'observationsValidated': len(validated),
    'sourcePackagePlanAndReceiptChecks': 'passed',
    'candidateVsBaseline': candidate, 'candidateDetail': candidate_detail,
    'identicalCodeControl': control, 'controlDetail': control_detail,
    'memory': memory, 'reportedStatus': analysis['status'],
    'scope': 'Artifact and measurement audit only. No benchmark is executed and no speed-promotion verdict is implied.',
}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['complete', 'dictionary', 'order', 'observationsValidated',
                                             'candidateVsBaseline', 'identicalCodeControl', 'memory']}, indent=2))
