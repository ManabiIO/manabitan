from pathlib import Path
import fcntl,hashlib,json,os,platform,subprocess,time

T=Path(__file__).resolve().parent;C=json.loads((T/'config.json').read_text());K=json.loads((T/'contract.json').read_text());E=Path(C['evidence'])
assert platform.system()=='Linux' and platform.machine() in ['x86_64','amd64']
assert subprocess.check_output([C['node'],'--version'],text=True).startswith('v22.')
identity={n:hashlib.sha256((T/n).read_bytes()).hexdigest() for n in ['child.mjs','config.json','contract.json','helpers.mjs','baseline.wasm','wide.wasm','crc.wasm','colon.wasm']}
(E/'registered-tools.json').write_text(json.dumps(identity,indent=2)+'\n')
environment={'platform':platform.platform(),'machine':platform.machine(),'logicalCpuCount':os.cpu_count(),'cpuMax':Path('/sys/fs/cgroup/cpu.max').read_text().strip() if Path('/sys/fs/cgroup/cpu.max').exists() else None}
(E/'host.json').write_text(json.dumps(environment,indent=2)+'\n')
with open(C['lock'],'a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 for candidate,dictionary,phase in K['cases']:
  golden_env={**os.environ,'CONTAINED_GENERATE_GOLDEN':'1'}
  subprocess.run([C['node'],'--expose-gc',str(T/'child.mjs'),candidate,dictionary,phase,'baseline'],cwd=T,env=golden_env,check=True)
  path=E/(candidate+'-'+dictionary+'-'+phase+'-cohort.json');assert not path.exists()
  result={'candidate':candidate,'dictionary':dictionary,'phase':phase,'host':environment,'blocks':[]}
  for block in K['blocks']:
   observations=[]
   for label in block['arms']:
    arm=candidate if label=='candidate' else 'baseline'
    before={'at':time.time(),'load':os.getloadavg()}
    raw=subprocess.check_output([C['node'],'--expose-gc',str(T/'child.mjs'),candidate,dictionary,phase,arm],text=True,cwd=T)
    item=json.loads(raw);item['before']=before;observations.append(item)
   result['blocks'].append({**block,'observations':observations});path.write_text(json.dumps(result,indent=2)+'\n')
   print(json.dumps({'candidate':candidate,'dictionary':dictionary,'phase':phase,'blocks':len(result['blocks']),'total':len(K['blocks'])}),flush=True)
   assert identity=={n:hashlib.sha256((T/n).read_bytes()).hexdigest() for n in identity}
  result['complete']=True;path.write_text(json.dumps(result,indent=2)+'\n')
 subprocess.run(['/usr/bin/python3',str(T/'analyze.py')],cwd=T,check=True)
print('Fixed complete phase cohorts and all full-corpus oracles finished',flush=True)
