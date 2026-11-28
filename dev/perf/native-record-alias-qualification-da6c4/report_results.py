#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Always expose compact original receipts and failure logs through Actions stdout."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def emit(path, root, value):
    print('ALIAS_RECEIPT ' + json.dumps({'path': path.relative_to(root).as_posix(),
          'sha256': sha(path), 'data': value}, sort_keys=True, allow_nan=False), flush=True)


def report(root):
    root = Path(root)
    if not root.is_dir():
        print('ALIAS_SETUP_MISSING ' + str(root), flush=True)
        return
    failures = []
    selected = (
        'run-state.json', 'setup-failure.json', 'pre-acquisition-binding.json',
        'package-delta.json', 'repository-gates.json', 'preflight-gate.json',
        'browser-preflight-binding.json', 'observations.json', 'analysis.json',
        'memory/memory-comparison.json', 'memory/memory-audit.json',
    )
    seen = set()
    for relative in selected:
        path = root / relative
        if not path.is_file():
            continue
        try:
            value = json.loads(path.read_text())
            if relative == 'run-state.json':
                value = {key: value.get(key) for key in ('complete', 'mode', 'dictionary', 'initialOrder', 'baseline',
                    'candidate', 'phase', 'observations', 'failures', 'cleanupFailures', 'commands')}
            emit(path, root, value)
            seen.add(path)
        except Exception as error:
            failures.append({'path': relative, 'message': str(error)})
    for path in sorted(root.rglob('*.json')):
        if path in seen or path.name not in ('observation.json', 'canonical-receipt.json', 'layout.json',
                                             'browser-verification.json', 'sampling-failure.json'):
            continue
        try:
            value = json.loads(path.read_text())
            if path.name == 'layout.json':
                phases = value.get('importDebug', {}).get('importerPhaseTimings', [])
                value = {key: value.get(key) for key in ('complete', 'request', 'fixture', 'files', 'headerLinkage',
                    'exclusiveTermHandles', 'failure', 'cleanupFailures')}
                original = json.loads(path.read_text())
                value['probes'] = {key: original.get('probes', {}).get(key) for key in
                                  ('physicalOutputDigestSha256', 'semanticProbeDigestSha256')}
                value['nativeImportPhases'] = [phase for phase in phases
                    if str(phase.get('phase', '')).startswith('term-file-fast-path:')]
            elif path.name == 'browser-verification.json':
                value = {key: value.get(key) for key in ('complete', 'arm', 'sourceCommit', 'sourceTree',
                    'naturalCoreSha256', 'pipelineSha256', 'naturalVerificationReportSha256',
                    'naturalComparisonReportSha256', 'browserLayoutReportSha256', 'verifiedRows',
                    'inputLogicalSha256', 'nativePreparedGroups', 'aliasProofs', 'coldLookupProbes',
                    'coldRecordProbes', 'maximumRssKiB', 'quiescenceAfterRead',
                    'browserNaturalTermFileEqualityEstablished', 'failures')}
            emit(path, root, value)
        except Exception as error:
            failures.append({'path': path.relative_to(root).as_posix(), 'message': str(error)})
    state = root / 'run-state.json'
    complete = state.is_file() and json.loads(state.read_text()).get('complete') is True
    if not complete:
        for path in sorted(root.rglob('*.log')):
            print('ALIAS_LOG_TAIL ' + path.relative_to(root).as_posix(), flush=True)
            print('\n'.join(path.read_text(errors='replace').splitlines()[-35:]), flush=True)
    if failures:
        print('ALIAS_REPORTER_FAILURES ' + json.dumps(failures), flush=True)
        raise RuntimeError('Some original receipt files could not be reported')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    report(args.evidence)


if __name__ == '__main__':
    main()
