# SPDX-License-Identifier: GPL-3.0-or-later
"""Separate physical/decoded proof policy for one corrected compression trial.

The original raw validator, raw receipts and failed trial stay unchanged. This
policy first verifies exact physical preimages, bounded compact references and
full decoded lookup JSON before making a labeled logical comparison copy.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import compression_receipts as original_storage_policy
from qualification_receipts import require_matching_receipts


POLICY_ID = 'zstd-minus2-physical-decoded-proof-20261128-1b47'
PROOF_DOMAIN = 'manabitan-compression-proof-v1'
LOGICAL_DOMAIN = 'manabitan-compression-logical-projection-v1'
BASELINE_SHA = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
STORAGE_PREDICTION_BASELINE_SHA = original_storage_policy.BASELINE_SHA
PRODUCT_SOURCE_SHA = 'f7980e638ea1808701ac28339987663fd8b3dc4e'
CONTENT_PATH = original_storage_policy.CONTENT_PATH
SUPPORTED_DICTIONARIES = ('jmdict', 'jitendex')
REFERENCE_TAG = 'raw-block-v2:jmdict'
REFERENCE_BYTES = 20
ORIGINAL_STORAGE_POLICY_SHA256 = '7512dd8f4422fc01fe094eb49dcccc4a3f8a80cb9dbf8fc2e37b8b00e1f68bb8'
PROOF_KEYS = {'schemaVersion', 'domain', 'dictionary', 'physical', 'references', 'decoded'}
STAGES = {'preRestart', 'postRestart'}
PHYSICAL_PROBE_KEYS = {'term', 'totalLength', 'rowSampleCount', 'inBoundsRowCount',
                       'outOfBoundsRowCount', 'glossaryReadyRowCount',
                       'readablePreviewRowCount', 'rowSample'}
PHYSICAL_ROW_KEYS = {'rawEntryContentOffset', 'rawEntryContentLength',
                    'glossaryLength', 'rawContentPreview'}
REFERENCE_KEYS = {'id', 'dictionary', 'matchSource', 'expression', 'reading',
                  'rawEntryContentOffset', 'rawEntryContentLength',
                  'rawEntryContentDictName', 'glossaryLength',
                  'decodedContentLength', 'readErrorDetails'}
DECODED_KEYS = {'term', 'resultJson', 'utf8Bytes', 'sha256', 'results',
                'originalTextLength', 'hasExactHeadwordMatch'}


def _exact(actual, expected, label):
    try:
        equal = json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(
            expected, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f'{label} contains invalid JSON') from error
    if not equal:
        raise ValueError(f'{label} differs from the required value')


def _record(value, keys, label):
    if type(value) is not dict or set(value) != keys:
        raise ValueError(f'{label} has unexpected or missing fields')
    return value


def _integer(value, label, minimum=0):
    if type(value) is not int or not minimum <= value <= 2 ** 53 - 1:
        raise ValueError(f'{label} must be a safe integer >= {minimum}')
    return value


def _text(value, label, nonempty=True):
    if type(value) is not str or (nonempty and not value):
        raise ValueError(f'{label} must be a string' + (' with content' if nonempty else ''))
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Proof JSON contains a duplicate key')
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError(f'Proof JSON contains a nonfinite constant: {value}')


def _json_witness(record, text_key, label):
    text = _text(record[text_key], label + ' JSON')
    try:
        raw = text.encode('utf-8')
        value = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f'{label} has invalid UTF-8 JSON') from error
    _exact(_integer(record['utf8Bytes'], label + ' UTF-8 bytes', 1), len(raw), label + ' byte count')
    _exact(record['sha256'], hashlib.sha256(raw).hexdigest(), label + ' SHA-256')
    return value


def policy_manifest(dictionary):
    if dictionary not in SUPPORTED_DICTIONARIES:
        raise ValueError('Corrected proof trial supports only JMdict and Jitendex')
    if hashlib.sha256(Path(original_storage_policy.__file__).read_bytes()).hexdigest() != ORIGINAL_STORAGE_POLICY_SHA256:
        raise ValueError('The original exact-storage policy bytes changed')
    return {
        'id': POLICY_ID,
        'baselineSha': BASELINE_SHA,
        'compressionProductOriginSha': PRODUCT_SOURCE_SHA,
        'historicalStoragePredictionBaselineSha': STORAGE_PREDICTION_BASELINE_SHA,
        'historicalPredictionRole': 'The original 9e10 frame census supplies unchanged exact '
                                    'byte-delta predicates; it is not the active common baseline. '
                                    'Any current-baseline difference fails without recalibration.',
        'dictionary': dictionary,
        'originalStoragePolicy': original_storage_policy.policy_manifest(dictionary),
        'proofDomain': PROOF_DOMAIN,
        'logicalDomain': LOGICAL_DOMAIN,
        'allowedReferenceTag': REFERENCE_TAG,
        'referencePhysicalBytes': REFERENCE_BYTES,
        'allowedCrossArmPhysicalFields': [
            'physical canonical probe totalLength (exact stored content bytes or matching -1 sentinel)',
            'physical canonical row rawEntryContentOffset and rawContentPreview',
            'reference row rawEntryContentOffset (bounded 20-byte compact reference)',
        ],
        'comparison': 'Raw receipts and physical proof remain exact within an arm and between A/C. '
                      'Cross B/non-B comparison uses a separately computed logical projection digest '
                      'only after exact physical preimage/restart, reference, full decoded JSON and '
                      'all 72 existing lookup bindings pass. Labeled comparison copies retain '
                      'the original two storage adjustments, remove their physical outputDigestSha256 '
                      'and add a domain-bearing compressionLogicalProjection. Raw receipts are unchanged.',
        'rawEvidence': 'summary.json, run-1.json and canonical-receipt.json are never rewritten; '
                       'compressionProof is additive outside the original validation object.',
        'logicalDigestEncoding': 'SHA-256 of Python json.dumps(sort_keys=True, separators=(comma,colon), '
                                'ensure_ascii=True, allow_nan=False); full decoded result JSON strings retained',
        'scope': 'One separate correction of a representation-sensitive diagnostic policy omission; '
                 'no old warmups, old trial qualification or primary endpoint changes',
    }


def _physical_projection(physical, references, *, terms, title, content_bytes):
    if type(physical) is not list or type(references) is not list or len(physical) != len(terms) or len(references) != len(terms):
        raise ValueError('Expected all twelve ordered physical/reference term groups')
    projected_physical, projected_references = [], []
    for term, group, ref_group in zip(terms, physical, references):
        _record(group, {'term', 'probes'}, 'physical term group')
        _record(ref_group, {'term', 'probes'}, 'reference term group')
        _exact(group['term'], term, 'physical term order')
        _exact(ref_group['term'], term, 'reference term order')
        probes, ref_probes = group['probes'], ref_group['probes']
        if type(probes) is not list or not probes or type(ref_probes) is not list or len(probes) != len(ref_probes):
            raise ValueError('Physical and reference probes must cover the same nonempty ordered set')
        projected_probes, projected_ref_probes = [], []
        for probe, ref_probe in zip(probes, ref_probes):
            _record(probe, PHYSICAL_PROBE_KEYS, 'physical probe')
            _record(ref_probe, {'term', 'rows'}, 'reference probe')
            _exact(probe['term'], term, 'physical probe term')
            _exact(ref_probe['term'], term, 'reference probe term')
            total = probe['totalLength']
            if type(total) is not int or total not in (-1, content_bytes):
                raise ValueError('Physical probe total must equal exact content-file bytes or the -1 unavailable sentinel')
            count = _integer(probe['rowSampleCount'], 'physical row sample count', 1)
            rows, ref_rows = probe['rowSample'], ref_probe['rows']
            if type(rows) is not list or type(ref_rows) is not list or len(rows) != count or len(ref_rows) != count:
                raise ValueError('Physical/reference row counts differ')
            for key in ('inBoundsRowCount', 'outOfBoundsRowCount', 'glossaryReadyRowCount', 'readablePreviewRowCount'):
                _integer(probe[key], key)
            _exact(probe['outOfBoundsRowCount'], 0, 'physical out-of-bounds count')
            _exact(probe['inBoundsRowCount'], 0 if total == -1 else count, 'physical in-bounds count')
            _exact(probe['glossaryReadyRowCount'], count, 'decoded glossary coverage')
            _exact(probe['readablePreviewRowCount'], count, 'physical preview read coverage')
            logical_rows, logical_ref_rows = [], []
            for row, ref_row in zip(rows, ref_rows):
                _record(row, PHYSICAL_ROW_KEYS, 'physical row')
                _record(ref_row, REFERENCE_KEYS, 'reference row')
                _integer(ref_row['id'], 'row id')
                _exact(ref_row['dictionary'], title, 'row dictionary')
                _text(ref_row['matchSource'], 'row match source')
                _text(ref_row['expression'], 'row expression')
                _text(ref_row['reading'], 'row reading', nonempty=False)
                offset = _integer(ref_row['rawEntryContentOffset'], 'compact-reference offset')
                length = _integer(ref_row['rawEntryContentLength'], 'decoded entry length', 1)
                glossary = _integer(ref_row['glossaryLength'], 'glossary count', 1)
                _exact(ref_row['rawEntryContentDictName'], REFERENCE_TAG, 'compact-reference format')
                _exact(_integer(ref_row['decodedContentLength'], 'decoded diagnostic length', 1), length, 'decoded entry length')
                _exact(ref_row['readErrorDetails'], None, 'reference read error')
                if offset + REFERENCE_BYTES > content_bytes:
                    raise ValueError('Compact-reference physical range exceeds the exact content file')
                if total != -1 and offset + length > total:
                    raise ValueError('Original physical probe in-bounds count is inconsistent')
                _exact(row['rawEntryContentOffset'], offset, 'physical/reference offset binding')
                _exact(row['rawEntryContentLength'], length, 'physical/reference length binding')
                _exact(row['glossaryLength'], glossary, 'physical/reference glossary binding')
                preview = _text(row['rawContentPreview'], 'physical preview')
                if preview in ('<read-null>', '<read-failed>'):
                    raise ValueError('Physical preview did not read successfully')
                logical_rows.append({'rawEntryContentLength': length, 'glossaryLength': glossary})
                logical_ref = deepcopy(ref_row)
                del logical_ref['rawEntryContentOffset']
                logical_ref_rows.append(logical_ref)
            logical_probe = deepcopy(probe)
            del logical_probe['totalLength']
            logical_probe['totalLengthUnavailable'] = total == -1
            logical_probe['rowSample'] = logical_rows
            projected_probes.append(logical_probe)
            projected_ref_probes.append({'term': term, 'rows': logical_ref_rows})
        projected_physical.append({'term': term, 'probes': projected_probes})
        projected_references.append({'term': term, 'probes': projected_ref_probes})
    return projected_physical, projected_references


def _decoded_witnesses(rows, *, terms, title):
    if type(rows) is not list or len(rows) != len(terms):
        raise ValueError('Expected all twelve ordered full decoded lookup witnesses')
    for term, row in zip(terms, rows):
        _record(row, DECODED_KEYS, 'decoded lookup witness')
        _exact(row['term'], term, 'decoded lookup term order')
        result = _json_witness(row, 'resultJson', 'decoded lookup')
        if type(result) is not dict or type(result.get('dictionaryEntries')) is not list:
            raise ValueError('Full decoded lookup JSON lacks dictionary entries')
        entries = result['dictionaryEntries']
        _exact(_integer(row['results'], 'decoded result count', 1), len(entries), 'decoded result count')
        term_length = len(term.encode('utf-16-le', errors='surrogatepass')) // 2
        _exact(row['originalTextLength'], term_length, 'decoded original text length')
        _exact(result.get('originalTextLength'), term_length, 'full result original text length')
        _exact(row['hasExactHeadwordMatch'], True, 'decoded exact-match flag')
        exact = any(type(entry) is dict and type(entry.get('definitions')) is list and
                    type(entry.get('headwords')) is list and
                    any(type(value) is dict and value.get('dictionary') == title for value in entry['definitions']) and
                    any(type(value) is dict and (value.get('term') == term or value.get('reading') == term)
                        for value in entry['headwords']) for entry in entries)
        if not exact:
            raise ValueError('Full decoded lookup JSON lacks an exact headword in the pinned dictionary')


def validate_compression_proof(receipt, proof, *, dictionary):
    """Verify one additive witness and derive its separate logical projection."""
    policy_manifest(dictionary)
    storage, content_index = original_storage_policy._validated_storage(receipt, dictionary)
    validation = receipt['common']['validation']
    if 'compressionLogicalProjection' in validation:
        raise ValueError('A raw physical receipt must not contain the reserved logical comparison field')
    _record(proof, PROOF_KEYS, 'compression proof')
    _exact(proof['schemaVersion'], 1, 'compression proof schema')
    _exact(proof['domain'], PROOF_DOMAIN, 'compression proof domain')
    _record(proof['dictionary'], {'title', 'revision', 'probeTerms'}, 'proof dictionary')
    for key in ('title', 'revision', 'probeTerms'):
        _exact(proof['dictionary'][key], validation.get(key), 'proof dictionary ' + key)
    terms = proof['dictionary']['probeTerms']
    if type(terms) is not list or len(terms) != 12 or any(type(term) is not str or not term for term in terms) or len(set(terms)) != 12:
        raise ValueError('Expected twelve distinct ordered terms')
    title = _text(proof['dictionary']['title'], 'dictionary title')
    _record(proof['physical'], STAGES, 'physical stages')
    _record(proof['references'], STAGES, 'reference stages')
    _record(proof['decoded'], STAGES, 'decoded stages')
    projections = []
    for stage in ('preRestart', 'postRestart'):
        witness = _record(proof['physical'][stage], {'json', 'utf8Bytes', 'sha256'}, 'physical witness')
        physical = _json_witness(witness, 'json', 'physical probe')
        _exact(witness['sha256'], validation['outputDigestSha256'], 'original physical digest binding')
        projections.append(_physical_projection(physical, proof['references'][stage], terms=terms,
                           title=title, content_bytes=storage['files'][content_index]['bytes']))
        _decoded_witnesses(proof['decoded'][stage], terms=terms, title=title)
    for key in ('physical', 'references', 'decoded'):
        _exact(proof[key]['preRestart'], proof[key]['postRestart'], key + ' pre/post restart stability')
    _exact(projections[0], projections[1], 'logical projection restart stability')
    lookup_rows = validation.get('lookup', {}).get('observations')
    if type(lookup_rows) is not list or len(lookup_rows) != 72:
        raise ValueError('Original 72 lookup observations must remain present')
    by_term = {row['term']: row for row in proof['decoded']['postRestart']}
    seen = set()
    for row in lookup_rows:
        term, number = row.get('term'), row.get('pass')
        _integer(number, 'lookup pass')
        if number >= 6 or term not in by_term or (number, term) in seen:
            raise ValueError('Unknown or duplicate original lookup pass/term')
        seen.add((number, term))
        for key in ('sha256', 'results', 'originalTextLength', 'hasExactHeadwordMatch'):
            _exact(row.get(key), by_term[term][key], 'full decoded/original lookup ' + key)
    if len(seen) != 72:
        raise ValueError('Incomplete original lookup coverage')
    logical = {'domain': LOGICAL_DOMAIN, 'dictionary': deepcopy(proof['dictionary']),
               'physicalChecks': projections[1][0], 'references': projections[1][1],
               'decoded': deepcopy(proof['decoded']['postRestart'])}
    return {'logicalProjection': logical,
            'logicalSha256': original_storage_policy.receipt_digest(logical),
            'physicalSha256': proof['physical']['postRestart']['sha256'],
            'proofSha256': original_storage_policy.receipt_digest(proof)}


def comparison_receipt(receipt, proof, *, dictionary, arm):
    """Return a labeled comparison copy; no raw input is modified or qualified."""
    witness = validate_compression_proof(receipt, proof, dictionary=dictionary)
    copied, storage_audit = original_storage_policy.comparison_receipt(receipt, dictionary=dictionary, arm=arm)
    copied_validation = copied['common']['validation']
    del copied_validation['outputDigestSha256']
    copied_validation['compressionLogicalProjection'] = {'domain': LOGICAL_DOMAIN, 'sha256': witness['logicalSha256']}
    audit = {'policy': policy_manifest(dictionary), 'arm': arm,
             'evidenceKind': 'comparison copy only; original physical receipt and additive proof retained',
             'rawReceiptSha256': original_storage_policy.receipt_digest(receipt),
             'comparisonReceiptSha256': original_storage_policy.receipt_digest(copied),
             'proofSha256': witness['proofSha256'], 'physicalOutputDigestSha256': witness['physicalSha256'],
             'logicalOutputDigestSha256': witness['logicalSha256'], 'originalStorageAudit': storage_audit}
    return copied, audit


def require_matching_trial_receipts(reference, candidate, *, reference_proof, candidate_proof,
                                    dictionary, reference_arm, candidate_arm, compare_media=True):
    """Retain raw same-arm/A-C equality and compare only proven cross-B layouts."""
    left_copy, _ = comparison_receipt(reference, reference_proof, dictionary=dictionary, arm=reference_arm)
    right_copy, _ = comparison_receipt(candidate, candidate_proof, dictionary=dictionary, arm=candidate_arm)
    left, li = original_storage_policy._validated_storage(reference, dictionary)
    right, ri = original_storage_policy._validated_storage(candidate, dictionary)
    expected = original_storage_policy.EXPECTED_CONTENT_DELTAS[dictionary] * ((candidate_arm == 'B') - (reference_arm == 'B'))
    if right['bytes'] - left['bytes'] != expected or right['files'][ri]['bytes'] - left['files'][li]['bytes'] != expected:
        raise ValueError('Observed content/complete-storage delta differs from the exact prospective value')
    if (reference_arm == 'B') == (candidate_arm == 'B'):
        require_matching_receipts(reference, candidate, compare_media=compare_media)
        _exact(reference_proof, candidate_proof, 'same-arm or A/C physical and decoded proof')
    else:
        require_matching_receipts(left_copy, right_copy, compare_media=compare_media)
