import {readFile, writeFile, readdir, stat, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const inputRoot = process.argv[2];
const outputRoot = process.argv[3];
if (!inputRoot || !outputRoot) { throw new Error('Usage: profile-analysis.mjs inputRoot outputRoot'); }
await mkdir(outputRoot, {recursive: true});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile('dev/data/dictionary-wasm/manifest.json', 'utf8'));
if (!manifest.targets.some((target) => target.name === 'term-bank-parser.wasm' && target.sha256 === '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee')) { throw new Error('Unexpected native parser manifest'); }
const parserSymbols = {
    13: 'parse_composite_span_impl', 18: 'parse_row_single_pass',
    24: 'hash_content_xxh32_pair', 27: 'encode_term_content_token_binary_row',
    34: 'encode_term_lookup_index', 36: 'parse_and_encode_term_bank_token_binary_dedup',
    37: 'scan_scalar_span', 38: 'parse_int32_token', 40: 'raw_term_content_tokens_equal',
    42: 'reuse_validated_glossary', 44: 'next_format3_field', 46: 'compact_term_lookup_keys',
};
async function files(dir) {
    const result = [];
    for (const name of await readdir(dir)) {
        const filename = path.join(dir, name);
        if ((await stat(filename)).isDirectory()) { result.push(...await files(filename)); }
        else { result.push(filename); }
    }
    return result;
}
function shortUrl(url = '') {
    const extension = url.indexOf('/js/');
    return extension >= 0 ? url.slice(extension + 1) : url;
}
function extractDebug(details) {
    const marker = details.indexOf('debug=');
    if (marker < 0) { return null; }
    const start = details.indexOf('{', marker);
    if (start < 0) { return null; }
    let quoted = false;
    let escaped = false;
    let depth = 0;
    for (let i = start; i < details.length; ++i) {
        const char = details[i];
        if (quoted) {
            if (escaped) { escaped = false; }
            else if (char === '\\') { escaped = true; }
            else if (char === '"') { quoted = false; }
        } else if (char === '"') { quoted = true; }
        else if (char === '{') { ++depth; }
        else if (char === '}' && --depth === 0) { return JSON.parse(details.slice(start, i + 1)); }
    }
    throw new Error('Truncated embedded import diagnostics');
}
function reportSummary(report) {
    const phases = [];
    for (const phase of report.phases ?? []) {
        if (typeof phase.details !== 'string') { continue; }
        const debug = extractDebug(phase.details);
        if (debug?.importerPhaseTimings) { phases.push(...debug.importerPhaseTimings); }
    }
    const dedupedPhases = [...new Map(phases.map((phase) => [JSON.stringify(phase), phase])).values()];
    const validation = report.benchmark?.validation;
    return {
        status: report.status, failureReason: report.failureReason,
        startedAtIso: report.startedAtIso, browserVersion: report.browserVersion,
        packageSha256: report.packageSha256, benchmark: {...report.benchmark,
            validation: validation ? {
                title: validation.title, termRows: validation.termRows, probeCount: validation.probeCount,
                outputDigestSha256: validation.outputDigestSha256, media: validation.media,
                storageBytes: validation.storage?.bytes,
            } : undefined},
        phases: dedupedPhases,
    };
}
function traceSummary(trace) {
    const events = Array.isArray(trace) ? trace : trace.traceEvents;
    if (!Array.isArray(events)) { throw new Error('Missing traceEvents'); }
    const profiles = new Map();
    const threadNames = new Map();
    for (const event of events) {
        if (event.name === 'thread_name') {
            threadNames.set(event.pid + ':' + event.tid, event.args?.name ?? '');
        }
        if (event.name !== 'ProfileChunk') { continue; }
        const key = [event.pid, event.tid, event.id ?? event.id2?.local ?? event.id2?.global ?? 'default'].join(':');
        let profile = profiles.get(key);
        if (!profile) { profile = {pid: event.pid, tid: event.tid, nodes: new Map(), parents: new Map(), chunks: []}; profiles.set(key, profile); }
        const data = event.args?.data ?? {};
        const cpu = data.cpuProfile ?? {};
        for (const node of cpu.nodes ?? []) {
            profile.nodes.set(node.id, node);
            if (typeof node.parent === 'number') { profile.parents.set(node.id, node.parent); }
            for (const child of node.children ?? []) { profile.parents.set(child, node.id); }
        }
        profile.chunks.push({samples: cpu.samples ?? [], deltas: data.timeDeltas ?? cpu.timeDeltas ?? []});
    }
    const totalSelf = new Map();
    const threadReports = [];
    let sampleCount = 0;
    let missingNodes = 0;
    let missingDeltas = 0;
    function add(map, key, data, micros) {
        let value = map.get(key);
        if (!value) { value = {...data, selfMs: 0, samples: 0}; map.set(key, value); }
        value.selfMs += micros / 1000;
        ++value.samples;
    }
    for (const profile of profiles.values()) {
        const self = new Map();
        let sampledMs = 0;
        function moduleOf(nodeId) {
            const seen = new Set();
            for (let id = nodeId; typeof id === 'number' && !seen.has(id); id = profile.parents.get(id)) {
                seen.add(id);
                const url = profile.nodes.get(id)?.callFrame?.url ?? '';
                if (url.includes('/term-bank-wasm-parser.js')) { return 'term-bank-parser'; }
                if (url.includes('/term-content-dedup')) { return 'term-content-dedup'; }
                if (url.includes('zstd')) { return 'zstd'; }
            }
            return null;
        }
        for (const chunk of profile.chunks) {
            for (let i = 0; i < chunk.samples.length; ++i) {
                const id = chunk.samples[i];
                const node = profile.nodes.get(id);
                const micros = chunk.deltas[i];
                if (!node) { ++missingNodes; continue; }
                if (!Number.isFinite(micros) || micros < 0) { ++missingDeltas; continue; }
                ++sampleCount;
                sampledMs += micros / 1000;
                const frame = node.callFrame ?? {};
                const nativeModule = moduleOf(id);
                const rawName = frame.functionName || '(anonymous)';
                const wasmMatch = /wasm-function\[(\d+)\]/.exec(rawName);
                const name = nativeModule === 'term-bank-parser' && wasmMatch && parserSymbols[wasmMatch[1]] ?
                    parserSymbols[wasmMatch[1]] + ' [' + rawName + ']' : rawName;
                const data = {name, url: shortUrl(frame.url), line: (frame.lineNumber ?? -1) + 1,
                    nativeModule, rawFunctionName: rawName};
                const key = JSON.stringify(data);
                add(self, key, data, micros);
                add(totalSelf, key, data, micros);
            }
        }
        threadReports.push({pid: profile.pid, tid: profile.tid,
            threadName: threadNames.get(profile.pid + ':' + profile.tid) ?? '',
            sampledMs, topSelf: [...self.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 25)});
    }
    return {
        caveat: 'Instrumented import-only sampling diagnostics. Self-time sums across threads are CPU/wait attribution, not elapsed critical-path time. SQLite proxy/Atomics waits can dominate samples. No speedup claim.',
        nativeSymbolProvenance: 'Known parser function IDs were obtained locally by pinned LLVM21.1.8 name-section-only rebuild of baseline parser SHA8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee; every noncustom section matched. Symbols assigned only with parser JS ancestor; unresolved wasm functions remain numbered.',
        events: events.length, profiles: profiles.size, sampleCount, missingNodes, missingDeltas,
        topSelf: [...totalSelf.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 65),
        threads: threadReports.sort((a, b) => b.sampledMs - a.sampledMs),
    };
}
for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
    const all = await files(path.join(inputRoot, dictionary));
    const traceFile = all.find((name) => name.endsWith('.trace.json'));
    const ordinaryFile = all.find((name) => /[/\\]ordinary[/\\]run-1\.json$/.test(name));
    const tracedFile = all.find((name) => /[/\\]trace[/\\]run-1\.json$/.test(name));
    const sourceFile = all.find((name) => name.endsWith('source.txt'));
    if (!traceFile || !ordinaryFile || !tracedFile || !sourceFile) { throw new Error('Missing diagnostic files for ' + dictionary); }
    const source = (await readFile(sourceFile, 'utf8')).trim().split(/\s+/);
    if (source[0] !== '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2' || source[1] !== 'd99ea4d04658f7ec1c76acdc5f3684594212a471') {
        throw new Error('Unexpected baseline source identity');
    }
    const traceBytes = await readFile(traceFile);
    const ordinaryBytes = await readFile(ordinaryFile);
    const tracedBytes = await readFile(tracedFile);
    const result = {dictionary, source, originalRunId: 46101023614,
        inputHashes: {trace: sha256(traceBytes), ordinary: sha256(ordinaryBytes), tracedReport: sha256(tracedBytes)},
        ordinary: reportSummary(JSON.parse(ordinaryBytes)), traced: reportSummary(JSON.parse(tracedBytes)),
        trace: traceSummary(JSON.parse(traceBytes))};
    await writeFile(path.join(outputRoot, dictionary + '-profile-analysis.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('PROFILE_DIAGNOSTIC ' + JSON.stringify(result));
}
