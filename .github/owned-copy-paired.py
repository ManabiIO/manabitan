import argparse, subprocess, pathlib, json, hashlib, os, math

p = argparse.ArgumentParser()
p.add_argument('--baseline', required=True)
p.add_argument('--candidate', required=True)
p.add_argument('--output', required=True)
p.add_argument('--pairs', type=int, default=6)
p.add_argument('--dictionaries', default='jmnedict,jmdict,jitendex')
p.add_argument('--reverse', action='store_true')
a = p.parse_args()
root = pathlib.Path(a.output)
root.mkdir(parents=True, exist_ok=True)
node = os.environ.get('NODE_EXE', 'node')
arms = {k: pathlib.Path(getattr(a, k)) for k in ['baseline', 'candidate']}


def cmd(args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


identities = {k: {'commit': cmd(['git', 'rev-parse', 'HEAD'], v), 'tree': cmd(['git', 'rev-parse', 'HEAD^{tree}'], v), 'zip': hashlib.sha256((v / 'builds/manabitan-chrome-dev.zip').read_bytes()).hexdigest()} for k, v in arms.items()}
plan = []
dics = a.dictionaries.split(',')
for kind, count in [('warmup', 1), ('measured', a.pairs), ('same-binary', 1)]:
    for pair in range(count):
        for di, dic in enumerate(dics):
            order = ['baseline', 'candidate']
            if (pair + di + int(a.reverse)) % 2:
                order.reverse()
            if kind == 'same-binary':
                order = ['baseline', 'baseline']
            for position, arm in enumerate(order):
                plan.append({'kind': kind, 'pair': pair, 'dictionary': dic, 'position': position, 'arm': arm})
(root / 'plan.json').write_text(json.dumps({'identities': identities, 'plan': plan}, indent=2))
results = []
checks = {}
try:
    for n, item in enumerate(plan):
        arm = item['arm']
        work = arms[arm]
        out = root / f"{n:03d}-{item['kind']}-{item['dictionary']}-{arm}"
        out.mkdir()
        assert cmd(['git', 'status', '--porcelain'], work) == '', 'dirty source'
        assert cmd(['git', 'rev-parse', 'HEAD'], work) == identities[arm]['commit'], 'changed source'
        assert hashlib.sha256((work / 'builds/manabitan-chrome-dev.zip').read_bytes()).hexdigest() == identities[arm]['zip'], 'changed package'
        with (out / 'command.log').open('w') as log:
            run = subprocess.run([node, 'dev/perf/import-benchmark.js', item['dictionary'], '--runs', '1', '--no-build', '--output', str(out)], cwd=work, stdout=log, stderr=subprocess.STDOUT, timeout=240)
        if run.returncode:
            raise RuntimeError(f'{out}: exit {run.returncode}; retained without retry')
        summary = json.loads((out / 'summary.json').read_text())
        report = json.loads((out / 'run-1.json').read_text())
        r = summary['runs'][0]
        assert summary['schemaVersion'] == 3 and summary['authoritativeTiming'] is True and summary['traceEnabled'] is False
        assert summary['source']['dirty'] is False and summary['importFlags'] is None
        assert report['status'] == 'success' and report['skippedVerification'] is False
        assert report['benchmark']['productionImportDefaults'] and report['benchmark']['pinnedDictionaries']
        assert not any(report['benchmark'][k] for k in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
        assert math.isfinite(r['totalImportMs']) and r['totalImportMs'] > 0
        debug = r['importDebug']
        assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and not debug['usesFallbackStorage']
        validation = r['validation']
        assert validation['contentReadable'] and validation['probeCount'] == 12
        phases = debug['importerPhaseTimings']
        terms = [s['details'] for s in phases if s['phase'].startswith('term-file-fast-path:')]
        sums = {k: sum(t.get(k, 0) for t in terms) for k in ['rows', 'batchedFileCount', 'parserSourceCompressedBytes', 'parserSourceUncompressedBytes', 'dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount', 'dedupRecentSourceCacheBytes']}
        fixed = {k: v for k, v in summary['source']['sha256'].items() if k != 'builds/manabitan-chrome-dev.zip'}
        signature = {'validation': validation, 'accounting': sums, 'harness': fixed, 'browser': summary['browserVersion']}
        if item['dictionary'] in checks:
            assert checks[item['dictionary']] == signature, 'content/accounting/harness mismatch'
        checks[item['dictionary']] = signature
        results.append({**item, 'index': n, 'ms': r['totalImportMs'], 'cacheMs': sum(t.get('dedupRecentSourceCacheMs', 0) for t in terms), 'accounting': sums, 'report': str(out / 'run-1.json')})
        (root / 'observations.json').write_text(json.dumps({'complete': False, 'observations': results}, indent=2))
        print(json.dumps(results[-1]), flush=True)
    (root / 'observations.json').write_text(json.dumps({'complete': True, 'identities': identities, 'checks': checks, 'observations': results}, indent=2))
except Exception as e:
    (root / 'failure.json').write_text(json.dumps({'error': str(e), 'completed': len(results), 'planned': len(plan)}, indent=2))
    raise
