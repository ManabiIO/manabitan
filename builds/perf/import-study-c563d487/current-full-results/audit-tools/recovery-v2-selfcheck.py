#!/usr/bin/env python3
"""Replay artificial integrity cases and the observed leading-BOM log form only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


root = Path(__file__).resolve().parent
original = root / 'recovery-selfcheck-1/selfcheck-result.json'
assert sha(original) == 'ef5dca410949ba8b19f21f7ad1c69c2f407e3fb5b9ec027b2a5d296365d33fdd'
output = root / 'recovery-selfcheck-2'
output.mkdir(exist_ok=False)
source = root / 'recover-raw-archive-v2.py'
spec = importlib.util.spec_from_file_location('recovery_v2', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
old_result = json.loads(original.read_text())
cases = [(item['name'], (original.parent / item['name'] / 'artificial-job.log').read_text(), item['expectedPass'])
         for item in old_result['cases']]
valid = cases[0][1]
lines = valid.splitlines(keepends=True)
chunk_lines = [index for index, line in enumerate(lines) if 'MANABITAN_EVIDENCE_ARCHIVE_CHUNK ' in line]
assert len(chunk_lines) >= 3
for name, count, expected in [('one-leading-bom', 1, True), ('two-leading-boms-rejected', 2, False)]:
    changed = list(lines)
    changed[chunk_lines[2]] = '\ufeff' * count + changed[chunk_lines[2]]
    cases.append((name, ''.join(changed), expected))
changed = list(lines)
changed[chunk_lines[2]] = changed[chunk_lines[2]].replace('"data":"', '"data":"\ufeff', 1)
cases.append(('bom-inside-base64-rejected', ''.join(changed), False))
results = []
for name, log_text, expected in cases:
    directory = output / name
    directory.mkdir()
    log = directory / 'artificial-job.log'
    log.write_text(log_text)
    args = types.SimpleNamespace(log=log, output=directory/'recovered', dictionary='jmdict', order='AB', job_id=140933489138)
    error = None
    try:
        module.recover(args)
        passed = True
    except Exception as failure:
        passed = False
        error = {'type': type(failure).__name__, 'message': str(failure)}
    result = {'name': name, 'expectedPass': expected, 'passed': passed, 'error': error,
              'artificialLogSha256': sha(log), 'scope': 'Artificial log only; no original observation'}
    (directory/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    results.append(result)
    assert passed == expected, name
result = {'schemaVersion': 1, 'complete': True,
          'scope': 'The same13 artificial integrity cases plus the exact one-leading-BOM form and2 malformed-BOM cases; no original recovery or measurements',
          'sourceSha256': sha(source), 'selfcheckSha256': sha(Path(__file__)),
          'originalSelfcheckReceiptSha256': sha(original), 'cases': results,
          'allExpectedOutcomesMatched': True, 'acquisitionOrObservationsChanged': False}
path = output/'selfcheck-result.json'
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'resultSha256':sha(path),'cases':len(results),'accepted':sum(row['passed'] for row in results),
                  'rejected':sum(not row['passed'] for row in results)},indent=2))
