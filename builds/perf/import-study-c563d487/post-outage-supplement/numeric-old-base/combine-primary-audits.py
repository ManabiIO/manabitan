"""Index every original fixed full-import cell, including failed memory coverage.

This script reads retained observations only. It never acquires measurements,
alters a source/observer/criterion, retries a failure, pools hosts, or trims data.
"""
from pathlib import Path
import datetime
import hashlib
import json

root=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
load=lambda p:json.loads(p.read_text())
names=['jmdict-AB','jmdict-BA','jitendex-AB','jitendex-BA','vndb-AB','vndb-BA']
audits={name:load(root/name/'primary-log-audit.json') for name in names}
artifacts=load(root/'artifact-metadata-all-six-cells.json')['artifacts']
jobs=load(root/'primary-final-job-metadata.json')['raw']['jobs']
validation=load(root/'validation/independent-audit.json')
cells=[]
role_counts={}
memory_coverage=[]
for name,audit in audits.items():
    assert audit['observations']==42
    prefix='MANABITAN_QUALIFICATION_JSON '
    lines=(root/name/'primary-records.jsonl').read_text().splitlines()
    records=[json.loads(line[len(prefix):]) for line in lines if line]
    assert all(line.startswith(prefix) for line in lines if line)
    observations=[record['value'] for record in records if record['kind']=='observation']
    assert len(observations)==42
    for observation in observations:
        kind=observation['role']['kind'];role_counts[kind]=role_counts.get(kind,0)+1
    results={record['value']['path']:record['value']['value'] for record in records if record['kind']=='result-file'}
    memory=results['memory/memory-comparison.json']['observations']
    assert len(memory)==4
    assert results['memory/semantic-failures.json']==[]
    for observation in memory:
        memory_coverage.append({'cell':name,'id':observation['name'],'qualified':observation['qualifiedForWholeTreePss'],'failures':observation['qualificationFailures'],'maximumCoveredSampleGapMs':observation['maximumCoveredSampleGapMs'],'preImportBracketGapMs':observation['preImportBracketGapMs'],'postImportBracketGapMs':observation['postImportBracketGapMs'],'stableFullyReadImportSampleCount':observation['stableFullyReadImportSampleCount'],'allObservedSampleCount':observation['allObservedSampleCount']})
    artifact=next(item for item in artifacts if item['name']=='numeric-suffix-c563d487-'+name)
    job=next(item for item in jobs if item['id']==audit['jobId'])
    assert job['status']=='completed'
    stats=audit['candidateVsBaseline'];control=audit['identicalCodeControl']
    largest=max(abs(value) for value in audit['identicalCodeChangePercentRange'])
    cells.append({'cell':name,'jobId':audit['jobId'],'jobConclusion':job['conclusion'],'startedAt':job['started_at'],'completedAt':job['completed_at'],'runnerId':job['runner_id'],'runnerName':job['runner_name'],'rawObservationCount':42,'taggedRecordCount':len(records),'allEmittedReportChecksPass':audit['allChecksPass'],'errors':audit['errors'],'latency':stats,'identicalCodeControl':control,'largestAbsoluteControlChangePercent':largest,'absoluteMedianEffectOverLargestAbsoluteControl':abs(stats['medianPairedChangePercent'])/largest,'storageBytes':audit['storageBytes'],'lookupSemanticSha256':audit['lookupSemanticSha256'],'memoryPassed':audit['recomputedMemoryPass'],'memoryMetrics':audit['recomputedMemoryMetrics'],'memoryRawScanCount':audit['memoryAudit']['rawScanCount'],'mechanicalTargetThresholdPass':audit['mechanicalTargetThresholdPass'],'mechanicalNonTargetHoldSignal':audit['mechanicalNonTargetHoldSignal'],'artifact':{'id':artifact['id'],'name':artifact['name'],'sizeBytes':artifact['size_in_bytes'],'apiDigest':artifact['digest'],'scope':'Original Actions ZIP; independent archive/raw-scan audit is separately retained'},'primaryEvidence':[{'path':name+'/'+file,'bytes':(root/name/file).stat().st_size,'sha256':sha(root/name/file)}for file in ['primary-log-audit.json','primary-records.jsonl']]})

assert role_counts=={'control':48,'exhaustive-media':12,'memory':24,'candidate':144,'warmup':24}
target=[cell for cell in cells if cell['cell'].startswith('vndb')]
source_keys=['sha','tree','packageEntriesSha256','packageEntryCount','changedPackageEntryHashes','lockSha256','fixtureLockSha256']
reference=audits[names[0]]
for audit in audits.values():
    assert audit['cohort']['runId']=='46113243549'
    assert audit['cohort']['workflowSha256']==reference['cohort']['workflowSha256']
    assert audit['browser']['sha256']==reference['browser']['sha256']
    for arm in ['A','B']:
        for key in source_keys:
            assert audit['sourceIdentities'][arm][key]==reference['sourceIdentities'][arm][key],(arm,key)
for corpus in ['jmdict','jitendex','vndb']:
    for key in ['storageBytes','lookupSemanticSha256']:
        assert audits[corpus+'-AB'][key]==audits[corpus+'-BA'][key]
assert all(cell['mechanicalTargetThresholdPass'] for cell in target)
assert sum(cell['memoryPassed'] for cell in cells)==5
assert [item['cell']+'/'+item['id'] for item in memory_coverage if not item['qualified']]==['vndb-AB/A1','vndb-AB/B1','vndb-AB/A2']

out={'schemaVersion':1,'recordedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Complete independent primary-log index of the original fixed six-host cohort. Artifact/raw-scan reconciliation is a separate evidence layer. No new acquisition or rerun.','repository':'ManabiIO/manabitan','runId':46113243549,'runUrl':'https://github.com/ManabiIO/manabitan/actions/runs/46113243549','baseline':'9e10d3b3fcf66d344ab31bc42c9b522fa5215da2','candidate':'399feae29fea358560af27af68f03dfb6d8b6f58','toolingCommit':'ee9450923d14e95b7958feeffffde4998cf8c5d9','observerSha256':'cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef','independentAuditorSha256':'0a90d65ebda54d584a120ba0a9d1f5780ad550481f3aa7a08666307b7bd82656','plannedAndRetainedObservations':252,'roleCounts':role_counts,'allCellsTerminal':True,'allTimingPairsRetained':True,'sameSourcePackageEntryMapsBrowserAndWorkflowAcrossHosts':True,'distinctProvisionerAssignments':len({cell['runnerId']for cell in cells})==6,'provisionerInterpretation':'Six distinct Actions runner assignments; no inference about distinct underlying physical hardware.','latencyPairing':'Twelve candidate pairs and four identical-baseline control pairs per separate corpus/order host; no host pooling or subtraction.','memoryGate':{'thresholdUnchangedMs':250,'observations':24,'qualifiedObservations':sum(item['qualified']for item in memory_coverage),'allQualified':all(item['qualified']for item in memory_coverage),'rawScans':sum(cell['memoryRawScanCount']for cell in cells),'coverage':memory_coverage,'interpretation':'Three VNDB AB observations lack the required sampling coverage. This establishes neither a memory regression nor acceptable memory behavior for that host; qualification remains failed.'},'correctnessGate':{'auditSha256':sha(root/'validation/independent-audit.json'),'jobId':validation['jobId'],'jobConclusion':validation['jobConclusion'],'exactSource':validation['sourceIdentityMatchesPublishedProduct'],'nativeArtifactsReproduced':validation['nativeReproduction']['bothFrozenSourcesReproduceExactly'],'lintPassed':validation['lint']['passed'],'strictMainTypesPassed':validation['strictMainTypesPassed'],'strictTestTypesPassed':validation['strictTestTypesPassed'],'unit':validation['unit'],'options':validation['options'],'build':validation['build']},'cells':cells,'decision':{'status':'Held; not fully qualified; no performance PR from this cohort','replicatedVndbLatencyThresholdMet':True,'bothTargetEffectsExceedLargestAbsoluteSameHostControl':all(abs(cell['latency']['medianPairedChangePercent'])>cell['largestAbsoluteControlChangePercent']for cell in target),'nonTargetReplicatedHoldSignal':False,'nonTargetInterpretation':'Neither JMdict nor Jitendex triggers the prospective replicated slowdown gate; their intervals include zero, so these observations do not prove equivalence.','allCorrectnessStorageMemoryPackageGatesPassed':False,'reason':'VNDB AB sampling gaps255.363403,260.966631 and284.148828ms exceed the frozen250ms coverage gate. All failures and outliers remain included.','noRetryNoReplacementNoGateRelaxation':True,'currentDevelopLimitation':{'frozenBaseline':'9e10d3b3fcf66d344ab31bc42c9b522fa5215da2','observedDevelop':'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16','noGainTransfer':True,'requirement':'Any current-source follow-up must have separate source identities, prospective protocol and observations; it cannot repair or replace this failed cohort.'}},'artifactsMetadataSha256':sha(root/'artifact-metadata-all-six-cells.json'),'primaryFinalJobMetadataSha256':sha(root/'primary-final-job-metadata.json')}
destination=root/'combined-primary-index.json'
with destination.open('x') as file:file.write(json.dumps(out,indent=2)+'\n')
print(json.dumps({'path':str(destination),'sha256':sha(destination),'bytes':destination.stat().st_size,'observations':252,'memoryQualified':out['memoryGate']['qualifiedObservations'],'memoryRawScans':out['memoryGate']['rawScans'],'decision':out['decision']['status']}))
