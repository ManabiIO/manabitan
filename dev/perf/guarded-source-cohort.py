#!/usr/bin/env python3
"""Additional source controls. Separate from independent twelve-pair confirmations."""
import argparse, hashlib, json, shutil, statistics, subprocess, traceback, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE='54ac62a39386459b7822fc644e5a1a6b1a619619'
FLAG='experimentalValidatedGlossaryReuse'
FILES=['ext/js/dictionary/term-bank-experiments.js','ext/js/dictionary/wasm/term-bank-parser.c']
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def load(p): return json.loads(Path(p).read_text())
def run(args,log,timeout=300):
    with Path(log).open('w') as f: subprocess.run(args,cwd=ROOT,stdout=f,stderr=subprocess.STDOUT,timeout=timeout,check=True)
def main():
    p=argparse.ArgumentParser();p.add_argument('--dictionary',required=True,choices=['jitendex','jmdict']);p.add_argument('--out',required=True);args=p.parse_args()
    out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=False)
    shutil.copyfile(__file__,out/'driver.py')
    subprocess.run(['git','fetch','--depth=1','origin',BASE],cwd=ROOT,check=True)
    sources={'candidate':{f:(ROOT/f).read_bytes() for f in FILES},'parent':{f:subprocess.check_output(['git','show',BASE+':'+f],cwd=ROOT) for f in FILES}}
    def configure(arm):
        for f,data in sources[arm].items(): (ROOT/f).write_bytes(data)
    identities={}
    for arm in ['parent','candidate']:
        configure(arm);run(['node','dev/bin/build-libs.js'],out/(arm+'-libs.log'))
        run(['node','dev/bin/build.js','chrome-dev'],out/(arm+'-build.log'))
        for src,name in [('builds/manabitan-chrome-dev.zip',arm+'.zip'),('ext/lib/term-bank-parser.wasm',arm+'.wasm')]:shutil.copyfile(ROOT/src,out/name)
        identities[arm]={'packageSha256':sha(out/(arm+'.zip')),'packageBytes':(out/(arm+'.zip')).stat().st_size,'wasmSha256':sha(out/(arm+'.wasm')),'wasmBytes':(out/(arm+'.wasm')).stat().st_size,'sources':{f:sha(ROOT/f) for f in FILES}}
    with zipfile.ZipFile(out/'parent.zip') as a,zipfile.ZipFile(out/'candidate.zip') as b:
        assert set(a.namelist())==set(b.namelist())
        changed=[n for n in a.namelist() if a.read(n)!=b.read(n)]
        assert set(changed)=={'lib/term-bank-parser.wasm','js/dictionary/term-bank-experiments.js'},changed
    (out/'identities.json').write_text(json.dumps({'base':BASE,'packages':identities,'changedMembers':changed},indent=2))
    comparisons={'defaults':({},{}),'source-off':({FLAG:False},{FLAG:False}),'old-enabled':({FLAG:True},{})}
    plan=[]
    for label,(af,bf) in comparisons.items():
        for arm in ['parent','candidate']:
            plan.append({'comparison':label,'role':'warmup','block':-1,'source':arm,'flags':af if arm=='parent' else bf})
        for block in range(2):
            for role in (['candidate','control'] if block==0 else ['control','candidate']):
                for arm in ['parent','candidate','candidate','parent']:
                    source=arm if role=='candidate' else 'parent'
                    plan.append({'comparison':label,'role':role,'block':block,'source':source,'flags':af if source=='parent' else bf})
    (out/'plan.json').write_text(json.dumps(plan,indent=2));obs=[]
    try:
        for i,spec in enumerate(plan):
            arm=spec['source']; configure(arm)
            shutil.copyfile(out/(arm+'.zip'),ROOT/'builds/manabitan-chrome-dev.zip');shutil.copyfile(out/(arm+'.wasm'),ROOT/'ext/lib/term-bank-parser.wasm')
            assert sha(ROOT/'builds/manabitan-chrome-dev.zip')==identities[arm]['packageSha256']
            assert all(sha(ROOT/f)==h for f,h in identities[arm]['sources'].items())
            dest=out/f'{i:03}-{spec["comparison"]}-{spec["role"]}-{arm}'
            run(['node','dev/perf/import-benchmark.js',args.dictionary,'--runs','1','--no-build','--flags',json.dumps(spec['flags']),'--output',str(dest)],out/f'{i:03}.log')
            r=load(dest/'run-1.json');s=load(dest/'summary.json')
            assert r['status']=='success' and r['skippedVerification'] is False and s['authoritativeTiming']
            assert r['benchmark']['importFlags']==spec['flags']
            phases=[p['data'] for p in r['phases'] if isinstance(p.get('data'),dict) and p['data'].get('kind')=='dictionary-import'];assert len(phases)==1
            d=phases[0]['importDebug'];assert d['hasResult'] and not d['usesFallbackStorage'] and d['errorCount']==0
            fast=[p['details'] for p in d['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
            effective=spec['flags'].get(FLAG,arm=='candidate')
            assert fast and all(x['parserExperiments'][FLAG]==effective for x in fast)
            row={**spec,'index':i,'ms':s['runs'][0]['totalImportMs'],'report':str((dest/'run-1.json').relative_to(out)),'reportSha256':sha(dest/'run-1.json'),'packageSha256':identities[arm]['packageSha256']}
            obs.append(row);(out/'observations.json').write_text(json.dumps(obs,indent=2));print(json.dumps(row),flush=True)
        result={}
        for label in comparisons:
            result[label]={}
            for role in ['candidate','control']:
                rows=[x for x in obs if x['comparison']==label and x['role']==role];pairs=[];blocks=[]
                for i in range(0,len(rows),4):
                    a,b,c,d=[x['ms'] for x in rows[i:i+4]];pairs.extend([100*(b/a-1),100*(c/d-1)]);blocks.append(100*((b+c)/(a+d)-1))
                result[label][role]={'pairs':pairs,'median':statistics.median(pairs),'medianAbsolute':statistics.median(map(abs,pairs)),'blockTotals':blocks}
        (out/'results.json').write_text(json.dumps({'complete':True,'dictionary':args.dictionary,'observations':len(obs),'results':result},indent=2))
    except Exception:
        (out/'failure.txt').write_text(traceback.format_exc());raise
    finally:
        configure('candidate')
        shutil.copyfile(out/'candidate.wasm',ROOT/'ext/lib/term-bank-parser.wasm')
        shutil.copyfile(out/'candidate.zip',ROOT/'builds/manabitan-chrome-dev.zip')
if __name__=='__main__':main()
