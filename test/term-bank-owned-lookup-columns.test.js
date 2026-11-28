/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {readFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {beforeAll, describe, expect, test} from 'vitest';
import {
    copyWasmBackedColumnChunk,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {encodePersistedTermLookupIndexFromPreinternedPlan, parsePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js';
import {compactTermRecordPreinternedPlan} from '../ext/js/dictionary/term-record-preinterned-plan.js';

/** @typedef {Parameters<typeof copyWasmBackedColumnChunk>[0]} Chunk */
/** @typedef {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */

const encoder = new TextEncoder();
const banks = [
    '[["猫","ねこ","","",1,["cat"],100,""],["仮名","","","",0,[{"type":"image","path":"cat.png"}],101,""]]',
    '[["a","\\u0061","","",2,["latin"],102,""],["かな","かな","","",3,["kana"],103,""]]',
].map((bank) => encoder.encode(bank));

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});

/**
 * @param {(chunk: Chunk) => void} inspect
 * @returns {Promise<void>}
 */
async function parse(inspect) {
    await parseTermBankWithWasmColumnChunks(banks, 3, inspect, 4, {
        singleChunk: true,
        emitTermByteLists: false,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
        experimentalNativeEscapedKeys: true,
    });
}

/**
 * @param {Plan} plan
 * @returns {{strings: number[], lengths: number[], expressions: number[], readings: number[]}}
 */
function values(plan) {
    return {
        strings: [...plan.stringsBuffer],
        lengths: [...plan.stringLengths],
        expressions: [...plan.expressionIndexes],
        readings: [...plan.readingIndexes],
    };
}

describe('owned whole-chunk lookup columns', () => {
    test('reuses the native sidecar without changing keys, media projection or reading equality', async () => {
        await parse((chunk) => {
            const original = values(chunk.termRecordPreinternedPlan);
            const prepared = chunk.preparedLookupIndexes?.get('0:4');
            if (typeof prepared === 'undefined') { throw new Error('Missing native sidecar'); }
            const expectedBytes = new Uint8Array(prepared.bytes);
            const copy = copyWasmBackedColumnChunk(chunk, false, true, true, void 0, true);
            const plan = copy.termRecordPreinternedPlan;
            expect(plan.stringsBuffer.buffer).toBe(prepared.bytes.buffer);
            expect(plan.stringLengths.buffer).toBe(prepared.bytes.buffer);
            expect(plan.expressionIndexes.buffer).toBe(prepared.bytes.buffer);
            expect(plan.expressionIndexes).toBeInstanceOf(Uint16Array);
            expect(plan.readingIndexes.buffer).not.toBe(prepared.bytes.buffer);
            expect(values(plan)).toStrictEqual(original);
            expect([...copy.readingEqualsExpressionList]).toStrictEqual([0, 1, 0, 1]);
            expect(copy.mediaRows[0].imagePaths).toStrictEqual(['cat.png']);
            expect(new TextDecoder().decode(copy.mediaRows[0].row.expressionBytes)).toBe('仮名');
            expect(copy.preparedLookupIndexes?.get('0:4')?.preinternedPlan).toBe(plan);

            // Native views can be overwritten by the next worker parse. The
            // published plan and its projected media must retain owned bytes.
            chunk.termRecordPreinternedPlan.stringsBuffer.fill(0);
            chunk.termRecordPreinternedPlan.stringLengths.fill(0);
            chunk.termRecordPreinternedPlan.expressionIndexes.fill(0);
            chunk.termRecordPreinternedPlan.readingIndexes.fill(0);
            expect(values(plan)).toStrictEqual(original);
            expect(new TextDecoder().decode(copy.mediaRows[0].row.expressionBytes)).toBe('仮名');
            expect(prepared.bytes).toStrictEqual(expectedBytes);
            expect(encodePersistedTermLookupIndexFromPreinternedPlan(plan, copy.readingEqualsExpressionList, copy.sequenceList, copy.rowCount)).toStrictEqual(expectedBytes);

            const moved = structuredClone(copy, {transfer: [prepared.bytes.buffer]});
            const movedIndex = moved.preparedLookupIndexes?.get('0:4');
            if (typeof movedIndex === 'undefined') { throw new Error('Missing transferred sidecar'); }
            expect(values(moved.termRecordPreinternedPlan)).toStrictEqual(original);
            expect(moved.termRecordPreinternedPlan.expressionIndexes.buffer).toBe(movedIndex.bytes.buffer);
            expect(movedIndex.bytes).toStrictEqual(expectedBytes);
            expect(parsePersistedTermLookupIndex(movedIndex.bytes).readingKeys).toStrictEqual(new Uint16Array([1, 0xffff, 3, 0xffff]));
            const compact = compactTermRecordPreinternedPlan(
                moved.termRecordPreinternedPlan,
                1,
                2,
                new Uint32Array(moved.termRecordPreinternedPlan.stringLengths.length),
                moved.readingEqualsExpressionList,
            );
            expect(compact?.expressionIndexes).toStrictEqual(new Uint32Array([0, 1]));
        });
    });

    test('keeps the default column snapshot independent of the native sidecar', async () => {
        await parse((chunk) => {
            const original = values(chunk.termRecordPreinternedPlan);
            const prepared = chunk.preparedLookupIndexes?.get('0:4');
            if (typeof prepared === 'undefined') { throw new Error('Missing native sidecar'); }
            const copy = copyWasmBackedColumnChunk(chunk);
            expect(copy.termRecordPreinternedPlan.stringsBuffer.buffer).not.toBe(prepared.bytes.buffer);
            expect(copy.termRecordPreinternedPlan.expressionIndexes).toBeInstanceOf(Uint32Array);
            prepared.bytes.fill(0, 48);
            chunk.termRecordPreinternedPlan.stringsBuffer.fill(0);
            expect(values(copy.termRecordPreinternedPlan)).toStrictEqual(original);
        });
    });

    test('the actual worker transfers adopted columns once and preserves prior results on reuse', async () => {
        const workerUrl = new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href;
        const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
            import {parentPort} from 'node:worker_threads';
            globalThis.self = {
                addEventListener: (_, handler) => parentPort.on('message', data => handler({data})),
                postMessage: (data, transfer = []) => {
                    const transfers = [...(data.chunk?.preparedLookupIndexes?.values() ?? [])]
                        .map(({bytes}) => transfer.filter(buffer => buffer === bytes.buffer).length);
                    parentPort.postMessage({...data, transfers}, transfer);
                },
            };
            await import(${JSON.stringify(workerUrl)});
            parentPort.postMessage({type: 'loaded'});
        `)}`));
        /**
         * @param {unknown} message
         * @returns {Promise<{type: string, chunk?: Chunk, transfers?: number[]}>}
         */
        const request = (message) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker request timed out')), 10000);
            worker.once('error', reject);
            worker.once('message', (reply) => {
                clearTimeout(timer);
                worker.off('error', reject);
                resolve(reply);
            });
            if (message !== null) { worker.postMessage(message); }
        });
        try {
            expect((await request(null)).type).toBe('loaded');
            const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)));
            expect((await request({type: 'initialize', module})).type).toBe('ready');
            /** @type {Chunk|null} */
            let previous = null;
            /** @type {ReturnType<typeof values>|null} */
            let expected = null;
            for (let id = 1; id <= 2; ++id) {
                const reply = await request({
                    type: 'parse',
                    id,
                    version: 3,
                    sourceBuffers: banks.map((bank) => bank.buffer),
                    options: {
                        emitContentSlab: true,
                        emitTokenBinaryContent: true,
                        emitTermByteLists: false,
                        mediaHintFastScan: true,
                        projectImagePaths: true,
                        validateGlossaryTypes: true,
                        prepareLookupIndexes: true,
                        prepareLookupRoute: true,
                        experimentalNativeEscapedKeys: true,
                    },
                });
                expect(reply.type).toBe('result');
                expect(reply.transfers).toStrictEqual([1]);
                const chunk = reply.chunk;
                const prepared = chunk?.preparedLookupIndexes?.get('0:4');
                if (typeof chunk === 'undefined' || typeof prepared === 'undefined') { throw new Error('Missing worker sidecar'); }
                const plan = chunk.termRecordPreinternedPlan;
                expect(plan.stringsBuffer.buffer).toBe(prepared.bytes.buffer);
                expect(plan.stringLengths.buffer).toBe(prepared.bytes.buffer);
                expect(plan.expressionIndexes.buffer).toBe(prepared.bytes.buffer);
                expect(plan.expressionIndexes).toBeInstanceOf(Uint16Array);
                expect(prepared.bytes).toStrictEqual(encodePersistedTermLookupIndexFromPreinternedPlan(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount));
                if (previous !== null) { expect(values(previous.termRecordPreinternedPlan)).toStrictEqual(expected); }
                previous = chunk;
                expected = values(plan);
            }
        } finally { await worker.terminate(); }
    });

    test.each(['missing', 'wrong range', 'multiple indexes', 'different plan', 'borrowed bytes', 'different version', 'truncated bytes', 'replaced bytes', 'forged matching header', 'replaced strings', 'replaced lengths', 'replaced expressions'])('copies original columns for %s', async (condition) => {
        await parse((chunk) => {
            const prepared = chunk.preparedLookupIndexes?.get('0:4');
            if (typeof prepared === 'undefined') { throw new Error('Missing native sidecar'); }
            const entry = prepared;
            let changed = chunk;
            if (!(changed.preparedLookupIndexes instanceof Map)) { throw new Error('Missing sidecar map'); }
            switch (condition) {
                case 'missing': changed.preparedLookupIndexes.clear(); break;
                case 'wrong range': changed.preparedLookupIndexes = new Map([['1:4', entry]]); break;
                case 'multiple indexes': changed.preparedLookupIndexes.set('4:4', entry); break;
                case 'different plan': entry.preinternedPlan = {...chunk.termRecordPreinternedPlan}; break;
                case 'borrowed bytes': {
                    chunk.termRecordPreinternedPlan.stringsBuffer = entry.bytes.subarray(48, 48 + chunk.termRecordPreinternedPlan.stringsBuffer.length);
                    break;
                }
                case 'different version':
                    new Uint32Array(entry.bytes.buffer)[1] = 8;
                    break;
                case 'truncated bytes': entry.bytes = entry.bytes.slice(0, 48); break;
                case 'replaced bytes':
                    entry.bytes = new Uint8Array(entry.bytes);
                    entry.bytes[48] ^= 1;
                    break;
                case 'forged matching header': {
                    const bytes = new Uint8Array(entry.bytes);
                    bytes[48] ^= 1;
                    changed = {...chunk, preparedLookupIndexes: new Map([['0:4', {bytes, preinternedPlan: chunk.termRecordPreinternedPlan}]])};
                    break;
                }
                case 'replaced strings':
                    chunk.termRecordPreinternedPlan.stringsBuffer = new Uint8Array(chunk.termRecordPreinternedPlan.stringsBuffer);
                    chunk.termRecordPreinternedPlan.stringsBuffer[0] ^= 1;
                    break;
                case 'replaced lengths':
                    chunk.termRecordPreinternedPlan.stringLengths = new Uint16Array(chunk.termRecordPreinternedPlan.stringLengths);
                    --chunk.termRecordPreinternedPlan.stringLengths[0];
                    break;
                case 'replaced expressions':
                    chunk.termRecordPreinternedPlan.expressionIndexes = new Uint32Array(chunk.termRecordPreinternedPlan.expressionIndexes);
                    chunk.termRecordPreinternedPlan.expressionIndexes[0] = 1;
                    break;
            }
            const original = values(changed.termRecordPreinternedPlan);
            const copy = copyWasmBackedColumnChunk(changed, false, false, false, void 0, true);
            expect(values(copy.termRecordPreinternedPlan)).toStrictEqual(original);
            expect(copy.termRecordPreinternedPlan.stringsBuffer.buffer).not.toBe(entry.bytes.buffer);
            expect(copy.termRecordPreinternedPlan.expressionIndexes).toBeInstanceOf(Uint32Array);
        });
    });
});
