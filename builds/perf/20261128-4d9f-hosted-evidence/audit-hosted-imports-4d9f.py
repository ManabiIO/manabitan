#!/usr/bin/env python3
"""Reconcile frozen import observations and memory scans; never reacquire data."""
import argparse
import hashlib
import io
import json
import pathlib
import random
import statistics
import sys
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-root', type=pathlib.Path, required=True)
parser.add_argument('--artifacts', type=pathlib.Path, required=True)
parser.add_argument('--artifact-manifest', type=pathlib.Path, required=True)
parser.add_argument('--baseline', required=True)
parser.add_argument('--candidate', required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
if not __debug__:
    raise SystemExit('Python optimized mode disables audit assertions')
args.output.mkdir(parents=True, exist_ok=False)
sys.path.insert(0, str(args.source_root / 'dev/perf/import-memory-20261125-a7f7'))
from audit_memory import audit_cell
from protocol import memory_overlay, schedule as memory_schedule
from qualification_receipts import validate_import_summary, require_matching_receipts

sha = lambda data: hashlib.sha256(data).hexdigest()
fixture_lock = json.loads((args.source_root / 'test/perf/dictionaries.lock.json').read_text())
manifest = json.loads(args.artifact_manifest.read_text())
all_results = []

def read_json(root, name):
    return json.loads((root / name).read_text())

def paired(rows, kind, left, right):
    by_pair = {}
    for row in rows:
        if row['kind'] == kind:
            assert row['arm'] not in by_pair.setdefault(row['pair'], {})
            by_pair[row['pair']][row['arm']] = row['totalImportMs']
    pairs = [by_pair[key] for key in sorted(by_pair)]
    assert all(set(p) == {left, right} for p in pairs)
    ratios = [p[right] / p[left] for p in pairs]
    randomizer = random.Random(897)
    medians = sorted(statistics.median(randomizer.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        'count': len(pairs), 'ratios': ratios,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(p[right] for p in pairs) / sum(p[left] for p in pairs) - 1) * 100,
        'worstPairChangePercent': (max(ratios) - 1) * 100,
        'descriptiveBootstrap95Percent': [(medians[i] - 1) * 100 for i in (249, 9749)],
        'fasterPairs': sum(value < 1 for value in ratios),
    }

for artifact in manifest:
    path = args.artifacts / (artifact['name'] + '.zip')
    raw = path.read_bytes()
    assert sha(raw) == artifact['digest'].removeprefix('sha256:')
    out = args.output / artifact['name']
    out.mkdir()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names))
        member_receipts = []
        for member in archive.infolist():
            if member.is_dir():
                continue
            value = archive.read(member)
            member_receipts.append({'name': member.filename, 'bytes': len(value), 'sha256': sha(value)})
            if member.filename not in ('package-A.zip', 'package-B.zip'):
                target = out / member.filename
                assert target.resolve().is_relative_to(out.resolve())
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
        identities = read_json(out, 'source-identities.json')
        for arm in ('A', 'B'):
            value = archive.read('package-' + arm + '.zip')
            identity = identities['arms'][arm]
            assert sha(value) == identity['packageSha256']
            with zipfile.ZipFile(io.BytesIO(value)) as package:
                members = [m.filename for m in package.infolist() if not m.is_dir()]
                assert len(members) == len(set(members))
                entries = {name: sha(package.read(name)) for name in members}
                assert entries == identity['entries']
    plan = read_json(out, 'registered-plan.json')
    dictionary = plan['dictionary']
    fixture = fixture_lock['dictionaries'][dictionary]
    assert plan['baseline'] == args.baseline and plan['candidate'] == args.candidate
    assert plan['pairs'] == 12 and plan['flags'] == {}
    for arm, source in [('A', args.baseline), ('B', args.candidate)]:
        identity = identities['arms'][arm]
        assert identity['sha'] == source
        assert identity['fixtureLockSha256'] == sha((args.source_root / 'test/perf/dictionaries.lock.json').read_bytes())
        assert identity['lockSha256'] == sha((args.source_root / 'package-lock.json').read_bytes())
    a_entries, b_entries = (identities['arms'][arm]['entries'] for arm in ('A', 'B'))
    assert set(a_entries) == set(b_entries)
    actual_changed = sorted(name for name in a_entries if a_entries[name] != b_entries[name])
    assert actual_changed == sorted(plan['expectedPackageEntries']) == sorted(identities['changedPackageEntries'])
    browser = read_json(out, 'browser-identity.json')['version']
    observations = read_json(out, 'observations.json')
    assert len(observations) == len(plan['schedule']) == 36
    assert [{k: row[k] for k in ('id', 'arm', 'kind', 'pair')} for row in observations] == plan['schedule']
    reference = None
    semantic_checks = 0

    def validate(location, arm, *, media='sample', overlay_hash=None):
        identity = identities['arms']['A' if arm == 'C' else arm]
        hashes = identity['sourceHashes'].copy()
        if overlay_hash is not None:
            hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = overlay_hash
        return validate_import_summary(
            read_json(out, location + '/summary.json'), read_json(out, location + '/run-1.json'),
            dictionary=dictionary, fixture=fixture, source_sha=identity['sha'],
            package_sha256=identity['packageSha256'], browser_version=browser,
            import_flags=None, source_hashes=hashes, source_dirty=overlay_hash is not None,
            media_check=media, vndb_sah_allocation_units=[37, 37] if dictionary == 'vndb' else None,
        )

    for row in observations:
        receipt = validate(row['id'], row['arm'])
        assert read_json(out, row['id'] + '/summary.json')['runs'][0]['totalImportMs'] == row['totalImportMs']
        assert receipt == read_json(out, row['id'] + '/canonical-receipt.json')
        if reference is None:
            reference = receipt
        else:
            require_matching_receipts(reference, receipt)
        semantic_checks += 1
    full_media = None
    for arm in ('A', 'B'):
        receipt = validate('exhaustive-media-' + arm, arm, media='all')
        require_matching_receipts(reference, receipt, compare_media=False)
        if full_media is None:
            full_media = receipt
        else:
            require_matching_receipts(full_media, receipt)
        semantic_checks += 1
    memory_root = out / 'memory'
    memory_plan = read_json(memory_root, 'plan.json')
    assert memory_plan['schedule'] == memory_schedule(1 if plan['initialOrder'] == 'AB' else 2)
    original = (memory_root / 'harness-original.js').read_text()
    instrumented = (memory_root / 'harness-instrumented.js').read_text()
    assert memory_overlay(original) == instrumented
    assert sha(instrumented.encode()) == memory_plan['overlaySha256']
    for arm in ('A', 'B'):
        assert sha(original.encode()) == identities['arms'][arm]['sourceHashes']['test/chromium/extension-two-dictionary-import.e2e.js']
    for row in memory_plan['schedule']:
        receipt = validate('memory/' + row['name'], row['arm'], overlay_hash=memory_plan['overlaySha256'])
        require_matching_receipts(reference, receipt)
        assert receipt == read_json(memory_root, row['name'] + '/canonical-receipt.json')
        semantic_checks += 1
    assert read_json(memory_root, 'semantic-failures.json') == []
    memory_audit = audit_cell(memory_root)
    assert memory_audit == read_json(memory_root, 'memory-audit.json')
    analysis = read_json(out, 'analysis.json')
    candidate = paired(observations, 'candidate', 'A', 'B')
    control = paired(observations, 'control', 'A', 'C')
    assert candidate == analysis['candidateVsBaseline']
    assert control == analysis['identicalCodeControl']
    assert analysis['memoryPassed'] == memory_audit['passesProspectiveMemoryScreen']
    result = {
        'artifact': artifact, 'status': 'audit-passed',
        'observations': len(observations), 'semanticChecks': semantic_checks,
        'candidateVsBaseline': candidate, 'identicalCodeControl': control,
        'memory': memory_audit, 'browserVersion': browser,
        'changedPackageEntries': actual_changed,
        'mediaFiles': fixture['mediaFiles'], 'mediaBytes': fixture['mediaBytes'],
        'rawProductZipPolicy': 'Original CI artifacts retain both ZIPs. This extracted audit pack retains their verified archive hashes and complete entry inventories, not duplicate ZIP bytes.',
    }
    (out / 'independent-audit.json').write_text(json.dumps(result, indent=2) + '\n')
    (out / 'artifact-members.json').write_text(json.dumps(member_receipts, indent=2) + '\n')
    all_results.append(result)
    print(json.dumps({'cell': artifact['name'], 'semanticChecks': semantic_checks,
                      'pairedMedian': candidate['medianPairedChangePercent'],
                      'controlMedian': control['medianPairedChangePercent'],
                      'memoryPassed': analysis['memoryPassed']}), flush=True)
(args.output / 'independent-audit.json').write_text(json.dumps(all_results, indent=2) + '\n')
