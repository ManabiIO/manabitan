#!/usr/bin/env python3
"""Preserve complete observation metrics independently of expiring Actions logs."""
import hashlib
import json
import sys
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pack(root, run_id, artifact_id, output):
    root = Path(root)
    output = Path(output)
    manifest = read(root / 'manifest.json')
    timing = read(root / 'results.json')
    diagnostics = read(root / 'diagnostics.json')
    observations = []
    for observation in timing.get('observations', []) + diagnostics.get('observations', []):
        item = dict(observation)
        directory = root / observation['id']
        report_path = directory / 'run-1.json'
        if report_path.exists():
            report = read(report_path)
            payloads = [p['data'] for p in report.get('phases', []) if isinstance(p.get('data'), dict) and 'importDebug' in p['data']]
            item['rawReportSha256'] = digest(report_path)
            item['report'] = {k: report.get(k) for k in [
                'startedAtIso', 'status', 'failureReason', 'browserFlavor', 'buildTarget',
                'packageSha256', 'browserVersion', 'launchMode', 'hostEnvironment',
                'benchmark', 'skippedVerification', 'skipReason',
            ]}
            item['importRuns'] = []
            for payload in payloads:
                debug = payload['importDebug']
                item['importRuns'].append({
                    'browserTiming': payload['browserTiming'],
                    'importerPhaseTimings': debug['importerPhaseTimings'],
                    'localPhaseTimings': debug['localPhaseTimings'],
                    'importOutcome': {k: v for k, v in debug.items() if k not in ['importerPhaseTimings', 'localPhaseTimings']},
                })
        command_path = directory / 'command.json'
        if command_path.exists():
            item['command'] = read(command_path)
        trace_path = directory / 'run-1.trace.json'
        if trace_path.exists():
            item['traceSha256'] = digest(trace_path)
            item['traceBytes'] = trace_path.stat().st_size
        observations.append(item)

    analysis = read(root / 'analysis.json') if (root / 'analysis.json').exists() else {}
    sources = {}
    for arm, source in manifest['sources'].items():
        entry_digests = source['packageEntries']
        sources[arm] = {k: v for k, v in source.items() if k != 'packageEntries'}
        sources[arm]['packageEntryCount'] = len(entry_digests)
        sources[arm]['allPackageEntryDigestsSha256'] = hashlib.sha256(json.dumps(entry_digests, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        sources[arm]['changedPackageEntryDigests'] = {name: entry_digests.get(name) for name in manifest['changedPackageEntries']}

    result = {
        'schemaVersion': 1,
        'purpose': 'Durable full import-phase metrics for every predeclared observation, including controls, warmups and separate traces. Raw traces are retained in the linked artifact and identified by SHA-256.',
        'run': {'id': int(run_id), 'url': f'https://github.com/ManabiIO/manabitan/actions/runs/{run_id}'},
        'artifact': {
            'id': int(artifact_id),
            'url': f'https://api.github.com/repos/ManabiIO/manabitan/actions/artifacts/{artifact_id}',
            'downloadUrl': f'https://api.github.com/repos/ManabiIO/manabitan/actions/artifacts/{artifact_id}/zip',
            'zipSha256': digest(root / 'evidence.zip'),
            'zipBytes': (root / 'evidence.zip').stat().st_size,
            'retentionDays': 14,
        },
        'rawFileDigests': {name: digest(root / name) for name in ['manifest.json', 'results.json', 'diagnostics.json']},
        'manifest': {**{k: v for k, v in manifest.items() if k != 'sources'}, 'sources': sources},
        'timingCohort': {k: v for k, v in timing.items() if k != 'observations'},
        'traceCohort': {k: v for k, v in diagnostics.items() if k != 'observations'},
        'observations': observations,
        'derivedMeasuredMetrics': {k: analysis.get(k) for k in ['measuredObservations', 'allMeasured', 'byArm', 'pairedMetrics']},
        'traceAttribution': analysis.get('traces'),
        'interpretationLimits': analysis.get('interpretationLimits'),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'output': str(output.resolve()), 'bytes': output.stat().st_size, 'observations': len(observations), 'timingComplete': timing['complete'], 'traceComplete': diagnostics['complete'], 'sha256': digest(output)}))


if __name__ == '__main__':
    pack(*sys.argv[1:])
