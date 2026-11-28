"""Read back frozen local-screen evidence and independently recompute its arithmetic."""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import hashlib
import json
import statistics
import subprocess
import tarfile

ROOT = Path('/home/agent/manabitan-guarded-local-9d6')
APPENDIX = ROOT / 'appendix'
REPO = Path('/workspace/scratch/9d6dcf05cf8f/manabitan')
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda p: json.loads(p.read_bytes())
blob = lambda data: hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
manifest_path = APPENDIX / 'publication-manifest.json'
assert sha(manifest_path.read_bytes()) == '65adebfa453c6855aa604c8dfbd0feb3f525063f4818451929b8836b2ab25c82'
manifest = read(manifest_path)
assert len(manifest['files']) == 7
assert {p.name for p in APPENDIX.iterdir()} == {'publication-manifest.json'} | {Path(r['localPath']).name for r in manifest['files']}
for row in manifest['files']:
    path = Path(row['localPath'])
    assert path.parent == APPENDIX and not path.is_symlink()
    data = path.read_bytes()
    assert len(data) == row['bytes'] and sha(data) == row['sha256'] and blob(data) == row['gitBlobSha1']

inventory = read(APPENDIX / 'inventory.json')
analysis = read(APPENDIX / 'analysis.json')
reconstruction = read(APPENDIX / 'reconstruction.json')
assert inventory['complete'] is True and inventory['archive']['files'] == 65
assert inventory['analysisSha256'] == sha((APPENDIX / 'analysis.json').read_bytes())
assert inventory['auditorSha256'] == sha((APPENDIX / 'audit-local-screen.py').read_bytes())
assert inventory['packagerSha256'] == sha((APPENDIX / 'build-appendix.py').read_bytes())
assert inventory['reconstruction'] == reconstruction
rows = {r['archivePath']: r for r in inventory['files']}
assert len(rows) == len(inventory['files']) == 65
archive_path = APPENDIX / inventory['archive']['name']
assert archive_path.stat().st_size == inventory['archive']['bytes'] == 80928
assert sha(archive_path.read_bytes()) == inventory['archive']['sha256'] == '6cc09c15d798cf6950c398e9c8b9afbcd38205ebfaac9da8de7e139ca3a06bfe'
saved = {}
with tarfile.open(archive_path, 'r:gz') as archive:
    infos = archive.getmembers()
    assert [i.name for i in infos] == sorted(rows)
    for info in infos:
        relative = PurePosixPath(info.name)
        assert info.isfile() and str(relative) == info.name and not relative.is_absolute() and '..' not in relative.parts
        assert info.mtime == info.uid == info.gid == 0 and info.mode == 0o444
        row = rows[info.name]
        data = archive.extractfile(info).read()
        assert len(data) == info.size == row['bytes'] and sha(data) == row['sha256']
        original = Path(row['sourcePath'])
        assert original.is_file() and not original.is_symlink() and original.read_bytes() == data
        saved[info.name] = data
assert sum(len(b) for b in saved.values()) == inventory['archive']['uncompressedBytes'] == 454139
rj = lambda name: json.loads(saved[name])
commands = rj('cohort/commands.json')
execution = rj('cohort/execution.json')
plan = rj('cohort/proposed-plan.json')
review = rj('cohort/orchestration-review.json')
assert review['approved'] is True and review['complete'] is True
assert sha(saved['cohort/proposed-plan.json']) == analysis['planSha256'] == '4dab9c657ec2ca96ea92f239d50f1bbc30995842dd3e4b3e8fc46f09f05985fc'
assert sha(saved['cohort/run-fixed-screen.py']) == analysis['wrapperSha256'] == 'd125be9413f064e4cba1c33c6e87bc3f76610e78e0a94b0cb7268d806b4ea9c4'
assert rj('cohort/root-release.json')['planSha256'] == analysis['planSha256']
assert execution['complete'] is True and execution['status'] == 'complete'
assert execution['completedChildren'] == len(commands) == len(execution['children']) == 19
permutations = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']
assert [''.join(p) for p in plan['fixedProtocol']['cold']['permutations']] == permutations
assert [(c['mode'],c['pair'],c['arm']) for c in commands] == [('warm',None,None)] + [('cold',i,a) for i,p in enumerate(permutations) for a in p]
parity = rj('identity/corrected-wrapper-parity.json')
assert parity['candidate'] == 'count16guarded' and parity['measurements'] == []
assert parity['parity']['wrappedBytesExact'] is True and parity['parity']['blocks'] == 103
warm = {}
cold = {}
initial = {}
measured = 0
for i,(command,child) in enumerate(zip(commands,execution['children'])):
    assert child['ordinal'] == i and child['argv'] == command['argv'] and child['exitCode'] == 0 and child['status'] == 'complete'
    name = 'cohort/' + Path(command['output']).name
    log = 'cohort/' + Path(command['log']).name
    assert sha(saved[name]) == child['resultSha256'] and sha(saved[log]) == child['logSha256']
    result = rj(name)
    assert result['node'] == 'v24.22.3' and result['order'] == 'AB' and result['mode'] == command['mode'] and result['candidate'] == command['kind']
    for key in ('captureReportSha256','wrapperSha256','databaseSourceSha256','plannerSourceSha256','blockTargetBytes','level','dictionarySha256','captureInputs'):
        assert result[key] == parity[key]
    for key in ('blocks','inputBytes','compressedBytes'):
        assert result['parity'][key] == parity['parity'][key]
    assert all(m['bytes'] == parity['parity']['compressedBytes'] for m in result['measurements'])
    measured += len(result['measurements'])
    if i == 0:
        schedule = [(n,a) for n,order in enumerate(plan['fixedProtocol']['warm']['roundSchedules']) for a in order]
        assert [(m['round'],m['arm']) for m in result['measurements']] == schedule
        assert len(result['measurements']) == 32
        assert analysis['warm']['rawMeasurements'] == result['measurements']
        for m in result['measurements']: warm[m['round'],m['arm']] = m['wallMs']
    else:
        assert len(result['measurements']) == len(result['initialization']) == 1
        cold[command['pair'],command['arm']] = result['measurements'][0]['wallMs']
        initial[command['pair'],command['arm']] = result['initialization'][0]['initializationMs']
assert measured == analysis['measuredCorpusPasses'] == 50
assert analysis['excludedWarmupPasses'] == execution['excludedWarmupCorpusPasses'] == 8
assert analysis['totalCorpusPasses'] == 58 and analysis['totalBlockCompressions'] == 58 * 103 == 5974


def compare(changed, baseline):
    delta = [b-a for b,a in zip(changed,baseline)]
    ratios = [b/a for b,a in zip(changed,baseline)]
    return {'count':len(delta),'changedMs':changed,'baselineMs':baseline,'changesMs':delta,'ratios':ratios,
            'medianChangeMs':statistics.median(delta),'medianChangePercent':100*(statistics.median(ratios)-1),
            'faster':sum(b<a for b,a in zip(changed,baseline)),'equalWorkChangePercent':100*(sum(changed)/sum(baseline)-1)}


def means(data, arms, count):
    return [sum(data[i,a] for a in arms)/len(arms) for i in range(count)]

recomputed = {}
for section,data,count,definitions in [
    ('warm',warm,8,[('B/A','B','A'),('B/C','B','C'),('D/A','D','A'),('D/C','D','C'),('C/A','C','A'),('D/B','D','B'),('mean(B,D)/mean(A,C)','BD','AC')]),
    ('cold',cold,6,[('B/A','B','A'),('B/C','B','C'),('C/A','C','A'),('B/mean(A,C)','B','AC')]),
    ('initialization',initial,6,[('B/A','B','A'),('B/C','B','C'),('C/A','C','A')]),
    ('total',{k:v+initial[k] for k,v in cold.items()},6,[('B/A','B','A'),('B/C','B','C'),('C/A','C','A'),('B/mean(A,C)','B','AC')])]:
    calculations = {label:compare(means(data,b,count),means(data,a,count)) for label,b,a in definitions}
    expected = analysis['warm']['comparisons'] if section == 'warm' else analysis['cold'][{'cold':'wrapperComparisons','initialization':'initializationComparisons','total':'initializationAndWrapperComparisons'}[section]]
    assert calculations == expected, section
    recomputed[section] = {label:{k:v for k,v in values.items() if k not in ('changedMs','baselineMs','changesMs','ratios')} for label,values in calculations.items()}
assert cold[3,'B'] == 304.650751 and cold[3,'B'] == max(cold.values())
assert len(analysis['cold']['rawMeasurements']) == 18
for item in reconstruction['nativeAssets']:
    data = subprocess.check_output(['git','-C',str(REPO),'show',item['commit']+':'+item['repositoryPath']])
    assert item['repositoryPath'] == 'dev/data/zstd-simd.wasm'
    assert len(data) == item['bytes'] and sha(data) == item['sha256'] and blob(data) == item['gitBlobSha1']
    assert Path(item['materializedPath']).read_bytes() == data
assert sha(saved['tools/screen.mjs']) == plan['screen']['sha256']
assert sha(saved['identity/capture-report.json']) == parity['captureReportSha256']
assert reconstruction['captureArtifact']['artifactId'] == 15245899188
assert len(reconstruction['captureGroups']) == len(parity['captureInputs']) == 12
assert [{k:v for k,v in row.items() if k != 'compressedBytes'} for row in reconstruction['captureGroups']] == parity['captureInputs']
capture_rows = {row['cacheFile']:row for row in rj('identity/capture-report.json')['groups']}
for row in reconstruction['captureGroups']:
    assert row['compressedBytes'] == capture_rows[row['name']]['compressedBytes']
    assert row['sha256'] == capture_rows[row['name']]['cacheSha256']
receipt = {'complete':True,'reviewedAtUtc':datetime.now(timezone.utc).isoformat(),
           'scope':'Independent archive/source readback and saved-data arithmetic only; no timing/build/parity rerun or product promotion.',
           'manifestSha256':sha(manifest_path.read_bytes()),'publicationFilesVerified':7,
           'archive':inventory['archive'],'sourceMembersVerified':65,'allOriginalBytesMatch':True,
           'childrenValidated':19,'measuredCorpusPasses':50,'excludedWarmups':8,'totalCorpusPasses':58,'blockCompressions':5974,
           'controlsAndTailRetained':True,'candidateTailBcaMs':cold[3,'B'],'recomputedComparisons':recomputed,
           'conclusion':'All archive/source identities and all four comparison families reproduce exactly. The retained controls and candidate tail support the stated inconclusive local-only disposition.',
           'reviewerSourceSha256':sha(Path(__file__).read_bytes())}
out=ROOT/'independent-appendix-review.json'
with out.open('x') as stream: json.dump(receipt,stream,indent=2);stream.write('\n')
print(json.dumps({'complete':True,'receipt':str(out),'sha256':sha(out.read_bytes()),'files':7,'members':65,'rawBytes':454139,'comparisonsRecomputed':sum(len(v) for v in recomputed.values())},indent=2))
