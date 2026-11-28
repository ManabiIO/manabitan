"""Retain one provider ZIP and run the frozen read-only audit once."""
from pathlib import Path
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time
import traceback
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
AUDITOR = ROOT / 'bench-work/audit-hosted-vndb-equality.py'
AUDITOR_SHA256 = 'c03c9653994ff40adcba1cc8696066ed8e76f6ce43b7c8aab791566a12a72cf4'
RUN_ID = 46114043842
COMMIT = '8be0d1c54e537efabc25e34e01926bb898eb50df'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--order', choices=['forward', 'reverse'], required=True)
args = parser.parse_args()
cell = ROOT / 'bench-work/hosted-vndb-equality' / args.order
metadata_path = cell / 'artifact-metadata.json'
reference_path = cell / 'artifact-reference.json'
receipt_path = cell / 'acquisition-audit-receipt.json'
archive_path = cell / 'artifact.zip'
assert not receipt_path.exists() and not archive_path.exists(), 'Preserve every first acquisition'
assert sha(AUDITOR.read_bytes()) == AUDITOR_SHA256
metadata = json.loads(metadata_path.read_text())
reference = json.loads(reference_path.read_text())
assert metadata['name'] == f'native-vndb-equality-component-eef4-{args.order}'
assert metadata['workflow_run']['id'] == RUN_ID
assert metadata['workflow_run']['head_sha'] == COMMIT
assert reference['artifact_id'] == metadata['id']
assert not metadata['expired'] and metadata['digest'].startswith('sha256:')
expected_sha = metadata['digest'].removeprefix('sha256:')
assert len(expected_sha) == 64
reference_path.chmod(0o600)

with (ROOT / 'bench-work/runner.lock').open('a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    owner = ROOT / 'bench-work/runner-owner.json'
    owner.write_text(json.dumps({'agent': 'native_analysis', 'phase': f'vndb-equality-{args.order}-artifact-audit',
                                'pid': os.getpid(), 'startedAt': now()}, indent=2) + '\n')
    receipt = {'schema': 1, 'order': args.order, 'startedAt': now(), 'complete': False,
               'artifactId': metadata['id'], 'workflowRun': RUN_ID, 'workflowCommit': COMMIT,
               'artifactMetadataSha256': sha(metadata_path.read_bytes()),
               'artifactReferenceSha256': sha(reference_path.read_bytes()),
               'auditorSha256': AUDITOR_SHA256, 'acquisitionWrapperSha256': sha(Path(__file__).read_bytes()),
               'scope': 'Read-only artifact retention and audit; zero new benchmark observations.'}

    def save():
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')

    save()
    status = 1
    try:
        with urllib.request.urlopen(reference['file_uri']['download_url'], timeout=60) as response:
            with archive_path.open('xb') as archive:
                while chunk := response.read(1024 * 1024):
                    archive.write(chunk)
        data = archive_path.read_bytes()
        receipt['archive'] = {'path': str(archive_path), 'bytes': len(data), 'sha256': sha(data)}
        save()
        assert len(data) == metadata['size_in_bytes'] and sha(data) == expected_sha
        del data
        receipt['wholeArchiveVerified'] = True
        command = [sys.executable, str(AUDITOR), '--cell', str(cell), '--order', args.order,
                   '--artifact-id', str(metadata['id']), '--bytes', str(metadata['size_in_bytes']),
                   '--sha256', expected_sha]
        receipt['auditCommand'] = command
        save()
        started = time.monotonic()
        log_path = cell / 'independent-audit.log'
        with log_path.open('xb') as log:
            process = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        receipt['auditExitCode'] = process.returncode
        receipt['auditElapsedSeconds'] = time.monotonic() - started
        receipt['auditLogSha256'] = sha(log_path.read_bytes())
        assert process.returncode == 0
        audit_path = cell / 'independent-audit.json'
        audit = json.loads(audit_path.read_text())
        receipt['independentAuditSha256'] = sha(audit_path.read_bytes())
        receipt['allPrescribedObservationsPassed'] = audit['complete']
        receipt['cohortStatuses'] = [{key: item.get(key) for key in ['candidate', 'status', 'complete']}
                                    for item in audit['cohorts']]
        receipt['complete'] = True
        status = 0
    except BaseException as error:
        receipt['error'] = {'type': type(error).__name__, 'message': str(error)}
        traceback.print_exc()
    finally:
        receipt['finishedAt'] = now()
        receipt['auditorSha256After'] = sha(AUDITOR.read_bytes())
        receipt['auditorUnchanged'] = receipt['auditorSha256After'] == AUDITOR_SHA256
        if not receipt['auditorUnchanged']:
            receipt['complete'] = False
            receipt['error'] = {'type': 'FrozenAuditorChanged',
                                'message': 'The exact reviewed auditor changed during artifact validation',
                                'previousError': receipt.get('error')}
            status = 1
        save()
        owner.write_text(json.dumps({'agent': 'native_analysis', 'phase': 'released',
                                    'previous': f'vndb-equality-{args.order}-artifact-audit',
                                    'finishedAt': now()}, indent=2) + '\n')
print(json.dumps({key: receipt.get(key) for key in ['order', 'complete', 'allPrescribedObservationsPassed', 'cohortStatuses', 'error']}))
sys.exit(status)
