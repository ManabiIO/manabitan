# SPDX-License-Identifier: GPL-3.0-or-later
"""Narrow post-validation comparison for the prospectively frozen alias study.

Call the stock validate_import_summary first. This adapter never changes that
validator, substitutes a physical digest, or permits unknown storage paths.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

from qualification_receipts import (
    EXPECTED_PRODUCT_PATHS, GENERATION_MEDIA_PATH, canonicalize_validation,
    require_matching_receipts,
)
from probe_projection import (
    js_json_sha, logical_projection, original_physical_from_full,
    original_semantic_projection, probe_views,
)

CURRENT_BASE = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
PROTOCOL_BLOB = '7801b5fd696fffe4f250b98a19d6d80406518705'
SHA = re.compile(r'[a-f0-9]{64}')
COMMIT = re.compile(r'[a-f0-9]{40}')
GENERATION = re.compile(r'[a-f0-9]{32}')
CHUNK_BYTES = 256 * 1024
ROUTE_KEYS = (
    'rows', 'chunkCount', 'parserParallelWorkerCount', 'parserParallelPipelineGroupsPerWorker',
    'parserParallelGroupCount', 'parserFusedAttempts', 'parserFusedFallbacks',
    'parserBorrowedContentResultCount', 'parserBankSpanCount', 'parserSourceUncompressedBytes',
    'parserSourceCompressedBytes', 'parserRecentContentDedupHitCount',
    'parserValidatedGlossaryReuseCount', 'parserGlobalExactContentReuseCount',
    'dedupNativeCallCount', 'dedupNativeScannedRows', 'dedupNativeBulkPendingRows',
    'dedupNativeExactCandidates', 'dedupNativeFallbackCount', 'dedupPendingHitCount',
    'dedupPersistedHitCount', 'dedupUniqueCount', 'dedupExactFallbackCount',
)


def same(actual, expected, label):
    if json.dumps(actual, sort_keys=True, allow_nan=False) != json.dumps(expected, sort_keys=True, allow_nan=False):
        raise ValueError(label)


def digest(value, label):
    if type(value) is not str or SHA.fullmatch(value) is None:
        raise ValueError('Invalid digest: ' + label)
    return value


def integer(value, label, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ValueError('Invalid integer: ' + label)
    return value


def term_paths(dictionary):
    return EXPECTED_PRODUCT_PATHS[dictionary] - {GENERATION_MEDIA_PATH}


def file_vector(layout, dictionary, term_rows):
    """Validate complete header linkage before accepting the16-byte exception."""
    files = layout['files']
    if type(files) is not list or len(files) != len(term_paths(dictionary)):
        raise ValueError('Incomplete term-file hash coverage')
    by_path, result = {}, []
    for item in files:
        if set(item) != {'path', 'bytes', 'sha256', 'normalizedSha256', 'header', 'chunks'}:
            raise ValueError('Unexpected file-hash receipt fields')
        pathname = item['path']
        if pathname not in term_paths(dictionary) or pathname in by_path:
            raise ValueError('Unknown or duplicate term file')
        size = integer(item['bytes'], 'term file bytes', 1)
        digest(item['sha256'], 'raw file'); digest(item['normalizedSha256'], 'normalized file')
        same(item['chunks'], (size + CHUNK_BYTES - 1) // CHUNK_BYTES, 'Incomplete bounded range count')
        header = item['header']
        if pathname.endswith('.mbtr.mbti'):
            if set(header) != {'kind', 'generationRange', 'generationId', 'descriptorBytes', 'chunkCount', 'rowCount'}:
                raise ValueError('Unexpected index header fields')
            same(header['kind'], 'index', 'Wrong index kind')
            same(header['generationRange'], [24, 40], 'Broadened index normalization')
            integer(header['descriptorBytes'], 'descriptor bytes', 26)
            integer(header['chunkCount'], 'index chunks', 1); integer(header['rowCount'], 'index rows', 1)
            if size <= 40:
                raise ValueError('Truncated index header')
        elif pathname.endswith('.mbtr'):
            if set(header) != {'kind', 'generationRange', 'generationId'} or size < 26:
                raise ValueError('Invalid descriptor header')
            same(header['kind'], 'descriptor', 'Wrong descriptor kind')
            same(header['generationRange'], [8, 24], 'Broadened descriptor normalization')
        else:
            same(header, {'kind': 'content', 'generationRange': None, 'generationId': None}, 'Unexpected content normalization')
            same(item['sha256'], item['normalizedSha256'], 'Content bytes cannot normalize')
        if header['kind'] != 'content' and (type(header['generationId']) is not str or GENERATION.fullmatch(header['generationId']) is None):
            raise ValueError('Invalid16-byte generation identity')
        by_path[pathname] = item
        invariant = {key: value for key, value in header.items() if key != 'generationId'}
        result.append({'path': pathname, 'bytes': size, 'normalizedSha256': item['normalizedSha256'], 'headerInvariant': invariant})
    rows, pairs = 0, 0
    for pathname, item in by_path.items():
        header = item['header']
        if header['kind'] == 'descriptor' and pathname + '.mbti' not in by_path:
            raise ValueError('Missing descriptor sidecar')
        if header['kind'] != 'index':
            continue
        descriptor = by_path.get(pathname[:-5])
        if descriptor is None:
            raise ValueError('Missing sidecar descriptor')
        same(header['generationId'], descriptor['header']['generationId'], 'Mismatched paired generation')
        same(header['descriptorBytes'], descriptor['bytes'], 'Mismatched descriptor-length linkage')
        rows += header['rowCount']; pairs += 1
    same(rows, term_rows, 'Index headers omit or duplicate fixture rows')
    same(layout['headerLinkage']['pairs'], pairs, 'Incomplete header-linkage pair receipt')
    same(layout['headerLinkage']['rows'], rows, 'Incomplete header-linkage row receipt')
    return sorted(result, key=lambda item: item['path'])


def route_receipt(debug):
    for key, expected in [('hasResult', True), ('errorCount', 0), ('addSettingsErrorCount', 0), ('usesFallbackStorage', False)]:
        same(debug.get(key), expected, 'Import diagnostics do not establish successful production route: ' + key)
    phases = [item for item in debug.get('importerPhaseTimings', []) if item.get('phase', '').startswith('term-file-fast-path:')]
    if len(phases) != 1:
        raise ValueError('Expected exactly one complete native import source run')
    details = phases[0]['details']
    result = {key: integer(details.get(key), key) for key in ROUTE_KEYS}
    same(result['parserParallelWorkerCount'], 3, 'Worker policy changed')
    same(result['parserFusedFallbacks'], 0, 'Native fused fallback occurred')
    same(result['dedupNativeFallbackCount'], 0, 'Canonical native fallback occurred')
    return result, {
        'count': integer(details.get('contentAliasCount', 0), 'content alias count'),
        'inputBytes': integer(details.get('contentAliasInputBytes', 0), 'content alias input bytes'),
    }


class AliasReceiptComparator:
    """Freeze per-host witnesses before warmups; accept no post-result changes."""
    def __init__(self, binding):
        self.binding = deepcopy(binding)
        same(binding['schemaVersion'], 1, 'Unknown comparator binding schema')
        same(binding['baseline'], CURRENT_BASE, 'Stale baseline/source witness')
        same(binding['protocolBlob'], PROTOCOL_BLOB, 'Wrong prospective protocol')
        if COMMIT.fullmatch(binding['candidate']) is None:
            raise ValueError('Incomplete candidate commit')
        self.dictionary = binding['dictionary']
        if self.dictionary not in EXPECTED_PRODUCT_PATHS:
            raise ValueError('Unknown dictionary')
        digest(binding['fixtureSha256'], 'fixture')
        digest(binding['exporterSha256'], 'exporter')
        same(binding['receiptAdapterSha256'], hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'Comparator source changed')
        if set(binding['sources']) != {'A', 'B'}:
            raise ValueError('Incomplete arm source identity')
        for arm, source in binding['sources'].items():
            same(source['commit'], binding['candidate'] if arm == 'B' else binding['baseline'], 'Wrong arm source')
            if COMMIT.fullmatch(source['tree']) is None:
                raise ValueError('Incomplete source tree')
            digest(source['sourceManifestSha256'], 'runtime manifest'); digest(source['packageSha256'], 'package')
        self.witnesses = deepcopy(binding.get('witnesses'))
        if self.dictionary == 'vndb':
            if type(self.witnesses) is not dict or set(self.witnesses) != {'A', 'B'}:
                raise ValueError('VNDB requires both complete pre-acquisition physical witnesses')
            proof = binding['physicalProof']
            same(proof['complete'], True, 'Incomplete full layout proof')
            same(proof['baseline'], binding['baseline'], 'Stale physical proof baseline')
            same(proof['candidate'], binding['candidate'], 'Stale physical proof candidate')
            for key in ['naturalReplayComparisonSha256', 'browserVerificationASha256', 'browserVerificationBSha256']:
                digest(proof[key], key)
            for witness in self.witnesses.values():
                for key in ['preflightLayoutSha256', 'physicalOutputDigestSha256', 'semanticProbeDigestSha256']:
                    digest(witness[key], key)
                physical = original_physical_from_full(witness['fullProbeProjection'])
                same(js_json_sha(physical), witness['physicalOutputDigestSha256'], 'Preflight physical probe witness changed')
                same(js_json_sha(original_semantic_projection(physical)), witness['semanticProbeDigestSha256'], 'Preflight original projection witness changed')
                same(logical_projection(witness['fullProbeProjection']), witness['logicalProbeProjection'], 'Broadened logical probe projection')
            relocation = proof['rawProbeRelocationProof']
            same(relocation['schemaVersion'], 1, 'Unknown raw-preview relocation proof')
            same(relocation['complete'], True, 'Incomplete raw-preview relocation proof')
            same(relocation['naturalComparisonSha256'], proof['naturalReplayComparisonSha256'], 'Raw-preview relocation map changed')
            for arm, witness in self.witnesses.items():
                content = [entry for entry in witness['files'] if entry['path'] == 'manabitan-term-content.bin']
                same(len(content), 1, 'Missing preview content-file witness')
                same(relocation['contentFiles'][arm], {'bytes': content[0]['bytes'], 'sha256': content[0]['normalizedSha256']}, 'Raw-preview proof used different file bytes')
            same(self.witnesses['A']['logicalProbeProjection'], self.witnesses['B']['logicalProbeProjection'], 'Logical browser probe projection differs across arms')
            same(self.witnesses['A']['route'], self.witnesses['B']['route'], 'Current-base logical route differs across arms')
            self.route = deepcopy(self.witnesses['A']['route'])
        else:
            if self.witnesses is not None:
                raise ValueError('Non-targets use exact cross-arm equality, not alternate physical layouts')
            self.route = None
        self.shared_files = None
        self.checked = {}

    def check(self, receipt, layout, arm):
        """Bind stock-validated receipt to the actual post-endpoint full hashes."""
        if arm not in ('A', 'B', 'C'):
            raise ValueError('Unknown arm')
        source_arm = 'B' if arm == 'B' else 'A'
        same(layout['schemaVersion'], 1, 'Unknown layout schema')
        same(layout['complete'], True, 'Incomplete layout proof')
        same(layout['authoritativeTiming'], False, 'Layout work cannot be authoritative timing')
        same(layout['cleanupFailures'], [], 'Layout cleanup failed'); same(layout['failure'], None, 'Layout failed')
        request, source = layout['request'], self.binding['sources'][source_arm]
        same(request['schemaVersion'], 1, 'Unknown layout request schema')
        for key in ['baseline', 'candidate', 'protocolBlob', 'dictionary', 'fixtureSha256', 'exporterSha256']:
            same(request[key], self.binding[key], 'Layout binding mismatch: ' + key)
        same(request['arm'], arm, 'Wrong layout observation arm')
        if request['mode'] not in ('hash-only', 'export'):
            raise ValueError('Unknown layout mode')
        for key, source_key in [('sourceCommit', 'commit'), ('sourceTree', 'tree'), ('sourceManifestSha256', 'sourceManifestSha256'), ('packageSha256', 'packageSha256')]:
            same(request[key], source[source_key], 'Layout source mismatch: ' + key)
        same(sorted(set(request['termFiles'])), sorted(term_paths(self.dictionary)), 'Term path set changed')
        same(len(request['termFiles']), len(term_paths(self.dictionary)), 'Duplicate requested term path')
        common = receipt['common']; same(common['dictionary'], self.dictionary, 'Wrong stock receipt corpus')
        same(layout['fixture'], common['fixture'], 'Layout fixture differs from stock receipt')
        same(layout['fixture']['sha256'], self.binding['fixtureSha256'], 'Fixture archive changed')
        canonical = canonicalize_validation(layout['validation'], dictionary=self.dictionary, fixture=common['fixture'],
            media_check=layout['validation']['media']['mode'], vndb_sah_allocation_units=(37, 37) if self.dictionary == 'vndb' else None)
        media = canonical.pop('media')
        same(canonical, common['validation'], 'Layout validation is not this stock observation')
        same(media, receipt['media'], 'Layout media differs from stock observation')
        same(layout['beforeInventory'], layout['afterInventory'], 'Read-only layout inventory changed')
        same(layout['beforeInventory'], sorted(layout['validation']['storage']['files'], key=lambda value: value['path']), 'Layout inventory is not the complete stock inventory')
        files = file_vector(layout, self.dictionary, common['fixture']['termRows'])
        sizes = {item['path']: item['bytes'] for item in layout['beforeInventory']}
        for item in files:
            same(item['bytes'], sizes[item['path']], 'File hash does not cover stock file size')
        probes = layout['probes']
        same(probes['physicalOutputDigestSha256'], canonical['outputDigestSha256'], 'Physical probe binding changed')
        digest(probes['semanticProbeDigestSha256'], 'semantic probe projection')
        route, aliases = route_receipt(layout['importDebug'])
        same(route['rows'], common['fixture']['termRows'], 'Native route did not cover all rows')
        expected_aliases = {'count': 8, 'inputBytes': 2983} if self.dictionary == 'vndb' and arm == 'B' else {'count': 0, 'inputBytes': 0}
        same(aliases, expected_aliases, 'Unexpected alias activation')
        if self.dictionary == 'vndb':
            witness = self.witnesses[source_arm]
            same(files, witness['files'], 'Complete term-file bytes differ from frozen arm oracle')
            same(probes['physicalOutputDigestSha256'], witness['physicalOutputDigestSha256'], 'Physical digest differs from frozen arm oracle')
            same(probes['semanticProbeDigestSha256'], witness['semanticProbeDigestSha256'], 'Semantic probe projection differs from oracle')
            actual_probes = probe_views(probes)
            same(actual_probes['fullProbeProjection'], witness['fullProbeProjection'], 'Complete original preview/identity/decoded probe differs from its own arm oracle')
            same(actual_probes['logicalProbeProjection'], witness['logicalProbeProjection'], 'Logical probe fields differ from oracle')
        else:
            if self.shared_files is None:
                self.shared_files = deepcopy(files)
            else:
                same(files, self.shared_files, 'Non-target normalized storage changed across observations/arms')
        if self.route is None:
            self.route = deepcopy(route)
        else:
            same(route, self.route, 'Logical parser/canonical route changed')
        # Retain the exact object as well as its digest; a later equal-size file
        # corruption must not reuse a prior observation's successful hash proof.
        self.checked[(id(receipt), arm)] = (receipt, hashlib.sha256(json.dumps(receipt, sort_keys=True, allow_nan=False).encode()).hexdigest())
        return {'arm': arm, 'sourceArm': source_arm, 'files': files, 'route': route, 'aliases': aliases}

    def compare(self, reference, candidate, reference_arm, candidate_arm, *, compare_media=True):
        """Require both exact observations' checks; project pre-proved fields."""
        for receipt, arm in [(reference, reference_arm), (candidate, candidate_arm)]:
            checked = self.checked.get((id(receipt), arm))
            if checked is None or checked[0] is not receipt:
                raise ValueError('This exact observation has no full-file hash proof')
            same(hashlib.sha256(json.dumps(receipt, sort_keys=True, allow_nan=False).encode()).hexdigest(), checked[1],
                 'Stock receipt changed after its hash proof')
        if self.dictionary != 'vndb' or (reference_arm == 'B') == (candidate_arm == 'B'):
            return require_matching_receipts(reference, candidate, compare_media=compare_media)
        def project(receipt):
            result = deepcopy(receipt)
            value = result['common']['validation']
            del value['outputDigestSha256']
            storage = value['storage']
            removed_bytes = 0
            for item in storage['files']:
                if item['path'] in term_paths(self.dictionary):
                    removed_bytes += item['bytes']; item['bytes'] = 0
            storage['bytes'] -= removed_bytes
            return result
        return require_matching_receipts(project(reference), project(candidate), compare_media=compare_media)
