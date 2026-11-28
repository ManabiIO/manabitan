# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministic saved-byte/projection checks; no import or timing evidence."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest

from probe_projection import (
    js_json_sha, original_semantic_projection, physical_probes, probe_views,
    prove_probe_relocations, raw_preview,
)


def make_probe_receipts(queries, total_length=1000):
    before = []
    for index, rows in enumerate(queries):
        term = 'query-' + str(index)
        before.append({'term': term, 'probes': [{
            'term': term, 'totalLength': total_length, 'rowSampleCount': len(rows),
            'inBoundsRowCount': len(rows), 'outOfBoundsRowCount': 0,
            'glossaryReadyRowCount': len(rows), 'readablePreviewRowCount': len(rows),
            'diagnostics': {'offscreenState': {'rowSample': deepcopy(rows), 'directHits': []}},
        }]})
    physical = physical_probes(before)
    semantic = original_semantic_projection(physical)
    return {'before': before, 'after': deepcopy(before), 'physicalBefore': physical,
            'physicalAfter': deepcopy(physical), 'semanticProjection': semantic,
            'physicalOutputDigestSha256': js_json_sha(physical),
            'semanticProbeDigestSha256': js_json_sha(semantic)}


def synthetic_probes(dictionary='vndb', arm='A'):
    alternate = dictionary == 'vndb' and arm == 'B'
    queries = []
    for query in range(12):
        rows = []
        for index in range(2):
            rows.append({'id': query * 2 + index + 1, 'dictionary': dictionary,
                'matchSource': 'expression', 'expression': 'word-' + str(index), 'reading': 'reading',
                'glossaryLength': 1, 'rawEntryContentOffset': 20 + index * 20 + (5 if alternate else 0),
                'rawEntryContentLength': 140, 'rawEntryContentDictName': 'raw-block-v2',
                'rawContentPreview': 'candidate' if alternate else 'baseline',
                'decodedContentDebug': {'length': 140, 'prefixBytes': [1, 2], 'textPrefix': 'definition'},
                'readErrorDetails': None})
        queries.append(rows)
    return make_probe_receipts(queries, 1100 if alternate else 1000)


class ProbeByteProof(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.arms = {}
        self.comparison = {'complete': True, 'normalSpanProofs': []}
        contents = {'A': bytearray(), 'B': bytearray()}
        for group in range(170):
            if group == 1:
                contents['B'].extend(b'alias')
            starts = {arm: len(content) for arm, content in contents.items()}
            for arm, content in contents.items():
                content.extend(b'unchanged-frame-data')
                for index in range(6):
                    content.extend(struct.pack('<QIII', starts[arm], 20, 256, index * 8))
            self.comparison['normalSpanProofs'].append({'group': group,
                'baselineStart': starts['A'], 'candidateStart': starts['B'], 'bytes': 140})
        for arm, content in contents.items():
            root = self.root / arm
            (root / 'opfs').mkdir(parents=True)
            (root / 'opfs/manabitan-term-content.bin').write_bytes(content)
            queries = []
            for query in range(12):
                span = self.comparison['normalSpanProofs'][query + 1]
                offset = span['baselineStart' if arm == 'A' else 'candidateStart'] + 20
                row = deepcopy(synthetic_probes()['before'][0]['probes'][0]['diagnostics']['offscreenState']['rowSample'][0])
                row.update(id=query + 1, rawEntryContentOffset=offset,
                           rawContentPreview=raw_preview(content[offset:offset + 120]))
                queries.append([row])
            layout = {'files': [{'path': 'manabitan-term-content.bin', 'bytes': len(content),
                                  'sha256': hashlib.sha256(content).hexdigest()}],
                      'probes': make_probe_receipts(queries, len(content))}
            self.arms[arm] = {'layout': layout, 'layoutPath': root / 'layout.json'}

    def tearDown(self):
        self.temporary.cleanup()

    def call(self):
        return prove_probe_relocations(self.arms, self.comparison, 'a' * 64)

    def test_exact_real_file_ranges_and_pointer_relocations_pass(self):
        proof = self.call()
        self.assertTrue(proof['complete'])
        self.assertEqual(proof['rowCount'], 12)
        self.assertEqual(proof['compactReferences'], 72)
        # UTF-8 replacement can hide some changed pointer bytes; all 72 binary
        # references are still checked, including the six equal text previews.
        self.assertEqual(proof['changedPreviewRows'], 6)

    def test_changed_content_file_is_rejected_even_without_probe_mutation(self):
        path = self.root / 'B/opfs/manabitan-term-content.bin'
        content = bytearray(path.read_bytes()); content[145] ^= 1; path.write_bytes(content)
        with self.assertRaisesRegex(ValueError, 'file bytes changed'):
            self.call()

    def test_wrong_preview_with_recomputed_report_digests_is_rejected(self):
        layout = self.arms['B']['layout']
        queries = [[deepcopy(query['probes'][0]['diagnostics']['offscreenState']['rowSample'][0])]
                   for query in layout['probes']['before']]
        queries[0][0]['rawContentPreview'] = 'forged'
        layout['probes'] = make_probe_receipts(queries, layout['files'][0]['bytes'])
        with self.assertRaisesRegex(ValueError, 'exact saved file range'):
            self.call()

    def test_changed_relocation_map_cannot_bless_a_different_offset(self):
        self.comparison['normalSpanProofs'][1]['candidateStart'] += 1
        with self.assertRaisesRegex(ValueError, 'normal-span relocation'):
            self.call()

    def test_non_pointer_reference_change_is_not_normalized(self):
        path = self.root / 'B/opfs/manabitan-term-content.bin'
        content = bytearray(path.read_bytes())
        offset = self.comparison['normalSpanProofs'][1]['candidateStart'] + 20
        content[offset + 16] ^= 1
        path.write_bytes(content)
        layout = self.arms['B']['layout']
        layout['files'][0]['sha256'] = hashlib.sha256(content).hexdigest()
        queries = [[deepcopy(query['probes'][0]['diagnostics']['offscreenState']['rowSample'][0])]
                   for query in layout['probes']['before']]
        queries[0][0]['rawContentPreview'] = raw_preview(content[offset:offset + 120])
        layout['probes'] = make_probe_receipts(queries, len(content))
        with self.assertRaisesRegex(ValueError, 'Non-pointer'):
            self.call()

    def test_pointed_frame_change_is_not_normalized(self):
        path = self.root / 'B/opfs/manabitan-term-content.bin'
        content = bytearray(path.read_bytes()); content[145] ^= 1; path.write_bytes(content)
        self.arms['B']['layout']['files'][0]['sha256'] = hashlib.sha256(content).hexdigest()
        with self.assertRaisesRegex(ValueError, 'frame bytes changed'):
            self.call()

    def test_logical_row_and_restart_mutations_remain_visible(self):
        original = deepcopy(self.arms['B']['layout']['probes'])
        for key, value in [('id', 999), ('id', True), ('expression', 'wrong'), ('reading', 'wrong'),
                           ('decodedContentDebug', {'length': 1}), ('readErrorDetails', {'error': 'failed'})]:
            probes = deepcopy(original)
            for phase in ('before', 'after'):
                probes[phase][0]['probes'][0]['diagnostics']['offscreenState']['rowSample'][0][key] = value
            self.arms['B']['layout']['probes'] = probes
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'logical lookup'):
                self.call()
        probes = deepcopy(original)
        probes['after'][0]['probes'][0]['diagnostics']['offscreenState']['rowSample'][0]['id'] = 999
        with self.assertRaisesRegex(ValueError, 'after restart'):
            probe_views(probes)


if __name__ == '__main__':
    unittest.main()
