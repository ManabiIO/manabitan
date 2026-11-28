/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import path from 'node:path';

const [sourceRoot] = process.argv.slice(2);
assert(sourceRoot);
const parser = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')));
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function snapshot(chunk) {
    return {
        rows: Array.from({length: chunk.rowCount}, (_, i) => {
            const meta = chunk.contentMetaList;
            const offset = meta ? (chunk.contentBytesBaseOffset ?? 0) + meta[i * 4] : 0;
            const content = meta && chunk.contentBytesBuffer ?
                chunk.contentBytesBuffer.subarray(offset, offset + meta[i * 4 + 1]) : chunk.contentBytesList[i];
            return {expression: decoder.decode(chunk.expressionBytesList[i]), reading: decoder.decode(chunk.readingBytesList[i]),
                equal: chunk.readingEqualsExpressionList[i], score: chunk.scoreList[i],
                negativeZero: Object.is(chunk.scoreList[i], -0), sequence: chunk.sequenceList[i], content: hash(content)};
        }),
        mediaRows: chunk.mediaRows.map(({index, row}) => ({index, expression: row.expression, reading: row.reading,
            glossary: row.glossaryJson, glossaryBytes: row.glossaryJsonBytes ? hash(row.glossaryJsonBytes) : null})),
    };
}

async function parse(banks) {
    const sources = banks.map((text) => {
        const decoded = encoder.encode(text);
        const bytes = new Uint8Array(deflateRawSync(decoded));
        return {bytes, compressedSize: bytes.length, uncompressedSize: decoded.length, compressionMethod: 8, signature: crc32(decoded)};
    });
    const options = {experimentalNativeEscapedKeys: true, singleChunk: true, emitTermByteLists: true,
        computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
        mediaHintFastScan: true, validateGlossaryTypes: true};
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true);
    const results = [];
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => results.push(snapshot(chunk)), 2048, {...options, preloadedSource});
    return results;
}

const tail = '"noun","",-5,[{"type":"text","text":"  shared text  "},{"type":"image","path":"image.png"}],17,"common"';
const prefix = `[["first","",${tail}],["longer expression","",${tail}]]`;
const valid = [
    [prefix, `[["\\u0061","a",${tail}],["a","a",${tail}]]`],
    [`[["a","",null,"",0,["x"],null,""] ,["b","",null,"",0,["x"],null,""] ,["c","",null,"",0,["x"],null,""   ]]`, '[]'],
    [`[["a","","","",0.5,["x"],1e1,""] ,["b","","","",0.5,["x"],1e1,""] ,["c","","","",0.5,["x"],1e1,""]]`, '[]'],
    [`[["a","","","",-0,["x"],1,""] ,["b","","","",-0,["x"],1,""] ,["c","","","",-0,["x"],1,""]]`, '[]'],
    [prefix, '[]', `[["last","",${tail}]]`],
];
const malformed = [
    [prefix, `[["c","",${tail},true]]`],
    [prefix, `[["c","",${tail} null]]`],
    [prefix, `[["c","",${tail.slice(0, -1)}`],
    [prefix, `[["c","",${tail.slice(0, -1)}`, '"]]]'],
    [prefix, `[["c","",null,"",false,["x"],1,""]]`],
    [prefix, `[["c","",${tail}],["d","",{},"",0,["x"],1,""]]`],
];
const results = [];
for (const banks of valid) { results.push(await parse(banks)); }
for (const banks of malformed) { await assert.rejects(() => parse(banks)); }
results.push(await parse([`[["fresh","","","",3,["new"],9,""]]`, '[]']));
console.log(JSON.stringify({validCases: valid.length, malformedCases: malformed.length,
    results}));
