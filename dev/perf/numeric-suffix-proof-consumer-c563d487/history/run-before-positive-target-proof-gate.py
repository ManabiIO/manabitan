#!/usr/bin/env python3
"""The completed numeric-corrected48-child acquisition, with new source bindings."""
import argparse
import hashlib
import json
import pathlib
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('dictionary', choices=['jmdict', 'jitendex', 'vndb'])
for name in ['baseline', 'candidate', 'cache', 'output']:
    parser.add_argument(name, type=pathlib.Path)
args = parser.parse_args()
for name in ['baseline', 'candidate', 'cache', 'output']:
    setattr(args, name, getattr(args, name).resolve())
args.output.mkdir(parents=True, exist_ok=True)
here = pathlib.Path(__file__).resolve().parent
tooling = here.parents[2]
script = here / 'screen.mjs'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
binding = json.loads((here / 'binding.json').read_text())
assert binding['finalized'] is True, 'Unreviewed or unresolved binding cannot acquire data'
criteria = json.loads((here / 'prospective-review-criteria.json').read_text())
assert sha(here / 'prospective-review-criteria.json') == binding['criteriaSha256']
built = json.loads((args.output / 'compiled-source-binding.json').read_text())
assert built['candidateSource'] == binding['candidateCSourceSha256']
assert built['baseline'] == binding['baseline']
correctness = json.loads((args.output / 'correctness-result.json').read_text())
assert correctness['complete'] is True and correctness['correctnessPass'] is True
assert correctness['productFilesSha256'] == built['productFilesSha256']
assert correctness['bindingSha256'] == sha(here / 'binding.json')
assert correctness['diagnosticWasmSha256'] == sha(args.output / 'diagnostic.wasm')
fields = json.loads((here / 'diagnostic-fields.json').read_text())
assert len(fields) == 16


def git(root, *arguments):
    return subprocess.check_output(['git', *arguments], cwd=root, text=True).strip()


def identity(root):
    return {'root': str(root), 'head': git(root, 'rev-parse', 'HEAD'),
            'tree': git(root, 'rev-parse', 'HEAD^{tree}'),
            'trackedChanges': git(root, 'status', '--porcelain', '--untracked-files=no'),
            'cSha256': sha(root / 'ext/js/dictionary/wasm/term-bank-parser.c'),
            'wasmSha256': sha(root / 'ext/lib/term-bank-parser.wasm'),
            'trackedWasmSha256': sha(root / 'dev/data/dictionary-wasm/term-bank-parser.wasm'),
            'manifestSha256': sha(root / 'dev/data/dictionary-wasm/manifest.json'),
            'dependencyLockSha256': sha(root / 'package-lock.json')}


baseline_identity, candidate_identity = identity(args.baseline), identity(args.candidate)
for selected in [baseline_identity, candidate_identity]:
    assert selected['head'] == binding['baseline']['commit']
    assert selected['tree'] == binding['baseline']['tree']
    assert selected['wasmSha256'] == selected['trackedWasmSha256']
    assert selected['dependencyLockSha256'] == binding['dependencyLockSha256']
assert not baseline_identity['trackedChanges']
assert baseline_identity['cSha256'] == binding['baseline']['cSha256']
assert baseline_identity['wasmSha256'] == binding['baseline']['wasmSha256']
assert baseline_identity['manifestSha256'] == binding['baseline']['manifestSha256']
assert candidate_identity['cSha256'] == binding['candidateCSourceSha256']
assert candidate_identity['wasmSha256'] == built['productFilesSha256']['dev/data/dictionary-wasm/term-bank-parser.wasm']
assert candidate_identity['manifestSha256'] == built['productFilesSha256']['dev/data/dictionary-wasm/manifest.json']
assert set(git(args.candidate, 'diff', '--name-only').splitlines()) == {
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
    'dev/data/dictionary-wasm/manifest.json',
}
for name, expected in binding['toolingFiles'].items():
    assert sha(here / name) == expected, name
schedule = []
for pair in range(4):
    order = 'ABCD' if pair % 2 == 0 else 'DCBA'
    schedule.extend({'pair': pair, 'arm': arm} for arm in order)
plan = {
    'schema': 1, 'dictionary': args.dictionary,
    'variant': 'Positive full-suffix proof consumes already parsed numeric values and ordinary recent-content equality',
    'optionsScope': 'Unchanged production-default component options; VNDB explicitly enables experimentalNativeEscapedKeys',
    'scope': 'Sequential native inflation+CRC+strict parse+completed lookup only; no browser/import/storage/compression/UI or process-memory qualification.',
    'timing': 'Unchanged completed numeric-corrected child: fresh process, two excluded warmups, one complete measured pass; digest outside each group clock before memory reuse.',
    'schedule': schedule, 'baseline': baseline_identity, 'candidate': candidate_identity,
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'browser': None, 'host': subprocess.check_output(['uname', '-a'], text=True).strip(),
    'runnerSha256': sha(pathlib.Path(__file__)), 'screenSha256': sha(script),
    'patchSha256': sha(here / 'candidate.patch'),
    'fixtureLockSha256': sha(tooling / 'test/perf/dictionaries.lock.json'),
    'toolingHead': git(tooling, 'rev-parse', 'HEAD'),
    'toolingTree': git(tooling, 'rev-parse', 'HEAD^{tree}'),
    'toolingFiles': binding['toolingFiles'], 'bindingSha256': sha(here / 'binding.json'),
    'criteriaSha256': binding['criteriaSha256'],
    'compiledSourceBindingSha256': sha(args.output / 'compiled-source-binding.json'),
    'originalCorrectnessReceiptSha256': sha(args.output / 'correctness-result.json'),
    'observations': [], 'complete': False,
}
assert plan['node'] == 'v22.22.0'
assert plan['fixtureLockSha256'] == binding['fixtureLockSha256']
report_path = args.output / 'result.json'
assert not report_path.exists(), 'Never resume or overwrite a fixed acquisition'


def save():
    report_path.write_text(json.dumps(plan, indent=2) + '\n')


def run_observation(label, root, diagnostic=False):
    if identity(args.baseline) != baseline_identity or identity(args.candidate) != candidate_identity:
        raise RuntimeError('Source identity changed during acquisition')
    # The exact successful numeric-corrected child command/options are retained.
    command = ['node', '--expose-gc', '--max-old-space-size=512', str(script), args.dictionary,
               '--source-root', str(root), '--cache-dir', str(args.cache)]
    if diagnostic:
        command.extend(['--diagnostic-wasm', str(args.output / 'diagnostic.wasm')])
    started = time.time()
    stdout_path = args.output / f'{label}.stdout.json'
    stderr_path = args.output / f'{label}.stderr.log'
    status_path = args.output / f'{label}.child-status.json'
    assert not stdout_path.exists() and not stderr_path.exists() and not status_path.exists()
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=600)
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode(errors='replace') if isinstance(value, bytes) else (value or '')
        stdout_path.write_text(decoded(error.stdout))
        stderr_path.write_text(decoded(error.stderr))
        status = {'label': label, 'command': command, 'startedEpoch': started,
                  'finishedEpoch': time.time(), 'status': 'timeout', 'timeoutSeconds': 600,
                  'stdoutSha256': sha(stdout_path), 'stderrSha256': sha(stderr_path)}
        status_path.write_text(json.dumps(status, indent=2) + '\n')
        print('SUFFIX_PROOF_CHILD_STATUS ' + json.dumps(status, separators=(',', ':')), flush=True)
        raise
    stdout_path.write_text(result.stdout)
    stderr_path.write_text(result.stderr)
    status = {'label': label, 'command': command, 'startedEpoch': started,
              'finishedEpoch': time.time(), 'status': 'completed', 'exitCode': result.returncode,
              'stdoutSha256': sha(stdout_path), 'stderrSha256': sha(stderr_path)}
    status_path.write_text(json.dumps(status, indent=2) + '\n')
    print('SUFFIX_PROOF_CHILD_STATUS ' + json.dumps(status, separators=(',', ':')), flush=True)
    if result.returncode != 0:
        raise RuntimeError(f'{label}: child failed code={result.returncode}, stderr={result.stderr[-2000:]}')
    data = json.loads(result.stdout)
    # Emit original child JSON after exit, before validations, so a later
    # assertion failure cannot hide the completed observation.
    print('SUFFIX_PROOF_CHILD_RECEIPT ' + json.dumps({'label': label, 'command': command,
          'startedEpoch': started, 'finishedEpoch': status['finishedEpoch'], 'result': data}, separators=(',', ':')), flush=True)
    expected_identity = candidate_identity if root == args.candidate else baseline_identity
    assert data['sourceRoot'] == str(root) and data['gitHead'] == expected_identity['head']
    assert data['gitTree'] == expected_identity['tree'] and data['trackedChanges'] == expected_identity['trackedChanges']
    assert data['dictionary'] == args.dictionary and data['validateGlossaryTypes'] is True
    assert data['node'] == plan['node'] and data['runnerSha256'] == plan['screenSha256']
    assert data['flags'] == criteria['componentPlan']['flags'][args.dictionary]
    assert data['filesPerGroup'] == criteria['componentPlan']['filesPerGroup'][args.dictionary]
    assert data['warmupPasses'] == (0 if diagnostic else 2)
    assert data['lockSha256'] == binding['fixtureLockSha256']
    assert data['sourceHashes']['ext/js/dictionary/wasm/term-bank-parser.c'] == expected_identity['cSha256']
    assert data['sourceHashes']['dev/data/dictionary-wasm/manifest.json'] == expected_identity['manifestSha256']
    assert data['wasmSha256'] == (sha(args.output / 'diagnostic.wasm') if diagnostic else expected_identity['wasmSha256'])
    data['observationStartedEpoch'] = started
    return data


save()
print('SUFFIX_PROOF_PLAN ' + json.dumps({k: v for k, v in plan.items() if k != 'observations'}, separators=(',', ':')), flush=True)
try:
    for step in schedule:
        arm, pair = step['arm'], step['pair']
        source = args.candidate if arm == 'B' else args.baseline
        data = run_observation(f'pair-{pair}-{arm}', source)
        if plan['observations']:
            first = plan['observations'][0]['result']
            for key in ['rows', 'digest', 'indexBytes', 'archiveSha256', 'lockSha256', 'flags', 'filesPerGroup']:
                if data[key] != first[key]:
                    raise RuntimeError(f'{arm} pair{pair}: complete-output/workload mismatch: {key}')
        plan['observations'].append({**step, 'result': data})
        save()
        print('SUFFIX_PROOF_OBSERVATION ' + json.dumps({'dictionary': args.dictionary, **step,
              **{k: data[k] for k in ['rows', 'digest', 'elapsedMs', 'cpuMs', 'inflateMs', 'inflateCpuMs', 'parseMs', 'lookupMs', 'nativeParseMs', 'fusedAttempts', 'fusedFallbacks', 'maxWasmHeapBytes']}}, separators=(',', ':')), flush=True)
    summary = {}
    # Paired summaries and their arithmetic retain the original successful
    # controller. No control subtraction or host pooling is performed.
    for metric in ['elapsedMs', 'cpuMs', 'parseMs', 'nativeParseMs', 'lookupMs']:
        for comparison, first_arm, second_arm in [('candidate', 'A', 'B'), ('identicalControl', 'C', 'D')]:
            first_values, second_values = [], []
            for pair in range(4):
                row = {item['arm']: item['result'] for item in plan['observations'] if item['pair'] == pair}
                first_values.append(row[first_arm][metric])
                second_values.append(row[second_arm][metric])
            changes = [100 * (second / first - 1) for first, second in zip(first_values, second_values)]
            summary[f'{comparison}.{metric}'] = {'pairedChangesPercent': changes,
                'medianPairedChangePercent': statistics.median(changes),
                'equalWorkChangePercent': 100 * (sum(second_values) / sum(first_values) - 1),
                'fasterPairs': sum(change < 0 for change in changes)}
    # As in the completed numeric-corrected screen, this separate instrumented
    # child runs only after all16 uninstrumented timing children.
    diagnostic = run_observation('diagnostic', args.candidate, diagnostic=True)
    first = plan['observations'][0]['result']
    for key in ['rows', 'digest', 'indexBytes', 'archiveSha256', 'lockSha256', 'flags']:
        if diagnostic[key] != first[key]:
            raise RuntimeError(f'Instrumented diagnostic changed complete output: {key}')
    counts = diagnostic['diagnostic']
    assert counts is not None and set(counts) == set(fields)
    assert all(type(value) is int and value >= 0 for value in counts.values())
    assert counts['numericRejected'] <= counts['eligibleStreakRows']
    assert counts['attempts'] <= counts['eligibleStreakRows'] - counts['numericRejected']
    assert counts['boundedRanges'] <= counts['attempts']
    assert counts['hits'] + counts['tailRejected'] + counts['fullRejected'] == counts['boundedRanges']
    assert counts['actualSuffixSuccessRows'] == counts['hits']
    assert counts['scoreTokenEndScansAvoided'] == counts['actualSuffixSuccessRows']
    assert counts['sequenceTokenEndScansAvoided'] <= counts['actualSuffixSuccessRows']
    assert counts['numericCopyRows'] == counts['actualSuffixSuccessRows'], 'Valid native corpus must reach the numeric consumer'
    assert counts['scoreConversionsAvoided'] == counts['numericCopyRows']
    assert counts['sequenceConversionsAvoided'] <= counts['numericCopyRows']
    assert counts['ordinaryContentComparisonsAvoided'] == counts['numericCopyRows'], 'Fixed default route uses ordinary recent-window dedup'
    effect = summary['candidate.elapsedMs']['medianPairedChangePercent']
    paired = summary['candidate.elapsedMs']['pairedChangesPercent']
    largest_control = max(abs(value) for value in summary['identicalControl.elapsedMs']['pairedChangesPercent'])
    plan['componentGate'] = {
        'targetPromotionSignal': args.dictionary == 'vndb' and effect <= -2 and all(v < 0 for v in paired) and -effect > largest_control,
        'nonTargetRiskSignal': args.dictionary != 'vndb' and effect > 3 and all(v > 0 for v in paired) and effect > largest_control,
        'largestAbsoluteControlChangePercent': largest_control,
        'interpretation': 'Source-bound component signal only. All three cells and correctness must be reviewed; ambiguity can hold. No browser/import/PR claim.',
    }
    plan['summary'], plan['diagnostic'], plan['complete'] = summary, diagnostic, True
    save()
    print('SUFFIX_PROOF_RESULT ' + json.dumps({'dictionary': args.dictionary, 'complete': True,
          'scope': plan['scope'], 'summary': summary, 'componentGate': plan['componentGate'],
          'mechanicalCounts': counts, 'rows': first['rows'], 'digest': first['digest']}, separators=(',', ':')), flush=True)
except Exception as error:
    plan['error'] = str(error)
    plan['unattemptedOrUnacceptedSchedule'] = schedule[len(plan['observations']):]
    save()
    print('SUFFIX_PROOF_FAILED ' + json.dumps({'dictionary': args.dictionary, 'complete': False,
          'completedObservations': len(plan['observations']), 'error': str(error),
          'unattemptedOrUnacceptedSchedule': plan['unattemptedOrUnacceptedSchedule']}, separators=(',', ':')), flush=True)
    raise
