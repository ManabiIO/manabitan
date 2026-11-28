"""Identity and fixed-pair summaries shared by the two independent cohorts."""
import hashlib
import json
import pathlib
import statistics
import subprocess
import sys
import time

BASE_SHA = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
BASE_C = '5a8257cb77d061694b6b2d247057aebb53ea2f49521d8d9893b3af175f145d8a'
BASE_WASM = '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'
CANDIDATE_C = '358428813d7452f55dfd084ee84cc1437e944bd790acaed41adf1634d477cf68'
PATCH_SHA = '34a56bd9e40f5cd52ffa3ae3c8914ded15d89df6958d6dc54d4a517735c5b117'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

def git(root, *arguments):
    return subprocess.check_output(['git', *arguments], cwd=root, text=True).strip()

def identity(root):
    return {'root': str(root), 'head': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'),
        'trackedChanges': git(root, 'status', '--porcelain', '--untracked-files=no'),
        'cSha256': sha(root / 'ext/js/dictionary/wasm/term-bank-parser.c'),
        'wasmSha256': sha(root / 'ext/lib/term-bank-parser.wasm'),
        'trackedWasmSha256': sha(root / 'dev/data/dictionary-wasm/term-bank-parser.wasm'),
        'manifestSha256': sha(root / 'dev/data/dictionary-wasm/manifest.json'),
        'dependencyLockSha256': sha(root / 'package-lock.json')}

def checked_sources(baseline, candidate):
    first, second = identity(baseline), identity(candidate)
    assert first['head'] == second['head'] == BASE_SHA
    assert first['cSha256'] == BASE_C and first['wasmSha256'] == BASE_WASM
    assert not first['trackedChanges'], 'Baseline source is dirty'
    assert second['cSha256'] == CANDIDATE_C
    assert first['dependencyLockSha256'] == second['dependencyLockSha256']
    assert first['trackedWasmSha256'] == first['wasmSha256']
    assert second['trackedWasmSha256'] == second['wasmSha256']
    changed = set(git(candidate, 'diff', '--name-only').splitlines())
    assert changed == {'ext/js/dictionary/wasm/term-bank-parser.c', 'dev/data/dictionary-wasm/term-bank-parser.wasm', 'dev/data/dictionary-wasm/manifest.json'}, changed
    return first, second

def tooling_receipt(here):
    tooling = here.parents[3]
    names = ['candidate.patch', 'diagnostic-fields.json', 'expected-mechanics.json', 'prepare.py', 'cohort_tools.py',
        'run.py', 'screen.mjs', 'smoke.mjs', 'native-oracle.mjs', 'preflight.py', 'setup.sh', 'negative-fixtures.mjs', 'negative-screen.mjs',
        'negative-run.py', 'output-digest.mjs', 'workflow.yml', 'negative-control-protocol-review.json',
        'prospective-complete-import-criteria.json', 'preparation-record.json', '../qualification/term-bank-prefix-selector-fixtures.js',
        '../qualification/term-bank-prefix-selector-reuse.test.js']
    hashes = {name: sha(here / name) for name in names}
    assert hashes['candidate.patch'] == PATCH_SHA
    return {'head': git(tooling, 'rev-parse', 'HEAD'), 'hashes': hashes,
        'fixtureLockSha256': sha(tooling / 'test/perf/dictionaries.lock.json')}

def runtime_receipt():
    node = subprocess.check_output(['node', '--version'], text=True).strip()
    assert node == 'v22.22.0', node
    return {'node': node, 'python': sys.version, 'browser': None,
        'host': subprocess.check_output(['uname', '-a'], text=True).strip(),
        'cpu': subprocess.check_output(['lscpu'], text=True),
        'compiler': subprocess.check_output(['clang-21', '--version'], text=True),
        'linker': subprocess.check_output(['wasm-ld-21', '--version'], text=True)}

def schedule():
    return [{'pair': pair, 'arm': arm} for pair in range(4) for arm in ('ABCD' if pair % 2 == 0 else 'DCBA')]

def child(command, prefix, timeout=1200, emit_receipt=False):
    started = time.time()
    def emit_failure_progress(stderr):
        for line in stderr.splitlines():
            if not line.startswith(('PREFIX_NEGATIVE_PASS ', 'PREFIX_NEGATIVE_CHILD_FAILED ', 'PREFIX_NEGATIVE_CHILD_START ')):
                continue
            tag, _, payload = line.partition(' ')
            try:
                receipt = json.loads(payload)
            except json.JSONDecodeError:
                receipt = {'unparsedPartialReceipt': payload}
            print('PREFIX_CHILD_PROGRESS ' + json.dumps({'label': prefix.name, 'tag': tag, 'receipt': receipt}, separators=(',', ':')), flush=True)
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode(errors='replace') if isinstance(value, bytes) else (value or '')
        pathlib.Path(str(prefix) + '.stdout.json').write_text(decoded(error.stdout))
        pathlib.Path(str(prefix) + '.stderr.log').write_text(decoded(error.stderr))
        status = {'label': prefix.name, 'command': command, 'startedEpoch': started,
            'finishedEpoch': time.time(), 'timeoutSeconds': timeout, 'status': 'timeout'}
        pathlib.Path(str(prefix) + '.child-status.json').write_text(json.dumps(status, indent=2) + '\n')
        print('PREFIX_CHILD_STATUS ' + json.dumps(status, separators=(',', ':')), flush=True)
        emit_failure_progress(decoded(error.stderr))
        raise
    pathlib.Path(str(prefix) + '.stdout.json').write_text(result.stdout)
    pathlib.Path(str(prefix) + '.stderr.log').write_text(result.stderr)
    status = {'label': prefix.name, 'command': command, 'startedEpoch': started,
        'finishedEpoch': time.time(), 'exitCode': result.returncode, 'status': 'completed'}
    pathlib.Path(str(prefix) + '.child-status.json').write_text(json.dumps(status, indent=2) + '\n')
    print('PREFIX_CHILD_STATUS ' + json.dumps(status, separators=(',', ':')), flush=True)
    if result.returncode != 0:
        emit_failure_progress(result.stderr)
        raise RuntimeError(f'{prefix.name}: child failed code={result.returncode}, stderr={result.stderr[-2000:]}')
    data = json.loads(result.stdout)
    data['observationStartedEpoch'] = started
    if emit_receipt:
        print('PREFIX_CHILD_RECEIPT ' + json.dumps({'label': prefix.name, 'command': command,
            'startedEpoch': started, 'finishedEpoch': status['finishedEpoch'], 'result': data}, separators=(',', ':')), flush=True)
    return data

def paired_summaries(observations, metrics):
    assert len(observations) == 16
    result = {}
    for metric in metrics:
        for comparison, first_arm, second_arm in [('candidate', 'A', 'B'), ('identicalControl', 'C', 'D')]:
            first_values, second_values = [], []
            for pair in range(4):
                row = {item['arm']: item['result'] for item in observations if item['pair'] == pair}
                first_values.append(row[first_arm][metric]); second_values.append(row[second_arm][metric])
            assert all(value > 0 for value in first_values + second_values), metric
            changes = [100 * (second / first - 1) for first, second in zip(first_values, second_values)]
            result[f'{comparison}.{metric}'] = {'pairedChangesPercent': changes,
                'medianPairedChangePercent': statistics.median(changes),
                'equalWorkChangePercent': 100 * (sum(second_values) / sum(first_values) - 1),
                'fasterPairs': sum(change < 0 for change in changes)}
    return result

def check_diagnostic(c):
    assert c is not None
    assert c['admissions'] == c['noPrefixCandidate'] + c['selected']
    assert c['candidateRecordsInspected'] == sum(c[name] for name in ['definitionLengthRejected', 'rulesLengthRejected', 'definitionSignatureRejected', 'rulesSignatureRejected', 'selected'])
    assert c['selected'] == sum(c[name] for name in ['boundsRejected', 'openerRejected', 'tailRejected', 'middleRejected', 'fullRejected', 'hits'])
    assert c['selected'] == sum(c[f'selectedDistance{i}'] for i in range(1, 5))
    assert c['hits'] == sum(c[f'hitDistance{i}'] for i in range(1, 5))
    assert c['fullBytesOffered'] == c['hitBytes'] + c['failedFullBytesOffered']
    assert c['totalGlossaryReuses'] == c['originalGlossaryReuses'] + c['hits']
    assert c['selected'] <= c['admissions'] <= c['keyIdentityRows'] <= c['originalLookbackZeroRows']

def assert_expected(actual, expected, label):
    for key, value in expected.items():
        assert actual[key] == value, f'{label}: {key}: actual={actual[key]}, expected={value}'
