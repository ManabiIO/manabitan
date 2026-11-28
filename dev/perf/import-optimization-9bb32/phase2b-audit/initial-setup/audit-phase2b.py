#!/usr/bin/env python3
"""Independent retained-byte and claim audit; never executes product code."""
import gzip,hashlib,io,json,subprocess,tarfile,traceback
from pathlib import Path,PurePosixPath
R=Path('/workspace/scratch/9bb32f82fa3b');P=R/'profiling/checkpoint-phase2b';O=R/'profiling/checkpoint-phase2b-audit'
CHECKS=[]
def check(name,actual,expected=True):
 good=json.dumps(actual,sort_keys=True,allow_nan=False)==json.dumps(expected,sort_keys=True,allow_nan=False)
 row={'name':name,'passed':good}
 if not good:row.update(actual=actual,expected=expected)
 CHECKS.append(row)
 if not good:raise AssertionError(name)
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def identity(name,b,e):
 for field,actual in [('bytes',len(b)),('sha256',sha(b)),('gitBlobSha1',blob(b))]:
  if field in e:check(name+' '+field,actual,e[field])
def js(b):return json.loads(b)
def readarchive(path,expected,retain=None,ordered=False):
 values={};names=[];raw=0
 with tarfile.open(path,'r|gz') as t:
  for m in t:
   pp=PurePosixPath(m.name)
   check(path.name+' safe regular '+m.name,m.isfile() and not pp.is_absolute() and '..' not in pp.parts and '\\' not in m.name and m.name not in names)
   check(path.name+' registered '+m.name,m.name in expected)
   check(path.name+' metadata '+m.name,[m.uid,m.gid,m.uname,m.gname,m.mode,m.mtime],[0,0,'','',420,0])
   b=t.extractfile(m).read();identity(m.name,b,expected[m.name]);names.append(m.name);raw+=len(b)
   if retain is None or retain(m.name):values[m.name]=b
 check(path.name+' exact members',sorted(names),sorted(expected))
 if ordered:check(path.name+' sorted order',names,sorted(names))
 return values,{'count':len(names),'rawBytes':raw,'names':names}
def nullmetrics(name,metrics):
 for k,v in metrics.items():
  for field,value in v.items():check(name+' '+k+' '+field,value,None)
result={'scope':'Independent exact retained bytes/membership and frozen semantic/decision bindings. No product imports, tests, benchmarks, threshold changes, or omitted-payload rehash.','passed':False,'checks':CHECKS}
try:
 pubpath=R/'profiling/checkpoint-phase2b-publication-files.json';pubbytes=pubpath.read_bytes()
 check('frozen publication manifest pin',sha(pubbytes),'f78158b103392c4cf7fff153d71de6f8581b2811c1f0b18382e64fab51306f30')
 pub=js(pubbytes);expectedouter={x['name']:x for x in pub['files']}
 check('exact20publicationentries',len(expectedouter),20)
 check('outer membership includes no directories/symlinks',all(x.is_file() and not x.is_symlink() for x in P.iterdir()))
 check('exact outer membership',sorted(x.name for x in P.iterdir()),sorted(expectedouter))
 for n,e in expectedouter.items():identity('outer '+n,(P/n).read_bytes(),e)
 inventory=js((P/'INVENTORY.json').read_bytes());declared={x['name']:x for x in inventory['files']}
 check('inventory self excluded only',set(expectedouter)-set(declared)=={'INVENTORY.json'})
 for n,e in declared.items():identity('inventory '+n,(P/n).read_bytes(),e)
 freeze=js((P/'INPUT-FREEZE.json').read_bytes());check('snapshot time',freeze['asOfUtc'],'2026-11-28T06:34:31Z')
 proofitems=js((P/'PROOF-INVENTORY.json').read_bytes())['files'];proofindex={x['path']:x for x in proofitems}
 check('119 proof members',len(proofindex),119)
 check('frozen proof membership',sorted(proofindex),sorted(x['path'] for x in freeze['proofInputs']))
 for f in freeze['proofInputs']:
  for key in ['bytes','sha256','gitBlobSha1']:check('freeze '+f['path']+' '+key,proofindex[f['path']][key],f[key])
 proofs,ps=readarchive(P/'proofs-and-sources.tar.gz',proofindex,ordered=True)
 check('proof archive known hash',sha((P/'proofs-and-sources.tar.gz').read_bytes()),'508573a2295c1000f096ea71fb47f27bad71ddcd540e910d780428247f8da2cc')
 check('proof archive known size',(P/'proofs-and-sources.tar.gz').stat().st_size,764000)
 buf=io.BytesIO()
 with gzip.GzipFile(filename='',mode='wb',fileobj=buf,mtime=0,compresslevel=9) as gz:
  with tarfile.open(fileobj=gz,mode='w|',format=tarfile.PAX_FORMAT) as t:
   for name in sorted(proofs):
    data=proofs[name];m=tarfile.TarInfo(name);m.size=len(data);m.mode=420;m.uid=m.gid=m.mtime=0;m.uname=m.gname='';t.addfile(m,io.BytesIO(data))
 check('independent deterministic proof repack exact bytes',buf.getvalue()==(P/'proofs-and-sources.tar.gz').read_bytes())
 result['proofArchive']={'members':ps['count'],'rawBytes':ps['rawBytes'],'sha256':sha(buf.getvalue()),'repackByteIdentical':True}
 prior={};deps=js((P/'DEPENDENCIES.json').read_bytes());result['dependencies']={}
 for label,path,count in [('phase1',R/'profiling/checkpoint-phase1/checkpoint-phase1.tar.gz',2),('phase2a',R/'profiling/checkpoint-phase2a/proofs-and-sources.tar.gz',23)]:
  spec=deps[label];identity(label+' archive',path.read_bytes(),spec['archive']);wanted={m['member']:m for m in spec['members']};check(label+' member count',len(wanted),count);seen=set()
  with tarfile.open(path,'r|gz') as t:
   for m in t:
    if m.name not in wanted:continue
    check(label+' regular unique '+m.name,m.isfile() and m.name not in seen);b=t.extractfile(m).read();identity(label+' '+m.name,b,wanted[m.name]);prior[m.name]=b;seen.add(m.name)
  check(label+' exact dependency set',sorted(seen),sorted(wanted));result['dependencies'][label]=len(seen)
 for target,member in freeze['directOuterProjections'].items():check('direct frozen root projection '+target,(P/target).read_bytes()==proofs[member])
 summary=js(proofs['profiling/import-experiment-summary/RESULTS.json']);decisions=js((P/'DECISIONS.json').read_bytes());status=js((P/'STATUS.json').read_bytes());exclusions=js((P/'EXCLUSIONS.json').read_bytes())
 identity('root JSON projection',proofs['profiling/import-experiment-summary/RESULTS.json'],decisions['projection'])
 for candidate in summary['candidates'].values():
  for cell in candidate['cells']:
   for b in cell.get('sourceBindings',[]):
    n='profiling/'+b['path'];check('projection binding present '+n,n in proofs or n in prior);identity('projection binding '+n,proofs.get(n,prior.get(n)),b)
 check('source baseline',summary['baselineCommit'],'9e10d3b3fcf66d344ab31bc42c9b522fa5215da2')
 check('candidate source',summary['candidates']['minsize']['commit'],'2907ba1bad0958c22fe363f88d7cceb4d4bc604e')
 index=js((P/'CELL-INDEX.json').read_bytes());result['cells']=[]
 expectedcells=[f'{d}-{o}' for d in ['jmdict','jitendex','vndb'] for o in ['AB','BA']]
 check('six expected cells',sorted(c['cell'] for c in index['cells']),sorted(expectedcells))
 scans=imports=qualified=members=0
 for cell in index['cells']:
  name=cell['cell'];prefix='profiling/hosted-qualification/minsize/'+name+'/'
  retention=js(proofs[prefix+'retention-manifest.json']);a=js(proofs[prefix+'audit-and-stage-analysis.json']);audit=js(proofs[prefix+'independent-semantics-memory-audit.json']);ident=js(proofs[prefix+'independent-identity-preflight.json']);gh=js(proofs[prefix+'github-artifact.json'])
  rawpath=P/cell['publicationName'];identity(name+' frozen raw archive',rawpath.read_bytes(),cell);identity(name+' retained archive',rawpath.read_bytes(),retention['retainedArchive'])
  e={**retention['included'],**retention['derived']};check(name+'269original+1derived',[len(retention['included']),len(retention['derived'])],[269,1])
  wanted=lambda n:n in ['registered-plan.json','analysis.json','observations.json','source-identities.json','derived-package-audit.json','browser-identity.json','memory/memory-comparison.json','memory/memory-audit.json','memory/semantic-failures.json'] or n.endswith('/canonical-receipt.json') or n.endswith('/memory.json') or n.endswith('/summary.json')
  raw,rs=readarchive(rawpath,e,retain=wanted);members+=rs['count'];check(name+'270members',rs['count'],270)
  plan=js(raw['registered-plan.json']);analysis=js(raw['analysis.json']);memory=js(raw['memory/memory-comparison.json']);observations=js(raw['observations.json'])
  check(name+'source pins',[plan['baseline'],plan['candidate']],['9e10d3b3fcf66d344ab31bc42c9b522fa5215da2','2907ba1bad0958c22fe363f88d7cceb4d4bc604e'])
  check(name+'fixed schedule',[plan['pairs'],len(plan['schedule']),len(observations),plan['expectedWorkers'],plan['flags']],[12,36,36,3,{}])
  check(name+'raw analysis matches audited',analysis,a['frozenHarnessAnalysis'])
  projected=next(c for c in summary['candidates']['minsize']['cells'] if c['cell']==name)
  for key in ['medianPairedChangePercent','descriptiveBootstrap95Percent','equalWorkChangePercent','fasterPairs']:check(name+'projected '+key,projected[key],analysis['candidateVsBaseline'][key])
  check(name+'control projected median',projected['controlMedianPairedChangePercent'],analysis['identicalCodeControl']['medianPairedChangePercent'])
  check(name+'control projected equalwork',projected['controlEqualWorkChangePercent'],analysis['identicalCodeControl']['equalWorkChangePercent'])
  check(name+'projected qualification',projected['memoryPassed'],analysis['memoryPassed'])
  check(name+'source stage audit complete',[a['checksPassed'],a['allImportCount'],a['checkCount'],a['failedChecks']],[True,42,585,[]])
  check(name+'independent audit complete',[audit['passed'],audit['failedChecks'],audit['archiveSha256'],audit['retentionManifestSha256']],[True,[],sha(rawpath.read_bytes()),sha(proofs[prefix+'retention-manifest.json'])])
  check(name+'wrapper binds independent audit',ident['semanticMemoryReceiptSha256'],sha(proofs[prefix+'independent-semantics-memory-audit.json']))
  check(name+'artifact/run/workflow binding',[gh['id'],gh['workflow_run']['id'],gh['workflow_run']['head_sha']],[cell['sourceArtifact']['id'],46104898097,'0c2a8a75cd0322cc13348b977a7e915b555d5a88'])
  check(name+'artifact content metadata',[gh['size_in_bytes'],gh['digest']],[cell['sourceArtifact']['bytes'],'sha256:'+cell['sourceArtifact']['sha256']])
  receipts=[js(b) for n,b in raw.items() if n.endswith('/canonical-receipt.json')];check(name+'all42canonical receipts',len(receipts),42);imports+=len(receipts)
  for i,c in enumerate(receipts):check(name+f'common semantics {i}',c['common'],receipts[0]['common']);check(name+f'browser identity {i}',c['browserVersion'],receipts[0]['browserVersion'])
  allmedia=[c['media'] for c in receipts if c['media']['mode']=='all'];check(name+'two exhaustive referenced media receipts',len(allmedia),2)
  for m in allmedia:check(name+'full media equality',m,audit['semanticSummary']['fullMedia'])
  check(name+'sampled semantic scope',[audit['semanticSummary']['lookupsPerObservation'],audit['semanticSummary']['distinctProbeTerms'],audit['semanticSummary']['lookupPasses'],audit['semanticSummary']['allNormalizedCommonSemanticsEqual']],[72,12,6,True])
  check(name+'42rawreports+summaries',[sum(n.endswith('/run-1.json') for n in rs['names']),sum(n.endswith('/summary.json') for n in rs['names'])],[42,42])
  for n,b in raw.items():
   if n.endswith('/summary.json'):
    s=js(b);check(name+'raw source '+n,s['gitSha'] in {plan['baseline'],plan['candidate']} and s['source']['gitSha']==s['gitSha'])
  check(name+'no memory semantic failures',js(raw['memory/semantic-failures.json']),[])
  rawscans=0
  for slot in memory['observations']:
   rm=js(raw['memory/'+slot['name']+'/memory.json']);rawscans+=len(rm['samples']);check(name+'raw scans '+slot['name'],len(rm['samples']),rm['allObservedSampleCount']);check(name+'memory benchmark success '+slot['name'],rm['benchmarkExitCode'],0)
   for key in ['maximumCoveredSampleGapMs','qualifiedForWholeTreePss','qualificationFailures','maxSampledPrivateKiB','maxSampledPssKiB']:check(name+'memory binding '+slot['name']+' '+key,rm[key],slot[key])
  check(name+'raw scan accounting',rawscans,audit['memorySummary']['rawScanCount']);check(name+'projection scan count',rawscans,projected['rawMemoryScans']);scans+=rawscans
  shouldqualify=name!='vndb-AB';check(name+'qualification status',[memory['everyObservationQualified'],memory['passesProspectiveMemoryScreen']],[shouldqualify,shouldqualify]);qualified+=int(shouldqualify)
  if not shouldqualify:
   nullmetrics(name,memory['metrics']);nullmetrics(name+' independent',audit['memorySummary']['metrics'])
   gaps={'A1':258.452668,'B1':251.822165,'B2':270.497028,'A2':258.260357}
   for slot in memory['observations']:
    check('failed VNDB AB coverage '+slot['name'],[slot['maximumCoveredSampleGapMs'],slot['qualifiedForWholeTreePss'],slot['qualificationFailures'],slot['maxSampledPssKiB'],slot['maxSampledPrivateKiB']],[gaps[slot['name']],False,['covered-import-scan-gap-over-250ms'],None,None])
   for pair in memory['pairs']:
    check('unqualified VNDB pair',pair['qualified'],False)
    for k in ['maxSampledPssKiB','maxSampledPrivateKiB']:check('null VNDB pair '+k,pair[k],{'baseline':None,'candidate':None,'changePercent':None})
   check('reproduced failure distinct from qualified', [ident['auditReproducedCorrectly'],ident['qualificationPassed']],[True,False])
   job=js(proofs[prefix+'job-completion-summary.json']);check('VNDB AB preserved job failure',job['jobConclusion'],'failure');check('VNDB AB original failure excerpt',bool(job['jobFailureExcerpt']))
  package=js(raw['derived-package-audit.json']);sources=js(raw['source-identities.json']);check(name+'package original audit passed',package['passes'],True)
  pa,pb=package['arms']['A']['entries'],package['arms']['B']['entries'];check(name+'554members per arm',[len(pa),len(pb)],[554,554]);check(name+'same package member set',sorted(pa),sorted(pb))
  check(name+'exact2package deltas',sorted(k for k in pa if pa[k]!=pb[k]),['js/dictionary/wasm/term-bank-parser.c','lib/term-bank-parser.wasm'])
  check(name+'native parser identity',[pa['lib/term-bank-parser.wasm'],pb['lib/term-bank-parser.wasm']],['8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee','363136045b400ea9bab953cb7b52febaedd23b4d1e3b666cde3d4df859b72ff0'])
  for arm in ['A','B']:check(name+'package entries bound '+arm,package['arms'][arm]['entries'],sources['arms'][arm]['entries'])
  omitted=retention['omittedRedundant'];check(name+'only redundant omitted payloads',[len(omitted),sum(n.endswith('.html') for n in omitted),sorted(n for n in omitted if not n.endswith('.html'))],[44,42,['package-A.zip','package-B.zip']])
  result['cells'].append({'cell':name,'rawArchiveSha256':sha(rawpath.read_bytes()),'members':270,'imports':42,'rawScans':rawscans,'memoryQualified':shouldqualify,'medianPairedChangePercent':analysis['candidateVsBaseline']['medianPairedChangePercent'],'equalWorkChangePercent':analysis['candidateVsBaseline']['equalWorkChangePercent']})
 check('complete retained totals',[members,imports,scans,qualified],[1620,252,2152,5])
 check('no PR decisions',decisions['pullRequestsCreated'],0);check('shelved minsize',decisions['decisions']['minsize']['decision'],'shelved-no-pr');check('wide decision pending',decisions['decisions']['wide']['decision'],'pending-hosted-evidence')
 check('no observation exclusions',exclusions['observationExclusions'],[]);check('failed/unqualified not removed',exclusions['failedOrUnqualifiedObservationsRemoved'],False)
 check('pending status alignment',[status['pendingOutcomes'],exclusions['pendingOutcomes']],[freeze['pendingOutcomes'],freeze['pendingOutcomes']]);check('pending outcome payloads excluded',[freeze['pendingOutcomePayloadsIncluded'],status['pendingOutcomePayloadsIncluded'],status['wideKeyword']['outcomePayloadsIncluded'],status['coordinatorDiagnostic']['outcomePayloadsIncluded']],[False]*4)
 check('pending run identities',sorted(x['runId'] for x in status['pendingOutcomes']),sorted([46110109833,46110109799,46111036970,46112384728,46116931392,46116931346]))
 for c in summary['candidates']['wide']['cells']:check('wide projection still pending '+c['cell'],c['state'],'pending')
 check('no wide/diagnostic acquired outcome paths',not any('/hosted-qualification/wide/' in n or '/hosted-wide-parity-result/' in n or n.startswith('profiling/wide-hosted-qa.') or '/slot-1/' in n or '/slot-2/' in n or '/slot-3/' in n for n in proofs))
 check('no large dependency/corpus payload members',not any('node_modules/' in n or '/runtime/node/' in n or n.endswith(('.wasm','.zip','.so','.dll','.exe')) for n in proofs))
 pubdiag=js(proofs['profiling/jmdict-group-diagnostic/remote-publication.json']);diagmanifest=js(proofs['profiling/jmdict-group-diagnostic/publication-files.final.json'])
 check('diagnostic exact remote source/tree/parent',[pubdiag['publishedCommit'],pubdiag['tree'],pubdiag['parent']],['b66020e0def759142ab2106a3f634a970ad807d7','dad39eefe469361fc5f74a14446b352b431bc77f','9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'])
 for f in diagmanifest['files']:identity('frozen diagnostic '+f['path'],proofs['frozen-diagnostic-source/'+f['path']],{'bytes':f['sizeBytes'],'sha256':f['sha256'],'gitBlobSha1':f['gitBlob']})
 for version in ['v1','v2']:
  check('superseded '+version+' driver/spec preserved',all('profiling/jmdict-group-diagnostic/pre-acquisition-'+version+'/'+n in proofs for n in ['import-group-stages-9bb32.py','import-group-stages-9bb32.json','publication-files.proposed.json']))
 check('remote alignment exact',sha(proofs['profiling/jmdict-group-diagnostic/remote-alignment.json']),'8e01668d76b50ba371e71499c7c4459d9e134fb4825ddd863b3deca6df167abb')
 check('queued pending no optimization claim',status['coordinatorDiagnostic']['purpose'],'Coordinator-observed dependency order only; no relative-speed or removable-duration claim')
 # Run the reviewed supplied verifier separately; our checks above do not depend on its return value.
 command=['python3',str(P/'verify-phase2b-checkpoint.py'),str(P),'--phase2a',str(R/'profiling/checkpoint-phase2a/proofs-and-sources.tar.gz'),'--phase1',str(R/'profiling/checkpoint-phase1/checkpoint-phase1.tar.gz')]
 with (O/'supplied-verifier.json').open('wb') as out,(O/'supplied-verifier.stderr').open('wb') as err:run=subprocess.run(command,stdout=out,stderr=err,timeout=60)
 check('reviewed supplied verifier exit',run.returncode,0)
 check('reviewed supplied verifier outcome',js((O/'supplied-verifier.json').read_bytes())['passed'],True)
 result.update(passed=True,asOfUtc=freeze['asOfUtc'],outerFileCount=20,rawMembers=members,totalImports=imports,rawMemoryScans=scans,qualifiedMemoryCells=qualified,pendingOutcomePayloadsIncluded=False,scopeReview={'rootProjectionByteIdentical':True,'allFailedCoveragePreserved':True,'failedCoverageNotRegression':True,'persistedLookupScope':'72 sampled observations; not exhaustive persisted-row equivalence','fullParserParityScopeSeparate':True,'memoryScope':'sampled process-tree PSS/private, not absolute peak','noOptimizationGainClaim':True,'omittedOriginalPayloadsNotRehashed':True,'sevenArchivesUnmodified':True})
except Exception as error:
 result['failure']=str(error);(O/'audit-failure.txt').write_text(traceback.format_exc())
finally:
 result['checkCount']=len(CHECKS);result['failedChecks']=[x for x in CHECKS if not x['passed']];result['scriptSha256']=sha(Path(__file__).read_bytes());result['coreArchiveSha256']={p.name:sha(p.read_bytes()) for p in P.glob('*.tar.gz')};(O/'independent-checkpoint-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':result['passed'],'checks':result['checkCount'],'failure':result.get('failure'),'cells':result.get('cells',[])}))
raise SystemExit(0 if result['passed'] else 1)
