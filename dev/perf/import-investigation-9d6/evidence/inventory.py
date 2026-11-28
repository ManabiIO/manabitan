"""Inventory existing component evidence; never alter a receipt or write archives."""
from pathlib import Path
import datetime
import gzip
import hashlib
import io
import json
import re
import tarfile
import zipfile

root = Path(__file__).resolve().parents[4]
output = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda path: json.loads(Path(path).read_text())
text_suffixes = {'.json', '.jsonl', '.log', '.txt', '.md', '.mjs', '.js', '.py', '.patch', '.yml', '.c', '.h'}
studies = {}
checks = []


def study(name, disposition, timing_scope):
    value = {'name': name, 'disposition': disposition, 'timingScope': timing_scope, 'files': {}}
    studies[name] = value
    return value


def add(value, path, label=None):
    path = Path(path)
    if not path.is_absolute():
        path = root / path
    assert path.is_file() and not path.is_symlink(), path
    label = label or str(path.relative_to(root))
    assert not Path(label).is_absolute() and '..' not in Path(label).parts
    value['files'][label] = path


def tree(value, folder, recursive=True):
    folder = root / folder
    paths = folder.rglob('*') if recursive else folder.glob('*')
    for path in paths:
        if path.is_file() and path.suffix in text_suffixes and '__pycache__' not in path.parts:
            add(value, path)


def manifest_check(path):
    manifest = read(root / path)
    for item in manifest['files']:
        source = Path(item['localPath'])
        data = source.read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], source
    checks.append({'kind': 'frozen-publication-package', 'path': path, 'sha256': sha((root / path).read_bytes()), 'files': len(manifest['files'])})


def zip_check(archive, extracted, metadata):
    archive = root / archive
    extracted = root / extracted
    data = archive.read_bytes()
    assert len(data) == metadata['size_in_bytes']
    assert sha(data) == metadata['digest'].removeprefix('sha256:')
    members = []
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        files = [item for item in source.infolist() if not item.is_dir()]
        assert len({item.filename for item in files}) == len(files)
        for item in files:
            name = Path(item.filename)
            assert not name.is_absolute() and '..' not in name.parts
            member = source.read(item)
            assert member == (extracted / name).read_bytes(), name
            members.append({'path': item.filename, 'bytes': len(member), 'sha256': sha(member)})
    checks.append({'kind': 'original-artifact-zip-and-extracted-bytes', 'path': str(archive.relative_to(root)), 'artifact': metadata, 'zipSha256': sha(data), 'zipBytes': len(data), 'members': members})


metadata = study('metadata', 'Fusion prototype rejected (~0.6 ms warmed corpus saving for 96 added lines). Narrow cache-loop extraction has two-host cold component gains, with a warm AB regression and mixed BA warm outcome; complete-import run 46107460816 is pending. Local controls are noisy. No complete-import gain is established.', 'Fusion warm replay; separate 36-child local cold/warm helper cohort; 72 hosted children across AB/BA, all observations and controls retained.')
tree(metadata, 'metadata-experiments/builds/perf/metadata-cache', recursive=False)
metadata['files'].pop('metadata-experiments/builds/perf/metadata-cache/jitendex-current-profile.json', None)
tree(metadata, 'metadata-experiments/builds/perf/metadata-cache/cache-loop-local-AB')
tree(metadata, 'metadata-experiments/builds/perf/metadata-cache/hosted-metadata')
for capture in ['jmdict-capture', 'jmdict-capture-v3', 'jmdict-portable-smoke']:
    add(metadata, f'metadata-experiments/builds/perf/metadata-cache/{capture}/report.json')
tree(metadata, 'metadata-results')
for file in ['benchmark-setup/metadata-hosted-api.json', 'benchmark-setup/metadata-hosted-audit.json', 'benchmark-setup/audit-metadata-hosted.py']:
    add(metadata, file)
manifest_check('metadata-experiments/builds/perf/metadata-cache/metadata-publication-manifest.json')
metadata_api = read(root / 'benchmark-setup/metadata-hosted-api.json')
for order in ['AB', 'BA']:
    receipt = read(root / f'metadata-results/{order}/download-receipt.json')
    artifact = next(item for item in metadata_api['artifacts'] if item['id'] == receipt['id'])
    assert artifact['workflow_run']['id'] == 46104605338
    assert artifact['workflow_run']['head_sha'] == '8ce17bb15c5593889a528e91c753684b641a1afe'
    zip_check(f'metadata-results/{order}/artifact.zip', f'metadata-results/{order}', artifact)

codec1 = study('codec-v1', 'count8ctz/count8unroll closed: small warm wins do not establish consistent cold gains and binaries grow. Later source review identifies the same missing reversed-limit guard in both old unsigned-length specializations. Old timings are ineligible for production qualification. Native-context snapshot saving is negligible; early 4 MiB screens are explicitly nonproduction surrogates.', 'Two isolated hosts, two candidates, all eight A/B/C/D warm blocks and six A/B/C cold permutations per candidate; earlier local and surrogate evidence is separately named.')
codec2 = study('codec-v2-and-guarded-proof', 'Original count16 is invalid: direct-header regression probes expose 768 traps and one wrong result for reversed limits; its ~3% warm component results cannot qualify the corrected binary. CStream64 is rejected with 72 tight-destination status regressions. New guarded binary passes correctness and awaits prospective complete-import run 46109596112; no guarded performance claim.', 'Original two-host component cohorts retain all warm/cold observations. Guarded receipts are correctness-only, not a timing rerun.')
for version, value, package, run, head in [
    ('v1', codec1, 'wasm-word-width', 46103338197, 'd4470d35a684a8c37628123d7740ec2fa3375f4b'),
    ('v2', codec2, 'wasm-word-width-v2', 46104781415, '03aaef1730788c59ecdb5d8bb45f3c87fe90cb40'),
]:
    tree(value, f'compression-probe/hosted-results/{version}', recursive=False)
    for receipt_path in sorted((root / f'compression-probe/hosted-results/{version}').glob('artifact-*-receipt.json')):
        receipt = read(receipt_path)
        artifact = receipt['artifact']
        assert artifact['workflow_run']['id'] == run and artifact['workflow_run']['head_sha'] == head
        directory = receipt_path.with_name(f"artifact-{artifact['id']}")
        zip_check(str(directory.with_suffix('.zip').relative_to(root)), str(directory.relative_to(root)), artifact)
        tree(value, str(directory.relative_to(root)), recursive=False)
        provenance = read(directory / 'provenance.json')
        for file, digest in provenance['scripts'].items():
            path = root / f'compression-experiments/dev/perf/{package}' / file
            assert sha(path.read_bytes()) == digest, path
        checks.append({'kind': 'frozen-codec-package', 'version': version, 'artifactId': artifact['id'], 'experimentHead': head, 'scripts': provenance['scripts']})
    add(value, f'compression-experiments/dev/perf/{package}/manifest.json')
    add(value, f'compression-experiments/dev/perf/{package}/README.md')
for file in ['snapshot-native-result.json', 'snapshot-probe.c', 'count8-wasm-screen-01.json', 'count8-wasm-results.json', 'count8ctz-wasm-screen-01.json', 'count8unroll-wasm-screen-01.json', 'match-length-census.json', 'match-length-census.log', 'input-proof.json', 'count8-wasm-screen-01.log', 'count8ctz-wasm-screen-01.log', 'count8unroll-wasm-screen-01.log', 'count8-wasm-parity.log', 'count8unroll-wasm-parity.json', 'count8unroll-wrapper-parity.json', 'wasm-build-results.json']:
    add(codec1, 'compression-probe/' + file)
tree(codec1, 'compression-probe/portable-smoke')
add(codec1, 'compression-probe/hosted-results/analyze-cohort.py')
add(codec1, 'compression-probe/hosted-results/cohort-spec.json')
add(codec2, 'compression-probe/hosted-results/analyze-cohort.py')
tree(codec2, 'compression-probe/count16-guarded', recursive=False)
tree(codec2, 'compression-probe/count16-guarded/verified-package-01')
for file in ['benchmark-setup/count16-bounds-review.md', 'benchmark-setup/count16-guarded-proof-audit.json', 'compression-probe/import-count16-9d6.yml']:
    add(codec2, file)
guarded_root = Path('/home/agent/manabitan-compression-toolchain/guarded-verification-01')
for name in ['verification.json', 'boundary-result.json', 'boundaries/build.json', 'raw-parity.json', 'wrapper-parity.json']:
    add(codec2, guarded_root / name, 'guarded-verification-01/' + name)

direct = study('direct-record-lengths', 'Rejected; runtime restored. 108 child observations show no consistent JMdict or VNDB gain against both source-identical controls. Jitendex warm saving is only about 0.24 ms. All measured child receipts are retained; no failed measured child was discarded.', 'Three actual parsed corpora, six A/B/C permutations per cold/warm mode; virtual resolved offsets and component record-field encoding only.')
tree(direct, 'metadata-experiments/builds/perf/record-length')
test = root / 'metadata-experiments/test/term-record-field-reference-length.test.js'
if test.exists():
    add(direct, test)
ids = read(root / 'metadata-experiments/builds/perf/record-length/identities.json')
for file, digest in ids.items():
    if file == 'ext/js/dictionary/term-record-opfs-store.js':
        continue
    assert sha((root / 'metadata-experiments' / file).read_bytes()) == digest, file
patch = (root / 'metadata-experiments/builds/perf/record-length/candidate.patch').read_text().splitlines(True)
original = (root / 'manabitan/ext/js/dictionary/term-record-opfs-store.js').read_text().splitlines(True)
patched = []
position = 0
i = 0
while i < len(patch):
    match = re.match(r'@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@', patch[i])
    if not match:
        i += 1
        continue
    start = int(match[1]) - 1
    patched.extend(original[position:start])
    position = start
    i += 1
    while i < len(patch) and not patch[i].startswith('@@'):
        line = patch[i]
        if line[0] in ' -':
            assert original[position] == line[1:]
            position += 1
        if line[0] in ' +':
            patched.append(line[1:])
        i += 1
patched.extend(original[position:])
assert sha(''.join(patched).encode()) == ids['ext/js/dictionary/term-record-opfs-store.js']
checks.append({'kind': 'direct-length-source-reconstructed-without-mutation', 'candidateSourceSha256': ids['ext/js/dictionary/term-record-opfs-store.js'], 'supportFiles': ids})
for name in ['jmdict', 'jitendex', 'vndb']:
    receipt = read(root / f'metadata-experiments/builds/perf/record-length/capture-v1/{name}.json')
    source = root / f'metadata-experiments/builds/perf/record-length/capture-v1/{name}.bin.gz'
    assert sha(source.read_bytes()) == receipt['compressedSha256']

inflater = study('inflater-local', 'Local 36-child cohort is inconclusive: cold candidate medians lose against both baselines, warmed medians are small/noisy, and identical-code controls drift substantially. All losses and tails retained. Correctness/reach are promising but hosted replication run 46106878218 is still pending; no PR or complete-import gain.', 'Exact 12 production source groups, 53 JMdict banks, one WASM instance; timed native inflate plus CRC only. Cold and warmed cohorts remain separate.')
tree(inflater, 'metadata-experiments/builds/perf/inflater-simd', recursive=False)
tree(inflater, 'metadata-experiments/builds/perf/inflater-simd/screen-AB')
tree(inflater, 'metadata-experiments/builds/perf/inflater-simd/tests')
add(inflater, 'metadata-experiments/builds/perf/inflater-simd/candidate-tests-v1-source.tar.gz')
manifest_check('metadata-experiments/builds/perf/inflater-simd/publication-manifest.json')
add(inflater, 'metadata-experiments/dev/perf/inflater-copy-9d6/README.md')
add(inflater, 'metadata-experiments/dev/perf/inflater-copy-9d6/candidate.json')
add(inflater, 'benchmark-setup/inflater-push-receipt.json')

shared = study('shared-identity-and-dispositions', 'Input and provenance only; no timing conclusion. One shared immutable source-capture identity supports the component studies. Cross-study dispositions retain rejected and duplicate directions.', 'Fixture and source/capture receipt chain; no fixture bytes or binary column capture is included.')
for file in ['benchmark-setup/fixture-receipts.json', 'benchmark-setup/round-dispositions.json', 'compression-probe/hosted-results/capture/artifact-15245899188-receipt.json', 'compression-probe/hosted-results/capture/artifact-15245899188/report.json', 'compression-probe/hosted-results/extract-artifact.py']:
    add(shared, file)
capture_receipt = read(root / 'compression-probe/hosted-results/capture/artifact-15245899188-receipt.json')
assert capture_receipt['artifact']['workflow_run']['id'] == 46103338197
assert capture_receipt['artifact']['workflow_run']['head_sha'] == 'd4470d35a684a8c37628123d7740ec2fa3375f4b'
zip_check('compression-probe/hosted-results/capture/artifact-15245899188.zip', 'compression-probe/hosted-results/capture/artifact-15245899188', capture_receipt['artifact'])

inventory = {'schemaVersion': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'baselineCommit': '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2', 'measurementBranch': 'perf/import-components-9d6-20261128', 'status': 'Inventory only. Existing evidence read and hashed; no source receipt changed, benchmark rerun, archive persisted or external publication performed.', 'archiveEncoding': 'Approximate sizes are exact in-memory gzip level 6 of deterministic PAX tar entries (mtime=0, uid=gid=0, mode=0444), using the listed archive paths. Archives have not been written.', 'excluded': ['Original downloaded ZIPs (their identities and member hashes are retained)', 'All fixture ZIPs and compressed source/record columns', 'Generated WASM and generated module JS duplicates', 'SDKs, source checkout duplicates, dependencies, old-session evidence already committed', 'Profiles/traces: separate diagnostic inventory, outside these completed component studies'], 'identityChecks': checks, 'studies': []}
for value in studies.values():
    members = []
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', compresslevel=6, mtime=0, filename='') as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, path in sorted(value['files'].items()):
                data = path.read_bytes()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o444
                archive.addfile(info, io.BytesIO(data))
                members.append({'sourcePath': str(path), 'archivePath': name, 'bytes': len(data), 'sha256': sha(data)})
    archive_bytes = buffer.getvalue()
    value['files'] = members
    value['fileCount'] = len(members)
    value['uncompressedBytes'] = sum(row['bytes'] for row in members)
    value['estimatedTarGzipBytes'] = len(archive_bytes)
    value['estimatedTarGzipSha256'] = sha(archive_bytes)
    value['suggestedArchivePath'] = f"dev/perf/import-investigation-9d6/evidence/{value['name']}.tar.gz"
    inventory['studies'].append(value)
inventory['totalFiles'] = sum(value['fileCount'] for value in inventory['studies'])
inventory['totalUncompressedBytes'] = sum(value['uncompressedBytes'] for value in inventory['studies'])
inventory['totalEstimatedTarGzipBytes'] = sum(value['estimatedTarGzipBytes'] for value in inventory['studies'])
destination = output / 'inventory.json'
destination.write_text(json.dumps(inventory, indent=2) + '\n')
print(json.dumps({'inventory': str(destination), 'sha256': sha(destination.read_bytes()), 'originalZipAudits': sum(check['kind'] == 'original-artifact-zip-and-extracted-bytes' for check in checks), 'studies': [{key: value[key] for key in ['name', 'fileCount', 'uncompressedBytes', 'estimatedTarGzipBytes']} for value in inventory['studies']], 'totalEstimatedTarGzipBytes': inventory['totalEstimatedTarGzipBytes']}, indent=2))
