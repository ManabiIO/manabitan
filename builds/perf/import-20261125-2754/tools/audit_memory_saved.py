#!/usr/bin/env python3
"""Reconcile saved raw scans using each artifact's unchanged captured auditor."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
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
    parser.add_argument('--candidate', required=True)
    parser.add_argument('artifacts', type=Path, nargs='+')
    args = parser.parse_args()
    source_directory = 'dev/perf/import-memory-20261124-3aac'
    for number, location in enumerate(args.artifacts):
        location = location.resolve()
        plan = json.loads((location / 'plan.json').read_text())
        assert plan['sourceIdentities']['A']['commit'] == '7d1643e6147a10cb2165e9744cf0e63b59e46632'
        assert plan['sourceIdentities']['B']['commit'] == args.candidate
        for filename in ['chromium_memory.py', 'audit_memory.py']:
            relative = f'{source_directory}/{filename}'
            path = location / 'source' / relative
            assert hashlib.sha256(path.read_bytes()).hexdigest() == plan['sourceFiles'][relative]
        load_module('chromium_memory', location / 'source' / source_directory / 'chromium_memory.py')
        auditor = load_module(f'captured_memory_auditor_{number}',
                              location / 'source' / source_directory / 'audit_memory.py')
        result = auditor.audit_cell(location)
        recorded = json.loads((location / 'memory-audit.json').read_text())
        assert result == recorded, 'Raw-scan replay differs from recorded memory audit'
        print(json.dumps({'auditReconciliation': 'passed', 'dictionary': plan['dictionary'],
                          'replication': plan['replication'], 'candidate': args.candidate,
                          'recordedAuditReproducedExactly': True, 'memoryAudit': result}))


if __name__ == '__main__':
    main()
