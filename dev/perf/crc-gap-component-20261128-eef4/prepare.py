#!/usr/bin/env python3
"""Bind an independent hosted diagnostic to exact product, fixture and runner bytes."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *arguments):
    return subprocess.check_output(['git', '-C', str(root), *arguments], text=True).strip()


def native_manifest(root):
    directory = root / 'ext/js/dictionary/wasm'
    assert not directory.is_symlink()
    files = []
    for item in directory.rglob('*'):
        assert not item.is_symlink(), f'Linked native source is unsupported: {item}'
        if item.is_file() and item.suffix.lower() in {'.c', '.h'}:
            files.append(item.relative_to(root).as_posix())
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(f'{name}\0{sha256((root / name).read_bytes())}\n'.encode())
    manifest = json.loads((root / 'dev/data/dictionary-wasm/manifest.json').read_text())
    assert manifest['sourceFileCount'] == len(files)
    assert manifest['sourceDigest'] == digest.hexdigest()
    assert manifest['toolchain'] == {'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8'}
    for target in manifest['targets']:
        data = (root / 'dev/data/dictionary-wasm' / target['name']).read_bytes()
        assert sha256(data) == target['sha256']
        assert data[:8] == b'\0asm\x01\0\0\0'
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-root', type=Path, required=True)
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--candidate-ref', required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--order', choices=['forward', 'reverse'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    baseline = args.baseline_root.resolve()
    candidate = args.candidate_root.resolve()
    node = args.node.resolve()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    assert not (output / 'plan.json').exists(), 'Do not overwrite a registered cohort'
    assert not (output / 'result.json').exists(), 'Do not resume or replace an acquisition'
    protocol_bytes = (package / 'protocol.json').read_bytes()
    protocol = json.loads(protocol_bytes)
    assert re.fullmatch('[a-f0-9]{40}', args.candidate_ref)
    assert git(baseline, 'rev-parse', 'HEAD') == protocol['baseline']
    assert git(candidate, 'rev-parse', 'HEAD') == args.candidate_ref
    assert not git(baseline, 'status', '--porcelain', '--untracked-files=no')
    assert not git(candidate, 'status', '--porcelain', '--untracked-files=no')
    changed = git(candidate, 'diff', '--name-only', protocol['baseline'], args.candidate_ref).splitlines()
    assert sorted(changed) == protocol['allowedProductChanges'], changed
    assert subprocess.check_output([str(node), '--version'], text=True).strip() == protocol['nodeVersion']
    assert not os.environ.get('NODE_OPTIONS'), 'The frozen diagnostic requires an empty NODE_OPTIONS'
    baseline_manifest = native_manifest(baseline)
    candidate_manifest = native_manifest(candidate)
    targets = lambda value: {target['name']: target for target in value['targets']}
    baseline_targets = targets(baseline_manifest)
    candidate_targets = targets(candidate_manifest)
    assert baseline_targets['term-bank-parser.wasm']['sha256'] == protocol['baselineWasmSha256']
    assert candidate_targets['term-bank-parser.wasm']['sha256'] == protocol['candidateWasmSha256']
    assert baseline_targets['term-content-canonical-scan-v1.wasm'] == candidate_targets['term-content-canonical-scan-v1.wasm']
    for key in ['sources', 'arguments']:
        assert baseline_targets['term-bank-parser.wasm'][key] == candidate_targets['term-bank-parser.wasm'][key]
    lock = baseline / 'test/perf/dictionaries.lock.json'
    assert lock.read_bytes() == (candidate / 'test/perf/dictionaries.lock.json').read_bytes()
    fixture = json.loads(lock.read_text())['dictionaries'][protocol['dictionary']]
    assert fixture['sha256'] == protocol['fixtureSha256']
    assert fixture['sizeBytes'] == protocol['fixtureBytes']
    assert fixture['termRows'] == protocol['rows']
    fixture_file = args.cache_dir.resolve() / fixture['cacheFile']
    fixture_digest = hashlib.sha256()
    with fixture_file.open('rb') as file:
        while block := file.read(4 * 1024 * 1024):
            fixture_digest.update(block)
    assert fixture_file.stat().st_size == protocol['fixtureBytes']
    assert fixture_digest.hexdigest() == protocol['fixtureSha256']
    server = package / 'preloaded-worker-server.mjs'
    assert sha256(server.read_bytes()) == protocol['serverSha256']
    source_path = Path('ext/js/dictionary/wasm/term-bank-parser.c')
    source = (candidate / source_path).read_bytes()
    assert sha256(source) == protocol['candidateSourceSha256']
    variant = output / 'variant'
    (variant / source_path).parent.mkdir(parents=True, exist_ok=True)
    (variant / source_path).write_bytes(source)
    module = (candidate / 'dev/data/dictionary-wasm/term-bank-parser.wasm').read_bytes()
    destination = variant / 'ext/lib/term-bank-parser.wasm'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(module)
    receipt = {
        'baseline': protocol['baseline'], 'candidate': args.candidate_ref,
        'name': 'crc-gap-short-tail',
        'sourceSha256': sha256(source), 'wasmSha256': sha256(module), 'wasmBytes': len(module),
        'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8',
        'candidateManifestSha256': sha256((candidate / 'dev/data/dictionary-wasm/manifest.json').read_bytes()),
    }
    (variant / 'variant.json').write_text(json.dumps(receipt, indent=2) + '\n')
    frozen = output / 'runners'
    frozen.mkdir()
    runner_hashes = {}
    for name in ['prepare.py', 'run.py', 'summarize.py', 'protocol.json', 'preloaded-worker-server.mjs']:
        shutil.copyfile(package / name, frozen / name)
        runner_hashes[name] = sha256((frozen / name).read_bytes())
    identities = output / 'identities'
    identities.mkdir()
    for name, root in [('baseline', baseline), ('candidate', candidate)]:
        shutil.copyfile(root / 'dev/data/dictionary-wasm/manifest.json', identities / f'{name}-manifest.json')
        shutil.copyfile(root / 'dev/data/dictionary-wasm/term-bank-parser.wasm', identities / f'{name}.wasm')
        shutil.copyfile(root / source_path, identities / f'{name}.c')
    plan = dict(protocol)
    plan.update({
        'candidate': args.candidate_ref,
        'orderMode': args.order,
        'orders': protocol['orders'] if args.order == 'forward' else [order[::-1] for order in reversed(protocol['orders'])],
        'baselineRoot': str(baseline), 'candidateRoot': str(candidate), 'variantRoot': str(variant),
        'cacheDir': str(args.cache_dir.resolve()), 'nodeExecutable': str(node),
        'nodeExecutableSha256': sha256(node.read_bytes()),
        'serverPath': str(frozen / server.name), 'controllerSha256': runner_hashes['run.py'],
        'protocolSha256': sha256(protocol_bytes), 'runnerHashes': runner_hashes,
        'baselineTree': git(baseline, 'rev-parse', 'HEAD^{tree}'),
        'candidateTree': git(candidate, 'rev-parse', 'HEAD^{tree}'),
        'changedProductFiles': changed,
        'host': {'pythonVersion': platform.python_version(), 'system': platform.platform(),
            'runnerImageOS': os.environ.get('ImageOS'), 'runnerImageVersion': os.environ.get('ImageVersion'),
            'workflowSha': os.environ.get('GITHUB_SHA'), 'runId': os.environ.get('GITHUB_RUN_ID'),
            'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT')},
    })
    (output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps({'plan': str(output / 'plan.json'), 'orders': plan['orders'], 'runners': runner_hashes}))


if __name__ == '__main__':
    main()
