#!/usr/bin/env python3
"""Combine only complete, source-bound correctness partitions; never timings."""
import argparse
import collections
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parts-dir', type=Path, required=True)
parser.add_argument('--runner', type=Path, required=True)
parser.add_argument('--manifest', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
digest = lambda data: hashlib.sha256(data).hexdigest()
manifest_bytes = args.manifest.read_bytes()
manifest = json.loads(manifest_bytes)
runner_sha = digest(args.runner.read_bytes())
manifest_sha = digest(manifest_bytes)
parts = [('jmdict-full', 'jmdict', 0, 0), ('jitendex-full', 'jitendex', 0, 0)]
parts.extend((f'vndb-{start + 1:03d}-{min(start + 32, 170):03d}', 'vndb', start, 32)
             for start in [0, 32, 64, 96, 128, 160])
sources = None
require_plan = None
node = None
grouping = None
merged = {}
receipts = []
for name, dictionary, start, count in parts:
    file = args.parts_dir / f'{name}.json'
    raw = file.read_bytes()
    part = json.loads(raw)
    assert part['schema'] == 3 and part['correctnessOnly'] is True, name
    assert part['partComplete'] is True, f'Interrupted partition: {name}'
    assert part['runnerSha256'] == runner_sha, name
    assert part['groupManifestSha256'] == manifest_sha, name
    assert part['lockSha256'] == manifest['lockSha256'], name
    assert part['selection'] == {'groupStart': start, 'groupCount': count}, name
    assert len(part['dictionaries']) == 1, name
    if sources is None:
        sources = part['sources']
        require_plan = part['requirePlan']
        node = part['node']
        grouping = part['grouping']
    assert part['sources'] == sources, f'Source identity differs: {name}'
    assert part['requirePlan'] == require_plan and part['node'] == node and part['grouping'] == grouping, name
    data = part['dictionaries'][0]
    assert data['dictionary'] == dictionary, name
    expected = manifest['dictionaries'][dictionary]
    assert data['archiveSha256'] == expected['archiveSha256'], name
    assert data['expectedGroups'] == len(expected['groups']), name
    selected = expected['groups'][start:start + count] if count else expected['groups'][start:]
    assert data['selectedGroupStart'] == start and data['selectedGroupCount'] == len(selected), name
    assert len(data['groups']) == len(selected), name
    assert part['complete'] is (start == 0 and len(selected) == len(expected['groups'])), name
    if dictionary not in merged:
        merged[dictionary] = {'dictionary': dictionary, 'archiveSha256': data['archiveSha256'],
                              'catalog': data['catalog'], 'policy': data['policy'], 'groups': []}
    target = merged[dictionary]
    assert target['policy'] == data['policy'] and target['catalog'] == data['catalog'], name
    for actual, planned in zip(data['groups'], selected, strict=True):
        for key in ['ordinal', 'firstId', 'firstBank', 'lastBank', 'sourceBytes']:
            assert actual[key] == planned[key], (name, key)
        baseline, candidate = actual['baseline'], actual['candidate']
        assert baseline['rows'] == candidate['rows'] == planned['rows'], name
        for key in ['keys', 'lookupBytes', 'nativeSegments', 'nativeFallbacks', 'digest', 'rawScoreDigest', 'fields']:
            assert baseline[key] == candidate[key], (name, key)
        for key in ['effectiveExperiments', 'fusedParseAttempts', 'fusedParseFallbacks', 'discardedFusedRows',
                    'escapedKeyDecodeCount', 'maxWasmHeapBytes', 'sourceCompressedBytes', 'sourceUncompressedBytes',
                    'crcVerified', 'crcScannedBytes', 'crcReusedBytes']:
            assert baseline['parserRoutes'][key] == candidate['parserRoutes'][key], (name, key)
        target['groups'].append(actual)
    receipts.append({'name': name, 'sha256': digest(raw), 'dictionary': dictionary,
                     'groupStart': start, 'groups': len(selected), 'rows': data['rows']})

assert set(merged) == {'jmdict', 'jitendex', 'vndb'}
summary = {'schema': 1, 'complete': True, 'correctnessOnly': True,
           'scope': 'Eight separate correctness processes with exact ordered group coverage. No interrupted report or timing is combined. Product execution is unmodified; canonical eligibility is derived from current input values and final format.',
           'runnerSha256': runner_sha, 'groupManifestSha256': manifest_sha,
           'lockSha256': manifest['lockSha256'], 'sources': sources, 'node': node, 'grouping': grouping,
           'partReceipts': receipts, 'totalRows': 0, 'totalGroups': 0, 'totalOwnedScoreBytesAvoided': 0,
           'corpora': []}
for dictionary in ['jmdict', 'jitendex', 'vndb']:
    data = merged[dictionary]
    expected = manifest['dictionaries'][dictionary]
    groups = data['groups']
    assert [group['ordinal'] for group in groups] == list(range(1, len(expected['groups']) + 1)), dictionary
    assert sum(group['baseline']['rows'] for group in groups) == expected['rows'], dictionary
    assert sum(group['sourceBytes'] for group in groups) == data['policy']['totalSourceBytes'], dictionary
    formats = collections.Counter()
    format_rows = collections.Counter()
    eligibility = collections.Counter()
    transports = collections.Counter()
    transport_rows = collections.Counter()
    route_counts = collections.Counter()
    maxima = collections.Counter()
    bytes_avoided = 0
    raw_fallbacks = []
    for group in groups:
        candidate = group['candidate']
        transports[candidate['transport']] += 1
        transport_rows[candidate['transport']] += candidate['rows']
        bytes_avoided += candidate['scoreBytesAvoided']
        if candidate['transport'] == 'raw':
            raw_fallbacks.append({'ordinal': group['ordinal'], 'firstBank': group['firstBank'],
                                 'lastBank': group['lastBank'], 'rows': candidate['rows']})
        routes = candidate['parserRoutes']
        for key in ['fusedParseAttempts', 'fusedParseFallbacks', 'discardedFusedRows', 'escapedKeyDecodeCount',
                    'nativeScorePlanGroups', 'nativeScorePlanRows', 'nativeScorePlanBytesAvoided',
                    'sourceCompressedBytes', 'sourceUncompressedBytes', 'crcScannedBytes', 'crcReusedBytes']:
            route_counts[key] += routes[key] or 0
        maxima['maxWasmHeapBytes'] = max(maxima['maxWasmHeapBytes'], routes['maxWasmHeapBytes'])
        for chunk, score_input in zip(candidate['fields']['whole']['chunks'], candidate['fieldScoreInputs']['whole'], strict=True):
            kind = str(chunk['format'])
            formats[kind] += 1
            format_rows[kind] += chunk['count']
            eligible = score_input['transport'] == 'plan' and score_input['canonicalFromCurrentValues']
            eligibility[('canonicalPlan' if eligible else score_input['transport']) + 'Format' + kind] += chunk['count']
    first = groups[0]['candidate']
    item = {'dictionary': dictionary, 'rows': expected['rows'], 'groups': len(groups),
            'catalog': data['catalog'], 'policy': data['policy'], 'transportGroups': dict(transports),
            'transportRows': dict(transport_rows), 'ownedScoreBytesAvoided': bytes_avoided,
            'finalFormatCounts': dict(formats), 'finalFormatRows': dict(format_rows),
            'derivedCanonicalEligibilityRows': dict(eligibility), 'parserRoutes': dict(route_counts),
            'maxima': dict(maxima), 'rawFallbackGroups': raw_fallbacks,
            'additionalScenarios': {name: {'rows': value['rows'], 'formats': [chunk['format'] for chunk in value['chunks']],
                                          'ranges': [chunk['count'] for chunk in value['chunks']],
                                          'materializedRows': value['materializedRows']}
                                    for name, value in first['fields'].items() if name != 'whole'}}
    summary['corpora'].append(item)
    summary['totalRows'] += expected['rows']
    summary['totalGroups'] += len(groups)
    summary['totalOwnedScoreBytesAvoided'] += bytes_avoided

# Bind the aggregate to the still-frozen local source bytes after every part.
for arm in sources.values():
    root = Path(arm['root'])
    for name, expected in arm['hashes'].items():
        file = root / name
        if expected is None:
            assert not file.exists(), file
        else:
            assert digest(file.read_bytes()) == expected, file
assert summary['totalRows'] == 7613164 and summary['totalGroups'] == 204
if require_plan:
    assert any(corpus['transportGroups'].get('plan', 0) for corpus in summary['corpora'])
with args.out.open('x') as file:
    json.dump(summary, file, indent=2)
    file.write('\n')
print(json.dumps({key: summary[key] for key in ['complete', 'totalRows', 'totalGroups', 'totalOwnedScoreBytesAvoided']}, indent=2))
for corpus in summary['corpora']:
    print(json.dumps({key: corpus[key] for key in ['dictionary', 'transportGroups', 'transportRows',
                                                  'ownedScoreBytesAvoided', 'finalFormatCounts', 'parserRoutes']}))
