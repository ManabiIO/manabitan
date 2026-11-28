#!/usr/bin/env python3
"""Check the immutable complete-copy archive; no import or benchmark."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest = json.loads((root / 'manifest.json').read_bytes())
for file in manifest['files']:
    data = (root / file['path']).read_bytes()
    assert len(data) == file['sizeBytes'] and sha(data) == file['sha256'], file['path']
members = {}
with tarfile.open(fileobj=io.BytesIO((root / 'evidence.tar.gz').read_bytes()), mode='r:gz') as archive:
    assert set(archive.getnames()) == {item['path'] for item in manifest['members']}
    for item in manifest['members']:
        data = archive.extractfile(item['path']).read()
        assert len(data) == item['sizeBytes'] and sha(data) == item['sha256'], item['path']
        members[item['path']] = data

report_raw = members['complete-run/oracle/manifest.json']
assert sha(report_raw) == '3332a215bafffe09f0402fcabeb498bc0ce7cb45245de8e3ff78943eb122339f'
report = json.loads(report_raw)
monitor = json.loads(members['complete-run/monitor-receipt.json'])
reference = json.loads(members['hosted-package/reference-manifest.json'])
assert report['complete'] and report['failures'] == []
assert report['node'] == 'v24.22.3' and report['candidateCommit'] == 'e90c4c04172b691985858609094887f9541541dd'
assert monitor['complete'] and monitor['status'] == 'passed' and monitor['exitCode'] == 0
assert monitor['resourceAbort'] is None and monitor['failures'] == [] and monitor['priorPartialGroupsReused'] == 0
assert monitor['postSourceIdentityExact']
assert sha(members['hosted-package/reference-manifest.json']) == report['fixtureManifestSha256'] == '810c067eabf70271a5440775751420ce065e3bfc1ce2a47bfd2cb61c4876a8a2'
expected = {group['groupKey']: group for group in reference['groups']}
seen = set()
totals = {'sourceRows': 0, 'mediaRows': 0, 'preparedIndexes': 0, 'preparedRoutes': 0}
for item in report['groups']:
    data = members['complete-run/oracle/' + item['receiptFile']]
    assert sha(data) == item['receiptSha256']
    group = json.loads(data)
    assert group['groupKey'] not in seen
    seen.add(group['groupKey'])
    prior = expected[group['groupKey']]
    assert group['files'] == prior['files']
    assert group['sourceRows'] == prior['sourceRows']
    assert group['mediaRows'] == prior['counts']['mediaRows']
    assert group['copiedOutputSha256'] == prior['copiedOutputSha256']
    assert group['preparedIndexes'] == group['preparedRoutes'] == 1
    assert group['complete'] and group['sameModulePublicCopyFullAliasParity'] and group['frozenBaselineFullValueByteParity']
    assert group['exactRawSourceAndColumnsUnchanged'] and group['nativeHeapAndBufferUnchanged'] and not group['aliasNormalization']
    for key in totals:
        totals[key] += group[key]
assert seen == set(expected) and len(seen) == 170
assert totals == {'sourceRows': 6648310, 'mediaRows': 146725, 'preparedIndexes': 170, 'preparedRoutes': 170}
assert report['rows'] == totals['sourceRows'] and report['mediaRows'] == totals['mediaRows']
assert report['preparedIndexes'] == report['preparedRoutes'] == 170
assert report['privateContentGroups'] == 170 and report['shareContentGroups'] == 0
assert report['fallbackReads'] == 0 and report['exactPlannerGroupsMatch'] and not report['aliasNormalization']
for source in manifest['loadedSourceMapping']:
    assert sha(members[source['member']]) == source['sha256']
print(json.dumps({'status': 'passed', 'scope': 'Archived-data verification only; no imports or timings',
    'members': len(members), 'groups': len(seen), 'totals': totals,
    'oracleManifestSha256': sha(report_raw), 'bundleManifestSha256': sha((root / 'manifest.json').read_bytes())}, sort_keys=True))
