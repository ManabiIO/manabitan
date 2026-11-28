"""Verify one fixed-cohort artifact, retain its complete census, or summarize its audit."""
import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import stat
import statistics
import zipfile


RUN = 46127721419
HEAD = '477fb271ef25fac533fb1faf737a5dab898190e3'


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def file_sha(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def extract(args):
    artifact = read(args.metadata)
    run = read(args.run)
    job = read(args.job)
    expected_name = f'crc-no-unroll-browser-beb5-{args.dictionary}-AB'
    expected_job = f'Frozen CRC imports ({args.dictionary}, 12 pairs)'
    assert run['id'] == RUN and run['run_attempt'] == 1 and run['head_sha'] == HEAD
    assert run['head_branch'] == 'test/crc-no-unroll-browser-20261128-beb5'
    assert run['head_commit']['tree_id'] == 'f4b08d4dfc6f2493336a5318c20c4f2b64b90593'
    assert job['run_id'] == RUN and job['run_attempt'] == 1 and job['head_sha'] == HEAD
    assert job['head_branch'] == run['head_branch']
    assert job['name'] == expected_job and job['status'] == 'completed'
    uploads = [step for step in job['steps'] if step['name'] == 'Retain every original package, observation and failure']
    assert len(uploads) == 1 and uploads[0]['status'] == 'completed' and uploads[0]['conclusion'] == 'success'
    assert artifact['name'] == expected_name
    assert artifact['workflow_run']['id'] == RUN
    assert artifact['workflow_run']['head_sha'] == HEAD
    assert not artifact['expired']
    expected_digest = artifact['digest']
    assert expected_digest.startswith('sha256:') and len(expected_digest) == 71
    actual_digest = file_sha(args.zip)
    assert args.zip.stat().st_size == artifact['size_in_bytes'], 'Outer archive size differs'
    assert actual_digest == expected_digest[7:], 'Outer archive digest differs'
    assert not args.out.exists(), 'Never replace an extraction'
    rows = []
    with zipfile.ZipFile(args.zip) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        assert len(names) == len(set(names)), 'Duplicate member'
        for entry in entries:
            path = PurePosixPath(entry.filename)
            assert not path.is_absolute() and '..' not in path.parts
            assert str(path) == entry.filename.rstrip('/')
            assert not stat.S_ISLNK(entry.external_attr >> 16), 'Symlink member'
        args.out.mkdir(parents=True)
        for entry in entries:
            destination = args.out.joinpath(*PurePosixPath(entry.filename).parts)
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                rows.append({'name': entry.filename, 'directory': True, 'bytes': 0})
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            count = 0
            with archive.open(entry) as source, destination.open('xb') as target:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    target.write(block)
                    digest.update(block)
                    count += len(block)
            assert count == entry.file_size
            rows.append({'name': entry.filename, 'bytes': count, 'sha256': digest.hexdigest(),
                         'compressedBytes': entry.compress_size, 'zipCrc32': entry.CRC})
    report = {'complete': True, 'dictionary': args.dictionary, 'runId': RUN, 'studyCommit': HEAD,
              'runAttempt': 1, 'jobId': job['id'], 'jobName': job['name'], 'jobConclusion': job['conclusion'],
              'jobJoin': 'Exact frozen matrix job name, run/head/attempt and successful retained-artifact upload step; artifact API has no direct job ID.',
              'runApiSha256': file_sha(args.run), 'jobApiSha256': file_sha(args.job),
              'artifactApiSha256': file_sha(args.metadata),
              'artifactId': artifact['id'], 'artifactName': expected_name,
              'archive': str(args.zip), 'bytes': args.zip.stat().st_size, 'sha256': actual_digest,
              'extraction': str(args.out), 'memberCount': len(rows), 'members': rows,
              'omittedMembers': [],
              'packageMembers': [name for name in names if name in ['package-A.zip', 'package-B.zip']],
              'fullPackagesRetained': all(name in names for name in ['package-A.zip', 'package-B.zip'])}
    write(args.census, report)
    print(json.dumps({key: report[key] for key in ['complete', 'dictionary', 'artifactId', 'bytes', 'sha256', 'memberCount']}))


def differences(rows, kind, metric=None):
    other = 'B' if kind == 'candidate' else 'C'
    grouped = {}
    for row in rows:
        if row['kind'] != kind:
            continue
        value = row['totalImportMs'] if metric is None else row['phases'].get(metric)
        if type(value) not in (int, float):
            return {'available': False}
        assert math.isfinite(value)
        grouped.setdefault(row['pair'], {})[row['arm']] = value
    result = []
    for pair, values in sorted(grouped.items()):
        assert set(values) == {'A', other}
        result.append({'pair': pair, 'baselineMs': values['A'], 'otherMs': values[other],
                       'differenceMs': values[other] - values['A']})
    assert len(result) == (12 if kind == 'candidate' else 4)
    deltas = [row['differenceMs'] for row in result]
    return {'available': True, 'pairs': result, 'medianPairedDifferenceMs': statistics.median(deltas),
            'meanPairedDifferenceMs': statistics.mean(deltas), 'sumDifferenceMs': sum(deltas),
            'minimumDifferenceMs': min(deltas), 'maximumDifferenceMs': max(deltas),
            'fasterPairs': sum(value < 0 for value in deltas)}


def summarize(args):
    audit = read(args.audit)
    census = read(args.census)
    assert census['complete'] is True and census['runId'] == RUN and census['studyCommit'] == HEAD
    assert census['runAttempt'] == 1 and census['omittedMembers'] == []
    extraction = Path(census['extraction']).resolve()
    assert args.audit.resolve().parent == extraction
    members = {row['name']: row for row in census['members'] if not row.get('directory')}
    for name in ['qualification-source-identities.json', 'observations.json']:
        assert file_sha(extraction / name) == members[name]['sha256']
    source = read(extraction / 'qualification-source-identities.json')
    assert source['studyCommit'] == HEAD and source['studyTree'] == 'f4b08d4dfc6f2493336a5318c20c4f2b64b90593'
    assert source['preflightComplete'] is True and source['trackedSourceClean'] is True
    assert audit['complete'] is True
    assert audit['dictionary'] == census['dictionary']
    assert audit['candidateSourceCommit'] == '19db774b564064a7e339d3c3a79ea8da04ab48b5'
    assert audit['baseline'] == 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
    rows = audit['ordinaryObservations']
    fields = ['id', 'kind', 'pair', 'arm', 'totalImportMs']
    project = lambda items: [{key: row[key] for key in fields} for row in items]
    assert project(rows) == project(read(extraction / 'observations.json'))
    result = {'dictionary': audit['dictionary'], 'runId': RUN, 'studyCommit': HEAD,
              'artifactId': census['artifactId'], 'jobId': census['jobId'],
              'originalArchiveSha256': census['sha256'], 'censusSha256': file_sha(args.census),
              'independentAuditSha256': file_sha(args.audit),
              'candidate': {'relative': audit['candidate'], 'absolute': differences(rows, 'candidate')},
              'control': {'relative': audit['control'], 'absolute': differences(rows, 'control')},
              'sourceInflate': {
                  'candidate': differences(rows, 'candidate', 'parserSourceInflateMs'),
                  'control': differences(rows, 'control', 'parserSourceInflateMs'),
                  'scope': 'Inflation plus immediate whole-bank CRC; aggregated worker duration, not a complete-import timer.'},
              'deferredSourceCrc': {
                  'candidate': differences(rows, 'candidate', 'parserSourceCrcMs'),
                  'control': differences(rows, 'control', 'parserSourceCrcMs'),
                  'scope': 'Deferred verification inside parsing; separate from immediate CRC within inflation. Do not add overlapping phases.'},
              'termParse': {
                  'candidate': differences(rows, 'candidate', 'step4.termParseMs'),
                  'control': differences(rows, 'control', 'step4.termParseMs'),
                  'scope': 'Parser-phase diagnostic; complete-import elapsed time remains primary.'},
              'memoryPassed': audit['memoryPassed'], 'memoryAudit': audit['memoryAudit'],
              'memoryReceiptFailures': audit['memoryReceiptFailures'],
              'validatedObservationCount': audit['validatedObservationCount'],
              'noPooling': True, 'noControlSubtraction': True, 'noTrimmingOrReplacement': True}
    write(args.out, result)
    print(json.dumps({key: result[key] for key in ['dictionary', 'candidate', 'control', 'memoryPassed', 'validatedObservationCount']}))


parser = argparse.ArgumentParser(description=__doc__)
commands = parser.add_subparsers(dest='command', required=True)
command = commands.add_parser('extract')
command.add_argument('dictionary', choices=['jmdict', 'jitendex', 'vndb'])
command.add_argument('--zip', type=Path, required=True)
command.add_argument('--metadata', type=Path, required=True)
command.add_argument('--run', type=Path, required=True)
command.add_argument('--job', type=Path, required=True)
command.add_argument('--out', type=Path, required=True)
command.add_argument('--census', type=Path, required=True)
command.set_defaults(function=extract)
command = commands.add_parser('summarize')
command.add_argument('--audit', type=Path, required=True)
command.add_argument('--census', type=Path, required=True)
command.add_argument('--out', type=Path, required=True)
command.set_defaults(function=summarize)
arguments = parser.parse_args()
arguments.function(arguments)
