import {openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {setImmediate} from 'node:timers/promises'
import path from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'

const root = process.cwd()
const baseline = path.resolve(root, '../manabitan-base')
const sourceName = 'ext/js/dictionary/dense-zip-directory.js'
const fixture = 'builds/e2e-dictionary-cache/vndb_characters_by_bee.zip'
const script = fileURLToPath(import.meta.url)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const median = (values) => { const sorted = [...values].sort((a,b) => a-b); const mid = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2 }

if (process.argv[2] === 'child') {
    if (typeof global.gc !== 'function') throw new Error('Run under --expose-gc')
    const arm = process.argv[3]
    const directory = arm === 'B' ? root : baseline
    const {readDenseZipDirectory} = await import(pathToFileURL(path.join(directory, sourceName)))
    const archive = await openAsBlob(path.join(root, fixture))
    const gc = async () => { for (let i=0;i<3;i++) { await setImmediate(); global.gc() } await setImmediate() }
    let retained = null
    for (let i=0;i<2;i++) { retained = await readDenseZipDirectory(archive); if (retained?.length !== 147237) throw new Error('Catalog count'); retained = null; await gc() }
    const before = process.memoryUsage()
    const start = performance.now()
    retained = await readDenseZipDirectory(archive)
    const durationMs = performance.now()-start
    if (retained?.length !== 147237) throw new Error('Catalog count')
    await gc()
    const after = process.memoryUsage()
    const deltas = Object.fromEntries(Object.keys(after).map(key => [key, after[key]-before[key]]))
    console.log(JSON.stringify({arm,runtime:process.versions,sourceSha256:hash(await readFile(path.join(directory,sourceName))),durationMs,before,after,deltas,retainedRows:retained.length,firstName:retained[0].filename,lastName:retained.at(-1).filename,filenameArenaBytes:retained[0].rawFilename.buffer.byteLength}))
} else {
    // Two excluded warmup catalogs and one measurement in each fresh process.
    // Fixed complete counterbalance keeps the unchanged A/C controls visible.
    const orders = ['ABC','BCA','CAB','ACB','CBA','BAC']
    const observations = []
    for (let block=0;block<orders.length;block++) {
        for (const arm of orders[block]) {
            const child=spawnSync(process.execPath,['--expose-gc',script,'child',arm],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024})
            const observation={block,arm,exitStatus:child.status,stderr:child.stderr,stdout:child.stdout}
            if (child.status===0) observation.result=JSON.parse(child.stdout)
            observations.push(observation)
            await writeFile(path.join(root,'builds/perf/lazy-filename-20261125/measure-raw.json'),JSON.stringify({schemaVersion:1,orders,scope:'Fresh-process component catalog construction and forced-GC retained memory. Not browser peak memory or end-to-end import timing.',observations},null,2)+'\n')
            if(child.status!==0) throw new Error(`Failed ${block}/${arm}: ${child.stderr}`)
        }
    }
    const results = observations.map(x=>({...x.result,block:x.block}))
    const arms=Object.fromEntries(['A','B','C'].map(arm=>{
        const rows=results.filter(x=>x.arm===arm)
        return [arm,{samples:rows.length,durationMs:median(rows.map(x=>x.durationMs)),retainedHeap:median(rows.map(x=>x.deltas.heapUsed)),retainedExternal:median(rows.map(x=>x.deltas.external)),retainedArrayBuffers:median(rows.map(x=>x.deltas.arrayBuffers)),retainedHeapPlusExternal:median(rows.map(x=>x.deltas.heapUsed+x.deltas.external))}]
    }))
    const pairs=[]
    for(let block=0;block<orders.length;block++){
        const rows=Object.fromEntries(results.filter(x=>x.block===block).map(x=>[x.arm,x]))
        pairs.push({block,baTime:100*(rows.B.durationMs/rows.A.durationMs-1),bcTime:100*(rows.B.durationMs/rows.C.durationMs-1),caTime:100*(rows.C.durationMs/rows.A.durationMs-1),baRetainedBytes:rows.B.deltas.heapUsed+rows.B.deltas.external-rows.A.deltas.heapUsed-rows.A.deltas.external,bcRetainedBytes:rows.B.deltas.heapUsed+rows.B.deltas.external-rows.C.deltas.heapUsed-rows.C.deltas.external})
    }
    const report={arms,pairs,pairedMedians:Object.fromEntries(['baTime','bcTime','caTime','baRetainedBytes','bcRetainedBytes'].map(key=>[key,median(pairs.map(p=>p[key]))]))}
    await writeFile(path.join(root,'builds/perf/lazy-filename-20261125/measure-summary.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report))
}
