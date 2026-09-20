#!/usr/bin/env python3
"""Exact-source complete original-import comparisons; no retries or discarded runs."""
import argparse,hashlib,json,shutil,statistics,subprocess,traceback,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE='54ac62a39386459b7822fc644e5a1a6b1a619619'
FILES=['ext/js/dictionary/zstd-term-content.js','ext/js/dictionary/zstd-term-content-compression-worker.js']
HASHES=['053785e88133bf465a120e11d5bcfefbdb7cb4c8930e1ff21070a61f93d56eea','5b768f84ec934f50e20b55fa640c17b90bf3d1d4cfdfd1d9586ac2ed7ad52904']
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(args,log,timeout=300):
    with Path(log).open('w') as f:subprocess.run(args,cwd=ROOT,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=timeout)
def main():
    p=argparse.ArgumentParser();p.add_argument('--dictionary',choices=['jmdict','jitendex'],required=True);p.add_argument('--out',required=True);p.add_argument('--blocks',type=int,default=2);a=p.parse_args();assert 2<=a.blocks<=8
    out=Path(a.out).resolve();out.mkdir(parents=True,exist_ok=False);shutil.copyfile(__file__,out/'driver.py')
    subprocess.run(['git','fetch','--depth=1','origin',BASE],cwd=ROOT,check=True)
    baseline={f:subprocess.check_output(['git','show',BASE+':'+f],cwd=ROOT) for f in FILES}
    for f,b in baseline.items():(ROOT/f).write_bytes(b)
    patch=(ROOT/'dev/perf/jj-compression-batch.patch').read_text().replace('\n diff --git','\ndiff --git')
    subprocess.run(['git','apply','--recount','-'],input=patch.encode(),cwd=ROOT,check=True)
    assert [sha(ROOT/f) for f in FILES]==HASHES
    candidate={f:(ROOT/f).read_bytes() for f in FILES}
    (out/'candidate.patch').write_text(patch)
    identity={'base':BASE,'node':subprocess.check_output(['node','--version']).decode().strip(),'wasmSha256':sha(ROOT/'ext/lib/term-bank-parser.wasm'),'packages':{},'lockSha256':sha(ROOT/'test/perf/dictionaries.lock.json')}
    for arm,source in [('baseline',baseline),('candidate',candidate)]:
        for f,b in source.items():(ROOT/f).write_bytes(b)
        run(['node','dev/bin/build.js','chrome-dev'],out/(arm+'-build.log'))
        target=out/(arm+'.zip');shutil.copyfile(ROOT/'builds/manabitan-chrome-dev.zip',target)
        identity['packages'][arm]={'sha256':sha(target),'bytes':target.stat().st_size,'sources':{f:sha(ROOT/f) for f in FILES}}
    with zipfile.ZipFile(out/'baseline.zip') as x,zipfile.ZipFile(out/'candidate.zip') as y:
        assert set(x.namelist())==set(y.namelist())
        changes=[n for n in x.namelist() if x.read(n)!=y.read(n)];assert set(changes)=={f[4:] for f in FILES},changes
        identity['changedMembers']=changes
    (out/'identities.json').write_text(json.dumps(identity,indent=2))
    plan=[dict(role='warmup',arm=arm,block=-1) for arm in ['baseline','candidate']]
    for block in range(a.blocks):
        for role in (['candidate','control'] if block%2==0 else ['control','candidate']):
            for arm in ['baseline','candidate','candidate','baseline']:plan.append(dict(role=role,arm=arm if role=='candidate' else 'baseline',block=block))
    (out/'plan.json').write_text(json.dumps(plan,indent=2));observations=[]
    try:
        for index,spec in enumerate(plan):
            arm=spec['arm'];source=baseline if arm=='baseline' else candidate
            for f,b in source.items():(ROOT/f).write_bytes(b)
            assert sha(ROOT/'test/perf/dictionaries.lock.json')==identity['lockSha256']
            assert sha(ROOT/'ext/lib/term-bank-parser.wasm')==identity['wasmSha256']
            archive=out/(arm+'.zip');assert sha(archive)==identity['packages'][arm]['sha256'];shutil.copyfile(archive,ROOT/'builds/manabitan-chrome-dev.zip')
            dest=out/f'{index:03}-{spec["role"]}-{arm}'
            run(['node','dev/perf/import-benchmark.js',a.dictionary,'--runs','1','--no-build','--flags','{}','--output',str(dest)],out/f'{index:03}.log')
            summary=json.loads((dest/'summary.json').read_text());report=json.loads((dest/'run-1.json').read_text())
            assert summary['authoritativeTiming'] and len(summary['runs'])==1
            assert report['status']=='success' and report['skippedVerification'] is False
            ms=summary['runs'][0]['totalImportMs'];assert 0<ms<180000
            phases=[p for p in report['phases'] if isinstance(p.get('data'),dict) and p['data'].get('kind')=='dictionary-import'];assert len(phases)==1
            d=phases[0]['data']['importDebug'];assert d['errorCount']==0 and not d['usesFallbackStorage'] and d['openStorageDiagnostics']['mode']=='opfs-sahpool'
            fast=[p['details'] for p in d['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')];assert fast
            assert all(p['parserExperiments']['experimentalNativeSegmentedLookup'] and p['parserExperiments']['experimentalLookupScratchReuse'] for p in fast)
            row={**spec,'index':index,'ms':ms,'packageSha256':sha(archive),'reportSha256':sha(dest/'run-1.json'),'report':str((dest/'run-1.json').relative_to(out))}
            observations.append(row);(out/'observations.json').write_text(json.dumps(observations,indent=2));print(json.dumps(row),flush=True)
        result={}
        for role in ['candidate','control']:
            rows=[r for r in observations if r['role']==role];pairs=[];totals=[]
            for i in range(0,len(rows),4):
                x,y,z,w=[r['ms'] for r in rows[i:i+4]];pairs.extend([100*(y/x-1),100*(z/w-1)]);totals.append(100*((y+z)/(x+w)-1))
            result[role]={'pairs':pairs,'median':statistics.median(pairs),'medianAbsolute':statistics.median(map(abs,pairs)),'fasterPairs':sum(p<0 for p in pairs),'blockTotals':totals,'equalWorkPercent':100*(sum(r['ms'] for i,r in enumerate(rows) if i%4 in (1,2))/sum(r['ms'] for i,r in enumerate(rows) if i%4 in (0,3))-1)}
        (out/'results.json').write_text(json.dumps(dict(complete=True,dictionary=a.dictionary,observations=len(observations),results=result),indent=2));print(json.dumps(result),flush=True)
    except Exception:
        (out/'failure.txt').write_text(traceback.format_exc());raise
    finally:
        for f,b in candidate.items():(ROOT/f).write_bytes(b)
        shutil.copyfile(out/'candidate.zip',ROOT/'builds/manabitan-chrome-dev.zip')
if __name__=='__main__':main()
