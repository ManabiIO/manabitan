function auditComponent(dictionary, records) {
  const assert = (value, label) => { if (!value) throw new Error(label); };
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const by = tag => records.filter(row => row.tag === tag).map(row => row.value);
  const one = tag => { const found = by(tag); assert(found.length===1, "one "+tag); return found[0]; };
  const plan=one("SUFFIX_PROOF_PLAN"), result=one("SUFFIX_PROOF_RESULT");
  const children=by("SUFFIX_PROOF_CHILD_RECEIPT"), statuses=by("SUFFIX_PROOF_CHILD_STATUS"), observations=by("SUFFIX_PROOF_OBSERVATION");
  assert(records.length===52 && children.length===17 && statuses.length===17 && observations.length===16, "exact counts");
  assert(plan.dictionary===dictionary && result.dictionary===dictionary && result.complete===true, "complete corpus");
  assert(plan.toolingHead==="2c6761f83bd88a8d88b269ef31e5e15fa6840c22" && plan.toolingTree==="d71df680d403dad8c801f57e70c3a7c86dae17ca", "tooling");
  assert(plan.bindingSha256==="61d7d54b12c709e2c5275d187c11bf4370d5edaebc21c9ede8ee93cf57aff880", "binding");
  assert(plan.criteriaSha256==="7812d2e91515ae2ed2038acecac3617661a40152d33501fe54f089bd2e8cdb9d", "criteria");
  assert(equal(plan.python.versionInfo,[3,14,4,"final",0]) && plan.python.implementation==="cpython", "producer arithmetic");
  const schedule=[...Array(4)].flatMap((_,pair)=>[...(pair%2?"DCBA":"ABCD")].map(arm=>({pair,arm})));
  assert(equal(plan.schedule,schedule), "schedule");
  assert(equal(observations.map(({pair,arm})=>({pair,arm})),schedule), "observed order");
  assert(new Set(children.map(x=>x.label)).size===17 && new Set(statuses.map(x=>x.label)).size===17, "child uniqueness");
  for(const item of children) {
    const status=statuses.find(x=>x.label===item.label);
    assert(status.status==="completed" && status.exitCode===0 && equal(status.command,item.command), "child exit/command");
    assert(status.startedEpoch===item.startedEpoch && status.finishedEpoch===item.finishedEpoch, "child interval");
  }
  const expectedRows={jmdict:528299,jitendex:436555,vndb:6648310}[dictionary];
  const expectedDigest={jmdict:"2f8e0f8b55166fe47a30dcc09a2cdcef68b5ff27bd586acc3f0753f15de18b11",jitendex:"00e4f6116857fc5343b8ea6cc7255cbcda5703ff99ceb07e3d492752bcc69927",vndb:"5dcd5e0ef85feb32eda261441814f369c31950c96590ebd534b4c7a3f4643694"}[dictionary];
  const flags=dictionary==="vndb"?{experimentalNativeEscapedKeys:true}:{};
  const known = {
    A:{c:"7e836d21cb68165dc0fd6fe8aec074d50b77706debe2360b352b9cc34a67d24a",wasm:"5d216041823936521f8a70b721472fb8c42052d165d771a92b59ed967d8d2695",manifest:"a629d5be17edb377a890a06b00449c850ff34ef6f0fa13918e916dd5d694f770",dirty:""},
    B:{c:"ae886af90a3313c219b59fe7fe25a38705de47c2e2e2763135fcfaf61dbf91cc",wasm:"9a1dd618597f5ca5ec85e620621f0fb9167b3486a708d9dc82292bd099c45554",manifest:"a53f0ddd532e216ef66c36cfc5c0c9c48d1afc45b4a4b6413ef1cea552494459",dirty:"M dev/data/dictionary-wasm/manifest.json\n M dev/data/dictionary-wasm/term-bank-parser.wasm\n M ext/js/dictionary/wasm/term-bank-parser.c"}
  };
  let baselineHashes=null;
  for(const observation of observations) {
    const child=children.find(x=>x.label==="pair-"+observation.pair+"-"+observation.arm);
    assert(child, "missing child");
    const raw=child.result, identity=known[observation.arm==="B"?"B":"A"];
    assert(raw.dictionary===dictionary && raw.rows===expectedRows && raw.digest===expectedDigest, "corpus content");
    assert(raw.diagnostic===null && raw.diagnosticWasm===null && raw.warmupPasses===2, "unmeasured diagnostic/warmups");
    assert(raw.node==="v22.22.0" && raw.validateGlossaryTypes===true && equal(raw.flags,flags), "flags/runtime");
    assert(raw.filesPerGroup==={jmdict:7,jitendex:10,vndb:4}[dictionary] && raw.fusedAttempts==={jmdict:8,jitendex:22,vndb:166}[dictionary] && raw.fusedFallbacks===0, "fixed routes");
    assert(raw.gitHead==="f28c2801fcfd9416f220b46b9cbafeee901c1cb2" && raw.gitTree==="b428d0c9fa18e4956f3e2b182cae934de78e8f63" && raw.trackedChanges===identity.dirty, "exact source state");
    assert(raw.wasmSha256===identity.wasm && raw.sourceHashes["ext/js/dictionary/wasm/term-bank-parser.c"]===identity.c && raw.sourceHashes["dev/data/dictionary-wasm/manifest.json"]===identity.manifest, "native source");
    const normalized={...raw.sourceHashes,"ext/js/dictionary/wasm/term-bank-parser.c":known.A.c,"dev/data/dictionary-wasm/manifest.json":known.A.manifest};
    if(baselineHashes===null) baselineHashes=normalized;
    else assert(equal(normalized,baselineHashes), "same declared source dependencies");
    assert(Object.keys(raw.sourceHashes).length===11, "11 source dependencies");
    for(const key of Object.keys(observation).filter(k=>!["pair","arm"].includes(k))) assert(raw[key]===observation[key], "compact/raw "+key);
  }
  const excluded=children.filter(x=>!x.label.startsWith("pair-"));
  assert(excluded.length===1 && excluded[0].result.diagnostic!==null, "one excluded diagnostic");
  assert(equal(excluded[0].result.diagnostic,result.mechanicalCounts), "diagnostic totals");
  assert(result.rows===expectedRows && result.digest===expectedDigest, "result content");
  const sum = values => { let high=0,low=0; for(const x of values) { const next=high+x; low+=Math.abs(high)>=Math.abs(x)?(high-next)+x:(x-next)+high; high=next; } return high+low; };
  const median = values => { const sorted=values.slice().sort((a,b)=>a-b); return (sorted[1]+sorted[2])/2; };
  const calculated={};
  for(const metric of ["elapsedMs","cpuMs","parseMs","nativeParseMs","lookupMs"]) {
    for(const [label,left,right] of [["candidate","A","B"],["identicalControl","C","D"]]) {
      const a=[0,1,2,3].map(pair=>observations.find(x=>x.pair===pair && x.arm===left)[metric]);
      const b=[0,1,2,3].map(pair=>observations.find(x=>x.pair===pair && x.arm===right)[metric]);
      const changes=a.map((value,i)=>100*(b[i]/value-1));
      const value={pairedChangesPercent:changes,medianPairedChangePercent:median(changes),equalWorkChangePercent:100*(sum(b)/sum(a)-1),fasterPairs:changes.filter(x=>x<0).length};
      assert(equal(value,result.summary[label+"."+metric]), "exact Python3.14 arithmetic "+label+"."+metric);
      calculated[label+"."+metric]={...value,pairedMilliseconds:b.map((value,i)=>value-a[i]),medianPairedMilliseconds:median(b.map((value,i)=>value-a[i])),leftValues:a,rightValues:b};
    }
  }
  const candidate=calculated["candidate.elapsedMs"],control=calculated["identicalControl.elapsedMs"];
  const largestControl=Math.max(...control.pairedChangesPercent.map(Math.abs));
  const target=dictionary==="vndb" && candidate.medianPairedChangePercent<=-2 && candidate.fasterPairs===4 && -candidate.medianPairedChangePercent>largestControl && result.mechanicalCounts.hits>0;
  const risk=dictionary!=="vndb" && candidate.medianPairedChangePercent>3 && candidate.pairedChangesPercent.every(x=>x>0) && candidate.medianPairedChangePercent>largestControl;
  assert(result.componentGate.targetPromotionSignal===target && result.componentGate.nonTargetRiskSignal===risk && result.componentGate.largestAbsoluteControlChangePercent===largestControl, "fixed gate");
  return {dictionary,completedMeasuredObservations:16,excludedDiagnosticChildren:1,sourcePair:"f28 baseline versus exact ae886/9a1dd/a53f product overlay",producerPython:plan.python,host:plan.host,calculated,gate:{targetPromotionSignal:target,nonTargetRiskSignal:risk,largestAbsoluteControlChangePercent:largestControl},mechanicalCounts:result.mechanicalCounts,rows:expectedRows,digest:expectedDigest,rawRecordCount:52,artifactBindingScope:"This replays original primary logs only; separate original ZIP audits retain their own completion status."};
}
