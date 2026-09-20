#!/usr/bin/env python3
"""Research only: fixed complete-import ABBA/BAAB cohorts and interleaved A/A."""
import argparse, hashlib, json, math, os, shutil, statistics, subprocess, traceback
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
FLAG = 'experimentalValidatedGlossaryReuse'

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def load(p): return json.loads(Path(p).read_text())
def run(args, log):
    with Path(log).open('w') as f:
        subprocess.run(args, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, check=True, timeout=180)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--dictionary', required=True, choices=['jmdict','jitendex'])
    parser.add_argument('--out', required=True)
    parser.add_argument('--blocks', type=int, default=6)
    parser.add_argument('--initial-order', choices=['AB','BA'], default='AB')
    args=parser.parse_args(); assert 2 <= args.blocks <= 8
    out=Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(__file__, out/'driver.py')
    package=ROOT/'builds/manabitan-chrome-dev.zip'
    run(['node','dev/bin/build.js','chrome-dev'], out/'build.log')
    identity={'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip(),
              'node':subprocess.check_output(['node','--version']).decode().strip(),
              'wasmSha256':sha(ROOT/'ext/lib/term-bank-parser.wasm'), 'packageSha256':sha(package),
              'sources':{p:sha(ROOT/p) for p in ['ext/js/dictionary/term-bank-experiments.js','ext/js/dictionary/wasm/term-bank-parser.c']},
              'lockSha256':sha(ROOT/'test/perf/dictionaries.lock.json')}
    (out/'identities.json').write_text(json.dumps(identity,indent=2))
    fixture=load(ROOT/'test/perf/dictionaries.lock.json')['dictionaries'][args.dictionary]
    (out/'fixture.json').write_text(json.dumps(fixture,indent=2))
    orders=['A','B','B','A'] if args.initial_order=='AB' else ['B','A','A','B']
    plan=[{'role':'warmup','arm':a,'block':-1} for a in orders]
    for block in range(args.blocks):
        for role in (['candidate','control'] if block%2==0 else ['control','candidate']):
            for a in orders:
                plan.append({'role':role,'arm':a if role=='candidate' else 'A','block':block})
    (out/'plan.json').write_text(json.dumps(plan,indent=2)); observations=[]
    try:
        for index,spec in enumerate(plan):
            enabled=spec['arm']=='B'; flags={FLAG:enabled}
            assert sha(package)==identity['packageSha256']
            dest=out/f'{index:03}-{spec["role"]}-{spec["arm"]}'
            run(['node','dev/perf/import-benchmark.js',args.dictionary,'--runs','1','--no-build',
                 '--flags',json.dumps(flags),'--output',str(dest)],out/f'{index:03}.log')
            summary=load(dest/'summary.json'); report=load(dest/'run-1.json')
            assert report['status']=='success' and report['skippedVerification'] is False
            assert summary['authoritativeTiming'] and len(summary['runs'])==1
            bench=report['benchmark']; assert bench['productionImportDefaults'] and bench['importFlags']==flags
            assert not any(bench[k] for k in ['traceEnabled','phaseProfiling','phaseScreenshots','processSampling'])
            v=bench['validation']
            assert v['title']==fixture['expectedTitle'] and v['revision']==fixture['revision']
            assert v['termRows']==fixture['termRows'] and v['contentReadable'] and v['probeCount']==12
            phases=[p for p in report['phases'] if isinstance(p.get('data'),dict) and p['data'].get('kind')=='dictionary-import']
            assert len(phases)==1
            data=phases[0]['data']; d=data['importDebug']; t=data['browserTiming']
            ms=summary['runs'][0]['totalImportMs']; assert math.isfinite(ms) and ms>0
            assert abs(t['completedAtMs']-t['startedAtMs']-ms)<0.00001
            assert t['errorCount']==0 and t['sequence']>t['sequenceBefore'] and t['trigger']=='file-input-change'
            assert d['hasResult'] and d['errorCount']==0 and d['addSettingsErrorCount']==0 and not d['usesFallbackStorage']
            assert d['openStorageDiagnostics']['mode']=='opfs-sahpool'
            fast=[p['details'] for p in d['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
            assert fast and sum(p['rows'] for p in fast)==fixture['termRows']
            assert all(p['parserExperiments'][FLAG] is enabled for p in fast)
            reuse=sum(p['parserValidatedGlossaryReuseCount'] for p in fast)
            assert (reuse>0)==enabled
            row={**spec,'index':index,'ms':ms,'reuseCount':reuse,'report':str((dest/'run-1.json').relative_to(out)),
                 'reportSha256':sha(dest/'run-1.json'),'packageSha256':identity['packageSha256']}
            observations.append(row); (out/'observations.json').write_text(json.dumps(observations,indent=2)); print(json.dumps(row),flush=True)
        result={'complete':True,'dictionary':args.dictionary,'initialOrder':args.initial_order,'observations':len(observations)}
        for role in ['candidate','control']:
            rows=[r for r in observations if r['role']==role]; pairs=[]; blocks=[]
            for i in range(0,len(rows),4):
                vals=[r['ms'] for r in rows[i:i+4]]
                a,b,c,d=vals if args.initial_order=='AB' else vals[::-1]
                if args.initial_order=='BA': a,b,c,d=b,a,d,c
                pairs.extend([100*(b/a-1),100*(c/d-1)])
                blocks.append(100*((b+c)/(a+d)-1))
            result[role]={'pairedPercent':pairs,'medianPairedPercent':statistics.median(pairs),
                          'medianAbsolutePercent':statistics.median(map(abs,pairs)),
                          'fasterPairs':sum(p<0 for p in pairs),'blockTotalsPercent':blocks}
        (out/'results.json').write_text(json.dumps(result,indent=2)); print(json.dumps(result,indent=2),flush=True)
    except Exception:
        (out/'failure.txt').write_text(traceback.format_exc()); raise

if __name__=='__main__': main()
