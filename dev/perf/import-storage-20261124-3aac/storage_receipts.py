# SPDX-License-Identifier: GPL-3.0-or-later
"""Prospective storage receipts for the three frozen 2026-11-24 fixtures.

Only VNDB's already observed SAH-pool allocation may vary, by at most two
4,096-byte units. This is a full-file allocation allowance, not proof about
SQLite page contents. Every other normalized file path and size remains exact.
Keep the returned raw receipt in every observation; compare only its explicit
comparison key. This module does not relax lookup, media or restart checks.
"""

import re


POLICY_VERSION = 'pinned-import-storage-20261124-v1'
STORAGE_KIND = 'OPFS logical file sizes after restart and verification'
SQLITE_PREFIX = 'manabitan/sqlite-sahpool-v1/.opaque/'
GENERATION_MEDIA_PATH = 'manabitan-dictionary-media-v1/{generation}.bin'
ALLOCATION_UNIT_BYTES = 4096
SQLITE_FILE_COUNT = 8
SQLITE_EMPTY_FILE_COUNT = 7
VNDB_ACTIVE_MIN_UNITS = 129
VNDB_ACTIVE_MAX_UNITS = 131

# This is a fixture-specific qualification policy, never a runtime admission
# heuristic. Unexpected files or changed fixture titles require a new protocol.
EXPECTED_PRODUCT_PATHS = {
    'jmdict': frozenset({
        'manabitan-term-content.bin',
        'manabitan-term-records/dict-25|JMdict%20%5B2026-11-22%5Draw-block-v2%3Ajmdict.mbtr',
        'manabitan-term-records/dict-25|JMdict%20%5B2026-11-22%5Draw-block-v2%3Ajmdict.mbtr.mbti',
    }),
    'jitendex': frozenset({
        'manabitan-term-content.bin',
        'manabitan-term-records/dict-31|Jitendex.org%20%5B2026-10-03%5Draw-block-v2%3Ajmdict.mbtr',
        'manabitan-term-records/dict-31|Jitendex.org%20%5B2026-10-03%5Draw-block-v2%3Ajmdict.mbtr.mbti',
    }),
    'vndb': frozenset({
        GENERATION_MEDIA_PATH,
        'manabitan-term-content.bin',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-block-v2.mbtr',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-block-v2.mbtr.mbti',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-v6.mbtr',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-v6.mbtr.mbti',
    }),
}
GENERATION_MEDIA_RE = re.compile(
    r'manabitan-dictionary-media-v1/'
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin'
)
SQLITE_FILE_RE = re.compile(re.escape(SQLITE_PREFIX) + r'[a-z0-9]+')


def _byte_count(value, name):
    if type(value) is not int or value < 0 or value > 2 ** 53 - 1:
        raise ValueError(f'Invalid byte count for {name}')
    return value


def normalize_storage_receipt(storage, dictionary):
    """Validate one native storage inventory and retain its complete raw sizes.

    File enumeration order is irrelevant. The only path normalization is an
    explicitly recognized generation UUID and the unordered SAH opaque pool.
    All non-SAH paths must match the fixed fixture inventory, even on arm A.
    """
    if dictionary not in EXPECTED_PRODUCT_PATHS:
        raise ValueError('Unsupported frozen dictionary storage policy')
    if not isinstance(storage, dict) or storage.get('kind') != STORAGE_KIND:
        raise ValueError('Unexpected storage receipt kind')
    total = _byte_count(storage.get('bytes'), 'storage total')
    files = storage.get('files')
    if not isinstance(files, list) or not files:
        raise ValueError('Storage receipt requires a nonempty file list')
    raw_files = []
    seen_paths = set()
    product = {}
    sqlite_sizes = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'bytes'}:
            raise ValueError('Unexpected storage file receipt fields')
        name = item['path']
        if not isinstance(name, str) or name in seen_paths:
            raise ValueError('Invalid or duplicate storage file path')
        seen_paths.add(name)
        size = _byte_count(item['bytes'], name)
        raw_files.append({'path': name, 'bytes': size})
        if SQLITE_FILE_RE.fullmatch(name):
            sqlite_sizes.append(size)
            continue
        if name.startswith('manabitan-dictionary-media-v1/') and not GENERATION_MEDIA_RE.fullmatch(name):
            raise ValueError(f'Unrecognized generation-media filename: {name}')
        normalized = GENERATION_MEDIA_PATH if GENERATION_MEDIA_RE.fullmatch(name) else name
        if normalized not in EXPECTED_PRODUCT_PATHS[dictionary]:
            raise ValueError(f'Unknown non-SAH storage path: {name}')
        if normalized in product:
            raise ValueError(f'Duplicate normalized storage path: {normalized}')
        product[normalized] = size
    if set(product) != EXPECTED_PRODUCT_PATHS[dictionary]:
        raise ValueError('Missing required non-SAH storage paths')
    if total != sum(item['bytes'] for item in raw_files):
        raise ValueError('Storage total does not equal complete file inventory')
    if len(sqlite_sizes) != SQLITE_FILE_COUNT:
        raise ValueError('Unexpected SAH-pool file count')
    if sqlite_sizes.count(ALLOCATION_UNIT_BYTES) != SQLITE_EMPTY_FILE_COUNT:
        raise ValueError('Unexpected empty SAH-pool file count or size')
    active = [size for size in sqlite_sizes if size != ALLOCATION_UNIT_BYTES]
    if len(active) != 1 or active[0] <= ALLOCATION_UNIT_BYTES:
        raise ValueError('Expected exactly one active SAH-pool file')
    active_bytes = active[0]
    if active_bytes % ALLOCATION_UNIT_BYTES:
        raise ValueError('Active SAH-pool allocation is not 4,096-byte aligned')
    active_units = active_bytes // ALLOCATION_UNIT_BYTES
    if dictionary == 'vndb' and not VNDB_ACTIVE_MIN_UNITS <= active_units <= VNDB_ACTIVE_MAX_UNITS:
        raise ValueError('VNDB active SAH allocation exceeds the frozen 129–131-unit range')
    return {
        'policyVersion': POLICY_VERSION,
        'dictionary': dictionary,
        'rawStorageBytes': total,
        'rawFiles': sorted(raw_files, key=lambda item: item['path']),
        'nonSahFiles': [{'path': name, 'bytes': product[name]} for name in sorted(product)],
        'nonSahBytes': sum(product.values()),
        'sahPool': {
            'fileCount': len(sqlite_sizes),
            'emptyFileCount': sqlite_sizes.count(ALLOCATION_UNIT_BYTES),
            'emptyFileBytes': ALLOCATION_UNIT_BYTES,
            'allocationUnitBytes': ALLOCATION_UNIT_BYTES,
            'sortedFileBytes': sorted(sqlite_sizes),
            'activeFileBytes': active_bytes,
            'activeAllocationUnits': active_units,
            'totalBytes': sum(sqlite_sizes),
        },
    }


def storage_comparison_key(receipt):
    """Return the prospective cross-observation invariant, retaining raw data.

    Revalidate the embedded raw inventory so a modified normalized field cannot
    hide a storage difference during an offline audit.
    """
    checked = normalize_storage_receipt({
        'kind': STORAGE_KIND, 'bytes': receipt['rawStorageBytes'], 'files': receipt['rawFiles'],
    }, receipt['dictionary'])
    if checked != receipt:
        raise ValueError('Normalized storage receipt does not match its raw inventory')
    pool = checked['sahPool']
    active_rule = (
        {'mode': 'bounded-allocation', 'minimumUnits': VNDB_ACTIVE_MIN_UNITS,
         'maximumUnits': VNDB_ACTIVE_MAX_UNITS, 'allocationUnitBytes': ALLOCATION_UNIT_BYTES}
        if checked['dictionary'] == 'vndb' else
        {'mode': 'exact-allocation', 'activeFileBytes': pool['activeFileBytes']}
    )
    return {
        'policyVersion': POLICY_VERSION,
        'dictionary': checked['dictionary'],
        'nonSahFiles': checked['nonSahFiles'],
        'sahFileCount': pool['fileCount'],
        'sahEmptyFileCount': pool['emptyFileCount'],
        'sahEmptyFileBytes': pool['emptyFileBytes'],
        'sahActiveAllocationRule': active_rule,
    }


def compare_storage_receipts(baseline, candidate, dictionary):
    """Compare two raw native inventories and retain both allocation metrics."""
    a = normalize_storage_receipt(baseline, dictionary)
    b = normalize_storage_receipt(candidate, dictionary)
    if storage_comparison_key(a) != storage_comparison_key(b):
        raise ValueError('Normalized storage path/size invariants differ')
    return {
        'policyVersion': POLICY_VERSION,
        'dictionary': dictionary,
        'baseline': a,
        'candidate': b,
        'rawStorageDeltaBytes': b['rawStorageBytes'] - a['rawStorageBytes'],
        'activeSahDeltaBytes': b['sahPool']['activeFileBytes'] - a['sahPool']['activeFileBytes'],
        'nonSahBytesEqual': a['nonSahBytes'] == b['nonSahBytes'],
    }
