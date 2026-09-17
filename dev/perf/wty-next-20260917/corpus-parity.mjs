import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const root=process.cwd()
const output=path.resolve(process.argv[3]??'builds/wty-parity')
const options=JSON.parse(process.argv[2]??'{"experimentalRetainedFusedFallback":true}')
mkdirSync(output,{recursive:true})
const fixture=JSON.parse(readFileSync('test/perf/dictionaries.lock.json','utf8')).dictionaries['wty-en-en']
const archivePath=path.resolve('builds/e2e-dictionary-cache',fixture.cacheFile)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(readFileSync(archivePath)),fixture.sha256)
const manifest=JSON.parse(execFileSync('python3',['-c',String.raw`
import json,struct,sys,zipfile
from pathlib import Path
archive=Path(sys.argv[1]); out=Path(sys.argv[2]); out.mkdir(parents=True,exist_ok=True)
result=[]
with archive.open('rb') as raw, zipfile.ZipFile(archive) as z:
    banks=sorted((i for i in z.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')),key=lambda i:int(i.filename[10:-5]))
    assert len(banks)==67
    for info in banks:
        raw.seek(info.header_offset)
        header=raw.read(30)
        assert header[:4]==b'PK\x03\x04'
        name_length,extra_length=struct.unpack_from('<HH',header,26)
        raw.seek(name_length+extra_length,1)
        payload=raw.read(info.compress_size)
        assert len(payload)==info.compress_size and info.compress_type in (0,8)
        file=out/(info.filename+'.raw')
        file.write_bytes(payload)
        result.append({'filename':info.filename,'path':str(file),'compressionMethod':info.compress_type,'compressedSize':info.compress_size,'uncompressedSize':info.file_size,'signature':info.CRC})
print(json.dumps(result))
`,archivePath,path.join(output,'compressed-input')],{encoding:'utf8'}))
const {setTermBankWasmModule,inflateCompressedTermBankSourcesWasm,parseTermBankWithWasmColumnChunks,consumeLastTermBankWasmParseProfile}=await import(pathToFileURL(path.join(root,'ext/js/dictionary/term-bank-wasm-parser.js')).href)
const wasm=readFileSync('ext/lib/term-bank-parser.wasm')
setTermBankWasmModule(await WebAssembly.compile(wasm))
const report={status:'running',fixture,options,wasmSha256:sha(wasm),groups:[],modes:[]}
function persist(){writeFileSync(path.join(output,'parity.json'),JSON.stringify(report,null,2)+'\n')}
async function parse(sources,experiments){
    const preloadedSource=await inflateCompressedTermBankSourcesWasm(sources,experiments)
    const sourceDigest=sha(new Uint8Array(preloadedSource.wasm.memory.buffer,preloadedSource.jsonPtr,preloadedSource.jsonLength))
    const digest=createHash('sha256')
    let rows=0,contentBytes=0,mediaRows=0
    const header=Buffer.alloc(32)
    const length=Buffer.alloc(4)
    const addText=text=>{const bytes=Buffer.from(text);length.writeUInt32LE(bytes.length);digest.update(length).update(bytes)}
    await parseTermBankWithWasmColumnChunks(new Uint8Array(0),3,chunk=>{
        const plan=chunk.termRecordPreinternedPlan
        assert.ok(plan)
        const offsets=plan.stringOffsets??new Uint32Array(plan.stringLengths.length)
        if(!plan.stringOffsets) for(let i=1;i<offsets.length;i++) offsets[i]=offsets[i-1]+plan.stringLengths[i-1]
        const key=index=>plan.stringsBuffer.subarray(offsets[index],offsets[index]+plan.stringLengths[index])
        for(let i=0;i<chunk.rowCount;i++){
            const expression=key(plan.expressionIndexes[i]),reading=key(plan.readingIndexes[i])
            let content=chunk.contentBytesList[i],h1=chunk.contentHash1List[i],h2=chunk.contentHash2List[i]
            if(chunk.contentBytesBuffer && chunk.contentMetaList){
                const meta=chunk.contentMetaList,start=meta[i*4]+(chunk.contentBytesBaseOffset??0),size=meta[i*4+1]
                assert.ok(start>=0 && size<=chunk.contentBytesBuffer.length-start)
                content=chunk.contentBytesBuffer.subarray(start,start+size);h1=meta[i*4+2];h2=meta[i*4+3]
            }
            const values=[expression.length,reading.length,chunk.scoreList[i],chunk.sequenceList[i],chunk.readingEqualsExpressionList[i]?1:0,content.length,h1,h2]
            values.forEach((v,j)=>header.writeUInt32LE(v>>>0,j*4))
            digest.update(header).update(expression).update(reading).update(content)
            contentBytes+=content.length
            const media=chunk.mediaRows.filter(m=>m.index===i)
            length.writeUInt32LE(media.length);digest.update(length)
            for(const {row} of media){addText(row.expression);addText(row.reading);addText(row.glossaryJson);addText(sha(row.termEntryContentBytes));mediaRows++}
        }
        rows+=chunk.rowCount
    },8192,{...experiments,preloadedSource,computeContentHashes:true,emitContentSlab:true,emitTokenBinaryContent:true,mediaHintFastScan:true,singleChunk:true,prepareLookupIndexes:false})
    const profile=consumeLastTermBankWasmParseProfile()
    assert.ok(profile)
    return {rows,contentBytes,mediaRows,sourceDigest,sha256:digest.digest('hex'),profile}
}
try{
    for(const experimentalTermBankSpans of [false,true]){
        let rows=0,fallbacks=0
        for(let start=0;start<manifest.length;start+=2){
            const entries=manifest.slice(start,start+2)
            const sources=entries.map(entry=>({...entry,bytes:new Uint8Array(readFileSync(entry.path))}))
            const baseline=await parse(sources,{experimentalTermBankSpans})
            const candidate=await parse(sources,{...options,experimentalTermBankSpans})
            for(const field of ['rows','contentBytes','mediaRows','sourceDigest','sha256']) assert.equal(candidate[field],baseline[field],`${entries[0].filename}: ${field}`)
            rows+=baseline.rows;fallbacks+=candidate.profile.fusedParseFallbacks??0
            report.groups.push({banks:entries.map(e=>e.filename),experimentalTermBankSpans,baseline,candidate})
            persist()
            console.log(`${experimentalTermBankSpans?'spans':'joined'} ${entries.map(e=>e.filename).join('+')}: ${baseline.rows} exact rows`)
        }
        assert.equal(rows,fixture.termRows)
        if(options.experimentalRetainedFusedFallback) assert.ok(fallbacks>0,'Retained fallback must execute on this qualification path')
        report.modes.push({experimentalTermBankSpans,rows,fallbacks})
    }
    report.status='success'
}catch(error){report.status='failed';report.error=error.stack;throw error}
finally{persist()}
