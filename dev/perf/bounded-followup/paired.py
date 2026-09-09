#!/usr/bin/env python3
"""Read-only, fixed-count browser import A/B with interleaved same-binary controls.

Uses each committed tree's existing schema-3 event-to-completion harness. This
is not a native Reader benchmark. No retries, outlier deletion or optional
stopping: an incomplete plan never receives a performance estimate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

COMMON = (
    'package-lock.json', 'test/perf/dictionaries.lock.json',
    'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js',
    'dev/perf/benchmark-support.js', 'test/e2e/import-timing.js',
    'test/chromium/extension-two-dictionary-import.e2e.js',
    'ext/js/pages/settings/dictionary-import-controller.js',
    'ext/lib/zstd.wasm', 'ext/lib/term-bank-parser.wasm',
    'ext/lib/zip.js', 'ext/lib/z-worker.js',
)
PACKAGE = 'builds/manabitan-chrome-dev.zip'


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
    temporary.replace(path)


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def schedule(pairs: int, reverse: bool = False) -> list[dict]:
    if pairs < 4 or pairs % 2:
        raise ValueError('Use an even pair count of at least four')
    result = []
    for kind, pair, arms in [('warmup', 0, ['baseline', 'candidate'])]:
        for position, arm in enumerate(reversed(arms) if reverse else arms):
            result.append(dict(kind=kind, pair=pair, position=position, arm=arm))
    for pair in range(1, pairs + 1):
        arms = ['baseline', 'candidate']
        if bool(pair % 2 == 0) != reverse:
            arms.reverse()
        for position, arm in enumerate(arms):
            result.append(dict(kind='ab', pair=pair, position=position, arm=arm))
        # Two A/A pairs: different source builds, same binary within each pair.
        if pair in (2, pairs - 1):
            arm = 'baseline' if pair == 2 else 'candidate'
            for position in range(2):
                result.append(dict(kind='aa', pair=pair, position=position, arm=arm))
    return result


def validate(summary: dict, report: dict, dataset: str, fixture: dict,
             policy: str, expected_source: dict) -> dict:
    if (summary.get('schemaVersion') != 3 or
            summary.get('authoritativeTiming') is not True or
            summary.get('traceEnabled') is not False or
            summary.get('dictionary') != dataset or summary.get('fixture') != fixture or
            summary.get('importFlags') is not None or len(summary.get('runs', [])) != 1):
        raise ValueError('Unexpected benchmark schema, fixture, flags or timing mode')
    if (report.get('status') != 'success' or report.get('skippedVerification') is not False or
            report.get('benchmark', {}).get('productionImportDefaults') is not True):
        raise ValueError('Failed or weakened verification')
    run = summary['runs'][0]
    elapsed = run.get('totalImportMs')
    if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed <= 0:
        raise ValueError('Invalid event-to-completion elapsed time')
    validation = run.get('validation', {})
    if (validation.get('title') != fixture['expectedTitle'] or
            validation.get('revision') != fixture['revision'] or
            validation.get('termRows') != fixture['termRows'] or
            validation.get('contentReadable') is not True or validation.get('probeCount', 0) < 12):
        raise ValueError('Persisted dictionary verification mismatch')
    source = summary.get('source', {})
    if source.get('gitSha') != expected_source['commit'] or source.get('dirty') is not False:
        raise ValueError('Tested source differs from committed clean tree')
    if source.get('sha256', {}).get(PACKAGE) != expected_source['package_sha256']:
        raise ValueError('Package changed during import')
    phases = run.get('importDebug', {}).get('importerPhaseTimings', [])
    batches = [p['details'] for p in phases if p.get('phase', '').startswith('term-file-fast-path:')]
    if not batches or sum(p.get('rows', 0) for p in batches) != fixture['termRows']:
        raise ValueError('Complete fast-path row accounting missing')
    expected_budget = (64 if policy == 'low' else 192) * 1024 * 1024
    if any(p.get('sourceBatchMaxBytes') != expected_budget for p in batches):
        raise ValueError('Actual importer selected the wrong memory tier')
    if sum(p.get('batchedFileCount', 0) for p in batches) != expected_source['bank_count']:
        raise ValueError('Complete term-bank accounting mismatch')
    # Keep overlapping worker/wall diagnostics as raw fields, never sum them
    # into total CPU or subtract them from the authoritative import interval.
    metrics = {}
    for key in ('parserSourceTransferredBytes', 'parserSourceCompressedBytes',
                'parserSourceUncompressedBytes', 'sourceArchiveReadMs',
                'parserSourceInflateMs', 'parserResultCopyMs', 'parserOrderedSinkWaitMs'):
        values = [p.get(key) for p in batches]
        metrics[key] = sum(values) if all(isinstance(v, (int, float)) for v in values) else None
    return dict(elapsed_ms=elapsed, worker_ms=run.get('workerImportMs'),
                stages=run.get('step4Breakdown'), source_metrics=metrics,
                batches=batches, validation=validation, browser=summary.get('browserVersion'))


def effects(plan: list[dict], runs: list[dict]) -> dict:
    if len(plan) != len(runs) or any(any(r.get(k) != p[k] for k in p) for p, r in zip(plan, runs)):
        raise ValueError('Incomplete or reordered plan; do not estimate an effect')
    pairs = sorted({r['pair'] for r in runs if r['kind'] == 'ab'})
    paired, baseline, candidate = [], [], []
    for pair in pairs:
        by_arm = {r['arm']: r['elapsed_ms'] for r in runs if r['kind'] == 'ab' and r['pair'] == pair}
        a, b = by_arm['baseline'], by_arm['candidate']
        baseline.append(a)
        candidate.append(b)
        paired.append(100 * (b / a - 1))
    aa = []
    for pair in sorted({r['pair'] for r in runs if r['kind'] == 'aa'}):
        rows = [r for r in runs if r['kind'] == 'aa' and r['pair'] == pair]
        aa.append(dict(arm=rows[0]['arm'], first_ms=rows[0]['elapsed_ms'],
                       second_ms=rows[1]['elapsed_ms'],
                       change_percent=100 * (rows[1]['elapsed_ms'] / rows[0]['elapsed_ms'] - 1)))
    return dict(paired_changes_percent=paired, median_paired_percent=statistics.median(paired),
                baseline_median_ms=statistics.median(baseline), candidate_median_ms=statistics.median(candidate),
                total_equal_work_percent=100 * (sum(candidate) / sum(baseline) - 1),
                worst_pair_percent=max(paired), faster_pairs=sum(x < 0 for x in paired),
                aa_controls=aa)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--dictionary', choices=['jmdict', 'jmnedict', 'jitendex'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pairs', type=int, default=6)
    parser.add_argument('--reverse', action='store_true')
    parser.add_argument('--policy', choices=['low', 'high'], default='low')
    args = parser.parse_args()
    plan = schedule(args.pairs, args.reverse)
    roots = dict(baseline=args.baseline.resolve(), candidate=args.candidate.resolve())
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixture = json.loads((roots['baseline'] / 'test/perf/dictionaries.lock.json').read_text())['dictionaries'][args.dictionary]
    import zipfile
    source = {}
    for arm, root in roots.items():
        if git(root, 'status', '--porcelain'):
            raise ValueError('Refusing a dirty source tree: ' + arm)
        archive = root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
        if digest(archive) != fixture['sha256'] or archive.stat().st_size != fixture['sizeBytes']:
            raise ValueError('Fixture bytes differ: ' + arm)
        with zipfile.ZipFile(archive) as bank_zip:
            import re
            bank_count = sum(bool(re.fullmatch(r'term_bank_\d+\.json', n)) for n in bank_zip.namelist())
        source[arm] = dict(commit=git(root, 'rev-parse', 'HEAD'), tree=git(root, 'rev-parse', 'HEAD^{tree}'),
                           package_sha256=digest(root / PACKAGE), bank_count=bank_count,
                           common={p: digest(root / p) for p in COMMON},
                           production={p: digest(root / p) for p in (
                               'ext/js/dictionary/term-bank-source-pipeline.js',
                               'ext/js/dictionary/dictionary-importer.js')})
    if source['baseline']['common'] != source['candidate']['common']:
        raise ValueError('Harness, fixture locks or native libraries differ')
    result = dict(status='running', plan=plan, runs=[], source=source, fixture=fixture,
                  policy=args.policy, platform=platform.platform(), driver_sha256=digest(Path(__file__)),
                  started_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  failure_policy='No retries; no estimates for incomplete plans')
    save(output / 'plan.json', result)
    try:
        for index, item in enumerate(plan):
            root = roots[item['arm']]
            name = f"{index:02d}-{item['kind']}-{item['pair']:02d}-{item['arm']}-{item['position']}"
            folder = output / name
            command = ['node', 'dev/perf/import-benchmark.js', args.dictionary,
                       '--runs', '1', '--no-build', '--output', str(folder)]
            print('START', name, flush=True)
            before = os.getloadavg() if hasattr(os, 'getloadavg') else None
            with (output / (name + '.log')).open('w') as log:
                subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=150)
            summary_path, report_path = folder / 'summary.json', folder / 'run-1.json'
            summary, report = json.loads(summary_path.read_text()), json.loads(report_path.read_text())
            measured = validate(summary, report, args.dictionary, fixture, args.policy, source[item['arm']])
            result['runs'].append(dict(**item, **measured, summary=str(summary_path.relative_to(output)),
                                      report_sha256=digest(report_path), summary_sha256=digest(summary_path),
                                      load_before=before, command=command))
            save(output / 'results.json', result)
            print('DONE', name, measured['elapsed_ms'], flush=True)
        for arm, root in roots.items():
            if git(root, 'status', '--porcelain') or digest(root / PACKAGE) != source[arm]['package_sha256']:
                raise ValueError('Source or package changed during verification')
        result['effect'] = effects(plan, result['runs'])
        result['status'] = 'complete'
    except BaseException as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        raise
    finally:
        save(output / 'results.json', result)
        print(result['status'], flush=True)


if __name__ == '__main__':
    main()
