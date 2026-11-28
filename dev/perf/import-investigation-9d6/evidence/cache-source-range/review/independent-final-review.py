"""Read-only verification of the frozen cache evidence package."""
import ast
from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import statistics
import subprocess
import tarfile
import zipfile

ROOT = Path('/home/agent/manabitan-cache-hosted-9d6')
PACKAGE = ROOT / 'packaging/completed'
REPO = Path('/workspace/scratch/9d6dcf05cf8f/manabitan')
EXPECTED_MANIFEST = '0cf4c9cab875ee64bcbafb42a631117e9de91a42c7e0490552580b08f9717582'
EXPECTED_MATERIALIZER = '66be542ee372e34f13b6ab81eb1de0ed847a33a311340d7d29efbeda0fb205de'
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'dfd2523b514f291dc57f39a9f256bbc0759efd5b'
TOOLING = '5b5389ac69e07c95d11c4ff04230dbb8e0761995'
RUN = 46107460816
ENTRY = 'js/dictionary/dictionary-database.js'
sha = lambda data: hashlib.sha256(data).hexdigest()
blob = lambda data: hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
read = lambda path: json.loads(path.read_bytes())

manifest_bytes = (PACKAGE / 'publication-manifest.json').read_bytes()
assert sha(manifest_bytes) == EXPECTED_MANIFEST
manifest = json.loads(manifest_bytes)
assert len(manifest['files']) == 13
materializer = (PACKAGE / 'materialize.py').read_bytes()
assert sha(materializer) == EXPECTED_MATERIALIZER
rules = next(ast.literal_eval(node.value) for node in ast.parse(materializer).body
             if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CREDENTIAL_RULES' for t in node.targets))
scanners = [(name, re.compile(pattern)) for name, pattern in rules.items()]


def scan(data, label):
    for name, pattern in scanners:
        assert not pattern.search(data), f'Credential pattern {name} in {label}; no matched value emitted'


def git_bytes(commit, filename):
    return subprocess.check_output(['git', '-C', str(REPO), 'show', f'{commit}:{filename}'])


publication_paths = set()
for row in manifest['files']:
    path = Path(row['localPath'])
    assert path.is_relative_to(PACKAGE) and not path.is_symlink()
    assert row['path'] == 'dev/perf/import-investigation-9d6/evidence/cache-source-range/' + str(path.relative_to(PACKAGE))
    assert path not in publication_paths
    publication_paths.add(path)
    data = path.read_bytes()
    assert len(data) == row['bytes'] and sha(data) == row['sha256'] and blob(data) == row['gitBlobSha1']
    if row['encoding'] == 'utf-8':
        data.decode()
        scan(data, path.name)
    else:
        assert row['encoding'] == 'base64' and path.name.endswith('.tar.gz')
actual_paths = {p for p in PACKAGE.rglob('*') if p.is_file()}
expected_paths = publication_paths | {PACKAGE / 'publication-manifest.json'}
assert expected_paths <= actual_paths
operational_sidecars = actual_paths - expected_paths
assert operational_sidecars <= {PACKAGE / 'root-upload-plan.json'}
scan(manifest_bytes, 'publication-manifest.json')

inventory = read(PACKAGE / 'inventory.json')
receipt = read(PACKAGE / 'publication-receipt.json')
release = read(PACKAGE / 'release.json')
assert receipt['inventorySha256'] == sha((PACKAGE / 'inventory.json').read_bytes())
assert receipt['materializerSha256'] == inventory['materializerSha256'] == EXPECTED_MATERIALIZER
assert release['packagingReleased'] is True
assert release['approvedLayoutSha256'] == sha((PACKAGE / 'layout.json').read_bytes())
for doc in (inventory, receipt, release):
    assert doc['baseline'] == BASELINE and doc['candidate'] == CANDIDATE and doc['tooling'] == TOOLING
    assert doc['runId'] == RUN and doc['attempt'] == 1
assert inventory['disposition'] == receipt['disposition'] == release['disposition']
assert len(inventory['archives']) == 7
assert sum(a['files'] for a in inventory['archives']) == 1938
assert sum(a['bytes'] for a in inventory['archives']) == 13204300

artifact_by_id = {a['artifact']['id']: a for a in inventory['originalArtifacts']}
assert len(artifact_by_id) == 7
for identifier, identity in artifact_by_id.items():
    path = ROOT / str(identifier) / 'artifact.zip'
    data = path.read_bytes()
    assert len(data) == identity['zipBytes'] == identity['artifact']['size_in_bytes']
    assert sha(data) == identity['zipSha256'] == identity['artifact']['digest'].removeprefix('sha256:')
    assert identity['artifact']['workflow_run']['id'] == RUN
    assert identity['artifact']['workflow_run']['head_sha'] == TOOLING

counts = Counter()
cells = []
all_members = 0
all_bytes = 0
failure_detail = None
helper_bindings = None
for archive in inventory['archives']:
    path = Path(archive['localPath'])
    raw = path.read_bytes()
    assert len(raw) == archive['bytes'] and sha(raw) == archive['sha256']
    assert raw[:4] == b'\x1f\x8b\x08\x00' and raw[4:8] == b'\0' * 4
    expected = {m['archivePath']: m for m in archive['members']}
    assert len(expected) == archive['files']
    original_maps = {}
    identities = None
    memory_inputs = {}
    selected = {}
    archived_hashes = {}
    with tarfile.open(path, 'r:gz') as tar:
        members = tar.getmembers()
        assert [m.name for m in members] == sorted(expected)
        for member in members:
            name = member.name
            assert member.isfile() and str(PurePosixPath(name)) == name
            assert not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
            assert member.mode == 0o444 and member.uid == member.gid == member.mtime == 0
            assert member.uname == member.gname == ''
            data = tar.extractfile(member).read()
            row = expected[name]
            assert len(data) == row['bytes'] == member.size and sha(data) == row['sha256']
            archived_hashes[name] = sha(data)
            if row['sourcePath'] is not None:
                assert Path(row['sourcePath']).read_bytes() == data
            scan(data, name)
            all_members += 1
            all_bytes += len(data)
            if name.endswith('/canonical-receipt.json'):
                counts['canonicalReceipts'] += 1
            if name.endswith('/run-1.json'):
                counts['rawReports'] += 1
            if re.fullmatch(r'raw/memory/[AB][12]/memory.json', name):
                value = json.loads(data)
                assert len(value['samples']) == value['allObservedSampleCount']
                counts['rawMemoryScans'] += len(value['samples'])
                memory_inputs[name.split('/')[2]] = value
            if name.startswith('identity/') or name.startswith('audit/') or name in {
                'raw/observations.json', 'raw/registered-plan.json', 'raw/analysis.json',
                'raw/source-identities.json', 'raw/memory/observations.json', 'raw/memory/semantic-failures.json',
                'analysis/complete-six-host-summary.json', 'tools/audit-complete-import.py',
            } or name.startswith('tools/baseline/'):
                selected[name] = data
    assert sum(m['bytes'] for m in expected.values()) == archive['uncompressedBytes']
    outer = json.loads(selected['identity/artifact-members.json'])
    artifact_id = outer['artifact']['id']
    assert outer == artifact_by_id[artifact_id]
    original_prefix = 'checks/raw/' if archive['name'] == 'checks-and-tools.tar.gz' else 'raw/'
    with zipfile.ZipFile(ROOT / str(artifact_id) / 'artifact.zip') as original:
        infos = {i.filename: i for i in original.infolist()}
        assert len(infos) == len(original.infolist()) == len(outer['members'])
        omitted = []
        for member in outer['members']:
            info = infos[member['path']]
            data = original.read(info)
            assert len(data) == member['bytes'] and sha(data) == member['sha256']
            if member['kind'] == 'directory':
                assert info.is_dir()
            elif member['path'] in ('package-A.zip', 'package-B.zip'):
                omitted.append(member['path'])
                original_maps[member['path']] = data
            else:
                assert archived_hashes[original_prefix + member['path']] == member['sha256']
        assert len(omitted) == (0 if archive['name'] == 'checks-and-tools.tar.gz' else 2)
    if archive['name'] == 'checks-and-tools.tar.gz':
        assert sha(selected['tools/audit-complete-import.py']) == inventory['auditorSha256']
        helper_bindings = json.loads(selected['identity/baseline-helper-git-bindings.json'])
        assert helper_bindings == inventory['baselineHelperBindings']
        for helper in helper_bindings:
            data = selected['tools/baseline/' + helper['path']]
            assert data == git_bytes(BASELINE, helper['path'])
            assert len(data) == helper['bytes'] and sha(data) == helper['sha256'] and blob(data) == helper['gitBlobSha1']
        support_summary = json.loads(selected['analysis/complete-six-host-summary.json'])
        continue
    identities = json.loads(selected['raw/source-identities.json'])
    entry_maps = {}
    for arm, commit in [('A', BASELINE), ('B', CANDIDATE)]:
        package = json.loads(selected[f'identity/package-{arm}-members.json'])
        payload = original_maps[f'package-{arm}.zip']
        assert len(payload) == package['zipBytes'] and sha(payload) == package['zipSha256'] == identities['arms'][arm]['packageSha256']
        assert package['commit'] == identities['arms'][arm]['sha'] == commit
        assert package['tree'] == identities['arms'][arm]['tree']
        mapped = {m['path']: m for m in package['members']}
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            assert len(mapped) == len(z.infolist()) == 619
            files = {}
            for info in z.infolist():
                data = z.read(info)
                assert len(data) == mapped[info.filename]['bytes'] and sha(data) == mapped[info.filename]['sha256']
                if not info.is_dir(): files[info.filename] = sha(data)
            assert len(files) == 554 and files == identities['arms'][arm]['entries']
            assert z.read(ENTRY) == git_bytes(commit, 'ext/' + ENTRY)
        entry_maps[arm] = files
    assert entry_maps['A'].keys() == entry_maps['B'].keys()
    assert [k for k in entry_maps['A'] if entry_maps['A'][k] != entry_maps['B'][k]] == [ENTRY]
    observations = json.loads(selected['raw/observations.json'])
    plan = json.loads(selected['raw/registered-plan.json'])
    assert [{k: o[k] for k in ('id', 'kind', 'pair', 'arm')} for o in observations] == plan['schedule']
    kinds = Counter(o['kind'] for o in observations)
    assert kinds == {'candidate': 24, 'control': 8, 'warmup': 4}
    counts.update({'timedImports': kinds['candidate'] + kinds['control'], 'warmups': kinds['warmup']})
    analysis = json.loads(selected['raw/analysis.json'])
    audit_name = next(name for name in ('audit/root-audit.json', 'audit/independent-audit.json') if name in selected)
    audit = json.loads(selected[audit_name])
    released = next(r for r in release['cells'] if r['artifactId'] == artifact_id)
    assert sha(selected['audit/' + released['audit']]) == released['auditSha256']
    assert audit['candidateVsBaseline'] == analysis['candidateVsBaseline']
    assert audit['identicalCodeControl'] == analysis['identicalCodeControl']
    assert audit['reportedStatus'] == analysis['status']
    assert audit['memory']['passesProspectiveMemoryScreen'] == analysis['memoryPassed']
    assert audit['observationsValidated'] == 42
    for kind, label, target in [('candidate', 'B', 'candidateVsBaseline'), ('control', 'C', 'identicalCodeControl')]:
        groups = {}
        for observation in observations:
            if observation['kind'] == kind: groups.setdefault(observation['pair'], {})[observation['arm']] = observation['totalImportMs']
        pairs = [groups[k] for k in sorted(groups)]
        ratios = [pair[label] / pair['A'] for pair in pairs]
        result = audit[target]
        assert ratios == result['ratios'] and len(ratios) == result['count']
        assert (statistics.median(ratios) - 1) * 100 == result['medianPairedChangePercent']
        assert (sum(pair[label] for pair in pairs) / sum(pair['A'] for pair in pairs) - 1) * 100 == result['equalWorkChangePercent']
        assert (max(ratios) - 1) * 100 == result['worstPairChangePercent']
        assert sum(r < 1 for r in ratios) == result['fasterPairs']
    assert audit['candidateVsBaseline']['descriptiveBootstrap95Percent'][0] <= 0 <= audit['candidateVsBaseline']['descriptiveBootstrap95Percent'][1]
    memory_rows = json.loads(selected['raw/memory/observations.json'])
    assert len(memory_rows) == len(memory_inputs) == 4
    assert json.loads(selected['raw/memory/semantic-failures.json']) == []
    for row in memory_rows:
        data = memory_inputs[row['name']]
        for key in ('qualifiedForWholeTreePss', 'qualificationFailures', 'maxSampledPssKiB', 'maxSampledPrivateKiB', 'maximumCoveredSampleGapMs'):
            assert row[key] == data[key]
    assert sum(len(m['samples']) for m in memory_inputs.values()) == audit['memory']['rawScanCount']
    if archive['name'] == 'vndb-BA.tar.gz':
        expected_gaps = {'B1': 259.371315, 'A1': 266.956994, 'A2': 272.787439, 'B2': 267.570606}
        for row in memory_rows:
            assert row['qualificationFailures'] == ['covered-import-scan-gap-over-250ms']
            assert not row['qualifiedForWholeTreePss']
            assert row['maximumCoveredSampleGapMs'] == expected_gaps[row['name']]
            assert row['maxSampledPssKiB'] is None and row['maxSampledPrivateKiB'] is None
        assert all(v is None for metric in audit['memory']['metrics'].values() for v in metric.values())
        log = selected['audit/failed-job.log']
        failed = json.loads(selected['audit/failed-job-receipt.json'])
        assert len(log) == failed['decodedLogBytes'] == 65610
        assert sha(log) == failed['decodedLogSha256'] == 'fe4a919adaffd190ec0caa16064fd43ac50985aaa49ba2d534b6c096013b3209'
        assert failed['job']['id'] == 140863296120 and failed['job']['conclusion'] == 'failure'
        assert failed['run'] == RUN and failed['attempt'] == 1
        assert failed['toolingCommit'] == failed['job']['head_sha'] == TOOLING and failed['candidateCommit'] == CANDIDATE
        failure_detail = {'jobId': failed['job']['id'], 'decodedLogBytes': len(log), 'decodedLogSha256': sha(log),
                          'maximumCoveredScanGapsMs': expected_gaps, 'allFourObservationMaximaAndPairMetricsRemainNull': True,
                          'semanticFailures': [], 'failureKind': 'Sampler coverage exceeds fixed 250 ms limit; not measured memory growth.'}
    else:
        assert audit['memory']['passesProspectiveMemoryScreen']
    cells.append({'dictionary': audit['dictionary'], 'order': audit['order'], 'artifactId': artifact_id,
                  'candidateMedianPercent': audit['candidateVsBaseline']['medianPairedChangePercent'],
                  'controlMedianPercent': audit['identicalCodeControl']['medianPairedChangePercent'],
                  'rawMemoryScans': audit['memory']['rawScanCount'], 'memoryPassed': audit['memory']['passesProspectiveMemoryScreen']})

assert all_members == 1938 and all_bytes == 150262258
assert counts == {'canonicalReceipts': 252, 'rawReports': 252, 'rawMemoryScans': 1924, 'timedImports': 192, 'warmups': 24}
assert len(cells) == 6 and len(support_summary['cells']) == 6 and failure_detail is not None
assert sum(cell['memoryPassed'] for cell in cells) == 5
assert receipt['sourceEntriesVerified'] == all_members and receipt['canonicalReceiptsValidated'] == counts['canonicalReceipts']
assert receipt['rawMemoryScansValidated'] == counts['rawMemoryScans']
for summary in support_summary['cells']:
    cell = next(c for c in cells if c['artifactId'] == summary['artifactId'])
    assert summary['candidateVsBaseline']['medianPairedChangePercent'] == cell['candidateMedianPercent']
    assert summary['identicalCodeControl']['medianPairedChangePercent'] == cell['controlMedianPercent']
review = {
    'complete': True, 'reviewedAtUtc': datetime.now(timezone.utc).isoformat(),
    'scope': 'Independent final package/source readback only; no archive/source mutation and no benchmark.',
    'manifestSha256': EXPECTED_MANIFEST, 'materializerSha256': EXPECTED_MATERIALIZER,
    'publicationFilesVerified': 13, 'archivesVerified': 7, 'archiveBytes': 13204300,
    'archiveMembersVerified': all_members, 'uncompressedMemberBytes': all_bytes,
    'allPublicationGitBlobIdentitiesVerified': True,
    'unpublishedOperationalSidecars': sorted(str(p.relative_to(PACKAGE)) for p in operational_sidecars),
    'allOriginalOuterArtifactAndInnerPackageBytesAndMemberMapsVerified': True,
    'allRetainedSourceBytesUnchanged': True,
    'deterministicTarAndGzipMetadataVerified': True,
    'credentialScan': {'passed': True, 'rules': list(rules), 'scope': 'All retained tar payloads and publication text; bounded reviewed patterns.'},
    'baselineHelpersVerifiedAgainstGit': helper_bindings,
    'counts': dict(counts), 'cells': cells, 'vndbBaFailure': failure_detail,
    'allCandidateIntervalsIncludeZero': True,
    'sourceSha256': sha(Path(__file__).read_bytes()),
}
target = ROOT / 'packaging/independent-final-review.json'
assert not target.exists()
target.write_text(json.dumps(review, indent=2) + '\n')
print(json.dumps({'complete': True, 'receipt': str(target), 'receiptSha256': sha(target.read_bytes()), 'members': all_members, 'counts': dict(counts)}, indent=2))
