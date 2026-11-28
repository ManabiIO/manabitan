#!/usr/bin/env python3
"""Run the frozen latest-source storage qualification; never report latency gains."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time


HERE = Path(__file__).resolve().parent
TOOLING_ROOT = HERE.parents[2]
EVIDENCE = TOOLING_ROOT / 'builds/perf/20261128-4d9f-reference-fields-latest'
CANDIDATE = '85a8aa49f76fbabd2dc494aad247f74774ff2573'
PARENT = 'a300da36d00df8e353c5679b1528b50a1299b75f'
NODE_SHA256 = '1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31'


def sha256_file(file):
    digest = hashlib.sha256()
    with Path(file).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(file, value):
    with Path(file).open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def run(args, output, name, *, cwd, env=None, timeout=1800):
    receipt = {'command': [str(arg) for arg in args], 'cwd': str(cwd), 'timingEligible': False,
               'deadlineSeconds': timeout, 'startedEpoch': time.time()}
    with (output / f'{name}.stdout.log').open('xb') as stdout, (output / f'{name}.stderr.log').open('xb') as stderr:
        try:
            result = subprocess.run(receipt['command'], cwd=cwd, env=env, stdout=stdout, stderr=stderr, timeout=timeout, check=False)
            receipt['returncode'] = result.returncode
        except subprocess.TimeoutExpired as error:
            receipt.update(returncode=None, deadlineExceeded=True, error=str(error))
        receipt['finishedEpoch'] = time.time()
    write_json(output / f'{name}.exit.json', receipt)
    if receipt['returncode'] != 0:
        raise RuntimeError(f'{name} failed; retain its exact logs and exit receipt')


def prepare_evidence():
    manifest = json.loads((EVIDENCE / 'verification-manifest.json').read_text())
    preparation = json.loads((EVIDENCE / 'source-preparation.json').read_text())
    archive = EVIDENCE / 'verification-oracles.tar.gz'
    assert archive.stat().st_size == preparation['oracleArchive']['bytes']
    assert sha256_file(archive) == preparation['oracleArchive']['sha256']
    expected = {item['path']: item for item in manifest['oracles'].values()}
    with tarfile.open(archive, 'r:gz') as source:
        files = [member for member in source.getmembers() if not member.isdir()]
        assert len(files) == len(expected)
        assert {member.name for member in files} == set(expected)
        for member in files:
            assert member.isfile() and not member.issym() and not member.islnk()
            assert not Path(member.name).is_absolute() and '..' not in Path(member.name).parts
            record = expected[member.name]
            assert member.size == record['bytes']
            content = source.extractfile(member).read()
            assert hashlib.sha256(content).hexdigest() == record['sha256']
            target = EVIDENCE / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as destination:
                destination.write(content)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['contracts', 'old-reader', 'corpus'], required=True)
    parser.add_argument('--source-root', required=True)
    parser.add_argument('--reader-root')
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--cache-dir')
    parser.add_argument('--corpus', choices=['jmdict', 'jitendex', 'vndb'])
    args = parser.parse_args()
    source = Path(args.source_root).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == CANDIDATE
    node = Path(args.node).resolve()
    assert sha256_file(node) == NODE_SHA256
    assert subprocess.check_output([str(node), '--version'], text=True).strip() == 'v22.22.0'
    write_json(output / 'invocation.json', {'schemaVersion': 1, 'timingEligible': False, 'arguments': vars(args),
                                          'candidateCommit': CANDIDATE, 'readerCommit': PARENT,
                                          'driverSha256': sha256_file(__file__), 'nodeSha256': sha256_file(node)})
    if args.phase == 'contracts':
        assert args.reader_root is None and args.corpus is None
        for index, file in enumerate(sorted(HERE.glob('*.mjs'))):
            run([node, '--check', file], output, f'syntax-{index:02d}', cwd=TOOLING_ROOT, timeout=60)
        run([node, '--test', *sorted(HERE.glob('*.contract.mjs'))], output, 'node-contracts', cwd=TOOLING_ROOT, timeout=120)
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
        run([sys.executable, HERE / 'test_activation_overlay.py'], output, 'python-contracts', cwd=TOOLING_ROOT, env=env, timeout=120)
        run([node, TOOLING_ROOT / 'node_modules/eslint/bin/eslint.js', *sorted(HERE.glob('*.mjs'))], output, 'scoped-eslint', cwd=TOOLING_ROOT, timeout=600)
    elif args.phase == 'old-reader':
        assert args.reader_root is not None and args.corpus is None
        reader = Path(args.reader_root).resolve()
        assert subprocess.check_output(['git', '-C', str(reader), 'rev-parse', 'HEAD'], text=True).strip() == PARENT
        prepare_evidence()
        run([node, HERE / 'run-old-reader-check.mjs', '--source-root', source, '--source-id', CANDIDATE,
             '--reader-root', reader, '--reader-id', PARENT, '--output', output / 'acquisition',
             '--evidence-dir', EVIDENCE, '--node-sha256', NODE_SHA256], output, 'old-reader', cwd=TOOLING_ROOT, timeout=180)
    else:
        assert args.corpus is not None and args.cache_dir is not None and args.reader_root is None
        prepare_evidence()
        cache = Path(args.cache_dir).resolve()
        cache.mkdir(parents=True, exist_ok=True)
        # Exact pinned production downloader; no mutable URL or fixture substitution.
        downloader = "import {ensureSelectedPinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js'; await ensureSelectedPinnedDictionaryCache(process.argv[1], [process.argv[2]]);"
        run([node, '--input-type=module', '-e', downloader, cache, args.corpus], output, 'pinned-fixture', cwd=source, timeout=600)
        for arm in ['A', 'B']:
            run([sys.executable, HERE / 'launch.py', '--node', node, '--source-root', source, '--source-id', CANDIDATE,
                 '--corpus', args.corpus, '--arm', arm, '--cache-dir', cache,
                 '--output', output / f'{args.corpus}-{arm}-1', '--evidence-dir', EVIDENCE,
                 '--node-sha256', NODE_SHA256], output, f'corpus-{arm}', cwd=TOOLING_ROOT, timeout=1260)
        run([node, HERE / 'compare-results.mjs', output / f'{args.corpus}-A-1', output / f'{args.corpus}-B-1',
             output / 'comparison.json', '--evidence-dir', EVIDENCE], output, 'complete-comparison', cwd=TOOLING_ROOT, timeout=180)
    write_json(output / 'complete.json', {'success': True, 'timingEligible': False, 'phase': args.phase,
                                        'candidateCommit': CANDIDATE, 'corpus': args.corpus})


if __name__ == '__main__':
    main()
