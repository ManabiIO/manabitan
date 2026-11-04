from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,tempfile,urllib.request

source=Path(__file__).resolve().parents[3]
package=Path(__file__).resolve().parent
variant,dictionary=sys.argv[1:]
assert variant in ['wide','crc','colon'] and dictionary in ['jmdict','jitendex']
identity=json.loads((package/'source-identity.json').read_text())
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
assert subprocess.check_output(['git','rev-parse','HEAD:ext'],cwd=source,text=True).strip()==identity['extTree']
assert hashlib.sha256((source/'ext/js/dictionary/wasm/term-bank-parser.c').read_bytes()).hexdigest()==identity['parserSourceSha256']
assert hashlib.sha256((source/'ext/js/dictionary/wasm/vendor/libdeflate/common_defs.h').read_bytes()).hexdigest()==identity['headerSha256']
parent=Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
root=Path(tempfile.mkdtemp(prefix='contained-fresh-',dir=parent));tools=root/'tools';evidence=root/'evidence';goldens=root/'goldens'
for p in [tools,evidence,goldens]:p.mkdir()
for name in ['child.mjs','helpers.mjs','analyze.py','run.py']:(tools/name).write_bytes((package/name).read_bytes())
(tools/'node_modules').symlink_to((source/'node_modules').resolve(strict=True),target_is_directory=True)
fixture_root=parent/'contained-dictionary-cache';fixture_root.mkdir(exist_ok=True)
fixtures=json.loads((source/'test/perf/dictionaries.lock.json').read_text())['dictionaries']
fixture=fixtures[dictionary];archive=fixture_root/fixture['cacheFile']
if not archive.exists():
 request=urllib.request.Request(fixture['url'],headers={'User-Agent':'Manabitan-contained-phase-qualification'})
 with urllib.request.urlopen(request,timeout=120) as response,archive.open('xb') as output:shutil.copyfileobj(response,output)
assert archive.stat().st_size==fixture['sizeBytes']
with archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==fixture['sha256']
flags=json.loads((package/'compiler-flags.json').read_text());compiler=shutil.which('clang');assert compiler
builds=[]
for arm in ['baseline','wide','crc','colon']:
 native=tools/arm/'native';shutil.copytree(source/'ext/js/dictionary/wasm',native)
 if arm=='wide':
  p=native/'vendor/libdeflate/common_defs.h';s=p.read_text();assert s.count('typedef size_t machine_word_t;')==1;p.write_text(s.replace('typedef size_t machine_word_t;','typedef uint64_t machine_word_t;'))
 if arm in ['crc','colon']:
  patch=(package/(arm+'.patch')).read_text()
  subprocess.run(['git','apply','--check','-'],input=patch,text=True,cwd=native,check=True)
  subprocess.run(['git','apply','-'],input=patch,text=True,cwd=native,check=True)
 output=tools/(arm+'.wasm');command=[compiler,*flags,'-o',str(output),str(native/'term-bank-parser.c'),str(native/'term-bank-inflate.c')]
 subprocess.run(command,check=True)
 builds.append({'side':arm,'command':command,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'bytes':output.stat().st_size})
(evidence/'builds.json').write_text(json.dumps(builds,indent=2)+'\n')
node=shutil.which('node');assert node
config={'source':str(source),'tools':str(tools),'evidence':str(evidence),'originalEvidence':str(goldens),'head':head,'node':node,'compiler':compiler,'root':str(root),'fixtureRoot':str(fixture_root),'baselineWasmSha256':builds[0]['sha256'],'lock':str(root/'admission.lock'),'hosted':True}
(tools/'config.json').write_text(json.dumps(config,indent=2)+'\n');(evidence/'config.json').write_text(json.dumps(config,indent=2)+'\n')
contract=json.loads((package/'contract-template.json').read_text());contract['cases']=[[variant,dictionary,phase] for phase in (['parse','inflate'] if variant=='colon' else ['inflate','parse'])]
(tools/'contract.json').write_text(json.dumps(contract,indent=2)+'\n');(evidence/'contract.json').write_text(json.dumps(contract,indent=2)+'\n')
(evidence/'compiler.json').write_text(json.dumps({'path':compiler,'version':subprocess.check_output([compiler,'--version'],text=True),'sourceExtTree':identity['extTree'],'researchHead':head,'packageFiles':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in package.iterdir() if p.is_file()}},indent=2)+'\n')
output=os.environ.get('GITHUB_OUTPUT')
if output:
 with open(output,'a') as f:f.write('tools='+str(tools)+'\nevidence='+str(evidence)+'\n')
print(json.dumps({'tools':str(tools),'evidence':str(evidence),'variant':variant,'dictionary':dictionary}))
