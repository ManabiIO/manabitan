from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,tempfile,urllib.request,zipfile,datetime
source=Path(__file__).resolve().parents[3];package=Path(__file__).resolve().parent;dataset=sys.argv[1];assert dataset in ['jmdict','jitendex']
runner=Path(os.environ['RUNNER_TEMP']).resolve(strict=True);root=Path(tempfile.mkdtemp(prefix='prefix-firefox-guard-',dir=runner));tools=root/'tools';evidence=root/'evidence';tools.mkdir();evidence.mkdir();(tools/'browser-tmp').mkdir();(evidence/'packages').mkdir()
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip();template=json.loads((package/'contract-template.json').read_text());revisions={'baseline':template['baseline'],'candidate':template['candidate']};worktrees={}
for arm,revision in revisions.items():
 dest=root/arm;assert not dest.exists();subprocess.run(['git','worktree','add','--detach',str(dest),revision],cwd=source,check=True);assert dest.resolve()==dest
 (dest/'node_modules').symlink_to((source/'node_modules').resolve(strict=True),target_is_directory=True)
 assert subprocess.check_output(['git','rev-parse',revision+':ext/js/dictionary/wasm'],cwd=source,text=True).strip()==subprocess.check_output(['git','rev-parse','HEAD:ext/js/dictionary/wasm'],cwd=source,text=True).strip()
 # Both variants use the same generated dependency graph; build outputs remain private copies.
 assert not (dest/'ext/lib').exists();shutil.copytree(source/'ext/lib',dest/'ext/lib')
 log=evidence/('build-'+arm+'.log')
 with log.open('x') as f:subprocess.run(['npm','run','build','--','--target','firefox-dev'],cwd=dest,stdout=f,stderr=subprocess.STDOUT,check=True)
 assert not subprocess.check_output(['git','diff','--name-only'],cwd=dest,text=True).strip();worktrees[arm]=dest
sha=lambda data:hashlib.sha256(data).hexdigest();packages={};assets={}
for arm,dest in worktrees.items():
 built=dest/'builds/manabitan-firefox-dev.zip';out=evidence/'packages'/(arm+'.zip');shutil.copyfile(built,out)
 with zipfile.ZipFile(out) as z:
  assets[arm]={n:sha(z.read(n)) for n in z.namelist() if not n.endswith('/')}
  wasm=sha(z.read('lib/term-bank-parser.wasm'));lookup=sha(z.read('js/dictionary/term-lookup-index.js'))
 packages[arm+'-firefox']={'path':str(out),'sha256':sha(out.read_bytes()),'wasmSha256':wasm,'runtimeSha256':lookup,'sourceHead':revisions[arm]}
assert assets['baseline'].keys()==assets['candidate'].keys();changed=[n for n in assets['baseline'] if assets['baseline'][n]!=assets['candidate'][n]];assert changed==['js/dictionary/term-lookup-index.js'],changed
assert packages['baseline-firefox']['wasmSha256']==packages['candidate-firefox']['wasmSha256'];(evidence/'packages.json').write_text(json.dumps(packages,indent=2)+'\n');(evidence/'package-asset-audit.json').write_text(json.dumps({'assets':assets,'changed':changed,'unchangedNativeBytes':True},indent=2)+'\n')
fixtures=json.loads((source/'test/perf/dictionaries.lock.json').read_text())['dictionaries'];fixture=fixtures[dataset];cache=runner/'prefix-firefox-dictionary-cache';cache.mkdir(exist_ok=True);archive=cache/fixture['cacheFile']
if not archive.exists():
 request=urllib.request.Request(fixture['url'],headers={'User-Agent':'Manabitan-prefix-qualification'})
 with urllib.request.urlopen(request,timeout=120) as response,archive.open('xb') as output:shutil.copyfileobj(response,output)
assert archive.stat().st_size==fixture['sizeBytes'];assert sha(archive.read_bytes())==fixture['sha256'];(evidence/'fixture.json').write_text(json.dumps(fixture,indent=2)+'\n')
for name in ['one.mjs','cohort.py','firefox-runner.mjs','firefox-extension-base-url.mjs','prefix-probe.mjs','probe.test.mjs','process-tree-memory.mjs']:(tools/name).write_bytes((package/name).read_bytes())
# Keep only relative portable references in committed tools; frozen runtime import points at the research checkout.
p=tools/'firefox-runner.mjs';s=p.read_text();s=s.replace("from '../host-environment.js'",'from '+json.dumps((source/'dev/perf/host-environment.js').as_uri()));s=s.replace("from '../../../ext/js/dictionary/term-bank-experiments.js'",'from '+json.dumps((source/'ext/js/dictionary/term-bank-experiments.js').as_uri()));p.write_text(s)
config={'source':str(worktrees['baseline']),'candidateSource':str(worktrees['candidate']),'head':revisions['baseline'],'candidateHead':revisions['candidate'],'root':str(root),'tools':str(tools),'evidence':str(evidence),'fixtureRoot':str(cache),'node':shutil.which('node'),'lock':str(root/'admission.lock')};assert config['node'];(tools/'config.json').write_text(json.dumps(config,indent=2)+'\n');(evidence/'config.json').write_text(json.dumps(config,indent=2)+'\n')
contract={**template,'researchHead':head,'cases':[{'browser':'firefox','dictionary':dataset,'blocks':template['caseBlocks']}],'tools':{}}
contract['tools']={n:sha((tools/n).read_bytes()) for n in ['one.mjs','cohort.py','firefox-runner.mjs','firefox-extension-base-url.mjs','prefix-probe.mjs','probe.test.mjs','process-tree-memory.mjs','config.json']};(tools/'contract.json').write_text(json.dumps(contract,indent=2)+'\n');(evidence/'contract.json').write_text(json.dumps(contract,indent=2)+'\n')
for n in ['one.mjs','firefox-runner.mjs','firefox-extension-base-url.mjs','prefix-probe.mjs','process-tree-memory.mjs']:subprocess.run([config['node'],'--check',str(tools/n)],check=True)
with (evidence/'observer-controls.log').open('x') as f:subprocess.run([config['node'],'--test',str(tools/'probe.test.mjs')],stdout=f,stderr=subprocess.STDOUT,check=True)
(evidence/'preflight-audit.json').write_text(json.dumps({'status':'passed','scope':'Static/package/fixture/observer preflight only. Actual runtime/source/import/query oracles execute in excluded warmups and every subsequent observation.','researchHead':head,'packageDifference':changed,'fixtureSha256':fixture['sha256'],'observerUnitControls':True},indent=2)+'\n')
(evidence/'environment.json').write_text(json.dumps({'researchHead':head,'node':subprocess.check_output(['node','--version'],text=True).strip(),'compiler':subprocess.check_output(['clang','--version'],text=True),'packageFiles':{p.name:sha(p.read_bytes()) for p in package.iterdir() if p.is_file()}},indent=2)+'\n')
with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('tools='+str(tools)+'\nevidence='+str(evidence)+'\n')
print(json.dumps({'tools':str(tools),'evidence':str(evidence),'dataset':dataset,'researchHead':head}))
