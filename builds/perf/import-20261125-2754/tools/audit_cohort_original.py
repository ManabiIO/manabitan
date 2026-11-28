#!/usr/bin/env python3
"""Reopen fixed-cohort raw reports and independently reconcile paired analysis."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import sys

ROOT = Path('/workspace/scratch/2754d3e3fa09')
NODE = ROOT / 'runtime/node_modules/node/bin/node'
REPO = ROOT / 'manabitan'
sys.path.insert(0, str(ROOT / 'studies/dev/perf/import-storage-20261124-3aac'))
from storage_receipts import normalize_storage_receipt, storage_comparison_key


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compare(a, b):
    changes = [(y / x - 1) * 100 for x, y in zip(a, b, strict=True)]
    randomizer = random.Random(20261124)
    samples = sorted(statistics.median(randomizer.choices(changes, k=len(changes))) for _ in range(10000))
    return {
        'pairs': len(changes), 'fasterPairs': sum(x < 0 for x in changes),
        'pairedChangesPercent': changes,
        'pairedMedianPercent': statistics.median(changes),
        'pairedMedianBootstrap95Percent': [samples[249], samples[9749]],
        'equalWorkPercent': (sum(b) / sum(a) - 1) * 100,
        'baselineMedianMs': statistics.median(a), 'candidateMedianMs': statistics.median(b),
        'bestPairPercent': min(changes), 'worstPairPercent': max(changes),
    }


def audit(path, candidate):
    protocol, state = read(path / 'protocol.json'), read(path / 'state.json')
    observations, analysis = read(path / 'observations.json'), read(path / 'analysis.json')
    dictionary = protocol['dictionary']
    assert state['status'] == 'success' and analysis['status'] == 'complete'
    assert protocol['sourceIdentities']['A']['commit'] == '7d1643e6147a10cb2165e9744cf0e63b59e46632'
    assert protocol['sourceIdentities']['B']['commit'] == candidate
    assert protocol['sourceIdentities']['A'] == protocol['sourceIdentities']['C']
    assert protocol['harnessOverlay'] is None and protocol['nodeVersion'] == 'v22.22.0'
    assert sha(path.parent / 'runner.py') == protocol['runnerSha256']
    for name, digest in protocol['storagePolicySha256'].items():
        assert sha(path.parent / 'storage-policy' / name) == digest
    for name, digest in protocol['unchangedHarnessSha256'].items():
        assert sha(REPO / name) == digest, name
    expected = [(f'warmup-{arm}', arm, 'excluded-warmup', None, None, 'sample')
                for arm in ('CBA' if protocol['reversedSchedule'] else 'ABC')]
    for block, order in enumerate(protocol['orders'], 1):
        expected.extend((f'block-{block:02d}-{pos}-{arm}', arm, 'timed', block, pos, 'sample')
                        for pos, arm in enumerate(order, 1))
    expected.extend((f'diagnostic-{arm}', arm, 'exhaustive-diagnostic', None, None, 'all')
                    for arm in protocol['diagnosticArms'])
    assert len(observations) == len(expected) == state['attemptedObservations']
    assert len(protocol['orders']) == protocol['plannedBlocks']
    packages = {arm: read(path / f'package-{arm}.json') for arm in 'ABC'}
    assert packages['A']['entries'] == packages['C']['entries']
    assert packages['A']['archiveSha256'] == packages['C']['archiveSha256']
    differences = sorted(name for name in packages['A']['entries'].keys() | packages['B']['entries'].keys()
                         if packages['A']['entries'].get(name) != packages['B']['entries'].get(name))
    assert differences == protocol['expectedPackageDifferences'] == read(path / 'package-differences.json')
    for entry, planned in zip(observations, expected, strict=True):
        assert tuple(entry.get(k) for k in ['name', 'arm', 'cohort', 'block', 'position', 'mediaCheck']) == planned
        assert entry['status'] == 'success'
        assert entry['source'] == protocol['sourceIdentities'][entry['arm']]
        summary = read(path / entry['name'] / 'summary.json')
        assert summary['fixture'] == protocol['fixture']
        assert summary['gitSha'] == entry['source']['commit'] == summary['source']['gitSha']
        assert summary['source']['dirty'] is False
        assert summary['traceEnabled'] is False and summary['importFlags'] is None
        assert summary['authoritativeTiming'] is True and summary['buildTarget'] == 'chrome'
        assert summary['browserVersion'] == analysis['browserVersion'] == state['browserVersion']
        assert summary['hostEnvironment']['nodeVersion'] == 'v22.22.0'
        assert summary['source']['sha256']['builds/manabitan-chrome.zip'] == packages[entry['arm']]['archiveSha256']
        assert len(summary['runs']) == 1
        assert summary['runs'][0]['packageSha256'] == packages[entry['arm']]['archiveSha256']
        assert summary['runs'][0]['totalImportMs'] == entry['totalImportMs']
    node_source = r'''
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import {createHash} from 'node:crypto'
const [repo, root] = process.argv.slice(1)
const {extractImportResult} = await import(pathToFileURL(repo + '/dev/perf/benchmark-support.js'))
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const protocol = read(root + '/protocol.json')
const out = []
for (const entry of read(root + '/observations.json')) {
  const summary = read(root + '/' + entry.name + '/summary.json')
  const report = read(root + '/' + entry.name + '/run-1.json')
  const result = extractImportResult(report, protocol.dictionary, protocol.fixture, false, null, entry.mediaCheck)
  for (const [key, value] of Object.entries(result)) {
    if (!isDeepStrictEqual(value, summary.runs[0][key])) throw new Error(entry.name + ': raw summary mismatch ' + key)
  }
  if (report.packageSha256 !== summary.runs[0].packageSha256 || report.buildTarget !== 'chrome' || report.browserVersion !== summary.browserVersion) throw new Error(entry.name + ': raw identity mismatch')
  const v = result.validation
  const lookups = v.lookup.observations.map(x => [x.pass, x.term, x.results, x.sha256]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  out.push({name: entry.name, totalImportMs: result.totalImportMs, lookupDigest: createHash('sha256').update(JSON.stringify(lookups)).digest('hex'), contentDigest: v.outputDigestSha256, media: v.media, storage: v.storage})
}
process.stdout.write(JSON.stringify(out))
'''
    raw = json.loads(subprocess.run([str(NODE), '--input-type=module', '-e', node_source, str(REPO), str(path)],
                                   check=True, capture_output=True, text=True).stdout)
    invariants, media = [], {}
    storage_totals = []
    for entry, result in zip(observations, raw, strict=True):
        assert entry['name'] == result['name'] and entry['totalImportMs'] == result['totalImportMs']
        assert math.isfinite(result['totalImportMs']) and result['totalImportMs'] > 0
        receipt = normalize_storage_receipt(result['storage'], dictionary)
        assert receipt == read(path / entry['name'] / 'storage-receipt.json')
        invariants.append((result['lookupDigest'], result['contentDigest'], storage_comparison_key(receipt)))
        mode = result['media']['mode']
        if mode in media:
            assert media[mode] == result['media']
        media[mode] = result['media']
        storage_totals.append(result['storage']['bytes'])
    assert all(value == invariants[0] for value in invariants)
    values = {arm: [row['totalImportMs'] for row in observations if row['cohort'] == 'timed' and row['arm'] == arm] for arm in 'ABC'}
    assert values == analysis['allTimingsMs']
    results = {}
    for name, first, second in [('candidate', 'A', 'B'), ('candidateVsSecondBaseline', 'C', 'B'), ('identicalProductControl', 'A', 'C')]:
        calculated = compare(values[first], values[second])
        for key, value in calculated.items():
            assert value == analysis[name][key], (name, key)
        results[name] = calculated
    return {'status': 'passed', 'dictionary': dictionary, 'stage': protocol['stage'],
            'sourceIdentities': protocol['sourceIdentities'], 'observationsReopened': len(raw),
            'timedObservations': sum(len(x) for x in values.values()), 'comparisons': results,
            'exhaustiveMedia': media['all'], 'storageBytesRange': [min(storage_totals), max(storage_totals)],
            'packageDifferences': differences, 'rawReportsRevalidated': True,
            'rawReportValidator': 'unchanged frozen benchmark-support.js',
            'analysisRecomputedIndependently': True,
            'limits': 'Descriptive fixed-cohort results; no multiple-comparison correction; separate stages not pooled.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', required=True)
    parser.add_argument('cohorts', type=Path, nargs='+')
    args = parser.parse_args()
    for cohort in args.cohorts:
        result = audit(cohort, args.candidate)
        destination = cohort.parent / 'independent-timing-audit.json'
        destination.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
        print(json.dumps({'path': str(destination), 'status': result['status'], 'dictionary': result['dictionary'],
                          'observations': result['observationsReopened']}))
