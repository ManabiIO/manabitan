#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only AST/input census for exact reconstructed historical/current bundles.
import assert from 'node:assert/strict';
import {readFile, writeFile, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root='/workspace/scratch/da6c4dbd0097/baseline';
const dependencyRoot='/workspace/scratch/da6c4dbd0097/manabitan/node_modules';
const require=createRequire(path.join(root,'package.json'));
const acorn=require('acorn');
const esbuild=require('esbuild');
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const naturalPrefix='../../../../workspace/scratch/da6c4dbd0097/manabitan/node_modules/';
const hostedPrefix='node_modules/';
const receipt=JSON.parse(await readFile(path.join(here,'reconstruction.json'),'utf8'));
assert(receipt.complete);
const report={schemaVersion:1,complete:false,node:process.version,esbuild:esbuild.version,acorn:acorn.version,
    reconstructionSha256:sha(await readFile(path.join(here,'reconstruction.json'))),
    scope:'Exact hashed bundles; no product/source write, corpus import, browser execution or timing',files:[],inputs:[],packages:[],failures:[]};
const astValue=(value)=>{
    if(value===null||typeof value!=='object')return typeof value==='bigint'?{bigintValue:value.toString()}:value;
    if(Array.isArray(value))return value.map(astValue);
    return Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','raw'].includes(key)).map(([key,item])=>[key,astValue(item)]));
};
const walk=(node,ancestors,callback)=>{
    if(node===null||typeof node!=='object')return;
    if(Array.isArray(node)){for(const value of node)walk(value,ancestors,callback);return;}
    callback(node,ancestors);
    for(const value of Object.values(node))if(value!==null&&typeof value==='object')walk(value,[...ancestors,node],callback);
};
const inputMap=new Map(),packageMap=new Map();
try{
    process.chdir(root);
    for(const file of receipt.files.filter((item)=>item.path.endsWith('.js'))){
        const name=path.basename(file.path);
        const natural=await readFile(path.join(here,'natural',name),'utf8');
        const hosted=await readFile(path.join(here,'hosted',name),'utf8');
        assert.equal(sha(natural),file.natural.sha256);
        assert.equal(sha(hosted),file.hosted.sha256);
        const comments=[];
        const a=acorn.parse(natural,{ecmaVersion:'latest',sourceType:'module',onComment:comments});
        const b=acorn.parse(hosted,{ecmaVersion:'latest',sourceType:'module'});
        const originalAstSha256=sha(JSON.stringify(astValue(a)));
        const hostedAstSha256=sha(JSON.stringify(astValue(b)));
        const labels=[];
        walk(a,[],(node,ancestors)=>{
            if(node.type!=='Literal'||typeof node.value!=='string'||!node.value.includes(naturalPrefix))return;
            const property=ancestors.at(-1),object=ancestors.at(-2),call=ancestors.at(-3);
            assert.equal(property?.type,'Property'); assert.equal(property.key,node);
            assert.equal(property.computed,false); assert.equal(property.method,true);
            assert.equal(property.value.type,'FunctionExpression'); assert.equal(property.kind,'init');
            assert.equal(object?.type,'ObjectExpression'); assert.equal(object.properties.length,1);
            assert.equal(object.properties[0],property); assert.equal(call?.type,'CallExpression');
            assert.equal(call.callee.type,'Identifier'); assert.equal(call.callee.name,'__commonJS');
            assert.equal(call.arguments[0],object); assert.equal(call.arguments.length,1);
            labels.push({start:node.start,end:node.end,natural:node.value,hosted:node.value.replaceAll(naturalPrefix,hostedPrefix),
                classification:'Sole esbuild __commonJS callback method key; name only used to select that one callback, and may appear in diagnostic function names/stacks'});
            node.value=node.value.replaceAll(naturalPrefix,hostedPrefix);
        });
        const spans=[];
        let at=-1;
        while((at=natural.indexOf(naturalPrefix,at+1))>=0){
            const comment=comments.find((item)=>item.start<=at&&item.end>=at+naturalPrefix.length);
            const label=labels.find((item)=>item.start<=at&&item.end>=at+naturalPrefix.length);
            assert(Boolean(comment)!==Boolean(label),'Every path byte must belong to exactly one comment or recognized commonJS metadata key');
            spans.push({start:at,end:at+naturalPrefix.length,kind:comment?'comment':'commonjs-source-label'});
        }
        assert.equal(sha(JSON.stringify(astValue(a))),hostedAstSha256,'Executable AST differs outside the classified module source labels');
        console.log(JSON.stringify({phase:'ast-classified',name,comments:spans.filter((span)=>span.kind==='comment').length,labels:labels.length}));
        let commonJsHelper=null;
        if(labels.length){
            const declaration=a.body.find((statement)=>statement.type==='VariableDeclaration'&&statement.declarations.some((entry)=>entry.id.type==='Identifier'&&entry.id.name==='__commonJS'));
            assert(declaration);
            commonJsHelper=natural.slice(declaration.start,declaration.end);
            assert(commonJsHelper.includes('__getOwnPropNames(cb)[0]'));
        }
        const entry=path.join(root,'dev/lib',name);
        const outfile=path.join(root,file.path);
        const built=await esbuild.build({absWorkingDir:root,entryPoints:[entry],bundle:true,minify:false,sourcemap:true,target:'es2020',format:'esm',outfile,
            external:['fs'],banner:{js:'// @ts-nocheck'},metafile:true,write:false});
        const buildOutputs=[];
        for(const generated of built.outputFiles){
            const filename=path.basename(generated.path);
            const expected=await readFile(path.join(here,'surviving',filename));
            assert.equal(sha(generated.contents),sha(expected),'Fresh stock-option read-only build did not reproduce exact surviving bundle: '+filename);
            buildOutputs.push({name:filename,bytes:expected.length,sha256:sha(expected)});
        }
        for(const input of Object.keys(built.metafile.inputs)){
            const resolved=await realpath(path.resolve(root,input));
            const bytes=await readFile(resolved);
            const relative=resolved.startsWith(dependencyRoot+'/')?'node_modules/'+path.relative(dependencyRoot,resolved):path.relative(root,resolved);
            assert(!relative.startsWith('..')&&!path.isAbsolute(relative),'Unexpected input outside restored baseline');
            inputMap.set(relative,{path:relative,bytes:bytes.length,sha256:sha(bytes)});
            if(relative.startsWith('node_modules/')){
                let directory=path.dirname(resolved);
                while(directory!==dependencyRoot){
                    let data=null;
                    try{data=await readFile(path.join(directory,'package.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
                    if(data!==null){const value=JSON.parse(data);packageMap.set(directory,{path:'node_modules/'+path.relative(dependencyRoot,path.join(directory,'package.json')),name:value.name??null,version:value.version??null,bytes:data.length,sha256:sha(data)});break;}
                    directory=path.dirname(directory);
                }
            }
        }
        await writeFile(path.join(here,'diffs',name+'.metafile.json'),JSON.stringify(built.metafile,null,2)+'\n');
        report.files.push({path:file.path,naturalSha256:file.natural.sha256,hostedSha256:file.hosted.sha256,
            naturalAstSha256:originalAstSha256,hostedAstSha256,astExactlyIdentical:originalAstSha256===hostedAstSha256,
            astIdenticalAfterOnlyRecognizedSourceLabels:true,comments:spans.filter((span)=>span.kind==='comment').length,
            commonJsSourceLabels:labels.length,replacementSpans:spans,labels,commonJsHelper,stockReadOnlyBuildOutputs:buildOutputs});
    }
    report.inputs=[...inputMap.values()].sort((a,b)=>a.path.localeCompare(b.path));
    report.packages=[...packageMap.values()].sort((a,b)=>a.path.localeCompare(b.path));
    report.compiler=[];
    for(const relative of ['node_modules/esbuild/package.json','node_modules/esbuild/lib/main.js','node_modules/@esbuild/linux-x64/bin/esbuild','node_modules/acorn/package.json','node_modules/acorn/dist/acorn.js','package.json','package-lock.json','dev/build-libs.js']){
        const bytes=await readFile(path.join(root,relative));report.compiler.push({path:relative,bytes:bytes.length,sha256:sha(bytes)});
    }
    report.complete=true;
}catch(error){report.failures.push({name:error.name,message:error.message,stack:error.stack});throw error;}
finally{
    await writeFile(path.join(here,'classification.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({complete:report.complete,node:report.node,esbuild:report.esbuild,files:report.files.map(({path,astExactlyIdentical,comments,commonJsSourceLabels})=>({path,astExactlyIdentical,comments,commonJsSourceLabels})),inputCount:report.inputs.length,failures:report.failures}));
}
