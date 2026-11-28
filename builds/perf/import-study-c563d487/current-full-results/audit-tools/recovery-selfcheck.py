#!/usr/bin/env python3
"""Artificial archive/tag corruption checks only; no product or measurement input."""
import argparse
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    own = Path(__file__).resolve().parent
    helper = own.parent / 'numeric-suffix-972-full-qualification/published-faf6d9d9/tree/dev/perf/import-numeric-suffix-972-qualification-c563d487/archive-evidence.py'
    assert sha(helper) == 'c667e543855dc082d5e0adcabb5ad1a92d9e1dadbe6b64e039d0965158863b1f'
    fixture = args.output / 'synthetic-input' / 'numeric-suffix-972-c563d487-jmdict-AB'
    (fixture / 'aa').mkdir(parents=True)
    (fixture / 'aa/inner.txt').write_text('Path-component sorting differs from raw string sorting.\n')
    (fixture / 'aa.json').write_text('{"synthetic":true}\n')
    (fixture / 'empty.txt').write_bytes(b'')
    (fixture / 'payload.bin').write_bytes(b''.join(hashlib.sha256(str(i).encode()).digest() for i in range(800)))
    for arm in 'AB':
        (fixture / ('package-' + arm + '.zip')).write_bytes(('Synthetic excluded bytes ' + arm).encode())
    process = subprocess.run([sys.executable, str(helper), '--evidence', str(fixture)], capture_output=True)
    (args.output / 'producer.stdout').write_bytes(process.stdout)
    (args.output / 'producer.stderr').write_bytes(process.stderr)
    assert process.returncode == 0
    entries = []
    for line in process.stdout.decode().splitlines():
        tag, raw = line.split(' ', 1)
        entries.append([tag.removeprefix('MANABITAN_EVIDENCE_ARCHIVE_'), json.loads(raw)])
    spec = importlib.util.spec_from_file_location('recovery_under_check', own / 'recover-raw-archive.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cases = [('valid-original-producer', copy.deepcopy(entries), True)]
    chunks = [i for i, value in enumerate(entries) if value[0] == 'CHUNK']
    assert len(chunks) >= 3
    def variant(name, change):
        changed = copy.deepcopy(entries)
        change(changed)
        cases.append((name, changed, False))
    variant('missing-first-chunk', lambda rows: rows.pop(chunks[0]))
    variant('duplicate-first-chunk', lambda rows: rows.insert(chunks[0], copy.deepcopy(rows[chunks[0]])))
    def swap(rows):
        rows[chunks[0]], rows[chunks[1]] = rows[chunks[1]], rows[chunks[0]]
    variant('reordered-chunks', swap)
    def changed_bytes(rows):
        data = bytearray(base64.b64decode(rows[chunks[0]][1]['data']))
        data[-1] ^= 1
        rows[chunks[0]][1]['data'] = base64.b64encode(data).decode()
    variant('one-changed-archive-byte', changed_bytes)
    variant('truncated-base64', lambda rows: rows[chunks[-1]][1].update(data=rows[chunks[-1]][1]['data'][:-2]))
    variant('missing-member', lambda rows: rows.pop(next(i for i, row in enumerate(rows) if row[0] == 'MEMBER')))
    variant('wrong-member-hash', lambda rows: next(row for row in rows if row[0] == 'MEMBER')[1].update(sha256='0' * 64))
    def wrong_blob(rows):
        for kind, value in rows:
            if kind in ('START', 'COMPLETE'):
                value['archive']['gitBlobSha1'] = '0' * 40
    variant('wrong-git-blob-hash', wrong_blob)
    def wrong_manifest(rows):
        for kind, value in rows:
            if kind in ('START', 'COMPLETE'):
                value['manifestSha256'] = '0' * 64
    variant('wrong-manifest-hash', wrong_manifest)
    variant('extra-chunk-after-complete', lambda rows: rows.append(copy.deepcopy(rows[chunks[0]])))
    variant('missing-complete', lambda rows: rows.pop())
    variant('producer-reported-failure', lambda rows: rows.insert(1, ['FAILED', {'complete': False, 'stage': 'synthetic', 'errorType': 'SyntheticError', 'acquisitionOrObservationsChanged': False}]))
    results = []
    for name, rows, should_pass in cases:
        directory = args.output / name
        directory.mkdir()
        log = directory / 'artificial-job.log'
        log.write_text(''.join('2026-11-28T00:00:00.0000000Z MANABITAN_EVIDENCE_ARCHIVE_' + kind + ' ' + json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n' for kind, value in rows))
        invocation = types.SimpleNamespace(output=directory / 'recovered', log=log, dictionary='jmdict', order='AB', job_id=140933489138)
        error = None
        try:
            outcome = module.recover(invocation)
            passed = True
        except Exception as failure:
            passed = False
            error = {'type': type(failure).__name__, 'message': str(failure)}
        result = {'name': name, 'expectedPass': should_pass, 'passed': passed, 'error': error,
                  'artificialLogSha256': sha(log), 'scope': 'Synthetic integrity test; no real CI observations'}
        (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        results.append(result)
        assert passed == should_pass, name
    result = {'schemaVersion': 1, 'complete': True,
              'scope': 'One artificial archive and twelve altered log forms; no corpus, native code, or performance acquisition',
              'producerSha256': sha(helper), 'recoverySha256': sha(own / 'recover-raw-archive.py'),
              'selfcheckSha256': sha(Path(__file__)), 'cases': results, 'allExpectedOutcomesMatched': True,
              'measurementsChanged': False}
    (args.output / 'selfcheck-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'resultSha256': sha(args.output / 'selfcheck-result.json'), 'cases': len(results),
                      'successes': sum(item['passed'] for item in results), 'expectedRejections': sum(not item['passed'] for item in results)}, indent=2))


if __name__ == '__main__':
    main()
