#!/usr/bin/env python3
"""Run the unchanged captured timing auditor with explicit portable locations."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--auditor', type=Path, required=True)
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--recorded-audit', type=Path, action='append',
                        help='Explicit original per-cohort audit envelope; repeat in cohort order')
    parser.add_argument('cohorts', type=Path, nargs='+')
    args = parser.parse_args()
    if args.recorded_audit is not None:
        assert len(args.recorded_audit) == len(args.cohorts), 'One recorded audit is required per cohort'
    node = args.node.resolve()
    repository = args.repository.resolve()
    assert subprocess.check_output([str(node), '--version'], text=True).strip() == 'v22.22.0'
    for number, cohort in enumerate(args.cohorts):
        cohort = cohort.resolve()
        protocol = json.loads((cohort / 'protocol.json').read_text())
        policy_path = cohort.parent / 'storage-policy/storage_receipts.py'
        assert hashlib.sha256(policy_path.read_bytes()).hexdigest() == protocol['storagePolicySha256']['storage_receipts.py']
        # The original auditor's import uses a captured absolute path. Preload
        # the hash-verified retained module, then bind only filesystem/runtime
        # locations. No validation, schedule, metric or acceptance rule changes.
        load_module('storage_receipts', policy_path)
        auditor = load_module(f'captured_timing_auditor_{number}', args.auditor.resolve())
        auditor.REPO = repository
        auditor.NODE = node
        result = auditor.audit(cohort, args.candidate)
        if args.recorded_audit is None:
            recorded = json.loads((cohort.parent / 'independent-timing-audit.json').read_text())
        else:
            envelope = json.loads(args.recorded_audit[number].read_text())
            assert envelope['status'] == 'passed'
            recorded = envelope['audit']
        assert result == recorded, 'Portable replay differs from the recorded independent audit'
        print(json.dumps({'status': 'passed', 'dictionary': result['dictionary'],
                          'observationsReopened': result['observationsReopened'],
                          'candidate': args.candidate,
                          'recordedAuditReproducedExactly': True}))


if __name__ == '__main__':
    main()
