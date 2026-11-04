from pathlib import Path
import json,math,random,statistics,sys
T=Path(__file__).resolve().parent;C=json.loads((T/'config.json').read_text());E=Path(C['evidence'])
def interval(values):
 assert values and all(math.isfinite(x) for x in values)
 rng=random.Random(20261104);n=len(values);means=sorted(sum(values[rng.randrange(n)] for _ in range(n))/n for _ in range(100000));tail=(1-0.9833333333333333)/2
 return [means[int(tail*len(means))],means[min(len(means)-1,int((1-tail)*len(means)))]]
def ratio(values):
 ci=interval(values);return {'pairs':len(values),'geometricMeanPercent':math.expm1(statistics.mean(values))*100,'confidencePercent':98.33333333333333,'ciPercent':[math.expm1(x)*100 for x in ci]}
results=[]
for p in sorted(E.glob('*-cohort.json')):
 d=json.loads(p.read_text());assert d['complete'] and len(d['blocks'])==36
 item={k:d[k] for k in ['candidate','dictionary','phase']};item['metrics']={}
 for metric in ['cpuMs','wallMs']:
  arms={};controls=[];pairs=[]
  for block in d['blocks']:
   obs=block['observations'];assert len(obs)==2
   assert all(o['postBatchOracleVerified'] for o in obs)
   assert obs[0]['oracleSha256']==obs[1]['oracleSha256']
   for o in obs:arms.setdefault(o['arm'],[]).append(o['maxHeapBytes'])
   if block['kind']=='AB':
    a=next(o for o in obs if o['arm']=='baseline');b=next(o for o in obs if o['arm']==d['candidate']);pairs.append(math.log(b[metric]/a[metric]))
   else:controls.append(math.log(obs[1][metric]/obs[0][metric]))
  item['metrics'][metric]={'candidate':ratio(pairs),'AA':ratio(controls)}
 item['maximumHeapByArm']={k:max(v) for k,v in arms.items()}
 item['cpuAAWithinMargin']=all(abs(x)<=1.5 for x in item['metrics']['cpuMs']['AA']['ciPercent'])
 item['owningPhaseGainGate']=item['metrics']['cpuMs']['candidate']['ciPercent'][1]<0 and item['metrics']['cpuMs']['candidate']['geometricMeanPercent']<=-1
 item['adjacentCpuNonRegression']=item['metrics']['cpuMs']['candidate']['ciPercent'][1]<=2
 item['phaseWallNonRegression']=item['metrics']['wallMs']['candidate']['ciPercent'][1]<=2
 results.append(item)
p=E/(sys.argv[1] if len(sys.argv)>1 else 'component-analysis.json');assert not p.exists();p.write_text(json.dumps(results,indent=2)+'\n')
for item in results:print(json.dumps(item))
