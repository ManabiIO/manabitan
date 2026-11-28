"""Narrow normalization for already-validated reference-format receipts.

Exact product sizes come from a prospective full-corpus contract. Every field
outside that declared storage change and the asserted experimental flag remains
in the receipt for the existing strict cross-observation comparison.
"""
from copy import deepcopy
import json


def normalize_receipt(receipt, case, mode):
    if mode not in ('off', 'on'):
        raise ValueError('Unknown experimental mode')
    expected = case['modes'][mode]
    expected_flags = {'experimentalReferenceTableFields': mode == 'on'}
    if json.dumps(receipt['common']['importFlags'], sort_keys=True, allow_nan=False) != json.dumps(expected_flags, sort_keys=True):
        raise ValueError('The exact ephemeral flag differs')
    storage = receipt['common']['validation']['storage']
    actual = {item['path']: item['bytes'] for item in storage['files']
              if item['path'] == 'manabitan-term-content.bin' or item['path'].startswith('manabitan-term-records/')}
    if actual != expected['termFiles']:
        raise ValueError(f'Term-file inventory differs from prospective {mode} contract: {actual}')
    if set(expected['termFiles']) != set(case['modes']['off']['termFiles']):
        raise ValueError('Both modes must retain the same complete term-file inventory')
    normalized = deepcopy(receipt)
    normalized['common']['importFlags'] = {}
    normalized_storage = normalized['common']['validation']['storage']
    for item in normalized_storage['files']:
        if item['path'] in expected['termFiles']:
            item['bytes'] = case['modes']['off']['termFiles'][item['path']]
    normalized_storage['bytes'] = sum(item['bytes'] for item in normalized_storage['files'])
    return normalized
