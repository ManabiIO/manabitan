#!/usr/bin/env python3
"""Snapshot this task's evidence; never modify a product worktree or Git ref."""
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

TASK = Path('/workspace/scratch/0a1757ac2970')
OUT = Path(__file__).resolve().parents[1]
REPO = TASK / 'manabitan'
SHA = lambda value: hashlib.sha256(value).hexdigest()
origins = {}
excluded = []
hosted_cohorts = []


def safe_text(data, path):
    text = data.decode('utf-8', errors='ignore')
    signed = r'https?://[^\s\"<>]*[?&](?:X-Amz-Signature|X-Amz-Credential|sig|se|Expires)='
    if re.search(signed, text, flags=re.I):
        raise ValueError(f'Expiring or signed URL in {path}; retain no URL in evidence')


def copy(source, relative, compress=False):
    before = source.stat()
    data = source.read_bytes()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f'Input changed while copying: {source}')
    safe_text(data, source)
    target = OUT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.compress(data, compresslevel=9, mtime=0) if compress else data)
    origins[relative] = {'path': str(source), 'sha256': SHA(data), 'bytes': len(data)}
    if compress:
        origins[relative]['transformation'] = 'gzip level 9, mtime 0; decompressed bytes identical to source'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO, text=True).strip()


for source in sorted(TASK.iterdir()):
    if not source.is_file() or source.suffix not in {'.mjs', '.json', '.jsonl', '.log', '.py'}:
        continue
    if not (source.name.startswith(('jmdict-', 'jitendex-', 'vndb-', 'score-', 'baseline-audit', 'baseline-artifact-audit', 'record-encoder-', 'record-runs-', 'stacked-record-review', 'hosted-import-artifact-audit', 'qualification-artifact-audit', 'pack-dispatch-qualification-')) or source.name in {'npm-ci.log', 'build-libs.log', 'extract-screen-packet.py'}):
        continue
    # Agent marks this as active until its final typecheck returns. An explicit
    # readiness file lets the root refresh this snapshot after completion.
    if source.name == 'jmdict-stacked-types-test-final.log' and not (OUT / 'stacked-final-ready.json').exists():
        excluded.append({'path': str(source), 'reason': 'Still writing at initial staging; refresh after completion'})
        continue
    relative = f'local/{source.name}'
    compressed = source.name == 'vndb-media-records.json'
    copy(source, relative + ('.gz' if compressed else ''), compressed)

for source in sorted((TASK / 'jitendex-parity').iterdir()):
    if source.is_file():
        copy(source, f'jitendex/{source.name}')

for source, relative in [
    (Path('/workspace/scratch/0f5c13c58962/rejected-import-storage-20261123/pool/runners/prepare.mjs'), 'jitendex/prepare-inputs.mjs'),
    (Path('/workspace/scratch/0f5c13c58962/content-recycle-screen/prepared/manifest.json'), 'jitendex/prepared-manifest.json'),
    (REPO / 'test/perf/dictionaries.lock.json', 'inputs/dictionaries.lock.json'),
]:
    copy(source, relative)

for candidate in ['pack-dispatch', 'media-path']:
    metadata = TASK / 'artifacts' / f'{candidate}-screen-vndb-download.json'
    if metadata.exists():
        copy(metadata, f'browser/artifact-metadata/{metadata.name}')

for ref, source, relative in [
    ('462c4e1e079f4bf7a0c858b004e14bb9356f11d5', 'dev/perf/import-runtime-next.py', 'browser/planned-screen/runner.py'),
    ('462c4e1e079f4bf7a0c858b004e14bb9356f11d5', '.github/workflows/import-runtime-next.yml', 'browser/planned-screen/workflow.yml'),
    ('3c8f26e7ebfde84ad7bd46a5296617e18a46ca6a', 'dev/perf/import-runtime-next.py', 'browser/planned-next/runner.py'),
    ('3c8f26e7ebfde84ad7bd46a5296617e18a46ca6a', '.github/workflows/import-runtime-next.yml', 'browser/planned-next/workflow.yml'),
]:
    data = subprocess.check_output(['git', 'show', f'{ref}:{source}'], cwd=REPO)
    target = OUT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    origins[relative] = {'kind': 'git blob', 'commit': ref, 'path': source, 'sha256': SHA(data)}

for filename, extracted, relative in [
    ('baseline-jmdict.zip', 'baseline/jmdict', 'browser/baseline/jmdict'),
    ('baseline-jitendex.zip', 'baseline/jitendex', 'browser/baseline/jitendex'),
    ('baseline-vndb.zip', 'baseline/vndb', 'browser/baseline/vndb'),
    ('pack-dispatch-screen-jitendex.zip', 'screen/pack-dispatch-jitendex', 'browser/screen/pack-dispatch-jitendex'),
    ('pack-dispatch-screen-jmdict.zip', 'screen/pack-dispatch-jmdict', 'browser/screen/pack-dispatch-jmdict'),
    ('pack-dispatch-screen-vndb.zip', 'screen/pack-dispatch-vndb', 'browser/screen/pack-dispatch-vndb'),
    ('media-path-screen-vndb.zip', 'screen/media-path-vndb', 'browser/screen/media-path-vndb'),
    ('record-runs-screen-jmdict.zip', 'screen/record-runs-jmdict', 'browser/screen/record-runs-jmdict'),
    ('record-runs-screen-jitendex.zip', 'screen/record-runs-jitendex', 'browser/screen/record-runs-jitendex'),
    ('record-runs-screen-vndb.zip', 'screen/record-runs-vndb', 'browser/screen/record-runs-vndb'),
    ('pack-dispatch-qualification-jitendex.zip', 'qualification/pack-dispatch-jitendex', 'browser/qualification/pack-dispatch-jitendex'),
]:
    archive = TASK / 'artifacts' / filename
    if not archive.exists():
        continue
    browse = OUT / relative
    if browse.exists():
        shutil.rmtree(browse)
    target = OUT / 'browser/original-artifacts' / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(archive, target)
    origins[target.relative_to(OUT).as_posix()] = {'path': str(archive), 'sha256': SHA(archive.read_bytes()), 'bytes': archive.stat().st_size, 'transformation': 'none; original downloaded GitHub Actions artifact ZIP'}
    with zipfile.ZipFile(archive) as zipped:
        for entry in zipped.infolist():
            if entry.is_dir():
                continue
            if Path(entry.filename).suffix not in {'.json', '.log', '.txt', '.html', '.py', '.yml', '.md'}:
                raise ValueError(f'Unexpected artifact binary: {entry.filename}')
            source = TASK / 'artifacts' / extracted / entry.filename
            assert source.read_bytes() == zipped.read(entry), f'Extraction differs: {source}'
            safe_text(zipped.read(entry), f'{archive}:{entry.filename}')
            if len(Path(entry.filename).parts) == 1 and Path(entry.filename).suffix in {'.json', '.txt', '.py', '.yml'}:
                copy(source, f'{relative}/{entry.filename}')
    protocol = json.loads((browse / 'protocol.json').read_text())
    state = json.loads((browse / 'state.json').read_text())
    hosted_cohorts.append({'archive': f'browser/original-artifacts/{filename}', 'archiveSha256': SHA(archive.read_bytes()), 'run': protocol['github']['GITHUB_RUN_ID'], 'stage': protocol['stage'], 'dictionary': protocol['dictionary'], 'sourceIdentities': protocol['sourceIdentities'], 'state': state})

baseline = '3d65e403c644b9a5a6be3128d72f9d30050b70e0'
mappings = {
    'baseline': {'commit': baseline, 'tree': git('rev-parse', f'{baseline}^{{tree}}')},
    'pr851': {'apiCommit': '78a2adcfba8d72d8cba070319b53d4b2b354a8f9', 'localCommit': '912c0bed18b5f6301a0a0eccd08ed2d2fefcf6b2', 'tree': '5c074e07c8964e8435987b954987b4fba95d7fdb', 'reviewState': 'Ready for review; not merged; qualified hosted Jitendex result and three-dictionary screen integrity'},
    'pr846': {'apiCommit': '32c13e05c1a7fda88fd531dab40648c1978565f2', 'localCommit': '17c7c56803a5560d8b824bc04a49872dba4d2ed5', 'tree': '2c4048a4f2be1dac76f16ec9f10efc93c1d966c4', 'reviewState': 'Draft; six-block VNDB screen is inconclusive, no complete-import gain established'},
    'recordRunsOriginal': {'localCommit': 'a470edad0bdad293460cf89c5407ee69f29f96dd', 'tree': 'a83a8032b4367ca657c225007a693716ad1ee1b8', 'status': 'Superseded; initial component evidence retained, no current candidate speed claim'},
    'recordRunsStacked': {'parentPr': 849, 'parentCommit': '10a8f09e96ff943ec1351b1391cb56fa7e20feed', 'candidateCommit': None, 'status': 'Pending final validation and publication; runtime parity hashes retained'},
    'scoreBoundary': {'status': 'Separate pending correctness fix; excluded from frozen performance candidates'},
    'jitendexInputPreparation': {'commit': '467067650653c37c1f7d6b05d6737d070e1259cd', 'tree': '934dd7011275aafa9f5b0314af8c729eb5fc96a2', 'reason': 'Original parser revision for the preserved 22-group logical-content fixture'},
    'snapshotAlternative847': {'reviewedCommit': '44d6830646bfa43cb30fbec3c05ea9d98d09406f', 'initialCommit': '4603afd9231a0e862d7dcc76221d8356a5a260e3', 'scope': 'Four targeted source-snapshot cases, not general import corruption evidence'},
}
for key in ['pr851', 'pr846']:
    mapping = mappings[key]
    assert git('rev-parse', f'{mapping["apiCommit"]}^{{tree}}') == mapping['tree']
    assert git('rev-parse', f'{mapping["localCommit"]}^{{tree}}') == mapping['tree']
    mapping['apiAndLocalTreeEqualityVerified'] = True

patch = subprocess.check_output(['git', 'diff', baseline, mappings['recordRunsOriginal']['localCommit'], '--', 'ext/js/dictionary/term-record-opfs-store.js', 'test/term-record-encoding-runs.test.js'], cwd=REPO)
(OUT / 'local/record-runs-original-superseded.patch').write_bytes(patch)
origins['local/record-runs-original-superseded.patch'] = {'kind': 'git diff', 'base': baseline, 'head': mappings['recordRunsOriginal']['localCommit']}
ready = OUT / 'stacked-final-ready.json'
if ready.exists():
    mappings['recordRunsStacked'].update(json.loads(ready.read_text()))
    mapping = mappings['recordRunsStacked']
    for key in ['candidateCommit', 'candidateLocalCommit']:
        if mapping.get(key):
            assert git('rev-parse', f'{mapping[key]}^{{tree}}') == mapping['tree']
score_ready = OUT / 'score-final-ready.json'
if score_ready.exists():
    mappings['scoreBoundary'].update(json.loads(score_ready.read_text()))
    mapping = mappings['scoreBoundary']
    assert git('rev-parse', f'{mapping["localCommit"]}^{{tree}}') == mapping['tree']
    if mapping.get('apiCommit'):
        assert git('rev-parse', f'{mapping["apiCommit"]}^{{tree}}') == mapping['tree']

files = []
for file in sorted(OUT.rglob('*')):
    if not file.is_file() or file.name in {'manifest.json', 'manifest.sha256'} or '__pycache__' in file.parts:
        continue
    relative = file.relative_to(OUT).as_posix()
    data = file.read_bytes()
    if file.suffix not in {'.zip', '.gz'}:
        safe_text(data, file)
    files.append({'path': relative, 'bytes': len(data), 'sha256': SHA(data), 'source': origins.get(relative, {'kind': 'generated evidence note, audit, or verifier'})})
manifest = {
    'schemaVersion': 1, 'snapshotAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'repository': 'ManabiIO/manabitan', 'scope': 'Engineering evidence staging; frozen source identities and raw observations; qualified runner-specific results and inconclusive screens; no merges',
    'previousCheckpoint': {'commit': 'fdd7579b573c48811e3f451c95da4264c2d62835', 'tree': '573dadda16cf134198bbdd5b48c7052abee63c7c', 'path': 'docs/performance/import-crossover-20261123'},
    'sourceMappings': mappings,
    'hostedRuns': {'baseline': 45260267997, 'screen': 45262916933, 'screenStatus': 'Complete: all three packing screens and the VNDB media-path screen are retained', 'next': {'run': 45265448894, 'toolingCommit': '3c8f26e7ebfde84ad7bd46a5296617e18a46ca6a', 'toolingTree': '05d2e37e199c9fc444b81f33570c97605c96d328', 'cohorts': 'PR855 all three screens versus849; unchanged PR851 Jitendex twelve-block qualification', 'status': 'Complete: all four packets retained; do not pool qualification with prior screen'}},
    'retainedHostedCohorts': hosted_cohorts,
    'exclusions': excluded + [{'category': item, 'reason': 'Reconstruct from pinned repository or source archives; not evidence payload'} for item in ['dictionary ZIP archives', 'node_modules', 'compiled libraries and extension build binaries', 'prepared Jitendex binary slabs']],
    'files': files,
}
manifest_file = OUT / 'manifest.json'
manifest_file.write_text(json.dumps(manifest, indent=2) + '\n')
(OUT / 'manifest.sha256').write_text(f'{SHA(manifest_file.read_bytes())}  manifest.json\n')
print(json.dumps({'files': len(files), 'bytes': sum(file['bytes'] for file in files), 'excludedActiveInputs': excluded, 'manifestSha256': SHA(manifest_file.read_bytes())}))
