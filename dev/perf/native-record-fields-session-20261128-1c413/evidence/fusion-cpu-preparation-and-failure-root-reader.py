from pathlib import Path,PurePosixPath
import hashlib,json,tarfile
def identity(raw):
 return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'gitBlob':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()}
cases=[
 {'name':'preparation','root':'/tmp/manabitan-cpu-preparation-evidence-20261128-1c413','archive':'preparation-history-and-reviews.tar.gz','ledger':'preparation-history-and-reviews.tar.gz.members.json','expected':{'bytes':276095,'sha256':'3d3755d41fe23b1d608ce3aec55b00608e19674a9167ab9b1ca76bf393fc5331','gitBlob':'2a2f6200f322c14169e6d6c05f4d4c7f1fc7aca5'}},
 {'name':'original-failure','root':'/tmp/cpu-original-audit-46153880495-attempt1-zs5uf_xj','archive':'cpu-original-accessible-evidence-46153880495-attempt1.tar.gz','ledger':'archive-member-readback.json','expected':{'bytes':148917,'sha256':'d75788314d1577a142aacdabcfc420c7d5fc7e2add35bb038a627868d7a6ab8c','gitBlob':'67962798ea2a7cb600d429a5331c5e71b62d369d'}}
]
results=[]
for case in cases:
 root=Path(case['root']);archive=root/case['archive']
 actual=identity(archive.read_bytes());assert actual==case['expected']
 ledger_path=root/case['ledger']
 if not ledger_path.exists():
  choices=[]
  for f in root.glob('*.json'):
   d=json.loads(f.read_text())
   if 'completeMembers' in d: choices.append((f,d))
  assert len(choices)==1
  ledger_path,ledger=choices[0]
 else: ledger=json.loads(ledger_path.read_text())
 expected=ledger.get('members',ledger.get('completeMembers'))
 assert isinstance(expected,dict)
 verified={}
 with tarfile.open(archive,'r:gz') as tar:
  members=tar.getmembers()
  assert len(members)==len(expected)
  assert len(set(m.name for m in members))==len(expected)
  for member in members:
   name=member.name;path=PurePosixPath(name)
   assert not path.is_absolute() and '..' not in path.parts
   assert name in expected
   reference=expected[name]
   if member.isdir():
    assert reference.get('kind')=='directory'
    verified[name]={'kind':'directory'}
   else:
    assert member.isfile()
    raw=tar.extractfile(member).read()
    check=identity(raw)
    assert check['bytes']==reference['bytes'] and check['sha256']==reference['sha256']
    assert check['gitBlob']==reference.get('gitBlob',reference.get('gitBlobIdentity'))
    assert member.size==len(raw)
    verified[name]=check
 digest=hashlib.sha256(''.join(n+'\0'+verified[n].get('sha256','directory')+'\n' for n in sorted(verified)).encode()).hexdigest()
 results.append({'name':case['name'],'passed':True,'archive':actual,'members':len(verified),'regularFiles':sum('sha256' in v for v in verified.values()),'allMembersCompletelyReadAndMatched':True,'linksFollowed':False,'memberDigest':digest,'ledgerFile':str(ledger_path)})
print(json.dumps({'schemaVersion':1,'kind':'root-independent-cpu-preparation-and-failed-cohort-archive-readback','passed':True,'archives':results,'productExecution':False,'newTimingObservations':0},indent=2))
