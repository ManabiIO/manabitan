#!/usr/bin/env python3
"""Prospective binding only; does not execute a replay or rewrite prior receipts."""
import hashlib, json, os, pathlib, subprocess, tempfile

HERE = pathlib.Path(__file__).resolve().parent
BASE = pathlib.Path('/home/agent/manabitan-da6c4dbd0097/current-baseline-dcfc')
HISTORICAL_BASE = pathlib.Path('/workspace/scratch/da6c4dbd0097/baseline')
CANDIDATE = pathlib.Path('/home/agent/manabitan-da6c4dbd0097/raw-alias-product')
MANIFEST = pathlib.Path('/workspace/scratch/da6c4dbd0097/profiling/compression-groups/vndb/manifest.json')
FIXTURE = pathlib.Path('/home/agent/manabitan-da6c4dbd0097/fixtures/vndb_characters_by_bee.zip')
BASE_COMMIT = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
HISTORICAL_COMMIT = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
REMOTE = {'commit': '2c02336b135ee01661ca2a788395afec75e66712', 'tree': '17995fab3d9e2fd226f0cc37d306f5dfc7e39505'}

def git(root, *args, env=None):
    return subprocess.check_output(['git', *args], cwd=root, env=env, text=True).strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def source_hashes(root):
    paths = set()
    for directory in ['ext/js', 'ext/lib', 'ext/data']:
        paths.update(p.relative_to(root).as_posix() for p in (root/directory).rglob('*') if p.is_file())
    paths.update(['package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json'])
    return {name: sha(root/name) for name in sorted(paths)}

def current_tree(root):
    changes = git(root, 'diff', '--name-only', 'HEAD').splitlines() + git(root, 'ls-files', '--others', '--exclude-standard').splitlines()
    with tempfile.TemporaryDirectory(dir=HERE) as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(pathlib.Path(temporary)/'index'))
        git(root, 'read-tree', 'HEAD', env=env)
        for name in changes:
            assert (root/name).is_file(), name
            blob = git(root, 'hash-object', '-w', name)
            git(root, 'update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + name, env=env)
        return git(root, 'write-tree', env=env)

def write_new(name, value):
    with (HERE/name).open('x') as file:
        json.dump(value, file, indent=2); file.write('\n')

assert git(BASE, 'rev-parse', 'HEAD') == BASE_COMMIT
assert git(CANDIDATE, 'rev-parse', 'HEAD') == BASE_COMMIT
assert not git(BASE, 'diff', '--name-only', 'HEAD', '--', 'ext', 'package.json', 'package-lock.json', 'test/perf/dictionaries.lock.json')
candidate_tree = current_tree(CANDIDATE)
assert candidate_tree == REMOTE['tree'], (candidate_tree, REMOTE)
fixture_manifest = json.loads(MANIFEST.read_text())
assert fixture_manifest['complete'] and fixture_manifest['gitSha'] == HISTORICAL_COMMIT
for name, digest in fixture_manifest['sourceHashes'].items():
    assert sha(HISTORICAL_BASE/name) == digest, name
    if name != 'ext/lib/term-bank-parser.wasm':
        assert sha(BASE/name) == digest, name
assert sha(BASE/'test/perf/dictionaries.lock.json') == fixture_manifest['lockSha256']
assert sha(BASE/'package-lock.json') == sha(CANDIDATE/'package-lock.json')
for name in ['ext/lib/term-bank-parser.wasm', 'ext/lib/term-content-canonical-scan-v1.wasm', 'ext/lib/zstd.wasm']:
    assert sha(BASE/name) == sha(CANDIDATE/name), name
assert sha(BASE/'ext/lib/term-bank-parser.wasm') == sha(BASE/'dev/data/dictionary-wasm/term-bank-parser.wasm')
assert sha(BASE/'ext/lib/term-bank-parser.wasm') != fixture_manifest['sourceHashes']['ext/lib/term-bank-parser.wasm']
sources = {arm: source_hashes(root) for arm, root in [('A', BASE), ('B', CANDIDATE)]}
changed_runtime = sorted(name for name in set(sources['A']) | set(sources['B']) if sources['A'].get(name) != sources['B'].get(name))
assert changed_runtime == sorted([
    'ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/native-term-record-alias.js', 'ext/js/dictionary/native-term-record-ownership.js',
    'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/term-import-metrics.js',
]), changed_runtime
harness_files = ['product-common.mjs', 'product-arm.mjs', 'product-worker-adapter.mjs', 'product-worker-bridge.mjs',
    'product-verify.mjs', 'product-compare.mjs', 'prepare-bindings.py',
    'archived/raw-alias-node-opfs.mjs', 'archived/raw-alias-node-opfs.test.mjs']
harness = {name: sha(HERE/name) for name in harness_files}
node = subprocess.check_output(['node', '-p', 'process.version'], text=True).strip()
plan = {'schemaVersion': 1, 'mode': 'full-native-term-storage-diagnostic', 'timingClaim': False,
    'sourceManifestSha256': sha(MANIFEST), 'nativeFixture': fixture_manifest['fixture'],
    'historicalOracle': {'source': HISTORICAL_COMMIT, 'scope': 'Prior group geometry/content input bytes and canonical counts only. Current native source/assets are freshly bound independently; no historical timing or source equivalence claim.'},
    'baselineCommit': BASE_COMMIT, 'candidateRemoteEquivalent': REMOTE,
    'localCandidateHead': git(CANDIDATE, 'rev-parse', 'HEAD'), 'localCandidateTreeIncludingWorkingChanges': candidate_tree,
    'localCandidateStatus': git(CANDIDATE, 'status', '--short'), 'changedRuntime': changed_runtime,
    'harnessHashes': harness, 'node': node,
    'sequence': ['A full170-group pipeline', 'A full persisted verification', 'B full170-group pipeline', 'B full persisted verification', 'cross-arm canonical/relocation proof'],
    'failurePolicy': 'Stop on every failure, retain all files/receipts. A new source-bound attempt requires an identified repair, never repeat an unchanged cohort.',
    'scope': 'Native term-storage component only. Real private receiver and importer callback, canonical dedup and actual codecs/records/files. Explicit component lifecycle entry-state instead of SQLite; no media writes or browser timing. Separate verification reads every row/definition and reopens actual runtime readers.',
}
write_new('plan-6.json', plan)
for arm, root in [('A', BASE), ('B', CANDIDATE)]:
    directory = HERE/('natural-' + arm + '-6')
    configuration = {'schemaVersion': 1, 'arm': arm, 'mode': plan['mode'], 'node': node, 'root': str(root),
        'outputDirectory': str(directory), 'fixturePath': str(FIXTURE), 'fixtureManifest': str(MANIFEST),
        'fixtureManifestSha256': sha(MANIFEST), 'dictionaryTitle': fixture_manifest['fixture']['expectedTitle'],
        'sourceHashes': sources[arm], 'harnessHashes': harness, 'localHead': git(root, 'rev-parse', 'HEAD'),
        'localStatus': git(root, 'status', '--short'), 'localTreeIncludingWorkingChanges': git(BASE, 'rev-parse', 'HEAD^{tree}') if arm == 'A' else candidate_tree,
        'remoteEquivalent': {'commit': BASE_COMMIT, 'tree': git(BASE, 'rev-parse', 'HEAD^{tree}')} if arm == 'A' else REMOTE,
        'planPath': str(HERE/'plan-6.json'), 'planSha256': sha(HERE/'plan-6.json')}
    write_new('config-' + arm + '-6.json', configuration)
    write_new('verify-' + arm + '-6.json', {'root': str(root), 'pipelineReport': str(directory/'pipeline.json'), 'opfsDirectory': str(directory/'opfs'), 'reportPath': str(directory/'verification.json')})
write_new('compare-6.json', {'a': str(HERE/'natural-A-6/pipeline.json'), 'b': str(HERE/'natural-B-6/pipeline.json'),
    'verifyA': str(HERE/'natural-A-6/verification.json'), 'verifyB': str(HERE/'natural-B-6/verification.json'), 'reportPath': str(HERE/'comparison-6.json')})
print(json.dumps({'bound': True, 'candidateTree': candidate_tree, 'harnessHashes': harness, 'runtimeFiles': {key: len(value) for key, value in sources.items()}}))
