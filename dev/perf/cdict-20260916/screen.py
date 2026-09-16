from pathlib import Path
import hashlib, json, os, shutil, subprocess, time, zipfile

BASE='c0a1b7ee6fa1383a0a422361d2a8b7f826499fff'
TREE='a48da18d4244b00661d0c6518b2ce77b9f2f9b55'
root=Path.cwd(); inputs=Path(__file__).parent
variant=os.environ['CANDIDATE']; dictionary=os.environ['DICTIONARY']; pairs=int(os.environ.get('PAIRS','6')); order=os.environ.get('INITIAL_ORDER','AB')
assert variant=='cdict' and dictionary in ('jmdict','jitendex') and order in ('AB','BA')
out=root/'builds/cdict-review'; out.mkdir(parents=True,exist_ok=True)
candidate=Path(os.environ['RUNNER_TEMP'])/'cdict-candidate'; package=Path('builds/manabitan-chrome-dev.zip')

def run(args,cwd=root,timeout=600): return subprocess.check_output(args,cwd=cwd,text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()
def logrun(args,name,cwd=root,timeout=600):
    with (out/name).open('w') as f: subprocess.run(args,cwd=cwd,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=timeout)
def sha(path):
    with Path(path).open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()

def zstd_build(directory,write=False,name='zstd-build.log'):
    args=['docker','run','--rm','-u',f"{os.getuid()}:{os.getgid()}",'-v',f'{directory}:/src','-w','/src','emscripten/emsdk:5.0.1','node','dev/bin/build-zstd-wasm.js']
    if write: args.append('--write')
    logrun(args,name,root,1200)

assert run(['git','rev-parse','HEAD'])==BASE and run(['git','rev-parse','HEAD^{tree}'])==TREE
run(['git','worktree','add','--detach',str(candidate),BASE])
(candidate/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
(candidate/'builds').mkdir(exist_ok=True)
(candidate/'builds/e2e-dictionary-cache').symlink_to(root/'builds/e2e-dictionary-cache',target_is_directory=True)
with (root/'.git/info/exclude').open('a') as f: f.write('\n/node_modules\n')

# Fail closed if the pinned container cannot reproduce the checked-in compiler output.
zstd_build(root,False,'baseline-zstd-repro.log')
change=json.loads(run(['python3',str(inputs/'apply.py'),variant],candidate))
zstd_build(candidate,True,'candidate-zstd-build.log')
product_files=change['changed']+['dev/lib/zstd-simd-module.js','dev/data/zstd-simd.wasm']
assert len(product_files)==len(set(product_files))
run(['git','add','--',*product_files],candidate)
run(['git','-c','core.hooksPath=/dev/null','-c','user.name=Manabitan contributors','-c','user.email=contributors@manabi.io','commit','-m','Isolated compiled-dictionary candidate'],candidate)
(out/'candidate.patch').write_text(run(['git','diff',BASE,'HEAD'],candidate)+'\n')

# Build both packages at the exact same filesystem path to keep source maps and ZIP metadata comparable.
logrun(['npm','run','build:libs'],'base-libs.log')
logrun(['node','dev/bin/build.js','--target','chrome-dev'],'base-package.log')
base_package=(root/package).read_bytes(); base_ext=Path(os.environ['RUNNER_TEMP'])/'base-ext-lib'; shutil.copytree(root/'ext/lib',base_ext)
saved={p:(root/p).read_bytes() for p in product_files if (root/p).exists()}
created=[p for p in product_files if not (root/p).exists()]
try:
    for p in product_files:
        src=candidate/p; dst=root/p; dst.parent.mkdir(parents=True,exist_ok=True); dst.write_bytes(src.read_bytes())
    logrun(['npm','run','build:libs'],'candidate-libs.log')
    logrun(['node','dev/bin/build.js','--target','chrome-dev'],'candidate-package.log')
    (candidate/package).parent.mkdir(parents=True,exist_ok=True); shutil.copy(root/package,candidate/package)
    shutil.copytree(root/'ext/lib',candidate/'ext/lib',dirs_exist_ok=True)
finally:
    for p,data in saved.items(): (root/p).write_bytes(data)
    for p in created:
        target=root/p
        if target.exists(): target.unlink()
    (root/package).write_bytes(base_package); shutil.copytree(base_ext,root/'ext/lib',dirs_exist_ok=True)

with zipfile.ZipFile(root/package) as a, zipfile.ZipFile(candidate/package) as b:
    assert a.namelist()==b.namelist()
    changed={n for n in a.namelist() if a.read(n)!=b.read(n)}
    # Product package changes must stay confined to Zstd/term-content implementation assets.
    assert changed and all(('zstd' in n.lower()) or ('term-content' in n.lower()) for n in changed), changed
(out/'member-changes.json').write_text(json.dumps(sorted(changed),indent=2))

# Existing mock tests plus all type projects catch wrapper/API integration before expensive browser runs.
logrun(['node','node_modules/vitest/vitest.mjs','run','test/zstd-wasm.test.js','test/term-content-block-store.test.js'],'focused.log',candidate)
logrun(['npm','run','test:ts'],'types.log',candidate)

roots={'A':root,'B':candidate}
def identity(directory):
    return {'commit':run(['git','rev-parse','HEAD'],directory),'tree':run(['git','rev-parse','HEAD^{tree}'],directory),'status':run(['git','status','--porcelain'],directory),'package':sha(directory/package),'zstdWasm':sha(directory/'dev/data/zstd-simd.wasm'),'fixtureLock':sha(directory/'test/perf/dictionaries.lock.json'),'harness':sha(directory/'test/chromium/extension-two-dictionary-import.e2e.js')}
identities={arm:identity(d) for arm,d in roots.items()}; assert all(not x['status'] for x in identities.values())
(out/'identities.json').write_text(json.dumps(identities,indent=2)); (out/'sizes.json').write_text(json.dumps({a:{'package':(d/package).stat().st_size,'zstdWasm':(d/'dev/data/zstd-simd.wasm').stat().st_size} for a,d in roots.items()},indent=2))
plan=[{'kind':'warmup','pair':0,'arm':arm,'binary':arm} for arm in order]
for pair in range(1,pairs+1):
    plan += [{'kind':'measured','pair':pair,'arm':arm,'binary':arm} for arm in (order if pair%2 else order[::-1])]
    if pair%2==0: plan += [{'kind':'aa','pair':pair//2,'arm':arm,'binary':'A'} for arm in ('AB' if pair%4 else 'BA')]
(out/'plan.json').write_text(json.dumps({'baseline':BASE,'candidate':variant,'dictionary':dictionary,'plan':plan,'identities':identities,'retries':0,'outlierRemoval':False},indent=2))
obs=[]
for ordinal,item in enumerate(plan,1):
    directory=roots[item['binary']]; assert identity(directory)==identities[item['binary']]
    dest=out/f"{ordinal:02}-{item['kind']}-{item['pair']}-{item['arm']}"; started=time.monotonic()
    logrun(['node','dev/perf/import-benchmark.js',dictionary,'--runs','1','--no-build','--flags','{}','--output',str(dest)],dest.name+'.log',directory,300)
    summary=json.loads((dest/'summary.json').read_text()); report=json.loads((dest/'run-1.json').read_text())
    assert report['status']=='success' and report['skippedVerification'] is False
    assert summary['source']['dirty'] is False and summary['source']['sha256']['builds/manabitan-chrome-dev.zip']==identities[item['binary']]['package']
    m=summary['runs'][0]; receipts=[]
    for phase in m['importDebug']['importerPhaseTimings']:
        for key in ('parserExperiments','fastPathParserEffectiveExperiments'):
            if key in (phase.get('details') or {}):
                r=phase['details'][key]; assert len(r)==10 and all(v is False for v in r.values()); receipts.append(r)
    assert receipts
    obs.append({**item,'ordinal':ordinal,'ms':m['totalImportMs'],'workerMs':m['workerImportMs'],'validation':m['validation'],'browser':summary['browserVersion'],'wallSeconds':time.monotonic()-started})
    (out/'observations.json').write_text(json.dumps(obs,indent=2)); print(json.dumps(obs[-1]),flush=True)
for arm,d in roots.items(): assert identity(d)==identities[arm]
(out/'complete.json').write_text(json.dumps({'completed':len(obs),'planned':len(plan)}))
