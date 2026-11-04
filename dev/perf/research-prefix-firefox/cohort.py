from pathlib import Path
import json,fcntl,subprocess,os,hashlib
T=Path(__file__).resolve().parent;C=json.loads((T/'config.json').read_text());E=Path(C['evidence']);K=json.loads((T/'contract.json').read_text());assert json.loads((E/'preflight-audit.json').read_text())['status']=='passed';assert not (E/'ledger.json').exists();ledger=[]
for name,digest in K['tools'].items():assert hashlib.sha256((T/name).read_bytes()).hexdigest()==digest,name
env=dict(os.environ);env['PATH']=str(Path(C['node']).parent)+':'+env.get('PATH','');env['PLAYWRIGHT_BROWSERS_PATH']=C['root']+'/playwright-mapping';env['MANABITAN_ADMISSION_HELD']='1'
def run(specs):
 with open(C['lock'],'a') as lock:
  print('Waiting prefix browser pair '+specs[0]['id'],flush=True);fcntl.flock(lock,fcntl.LOCK_EX)
  rows=[]
  for spec in specs:
   subprocess.run([C['node'],str(T/'one.mjs'),json.dumps(spec)],cwd=T,env=env,check=True);rows.append(json.loads((E/spec['id']/'observation.json').read_text()))
  assert all(x['payloadSha256']==rows[0]['payloadSha256'] for x in rows),'Payload differs in matched pair'
 ledger.extend(specs);(E/'ledger.json').write_text(json.dumps({'observations':ledger,'complete':len(ledger),'total':50},indent=2)+'\n')
for c in K['cases']:
 prefix=c['browser']+'-'+c['dictionary']
 for arm in ['baseline','candidate']:run([{'browser':c['browser'],'dictionary':c['dictionary'],'arm':arm,'kind':'warmup','id':prefix+'-warmup-'+arm}])
 for b in c['blocks']:
  run([{'browser':c['browser'],'dictionary':c['dictionary'],'arm':arm,'kind':b['kind'],'pair':b['pair'],'position':i,'id':prefix+'-'+b['kind']+'-'+str(b['pair'])+'-'+str(i)+'-'+arm} for i,arm in enumerate(b['arms'])])
 for name,digest in K['tools'].items():assert hashlib.sha256((T/name).read_bytes()).hexdigest()==digest,name
 print('Prefix browser case complete '+prefix,flush=True)
print('Prefix browser fixed budget complete',flush=True)
