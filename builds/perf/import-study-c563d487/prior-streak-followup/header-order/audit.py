#!/usr/bin/env python3
"""Read completed untimed observer records only; never execute a corpus pass."""
from pathlib import Path
import datetime
import hashlib
import json

ROOT = Path('/workspace/scratch/c563d487c718')
HERE = Path(__file__).resolve().parent
sha = lambda value: hashlib.sha256(value).hexdigest()


def read(relative):
    return json.loads((HERE / relative).read_text())


def paths(value, prefix=()):
    for key, item in value.items():
        if isinstance(item, dict):
            yield from paths(item, (*prefix, key))
        else:
            assert isinstance(item, int) and not isinstance(item, bool), (prefix, key, item)
            yield (*prefix, key), item


def at(value, keys):
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            return 0
        value = value[key]
    return value


def main():
    data = read('run-1/result.json')
    status = read('run-1.child-status.json')
    prepared = read('preparation.json')
    previous_file = ROOT / prepared['previousResultPath']
    assert sha(previous_file.read_bytes()) == prepared['previousResultSha256']
    previous = json.loads(previous_file.read_text())
    assert data['complete'] and data['failures'] == []
    assert status['exitCode'] == 0 and status['timeout'] is False
    assert status['replacement'] is False and status['requestedTiming'] is False
    assert data['observerSha256'] == status['observerSha256'] == sha((HERE / 'observer.mjs').read_bytes()) == sha((HERE / 'run-1/observer-source.mjs').read_bytes())
    assert data['observerSha256'] == '9a227bb089dc9972d139b64458477de8f6413f8c75a301e90d864924b89bd65c'
    assert status['stdoutSha256'] == sha((HERE / 'run-1.stdout.json').read_bytes())
    assert status['stderrSha256'] == sha((HERE / 'run-1.stderr.log').read_bytes())
    assert status['nodeSha256'] == '1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31'
    assert data['invocation']['execArgv'] == ['--max-old-space-size=256']
    assert data['invocation']['argv'] == status['argv'][2:]
    assert len(data['banks']) == 53 and len(data['groups']) == 8
    total = data['totals']
    aggregated_fields = 0
    for keys, expected in paths(total):
        for collection in ['banks', 'groups']:
            assert sum(at(item, keys) for item in data[collection]) == expected, (collection, keys)
        aggregated_fields += 1
    baseline_names = ['rows', 'firstRows', 'priorStreakRows', 'existingLookbackZero', 'existingLookbackPositive', 'existingGlossaryReuses', 'recentRawContentHits', 'groupEndingRawHits']
    baseline_checks = 0
    for collection in ['banks', 'groups']:
        assert len(data[collection]) == len(previous[collection])
        for got, old in zip(data[collection], previous[collection]):
            for key in baseline_names:
                assert got[key] == old[key], (collection, key)
                baseline_checks += 1
            if collection == 'banks':
                for key in ['name', 'group', 'sourceSha256', 'metadataSha256', 'nativeResult', 'nativeCapacity']:
                    assert got[key] == old[key]
                    baseline_checks += 1
            else:
                for key in ['group', 'finalBudget', 'finalStreak']:
                    assert got[key] == old[key]
                    baseline_checks += 1
    for key in baseline_names:
        assert total[key] == previous['totals'][key]
        baseline_checks += 1
    for key in ['node', 'wasmSha256', 'fixtureLockSha256', 'baselineCSourceSha256', 'archiveSha256', 'metadataDigest']:
        assert data[key] == previous[key]
    assert data['matchIndexesDigest'] == data['unfilteredOracleMatchIndexesDigest']
    assert data['everyPredicateAndRecentMatchIndexEquivalent'] is True
    assert data['baselineReplayReconciled'] is True
    assert total['signatureComputations'] + total['witnessSignatureCopies'] == total['rows']
    assert total['signaturePasses'] + total['signatureRejects'] == total['signatureComparisons']
    metrics = ['bytesOffered', 'logicalBytesCompared', 'sourceSimdBytesPerOperand', 'sourceScalarBytesPerOperand']
    variant_totals = {variant: {metric: sum(field[metric] for field in total[variant]['fields'].values())
                              for metric in [*metrics, 'equalityCalls', 'lengthChecks']}
                      for variant in ['original', 'headersFirst']}
    for metric in metrics:
        net = variant_totals['original'][metric] - variant_totals['headersFirst'][metric]
        assert net == total['netComparisonRangesSaved'][metric]
        assert net == total['savedGlossary'][metric] - total['extraHeadersAfterGlossaryReject'][metric]
    histogram = data['savedGlossaryLengthHistogram']
    assert sum(item['calls'] for item in histogram.values()) == total['savedGlossary']['calls']
    assert sum(int(length) * item['calls'] for length, item in histogram.items()) == total['savedGlossary']['bytesOffered']
    for key in ['wouldMatch', 'wouldDiffer']:
        assert sum(item[key] for item in histogram.values()) == total['savedGlossary'][key]
    assert sum(total['savedGlossary']['headerRejections'].values()) == total['savedGlossary']['calls']
    assert total['savedGlossary']['calls'] == total['original']['fields']['glossary']['equalityCalls'] - total['headersFirst']['fields']['glossary']['equalityCalls']
    assert total['extraHeadersAfterGlossaryReject']['calls'] == total['original']['fields']['glossary']['unequalCalls']
    audit = {'schema': 1, 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'scope': 'Independent integer aggregation/source-receipt audit of the single completed untimed replay; no new native or corpus execution',
             'passed': True, 'resultSha256': sha((HERE / 'run-1/result.json').read_bytes()),
             'observerSha256': data['observerSha256'], 'auditorSha256': sha(Path(__file__).read_bytes()),
             'preparationSha256': sha((HERE / 'preparation.json').read_bytes()),
             'childStatusSha256': sha((HERE / 'run-1.child-status.json').read_bytes()),
             'previousResultSha256': prepared['previousResultSha256'],
             'aggregatedIntegerFields': aggregated_fields, 'baselineBankGroupTotalChecks': baseline_checks,
             'rows': total['rows'], 'originalWitnesses': total['existingGlossaryReuses'],
             'rawRecentHits': total['recentRawContentHits'], 'rawPredicateCalls': total['original']['calls'],
             'variantTotals': variant_totals, 'savedGlossary': total['savedGlossary'],
             'addedHeadersAfterGlossaryRejection': total['extraHeadersAfterGlossaryReject'],
             'netModeledRangesSaved': total['netComparisonRangesSaved'],
             'relativeNetModeledRangesSavedPercent': {metric: 100 * total['netComparisonRangesSaved'][metric] / variant_totals['original'][metric] for metric in metrics},
             'extraEqualityCalls': variant_totals['headersFirst']['equalityCalls'] - variant_totals['original']['equalityCalls'],
             'extraEqualityCallsPercent': 100 * (variant_totals['headersFirst']['equalityCalls'] / variant_totals['original']['equalityCalls'] - 1),
             'metadataDigest': data['metadataDigest'], 'recentMatchIndexesDigest': data['matchIndexesDigest'],
             'maxima': data['maxima'], 'timingsCollected': False,
             'decision': 'Drop before product implementation: only 73,244 modeled source-SIMD bytes per operand saved across the corpus, with 23,006 more equality calls. No prototype, benchmark, performance PR, or speedup conclusion.',
             'limitations': ['Counts are an exact source-level shadow of the frozen default recent path with original signature filtering, reconciled to existing native metadata and prior baseline state totals; they are not directly instrumented native call counters.',
                             'Logical and block prefixes describe source comparison ranges per operand; compiler scheduling, hardware traffic, cache effects, CPU cost and elapsed import behavior were not measured.',
                             'The unfiltered raw-byte oracle and every per-call equivalence assertion ran in the original observer; this audit rechecks the preserved aggregate and identity receipts without another corpus pass.']}
    (HERE / 'independent-result-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    print(json.dumps({'passed': True, 'auditSha256': sha((HERE / 'independent-result-audit.json').read_bytes()),
                      'resultSha256': audit['resultSha256'], 'relativeNetModeledRangesSavedPercent': audit['relativeNetModeledRangesSavedPercent'],
                      'extraEqualityCalls': audit['extraEqualityCalls'], 'extraEqualityCallsPercent': audit['extraEqualityCallsPercent']}))


if __name__ == '__main__':
    main()
