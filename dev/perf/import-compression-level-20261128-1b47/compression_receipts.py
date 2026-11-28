# SPDX-License-Identifier: GPL-3.0-or-later
"""Exact, prospective storage policy for the isolated Zstd -2 import trial.

Callers first run the unchanged qualification_receipts.validate_import_summary.
This module never changes raw summaries, raw reports, or canonical receipts. It
allows only the independently predicted content-file increase for the pinned
corpus, with a two-percent ceiling relative to the baseline's complete storage.
The original require_matching_receipts then compares every remaining field.
"""

from copy import deepcopy
import hashlib
import json
from types import MappingProxyType

from qualification_receipts import STORAGE_KIND, require_matching_receipts


POLICY_ID = 'zstd-minus2-exact-content-delta-20261128-1b47'
BASELINE_SHA = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CONTENT_PATH = 'manabitan-term-content.bin'
EXPECTED_CONTENT_DELTAS = MappingProxyType({'jmdict': 312404, 'jitendex': 750018, 'vndb': 0})
MAX_INCREASE_NUMERATOR = 2
MAX_INCREASE_DENOMINATOR = 100


def policy_manifest(dictionary):
    """Return a fresh serializable declaration, not a configurable allowance."""
    if dictionary not in EXPECTED_CONTENT_DELTAS:
        raise ValueError('Unsupported dictionary for the frozen compression policy')
    return {
        'id': POLICY_ID,
        'baselineSha': BASELINE_SHA,
        'dictionary': dictionary,
        'contentPath': CONTENT_PATH,
        'candidateMinusBaselineBytes': EXPECTED_CONTENT_DELTAS[dictionary],
        'maximumTotalIncrease': {'numerator': MAX_INCREASE_NUMERATOR,
                                 'denominator': MAX_INCREASE_DENOMINATOR},
        'origin': 'Independent exact-frame compression census at baseline 9e10; '
                  'all 103 JMdict and 385 Jitendex frames independently decoded with libzstd 1.5.7',
        'comparison': 'Only B content-file bytes and complete-storage bytes are reduced by the '
                      'declared exact delta in a labeled comparison copy. A/C and within-arm '
                      'receipts remain exact. Original require_matching_receipts is unchanged.',
        'rawEvidence': 'summary.json, run-1.json, and canonical-receipt.json remain unmodified',
    }


def _safe_integer(value, label, minimum=0):
    if type(value) is not int or not minimum <= value <= 2 ** 53 - 1:
        raise ValueError(f'{label} must be a safe integer >= {minimum}')
    return value


def _validated_storage(receipt, dictionary):
    # This is deliberately not a substitute for validate_import_summary. These
    # narrow checks make the adjustment fail closed even if miscalled directly.
    if type(receipt) is not dict or set(receipt) != {'browserVersion', 'common', 'media'}:
        raise ValueError('Unexpected canonical receipt fields')
    common = receipt.get('common')
    if type(common) is not dict or common.get('dictionary') != dictionary:
        raise ValueError('Receipt dictionary differs from the frozen policy')
    if common.get('importFlags') is not None:
        raise ValueError('Compression trial requires production defaults without import flags')
    validation = common.get('validation')
    storage = validation.get('storage') if type(validation) is dict else None
    if type(storage) is not dict or set(storage) != {'kind', 'bytes', 'files'}:
        raise ValueError('Unexpected canonical storage fields')
    if storage['kind'] != STORAGE_KIND:
        raise ValueError('Unexpected storage boundary')
    total = _safe_integer(storage['bytes'], 'storage total', 1)
    files = storage['files']
    if type(files) is not list or not files:
        raise ValueError('Expected the complete canonical storage file inventory')
    content_indexes = []
    for index, item in enumerate(files):
        if type(item) is not dict or set(item) != {'path', 'bytes'}:
            raise ValueError('Unexpected canonical storage file fields')
        if not isinstance(item['path'], str) or not item['path']:
            raise ValueError('Invalid canonical storage path')
        _safe_integer(item['bytes'], 'storage file bytes')
        if item['path'] == CONTENT_PATH:
            content_indexes.append(index)
    if len(content_indexes) != 1:
        raise ValueError('Expected exactly one complete term-content file')
    if sum(item['bytes'] for item in files) != total:
        raise ValueError('Storage total differs from the complete file inventory')
    return storage, content_indexes[0]


def receipt_digest(receipt):
    return hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def comparison_receipt(receipt, *, dictionary, arm):
    """Return a labeled comparison copy; raw input is never mutated.

    This function alone does not qualify an observation. The caller must also
    require_matching_trial_receipts against the cohort reference. In particular,
    subtracting the declared delta is not permission for an arbitrary increase.
    """
    manifest = policy_manifest(dictionary)
    if arm not in ('A', 'B', 'C'):
        raise ValueError('Compression trial arm must be A, B, or C')
    storage, index = _validated_storage(receipt, dictionary)
    delta = EXPECTED_CONTENT_DELTAS[dictionary] if arm == 'B' else 0
    baseline_total = storage['bytes'] - delta
    _safe_integer(baseline_total, 'implied baseline storage total', 1)
    if storage['files'][index]['bytes'] < delta:
        raise ValueError('Content file is smaller than its declared compression delta')
    expected_delta = EXPECTED_CONTENT_DELTAS[dictionary]
    if expected_delta * MAX_INCREASE_DENOMINATOR > baseline_total * MAX_INCREASE_NUMERATOR:
        raise ValueError('Predicted compression increase exceeds two percent of baseline total storage')
    copied = deepcopy(receipt)
    copied_storage = copied['common']['validation']['storage']
    copied_storage['bytes'] -= delta
    copied_storage['files'][index]['bytes'] -= delta
    audit = {
        'policy': manifest,
        'arm': arm,
        'evidenceKind': 'comparison copy only; raw canonical receipt retained separately',
        'rawReceiptSha256': receipt_digest(receipt),
        'comparisonReceiptSha256': receipt_digest(copied),
        'rawStorageBytes': storage['bytes'],
        'comparisonStorageBytes': copied_storage['bytes'],
        'rawContentBytes': storage['files'][index]['bytes'],
        'comparisonContentBytes': copied_storage['files'][index]['bytes'],
        'adjustedBytes': delta,
        'baselineTotalForBudget': baseline_total,
    }
    return copied, audit


def require_matching_trial_receipts(reference, candidate, *, dictionary,
                                    reference_arm, candidate_arm, compare_media=True):
    """Check the exact observed delta, then use the unmodified semantic matcher."""
    normalized_reference, _ = comparison_receipt(reference, dictionary=dictionary, arm=reference_arm)
    normalized_candidate, _ = comparison_receipt(candidate, dictionary=dictionary, arm=candidate_arm)
    left, left_index = _validated_storage(reference, dictionary)
    right, right_index = _validated_storage(candidate, dictionary)
    expected = EXPECTED_CONTENT_DELTAS[dictionary] * ((candidate_arm == 'B') - (reference_arm == 'B'))
    if right['bytes'] - left['bytes'] != expected:
        raise ValueError('Observed complete-storage delta differs from the exact prospective value')
    if right['files'][right_index]['bytes'] - left['files'][left_index]['bytes'] != expected:
        raise ValueError('Observed content-file delta differs from the exact prospective value')
    if (reference_arm == 'B') == (candidate_arm == 'B'):
        # No tolerance or adjustment for identical-code A/C or same-arm checks.
        require_matching_receipts(reference, candidate, compare_media=compare_media)
    else:
        require_matching_receipts(normalized_reference, normalized_candidate, compare_media=compare_media)
