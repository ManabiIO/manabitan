"""Frozen source A/B; fixed plan, source accounting, no retries or dropped runs."""
import argparse, hashlib, json, math, os, statistics, subprocess, zipfile
from pathlib import Path

def read(p): return json.loads(Path(p).read_text())
def save(p,v): Path(p).write_text(json.dumps(v,indent=2)+'\n')
def git(p,*a): return subprocess.check_output(['git','-C',str(p),*a],text=True).strip()
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def stats(ps):
    c=[100*(b/a-1) for a,b in ps]
    return dict(pairsMs=ps,changesPercent=c,pairedMedianPercent=statistics.median(c),equalWorkPercent=100*(sum(b for a,b in ps)/sum(a for a,b in ps)-1),fasterPairs=sum(b<a for a,b in ps),worstPairPercent=max(c))
def audit(root,d,t):
    s=read(t/'summary.json');r=read(t/'run-1.json');b=r['benchmark'];run=s['runs'][0]
    assert r['status']=='success' and r['skippedVerification'] is False
    assert b['dictionary']==d and b['pinnedDictionaries'] and b['productionImportDefaults'] and b['authoritativeTiming'] and b['importFlags'] is None
    assert not any(b[k] for k in ('traceEnabled','phaseProfiling','phaseScreenshots','processSampling'))
    assert len(s['runs'])==1 and not s['source']['dirty']
    f=read(root/'test/perf/dictionaries.lock.json')['dictionaries'][d];v=run['validation'];db=run['importDebug']
    assert (v['title'],v['revision'],v['termRows'])==(f['expectedTitle'],f['revision'],f['termRows'])
    assert v['contentReadable'] and v['probeCount']>=12
    assert db['errorCount']==0 and db['addSettingsErrorCount']==0 and db['usesFallbackStorage'] is False
    ps=[p['details'] for p in db['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    with zipfile.ZipFile(root/'builds/e2e-dictionary-cache'/f['cacheFile']) as z:
        banks=[i for i in z.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')]
    assert sum(p['rows'] for p in ps)==f['termRows']
    assert sum(p['batchedFileCount'] for p in ps)==len(banks)
    assert sum(p['parserSourceUncompressedBytes'] for p in ps)==sum(i.file_size for i in banks)
    assert sum(p['parserSourceCompressedBytes'] for p in ps)==sum(i.compress_size for i in banks)
    ms=run['totalImportMs'];assert math.isfinite(ms) and ms>0
    return dict(ms=ms,validation=v,accounting={k:sum(p[k] for p in ps) for k in ('dedupPendingHitCount','dedupPersistedHitCount','dedupUniqueCount')},components={k:sum(p[k] for p in ps) for k in ('contentPackMs','contentAppendMs','dedupScanMs')},browserVersion=run['browserVersion'],source=s['source'])
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--baseline',required=True,type=Path);ap.add_argument('--candidate',required=True,type=Path);ap.add_argument('--output',required=True,type=Path);ap.add_argument('--pairs',type=int,default=6);ap.add_argument('--dictionaries',nargs='+',default=['jmnedict','jmdict','jitendex']);ap.add_argument('--reverse',action='store_true');a=ap.parse_args()
    roots={'A':a.baseline.resolve(),'B':a.candidate.resolve()};out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
    ids={arm:dict(commit=git(root,'rev-parse','HEAD'),tree=git(root,'rev-parse','HEAD^{tree}'),package=sha(root/'builds/manabitan-chrome-dev.zip')) for arm,root in roots.items()}
    for root in roots.values():assert not git(root,'status','--porcelain')
    with zipfile.ZipFile(roots['A']/'builds/manabitan-chrome-dev.zip') as x,zipfile.ZipFile(roots['B']/'builds/manabitan-chrome-dev.zip') as y:
        assert set(x.namelist())==set(y.namelist())
        changed=[n for n in x.namelist() if x.read(n)!=y.read(n)]
        assert changed==['js/dictionary/term-content-block-store.js'],changed
    for f in ('package-lock.json','test/perf/dictionaries.lock.json','test/chromium/extension-two-dictionary-import.e2e.js','dev/perf/import-benchmark.js','dev/perf/benchmark-support.js'):
        assert sha(roots['A']/f)==sha(roots['B']/f)
    save(out/'identity.json',ids);plan=[]
    def add(d,k,p,order):plan.extend(dict(dictionary=d,kind=k,pair=p,arm=arm) for arm in order)
    for d in a.dictionaries:add(d,'warmup',-1,'BA' if a.reverse else 'AB')
    for p in range(a.pairs):
        ds=a.dictionaries[p%len(a.dictionaries):]+a.dictionaries[:p%len(a.dictionaries)]
        for j,d in enumerate(ds):
            add(d,'AB',p,'AB' if (p+j+int(a.reverse))%2==0 else 'BA')
            if p in (1,a.pairs-2):add(d,'control',p,'AA' if p==1 else 'BB')
    save(out/'plan.json',plan);obs=[]
    try:
        for idx,item in enumerate(plan):
            root=roots[item['arm']];t=out/f'{idx:03d}-{item["dictionary"]}-{item["kind"]}-{item["arm"]}'
            with (out/f'{idx:03d}.log').open('w') as log:
                rc=subprocess.run(['node','dev/perf/import-benchmark.js',item['dictionary'],'--runs','1','--no-build','--output',str(t)],cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=180,check=False).returncode
            o=dict(item,output=str(t),returncode=rc);obs.append(o);save(out/'observations.json',obs);assert rc==0,o
            o.update(audit(root,item['dictionary'],t));save(out/'observations.json',obs)
            print(idx,item['dictionary'],item['kind'],item['arm'],round(o['ms'],2),flush=True)
        result={}
        for d in a.dictionaries:
            ps=[]
            for p in range(a.pairs):
                vs={v['arm']:v for v in obs if v['kind']=='AB' and v['dictionary']==d and v['pair']==p}
                assert vs['A']['accounting']==vs['B']['accounting'];ps.append([vs['A']['ms'],vs['B']['ms']])
            result[d]=dict(comparison=stats(ps),controls={arm:stats([[v['ms'] for v in obs if v['kind']=='control' and v['dictionary']==d and v['arm']==arm]]) for arm in 'AB'})
        for arm,root in roots.items():
            assert not git(root,'status','--porcelain') and git(root,'rev-parse','HEAD')==ids[arm]['commit']
            assert sha(root/'builds/manabitan-chrome-dev.zip')==ids[arm]['package']
        save(out/'RESULTS.json',dict(status='complete',results=result));print(json.dumps(result,indent=2),flush=True)
    except BaseException as e:
        save(out/'FAILURE.json',dict(status='incomplete',error=repr(e),observations=len(obs),effectEstimate=None));raise
if __name__=='__main__':main()
