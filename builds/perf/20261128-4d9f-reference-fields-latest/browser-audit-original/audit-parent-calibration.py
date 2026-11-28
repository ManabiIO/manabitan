#!/usr/bin/env python3
"""Audit the distinct default-flag a300 allocation observation, not a candidate cohort."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('frozen_format_audit', ROOT / 'audit-format16c.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
artifact = ROOT / 'vndb-a300-storage-calibration-4d9f.zip'
expected_sha = 'a03b703d9e0e3ffe47edd953d8ba066911f70ea91d33d33557579eb2011cac5f'
assert artifact.stat().st_size == 17046324 and audit.file_digest(artifact) == expected_sha
output = ROOT / 'independent-parent-calibration'
raw, package = audit.unpack_artifact(artifact, output)
read = lambda path: json.loads(raw[path])
scope = read('registered-scope.json')
observation = read('parent-allocation-observation.json')
summary = read('observation/summary.json')
report = read('observation/run-1.json')
identity = read('package-identity.json')
pins = json.loads((ROOT / 'pinned-source-receipts.json').read_bytes())
assert package == identity
assert scope['source'] == observation['source'] == 'a300da36d00df8e353c5679b1528b50a1299b75f'
assert scope['tree'] == '5fe9ee5a3e2c27ce4e099cb3d6a598077027eac4'
assert scope['timingEligible'] is False and scope['memoryQualification'] is False
assert scope['candidateComparison'] is False and scope['observations'] == 1
assert scope['mediaCheck'] == 'all' and scope['importFlags'] is None
assert scope['priorFailedCohort'] == 46139342690
assert observation['status'] == 'observed-parent-only' and observation['timingEligible'] is False
assert observation['importFlags'] is None
assert audit.digest(raw['observation/run-1.json']) == observation['rawReportSha256'] == '3ea007adcaa5190860333540a6eb1fec87d24bd110b0315fe4235fb60e1bb07b'
assert all(step['returncode'] == 0 for step in read('steps.json'))
assert [step['name'] for step in read('steps.json')] == ['libs', 'license', 'build', 'fixture', 'import']
sizes = sorted(item['bytes'] for item in report['benchmark']['validation']['storage']['files'] if item['path'].startswith('manabitan/sqlite-sahpool-v1/.opaque/'))
assert sizes == observation['allSahSizes'] == [4096] * 7 + [315392]
assert observation['activeSahBytes'] == 315392 and observation['activeSahUnits'] == 77
validator_path = ROOT / 'independent-audit-1/reference-browser-jmdict-on-off-latest-4d9f/qualification_receipts.py'
assert audit.file_digest(validator_path) == '4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51'
validator = audit.import_pinned(validator_path, 'parent_calibration_validator')
source_hashes = {entry['path']: entry['sha256'] for entry in pins['pinnedSources'] if entry['key'] != 'validator'}
source_hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = pins['harness']['originalSha256']
source_hashes['builds/manabitan-chrome.zip'] = package['sha256']
source_hashes['builds/manabitan-chrome-dev.zip'] = None
receipt = validator.validate_import_summary(summary, report, dictionary='vndb',
    fixture=pins['fixture']['dictionaries']['vndb'], source_sha=scope['source'],
    package_sha256=package['sha256'], browser_version=summary['browserVersion'],
    import_flags=None, source_hashes=source_hashes, source_dirty=False, media_check='all',
    vndb_sah_allocation_units=[77, 77])
audit.write_json(output / 'independent-canonical-receipt.json', receipt)
result = {'schemaVersion': 1, 'artifactId': 15261649240, 'runId': 46140891339,
    'artifactSha256': expected_sha, 'artifactBytes': artifact.stat().st_size,
    'source': scope['source'], 'sourceTree': scope['tree'], 'packageSha256': package['sha256'],
    'packageEntryCount': len(package['entries']), 'rawReportSha256': observation['rawReportSha256'],
    'defaultFlags': True, 'activeSahBytes': 315392, 'activeSahUnits': 77, 'allSahSizes': sizes,
    'semanticReceiptRecomputed': True, 'lookupObservations': 72, 'allMediaVerified': True,
    'purpose': 'Independent parent-only allocation observation supporting the separately prospective exact77 contract.',
    'qualification': 'The caller-supplied77 value checks this calibration report; this does not retrospectively qualify either failed37 candidate cell.',
    'timingEligible': False, 'processMemoryMeasured': False, 'candidateComparison': False,
    'auditScriptSha256': audit.file_digest(Path(__file__)), 'commonAuditScriptSha256': audit.file_digest(ROOT / 'audit-format16c.py')}
audit.write_json(output / 'independent-audit.json', result)
print(json.dumps(result, sort_keys=True))
