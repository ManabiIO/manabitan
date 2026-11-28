#!/usr/bin/env python3
"""Replay existing VNDB artifacts with the recovered frozen auditor; acquire no measurements."""
from pathlib import Path
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request

REPO = 'ManabiIO/manabitan'
RUN = 46114043842
COMMIT = '8be0d1c54e537efabc25e34e01926bb898eb50df'
TREE = 'f0eb884d923ad6054112a9b47e1550709f22f1ee'
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
BASELINE_TREE = 'd99ea4d04658f7ec1c76acdc5f3684594212a471'
BRANCH = 'experiment/native-vndb-equality-component-20261128-eef4'
ROOT = Path('/workspace/scratch/eef400aacc1b')
JOBS = {'forward': 140883726945, 'reverse': 140883726734}
RECOVERY = [
    ('bench-work/audit-hosted-vndb-equality.py',
     '7595f07f3a752329834f84758456a890d751c547', 19099,
     'c03c9653994ff40adcba1cc8696066ed8e76f6ce43b7c8aab791566a12a72cf4', 'exact-original-bytes'),
    ('native-analysis/acquire-vndb-equality-artifact.py',
     '88dac6cbdd428edcfdf5af8ef631e08c7ecc6a0f', 5691,
     '59d3701d5268f616957e754fa9ec130682be055da53b9df712e623132fde822a', 'exact-original-bytes'),
    ('native-analysis/native-vndb-equality-publish-v1.json',
     '519b64d1908b6b1c4c0415b999fe7200d37abe1f', 7020,
     '18267065b3121ca0eb0ba491e5477a4453ef11c9cd97d6a52090e2f1da56d830', 'exact-original-bytes'),
    ('native-analysis/native-vndb-equality-hosted-publish-receipt.json',
     '6ff0befb16036035771bdf9cab16fbd3709e0852', 3905,
     '3d5cba2cf860ccf4ee7f279ef9296335a93e193b3652bdaa618099c0aa67bd9f',
     'semantic-reconstruction-from-retained-object-original-raw-file-hash-unknown'),
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def emit(label, value):
    print(label + ' ' + json.dumps(value, separators=(',', ':')), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def api_request(route):
    request = urllib.request.Request(
        'https://api.github.com/repos/' + REPO + route,
        headers={'Accept': 'application/vnd.github+json',
                 'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'X-GitHub-Api-Version': '2022-11-28',
                 'User-Agent': 'manabitan-offline-artifact-review'})
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=60)


def api_json(route):
    with api_request(route) as response:
        return json.load(response)


def git_identity(path):
    return subprocess.check_output(
        ['git', '-C', str(path), 'rev-parse', 'HEAD', 'HEAD^{tree}'], text=True).splitlines()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--order', choices=JOBS, required=True)
parser.add_argument('--campaign-checkout', type=Path, required=True)
parser.add_argument('--baseline-checkout', type=Path, required=True)
args = parser.parse_args()
cell = ROOT / 'bench-work/hosted-vndb-equality' / args.order
cell.mkdir(parents=True, exist_ok=True)
receipt_path = cell / 'offline-replay-receipt.json'
assert not receipt_path.exists(), 'Keep every offline replay attempt separately'
receipt = {
    'schema': 1, 'complete': False, 'order': args.order,
    'originalRun': RUN, 'originalJob': JOBS[args.order], 'originalCommit': COMMIT,
    'reviewRun': os.environ.get('GITHUB_RUN_ID'),
    'reviewAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
    'reviewCommit': os.environ.get('GITHUB_SHA'),
    'bridgeSha256': sha(Path(__file__).read_bytes()),
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Offline source/raw audit and unchanged summary replay only; zero new measurements.',
}
status = 1
save(receipt_path, receipt)
try:
    assert os.environ.get('GITHUB_REPOSITORY') == REPO
    frozen = args.campaign_checkout.resolve()
    baseline = args.baseline_checkout.resolve()
    assert git_identity(frozen) == [COMMIT, TREE]
    assert git_identity(baseline) == [BASELINE, BASELINE_TREE]
    (ROOT / 'native-analysis').mkdir(exist_ok=True)
    (ROOT / 'bench-work').mkdir(exist_ok=True)
    (ROOT / 'native-analysis/native-vndb-equality-hosted-v1').symlink_to(frozen, target_is_directory=True)
    (ROOT / 'bench-base').symlink_to(baseline, target_is_directory=True)
    module = baseline / 'ext/lib/term-bank-parser.wasm'
    module.parent.mkdir(parents=True, exist_ok=True)
    assert not module.exists()
    shutil.copyfile(baseline / 'dev/data/dictionary-wasm/term-bank-parser.wasm', module)
    assert sha(module.read_bytes()) == '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'
    recovered = []
    for relative, blob, size, expected, provenance in RECOVERY:
        value = api_json('/git/blobs/' + blob)
        assert value['sha'] == blob and value['encoding'] == 'base64'
        data = base64.b64decode(value['content'])
        assert len(data) == size == value['size'] and sha(data) == expected
        assert hashlib.sha1(('blob ' + str(size) + '\0').encode() + data).hexdigest() == blob
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
        retained = cell / 'recovered-inputs' / relative
        retained.parent.mkdir(parents=True, exist_ok=True)
        retained.write_bytes(data)
        recovered.append({'path': relative, 'gitBlob': blob, 'bytes': size,
                          'sha256': expected, 'recoveryProvenance': provenance})
    manifest = json.loads((ROOT / RECOVERY[2][0]).read_text())
    publication = json.loads((ROOT / RECOVERY[3][0]).read_text())
    assert manifest['baseline'] == BASELINE and manifest['baselineTree'] == BASELINE_TREE
    assert manifest['tree'] == publication['tree'] == TREE
    assert publication['commit'] == COMMIT and publication['diagnosticRun'] == RUN
    assert publication['branch'] == BRANCH and publication['allBlobsAndCompleteTreeVerified']
    frozen_alias = ROOT / 'native-analysis/native-vndb-equality-hosted-v1'
    for item in manifest['files']:
        assert Path(item['localPath']) == frozen_alias / item['path']
        assert sha(Path(item['localPath']).read_bytes()) == item['sha256']
    receipt['recoveredInputs'] = recovered
    receipt['allOriginalManifestFilesVerified'] = True
    save(receipt_path, receipt)

    run = api_json('/actions/runs/' + str(RUN))
    assert run['id'] == RUN and run['head_sha'] == COMMIT and run['run_attempt'] == 1
    assert run['head_branch'] == BRANCH and run['repository']['full_name'] == REPO
    assert run['path'] == '.github/workflows/native-vndb-equality-component-eef4.yml'
    jobs = api_json('/actions/runs/' + str(RUN) + '/jobs?filter=latest&per_page=100')
    assert jobs['total_count'] == len(jobs['jobs'])
    matches = [job for job in jobs['jobs'] if job['id'] == JOBS[args.order]]
    assert len(matches) == 1
    job = matches[0]
    assert job['run_id'] == RUN and job['head_sha'] == COMMIT and job['run_attempt'] == 1
    assert job['name'] == 'VNDB equality component (' + args.order + ')'
    assert job['status'] == 'completed', 'Original job is not ready; do not poll or acquire replacements'
    listing = api_json('/actions/runs/' + str(RUN) + '/artifacts?per_page=100')
    assert listing['total_count'] == len(listing['artifacts'])
    artifact_name = 'native-vndb-equality-component-eef4-' + args.order
    matches = [item for item in listing['artifacts'] if item['name'] == artifact_name]
    assert len(matches) == 1
    metadata = api_json('/actions/artifacts/' + str(matches[0]['id']))
    assert metadata['id'] == matches[0]['id'] and metadata['name'] == artifact_name
    assert metadata['workflow_run']['id'] == RUN and metadata['workflow_run']['head_sha'] == COMMIT
    assert not metadata['expired']
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', metadata['digest'])
    assert isinstance(metadata['size_in_bytes'], int) and 0 < metadata['size_in_bytes'] < 1000000000
    save(cell / 'original-provider-context.json', {'run': run, 'job': job, 'artifact': metadata})
    save(cell / 'artifact-metadata.json', metadata)
    try:
        with api_request('/actions/artifacts/' + str(metadata['id']) + '/zip'):
            raise AssertionError('Expected the original artifact API download redirect')
    except urllib.error.HTTPError as redirect:
        assert redirect.code == 302
        location = redirect.headers['Location']
    assert urllib.parse.urlsplit(location).scheme == 'https'
    # Authorization never follows the API redirect. Do not print or retain the signed URL.
    with urllib.request.urlopen(location, timeout=60) as response:
        data = response.read(metadata['size_in_bytes'] + 1)
    assert len(data) == metadata['size_in_bytes']
    assert sha(data) == metadata['digest'].removeprefix('sha256:')
    provider_directory = ROOT / 'private-provider-downloads'
    provider_directory.mkdir(exist_ok=True)
    provider_path = provider_directory / (args.order + '.zip')
    with provider_path.open('xb') as stream:
        stream.write(data)
    provider_path.chmod(0o600)
    del data
    reference = {'artifact_id': metadata['id'],
                 'file_uri': {'download_url': provider_path.as_uri()},
                 'provenance': 'Original provider ZIP independently downloaded and digest/size verified; local byte-identical replay transport.'}
    save(cell / 'artifact-reference.json', reference)
    (cell / 'artifact-reference.json').chmod(0o600)
    receipt['providerArchive'] = {'artifactId': metadata['id'], 'bytes': metadata['size_in_bytes'],
                                  'sha256': metadata['digest'].removeprefix('sha256:')}
    receipt['originalJobConclusion'] = job['conclusion']
    receipt['originalRunHeadAttemptAndJobVerified'] = True
    save(receipt_path, receipt)

    child_env = dict(os.environ)
    child_env.pop('GH_TOKEN', None)
    child_env.pop('GITHUB_TOKEN', None)
    wrapper = ROOT / 'native-analysis/acquire-vndb-equality-artifact.py'
    result = subprocess.run([sys.executable, str(wrapper), '--order', args.order],
                            cwd=ROOT, env=child_env, timeout=360)
    receipt['frozenWrapperExitCode'] = result.returncode
    receipt['frozenToolsUnchanged'] = all(sha((ROOT / row[0]).read_bytes()) == row[3] for row in RECOVERY)
    audit_path = cell / 'independent-audit.json'
    if audit_path.exists():
        audit = json.loads(audit_path.read_text())
        emit('ORIGINAL_ARTIFACT_AUDIT', {
            key: value for key, value in audit.items() if key not in {'files', 'cohorts'}})
        for item in audit['files']:
            emit('ORIGINAL_ARTIFACT_MEMBER', item)
        for cohort in audit['cohorts']:
            emit('COHORT_AUDIT', {
                key: value for key, value in cohort.items()
                if key not in {'comparisons', 'armMedians', 'rawPrefixChecks'}})
            for child in cohort.get('rawPrefixChecks', []):
                emit('CHILD_AUDIT', child)
    for summary_path in sorted(cell.glob('*-strict-summary-independent.json')):
        summary = json.loads(summary_path.read_text())
        emit('STRICT_SUMMARY_IDENTITY', {'path': summary_path.name, 'sha256': sha(summary_path.read_bytes())})
        emit('STRICT_SUMMARY_HEADER', {
            key: value for key, value in summary.items() if key not in {'comparisons', 'armMedians', 'perBlock'}})
        for metric, comparisons in summary['comparisons'].items():
            emit('STRICT_SUMMARY_COMPARISON', {'metric': metric, 'comparisons': comparisons})
        for arm, medians in summary['armMedians'].items():
            emit('STRICT_SUMMARY_ARM', {'arm': arm, 'medians': medians})
        for block in summary['perBlock']:
            emit('STRICT_SUMMARY_BLOCK', block)
    acquisition = json.loads((cell / 'acquisition-audit-receipt.json').read_text())
    emit('FROZEN_ACQUISITION_RECEIPT', acquisition)
    assert result.returncode == 0 and acquisition['complete']
    assert acquisition['allPrescribedObservationsPassed']
    assert acquisition['auditorUnchanged'] and receipt['frozenToolsUnchanged']
    receipt['complete'] = True
    status = 0
except BaseException as error:
    receipt['error'] = {'type': type(error).__name__, 'message': str(error)}
    traceback.print_exc()
finally:
    receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save(receipt_path, receipt)
    emit('OFFLINE_REPLAY_RECEIPT', receipt)
raise SystemExit(status)
