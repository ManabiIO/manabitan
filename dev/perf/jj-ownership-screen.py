#!/usr/bin/env python3
"""Fixed-plan research; source, originals, controls, and every observation retained."""
import argparse, hashlib, json, os, shutil, statistics, subprocess, traceback, zipfile
from pathlib import Path
BASE='54ac62a39386459b7822fc644e5a1a6b1a619619'
ROOT=Path(__file__).resolve().parents[2]
BUILD='dev/build-libs.js'
WORKER='ext/js/dictionary/term-bank-wasm-parser-worker.js'

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(args, log, timeout=300):
    with Path(log).open('w') as f: subprocess.run(args,cwd=ROOT,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=timeout)
def original(p): return subprocess.check_output(['git','show',BASE+':'+p],cwd=ROOT).decode()
def configure(variant):
    build=original(BUILD); worker=original(WORKER)
    if variant!='baseline':
        a,b=build.split('async function buildDictionaryWasm(out)',1)
        old="            '-Wl,--shared-memory',\n"; assert b.count(old)==1
        build=a+'async function buildDictionaryWasm(out)'+b.replace(old,'')
    if variant=='private-owned':
        old='resultChunk = copyWasmBackedColumnChunk(chunk, true);'; assert worker.count(old)==1
        worker=worker.replace(old,'resultChunk = copyWasmBackedColumnChunk(chunk);')
    assert variant in ('baseline','private-shared','private-owned')
    (ROOT/BUILD).write_text(build);(ROOT/WORKER).write_text(worker)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--dictionary',choices=['jmdict','jitendex'],required=True);parser.add_argument('--out',required=True);parser.add_argument('--blocks',type=int,default=2);parser.add_argument('--variant',default='private-shared,private-owned');args=parser.parse_args()
    assert 2<=args.blocks<=8
    out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=False)
    variants=args.variant.split(',');assert set(variants)<={'private-shared','private-owned'}
    subprocess.run(['git','fetch','--depth=1','origin',BASE],cwd=ROOT,check=True)
    shutil.copyfile(__file__,out/'driver.py')
    identity={'base':BASE,'node':subprocess.check_output(['node','--version']).decode().strip(),'packages':{},'lock':sha(ROOT/'test/perf/dictionaries.lock.json')}
    for variant in ['baseline']+variants:
        configure(variant)
        run(['node','dev/bin/build-libs.js'],out/(variant+'-libs.log'))
        run(['node','dev/bin/build.js','chrome-dev'],out/(variant+'-build.log'))
        archive=out/(variant+'.zip');shutil.copyfile(ROOT/'builds/manabitan-chrome-dev.zip',archive)
        shutil.copyfile(ROOT/'ext/lib/term-bank-parser.wasm',out/(variant+'.wasm'))
        (out/(variant+'.patch')).write_bytes(subprocess.check_output(['git','diff',BASE,'--',BUILD,WORKER],cwd=ROOT))
        identity['packages'][variant]={'sha256':sha(archive),'bytes':archive.stat().st_size,'wasm':sha(out/(variant+'.wasm')),'sources':{p:sha(ROOT/p) for p in [BUILD,WORKER]}}
        if variant!='baseline':
            with zipfile.ZipFile(out/'baseline.zip') as a,zipfile.ZipFile(archive) as b:
                assert set(a.namelist())==set(b.namelist())
                changes=[n for n in a.namelist() if a.read(n)!=b.read(n)]
                assert set(changes)<={'lib/term-bank-parser.wasm','js/dictionary/term-bank-wasm-parser-worker.js'},changes
                assert 'lib/term-bank-parser.wasm' in changes
                identity['packages'][variant]['changedMembers']=changes
    (out/'identities.json').write_text(json.dumps(identity,indent=2))
    plan=[]
    for candidate in variants:
        for variant in ['baseline',candidate]:plan.append(dict(role='warmup',candidate=candidate,variant=variant,block=-1))
        for block in range(args.blocks):
            for role in (['candidate','control'] if block%2==0 else ['control','candidate']):
                for v in ['baseline',candidate,candidate,'baseline']:plan.append(dict(role=role,candidate=candidate,variant=v if role=='candidate' else 'baseline',block=block))
    (out/'plan.json').write_text(json.dumps(plan,indent=2));observations=[]
    try:
        for index,spec in enumerate(plan):
            variant=spec['variant'];configure(variant)
            archive=out/(variant+'.zip')
            assert sha(archive)==identity['packages'][variant]['sha256']
            shutil.copyfile(archive,ROOT/'builds/manabitan-chrome-dev.zip')
            shutil.copyfile(out/(variant+'.wasm'),ROOT/'ext/lib/term-bank-parser.wasm')
            dest=out/f'{index:03}-{spec["role"]}-{variant}'
            run(['node','dev/perf/import-benchmark.js',args.dictionary,'--runs','1','--no-build','--flags','{}','--output',str(dest)],out/f'{index:03}.log')
            report=json.loads((dest/'run-1.json').read_text());summary=json.loads((dest/'summary.json').read_text())
            assert report['status']=='success' and report['skippedVerification'] is False
            assert summary['authoritativeTiming'] and len(summary['runs'])==1
            ms=summary['runs'][0]['totalImportMs'];assert 0<ms<180000
            phases=[p for p in report['phases'] if isinstance(p.get('data'),dict) and p['data'].get('kind')=='dictionary-import'];assert len(phases)==1
            d=phases[0]['data']['importDebug'];assert d['errorCount']==0 and not d['usesFallbackStorage']
            fast=[p['details'] for p in d['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')];assert fast
            borrowed=sum(p['parserBorrowedContentResultCount'] for p in fast)
            assert (borrowed>0)==(variant=='baseline'), (variant,borrowed)
            row={**spec,'index':index,'ms':ms,'borrowedContentResults':borrowed,'report':str((dest/'run-1.json').relative_to(out)),'reportSha256':sha(dest/'run-1.json'),'packageSha256':sha(archive)}
            observations.append(row);(out/'observations.json').write_text(json.dumps(observations,indent=2));print(json.dumps(row),flush=True)
        result={}
        for v in variants:
            groups={}
            for role in ['candidate','control']:
                rows=[r for r in observations if r['candidate']==v and r['role']==role];pairs=[];totals=[]
                for i in range(0,len(rows),4):
                    a,b,c,d=[r['ms'] for r in rows[i:i+4]];pairs.extend([100*(b/a-1),100*(c/d-1)]);totals.append(100*((b+c)/(a+d)-1))
                groups[role]={'pairs':pairs,'median':statistics.median(pairs),'medianAbsolute':statistics.median(map(abs,pairs)),'faster':sum(p<0 for p in pairs),'blockTotals':totals}
            result[v]=groups
        (out/'results.json').write_text(json.dumps({'complete':True,'dictionary':args.dictionary,'observations':len(observations),'results':result},indent=2));print(json.dumps(result,indent=2),flush=True)
    except Exception:
        (out/'failure.txt').write_text(traceback.format_exc());raise
    finally:configure('baseline')
if __name__=='__main__':main()
