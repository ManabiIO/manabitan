import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = process.cwd()
const out = path.resolve(process.env.WTY_OUTPUT ?? 'builds/wty-next-screen')
mkdirSync(out, {recursive:true})
const dictionary = process.env.WTY_DICTIONARY ?? 'wty-en-en'
const variants = {
    control: {},
    keys: {experimentalKnownObjectKeys:true},
    skip: {experimentalSkipFusedParse:true},
    retain: {experimentalRetainedFusedFallback:true},
    keysRetain: {experimentalKnownObjectKeys:true, experimentalRetainedFusedFallback:true},
    keysSkip: {experimentalKnownObjectKeys:true, experimentalSkipFusedParse:true},
}
const selected = (process.argv[2] ?? 'control,keys,skip,retain,keysRetain').split(',')
const blocks = Number(process.argv[3] ?? 2)
assert.ok(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 24)
for (const id of selected) assert.ok(Object.hasOwn(variants,id), id)
const {createBenchmarkEnvironment, extractImportResult, median} = await import(pathToFileURL(path.join(root,'dev/perf/benchmark-support.js')).href)
const fixture = JSON.parse(readFileSync('test/perf/dictionaries.lock.json','utf8')).dictionaries[dictionary]
assert.ok(fixture)
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')
assert.equal(hash(path.join('builds/e2e-dictionary-cache',fixture.cacheFile)),fixture.sha256)
const files = ['builds/manabitan-chrome-dev.zip','ext/lib/term-bank-parser.wasm','ext/js/dictionary/wasm/term-bank-parser.c','ext/js/dictionary/term-bank-wasm-parser.js','ext/js/dictionary/term-bank-experiments.js','test/chromium/extension-two-dictionary-import.e2e.js','dev/perf/benchmark-support.js','test/perf/dictionaries.lock.json','package-lock.json']
const identities = Object.fromEntries(files.map(p => [p,hash(p)]))
const plan = []
for (const id of selected) for (const arm of ['A','B']) plan.push({variant:id,arm,block:0,warmup:true,flags:arm==='A'?{}:variants[id]})
for (let block=1;block<=blocks;block++) for (const id of selected) for (const arm of ['A','B','B','A']) plan.push({variant:id,arm,block,warmup:false,flags:arm==='A'?{}:variants[id]})
const summary = {schemaVersion:1,status:'running',startedAt:new Date().toISOString(),dictionary,fixture,blocks,identities,driverHash:hash(process.argv[1]),node:process.version,cpus:os.cpus(),totalMemory:os.totalmem(),plan,observations:[],results:{},rules:'Same build, experimental flags off/on. Fresh browser and OPFS. Fixed ABBA blocks and excluded warmups. Interleaved A/A control. No retries, outlier removal, profiling or sampling. Browser file-input change through post-UI completion. Common shared-token decoder correction in both arms.'}
const persist = () => writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n')
let work = null
persist()
try {
    for (const [index,entry] of plan.entries()) {
        const id = `${String(index+1).padStart(3,'0')}-${entry.warmup?'warmup':`block${entry.block}`}-${entry.variant}-${entry.arm}`
        const reportPath = path.join(out,`${id}.html`)
        const env = createBenchmarkEnvironment(process.env, {
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK:'1',MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS:'1',
            MANABITAN_E2E_IMPORT_FLAGS_JSON:JSON.stringify(entry.flags),MANABITAN_E2E_SKIP_BUILD:'1',
            MANABITAN_E2E_IMPORT_BENCH_QUICK:'1',MANABITAN_E2E_IMPORT_BENCH_DICTIONARY:dictionary,
            MANABITAN_E2E_PHASE_PROFILING:'0',MANABITAN_E2E_PHASE_SCREENSHOTS:'0',MANABITAN_E2E_PROCESS_SAMPLING:'0',
            MANABITAN_CHROMIUM_E2E_REPORT:reportPath,
        })
        const fd=openSync(path.join(out,`${id}.log`),'wx')
        let child
        try {child=spawnSync(process.execPath,['test/chromium/extension-two-dictionary-import.e2e.js'],{cwd:root,env,stdio:['ignore',fd,fd],timeout:600000})}
        finally {closeSync(fd)}
        assert.equal(child.error,undefined,`${id}: ${child.error?.message}`)
        assert.equal(child.status,0,`${id}: read its retained log`)
        const reportFile=reportPath.replace(/\.html$/,'.json')
        const report=JSON.parse(readFileSync(reportFile,'utf8'))
        const actual=extractImportResult(report,dictionary,fixture,false,entry.flags)
        const phases=actual.importDebug.importerPhaseTimings
        const parser=phases.find(p=>p.phase.startsWith('term-file-fast-path:'))?.details
        const finalization=phases.find(p=>p.phase==='bulk-finalization')?.details
        assert.ok(parser && finalization)
        if(entry.flags.experimentalSkipFusedParse) assert.equal(parser.parserFusedAttempts,0)
        if(dictionary==='wty-en-en' && entry.flags.experimentalRetainedFusedFallback) assert.ok(parser.parserFusedFallbacks>0)
        const signature={rows:parser.rows,banks:parser.batchedFileCount,sourceBytes:parser.parserSourceUncompressedBytes,
            contentBytes:parser.parserEncodedContentBytes,storedContentBytes:finalization.termContentTotalWriteBytes,
            storedRecordBytes:finalization.termRecordTotalWriteBytes,dedupUniqueCount:parser.dedupUniqueCount}
        if(work===null) work=signature
        if(dictionary==='wty-en-en') assert.deepEqual(signature,work,'Import work/content write totals changed')
        summary.observations.push({...entry,id,totalImportMs:actual.totalImportMs,workerImportMs:actual.workerImportMs,
            automationObservedImportMs:actual.automationObservedImportMs,browser:report.browserVersion,validation:actual.validation,
            parser,finalization,signature,report:path.basename(reportFile),reportSha256:hash(reportFile)})
        persist()
        console.log(`${id}: ${actual.totalImportMs.toFixed(2)} ms`)
    }
    for(const p of files) assert.equal(hash(p),identities[p],`Measured input changed: ${p}`)
    for(const variant of selected) {
        const rows=summary.observations.filter(r=>r.variant===variant && !r.warmup)
        const paired=[],blockPercentages=[]
        for(let i=0;i<rows.length;i+=4) {
            const block=rows.slice(i,i+4)
            assert.deepEqual(block.map(r=>r.arm),['A','B','B','A'])
            const [a1,b1,b2,a2]=block.map(r=>r.totalImportMs)
            paired.push(100*(b1/a1-1),100*(b2/a2-1))
            blockPercentages.push(100*((b1+b2)/(a1+a2)-1))
        }
        const a=rows.filter(r=>r.arm==='A').map(r=>r.totalImportMs)
        const b=rows.filter(r=>r.arm==='B').map(r=>r.totalImportMs)
        const sum=values=>values.reduce((x,y)=>x+y,0)
        summary.results[variant]={pairedMedianPercent:median(paired),pairedPercentages:paired,blockPercentages,
            baselineMedianMs:median(a),candidateMedianMs:median(b),equalWorkPercent:100*(sum(b)/sum(a)-1),
            pairsFaster:paired.filter(x=>x<0).length,medianAbsolutePairPercent:median(paired.map(Math.abs))}
    }
    summary.status='success'
} catch(error) {summary.status='failed';summary.error=error.stack;throw error}
finally {persist()}
console.log(JSON.stringify(summary.results,null,2))
