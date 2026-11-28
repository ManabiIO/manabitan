import hashlib,json,math,pathlib,random,statistics,zipfile
ROOT=pathlib.Path(__file__).resolve().parent
CONFIG=json.loads((ROOT/'audit-inputs.json').read_text())
BASE='dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
CAND='b2a909472aa6a415a9bc0b91f7d37208390af016'
def stats(observations,kind):
    paired={}
    other='B' if kind=='candidate' else 'C'
    for item in observations:
        if item['kind']==kind:paired.setdefault(item['pair'],{})[item['arm']]=item['totalImportMs']
    assert sorted(paired)==list(range(1,(12 if kind=='candidate' else 4)+1))
    pairs=[paired[k] for k in sorted(paired)]
    assert all(set(p)=={'A',other} and all(math.isfinite(v) and v>0 for v in p.values()) for p in pairs)
    ms=[p[other]-p['A'] for p in pairs]
    ratios=[p[other]/p['A'] for p in pairs]
    rnd=random.Random(897);boot_ms=[];boot_pc=[]
    for _ in range(10000):
        indexes=[rnd.randrange(len(pairs)) for _ in pairs]
        boot_ms.append(statistics.median(ms[i] for i in indexes))
        boot_pc.append((statistics.median(ratios[i] for i in indexes)-1)*100)
    boot_ms.sort();boot_pc.sort()
    return {'count':len(pairs),'medianPairedChangeMs':statistics.median(ms),
            'medianPairedChangePercent':(statistics.median(ratios)-1)*100,
            'equalWorkChangePercent':(sum(p[other] for p in pairs)/sum(p['A'] for p in pairs)-1)*100,
            'fasterPairs':sum(x<0 for x in ms),
            'bootstrap95ChangeMs':[boot_ms[249],boot_ms[9749]],
            'bootstrap95ChangePercent':[boot_pc[249],boot_pc[9749]],
            'baselineMedianMs':statistics.median(p['A'] for p in pairs),
            'candidateMedianMs':statistics.median(p[other] for p in pairs),
            'pairedMs':ms,'pairedRatios':ratios}
result={'schemaVersion':1,'scope':'Independent exact-artifact recomputation of two current JMdict tag-prefetch cohorts. No observations excluded, pooled or reacquired.',
        'baseline':BASE,'candidate':CAND,'run':46125860840,
        'decision':'REJECT_FOR_PRODUCT_PR_NO_REPLICATED_JMDICT_GAIN','cells':[]}
for config,printed in zip(CONFIG['downloads'],CONFIG['printed'],strict=True):
    order=config['order']; archive=ROOT/('jmdict-'+order+'.zip')
    raw=archive.read_bytes()
    assert len(raw)==config['bytes'] and hashlib.sha256(raw).hexdigest()==config['sha256']
    with zipfile.ZipFile(archive) as z:
        entries=z.namelist();assert len(entries)==len(set(entries))
        assert z.testzip() is None
        for p in printed['json']:
            data=z.read(p['path'])
            assert hashlib.sha256(data).hexdigest()==p['sha256'],p['path']
            assert json.loads(data)==p['data'],p['path']
        def read(name):return json.loads(z.read(name))
        plan=read('registered-plan.json');observations=read('observations.json');reported=read('analysis.json')
        assert plan['baseline']==BASE and plan['candidate']==CAND and plan['initialOrder']==order and plan['flags']=={} and plan['expectedWorkers']==3
        assert len(observations)==36
        assert [{k:o[k] for k in ('arm','id','kind','pair')} for o in observations]==plan['schedule']
        first=None; phases=[];manifest={}
        for obs in observations:
            name=obs['id'];summary=read(name+'/summary.json');report=read(name+'/run-1.json');canonical=read(name+'/canonical-receipt.json')
            assert summary['gitSha']==(CAND if obs['arm']=='B' else BASE)
            assert summary['source']['dirty'] is False and summary['authoritativeTiming'] is True and summary['traceEnabled'] is False
            assert len(summary['runs'])==1 and summary['runs'][0]['totalImportMs']==obs['totalImportMs']
            assert report['status']=='success' and report['skippedVerification'] is False
            if first is None:first=canonical
            assert canonical==first,(order,name,'canonical parity')
            run=summary['runs'][0]
            phases.append({'id':name,'arm':obs['arm'],'kind':obs['kind'],'pair':obs['pair'],
                           'totalImportMs':obs['totalImportMs'],'workerImportMs':run['workerImportMs'],
                           'step4':run['step4Breakdown'],'steps':run['stepTimingSummary']})
        memory=read('memory/memory-audit.json')
        assert memory['observations']==4 and memory['everyObservationQualified'] is True and memory['passesProspectiveMemoryScreen'] is True
        a=stats(observations,'candidate');control=stats(observations,'control')
        for own,remote in [(a,reported['candidateVsBaseline']),(control,reported['identicalCodeControl'])]:
            for key in ['count','medianPairedChangePercent','equalWorkChangePercent','fasterPairs']:
                assert abs(own[key]-remote[key])<1e-9,(order,key)
            assert all(abs(x-y)<1e-9 for x,y in zip(own['bootstrap95ChangePercent'],remote['descriptiveBootstrap95Percent']))
        gates={
           'savingMsAtLeast5':a['medianPairedChangeMs']<=-5,
           'savingPercentAtLeast0_5':a['medianPairedChangePercent']<=-.5,
           'fasterPairsAtLeast9':a['fasterPairs']>=9,
           'equalWorkLower':a['equalWorkChangePercent']<0,
           'upper95MsNegative':a['bootstrap95ChangeMs'][1]<0,
           'upper95PercentNegative':a['bootstrap95ChangePercent'][1]<0,
           'controlMedianBelowHalfBenefit':a['medianPairedChangePercent']<0 and abs(control['medianPairedChangePercent'])<(-a['medianPairedChangePercent']*.5),
           'controlEqualWorkBelowHalfBenefit':a['equalWorkChangePercent']<0 and abs(control['equalWorkChangePercent'])<(-a['equalWorkChangePercent']*.5)}
        identity=read('source-identities.json')
        assert identity['changedPackageEntries']==['js/dictionary/dictionary-importer.js']
        assert identity['addedPackageEntries']==['js/dictionary/bounded-zip-text-writer.js']
        assert not identity['removedPackageEntries']
        for name in entries:
            data=z.read(name);manifest[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        saved=ROOT/('jmdict-'+order+'-retained');saved.mkdir(exist_ok=True)
        for name in ['registered-plan.json','observations.json','analysis.json','source-identities.json','browser-identity.json','memory/memory-audit.json','memory/memory-comparison.json','memory/semantic-failures.json']:
            path=saved/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(z.read(name))
        (saved/'all-observation-phases.json').write_text(json.dumps(phases,indent=2)+'\n')
        (saved/'artifact-members-sha256.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
        result['cells'].append({'order':order,'artifactId':config['artifactId'],'artifactBytes':len(raw),'artifactSha256':config['sha256'],
            'prescribedTimingObservations':36,'allTimingSummariesSourceBound':True,'allCanonicalReceiptsEqual':True,
            'candidate':a,'control':control,'timingGates':gates,'passesAllTimingGates':all(gates.values()),
            'memoryAudit':memory,'sourceIdentityChangedEntries':identity['changedPackageEntries'],'sourceIdentityAddedEntries':identity['addedPackageEntries'],
            'rawArchiveMembers':len(entries),'rawArchiveValidatedEveryMember':True})
assert not any(c['passesAllTimingGates'] for c in result['cells'])
(ROOT/'jmdict-independent-audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))

