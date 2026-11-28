"""Read back frozen guarded evidence archives; no build, import or measurement."""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import random
import statistics
import subprocess
import tarfile
import zipfile

ROOT = Path('/home/agent/manabitan-guarded-hosted-9d6')
PACKAGE = ROOT / 'recovery-packaging'
OUT = PACKAGE / 'completed'
REPO = Path('/workspace/scratch/9d6dcf05cf8f/manabitan')
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda path: json.loads(path.read_bytes())
blob = lambda data: hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
identity = lambda path: {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}

manifest_path = OUT / 'publication-manifest.json'
assert sha(manifest_path.read_bytes()) == 'd55140180151a62dd60d31ab47a3abcb6ab4f114c90ebf5bfaf8ff3d4c766202'
manifest = read(manifest_path)
assert len(manifest['files']) == 13
for row in manifest['files']:
    path = Path(row['localPath'])
    assert path.resolve().is_relative_to(OUT.resolve()) and not path.is_symlink()
    data = path.read_bytes()
    assert len(data) == row['bytes'] and sha(data) == row['sha256'] and blob(data) == row['gitBlobSha1']
expected_files = {str(Path(row['localPath']).relative_to(OUT)) for row in manifest['files']} | {'publication-manifest.json'}
assert expected_files == {str(path.relative_to(OUT)) for path in OUT.rglob('*') if path.is_file()}
inventory = read(OUT / 'inventory.json')
receipt = read(OUT / 'publication-receipt.json')
release = read(OUT / 'release.json')
layout = read(OUT / 'layout.json')
readme = (OUT / 'README.md').read_text()
assert sha((OUT / 'release.json').read_bytes()) == '01bc7a775e958608491326cbb967531c319ea66bf8b047f70e6872dc3c6b6785'
assert (OUT / 'release.json').read_bytes() == (PACKAGE / 'root-release.json').read_bytes()
assert sha((OUT / 'materialize.py').read_bytes()) == release['approvedMaterializerSha256'] == '840aef67289b10d77cbafedd6112666504c7bb3ae7e86a12e1d7490f73380aaf'
assert sha((OUT / 'layout.json').read_bytes()) == release['approvedLayoutSha256'] == 'efb74076b76ef7c0f57de2a13795215dd5b7fdf8d4afe4132a1661fa40ad57a8'
assert sha((PACKAGE / 'PLAN.md').read_bytes()) == release['approvedPlanSha256'] == '9e92c0f2e855ddb5319aa43ad86291b72da536ace25fc60e797e16c498969540'
for key in ['runId', 'attempt', 'baseline', 'candidate', 'tooling', 'disposition']:
    assert inventory[key] == receipt[key] == release[key]
assert inventory['complete'] and receipt['complete']
assert receipt['inventorySha256'] == sha((OUT / 'inventory.json').read_bytes())
assert release['disposition']['status'] in readme and release['disposition']['decision'] in readme
assert 'no product PR' in readme and 'no replacement cohort' in readme
ns = {'__name__': 'review_only', '__file__': str(PACKAGE / 'materialize.py')}
exec(compile((OUT / 'materialize.py').read_bytes(), ns['__file__'], 'exec'), ns)
assert inventory['credentialScan']['passed'] is True and set(inventory['credentialScan']['rules']) == set(ns['CREDENTIAL_RULES'])
original_manifest = read(ROOT / 'original-recovery-manifest.json')
original_metadata = {r['id']: r for r in original_manifest['originalArtifactMetadata']}
assert len(inventory['originalArtifacts']) == len(original_metadata) == 8
original_maps = {r['artifact']['id']: r for r in inventory['originalArtifacts']}
assert set(original_maps) == set(original_metadata)

def verify_zip(path, rows, expected_bytes, expected_sha):
    actual = identity(path)
    assert actual == {'bytes': expected_bytes, 'sha256': expected_sha}
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        assert len(infos) == len(rows)
        for info, row in zip(infos, rows):
            with archive.open(info) as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            expected = {'path': info.filename, 'kind': 'directory' if info.is_dir() else 'file',
                        'bytes': info.file_size, 'sha256': digest, 'crc32': f'{info.CRC:08x}',
                        'compressedBytes': info.compress_size, 'compressionMethod': info.compress_type}
            assert all(row[k] == v for k, v in expected.items())

for identifier, row in original_maps.items():
    assert row['artifact'] == original_metadata[identifier] and row['runAttempt'] == 1
    assert row['zipBytes'] == row['artifact']['size_in_bytes'] and row['zipSha256'] == row['artifact']['digest'][7:]
    verify_zip(ROOT / str(identifier) / 'artifact.zip', row['members'], row['zipBytes'], row['zipSha256'])

def statistics_from_raw(rows, kind, other):
    selected = [r for r in rows if r['kind'] == kind]
    pairs = []
    for number in sorted({r['pair'] for r in selected}):
        group = [r for r in selected if r['pair'] == number]
        assert len(group) == 2 and {r['arm'] for r in group} == {'A', other}
        by_arm = {r['arm']: r['totalImportMs'] for r in group}
        a, b = by_arm['A'], by_arm[other]
        pairs.append({'pair': number, 'order': ''.join(r['arm'] for r in group), 'baselineMs': a,
                      'comparisonMs': b, 'savedMs': a-b, 'ratio': b/a})
    ratios = [p['ratio'] for p in pairs]
    rng = random.Random(897)
    boot = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return ({'count': len(pairs), 'ratios': ratios,
             'medianPairedChangePercent': 100*(statistics.median(ratios)-1),
             'equalWorkChangePercent': 100*(sum(p['comparisonMs'] for p in pairs)/sum(p['baselineMs'] for p in pairs)-1),
             'worstPairChangePercent': 100*(max(ratios)-1),
             'descriptiveBootstrap95Percent': [100*(boot[i]-1) for i in (249,9749)],
             'fasterPairs': sum(r < 1 for r in ratios)},
            {'baselineMedianMs': statistics.median(p['baselineMs'] for p in pairs),
             'comparisonMedianMs': statistics.median(p['comparisonMs'] for p in pairs),
             'medianSavedMs': statistics.median(p['savedMs'] for p in pairs), 'pairs': pairs})

cells = {(c['dictionary'], c['order']): c for c in release['cells']}
host_results = []
saved_support = None
totals = {'members': 0, 'rawBytes': 0, 'archiveBytes': 0, 'canonicalReceipts': 0,
          'timedImports': 0, 'warmups': 0, 'mediaImports': 0, 'memoryImports': 0,
          'rawMemoryScans': 0, 'coverageFailures': 0, 'failedJobRecords': 0}
for archive_info in inventory['archives']:
    path = Path(archive_info['localPath'])
    assert identity(path) == {k: archive_info[k] for k in ('bytes', 'sha256')}
    assert path.parent == OUT / 'archives'
    rows = archive_info['members']
    saved = {}
    with tarfile.open(path, 'r:xz') as archive:
        members = archive.getmembers()
        assert len(members) == len(rows) == archive_info['files']
        assert [m.name for m in members] == sorted(m.name for m in members)
        for member, row in zip(members, rows):
            assert member.isfile() and member.name == row['archivePath'] and member.size == row['bytes']
            assert member.uid == member.gid == member.mtime == 0 and member.mode == 0o444
            assert member.uname == member.gname == ''
            data = archive.extractfile(member).read()
            assert len(data) == row['bytes'] and sha(data) == row['sha256']
            ns['scan'](data, member.name)
            if row['sourcePath'] is not None:
                assert Path(row['sourcePath']).read_bytes() == data
            saved[member.name] = data
    assert sum(len(v) for v in saved.values()) == archive_info['uncompressedBytes']
    totals['members'] += len(saved)
    totals['rawBytes'] += archive_info['uncompressedBytes']
    totals['archiveBytes'] += archive_info['bytes']
    assert f"| {archive_info['name']} | {archive_info['bytes']:,} | {archive_info['sha256']} |" in readme
    if archive_info['name'] == 'native-checks-and-tools.tar.xz':
        saved_support = saved
        continue
    dictionary, order = archive_info['name'][:-7].split('-')
    instruction = cells[dictionary, order]
    identifier = instruction['artifactId']
    outer = json.loads(saved['identity/artifact-members.json'])
    assert outer == original_maps[identifier]
    retained = {r['retainedAs']: r for r in outer['members'] if r['kind'] == 'file' and r['path'] not in ('package-A.zip', 'package-B.zip')}
    assert {name for name in saved if name.startswith('raw/')} == set(retained)
    for name, row in retained.items():
        assert sha(saved[name]) == row['sha256'] and len(saved[name]) == row['bytes']
    identities = json.loads(saved['raw/source-identities.json'])
    package_maps = {}
    for arm, commit in [('A', release['baseline']), ('B', release['candidate'])]:
        package = json.loads(saved[f'identity/package-{arm}-members.json'])
        assert package['arm'] == arm and package['commit'] == commit
        assert package['zipSha256'] == identities['arms'][arm]['packageSha256']
        verify_zip(ROOT / str(identifier) / f'files/package-{arm}.zip', package['members'], package['zipBytes'], package['zipSha256'])
        entries = {r['path']: r['sha256'] for r in package['members'] if r['kind'] == 'file'}
        assert entries == identities['arms'][arm]['entries']
        data = subprocess.check_output(['git','-C',str(REPO),'show',commit+':dev/data/zstd-simd.wasm'])
        assert entries['lib/zstd.wasm'] == sha(data)
        package_maps[arm] = entries
    assert set(package_maps['A']) == set(package_maps['B'])
    assert [name for name in sorted(package_maps['A']) if package_maps['A'][name] != package_maps['B'][name]] == ['lib/zstd.wasm']
    audit_data = saved['audit/' + instruction['audit']]
    assert sha(audit_data) == instruction['auditSha256']
    audit = json.loads(audit_data)
    raw = json.loads(saved['raw/observations.json'])
    assert Counter(r['kind'] for r in raw) == {'warmup': 4, 'candidate': 24, 'control': 8}
    candidate, candidate_detail = statistics_from_raw(raw, 'candidate', 'B')
    control, control_detail = statistics_from_raw(raw, 'control', 'C')
    assert candidate == audit['candidateVsBaseline'] and candidate_detail == audit['candidateDetail']
    assert control == audit['identicalCodeControl'] and control_detail == audit['controlDetail']
    raw_analysis = json.loads(saved['raw/analysis.json'])
    assert candidate == raw_analysis['candidateVsBaseline'] and control == raw_analysis['identicalCodeControl']
    interval = candidate['descriptiveBootstrap95Percent']
    expected_line = f"| {dictionary} | {order} | {candidate['medianPairedChangePercent']:+.4f}% | [{interval[0]:+.4f}%, {interval[1]:+.4f}%] | {candidate['fasterPairs']}/12 | {candidate_detail['medianSavedMs']:+.3f} ms | {candidate['equalWorkChangePercent']:+.4f}% | {control['medianPairedChangePercent']:+.4f}% |"
    assert expected_line in readme
    canonical = [name for name in saved if name.endswith('/canonical-receipt.json')]
    assert len(canonical) == audit['observationsValidated'] == 42
    totals['canonicalReceipts'] += len(canonical)
    totals['timedImports'] += 32
    totals['warmups'] += 4
    totals['mediaImports'] += 2
    totals['memoryImports'] += 4
    observations = json.loads(saved['raw/memory/observations.json'])
    comparison = json.loads(saved['raw/memory/memory-comparison.json'])
    assert comparison['observations'] == observations and len(observations) == 4
    assert comparison['passesProspectiveMemoryScreen'] == audit['memory']['passesProspectiveMemoryScreen'] == raw_analysis['memoryPassed']
    assert json.loads(saved['raw/memory/semantic-failures.json']) == []
    unqualified = []
    scan_count = 0
    for row in observations:
        raw_memory = json.loads(saved['raw/memory/' + row['name'] + '/memory.json'])
        scan_count += len(raw_memory['samples'])
        if not row['qualifiedForWholeTreePss']:
            assert row['qualificationFailures'] == ['covered-import-scan-gap-over-250ms']
            assert row['maxSampledPssKiB'] is None and row['maxSampledPrivateKiB'] is None
            assert raw_memory['maxSampledPssKiB'] is None and raw_memory['maxSampledPrivateKiB'] is None
            assert f"{row['name']}: covered-import-scan-gap-over-250ms (maximum covered gap {row['maximumCoveredSampleGapMs']:.6f} ms)" in readme
            unqualified.append({'name': row['name'], 'gapMs': row['maximumCoveredSampleGapMs']})
    assert scan_count == audit['memory']['rawScanCount']
    totals['rawMemoryScans'] += scan_count
    totals['coverageFailures'] += len(unqualified)
    for pair in comparison['pairs']:
        if not pair['qualified']:
            assert pair['maxSampledPssKiB']['changePercent'] is None and pair['maxSampledPrivateKiB']['changePercent'] is None
    if unqualified:
        assert all(v is None for metric in comparison['metrics'].values() for v in metric.values())
    phase = [name for name in saved if name.startswith('exploratory/')]
    assert len(phase) == 2 and any(name.endswith('.json') for name in phase) and any(name.endswith('.log') for name in phase)
    failed = [name for name in saved if name.startswith('audit/failed-job-') and name.endswith('.receipt.json')]
    for name in failed:
        failure = json.loads(saved[name])
        data = saved['audit/' + failure['logFile']]
        assert len(data) == failure['decodedUtf8Bytes'] and sha(data) == failure['sha256']
        assert failure['artifactId'] == identifier and failure['runId'] == release['runId'] and failure['toolingHead'] == release['tooling']
        assert failure['jobMetadata']['conclusion'] == 'failure'
    totals['failedJobRecords'] += len(failed)
    host_results.append({'dictionary': dictionary, 'order': order, 'artifactId': identifier,
                         'candidateVsBaseline': candidate, 'candidateDetail': candidate_detail,
                         'identicalCodeControl': control, 'controlDetail': control_detail,
                         'memoryPassed': comparison['passesProspectiveMemoryScreen'], 'unqualified': unqualified,
                         'rawMemoryScans': scan_count, 'canonicalReceipts': len(canonical), 'failedJobs': len(failed)})

assert saved_support is not None
assert json.loads(saved_support['identity/packaging-release.json']) == release
assert saved_support['tools/packaging/materialize.py'] == (OUT / 'materialize.py').read_bytes()
assert saved_support['tools/packaging/layout.json'] == (OUT / 'layout.json').read_bytes()
assert sha(saved_support['tools/packaging/PLAN.md']) == release['approvedPlanSha256']
assert json.loads(saved_support['identity/baseline-helper-git-bindings.json']) == inventory['baselineHelperBindings']
assert json.loads(saved_support['identity/native-and-workflow-git-bindings.json']) == inventory['nativeAndWorkflowGitBindings']
for row in inventory['nativeAndWorkflowGitBindings']:
    data = subprocess.check_output(['git','-C',str(REPO),'show',row['commit']+':'+row['path']])
    assert saved_support[row['archivePath']] == data and sha(data) == row['sha256']
for row in inventory['baselineHelperBindings']:
    data = subprocess.check_output(['git','-C',str(REPO),'show',row['commit']+':'+row['path']])
    assert saved_support['tools/baseline/' + row['path']] == data and sha(data) == row['sha256']
for item in layout['support']['artifacts']:
    artifact = json.loads(saved_support[item['kind'] + '/identity/artifact-members.json'])
    assert artifact == original_maps[item['artifactId']]
    expected_names = {item['kind'] + '/raw/' + row['path'] for row in artifact['members'] if row['kind'] == 'file'}
    assert expected_names == {name for name in saved_support if name.startswith(item['kind'] + '/raw/')}
    assert len(expected_names) == item['members']
summary = json.loads(saved_support['analysis/complete-six-host-summary.json'])
assert summary['disposition'] == release['disposition'] and len(summary['cells']) == 6
for row in summary['cells']:
    host = next(h for h in host_results if (h['dictionary'],h['order']) == (row['dictionary'],row['order']))
    for key in ['artifactId','candidateVsBaseline','candidateDetail','identicalCodeControl','controlDetail']:
        assert row[key] == host[key]
    assert row['memory']['rawScanCount'] == host['rawMemoryScans']
for row in layout['supportRecords'] + release['additionalSupportFiles']:
    assert len(saved_support[row['archivePath']]) == row['bytes'] and sha(saved_support[row['archivePath']]) == row['sha256']
native = json.loads(saved_support[layout['support']['independentAudit']['archivePath']])
assert sha(saved_support[layout['support']['independentAudit']['archivePath']]) == inventory['nativeAndChecksAuditSha256']
assert native['discrepancies'] == [] and native['performanceConclusion'] is None
assert native['native']['directBoundaryCases'] == 885455 and native['native']['supersededFailuresRetained'] == {'traps':768,'wrongResults':1}
assert native['checks']['unitTestsPassed'] == 15135
assert totals == {'members':2004,'rawBytes':154032081,'archiveBytes':2707812,'canonicalReceipts':252,'timedImports':192,'warmups':24,'mediaImports':12,'memoryImports':24,'rawMemoryScans':1968,'coverageFailures':7,'failedJobRecords':3}
assert receipt['sourceEntriesVerified'] == totals['members'] and receipt['totalArchiveBytes'] == totals['archiveBytes']
assert receipt['canonicalReceiptsValidated'] == totals['canonicalReceipts'] and receipt['rawMemoryScansValidated'] == totals['rawMemoryScans']
assert {str(path.relative_to(OUT)) for path in OUT.rglob('*') if path.is_file()} == expected_files

result = {'complete': True, 'reviewedAtUtc': datetime.now(timezone.utc).isoformat(),
          'scope': 'Independent readback of frozen archives and original evidence only. No archive mutation, new timing, build, import or native proof execution.',
          'manifestSha256': sha(manifest_path.read_bytes()), 'rootReleaseSha256': sha((OUT/'release.json').read_bytes()),
          'materializerSha256': release['approvedMaterializerSha256'], 'layoutSha256': release['approvedLayoutSha256'],
          'publicationFilesVerified':13, 'archivesVerified':7, 'outerZipMapsVerified':8, 'innerZipMapsVerified':12,
          'totals':totals, 'hostStatisticsRecomputedFromArchivedRawObservations':host_results,
          'readmeStatisticsAndFailureRowsMatch':True, 'allRawAndSourceMemberBytesMatch':True,
          'allOriginalZipMemberHashesAndCrcsMatch':True, 'nativeChecksAndAllSupportRecordsRetained':True,
          'nullQualifiedMaximaAndPairDeltasPreserved':True, 'credentialPatternScanPassed':True,
          'finalDisposition':release['disposition'],
          'conclusion':'Final frozen package passed independent verification. No publication blocker; no product PR or replacement cohort.',
          'reviewerSourceSha256':sha(Path(__file__).read_bytes())}
output=Path(__file__).with_suffix('.json')
with output.open('x') as stream:
    json.dump(result,stream,indent=2)
    stream.write('\n')
print(json.dumps({'complete':True,'receipt':str(output),'sha256':sha(output.read_bytes()),'totals':totals,'publicationFilesVerified':13,'archivesModified':False},indent=2))
