import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const root=process.cwd()
const out=path.resolve(process.env.THREE_OUTPUT??'builds/compression-screen')
mkdirSync(out,{recursive:true})
const dictionary=process.env.THREE_DICTIONARY??'wty-en-en'
const variants={control:{},fast2:{experimentalZstdFast2:true},workers2:{experimentalCompressionWorkers2:true},generic:{experimentalGenericSpanCompression:true},both:{experimentalZstdFast2:true,experimentalGenericSpanCompression:true}}
const selected=(process.argv[2]??'control,fast2,workers2,generic,both').split(',')
const blocks=Number(process.argv[3]??2)
assert.ok(Number.isSafeInteger(blocks)&&blocks>=1&&blocks<=12)
assert.equal(new Set(selected).size,selected.length)
for(const id of selected) assert.ok(Object.hasOwn(variants,id),id)
const {createBenchmarkEnvironment,extractImportResult,median}=await import(pathToFileURL(path.join(root,'dev/perf/benchmark-support.js')).href)
const {snapshotTermBankExperiments}=await import(pathToFileURL(path.join(root,'ext/js/dictionary/term-bank-experiments.js')).href)
const fixture=JSON.parse(readFileSync('test/perf/dictionaries.lock.json','utf8')).dictionaries[dictionary]
assert.ok(fixture)
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
assert.equal(hash(path.join('builds/e2e-dictionary-cache',fixture.cacheFile)),fixture.sha256)
const files=['builds/manabitan-chrome-dev.zip','ext/lib/term-bank-parser.wasm','ext/lib/zstd-wasm.js','ext/js/dictionary/term-bank-wasm-parser.js','ext/js/dictionary/term-bank-experiments.js','ext/js/dictionary/dictionary-importer.js','ext/js/dictionary/dictionary-database.js','ext/js/dictionary/term-content-block-store.js','ext/js/dictionary/zstd-term-content.js','ext/js/dictionary/zstd-term-content-compression-worker.js','types/ext/dictionary-importer.d.ts','test/term-bank-experiments.test.js','test/term-content-block-store.test.js','test/zstd-term-content-pool.test.js','test/chromium/extension-two-dictionary-import.e2e.js','dev/perf/benchmark-support.js','test/perf/dictionaries.lock.json','package-lock.json']
const identities=Object.fromEntries(files.map(p=>[p,hash(p)]))
for(const id of selected) for(const [key,value] of Object.entries(variants[id])) assert.equal(snapshotTermBankExperiments(variants[id])[key],value)
const plan=[]
for(const id of selected) for(const arm of ['A','B']) plan.push({variant:id,arm,block:0,warmup:true,flags:arm==='A'?{}:variants[id]})
for(let block=1;block<=blocks;block++) for(const id of selected) for(const arm of ['A','B','B','A']) plan.push({variant:id,arm,block,warmup:false,flags:arm==='A'?{}:variants[id]})
const summary={schemaVersion:1,status:'running',base:'2f407e86fae0d3e39f506e6b1ce30886697698ea',startedAt:new Date().toISOString(),dictionary,fixture,blocks,identities,driverHash:hash(process.argv[1]),node:process.version,cpus:os.cpus(),totalMemory:os.totalmem(),plan,observations:[],results:{},rules:'Same binary flag off/on. Fresh browser profile and OPFS per observation. Fixed ABBA, excluded full warmups and interleaved A/A controls. No retries, trimming, sampling, profiling or tracing. Browser file-input event through post-UI completion. Logical work must match; compressed content size is measured, not forced to match. No host or dictionary pooling.'}
const persist=()=>writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n')
let work=null
persist()
try{
    for(const [index,entry] of plan.entries()){
        const id=`${String(index+1).padStart(3,'0')}-${entry.warmup?'warmup':`block${entry.block}`}-${entry.variant}-${entry.arm}`
        const reportPath=path.join(out,`${id}.html`)
        const env=createBenchmarkEnvironment(process.env,{
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK:'1',MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS:'1',MANABITAN_E2E_IMPORT_FLAGS_JSON:JSON.stringify(entry.flags),MANABITAN_E2E_SKIP_BUILD:'1',MANABITAN_E2E_IMPORT_BENCH_QUICK:'1',MANABITAN_E2E_IMPORT_BENCH_DICTIONARY:dictionary,MANABITAN_E2E_PHASE_PROFILING:'0',MANABITAN_E2E_PHASE_SCREENSHOTS:'0',MANABITAN_E2E_PROCESS_SAMPLING:'0',MANABITAN_CHROMIUM_E2E_REPORT:reportPath,
        })
        const fd=openSync(path.join(out,`${id}.log`),'wx')
        let child
        try{child=spawnSync(process.execPath,['test/chromium/extension-two-dictionary-import.e2e.js'],{cwd:root,env,stdio:['ignore',fd,fd],timeout:600000})}finally{closeSync(fd)}
        assert.equal(child.error,undefined,`${id}: ${child.error?.message}`)
        assert.equal(child.status,0,`${id}: inspect retained log`)
        const reportFile=reportPath.replace(/\.html$/,'.json')
        const report=JSON.parse(readFileSync(reportFile,'utf8'))
        const actual=extractImportResult(report,dictionary,fixture,false,entry.flags)
        assert.equal(actual.importDebug.openStorageDiagnostics.mode,'opfs-sahpool')
        const phases=actual.importDebug.importerPhaseTimings
        const parser=phases.find(p=>p.phase.startsWith('term-file-fast-path:'))?.details
        const finalization=phases.find(p=>p.phase==='bulk-finalization')?.details
        assert.ok(parser&&finalization)
        assert.equal(finalization.ok,true)
        assert.deepEqual(finalization.compressionExperiments,snapshotTermBankExperiments(entry.flags),'Storage-side flags differ')
        const signature={rows:parser.rows,banks:parser.batchedFileCount,sourceBytes:parser.parserSourceUncompressedBytes,compressedSourceBytes:parser.parserSourceCompressedBytes,contentBytes:parser.parserEncodedContentBytes,storedRecordBytes:finalization.termRecordTotalWriteBytes,lookupBytes:finalization.termRecordLookupIndexWriteBytes,dedupUniqueCount:parser.dedupUniqueCount,groups:parser.parserParallelGroupCount,workers:parser.parserParallelWorkerCount}
        assert.equal(signature.rows,fixture.termRows)
        if(work===null)work=signature
        assert.deepEqual(signature,work,'Logical import work changed')
        summary.observations.push({...entry,id,totalImportMs:actual.totalImportMs,workerImportMs:actual.workerImportMs,automationObservedImportMs:actual.automationObservedImportMs,browser:report.browserVersion,validation:actual.validation,parser,finalization,signature,report:path.basename(reportFile),reportSha256:hash(reportFile)})
        persist()
        console.log(`${id}: ${actual.totalImportMs.toFixed(2)} ms; ${finalization.termContentTotalWriteBytes} content bytes`)
    }
    for(const p of files)assert.equal(hash(p),identities[p],`Input changed: ${p}`)
    for(const variant of selected){
        const rows=summary.observations.filter(r=>r.variant===variant&&!r.warmup)
        assert.equal(rows.length,blocks*4)
        const paired=[],blockPercentages=[],storagePercentages=[]
        for(let i=0;i<rows.length;i+=4){
            const block=rows.slice(i,i+4)
            assert.deepEqual(block.map(r=>r.arm),['A','B','B','A'])
            const [a1,b1,b2,a2]=block.map(r=>r.totalImportMs)
            paired.push(100*(b1/a1-1),100*(b2/a2-1))
            blockPercentages.push(100*((b1+b2)/(a1+a2)-1))
            const [as1,bs1,bs2,as2]=block.map(r=>r.finalization.termContentTotalWriteBytes)
            storagePercentages.push(100*((bs1+bs2)/(as1+as2)-1))
        }
        const a=rows.filter(r=>r.arm==='A').map(r=>r.totalImportMs)
        const b=rows.filter(r=>r.arm==='B').map(r=>r.totalImportMs)
        const sum=xs=>xs.reduce((x,y)=>x+y,0)
        summary.results[variant]={pairedMedianPercent:median(paired),pairedPercentages:paired,blockPercentages,baselineMedianMs:median(a),candidateMedianMs:median(b),equalWorkPercent:100*(sum(b)/sum(a)-1),pairsFaster:paired.filter(x=>x<0).length,medianAbsolutePairPercent:median(paired.map(Math.abs)),storageMedianPercent:median(storagePercentages),storagePercentages}
    }
    summary.status='success'
}catch(error){summary.status='failed';summary.error=error.stack;throw error}finally{persist()}
console.log(JSON.stringify(summary.results,null,2))
