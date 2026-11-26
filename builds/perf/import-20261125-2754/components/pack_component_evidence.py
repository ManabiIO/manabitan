from pathlib import Path
import argparse,hashlib,importlib.util,json,subprocess,sys,tarfile,tempfile
sys.dont_write_bytecode = True
arguments = argparse.ArgumentParser()
arguments.add_argument('workspace', type=Path)
BASE=arguments.parse_args().workspace.resolve()
REPO=BASE/'manabitan'
OUT=Path(__file__).resolve().parent
HELPER=OUT.parent/'media-memory/pack_text_evidence.py'
spec=importlib.util.spec_from_file_location('retained_memory_packer',HELPER)
helper=importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
def git(*args):return subprocess.check_output(['git',*args],cwd=REPO)
def sha(data):return hashlib.sha256(data).hexdigest()
baseline='7d1643e6147a10cb2165e9744cf0e63b59e46632'
candidates={
 'native-media-projection':('7a8b25a44a3fe165107ed816377cc72bb0fac67d','98731a11d81161c929f7822516610e3018aa9dab'),
 'native-metadata-preflight':('b2e816c4714f42f87cbb6a1ebc7fe1a2d2fd863b','d61a49f03'),
 'contiguous-source-crc':('c2cf7647c67b02474301ed48e54a53205be0f027','8657de155e6a17c7d85c67f66c0eebdff6931ed3'),
}
identities={'baseline':{'commit':baseline,'tree':git('rev-parse',baseline+'^{tree}').decode().strip()},'candidates':{}}
for name,(remote,local) in candidates.items():
 tree=git('rev-parse',remote+'^{tree}').decode().strip()
 assert tree==git('rev-parse',local+'^{tree}').decode().strip()
 paths=git('diff','--name-only',baseline,remote).decode().splitlines()
 identities['candidates'][name]={'frozenHostedCommit':remote,'equivalentLocalCommit':git('rev-parse',local).decode().strip(),'tree':tree,'changedSourceFiles':[{'path':path,'bytes':len(data:=git('show',remote+':'+path)),'sha256':sha(data)} for path in paths]}
later='5afd2e97ec2707b150acfde61115aee688547a78'
frozen=candidates['native-media-projection'][0]
changed=git('diff','--name-only',frozen,later).decode().splitlines()
assert changed==['test/term-bank-experiments.test.js','test/term-bank-media-projection.test.js']
assert not git('diff',frozen,later,'--','ext','dev','package.json','package-lock.json')
identities['candidates']['native-media-projection']['laterPr875TestHead']={'commit':later,'tree':git('rev-parse',later+'^{tree}').decode().strip(),'parent':git('rev-parse',later+'^').decode().strip(),'changedPaths':changed,'productSourceAndBuildInputsUnchanged':True,'meaning':'The frozen component, timing and memory product remains 7a8b25; the later PR head adds route-disabled coverage in only these two test files.'}
metadata_later='b273513dab4fa409a0213a2db470e52b4a0f559c'
metadata_frozen=candidates['native-metadata-preflight'][0]
metadata_local='60a8a9c1'
assert git('rev-parse',metadata_later+'^{tree}')==git('rev-parse',metadata_local+'^{tree}')
identities['candidates']['native-metadata-preflight']['laterValidationHead']={'commit':metadata_later,'equivalentLocalCommit':git('rev-parse',metadata_local).decode().strip(),'tree':git('rev-parse',metadata_later+'^{tree}').decode().strip(),'changedPathsSinceFrozenStudy':git('diff','--name-only',metadata_frozen,metadata_later).decode().splitlines(),'meaning':'Frozen component and hosted study source remains b2e816c. Later source formatting has a retained exact AST comparison; subsequent checked non-null fixture guards affect tests. Final lint/types/focused tests/dry builds apply to this later validation head, not the frozen study commit.'}
crc_annotation='a3b5ddf4bb676b06bd8a577c67f971907ddc30b2'
crc_annotation_hosted='2fe47fa3db04342d04eb4f309c5d74ef45eef9e3'
assert git('rev-parse',crc_annotation_hosted+'^{tree}')==git('rev-parse',crc_annotation+'^{tree}')
crc_frozen=candidates['contiguous-source-crc'][0]
assert git('diff','--name-only',crc_frozen,crc_annotation).decode().splitlines()==['test/term-bank-source-crc-reuse.test.js']
assert not git('diff',crc_frozen,crc_annotation,'--','ext','dev','package.json','package-lock.json')
identities['candidates']['contiguous-source-crc']['laterTestAnnotationHead']={'hostedCommit':crc_annotation_hosted,'localCommit':crc_annotation,'tree':git('rev-parse',crc_annotation+'^{tree}').decode().strip(),'changedPaths':['test/term-bank-source-crc-reuse.test.js'],'productSourceAndBuildInputsUnchanged':True,'meaning':'One JSDoc type annotation fixes the three test TypeScript literal-inference diagnostics. Performance studies remain labeled with frozen c2cf7647; no source or performance reacquisition occurred.'}
(OUT/'source-identities.json').write_text(json.dumps(identities,indent=2)+'\n')
sources={'provenance/source-identities.json':OUT/'source-identities.json'}
omitted=[]
for prefix,root in [('native-media-projection',BASE/'vndb-evidence'),('contiguous-source-crc',BASE/'jitendex/builds/perf'),('contiguous-source-crc/final-codeql',BASE/'evidence/crc-codeql-final')]:
 for p in sorted(root.rglob('*')):
  if not p.is_file():continue
  assert not p.is_symlink()
  name=f'{prefix}/{p.relative_to(root).as_posix()}'
  data=p.read_bytes()
  if p.suffix in ['.wasm','.gz','.pyc']:
   omitted.append({'path':name,'bytes':len(data),'sha256':sha(data),'reason':'Compiled diagnostic or historical archive payload omitted; current committed asset identities, retained text sources, and diagnostic receipts are preserved. Integration-snapshot files are pre-rebuild scratch, not the frozen validated candidate.'})
   continue
  data.decode('utf-8')
  sources[name]=p
for name in ['jmdict-publish-real-parity.json','jitendex-publish-real-parity.json','vndb-publish-real-parity.json','jmdict-publish-real-parity.mjs','jmdict-publish-screen.mjs','metadata-admission-audit.md','metadata-admission-audit.json','metadata-codeql-45647170330.md','metadata-codeql-45647170330.json','metadata-codeql-45647170330-job.log']:
 p=BASE/'evidence'/name
 p.read_bytes().decode('utf-8')
 sources['native-metadata-preflight/'+name]=p
for name,(commit,_) in candidates.items():
 manifest_path=OUT/(name+'-wasm-manifest.json')
 manifest_path.write_bytes(git('show',commit+':dev/data/dictionary-wasm/manifest.json'))
 sources['provenance/'+manifest_path.name]=manifest_path
for name,p in {
 'native-metadata-preflight/later-format-ast.json':Path('/tmp/manabitan-2754-metadata-format-ast.json'),
 'native-metadata-preflight/independent-source-review.md':Path('/tmp/manabitan-2754-metadata-audit/source-review.md'),
 'contiguous-source-crc/independent-source-review.md':OUT/'crc-source-review.md',
 'provenance/pack_component_evidence.py':Path(__file__).resolve(),
 'provenance/final-pr-ci-snapshot.json':BASE/'evidence/final-pr-ci-snapshot.json',
 'provenance/final-source-ci-jobs.json':BASE/'evidence/final-source-ci-jobs.json',
}.items():
 p.read_bytes().decode('utf-8')
 sources[name]=p
for name in [
 'manabitan-2754-jmdict-lint-60a8.log','manabitan-2754-jmdict-types-60a8.log',
 'manabitan-2754-jmdict-tests-60a8.log','manabitan-2754-jmdict-build-60a8.log',
 'manabitan-2754-jmdict-main-types.log','manabitan-2754-jmdict-final-lint.log',
 'manabitan-2754-jmdict-test-types.log',
 'manabitan-2754-jmdict-full-unit.log','manabitan-2754-jmdict-native-check-final.log',
 'manabitan-2754-jmdict-timeout-isolation.json',
 'manabitan-2754-jmdict-timeout-isolation-baseline.log',
 'manabitan-2754-jmdict-timeout-isolation-candidate.log',
]:
 p=Path('/tmp')/name
 p.read_bytes().decode('utf-8')
 sources['native-metadata-preflight/root-validation/'+name]=p
for name in [
 'manabitan-2754-crc-full-unit.log','manabitan-2754-crc-native-check.log',
 'manabitan-2754-crc-main-types.log','manabitan-2754-crc-test-types.log',
 'manabitan-2754-crc-test-types-fixed.log','manabitan-2754-crc-test-lint-fixed.log',
 'manabitan-2754-crc-build-final.log',
]:
 p=Path('/tmp')/name
 p.read_bytes().decode('utf-8')
 sources['contiguous-source-crc/root-validation/'+name]=p
for p in sorted((OUT/'ci').glob('*.json')):
 p.read_bytes().decode('utf-8')
 sources['native-media-projection/ci/'+p.name]=p
members=[{'path':name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for name,p in sorted(sources.items())]
archive=OUT/'component-receipts-20261125-2754.text.tar.gz'
with archive.open('wb') as stream:helper.write_archive(stream,sources)
digest=sha(archive.read_bytes())
with tempfile.TemporaryFile(dir='/tmp') as second:
 helper.write_archive(second,sources)
 second.seek(0)
 assert hashlib.file_digest(second,'sha256').hexdigest()==digest
with tarfile.open(archive,'r:gz') as packed:
 assert [m.name for m in packed.getmembers()]==[m['path'] for m in members]
 for member in members:assert sha(packed.extractfile(member['path']).read())==member['sha256']
manifest={'schemaVersion':1,'scope':'Component correctness and diagnostic receipts only; no browser timing or memory qualification inference. All available supplied local text receipts and harnesses are preserved, including rejected experiments and failures.','archive':{'path':archive.name,'bytes':archive.stat().st_size,'sha256':digest},'sourceIdentities':identities,'sourceRoots':{'native-media-projection':str(BASE/'vndb-evidence'),'contiguous-source-crc':str(BASE/'jitendex/builds/perf'),'native-metadata-preflight':str(BASE/'evidence')},'includedFiles':members,'omittedBinaryFiles':omitted,'verification':{'duplicateBuildByteIdentical':True,'everyMemberRoundTripMatches':True},'notes':['Earlier media projection integration-snapshot is preserved as scratch history; its parser asset predates the successful pinned rebuild and is not qualification evidence.','Earlier media package-delta.json includes dependency-symlink path churn; package-delta-hardlink.json records the corrected ordinary build with exactly four changed entries.','The metadata owner supplied no saved raw logs for their first focused tests/native rebuild; this archive does not reconstruct those logs. Later genuine root-validation logs for head b273513 are preserved separately, along with the initial lint/nullability failures.','CRC failure receipts distinguish transcribed tool outcomes from original raw logs; their missing candidate results remain missing.','Component RSS and timing values are diagnostic only. Bounded worker replays do not reproduce full parallel scheduling.']}
(OUT/'archive-manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
(OUT/'SHA256SUMS').write_text(f'{digest}  {archive.name}\n')
print(json.dumps({'archive':manifest['archive'],'files':len(members),'uncompressedBytes':sum(m['bytes'] for m in members),'omitted':len(omitted)}))
