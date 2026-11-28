#!/usr/bin/env node
// Measurement-only adapter for frozen 9e10d3b3; never imported by product code.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const baseline = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) { throw new Error('Expected frozen baseline worktree'); }
const runnerPath = path.join(baseline, 'dev/perf/import-lookup-screen.js');
let runner = await readFile(runnerPath, 'utf8');
const originalBlob = createHash('sha1').update('blob ' + Buffer.byteLength(runner) + '\0').update(runner).digest('hex');
if (originalBlob !== 'e4efa15a14f3e781b7ab93ada9e1c86ae6d96bf2') { throw new Error('Unexpected committed component runner'); }
const parserSource = await readFile(path.join(baseline, 'ext/js/dictionary/term-bank-wasm-parser.js'), 'utf8');
const workerSource = await readFile(path.join(baseline, 'ext/js/dictionary/term-bank-wasm-parser-worker.js'), 'utf8');
const ownershipSource = await readFile(path.join(baseline, 'ext/js/dictionary/term-content-ownership.js'), 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n}', start);
    if (start < 0 || end < start || source.indexOf('function ' + name + '(', start + 1) >= 0) { throw new Error('Ambiguous function: ' + name); }
    return source.slice(start, end + 2);
}
const partition = extractFunction(parserSource, 'partitionSourceBanks');
const sourceLength = extractFunction(parserSource, 'getPartitionSourceByteLength');
const transfer = extractFunction(workerSource, 'collectChunkTransferables');
const ownStart = workerSource.indexOf('const ownCacheableContent =');
const ownEnd = workerSource.indexOf('resultCopyMs = Math.max', ownStart);
if (ownStart < 0 || ownEnd < ownStart) { throw new Error('Worker ownership boundary missing'); }
const ownBody = workerSource.slice(ownStart, ownEnd).trim();
const support = [
    '// Generated measurement support: verbatim frozen production grouping, ownership, transfers.',
    'export const expectedParserSha256 = ' + JSON.stringify(hash(parserSource)) + ';',
    'export const expectedWorkerSha256 = ' + JSON.stringify(hash(workerSource)) + ';',
    'export const expectedOwnershipSha256 = ' + JSON.stringify(hash(ownershipSource)) + ';',
    'export ' + partition,
    'export ' + sourceLength,
    'export ' + transfer,
    'export function copyOwnedChunkForMeasurement(parser, ownership, chunk, options) {',
    '    const {copyWasmBackedColumnChunk} = parser;',
    '    const {shouldOwnTermContentBytes, shouldBorrowProjectedTermContent} = ownership;',
    '    const preloadedSource = void 0;',
    '    let resultChunk = null;',
    '    let ownsContentBytes = false;',
    '    let borrowsWorkerMemory = false;',
    ownBody,
    '    if (!ownsContentBytes || borrowsWorkerMemory || resultChunk === null) { throw new Error("Expected ordinary owned JMdict result"); }',
    '    return resultChunk;',
    '}',
    '',
].join('\n');
function replaceOnce(before, after) {
    if (runner.split(before).length !== 2) { throw new Error('Runner replacement did not match exactly once: ' + before.slice(0, 100)); }
    runner = runner.replace(before, after);
}
replaceOnce("import path from 'node:path'", [
    "import path from 'node:path'",
    "import {partitionSourceBanks, collectChunkTransferables, copyOwnedChunkForMeasurement, expectedParserSha256, expectedWorkerSha256, expectedOwnershipSha256} from './import-ownership-support-a7c4.js'",
].join('\n'));
replaceOnce("const filesPerGroup = {jmdict: 7, jmnedict: 9, jitendex: 10}", [
    "const filesPerGroup = {jmdict: 1}",
    "const componentGroupCount = 12",
    "const expectedGroupRows = [50000, 40000, 40000, 40000, 50000, 50000, 40000, 50000, 40000, 40000, 40000, 48299]",
].join('\n'));
replaceOnce("    'ext/js/dictionary/wasm/term-bank-parser.c']", [
    "    'ext/js/dictionary/wasm/term-bank-parser.c',",
    "    'ext/js/dictionary/term-bank-wasm-parser-worker.js',",
    "    'ext/js/dictionary/term-content-ownership.js']",
].join('\n'));
replaceOnce('async function measure(dictionary, cache, sourceRoot, flags) {', [
    'async function measure(dictionary, cache, sourceRoot, flags) {',
    "    if (dictionary !== 'jmdict' || Object.keys(flags).length !== 0) { throw new Error('This frozen screen requires ordinary JMdict {} flags') }",
    "    const ownership = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-content-ownership.js')).href)",
].join('\n'));
replaceOnce('    const options = {...flags,', [
    "    if (sourceHashes['ext/js/dictionary/term-bank-wasm-parser.js'] !== expectedParserSha256 ||",
    "        sourceHashes['ext/js/dictionary/term-bank-wasm-parser-worker.js'] !== expectedWorkerSha256 ||",
    "        sourceHashes['ext/js/dictionary/term-content-ownership.js'] !== expectedOwnershipSha256) { throw new Error('Frozen JS boundary changed') }",
    '    const groups = partitionSourceBanks(sources, sources.reduce((sum, bytes) => sum + bytes.byteLength, 0), componentGroupCount)',
    '    const groupGeometry = groups.map((group) => ({files: group.length, sourceBytes: group.reduce((sum, bytes) => sum + bytes.byteLength, 0)}))',
    '    const options = {...flags,',
    '        maxPendingChunks: 1,',
    '        compactContentMetadata: true,',
    '        prepareLookupRoute: true,',
].join('\n'));
replaceOnce('        mediaHintFastScan: true,', '        mediaHintFastScan: false,');
replaceOnce('        let lookupMs = 0', [
    '        let lookupMs = 0',
    '        let ownershipCopyMs = 0',
    '        let ownedContentBytes = 0',
    '        let transferBytes = 0',
    '        let transferCount = 0',
    '        let nativeSuccessGroups = 0',
    '        let fusedAttempts = 0',
    '        let fusedFallbacks = 0',
    '        const groupRows = []',
].join('\n'));
replaceOnce('        for (let start = 0; start < sources.length; start += filesPerGroup[dictionary]) {', '        for (const group of groups) {');
replaceOnce('            const group = sources.slice(start, start + filesPerGroup[dictionary])\n', '');
replaceOnce('                resultChunk = chunk\n', [
    '                const copyStart = safePerformance.now()',
    '                resultChunk = copyOwnedChunkForMeasurement(parser, ownership, chunk, options)',
    '                ownershipCopyMs += safePerformance.now() - copyStart',
    '                chunk = resultChunk',
    '',
].join('\n'));
replaceOnce('            rows += chunk.rowCount', [
    '            rows += chunk.rowCount',
    '            groupRows.push(chunk.rowCount)',
    '            nativeSuccessGroups += profile.nativeLookupScratchReuseGroups ?? 0',
    '            fusedAttempts += profile.fusedParseAttempts ?? 0',
    '            fusedFallbacks += profile.fusedParseFallbacks ?? 0',
    '            ownedContentBytes += chunk.contentBytesBuffer?.byteLength ?? 0',
].join('\n'));
replaceOnce('            if (!verify) { continue }', [
    '            if (!verify) { continue }',
    '            const transfers = collectChunkTransferables(chunk)',
    '            transferCount += transfers.length',
    '            transferBytes += transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0)',
].join('\n'));
replaceOnce('                const offset = contentBytesBaseOffset + contentMetaList[row * 4]\n                digest.update(contentBytesBuffer.subarray(offset, offset + contentMetaList[row * 4 + 1]))\n                updateView(digest, contentMetaList.subarray(row * 4 + 1, row * 4 + 4))', [
    '                const metaIndex = (chunk.contentMetaByUniqueIndex === true ? chunk.contentUniqueIndexList[row] : row) * 4',
    '                const offset = contentBytesBaseOffset + contentMetaList[metaIndex]',
    '                digest.update(contentBytesBuffer.subarray(offset, offset + contentMetaList[metaIndex + 1]))',
    '                updateView(digest, contentMetaList.subarray(metaIndex + 1, metaIndex + 4))',
].join('\n'));
replaceOnce("        if (rows !== spec.termRows) { throw new Error('Dictionary row count differs from lock') }", [
    "        if (rows !== spec.termRows) { throw new Error('Dictionary row count differs from lock') }",
    "        if (JSON.stringify(groupRows) !== JSON.stringify(expectedGroupRows)) { throw new Error('Ordinary JMdict group rows changed') }",
    "        if (nativeSuccessGroups !== 12 || fusedAttempts !== 12 || fusedFallbacks !== 0 || nativeSegments !== 0 || scratchReuseMisses !== 0) { throw new Error('Expected 12 successful ordinary native groups') }",
].join('\n'));
replaceOnce('        return {scratchReusedBytes,', [
    '        return {ownershipCopyMs, ownedContentBytes, transferBytes, transferCount, nativeSuccessGroups, fusedAttempts, fusedFallbacks, groupRows, groupGeometry, scratchReusedBytes,',
].join('\n'));
replaceOnce('        filesPerGroup: filesPerGroup[dictionary],', [
    '        componentGroupCount,',
    "        scope: 'Sequential native parse + completed lookup + actual ordinary worker ownership copies; excludes inflate, IPC, compression, storage and UI',",
    "        supportSha256: sha256(await readFile(new URL('./import-ownership-support-a7c4.js', import.meta.url))),",
].join('\n'));
replaceOnce("'pairs': {type: 'string', default: '8'},", "'pairs': {type: 'string', default: '3'},");
replaceOnce("'flags': {type: 'string', default: '{\"experimentalNativeSegmentedLookup\":true}'},", "'flags': {type: 'string', default: '{}'},");
replaceOnce("if (!Number.isInteger(pairs) || pairs < 2 || !['AB', 'BA'].includes(values['initial-order']))", "if (pairs !== 3 || values['initial-order'] !== 'AB')");
replaceOnce("            if (a.archiveSha256 !== b.archiveSha256 || a.lockSha256 !== b.lockSha256) { throw new Error('Fixture identity mismatch') }", [
    "            if (a.archiveSha256 !== b.archiveSha256 || a.lockSha256 !== b.lockSha256) { throw new Error('Fixture identity mismatch') }",
    "            if (JSON.stringify(a.groupGeometry) !== JSON.stringify(b.groupGeometry) || JSON.stringify(a.groupRows) !== JSON.stringify(b.groupRows) || a.supportSha256 !== b.supportSha256) { throw new Error('Group/boundary mismatch') }",
].join('\n'));
replaceOnce('x.result.sourceHashes, x.result.wasmSha256, x.result.runnerSha256', 'x.result.sourceHashes, x.result.wasmSha256, x.result.runnerSha256, x.result.supportSha256');
replaceOnce(' * Sequential parser + completed lookup construction, not end-to-end import.', ' * Sequential parser + completed lookup + actual worker ownership boundary; not end-to-end import.');
replaceOnce(' * Grouping is fixed component-fixture grouping, not a production planner override.', ' * Grouping copies ordinary JMdict byte-balanced 12 groups, without changing production planner policy.');
const supportPath = path.join(baseline, 'dev/perf/import-ownership-support-a7c4.js');
const outputPath = path.join(baseline, 'dev/perf/import-ownership-screen-a7c4.js');
await writeFile(supportPath, support, {flag: 'wx'});
await writeFile(outputPath, runner, {flag: 'wx'});
console.log(JSON.stringify({runner: outputPath, runnerSha256: hash(runner), support: supportPath, supportSha256: hash(support), originalRunnerBlob: originalBlob}));
