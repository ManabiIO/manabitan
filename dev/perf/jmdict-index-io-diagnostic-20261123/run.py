#!/usr/bin/env python3
"""Acquire six fixed JMdict index-I/O diagnostics, with no timing qualification."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import zipfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('ordinary_import_study', ROOT / 'dev/perf/import-study-20261123/run.py')
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


def schedule():
    return [{'name': f'{arm}{index + 1}', 'arm': arm, 'triplet': index + 1}
            for index, arms in enumerate(('ABC', 'CBA')) for arm in arms]


def main():
    config = json.loads((HERE / 'config.json').read_text())
    assert config['schemaVersion'] == 1 and config['authoritativeTiming'] is False
    assert config['baseline'] == '467067650653c37c1f7d6b05d6737d070e1259cd'
    assert list(config['arms']) == ['A', 'B', 'C']
    assert all(re.fullmatch(r'[a-f0-9]{40}', value['sha']) for value in config['arms'].values())
    assert len({value['sha'] for value in config['arms'].values()}) == 3
    assert len(config['expectedArmPackageDifferences']) == 1
    evidence = ROOT / 'builds/jmdict-index-io-diagnostic-20261123'
    evidence.mkdir(parents=True, exist_ok=False)
    node = study.command(['node', '--version'])
    if node != 'v22.22.0':
        raise ValueError('The diagnostic is pinned to Node.js 22.22.0')
    fixture = json.loads((ROOT / study.OVERLAY[0]).read_text())['dictionaries']['jmdict']
    sources = [*study.OVERLAY, *study.TIMING_SOURCE, 'dev/perf/host-environment.js',
               'dev/perf/import-study-20261123/run.py', 'dev/perf/import-study-20261123/verify.mjs',
               *[str(path.relative_to(ROOT)) for path in sorted(HERE.iterdir()) if path.is_file()],
               '.github/workflows/jmdict-index-io-diagnostic-20261123.yml']
    plan = {'schemaVersion': 1, 'authoritativeTiming': False, 'config': config,
            'dictionary': 'jmdict', 'schedule': schedule(), 'fixture': fixture,
            'nodeVersion': node, 'harnessSha': study.command(['git', 'rev-parse', 'HEAD']),
            'workflowRun': os.environ.get('GITHUB_RUN_ID'), 'workflowAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
            'sourceFiles': {name: study.digest(ROOT / name) for name in sources},
            'scope': 'Instrumented writer lifecycle diagnosis only; not import-speed qualification',
            'noWarmupExclusions': True, 'noRetries': True, 'importFlags': None,
            'interpretation': 'All inner benchmark timing labels are overridden by this diagnostic plan'}
    study.save(evidence / 'plan.json', plan)
    for name in sources:
        target = evidence / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    stage = Path(tempfile.mkdtemp(prefix='jmdict-index-io-', dir=os.environ.get('RUNNER_TEMP')))
    try:
        study.command(['node', '--input-type=module', '-e',
                       "import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js'; "
                       "await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache',['jmdict'])"],
                      log=evidence / 'fixtures.log')
        archive = ROOT / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
        assert archive.stat().st_size == fixture['sizeBytes'] and study.digest(archive) == fixture['sha256']
        study.save(evidence / 'media-reference.json', study.media_reference(archive, fixture)['all'])
        roots, packages = {}, {}
        for arm, value in config['arms'].items():
            source = stage / arm
            study.command(['git', 'worktree', 'add', '--detach', str(source), value['sha']], log=evidence / f'{arm}-checkout.log')
            assert study.command(['git', 'rev-parse', 'HEAD^{tree}'], cwd=source) == value['tree']
            for name in study.TIMING_SOURCE:
                if study.digest(source / name) != plan['sourceFiles'][name]:
                    raise ValueError('Timing/dependency source changed: ' + name)
            for name in study.OVERLAY:
                shutil.copyfile(ROOT / name, source / name)
            (source / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            (source / 'builds').mkdir(exist_ok=True)
            (source / 'builds/e2e-dictionary-cache').symlink_to(ROOT / 'builds/e2e-dictionary-cache', target_is_directory=True)
            for name, script in (('libs', 'build:libs'), ('license', 'license-report:html'), ('build', 'build')):
                arguments = ['npm', 'run', script]
                if name == 'build':
                    arguments += ['--', '--target', 'chrome']
                study.command(arguments, cwd=source, log=evidence / f'{arm}-{name}.log')
            package = source / 'builds/manabitan-chrome.zip'
            with zipfile.ZipFile(package) as built:
                assert len(built.namelist()) == len(set(built.namelist()))
                packages[arm] = {entry.filename: hashlib.sha256(built.read(entry)).hexdigest()
                                 for entry in built.infolist() if not entry.is_dir()}
            study.save(evidence / f'{arm}-package-entries.json', packages[arm])
            study.save(evidence / f'{arm}-identity.json', {'sha': value['sha'], 'tree': value['tree'], 'packageSha256': study.digest(package),
                       'statusWithHarnessOverlay': study.command(['git', 'status', '--porcelain'], cwd=source)})
            roots[arm] = source
        differences = {arm: sorted(name for name in packages['A'].keys() | packages[arm].keys()
                                  if packages['A'].get(name) != packages[arm].get(name)) for arm in ('B', 'C')}
        assert all(value == config['expectedArmPackageDifferences'] for value in differences.values())
        study.save(evidence / 'package-differences.json', differences)
        for observation in plan['schedule']:
            output = evidence / observation['name']
            output.mkdir()
            study.command(['node', 'dev/perf/host-environment.js'], log=output / 'host-before.json')
            started = time.time()
            print('diagnostic: ' + observation['name'], flush=True)
            try:
                study.command(['node', 'dev/perf/import-benchmark.js', 'jmdict', '--runs', '1', '--no-build',
                               '--build-target', 'chrome', '--media-check', 'all', '--output', str(output)],
                              cwd=roots[observation['arm']], log=output / 'run.log')
            finally:
                study.save(output / 'acquisition.json', {**observation, 'startedEpochSeconds': started,
                           'endedEpochSeconds': time.time(), 'retried': False, 'authoritativeTiming': False})
                study.command(['node', 'dev/perf/host-environment.js'], log=output / 'host-after.json')
        study.command(['node', str(HERE / 'verify.mjs'), str(evidence)], log=evidence / 'verification.log')
        print((evidence / 'result.json').read_text(), flush=True)
    except BaseException as error:
        study.save(evidence / 'failure.json', {'type': type(error).__name__, 'message': str(error),
                   'recordedAtEpochSeconds': time.time(), 'retried': False})
        raise


if __name__ == '__main__':
    main()
