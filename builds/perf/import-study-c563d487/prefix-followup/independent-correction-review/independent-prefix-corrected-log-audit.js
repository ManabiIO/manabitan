/* Independent audit of frozen component logs; never executes product or timing code. */
function prefixStable(value) {
    if (Array.isArray(value)) return value.map(prefixStable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k=>[k,prefixStable(value[k])]));
    return value;
}
function prefixEqual(a,b) { return JSON.stringify(prefixStable(a))===JSON.stringify(prefixStable(b)); }
function prefixMedian(values) { const s=[...values].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function prefixStats(first,second) {
    const changes=first.map((x,i)=>100*(second[i]/x-1));
    return {firstValues:first,secondValues:second,pairedChangesPercent:changes,medianPairedChangePercent:prefixMedian(changes),
        equalWorkChangePercent:100*(second.reduce((a,b)=>a+b,0)/first.reduce((a,b)=>a+b,0)-1),
        fasterPairs:changes.filter(x=>x<0).length,slowerPairs:changes.filter(x=>x>0).length,
        minimumChangePercent:Math.min(...changes),maximumChangePercent:Math.max(...changes),largestAbsoluteChangePercent:Math.max(...changes.map(Math.abs))};
}
function parsePrefixLog(log) {
    const records=[],parseErrors=[];
    for(const [index,line] of log.split("\n").entries()) {
        const match=/\b(PREFIX_(?:CHILD_(?:RECEIPT|STATUS|PROGRESS)|SELECTOR_(?:PLAN|DIAGNOSTIC|OBSERVATION|RESULT|FAILED)|NEGATIVE_(?:PLAN|DIAGNOSTIC|OBSERVATION|CASE_RESULT|RESULT|FAILED))) (\{.*\})\s*$/.exec(line);
        if(!match)continue;
        try{records.push({kind:match[1],value:JSON.parse(match[2])});}catch(error){parseErrors.push({line:index+1,kind:match[1],error:String(error)});}
    }
    return {records,parseErrors};
}
function auditPrefixCorrectedLog(parsed,expected) {
    const records=parsed.records??parsed,errors=[...(parsed.parseErrors??[]).map(x=>"JSON parse error: "+JSON.stringify(x))];
    const check=(condition,label)=>{if(!condition)errors.push(label);};
    const equal=(a,b,label)=>check(prefixEqual(a,b),label);
    const finite=(n)=>typeof n==="number"&&Number.isFinite(n);
    const hash=(s)=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s);
    const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
    const get=(kind)=>records.filter(r=>r.kind===kind).map(r=>r.value);
    const negative=get("PREFIX_NEGATIVE_PLAN").length>0;
    const family=negative?"PREFIX_NEGATIVE_":"PREFIX_SELECTOR_";
    const plans=get(family+"PLAN"),finals=get(family+"RESULT"),failures=get(family+"FAILED");
    check(plans.length===1,"Exactly one acquisition plan");check(finals.length===1,"Exactly one completed result");
    check(failures.length===0,"Acquisition failure retained");
    if(plans.length!==1)return {complete:false,errors,failures,records:records.length,scope:"No source-bound acquisition plan; inspect retained setup/failure logs"};
    const plan=plans[0],final=finals[0],schedule=[];
    check(negative || ["jmdict","vndb"].includes(plan.dictionary),"Corrected cohort contains only JMdict, VNDB and negative controls");
    for(let pair=0;pair<4;pair++)for(const arm of (pair%2?"DCBA":"ABCD"))schedule.push({pair,arm});
    equal(negative?plan.schedulePerCase:plan.schedule,schedule,"Frozen 4-pair ABCD/DCBA schedule");
    equal(plan.tooling?.hashes,expected.toolingHashes,"Exact frozen observer file hashes");
    check(plan.tooling?.head===expected.toolingHead,"Tooling commit");
    check(plan.tooling?.fixtureLockSha256===expected.fixtureLockSha256,"Tooling fixture lock");
    check(plan.runtime?.node===expected.node,"Pinned Node runtime");
    check(plan.runtime?.browser===null,"Component scope has no browser");
    const identities={A:plan.baseline,B:plan.candidate,C:plan.baseline,D:plan.baseline};
    for(const [arm,id] of [["A",plan.baseline],["B",plan.candidate]]) {
        check(id?.head===expected.baseline&&id?.tree===expected.baselineTree,arm+" frozen base worktree");
        check(id?.cSha256===(arm==="A"?expected.baselineC:expected.candidateC),arm+" frozen C source");
        check(id?.dependencyLockSha256===expected.dependencyLockSha256,arm+" dependency lock");
        check(hash(id?.wasmSha256)&&id?.trackedWasmSha256===id?.wasmSha256,arm+" tracked/runtime WASM equality");
        check(hash(id?.manifestSha256),arm+" generated manifest identity");
    }
    check(plan.baseline?.wasmSha256===expected.baselineWasm,"Baseline WASM");
    check(plan.candidate?.wasmSha256!==expected.baselineWasm,"Candidate generated WASM differs");
    check(plan.candidate?.wasmSha256===expected.candidateWasm,"Candidate WASM unchanged from original cohort");
    check(plan.candidate?.manifestSha256===expected.candidateManifest,"Candidate manifest unchanged from original cohort");
    check(plan.baseline?.trackedChanges==="","Baseline clean");
    const changed=(plan.candidate?.trackedChanges??"").split("\n").filter(Boolean).map(x=>x.trim().split(/\s+/).slice(1).join(" ")).sort();
    equal(changed,["dev/data/dictionary-wasm/manifest.json","dev/data/dictionary-wasm/term-bank-parser.wasm","ext/js/dictionary/wasm/term-bank-parser.c"],"Exact intentional candidate component overlay");
    const allReceipts=get("PREFIX_CHILD_RECEIPT"),allStatuses=get("PREFIX_CHILD_STATUS");
    const selectedLabels=negative?/^negative-case-[123]-(?:baseline-verification|diagnostic|pair-[0-3]-[ABCD])$/:/^(?:diagnostic|pair-[0-3]-[ABCD])$/;
    const receipts=allReceipts.filter(r=>selectedLabels.test(r.label)),statuses=allStatuses.filter(r=>selectedLabels.test(r.label));
    const byLabel=new Map(receipts.map(r=>[r.label,r]));
    check(byLabel.size===receipts.length,"No duplicate child receipt labels");
    const coreC="ext/js/dictionary/wasm/term-bank-parser.c",coreManifest="dev/data/dictionary-wasm/manifest.json";
    function child(label,arm,diagnostic=false,verification=false) {
        const receipt=byLabel.get(label),data=receipt?.result,id=identities[arm];
        check(!!data,label+" raw child receipt");
        const status=statuses.filter(s=>s.label===label);
        check(status.length===1&&status[0].status==="completed"&&status[0].exitCode===0,label+" successful child status");
        if(!data)return null;
        equal(receipt.command,status[0]?.command,label+" command identity");
        check(receipt.startedEpoch===status[0]?.startedEpoch&&receipt.finishedEpoch===status[0]?.finishedEpoch,label+" status timestamps");
        check(receipt.finishedEpoch>=receipt.startedEpoch,label+" completed timestamp order");
        check(data.sourceRoot===id.root&&data.gitHead===id.head&&data.gitTree===id.tree,label+" selected source root/commit/tree");
        check(data.trackedChanges===id.trackedChanges,label+" tracked overlay identity");
        check(data.node===expected.node,label+" Node version");
        check(data.validateGlossaryTypes===true,label+" strict glossary workload");
        equal(data.flags,negative?{}:(plan.dictionary==="vndb"?{experimentalNativeEscapedKeys:true}:{}),label+" frozen flags");
        check(data.runnerSha256===expected.toolingHashes[negative?"negative-screen.mjs":"screen.mjs"],label+" runner hash");
        check(data.diagnosticFieldsSha256===expected.toolingHashes["diagnostic-fields.json"],label+" diagnostic schema hash");
        check(hash(data.digest),label+" output digest");
        check(hash(data.wasmSha256),label+" WASM identity format");
        if(diagnostic)check(data.diagnosticWasm!==null&&data.wasmSha256!==id.wasmSha256&&!!data.diagnostic,label+" separate diagnostic artifact");
        else check(data.diagnosticWasm===null&&data.wasmSha256===id.wasmSha256&&data.diagnostic===null,label+" uninstrumented timing artifact");
        for(const path of [coreC,coreManifest,"ext/js/dictionary/term-bank-wasm-parser.js","package-lock.json"])check(path in (data.sourceHashes??{}),label+" mandatory source hash "+path);
        for(const [path,digest]of Object.entries(data.sourceHashes??{})) {
            const wanted=path===coreC?id.cSha256:path===coreManifest?id.manifestSha256:expected.baselineSourceHashes[path];
            check(!!wanted&&digest===wanted,label+" exact source hash "+path);
        }
        check(data.warmupPasses===(diagnostic||verification?0:2),label+" excluded warmup count");
        for(const key of ["elapsedMs","cpuMs","inflateMs","inflateCpuMs","parseMs","lookupMs","nativeParseMs","rows","indexBytes"])check(finite(data[key])&&data[key]>=0,label+" finite nonnegative "+key);
        return data;
    }
    function summarize(observations,reported,label) {
        const statistics={};
        for(const metric of ["elapsedMs","cpuMs","parseMs","nativeParseMs","lookupMs"])for(const [kind,a,b]of [["candidate","A","B"],["identicalControl","C","D"]]) {
            const first=[],second=[];
            for(let pair=0;pair<4;pair++) {
                const x=observations.find(o=>o.pair===pair&&o.arm===a)?.result?.[metric];
                const y=observations.find(o=>o.pair===pair&&o.arm===b)?.result?.[metric];
                check(finite(x)&&x>0&&finite(y)&&y>0,label+" positive paired "+metric);
                first.push(x);second.push(y);
            }
            if(first.some(x=>!finite(x))||second.some(x=>!finite(x)))continue;
            const name=kind+"."+metric,s=prefixStats(first,second);statistics[name]=s;
            const published=reported?.[name];
            check(!!published,label+" reported "+name);
            for(const key of ["medianPairedChangePercent","equalWorkChangePercent","fasterPairs"])check(near(s[key],published?.[key]),label+" independently reconstructed "+name+" "+key);
            check(s.pairedChangesPercent.every((x,i)=>near(x,published?.pairedChangesPercent?.[i])),label+" independently reconstructed "+name+" raw pair changes");
        }
        return statistics;
    }
    function verifyDictionaryGroupRoutes(data,label,diagnostic=false) {
        const groups=data.groupReceipts;
        check(Array.isArray(groups)&&groups.length>0,label+" group inventory");
        if(!Array.isArray(groups))return;
        let expectedAttempts=0,expectedDiagnosticRows=0;
        for(const [index,group]of groups.entries()) {
            const bankCount=group.banks?.length;
            check(group.group===index&&Number.isSafeInteger(bankCount)&&bankCount>0&&bankCount<=data.filesPerGroup,label+" fixed group bank count/index "+index);
            if(index<groups.length-1)check(bankCount===data.filesPerGroup,label+" full nonfinal group "+index);
            const expectedAttempt=bankCount>1?1:0;
            check(group.fusedAttempts===expectedAttempt&&group.fusedFallbacks===0,label+" explicit per-group fused/normal route "+index);
            expectedAttempts+=expectedAttempt;
            if(expectedAttempt)expectedDiagnosticRows+=group.rows;
            else {
                check(group.glossaryReuseCount===0&&group.recentContentDedupHitCount===0,label+" singleton normal-route counters "+index);
                if(diagnostic)equal(group.diagnosticBefore,group.diagnosticAfter,label+" singleton leaves fused diagnostic counters unchanged "+index);
            }
        }
        check(data.fusedAttempts===expectedAttempts&&data.fusedFallbacks===0,label+" exact aggregate route counts");
        if(diagnostic)check(data.diagnostic?.rows===expectedDiagnosticRows,label+" fused diagnostic row domain");
    }
    const rawObservations=[],statistics={},mechanics={};
    if(!negative) {
        const dictionary=plan.dictionary,fixture=expected.fixtures[dictionary];
        check(!!fixture,"Known locked corpus");
        const compact=get("PREFIX_SELECTOR_OBSERVATION"),diagnostics=get("PREFIX_SELECTOR_DIAGNOSTIC");
        equal(compact.map(({pair,arm})=>({pair,arm})),schedule,"Raw observed dictionary schedule");
        equal(receipts.map(r=>r.label),["diagnostic",...schedule.map(s=>"pair-"+s.pair+"-"+s.arm)],"Raw dictionary child order including excluded diagnostic");
        const diagnostic=child("diagnostic","B",true);
        if(diagnostic) {
            check(diagnostic.rows===fixture?.rows&&diagnostic.archiveSha256===fixture?.sha256,"Diagnostic locked corpus");
            check(diagnostic.lockSha256===expected.fixtureLockSha256,"Diagnostic fixture lock");
            check(diagnostic.filesPerGroup==={jmdict:7,jitendex:10,vndb:4}[dictionary],"Frozen component grouping");
            verifyDictionaryGroupRoutes(diagnostic,"Excluded dictionary diagnostic",true);
            check(diagnostics.length===1,"Single diagnostic mechanics report");
            equal(diagnostic.diagnostic,diagnostics[0]?.mechanicalCounts,"Full and compact diagnostic counts");
            mechanics[dictionary]=diagnostic.diagnostic;
            if(dictionary==="jmdict") {
                equal(plan.expectedMechanics,expected.mechanics,"Independent frozen JMdict mechanics registration");
                for(const [key,value]of Object.entries(expected.mechanics.jmdict.total))check(diagnostic.diagnostic?.[key]===value,"Independent JMdict mechanics "+key);
                check(diagnostic.groupReceipts?.length===expected.mechanics.jmdict.groups.length,"Independent JMdict group count");
                for(const [i,wanted]of expected.mechanics.jmdict.groups.entries()) {
                    const actual=diagnostic.groupReceipts?.[i],before=actual?.diagnosticBefore??{},after=actual?.diagnosticAfter??{};
                    check(actual?.group===wanted.group,"Independent JMdict diagnostic group "+i);
                    for(const [key,value]of Object.entries(wanted.expected))check(after[key]===(key.startsWith("max")?Math.max(before[key]??0,value):(before[key]??0)+value),"Independent JMdict group "+i+" "+key);
                }
            }
        }
        for(const step of schedule) {
            const label="pair-"+step.pair+"-"+step.arm,data=child(label,step.arm);
            if(!data)continue;
            rawObservations.push({...step,result:data});
            const short=compact.find(r=>r.pair===step.pair&&r.arm===step.arm);
            for(const [key,value]of Object.entries(short??{}))if(!["dictionary","pair","arm"].includes(key))equal(data[key],value,label+" compact/raw "+key);
            if(!diagnostic)continue;
            for(const key of ["rows","digest","indexBytes","archiveSha256","lockSha256","flags","filesPerGroup","recentContentDedupHitCount"])equal(data[key],diagnostic[key],label+" equal work/output "+key);
            const reuseKey=step.arm==="B"?"totalGlossaryReuses":"originalGlossaryReuses";
            check(data.glossaryReuseCount===diagnostic.diagnostic[reuseKey],label+" predicted glossary reuse");
            verifyDictionaryGroupRoutes(data,label);
            check(data.groupReceipts?.length===diagnostic.groupReceipts.length,label+" complete group count");
            for(const key of ["rows","fusedAttempts","fusedFallbacks","glossaryReuseCount","recentContentDedupHitCount"])check(data[key]===data.groupReceipts.reduce((s,g)=>s+g[key],0),label+" group sum "+key);
            for(const [i,group]of data.groupReceipts.entries()) {
                const reference=diagnostic.groupReceipts[i];
                for(const key of ["group","banks","rows","fusedAttempts","fusedFallbacks","recentContentDedupHitCount"])equal(group[key],reference[key],label+" group "+i+" "+key);
                check(group.glossaryReuseCount===reference.diagnosticAfter[reuseKey]-(reference.diagnosticBefore?.[reuseKey]??0),label+" group reuse delta "+i);
            }
        }
        check(rawObservations.length===16,"All 16 dictionary measurements retained");
        statistics[dictionary]=summarize(rawObservations,final?.summary,dictionary);
        check(final?.complete===true,"Dictionary acquisition complete");
        equal(final?.mechanicalCounts,diagnostic?.diagnostic,"Final mechanics unchanged");
    } else {
        equal(plan.casesOrder,[1,2,3],"Frozen synthetic case order");
        check(plan.measuredObservationCount===48,"Frozen 48 negative children");
        equal(plan.prospectiveReview,expected.negativeReview,"Negative rule unchanged from preregistration");
        check(plan.fixtureManifest?.generatorSha256===expected.toolingHashes["negative-fixtures.mjs"],"Frozen negative generator");
        check(plan.fixtureManifest?.node===expected.node,"Fixture generation runtime");
        equal(plan.fixtureManifest?.cases?.map(x=>x.id),[1,2,3],"All fixed synthetic cases");
        const compact=get("PREFIX_NEGATIVE_OBSERVATION"),caseResults=get("PREFIX_NEGATIVE_CASE_RESULT"),diagnostics=get("PREFIX_NEGATIVE_DIAGNOSTIC");
        const wantedOrder=[];
        for(const caseId of [1,2,3]) {
            const prefix="negative-case-"+caseId+"-";
            wantedOrder.push(prefix+"baseline-verification",prefix+"diagnostic",...schedule.map(s=>prefix+"pair-"+s.pair+"-"+s.arm));
            const fixture=plan.fixtureManifest.cases.find(x=>x.id===caseId),observations=[];
            const baseline=child(prefix+"baseline-verification","A",false,true),diagnostic=child(prefix+"diagnostic","B",true);
            const perPassBytes=fixture.banks.reduce((s,b)=>s+b.uncompressedSize,0);
            check(fixture.rows===20000&&fixture.banks.length===2,"Case "+caseId+" fixed 20000-row/two-bank work");
            function verify(data,label,excluded) {
                if(!data)return;
                check(data.complete===true&&data.caseId===caseId,label+" successful case identity");
                check(data.excludedOnly===excluded&&data.measuredRepetitions===(excluded?0:16),label+" measured/excluded role");
                check(data.repetitions?.length===(excluded?1:16)&&data.warmups?.length===(excluded?0:2),label+" all per-pass receipts");
                equal(data.bankIdentities,fixture.banks,label+" exact bank identities");
                check(data.fixtureManifestSha256===plan.fixtureManifestSha256,label+" fixture manifest identity");
                check(data.generatorSha256===expected.toolingHashes["negative-fixtures.mjs"]&&data.outputDigestSha256===expected.toolingHashes["output-digest.mjs"],label+" fixture and digest observer identities");
                check(data.perPassRows===20000,label+" per-pass work");
                for(const key of ["elapsedMs","cpuMs","inflateMs","inflateCpuMs","parseMs","lookupMs","nativeParseMs","rows","indexBytes"])check(data[key]===data.repetitions.reduce((s,r)=>s+r[key],0),label+" independent 16-pass sum "+key);
                for(const [kind,passes]of [["warmup",data.warmups],["measured",data.repetitions]])for(const [i,pass]of passes.entries()) {
                    check(pass.repetition===i,label+" "+kind+" fixed repetition index");
                    if(kind==="warmup")check(pass.excluded===true,label+" warmup excluded");
                    check(pass.rows===20000&&pass.fusedAttempts===1&&pass.fusedFallbacks===0,label+" "+kind+" full fused work "+i);
                    check(pass.glossaryReuseCount===0&&pass.recentContentDedupHitCount===0&&pass.crcReusedBytes===0,label+" full-miss work "+i);
                    check(pass.crcVerifiedBytes===perPassBytes,label+" complete CRC bytes "+i);
                    check(pass.digest===baseline?.digest&&pass.indexBytes===baseline?.perPassIndexBytes,label+" full output parity "+i);
                    for(const metric of ["elapsedMs","cpuMs","inflateMs","inflateCpuMs","parseMs","lookupMs","nativeParseMs"])check(finite(pass[metric])&&pass[metric]>=0,label+" "+kind+" finite "+metric+" "+i);
                }
                equal(data.digest,baseline?.digest,label+" baseline digest");
                equal(data.perPassIndexBytes,baseline?.perPassIndexBytes,label+" baseline index bytes");
            }
            verify(baseline,prefix+"baseline-verification",true);verify(diagnostic,prefix+"diagnostic",true);
            if(diagnostic) {
                mechanics[caseId]=diagnostic.diagnostic;
                for(const [key,value]of Object.entries(fixture.expectedMechanics))check(diagnostic.diagnostic?.[key]===value,"Case "+caseId+" exact diagnostic "+key);
                const independent=caseId===1?{keyIdentityRows:19999,admissions:0,selected:0,fullRejected:0,hits:0,selectedBytes:0}:
                    caseId===2?{keyIdentityRows:19999,admissions:19999,selected:19999,selectedDistance1:19999,fullRejected:19999,hits:0,selectedBytes:19999*240}:
                    {keyIdentityRows:10000,admissions:10000,selected:9999,selectedDistance2:9999,noPrefixCandidate:1,fullRejected:9999,hits:0,selectedBytes:9999*4096,originalLookbackPositiveRows:9999};
                for(const [key,value]of Object.entries(independent))check(diagnostic.diagnostic?.[key]===value,"Case "+caseId+" independent fixture-geometry count "+key);
                equal(diagnostics.find(x=>x.caseId===caseId)?.counts,diagnostic.diagnostic,"Case "+caseId+" compact/raw mechanics");
            }
            const compactCase=compact.filter(x=>x.caseId===caseId);
            equal(compactCase.map(({pair,arm})=>({pair,arm})),schedule,"Case "+caseId+" observed schedule");
            for(const step of schedule) {
                const label=prefix+"pair-"+step.pair+"-"+step.arm,data=child(label,step.arm);
                verify(data,label,false);if(!data)continue;
                const observation={caseId,...step,result:data};observations.push(observation);rawObservations.push(observation);
                const short=compactCase.find(x=>x.pair===step.pair&&x.arm===step.arm);
                for(const [key,value]of Object.entries(short??{}))if(!["caseId","pair","arm"].includes(key))equal(data[key],value,label+" compact/raw "+key);
            }
            check(observations.length===16,"Case "+caseId+" all 16 measured children");
            const published=caseResults.find(x=>x.caseId===caseId);
            const stats=summarize(observations,published?.summary,"Case "+caseId);statistics[caseId]=stats;
            const candidate=stats["candidate.elapsedMs"],control=stats["identicalControl.elapsedMs"];
            const triggered=!!candidate&&!!control&&candidate.medianPairedChangePercent>3&&candidate.slowerPairs===4&&candidate.medianPairedChangePercent>control.largestAbsoluteChangePercent;
            check(published?.assessment?.clearSlowdownRuleTriggered===triggered,"Case "+caseId+" preregistered fail-fast rule");
            check(near(published?.assessment?.largestAbsoluteControlChangePercent,control?.largestAbsoluteChangePercent),"Case "+caseId+" largest absolute control");
            stats.prospectiveNegativeAssessment={clearSlowdownRuleTriggered:triggered,interpretation:triggered?"Hold/reject exact candidate":"No automatic pass: ambiguous negatives remain a hold or qualification limitation; not equivalence proof"};
            equal(final?.cases?.find(x=>x.id===caseId)?.summary,published?.summary,"Case "+caseId+" final statistics unchanged");
        }
        equal(receipts.map(r=>r.label),wantedOrder,"All 54 negative children including six excluded preflights in fixed order");
        check(rawObservations.length===48&&final?.observations===48&&final?.complete===true,"Complete 48-observation negative acquisition");
    }
    return {schemaVersion:1,scope:negative?"Synthetic one-host failure-overhead component screen":"Locked dictionary one-host native component screen",
        dictionary:plan.dictionary??null,negative,complete:final?.complete===true,allLogChecksPass:errors.length===0,errors,
        source:{baseline:plan.baseline,candidate:plan.candidate,tooling:plan.tooling,runtime:plan.runtime},
        measuredObservationCount:rawObservations.length,rawChildReceiptCount:receipts.length,mechanics,statistics,rawObservations,failures,
        limits:["Original artifact byte/hash and native oracle audits are separate responsibilities.","No complete browser import or memory qualification.","No pooling hosts/corpora, timing-directed trimming, substitution or retuning."]};
}
