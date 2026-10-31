import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {firefoxTimingScript, findReadableRows, fixtureOracle, loadHarness, parseArgs, runBrowser, transformHarness, validateRoute} from './firefox-import-pilot.mjs';

assert(process.env.MANABITAN_ADMISSION_HELD, 'Run tests through run.py --test');
const source = process.env.MANABITAN_SOURCE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../parser-screen-baseline');

test('real upstream helper extraction imports without executing browser main', async () => {
    const harness = await loadHarness(source);
    assert.equal(typeof harness.module.importDictionariesViaFileInput, 'function');
    assert.equal(typeof harness.module.createAdapterFirefoxOptions, 'function');
    assert.equal(typeof harness.armBrowserImportTiming, 'function');
    assert.match(harness.identity.harnessSha256, /^[0-9a-f]{64}$/);
    assert.throws(() => transformHarness('unexpected changed harness', source, () => ''), /extraction start/);
});

test('upstream timing function survives Selenium function serialization and rejects stale completion', async () => {
    const {armBrowserImportTiming} = await loadHarness(source);
    const sandbox = vm.createContext({EventTarget, Event, CustomEvent, performance});
    vm.runInContext(`
        const listeners = {};
        globalThis.document = {addEventListener:(type,f)=>listeners[type]=f,removeEventListener:()=>{}};
        const bus = new EventTarget();
        globalThis.addEventListener = bus.addEventListener.bind(bus);
        globalThis.removeEventListener = bus.removeEventListener.bind(bus);
        globalThis.dispatchEvent = bus.dispatchEvent.bind(bus);
        globalThis.Element = class extends Event { matches(x) {return x === '#dictionary-import-file-input';} closest() {return null;} };
        globalThis.requestAnimationFrame = (f) => { f(); return 1; };
        globalThis.cancelAnimationFrame = () => {};
        globalThis.__manabitanImportCompletionSequence = 7;
        (${armBrowserImportTiming.toString()})();
        listeners.change({type:'change',target:new Element('change')});
    `, sandbox);
    vm.runInContext(`
        dispatchEvent(new CustomEvent('manabitan:dictionary-import-complete', {detail:{sequence:7,importRunCurrent:true,completedAtMonotonicMs:performance.now(),errorCount:0}}));
    `, sandbox);
    assert.equal(sandbox.__manabitanBrowserImportTiming.completedAtMs, null);
    vm.runInContext(`
        dispatchEvent(new CustomEvent('manabitan:dictionary-import-complete', {detail:{sequence:8,importRunCurrent:true,completedAtMonotonicMs:performance.now(),errorCount:0}}));
    `, sandbox);
    assert.equal(sandbox.__manabitanBrowserImportTiming.trigger, 'file-input-change');
    assert.equal(sandbox.__manabitanBrowserImportTiming.sequence, 8);
    assert(sandbox.__manabitanBrowserImportTiming.completedAtMs >= sandbox.__manabitanBrowserImportTiming.startedAtMs);
});

test('route oracle rejects no-op flag, fallback and missing source groups', () => {
    const fixture = {title: 'fixture', bankCount: 20, compressedBytes: 17, uncompressedBytes: 100, counts: {terms: 41, media: 0}};
    const debug = {hasResult:true,resultTitle:'fixture',errorCount:0,addSettingsErrorCount:0,usesFallbackStorage:false,importerPhaseTimings:[{phase:'term-file-fast-path:term_bank_1.json..term_bank_20.json',details:{parserExperiments:{experimentalParserWorkers3:true},parserParallelWorkerCount:3,batchedFileCount:20,rows:41,parserSourceCompressedBytes:17,parserSourceUncompressedBytes:100,parserParallelSkipReason:null,parserParallelPipelineGroupsPerWorker:4,parserParallelGroupCount:12}}]};
    assert.equal(validateRoute(debug, fixture, true, 3).groups, 12);
    assert.throws(() => validateRoute(debug, fixture, false, 3), /did not reach parser/);
    const missing = structuredClone(debug);
    missing.importerPhaseTimings[0].details.parserParallelGroupCount = 8;
    assert.throws(() => validateRoute(missing, fixture, true, 3), /source group count/);
    const fallback = structuredClone(debug);
    fallback.importerPhaseTimings[0].details.parserParallelSkipReason = 'source-size-budget';
    assert.throws(() => validateRoute(fallback, fixture, true, 3), /fell back/);
});

test('readable-content oracle cannot pass another dictionary or failed raw reads', () => {
    assert.deepEqual(findReadableRows({workerState:{rowSample:[{dictionary:'other',glossaryLength:1},{dictionary:'wanted',glossaryLength:0,rawContentPreview:'<read-null>'},{dictionary:'wanted',glossaryLength:0,rawContentPreview:'<read-failed>'}]}}, 'wanted'), []);
    assert.equal(findReadableRows({workerState:{rowSample:[{dictionary:'wanted',glossaryLength:2}]}}, 'wanted').length, 1);
});

test('failed browser session is still awaited through real driver cleanup', async () => {
    const calls = [];
    const driver = {getWindowHandle:async()=>{throw new Error('startup rejected');},quit:async()=>{await Promise.resolve();calls.push('quit-complete');}};
    class Builder {forBrowser(){return this;}setFirefoxOptions(){return this;}setFirefoxService(){return this;}build(){return driver;}}
    class ServiceBuilder {addArguments(){}}
    const harness = {module:{Builder,Browser:{FIREFOX:'firefox'},firefox:{ServiceBuilder},createAdapterFirefoxOptions:async()=>({firefoxOptions:{}})}};
    await assert.rejects(runBrowser({}, {}, {}, harness, {}), /startup rejected/);
    assert.deepEqual(calls, ['quit-complete']);
});

test('adapter avoids legacy screenshots, profiling, root-only sampling, and forced exit', async () => {
    const text = await readFile(new URL('./firefox-import-pilot.mjs', import.meta.url), 'utf8');
    assert(!/\.(?:takeScreenshot|startFirefoxResourceSampler|ensurePageProfiler|beginPageProfilePhase)\s*\(/.test(text));
    assert(!/process\.exit\s*\(/.test(text));
    assert.throws(() => parseArgs(['--workers3', 'maybe']), /Missing --source/);
});

test('canonical fixture preflight decodes the exact pinned source ZIPs outside timing', async (t) => {
    const fixtures = process.env.MANABITAN_FIXTURE_DIR ?? path.resolve(source, '../dictionary-fixtures');
    for (const [dataset, filename] of [['jmdict', 'JMdict.zip'], ['jitendex', 'jitendex-yomitan.zip']]) {
        const oracle = await fixtureOracle(source, path.join(fixtures, filename), dataset);
        t.diagnostic(JSON.stringify(oracle));
        assert.equal(oracle.counts.terms, dataset === 'jmdict' ? 526_942 : 435_448);
    }
});


test('Firefox timing state is attached to the page Window instead of the WebDriver sandbox', async () => {
    const {armBrowserImportTiming} = await loadHarness(source);
    const window = {__manabitanImportCompletionSequence: 7};
    const sandbox = vm.createContext({window, EventTarget, Event, CustomEvent, performance});
    vm.runInContext(`
        const listeners = {};
        globalThis.document = {addEventListener:(type,f)=>listeners[type]=f,removeEventListener:()=>{}};
        const bus = new EventTarget();
        window.addEventListener = bus.addEventListener.bind(bus);
        window.removeEventListener = bus.removeEventListener.bind(bus);
        window.dispatchEvent = bus.dispatchEvent.bind(bus);
        globalThis.Element = class extends Event { matches(x) {return x === '#dictionary-import-file-input';} closest() {return null;} };
        globalThis.requestAnimationFrame = (f) => { f(); return 1; };
        globalThis.cancelAnimationFrame = () => {};
    `, sandbox);
    vm.runInContext(firefoxTimingScript(armBrowserImportTiming), sandbox);
    assert.equal(window.__manabitanImportCompletionSignalEnabled, true);
    assert.equal(sandbox.__manabitanImportCompletionSignalEnabled, undefined);
    vm.runInContext(`
        listeners.change({type:'change',target:new Element('change')});
        window.dispatchEvent(new CustomEvent('manabitan:dictionary-import-complete', {detail:{sequence:8,importRunCurrent:true,completedAtMonotonicMs:performance.now(),errorCount:0}}));
    `, sandbox);
    assert.equal(window.__manabitanBrowserImportTiming.sequence, 8);
    assert(window.__manabitanBrowserImportTiming.completedAtMs >= window.__manabitanBrowserImportTiming.startedAtMs);
});
