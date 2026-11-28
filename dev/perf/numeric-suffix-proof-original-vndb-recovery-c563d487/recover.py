#!/usr/bin/env python3
"""Read-only export of an existing source-bound artifact; never execute it."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib

REPOSITORY = 'ManabiIO/manabitan'
ORIGINAL_RUN = 46136965050
ORIGINAL_ATTEMPT = 1
ORIGINAL_JOB = 140955527816
ORIGINAL_HEAD = '2c6761f83bd88a8d88b269ef31e5e15fa6840c22'
ARTIFACT_ID = 15260432499
ARTIFACT_NAME = 'suffix-proof-component-vndb-1'
ARTIFACT_BYTES = 281122
ARTIFACT_SHA = '6630e77afbb10681aee5faef58bd0b4aad47cd52b94715e93b346041ff18b3f5'
PRIMARY_BYTES = 136612
PRIMARY_SHA = '13372cf23c1684c9f35eb55a31caf30e074bc57d0b46e5e2a25958056c18a86b'
BINDING_SHA = '61d7d54b12c709e2c5275d187c11bf4370d5edaebc21c9ede8ee93cf57aff880'
SOURCE_ARTIFACT_ID = '15260257444'
SOURCE_ARTIFACT_SHA = '8f48ef25c5c8a9283981192db8402fadcdbba7cc3a02290b278c3d229470c1ee'
DIAGNOSTIC_SHA = '656dc9bf1e8f2090e798b50025b30a9851e8eee5cdc023e9970354636d5e2ac6'
DIAGNOSTIC_SOURCE_SHA = 'a73b93ab2e55ac68508663b13544ba51d310230a3c3801df5fbf9817bf1ffef8'
CHUNK_BYTES = 6144
MAX_MEMBER_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
OUT = Path(os.environ['GITHUB_WORKSPACE']) / 'builds/suffix-proof-original-vndb-recovery'
API = 'https://api.github.com/repos/' + REPOSITORY
stage = 'initialize'


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def identity(data):
    return {'bytes': len(data), 'sha256': sha(data),
            'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()}


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf-8')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def parse_json(data):
    def reject_constant(value):
        raise AssertionError('Nonfinite JSON constant')
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object, parse_constant=reject_constant)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        require(target.scheme == 'https', 'Only HTTPS redirects are allowed')
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and target.netloc != urllib.parse.urlsplit(req.full_url).netloc:
            redirected.remove_header('Authorization')
        return redirected


OPENER = urllib.request.build_opener(SafeRedirect())


def download(url, maximum, api_auth=True):
    require(url.startswith(API + '/'), 'Initial requests stay in the named repository API')
    headers = {'User-Agent': 'manabitan-original-evidence-recovery',
               'X-GitHub-Api-Version': '2022-11-28', 'Accept': 'application/vnd.github+json'}
    if api_auth:
        headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    request = urllib.request.Request(url, headers=headers)
    with OPENER.open(request, timeout=45) as response:
        data = response.read(maximum + 1)
    require(len(data) <= maximum, 'Download exceeds the fixed byte bound')
    return data


def safe_name(name):
    require(isinstance(name, str) and name and '\\' not in name and '\0' not in name,
            'Unsafe ZIP entry name')
    require(not any(ord(c) < 32 for c in name), 'Control character in ZIP entry name')
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(part not in ('', '.', '..') for part in path.parts),
            'Unsafe ZIP entry path')
    require(path.as_posix() == name.rstrip('/'), 'ZIP entry path normalization changed')


def put(name, data):
    safe_name(name)
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)


def emit(tag, value):
    print('SUFFIX_PROOF_ORIGINAL_RECOVERY_' + tag + ' ' +
          json.dumps(value, separators=(',', ':'), allow_nan=False), flush=True)


def export_file(name, data, role):
    info = identity(data)
    chunks = (len(data) + CHUNK_BYTES - 1) // CHUNK_BYTES
    emit('FILE', {'path': name, 'role': role, **info, 'chunks': chunks})
    for index in range(chunks):
        offset = index * CHUNK_BYTES
        part = data[offset:offset + CHUNK_BYTES]
        emit('CHUNK', {'path': name, 'index': index, 'offset': offset, 'bytes': len(part),
                       'base64': base64.b64encode(part).decode('ascii')})
    return chunks


try:
    require(not OUT.exists(), 'Never replace a recovery attempt')
    OUT.mkdir(parents=True)
    script_bytes = Path(__file__).read_bytes()
    require(sha(script_bytes) == os.environ['RECOVERY_SCRIPT_SHA256'], 'Reviewed recovery source hash')
    require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'Recovery repository identity')
    labels = [f'pair-{pair}-{arm}' for pair in range(4)
              for arm in ('ABCD' if pair % 2 == 0 else 'DCBA')] + ['diagnostic']
    expected_members = {label + '.' + suffix for label in labels
                        for suffix in ('stdout.json', 'stderr.log', 'child-status.json')}
    expected_members.update({
        'result.json', 'component-setup.json', 'compiled-source-binding.json',
        'correctness-result.json', 'diagnostic.wasm', 'diagnostic-source.c',
        'diagnostic-build.json', 'smoke-parity.json',
        'native-oracle/native-oracle.json', 'native-oracle/native-oracle-records.jsonl',
    })
    require(len(expected_members) == 61, 'Frozen producer inventory has61 regular files')

    stage = 'verify-original-api-identities'
    artifact_raw = download(API + '/actions/artifacts/' + str(ARTIFACT_ID), 65536)
    run_raw = download(API + '/actions/runs/' + str(ORIGINAL_RUN), 262144)
    job_raw = download(API + '/actions/jobs/' + str(ORIGINAL_JOB), 262144)
    artifact, run, job = map(parse_json, (artifact_raw, run_raw, job_raw))
    require(artifact['id'] == ARTIFACT_ID and artifact['name'] == ARTIFACT_NAME and
            artifact['size_in_bytes'] == ARTIFACT_BYTES and artifact['digest'] == 'sha256:' + ARTIFACT_SHA and
            artifact['expired'] is False, 'Exact original artifact API identity')
    require(artifact['workflow_run']['id'] == ORIGINAL_RUN and
            artifact['workflow_run']['head_sha'] == ORIGINAL_HEAD, 'Original artifact run/head')
    require(run['id'] == ORIGINAL_RUN and run['run_attempt'] == ORIGINAL_ATTEMPT and
            run['head_sha'] == ORIGINAL_HEAD and run['status'] == 'completed' and
            run['conclusion'] == 'success', 'Exact completed original run')
    require(job['id'] == ORIGINAL_JOB and job['run_id'] == ORIGINAL_RUN and
            job['head_sha'] == ORIGINAL_HEAD and job['status'] == 'completed' and
            job['conclusion'] == 'success', 'Exact completed original job')
    api_bytes = {'original-api/artifact.json': artifact_raw,
                 'original-api/run.json': run_raw, 'original-api/job.json': job_raw}
    for name, data in api_bytes.items():
        put(name, data)

    stage = 'download-and-verify-original-zip'
    original = download(API + '/actions/artifacts/' + str(ARTIFACT_ID) + '/zip', ARTIFACT_BYTES)
    require(len(original) == ARTIFACT_BYTES and sha(original) == ARTIFACT_SHA,
            'Original ZIP size/SHA mismatch before inspection')
    put('original-artifact.zip', original)

    stage = 'inspect-bounded-original-members'
    members = {}
    all_names = set()
    total = 0
    directory_names = []
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        infos = archive.infolist()
        require(len(infos) <= 80, 'ZIP entry count bound')
        for entry in infos:
            safe_name(entry.filename)
            require(entry.filename not in all_names, 'Duplicate ZIP entry')
            all_names.add(entry.filename)
            require((entry.flag_bits & 1) == 0, 'Encrypted ZIP entry rejected')
            require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    'Unexpected ZIP compression method')
            mode = (entry.external_attr >> 16) & 0xffff
            if entry.is_dir():
                require(entry.file_size == 0 and (stat.S_IFMT(mode) in (0, stat.S_IFDIR)),
                        'Invalid ZIP directory')
                directory_names.append(entry.filename)
                continue
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG), 'Nonregular ZIP member rejected')
            require(0 <= entry.file_size <= MAX_MEMBER_BYTES, 'ZIP member size bound')
            total += entry.file_size
            require(total <= MAX_TOTAL_BYTES, 'ZIP total size bound')
            data = archive.read(entry)
            require(len(data) == entry.file_size, 'Original member exact size')
            members[entry.filename] = data
    require(set(members) == expected_members, 'Exact frozen original member inventory')

    stage = 'verify-original-identity-crosslinks'
    result = parse_json(members['result.json'])
    setup = parse_json(members['component-setup.json'])
    require(result['complete'] is True and result['dictionary'] == 'vndb' and
            len(result['observations']) == 16 and result['diagnostic'] is not None,
            'Original completed16-observation cohort plus diagnostic')
    require(result['toolingHead'] == setup['toolingHead'] == ORIGINAL_HEAD and
            result['bindingSha256'] == setup['bindingSha256'] == BINDING_SHA,
            'Original source/binding crosslink')
    require(setup['sourceArtifactId'] == SOURCE_ARTIFACT_ID and
            setup['sourceArtifactDigest'].removeprefix('sha256:') == SOURCE_ARTIFACT_SHA,
            'Exact original successful correctness artifact')
    require(sha(members['diagnostic.wasm']) == DIAGNOSTIC_SHA and
            sha(members['diagnostic-source.c']) == DIAGNOSTIC_SOURCE_SHA,
            'Original diagnostic source/binary binding')
    child_crosslinks = []
    for label in labels:
        status = parse_json(members[label + '.child-status.json'])
        require(status['exitCode'] == 0 and
                status['stdoutSha256'] == sha(members[label + '.stdout.json']) and
                status['stderrSha256'] == sha(members[label + '.stderr.log']),
                'Original successful child stdout/stderr crosslink')
        parse_json(members[label + '.stdout.json'])
        child_crosslinks.append({'label': label, 'status': identity(members[label + '.child-status.json']),
                                 'stdout': identity(members[label + '.stdout.json']),
                                 'stderr': identity(members[label + '.stderr.log'])})
    require(parse_json(members['native-oracle/native-oracle.json'])['complete'] is True,
            'Original raw native oracle completed')

    stage = 'download-original-primary-log'
    primary = download(API + '/actions/jobs/' + str(ORIGINAL_JOB) + '/logs', 4 * 1024 * 1024)
    put('primary-job.log', primary)
    primary_agrees = len(primary) == PRIMARY_BYTES and sha(primary) == PRIMARY_SHA
    for name, data in members.items():
        put('original-members/' + name, data)

    manifest = {
        'schema': 1,
        'scope': 'Read-only transport/byte binding of existing artifacts and logs. No benchmark, native execution, test, corpus acquisition, observer rerun or result substitution.',
        'originalRunId': ORIGINAL_RUN, 'originalRunAttempt': ORIGINAL_ATTEMPT,
        'originalJobId': ORIGINAL_JOB, 'originalHead': ORIGINAL_HEAD,
        'artifactId': ARTIFACT_ID, 'artifactName': ARTIFACT_NAME,
        'originalZip': identity(original),
        'originalRegularMemberCount': len(members), 'originalDirectoryEntries': directory_names,
        'originalMembers': {name: identity(members[name]) for name in sorted(members)},
        'originalChildCrosslinks': child_crosslinks,
        'sourceApiResponses': {name: identity(data) for name, data in api_bytes.items()},
        'primaryLog': identity(primary), 'priorConnectorPrimaryLog': {'bytes': PRIMARY_BYTES, 'sha256': PRIMARY_SHA},
        'primaryLogMatchesPriorConnectorBytes': primary_agrees,
        'recoverySource': identity(script_bytes),
        'recoveryPython': sys.version, 'recoveryZlib': zlib.ZLIB_RUNTIME_VERSION,
        'recoveryToolingHead': os.environ['GITHUB_SHA'],
        'recoveryRunId': os.environ['GITHUB_RUN_ID'],
        'recoveryRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'frozenIndependentComponentAuditorSha256': '6e007d90376d3195d14d0949e7aa23d72bc8bfe438cdec510b4ef29d3979da66',
        'frozenIndependentComponentAuditorExecutedHere': False,
        'limitation': 'This layer proves transport identity, complete original inventory and child hashes only. The unavailable original6e00/core26ae replay remains not-run for VNDB; independent cloud reconciliation is a separately identified layer.',
    }
    manifest_bytes = json_bytes(manifest)
    put('recovery-manifest.json', manifest_bytes)
    deterministic = {**{'artifact/' + name: data for name, data in members.items()},
                     **api_bytes, 'primary-job.log': primary, 'recovery-manifest.json': manifest_bytes}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as selected:
        for name in sorted(deterministic):
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            selected.writestr(entry, deterministic[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    selected_bytes = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(selected_bytes)) as selected:
        require(set(selected.namelist()) == set(deterministic), 'Deterministic ZIP roundtrip inventory')
        for name, data in deterministic.items():
            require(selected.read(name) == data, 'Deterministic ZIP byte roundtrip')
    put('recovered-original-files.zip', selected_bytes)

    stage = 'emit-exact-original-bytes'
    exports = {'original-artifact.zip': original, 'recovered-original-files.zip': selected_bytes,
               'primary-job.log': primary, 'recovery-manifest.json': manifest_bytes,
               'recovery-source.py': script_bytes, **api_bytes,
               **{'original-members/' + name: data for name, data in members.items()}}
    emit('START', {'schema': 1, 'files': len(exports), 'chunkBytes': CHUNK_BYTES,
                   'originalArtifact': identity(original), 'recoverySource': identity(script_bytes),
                   'recoveryHead': os.environ['GITHUB_SHA'], 'originalRunId': ORIGINAL_RUN})
    chunks = 0
    for name in sorted(exports):
        role = 'original-member' if name.startswith('original-members/') else 'transport-or-provenance'
        chunks += export_file(name, exports[name], role)
    emit('COMPLETE', {'files': len(exports), 'chunks': chunks,
                      'originalArtifact': identity(original), 'recoveredZip': identity(selected_bytes),
                      'manifest': identity(manifest_bytes), 'primaryAgrees': primary_agrees,
                      'frozenAuditorExecuted': False})
    require(primary_agrees, 'Original raw API log differs from the prior connector byte receipt')
except Exception as error:
    failure = {'schema': 1, 'complete': False, 'stage': stage, 'failureType': type(error).__name__,
               'originalRunId': ORIGINAL_RUN, 'artifactId': ARTIFACT_ID,
               'noMeasurementsOrNativeExecution': True}
    if isinstance(error, AssertionError):
        failure['assertion'] = str(error)
    if OUT.exists():
        path = OUT / 'recovery-failure.json'
        if not path.exists():
            path.write_bytes(json_bytes(failure))
    emit('FAILURE', failure)
    raise SystemExit(1)
