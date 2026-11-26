#!/usr/bin/env python3
"""Replay existing Jitendex receipts; this script does not acquire timings."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    runner = root / 'manabitan-qualification/dev/perf/import-screen-20261126-fbc.py'
    support = root / 'manabitan-qualification/dev/perf/benchmark-support.js'
    benchmark = root / 'manabitan-qualification/dev/perf/import-benchmark.js'
    fixture_path = root / 'manabitan-qualification/test/perf/dictionaries.lock.json'
    revalidation_path = root / 'current-jitendex-baseline/revalidation.json'
    raw_path = root / 'current-jitendex-baseline/ordinary-1.json'
    paths = [runner, support, benchmark, fixture_path, revalidation_path, raw_path]
    before = {str(path.relative_to(root)): digest(path) for path in paths}
    spec = importlib.util.spec_from_file_location('jitendex_screen_independent_audit', runner)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture = json.loads(fixture_path.read_text())['dictionaries']['jitendex']
    revalidation = json.loads(revalidation_path.read_text())
    raw = json.loads(raw_path.read_text())
    receipts = module.semantic_receipts(revalidation['validation'], fixture, 'sample')
    assert raw['benchmark']['validation'] == revalidation['validation']

    support_source = support.read_text()
    provenance_start = support_source.index('export async function getSourceProvenance')
    list_start = support_source.index('for (const file of [', provenance_start)
    list_end = support_source.index(']) {', list_start)
    actual_keys = re.findall(r"'([^']+)'", support_source[list_start:list_end])
    assert tuple(actual_keys) == module.PROVENANCE_PATHS

    phases = [phase for phase in raw['phases'] if phase['name'] == fixture['label'] + ': total import']
    assert len(phases) == 1
    data = phases[0]['data']
    timing = data['browserTiming']
    assert timing['trigger'] == 'file-input-change' and timing['errorCount'] == 0
    assert type(timing['sequence']) is int and type(timing['sequenceBefore']) is int
    assert timing['sequence'] > timing['sequenceBefore']
    assert all(type(timing[key]) in (int, float) for key in ['startedAtMs', 'completedAtMs'])
    duration = timing['completedAtMs'] - timing['startedAtMs']
    assert duration > 0 and duration == revalidation['totalImportMs']

    contexts = {}
    receipt_keys = set()
    for phase in data['importDebug']['importerPhaseTimings']:
        details = phase.get('details', {})
        receipt_keys.update(details)
        for marker, prefix in [('parserExperiments', 'parser'), ('fastPathParserEffectiveExperiments', 'fastPathParser')]:
            if marker not in details:
                continue
            assert prefix not in contexts
            expected = dict(zip(['BankSpanCount', 'SourceCompressedBytes', 'SourceUncompressedBytes'], module.SOURCE_BANKS['jitendex']))
            expected.update(ParallelWorkerCount=3, ParallelGroupCount=22, ParallelPipelineGroupsPerWorker=3)
            for key, value in expected.items():
                assert type(details[prefix + key]) is int and details[prefix + key] == value
            assert details[prefix + 'ParallelSkipReason'] is None
            contexts[prefix] = expected
    assert len(contexts) == 2
    assert {'parserExperiments', 'fastPathParserEffectiveExperiments', 'fastPathParserExperiments', 'compressionExperiments'} <= receipt_keys
    assert before == {str(path.relative_to(root)): digest(path) for path in paths}
    result = {
        'status': 'passed',
        'scope': 'Independent receipt replay and raw/schema inspection; no new browser observation and no timing qualification.',
        'inputSha256': before,
        'receiptFingerprints': {key: module.fingerprint(value) for key, value in receipts.items()},
        'sourceProvenanceKeys': actual_keys,
        'sourceProvenanceKeyCheck': 'Exact ordered match with getSourceProvenance, including nullable chrome-dev ZIP.',
        'browserDurationMs': duration,
        'automationPhaseDurationMs': phases[0]['durationMs'],
        'timingCheck': 'Screen.validate uses browser completedAtMs minus startedAtMs; it does not substitute phase.durationMs.',
        'parserContexts': contexts,
        'summaryLimitation': 'The supplied original failed run has no summary.json. Full Screen.validate was not replayed. Summary key/type expectations were inspected against the native summary producer.',
        'originalReportStatus': raw['status'],
        'originalReportFailure': raw['failureReason'],
        'incompatibilitiesFound': [],
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'status': result['status'], 'receiptFingerprints': result['receiptFingerprints'], 'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
