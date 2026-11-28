#!/usr/bin/env python3
"""Bind an unchanged independent auditor to the separate corrected cohort."""
import copy
import datetime
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPERIMENTS = HERE.parent
ORIGINAL = EXPERIMENTS / 'numeric-suffix-proof-consumer-audit'
CORRECTED = EXPERIMENTS / 'numeric-suffix-proof-consumer-corrected'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


source_path = ORIGINAL / 'expected.json'
assert sha(source_path) == '766b4371ffe2a3203a8ee40642b99c8807c2a5183d16157ee70f6b83bcb62c52'
binding_path = CORRECTED / 'tree/dev/perf/numeric-suffix-proof-consumer-c563d487/binding.json'
assert sha(binding_path) == '61d7d54b12c709e2c5275d187c11bf4370d5edaebc21c9ede8ee93cf57aff880'
publication_path = CORRECTED / 'publication.json'
assert sha(publication_path) == '8aa82613d4e5a0b892aede121774d472a23c885295f6598182cc824ad996383f'
old = json.loads(source_path.read_text())
binding = json.loads(binding_path.read_text())
publication = json.loads(publication_path.read_text())
assert publication['head'] == '2c6761f83bd88a8d88b269ef31e5e15fa6840c22'
assert publication['tree'] == 'd71df680d403dad8c801f57e70c3a7c86dae17ca'
assert publication['parent'] == old['publication']['commit']
assert publication['compare']['verified'] is True

expected = copy.deepcopy(old)
expected['recordedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
expected['publication'].update(
    runId=46136965050,
    runAttempt=1,
    commit=publication['head'],
    tree=publication['tree'],
    branch=publication['branch'],
)
expected['bindingSha256'] = sha(binding_path)
expected['binding'] = binding

changed = [key for key in old if old[key] != expected[key]]
assert changed == ['recordedAt', 'publication', 'bindingSha256', 'binding']
for name in ['baseline', 'candidateCSourceSha256', 'candidatePatchSha256',
             'dependencyLockSha256', 'fixtureLockSha256', 'criteriaSha256',
             'compiledBinaryPolicy']:
    assert old['binding'][name] == binding[name]
changed_tools = [key for key in old['binding']['toolingFiles']
                 if old['binding']['toolingFiles'][key] != binding['toolingFiles'][key]]
assert changed_tools == ['workflow.yml']
changed_tests = [key for key in old['binding']['qualificationFiles']
                 if old['binding']['qualificationFiles'][key] != binding['qualificationFiles'][key]]
assert changed_tests == ['term-bank-row-suffix-proof-consumer.test.js',
                         'term-bank-row-suffix-proof-fixtures.js']
assert binding['qualificationFiles'][changed_tests[0]] == 'a0555e2722459d2d1c9e1014fc39f6538d023ac8cd112b1c30eda8b3414c1732'
assert binding['qualificationFiles'][changed_tests[1]] == 'a49494534a0a3401e0e5ab80c876f08338ab9f2b3f822ab80a45b2b5a3a8cff4'
assert len(expected['baselineScreenSourceHashes']) == 11
assert len(expected['baselineNativeSourceHashes']) == 14

auditors = {
    'evidence_core.py': '26ae504a358edf263b45c9da575e02a548dfe00f50e370ff502e20ee90f88aaf',
    'audit-component.py': '6e007d90376d3195d14d0949e7aa23d72bc8bfe438cdec510b4ef29d3979da66',
    'audit-build.py': '77947b8202fbadf59e4bd1677ae7fe437a37a0159c1a65d727a440b7969a7f92',
}
for name, digest in auditors.items():
    assert sha(ORIGINAL / name) == digest

destination = HERE / 'expected.json'
with destination.open('x') as stream:
    stream.write(json.dumps(expected, indent=2) + '\n')
receipt = {
    'schema': 1,
    'finalizedBeforeAnyCorrectedMeasurementsConsumed': True,
    'recordedAt': expected['recordedAt'],
    'scope': 'Prospective identity amendment only for a separate corrected preflight/cohort. No acquisition, raw-observation, arithmetic, gate, or native-source change.',
    'originalExpectedSha256': sha(source_path),
    'correctedExpectedSha256': sha(destination),
    'bindingSha256': sha(binding_path),
    'publicationReceiptSha256': sha(publication_path),
    'publication': expected['publication'],
    'runDiscovery': {
        'source': 'Benchmark owner original GitHub run/job metadata; delivered before any corrected build result or component observation.',
        'createdAtUtc': '2026-11-28T10:49:18Z',
        'correctnessJobId': 140954302987,
        'statusAtBinding': 'in_progress/setup',
    },
    'changedTopLevelFields': changed,
    'changedToolingFiles': changed_tools,
    'changedQualificationFiles': changed_tests,
    'allOtherExpectedValuesEqual': True,
    'allElevenBaselineSourceHashesUnchanged': True,
    'allFourteenNativeInputHashesUnchanged': True,
    'allCriteriaFixtureSmokeDiagnosticAndArithmeticValuesUnchanged': True,
    'auditorFilesUnchanged': auditors,
    'originalFailedRunId': old['publication']['runId'],
    'originalExpectedAndAuditorFilesPreserved': True,
    'preparerSha256': sha(Path(__file__)),
    'interpretation': 'This binds only the new run identity and reviewed optional-wide-sequence test contract. A successful original build and all fixed raw observations are still required for any later conclusion.',
}
receipt_path = HERE / 'preparation-receipt.json'
with receipt_path.open('x') as stream:
    stream.write(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'expectedSha256': sha(destination), 'receiptSha256': sha(receipt_path),
                  'changedFields': changed, 'publication': expected['publication']}))
