from pathlib import Path
import hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parent
base=root/'baseline'
candidate=root/'candidate'
expected={'A':'7d1643e6147a10cb2165e9744cf0e63b59e46632','B':'0d7b5a70213e2324a2166cbb584847189e9cd2ff'}
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def git(where,*args):return subprocess.check_output(['git','-C',str(where),*args],text=True).strip()
harness=['package-lock.json','dev/data/manifest-variants.json','test/perf/dictionaries.lock.json','dev/perf/benchmark-support.js','dev/perf/dictionary-fixtures.js','dev/perf/import-benchmark.js','test/chromium/extension-two-dictionary-import.e2e.js','test/e2e/import-timing.js','dev/data/dictionary-wasm/manifest.json']
source={};packages={}
for arm,where in [('A',base),('B',candidate)]:
 assert git(where,'rev-parse','HEAD')==expected[arm]
 assert git(where,'status','--porcelain')==''
 paths=subprocess.check_output(['git','-C',str(where),'ls-files','-z']).decode().split('\0')
 hashes={p:sha(where/p) for p in paths if p}
 aggregate=hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 source[arm]={'path':str(where),'head':expected[arm],'tree':git(where,'rev-parse','HEAD^{tree}'),'allTrackedFileHashes':hashes,'aggregateTrackedSha256':aggregate,'harness':{p:hashes[p] for p in harness}}
 archive=where/'builds/manabitan-chrome.zip'
 with zipfile.ZipFile(archive) as z:
  members={name:{'bytes':z.getinfo(name).file_size,'sha256':hashlib.sha256(z.read(name)).hexdigest()} for name in z.namelist() if not name.endswith('/')}
 packages[arm]={'path':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'members':members}
assert source['A']['harness']==source['B']['harness']
a,b=[packages[x]['members'] for x in ('A','B')]
delta={p:{'A':a.get(p),'B':b.get(p)} for p in sorted(set(a)|set(b)) if a.get(p)!=b.get(p)}
allowed={'js/dictionary/dictionary-importer.js','js/dictionary/dictionary-media-diagnostics.js','js/dictionary/term-bank-wasm-parser.js','js/dictionary/term-bank-wasm-parser-worker.js'}
assert set(delta)==allowed,sorted(delta)
for arm,where in [('A',base),('B',candidate)]:
 for p in allowed:
  if p in packages[arm]['members']:assert sha(where/'ext'/p)==packages[arm]['members'][p]['sha256']
lock=json.loads((base/'test/perf/dictionaries.lock.json').read_text())
fixtures={}
for name,spec in lock['dictionaries'].items():
 p=base/'builds/e2e-dictionary-cache'/spec['cacheFile']
 assert sha(p)==spec['sha256']
 assert p.stat().st_size==spec['sizeBytes']
 fixtures[name]={'path':str(p.resolve()),**spec}
node=Path('/tmp/manabitan-8ca6-runtime/runtime/node/bin/node')
chromium=Path('/tmp/manabitan-8ca6-runtime/runtime/ms-playwright/chromium-1243/chrome-linux64/chrome')
assert chromium.is_file()
dependencies={}
for name in ('@playwright/test','playwright','playwright-core'):
 p=(base/'node_modules'/name/'package.json').resolve()
 dependencies[name]={'path':str(p),'version':json.loads(p.read_text())['version'],'packageJsonSha256':sha(p)}
identity={'source':source,'packages':packages,'packageDelta':delta,'fixtures':fixtures,'baselineControl':'C uses the exact A package in a separate fresh browser/profile for every observation.','candidateRemote':{'pr':'https://github.com/ManabiIO/manabitan/pull/907','head':'2a0b9243540bf54932165fd9ab4da17709e3b390','tree':source['B']['tree'],'equivalence':'Root verified remote tree equals local candidate tree.'},'runtime':{'artifactId':15033782559,'workflowRun':45639583911,'node':{'path':str(node),'version':subprocess.check_output([str(node),'--version'],text=True).strip(),'versions':json.loads(subprocess.check_output([str(node),'-p','JSON.stringify(process.versions)'],text=True)),'sha256':sha(node)},'chromium':{'path':str(chromium),'version':'153.0.8010.12','versionCommandOutput':subprocess.check_output([str(chromium),'--version'],text=True).strip(),'sha256':sha(chromium)},'playwrightBrowsersPath':'/tmp/manabitan-8ca6-runtime/runtime/ms-playwright','dependencies':dependencies},'libraryControl':'Candidate normal build retained as candidate-original-build.zip; qualification candidate repackaged with identical baseline generated libraries using unmodified exported build(). Lockfile, library source, and all noncandidate package entries match.','scope':'Single-host Linux Chromium screen. No process-tree memory measurement. Browser profile filesystem is task-specific /tmp tmpfs.'}
(root/'identity.json').write_text(json.dumps(identity,indent=2)+'\n')
print(json.dumps({'heads':{k:{x:v[x] for x in ['head','tree','aggregateTrackedSha256']} for k,v in source.items()},'packages':{k:{x:v[x] for x in ['bytes','sha256']} for k,v in packages.items()},'delta':list(delta),'runtime':identity['runtime']},indent=2))
