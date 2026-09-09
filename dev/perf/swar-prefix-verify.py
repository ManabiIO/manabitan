"""Independent frozen-source importer comparison; no retries or dropped observations."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import traceback
import zipfile

A, B, OUT = map(Path, sys.argv[1:4])
D = sys.argv[4]
REVERSE = len(sys.argv) > 5
ROOTS = {'A': A.resolve(), 'B': B.resolve()}
PACKAGE = 'builds/manabitan-chrome-dev.zip'
COMMON = ['package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/benchmark-support.js', 'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js', 'test/chromium/import-flags-ab-benchmark.js', 'test/chromium/extension-two-dictionary-import.e2e.js', 'test/e2e/import-timing.js', 'ext/js/pages/settings/dictionary-import-controller.js']
RUNTIME = ['ext/lib/term-bank-parser.wasm', 'ext/js/dictionary/wasm/term-bank-parser.c']


def check(ok, message):
    if not ok:
        raise ValueError(message)


def load(path):
    return json.loads(path.read_text())


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def identity(root):
    check(not git(root, 'status', '--porcelain'), 'dirty source')
    return {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'sha256': {p: sha(root / p) for p in COMMON + RUNTIME + [PACKAGE]}}


def audit(root, target, frozen, fixture, banks):
    summary = load(target / 'summary.json')
    raw = load(target / 'run-1.json')
    check(raw['status'] == 'success' and raw['skippedVerification'] is False, 'failed or skipped import')
    check(summary['schemaVersion'] == 3 and summary['authoritativeTiming'] is True and summary['traceEnabled'] is False, 'non-authoritative summary')
    config = raw['benchmark']
    check(all(config[k] is True for k in ['pinnedDictionaries', 'productionImportDefaults', 'authoritativeTiming']), 'changed import policy')
    check(all(config[k] is False for k in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling']), 'instrumented timing')
    check(config['importFlags'] is None and summary['importFlags'] is None, 'changed flags')
    check(summary['source']['dirty'] is False and summary['source']['gitSha'] == frozen['commit'], 'wrong source')
    for path in COMMON + [PACKAGE]:
        check(summary['source']['sha256'][path] == frozen['sha256'][path], 'changed report fingerprint: ' + path)
    check(summary['timingBoundary'] == 'page file-input change event to post-UI import-complete event; browser monotonic clock', 'changed timing boundary')
    check(len(summary['runs']) == 1, 'unexpected run count')
    run = summary['runs'][0]
    ms = run['totalImportMs']
    check(math.isfinite(ms) and ms > 0, 'invalid elapsed time')
    v = run['validation']
    check((v['title'], v['revision'], v['termRows']) == (fixture['expectedTitle'], fixture['revision'], fixture['termRows']), 'wrong persisted metadata')
    check(v['contentReadable'] is True and v['probeCount'] == 12, 'unreadable content')
    debug = run['importDebug']
    check(debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and debug['usesFallbackStorage'] is False, 'errors or fallback storage')
    phases = [p['details'] for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    for key, expected in [('batchedFileCount', len(banks)), ('rows', fixture['termRows']), ('parserSourceUncompressedBytes', sum(b.file_size for b in banks)), ('parserSourceCompressedBytes', sum(b.compress_size for b in banks))]:
        check(sum(p[key] for p in phases) == expected, 'incomplete accounting: ' + key)
    policy = sorted({p['sourceBatchMaxBytes'] for p in phases})
    check(policy and all(isinstance(v, int) and v > 0 for v in policy), 'missing source policy')
    dedup = {k: sum(p[k] for p in phases) for k in ['dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount']}
    counters = {k: sum(p.get(k, 0) for p in phases) for k in ['parserParseBankMs', 'parserLookupIndexPrepareMs', 'parserSourceInflateMs', 'bulkAddTermsMs', 'dedupScanMs', 'contentAppendMs', 'contentStoreMs', 'dedupRecentSourceCacheMs']}
    return {'ms': ms, 'validation': v, 'dedup': dedup, 'sourceBudgetBytes': policy, 'browserVersion': run['browserVersion'], 'hostEnvironment': summary['hostEnvironment'], 'overlappingCountersMs': counters}


def stats(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    return {'pairsMs': pairs, 'pairedChangesPercent': changes, 'medianPairedChangePercent': statistics.median(changes), 'aggregateChangePercent': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1), 'fasterPairs': sum(b < a for a, b in pairs), 'worstPairPercent': max(changes)}


OUT.mkdir(parents=True, exist_ok=False)
rows = []
try:
    frozen = {arm: identity(root) for arm, root in ROOTS.items()}
    check(frozen['A']['commit'] == '03478be25506176610b2133be658ee697d9bb3f1', 'wrong baseline')
    check(frozen['B']['tree'] == '68a31e0ec29969000adbd3ba7435a71d7ebdb966', 'wrong candidate tree')
    for p in COMMON:
        check(frozen['A']['sha256'][p] == frozen['B']['sha256'][p], 'different harness/lock: ' + p)
    fixture = load(A / 'test/perf/dictionaries.lock.json')['dictionaries'][D]
    for root in ROOTS.values():
        path = root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
        check(path.stat().st_size == fixture['sizeBytes'] and sha(path) == fixture['sha256'], 'wrong fixture bytes')
    with zipfile.ZipFile(A / 'builds/e2e-dictionary-cache' / fixture['cacheFile']) as z:
        banks = [i for i in z.infolist() if re.fullmatch(r'term_bank_\d+\.json', i.filename)]
    with zipfile.ZipFile(A / PACKAGE) as a, zipfile.ZipFile(B / PACKAGE) as b:
        check(a.namelist() == b.namelist(), 'different packaged member order')
        changed = sorted(n for n in a.namelist() if a.read(n) != b.read(n))
        check(changed == ['js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm'], 'unexpected package difference')
    save('IDENTITY.json', {'arms': frozen, 'fixture': fixture, 'changedPackageMembers': changed})
    plan = []
    for pair in range(-1, 6):
        order = 'AB' if (pair + int(REVERSE)) % 2 == 0 else 'BA'
        plan.extend({'kind': 'warmup' if pair < 0 else 'AB', 'pair': pair, 'arm': arm} for arm in order)
        if pair in (1, 4):
            arm = 'A' if pair == 1 else 'B'
            plan.extend({'kind': 'AA', 'pair': pair, 'arm': arm} for _ in range(2))
    save('PLAN.json', {'dictionary': D, 'observations': plan, 'retries': 0, 'pairs': 6})
    for index, item in enumerate(plan):
        target = OUT / f'{index:02d}-{item["kind"]}-{item["arm"]}'
        row = dict(item, index=index, path=target.name)
        rows.append(row)
        save('OBSERVATIONS.json', rows)
        with (OUT / f'{index:02d}.log').open('w') as log:
            result = subprocess.run(['node', 'dev/perf/import-benchmark.js', D, '--runs', '1', '--no-build', '--output', str(target.resolve())], cwd=ROOTS[item['arm']], stdout=log, stderr=subprocess.STDOUT, timeout=240, check=False)
        row['returncode'] = result.returncode
        check(result.returncode == 0, 'benchmark command failed')
        row.update(audit(ROOTS[item['arm']], target, frozen[item['arm']], fixture, banks))
        check(identity(ROOTS[item['arm']]) == frozen[item['arm']], 'source changed during plan')
        save('OBSERVATIONS.json', rows)
        print(index, D, item['kind'], item['arm'], row['ms'], flush=True)
    pairs = []
    for p in range(6):
        values = {r['arm']: r for r in rows if r['kind'] == 'AB' and r['pair'] == p}
        check(set(values) == {'A', 'B'}, 'incomplete pair')
        for field in ['dedup', 'sourceBudgetBytes', 'browserVersion']:
            check(values['A'][field] == values['B'][field], 'unequal pair ' + field)
        pairs.append([values[arm]['ms'] for arm in 'AB'])
    controls = {}
    for arm in 'AB':
        values = [r for r in rows if r['kind'] == 'AA' and r['arm'] == arm]
        check(len(values) == 2 and values[0]['dedup'] == values[1]['dedup'], 'invalid same-build control')
        controls[arm] = stats([[r['ms'] for r in values]])
        check(identity(ROOTS[arm]) == frozen[arm], 'final identity changed')
    save('RESULTS.json', {'status': 'complete', 'dictionary': D, 'AB': stats(pairs), 'sameBinaryControls': controls})
except BaseException as error:
    save('OBSERVATIONS.json', rows)
    save('FAILURE.json', {'status': 'incomplete', 'error': repr(error), 'traceback': traceback.format_exc(), 'effectEstimate': None})
    raise
