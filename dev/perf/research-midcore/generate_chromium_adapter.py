#!/usr/bin/env python3
"""Generate a research-only copy; never modify the source tree or dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import re

p=argparse.ArgumentParser()
p.add_argument('root',type=Path)
p.add_argument('output',type=Path)
p.add_argument('--sampler',type=Path,required=True)
a=p.parse_args()
root=a.root.resolve(strict=True)
source=root/'test/chromium/extension-two-dictionary-import.e2e.js'
assert source.resolve(strict=True)==source, 'Unexpected source symlink'
out=a.output.parent.resolve(strict=True)/a.output.name
assert not out.exists() and not out.is_symlink(), 'Output must be a new regular file'
sampler=a.sampler.resolve(strict=True)
s=source.read_text()
original_sha=hashlib.sha256(s.encode()).hexdigest()
def replace(old,new,count=1):
 global s
 assert s.count(old)==count, f'Expected {count} exact occurrences: {old[:100]!r}; found {s.count(old)}'
 s=s.replace(old,new)
def function(name,new):
 global s
 pat=re.compile(r'async function '+re.escape(name)+r'\([^\n]*\) \{.*?\n\}',re.S)
 assert len(pat.findall(s))==1,name
 s=pat.sub(lambda _:new,s)
# Rewrite imports against the read-only source root. Installed dependencies are not edited.
s=re.sub(r"from '((?:\./|\.\./)[^']+)'",lambda m:"from '"+(source.parent/m.group(1)).resolve(strict=True).as_uri()+"'",s)
replace('readFile, rm, writeFile','readFile, realpath, writeFile')
replace("from '@playwright/test'", "from "+json.dumps((root/'node_modules/@playwright/test/index.mjs').resolve(strict=True).as_uri()))
replace("import {ensurePinnedDictionaryCache}","import {loadDictionaryFixtures}")
imports="import {snapshotTermBankExperiments} from "+json.dumps((root/'ext/js/dictionary/term-bank-experiments.js').as_uri())+";\n"
imports+="import {createProcessTreeSampler} from "+json.dumps(sampler.as_uri())+";\n"
prelude=r'''
const midcoreMode = process.env.MIDCORE_MODE;
const midcoreArm = process.env.MIDCORE_ARM;
const midcoreDictionary = process.env.MIDCORE_DICTIONARY;
assert.ok(['timing', 'memory'].includes(midcoreMode), 'MIDCORE_MODE');
assert.ok(['A', 'B'].includes(midcoreArm), 'MIDCORE_ARM');
assert.ok(['jmdict', 'jitendex'].includes(midcoreDictionary), 'MIDCORE_DICTIONARY');
assert.equal(process.platform, 'linux', 'This hosted qualification requires real Linux /proc');
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Node 22 required');
assert.equal(os.cpus().length, 4, 'Pilot requires an actual 4-CPU host; do not spoof navigator');
const midcoreOutput = process.env.MIDCORE_OUTPUT;
const midcoreCache = process.env.MIDCORE_CACHE;
const midcorePackageDir = process.env.MIDCORE_PACKAGE_DIR;
for (const value of [midcoreOutput, midcoreCache, midcorePackageDir]) {
    assert.ok(typeof value === 'string' && path.isAbsolute(value), 'Absolute owned paths required');
    assert.equal(await realpath(value), value, 'Resolve symlinks before use');
}
for (const key of Object.keys(process.env)) {
    if (/^MANABITAN_(?:E2E_|CHROMIUM_)/.test(key)) { delete process.env[key]; }
}
Object.assign(process.env, {
    MANABITAN_CHROMIUM_BROWSER: 'chromium', MANABITAN_CHROMIUM_HEADLESS: '1',
    MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK: '0', MANABITAN_CHROMIUM_BUILD_TARGET: 'chrome',
    MANABITAN_CHROMIUM_E2E_REPORT: path.join(midcoreOutput, 'report.html'),
    MANABITAN_E2E_STRICT_RUNTIME: '1', MANABITAN_E2E_IMPORT_BENCH_QUICK: '1',
    MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: midcoreDictionary,
    MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1', MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
    MANABITAN_E2E_PHASE_PROFILING: '0', MANABITAN_E2E_PHASE_SCREENSHOTS: '0',
    MANABITAN_E2E_PROCESS_SAMPLING: '0', MANABITAN_E2E_SKIP_BUILD: '1',
    MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify({experimentalParserWorkers3: midcoreArm === 'B'}),
});
const midcoreMemoryMode = midcoreMode === 'memory';
let midcoreEnvironment = {host: getHostEnvironment(), browser: null};
let midcorePackageIdentity = null;
let midcoreMemorySampler = null;
let midcoreMemoryStop = null;
let midcoreMemoryResult = null;
let midcoreMemorySignal = null;
let midcorePostMemoryPromise = null;
let midcorePostMemoryResult = null;
const midcoreRetainedResources = [];
async function retainOwnedResource(target) {
    const resolved = await realpath(target);
    const temporaryRoot = await realpath(os.tmpdir());
    assert.ok(resolved.startsWith(temporaryRoot + path.sep), 'Unexpected retained resource');
    midcoreRetainedResources.push(resolved);
}
async function startMidcoreMemory(page, rootPid) {
    if (!midcoreMemoryMode) { return; }
    assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, 'Missing owned browser PID');
    await page.exposeFunction('__midcoreMemoryComplete', async (signal) => {
        if (midcoreMemoryStop !== null) { return; }
        midcoreMemorySignal = signal;
        midcoreMemoryStop = midcoreMemorySampler.stop();
        try {
            midcoreMemoryResult = await midcoreMemoryStop;
            midcorePostMemoryPromise = (async () => {
                const sampler = createProcessTreeSampler({intervalMs: 100, includePss: true});
                try {
                    const pinned = await sampler.start(rootPid);
                    assert.deepEqual(pinned, midcoreMemoryResult.summary.root, 'Browser root identity changed after import');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                } finally { midcorePostMemoryResult = await sampler.stop(); }
            })();
            void midcorePostMemoryPromise.catch(() => {});
        } catch (_) { /* joined by finishMidcoreMemory */ }
    });
    await page.evaluate(() => {
        const sequenceBefore = Number(globalThis.__manabitanImportCompletionSequence ?? 0);
        const onComplete = (event) => {
            const detail = event.detail;
            if (!(event instanceof CustomEvent) || detail?.importRunCurrent !== true ||
                !Number.isSafeInteger(detail.sequence) || detail.sequence <= sequenceBefore ||
                globalThis.__manabitanBrowserImportTiming?.completedAtMs === null) { return; }
            globalThis.removeEventListener('manabitan:dictionary-import-complete', onComplete);
            void globalThis.__midcoreMemoryComplete({sequence: detail.sequence,
                completedAtMonotonicMs: detail.completedAtMonotonicMs,
                observedAtMonotonicMs: performance.now()});
        };
        globalThis.addEventListener('manabitan:dictionary-import-complete', onComplete);
    });
    midcoreMemorySampler = createProcessTreeSampler({intervalMs: 100, includePss: true});
    await midcoreMemorySampler.start(rootPid);
}
async function finishMidcoreMemory(requireSignal) {
    if (midcoreMemorySampler === null) { return; }
    if (midcoreMemoryStop === null) {
        midcoreMemoryStop = midcoreMemorySampler.stop();
        midcoreMemoryResult = await midcoreMemoryStop;
    } else { await midcoreMemoryStop; }
    if (requireSignal) {
        assert.ok(midcoreMemorySignal, 'Missing request-scoped memory completion signal');
        assert.ok(midcorePostMemoryPromise, 'Missing post-completion memory window');
    }
    if (midcorePostMemoryPromise !== null) { await midcorePostMemoryPromise; }
}
function validateMidcoreRoute(debug) {
    const phases = debug.importerPhaseTimings;
    assert.ok(Array.isArray(phases));
    const expectedExperiments = snapshotTermBankExperiments({experimentalParserWorkers3: midcoreArm === 'B'});
    let receipts = 0;
    for (const phase of phases) {
        for (const key of ['parserExperiments', 'fastPathParserEffectiveExperiments']) {
            if (!Object.hasOwn(phase.details ?? {}, key)) { continue; }
            assert.deepEqual(phase.details[key], expectedExperiments, key); ++receipts;
        }
    }
    assert.ok(receipts > 0, 'Missing worker experiment receipts');
    const owners = phases.filter((phase) => typeof phase.details?.dedupUniqueCount === 'number');
    assert.equal(owners.length, 1, 'Exactly one complete parser owner is required');
    const metrics = owners[0].details;
    const jmdict = midcoreDictionary === 'jmdict';
    assert.equal(metrics.parserParallelWorkerCount, midcoreArm === 'A' ? 2 : 3);
    assert.equal(metrics.parserParallelGroupCount, jmdict ? (midcoreArm === 'A' ? 8 : 12) : 22);
    assert.equal(metrics.parserFusedAttempts, metrics.parserParallelGroupCount);
    assert.equal(metrics.parserFusedFallbacks, 0);
    assert.equal(metrics.rows, jmdict ? 526942 : 435448);
    assert.equal(metrics.dedupUniqueCount, jmdict ? 360859 : 362154);
    assert.equal(metrics.parserSourceCompressedBytes, jmdict ? 15574114 : 33696215);
    assert.equal(metrics.parserSourceUncompressedBytes, jmdict ? 171092992 : 537538792);
    assert.equal(debug.openStorageDiagnostics?.mode, 'opfs-sahpool');
    assert.equal(debug.usesFallbackStorage, false);
    assert.equal(phases.find((phase) => phase.phase === 'bulk-finalization')?.details?.published, true);
}
'''
anchor='const dirname = path.dirname(fileURLToPath(import.meta.url));'
replace(anchor,imports+'\n'+prelude+'\n'+anchor)
replace("const root = path.join(dirname, '..', '..');","const root = process.env.MIDCORE_SOURCE_ROOT ?? "+json.dumps(str(root))+";\nassert.equal(await realpath(root), "+json.dumps(str(root))+", 'Source root must match generated imports');")
replace("const dictionaryCacheDir = path.join(root, 'builds', 'e2e-dictionary-cache');","const dictionaryCacheDir = midcoreCache;")
replace('authoritativeTiming: importTracePath.length === 0 && !capturePhaseProfiles && !capturePhaseScreenshots && !captureProcessSamples,','authoritativeTiming: importTracePath.length === 0 && !capturePhaseProfiles && !capturePhaseScreenshots && !captureProcessSamples && !midcoreMemoryMode,')
replace('        benchmark: report.benchmark,','        benchmark: report.benchmark,\n        midcore: {mode: midcoreMode, arm: midcoreArm, environment: midcoreEnvironment, packageIdentity: midcorePackageIdentity, memory: midcoreMemoryMode ? {window: \'pre-file-dispatch to request-scoped completion observed across the browser bridge\', completionSignal: midcoreMemorySignal, result: midcoreMemoryResult, postCompletion: {windowMs: 2000, result: midcorePostMemoryResult}} : null, retainedResources: midcoreRetainedResources},')
function('ensureRealDictionaryCache',r'''async function ensureRealDictionaryCache() {
    const fixtures = await loadDictionaryFixtures();
    const paths = {};
    for (const [id, fixture] of Object.entries(fixtures)) {
        const file = path.join(dictionaryCacheDir, fixture.cacheFile);
        assert.equal(await realpath(file), file, 'Fixture must be a regular resolved cache file');
        const bytes = await readFile(file);
        assert.equal(bytes.byteLength, fixture.sizeBytes, id + ' size');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256, id + ' SHA');
        paths[id] = file;
    }
    return {fixtures, jmdictPath: paths.jmdict, jitendexPath: paths.jitendex, jmnedictPath: paths.jmnedict};
}''')
function('ensureCachedDownload',"async function ensureCachedDownload() { throw new Error('Network fixture resolution is forbidden in this qualification');\n}")
function('loadRecommendedDictionaryUrls',"async function loadRecommendedDictionaryUrls() { throw new Error('Recommended/latest fixture resolution is forbidden in this qualification');\n}")
verify_python=r'''
import hashlib,json,os,stat,sys,zipfile
from pathlib import Path
archive,base=map(Path,sys.argv[1:])
assert base.resolve(strict=True)==base
h=lambda b:hashlib.sha256(b).hexdigest()
entries={}
with zipfile.ZipFile(archive) as z:
 for n in z.namelist():
  if n.endswith('/'): continue
  parts=Path(n).parts
  assert not Path(n).is_absolute() and '..' not in parts
  dest=base/n
  assert dest.resolve(strict=True)==dest, n
  assert stat.S_ISREG(dest.lstat().st_mode),n
  data=z.read(n)
  assert h(data)==h(dest.read_bytes()),n
  assert n not in entries,n
  entries[n]=h(data)
nodes=list(base.rglob('*'))
assert all(not p.is_symlink() for p in nodes),'Extraction contains symlink'
actual={str(p.relative_to(base)) for p in nodes if p.is_file()}
assert actual==set(entries),'Extraction contains missing/extra files'
assert entries['lib/term-bank-parser.wasm']==h((archive.parent.parent/'ext/lib/term-bank-parser.wasm').read_bytes())
print(json.dumps({'packageSha256':h(archive.read_bytes()),'entryHashes':entries,'entryCount':len(entries),'packageTreeSha256':h(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()),'nativeSha256':entries['lib/term-bank-parser.wasm']}))
'''
function('ensureFreshChromeBuild','async function ensureFreshChromeBuild(zipPath) {\n    await access(zipPath);\n    const {stdout} = await execFileAsync(\'python3\', [\'-c\', '+json.dumps(verify_python)+', zipPath, midcorePackageDir], {maxBuffer: 4 * 1024 * 1024});\n    midcorePackageIdentity = JSON.parse(stdout);\n    if (process.env.MIDCORE_PACKAGE_SHA256) { assert.equal(midcorePackageIdentity.packageSha256, process.env.MIDCORE_PACKAGE_SHA256); }\n}\n')
function('extractExtensionZip','async function extractExtensionZip() {\n    return midcorePackageDir;\n}')
# Remaining cleanup calls are retained-resource validation, never mutation.
s=s.replace('await rm(', 'await retainOwnedResource(')
# Shared extraction is intentionally retained and never treated as an owned profile.
replace("        if (extensionDir !== null) {\n            await withCleanupTimeout('extension dir removal', async () => { await retainOwnedResource(extensionDir, {recursive: true, force: true}); });\n        }",'')
# Stop writing combined reports into a source build directory.
s,n=re.subn(r'            await writeCombinedTabbedReport\(\{.*?\n            \}\);','            // Combined report is intentionally not written by this isolated observation.',s,flags=re.S)
assert n==1
# Eligibility is read from the actual extension page and never overwritten.
needle="        await waitForSettingsPageReady(page);\n        const settingsOpenEnd"
replace(needle,r'''        await waitForSettingsPageReady(page);
        midcoreEnvironment.browser = await page.evaluate(() => ({
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: typeof navigator.deviceMemory === 'undefined' ? null : navigator.deviceMemory,
            userAgent: navigator.userAgent,
        }));
        assert.ok(Number.isInteger(midcoreEnvironment.browser.hardwareConcurrency) && midcoreEnvironment.browser.hardwareConcurrency >= 4 && midcoreEnvironment.browser.hardwareConcurrency <= 7, 'Ineligible browser hardwareConcurrency');
        assert.ok(midcoreEnvironment.browser.deviceMemory === null || midcoreEnvironment.browser.deviceMemory > 4, 'Constrained browser memory tier');
        const settingsOpenEnd''')
replace('        const initialImportTriggerStart = safePerformance.now();','        await startMidcoreMemory(page, browserPid);\n        const initialImportTriggerStart = safePerformance.now();')
replace('            const importTotalEnd = safePerformance.now();','            const importTotalEnd = safePerformance.now();\n            await finishMidcoreMemory(true);')
replace('        if (quickImportBenchmarkMode) {\n            if (initialImportDebug.errorCount', '        validateMidcoreRoute(initialImportDebug);\n        if (quickImportBenchmarkMode) {\n            if (initialImportDebug.errorCount')
replace('                    termRows: state.counts[0].terms,','                    termRows: state.counts[0].terms,\n                    counts: state.counts[0],')
replace('                const probeTerms = await loadBenchmarkProbeTerms(initialImportSpec.filePath);',r'''                const expectedCounts = {terms: fixture.termRows, termMeta: 0, kanji: 0, kanjiMeta: 0, tagMeta: midcoreDictionary === 'jmdict' ? 327 : 8, media: midcoreDictionary === 'jmdict' ? 0 : 236};
                assert.deepEqual(state.counts[0], expectedCounts);
                const probeTerms = await loadBenchmarkProbeTerms(initialImportSpec.filePath);''')
replace("    } finally {\n        try {\n            await mkdir(path.dirname(reportPath)","    } finally {\n        try { await finishMidcoreMemory(false); } catch (error) { report.status = 'failure'; report.failureReason = errorMessage(error); runError ??= error; }\n        try {\n            await mkdir(path.dirname(reportPath)")
replace("await withCleanupTimeout('browser context close', async () => { await context.close(); });", 'await context.close();')
# Root discovery uses the browser's own process inventory, not a pgrep heuristic.
replace('        const browserPid = browserPidFromPlaywright ?? await findChromiumPidByProfileDir(userDataDir);',r'''        const rootSession = await context.browser().newBrowserCDPSession();
        let browserPid;
        try {
            const inventory = await rootSession.send('SystemInfo.getProcessInfo');
            const roots = inventory.processInfo.filter((entry) => entry.type === 'browser');
            assert.equal(roots.length, 1, 'Unambiguous owned browser process required');
            browserPid = roots[0].id;
            assert.ok(Number.isSafeInteger(browserPid) && browserPid > 0);
        } finally { await rootSession.detach(); }''', count=2)
replace('await main();',r'''let midcoreError = null;
try { await main(); } catch (error) { midcoreError = error; }
let midcoreReport = null;
try { midcoreReport = JSON.parse(await readFile(path.join(midcoreOutput, 'report.json'), 'utf8')); }
catch (error) { midcoreError ??= error; }
const midcoreImport = midcoreReport?.phases?.find((phase) => phase.data?.kind === 'dictionary-import');
const midcoreTiming = midcoreImport?.data?.browserTiming;
const midcoreObservation = {
    schemaVersion: 1, browser: 'chromium', mode: midcoreMode, arm: midcoreArm, dictionary: midcoreDictionary,
    status: midcoreError ? 'failure' : midcoreReport?.status ?? 'failure',
    failureReason: midcoreError?.stack ?? midcoreReport?.failureReason ?? '',
    authoritativeTiming: midcoreMode === 'timing',
    timing: {browser: midcoreTiming, totalImportMs: midcoreTiming ? midcoreTiming.completedAtMs - midcoreTiming.startedAtMs : null,
        workerImportMs: midcoreImport?.data?.importDebug?.localPhaseTimings?.find((phase) => phase.phase === 'worker-import-dictionary')?.elapsedMs ?? null},
    importDebug: midcoreImport?.data?.importDebug ?? null,
    validation: midcoreReport?.benchmark?.validation ?? null,
    environment: midcoreEnvironment,
    packageIdentity: midcorePackageIdentity,
    memory: midcoreReport?.midcore?.memory ?? null,
    browserVersion: midcoreReport?.browserVersion ?? null,
    skippedVerification: midcoreReport?.skippedVerification ?? null,
    launchMode: midcoreReport?.launchMode ?? null,
};
await writeFile(path.join(midcoreOutput, 'observation.json'), JSON.stringify(midcoreObservation, null, 2) + '\n', {flag: 'wx'});
if (midcoreError) { throw midcoreError; }''')
assert not re.search(r'\brm\(',s)
assert 'ensurePinnedDictionaryCache' not in s
out.write_text(s)
manifest={'generatorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'source':str(source),'sourceSha256':original_sha,'output':str(out),'outputSha256':hashlib.sha256(s.encode()).hexdigest(),'sampler':str(sampler),'samplerSha256':hashlib.sha256(sampler.read_bytes()).hexdigest(),'sourceRoot':str(root),'contract':'temporary canonical Chromium E2E copy; real4CPU pilot, existing experiment switch, verified cached fixtures, immutable package extraction, no cleanup mutations'}
with Path(str(out)+'.generation.json').open('x') as f: json.dump(manifest,f,indent=2);f.write('\n')
print(json.dumps(manifest,indent=2))
