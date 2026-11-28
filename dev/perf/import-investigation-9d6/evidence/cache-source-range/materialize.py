"""Package the released six-host cache study; default mode only checks readiness.

No benchmark, network call, source mutation, or publication is performed.
All original observations remain unchanged. Only the two verified release ZIP
payloads are omitted; complete outer/inner member identities remain retained.
"""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import zipfile


HERE = Path(__file__).resolve().parent
LAYOUT_PATH = HERE / 'layout.json'
REPOSITORY = Path('/workspace/scratch/9d6dcf05cf8f/manabitan')
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'dfd2523b514f291dc57f39a9f256bbc0759efd5b'
TOOLING = '5b5389ac69e07c95d11c4ff04230dbb8e0761995'
RUN = 46107460816
ATTEMPT = 1
AUDITOR_SHA = '8f5dcacc42616d2198d3f1d6ab4b7ec84e560c7b12052458381b459b5783bd8e'
HELPER_DIR = 'dev/perf/import-memory-20261125-a7f7'
HELPERS = ('audit_memory.py', 'qualification_receipts.py', 'protocol.py', 'chromium_memory.py')
OMIT = {'package-A.zip', 'package-B.zip'}
PACKAGE_ENTRY = 'js/dictionary/dictionary-database.js'
BLOCK = 1024 * 1024

# Deliberately bounded, high-confidence patterns; no matched values are printed.
CREDENTIAL_RULES = {
    'github-token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b',
    'openai-project-key': rb'\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{32,}',
    'aws-access-key-id': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'private-key': rb'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----',
    'authorization-value': rb'(?i)authorization[\x20\t]*[:=][\x20\t]*[\x22\x27]?(?:bearer|basic)[\x20\t]+[A-Za-z0-9_./+=-]{24,}',
    'signed-or-secret-url': rb'(?i)https?://[^\s\x22\x27<>]{0,2048}[?&](?:x-amz-signature|x-amz-security-token|sig|access_token|refresh_token|client_secret|api_key)=[^&\s\x22\x27<>]{16,}',
    'url-user-password': rb'(?i)https?://[^\s/@:\x22\x27<>]{1,100}:[^\s/@\x22\x27<>]{8,200}@',
}
SCANNERS = [(name, re.compile(pattern)) for name, pattern in CREDENTIAL_RULES.items()]


def require(condition, label):
    if not condition:
        raise ValueError(label)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def read_json(path):
    return json.loads(path.read_bytes())


def scan(data, label):
    for rule, pattern in SCANNERS:
        if pattern.search(data):
            raise ValueError(f'Credential pattern detected; publication stopped: {rule} in {label}')


def file_identity(path, scan_credentials=False):
    require(path.is_file() and not path.is_symlink(), f'Not a regular source file: {path}')
    digest = hashlib.sha256()
    size = 0
    previous = b''
    with path.open('rb') as stream:
        while block := stream.read(BLOCK):
            digest.update(block)
            size += len(block)
            if scan_credentials:
                scan(previous + block, str(path))
                previous = block[-4096:]
    return {'bytes': size, 'sha256': digest.hexdigest()}


def git_bytes(revision, filename):
    return subprocess.check_output(['git', '-C', str(REPOSITORY), 'show', f'{revision}:{filename}'])


def git_blob(data):
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()


def safe_name(name, directory=False):
    require(isinstance(name, str) and name and '\\' not in name, 'Invalid member path')
    require(not any(ord(char) < 32 for char in name), 'Control character in member path')
    path = PurePosixPath(name)
    expected = str(path) + ('/' if directory else '')
    require(not path.is_absolute() and '..' not in path.parts and name == expected, f'Unsafe or non-normalized member path: {name}')
    return path


def zip_members(archive):
    infos = archive.infolist()
    require(len(infos) <= 5000, 'ZIP member count exceeds reviewed bound')
    require(sum(info.file_size for info in infos) <= 1024 ** 3, 'ZIP expanded bytes exceed reviewed bound')
    seen = set()
    for info in infos:
        path = safe_name(info.filename, info.is_dir())
        normalized = str(path)
        require(normalized not in seen, f'Duplicate normalized ZIP path: {normalized}')
        seen.add(normalized)
        kind = stat.S_IFMT(info.external_attr >> 16)
        require(kind in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG), f'Non-regular ZIP member: {normalized}')
        require(not info.flag_bits & 1, f'Encrypted ZIP member: {normalized}')
    return infos


def zip_member_identity(archive, info):
    digest = hashlib.sha256()
    count = 0
    with archive.open(info) as stream:
        while block := stream.read(BLOCK):
            digest.update(block)
            count += len(block)
    require(count == info.file_size, f'ZIP member size mismatch: {info.filename}')
    return {'path': info.filename, 'kind': 'directory' if info.is_dir() else 'file', 'bytes': count,
            'sha256': digest.hexdigest(), 'crc32': f'{info.CRC:08x}', 'compressedBytes': info.compress_size,
            'compressionMethod': info.compress_type}


def discover(layout):
    found = {}
    expected = {cell['expectedArtifactName'] for cell in layout['cells']} | {layout['checks']['expectedArtifactName']}
    root = Path(layout['evidenceRoot'])
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or not directory.name.isdigit():
            continue
        receipt_path = directory / 'download-receipt.json'
        if not receipt_path.is_file():
            continue
        receipt = read_json(receipt_path)
        artifact = receipt['artifact']
        if artifact['name'] not in expected:
            continue
        require(artifact['name'] not in found, f'Duplicate completed artifact name: {artifact["name"]}')
        require(artifact['id'] == int(directory.name), 'Artifact directory/ID mismatch')
        require(artifact['workflow_run']['id'] == RUN and artifact['workflow_run']['head_sha'] == TOOLING, 'Artifact run/head mismatch')
        found[artifact['name']] = directory
    return found


def check_audit(path, cell, helpers=None):
    audit = read_json(path)
    expected = {'complete': True, 'observationsValidated': 42, 'baseline': BASELINE,
                'candidate': CANDIDATE, 'dictionary': cell['dictionary'], 'order': cell['order'],
                'auditorSha256': AUDITOR_SHA, 'sourcePackagePlanAndReceiptChecks': 'passed'}
    for key, value in expected.items():
        require(audit.get(key) == value, f'Audit admission mismatch: {path.name}/{key}')
    require(audit['candidateVsBaseline']['count'] == 12 and audit['identicalCodeControl']['count'] == 4, 'Audit comparison counts mismatch')
    require(audit['memory']['observations'] == 4, 'Audit memory observation count mismatch')
    evidence = (path.parent / 'files').resolve()
    require(audit['evidence'] == str(evidence), 'Audit evidence directory mismatch')
    original_analysis = read_json(evidence / 'analysis.json')
    for key in ('candidateVsBaseline', 'identicalCodeControl'):
        require(audit[key] == original_analysis[key], f'Audit/raw analysis mismatch: {key}')
    require(audit['reportedStatus'] == original_analysis['status'], 'Audit/raw status mismatch')
    require(audit['memory']['passesProspectiveMemoryScreen'] == original_analysis['memoryPassed'], 'Audit/raw memory result mismatch')
    if helpers is not None:
        require(audit['boundBaselineHelpers'] == helpers, 'Audit helper identity mismatch')
    # A negative endpoint or failed memory screen is evidence, never an exclusion.
    return audit


def readiness(layout, found):
    cells = []
    for cell in layout['cells']:
        directory = found.get(cell['expectedArtifactName'])
        paths = [] if directory is None else [directory / name for name in ('root-audit.json', 'independent-audit.json') if (directory / name).is_file()]
        if paths:
            for path in paths:
                check_audit(path, cell)
        cells.append({'dictionary': cell['dictionary'], 'order': cell['order'],
                      'artifactId': None if directory is None else int(directory.name),
                      'auditsComplete': bool(paths), 'audits': [path.name for path in paths]})
    checks = found.get(layout['checks']['expectedArtifactName'])
    checks_ready = checks is not None and (checks / 'checks-independent-audit.json').is_file()
    return {'ready': checks_ready and all(cell['auditsComplete'] for cell in cells),
            'checksReady': checks_ready, 'cells': cells, 'archivesCreated': False}


class Selection:
    def __init__(self):
        self.entries = {}

    def source(self, name, path, expected=None):
        safe_name(name)
        require(name not in self.entries, f'Duplicate archive entry: {name}')
        identity = file_identity(path, scan_credentials=True)
        if expected is not None:
            require(all(identity[key] == expected[key] for key in ('bytes', 'sha256')), f'Source identity mismatch: {path}')
        self.entries[name] = {'sourcePath': str(path), **identity}

    def generated(self, name, data, provenance):
        safe_name(name)
        require(name not in self.entries, f'Duplicate archive entry: {name}')
        scan(data, name)
        self.entries[name] = {'sourcePath': None, 'generatedFrom': provenance, 'bytes': len(data), 'sha256': sha(data), '_data': data}

    def rows(self):
        return [{'archivePath': name, **{key: value for key, value in row.items() if key != '_data'}} for name, row in sorted(self.entries.items())]


def verify_outer(directory, expected_name, selection, prefix='raw'):
    receipt_path = directory / 'download-receipt.json'
    receipt = read_json(receipt_path)
    artifact = receipt['artifact']
    require(artifact['name'] == expected_name, 'Artifact name mismatch')
    require(artifact['workflow_run']['id'] == RUN and artifact['workflow_run']['head_sha'] == TOOLING, 'Artifact source mismatch')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', artifact['digest']) is not None, 'Missing exact artifact digest')
    archive_path = directory / 'artifact.zip'
    identity = file_identity(archive_path)
    require(identity['bytes'] == artifact['size_in_bytes'] and identity['bytes'] <= 128 * 1024 ** 2, 'Original ZIP size mismatch')
    require(identity['sha256'] == artifact['digest'][7:], 'Original ZIP digest mismatch')
    require(receipt.get('verifiedBytes', receipt.get('verified_size')) == identity['bytes'], 'Download receipt size mismatch')
    require(receipt.get('verifiedSha256', receipt.get('verified_sha256')) == identity['sha256'], 'Download receipt hash mismatch')
    extracted = directory / 'files'
    members = []
    retained = set()
    with zipfile.ZipFile(archive_path) as archive:
        for info in zip_members(archive):
            row = zip_member_identity(archive, info)  # Reading all bytes also checks ZIP CRC.
            path = extracted / info.filename
            if info.is_dir():
                require(path.is_dir() and not path.is_symlink(), 'Extracted directory mismatch')
                row['retainedAs'] = 'directory represented by retained files and this map'
            else:
                require(file_identity(path) == {key: row[key] for key in ('bytes', 'sha256')}, f'Extracted member differs: {info.filename}')
                retained.add(info.filename)
                if info.filename in OMIT:
                    row['retainedAs'] = 'payload omitted only after complete inner package verification'
                else:
                    row['retainedAs'] = f'{prefix}/{info.filename}'
                    selection.source(row['retainedAs'], path, row)
            members.append(row)
    require(retained == {str(path.relative_to(extracted)) for path in extracted.rglob('*') if path.is_file()}, 'Extra/missing extracted artifact file')
    require(not any(path.is_symlink() for path in extracted.rglob('*')), 'Extracted artifact contains a symlink')
    require(len(members) == receipt.get('members', receipt.get('member_count')), 'Receipt member count mismatch')
    if 'files' in receipt:
        require({row['path']: (row['bytes'], row['sha256']) for row in receipt['files']} ==
                {row['path']: (row['bytes'], row['sha256']) for row in members if row['kind'] == 'file'}, 'Download member map mismatch')
    selection.source('identity/download-receipt.json', receipt_path)
    result = {'artifact': artifact, 'runAttempt': ATTEMPT, 'zipBytes': identity['bytes'], 'zipSha256': identity['sha256'], 'members': members}
    selection.generated('identity/artifact-members.json', json_bytes(result), str(receipt_path))
    return result


def verify_packages(directory, selection):
    identities_path = directory / 'files/source-identities.json'
    identities = read_json(identities_path)
    require(identities['changedPackageEntries'] == [PACKAGE_ENTRY], 'Unexpected changed package entry')
    maps = {}
    for arm, commit in [('A', BASELINE), ('B', CANDIDATE)]:
        recorded = identities['arms'][arm]
        require(recorded['sha'] == commit, 'Package arm source mismatch')
        expected_tree = subprocess.check_output(['git', '-C', str(REPOSITORY), 'rev-parse', commit + '^{tree}'], text=True).strip()
        require(recorded['tree'] == expected_tree, 'Package source tree mismatch')
        path = directory / f'files/package-{arm}.zip'
        identity = file_identity(path)
        require(identity['sha256'] == recorded['packageSha256'], 'Release ZIP digest mismatch')
        members = []
        with zipfile.ZipFile(path) as package:
            for info in zip_members(package):
                members.append(zip_member_identity(package, info))
        entry_hashes = {member['path']: member['sha256'] for member in members if member['kind'] == 'file'}
        require(entry_hashes == recorded['entries'], 'Release ZIP member map mismatch')
        require(entry_hashes[PACKAGE_ENTRY] == sha(git_bytes(commit, 'ext/' + PACKAGE_ENTRY)), 'Packaged product source mismatch')
        result = {'arm': arm, 'commit': commit, 'tree': expected_tree, 'zipBytes': identity['bytes'], 'zipSha256': identity['sha256'], 'members': members}
        selection.generated(f'identity/package-{arm}-members.json', json_bytes(result), str(identities_path))
        maps[arm] = result
    require(set(identities['arms']['A']['entries']) == set(identities['arms']['B']['entries']), 'Release package entry sets differ')
    changed = sorted(path for path in identities['arms']['A']['entries'] if identities['arms']['A']['entries'][path] != identities['arms']['B']['entries'].get(path))
    require(changed == [PACKAGE_ENTRY], 'Actual release package difference mismatch')
    return maps


def write_archive(path, selection):
    temporary = path.with_suffix(path.suffix + '.partial')
    rows = selection.rows()
    with temporary.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=6, mtime=0, filename='') as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for name, row in sorted(selection.entries.items()):
                    data = row['_data'] if row['sourcePath'] is None else Path(row['sourcePath']).read_bytes()
                    require(len(data) == row['bytes'] and sha(data) == row['sha256'], f'Source changed before archive inclusion: {name}')
                    scan(data, name)
                    info = tarfile.TarInfo(name)
                    info.size, info.mode, info.mtime = len(data), 0o444, 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    archive.addfile(info, io.BytesIO(data))
    with tarfile.open(temporary, 'r:gz') as archive:
        members = archive.getmembers()
        require(len(members) == len(rows), 'Saved tar member count mismatch')
        for info, row in zip(members, rows):
            require(info.isfile() and info.name == row['archivePath'] and info.size == row['bytes'], 'Saved tar member mismatch')
            require(info.uid == info.gid == info.mtime == 0 and info.mode == 0o444, 'Tar metadata is not deterministic')
            require(sha(archive.extractfile(info).read()) == row['sha256'], f'Saved tar member hash mismatch: {info.name}')
    temporary.rename(path)
    identity = file_identity(path)
    return {'localPath': str(path), 'name': path.name, **identity, 'files': len(rows),
            'uncompressedBytes': sum(row['bytes'] for row in rows), 'members': rows}


def write_new(path, data):
    scan(data, path.name)
    with path.open('xb') as stream:
        stream.write(data)


def materialize(layout, found, release_path, output):
    release_data = release_path.read_bytes()
    release = json.loads(release_data)
    require(release.get('packagingReleased') is True, 'Packaging release is not present')
    for key, expected in [('runId', RUN), ('attempt', ATTEMPT), ('baseline', BASELINE), ('candidate', CANDIDATE), ('tooling', TOOLING)]:
        require(release.get(key) == expected, f'Packaging release binding mismatch: {key}')
    require(release['approvedLayoutSha256'] == sha(LAYOUT_PATH.read_bytes()), 'Approved layout hash mismatch')
    require(release['disposition']['status'] and release['disposition']['decision'], 'Final parent disposition is required')
    require(isinstance(release['finalizedAt'], str) and release['finalizedAt'], 'Fixed finalization timestamp is required')
    require(readiness(layout, found)['ready'], 'All six cells and checks must be fully audited before archive creation')
    require(output.resolve().is_relative_to(Path('/home/agent')), 'All packaging writes must remain under /home/agent')
    require(not output.exists(), 'Output already exists; never overwrite a frozen appendix')
    cells = {(cell['dictionary'], cell['order']): cell for cell in release['cells']}
    require(len(cells) == len(release['cells']) == 6 and set(cells) == {(cell['dictionary'], cell['order']) for cell in layout['cells']}, 'Release must list each of the six cells once')

    support = Selection()
    auditor_path = Path(layout['auditor']['sourcePath'])
    require(file_identity(auditor_path)['sha256'] == AUDITOR_SHA, 'Reviewed auditor source changed')
    support.source('tools/audit-complete-import.py', auditor_path, layout['auditor'])
    helpers = {}
    helper_map = []
    for name in HELPERS:
        filename = HELPER_DIR + '/' + name
        path = REPOSITORY / filename
        original = git_bytes(BASELINE, filename)
        identity = file_identity(path)
        require(identity == {'bytes': len(original), 'sha256': sha(original)}, 'Baseline helper differs from Git object')
        helpers[name] = identity['sha256']
        helper_map.append({'path': filename, 'commit': BASELINE, 'gitBlobSha1': git_blob(original), **identity})
        support.source('tools/baseline/' + filename, path, identity)
    support.generated('identity/baseline-helper-git-bindings.json', json_bytes(helper_map), BASELINE)
    for name, source in [('materialize.py', Path(__file__)), ('layout.json', LAYOUT_PATH), ('PLAN.md', HERE / 'PLAN.md')]:
        support.source('tools/packaging/' + name, source)
    support.generated('identity/packaging-release.json', release_data, str(release_path))
    for row in layout.get('supportRecords', []):
        support.source(row['archivePath'], Path(row['sourcePath']), row)
    phase_source = layout['exploratory']['phaseDiagnosticSource']
    support.source('tools/diagnose-complete-import-phases.py', Path(phase_source['sourcePath']), phase_source)
    for path_string in layout['exploratory']['knownPaths']:
        path = Path(path_string)
        if path.parent == Path(layout['evidenceRoot']):
            support.source('exploratory/' + path.name, path)
    for row in release.get('additionalSupportFiles', []):
        support.source(row['archivePath'], Path(row['sourcePath']), row)

    checks_dir = found[layout['checks']['expectedArtifactName']]
    checks_outer = verify_outer(checks_dir, layout['checks']['expectedArtifactName'], support, 'checks/raw')
    checks = read_json(checks_dir / 'checks-independent-audit.json')
    require(checks['complete'] and checks['product']['sha'] == CANDIDATE and checks['run']['head'] == TOOLING, 'Checks audit binding mismatch')
    require(checks['jobConclusion'] == 'success', 'Checks job did not pass')
    require(checks['bindingReceiptSha256'] == file_identity(checks_dir / 'checks-binding.json')['sha256'], 'Checks binding receipt changed')
    require(checks['downloadReceiptSha256'] == file_identity(checks_dir / 'download-receipt.json')['sha256'], 'Checks download receipt changed')
    for path in sorted(checks_dir.iterdir()):
        if path.name in ('artifact.zip', 'download-receipt.json', 'files'):
            continue
        require(path.is_file() and not path.name.endswith('.tmp'), 'Unexpected or incomplete checks sidecar')
        support.source('checks/review/' + path.name, path)

    selections = []
    summaries = []
    original_artifacts = [checks_outer]
    snapshots = {}
    for cell in layout['cells']:
        key = (cell['dictionary'], cell['order'])
        instruction = cells[key]
        directory = found[cell['expectedArtifactName']]
        require(int(directory.name) == instruction['artifactId'], 'Released artifact ID mismatch')
        require(instruction['audit'] in ('root-audit.json', 'independent-audit.json'), 'Unrecognized primary audit name')
        audit_path = directory / instruction['audit']
        require(file_identity(audit_path)['sha256'] == instruction['auditSha256'], 'Released audit hash mismatch')
        audit = check_audit(audit_path, cell, helpers)
        selection = Selection()
        original = verify_outer(directory, cell['expectedArtifactName'], selection)
        packages = verify_packages(directory, selection)
        original_artifacts.append(original)
        for path in sorted(directory.iterdir()):
            if path.name in ('artifact.zip', 'download-receipt.json', 'files'):
                continue
            require(path.is_file() and not path.name.endswith('.tmp'), 'Unexpected or incomplete host sidecar')
            section = 'exploratory' if 'phase' in path.name else 'audit'
            selection.source(section + '/' + path.name, path)
        snapshots[str(directory)] = sorted(str(path.relative_to(directory)) for path in directory.rglob('*') if path.is_file())
        selections.append((cell['archive'], selection))
        summaries.append({'dictionary': key[0], 'order': key[1], 'artifactId': int(directory.name),
                          'auditSha256': instruction['auditSha256'], 'observationsValidated': audit['observationsValidated'],
                          'candidateVsBaseline': audit['candidateVsBaseline'], 'candidateDetail': audit['candidateDetail'],
                          'identicalCodeControl': audit['identicalCodeControl'], 'controlDetail': audit['controlDetail'],
                          'memory': audit['memory'], 'reportedStatus': audit['reportedStatus'],
                          'packageIdentities': {arm: {k: v for k, v in value.items() if k != 'members'} for arm, value in packages.items()}})
    support.generated('analysis/complete-six-host-summary.json', json_bytes({'disposition': release['disposition'], 'cells': summaries,
                      'scope': 'Original endpoint/control arithmetic from completed audits. Phase diagnostics remain exploratory; no filtering or pooled endpoint replacement.'}), 'All six unchanged primary audits')
    selections.append((layout['checks']['archive'], support))
    # Nothing is written before every cell, outer ZIP, inner ZIP and selected source passes.
    output.mkdir()
    archives_dir = output / 'archives'
    archives_dir.mkdir()
    archives = [write_archive(archives_dir / name, selection) for name, selection in selections]
    for directory, expected in snapshots.items():
        require(sorted(str(path.relative_to(directory)) for path in Path(directory).rglob('*') if path.is_file()) == expected, 'Input evidence file set changed during packaging')

    inventory = {'complete': True, 'baseline': BASELINE, 'candidate': CANDIDATE, 'tooling': TOOLING, 'runId': RUN, 'attempt': ATTEMPT,
                 'disposition': release['disposition'], 'originalArtifacts': original_artifacts, 'archives': archives,
                 'sourceSelection': 'Every original extracted file retained; only exact package-A.zip/package-B.zip payloads omitted after full digest/member verification.',
                 'credentialScan': {'passed': True, 'rules': list(CREDENTIAL_RULES), 'scope': 'All retained source bytes and generated text; bounded pattern scan, no matches.'},
                 'deterministicEncoding': 'Lexical PAX tar order; regular files mode0444, mtime0, uid/gid0, empty owner names; gzip level6, mtime0, empty filename.',
                 'materializerSha256': file_identity(Path(__file__))['sha256'], 'auditorSha256': AUDITOR_SHA, 'baselineHelperBindings': helper_map}
    write_new(output / 'inventory.json', json_bytes(inventory))
    receipt = {'complete': True, 'finalizedAt': release['finalizedAt'], 'runId': RUN, 'attempt': ATTEMPT,
               'baseline': BASELINE, 'candidate': CANDIDATE, 'tooling': TOOLING, 'disposition': release['disposition'],
               'inventorySha256': file_identity(output / 'inventory.json')['sha256'], 'materializerSha256': inventory['materializerSha256'],
               'sourceEntriesVerified': sum(archive['files'] for archive in archives), 'totalArchiveBytes': sum(archive['bytes'] for archive in archives),
               'canonicalReceiptsValidated': sum(cell['observationsValidated'] for cell in summaries),
               'rawMemoryScansValidated': sum(cell['memory']['rawScanCount'] for cell in summaries),
               'archives': [{k: v for k, v in archive.items() if k != 'members'} for archive in archives],
               'originalArtifacts': [{k: v for k, v in artifact.items() if k != 'members'} for artifact in original_artifacts],
               'verification': ['All seven original ZIP sizes/digests and every extracted member verified',
                                'All twelve release ZIPs and every entry verified before payload omission',
                                'All primary audits bind the exact reviewed auditor and four baseline Git helpers',
                                'Every saved tar member re-read and checked against its frozen source hash',
                                'Credential pattern scan passed across retained evidence and generated text',
                                'No source receipt, endpoint observation, control, tail, memory scan or phase diagnostic rewritten',
                                'No benchmark executed, no earlier archive changed, no external publication performed']}
    write_new(output / 'publication-receipt.json', json_bytes(receipt))
    lines = ['# Cache source-range helper: complete six-host record', '', release['disposition']['status'], '', release['disposition']['decision'], '',
             f'Run {RUN}, attempt {ATTEMPT}; baseline {BASELINE}; candidate {CANDIDATE}; workflow/tooling {TOOLING}.', '',
             'All original warmups, 12 candidate pairs and four identical-code control pairs per host remain included. The two exhaustive-media observations and four memory observations also remain intact: 42 canonical receipts per host, 252 in total. Original reports, plans, host snapshots, logs, raw scans, markers and audits are retained. Phase diagnostics are exploratory and do not modify endpoint timing.', '',
             '| Dictionary | Host order | Median B/A | Descriptive 95% interval | Faster pairs | Median saving | Equal-work change | Control C/A |',
             '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |']
    for cell in summaries:
        comparison = cell['candidateVsBaseline']
        interval = comparison['descriptiveBootstrap95Percent']
        lines.append(f"| {cell['dictionary']} | {cell['order']} | {comparison['medianPairedChangePercent']:+.4f}% | [{interval[0]:+.4f}%, {interval[1]:+.4f}%] | {comparison['fasterPairs']}/12 | {cell['candidateDetail']['medianSavedMs']:+.3f} ms | {comparison['equalWorkChangePercent']:+.4f}% | {cell['identicalCodeControl']['medianPairedChangePercent']:+.4f}% |")
    lines += ['', 'Negative B/A favors the candidate; positive saved milliseconds favors the candidate. Endpoint results are not pooled across hosts or replaced by phase counters. Correctness and memory checks do not establish a speed gain.', '',
              '| Archive | Bytes | SHA256 |', '| --- | ---: | --- |']
    for archive in archives:
        lines.append(f"| {archive['name']} | {archive['bytes']:,} | {archive['sha256']} |")
    lines += ['', 'The inventory retains full original artifact/member identities and both release-package maps for every host. Only the two release ZIP payloads per host and the original outer ZIP duplicates are omitted. The source packages were verified before omission; rerunning the original offline auditor requires recovering/building those exact packages. The checks archive includes the reviewed auditor, its Git-bound baseline helpers, packaging source and layout, checks evidence, and exploratory support records.', '',
              'No benchmark, new qualification criterion, tail exclusion, earlier archive replacement or publication is performed by this packager.', '']
    write_new(output / 'README.md', '\n'.join(lines).encode())
    write_new(output / 'materialize.py', Path(__file__).read_bytes())
    write_new(output / 'layout.json', LAYOUT_PATH.read_bytes())
    write_new(output / 'release.json', release_data)
    files = []
    for path in sorted(output.rglob('*')):
        if not path.is_file():
            continue
        data = path.read_bytes()
        files.append({'path': layout['publicationDirectory'] + '/' + str(path.relative_to(output)), 'localPath': str(path),
                      'encoding': 'base64' if path.name.endswith('.tar.gz') else 'utf-8', 'bytes': len(data),
                      'sha256': sha(data), 'gitBlobSha1': git_blob(data)})
    write_new(output / 'publication-manifest.json', json_bytes({'status': 'Frozen evidence-only record for parent publication; no product promotion implied.', 'files': files}))
    return {'complete': True, 'archives': len(archives), 'files': receipt['sourceEntriesVerified'],
            'archiveBytes': receipt['totalArchiveBytes'], 'manifest': str(output / 'publication-manifest.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--materialize', action='store_true', help='Write only after a frozen parent release lists all six completed audits')
    parser.add_argument('--release', type=Path)
    parser.add_argument('--output', type=Path, default=HERE / 'completed')
    args = parser.parse_args()
    layout = read_json(LAYOUT_PATH)
    require(layout['baselineCommit'] == BASELINE and layout['productCommit'] == CANDIDATE and layout['toolingCommit'] == TOOLING, 'Layout binding mismatch')
    require(layout['runId'] == RUN and layout['attempt'] == ATTEMPT, 'Layout run mismatch')
    found = discover(layout)
    if not args.materialize:
        print(json.dumps(readiness(layout, found), indent=2))
        return
    require(args.release is not None, '--release is required with --materialize')
    print(json.dumps(materialize(layout, found, args.release.resolve(), args.output.resolve()), indent=2))


if __name__ == '__main__':
    main()
