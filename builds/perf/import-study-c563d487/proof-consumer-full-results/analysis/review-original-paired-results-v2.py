#!/usr/bin/env python3
"""Read-only terminal evidence reconciliation; never invokes the importer."""
from pathlib import Path
import collections
import datetime
import hashlib
import json
import math
import random
import re
import statistics
import sys

ROOT = Path('/workspace/scratch/c563d487c718/experiments')
EVIDENCE = ROOT / 'numeric-suffix-proof-consumer-982-full-evidence'
DEST = Path(__file__).with_name('independent-paired-result-review-v2.json')
CELLS = ('jmdict-AB', 'jmdict-BA', 'jitendex-AB', 'jitendex-BA', 'vndb-AB', 'vndb-BA')
JOBS = (140967463788, 140967463778, 140967463739, 140967463737, 140967463725, 140967463694)
BASELINE = 'a300da36d00df8e353c5679b1528b50a1299b75f'
CANDIDATE = '61ac55c50d9ade7b90dbeb9299de18e094e25044'
EXPECTED = '006d19ea2498cb3b561f084dba2c41b133c0c5b23a65137b8afb7756716f49f9'
MARKER = re.compile(r'\bMANABITAN_QUALIFICATION_JSON (\{.*\})\s*$')


def identity(path):
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}


def records(path):
    found = []
    for line in path.read_text().splitlines():
        match = MARKER.search(line)
        if match:
            found.append('MANABITAN_QUALIFICATION_JSON ' + match.group(1))
    return found, [json.loads(line.split(' ', 1)[1]) for line in found]


def require_equal_number(actual, expected, label):
    assert isinstance(actual, (int, float)) and not isinstance(actual, bool), label
    assert isinstance(expected, (int, float)) and not isinstance(expected, bool), label
    assert math.isfinite(actual) and math.isfinite(expected), label
    assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10), (label, actual, expected)


def ordered_sum(values):
    # Mirrors JavaScript's explicit left-to-right reduce, independent of Python sum version.
    result = 0
    for value in values:
        result += value
    return result


def pair_statistics(rows, right_arm):
    by_pair = {}
    for row in rows:
        pair = by_pair.setdefault(row['pair'], {})
        assert row['arm'] not in pair
        pair[row['arm']] = row
    assert sorted(by_pair) == list(range(1, len(by_pair) + 1))
    pairs = []
    for number, arms in sorted(by_pair.items()):
        assert set(arms) == {'A', right_arm}
        left = arms['A']['durationMs']
        right = arms[right_arm]['durationMs']
        assert left > 0 and right > 0
        pairs.append({'pair': number, 'baselineId': arms['A']['id'],
                      'candidateId': arms[right_arm]['id'], 'baselineMs': left,
                      'candidateMs': right, 'changeMs': right - left,
                      'ratio': right / left, 'changePercent': (right / left - 1) * 100})
    ratios = [pair['ratio'] for pair in pairs]
    rng = random.Random(897)
    bootstraps = sorted(statistics.median([ratios[int(rng.random() * len(ratios))]
                                          for _ in ratios]) for _ in range(10000))
    left = [pair['baselineMs'] for pair in pairs]
    right = [pair['candidateMs'] for pair in pairs]
    return {'count': len(pairs), 'ratios': ratios, 'baselineMs': left, 'candidateMs': right,
            'baselineMedianMs': statistics.median(left), 'candidateMedianMs': statistics.median(right),
            'medianPairedChangeMs': statistics.median(pair['changeMs'] for pair in pairs),
            'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
            'equalWorkChangePercent': (ordered_sum(right) / ordered_sum(left) - 1) * 100,
            'worstPairChangePercent': (max(ratios) - 1) * 100,
            'fasterPairs': sum(ratio < 1 for ratio in ratios),
            'descriptiveBootstrap95Percent': [(bootstraps[index] - 1) * 100 for index in (249, 9749)],
            'pairs': pairs}


def match_statistics(actual, expected, label):
    # The original observer publishes seven fields; the primary audit also publishes
    # absolute durations and medians. Check every field that each producer emits.
    for key, reference in expected.items():
        assert key in actual, (label, key)
        value = actual[key]
        if isinstance(value, list):
            assert len(value) == len(reference), (label, key)
            for index, (a, b) in enumerate(zip(value, reference)):
                require_equal_number(a, b, f'{label}.{key}[{index}]')
        else:
            require_equal_number(value, reference, f'{label}.{key}')


def review_cell(cell, job):
    directory = EVIDENCE / cell
    record_path = directory / 'primary-records.jsonl'
    log_path = directory / 'primary-job.log'
    audit_path = directory / 'primary-log-audit.json'
    raw_path = directory / 'raw-recovery-1/independent-raw-evidence-audit.json'
    for path in (record_path, log_path, audit_path, raw_path):
        assert path.is_file(), f'All six terminal primary and original raw audits required: {path}'
    lines, rows = records(record_path)
    log_lines, log_rows = records(log_path)
    assert lines == log_lines and rows == log_rows and len(rows) == 55
    audit = json.loads(audit_path.read_text())
    raw_audit = json.loads(raw_path.read_text())
    dictionary, order = cell.rsplit('-', 1)
    assert raw_audit['auditIntegrityPassed'] is True
    assert raw_audit['runId'] == 46141233321 and raw_audit['jobId'] == job
    assert raw_audit['dictionary'] == dictionary and raw_audit['order'] == order
    assert raw_audit['expectedSha256'] == EXPECTED
    assert raw_audit['primaryRecordsSha256'] == identity(record_path)['sha256']
    assert raw_audit['auditorSha256'] == '2dcd4c56bed134871a1cc35b5b05d170d73bca47aeb74ae38bbed9bb3ee6ace0'
    assert audit['jobId'] == job and audit['runId'] == 46141233321
    assert isinstance(audit['errors'], list)
    assert audit['allChecksPass'] is (audit['errors'] == [])
    assert audit['expectedSha256'] == EXPECTED
    assert audit['cohort']['baseline'] == BASELINE and audit['cohort']['candidate'] == CANDIDATE
    assert audit['primaryLogSha256'] == identity(log_path)['sha256']
    assert audit['rawTaggedRecordsSha256'] == identity(record_path)['sha256']
    observations = [row['value'] for row in rows if row['kind'] == 'observation']
    assert len(observations) == 42
    roles = collections.Counter(value['role']['kind'] for value in observations)
    assert roles == {'candidate': 24, 'control': 8, 'warmup': 4, 'memory': 4, 'exhaustive-media': 2}
    clock_rows = []
    for observation in observations:
        clocks = [phase['browserTiming'] for phase in observation['rawPhases']
                  if isinstance(phase.get('browserTiming'), dict)]
        assert len(clocks) == 1
        clock = clocks[0]
        assert clock['errorCount'] == 0 and clock['sequence'] == clock['sequenceBefore'] + 1
        duration = clock['completedAtMs'] - clock['startedAtMs']
        assert duration > 0
        # Exact arithmetic equality with the original browser clock, before rounded prose.
        assert duration == observation['run']['totalImportMs']
        assert duration == observation['summary']['timing']['medianMs']
        assert observation['summary']['timing']['count'] == 1
        clock_rows.append({'id': observation['id'], **observation['role'], 'durationMs': duration})
    candidate = pair_statistics([row for row in clock_rows if row['kind'] == 'candidate'], 'B')
    control = pair_statistics([row for row in clock_rows if row['kind'] == 'control'], 'C')
    assert candidate['count'] == 12 and control['count'] == 4
    files = {row['value']['path']: row['value']['value'] for row in rows if row['kind'] == 'result-file'}
    assert len(files) == 6
    for name, calculated in [('candidateVsBaseline', candidate), ('identicalCodeControl', control)]:
        match_statistics(calculated, audit[name], 'primary.' + name)
        match_statistics(calculated, files['analysis.json'][name], 'original.' + name)
    memory_rows = files['memory/observations.json']
    assert len(memory_rows) == 4
    assert {(row['pair'], row['arm']) for row in memory_rows} == {(p, a) for p in (1, 2) for a in ('A', 'B')}
    all_qualified = all(row['qualifiedForWholeTreePss'] for row in memory_rows)
    memory_metrics = {}
    for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
        changes = []
        for pair in (1, 2):
            arms = {row['arm']: row for row in memory_rows if row['pair'] == pair}
            if arms['A']['qualifiedForWholeTreePss'] and arms['B']['qualifiedForWholeTreePss']:
                left, right = arms['A'][metric], arms['B'][metric]
                assert left > 0 and right > 0
                changes.append((right / left - 1) * 100)
        memory_metrics[metric] = {'medianPairedChangePercent': statistics.median(changes) if all_qualified else None,
                                  'maximumPairedChangePercent': max(changes) if all_qualified else None}
        for key, value in memory_metrics[metric].items():
            original = audit['memoryMetrics'][metric][key]
            if value is None:
                assert original is None
            else:
                require_equal_number(value, original, metric + '.' + key)
    memory_pass = all_qualified and all(value['medianPairedChangePercent'] <= 5 and value['maximumPairedChangePercent'] <= 10
                                      for value in memory_metrics.values())
    assert memory_pass == audit['recomputedMemoryPass'] == audit['memoryAudit']['passesProspectiveMemoryScreen']
    assert memory_pass == raw_audit['memory']['rawAudit']['passesProspectiveMemoryScreen']
    assert memory_metrics == raw_audit['memory']['rawAudit']['metrics']
    assert files['memory/semantic-failures.json'] == []
    assert files['analysis.json']['memoryPassed'] is memory_pass
    assert files['analysis.json']['status'] == ('correctness-memory-passed' if memory_pass else 'memory-or-semantics-failed')
    # The primary auditor includes expected qualification failures in allChecksPass.
    # Reconstruct only those exact errors from original memory data; all other errors reject.
    qualification_errors = []
    if not memory_pass:
        qualification_errors += ['Original correctness/memory gate did not pass',
                                 'Separate memory observations/audit did not qualify']
    for row in memory_rows:
        if not (row['qualifiedForWholeTreePss'] is True and row['qualificationFailures'] == []):
            qualification_errors.append(row['name'] + ': memory coverage did not qualify')
        sufficient = row['stableFullyReadImportSampleCount'] >= 5 and all(
            math.isfinite(row[name]) and 0 <= row[name] <= 250
            for name in ('preImportBracketGapMs', 'postImportBracketGapMs', 'maximumCoveredSampleGapMs'))
        if not sufficient:
            qualification_errors.append(row['name'] + ': emitted prospective memory coverage is insufficient')
    assert audit['errors'] == qualification_errors, (cell, 'Unexpected primary integrity/qualification error', audit['errors'], qualification_errors)
    if cell == 'vndb-AB':
        assert qualification_errors == ['Original correctness/memory gate did not pass',
            'Separate memory observations/audit did not qualify',
            'A1: memory coverage did not qualify', 'A1: emitted prospective memory coverage is insufficient',
            'A2: memory coverage did not qualify', 'A2: emitted prospective memory coverage is insufficient']
        assert memory_pass is False and all(value is None for metric in memory_metrics.values() for value in metric.values())
    else:
        assert qualification_errors == [] and memory_pass is True
    return {'cell': cell, 'jobId': job, 'inputs': [identity(path) for path in (record_path, log_path, audit_path, raw_path)],
            'originalPrimaryAllChecksPass': audit['allChecksPass'],
            'independentlyReproducedQualificationErrors': qualification_errors,
            'exactOriginalLogRecordCount': len(rows), 'exactBrowserClockCount': len(clock_rows),
            'candidateVsBaseline': candidate, 'identicalCodeControl': control,
            'controlChangePercentRange': [min(p['changePercent'] for p in control['pairs']), max(p['changePercent'] for p in control['pairs'])],
            'memorySummaryArithmetic': {'qualified': all_qualified, 'metrics': memory_metrics, 'passesDeclaredScreen': memory_pass,
               'observations': [{key: row[key] for key in ('name', 'arm', 'pair', 'qualifiedForWholeTreePss', 'qualificationFailures',
                   'maximumCoveredSampleGapMs', 'stableFullyReadImportSampleCount', 'maxSampledPssKiB', 'maxSampledPrivateKiB')}
                    for row in memory_rows]},
            'primaryStorageBytes': audit['storageBytes'], 'primarySemanticSha256': audit['lookupSemanticSha256'],
            'rawAuditBoundSeparately': identity(raw_path),
            'mechanicalTargetThresholdPass': audit['mechanicalTargetThresholdPass'],
            'mechanicalNonTargetHoldSignal': audit['mechanicalNonTargetHoldSignal'],
            'allIndependentArithmeticChecksPass': True}


def main():
    assert not DEST.exists(), 'Do not overwrite any prior replay result'
    result = {'schemaVersion': 1, 'recordedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'Independent original browser-clock, paired latency/control/bootstrap and memory-summary arithmetic review. Original raw-scan/schema/semantic/package replay remains separately source-bound to row-owner audits.',
              'runId': 46141233321, 'baseline': BASELINE, 'candidate': CANDIDATE,
              'reviewSource': identity(Path(__file__)), 'pythonVersion': sys.version,
              'method': {'bootstrapSeed': 897, 'bootstrapResamples': 10000, 'bootstrapPercentileIndices': [249, 9749],
                         'bootstrapRandom': 'Python standard random.Random; independent of JavaScript reimplementation',
                         'sumArithmetic': 'explicit left-to-right floating addition',
                         'numericComparisonRelativeTolerance': 1e-12, 'numericComparisonAbsoluteTolerance': 1e-10,
                         'clockEquality': 'exact completedAtMs minus startedAtMs equals original totalImportMs and summary median'},
              'cells': [review_cell(cell, job) for cell, job in zip(CELLS, JOBS)],
              'limitations': ['No new acquisition, native code, browser, build or test ran.',
                  'This replay does not independently rerun process-tree scan classification; separate original-archive audits do.',
                  'All original paired/control outliers and discordant phases remain; no subtraction, exclusions, pooling or reruns.',
                  'The numerical gate flags alone are not a promotion decision; control scale and both corpus order cells must be reviewed.',
                  'Separate job assignments do not prove distinct physical hosts.'],
              'allEvidenceReconciliationChecksPass': True}
    DEST.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': identity(DEST), 'cells': len(result['cells']), 'browserClocks': sum(c['exactBrowserClockCount'] for c in result['cells'])}))


if __name__ == '__main__':
    main()
