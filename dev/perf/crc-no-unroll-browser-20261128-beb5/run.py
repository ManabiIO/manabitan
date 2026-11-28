"""Bind one frozen CRC runtime comparison before invoking the unchanged runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import traceback


ROOT = Path(__file__).resolve().parents[3]
STUDY = Path(__file__).resolve().parent


def read(path):
    return json.loads(path.read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=ROOT).decode().strip()


def verify_sources(config):
    assert git('status', '--porcelain', '--untracked-files=no') == '', 'Tracked qualification source is dirty'
    assert config['baseline'] == 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
    assert os.environ.get('CANDIDATE_COMMIT', config['candidate']) == config['candidate']
    assert config['pairs'] == 12 and config['expectedWorkers'] == 3
    assert config['initialOrder'] == 'AB' and config['flags'] == {}
    assert config['expectedAddedPackageEntries'] == []
    assert set(config['expectedPackageEntries']) == {
        'js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm',
    }
    assert set(config['expectedProductFiles']) == {
        'ext/js/dictionary/wasm/term-bank-parser.c',
        'dev/data/dictionary-wasm/term-bank-parser.wasm',
        'dev/data/dictionary-wasm/manifest.json',
    }
    assert git('rev-list', '--parents', '-n', '1', config['candidate']).split() == [
        config['candidate'], config['baseline'],
    ]
    changed = git('diff', '--name-only', config['baseline'], config['candidate']).splitlines()
    assert set(changed) == set(config['expectedProductFiles'])
    bindings = {}
    for arm, commit in [('A', config['baseline']), ('B', config['candidate'])]:
        expected = config['runtimeSources'][arm]
        assert git('rev-parse', commit) == expected['commit'] == commit
        assert git('rev-parse', commit + '^{tree}') == expected['tree']
        assert set(expected['files']) == set(config['expectedProductFiles'])
        files = {}
        for filename, identity in expected['files'].items():
            data = subprocess.check_output(['git', 'show', commit + ':' + filename], cwd=ROOT)
            actual = {'gitBlob': git('rev-parse', commit + ':' + filename), 'sha256': sha(data)}
            assert actual == identity, f'Frozen runtime source differs: {arm} {filename}'
            files[filename] = actual
        bindings[arm] = {'commit': commit, 'tree': expected['tree'], 'files': files}
    sources = {}
    for filename, expected in config['qualificationSourceHashes'].items():
        actual = sha((ROOT / filename).read_bytes())
        assert actual == expected, f'Qualification source differs: {filename}'
        sources[filename] = actual
    return {
        'studyCommit': git('rev-parse', 'HEAD'),
        'studyTree': git('rev-parse', 'HEAD^{tree}'),
        'configSha256': sha((STUDY / 'registration.json').read_bytes()),
        'qualificationSourceHashes': sources,
        'runtimeSources': bindings,
        'memoryAcquisition': config['memoryAcquisition'],
        'preflightComplete': True,
        'trackedSourceClean': True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dictionary', choices=('jmdict', 'jitendex', 'vndb'))
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--verify-only', action='store_true', help='Check identities without starting Chromium or a benchmark')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    assert not evidence.exists(), 'Refuse to replace any existing observation directory'
    config_path = STUDY / 'registration.json'
    config = read(config_path)
    provenance = {'preflightComplete': False}
    try:
        provenance = verify_sources(config)
        if args.verify_only:
            print(json.dumps({'sourceVerificationComplete': True, 'baseline': config['baseline'], 'candidate': config['candidate']}), flush=True)
            return
        command = [
            'python', 'dev/perf/import-qualification-20261128-beb5.py',
            '--baseline', config['baseline'], '--candidate', config['candidate'],
            '--dictionary', args.dictionary, '--initial-order', 'AB', '--pairs', '12',
            '--expected-workers', '3', '--evidence', str(evidence),
        ]
        for filename in config['expectedPackageEntries']:
            command.extend(['--expected-package-entry', filename])
        if args.dictionary == 'vndb':
            command.extend(['--vndb-sah-allocation-units', '37', '37'])
        subprocess.run(command, cwd=ROOT, check=True)
    except Exception as error:
        write(evidence / 'orchestration-failure.json', {
            'type': type(error).__name__, 'error': str(error),
            'traceback': traceback.format_exc(), 'retried': False,
        })
        raise
    finally:
        write(evidence / 'qualification-source-identities.json', provenance)
        (evidence / 'qualification-config.json').write_bytes(config_path.read_bytes())


if __name__ == '__main__':
    main()
