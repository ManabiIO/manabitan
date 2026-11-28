#!/usr/bin/env python3
"""Read existing parser CRC counters from every original import observation."""

import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
from protocol import schedule as memory_schedule

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
EXPECTED = {
    'jmdict': {
        'parserSourceCrcScannedBytes': 0,
        'parserSourceCrcReusedBytes': 0,
        'parserSourceCrcReusedGlossaryCount': 0,
        'parserSourceCompressedBytes': 15632849,
        'parserSourceUncompressedBytes': 171617523,
        'parserParallelGroupCount': 12,
        'parserParallelWorkerCount': 3,
        'parserParallelPipelineGroupsPerWorker': 4,
        'parserFusedAttempts': 12,
        'parserFusedFallbacks': 0,
        'parserBankSpanCount': 53,
    },
    'jitendex': {
        'parserSourceCrcScannedBytes': 0,
        'parserSourceCrcReusedBytes': 0,
        'parserSourceCrcReusedGlossaryCount': 0,
        'parserSourceCompressedBytes': 33829614,
        'parserSourceUncompressedBytes': 538927310,
        'parserParallelGroupCount': 22,
        'parserParallelWorkerCount': 3,
        'parserParallelPipelineGroupsPerWorker': 3,
        'parserFusedAttempts': 22,
        'parserFusedFallbacks': 0,
        'parserBankSpanCount': 219,
    },
    'vndb': {
        'parserSourceCrcScannedBytes': 568284368,
        'parserSourceCrcReusedBytes': 3699708599,
        'parserSourceCrcReusedGlossaryCount': 6490145,
        'parserSourceCompressedBytes': 86850424,
        'parserSourceUncompressedBytes': 4267992967,
        'parserParallelGroupCount': 170,
        'parserParallelWorkerCount': 3,
        'parserParallelPipelineGroupsPerWorker': 3,
        'parserFusedAttempts': 170,
        'parserFusedFallbacks': 0,
        'parserBankSpanCount': 665,
    },
}
PACKAGE_ENTRIES = ['js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm']


def extract_metrics(report, dictionary):
    phases = [phase for phase in report['phases']
              if isinstance(phase.get('data'), dict) and phase['data'].get('kind') == 'dictionary-import']
    if len(phases) != 1:
        raise ValueError('Expected one actual complete-import phase')
    history = phases[0]['data']['importDebugHistory']
    if not isinstance(history, list) or any(not isinstance(entry, dict) for entry in history):
        raise ValueError('Invalid import debug history')
    parser_phases = []
    for entry in history:
        timings = entry.get('importerPhaseTimings', [])
        if not isinstance(timings, list) or any(not isinstance(item, dict) for item in timings):
            raise ValueError('Invalid importer phase timings')
        parser_phases.extend(item for item in timings if isinstance(item.get('details'), dict)
                             and 'parserSourceCrcScannedBytes' in item['details'])
    expected = EXPECTED[dictionary]
    if len(parser_phases) != 1:
        raise ValueError('Expected exactly one source-bound parser phase')
    phase = parser_phases[0]
    expected_name = f"term-file-fast-path:term_bank_1.json..term_bank_{expected['parserBankSpanCount']}.json"
    if phase.get('phase') != expected_name:
        raise ValueError('Unexpected parser source-bank boundary')
    metrics = {key: phase['details'].get(key) for key in expected}
    if any(type(value) is not int or value < 0 or value > 2 ** 53 - 1 for value in metrics.values()):
        raise ValueError('Parser counts and byte totals must be nonnegative safe integers')
    if metrics != expected:
        raise ValueError(f'Original import did not exercise the frozen parser/CRC path: {metrics}')
    return metrics


def timing_schedule(first):
    result = []
    opposite = first[::-1]
    for pair, order in enumerate((first, opposite), 1):
        for arm in order:
            result.append({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm})
    for pair in range(1, 13):
        for arm in first if pair % 2 else opposite:
            result.append({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm})
        if pair % 3 == 0:
            control_pair = pair // 3
            for arm in 'AC' if (control_pair + (first == 'BA')) % 2 else 'CA':
                result.append({'id': f'control-{control_pair:02d}-{arm}', 'kind': 'control', 'pair': control_pair, 'arm': arm})
    return result


def original_observations(plan):
    first = plan['initialOrder']
    if (plan['baseline'] != BASELINE or re.fullmatch(r'[0-9a-f]{40}', plan['candidate']) is None
            or plan['dictionary'] not in EXPECTED or first not in ('AB', 'BA') or plan['pairs'] != 12
            or plan['flags'] != {} or plan['expectedWorkers'] is not None
            or sorted(plan['expectedPackageEntries']) != PACKAGE_ENTRIES
            or plan['schedule'] != timing_schedule(first)
            or plan['memorySchedule'] != memory_schedule(1 if first == 'AB' else 2)):
        raise ValueError('The frozen source, schedule or flags changed')
    expected_allocation = {'unitBytes': 4096, 'rangeUnits': [37, 37], 'origin': 'explicit'} if plan['dictionary'] == 'vndb' else None
    if plan['vndbSahAllocationPolicy'] != expected_allocation:
        raise ValueError('The frozen allocation policy changed')
    observations = [{'path': item['id'], 'kind': item['kind'], 'arm': item['arm']} for item in plan['schedule']]
    observations.extend({'path': f'exhaustive-media-{arm}', 'kind': 'exhaustive-media', 'arm': arm} for arm in first)
    observations.extend({'path': f"memory/{item['name']}", 'kind': 'memory', 'arm': item['arm']}
                        for item in plan['memorySchedule'])
    return observations


def audit(evidence):
    plan = json.loads((evidence / 'registered-plan.json').read_text())
    observations = original_observations(plan)
    results = []
    failures = []
    expected_paths = {f"{item['path']}/run-1.json" for item in observations}
    actual_paths = {str(path.relative_to(evidence)) for path in evidence.rglob('run-1.json')}
    extra = sorted(actual_paths - expected_paths)
    if extra:
        failures.append({'error': 'Unplanned raw observations are present', 'paths': extra})
    for observation in observations:
        try:
            report = json.loads((evidence / observation['path'] / 'run-1.json').read_text())
            metrics = extract_metrics(report, plan['dictionary'])
            results.append({**observation, 'metrics': metrics})
        except (KeyError, TypeError, ValueError, OSError) as error:
            failures.append({**observation, 'error': str(error)})
    return {
        'scope': 'Read-only audit after acquisition of all original warmup, timed, control, media and memory reports; no new timing, counters or diagnostic reruns',
        'baseline': plan['baseline'], 'candidate': plan['candidate'], 'dictionary': plan['dictionary'],
        'initialOrder': plan['initialOrder'], 'pairs': plan['pairs'],
        'observations': results, 'failures': failures, 'passed': not failures,
        'expectedMetrics': EXPECTED[plan['dictionary']],
        'qualification': 'All 42 original imports must preserve the source-bound parser and CRC work counts. Missing/failing observations are retained and fail this gate, never replaced.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = audit(args.evidence)
    except (KeyError, TypeError, ValueError, OSError) as error:
        result = {'passed': False, 'failure': str(error), 'observations': []}
    args.evidence.mkdir(parents=True, exist_ok=True)
    (args.evidence / 'crc-execution.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps(result, sort_keys=True))
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
