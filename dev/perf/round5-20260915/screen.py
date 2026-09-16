#!/usr/bin/env python3
"""Source-isolated whole-import discovery; all warmups and failures retained."""
from pathlib import Path
import hashlib, json, os, shutil, signal, subprocess, time, zipfile
BASE = 'b4094a423c20bb0ed424d944238f922c1b36559c'
ROOT = Path.cwd()
REVIEW = Path(__file__).parent
OUT = ROOT / 'builds/round5'
OUT.mkdir(parents=True, exist_ok=True)
variant = os.environ['CANDIDATE']
dictionary = os.environ['DICTIONARY']
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
assert variant in ('media-local', 'media-streams', 'cdict', 'exports-control')
assert dictionary in ('jmdict', 'jitendex') and 2 <= pairs <= 24 and order in ('AB','BA')
PACKAGE = Path('builds/manabitan-chrome-dev.zip')

def run(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def sha(path):
    with open(path, 'rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()

def apply(directory, name):
    patch = REVIEW / (name + '.patch')
    run(['git','apply','--check',str(patch)], directory)
    run(['git','apply',str(patch)], directory)

assert run(['git','rev-parse','HEAD']) == BASE
candidate = Path(os.environ['RUNNER_TEMP']) / 'round5-candidate'
run(['git','worktree','add','--detach',str(candidate),BASE])
(candidate/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
with (ROOT/'.git/info/exclude').open('a') as f: f.write('\n/node_modules\n')
shutil.copytree(ROOT/'ext/lib',candidate/'ext/lib',dirs_exist_ok=True)
(candidate/'builds').mkdir(exist_ok=True)
(candidate/'builds/e2e-dictionary-cache').symlink_to(ROOT/'builds/e2e-dictionary-cache',target_is_directory=True)
if variant.startswith('media-'):
    patch = (REVIEW/'media-local.patch').read_text()
    if variant == 'media-streams':
        assert patch.count('boundedMedia ? {useWebWorkers: false}') == 1
        patch = patch.replace('boundedMedia ? {useWebWorkers: false}', 'boundedMedia ? {transferStreams: false}')
    (OUT/'candidate.patch').write_text(patch)
    run(['git','apply','--check',str(OUT/'candidate.patch')], candidate)
    run(['git','apply',str(OUT/'candidate.patch')], candidate)
    changed = ['ext/js/dictionary/dictionary-importer.js']
    expected = {'media-local':'0a2d8909e9156282b0937fe4c6484db4eec019b2618fc9dd8557f04f7dbff305',
                'media-streams':'8d02a50a6656556fc222fa3a63dca314e7b7527540376fa19b5a5e5022a2a9cd'}
    assert sha(candidate/changed[0]) == expected[variant]
    replacements = {'js/dictionary/dictionary-importer.js'}
else:
    apply(candidate,'native-exports')
    assets = Path(os.environ['RUNNER_TEMP'])/'native-assets'
    for name in ['dev/data/zstd-simd.wasm','dev/lib/zstd-simd-module.js']:
        shutil.copy(assets/name,candidate/name)
    changed = ['dev/bin/build-zstd-wasm.js','dev/lib/zstd-simd-module.d.ts',
               'dev/data/zstd-simd.wasm','dev/lib/zstd-simd-module.js']
    if variant == 'cdict':
        apply(candidate,'cdict')
        changed.append('dev/lib/zstd-wasm.js')
        assert sha(candidate/changed[-1]) == '00bac519e2e2b8d3b1eb847549bc2a9cc46ee8d352ff2f9a3e9125ff01c72e77'
    with (OUT/'build-libs.log').open('w') as log:
        subprocess.run(['npm','run','build:libs'],cwd=candidate,stdout=log,stderr=subprocess.STDOUT,check=True)
    replacements = {'lib/zstd-wasm.js','lib/zstd.wasm'}
    for arm, directory in [('A',ROOT),('B',candidate)]:
        test = directory/'dev/perf/round5-20260915/zstd-conformance.test.js'
        test.parent.mkdir(exist_ok=True)
        shutil.copy(REVIEW/'zstd-conformance.test.js',test)
        try:
            with (OUT/f'conformance-{arm}.log').open('w') as log:
                subprocess.run(['node','node_modules/vitest/vitest.mjs','run',str(test.relative_to(directory))],cwd=directory,
                    stdout=log,stderr=subprocess.STDOUT,timeout=180,check=True)
        finally: test.unlink(); test.parent.rmdir()
    shutil.copy(assets/'toolchain.txt',OUT/'native-toolchain.txt')
    shutil.copy(assets/'stock-rebuild.json',OUT/'stock-rebuild.json')
run(['git','add',*changed],candidate)
run(['git','-c','core.hooksPath=/dev/null','-c','user.name=Manabitan contributors','-c',
     'user.email=contributors@manabi.io','commit','-m',f'Round five isolated candidate: {variant}'],candidate)
(OUT/'source.patch').write_text(run(['git','diff',BASE,'HEAD','--',*changed],candidate)+'\n')
if variant.startswith('media-'):
    with (OUT/'focused.log').open('w') as log:
        subprocess.run(['node','node_modules/vitest/vitest.mjs','run','test/dictionary-importer-media-loader.test.js',
            'test/dictionary-importer-artifact.test.js','test/dictionary-importer-zip-filename-alias.test.js'],cwd=candidate,
            stdout=log,stderr=subprocess.STDOUT,timeout=180,check=True)
with zipfile.ZipFile(ROOT/PACKAGE) as a, zipfile.ZipFile(candidate/PACKAGE,'w') as b:
    for item in a.infolist():
        b.writestr(item,(candidate/'ext'/item.filename).read_bytes() if item.filename in replacements else a.read(item.filename))
with zipfile.ZipFile(ROOT/PACKAGE) as a, zipfile.ZipFile(candidate/PACKAGE) as b:
    assert a.namelist()==b.namelist()
    actual = {n for n in a.namelist() if a.read(n)!=b.read(n)}
    assert actual <= replacements and actual, actual
shutil.copy(__file__,OUT/'driver.py')
roots={'A':ROOT,'B':candidate}

def identity(directory):
    return {'commit':run(['git','rev-parse','HEAD'],directory),'tree':run(['git','rev-parse','HEAD^{tree}'],directory),
        'status':run(['git','status','--porcelain'],directory),
        'hashes':{p:sha(directory/p) for p in [str(PACKAGE),'test/perf/dictionaries.lock.json',
             'test/chromium/extension-two-dictionary-import.e2e.js','ext/lib/term-bank-parser.wasm',*changed]}}
identities={arm:identity(directory) for arm,directory in roots.items()}
assert all(not x['status'] for x in identities.values()),identities
plan=[{'kind':'warmup','pair':0,'arm':arm,'binary':arm} for arm in order]
for pair in range(1,pairs+1):
    plan.extend({'kind':'measured','pair':pair,'arm':arm,'binary':arm} for arm in (order if pair%2 else order[::-1]))
    if pair%2==0:
        plan.extend({'kind':'aa','pair':pair//2,'arm':arm,'binary':'A'} for arm in ('AB' if pair%4 else 'BA'))
(OUT/'plan.json').write_text(json.dumps({'baseline':BASE,'candidate':variant,'dictionary':dictionary,'plan':plan,
    'identities':identities,'flags':{},'node':run(['node','--version']),'compiler':run(['clang','--version']),
    'noRetries':True,'noOutlierRemoval':True,'changedPackageMembers':sorted(actual)},indent=2))
observations=[]
for ordinal,item in enumerate(plan,1):
    directory=roots[item['binary']]
    assert identity(directory)==identities[item['binary']]
    destination=OUT/f"{ordinal:02}-{item['kind']}-{item['pair']}-{item['arm']}"
    started=time.monotonic()
    with Path(str(destination)+'.log').open('w') as log:
        p=subprocess.Popen(['node','dev/perf/import-benchmark.js',dictionary,'--runs','1','--no-build','--flags','{}',
            '--output',str(destination)],cwd=directory,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try: status=p.wait(timeout=240)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL); p.wait(); raise
    assert status==0,f'Failed observation {ordinal}; retained, not retried'
    summary=json.loads((destination/'summary.json').read_text())
    raw=json.loads((destination/'run-1.json').read_text())
    assert raw['status']=='success' and raw['skippedVerification'] is False
    assert summary['source']['dirty'] is False
    assert summary['source']['sha256'][str(PACKAGE)]==identities[item['binary']]['hashes'][str(PACKAGE)]
    measurement=summary['runs'][0]
    receipts=[]
    for phase in measurement['importDebug']['importerPhaseTimings']:
        for key in ('parserExperiments','fastPathParserEffectiveExperiments'):
            details=phase.get('details') or {}
            if key in details:
                r=details[key]; assert isinstance(r,dict) and len(r)==10 and all(x is False for x in r.values())
                receipts.append(r)
    assert receipts
    observations.append({**item,'ordinal':ordinal,'ms':measurement['totalImportMs'],'workerMs':measurement['workerImportMs'],
        'validation':measurement['validation'],'browser':summary['browserVersion'],'wallSeconds':time.monotonic()-started})
    (OUT/'observations.json').write_text(json.dumps(observations,indent=2))
    print(json.dumps(observations[-1]),flush=True)
for arm,directory in roots.items(): assert identity(directory)==identities[arm]
(OUT/'complete.json').write_text(json.dumps({'completed':len(observations),'planned':len(plan)}))
