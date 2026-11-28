#!/usr/bin/env python3
"""Collect already-completed original raw audits; never acquire or recompute observations."""
import datetime
import hashlib
import json
import sys
from pathlib import Path

BASE = Path('/workspace/scratch/c563d487c718/experiments')
TOOLS = Path(__file__).resolve().parent
ROOT = BASE / 'numeric-suffix-proof-consumer-982-full-evidence'
CELLS = ('jmdict-AB', 'jmdict-BA', 'jitendex-AB', 'jitendex-BA', 'vndb-AB', 'vndb-BA')
AUDITOR_SHA = '2dcd4c56bed134871a1cc35b5b05d170d73bca47aeb74ae38bbed9bb3ee6ace0'
RECOVERY_SHA = 'd23e55c961851b39dc0a000e4274500655bf3beee4f76f47ec0d6bce94a70330'
EXPECTED_SHA = '006d19ea2498cb3b561f084dba2c41b133c0c5b23a65137b8afb7756716f49f9'
BINDING_SHA = '5e53f0a6b260587d33b36b6d2198f4edcccbde74a541f9e4d1e53346bce6c6da'


def ref(path):
    raw = path.read_bytes()
    return {'path': str(path.relative_to(BASE)), 'bytes': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(),
            'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()}


def main(output):
    assert not output.exists(), 'Do not overwrite an earlier index'
    expected = json.loads((TOOLS / 'independent-complete-import-expected.json').read_bytes())
    binding = json.loads((TOOLS / 'publication-binding.json').read_bytes())
    pins = {'raw-evidence-audit-v3.py': AUDITOR_SHA, 'recover-raw-archive-v2.py': RECOVERY_SHA,
            'independent-complete-import-expected.json': EXPECTED_SHA, 'publication-binding.json': BINDING_SHA}
    for name, digest in pins.items():
        assert ref(TOOLS / name)['sha256'] == digest, name
    rows = []
    packages = {'A': set(), 'B': set()}
    semantics = {}
    policies = set()
    products = set()
    for cell in CELLS:
        directory = ROOT / cell
        raw = directory / 'raw-recovery-1'
        audit = json.loads((raw / 'independent-raw-evidence-audit.json').read_bytes())
        recovery = json.loads((raw / 'raw-archive-recovery.json').read_bytes())
        assert audit['auditIntegrityPassed'] and audit['all55PrimaryRecordsReconciled']
        assert audit['rawReports'] == 42 and audit['runId'] == 46141233321
        assert audit['auditorSha256'] == AUDITOR_SHA
        assert audit['expectedSha256'] == EXPECTED_SHA and audit['publicationBindingSha256'] == BINDING_SHA
        assert audit['dictionary'] + '-' + audit['order'] == cell
        assert audit['jobId'] == recovery['jobId'] == binding['jobs'][cell]
        assert recovery['recoverySourceSha256'] == RECOVERY_SHA
        assert recovery['publicationBindingSha256'] == BINDING_SHA
        assert ref(raw / 'raw-evidence-member-hashes.json')['sha256'] == audit['memberManifestSha256'] == recovery['memberHashManifestSha256']
        assert ref(raw / 'raw-evidence-manifest.json')['sha256'] == audit['archiveManifestSha256'] == recovery['manifestSha256']
        archive = ref(raw / 'raw-evidence.zip')
        assert archive['sha256'] == audit['zipSha256'] == recovery['archive']['sha256']
        assert archive['gitBlobSha1'] == recovery['archive']['gitBlobSha1']
        assert archive['bytes'] == audit['zipBytes'] == recovery['archive']['bytes']
        assert ref(raw / 'raw-archive-recovery.json')['sha256'] == audit['recoveryReceiptSha256']
        assert ref(raw / 'primary-records.jsonl')['sha256'] == audit['primaryRecordsSha256']
        assert (raw / 'primary-records.jsonl').read_bytes() == (directory / 'primary-records.jsonl').read_bytes()
        for arm in packages:
            assert audit['releasePackages'][arm]['entries'] == 582
            packages[arm].add(audit['releasePackages'][arm]['entryMapSha256'])
        semantics.setdefault(audit['dictionary'], set()).add(audit['completeCommonSemanticSha256'])
        policies.add(json.dumps(audit['frozenObserverSourceHashes'], sort_keys=True))
        products.add(json.dumps(audit['reviewedProductFiles'], sort_keys=True))
        rows.append({'cell': cell, 'jobId': audit['jobId'], 'audit': ref(raw / 'independent-raw-evidence-audit.json'),
                     'archive': archive, 'recovery': ref(raw / 'raw-archive-recovery.json'),
                     'memberManifest': ref(raw / 'raw-evidence-member-hashes.json'),
                     'originalLog': ref(directory / 'primary-job.log'),
                     'primaryRecords': ref(directory / 'primary-records.jsonl'),
                     'primaryAudit': ref(directory / 'primary-log-audit.json'),
                     'rawReports': audit['rawReports'], 'memberCount': audit['memberCount'],
                     'memory': audit['memory']['rawAudit'],
                     'memoryObservations': audit['memory']['observations'],
                     'semanticSha256': audit['completeCommonSemanticSha256'],
                     'releasePackages': audit['releasePackages']})
    assert all(len(values) == 1 for values in packages.values())
    assert len(semantics) == 3 and all(len(values) == 1 for values in semantics.values())
    assert len(policies) == len(products) == 1
    result = {'schemaVersion': 1, 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'All six original current-source raw archives/reports/process scans. Integrity and policy replay only; no new acquisition or performance decision.',
              'runId': 46141233321, 'toolingHead': expected['workflowCommit'],
              'baseline': expected['baseline'], 'candidate': expected['candidate'],
              'expected': ref(TOOLS / 'independent-complete-import-expected.json'),
              'publicationBinding': ref(TOOLS / 'publication-binding.json'),
              'recoverySource': ref(TOOLS / 'recover-raw-archive-v2.py'),
              'auditorSource': ref(TOOLS / 'raw-evidence-audit-v3.py'), 'indexBuilder': ref(Path(__file__).resolve()),
              'cells': rows, 'totals': {'completedCells': 6, 'rawReports': 252, 'primaryRecords': 330,
                'archiveMembers': sum(row['memberCount'] for row in rows), 'memoryObservations': 24,
                'qualifiedMemoryObservations': sum(sum(bool(v['qualifiedForWholeTreePss']) for v in row['memoryObservations']) for row in rows),
                'rawScans': sum(row['memory']['rawScanCount'] for row in rows)},
              'crossCellChecks': {'sameArm582EntryMapSha256': {k: next(iter(v)) for k, v in packages.items()},
                'sameDictionarySemanticSha256': {k: next(iter(v)) for k, v in semantics.items()},
                'sameFrozenPolicySources': True, 'sameReviewedEightProductFiles': True, 'allPass': True},
              'firstFourSnapshot': ref(ROOT / 'first-four-independent-raw-index.json'),
              'postprocessorHistory': {'originalV2Source': ref(TOOLS / 'raw-evidence-audit-v2.py'),
                'firstFailureFiles': [ref(p) for p in sorted((ROOT / 'jmdict-BA/raw-recovery-1').glob('raw-evidence-audit-failure-*.json'))],
                'amendment': ref(TOOLS / 'criteria-member-name-amendment.json'),
                'patch': ref(TOOLS / 'criteria-member-name-amendment.patch'),
                'independentReview': ref(TOOLS / 'criteria-member-name-independent-review.json'),
                'rootReview': ref(BASE / 'root-remote-continuation-20261128/a300-raw-auditor-filename-root-review.json')},
              'limits': ['No package ZIP bytes downloaded; retained original maps and separately logged hashes/sizes are reconciled.',
                         'Memory is sampled whole-browser process-tree data under unchanged a7f7 policy, not an exact peak.',
                         'Failed policy gates remain failed; this index never turns a missing coverage interval into a passing observation.',
                         'All original timing/control outliers remain; no pooling, subtraction, selected retry or old-source transfer.']}
    with output.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'index': ref(output), 'totals': result['totals'], 'crossCellChecks': result['crossCellChecks']}, indent=2))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve())
