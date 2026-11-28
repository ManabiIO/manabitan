"""Bind each hosted observation to the frozen production baseline and native module."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(root, *arguments):
    return subprocess.check_output(['git', '-C', str(root), *arguments], text=True).strip()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline-root', type=Path, required=True)
parser.add_argument('--cache-dir', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--clang', type=Path, required=True)
parser.add_argument('--linker', type=Path, required=True)
parser.add_argument('--order', choices=['forward', 'reverse'], required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
package = Path(__file__).resolve().parent
protocol = json.loads((package / 'protocol.json').read_text())
assert sha(package / 'prerequisites.json') == protocol['prerequisitesSha256']
prerequisites = json.loads((package / 'prerequisites.json').read_text())
assert prerequisites['baseline'] == protocol['baseline']
assert set(prerequisites['variants']) == set(protocol['variants'])
for name, gate in prerequisites['variants'].items():
    assert gate['allThreeCorporaPassed'] and gate['rowsPerArm'] == 7613164
    assert gate['sourceSha256'] == protocol['variants'][name]['sourceSha256']
    assert gate['wasmSha256'] == protocol['variants'][name]['wasmSha256']
    assert gate['digests'][protocol['dictionary']] == protocol['expectedDigest']
baseline = args.baseline_root.resolve()
node = args.node.resolve()
output = args.out.resolve()
output.mkdir(parents=True, exist_ok=True)
assert not (output / 'campaign.json').exists()
assert not (output / 'campaign-result.json').exists()
assert not os.environ.get('NODE_OPTIONS')
assert git(baseline, 'rev-parse', 'HEAD') == protocol['baseline']
assert not git(baseline, 'status', '--porcelain', '--untracked-files=no')
assert subprocess.check_output([str(node), '--version'], text=True).strip() == protocol['nodeVersion']
compiler_version = subprocess.check_output([str(args.clang), '--version'], text=True)
linker_version = subprocess.check_output([str(args.linker), '--version'], text=True)
assert re.search(r'\bclang version ' + re.escape(protocol['compilerVersion']) + r'\b', compiler_version)
assert re.search(r'\bLLD ' + re.escape(protocol['linkerVersion']) + r'\b', linker_version)
source_path = Path('ext/js/dictionary/wasm/term-bank-parser.c')
assert sha(baseline / source_path) == protocol['baselineSourceSha256']
manifest_path = baseline / 'dev/data/dictionary-wasm/manifest.json'
assert sha(manifest_path) == protocol['baselineManifestSha256']
manifest = json.loads(manifest_path.read_text())
target = next(item for item in manifest['targets'] if item['name'] == 'term-bank-parser.wasm')
assert target['sha256'] == protocol['baselineWasmSha256']
assert sha(baseline / 'ext/lib/term-bank-parser.wasm') == protocol['baselineWasmSha256']
fixture = json.loads((baseline / 'test/perf/dictionaries.lock.json').read_text())['dictionaries'][protocol['dictionary']]
assert fixture['sha256'] == protocol['fixtureSha256']
assert fixture['sizeBytes'] == protocol['fixtureBytes']
assert fixture['termRows'] == protocol['rows']
fixture_path = args.cache_dir.resolve() / fixture['cacheFile']
assert fixture_path.stat().st_size == protocol['fixtureBytes']
assert sha(fixture_path) == protocol['fixtureSha256']
assert sha(package / 'preloaded-worker-server.mjs') == protocol['serverSha256']
names = protocol['variantOrder'] if args.order == 'forward' else list(reversed(protocol['variantOrder']))
orders = protocol['orders'] if args.order == 'forward' else [order[::-1] for order in reversed(protocol['orders'])]
assert len(names) == 2 and len(set(names)) == 2
assert len(orders) == 6 and set(orders) == {'ABC', 'BCA', 'CAB', 'CBA', 'ACB', 'BAC'}
campaign = {'schema': 1, 'order': args.order, 'variantOrder': names,
            'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'protocolSha256': sha(package / 'protocol.json'), 'plans': [],
            'compilerVersionOutput': compiler_version, 'linkerVersionOutput': linker_version,
            'nodeExecutableSha256': sha(node),
            'host': {'system': platform.platform(), 'python': platform.python_version(),
                     'imageOS': os.environ.get('ImageOS'), 'imageVersion': os.environ.get('ImageVersion'),
                     'runId': os.environ.get('GITHUB_RUN_ID'), 'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
                     'workflowSha': os.environ.get('GITHUB_SHA')}}
for name in names:
    frozen_source = package / 'variants' / name
    expected = protocol['variants'][name]
    for filename, expected_sha in expected['files'].items():
        assert sha(frozen_source / filename) == expected_sha
    directory = output / name
    assert not directory.exists()
    directory.mkdir()
    variant = directory / 'variant'
    (variant / source_path).parent.mkdir(parents=True)
    shutil.copyfile(frozen_source / 'term-bank-parser.c', variant / source_path)
    module = variant / 'ext/lib/term-bank-parser.wasm'
    module.parent.mkdir(parents=True)
    command = [str(args.clang.resolve()), f'-fuse-ld={args.linker.absolute()}', *target['arguments'],
               '-o', str(module), str(variant / source_path),
               str(baseline / 'ext/js/dictionary/wasm/term-bank-inflate.c')]
    with (directory / 'compile.log').open('wb') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    assert sha(module) == expected['wasmSha256']
    assert module.read_bytes() == (frozen_source / 'term-bank-parser.wasm').read_bytes()
    receipt = {'baseline': protocol['baseline'], 'name': name,
               'sourceSha256': sha(variant / source_path), 'wasmSha256': sha(module),
               'wasmBytes': module.stat().st_size, 'compilerVersion': protocol['compilerVersion'],
               'linkerVersion': protocol['linkerVersion'], 'command': command}
    (variant / 'variant.json').write_text(json.dumps(receipt, indent=2) + '\n')
    runners = directory / 'runners'
    runners.mkdir()
    runner_hashes = {}
    for filename in ['prepare.py', 'campaign.py', 'run.py', 'summarize.py', 'preloaded-worker-server.mjs', 'protocol.json', 'prerequisites.json']:
        shutil.copyfile(package / filename, runners / filename)
        runner_hashes[filename] = sha(runners / filename)
    identities = directory / 'identities'
    identities.mkdir()
    shutil.copyfile(manifest_path, identities / 'baseline-manifest.json')
    shutil.copyfile(baseline / source_path, identities / 'baseline.c')
    shutil.copyfile(baseline / 'ext/lib/term-bank-parser.wasm', identities / 'baseline.wasm')
    shutil.copyfile(frozen_source / 'build-receipt.json', identities / 'original-build-receipt.json')
    shutil.copyfile(frozen_source / 'source.patch', identities / 'source.patch')
    plan = {key: value for key, value in protocol.items() if key not in {'variants', 'variantOrder'}}
    plan.update({'candidate': name, 'candidateWasmSha256': expected['wasmSha256'],
                 'candidateSourceSha256': expected['sourceSha256'],
                 'candidateBuildReceiptSha256': sha(variant / 'variant.json'),
                 'baselineRoot': str(baseline), 'baselineTree': git(baseline, 'rev-parse', 'HEAD^{tree}'),
                 'variantRoot': str(variant), 'cacheDir': str(args.cache_dir.resolve()),
                 'nodeExecutable': str(node), 'nodeExecutableSha256': sha(node),
                 'serverPath': str(runners / 'preloaded-worker-server.mjs'),
                 'controllerSha256': runner_hashes['run.py'], 'runnerHashes': runner_hashes,
                 'orders': orders, 'orderMode': args.order,
                 'protocolSha256': campaign['protocolSha256'], 'host': campaign['host']})
    path = directory / 'plan.json'
    path.write_text(json.dumps(plan, indent=2) + '\n')
    subprocess.run(['python3', str(runners / 'run.py'), '--plan', str(path), '--check-only'], check=True)
    campaign['plans'].append({'candidate': name, 'path': str(path), 'sha256': sha(path)})
(output / 'campaign.json').write_text(json.dumps(campaign, indent=2) + '\n')
print(json.dumps({'prepared': True, 'order': args.order, 'plans': campaign['plans']}))
