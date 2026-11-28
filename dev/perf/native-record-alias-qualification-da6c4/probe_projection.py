# SPDX-License-Identifier: GPL-3.0-or-later
"""Bind logical probes to unchanged per-arm physical probes and saved file bytes.

This is an untimed qualification helper. It does not change browser probes,
their physical digest, product files, or the stock observation validator.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import struct


def same(a, b, label):
    if isinstance(a, bytes) and isinstance(b, bytes):
        equal = a == b
    else:
        equal = json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)
    if not equal:
        raise ValueError(label)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def js_json_sha(value):
    # These projections contain only integral counts, strings, null and lists.
    return sha(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode())


def state_of(probe):
    state = probe['diagnostics']
    for name in ('offscreenState', 'localState'):
        if state.get(name) is not None:
            return state[name]
    return state


def physical_probes(results):
    same(len(results), 12, 'Incomplete probe query coverage')
    output = []
    for query in results:
        probes = []
        if type(query['probes']) is not list or not query['probes']:
            raise ValueError('Incomplete probe variant coverage')
        for probe in query['probes']:
            rows = state_of(probe).get('rowSample', [])
            values = {name: probe[name] for name in (
                'term', 'totalLength', 'rowSampleCount', 'inBoundsRowCount',
                'outOfBoundsRowCount', 'glossaryReadyRowCount', 'readablePreviewRowCount')}
            values['rowSample'] = [{name: row[name] for name in (
                'rawEntryContentOffset', 'rawEntryContentLength', 'glossaryLength', 'rawContentPreview')}
                for row in rows]
            probes.append(values)
        output.append({'term': query['term'], 'probes': probes})
    return output


def original_semantic_projection(physical):
    result = deepcopy(physical)
    for query in result:
        for probe in query['probes']:
            del probe['totalLength']
            for row in probe['rowSample']:
                del row['rawEntryContentOffset']
    return result


def logical_projection(full):
    result = deepcopy(full)
    for query in result:
        for probe in query['probes']:
            del probe['totalLength']
            for row in probe['rowSample']:
                del row['rawEntryContentOffset']
                # This is checked against exact content bytes and normal-span
                # relocations before binding, and remains exact within each arm.
                del row['rawContentPreview']
    return result


def original_physical_from_full(full):
    result = []
    for query in full:
        probes = []
        for probe in query['probes']:
            item = {name: probe[name] for name in (
                'term', 'totalLength', 'rowSampleCount', 'inBoundsRowCount',
                'outOfBoundsRowCount', 'glossaryReadyRowCount', 'readablePreviewRowCount')}
            item['rowSample'] = [{name: row[name] for name in (
                'rawEntryContentOffset', 'rawEntryContentLength', 'glossaryLength', 'rawContentPreview')}
                for row in probe['rowSample']]
            probes.append(item)
        result.append({'term': query['term'], 'probes': probes})
    return result


def probe_views(probes):
    physical = [physical_probes(probes[phase]) for phase in ('before', 'after')]
    for index, phase in enumerate(('Before', 'After')):
        same(physical[index], probes['physical' + phase], 'Raw/physical probe projection changed')
        same(js_json_sha(physical[index]), probes['physicalOutputDigestSha256'], 'Raw physical probe digest changed')
        semantic = original_semantic_projection(physical[index])
        same(semantic, probes['semanticProjection'], 'Original semantic projection changed')
        same(js_json_sha(semantic), probes['semanticProbeDigestSha256'], 'Original semantic probe digest changed')
    full = []
    for index, phase in enumerate(('before', 'after')):
        result = deepcopy(physical[index])
        for query, source_query in zip(result, probes[phase]):
            for probe, source_probe in zip(query['probes'], source_query['probes']):
                state = state_of(source_probe)
                # Keep the complete original physical row projection and add
                # stable logical identity/decoded/error fields. sqlTermRow is a
                # separate optional SQL diagnostic (absent before restart); it
                # was never part of the original probe projection.
                probe['rowSample'] = [{name: deepcopy(row[name]) for name in (
                    'rawEntryContentOffset', 'rawEntryContentLength', 'glossaryLength', 'rawContentPreview',
                    'id', 'dictionary', 'matchSource', 'expression', 'reading',
                    'rawEntryContentDictName', 'decodedContentDebug', 'readErrorDetails')}
                    for row in state.get('rowSample', [])]
                probe['directHits'] = deepcopy(state.get('directHits'))
        full.append(result)
    same(full[0], full[1], 'Full physical/logical probes changed after restart')
    return {'fullProbeProjection': full[0], 'logicalProbeProjection': logical_projection(full[0])}


def raw_preview(data):
    # TextDecoder defaults to UTF-8 replacement and removes an initial BOM.
    text = data.decode('utf-8-sig', errors='replace')
    text = re.sub('[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', text)
    return text.encode('utf-16-le')[:240].decode('utf-16-le', errors='surrogatepass')


def prove_probe_relocations(arms, comparison, comparison_sha256):
    """Prove only the saved raw-preview difference; full decoder proof is separate.

    The caller must first bind both complete exported files to their decoded
    natural arm. These checks additionally tie every preview to its exact range
    and permit compact-reference pointer changes only from that original map.
    """
    same(sorted(arms), ['A', 'B'], 'Incomplete preview proof arms')
    same(comparison['complete'], True, 'Incomplete original relocation proof')
    spans = comparison['normalSpanProofs']
    same(len(spans), 170, 'Incomplete original normal-span map')
    content = {}
    views = {}
    files = {}
    for arm, item in arms.items():
        layout = item['layout']
        entries = [entry for entry in layout['files'] if entry['path'] == 'manabitan-term-content.bin']
        same(len(entries), 1, 'Missing exact content-file witness')
        path = Path(item['layoutPath']).parent / 'opfs' / 'manabitan-term-content.bin'
        content[arm] = path.read_bytes()
        same(len(content[arm]), entries[0]['bytes'], 'Preview content-file size changed')
        same(sha(content[arm]), entries[0]['sha256'], 'Preview content-file bytes changed')
        files[arm] = {'bytes': len(content[arm]), 'sha256': sha(content[arm])}
        views[arm] = probe_views(layout['probes'])
    same(views['A']['logicalProbeProjection'], views['B']['logicalProbeProjection'],
         'A logical lookup/row/decoded/error/order field differs across arms')
    cases = []
    reference_count = 0
    for query_index, (aq, bq) in enumerate(zip(views['A']['fullProbeProjection'], views['B']['fullProbeProjection'])):
        for probe_index, (ap, bp) in enumerate(zip(aq['probes'], bq['probes'])):
            for row_index, (ar, br) in enumerate(zip(ap['rowSample'], bp['rowSample'])):
                length = min(ar['rawEntryContentLength'], 120)
                ao, bo = ar['rawEntryContentOffset'], br['rawEntryContentOffset']
                if type(ao) is not int or type(bo) is not int or ao < 0 or bo < 0 or length <= 0:
                    raise ValueError('Invalid preview byte range')
                matches = [span for span in spans if span['baselineStart'] <= ao < span['baselineStart'] + span['bytes']]
                same(len(matches), 1, 'Preview does not belong to one proved ordinary span')
                span = matches[0]
                delta = span['candidateStart'] - span['baselineStart']
                same(bo, ao + delta, 'Preview offset is not the original normal-span relocation')
                ranges = {}
                for arm, row, offset in [('A', ar, ao), ('B', br, bo)]:
                    if offset + length > len(content[arm]):
                        same(row['rawContentPreview'], '<read-null>', 'Out-of-file diagnostic preview changed')
                        ranges[arm] = None
                    else:
                        ranges[arm] = content[arm][offset:offset + length]
                        same(raw_preview(ranges[arm]), row['rawContentPreview'], 'Raw preview does not match its exact saved file range')
                if ranges['A'] is None or ranges['B'] is None:
                    same(ranges['A'], ranges['B'], 'Preview readability changed across arms')
                    same(ar['rawContentPreview'], br['rawContentPreview'], 'Unproved missing-preview change')
                    cases.append({'query': query_index, 'probe': probe_index, 'row': row_index,
                                  'id': ar['id'], 'baselineOffset': ao, 'candidateOffset': bo,
                                  'bytes': length, 'kind': 'identical-out-of-file-preview'})
                    continue
                normalized = bytearray(ranges['B'])
                if ar['rawEntryContentDictName'] == 'raw-block-v2':
                    same(br['rawEntryContentDictName'], 'raw-block-v2', 'Unexpected preview content family')
                    same(length % 20, 0, 'Preview cuts a compact reference')
                    if ao + length > span['baselineStart'] + span['bytes']:
                        raise ValueError('Preview extends beyond its original normal span')
                    for index in range(0, length, 20):
                        old, compressed, uncompressed, entry = struct.unpack_from('<QIII', ranges['A'], index)
                        new, bc, bu, be = struct.unpack_from('<QIII', ranges['B'], index)
                        same((compressed, uncompressed, entry), (bc, bu, be), 'Non-pointer compact reference field changed')
                        if not (span['baselineStart'] <= old < ao and old + compressed <= ao and 0 <= entry < uncompressed):
                            raise ValueError('Invalid compact frame/reference bounds')
                        same(new, old + delta, 'Compact pointer is not the original normal-span relocation')
                        same(content['A'][old:old + compressed], content['B'][new:new + compressed], 'Pointed compressed frame bytes changed')
                        struct.pack_into('<Q', normalized, index, old)
                        reference_count += 1
                else:
                    same(ar['rawEntryContentDictName'], 'raw-v6', 'Unproved raw preview family')
                    same(br['rawEntryContentDictName'], 'raw-v6', 'Unproved raw preview family')
                same(bytes(normalized), ranges['A'], 'Raw preview has a change beyond proved compact pointers')
                cases.append({'query': query_index, 'probe': probe_index, 'row': row_index,
                              'id': ar['id'], 'baselineOffset': ao, 'candidateOffset': bo,
                              'bytes': length, 'baselineBytesSha256': sha(ranges['A']),
                              'candidateBytesSha256': sha(ranges['B']), 'normalizedBytesSha256': sha(normalized),
                              'changedPreview': ar['rawContentPreview'] != br['rawContentPreview'],
                              'kind': ar['rawEntryContentDictName'], 'normalSpanGroup': span['group']})
    return {'schemaVersion': 1, 'complete': True, 'naturalComparisonSha256': comparison_sha256,
            'contentFiles': files, 'rowCount': len(cases), 'compactReferences': reference_count,
            'changedPreviewRows': sum(item.get('changedPreview', False) for item in cases),
            'cases': cases, 'allowedDifference': 'Only uint64 compact-block pointers relocated by the original normal-span map; all other preview bytes and pointed frames exact. Original full previews remain exact within each arm.'}
