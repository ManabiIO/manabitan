#!/usr/bin/env python3
"""Audit saved CI receipts without rebuilding or executing tests."""
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent
index = json.loads((root / 'index.json').read_text())
manifest_bytes = (root / 'manifest.json').read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest() == index['manifestSha256']
manifest = json.loads(manifest_bytes)
payload = (root / 'hosted-validation-evidence.zip').read_bytes()
assert len(payload) == index['bytes']
assert hashlib.sha256(payload).hexdigest() == index['sha256']
with zipfile.ZipFile(io.BytesIO(payload)) as archive:
    assert set(archive.namelist()) == set(manifest['files'])
    data = {}
    for name, entry in manifest['files'].items():
        raw = archive.read(name)
        assert len(raw) == entry['bytes']
        assert hashlib.sha256(raw).hexdigest() == entry['sha256']
        data[name] = raw
audit = json.loads(data['hosted-validation-audit.json'])
assert audit['status'] == 'passed'
assert (audit['runId'], audit['jobId']) == (46113567719, 140882253628)
assert hashlib.sha256(data['validation-source-comparison.json']).hexdigest() == audit['source']['comparisonSha256']
assert hashlib.sha256(data['validation-workflow-d36ee85.yml']).hexdigest() == audit['source']['workflowSha256']
comparison = json.loads(data['validation-source-comparison.json'])
assert comparison['status'] == 'ahead' and comparison['behindBy'] == 0
assert len(comparison['files']) == audit['source']['changedFiles'] == 60
assert all(row['filename'].startswith(('dev/perf/', '.github/workflows/')) for row in comparison['files'])
assert 'e90c4c04172b691985858609094887f9541541dd...d36ee85feb1513af31f769175affa33b3696a307' in comparison['url']
jobs = json.loads(data['monitor-46113567719-2.json'])['jobs']
job = next(row for row in jobs if row['id'] == audit['jobId'])
assert job['status'] == 'completed' and job['conclusion'] == 'success'
assert all(step['status'] == 'completed' and step['conclusion'] == 'success' for step in job['steps'])
artifact = data['parser-path-validation-15253361929.zip']
assert len(artifact) == audit['archiveBytes'] == 47103
assert hashlib.sha256(artifact).hexdigest() == audit['archiveSha256'] == '9df4dd5b1b7ffc14277ed149e9c705084f365a0e4f8df6844506d7bfb705a5e5'
assert audit['artifact']['digest'] == 'sha256:' + audit['archiveSha256']
with zipfile.ZipFile(io.BytesIO(artifact)) as original:
    assert original.testzip() is None
    assert set(original.namelist()) == set(audit['files'])
    for name, identity in audit['files'].items():
        raw = original.read(name)
        assert len(raw) == identity['bytes']
        assert hashlib.sha256(raw).hexdigest() == identity['sha256']
    log = re.sub(r'\x1b\[[0-9;]*m', '', original.read('validation.log').decode())
assert re.search(r'Test Files\s+669 passed\s+\(669\)', log)
assert re.search(r'Tests\s+15159 passed\s+\|\s+47 skipped\s+\(15206\)', log)
build_marker = '> node ./dev/bin/build.js --dryRun --all\n'
assert log.count(build_marker) == 1
targets = re.findall(r'^Building ([\w-]+)\.\.\.$', log.split(build_marker, 1)[1], re.M)
assert targets == audit['checks']['targets'] == ['chrome', 'chrome-dev', 'chrome-playwright', 'firefox', 'firefox-dev', 'firefox-android', 'edge']
job_log = data['validation-job-140882253628.log'].decode()
assert 'node: v22.22.0' in job_log
print(json.dumps({'integrity': 'passed', 'savedFiles': len(data), 'completeHostedValidation': 'passed',
                  'unitFiles': 669, 'passedTests': 15159, 'skippedTests': 47,
                  'dryBuildTargets': len(targets), 'newExecutions': 0, 'browserResults': 'separate'}))
