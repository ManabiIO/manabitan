# SPDX-License-Identifier: GPL-3.0-or-later
"""Pure identity and semantic gates for complete-import qualification receipts.

The native benchmark still runs its own extractImportResult checks. These
independent checks bind that summary to its raw report and the caller's frozen
source/package identities, then compare semantic receipts across observations.
Only lookup elapsed times and explicitly recognized random storage basenames
are removed from the comparison. No storage allocation allowance is applied.
"""

from copy import deepcopy
import hashlib
import json
import math
import re


STORAGE_KIND = 'OPFS logical file sizes after restart and verification'
TIMING_BOUNDARY = 'page file-input change event to post-UI import-complete event; browser monotonic clock'
LOOKUP_BOUNDARY = 'settings-page termsFind RPC; first pass after restart, then five warm passes; excludes result hashing'
SQLITE_PREFIX = 'manabitan/sqlite-sahpool-v1/.opaque/'
SQLITE_PATH = SQLITE_PREFIX + '{opaque}'
GENERATION_MEDIA_PATH = 'manabitan-dictionary-media-v1/{generation}.bin'
GENERATION_MEDIA_RE = re.compile(
    r'manabitan-dictionary-media-v1/'
    r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin'
)
SQLITE_FILE_RE = re.compile(re.escape(SQLITE_PREFIX) + r'[a-z0-9]+')
SHA256_RE = re.compile(r'[a-f0-9]{64}')
SHA_RE = re.compile(r'[a-f0-9]{40}')
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()
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
SOURCE_HASH_FIELDS = (
    'package-lock.json', 'test/perf/dictionaries.lock.json',
    'dev/perf/benchmark-support.js', 'dev/perf/dictionary-fixtures.js',
    'dev/perf/import-benchmark.js', 'test/chromium/import-flags-ab-benchmark.js',
    'test/chromium/extension-two-dictionary-import.e2e.js', 'test/e2e/import-timing.js',
    'ext/js/pages/settings/dictionary-import-controller.js',
    'builds/manabitan-chrome.zip',
)


def _record(value, label):
    if type(value) is not dict:
        raise ValueError(f'{label} must be an object')
    return value


def _required(record, key, label):
    if key not in record:
        raise ValueError(f'Missing {label}')
    return record[key]


def _integer(value, label, minimum=0):
    if type(value) is not int or not minimum <= value <= 2 ** 53 - 1:
        raise ValueError(f'{label} must be a safe integer >= {minimum}')
    return value


def _number(value, label, minimum=0, positive=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value < minimum or (positive and value <= 0):
        raise ValueError(f'{label} must be a finite {"positive" if positive else "nonnegative"} number')
    return value


def _digest(value, label):
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise ValueError(f'{label} must be a lowercase SHA-256 digest')
    return value


def _same(actual, expected, label):
    # JSON comparison distinguishes booleans from numbers, unlike Python ==.
    try:
        equal = json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f'{label} contains invalid JSON data') from error
    if not equal:
        raise ValueError(f'{label} differs from the required value')


def canonicalize_storage(storage, dictionary):
    """Keep exact logical sizes, normalizing only two validated random names."""
    if dictionary not in EXPECTED_PRODUCT_PATHS:
        raise ValueError('Unsupported frozen dictionary storage policy')
    storage = _record(storage, 'storage')
    if set(storage) != {'kind', 'bytes', 'files'} or storage['kind'] != STORAGE_KIND:
        raise ValueError('Unexpected storage receipt fields or kind')
    total = _integer(storage['bytes'], 'storage total', 1)
    files = storage['files']
    if type(files) is not list or not files:
        raise ValueError('Storage must contain its complete file inventory')
    seen = set()
    product_paths = set()
    sqlite_sizes = []
    normalized = []
    for item in files:
        if type(item) is not dict or set(item) != {'path', 'bytes'}:
            raise ValueError('Unexpected storage file receipt fields')
        path = item['path']
        if not isinstance(path, str) or not path or path in seen:
            raise ValueError('Invalid or duplicate storage file path')
        seen.add(path)
        size = _integer(item['bytes'], f'storage file {path}')
        if SQLITE_FILE_RE.fullmatch(path):
            sqlite_sizes.append(size)
            path = SQLITE_PATH
        else:
            if path.startswith(SQLITE_PREFIX):
                raise ValueError('Unrecognized SAH opaque basename')
            if path.startswith('manabitan-dictionary-media-v1/'):
                if GENERATION_MEDIA_RE.fullmatch(path) is None:
                    raise ValueError('Unrecognized generation-media UUID basename')
                path = GENERATION_MEDIA_PATH
            if path not in EXPECTED_PRODUCT_PATHS[dictionary] or path in product_paths:
                raise ValueError(f'Unexpected or duplicate normalized product path: {path}')
            product_paths.add(path)
        normalized.append({'path': path, 'bytes': size})
    if product_paths != EXPECTED_PRODUCT_PATHS[dictionary]:
        raise ValueError('Missing required product storage paths')
    if total != sum(item['bytes'] for item in normalized):
        raise ValueError('Storage total differs from the complete file inventory')
    if len(sqlite_sizes) != 8 or sqlite_sizes.count(4096) != 7:
        raise ValueError('Expected eight SAH files with seven empty 4096-byte files')
    active = [size for size in sqlite_sizes if size != 4096]
    if len(active) != 1 or active[0] <= 4096 or active[0] % 4096:
        raise ValueError('Expected one aligned active SAH allocation')
    # Retain the prior prospective VNDB bound and additionally require exact
    # sizes across observations. Even one allowed page's difference fails the
    # cross-observation comparison; the range never replaces actual bytes.
    if dictionary == 'vndb' and not 129 <= active[0] // 4096 <= 131:
        raise ValueError('VNDB active SAH allocation is outside 129–131 pages')
    return {'kind': storage['kind'], 'bytes': total,
            'files': sorted(normalized, key=lambda item: (item['path'], item['bytes']))}


def canonicalize_validation(validation, *, dictionary, fixture, media_check):
    """Validate all semantic coverage and preserve every field except elapsedMs."""
    validation = _record(validation, 'validation')
    fixture = _record(fixture, 'fixture')
    if media_check not in ('sample', 'all'):
        raise ValueError('media_check must be sample or all')
    _integer(fixture.get('termRows'), 'fixture term rows', 1)
    _integer(fixture.get('mediaFiles'), 'fixture media files')
    _integer(fixture.get('mediaBytes'), 'fixture media bytes')
    restart = _record(validation.get('restart'), 'restart')
    for key, expected in (('title', fixture['expectedTitle']), ('revision', fixture['revision']),
                          ('termRows', fixture['termRows']), ('contentReadable', True), ('probeCount', 12)):
        _same(validation.get(key), expected, f'validation.{key}')
        _same(restart.get(key), expected, f'restart.{key}')
    _same(restart.get('mediaFiles'), fixture['mediaFiles'], 'restart.mediaFiles')
    _digest(validation.get('outputDigestSha256'), 'content output digest')
    terms = validation.get('probeTerms')
    if type(terms) is not list or len(terms) != 12 or any(not isinstance(term, str) or not term for term in terms) or len(set(terms)) != 12:
        raise ValueError('Expected twelve distinct nonempty probe terms')
    lookup = _record(validation.get('lookup'), 'lookup')
    _same(lookup.get('timingBoundary'), LOOKUP_BOUNDARY, 'lookup timing boundary')
    rows = lookup.get('observations')
    if type(rows) is not list or len(rows) != 72:
        raise ValueError('Expected all 72 lookup observations')
    expected_pairs = {(number, term) for number in range(6) for term in terms}
    pairs = set()
    term_results = {}
    canonical_rows = []
    for row in rows:
        row = _record(row, 'lookup observation')
        number = _integer(row.get('pass'), 'lookup pass')
        term = row.get('term')
        if not isinstance(term, str) or (number, term) not in expected_pairs or (number, term) in pairs:
            raise ValueError('Unknown or duplicate lookup pass/term')
        pairs.add((number, term))
        _number(row.get('elapsedMs'), 'lookup elapsedMs')
        results = _integer(row.get('results'), 'lookup result count', 1)
        _same(row.get('originalTextLength'), len(term.encode('utf-16-le', errors='surrogatepass')) // 2, 'lookup original text length')
        _same(row.get('hasExactHeadwordMatch'), True, 'exact headword match')
        digest = _digest(row.get('sha256'), 'lookup digest')
        semantic_result = (results, digest)
        if term in term_results and term_results[term] != semantic_result:
            raise ValueError('Lookup result changes between cold and warm passes')
        term_results[term] = semantic_result
        copied = deepcopy(row)
        del copied['elapsedMs']
        canonical_rows.append(copied)
    if pairs != expected_pairs:
        raise ValueError('Incomplete lookup pass/term coverage')
    media = _record(validation.get('media'), 'media')
    expected_files = fixture['mediaFiles'] if media_check == 'all' else min(64, fixture['mediaFiles'])
    for key, expected in (('mode', media_check), ('totalFiles', fixture['mediaFiles']),
                          ('totalBytes', fixture['mediaBytes']), ('files', expected_files)):
        _same(media.get(key), expected, f'media.{key}')
    media_bytes = _integer(media.get('bytes'), 'verified media bytes')
    _digest(media.get('sha256'), 'media digest')
    if media_bytes > fixture['mediaBytes'] or (expected_files > 0 and media_bytes == 0):
        raise ValueError('Invalid verified media byte count')
    if (media_check == 'all' or expected_files == fixture['mediaFiles']) and media_bytes != fixture['mediaBytes']:
        raise ValueError('Complete media verification must cover every byte')
    if expected_files == 0 and (media_bytes != 0 or media['sha256'] != EMPTY_SHA256):
        raise ValueError('Empty media receipt differs from the empty digest')
    canonical = deepcopy(validation)
    canonical['storage'] = canonicalize_storage(validation.get('storage'), dictionary)
    canonical['lookup']['observations'] = sorted(canonical_rows, key=lambda row: (row['pass'], row['term']))
    return canonical


def validate_import_summary(summary, report, *, dictionary, fixture, source_sha, package_sha256,
                            browser_version=None, import_flags=None, source_hashes=None,
                            source_dirty=False, media_check='sample'):
    """Bind one summary/raw report to frozen identities and return semantic keys.

    source_hashes, when supplied, maps report provenance paths to their expected
    hashes. The caller separately freezes the complete harness dependency set;
    the native report exposes only its documented provenance subset. A dirty
    source is accepted only when explicitly requested for the marker overlay.
    """
    summary = _record(summary, 'summary')
    report = _record(report, 'raw report')
    if not isinstance(source_sha, str) or SHA_RE.fullmatch(source_sha) is None:
        raise ValueError('Expected source must be a full lowercase commit SHA')
    _digest(package_sha256, 'expected package digest')
    if type(source_dirty) is not bool:
        raise ValueError('Expected source dirty state must be explicit')
    if import_flags is not None and type(import_flags) is not dict:
        raise ValueError('Expected import flags must be an object or null')
    for key, expected in (('schemaVersion', 3), ('dictionary', dictionary), ('buildTarget', 'chrome'),
                          ('fixture', fixture), ('traceEnabled', False), ('authoritativeTiming', True),
                          ('importFlags', import_flags), ('mediaCheck', media_check), ('gitSha', source_sha),
                          ('timingBoundary', TIMING_BOUNDARY)):
        _same(_required(summary, key, f'summary.{key}'), expected, f'summary.{key}')
    runs = summary.get('runs')
    if type(runs) is not list or len(runs) != 1:
        raise ValueError('Expected exactly one native benchmark run')
    run = _record(runs[0], 'run')
    _same(run.get('index'), 1, 'run index')
    _same(_required(run, 'tracePath', 'run trace path'), None, 'run trace path')
    source = _record(summary.get('source'), 'source')
    _same(source.get('gitSha'), source_sha, 'source commit')
    _same(source.get('dirty'), source_dirty, 'source dirty state')
    hashes = _record(source.get('sha256'), 'source hashes')
    for name in SOURCE_HASH_FIELDS:
        _digest(hashes.get(name), f'source hash {name}')
    _same(hashes['builds/manabitan-chrome.zip'], package_sha256, 'source package digest')
    if source_dirty and (type(source_hashes) is not dict or 'test/chromium/extension-two-dictionary-import.e2e.js' not in source_hashes):
        raise ValueError('Marker-overlay source requires an explicit expected harness hash')
    if source_hashes is not None:
        for name, expected in _record(source_hashes, 'expected source hashes').items():
            _same(_required(hashes, name, f'source hash {name}'), expected, f'source hash {name}')
    browser = summary.get('browserVersion')
    if not isinstance(browser, str) or re.fullmatch(r'\d+(?:\.\d+){3}', browser) is None:
        raise ValueError('Missing full browser version')
    if browser_version is not None:
        _same(browser, browser_version, 'cohort browser version')
    _same(run.get('browserVersion'), browser, 'run browser version')
    _same(report.get('browserVersion'), browser, 'report browser version')
    for value in (run, report):
        _same(value.get('packageSha256'), package_sha256, 'reported package digest')
    for key, expected in (('status', 'success'), ('skippedVerification', False), ('buildTarget', 'chrome'),
                          ('browserFlavor', 'chromium'), ('launchMode', 'headless')):
        _same(report.get(key), expected, f'report.{key}')
    for value in (summary, report):
        _same(_record(value.get('hostEnvironment'), 'host environment').get('nodeVersion'), 'v22.22.0', 'pinned Node version')
    benchmark = _record(report.get('benchmark'), 'report benchmark')
    for key, expected in (('dictionary', dictionary), ('pinnedDictionaries', True), ('productionImportDefaults', True),
                          ('traceEnabled', False), ('authoritativeTiming', True), ('phaseProfiling', False),
                          ('phaseScreenshots', False), ('processSampling', False), ('importFlags', import_flags),
                          ('mediaCheck', media_check)):
        _same(_required(benchmark, key, f'benchmark.{key}'), expected, f'benchmark.{key}')
    _same(run.get('validation'), benchmark.get('validation'), 'summary/raw validation binding')
    validation = canonicalize_validation(run.get('validation'), dictionary=dictionary, fixture=fixture, media_check=media_check)
    phases = report.get('phases')
    if type(phases) is not list or any(type(phase) is not dict for phase in phases):
        raise ValueError('Invalid raw phase list')
    imports = [phase for phase in phases if phase.get('name') == f'{fixture["label"]}: total import']
    triggers = [phase for phase in phases if phase.get('name') == f'Import {fixture["label"]} via file input']
    if len(imports) != 1 or len(triggers) != 1:
        raise ValueError('Missing or duplicate complete-import/trigger phase')
    phase, trigger = imports[0], triggers[0]
    start = _number(phase.get('startMs'), 'import phase start')
    end = _number(phase.get('endMs'), 'import phase end')
    duration = _number(phase.get('durationMs'), 'import phase duration', positive=True)
    trigger_start = _number(trigger.get('startMs'), 'file input start')
    trigger_end = _number(trigger.get('endMs'), 'file input end')
    if start != trigger_start or trigger_end < trigger_start or end < trigger_end or abs(duration - (end - start)) > 0.001:
        raise ValueError('Raw total-import timing excludes file input or visible completion')
    _same(run.get('automationObservedImportMs'), duration, 'automation timing binding')
    data = _record(phase.get('data'), 'import phase data')
    _same(data.get('kind'), 'dictionary-import', 'import phase kind')
    _same(data.get('dictionary'), fixture['label'], 'import phase dictionary')
    timing = _record(data.get('browserTiming'), 'browser import timing')
    browser_start = _number(timing.get('startedAtMs'), 'browser import start')
    browser_end = _number(timing.get('completedAtMs'), 'browser import end')
    sequence = _integer(timing.get('sequence'), 'import sequence')
    before = _integer(timing.get('sequenceBefore'), 'preceding import sequence')
    if browser_end <= browser_start or sequence <= before:
        raise ValueError('Stale or incomplete browser import timing')
    _same(timing.get('trigger'), 'file-input-change', 'browser timing trigger')
    _same(timing.get('errorCount'), 0, 'browser timing error count')
    total = _number(run.get('totalImportMs'), 'complete import duration', positive=True)
    if abs(total - (browser_end - browser_start)) > 0.001:
        raise ValueError('Summary duration differs from browser monotonic timing')
    timing_summary = _record(summary.get('timing'), 'duration summary')
    _same(timing_summary.get('count'), 1, 'duration sample count')
    for key in ('minMs', 'medianMs', 'p95Ms', 'maxMs'):
        _same(timing_summary.get(key), total, f'duration summary {key}')
    debug = _record(run.get('importDebug'), 'import debug')
    _same(debug, data.get('importDebug'), 'summary/raw import completion binding')
    _same(run.get('step4Breakdown'), data.get('step4Breakdown'), 'summary/raw parser policy binding')
    _same(run.get('stepTimingSummary'), data.get('stepTimingSummary'), 'summary/raw step timing binding')
    for key, expected in (('hasResult', True), ('resultTitle', fixture['expectedTitle']),
                          ('errorCount', 0), ('addSettingsErrorCount', 0), ('usesFallbackStorage', False)):
        _same(debug.get(key), expected, f'import completion {key}')
    media = validation.pop('media')
    return {'browserVersion': browser,
            'common': {'dictionary': dictionary, 'fixture': deepcopy(fixture),
                       'importFlags': deepcopy(import_flags), 'validation': validation},
            'media': media}


def require_matching_receipts(reference, candidate, *, compare_media=True):
    """Compare every semantic field; full media uses a separate media reference."""
    reference = _record(reference, 'reference receipt')
    candidate = _record(candidate, 'candidate receipt')
    if type(compare_media) is not bool:
        raise ValueError('Media comparison choice must be explicit')
    if set(reference) != {'browserVersion', 'common', 'media'} or set(candidate) != set(reference):
        raise ValueError('Unexpected semantic receipt fields')
    for receipt in (reference, candidate):
        _record(receipt['common'], 'common semantic receipt')
        _record(receipt['media'], 'media semantic receipt')
    for key in ('browserVersion', 'common', *(('media',) if compare_media else ())):
        _same(candidate[key], reference[key], f'cross-observation {key}')
