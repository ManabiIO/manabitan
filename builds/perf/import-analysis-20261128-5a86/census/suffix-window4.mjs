import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js';

const root = process.cwd();
const outputRoot = process.argv[2];
if (!outputRoot) { throw new Error('Output directory required'); }
await mkdir(outputRoot, {recursive: true});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const locksBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'));
const locks = JSON.parse(locksBytes).dictionaries;
const runnerBytes = await readFile(fileURLToPath(import.meta.url));
const isSpace = (byte) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
function skipSpace(bytes, offset) {
    while (isSpace(bytes[offset])) { ++offset; }
    return offset;
}
function stringEnd(bytes, start) {
    let offset = start + 1;
    while (offset < bytes.length) {
        const quote = bytes.indexOf(34, offset);
        if (quote < 0) { throw new Error('Unterminated string'); }
        let precedingEscapes = 0;
        for (let i = quote - 1; i > start && bytes[i] === 92; --i) { ++precedingEscapes; }
        if ((precedingEscapes & 1) === 0) { return quote + 1; }
        offset = quote + 1;
    }
    throw new Error('Unterminated string');
}
function valueEnd(bytes, start) {
    const first = bytes[start];
    if (first === 34) { return stringEnd(bytes, start); }
    if (first === 91 || first === 123) {
        let depth = 1;
        for (let offset = start + 1; offset < bytes.length; ++offset) {
            const byte = bytes[offset];
            if (byte === 34) { offset = stringEnd(bytes, offset) - 1; }
            else if (byte === 91 || byte === 123) { ++depth; }
            else if ((byte === 93 || byte === 125) && --depth === 0) { return offset + 1; }
        }
        throw new Error('Unterminated composite');
    }
    let offset = start;
    while (offset < bytes.length && bytes[offset] !== 44 && bytes[offset] !== 93 && !isSpace(bytes[offset])) { ++offset; }
    if (offset === start) { throw new Error('Empty scalar'); }
    return offset;
}
function* scanBank(bytes) {
    const semanticRows = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(semanticRows)) { throw new Error('Invalid bank root'); }
    let rowIndex = 0;
    let offset = skipSpace(bytes, 0);
    if (bytes[offset++] !== 91) { throw new Error('Missing bank array'); }
    while (true) {
        offset = skipSpace(bytes, offset);
        if (bytes[offset] === 93) { ++offset; break; }
        if (bytes[offset++] !== 91) { throw new Error('Missing row array'); }
        const fields = [];
        const ends = [];
        for (let field = 0; field < 8; ++field) {
            offset = skipSpace(bytes, offset);
            const start = offset;
            offset = valueEnd(bytes, offset);
            fields.push(bytes.subarray(start, offset));
            ends.push(offset);
            offset = skipSpace(bytes, offset);
            if (field < 7 && bytes[offset++] !== 44) { throw new Error('Missing row comma'); }
        }
        if (bytes[offset++] !== 93) { throw new Error('Missing row end'); }
        const semantic = semanticRows[rowIndex++];
        if (!Array.isArray(semantic) || semantic.length !== 8) { throw new Error('Unexpected semantic row length'); }
        yield {fields, semantic, suffixes: Object.fromEntries([2, 5, 6, 7].map((field) => [field, bytes.subarray(ends[field - 1], offset)])),
            probeWindow: bytes.subarray(ends[4]), rowIndex};
        offset = skipSpace(bytes, offset);
        if (bytes[offset] === 44) { ++offset; }
        else if (bytes[offset] !== 93) { throw new Error('Invalid bank row separator'); }
    }
    if (skipSpace(bytes, offset) !== bytes.length || rowIndex !== semanticRows.length) { throw new Error('Incomplete bank traversal'); }
}
const selfTestRows = [...scanBank(Buffer.from(JSON.stringify([
    ['a', '', '', '', 1, ['same', {type: 'text', text: 'quote " and slash \\'}], 10, ''],
    ['b', '', '', '', 2, ['same', {type: 'text', text: 'quote " and slash \\'}], 10, ''],
])))];
if (selfTestRows.length !== 2 || selfTestRows[0].suffixes[2].equals(selfTestRows[1].suffixes[2]) ||
    !selfTestRows[0].suffixes[5].equals(selfTestRows[1].suffixes[5]) ||
    !selfTestRows[0].suffixes[6].equals(selfTestRows[1].suffixes[6]) ||
    !selfTestRows[0].suffixes[7].equals(selfTestRows[1].suffixes[7])) { throw new Error('Raw suffix scanner self-test failed'); }


for (const dictionary of ['jmdict', 'jitendex']) {
    const spec=locks[dictionary];
    const archive=await readFile(path.join(root,'builds/e2e-dictionary-cache',spec.cacheFile));
    if(sha256(archive)!==spec.sha256)throw new Error('archive mismatch');
    const reader=new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
    const prior=[];
    const counts={rows:0,fullSuffixMatches:0,fullSuffixMatchBytes:0,incrementalRows:0,incrementalGlossaryBytes:0,baselineWitnessRows:0,baselineWitnessBytes:0,rawContentMatches:0,fullSuffixDistances:[0,0,0,0],incrementalDistances:[0,0,0,0],fullSuffixSmallGlossary:0,incrementalSmallGlossary:0,probeCandidates:0,probeSampleBytes:0,probeFullBytes:0,boundsRejects:0};
    let budget=0,streak=0;
    const bytesCompared=(a,b)=>{let i=0;while(i<a.length&&a[i]===b[i])i++;return {equal:i===a.length,bytes:Math.min(i+1,a.length)};};
    try {
      const entries=(await reader.getEntries()).filter(e=>/^term_bank_\d+\.json$/.test(e.filename)).sort((a,b)=>Number(a.filename.slice(10,-5))-Number(b.filename.slice(10,-5)));
      for(const entry of entries){
        const u=await entry.getData(new Uint8ArrayWriter(),{useWebWorkers:false,checkSignature:true});
        const bytes=Buffer.from(u.buffer,u.byteOffset,u.byteLength);
        for(const row of scanBank(bytes)){
          const lookback=budget>0?4:(prior.length&&prior.at(-1).fields[5].length>=512?1:0);
          let baselineWitness=-1,fullMatch=-1,contentMatch=-1;
          for(let k=1;k<=Math.min(prior.length,4);k++){
            const p=prior.at(-k);
            if(k<=lookback&&baselineWitness<0&&p.fields[5].equals(row.fields[5]))baselineWitness=k;
            if(contentMatch<0&&[2,3,5,7].every(f=>p.fields[f].equals(row.fields[f])))contentMatch=k;
            if(fullMatch>=0)continue;
            const suffix=p.suffixes[5],n=suffix.length,window=row.probeWindow;
            counts.probeCandidates++;
            if(n>window.length){counts.boundsRejects++;continue;}
            const sample=Math.min(n,8);
            let r=bytesCompared(suffix.subarray(n-sample),window.subarray(n-sample,n));counts.probeSampleBytes+=r.bytes;if(!r.equal)continue;
            const mid=Math.floor((n-sample)/2);
            r=bytesCompared(suffix.subarray(mid,mid+sample),window.subarray(mid,mid+sample));counts.probeSampleBytes+=r.bytes;if(!r.equal)continue;
            r=bytesCompared(suffix,window.subarray(0,n));counts.probeFullBytes+=r.bytes;
            if(r.equal){if(!suffix.equals(row.suffixes[5]))throw new Error('prefix false positive');fullMatch=k;}
          }
          if(baselineWitness>0){counts.baselineWitnessRows++;counts.baselineWitnessBytes+=row.fields[5].length;budget=4;}
          else if(budget>0)budget--;
          if(contentMatch>0){counts.rawContentMatches++;if(streak>=4||++streak>=4)budget=4;}else streak=0;
          if(fullMatch>0){
            counts.fullSuffixMatches++;counts.fullSuffixMatchBytes+=row.suffixes[5].length;counts.fullSuffixDistances[fullMatch-1]++;
            if(row.fields[5].length<512)counts.fullSuffixSmallGlossary++;
            if(baselineWitness<0){counts.incrementalRows++;counts.incrementalGlossaryBytes+=row.fields[5].length;counts.incrementalDistances[fullMatch-1]++;if(row.fields[5].length<512)counts.incrementalSmallGlossary++;}
          }
          counts.rows++;
          prior.push(row);if(prior.length>4)prior.shift();
        }
      }
    }finally{await reader.close();}
    if(counts.rows!==spec.termRows)throw new Error('rows mismatch');
    const report={dictionary,source:'9e10d3b3fcf66d344ab31bc42c9b522fa5215da2',node:process.version,archiveSha256:spec.sha256,runnerSha256:sha256(runnerBytes),counts,scope:'Diagnostic exact raw suffix matching within existing four-row content window; all source-bank boundaries included. Baseline witness gate modeled with raw content equality, not instrumented production; compressed groups reset several times so small boundary differences expected. No timing claim.'};
    await writeFile(path.join(outputRoot,dictionary+'-suffix-window4.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
}
