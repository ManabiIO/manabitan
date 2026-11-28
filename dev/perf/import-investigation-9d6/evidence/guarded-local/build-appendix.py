"""Save the completed one-shot guarded component screen; no measurement or publication."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'appendix'
assert not OUT.exists()
OUT.mkdir()
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda path: json.loads(path.read_bytes())
analysis = read(ROOT / 'analysis.json')
plan = read(ROOT / 'proposed-plan.json')
identities = read(ROOT / 'cohort-01/input-identities.json')
by_path = {row['path']: row for row in identities['verified']}
assert analysis['complete'] and analysis['measurementChildren'] == 19 and analysis['totalCorpusPasses'] == 58
assert analysis['candidateWasmSha256'] == '13890c7e75e7a2ff5fa00bd65f1e518e15f545da85154719be6a2eaa2a773a22'
assert sha((ROOT/'audit-local-screen.py').read_bytes()) == analysis['auditorSha256']
selected = {f'cohort/{p.relative_to(ROOT/"cohort-01")}': p for p in sorted((ROOT/'cohort-01').rglob('*')) if p.is_file()}
selected.update({'analysis/analysis.json':ROOT/'analysis.json','analysis/audit-local-screen.log':ROOT/'audit-local-screen.log',
                 'logs/launch-01.log':ROOT/'launch-01.log','tools/audit-local-screen.py':ROOT/'audit-local-screen.py',
                 'tools/build-appendix.py':Path(__file__),'tools/screen.mjs':Path(plan['screen']['path']),
                 'identity/guarded-manifest.json':Path(plan['manifest']['path']),
                 'identity/capture-report.json':Path(plan['captureReport']['path']),
                 'identity/corrected-wrapper-parity.json':Path(plan['parityReceipt']['path']),
                 'packaging/preparation.json':ROOT/'packaging-preparation.json',
                 'packaging/preliminary-build.log':ROOT/'build-appendix-preliminary.log'})
workspace=Path('/workspace/scratch/9d6dcf05cf8f')
module=Path(plan['moduleRoot'])
capture_artifact=workspace/'compression-experiments/dev/perf/wasm-word-width-v2/capture-artifact.json'
selected['identity/capture-artifact.json']=capture_artifact
selected['identity/capture-download-receipt.json']=workspace/'compression-probe/hosted-results/capture/artifact-15245899188-receipt.json'
for name in ['verification.json','boundary-result.json','raw-parity.json']:
    selected['identity/guarded-proof/'+name]=module/name
for name in ['zstd-wasm.js','zstd-simd-module.js']:
    selected['tools/'+name]=module/'wasm-baseline'/name
selected['inputs/jmdict.zdict']=Path(plan['baselineRoot'])/'dev/data/zstd-dicts/jmdict.zdict'
native_assets = []
for kind, commit in [('baseline',plan['baselineCommit']),('count16guarded',plan['candidateCommit'])]:
    identity = plan['modules'][kind]['zstd-simd-module.wasm']
    repository_path = 'dev/data/zstd-simd.wasm'
    data = subprocess.check_output(['git','-C',plan['baselineRoot'],'show',f'{commit}:{repository_path}'])
    assert len(data) == identity['bytes'] and sha(data) == identity['sha256']
    native_assets.append({'kind':kind,'commit':commit,'repositoryPath':repository_path,
                          'materializedPath':identity['path'],'bytes':len(data),'sha256':sha(data),
                          'gitBlobSha1':hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest(),
                          'gitObjectBytesVerified':True})
capture_groups = []
for group in plan['capture']['inputs']:
    identity = by_path[str(Path(plan['captureDirectory'])/group['name'])]
    assert identity['sha256'] == group['sha256']
    capture_groups.append({**group,'compressedBytes':identity['bytes']})
reconstruction={
    'scope':'Native WASM and derived source-capture payloads are omitted; their exact identities and pinned retrieval/reconstruction sources are retained. No old invalid binary timings are reused.',
    'nativeAssets':native_assets,
    'nativeReconstruction':{'repository':'ManabiIO/manabitan','candidateCommit':plan['candidateCommit'],
                          'builderPath':'dev/bin/build-zstd-wasm.js','patchPath':'dev/data/zstd-wasm32-count.patch',
                          'provenancePath':'dev/data/zstd-wasm.PROVENANCE.md',
                          'recipe':'Use the pinned production builder and Emscripten/Zstd revisions in identity/guarded-manifest.json; require exact baseline and guarded WASM hashes before reuse.'},
    'captureArtifact':read(capture_artifact),
    'captureGroups':capture_groups,
    'captureReconstruction':{'repository':'ManabiIO/manabitan','sourceCommit':'d4470d35a684a8c37628123d7740ec2fa3375f4b',
                             'generatorPath':'dev/perf/experimental-9d6/capture.mjs',
                             'baselineCommit':plan['baselineCommit'],'fixtureLockPath':'test/perf/dictionaries.lock.json',
                             'recipe':'Retrieve the original pinned artifact and check its ZIP digest, or regenerate derived groups using the pinned fixture/generator and Node 24.22.3; require every saved group SHA256. The original capture report remains retained separately.'},
    'earlierCompletedEvidence':{'commit':'d602e1b003811b0ebac63e9ef2c8019f430aea21',
                              'guardedProofArchive':'dev/perf/import-investigation-9d6/evidence/codec-v2-and-guarded-proof.tar.gz',
                              'guardedProofArchiveBytes':247023,
                              'guardedProofArchiveSha256':'19daffeaa033adef237c3a24d96998b3d0595510934137e0bfe2fb949470293d',
                              'scope':'Separate prior correctness/invalid-candidate evidence; this local screen is a new corrected-binary result.'},
    'hostedQualification':analysis['hostedQualification']
}
reconstruction_path=OUT/'reconstruction.json'
reconstruction_path.write_text(json.dumps(reconstruction,indent=2)+'\n')
selected['identity/reconstruction.json']=reconstruction_path
patterns=[rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b',
          rb'\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{32,}',rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
          rb'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----',
          rb'(?i)authorization[\x20\t]*[:=][\x20\t]*[\x22\x27]?(?:bearer|basic)[\x20\t]+[A-Za-z0-9_./+=-]{24,}',
          rb'(?i)https?://[^\s\x22\x27<>]{0,2048}[?&](?:x-amz-signature|x-amz-security-token|sig|access_token|refresh_token|client_secret|api_key)=[^&\s\x22\x27<>]{16,}']
files=[]
buffer=io.BytesIO()
with gzip.GzipFile(fileobj=buffer,mode='wb',compresslevel=6,mtime=0,filename='') as compressed:
    with tarfile.open(fileobj=compressed,mode='w',format=tarfile.PAX_FORMAT) as archive:
        for name,source in sorted(selected.items()):
            assert source.is_file() and not source.is_symlink(),str(source)
            data=source.read_bytes()
            for rule,pattern in enumerate(patterns):
                assert re.search(pattern,data) is None,f'Credential pattern {rule} detected in {name}; no values printed'
            identity = by_path.get(str(source))
            if identity is not None:
                assert len(data) == identity['bytes'] and sha(data) == identity['sha256']
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o444;info.mtime=info.uid=info.gid=0
            archive.addfile(info,io.BytesIO(data))
            files.append({'archivePath':name,'sourcePath':str(source),'bytes':len(data),'sha256':sha(data)})
archive_path=OUT/'guarded-local.tar.gz'
with archive_path.open('xb') as stream:stream.write(buffer.getvalue())
with tarfile.open(archive_path,'r:gz') as archive:
    entries=archive.getmembers()
    assert len(entries)==len(files)
    for item,row in zip(entries,files):
        assert item.isfile() and item.name==row['archivePath'] and item.size==row['bytes']
        assert sha(archive.extractfile(item).read())==row['sha256']
for row in files:
    assert sha(Path(row['sourcePath']).read_bytes())==row['sha256']
archive_info={'name':archive_path.name,'bytes':archive_path.stat().st_size,'sha256':sha(archive_path.read_bytes()),'files':len(files),'uncompressedBytes':sum(row['bytes'] for row in files)}
inventory={'complete':True,'scope':analysis['scope'],'status':analysis['status'],'archive':archive_info,'files':files,
           'packagerSha256':sha(Path(__file__).read_bytes()),'auditorSha256':analysis['auditorSha256'],
           'analysisSha256':sha((ROOT/'analysis.json').read_bytes()),'inputIdentities':identities,
           'reconstruction':reconstruction,'credentialPatternScanPassed':True,
           'verification':['Every source file hash checked before and after packaging','Every saved regular tar member read back and hashed',
                           'All 19 original child outputs/logs and source-identical controls retained unchanged','No benchmark, measurement-source mutation, prior published archive replacement or external publication performed']}
(OUT/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
(OUT/'analysis.json').write_bytes((ROOT/'analysis.json').read_bytes())
lines=['# Corrected guarded Zstd: one local screen, inconclusive','',
       '**The single authorized local screen is closed as inconclusive. No follow-up local cohort or PR is justified by these results.** The corrected binary remains eligible for its separately running prospective browser qualification; this shared-host component study does not decide that outcome.','',
       'The candidate is product commit '+plan['candidateCommit']+', WASM SHA256 '+analysis['candidateWasmSha256']+' (433,757 bytes). Baseline '+plan['baselineCommit']+' uses '+analysis['baselineWasmSha256']+' (433,631 bytes). This is the corrected guard. The old invalid SIMD binary 97d50165… remains ineligible, and none of its timings is reused.','',
       '## Fixed protocol and scope','',
       'The complete cohort contains **19 fresh measurement children**: one warm child with four independent A/B/C/D wrapper contexts and 18 fresh cold children in all six A/B/C permutations. The warm child executes eight excluded warmup passes and 32 measured passes; cold children execute 18 first-corpus passes. Total: **50 measured passes, eight excluded warmups, 58 corpus executions and 5,974 block compressions**. Individual warmup durations are not recorded by the frozen child protocol.','',
       'Each corpus uses the same 103 production 1 MiB blocks from 12 captured JMdict groups, with 362,032 canonical pending spans and 101,143,985 retained source bytes. The production JS compression wrapper, dictionary, level, block planning and SharedArrayBuffer ownership are unchanged. Parsing, worker scheduling/messages, OPFS, lookup, UI and full-import latency are excluded. Node 24.22.3 and the exact executable/module/source identities are pinned.','',
       '## Results','',
       'Negative changes favor the numerator. All values below retain every observation. Warm and cold remain separate; no control subtraction, tail exclusion, result-based tuning or additional cohort occurred.','',
       '| Mode | Comparison | Median change | Median paired change | Faster | Equal-work change |',
       '| --- | --- | ---: | ---: | ---: | ---: |']
for mode,comparisons in [('Warm',analysis['warm']['comparisons']),('Cold wrapper',analysis['cold']['wrapperComparisons'])]:
    for name,row in comparisons.items():
        lines.append(f"| {mode} | {name} | {row['medianChangeMs']:+.3f} ms | {row['medianChangePercent']:+.3f}% | {row['faster']}/{row['count']} | {row['equalWorkChangePercent']:+.3f}% |")
lines += ['', 'Warm B/A improves 9.35 ms, but the identical-code C/A control improves 10.35 ms. Against C, B is mixed and D loses. Cold B/A improves 7.34 ms, while B/C loses 1.86 ms and its equal-work total loses 6.10%. These contradictions and control movements prevent a useful gain claim. The original mean-arm summaries also remain present in the table and machine-readable analysis; they are not replaced by a selected favorable comparison.','',
          '## Every cold triple','', '| Permutation | A baseline | B guarded | C baseline |', '| --- | ---: | ---: | ---: |']
for pair,order in enumerate(analysis['cold']['permutations']):
    values={arm:next(row['wallMs'] for row in analysis['cold']['rawMeasurements'] if row['pair']==pair and row['arm']==arm) for arm in 'ABC'}
    lines.append(f"| {''.join(order)} | {values['A']:.3f} ms | {values['B']:.3f} ms | {values['C']:.3f} ms |")
lines += ['', 'The 304.651 ms candidate observation in BCA remains included, alongside its 197.648 ms A and 188.834 ms C controls. Initialization timings and initialization-plus-wrapper comparisons are retained separately in analysis.json.','',
          '## Every warm round','', '| Round | A baseline | B guarded | C baseline | D guarded |', '| --- | ---: | ---: | ---: | ---: |']
for round in range(8):
    values={arm:next(row['wallMs'] for row in analysis['warm']['rawMeasurements'] if row['round']==round and row['arm']==arm) for arm in 'ABCD'}
    lines.append(f"| {round+1} | {values['A']:.3f} ms | {values['B']:.3f} ms | {values['C']:.3f} ms | {values['D']:.3f} ms |")
lines += ['', 'The shared benchmark lock was held for the entire cohort. Parent and peer local artifact work paused during the children. Namespaced visibility and cooperative locking do not establish host isolation. Execution took 20.31 seconds after preflight; host load and memory snapshots accompany every child. These are context observations, not a process-memory qualification.','',
          'The separately retained corrected parity proof checks every compressed byte for all 103 blocks. Timed passes assert the same aggregate compressed-byte total; they do not add per-block hashing inside the timed region. All children completed, all pinned input hashes remained unchanged, and all four warmed wrapper-buffer capacities match.','',
          '## Durable evidence','',
          f"guarded-local.tar.gz contains {archive_info['files']} files / {archive_info['uncompressedBytes']:,} raw bytes; compressed size {archive_info['bytes']:,} bytes; SHA256 {archive_info['sha256']}.",'',
          'The archive retains the frozen plan, root release, orchestration source/review, all child outputs/logs, complete command list, host snapshots, launch log, input identities, arithmetic auditor/source and disposition, original capture report/artifact identity, corrected parity/proof receipts, compression dictionary, and unchanged JS measurement/runtime sources. Native WASM and capture payloads are omitted only with complete hashes and pinned retrieval/reconstruction references. Every archived member was read back and verified.','',
          'The separate [full browser qualification](https://github.com/ManabiIO/manabitan/actions/runs/46109596112) was running when this local study closed. Its outcome is not inferred from this diagnostic. Earlier completed-study archives and old invalid-candidate outcomes remain unchanged.','']
(OUT/'README.md').write_text('\n'.join(lines))
for filename in ['audit-local-screen.py','build-appendix.py']:
    (OUT/filename).write_bytes((ROOT/filename).read_bytes())
manifest=[]
for filename in ['guarded-local.tar.gz','inventory.json','analysis.json','README.md','reconstruction.json','audit-local-screen.py','build-appendix.py']:
    path=OUT/filename;data=path.read_bytes()
    manifest.append({'path':'dev/perf/import-investigation-9d6/evidence/guarded-local/'+filename,'localPath':str(path),
                     'encoding':'base64' if filename.endswith('.tar.gz') else 'utf-8','bytes':len(data),
                     'sha256':sha(data),'gitBlobSha1':hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()})
(OUT/'publication-manifest.json').write_text(json.dumps({'status':'Frozen completed local diagnostic evidence; no promotion or external publication by this agent.','files':manifest},indent=2)+'\n')
print(json.dumps({'complete':True,'manifest':str(OUT/'publication-manifest.json'),'manifestSha256':sha((OUT/'publication-manifest.json').read_bytes()),'archive':archive_info},indent=2))
